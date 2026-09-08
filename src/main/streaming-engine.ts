import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'child_process'
import { performance } from 'perf_hooks'
import type { StreamSettings, StreamStatus } from '../shared/streaming'
import { StreamPublisher } from './stream-publisher'
import { FlvParser, type FlvPacket } from './stream-flv'

// Return only fixed messages, never FFmpeg text: errors can embed a secret URL.
export function publisherErrorMessage(text: string): string | undefined {
  if (/sample rate not set|dimensions not set|could not find codec parameters/i.test(text)) return 'Не удалось определить параметры звука или видео при подключении.'
  if (/certificate.*(?:verif|invalid|expired)|verify peer|certificate.s owner/i.test(text)) return 'Не удалось проверить сертификат сервера. Проверьте дату Windows и сетевые настройки.'
  if (/already publishing|already connected|already in use|NetStream.Publish.BadName/i.test(text)) return 'Сервер отклонил имя потока: проверьте ключ и не используется ли он в другой программе.'
  if (/unauthorized|authentication|auth_key|invalid.*(?:key|token)|(?:key|token).*invalid|403|401|access denied/i.test(text)) return 'Сервер отклонил доступ. Проверьте ключ и состояние трансляции на площадке.'
  if (/resolve hostname|name or service not known|getaddrinfo|no such host/i.test(text)) return 'Не удалось найти сервер по указанному адресу.'
  if (/connection refused|actively refused/i.test(text)) return 'Сервер отклонил подключение. Проверьте адрес и порт.'
  if (/timed out|timeout/i.test(text)) return 'Сервер не ответил вовремя. Проверьте соединение и доступность площадки.'
  if (/RTMP handshake|handshak.*(?:fail|error)|cannot read RTMP/i.test(text)) return 'Сервер не завершил RTMP-подключение. Проверьте адрес сервера и ограничения сети.'
  if (/TLS.*(?:fail|error)|SSL.*(?:fail|error)|cannot open connection tls/i.test(text)) return 'Не удалось установить защищённое подключение к серверу.'
  if (/non.monoton|invalid.*timestamp/i.test(text)) return 'Ошибка временных меток звука или видео.'
  if (/server error/i.test(text)) return 'Площадка отклонила поток. Проверьте ключ и запуск трансляции в её настройках.'
  if (/connection reset|broken pipe|end of file|error in the pull function/i.test(text)) return 'Соединение с сервером прервано.'
  return undefined
}

export function desktopInputArguments(bounds: { x: number; y: number; width: number; height: number }, fps: number): string[] {
  return ['-thread_queue_size', '2', '-probesize', '32', '-analyzeduration', '0', '-fpsprobesize', '0', '-f', 'gdigrab', '-framerate', String(fps), '-draw_mouse', '0',
    '-offset_x', String(bounds.x), '-offset_y', String(bounds.y), '-video_size', `${bounds.width}x${bounds.height}`, '-i', 'desktop']
}

