import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { performance } from 'perf_hooks'
import { streamDestinationUrl, type StreamDestination } from '../shared/streaming'
import { FLV_HEADER, rebaseFlvPacket, type FlvPacket } from './stream-flv'
import { progressReader, publisherErrorMessage } from './streaming-engine'
import { StreamTlsRelay } from './stream-tls-relay'

// Independent copy-only sender. Limit by MEDIA AGE as well as bytes: a static
// slide can compress a minute of video into less than a megabyte.
const MAX_QUEUE_MS = 1200
const MAX_QUEUE_BYTES = 2 * 1024 * 1024
export class StreamPublisher {
  private child: ChildProcessWithoutNullStreams | null = null
  private relay: StreamTlsRelay | null = null
  private opening = false
  private generation = 0
  private attemptError?: string
  private queue: FlvPacket[] = []
  private bytes = 0
  private writing = false
  private origin = 0
  private latest = 0
  private sentTime = 0
  private started = 0
  private lastProgress = 0
  private retryAt = 0
  private stopped = false
  private phase: 'connecting' | 'live' | 'reconnecting' = 'connecting'
  private retries = 0
  private error?: string
  private sentBytes = 0
  private bitrateKbps = 0
  private dropped = 0
  private waitingForKeyframe = false
  private lagSince = 0
  private finishing = false
  private inputEnded = false
  private finishResolve?: () => void
  private finishReject?: (error: Error) => void
  private finishTimer?: NodeJS.Timeout
  constructor(private path: string, private destination: StreamDestination) {}

  accept(packet: FlvPacket, headers: FlvPacket[]): void {
    if (this.stopped || packet.configuration || packet.type === 18) return
    this.latest = Math.max(this.latest, packet.timestamp)
    if (!this.child && !this.opening) {
      if (!packet.keyframe || performance.now() < this.retryAt || !headers.some(p => p.type === 8) || !headers.some(p => p.type === 9)) return
      this.open(packet.timestamp, headers)
    }
    if (packet.timestamp < this.origin) return
    if (this.waitingForKeyframe) {
      if (!packet.keyframe) { if (packet.type === 9) this.dropped++; return }
      this.waitingForKeyframe = false
    }
    this.queue.push(packet); this.bytes += packet.bytes.length
    if (this.bytes > MAX_QUEUE_BYTES || packet.timestamp - this.queue[0].timestamp > MAX_QUEUE_MS) {
      // RTMP/TLS setup can legitimately exceed the small media queue budget.
      // Closing the connection here prevents a slower server from EVER opening.
      // Discard a whole unsent GOP instead; never send its dependent P frames.
      // The bounded in-flight write is left intact, followed by a fresh IDR.
      this.dropped += this.queue.filter(p => p.type === 9).length
      this.queue = []; this.bytes = 0; this.waitingForKeyframe = true
      if (packet.keyframe && packet.bytes.length <= MAX_QUEUE_BYTES) {
        this.queue.push(packet); this.bytes = packet.bytes.length
        this.dropped--; this.waitingForKeyframe = false
      }
    }
    this.pump()
  }

  private open(origin: number, headers: FlvPacket[]): void {
    this.opening = true
    this.attemptError = undefined
    const generation = ++this.generation
    this.origin = origin; this.sentTime = origin; this.sentBytes = 0
    this.lagSince = 0
    this.started = this.lastProgress = performance.now()
    const url = streamDestinationUrl(this.destination)
    if (process.platform === 'darwin' && new URL(url).protocol === 'rtmps:') {
      const relay = new StreamTlsRelay((message) => {
        if (this.generation !== generation || this.stopped) return
        this.attemptError = message
        this.reconnect(message)
      })
      this.relay = relay
      void relay.open(url).then((transport) => {
        if (this.generation !== generation || this.stopped) { relay.close(); return }
        this.spawnSender(origin, headers, transport.url, transport.tcUrl)
      }).catch(() => {
        if (this.generation === generation && !this.stopped) this.reconnect('Не удалось подготовить защищённую отправку.')
      })
    } else this.spawnSender(origin, headers, url)
  }

