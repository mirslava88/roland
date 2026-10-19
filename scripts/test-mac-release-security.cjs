const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const { transformSync } = require('esbuild')
function load(file, platform, app) {
  const module = { exports: {} }
  const code = transformSync(fs.readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' }).code
  vm.runInNewContext(code, { module, exports: module.exports, URL,
    __dirname: path.resolve('src/main'), process: { platform, env: {} },
    require: name => name === 'electron' ? { app } : require(name) })
  return module.exports
}
for (const [platform, packaged] of [['darwin', true], ['darwin', false], ['win32', true]]) {
  const removed = [], app = { isPackaged: packaged, commandLine: { removeSwitch: s => removed.push(s) }, enableSandbox: () => removed.push('sandbox') }
  const api = load('src/main/mac-release-security.ts', platform, app)
  api.hardenMacReleaseRuntime()
  assert.equal(removed.length, platform === 'darwin' && packaged ? 5 : 0)
  assert.equal(api.macReleaseWebPreferences().devTools, platform === 'darwin' && packaged ? false : undefined)
}
const app = { isPackaged: true }
const trust = load('src/main/renderer-security.ts', 'darwin', app)
const local = trust.rendererPageUrl('index.html')
assert.equal(trust.matchesRendererPage(local, 'index.html'), true)
assert.equal(trust.matchesRendererPage(local + '?role=test#slide', 'index.html'), true)
assert.equal(trust.matchesRendererPage(local.replace('file:///', 'file://untrusted-host/'), 'index.html'), false)
assert.equal(trust.matchesRendererPage(local.replace('file:', 'untrusted:'), 'index.html'), false)
const frame = { url: local }, contents = { isDestroyed: () => false, mainFrame: frame }
const win = { isDestroyed: () => false, webContents: contents }
assert.equal(trust.isTrustedWindowMainFrame({ sender: contents, senderFrame: frame }, win, 'index.html'), true)
assert.equal(trust.isTrustedWindowMainFrame({ sender: contents, senderFrame: { url: local } }, win, 'index.html'), false)
assert.equal(trust.isTrustedWindowMainFrame({ sender: { ...contents }, senderFrame: frame }, win, 'index.html'), false)
const { builderConfig, editionInfo } = require('../build/editions.cjs')
for (const edition of ['stream', 'standard']) {
  const mac = builderConfig(edition, 'darwin'), windows = builderConfig(edition, 'win32')
  assert.equal(mac.electronVersion, require('../build/mac-runtime.json').electronVersion)
  assert.ok(mac.afterPack.endsWith('afterPack-mac.cjs'))
  assert.ok(windows.afterPack.endsWith('afterPack.js'))
  assert.equal(windows.electronVersion, undefined)
  const suffix = edition === 'stream' ? '-stream' : ''
  assert.equal(editionInfo(edition, 'darwin').version, require('../build/mac-runtime.json').appVersion + suffix)
  assert.equal(editionInfo(edition, 'win32').version, require('../package.json').version.replace(/-stream$/, '') + suffix)
  const baseline = `/private/tmp/pdm-security-windows-${edition}-before.json`
  if (fs.existsSync(baseline)) {
    const expected = JSON.parse(fs.readFileSync(baseline, 'utf8'))
    // The Mac toolchain copies sources into an isolated workspace. The hook
    // remains identical; only its absolute checkout path changes.
    assert.equal(windows.afterPack, path.resolve(__dirname, '../build/afterPack.js'))
    expected.afterPack = windows.afterPack
    assert.deepEqual(windows, expected, 'Windows builder configuration changed')
  }
}
console.log('PASS: Mac release sandbox/debugging policy, exact IPC origin/frame checks, Mac-only Electron configuration; Windows policy unchanged')
