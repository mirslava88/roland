import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { performance } from 'perf_hooks'
import { streamDestinationUrl, type StreamDestination } from '../shared/streaming'
import { FLV_HEADER, rebaseFlvPacket, type FlvPacket } from './stream-flv'
import { progressReader, publisherErrorMessage } from './streaming-engine'

// Independent copy-only sender. Limit by MEDIA AGE as well as bytes: a static
// slide can compress a minute of video into less than a megabyte.
const MAX_QUEUE_MS = 1200
const MAX_QUEUE_BYTES = 2 * 1024 * 1024
export class StreamPublisher {
  private child: ChildProcessWithoutNullStreams | null = null
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
  constructor(private path: string, private destination: StreamDestination) {}

  accept(packet: FlvPacket, headers: FlvPacket[]): void {
    if (this.stopped || packet.configuration || packet.type === 18) return
    this.latest = Math.max(this.latest, packet.timestamp)
    if (!this.child) {
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
    this.origin = origin; this.sentTime = origin; this.sentBytes = 0
    this.lagSince = 0
    this.started = this.lastProgress = performance.now()
    const url = streamDestinationUrl(this.destination)
    const child = spawn(this.path, ['-hide_banner', '-loglevel', 'error', '-nostdin',
      '-probesize', '8192', '-analyzeduration', '0', '-f', 'flv', '-i', 'pipe:0',
      '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-flush_packets', '1', '-flvflags', 'no_duration_filesize',
      '-progress', 'pipe:1', '-stats_period', '0.25', '-rw_timeout', '4000000',
      ...(this.destination.server.startsWith('rtmps:') ? ['-tls_verify', '1'] : []), '-f', 'flv', url],
    { windowsHide: true, stdio: 'pipe' })
    this.child = child
    const failed = (): void => { if (this.child === child) this.reconnect(this.error || 'Соединение с площадкой прервано. Выполняется переподключение.') }
    child.on('error', failed); child.on('exit', failed); child.stdin.on('error', failed)
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
      if (message) this.error = message // fixed text only; never expose an RTMP URL
      const end = tail.lastIndexOf('\n'); if (end >= 0) tail = tail.slice(end + 1)
    })
    child.stdin.write(Buffer.concat([FLV_HEADER, ...headers.map(p => rebaseFlvPacket(p, origin))]))
  }

  private pump(): void {
    const child = this.child
    if (!child || this.writing || !this.queue.length) return
    const packet = this.queue.shift()!; this.bytes -= packet.bytes.length
    this.writing = true
    child.stdin.write(rebaseFlvPacket(packet, this.origin), error => {
      if (this.child !== child) return
      this.writing = false
      if (error) this.reconnect('Соединение с площадкой прервано.')
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
      this.reconnect(this.error || 'Отправка отстала от эфира. Подключение перезапущено с текущего кадра.')
    }
  }
  private reconnect(message: string): void {
    if (this.stopped) return
    this.dropped += this.queue.filter(p => p.type === 9).length
    this.closeChild(); this.retries++; this.phase = 'reconnecting'; this.error = message
    this.retryAt = performance.now() + 1000
  }
  private closeChild(): void {
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
  stop(): void { this.stopped = true; this.closeChild(); this.destination.key = '' }
}
