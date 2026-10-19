// Disk-backed delay, synchronized packet replay, cancellation and real RTMP drain.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import ffmpeg from 'ffmpeg-static'

async function moduleFrom(path) {
  const result = await build({ entryPoints: [path], bundle: true, platform: 'node', format: 'esm', write: false })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}
const { StreamDelayBuffer, checkStreamDelaySpace } = await moduleFrom('src/main/stream-delay.ts')
const { DEFAULT_STREAM_SETTINGS, validateStreamSettings, formatStreamDuration } = await moduleFrom('src/shared/streaming.ts')
const { StreamingEngine, progressReader } = await moduleFrom('src/main/streaming-engine.ts')
const valid = { ...DEFAULT_STREAM_SETTINGS, destinations: [] }
assert.equal(validateStreamSettings({ ...valid, delaySeconds: undefined }, false).delaySeconds, 0)
assert.equal(validateStreamSettings({ ...valid, delaySeconds: 5 * 3600 + 17 }, false).delaySeconds, 18017)
assert.equal(formatStreamDuration(27 * 3600 + 62), '27:01:02')
for (const delaySeconds of [-1, 0.1, Infinity, NaN, null, Number.MAX_SAFE_INTEGER]) {
  assert.throws(() => validateStreamSettings({ ...valid, delaySeconds }, false))
}
assert.throws(() => validateStreamSettings({ ...valid, drainOnStop: 'yes' }, false))
await assert.rejects(checkStreamDelaySpace(Number.MAX_VALUE), /свободно/)

async function waitFor(predicate, label, timeout = 5000) {
  const start = performance.now()
  while (!predicate()) {
    assert.ok(performance.now() - start < timeout, label)
    await delay(20)
  }
}
function packet(index, type = 9, size = 32) {
  const bytes = Buffer.alloc(size + 15, index)
  bytes[0] = type; bytes.writeUIntBE(size, 1, 3); bytes.writeUIntBE(index * 100, 4, 3); bytes[7] = 0
  bytes[11] = type === 9 ? 0x17 : 0xaf; bytes[12] = 1
  return { bytes, type, timestamp: index * 100, configuration: false, keyframe: type === 9 }
}

{
  let clock = 0
  const output = [], errors = [], input = []
  const seconds = 5 * 3600 + 17
  const buffer = new StreamDelayBuffer(seconds, p => output.push(p), e => errors.push(e), () => clock)
  try {
    // Each record rolls the writer to another file. The reader must cross
    // file boundaries without retaining five hours of packet indexes in RAM.
    for (let index = 0; index < 6; index++) {
      clock = index * 11000
      const p = packet(index, index % 2 ? 8 : 9); input.push(p)
      buffer.accept(p)
      await waitFor(() => buffer.pendingBytes === 0, 'Delay writer did not commit')
    }
    assert.equal(output.length, 0, 'Long-delay media must not leak early')
    assert.equal(buffer.writeIndex, 5)
    assert.ok(buffer.snapshot().storedBytes > 0)
    const directory = buffer.directory
    let finished = false
    const finish = buffer.finish().then(() => { finished = true })
    for (let index = 0; index < input.length; index++) {
      clock = seconds * 1000 + index * 11000
      await waitFor(() => output.length === index + 1, 'Delayed audio/video was not released on time')
      assert.equal(finished, index === input.length - 1)
    }
    await finish
    assert.deepEqual(output.map(p => p.bytes), input.map(p => p.bytes))
    assert.deepEqual(output.map(p => p.timestamp), input.map(p => p.timestamp))
    assert.deepEqual(errors, [])
    await buffer.stop()
    assert.ok(!existsSync(directory), 'Completed disk buffer must be removed')
    console.log('PASS: five-hour delay, no early media, identical audio/video bytes and timestamps, rolling-file cleanup')
  } finally { await buffer.stop() }
}

