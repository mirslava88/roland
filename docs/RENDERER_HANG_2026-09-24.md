# Operator UI stall: preview serialization

The reported failure was an application-wide PDM freeze, not merely a PDF
navigation failure. Local diagnostics showed a GPU-process crash. A CPU-rendered
thumbnail was ready promptly, but the next log after synchronous canvas PNG
serialization arrived tens of seconds later, following GPU recovery. The control
renderer's TAKE timeout was delayed too. This narrows a blocking path; it does
not establish why Chromium's GPU process originally stalled/crashed.

## Changes

- Keep PDFium's CPU-originated raster cache in a `willReadFrequently` 2D canvas.
  The visible output retains accelerated composition, normal geometry and quality.
- Replace synchronous thumbnail serialization with `canvasToDataUrl` using
  `toBlob` and `FileReader` in slide navigation, PDF library thumbnails, speaker
  output and information-preview PDF fallbacks. Recheck cancellation after encoding.
- Encode camera operator previews asynchronously, allowing only one pending encode
  per capture effect. Reject delayed frames from a previous open attempt/session.
- Add executable tests for delayed encoding, UI-task progress, errors, bounded
  pending work and rejection of obsolete camera frames. Include in the core suite.

## Verification

- Strict node/web TypeScript and Stream production build passed.
- New canvas tests and all 21 race regressions passed.
- Scene/timer, scene composition and Stream Deck command checks passed.
- Actual Electron canvas encoding preserved 224x290 geometry with a CPU-backed
  canvas; the asynchronous encode/decode completed normally.
- Twenty live PPTX/PDF channel transitions passed on the existing external display:
  ten in participant-only Scene mode, ten in participant + presentation mode.
  USB camera, QR, timer, Stream Deck and physical virtual-camera route remained active.
  The operator timer probe ran for more than three minutes; maximum observed
  scheduling delay was about 250 ms, with no new GPU-process crashes in that run.
- Visually inspected the physical output capture in combined Scene mode: PDF,
  camera tile, timer and QR were present. A non-black frame alone is insufficient
  proof because it can contain only a camera tile.
- Runtime smoke confirmed the operator window, running virtual camera, live
  Scene snapshot and connected Stream Deck. Renderer changes were loaded by the
  existing development app; no main/preload changes required a restart.

## Limits

This removes identified synchronous preview work and limits its backlog. It is
not a proven repair of the underlying GPU/driver crash and not an all-day soak
test. Do not claim all application hangs or the separately reported VKS scaling
issue are resolved. Do not run the virtual-camera source self-test concurrently
with an active user camera: it shares the production frame mapping.
