import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'

const compiled = await build({ entryPoints: ['src/main/pptx-cache.ts'], bundle: true,
  platform: 'node', format: 'esm', write: false })
const { createPptxCache, readPptxCacheImages } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)
const root = await mkdtemp(join(tmpdir(), 'pdm-pptx-cache-test-'))
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8C8AAAAASUVORK5CYII=', 'base64')
const source = join(root, 'synthetic.pptx')
await writeFile(source, 'synthetic original')
let exports = 0, prepares = 0, releases = 0, resized = 0
let failCleanup = false, failExport = false, bulkExport = false, mutateSource = false
const directories = []
const deps = {
  directory(path, size, mtime, width, height) {
    const key = createHash('sha256').update(`${path}|${size}|${mtime}|${width}|${height}`).digest('hex')
    const directory = join(root, key); directories.push(directory); return directory
  },
  readCache: readPptxCacheImages,
  async export(path, directory, _width, _height, onEvent) {
    exports++
    await mkdir(directory, { recursive: true })
    if (failExport) throw Error('synthetic export failure')
    for (let slide = 1; slide <= 3; slide++) {
      const slidePath = join(directory, `slide_${slide}.png`)
      await writeFile(slidePath, png)
      onEvent({ event:'slide-exported', slide, slideCount:3, path:slidePath, slideWidth:540, slideHeight:960 })
    }
    if (mutateSource) await writeFile(path, 'changed during export')
    await writeFile(join(directory, 'complete.txt'), '3')
    return { ok:true, slideCount:3, slideWidth:540, slideHeight:960, bulkExport }
  },
  async prepare() { prepares++; return { ok:true, slideWidth:540, slideHeight:960 } },
  async resize(path) { resized++; await readFile(path); return png },
  async enqueue(_key, work) { return work() },
  async release() { releases++; return { success:!failCleanup, error:failCleanup?'synthetic cleanup failure':undefined } },
  log() {}
}
try {
  const cache = createPptxCache(deps)
  const progress = []
  const result = await cache(source,1920,1080,p => progress.push(p))
  assert.equal(exports,1,'cold cache must export once')
  assert.equal(prepares,0,'cold export already provides original dimensions')
  assert.equal(resized,3,'each thumbnail is resized once, not exported through PowerPoint')
  assert.equal(releases,1)
  assert.equal(result.aspectRatio,540/960,'portrait proportions must come from the deck, not the export box')
  assert.deepEqual(result.thumbnails.map(p=>p.includes('thumbnails')), [true,true,true])
  assert.ok(progress.length>=3)
  await Promise.all([cache(source),cache(source)])
  assert.equal(exports,1); assert.equal(prepares,0); assert.equal(releases,1)
  assert.equal(resized,3,'warm cache must not decode all full-sized slides again')
  const directory = directories.at(-1)
  await writeFile(join(directory,'thumbnails','slide_2.png'),'broken thumbnail')
  await cache(source)
  assert.equal(exports,1); assert.equal(prepares,0)
  assert.equal(resized,6,'broken thumbnail set is rebuilt from full frames without PowerPoint')
  await rm(join(directory,'metadata.json'))
  await cache(source)
  assert.equal(exports,1); assert.equal(prepares,1,'legacy cache gets a one-time metadata upgrade')
  await cache(source); assert.equal(prepares,1)
  await writeFile(join(directory,'slide_2.png'),png.subarray(0,24))
  await cache(source)
  assert.equal(exports,2,'truncated full frames must trigger a new export')
  await writeFile(source,'synthetic changed source')
  const concurrent = await Promise.all([cache(source),cache(source)])
  assert.equal(exports,3,'concurrent callers share one job and source edits invalidate the cache')
  assert.deepEqual(concurrent[0],concurrent[1])
  const nextDirectory = directories.at(-1)
  await rm(join(nextDirectory,'slide_1.png'))
  failCleanup=true
  await assert.rejects(cache(source),/cleanup failure/)
  // No previously valid metadata can certify a failed new export.
  await assert.rejects(readFile(join(nextDirectory,'metadata.json')),/ENOENT/)
  failCleanup=false
  await cache(source)
  assert.equal(exports,4)
  const brokenPath = join(root,'broken.pptx'); await writeFile(brokenPath,'failure')
  failExport=true
  await assert.rejects(cache(brokenPath),/export failure/)
  failExport=false
  await cache(brokenPath)
  const fallbackPath=join(root,'fallback.pptx');await writeFile(fallbackPath,'fallback')
  bulkExport=true
  const beforeResize=resized
  await cache(fallbackPath)
  assert.equal(resized-beforeResize,6,'bulk fallback refreshes all partial progress thumbnails')
  bulkExport=false
  const mutablePath=join(root,'mutable.pptx');await writeFile(mutablePath,'before')
  mutateSource=true
  await assert.rejects(cache(mutablePath),/changed during cache/)
  assert.ok((await stat(source)).size>0)
  console.log('PASS: PPTX single export, progressive thumbnails, warm disk reuse without Office, portrait metadata, invalidation, fallback, failures and resource cleanup')
} finally {
  // Explicit mkdtemp directory created exclusively for this test.
  await rm(root,{recursive:true,force:true})
}
