import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { build } from 'esbuild'

async function moduleFrom(path) {
  const result = await build({
    entryPoints: [path],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false
  })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

const { normalizeProgramSceneBackground, normalizeProgramSceneMediaLayers } = await moduleFrom('src/shared/program-scene.ts')
const {
  isProgramSceneBackgroundChannelSupported,
  resolveProgramSceneBackground
} = await moduleFrom('src/renderer/src/program-scene-background.ts')

assert.deepEqual(normalizeProgramSceneBackground(undefined), {
  kind: 'image', imagePath: null, videoPath: null, channelId: null, loop: true, muted: true
})
assert.deepEqual(normalizeProgramSceneBackground({
  kind: 'video', videoPath: ' C:/clip.mp4 ', loop: false, muted: false
}), {
  kind: 'video', imagePath: null, videoPath: ' C:/clip.mp4 ', channelId: null, loop: false, muted: false
})
assert.equal(normalizeProgramSceneBackground({ kind: 'unknown' }).kind, 'image')
assert.deepEqual(normalizeProgramSceneMediaLayers(undefined), [])
assert.deepEqual(normalizeProgramSceneMediaLayers([
  { id: 'layer', kind: 'video', path: 'C:/clip.mp4', xPercent: 120, yPercent: -4, widthPercent: 2, aspectRatio: 0, aboveContent: false, loop: false, muted: false },
  { id: 'layer', kind: 'image', path: 'C:/logo.png' },
  { path: '' }
]).map(layer => ({
  id: layer.id, kind: layer.kind, x: layer.xPercent, y: layer.yPercent,
  width: layer.widthPercent, aspect: layer.aspectRatio, above: layer.aboveContent,
  loop: layer.loop, muted: layer.muted
})), [
  { id: 'layer', kind: 'video', x: 100, y: 0, width: 5, aspect: 0.1, above: false, loop: false, muted: false },
  { id: 'layer-2', kind: 'image', x: 50, y: 50, width: 38, aspect: 16 / 9, above: true, loop: true, muted: true }
])

const image = { id: 'image', name: 'Image', path: 'C:/image.png', type: 'other', extension: '.png', size: 1, isImage: true }
const video = { id: 'video', name: 'Video', path: 'C:/video.mp4', type: 'video', extension: '.mp4', size: 1 }
const pdf = { id: 'pdf', name: 'PDF', path: 'C:/slides.pdf', type: 'pdf', extension: '.pdf', size: 1 }
const pptx = { id: 'pptx', name: 'Slides', path: 'C:/slides.pptx', type: 'presentation', extension: '.pptx', size: 1 }
const capture = {
  id: 'capture', name: 'Camera', path: 'capture://background', type: 'capture', extension: 'LIVE', size: 0,
  capture: { sourceId: 'background', captureKind: 'device', videoDeviceId: 'device', videoLabel: 'Background camera', audioEnabled: false }
}
const unsupported = { id: 'doc', name: 'Document', path: 'C:/doc.docx', type: 'other', extension: '.docx', size: 1 }
for (const file of [image, video, pdf, pptx, capture]) {
  assert.equal(isProgramSceneBackgroundChannelSupported(file), true)
}
assert.equal(isProgramSceneBackgroundChannelSupported(unsupported), false)

const state = (background, file = null, slide = 1) => ({
  programScene: { background },
  backdropImage: 'C:/backdrop.png',
  channels: file ? { channel: { file, slide } } : {},
  pptxSlidesMap: { 'C:/slides.pptx': ['frame-1.png', 'frame-2.png'] },
  pptxThumbnailsMap: {}
})

assert.equal(resolveProgramSceneBackground(state({ kind: 'image', imagePath: 'C:/key-fill.png' })).path, 'C:/key-fill.png')
assert.equal(resolveProgramSceneBackground(state({ kind: 'image' })), null,
  'the global Scene backdrop must never become the chroma-key image fill')
assert.deepEqual(resolveProgramSceneBackground(state({ kind: 'video', videoPath: 'C:/lower.mp4', loop: false, muted: false })), {
  type: 'video', path: 'C:/lower.mp4', name: 'Фоновое видео', slide: 1, loop: false, muted: false
})
assert.equal(resolveProgramSceneBackground(state({ kind: 'channel', channelId: 'channel' }, image)).type, 'image')
assert.equal(resolveProgramSceneBackground(state({ kind: 'channel', channelId: 'channel' }, video)).type, 'video')
assert.equal(resolveProgramSceneBackground(state({ kind: 'channel', channelId: 'channel' }, pdf, 2)).slide, 2)
assert.equal(resolveProgramSceneBackground(state({ kind: 'channel', channelId: 'channel' }, pptx, 2)).path, 'frame-2.png')
assert.equal(resolveProgramSceneBackground(state({ kind: 'channel', channelId: 'channel' }, capture)).capture.sourceId, 'background')
assert.equal(resolveProgramSceneBackground(state({ kind: 'channel', channelId: 'missing' })), null)
assert.equal(resolveProgramSceneBackground(state({ kind: 'channel', channelId: 'channel' }, unsupported)), null)

const presentation = readFileSync('src/renderer/src/PresentationApp.tsx', 'utf8')
assert.match(presentation, /ProgramSceneBackgroundLayer[\s\S]*?source=\{programScene\.background\}[\s\S]*?participantStyle/)
assert.match(presentation, /backgroundSourceId=/)
assert.match(presentation, /backgroundSceneStyle=\{\{[\s\S]*?participantStyle/)
assert.match(presentation, /data-program-scene-canvas-background[\s\S]*?programScene\.backdropPath/)
assert.ok(
  presentation.indexOf('<ProgramSceneBackgroundLayer') <
    presentation.indexOf('<CaptureHub'),
  'the lower layer must be mounted before the participant camera'
)
assert.ok(
  presentation.indexOf('placement="below"') < presentation.indexOf('{slots.map'),
  'independent lower media layers must be mounted below presentation content'
)
assert.ok(
  presentation.indexOf('<CaptureHub') < presentation.lastIndexOf('placement="above"'),
  'independent upper media layers must be mounted above presentation and camera content'
)
const captureHub = readFileSync('src/renderer/src/components/PresentationView/CaptureHub.tsx', 'utf8')
assert.match(captureHub, /displayMode === 'scene' \? 4/)
assert.match(captureHub, /displayMode === 'background' \? 3/)
assert.match(captureHub, /displayMode === 'background'[\s\S]*?backgroundSceneStyle/)
assert.match(captureHub, /displayMode === 'background'[\s\S]*?object-cover/)
const backgroundLayer = readFileSync('src/renderer/src/components/ProgramScene/ProgramSceneBackgroundLayer.tsx', 'utf8')
assert.match(backgroundLayer, /data-program-scene-key-fill/)
assert.match(backgroundLayer, /style=\{\{ \.\.\.style, zIndex: 3 \}\}/)
const appConfig = readFileSync('src/renderer/src/app-config.ts', 'utf8')
assert.match(appConfig, /background: restoredSceneBackground/)
assert.match(appConfig, /chromaKey: normalizeProgramSceneChromaKey\(rawProgramScene\.chromaKey\)/)
assert.match(appConfig, /mediaLayers: restoredSceneMediaLayers/)
const storeSource = readFileSync('src/renderer/src/stores/useAppStore.ts', 'utf8')
assert.match(storeSource, /version:\s*44/)
assert.match(storeSource, /export type SceneDraft = ProgramSceneConfigState/)
assert.match(storeSource, /freezeProgramSnapshot/)
assert.match(storeSource, /publishProgramSnapshot: \(contentChannelId, overrides\)/)
assert.match(storeSource, /mediaLayers:\s*normalizeProgramSceneMediaLayers\(rawScene\.mediaLayers\)/)
assert.match(storeSource, /mediaLayersVisible:\s*rawScene\.mediaLayersVisible === true/)
const main = readFileSync('src/main/index.ts', 'utf8')
assert.match(main, /program-scene-media-overlay-update/)
assert.match(main, /createProgramSceneMediaOverlayWindow/)

const sceneModal = readFileSync('src/renderer/src/components/ProgramScene/ProgramSceneModal.tsx', 'utf8')
assert.match(sceneModal, /\['picture', 'Сцена для эфира'\]/)
assert.match(sceneModal, /\['titles', 'Титры'\]/)
assert.doesNotMatch(sceneModal, /\['layers', 'Слои'\]/)
assert.doesNotMatch(sceneModal, /\['text', 'Текст'\]/)
assert.doesNotMatch(sceneModal, /\['qr', 'QR-код'\]/)
assert.match(sceneModal, /data-scene-context-menu/)
assert.match(sceneModal, /data-scene-add="background"/)
assert.match(sceneModal, /data-scene-add="text"/)
assert.match(sceneModal, /data-scene-add="qr"/)
assert.match(sceneModal, /data-scene-add="timer"/)
assert.doesNotMatch(sceneModal, /data-scene-add="external"/)
assert.match(sceneModal, /data-scene-add="layer"/)
assert.doesNotMatch(sceneModal, /data-scene-add="(?:image|video)"/)
assert.match(sceneModal, /selectSceneLayerFiles\(\)/)
assert.match(sceneModal, /shown=\{qrOverlay\.sceneVisible !== false \|\| qrOverlay\.enabled\}/)
assert.match(sceneModal, /data-scene-manage="qr"[\s\S]*?setQrOverlay\(\{ sceneVisible: true \}\)/)
assert.match(sceneModal, /<SceneQrPreviewLayer/)
assert.match(sceneModal, /<SceneTimerPreviewLayer/)
assert.match(sceneModal, /<SceneTimerSettings/)
assert.match(sceneModal, /canvasSelection\?\.kind === 'timer'/)
assert.match(sceneModal, /position=\{timerOverlayDraft\.position\}/)
assert.match(sceneModal, /scale=\{timerOverlayDraft\.scale\}/)
assert.match(sceneModal, /publishProgramSnapshot\(channelToTake, \{/)
assert.match(sceneModal, /position: \{ \.\.\.timerOverlayDraft\.position \}/)
assert.match(sceneModal, /data-program-scene-refresh/)
assert.match(sceneModal, /data-program-scene-select-external-source/)
assert.match(sceneModal, /data-scene-external-source-picker/)
assert.match(sceneModal, /data-scene-external-source=/)
assert.match(sceneModal, /data-program-scene-participant-preview[\s\S]*?onClick=\{\(event\)/)
assert.match(sceneModal, /addEventListener\('wheel', changeCameraHeight, \{ passive: false \}\)/)
assert.match(sceneModal, /data-scene-object-action="chroma"/)
assert.match(sceneModal, /function ChromaKeyPanel/)
assert.match(sceneModal, /effectiveEditorPanel === 'chroma'/)
assert.doesNotMatch(sceneModal, /Фон под хромакеем/)
assert.match(sceneModal, /data-scene-manage="layers"/)
assert.match(sceneModal, /data-scene-manage="text"/)
assert.match(sceneModal, /data-scene-manage="qr"/)
assert.doesNotMatch(sceneModal, /data-scene-object-action="background"/)
assert.ok(sceneModal.indexOf('Добавить в сцену') < sceneModal.indexOf('data-scene-object-action="up"'),
  'Add to Scene must be above object actions')
assert.ok(sceneModal.indexOf('data-scene-manage="layers"') > sceneModal.indexOf('data-scene-object-action="chroma"'),
  'Configure must be below object actions')
assert.match(sceneModal, /data-program-scene-select-content/)
assert.match(sceneModal, /chooserOnly:\s*true/)
assert.doesNotMatch(sceneModal, /Сначала выберите фоновое изображение/)
assert.match(sceneModal, /data-scene-content-channel=/)
assert.match(sceneModal, /channel\.caption\.trim\(\) \|\| shortFileName\(file\.path\)/)
assert.match(sceneModal, /new CustomEvent\('take-channel', \{ detail: channelToTake \}\)/)
assert.match(sceneModal, /new CustomEvent\('close-program-output'\)/)
assert.match(sceneModal, /programIsLive \? 'Выйти из эфира' : 'Показать в эфире'/)
assert.match(sceneModal, /pptxSlidesMap\[previewFile\.path\]\s*\|\|\s*pptxThumbnailsMap/)
assert.match(sceneModal, /measuredContentFrame\?\.aspectRatio \?\? storedContentAspectRatio \?\? 16 \/ 9/)
assert.match(sceneModal, /contentHeightPercent/)
const mediaLayers = readFileSync('src/renderer/src/components/ProgramScene/ProgramSceneMediaLayers.tsx', 'utf8')
assert.match(mediaLayers, /zIndex: placement === 'below' \? 1 : 6, isolation: 'isolate'/)
assert.match(sceneModal, /placement="all"/)
assert.equal((sceneModal.match(/<ProgramSceneMediaLayerSurface/g) || []).length, 1)
assert.match(mediaLayers, /zIndex: placement === 'all' \? \(layer.aboveContent \? 6 : 1\)/)
assert.match(mediaLayers, /onReorder\(selected.id, 'down'\)/)
assert.doesNotMatch(mediaLayers, /onAddImage|onAddVideo/)
const ipcSource = readFileSync('src/main/ipc-handlers.ts', 'utf8')
assert.match(ipcSource, /buffer\.buffer\.slice\(buffer\.byteOffset, buffer\.byteOffset \+ buffer\.byteLength\)/)
assert.match(ipcSource, /select-scene-layer-files/)
assert.match(mediaLayers, /controlRevision/)
const textOverlays = readFileSync('src/renderer/src/components/ProgramScene/ProgramSceneTextOverlays.tsx', 'utf8')
assert.match(textOverlays, /data-program-scene-inline-text/)
assert.match(textOverlays, /contentEditable=\{interactive \? 'plaintext-only' : false\}/)
assert.match(textOverlays, /editingRef\.current/)
assert.match(textOverlays, /overlay\.visible !== false/)
assert.match(textOverlays, /data-program-scene-text-resize/)
assert.doesNotMatch(textOverlays, /data-program-scene-text-drag/)
assert.doesNotMatch(textOverlays, />\s*↔\s*</)
assert.match(textOverlays, /cursor-ew-resize[\s\S]*bg-transparent/)
assert.match(textOverlays, /Math\.hypot\(/)
const previewPanelTitles = readFileSync('src/renderer/src/components/Preview/PreviewPanel.tsx', 'utf8')
assert.match(previewPanelTitles, /data-channel-show-all-speaker-picker/)
assert.match(previewPanelTitles, /data-channel-show-all-speaker=/)
const qrOverlay = readFileSync('src/shared/qr-overlay.ts', 'utf8')
assert.match(qrOverlay, /sceneVisible:\s*raw\.sceneVisible !== false/)
const sceneQrPreview = readFileSync('src/renderer/src/components/ProgramScene/SceneQrPreviewLayer.tsx', 'utf8')
assert.match(sceneQrPreview, /data-qr-description-inline-editor/)
assert.match(sceneQrPreview, /onTextChange\(event\.currentTarget\.innerText/)
const sceneTimerPreview = readFileSync('src/renderer/src/components/ProgramScene/SceneTimerPreviewLayer.tsx', 'utf8')
assert.match(sceneTimerPreview, /onSelect\?\.\(\)/)
const sceneTimerSettings = readFileSync('src/renderer/src/components/ProgramScene/SceneTimerSettings.tsx', 'utf8')
assert.match(sceneTimerSettings, /data-program-scene-timer-settings/)
assert.match(sceneTimerSettings, /timerDuration > 0 \? timerDuration : 15 \* 60/)
assert.match(sceneTimerSettings, /onSetDuration\(seconds\)/)
assert.match(sceneTimerSettings, /data-program-scene-timer-adjust=\{minutes \* direction\}/)
assert.match(sceneTimerSettings, /Положение и оформление попадут в эфир после ↻/)
assert.match(sceneTimerSettings, /data-program-scene-timer-time/)
assert.match(sceneTimerSettings, /data-program-scene-timer-sound=\{sound\.kind\}/)
assert.match(sceneTimerSettings, /selectSoundFile\(\)/)
const timerControls = readFileSync('src/renderer/src/timer-controls.ts', 'utf8')
assert.match(timerControls, /TIMER_COMMAND_EVENT = 'pdm-timer-command'/)
assert.match(timerControls, /type: 'apply-state'/)
const timerControl = readFileSync('src/renderer/src/components/Controls/Timer.tsx', 'utf8')
assert.match(timerControl, /addEventListener\(TIMER_COMMAND_EVENT, handleSceneCommand\)/)
assert.match(timerControl, /timerOutputVisible/)
assert.match(timerControl, /timerOutputOwner === 'scene'/)
assert.match(timerControl, /setTimerOutputState\(false, null\)/)
assert.match(sceneModal, /publishProgramSnapshot\(channelToTake, \{/)
assert.match(sceneModal, /timerTimeDraftDirty/)
assert.match(sceneModal, /draft\.duration <= 0 && minutes > 0/)
assert.match(sceneModal, /selectedCapture && backgroundSource\?\.type === 'image'/)
assert.match(sceneModal, />Внешний источник \(камера\)<\/label>/)
const sceneBridge = readFileSync('src/renderer/src/components/ProgramScene/ProgramSceneBridge.tsx', 'utf8')
assert.match(sceneBridge, /externalMediaOverlayActive = active && programScene.mediaLayersVisible/)
assert.doesNotMatch(sceneBridge, /nativeContentActive && targetDisplayId/)
assert.doesNotMatch(sceneBridge, /programScene\.enabled && !!selectedCapture/)
assert.match(sceneBridge, /!!programSnapshot && programScene\.enabled/)
assert.doesNotMatch(sceneBridge, /programScene\.enabled && !!background/)
assert.doesNotMatch(presentation, /active:\s*raw\?\.active === true && !!capture/)
for (const path of [
  'src/renderer/src/components/AuxiliaryDisplays/AuxiliaryDisplayBridge.tsx',
  'src/renderer/src/components/QrOverlay/QrOverlayBridge.tsx',
  'src/renderer/src/components/QrOverlay/QrOverlayModal.tsx',
  'src/renderer/src/components/Preview/PreviewPanel.tsx',
  'src/renderer/src/program-display-routing.ts'
]) {
  const source = readFileSync(path, 'utf8')
  assert.doesNotMatch(source, /programScene\.enabled && !!selected(?:Scene)?Capture/)
  assert.doesNotMatch(source, /!!selected(?:Scene)?Capture && !!sceneBackground/)
}
const sceneCanvas = sceneModal.slice(sceneModal.indexOf('data-program-scene-preview'))
const contentSurfaceIndex = sceneCanvas.indexOf('className={`pdm-pip-content-preview')
assert.ok(
  sceneCanvas.indexOf('placement="all"') < contentSurfaceIndex,
  'the unified scene preview must draw lower layers below presentation content'
)
assert.ok(
  sceneCanvas.includes('zIndex: 2'),
  'the unified scene preview must draw upper layers above presentation content'
)
assert.ok(
  sceneCanvas.indexOf('placement="all"') < sceneCanvas.indexOf('<ProgramSceneTextOverlayLayer'),
  'the unified scene preview must draw text above media layers'
)
assert.ok(
  sceneCanvas.indexOf('<ProgramSceneTextOverlayLayer') < sceneCanvas.indexOf('<SceneQrPreviewLayer'),
  'the unified scene preview must draw QR above text'
)

const previewPanel = readFileSync('src/renderer/src/components/Preview/PreviewPanel.tsx', 'utf8')
assert.match(previewPanel, /data-channel-toggle-qr/)
assert.match(previewPanel, /qrOverlay\.enabled \? 'Скрыть QR-код' : 'Отобразить QR-код'/)
assert.doesNotMatch(previewPanel, /disabled=\{!hasQrData\(qrOverlay\)\}/)
assert.match(previewPanel, /new CustomEvent\('open-program-scene', \{ detail: \{ editor: 'qr' \} \}\)/)
assert.match(previewPanel, /const pixelRatio = Math\.min\(2, Math\.max\(1, window\.devicePixelRatio \|\| 1\)\)/)
assert.match(previewPanel, /canvas\.style\.width = .*scaledViewport\.width \/ pixelRatio/)
const toolbar = readFileSync('src/renderer/src/components/Controls/Toolbar.tsx', 'utf8')
assert.match(toolbar, /const isOutputActive = programScene\.enabled \|\|/)
assert.match(toolbar, /addEventListener\('close-program-output'/)
assert.match(toolbar, /addEventListener\('open-program-scene'/)
assert.match(toolbar, /initialEditor=\{programSceneInitialEditor\}/)

console.log('PASS: scene background, unified editor canvas, high-quality preview, media layers, persistence and native PowerPoint overlay wiring')
