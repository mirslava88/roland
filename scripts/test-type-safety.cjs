// Exercise the runtime contracts behind the strict-type fixes without real
// screens, Office, USB, user configuration, or network access.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { build, transformSync } = require('esbuild')
const source = file => fs.readFileSync(file, 'utf8')
function fragment(text, from, to) {
  const start = text.indexOf(from), end = text.indexOf(to, start)
  assert.ok(start >= 0 && end > start, `Source anchors must exist: ${from}`)
  return text.slice(start, end)
}
function evaluate(text, globals = {}) {
  const exports = {}
  const context = { module: { exports }, exports, console, ...globals }
  vm.runInNewContext(transformSync(text, { loader: 'ts', format: 'cjs' }).code, context)
  return context.module.exports
}

async function checkDisplayGuards() {
  const main = source('src/main/index.ts')
  const primary = { id: 10, bounds: { x: 0, y: 0, width: 1280, height: 800 } }
  const external = { id: 20, bounds: { x: 1280, y: 0, width: 1920, height: 1080 } }
  // Real Electron Display has no isPrimary property.
  let primaryId = primary.id
  const screen = { getAllDisplays: () => [primary, external], getPrimaryDisplay: () => ({ id: primaryId }),
    dipToScreenRect: (_, bounds) => bounds }
  let showCount = 0
  const handlers = {}
  const globals = {
    screen, timerActive: false, wpfTimerDisplayId: null,
    showWpfTimer: () => { showCount++ }, startWpfTimerMirrorSync() {},
    handleControl: (name, fn) => { handlers[name] = fn },
    ipcMain: { on: (name, fn) => { handlers[name] = fn }, handle: (name, fn) => { handlers[name] = fn } },
    isTrustedWindowMainFrame: () => true, controlWindow: {}, qrOverlayRevision: 0, programSceneMediaOverlayRevision: 0
  }
  evaluate(fragment(main, "handleControl('show-timer-overlay'", "handleControl('hide-timer-overlay'"), globals)
  // Execute each real handler up to window creation. Returning the target here
  // avoids constructing native windows; all validation above it stays real.
  evaluate(fragment(main, "ipcMain.on('qr-overlay-update'", '    let win = qrOverlayWindow') + 'return display.id\n})', globals)
  evaluate(fragment(main, "ipcMain.handle('program-scene-media-overlay-update'", '    let win = programSceneMediaOverlayWindow') + 'return display.id\n})', globals)
  for (const primaryTarget of [10, 20]) {
    primaryId = primaryTarget
    const externalTarget = primaryTarget === 10 ? 20 : 10
    const before = showCount
    for (const id of [primaryTarget, 999, undefined]) await handlers['show-timer-overlay']({}, id)
    assert.equal(showCount, before, 'native timer must not open on primary/missing/unspecified display')
    await handlers['show-timer-overlay']({}, externalTarget)
    assert.equal(showCount, before + 1)
    const qr = { visible: true, imageDataUrl: 'data:image/png;base64,synthetic' }
    assert.equal(await handlers['qr-overlay-update']({}, { ...qr, displayId: primaryTarget }), undefined)
    assert.equal(await handlers['qr-overlay-update']({}, { ...qr, displayId: 999 }), undefined)
    assert.equal(await handlers['qr-overlay-update']({}, { ...qr, displayId: externalTarget }), externalTarget)
    const media = { visible: true, layers: [{ path: 'C:/synthetic.png', aboveContent: true }] }
    assert.equal((await handlers['program-scene-media-overlay-update']({}, { ...media, displayId: primaryTarget })).success, false)
    assert.equal((await handlers['program-scene-media-overlay-update']({}, { ...media, displayId: 999 })).success, false)
    assert.equal(await handlers['program-scene-media-overlay-update']({}, { ...media, displayId: externalTarget }), externalTarget)
  }
  console.log('PASS: timer/QR/media native guards reject primary and missing displays, including primary reassignment')
}

