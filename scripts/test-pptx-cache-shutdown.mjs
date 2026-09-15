import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

async function load(entry) {
  const result = await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', write: false })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}
const { createPptxCache } = await load('src/main/pptx-cache.ts')
const { createPptxDiskCache } = await load('src/main/pptx-cache-disk.ts')
const { exportPptxIncrementally } = await load('src/main/pptx-incremental-export.ts')
const root = await mkdtemp(join(tmpdir(), 'pdm-pptx-shutdown-test-'))
const name = (kind, digit) => `pdm-${kind}-${digit.repeat(24)}`
try {
  const slideDir = join(root, name('slides', 'a'))
  const oldThumbs = join(root, name('thumbs', 'b'))
  const disk = createPptxDiskCache(root)
  disk.claim(slideDir)
  await mkdir(slideDir)
  await mkdir(oldThumbs)
  await writeFile(join(slideDir, 'partial.png'), 'unfinished frame')
  const preserved = ['original.pptx', 'settings.json', 'pdm-slides-not-a-cache', 'pdm-pptx-cache-backup']
  for (const file of preserved) await writeFile(join(root, file), 'preserve')
  const outside = join(root, 'user-folder')
  await mkdir(outside)
  await writeFile(join(outside, 'original.pptx'), 'preserve')
  const link = join(root, name('slides', 'c'))
  await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => disk.claim(join(outside, name('slides', 'a'))), /Invalid/)
  const purged = await disk.clear()
  assert.deepEqual(purged, { removed: 2, shared: false })
  for (const file of preserved) assert.equal(await readFile(join(root, file), 'utf8'), 'preserve')
  assert.equal(await readFile(join(link, 'original.pptx'), 'utf8'), 'preserve')
  assert.throws(() => disk.claim(slideDir), /shutting down/)

  // Two active PDM instances must not destroy one another's shared cache.
  await mkdir(slideDir)
  const first = createPptxDiskCache(root)
  const last = createPptxDiskCache(root)
  first.claim(slideDir); last.claim(slideDir)
  assert.deepEqual(await first.clear(), { removed: 0, shared: true })
  assert.deepEqual(await last.clear(), { removed: 1, shared: false })
  const stale = `pdm-pptx-cache-owner-12345678-11111111-1111-1111-1111-111111111111.lock`
  await writeFile(join(root, stale), '')
  await mkdir(oldThumbs)
  assert.deepEqual(await createPptxDiskCache(root, () => false).clear(), { removed: 1, shared: false })
  assert.equal((await readdir(root)).includes(stale), false)

  // Stop during an actual short batch: wait it out, issue no continuation,
  // drain thumbnail work, release native resources, reject queued/new decks.
  const source = join(root, 'original.pptx')
  const secondSource = join(root, 'second.pptx')
  await writeFile(secondSource, 'second')
  let resumeBatch, startedBatch, resumeResize
  const started = new Promise(resolve => { startedBatch = resolve })
  const batch = new Promise(resolve => { resumeBatch = resolve })
  const resizing = new Promise(resolve => { resumeResize = resolve })
  let tail = Promise.resolve(), exports = 0, releases = 0, thumbnailFinished = false
  const cache = createPptxCache({
    directory: path => path === source ? slideDir : oldThumbs,
    readCache: async () => null,
    enqueue(_key, work) { const job = tail.then(work); tail = job.catch(() => {}); return job },
    async export(path, outputDir, width, height, onEvent, signal) {
      return exportPptxIncrementally(async () => {
        exports++
        onEvent({ event: 'slide-exported', slide: 1, slideCount: 123,
          path: join(outputDir, 'slide_1.png'), slideWidth: 1920, slideHeight: 1080 })
        startedBatch()
        await batch
        return { ok: true, exportPending: true, nextSlide: 5, slideCount: 123 }
      }, { path, outputDir, width, height }, undefined, signal)
    },
    async resize() { await resizing; thumbnailFinished = true; return new Uint8Array([1]) },
    async prepare() { throw Error('Must not prepare during shutdown') },
    async release() { assert.equal(thumbnailFinished, true); releases++; return { success: true } },
    log() {}
  })
  const active = cache(source)
  const activeRejected = assert.rejects(active, error => error.name === 'AbortError')
  await started
  // Allow the thumbnail to enter resize while the native batch is pending.
  await new Promise(resolve => setTimeout(resolve, 20))
  const queued = cache(secondSource)
  const queuedRejected = assert.rejects(queued, /aborted|shutting down/i)
  await new Promise(resolve => setImmediate(resolve))
  let stopped = false
  const stopping = cache.stop().then(() => { stopped = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(stopped, false)
  resumeBatch()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(stopped, false, 'shutdown must wait for active image work')
  resumeResize()
  await Promise.all([stopping, activeRejected, queuedRejected])
  assert.equal(exports, 1, 'no continuation or queued-deck export after stop')
  assert.equal(releases, 1, 'native cleanup still runs on cancellation')
  await assert.rejects(cache(source), /shutting down/)
  assert.equal(stopped, true)
  const aborted = new AbortController(); aborted.abort()
  await assert.rejects(exportPptxIncrementally(async () => { throw Error('Must not send') },
    { path: 'f', outputDir: 'd', width: 1, height: 1 }, undefined, aborted.signal), error => error.name === 'AbortError')
  console.log('PASS: shutdown cancellation/drain, queued jobs, no late writes, exact disk purge, originals/settings/junction safety, active second PDM and stale owners')
} finally {
  await rm(root, { recursive: true, force: true })
}
