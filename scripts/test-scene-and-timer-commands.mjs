import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'

async function moduleFrom(path) {
  const result = await build({ entryPoints: [path], bundle: true, platform: 'node', format: 'esm', write: false })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

const { resolveProgramSceneChannel } = await moduleFrom('src/renderer/src/program-scene-channel.ts')
const { reduceTimerCommand, shouldRenderTimerInProgramRenderer, shouldShowTimerOnProgram } = await moduleFrom('src/renderer/src/timer-controls.ts')
const { selectProgramSnapshotTimer } = await moduleFrom('src/renderer/src/program-snapshot-timer.ts')

const channels = {
  live: { file: { path: 'live.pdf' } },
  stale: { file: { path: 'stale.pptx' } },
  selected: { file: { path: 'selected.mp4' } },
  empty: { file: null }
}
assert.equal(resolveProgramSceneChannel({
  liveChannel: 'live', sceneContentChannelId: 'stale', selectedChannel: 'selected', channels
}), 'live', 'the committed live channel must win over stale Scene draft state')
assert.equal(resolveProgramSceneChannel({
  liveChannel: 'missing', sceneContentChannelId: 'stale', selectedChannel: 'selected', channels
}), 'stale')
assert.equal(resolveProgramSceneChannel({
  liveChannel: null, sceneContentChannelId: 'empty', selectedChannel: 'selected', channels
}), 'selected')
assert.equal(resolveProgramSceneChannel({
  liveChannel: null, sceneContentChannelId: null, selectedChannel: 'empty', channels
}), null)

const base = {
  duration: 900,
  remaining: 300,
  running: false,
  outputVisible: false,
  outputOwner: null,
  warned: false,
  ended: false
}
let timer = reduceTimerCommand(base, { type: 'start' })
assert.deepEqual(timer, { ...base, running: true, outputVisible: true, outputOwner: 'toolbar' })
timer = reduceTimerCommand(timer, { type: 'pause' })
assert.equal(timer.running, false)
assert.equal(timer.outputVisible, true, 'pause must not remove timer from output')

timer = reduceTimerCommand({ ...base, duration: 300, remaining: 300, outputVisible: true, outputOwner: 'scene' }, {
  type: 'add-minutes', minutes: -10
})
assert.equal(timer.duration, 300, '+/- minutes must not change the Reset baseline')
assert.equal(timer.remaining, -300)
assert.equal(timer.outputVisible, true, 'overtime after subtraction must remain visible')
assert.equal(timer.outputOwner, 'scene')

assert.equal(shouldRenderTimerInProgramRenderer(true, null, true), true,
  'without a physical Program display the internal output must draw the timer')
assert.equal(shouldRenderTimerInProgramRenderer(true, 42, true), false,
  'with a physical Program display the native timer must be the only visible timer')
assert.equal(shouldRenderTimerInProgramRenderer(false, null, true), false,
  'an inactive internal output must not draw a timer')
assert.equal(shouldRenderTimerInProgramRenderer(true, null, false), false,
  'a timer routed to its own display must not leak into Program')

const unsetTimer = { ...base, duration: 0, remaining: 0 }
assert.equal(
  reduceTimerCommand(unsetTimer, { type: 'add-minutes', minutes: -5 }),
  unsetTimer,
  'subtracting from an unset timer must not create an invisible negative timer'
)
assert.deepEqual(
  reduceTimerCommand(unsetTimer, { type: 'add-minutes', minutes: 5 }),
  { ...unsetTimer, duration: 300, remaining: 300, outputVisible: true, outputOwner: 'toolbar' },
  'a positive adjustment may initialize an unset timer consistently with Scene'
)

assert.equal(shouldShowTimerOnProgram({
  duration: 900, outputVisible: true, outputOwner: 'toolbar', hasDedicatedTimerDisplay: false
}), true)
assert.equal(shouldShowTimerOnProgram({
  duration: 900, outputVisible: true, outputOwner: 'toolbar', hasDedicatedTimerDisplay: true
}), false, 'a toolbar timer assigned to its own screen must not leak into Program')
assert.equal(shouldShowTimerOnProgram({
  duration: 900, outputVisible: true, outputOwner: 'scene', hasDedicatedTimerDisplay: true
}), true, 'a Scene timer remains a Program overlay even with a dedicated timer display')

timer = reduceTimerCommand({ ...base, remaining: -5, warned: true, ended: true }, {
  type: 'add-minutes', minutes: 5
})
assert.equal(timer.remaining, 295)
assert.equal(timer.warned, false)
assert.equal(timer.ended, false)
assert.equal(timer.outputVisible, true)

timer = reduceTimerCommand(base, {
  type: 'apply-state', duration: 900.4, remaining: 61.2, running: true
})
assert.equal(timer.duration, 900)
assert.equal(timer.remaining, 61)
assert.equal(timer.outputOwner, 'scene')
assert.equal(timer.outputVisible, true)
assert.equal(timer.warned, false)

timer = reduceTimerCommand({ ...timer, remaining: -12, warned: true, ended: true }, { type: 'reset' })
assert.equal(timer.remaining, 900)
assert.equal(timer.running, false)
assert.equal(timer.outputVisible, true)
assert.equal(timer.outputOwner, 'scene')
assert.equal(timer.warned, false)
assert.equal(timer.ended, false)

timer = reduceTimerCommand(timer, { type: 'stop' })
assert.deepEqual(timer, {
  duration: 0, remaining: 0, running: false,
  outputVisible: false, outputOwner: null, warned: false, ended: false
})
assert.equal(reduceTimerCommand(base, { type: 'set-duration', seconds: 0 }), base)
assert.equal(reduceTimerCommand({ ...base, duration: 0 }, { type: 'start' }).outputVisible, false)

const publishedSceneTimer = {
  duration: 900,
  remaining: 420,
  running: true,
  visible: true,
  position: { x: 74, y: 12 },
  scale: 1.4
}
const independentToolbarTimer = {
  ...publishedSceneTimer,
  duration: 600,
  remaining: 295,
  position: { x: 50, y: 50 }
}
let selectedTimer = selectProgramSnapshotTimer(undefined, publishedSceneTimer, independentToolbarTimer)
assert.deepEqual(selectedTimer.timer, publishedSceneTimer, 'QR-only publication must preserve the published Scene timer')
assert.equal(selectedTimer.applyToLiveTimer, false, 'QR-only publication must not take ownership of the live toolbar timer')
assert.notEqual(selectedTimer.timer.position, publishedSceneTimer.position, 'published timer geometry must remain immutable')

selectedTimer = selectProgramSnapshotTimer(independentToolbarTimer, publishedSceneTimer, publishedSceneTimer)
assert.deepEqual(selectedTimer.timer, independentToolbarTimer, 'an explicit Scene timer publication must use the new draft')
assert.equal(selectedTimer.applyToLiveTimer, true, 'only an explicit timer publication may replace live timer state')

const [auxiliaryBridge, auxiliaryApp, outputPreload, mainProcess, timerControl, appStore, timerOverlayScript, windowsSource, sceneModal, sceneBridge, presentationApp, sceneTimerLayer] = await Promise.all([
  readFile('src/renderer/src/components/AuxiliaryDisplays/AuxiliaryDisplayBridge.tsx', 'utf8'),
  readFile('src/renderer/src/AuxiliaryApp.tsx', 'utf8'),
  readFile('src/preload/output.ts', 'utf8'),
  readFile('src/main/index.ts', 'utf8'),
  readFile('src/renderer/src/components/Controls/Timer.tsx', 'utf8'),
  readFile('src/renderer/src/stores/useAppStore.ts', 'utf8'),
  readFile('scripts/timer-overlay.ps1', 'utf8'),
  readFile('src/main/windows.ts', 'utf8'),
  readFile('src/renderer/src/components/ProgramScene/ProgramSceneModal.tsx', 'utf8'),
  readFile('src/renderer/src/components/ProgramScene/ProgramSceneBridge.tsx', 'utf8'),
  readFile('src/renderer/src/PresentationApp.tsx', 'utf8'),
  readFile('src/renderer/src/components/ProgramScene/SceneTimerPreviewLayer.tsx', 'utf8')
])
assert.match(auxiliaryApp, /role === 'timer'[\s\S]*sendToControl\('timer-state-ready'/,
  'a newly opened timer display must announce that its listeners are ready')
assert.match(auxiliaryBridge, /on\('timer-state-ready'[\s\S]*sendToAuxiliary\('timer', 'information-state'[\s\S]*sendToAuxiliary\('timer', 'timer-update'/,
  'the timer ready handshake must replay visibility and the complete running timer snapshot')
assert.match(outputPreload, /'timer-state-ready'/,
  'the restricted output preload must allow the timer ready handshake')
assert.match(mainProcess, /timer: new Set\(\['timer-state-ready'\]\)/,
  'main must accept the timer handshake only from a timer auxiliary window')
assert.match(mainProcess, /channel === 'program-mirror-state-ready'[\s\S]*broadcastWpfTimerToMirrors\(true\)/,
  'a newly ready live copy must receive the current program timer overlay')
assert.match(auxiliaryApp, /PROGRAM_MIRROR_RETRY_DELAY_MS[\s\S]*retry scheduled[\s\S]*setReconnectRevision/,
  'a live copy must continue reconnecting after transient Windows capture failures')
assert.doesNotMatch(auxiliaryApp, /failure < PROGRAM_MIRROR_MAX_RETRIES/,
  'a live copy must not permanently stop after a fixed number of retries')
assert.match(timerControl, /data-timer-speaker-output[\s\S]*disabled=\{!hasSpeakerDisplay\}[\s\S]*Отправить в суфлёр/,
  'the timer panel must enable its speaker-output checkbox only for a connected speaker display')
assert.match(appStore, /timerSpeakerOutputEnabled: boolean[\s\S]*setTimerSpeakerOutputEnabled[\s\S]*timerSpeakerOutputEnabled: false/,
  'speaker timer routing must have an explicit session state instead of changing normal timer output ownership')
assert.match(appStore, /timerSpeakerPosition: \{ x: number; y: number \}[\s\S]*timerSpeakerScale: number[\s\S]*setTimerSpeakerPosition[\s\S]*setTimerSpeakerScale/,
  'speaker timer placement and scale must be independent from the normal program timer layout')
assert.match(appStore, /timerSpeakerPosition: state\.timerSpeakerPosition,[\s\S]*timerSpeakerScale: state\.timerSpeakerScale/,
  'speaker timer placement and scale must survive an application restart')
assert.equal((timerControl.match(/data-timer-layout-preview/g) || []).length, 1,
  'timer settings must render exactly one shared output preview')
assert.match(timerControl, /data-timer-layout-preview[\s\S]*onPointerDown[\s\S]*onPointerMove[\s\S]*onWheel/,
  'the shared timer preview must provide direct drag and wheel controls')
assert.match(timerControl, /hasSpeakerDisplay && timerSpeakerOutputEnabled[\s\S]*data-timer-preview-selector[\s\S]*data-timer-preview-target="program"[\s\S]*data-timer-preview-target="speaker"/,
  'enabling speaker output must reveal a target selector above the same preview')
assert.match(timerControl, /timerPreviewTarget[\s\S]*activePreviewTarget[\s\S]*data-preview-target=\{activePreviewTarget\}/,
  'the single preview must switch between program and speaker layouts instead of rendering both')
assert.match(timerControl, /programDraftPosition[\s\S]*speakerDraftPosition[\s\S]*data-timer-layout-refresh[\s\S]*setTimerSpeakerPosition\(speakerDraftPosition\)[\s\S]*setTimerSpeakerScale\(speakerDraftScale\)[\s\S]*setTimerOverlayPosition\(programDraftPosition\)[\s\S]*setTimerOverlayScale\(programDraftScale\)/,
  'each output geometry must remain an independent draft until the shared round refresh button publishes it')
assert.match(timerControl, /timerPreviewValueRef[\s\S]*timer\.offsetWidth \* scale \/ preview\.clientWidth[\s\S]*timer\.offsetHeight \* scale \/ preview\.clientHeight[\s\S]*clampSpeakerDraftPosition/,
  'speaker timer dragging must keep the complete scaled text inside the preview instead of clamping only its center')
assert.match(timerControl, /horizontalInset = Math\.max\(8,[\s\S]*verticalInset = Math\.max\(8,/,
  'speaker preview clamping must use the same 8–92 percent contract as the persisted speaker output')
assert.match(timerControl, /speakerOutputFontSize = Math\.max\(34, Math\.min\(speakerDisplayWidth \* 0\.048, 82\)\)[\s\S]*speakerPreviewFontCqw[\s\S]*containerType: 'inline-size'[\s\S]*fontSize: `\$\{speakerPreviewFontCqw\}cqw`/,
  'speaker preview timer typography must use the exact relative size of the assigned speaker display')
assert.match(timerControl, /const nextScale =[\s\S]*setSpeakerDraftScale\(nextScale\)[\s\S]*clampSpeakerDraftPosition\(current, nextScale\)/,
  'speaker timer wheel scaling must pull the timer back inside the preview when its footprint grows')
assert.match(timerControl, /speakerCurrentFrame[\s\S]*mediaUrl\(speakerCurrentFrame\)[\s\S]*speakerNextFrame[\s\S]*mediaUrl\(speakerNextFrame\)/,
  'the speaker timer preview must show the real current and next speaker frames')
assert.match(timerControl, /updateProgramTimerPosition[\s\S]*availableWidth[\s\S]*desiredLeft[\s\S]*setProgramDraftPosition/,
  'program timer dragging must use the available output travel after accounting for the timer footprint')
assert.match(timerControl, /programPreviewFontCqw[\s\S]*transform: `translate\(-\$\{programDraftPosition\.x\}%, -\$\{programDraftPosition\.y\}%\)`[\s\S]*fontSize: `\$\{programPreviewFontCqw \* programDraftScale\}cqw`/,
  'program preview typography and travel coordinates must match the real program timer overlay')
assert.match(timerControl, /programDisplayWidth[\s\S]*programOverlayDpiScale[\s\S]*boxSizing: 'content-box'/,
  'program preview must include the native WPF DPI scale and padding outside its reserved text width')
assert.match(timerControl, /const primaryDisplay = displays\.find[\s\S]*const programPreviewDisplay = programDisplay \?\? primaryDisplay[\s\S]*programPreviewAspect = programDisplayWidth \/ programDisplayHeight/,
  'headless timer preview must use the actual primary-display aspect ratio instead of an approximate 16:9 fallback')
assert.match(timerControl, /!programScene\.enabled && timerOutputOwner === 'scene'[\s\S]*setTimerOutputState\(true, 'toolbar'\)/,
  'leaving Scene must preserve a visible timer by returning it to the ordinary Program route')
assert.match(appStore, /update\.enabled === false[\s\S]*state\.timerDuration > 0 && state\.timerOutputVisible && state\.timerOutputOwner === 'scene'[\s\S]*timerOutputOwner: 'toolbar'/,
  'every Scene exit path must transfer timer ownership atomically in the store')
assert.match(sceneTimerLayer, /const widthDip = \(wideTime \? 260 : 176\) \+ 8[\s\S]*const heightDip = 48 \+ 4/,
  'the Scene timer must use the exact compact WPF footprint instead of the old approximate rectangle')
assert.doesNotMatch(sceneTimerLayer, /rgba\(60, 0, 0|rgba\(60, 20, 0|rgba\(0, 0, 0, 0\.5\)/,
  'the Scene and internal Program timer must not restore an obsolete backing plate')
assert.match(sceneModal, /timerOutputWidth[\s\S]*timerOutputHeight[\s\S]*dpiScale=\{timerDpiScale\}/,
  'the Scene preview must account for physical Program dimensions and the native timer DPI')
assert.match(sceneBridge, /shouldShowTimerOnProgram[\s\S]*shouldRenderTimerInProgramRenderer\(internalProgramOutputActive, targetDisplayId, timerTargetsProgram\)[\s\S]*timerOverlayPosition[\s\S]*timerTextOpacity/,
  'the internal Program timer must follow the live store without duplicating the physical native overlay')
assert.match(presentationApp, /\{programScene\.timer\?\.visible && \([\s\S]*<SceneTimerPreviewLayer[\s\S]*dpiScale=\{window\.devicePixelRatio \|\| 1\}/,
  'a standalone timer must render in the internal Program output even when Scene composition is disabled')
assert.doesNotMatch(timerControl, />\s*Сбросить\s*</,
  'timer output preview must not show the removed reset action')
const closeModalSource = sceneModal.slice(
  sceneModal.indexOf('const closeModal ='),
  sceneModal.indexOf('useEffect(() =>', sceneModal.indexOf('const closeModal ='))
)
assert.doesNotMatch(closeModalSource, /setTimerOverlayPosition|setTimerOverlayScale|setTimerTextColor|setTimerWarningTextColor|setTimerOvertimeTextColor|setTimerTextOpacity/,
  'closing an inactive Scene must discard its local timer layout instead of moving the standalone on-air timer')
assert.match(auxiliaryBridge, /on\('speaker-state-ready'[\s\S]*?'speaker-timer-update'[\s\S]*?currentSpeakerTimerDisplayState/,
  'a reconnected speaker display must receive the current timer routing state after listener readiness')
assert.match(auxiliaryBridge, /sendToAuxiliary\('speaker', 'speaker-timer-update', currentSpeakerTimerDisplayState\(\)\)/,
  'timer ticks and visibility changes must be forwarded independently to the speaker display')
assert.match(auxiliaryBridge, /x: state\.timerSpeakerPosition\.x,[\s\S]*y: state\.timerSpeakerPosition\.y,[\s\S]*scale: state\.timerSpeakerScale/,
  'speaker timer updates must carry the independently configured placement and scale')
assert.match(outputPreload, /'speaker-timer-update'/,
  'the restricted output preload must allow speaker timer updates')
assert.match(auxiliaryApp, /on\('speaker-timer-update'[\s\S]*?<SpeakerTimerOverlay timer=\{timer\}/,
  'the speaker renderer must show the timer overlay without replacing slide or notes content')
assert.match(auxiliaryApp, /left: `\$\{Math\.max\(8, Math\.min\(92, timer\.x\)\)\}%`[\s\S]*top: `\$\{Math\.max\(8, Math\.min\(92, timer\.y\)\)\}%`[\s\S]*timer\.scale/,
  'the speaker renderer must apply the operator-selected timer position and scale')
assert.match(auxiliaryApp, /data-speaker-timer-overlay[\s\S]*textShadow: '0 2px 8px rgba\(0,0,0,0\.95\)'/,
  'the speaker timer must remain readable without an opaque backing plate')
assert.doesNotMatch(auxiliaryApp, /data-speaker-timer-overlay[\s\S]{0,600}background,/,
  'the speaker timer overlay must not restore a colored or dark backing plate')
assert.match(timerOverlayScript, /MinWidth = useWideTimeLayout \? 260 : 176[\s\S]*new Thickness\(4, 2, 4, 2\)/,
  'the native timer backing area must be compact while reserving stable room for a minus sign')
assert.match(timerOverlayScript, /LineHeight = 48[\s\S]*LineStackingStrategy = LineStackingStrategy\.BlockLineHeight[\s\S]*text\.LineHeight = timerFontSize/,
  'the native timer must use the same one-line height as the leading-none Program preview')
assert.match(mainProcess, /broadcastWpfTimerToMirrors[\s\S]*dpiScale: Math\.max\(0\.5, screen\.getPrimaryDisplay\(\)\.scaleFactor \|\| 1\)/,
  'live copies must receive the DPI used by the native WPF timer')
assert.match(auxiliaryApp, /ProgramTimerOverlay[\s\S]*sourcePixelHeight[\s\S]*timer\.dpiScale[\s\S]*fontVh = 100 \* 48 \* timer\.scale \* dpiScale \/ sourceHeight/,
  'live copies must size the timer from the physical Program height and native DPI')
assert.match(timerOverlayScript, /NeedsWideTimeLayout\(duration, remaining\)[\s\S]*text\.MinWidth = Math\.Round\(\(useWideTimeLayout \? 260 : 176\) \* scale\)/,
  'hour timers must reserve their wider stable width before overtime changes the text')
assert.match(timerOverlayScript, /Background = Brushes\.Transparent/,
  'the native program timer must use a fully transparent backing surface')
assert.doesNotMatch(timerOverlayScript, /border\.Background = new SolidColorBrush/,
  'warning and overtime updates must change only timer text color, not restore a backing plate')
assert.match(timerOverlayScript, /UpdateTextAlignment\(\)[\s\S]*positionX <= 0\.001[\s\S]*TextAlignment\.Left[\s\S]*positionX >= 0\.999[\s\S]*TextAlignment\.Right/,
  'the native timer must align visible digits toward an edge while keeping the stable minus-sign reserve')
assert.match(timerOverlayScript, /Windows can move a topmost window onto the primary display[\s\S]*rect\.Left < targetDisplayX - tolerance[\s\S]*rect\.Right > targetDisplayX \+ targetDisplayWidth \+ tolerance[\s\S]*return;/,
  'hot-unplug must not persist the emergency Windows relocation as an operator timer position')
assert.match(mainProcess, /pixelMetadataValid[\s\S]*raw\.offsetX >= 0[\s\S]*raw\.offsetY >= 0[\s\S]*valid: false/,
  'main must reject a native timer state containing an impossible negative display offset')
assert.match(timerControl, /if \(!layout\.valid\)[\s\S]*useAppStore\.getState\(\)[\s\S]*setTimerLayoutReady\(true\)/,
  'the operator timer layout must remain authoritative when native hot-plug state is invalid')
const programTimerOverlaySource = auxiliaryApp.slice(
  auxiliaryApp.indexOf('function ProgramTimerOverlay('),
  auxiliaryApp.indexOf('function EventTimerDisplay(')
)
assert.doesNotMatch(programTimerOverlaySource, /background[,:]/,
  'the live-copy program timer must match the transparent native timer')
assert.match(windowsSource, /\.timer-normal \{ color: #fff; \}[\s\S]*\.timer-warning \{ color: #facc15; \}[\s\S]*\.timer-overtime \{ color: #ef4444; \}/,
  'the legacy Electron timer fallback must not draw a background plate')

console.log('PASS: live Scene channel priority, timer transitions, speaker timer routing, auxiliary readiness, mirror recovery and QR-only publication ownership isolation')
