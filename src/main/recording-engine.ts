import { spawn, type ChildProcess } from 'child_process'
import type { Writable } from 'stream'
import type { RecordingSettings } from '../shared/recording'
import { progressReader } from './streaming-engine'

export function recordingArguments(settings: RecordingSettings, videoInput: string[], path: string): string[] {
  const lossless = settings.format === 'lossless-mkv'
  return [
    '-hide_banner', '-loglevel', 'warning', '-filter_threads', '2',
    ...videoInput,
    '-thread_queue_size', '8', '-probesize', '32', '-analyzeduration', '0',
    '-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', 'pipe:3',
    '-map', '0:v:0', '-map', '1:a:0', '-fps_mode', 'vfr',
    ...(lossless
      ? ['-c:v', 'libx264rgb', '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'bgr0',
        '-c:a', 'pcm_f32le', '-f', 'matroska']
      : ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '16', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '320k', '-movflags', '+faststart', '-f', 'mp4']),
    '-shortest', '-progress', 'pipe:2', '-stats_period', '1', '-n', path
  ]
}

export class RecordingEngine {
  private child: ChildProcess | null = null
  private audio: Writable | null = null
  private video: Writable | null = null
  private stopping = false
  private audioPending = false
  private videoPending = false
  private firstAudioAt: number | null = null
  private audioFrames = 0
  private frames = 0
  private fps = 0
  private droppedFrames = 0
  private exitPromise: Promise<number | null> | null = null

  constructor(private ffmpegPath: string, private onFailure: (message: string) => void) {}

  start(settings: RecordingSettings, videoInput: string[], path: string, rawVideo: boolean): void {
    const child = spawn(this.ffmpegPath, recordingArguments(settings, videoInput, path), {
      windowsHide: true, stdio: rawVideo ? ['pipe', 'ignore', 'pipe', 'pipe', 'pipe'] : ['pipe', 'ignore', 'pipe', 'pipe']
    })
    this.child = child
    this.audio = child.stdio[3] as Writable
    this.video = rawVideo ? child.stdio[4] as Writable : null
    child.stdin?.on('error', () => {})
    this.audio.on('error', () => { if (!this.stopping) this.onFailure('Кодер записи перестал принимать звук.') })
    this.video?.on('error', () => { if (!this.stopping) this.onFailure('Кодер записи перестал принимать видео.') })
    this.exitPromise = new Promise((resolve) => child.once('close', (code) => resolve(code)))
    const progress = progressReader(values => {
      this.frames = values.frame ?? this.frames
      this.fps = values.fps ?? this.fps
      this.droppedFrames = values.drop_frames ?? this.droppedFrames
    })
    let tail = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      progress(chunk)
      tail = (tail + chunk.toString()).slice(-2048)
    })
    child.on('error', () => { if (!this.stopping) this.onFailure('Не удалось запустить кодер записи.') })
    child.on('exit', (code) => {
      if (!this.stopping) this.onFailure(/Failed to capture|Capture area|Could not find.*desktop/i.test(tail)
        ? 'Потерян эфирный экран. Запись остановлена.'
        : `Кодер записи завершился (код ${code ?? '—'}). Проверьте свободное место и нагрузку на компьютер.`)
    })
  }

  async writeAudio(bytes: ArrayBuffer, capturedAt: number): Promise<boolean> {
    const input = this.audio
    if (this.stopping || !input || input.destroyed || this.audioPending || !(bytes instanceof ArrayBuffer) ||
      bytes.byteLength > 38400 || bytes.byteLength % 8 !== 0) return false
    if (!Number.isFinite(capturedAt) || Date.now() - capturedAt > 300) return true
    const frames = bytes.byteLength / 8
    if (this.firstAudioAt === null) this.firstAudioAt = capturedAt - frames / 48
    const gap = Math.max(0, Math.round((capturedAt - this.firstAudioAt) * 48) - this.audioFrames - frames)
    if (gap > 96000) { this.onFailure('Захват звука отстал от видео. Запись остановлена.'); return false }
    const payload = gap > 1 ? Buffer.concat([Buffer.alloc(gap * 8), Buffer.from(bytes)]) : Buffer.from(bytes)
    this.audioFrames += payload.length / 8
    this.audioPending = true
    return new Promise(resolve => {
      let done = false
      const timeout = setTimeout(() => finish(false), 5000)
      const finish = (ok: boolean): void => {
        if (done) return
        done = true
        clearTimeout(timeout)
        this.audioPending = false
        resolve(ok && !this.stopping)
      }
      input.write(payload, error => finish(!error))
    })
  }

  async writeVideo(bytes: Buffer): Promise<boolean> {
    const input = this.video
    if (this.stopping || !input || input.destroyed || this.videoPending) return false
    this.videoPending = true
    return new Promise(resolve => {
      input.write(bytes, error => { this.videoPending = false; resolve(!error && !this.stopping) })
    })
  }

  snapshot(): { frames: number; fps: number; droppedFrames: number } {
    return { frames: this.frames, fps: this.fps, droppedFrames: this.droppedFrames }
  }

  async stop(): Promise<boolean> {
    if (!this.child) return true
    this.stopping = true
    const child = this.child
    // gdigrab is an endless input. Closing PCM lets -shortest finalize the
    // container; closing the raw video pipe does the same in headless mode.
    this.audio?.end()
    this.video?.end()
    const askToQuit = setTimeout(() => {
      try { child.stdin?.write('q\n') } catch { /* process may already be gone */ }
    }, 4000)
    const code = await Promise.race([
      this.exitPromise ?? Promise.resolve(null),
      new Promise<null>(resolve => setTimeout(() => resolve(null), 16000))
    ])
    clearTimeout(askToQuit)
    if (code === null) child.kill()
    this.child = null
    this.audio = null
    this.video = null
    return code === 0
  }
}
