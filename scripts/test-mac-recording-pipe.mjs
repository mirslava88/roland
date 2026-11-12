import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { build } from 'esbuild'

const ffmpeg = process.env.PDM_TEST_FFMPEG || resolve('tmp/macos-build/build/mac-ffmpeg')
const directory = mkdtempSync(join(tmpdir(), 'pdm-mac-record-pipe-'))
const compiled = await build({ entryPoints: ['src/main/recording-engine.ts'], bundle: true, platform: 'node', format: 'esm', write: false })
const { RecordingEngine } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)
const producer = join(directory, 'capture.cjs'), pidFile = join(directory, 'capture.pid')
// Larger than a pipe chunk: stopping must not truncate the final BGRA frame.
writeFileSync(producer, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));
const frame=Buffer.alloc(192*108*4);for(let i=0;i<frame.length;i+=4){frame[i]=91;frame[i+1]=53;frame[i+2]=17;frame[i+3]=255}
let busy=false;setInterval(()=>{if(busy)return;busy=true;process.stdout.write(frame,()=>busy=false)},40);
process.stdout.on('error',()=>process.exit(0));`)
const file = join(directory, 'native.mkv'), errors = []
const engine = new RecordingEngine(ffmpeg, message => errors.push(message))
try {
  engine.start({ format: 'lossless-mkv', fps: 25, audio: 'none', microphoneId: '' },
    ['-f', 'rawvideo', '-pixel_format', 'bgra', '-video_size', '192x108', '-framerate', '25',
      '-use_wallclock_as_timestamps', '1', '-i', 'pipe:4'], file, true, { path: process.execPath, args: [producer] })
  for (let index = 0; index < 60; index++) {
    assert.equal(await engine.writeAudio(new Float32Array(1920).buffer, Date.now()), true, errors.join('; '))
    await new Promise(done => setTimeout(done, 20))
  }
  assert.equal(await engine.stop(), true, 'native producer did not finalize cleanly: ' + errors.join('; '))
  assert.deepEqual(errors, [])
  execFileSync(ffmpeg, ['-v', 'error', '-i', file, '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] })
  const frame = execFileSync(ffmpeg, ['-v', 'error', '-i', file, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'])
  assert.deepEqual([...frame.subarray(0, 3)], [17, 53, 91], 'native recording changed RGB pixels')
  const pid = Number(readFileSync(pidFile, 'utf8'))
  for (let index = 0; index < 20; index++) {
    try { process.kill(pid, 0) } catch { break }
    await new Promise(done => setTimeout(done, 50))
  }
  assert.throws(() => process.kill(pid, 0), /ESRCH/, 'native capture survived recorder stop')
  console.log('PASS: native BGRA pipe finalizes, fully decodes, preserves RGB and releases capture')
} finally { await engine.stop(); rmSync(directory, { recursive: true, force: true }) }