export const encoderArguments = (s: StreamSettings, encoder: string, videoInput: string[]): string[] => [
  '-hide_banner', '-loglevel', 'warning', '-nostdin', '-filter_threads', '2',
  ...videoInput,
  '-thread_queue_size', '8', '-probesize', '32', '-analyzeduration', '0',
  '-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0',
  '-map', '0:v:0', '-map', '1:a:0', '-c:v', encoder,
  ...(encoder === 'libx264' ? ['-preset', 'veryfast', '-tune', 'zerolatency'] : []),
  // QSV otherwise turns time-forced I frames into non-IDR frames. Those do
  // not provide a clean decoder entry point for a live segment/reconnection.
  ...(encoder === 'h264_qsv' ? ['-preset', 'veryfast', '-async_depth', '1', '-look_ahead', '0', '-forced_idr', '1'] : []),
  ...(encoder === 'h264_nvenc' ? ['-preset', 'p3', '-tune', 'll', '-rc-lookahead', '0', '-zerolatency', '1'] : []),
  ...(encoder === 'h264_amf' ? ['-usage', 'ultralowlatency', '-quality', 'speed'] : []),
  '-threads', '4', '-pix_fmt', 'yuv420p', '-fps_mode', 'vfr',
  '-vf', `setpts=PTS-STARTPTS,scale=${s.resolution === 1080 ? 1920 : 1280}:${s.resolution}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${s.resolution === 1080 ? 1920 : 1280}:${s.resolution}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
  '-g', String(s.fps * 2), '-bf', '0', '-b:v', `${s.bitrateKbps}k`,
  '-force_key_frames', 'expr:gte(t,n_forced*2)',
  '-maxrate', `${s.bitrateKbps}k`, '-bufsize', `${s.bitrateKbps}k`,
  '-af', 'asetpts=PTS-STARTPTS,aresample=async=1000:first_pts=0', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
  '-progress', 'pipe:2', '-stats_period', '0.5', '-flush_packets', '1', '-max_interleave_delta', '1000000',
  '-flvflags', 'no_duration_filesize', '-f', 'flv', 'pipe:1'
]

export function progressReader(onProgress: (values: Record<string, number>) => void): (chunk: Buffer) => void {
  let rest = ''
  let values: Record<string, number> = {}
  return (chunk) => {
    rest += chunk.toString()
    const lines = rest.split(/\r?\n/)
    rest = (lines.pop() || '').slice(-4096)
    for (const line of lines) {
      const match = /^(frame|fps|drop_frames|out_time_us|total_size|speed)=\s*(-?\d+(?:\.\d+)?)(?:x)?$/.exec(line)
      if (match) values[match[1]] = Number(match[2])
      if (line.startsWith('progress=')) { onProgress(values); values = {} }
    }
  }
}

export function probeEncoder(path: string, encoder: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(path, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=size=1920x1080:rate=30',
      '-frames:v', '3', '-c:v', encoder, '-pix_fmt', 'yuv420p', '-f', 'null', '-'],
    { windowsHide: true, timeout: 10000, maxBuffer: 65536 }, (error) => resolve(!error))
  })
}

export class StreamingEngine {
  private encoder: ChildProcessWithoutNullStreams | null = null
  private publishers: StreamPublisher[] = []
  private timer?: NodeJS.Timeout
  private stopped = false
  private lastFrameAt = performance.now()
  private writePending = false
  private fps = 0
  private droppedFrames = 0
  private bitrateKbps = 0
  private headers = new Map<number, FlvPacket>()
  private lastVideoTime = 0
  private firstVideoAt = 0
  private firstVideoTime = 0
  private encodedBytes = 0
  private lastStatsAt = performance.now()
  private lastStatsBytes = 0
  private encoderLagMs = 0
  private lagSince = 0
  private firstAudioAt: number | null = null
  private audioFrames = 0
  private lastAudioAt = performance.now()

  constructor(private path: string, private settings: StreamSettings,
    private onError: (message: string) => void) {}

  start(encoder: string, videoInput: string[]): void {
    const process = spawn(this.path, encoderArguments(this.settings, encoder, videoInput), { windowsHide: true, stdio: 'pipe' })
    this.encoder = process
    this.publishers = this.settings.destinations.filter((d) => d.enabled).map(d => new StreamPublisher(this.path, { ...d }))
    process.stdin.on('error', () => this.fail('Кодер прекратил приём кадров.'))
    process.on('error', () => this.fail('Не удалось запустить кодер.'))
    process.on('exit', (code) => this.fail(`Кодер и отправка остановились (код ${code ?? '—'}). Проверьте настройки площадок или выберите другой кодер.`))
    const parser = new FlvParser(packet => {
      this.encodedBytes += packet.bytes.length
      if (packet.configuration || packet.type === 18) this.headers.set(packet.type, packet)
      if (packet.type === 9 && !packet.configuration) {
        this.lastFrameAt = performance.now(); this.lastVideoTime = packet.timestamp
        if (!this.firstVideoAt) { this.firstVideoAt = this.lastFrameAt; this.firstVideoTime = packet.timestamp }
      }
      for (const publisher of this.publishers) publisher.accept(packet, [...this.headers.values()])
    })
    process.stdout.on('data', (chunk: Buffer) => {
      if (this.stopped) return
      try { parser.push(chunk) } catch { this.fail('Кодер выдал некорректный поток. Стрим остановлен.') }
    })
    const readProgress = progressReader((p) => {
      this.fps = p.fps ?? this.fps
      this.droppedFrames = p.drop_frames ?? this.droppedFrames
    })
    let errorTail = ''
    process.stderr.on('data', (chunk: Buffer) => {
      readProgress(chunk)
      errorTail = (errorTail + chunk.toString()).slice(-4096)
      if (/Failed to capture|Capture area|Could not find.*desktop|I\/O error/i.test(errorTail)) this.fail('Не удалось захватить эфирный экран. Проверьте его подключение.')
      const lastLine = errorTail.lastIndexOf('\n')
      if (lastLine >= 0) errorTail = errorTail.slice(lastLine + 1)
    })
    this.timer = setInterval(() => {
      const now = performance.now()
      this.bitrateKbps = Math.round((this.encodedBytes - this.lastStatsBytes) * 8 / Math.max(1, now - this.lastStatsAt))
      this.lastStatsAt = now; this.lastStatsBytes = this.encodedBytes
      this.encoderLagMs = this.firstVideoAt ? Math.max(0, Math.round(now - this.firstVideoAt - (this.lastVideoTime - this.firstVideoTime))) : 0
      if (this.encoderLagMs > 3000) {
        if (!this.lagSince) this.lagSince = now
        if (now - this.lagSince > 3000) this.fail('Кодер не успевает за эфиром. Уменьшите разрешение или частоту кадров; старое видео не будет накапливаться.')
      } else this.lagSince = 0
      if (now - this.lastFrameAt > 15000) this.fail('Кодер перестал получать изображение. Стрим остановлен.')
      if (now - this.lastAudioAt > 5000) this.fail('Захват звука перестал передавать свежие данные. Стрим остановлен.')
      for (const p of this.publishers) p.tick()
    }, 500)
  }

  write(bytes: ArrayBuffer, capturedAt = Date.now()): Promise<boolean> {
    const input = this.encoder?.stdin
    if (this.stopped || !input || input.destroyed || this.writePending ||
      !(bytes instanceof ArrayBuffer) || bytes.byteLength > 38400 || bytes.byteLength % 8 !== 0) return Promise.resolve(false)
    if (!Number.isFinite(capturedAt) || Date.now() - capturedAt > 300) return Promise.resolve(true)
    const frames = bytes.byteLength / 8
    this.lastAudioAt = performance.now()
    if (this.firstAudioAt === null) this.firstAudioAt = capturedAt - frames / 48
    // Raw PCM timestamps are its exact sample count. Fill skipped worklet
    // blocks with silence so load cannot make audio gradually drift from video.
    const gap = Math.max(0, Math.round((capturedAt - this.firstAudioAt) * 48) - this.audioFrames - frames)
    if (gap > 96000) { this.fail('Захват звука отстал от эфира. Стрим остановлен; уменьшите нагрузку на компьютер.'); return Promise.resolve(false) }
    const payload = gap > 1 ? Buffer.concat([Buffer.alloc(gap * 8), Buffer.from(bytes)]) : Buffer.from(bytes)
    this.audioFrames += payload.length / 8
    this.writePending = true
    return new Promise((resolve) => {
      let finished = false
      const finish = (ok: boolean): void => {
        if (finished) return
        finished = true
        clearTimeout(timeout)
        this.writePending = false
        resolve(ok && !this.stopped)
      }
      const timeout = setTimeout(() => { finish(false); this.fail('Кодер перегружен. Уменьшите качество или частоту кадров.'); }, 5000)
      input.write(payload, (error) => finish(!error))
    })
  }

  snapshot(): Pick<StreamStatus, 'destinations' | 'fps' | 'bitrateKbps' | 'droppedFrames' | 'encoderLagMs'> {
    return { fps: this.fps, bitrateKbps: this.bitrateKbps, droppedFrames: this.droppedFrames, encoderLagMs: this.encoderLagMs,
      destinations: this.publishers.map(p => p.snapshot()) }
  }

  private fail(message: string): void {
    if (this.stopped) return
    this.stop()
    this.onError(message)
  }

  stop(): void {
    this.stopped = true
    clearInterval(this.timer)
    for (const p of this.publishers) p.stop()
    this.headers.clear()
    this.encoder?.stdin.destroy()
    this.encoder?.kill()
    this.encoder = null
    this.publishers = []
  }
}
