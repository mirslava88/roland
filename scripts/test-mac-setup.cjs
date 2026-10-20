const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const { transformSync } = require('esbuild')

function load(file, dependencies, globals = {}) {
  const module = { exports: {} }
  vm.runInNewContext(transformSync(fs.readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' }).code, {
    module, exports: module.exports, process, console, Buffer, __dirname: path.dirname(path.resolve(file)),
    setTimeout, clearTimeout, require: name => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name), ...globals
  })
  return module.exports
}

;(async () => {
  const shared = load('src/shared/mac-setup.ts', {})
  let screen = 'denied', accessibility = false, installed = false, failure = ''
  const prompts = [], urls = [], revealed = [], requests = []
  let finishRequest
  const electron = {
    app: { isPackaged: true, getAppPath: () => '/development' },
    shell: { openExternal: async url => urls.push(url), showItemInFolder: file => revealed.push(file) },
    desktopCapturer: { getSources: options => { requests.push(options); return new Promise(resolve => { finishRequest = resolve }) } },
    systemPreferences: { getMediaAccessStatus: () => screen, isTrustedAccessibilityClient: prompt => { prompts.push(prompt); return accessibility } }
  }
  const setup = load('src/main/mac-setup.ts', {
    electron, './diagnostic-log': { diagnosticLog() {} }, '../shared/mac-setup': shared,
    './mac-native-office': { keynoteNative: async () => { if (failure) throw Error(failure); if (!installed) throw Error('Для показа PPTX установите Keynote и запустите его один раз вручную'); return { bundleId: 'com.apple.Keynote' } } }
  }, { process: { execPath: '/Applications/Presentation Display Manager Stream.app/Contents/MacOS/PDM' } })
  assert.equal(setup.macPermissionStatus().screen, 'denied')
  assert.deepEqual(prompts, [false], 'Status checks must never request or grant consent')
  await assert.rejects(setup.openMacPrivacy('https://example.com'))
  await assert.rejects(setup.openMacPrivacy('__proto__'))
  assert.equal(urls.length, 0)
  await Promise.all([setup.openMacPrivacy('screen'), setup.openMacPrivacy('screen')])
  assert.equal(requests.length, 1, 'Concurrent settings requests must not start concurrent capture probes')
  assert.ok(urls.every(url => url.endsWith('?Privacy_ScreenCapture')))
  finishRequest([]); await new Promise(setImmediate)
  await setup.openMacPrivacy('accessibility')
  assert.equal(prompts.at(-1), true)
  assert.ok(urls.at(-1).endsWith('?Privacy_Accessibility'))
  screen = 'granted'; accessibility = true
  assert.equal(setup.macPermissionStatus().accessibility, true)
  await setup.openMacPrivacy('screen')
  assert.equal(requests.length, 1, 'Granted Screen Recording must not reopen a capture probe')
  setup.showMacApplication()
  assert.equal(revealed[0], '/Applications/Presentation Display Manager Stream.app')
  await setup.openKeynoteDownload()
  assert.equal(urls.at(-1), 'https://apps.apple.com/app/keynote/id361285480?platform=mac')
  assert.equal((await setup.macPresentationSupport()).error, shared.MAC_KEYNOTE_REQUIRED_MESSAGE)
  await assert.rejects(setup.requireMacKeynote(), /установите Keynote/)
  installed = true
  assert.equal((await setup.macPresentationSupport()).installed, true)
  await setup.requireMacKeynote()
  failure = 'native helper unavailable'
  assert.match((await setup.macPresentationSupport()).error, /Не удалось проверить Keynote/)
  console.log('PASS: real permission reads, consent registration, fixed privacy destinations, edition path and Keynote discovery')

  let poolCreated = 0
  installed = false; failure = ''
  const powerpoint = load('src/main/mac-powerpoint.ts', {
    electron, './powerpoint-daemon': {}, './mac-pptx-animation': {}, '../shared/presentation-output': {},
    './diagnostic-log': { diagnosticLog() {} }, './renderer-security': {}, './mac-render-display': {},
    './mac-keynote-pool': { MacKeynotePool: class { constructor() { poolCreated++; throw Error('Unexpected player launch') } } },
    './mac-setup': setup
  }).macPowerPoint
  assert.equal(await powerpoint.installed(), false)
  await assert.rejects(powerpoint.prewarm('/test.pptx'), /установите Keynote/)
  assert.equal((await powerpoint.prepare('/test.pptx')).ok, false)
  assert.equal((await powerpoint.export('/test.pptx', '/unused', 1920, 1080, () => {})).ok, false)
  const take = await powerpoint.launch('/test.pptx', 1, { x: 0, y: 0, width: 1920, height: 1080 }, 1)
  assert.equal(take.success, false)
  assert.equal(take.safeToUncover, true)
  assert.match(take.error, /установите Keynote/)
  assert.equal(poolCreated, 0, 'Missing Keynote must fail before modifying any live player or output')
  console.log('PASS: preview, export, prepare and TAKE fail early with actionable Keynote message and preserve the previous output')

  const events = []; let checks = 0
  const window = { api: { platform: 'darwin', macSetup: {
    presentationSupport: async () => { checks++; return { installed } },
    permissions: async () => ({screen, accessibility})
  } }, dispatchEvent: event => events.push(event) }
  const helper = load('src/renderer/src/mac-presentation-support.ts', {}, { window, CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail } } })
  assert.deepEqual(await Promise.all([helper.requireMacPresentationSupport(), helper.requireMacPresentationSupport()]), [false, false])
  assert.equal(checks, 1); assert.equal(events.length, 1)
  installed = true
  assert.equal(await helper.requireMacPresentationSupport(), true, 'Installing Keynote must be detected without restarting the UI')
  assert.equal(checks, 2)
  accessibility = false
  assert.equal(await helper.requireMacPresentationSupport(), false, 'PPTX without Accessibility must reopen setup before modifying output')
  assert.equal(events.length, 2)
  assert.equal(events.at(-1).detail.installed, true, 'Missing permission must not be reported as missing Keynote')
  window.api.platform = 'win32'
  assert.equal(await helper.requireMacPresentationSupport(), true)
  assert.equal(checks, 3, 'Windows must not query Mac requirements')

  for (const platform of ['darwin', 'win32']) {
    let api
    load('src/preload/index.ts', {
      electron: { contextBridge: { exposeInMainWorld: (_name, value) => { api = value } }, ipcRenderer: {}, webUtils: {} },
      './streaming-api': {}
    }, { process: { platform, contextIsolated: true }, __PDM_STREAM_ENABLED__: false })
    assert.equal(!!api.macSetup, platform === 'darwin', 'Mac setup IPC must not be exposed in the Windows preload')
  }
  console.log('PASS: concurrent requirement checks coalesce, recheck after installation works, Windows exposes no Mac setup IPC')
})().catch(error => { console.error(error); process.exitCode = 1 })
