import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pdfZoomRenderSize } from '../src/shared/pdf-zoom-render.ts'

assert.deepEqual(pdfZoomRenderSize(1920, 552, 1, 1), { width: 1920, height: 552 })
assert.deepEqual(pdfZoomRenderSize(1920, 552, 1, 3), { width: 5760, height: 1656 })
assert.deepEqual(pdfZoomRenderSize(1920, 1080, 1, 3, 8192, 8192, 16_000_000), {
  width: 5333,
  height: 3000
})
const highDpi = pdfZoomRenderSize(3840, 2160, 2, 3)
assert.ok(highDpi.width >= 7680 && highDpi.height >= 4320)
assert.ok(highDpi.width <= 8192 && highDpi.height <= 8192)
const viewer = readFileSync('src/renderer/src/components/PresentationView/PdfViewer.tsx', 'utf8')
const preview = readFileSync('src/renderer/src/components/Preview/PreviewPanel.tsx', 'utf8')
const mirror = readFileSync('src/renderer/src/AuxiliaryApp.tsx', 'utf8')
assert.match(viewer, /pdfZoomRenderSize\([\s\S]*?zoomRenderScale/)
assert.match(preview, /zoomRenderScale > 1[\s\S]*?renderPdfiumPageToCanvas/)
assert.match(mirror, /zoomRenderScale=\{contentZoom\.enabled \? contentZoom\.scale : 1\}/)
console.log('PASS: PDF magnifier rerenders vector pages at bounded high resolution')
