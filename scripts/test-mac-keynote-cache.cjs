const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const vm = require('node:vm')
const { transformSync } = require('esbuild')
const load = async () => {
  const module = { exports: {} }
  const source = await fs.readFile(path.join(__dirname, '../src/main/mac-keynote-cache.ts'), 'utf8')
  vm.runInNewContext(transformSync(source, { loader: 'ts', format: 'cjs' }).code,
    { module, exports: module.exports, require, console })
  return module.exports
}
;(async () => {
  const { KeynoteDiskCache, KeynoteQueue, keynoteSource } = await load()
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pdm-keynote-cache-test-'))
  let count = 0
  const test = async (name, run) => { await run(); count++; console.log(`PASS ${name}`) }
  try {
    const sourcePath = path.join(root, 'source.pptx')
    await fs.writeFile(sourcePath, 'original PPTX')
    const source = await keynoteSource(sourcePath)
    const cache = new KeynoteDiskCache(path.join(root, 'cache'))
    await test('metadata changes from macOS do not trigger a new import', async () => {
      await fs.chmod(sourcePath, 0o600)
      assert.equal((await keynoteSource(sourcePath)).key, source.key)
    })
    await test('unprepared source is not ready', async () => assert.equal(await cache.find(source), null))
    await test('only complete native document is published', async () => {
      const saved = await cache.save(source, async destination => {
        assert.equal(await cache.find(source), null)
        await fs.writeFile(destination, 'native document with builds')
      })
      assert.equal(await cache.find(source), saved)
      assert.equal(await fs.readFile(sourcePath, 'utf8'), 'original PPTX')
    })
    await test('new process can reuse committed cache', async () => {
      const fresh = new KeynoteDiskCache(path.join(root, 'cache'))
      assert.equal(await fresh.find(source), await cache.find(source))
    })
    await test('file aliases share one generation', async () => {
      const alias = path.join(root, 'alias.pptx')
      await fs.symlink(sourcePath, alias)
      assert.equal((await keynoteSource(alias)).key, source.key)
    })
    await test('source changes invalidate the native generation', async () => {
      await fs.writeFile(sourcePath, 'changed PPTX')
      const changed = await keynoteSource(sourcePath)
      assert.notEqual(changed.key, source.key)
      assert.equal(await cache.find(changed), null)
    })
    await test('source modified during save cannot publish stale readiness', async () => {
      const before = await keynoteSource(sourcePath)
      await assert.rejects(cache.save(before, async destination => {
        await fs.writeFile(destination, 'stale native')
        await fs.writeFile(sourcePath, 'modified during export')
      }), /changed/)
      assert.equal(await cache.find(before), null)
      assert.equal((await fs.readdir(path.join(root, 'cache'))).some(p => p.startsWith('.preparing-')), false)
    })
    await test('failed save leaves no ready cache', async () => {
      const current = await keynoteSource(sourcePath)
      await assert.rejects(cache.save(current, async destination => {
        await fs.writeFile(destination, 'partial')
        throw Error('Keynote failed')
      }))
      assert.equal(await cache.find(current), null)
    })
    await test('native package directories can be cached', async () => {
      const current = await keynoteSource(sourcePath)
      const saved = await cache.save(current, async destination => {
        await fs.mkdir(destination)
        await fs.writeFile(path.join(destination, 'data'), 'builds')
      })
      assert.equal(await fs.readFile(path.join(saved, 'data'), 'utf8'), 'builds')
    })
    await test('invalidating cache never deletes source or parent paths', async () => {
      await assert.rejects(cache.invalidate({ key: '../source.pptx' }), /Invalid/)
      await cache.invalidate(await keynoteSource(sourcePath))
      assert.equal(await fs.readFile(sourcePath, 'utf8'), 'modified during export')
    })
    await test('TAKE and navigation overtake queued imports without overlapping Keynote', async () => {
      const queue = new KeynoteQueue(), order = []
      let release
      const gate = new Promise(resolve => { release = resolve })
      const a = queue.run(async () => { order.push('import1'); await gate; order.push('import1 done') }, true)
      const b = queue.run(async () => { order.push('import2') }, true)
      const take = queue.run(async () => { order.push('TAKE') })
      const next = queue.run(async () => { order.push('NEXT') })
      assert.deepEqual(order, ['import1'])
      release()
      await Promise.all([a, b, take, next])
      assert.deepEqual(order, ['import1', 'import1 done', 'TAKE', 'NEXT', 'import2'])
    })
    await test('selecting an already queued channel promotes its existing preparation', async () => {
      const queue = new KeynoteQueue(), order = []
      let release
      const gate = new Promise(resolve => { release = resolve })
      const running = queue.run(async () => { await gate }, true)
      const a = queue.run(async () => { order.push('other') }, true, 'other')
      const b = queue.run(async () => { order.push('selected') }, true, 'selected')
      queue.promote('selected')
      release()
      await Promise.all([running, a, b])
      assert.deepEqual(order, ['selected', 'other'])
    })
    await test('failed operation does not stall operator queue', async () => {
      const queue = new KeynoteQueue()
      const failed = queue.run(async () => { throw Error('import failed') }, true)
      const next = queue.run(async () => 42)
      await assert.rejects(failed)
      assert.equal(await next, 42)
    })

    console.log(`${count} tests passed`)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})().catch(error => { console.error(error); process.exitCode = 1 })
