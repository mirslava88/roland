// Local-only bitstream regression. Live viewers/segmenters need IDR frames,
// not just I pictures; ffmpeg accepting -force_key_frames is not proof of IDR.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import ffmpeg from 'ffmpeg-static'

const result = await build({ entryPoints: ['src/main/streaming-engine.ts', 'src/main/stream-flv.ts'],
  bundle: true, platform: 'node', format: 'esm', outdir: 'unused', write: false })
const modules = await Promise.all(result.outputFiles.map(f => import(`data:text/javascript;base64,${Buffer.from(f.text).toString('base64')}`)))
const { encoderArguments, probeEncoder } = modules.find(m => m.encoderArguments)
const { FlvParser, FLV_HEADER, rebaseFlvPacket } = modules.find(m => m.FlvParser)

function videoNalTypes(packet, lengthBytes) {
  const types = []
  let offset = 16 // FLV tag header + AVC packet header
  while (offset + lengthBytes <= packet.bytes.length - 4) {
    const size = packet.bytes.readUIntBE(offset, lengthBytes); offset += lengthBytes
    assert.ok(size > 0 && offset + size <= packet.bytes.length - 4, 'Valid length-prefixed H.264 NAL unit')
    types.push(packet.bytes[offset] & 31); offset += size
  }
  assert.equal(offset, packet.bytes.length - 4)
  return types
}

async function check(encoder) {
  // The source still advertises 30 fps but delivers every other frame, just
  // as capture does under load. A frame-count-only GOP cannot meet 2 seconds.
  const args = encoderArguments({ resolution: 720, fps: 30, bitrateKbps: 2500 }, encoder,
    ['-re', '-f', 'lavfi', '-i', "testsrc2=size=1280x720:rate=30,select='not(mod(n,2))'"])
  args.splice(args.length - 1, 0, '-t', '9')
  const child = spawn(ffmpeg, args, { windowsHide: true, stdio: 'pipe' })
  const headers = new Map(), parts = [], idrTimes = []
  let lengthBytes = 4, current, pending = false, lastAudio = Date.now(), stderr = '', parseError
  const parser = new FlvParser(packet => {
    if (packet.configuration || packet.type === 18) {
      headers.set(packet.type, packet)
      if (packet.type === 9) lengthBytes = (packet.bytes[20] & 3) + 1
      return
    }
    if (packet.type === 9 && packet.bytes[12] === 2) return // AVC end-of-sequence
    if (packet.type === 9) {
      const idr = videoNalTypes(packet, lengthBytes).includes(5)
      if (packet.keyframe) assert.ok(idr, 'A recovery keyframe must be a genuine H.264 IDR')
      if (idr) {
        idrTimes.push(packet.timestamp)
        current = { origin: packet.timestamp, packets: [] }; parts.push(current)
      }
    }
    if (current && packet.timestamp >= current.origin) current.packets.push(packet)
  })
  child.stdout.on('data', bytes => { try { parser.push(bytes) } catch (e) { parseError = e; child.kill() } })
  child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-2000) })
  child.stdin.on('error', () => {})
  const audioTimer = setInterval(() => {
    if (pending) return
    pending = true
    const now = Date.now(), frames = Math.round((now - lastAudio) * 48); lastAudio = now
    child.stdin.write(Buffer.alloc(frames * 8), () => { pending = false })
  }, 20)
  const deadline = setTimeout(() => child.kill(), 18000)
  let code
  try { [code] = await once(child, 'exit') }
  finally { clearInterval(audioTimer); clearTimeout(deadline); child.kill() }
  if (parseError) throw parseError
  assert.equal(code, 0, stderr)
  assert.ok(idrTimes.length >= 5, `${encoder}: expected IDR every 2 seconds; got ${JSON.stringify(idrTimes)}`)
  const intervals = idrTimes.slice(1).map((time, i) => time - idrTimes[i])
  assert.ok(intervals.every(ms => ms >= 1900 && ms <= 2100), `${encoder}: IDR intervals ${intervals}`)

  // Start a NEW decoder from each IDR. This catches dependencies hidden by
  // tests that keep a single decoder running from the beginning of a stream.
  for (const part of parts) {
    const input = Buffer.concat([FLV_HEADER, ...[...headers.values(), ...part.packets].map(p => rebaseFlvPacket(p, part.origin))])
    const decoder = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-xerror', '-f', 'flv', '-i', 'pipe:0',
      '-map', '0:v:0', '-an', '-frames:v', '3', '-fps_mode', 'passthrough', '-f', 'framemd5', 'pipe:1'], { windowsHide: true, stdio: 'pipe' })
    let output = '', errors = ''
    decoder.stdout.on('data', bytes => { output += bytes })
    decoder.stderr.on('data', bytes => { errors += bytes })
    decoder.stdin.on('error', () => {})
    const closed = once(decoder, 'exit')
    const limit = setTimeout(() => decoder.kill(), 5000)
    decoder.stdin.end(input)
    try {
      const [exitCode] = await closed
      assert.equal(exitCode, 0, `${encoder}: decoder failed at ${part.origin} ms: ${errors}`)
      assert.equal(output.split(/\r?\n/).filter(line => /^0,/.test(line)).length, 3)
      assert.equal(errors.trim(), '')
    } finally { clearTimeout(limit); decoder.kill() }
  }
  console.log(`PASS: ${encoder}, IDR intervals ${intervals.join('/')} ms; all ${parts.length} segments decode independently`)
}

await check('libx264')
if (await probeEncoder(ffmpeg, 'h264_qsv')) await check('h264_qsv')
else console.log('SKIP: QSV hardware unavailable; software recovery test passed')
