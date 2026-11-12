// Exercise Mac recording lifecycle and IPC with isolated windows/devices.
// No real camera, microphone, dialogs or user profile are used.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

if (process.platform !== 'darwin') { console.log('SKIP: Mac recording lifecycle'); process.exit(0) }
const directory = mkdtempSync(join(tmpdir(), 'pdm-mac-record-lifecycle-'))
mkdirSync(join(directory, 'build')); writeFileSync(join(directory, 'build/mac-ffmpeg'), 'test encoder')
const pending = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const handlers = new Map(), ipcMain = new EventEmitter(), screen = new EventEmitter()
ipcMain.handle = (channel, fn) => handlers.set(channel, fn)
const state = { windows: [], engines: [], commands: [], powers: new Set(), saveCalls: 0, save: null, capture: null, stop: null, load: null, open: null }
const displays = [{ id: 1, label: 'Operator', bounds: { x: 0, y: 0, width: 1440, height: 900 }, scaleFactor: 1 },
  { id: 2, label: 'Program', bounds: { x: 1440, y: 0, width: 1720, height: 720 }, scaleFactor: 2 }]
screen.getAllDisplays = () => displays
screen.getPrimaryDisplay = () => displays[0]
screen.getDisplayMatching = bounds => bounds.x >= 1440 ? displays[1] : displays[0]
let powerSequence = 0, fileSequence = 0
class Window extends EventEmitter {
  constructor() {
    super(); state.windows.push(this)
    const wc = new EventEmitter(); this.webContents = wc
    wc.mainFrame = { url: '' }; wc.id = state.windows.length
    wc.isDestroyed = () => this.destroyed === true
    wc.getURL = () => wc.mainFrame.url
    wc.setWindowOpenHandler = () => {}
    wc.capturePage = () => state.capture?.promise ?? Promise.resolve(image)
    wc.send = (_channel, id, command, value) => {
      state.commands.push({ command, value })
      queueMicrotask(() => ipcMain.emit('record-reply', { sender: wc, senderFrame: wc.mainFrame }, id,
        command === 'devices' ? [{ id: 'mic', label: 'Microphone' }] : true))
    }
  }
  isDestroyed() { return this.destroyed === true }
  getBounds() { return { x: 0, y: 0, width: 1000, height: 700 } }
  loadFile(file) { this.webContents.mainFrame.url = pathToFileURL(file).href; return state.load?.promise ?? Promise.resolve() }
  loadURL(url) { this.webContents.mainFrame.url = url; return Promise.resolve() }
  destroy() { this.destroyed = true }
}
const image = { getSize: () => ({ width: 32, height: 18 }), toBitmap: () => Buffer.alloc(32 * 18 * 4) }
const fake = {
  app: { isPackaged: false, getAppPath: () => directory, getPath: () => directory }, BrowserWindow: Window,
  ipcMain, screen, session: { fromPartition: () => ({ setPermissionCheckHandler() {}, setPermissionRequestHandler() {}, setDisplayMediaRequestHandler() {} }) },
  dialog: { showSaveDialog: () => { state.saveCalls++; return state.save?.promise ?? Promise.resolve({ canceled: false, filePath: join(directory, `record-${++fileSequence}.mkv`) }) },
    showOpenDialog: () => state.open.promise },
  desktopCapturer: { getSources: async () => [{ display_id: '2' }] },
  systemPreferences: { getMediaAccessStatus: () => 'granted' },
  powerSaveBlocker: { start: () => { const id = ++powerSequence; state.powers.add(id); return id }, stop: id => state.powers.delete(id) }
}
class Engine {
  constructor() { state.engines.push(this) }
  start(...args) { this.args = args }
  writeVideo() { return Promise.resolve(true) }
  writeAudio() { return Promise.resolve(true) }
  snapshot() { return { frames: 12, fps: 30, droppedFrames: 0 } }
  stop() { return state.stop?.promise ?? Promise.resolve(true) }
}
globalThis.__pdmRecordingElectron = fake; globalThis.__pdmRecordingEngine = Engine
const previousVersion = process.getSystemVersion
process.getSystemVersion = () => '15.8.1'
delete process.env.ELECTRON_RENDERER_URL
const output = join(directory, 'fixture.cjs')
await build({ stdin: { contents: `export { MacRecordingManager, macRecordingInput, macRecordingSize } from './src/main/mac-recording'; export { rendererPageUrl } from './src/main/renderer-security'`, resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'cjs', outfile: output,
  plugins: [{ name: 'isolated-devices', setup(builder) {
    builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }))
    builder.onResolve({ filter: /\/recording-engine$/ }, () => ({ path: 'encoder', namespace: 'fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'encoder'
      ? 'export const RecordingEngine = globalThis.__pdmRecordingEngine'
      : `const value=globalThis.__pdmRecordingElectron; ${Object.keys(fake).map(key => `export const ${key}=value.${key};`).join('\n')}`, loader: 'js' }))
  }}] })