{
  const output = [], errors = []
  const buffer = new StreamDelayBuffer(120, p => output.push(p), e => errors.push(e))
  buffer.accept(packet(1))
  await waitFor(() => buffer.pendingBytes === 0, 'Delay writer did not commit')
  const directory = buffer.directory
  const finish = buffer.finish()
  const cancelled = assert.rejects(finish, /отменена/)
  await buffer.stop(); await cancelled
  assert.equal(output.length, 0)
  assert.deepEqual(errors, [])
  assert.ok(!existsSync(directory))

  const overload = []
  const bounded = new StreamDelayBuffer(120, () => assert.fail('Overloaded queue must not publish'), e => overload.push(e))
  for (let i = 0; i < 7; i++) bounded.accept(packet(i, 9, 3 * 1024 * 1024))
  await bounded.stop()
  assert.equal(overload.length, 1)
  assert.match(overload[0], /Диск не успевает/)
  console.log('PASS: immediate cancellation discards pending media; disk write backlog is bounded')
}

const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening')
const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve))
let engine, receiver, timer, pending = false, frames = 0, receiverErrors = ''
const errors = [], delays = [], times = new Map()
try {
  receiver = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-probesize', '8192', '-analyzeduration', '0',
    '-listen', '1', '-i', `rtmp://127.0.0.1:${port}/live/test`, '-progress', 'pipe:1', '-fps_mode', 'passthrough', '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] })
  receiver.stdout.on('data', progressReader(p => { frames = p.frame ?? frames }))
  receiver.stderr.on('data', bytes => { receiverErrors += bytes.toString() })
  engine = new StreamingEngine(ffmpeg, { ...valid, resolution: 720, bitrateKbps: 1500, delaySeconds: 2,
    destinations: [{ id: 'local', name: 'Local', enabled: true, server: `rtmp://127.0.0.1:${port}/live`, key: 'test' }] }, error => errors.push(error))
  engine.start('libx264', ['-re', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30'])
  const accept = engine.delayBuffer.accept.bind(engine.delayBuffer)
  engine.delayBuffer.accept = packet => { times.set(`${packet.type}:${packet.timestamp}:${packet.configuration}`, performance.now()); accept(packet) }
  const publish = engine.publish.bind(engine)
  engine.publish = packet => {
    const at = times.get(`${packet.type}:${packet.timestamp}:${packet.configuration}`)
    if (at !== undefined) delays.push(performance.now() - at)
    publish(packet)
  }
  timer = setInterval(async () => {
    if (pending) return
    pending = true
    try { await engine.write(new ArrayBuffer(7680)) } finally { pending = false }
  }, 20)
  await delay(1600)
  assert.equal(engine.snapshot().destinations[0].phase, 'connecting', 'Destination must not connect before delay is filled')
  await delay(4500)
  assert.deepEqual(errors, [])
  assert.equal(engine.snapshot().destinations[0].phase, 'live')
  clearInterval(timer)
  let complete = false
  engine.drain(() => { complete = true })
  await waitFor(() => complete || errors.length, 'Delayed stream did not finish', 15000)
  assert.deepEqual(errors, [], errors.join('; '))
  assert.ok(complete)
  await waitFor(() => receiver.exitCode !== null, 'Receiver did not receive EOF')
  assert.equal(receiver.exitCode, 0, receiverErrors)
  assert.ok(frames > 100, `Missing delayed video frames: ${frames}; ${receiverErrors}`)
  assert.ok(delays.length > 100)
  assert.ok(delays.every(ms => ms >= 1980 && ms < 3000), `Unexpected packet delay: ${Math.min(...delays)}–${Math.max(...delays)} ms`)
  assert.equal(engine.snapshot().destinations[0].retries, 0)
  console.log(`PASS: real RTMP H.264/AAC delayed ${Math.round(Math.min(...delays))}–${Math.round(Math.max(...delays))} ms; ${frames} decoded frames, graceful EOF, no reconnects`)
} finally { clearInterval(timer); engine?.stop(); receiver?.kill() }
