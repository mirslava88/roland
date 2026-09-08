// Local-only regression: a valid server needs longer than the media queue
// budget to complete its handshake. Dropping video must not abort its setup.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createServer, connect } from 'node:net'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import ffmpeg from 'ffmpeg-static'

const built = await build({ entryPoints: ['src/main/streaming-engine.ts'], bundle: true, platform: 'node', format: 'esm', write: false })
const { StreamingEngine, progressReader } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)
const reserve = createServer()
reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening')
const port = reserve.address().port
await new Promise(resolve => reserve.close(resolve))

let receiver, proxy, engine, audioTimer, pending = false, frames = 0, connections = 0, receiverErrors = ''
const sockets = new Set(), timers = new Set(), errors = []
try {
  receiver = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-probesize', '8192', '-analyzeduration', '0',
    '-listen', '1', '-i', `rtmp://127.0.0.1:${port}/live/test`, '-progress', 'pipe:1', '-fps_mode', 'passthrough', '-f', 'null', '-'],
  { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  receiver.on('error', error => errors.push(error.message))
  receiver.stdout.on('data', progressReader(p => { frames = p.frame ?? frames }))
  receiver.stderr.on('data', bytes => { receiverErrors = (receiverErrors + bytes.toString()).slice(-4000) })
  proxy = createServer(client => {
    sockets.add(client); client.on('error', () => {}); client.on('close', () => sockets.delete(client)); client.pause(); connections++
    const timer = setTimeout(() => {
      timers.delete(timer)
      if (client.destroyed) return
      const upstream = connect(port, '127.0.0.1')
      sockets.add(upstream); upstream.on('error', () => client.destroy())
      client.on('close', () => upstream.destroy())
      upstream.on('close', () => { sockets.delete(upstream); client.destroy() })
      client.pipe(upstream); upstream.pipe(client)
    }, 2200)
    timers.add(timer)
  })
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening')
  engine = new StreamingEngine(ffmpeg, { resolution: 720, fps: 30, bitrateKbps: 2500, audio: 'none', encoder: 'software', microphoneId: '',
    destinations: [{ id: 'test', name: 'Local delayed server', enabled: true, server: `rtmp://127.0.0.1:${proxy.address().port}/live`, key: 'test' }] }, error => errors.push(error))
  engine.start('libx264', ['-re', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30'])
  audioTimer = setInterval(async () => {
    if (pending) return
    pending = true
    try { await engine.write(new ArrayBuffer(7680)) } finally { pending = false }
  }, 20)
  for (let seconds = 0; seconds < 15; seconds++) {
    await delay(1000)
    assert.equal(errors.length, 0, errors.join('; '))
    const publisher = engine.publishers[0]
    assert.ok(publisher.bytes <= 2 * 1024 * 1024, 'The sender must retain a bounded queue during setup')
    assert.equal(connections, 1, 'A slow but valid handshake must not be aborted by media queue overflow')
  }
  const state = engine.snapshot().destinations[0]
  assert.equal(state.phase, 'live')
  assert.equal(state.retries, 0)
  assert.ok(state.droppedFrames > 0, 'The test must actually exercise queue overflow and GOP dropping')
  assert.ok(frames > 150, `Too few decoded frames after connection: ${frames}; ${receiverErrors}`)
  assert.ok(state.bufferedMs < 1500, `The sender must catch up: ${state.bufferedMs} ms`)
  assert.doesNotMatch(receiverErrors, /non.monoton|Invalid NAL|decode.*error|error.*decod|Missing reference/i)
  console.log(`PASS: 2.2 s handshake, one connection, ${frames} decoded frames, ${state.droppedFrames} stale frames dropped, queue ${state.bufferedMs} ms`)
} finally {
  clearInterval(audioTimer); engine?.stop(); receiver?.kill()
  for (const timer of timers) clearTimeout(timer)
  for (const socket of sockets) socket.destroy()
  proxy?.close()
}
