import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const [daemon, main, preview, store, pdfium, routing, auxiliaryBridge, auxiliaryApp] = await Promise.all([
  readFile(new URL('./powerpoint-daemon.ps1', import.meta.url), 'utf8'),
  readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/renderer/src/components/Preview/PreviewPanel.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/renderer/src/stores/useAppStore.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/renderer/src/pdfium-renderer.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/renderer/src/program-display-routing.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/renderer/src/components/AuxiliaryDisplays/AuxiliaryDisplayBridge.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/renderer/src/AuxiliaryApp.tsx', import.meta.url), 'utf8')
])

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
  /powerpoint-output-recovery-needed/,
  'failed relocation on the returned output must request transactional recovery'
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
  /presentation route refresh BEGIN[\s\S]*?void handleTake\(liveChannelId\)[\s\S]*?addEventListener\('presentation-route-refresh-needed'/,
  'A live display-role change must rebuild the current presentation through the normal TAKE pipeline'
)

console.log('PowerPoint display reconnect recovery contracts: OK')