  private spawnSender(origin: number, headers: FlvPacket[], url: string, tcUrl?: string): void {
    const child = spawn(this.path, ['-hide_banner', '-loglevel', 'error', '-nostdin',
      '-probesize', '8192', '-analyzeduration', '0', '-f', 'flv', '-i', 'pipe:0',
      '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-flush_packets', '1', '-flvflags', 'no_duration_filesize',
      '-progress', 'pipe:1', '-stats_period', '0.25', '-rw_timeout', '4000000',
      ...(tcUrl ? ['-rtmp_tcurl', tcUrl] : new URL(url).protocol === 'rtmps:' ? ['-tls_verify', '1'] : []), '-f', 'flv', url],
    { windowsHide: true, stdio: 'pipe' })
    this.child = child
    this.opening = false
    const failed = (): void => { if (this.child === child) this.reconnect(this.attemptError || 'Соединение с площадкой прервано. Выполняется переподключение.') }
    child.on('error', failed)
    child.on('exit', (code) => {
      if (this.child === child && this.finishing && this.inputEnded && code === 0) {
        this.finishResolve?.(); this.finishResolve = undefined; this.finishReject = undefined
        this.stop()
      } else failed()
    })
    child.stdin.on('error', failed)
    child.stdout.on('data', progressReader(p => {
      if (this.child !== child || (p.out_time_us ?? -1) < 0) return
      const now = performance.now()
      if ((p.total_size ?? 0) > this.sentBytes) {
        this.bitrateKbps = Math.round(((p.total_size ?? 0) - this.sentBytes) * 8 / Math.max(1, now - this.lastProgress))
        this.sentBytes = p.total_size ?? this.sentBytes
        this.lastProgress = now
        this.sentTime = this.origin + (p.out_time_us ?? 0) / 1000
        this.phase = 'live'; this.error = undefined
      }
    }))
    let tail = ''
    child.stderr.on('data', (b: Buffer) => {
      if (this.child !== child) return
      tail = (tail + b.toString()).slice(-4096)
      const message = publisherErrorMessage(tail)
      if (message) this.attemptError = this.error = message // fixed text only; never expose an RTMP URL
      const end = tail.lastIndexOf('\n'); if (end >= 0) tail = tail.slice(end + 1)
    })
    child.stdin.write(Buffer.concat([FLV_HEADER, ...headers.map(p => rebaseFlvPacket(p, origin))]))
    this.pump()
  }

  private pump(): void {
    const child = this.child
    if (!child || this.writing) return
    if (!this.queue.length) {
      if (this.finishing && !this.inputEnded) { this.inputEnded = true; child.stdin.end() }
      return
    }
    const packet = this.queue.shift()!; this.bytes -= packet.bytes.length
    this.writing = true
    child.stdin.write(rebaseFlvPacket(packet, this.origin), error => {
      if (this.child !== child) return
      this.writing = false
      if (error) this.reconnect(this.attemptError || 'Соединение с площадкой прервано.')
      else this.pump()
    })
  }

  tick(): void {
    if (!this.child) return
    const now = performance.now()
    // A successful pipe write only means FFmpeg buffered it. Its mux progress
    // is the independent acknowledgement that the network output advanced.
    // Allow setup independently of media buffering. Once publishing, tolerate
    // a short burst while the sender catches up; only persistent lag reconnects.
    const hasProgress = this.sentBytes > 0
    if (hasProgress && this.latest - this.sentTime > 2500) {
      if (!this.lagSince) this.lagSince = now
    } else this.lagSince = 0
    if ((!hasProgress && now - this.started > 15000) ||
      (hasProgress && (now - this.lastProgress > 4000 || (this.lagSince > 0 && now - this.lagSince > 3000)))) {
      this.reconnect(this.attemptError || 'Отправка отстала от эфира. Подключение перезапущено с текущего кадра.')
    }
  }
  private reconnect(message: string): void {
    if (this.stopped) return
    if (this.finishing) {
      this.finishReject?.(new Error(message)); this.finishResolve = undefined; this.finishReject = undefined
      this.stop(); return
    }
    this.dropped += this.queue.filter(p => p.type === 9).length
    this.closeChild(); this.retries++; this.phase = 'reconnecting'; this.error = message
    this.retryAt = performance.now() + 1000
  }
  private closeChild(): void {
    this.generation++; this.opening = false
    this.relay?.close(); this.relay = null
    const child = this.child; this.child = null
    this.queue = []; this.bytes = 0; this.writing = false; this.bitrateKbps = 0
    this.waitingForKeyframe = false; this.lagSince = 0
    child?.stdin.destroy(); child?.kill()
  }
  snapshot() {
    return { id: this.destination.id, name: this.destination.name, phase: this.phase, retries: this.retries,
      error: this.error, bitrateKbps: this.bitrateKbps, bufferedMs: this.child ? Math.round(Math.max(0, this.latest - this.sentTime)) : 0,
      droppedFrames: this.dropped }
  }
  finish(): Promise<void> {
    if (!this.child && !this.latest) { this.stop(); return Promise.resolve() }
    if (!this.child) { this.stop(); return Promise.reject(new Error('Не удалось дослать эфир: нет соединения с площадкой.')) }
    this.finishing = true
    return new Promise((resolve, reject) => {
      this.finishResolve = resolve; this.finishReject = reject
      this.finishTimer = setTimeout(() => this.reconnect('Площадка не подтвердила завершение отправки.'), 10_000)
      this.pump()
    })
  }
  stop(): void {
    this.stopped = true; clearTimeout(this.finishTimer)
    this.finishReject?.(new Error('Отправка остановлена.')); this.finishResolve = undefined; this.finishReject = undefined
    this.closeChild(); this.destination.key = ''
  }
}
