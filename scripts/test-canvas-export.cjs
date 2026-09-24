const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { transformSync } = require('esbuild')
function load(source, globals = {}) {
  const module = { exports: {} }
  vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code,
    { module, exports: module.exports, ...globals })
  return module.exports
}
const read = file => fs.readFileSync(file, 'utf8')
const flush = async () => { for (let n = 0; n < 10; n++) await Promise.resolve() }
async function main() {
  const { canvasToDataUrl } = load(read('src/renderer/src/canvas-export.ts'), {
    FileReader: class {
      readAsDataURL(blob) { this.result = blob.value; this.onload() }
    }
  })
  let finish, completed = false
  const pending = canvasToDataUrl({
    toDataURL() { throw new Error('Synchronous serialization is forbidden') },
    toBlob(callback, type, quality) {
      assert.equal(type, 'image/jpeg'); assert.equal(quality, 0.72); finish = callback
    }
  }, 'image/jpeg', 0.72).then(value => { completed = true; return value })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(completed, false, 'UI task must run while encoding is delayed')
  finish({ value: 'data:image/jpeg;base64,test' })
  assert.equal(await pending, 'data:image/jpeg;base64,test')
  await assert.rejects(canvasToDataUrl({ toBlob: cb => cb(null) }), /no image/)
  await assert.rejects(canvasToDataUrl({ toBlob() { throw new Error('context lost') } }), /context lost/)

  // Execute the real frame pump body with delayed encoding, not a rewritten model.
  const source = read('src/renderer/src/components/PresentationView/CaptureHub.tsx')
  const body = source.slice(source.indexOf('    const drawPreview ='), source.indexOf('    const startFramePump ='))
  let complete, calls = 0, currentAttempt = true
  const sent = [], held = { current: null }
  const pump = load(`let previewEncoding = false; const openAttempt = 1; ${body}\nexport { drawPreview }`, {
    videoRef: { current: { readyState: 2, videoWidth: 1920, videoHeight: 1080 } },
    HTMLMediaElement: { HAVE_CURRENT_DATA: 2 }, resolveFrameWaiters() {},
    holdImageRef: { current: null }, lastPreviewAtRef: { current: 0 },
    canvasRef: { current: { width: 640, height: 360, getContext: () => ({ fillRect() {}, drawImage() {} }) } },
    canvasToDataUrl: () => { calls++; return new Promise(resolve => { complete = resolve }) },
    isStaleOpen: () => !currentAttempt, lastFrameDataUrlRef: held,
    config: { sourceId: 'test' }, latestStateRef: { current: { status: 'ready' } },
    window: { api: { sendToControl: (_, frame) => sent.push(frame) } }
  })
  pump.drawPreview(1000); pump.drawPreview(2000); pump.drawPreview(3000)
  assert.equal(calls, 1, 'Slow encoding must not accumulate frames')
  currentAttempt = false; complete('old'); await flush()
  assert.equal(sent.length, 0, 'No late frame after reconnect/close')
  assert.equal(held.current, null)
  currentAttempt = true; pump.drawPreview(4000); complete('fresh'); await flush()
  assert.equal(sent.length, 1); assert.equal(held.current, 'fresh')
  assert.match(read('src/renderer/src/pdfium-renderer.ts'), /getContext\('2d', \{ willReadFrequently: true \}\)/)
  console.log('PASS: async canvas encoding, error handling, UI task progress, bounded camera work, stale-frame rejection, CPU raster cache')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