function checkLayerOrdering() {
  const text = source('src/renderer/src/components/ProgramScene/ProgramSceneMediaLayers.tsx')
  const { moveProgramSceneMediaLayer: move } = evaluate(fragment(text, 'export function moveProgramSceneMediaLayer(', 'export function ProgramSceneMediaLayerSurface('))
  const layers = [{ id: 'under', kind: 'image', aboveContent: false }, { id: 'over', kind: 'video', aboveContent: true }]
  const raised = move(layers, 'under', 'up')
  assert.equal(raised.length, 2)
  assert.equal(raised[0].aboveContent, true)
  assert.equal(layers[0].aboveContent, false, 'draft moves must not mutate published layers')
  const lowered = move(raised, 'under', 'down')
  assert.equal(lowered[0].aboveContent, false)
  assert.ok(lowered.every(layer => layer.kind !== 'content' && layer.id), 'presentation sentinel must not become a media layer')
  assert.equal(move(layers, 'missing', 'up'), layers)
  assert.equal(move(layers, 'under', 'down'), layers)
  console.log('PASS: layer movement above/below presentation, immutable inputs, boundary/missing IDs')
}

async function checkConfigAndPlayback() {
  const bundle = await build({ stdin: { contents: `
export { loadAppConfigFromFile, saveCurrentAppConfig } from './src/renderer/src/app-config';
export { useAppStore } from './src/renderer/src/stores/useAppStore';
`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', write: false,
    plugins: [{ name: 'no-pdf-hardware', setup(builder) {
      builder.onResolve({ filter: /pdfium-renderer$/ }, () => ({ path: 'pdfium', namespace: 'stub' }))
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const releasePdfiumResources=()=>{}; export const warmPdfiumDocument=()=>{throw new Error("Unexpected PDF load")};' }))
    } }] })
  let raw = {}, saved = null
  const storage = new Map()
  const localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }
  const noop = async () => {}
  const api = {
    loadAppConfig: async () => ({ success: true, content: JSON.stringify(raw) }),
    saveAppConfig: async text => { saved = JSON.parse(text); return { success: true } },
    validateConfigPaths: async paths => paths.map(path => ({ path, exists: !path.includes('missing'), isDirectory: false })),
    toggleGlobalHook: async enabled => enabled, watchFolder: noop,
    musicStop: noop, musicSetPlaylist: noop, musicSetLoopTrack: noop, musicSetLoopPlaylist: noop, musicSetVolume: noop,
    getAudioDevices: async () => [], musicGetState: async () => null
  }
  const module = { exports: {} }
  vm.runInNewContext(bundle.outputFiles[0].text, { exports: module.exports, module, console, localStorage, window: { api }, setTimeout, clearTimeout, process: { env: { NODE_ENV: 'test' } } })
  const { useAppStore, loadAppConfigFromFile, saveCurrentAppConfig } = module.exports
  const id = useAppStore.getState().channelIds[0]
  const file = { id: 'synthetic', name: 'Synthetic', type: 'video', path: 'C:/synthetic.mp4', extension: '.mp4', size: 1 }
  const base = { format: 'pdm-configuration', schemaVersion: 1, channels: { items: [{ file }] } }
  for (const [requested, path, expected] of [[id, file.path, id], ['absent', file.path, null], [id, 'C:/missing.mp4', null], [undefined, file.path, null]]) {
    raw = { ...base, channels: { items: [{ file: { ...file, path } }] }, programScene: { contentChannelId: requested, enabled: true } }
    const result = await loadAppConfigFromFile()
    assert.equal(result.error, undefined)
    assert.equal(useAppStore.getState().programScene.contentChannelId, expected)
    assert.equal(useAppStore.getState().programScene.enabled, false, 'import must not send a saved Scene on air')
    assert.equal(useAppStore.getState().activeFile, null)
  }
  raw = { ...base, programScene: { contentChannelId: id } }
  await loadAppConfigFromFile()
  await saveCurrentAppConfig()
  assert.equal(saved.programScene.contentChannelId, id, 'Scene selection must survive a save/load round trip')
  raw = saved
  await loadAppConfigFromFile()
  assert.equal(useAppStore.getState().programScene.contentChannelId, id)
  useAppStore.getState().setVideoPlayback(file.path, { currentTime: 12 })
  let playback = useAppStore.getState().videoPlayback[file.path]
  assert.equal(playback.currentTime, 12); assert.equal(playback.duration, 0); assert.equal(playback.playing, true)
  useAppStore.getState().setVideoPlayback(file.path, { playing: false, duration: 90 })
  playback = useAppStore.getState().videoPlayback[file.path]
  assert.equal(playback.currentTime, 12); assert.equal(playback.duration, 90); assert.equal(playback.playing, false)
  console.log('PASS: Scene config round trip, old/missing/invalid channel restoration, import stays off air, partial video updates')
}

async function main() {
  await checkDisplayGuards()
  checkLayerOrdering()
  await checkConfigAndPlayback()
}
main().catch(error => { console.error(error); process.exitCode = 1 })
