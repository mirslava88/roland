const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { extname, isAbsolute, join, resolve } = require('node:path')
const vm = require('node:vm')
const { buildSync, transformSync } = require('esbuild')

const bundle = buildSync({ entryPoints: [resolve('src/renderer/src/components/Controls/media-folder-playlist.ts')],
  bundle: true, platform: 'node', format: 'cjs', write: false })
const testModule = { exports: {} }
vm.runInNewContext(bundle.outputFiles[0].text, { module: testModule, exports: testModule.exports })
const { reconcileMediaFolderPlaylist: reconcile, sameMediaPlaylist: same } = testModule.exports
const list = (current, scanned, active = null) => Array.from(reconcile(current, scanned, active))
assert.deepEqual(list(['c.mp3', 'a.mp3'], ['a.mp3', 'b.mp3', 'c.mp3']), ['c.mp3', 'a.mp3', 'b.mp3'], 'New files append without resetting drag order')
assert.deepEqual(list(['a.mp3', 'b.mp3'], ['b.mp3'], 'a.mp3'), ['a.mp3', 'b.mp3'], 'Playing track stays until playback moves away')
assert.deepEqual(list(['a.mp3', 'b.mp3'], ['b.mp3']), ['b.mp3'], 'Removed idle file disappears')
assert.deepEqual(list([], ['new.mp4']), ['new.mp4'], 'Initially empty folder gains a file')
assert.equal(same(['a', 'b'], ['a', 'b']), true)
assert.equal(same(['a', 'b'], ['b', 'a']), false)

const source = readFileSync('src/main/index.ts', 'utf8')
const start = source.indexOf('  const scanMediaFolder = async')
const end = source.indexOf("  handleControl('scan-media-folder'", start)
assert.ok(start >= 0 && end > start)
const script = transformSync(source.slice(start, end) + '\nresult = scanMediaFolder', { loader: 'ts', format: 'cjs' }).code
let entries = []
const context = { result: null, Set, isAbsolute, extname, join,
  readdir: async () => entries, console }
vm.runInNewContext(script, context)
const file = name => ({ name, isFile: () => true })
const folder = name => ({ name, isFile: () => false })
entries = [file('z.MP3'), file('a.wav'), file('clip.mp4'), folder('fake.mp3')]
const music = context.result('music', process.cwd())
const video = context.result('video', process.cwd())
Promise.all([music, video]).then(async ([songs, videos]) => {
  assert.deepEqual(Array.from(songs).map(x => x.split(/[\\/]/).pop()), ['a.wav', 'z.MP3'])
  assert.deepEqual(Array.from(videos).map(x => x.split(/[\\/]/).pop()), ['clip.mp4'])
  assert.equal(await context.result('music', 'relative/path'), null)
  console.log('PASS: media folder rescans, file filtering, stable playlist order and active playback')
}).catch(error => { console.error(error); process.exitCode = 1 })
