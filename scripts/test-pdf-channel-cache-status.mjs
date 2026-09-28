import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const [cache, presentation, preview] = await Promise.all([
  readFile(new URL('../src/renderer/src/pdf-live-cache.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/renderer/src/PresentationApp.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/renderer/src/components/Preview/PreviewPanel.tsx', import.meta.url), 'utf8')
])

assert.match(cache, /if \(isCancelled\(\)\) \{\s*return \{ success: false, totalPages, cachedPages, error: 'cancelled' \}/)
assert.match(cache, /catch \(error\) \{\s*if \(isCancelled\(\)\) \{\s*return \{ success: false, totalPages: 0, cachedPages: 0, error: 'cancelled' \}/)
assert.match(presentation, /result\.error === 'cancelled' \? 'cancelled' : 'error'/)
assert.match(presentation, /requestId: request\.requestId,\s*status:/)
assert.match(preview, /expectedKey !== update\.cacheKey \|\| expectedId !== update\.requestId/)
assert.match(preview, /update\.status === 'cancelled'[\s\S]*?cancelledPdfPathsRef\.current\.add\(update\.filePath\)[\s\S]*?delete next\[update\.filePath as string\]/)
assert.match(preview, /cancelledPdfPathsRef\.current\.has\(file\.path\)[\s\S]*?sendToPresentation\('prewarm-pdf'/)

console.log('PASS: PDF cache cancellation, request identity and return-to-PDF retry')
