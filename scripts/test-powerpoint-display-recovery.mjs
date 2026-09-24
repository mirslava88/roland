import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const [daemon, main, windows, preview, store, pdfium, routing, auxiliaryBridge, auxiliaryApp, internalProgramBridge, presentationApp, navigationTransition] = await Promise.all([
  readFile(new URL('./powerpoint-daemon.ps1', import.meta.url), 'utf8'),
  readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/main/windows.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/renderer/src/components/Preview/PreviewPanel.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/renderer/src/stores/useAppStore.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/renderer/src/pdfium-renderer.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/renderer/src/program-display-routing.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/renderer/src/components/AuxiliaryDisplays/AuxiliaryDisplayBridge.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/renderer/src/AuxiliaryApp.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/renderer/src/components/ProgramScene/InternalProgramOutputBridge.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/renderer/src/PresentationApp.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/renderer/src/navigation-transition.ts', import.meta.url), 'utf8')
])
const auxiliaryOpenHandler = main.slice(
  main.indexOf("handleControl('open-auxiliary-window'"),
  main.indexOf("handleControl('close-auxiliary-window'")
)
const auxiliaryMetricsPlacement = main.slice(
  main.indexOf('const auxiliaryPlacements ='),
  main.indexOf('if (timerActive)', main.indexOf('const auxiliaryPlacements ='))
)

