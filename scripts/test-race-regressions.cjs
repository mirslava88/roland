// Regression tests: delayed work must never mutate a newer session.
// Runs actual TypeScript methods with fake hardware/processes and controlled promises.
// No Electron launch, USB access, Office, network, or live output mutation.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { transformSync } = require('esbuild')
const root = path.resolve(__dirname, '..')
const deferred = () => {
  let resolve, reject
  const promise = new Promise((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve() }
function timers() {
  const active = new Set()
  const make = (fn, ms) => { const t = { fn, ms }; active.add(t); return t }
  return { active, setTimeout: make, setInterval: make,
    clearTimeout: t => active.delete(t), clearInterval: t => active.delete(t) }
}
function load(file, deps, globals = {}, source) {
  const exports = {}
  const code = transformSync(source ?? fs.readFileSync(path.join(root, file), 'utf8'), {
    loader: 'ts', format: 'cjs', target: 'node22'
  }).code
  const context = { module: { exports }, exports, Buffer, console, URL,
    process: { platform: 'win32', resourcesPath: '/fake' },
    __dirname: '/fake/main', ...globals,
    require: name => {
      if (Object.hasOwn(deps, name)) return deps[name]
      throw new Error(`Unmocked dependency forbidden: ${name}`)
    } }
  vm.runInNewContext(code, context, { filename: file })
  return context.module.exports
}
const diagnostics = { diagnosticLog() {}, formatDiagnosticError: String }
function child() {
  const c = new EventEmitter()
  c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.stdin = new EventEmitter()
  c.stdin.write = () => true; c.stdin.end = () => {}; c.kill = () => { c.killed = true }
  c.killed = false
  return c
}
function virtualSetup() {
  const clock = timers(), screen = new EventEmitter(), children = []
  const primary = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }
  const secondary = { id: 2, bounds: { x: 1920, y: 0, width: 1920, height: 1080 } }
  screen.displays = [primary, secondary]
  screen.getAllDisplays = () => screen.displays
  screen.getDisplayMatching = () => primary
  screen.dipToScreenRect = (_, r) => r
  const win = { isDestroyed: () => false, setIgnoreMouseEvents() {}, setOpacity() {}, isVisible: () => true }
  const { VirtualCameraManager } = load('src/main/virtual-camera.ts', {
    electron: { app: { isPackaged: false, getAppPath: () => '/fake' }, ipcMain: { handle() {} }, screen },
    child_process: { spawn: (...args) => { const c = child(); c.args = args; children.push(c); return c }, execFile() {} },
    fs: { existsSync: () => true }, path, os: { release: () => '10.0.26200' },
    './diagnostic-log': diagnostics, './virtual-camera-frame': { fitNativeImageToVirtualCameraFrame: () => Buffer.alloc(4) }
  }, clock)
  const manager = new VirtualCameraManager(() => null, () => win)
  manager.isInstalled = async () => true
  manager.startInternalCapture = () => {}
  return { manager, children, screen, clock }
}
function deckSetup() {
  const clock = timers(), opened = []
  const shared = load('src/shared/direct-stream-deck.ts', {})
  const makeDevice = () => {
    const d = new EventEmitter()
    d.CONTROLS = []; d.PRODUCT_NAME = 'fake'; d.closed = false
    d.close = async () => { d.closed = true }
    d.setBrightness = async () => {}; d.getSerialNumber = async () => 'fake'
    return d
  }
  const { DirectStreamDeckManager } = load('src/main/direct-stream-deck.ts', {
    electron: { BrowserWindow: class {} },
    '@elgato-stream-deck/node': { getStreamDeckModelName: () => 'fake',
      listStreamDecks: async () => [{ path: 'fake', serialNumber: 'fake' }],
      openStreamDeck: async () => { const d = makeDevice(); opened.push(d); return d } },
    '../shared/direct-stream-deck': shared, './diagnostic-log': diagnostics
  }, clock)
  const manager = new DirectStreamDeckManager(() => {}, () => {})
  return { manager, opened, makeDevice, clock }
}
async function run(name, fn) {
  await fn()
  console.log(`PASS ${name}`)
}
async function main() {
  await run('PPTX: real process-exit detection uses signal 0 without touching Office', async () => {
    const { spawn } = require('node:child_process')
    const { once } = require('node:events')
    const probe = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' })
    await once(probe, 'spawn')
    const notifications = []
    const { PowerPointOutputWatchdog } = load('src/main/powerpoint-output-watchdog.ts', {}, { process, setInterval, clearInterval })
    const watch = new PowerPointOutputWatchdog((...args) => notifications.push(args))
    try {
      watch.arm({ pid: probe.pid, filePath: 'synthetic.pptx', displayId: 2 })
      watch.check(); assert.equal(notifications.length, 0)
      const exited = once(probe, 'exit')
      probe.kill(); await exited
      watch.check(); assert.equal(notifications.length, 1)
      assert.equal(notifications[0][1], true)
    } finally { watch.clear(); if (probe.exitCode === null && !probe.killed) probe.kill() }
  })
  await run('PPTX: watch only the committed process; close/replacement cancels old crash recovery', async () => {
    const notifications = [], callbacks = new Set(), live = new Set([41, 42])
    const { PowerPointOutputWatchdog } = load('src/main/powerpoint-output-watchdog.ts', {}, {
      setInterval: fn => { const t = { fn, unref() {} }; callbacks.add(t); return t },
      clearInterval: t => callbacks.delete(t)
    })
    const watch = new PowerPointOutputWatchdog((...args) => notifications.push(args), pid => live.has(pid))
    const target = { pid: 41, filePath: 'synthetic.pptx', displayId: 2 }
    watch.arm(target); watch.check(); assert.equal(notifications.length, 0)
    watch.arm({ ...target, pid: 42 }); live.delete(41); watch.check()
    assert.equal(notifications.length, 0, 'old Office process must not trigger recovery of a replacement')
    live.delete(42); watch.check(); watch.check()
    assert.equal(notifications.length, 1); assert.equal(notifications[0][0].pid, 42)
    assert.equal(notifications[0][1], true); assert.equal(callbacks.size, 0)
    watch.arm(target); watch.clear(); watch.check()
    assert.equal(notifications.length, 1, 'intentional close must not reopen PowerPoint')
  })
  await run('PPTX: repeated Office crashes have a bounded automatic recovery budget', async () => {
    let now = 1000
    const retries = []
    const { PowerPointOutputWatchdog } = load('src/main/powerpoint-output-watchdog.ts', {}, {
      setInterval: () => ({ unref() {} }), clearInterval() {}
    })
    const watch = new PowerPointOutputWatchdog((_, retry) => retries.push(retry), () => false, () => now)
    const target = { pid: 41, filePath: 'synthetic.pptx', displayId: 2 }
    for (let i = 0; i < 4; i++) { watch.arm(target); watch.check(); now += 1000 }
    assert.deepEqual(retries, [true, true, false, false])
    now += 120000; watch.arm(target); watch.check(); assert.equal(retries.at(-1), true)
  })
  for (const target of [1, 3]) {
    await run(`ROUTE: queued metrics relocation revalidates target ${target}`, async () => {
      const file = 'src/main/index.ts', source = fs.readFileSync(path.join(root, file), 'utf8')
      const fragment = source.slice(source.indexOf('  const syncWindowsAfterDisplayMetricsChange ='), source.indexOf('  const scheduleDisplayMetricsSync ='))
      const gate = deferred(), sent = []
      const displays = [1, 2, 3].map(id => ({ id, bounds: { x: (id - 1) * 1920, y: 0, width: 1920, height: 1080 } }))
      const api = load(file, {}, { ...diagnostics, displayMetricsRevision: 0,
        screen: { getAllDisplays: () => displays, getPrimaryDisplay: () => displays[0] },
        presentationDisplayId: 2, presentationWindow: null, presentationWindowRequestedVisible: false,
        overlayDisplayId: null, overlayWindow: null, auxiliaryWindows: new Map(), timerActive: false,
        activeContentType: 'presentation', isInternalProgramOutputActive: () => false,
        sendDisplays() {}, controlWindow: null, getPowerPointNativePlacement: d => ({ bounds: d.bounds }),
        pptDaemon: { runExclusive: async operation => { await gate.promise; return operation(async (_command, args) => { sent.push(args); return { ok: true } }) } }
      }, fragment + '\nexport { syncWindowsAfterDisplayMetricsChange }; export function route(id) { presentationDisplayId = id }')
      const pending = api.syncWindowsAfterDisplayMetricsChange('test')
      api.route(target); gate.resolve(); await pending
      assert.equal(sent.length, target === 1 ? 0 : 1)
      if (target === 3) assert.equal(sent[0].bounds.x, 3840)
    })
  }
  await run('OUTPUT: reactive internal publisher holds the same lock as TAKE and discards cancelled frames', async () => {
    const lock = load('src/renderer/src/output-transition-lock.ts', {}, { window: { api: { dbgLog() {} } } })
    const file = 'src/renderer/src/components/ProgramScene/InternalProgramOutputBridge.tsx'
    const source = fs.readFileSync(path.join(root, file), 'utf8')
    const fragment = source.slice(source.indexOf('    const publish = async'), source.indexOf('    void publish().catch'))
    const ready = deferred(), sent = []
    const activeFile = { type: 'pdf', path: 'synthetic.pdf' }
    const state = { activeFile, currentSlide: 1, internalProgramOutputActive: true }
    const api = load(file, {}, { ...lock, cancelled: false, activeFile, currentSlide: 1,
      isNavigationTransitionActive: () => false, useAppStore: { getState: () => state },
      lastSignatureRef: { current: '' }, window: { api: { prepareInternalProgramOutput: () => ready.promise,
        sendToPresentation: (...args) => sent.push(args), setActiveContentType() {} } }
    }, fragment + '\nexport { publish }; export function cancel() { cancelled = true }')
    const pending = api.publish(); await flush()
    let acquired = false
    const take = lock.acquireOutputTransition('test-take').then(release => { acquired = true; release() })
    await flush(); assert.equal(acquired, false)
    api.cancel(); ready.resolve(); await pending; await take
    assert.equal(acquired, true); assert.equal(sent.length, 0)
  })
  await run('VC: only the current physical-source acknowledgement commits the route', async () => {
    const { manager: m } = virtualSetup(), c = child()
    m.process = c; m.internalProgram = true
    m.statusValue = { ...m.statusValue, phase: 'running', source: 'internal' }
    m.observeRuntimeStatus(c); m.usePhysicalProgramDisplay(2)
    const ack = requestId => c.stdout.emit('data', Buffer.from(JSON.stringify({ phase: 'source', message: 'display', requestId }) + '\n'))
    ack(m.sourceRequestId - 1)
    assert.equal(m.internalProgram, true)
    ack(m.sourceRequestId)
    assert.equal(m.displaySourceId, 2); assert.equal(m.internalProgram, false)
    m.stop()
  })
  await run('VC: capture recovery preserves the device and rejects stale route notifications', async () => {
    const { manager: m } = virtualSetup(), c = child()
    m.process = c; m.internalProgram = false; m.displaySourceId = 2; m.sourceRequestId = 8
    m.statusValue = { ...m.statusValue, phase: 'running', source: 'display' }
    m.observeRuntimeStatus(c)
    const emit = (phase, requestId = 8) => c.stdout.emit('data', Buffer.from(JSON.stringify({ phase, requestId, message: 'test' }) + '\n'))
    emit('capture-retrying', 7)
    assert.equal(m.statusValue.error, null)
    emit('capture-retrying')
    assert.ok(m.statusValue.error)
    assert.equal(m.statusValue.phase, 'running'); assert.equal(m.process, c); assert.equal(c.killed, false)
    emit('capture-recovered', 7)
    assert.ok(m.statusValue.error, 'stale recovery must not clear the current warning')
    emit('capture-recovered')
    assert.equal(m.statusValue.error, null); assert.equal(m.process, c)
    m.internalProgram = true; m.displaySourceId = null
    emit('capture-retrying')
    assert.equal(m.statusValue.error, null, 'desktop recovery must not mutate internal capture')
    m.process = child()
    m.internalProgram = false; m.displaySourceId = 2
    emit('capture-retrying')
    assert.equal(m.statusValue.error, null, 'old host must not mutate the replacement')
    m.stop()
  })
  await run('SHELL-1: topology invalidation survives late hide success', async () => {
    const clock = timers(), callbacks = []
    const primary = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }
    const external = { id: 2, bounds: { x: 1920, y: 0, width: 1920, height: 1080 } }
    const module = load('src/main/taskbar-manager.ts', {
      electron: { screen: { getDisplayMatching: () => external,
        getPrimaryDisplay: () => primary, dipToScreenRect: (_, r) => r } },
      child_process: { execFile: (...args) => callbacks.push(args.at(-1)) },
      util: require('node:util'), './diagnostic-log': diagnostics, './paths': { scriptPath: x => x }
    }, clock)
    const hide = module.hideTaskbarForDisplay(external.bounds); await flush()
    module.invalidateTaskbarVisibilityCache('monitor removed/re-added while helper is running')
    callbacks[0](null, '', ''); await hide
    const retry = module.hideTaskbarForDisplay(external.bounds); await flush()
    assert.equal(callbacks.length, 2, 'topology invalidation must survive late completion')
    callbacks[1](null, '', ''); await retry
  })
  await run('VC-1: Stop during registration check cancels Start', async () => {
    const { manager: m, children } = virtualSetup(), check = deferred()
    m.isInstalled = () => check.promise; m.waitUntilRunning = async () => {}
    const pending = m.start(null)
    m.stop(); check.resolve(true); await pending
    assert.equal(children.length, 0)
    assert.equal(m.statusValue.phase, 'idle')
    m.stop()
  })
  await run('VC-2: old Start rejection cannot stop a newer camera', async () => {
    const { manager: m, children } = virtualSetup(), a = deferred(), b = deferred()
    let n = 0; m.waitUntilRunning = () => (++n === 1 ? a.promise : b.promise)
    const old = m.start(null).catch(() => {}); await flush()
    m.stop()
    const fresh = m.start(null); await flush(); b.resolve(); await fresh
    assert.deepEqual(Array.from(children[1].args[1].slice(-2)), ['--request-id', String(m.sourceRequestId)])
    assert.equal(m.process, children[1]); assert.equal(m.statusValue.phase, 'running')
    a.reject(new Error('old startup failed')); await old
    assert.equal(m.process, children[1]); assert.equal(m.statusValue.phase, 'running')
  })
  await run('VC-3: unplug before physical-source ACK retains internal fallback', async () => {
    const { manager: m, screen } = virtualSetup(), c = child()
    m.process = c; m.internalProgram = true
    m.statusValue = { ...m.statusValue, phase: 'running', source: 'internal' }
    m.observeRuntimeStatus(c); m.usePhysicalProgramDisplay(2)
    const requestId = m.sourceRequestId
    const removed = screen.displays.pop(); screen.emit('display-removed', {}, removed)
    c.stdout.emit('data', Buffer.from(JSON.stringify({ phase: 'source', message: 'display', requestId }) + '\n'))
    assert.equal(screen.displays.some(d => d.id === m.displaySourceId), false)
    assert.equal(m.internalProgram, true); assert.equal(m.statusValue.source, 'internal')
    assert.equal(m.frameTimer, undefined)
    m.stop()
  })
  await run('DECK-1: simultaneous Connect calls open only one device', async () => {
    const { manager: m, opened } = deckSetup()
    m.renderKeys = async () => {}
    await Promise.all([m.connect(), m.connect()])
    assert.equal(opened.length, 1)
    assert.equal(opened[0].closed, false)
    await m.shutdown()
  })
  await run('DECK-2: old key-render failure preserves the replacement device', async () => {
    const { manager: m, makeDevice } = deckSetup(), panel = deferred()
    const old = makeDevice(); old.CONTROLS = [{ type: 'button', feedbackType: 'lcd', index: 0 }]
    m.device = old; m.status.connected = true; m.renderPanel = () => panel.promise
    const rendering = m.renderKeys([]); await flush()
    await m.disconnectDevice(true)
    const fresh = makeDevice(); m.device = fresh; m.status.connected = true
    panel.reject(new Error('old USB/render request failed')); await rendering
    assert.equal(fresh.closed, false); assert.equal(m.device, fresh)
    await m.shutdown()
  })
  await run('PPTX-1: old goto response preserves the new slide and navigation barrier', async () => {
    const file = 'src/renderer/src/stores/useAppStore.ts'
    const source = fs.readFileSync(path.join(root, file), 'utf8')
    const fragment = source.slice(source.indexOf('type PptxResult ='), source.indexOf('export type ContentType ='))
    const calls = [], state = { currentSlide: 20, setCurrentSlide(v) { state.currentSlide = v } }
    const navigation = load(file, {}, { ...timers(), useAppStore: { getState: () => state },
      window: { api: { dbgLog() {}, powerpointCommand: () => {
        const d = deferred(); calls.push(d); return d.promise
      } } } }, fragment + '\nexport { dispatchPptxGotoCollapsed }')
    const old = navigation.dispatchPptxGotoCollapsed(2)
    navigation.resetPptxNavState()
    const fresh = navigation.dispatchPptxGotoCollapsed(20)
    calls[0].resolve({ success: true, output: '{"CurrentSlide":2}' }); await old
    assert.equal(state.currentSlide, 20)
    let idle = false; navigation.awaitPptxGotoChainIdle().then(() => { idle = true }); await flush()
    assert.equal(idle, false, 'idle barrier must wait for the current navigation chain')
    calls[1].resolve({ success: true, output: '{"CurrentSlide":20}' }); await fresh
  })
  for (const rejection of [false, true]) {
    await run(`STREAM-${rejection ? 2 : 1}: old capture ${rejection ? 'failure cannot stop new stream' : 'cannot write into new encoder'}`, async () => {
      const clock = timers(), screen = new EventEmitter(), engines = [], pending = deferred()
      screen.getPrimaryDisplay = () => ({ id: 1 })
      const frame = name => ({ getSize: () => ({ width: 1920, height: 1080 }), toBitmap: () => Buffer.from(name) })
      let captures = 0
      const win = { isDestroyed: () => false, setIgnoreMouseEvents() {}, setOpacity() {}, isVisible: () => true,
        webContents: { capturePage: async () => (++captures === 2 ? pending.promise : frame('fresh')) } }
      class Engine {
        constructor() { this.frames = []; this.stopped = false; engines.push(this) }
        start() {} stop() { this.stopped = true }
        writeVideo(bytes) { this.frames.push(bytes.toString()); return Promise.resolve(true) }
      }
      const { StreamingManager } = load('src/main/streaming.ts', {
        electron: { app: { isPackaged: false, getAppPath: () => '/fake' }, screen,
          ipcMain: { handle() {}, on() {} } }, fs: { existsSync: () => true }, 'fs/promises': {}, path,
        './renderer-security': {}, net: {}, tls: {},
        '../shared/streaming': { validateStreamSettings: x => x },
        './streaming-engine': { StreamingEngine: Engine, rawVideoInputArguments: () => [] },
        './diagnostic-log': diagnostics
      }, clock)
      const m = new StreamingManager(() => null, () => null, () => win)
      m.command = async () => {}
      const settings = { encoder: 'software', fps: 30, resolution: '1080p', bitrateKbps: 4000, destinations: [] }
      await m.start(settings, null)
      m.frameTimer.fn(); await flush(); m.stop()
      await m.start(settings, null)
      assert.equal(m.status.phase, 'running')
      if (rejection) pending.reject(new Error('old window capture failed'))
      else pending.resolve(frame('STALE'))
      await flush()
      if (rejection) { assert.equal(engines[1].stopped, false); assert.equal(m.status.phase, 'running') }
      else assert.ok(!engines[1].frames.includes('STALE'))
      m.stop()
    })
  }
  for (const exitOutput of [true, false]) {
  await run(`SCENE: ${exitOutput ? 'output exit cancels' : 'closing editor preserves'} pending publication`, async () => {
    const file = 'src/renderer/src/components/ProgramScene/ProgramSceneModal.tsx'
    const source = fs.readFileSync(path.join(root, file), 'utf8')
    const fragment = source.slice(source.indexOf('  const publishSceneDraft ='), source.indexOf('  const setPictureVisible ='))
    const opening = deferred(), published = []
    const state = { programSnapshot: null, programScene: { enabled: false }, qrOverlay: {},
      activeFile: null, selectedChannel: null, isPresentationWindowOpen: false,
      setPresentationWindowOpen(v) { state.isPresentationWindowOpen = v },
      publishProgramSnapshot(channel, overrides) {
        published.push({ enabledBefore: state.programScene.enabled, channel, overrides }); return 1
      } }
    const scene = load(file, {}, { ...timers(),
      scenePublicationGeneration: 0, acquireOutputTransition: async () => () => {},
      useAppStore: { getState: () => state, subscribe: () => () => {} }, setProgramScene: x => Object.assign(state.programScene, x),
      previewChannelId: null, textOverlayDraft: [], mediaLayerDraft: [], hasQrData: () => false,
      connectedProgramDisplayId: () => 2, timerTimeDraft: { duration: 900, remaining: 900, running: true },
      timerOverlayDraft: { position: { x: 50, y: 50 }, scale: 1 },
      setTimerDraftDirty() {}, setTimerTimeDraftDirty() {}, publishQrOverlay: async () => {},
      isQrEditorOutputOwned: () => true,
      window: { addEventListener() {}, removeEventListener() {}, api: { openPresentationWindow: () => opening.promise, setActiveContentType() {}, dbgLog() {} } }
    }, fragment + '\nexport { publishSceneDraft }')
    const pending = scene.publishSceneDraft(true); await flush()
    // User exits output while openPresentationWindow is still pending.
    if (exitOutput) {
      state.programScene.enabled = false; state.programSnapshot = null
      state.isPresentationWindowOpen = false
    }
    opening.resolve(); await pending
    assert.equal(published.length, exitOutput ? 0 : 1)
    assert.equal(state.isPresentationWindowOpen, !exitOutput)
  })
  }
  await run('LIBRARY-1: late folder A response preserves folder B contents', async () => {
    const file = 'src/renderer/src/components/Library/FileLibrary.tsx'
    const source = fs.readFileSync(path.join(root, file), 'utf8')
    const fragment = source.slice(source.indexOf('  const navigateToPath ='), source.indexOf('  const handleNavigateToFolder ='))
    const a = deferred(), b = deferred(), state = {}
    const library = load(file, {}, { folderLoadRevision: { current: 0 }, useAppStore: { getState: () => ({ folderPath: state.path }) }, setFolderPath: v => { state.path = v }, setFiles: v => { state.files = v },
      setSubfolders: v => { state.subfolders = v }, window: { api: { loadFolder: p => p === 'A' ? a.promise : b.promise } }
    }, fragment + '\nexport { navigateToPath }')
    const old = library.navigateToPath('A'), fresh = library.navigateToPath('B')
    b.resolve({ files: ['B-file'], subfolders: [] }); await fresh
    a.resolve({ files: ['A-file'], subfolders: [] }); await old
    assert.equal(state.path, 'B'); assert.equal(state.files[0], 'B-file')
  })
  await run('QR-SECRET-1: clearing wins over a pending password save', async () => {
    const disk = new Map(), write = deferred()
    const api = load('src/main/secure-secrets.ts', {
      electron: { app: { getPath: () => '/fake-profile' }, safeStorage: {
        isEncryptionAvailable: () => true, encryptString: x => Buffer.from(x), decryptString: x => x.toString()
      } }, path,
      'fs/promises': { writeFile: async (p, bytes) => { await write.promise; disk.set(p, bytes) },
        rm: async p => { disk.delete(p) },
        rename: async (a, b) => { disk.set(b, disk.get(a)); disk.delete(a) },
        readFile: async p => { if (!disk.has(p)) throw new Error('ENOENT'); return disk.get(p) } }
    })
    const old = api.saveQrWifiPassword('synthetic-example')
    const cleared = api.saveQrWifiPassword('')
    write.resolve(); await old; await cleared
    assert.equal(await api.loadQrWifiPassword(), '')
  })
  console.log('21/21 race regressions passed; no real devices or live output used.')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
