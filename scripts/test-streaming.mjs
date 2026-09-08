// Local-only RTMP integration test: synthetic picture/tone, two receivers,
// receiver restart, protocol validation, and encoder resource cleanup.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'esbuild'
import ffmpeg from 'ffmpeg-static'

async function moduleFrom(path) {
  const result = await build({ entryPoints: [path], bundle: true, platform: 'node', format: 'esm', write: false })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}
const { StreamingEngine, progressReader, publisherErrorMessage } = await moduleFrom('src/main/streaming-engine.ts')
const { DEFAULT_STREAM_SETTINGS, validateStreamSettings } = await moduleFrom('src/shared/streaming.ts')
for (const server of ['file:///tmp/test', 'https://example.com', '-report', 'rtmp://localhost/\nsecret']) {
  assert.throws(() => validateStreamSettings({ ...DEFAULT_STREAM_SETTINGS, destinations: [{ id: 'test', name: 'test', enabled: true, server, key: '' }] }))
}
assert.throws(() => validateStreamSettings({ ...DEFAULT_STREAM_SETTINGS, resolution: 2160 }))
assert.match(publisherErrorMessage('sample rate not set'), /параметры звука/)
const hiddenKeyError = publisherErrorMessage('Server error: 403 invalid key rtmps://localhost/live/PRIVATE_TOKEN')
assert.ok(hiddenKeyError && !hiddenKeyError.includes('PRIVATE_TOKEN') && !hiddenKeyError.includes('rtmps://'))
let progress
const parser = progressReader((p) => { progress = p })
parser(Buffer.from('untrusted secret text\nfra'))
parser(Buffer.from('me=42\nfps=30.0\nprogress=continue\n'))
assert.deepEqual(progress, { frame: 42, fps: 30 })

async function port() {
  const server = createServer()
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const number = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return number
}
const ports = await Promise.all([port(), port()])
const children = []
function process(args) {
  const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  child.on('error', () => {})
  return child
}
function receive(number) {
  const child = process(['-hide_banner', '-loglevel', 'info', '-listen', '1', '-i', `rtmp://127.0.0.1:${number}/live/test`,
    '-map', '0:v:0', '-map', '0:a:0', '-progress', 'pipe:1', '-stats_period', '0.5', '-f', 'null', '-'])
  const result = { child, frames: 0, log: '' }
  child.stdout.on('data', progressReader((p) => { result.frames = p.frame ?? result.frames }))
  child.stderr.on('data', (data) => { result.log = (result.log + data.toString()).slice(-12000) })
  return result
}
async function waitFor(predicate, label, timeout = 20000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error(`Timed out: ${label}`)
    await delay(200)
  }
}
const settings = { ...structuredClone(DEFAULT_STREAM_SETTINGS), resolution: 720, bitrateKbps: 2500,
  destinations: ports.map((p, i) => ({ id: `local${i}`, name: `Local ${i}`, enabled: true, server: `rtmp://127.0.0.1:${p}/live`, key: 'test' })) }
let engine, audioTimer, blackhole
const stalledSockets = new Set()
try {
  let first
  const second = receive(ports[1])
  await delay(500)
  const errors = []
  engine = new StreamingEngine(ffmpeg, settings, (error) => errors.push(error))
  engine.start('libx264', ['-re', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30'])
  let audioPending = false
  audioTimer = setInterval(async () => {
    if (audioPending) return
    audioPending = true
    const samples = new Float32Array(960 * 2)
    for (let i = 0; i < 960; i++) samples[i * 2] = samples[i * 2 + 1] = Math.sin(i * Math.PI * 2 * 400 / 48000) * 0.1
    await engine.write(samples.buffer)
    audioPending = false
  }, 20)
  await waitFor(() => second.frames > 20, 'available receiver decodes while first destination is unavailable')
  await delay(2500)
  assert.notEqual(engine.snapshot().destinations[0].phase, 'live', 'Unreachable service must never display a false live status')
  const before = second.frames
  first = receive(ports[0])
  await waitFor(() => first.frames > 20 && second.frames > before + 40, 'reconnection and unaffected second destination', 30000)
  assert.match(first.log, /Video: h264/)
  assert.match(first.log, /1280x720/)
  assert.match(first.log, /Audio: aac/)
  assert.equal(errors.length, 0, errors.join('; '))
  console.log('PASS: unavailable destination reconnects to H.264/AAC; second destination continues')
  const closed = once(first.child, 'exit'); first.child.kill(); await closed
  blackhole = createServer(socket => {
    stalledSockets.add(socket); socket.on('error', () => {}); socket.on('close', () => stalledSockets.delete(socket))
    socket.resume() // Accept TCP bytes but never complete the RTMP handshake.
  })
  blackhole.listen(ports[0], '127.0.0.1'); await once(blackhole, 'listening')
  const priorRetries = engine.snapshot().destinations[0].retries
  const priorFrames = second.frames
  await waitFor(() => engine.snapshot().destinations[0].retries > priorRetries + 1 && second.frames > priorFrames + 100,
    'stalled RTMP handshake is bounded and does not block the working destination', 45000)
  assert.notEqual(engine.snapshot().destinations[0].phase, 'live')
  assert.equal(engine.snapshot().destinations[1].phase, 'live')
  assert.equal(errors.length, 0, errors.join('; '))
  console.log('PASS: TCP blackhole is reconnected with bounded age; second destination remains live')
  const encoderChild = engine.encoder
  const senders = engine.publishers.map(p => p.child).filter(Boolean)
  engine.stop()
  clearInterval(audioTimer)
  for (const socket of stalledSockets) socket.destroy()
  blackhole?.close()
  await waitFor(() => encoderChild.exitCode !== null || encoderChild.signalCode !== null, 'encoding/publishing process exits')
  await waitFor(() => senders.every(p => p.exitCode !== null || p.signalCode !== null), 'all copy-only senders exit')
  assert.equal(await engine.write(new ArrayBuffer(10)), false)
  console.log('PASS: stop releases the encoder/publisher process and rejects late frames')
} finally {
  clearInterval(audioTimer)
  for (const socket of stalledSockets) socket.destroy()
  blackhole?.close()
  engine?.stop()
  for (const child of children) child.kill()
}