assert.match(
  daemon,
  /return \[string\]::IsNullOrEmpty\(\$currentKey\) -or \$currentKey -eq \$expectedKey/,
  'a stale managed PowerPoint RCW must retain ownership by exact COM identity'
)
assert.match(
  daemon,
  /\$key = \$trackedKey/,
  'stale managed presentation cleanup must retire its registered path key'
)
assert.match(
  daemon,
  /\$sw = Resolve-PdmSlideShowWindow \$ppt/,
  'CLOSE must validate the cached slideshow instead of calling a dead RCW'
)
assert.match(
  main,
  /scheduleDisplayMetricsSync\('display-added-stable'\)/,
  'a returned monitor must receive a stable delayed PowerPoint relocation pass'
)
assert.match(
  main,
  /const auxiliaryWindowOperationChains = new Map<number, Promise<void>>\(\)[\s\S]*?enqueueAuxiliaryWindowOperation/,
  'native auxiliary-window operations must be serialized per display'
)
assert.match(
  main,
  /function closeAuxiliaryWindow[\s\S]*?invalidateAuxiliaryWindowOperations\(id\)[\s\S]*?disposeAuxiliaryWindowEntry/,
  'disconnecting an auxiliary display must invalidate already queued window work'
)
assert.match(
  main,
  /return enqueueAuxiliaryWindowOperation\(displayId, async \(epoch\)[\s\S]*?target = resolveTarget\(\)[\s\S]*?!isAuxiliaryWindowOperationCurrent\(displayId, epoch\)/,
  'an auxiliary window open must revalidate topology after its asynchronous load'
)
assert.match(
  main,
  /const auxiliaryPlacements =[\s\S]*?enqueueAuxiliaryWindowOperation\(displayId,[\s\S]*?Promise\.allSettled\(auxiliaryPlacements\)/,
  'display-metrics placement must use the same serialized lane as window opening'
)
assert.match(
  main,
  /entry\.placementKey !== placementKey[\s\S]*?entry\.placementKey = placementKey/,
  'duplicate topology events must not repeatedly place an already positioned auxiliary window'
)
assert.doesNotMatch(
  auxiliaryOpenHandler + auxiliaryMetricsPlacement,
  /setFullScreen/,
  'hot-pluggable auxiliary outputs must not use crash-prone native fullscreen transitions'
)
assert.match(
  auxiliaryBridge,
  /reconcileChainRef[\s\S]*?reconcileRevisionRef[\s\S]*?revision !== reconcileRevisionRef\.current/,
  'renderer hotplug reconciles must discard stale topology revisions'
)
assert.match(
  main,
  /powerpoint-output-recovery-needed/,
  'failed relocation on the returned output must request transactional recovery'
)
assert.match(
  main,
  /const latestPrimary = screen\.getPrimaryDisplay\(\)[\s\S]*?latestPresentationTarget\.id !== latestPrimary\.id[\s\S]*?powerpoint-output-recovery-needed/,
  'returned-monitor recovery must compare against a defined fresh primary display'
)
assert.match(
  main,
  /registerIpcHandlers\([\s\S]*?presentationDisplayId = displayId[\s\S]*?authoritative Program route selected/,
  'main display-metrics recovery must receive the renderer-selected Program route'
)
assert.match(
  await readFile(new URL('../src/main/ipc-handlers.ts', import.meta.url), 'utf8'),
  /onProgramDisplaySelected\(targetDisplay\.id\)[\s\S]*?getPowerPointNativePlacement/,
  'PowerPoint launch must publish its target before asynchronous Office work begins'
)
assert.match(
  main,
  /const preservedPresentationWindow = presentationWindow[\s\S]*?setOpacity\(0\)[\s\S]*?setContentBounds\(primaryDisplay\.bounds\)[\s\S]*?presentation renderer preserved after external display removal/,
  'disconnect must preserve and relocate the Program renderer instead of reopening its USB camera'
)
assert.doesNotMatch(
  main.slice(main.indexOf("handleControl('place-presentation-window'"), main.indexOf("handleControl('raise-presentation-window'")),
  /setFullScreen/,
  'the hot-pluggable Program renderer must use exact borderless bounds instead of native fullscreen transitions'
)
assert.match(
  windows.slice(windows.indexOf('export function createPresentationWindow'), windows.indexOf('export function createAuxiliaryWindow')),
  /useContentSize: true[\s\S]*?fullscreen: false[\s\S]*?thickFrame: false/,
  'the Program renderer must size its exact client surface without a native fullscreen state or invisible resize frame'
)
assert.match(
  main.slice(main.indexOf("handleControl('place-presentation-window'"), main.indexOf("handleControl('raise-presentation-window'")),
  /presentationDisplayId = targetDisplay\.id[\s\S]*?maxPlacementAttempts = changed \? 8 : 1[\s\S]*?setContentBounds\(nextBounds\)[\s\S]*?actualContentBounds = win\.getContentBounds\(\)[\s\S]*?sameBounds\(actualContentBounds, nextBounds\)/,
  'Program hot-plug placement must own the route and retry the exact client surface while Windows settles the new monitor'
)
assert.doesNotMatch(
  main.slice(main.indexOf('const preservedPresentationWindow = presentationWindow'), main.indexOf("handleControl('open-display-settings'")),
  /setFullScreen/,
  'disconnect preservation must move the warm Program renderer without toggling native fullscreen'
)
assert.match(
  main,
  /if \(isInternalProgramOutputActive\(\) && !explicitlyRequestedDisplay\)/,
  'an internal stream/camera may keep capturing the same renderer after an explicit physical Program output is attached'
)
assert.match(
  internalProgramBridge,
  /displayTopologySignature[\s\S]*?liveFile\?\.type !== 'capture'[\s\S]*?program topology refresh requested[\s\S]*?presentation-route-refresh-needed/,
  'physical Program hotplug must rebuild a live presentation or camera through the transactional TAKE path'
)
assert.match(
  navigationTransition,
  /export function isNavigationTransitionActive\(\): boolean/,
  'output bridges must be able to detect a transactional TAKE without duplicating it'
)
assert.match(
  internalProgramBridge,
  /isNavigationTransitionActive\(\)[\s\S]*?transactional TAKE owns output/,
  'internal Program synchronization must not overwrite a user TAKE after display removal'
)
assert.match(
  daemon,
  /PromoteWarmedOutput\([\s\S]*?relocate: atomic promotion=[\s\S]*?Raise-SlideShow[\s\S]*?Lower-Window/,
  'Scene PPTX relocation must atomically place PowerPoint above its Chromium underlay, with a guarded fallback'
)
assert.match(
  presentationApp,
  /payload\.takeId\?\.startsWith\('internal-'\)[\s\S]*?pendingBeforeLoad\.payload\.takeId[\s\S]*?ignored internal capture replay/,
  'the output renderer must preserve a pending transactional capture id against a duplicate internal replay'
)
assert.match(
  preview,
  /on\('powerpoint-output-recovery-needed'[\s\S]*?void handleTake\(liveChannelId\)/,
  'the live PowerPoint channel must be reopened through the normal TAKE pipeline'
)
assert.match(
  preview,
  /channel\.file\.type === 'presentation' \|\| channel\.file\.type === 'pdf'[\s\S]*?isRendererOnlyPresentationRouting\(freshState\)[\s\S]*?powerpointCommand\('close'\)[\s\S]*?waitForPptxChannelStart[\s\S]*?speaker-only \$\{channel\.file\.type\} TAKE ready/,
  'Speaker/internal TAKE must close regular output and publish PDM-rendered PPTX/PDF frames instead'
)
assert.match(
  store,
  /state\.activeFile\?\.type === 'presentation'[\s\S]*?isRendererOnlyPresentationRouting\(state\)[\s\S]*?state\.setCurrentSlide\(target\)/,
  'Speaker/internal navigation must update PDM slide state without commanding native PowerPoint'
)
assert.match(
  store,
  /navigateSpeakerOnlyPdf[\s\S]*?isRendererOnlyPresentationRouting\(state\)[\s\S]*?state\.setCurrentSlide\(target\)/,
  'Speaker/internal PDF navigation must update the PDM page state without native output'
)
assert.match(
  pdfium,
  /page\.getOriginalSize\(\)[\s\S]*?fitPdfPageInsideRenderBox[\s\S]*?width: renderSize\.width,[\s\S]*?height: renderSize\.height/,
  'PDFium fallback must preserve each PDF page aspect ratio inside the Speaker render box'
)
assert.match(
  auxiliaryApp,
  /on\('speaker-state'[\s\S]*?sendToControl\('speaker-state-ready'/,
  'Speaker renderer must acknowledge that its state listener is installed'
)
assert.match(
  auxiliaryBridge,
  /on\('speaker-state-ready'[\s\S]*?currentSpeakerDisplayState\(useAppStore\.getState\(\)\)/,
  'Speaker bridge must replay the current slide after the renderer listener becomes ready'
)
assert.match(
  routing,
  /wasSpeakerOnlyPresentationRoute[\s\S]*?presentation-route-refresh-needed[\s\S]*?isSpeakerOnlyDisplayRouting/,
  'Changing between Program and Speaker during a live PPTX/PDF must request a transactional route refresh'
)
assert.match(
  preview,
  /liveFile\?\.type !== 'capture'[\s\S]*?program route refresh BEGIN[\s\S]*?void handleTake\(liveChannelId\)[\s\S]*?addEventListener\('presentation-route-refresh-needed'/,
  'A live display-route change must rebuild the current presentation or camera through the normal TAKE pipeline'
)
assert.match(
  preview,
  /detail\?\.displayId !== undefined[\s\S]*?isPresentationWindowOpen: false[\s\S]*?physical Program output requires reveal[\s\S]*?void handleTake\(liveChannelId\)/,
  'a returned physical Program display must force the preserved transparent renderer to be revealed again'
)

console.log('PowerPoint display reconnect recovery contracts: OK')
