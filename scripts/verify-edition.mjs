import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'

const require = createRequire(import.meta.url)
const { editionInfo, builderConfig } = require('../build/editions.cjs')
const info = editionInfo(process.argv[2])
const root = resolve(`out/${info.edition}`)
const main = readFileSync(join(root, 'main/index.js'), 'utf8')
const preload = readFileSync(join(root, 'preload/index.js'), 'utf8')
const js = readdirSync(join(root, 'renderer/assets')).filter((name) => name.endsWith('.js'))
const renderer = js.map((name) => readFileSync(join(root, 'renderer/assets', name), 'utf8')).join('\n')
assert.equal(main.includes('stream-start'), info.stream, 'main stream IPC must match edition')
assert.equal(preload.includes('stream-start'), info.stream, 'preload stream API must match edition')
assert.equal(renderer.includes('Начать трансляцию'), info.stream, 'stream controls must match edition')
assert.equal(existsSync(join(root, 'preload/streaming.js')), info.stream)
assert.equal(existsSync(join(root, 'renderer/streaming.html')), info.stream)
assert.ok(main.includes(info.displayVersion), 'settings version must match edition')
const config = builderConfig(info.edition)
assert.equal(config.extraResources.some((resource) => resource.to === 'ffmpeg'), info.stream)
assert.equal(config.extraMetadata.version, info.version)
assert.equal(config.extraMetadata.name, info.name)
assert.notEqual(builderConfig('standard').appId, builderConfig('stream').appId)
assert.notEqual(builderConfig('standard').nsis.shortcutName, builderConfig('stream').nsis.shortcutName)
assert.throws(() => editionInfo('unknown'))
console.log(`Edition verified: ${info.edition}, ${info.displayVersion}, FFmpeg ${info.stream ? 'included' : 'excluded'}`)
