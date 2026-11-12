import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { build } from 'esbuild'
import ffmpeg from 'ffmpeg-static'

const bundle = await build({ entryPoints: ['src/main/recording-engine.ts'], bundle: true,
  platform: 'node', format: 'esm', write: false })
const { RecordingEngine } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`)
const directory = await mkdtemp(join(tmpdir(), 'pdm-record-test-'))

try {
  for (const [format, extension, videoCodec, audioCodec] of [
    ['lossless-mkv', 'mkv', /h264.*4:4:4/i, /pcm_f32le/i],
    ['quality-mp4', 'mp4', /h264/i, /aac/i]
  ]) {
    const path = join(directory, `recording.${extension}`)
    const errors = []
    const engine = new RecordingEngine(ffmpeg, message => errors.push(message))
    const settings = { format, fps: 25, audio: 'none', microphoneId: '' }
    engine.start(settings, ['-f', 'rawvideo', '-pixel_format', 'bgra', '-video_size', '128x72',
      '-framerate', '25', '-use_wallclock_as_timestamps', '1', '-i', 'pipe:4'], path, true)
    const frame = Buffer.alloc(128 * 72 * 4)
    const audio = new Float32Array(960 * 2).buffer
    for (let index = 0; index < 25; index++) {
      for (let pixel = 0; pixel < frame.length; pixel += 4) {
        frame[pixel] = (index + 1) * 7 % 255
        frame[pixel + 1] = (index + 1) * 9 % 255
        frame[pixel + 2] = (index + 1) * 15 % 255
        frame[pixel + 3] = 255
      }
      const [videoAccepted, audioAccepted] = await Promise.all([
        engine.writeVideo(frame), engine.writeAudio(audio, Date.now())
      ])
      assert.equal(videoAccepted, true, `${format}: video rejected; ${errors.join('; ')}`)
      assert.equal(audioAccepted, true, `${format}: audio rejected; ${errors.join('; ')}`)
      assert.equal(await engine.writeAudio(audio, Date.now()), true, `${format}: second audio block rejected`)
      await delay(40)
    }
    assert.equal(await engine.stop(), true, `${format}: container did not finalize; ${errors.join('; ')}`)
    assert.ok((await stat(path)).size > 1000, `${format}: recording is empty`)
    const output = execFileSync(ffmpeg, ['-hide_banner', '-i', path, '-f', 'null', process.platform === 'win32' ? 'NUL' : '/dev/null'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    // ffmpeg writes stream information to stderr. A successful full decode
    // above proves both streams and the container's final index are readable.
    void output
    const info = await import('node:child_process').then(({ spawnSync }) => spawnSync(ffmpeg,
      ['-hide_banner', '-i', path, '-t', '0.1', '-f', 'null', process.platform === 'win32' ? 'NUL' : '/dev/null'],
      { encoding: 'utf8' }))
    assert.match(info.stderr, videoCodec)
    assert.match(info.stderr, audioCodec)
    if (format === 'lossless-mkv') {
      const firstFrame = execFileSync(ffmpeg, ['-loglevel', 'error', '-i', path, '-map', '0:v:0',
        '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { maxBuffer: 128 * 72 * 3 + 1024 })
      assert.deepEqual([...firstFrame.subarray(0, 3)], [15, 9, 7], 'MKV changed source RGB pixels')
    }
    console.log(`PASS: ${format} finalizes and fully decodes with video and audio`)
  }
} finally {
  await rm(directory, { recursive: true, force: true })
}