const { MacRecordingManager, macRecordingSize, macRecordingInput, rendererPageUrl } = createRequire(import.meta.url)(output)
const settings = { format: 'lossless-mkv', fps: 30, audio: 'none', microphoneId: '' }
let manager, control, program
const invoke = (channel, ...args) => handlers.get(channel)({ sender: control.webContents, senderFrame: control.webContents.mainFrame }, ...args)
const tick = () => new Promise(done => setTimeout(done, 0))
const setup = () => {
  handlers.clear(); ipcMain.removeAllListeners(); screen.removeAllListeners()
  state.windows = []; state.engines = []; state.commands = []; state.saveCalls = 0; state.save = null; state.capture = null; state.stop = null; state.load = null; state.open = null
  assert.equal(state.powers.size, 0)
  control = new Window(); control.webContents.mainFrame.url = rendererPageUrl('index.html')
  program = new Window(); manager = new MacRecordingManager(() => control, () => 2, () => program)
}
try {
  assert.deepEqual(macRecordingSize(7680, 4320), { width: 7680, height: 4320 })
  for (const size of [[0, 1080], [1920.5, 1080], [32768, 32768]]) assert.throws(() => macRecordingSize(...size))
  assert.ok(macRecordingInput(7680, 4320, 30).includes('7680x4320'))

  setup(); state.save = pending()
  const first = invoke('record-start', settings, null)
  await assert.rejects(async () => invoke('record-start', settings, null), /запускается|завершается/)
  assert.equal(state.saveCalls, 1, 'concurrent start must not open a second save dialog')
  state.save.resolve({ canceled: true }); assert.equal(await first, false)
  await manager.shutdown()
  console.log('PASS: duplicate starts cannot race through the save dialog')

  setup(); state.capture = pending()
  const oldStart = invoke('record-start', settings, null)
  const oldResult = oldStart.then(() => null, error => error)
  for (let i = 0; i < 20 && !state.commands.some(c => c.command === 'start'); i++) await tick()
  await tick(); await invoke('record-stop')
  state.capture.resolve(image)
  assert.match(String(await oldResult), /отменён/)
  assert.ok(state.engines.every(engine => !engine.args), 'cancelled first-frame capture must never spawn an encoder')
  assert.equal((await invoke('record-status')).phase, 'idle')
  await manager.shutdown()
  console.log('PASS: stop during first capture cannot leak an encoder or revive old status')

  setup(); state.load = pending()
  const oldLoad = state.load
  const loading = invoke('record-start', settings, null).then(() => null, error => error)
  for (let i = 0; i < 20 && state.windows.length < 3; i++) await tick()
  await invoke('record-stop'); state.load = null
  assert.equal(await invoke('record-start', settings, null), true)
  oldLoad.resolve(); assert.match(String(await loading), /остановлен|отменён/)
  assert.equal(state.commands.filter(c => c.command === 'start').length, 1, 'old start must not send commands to the replacement audio worker')
  assert.equal((await invoke('record-status')).phase, 'running')
  await manager.shutdown()
  console.log('PASS: cancelled page load cannot hijack the next audio worker')

  setup(); state.open = pending()
  const selecting = invoke('record-edit-open', false)
  await assert.rejects(async () => invoke('record-start', settings, null), /монтажа/)
  await assert.rejects(async () => invoke('record-edit-open', false), /выбора/)
  state.open.resolve({ canceled: true, filePaths: [] }); assert.equal(await selecting, null)
  await manager.shutdown()
  console.log('PASS: editor file selection cannot race recording or a second file dialog')

  setup(); assert.equal(await invoke('record-start', settings, 2), true)
  assert.equal((await invoke('record-status')).phase, 'running')
  const args = state.engines[0].args
  assert.ok(args[1].includes('3440x1440'), 'recording must preserve physical pixels on Retina outputs')
  assert.deepEqual(args[4].args.slice(1), ['3440', '1440', '30', '--record'])
  assert.equal(state.powers.size, 1)
  state.stop = pending()
  const stopping = invoke('record-stop')
  await assert.rejects(async () => invoke('record-start', settings, 2), /запускается|завершается/)
  state.stop.resolve(true); await stopping
  assert.equal((await invoke('record-status')).phase, 'idle'); assert.equal(state.powers.size, 0)
  await manager.shutdown()
  console.log('PASS: native capture preserves output dimensions and finalization blocks a new start')

  setup(); await invoke('record-start', settings, 2)
  screen.emit('display-removed', {}, displays[1]); await tick(); await tick()
  assert.equal((await invoke('record-status')).phase, 'error')
  assert.match((await invoke('record-status')).error, /отключён/)
  assert.equal(state.powers.size, 0); await manager.shutdown()
  console.log('PASS: unplugging the Program screen stops capture and releases the power request')

  setup(); await invoke('record-start', settings, 2); await manager.beforeProgramHide()
  assert.equal((await invoke('record-status')).phase, 'idle'); await manager.shutdown()
  console.log('PASS: physical recording finishes before Program can expose the desktop')

  setup(); const local = control.webContents.mainFrame.url
  control.webContents.mainFrame.url = 'https://example.invalid/index.html'
  assert.throws(() => invoke('record-status'), /Недоступно/)
  assert.throws(() => invoke('record-edit-status'), /Недоступно/)
  control.webContents.mainFrame.url = local
  process.getSystemVersion = () => '13.6'
  await assert.rejects(async () => invoke('record-start', { ...settings, audio: 'system' }, null), /14\.2/)
  process.getSystemVersion = () => '15.8.1'
  await manager.shutdown()
  console.log('PASS: remote origins are denied and unsupported system audio is explained before opening a file')
} finally {
  await manager?.shutdown()
  process.getSystemVersion = previousVersion
  delete globalThis.__pdmRecordingElectron; delete globalThis.__pdmRecordingEngine
  rmSync(directory, { recursive: true, force: true })
}
