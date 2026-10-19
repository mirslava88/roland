import { mkdtemp, open, readdir, rm, statfs, unlink, type FileHandle } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { performance } from 'perf_hooks'
import { flvPacketFromBytes, type FlvPacket } from './stream-flv'

const PREFIX = 'pdm-stream-delay-'
const SEGMENT_BYTES = 8 * 1024 * 1024
const MAX_PENDING_BYTES = 16 * 1024 * 1024
const DISK_RESERVE = 32 * 1024 * 1024

export async function cleanupAbandonedStreamDelays(): Promise<void> {
  for (const name of await readdir(tmpdir())) {
    const match = /^pdm-stream-delay-(\d+)-/.exec(name)
    if (!match) continue
    try { process.kill(Number(match[1]), 0) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') await rm(join(tmpdir(), name), { recursive: true, force: true })
    }
  }
}

export async function checkStreamDelaySpace(requiredBytes: number): Promise<void> {
  const space = await statfs(tmpdir())
  const available = space.bavail * space.bsize
  if (requiredBytes + DISK_RESERVE > available) {
    const gb = (bytes: number): string => (bytes / 1024 ** 3).toFixed(1)
    throw new Error(`Для задержки нужно примерно ${gb(requiredBytes)} ГБ, свободно ${gb(available)} ГБ. Уменьшите задержку или освободите место.`)
  }
}

// Both tracks and their codec headers share one ordered, disk-backed queue.
// Memory holds at most a small write backlog and one packet being read.
// File numbers replace an in-memory index proportional to the delay length.
export class StreamDelayBuffer {
  private directory: string | null = null
  private initialized: Promise<void>
  private queue: Array<{ packet: FlvPacket; at: number }> = []
  private pendingBytes = 0
  private writer: FileHandle | null = null
  private reader: FileHandle | null = null
  private writeIndex = 0
  private readIndex = 0
  private committed = 0
  private readPosition = 0
  private segmentStarted = 0
  private storedBytes = 0
  private pendingHeader: { due: number; size: number } | null = null
  private writing: Promise<void> | null = null
  private reading: Promise<void> | null = null
  private timer: NodeJS.Timeout
  private spaceTimer: NodeJS.Timeout
  private stopped = false
  private failed = false
  private finishedInput = false
  private draining = false
  private firstAt: number | null = null
  private lastAt = 0
  private finishResolve?: () => void
  private finishReject?: (error: Error) => void
  private cleanup: Promise<void> | null = null

  constructor(private seconds: number, private deliver: (packet: FlvPacket) => void,
    private onError: (message: string) => void, private clock = () => performance.now()) {
    this.initialized = this.initialize()
    void this.initialized.catch(() => this.fail('Не удалось создать буфер задержки на диске.'))
    this.timer = setInterval(() => this.startReading(), 20)
    this.spaceTimer = setInterval(() => {
      void checkStreamDelaySpace(0).catch(() => this.fail('На диске заканчивается место для задержки. Стрим остановлен.'))
    }, 5000)
  }

  private async initialize(): Promise<void> {
    // Clean only abandoned PDM buffers, leaving other running instances alone.
    await cleanupAbandonedStreamDelays()
    this.directory = await mkdtemp(join(tmpdir(), `${PREFIX}${process.pid}-`))
  }

  accept(packet: FlvPacket): void {
    if (this.stopped || this.finishedInput) return
    const at = this.clock()
    if (this.firstAt === null) this.firstAt = at
    this.lastAt = at
    if (this.pendingBytes + packet.bytes.length + 12 > MAX_PENDING_BYTES) {
      this.fail('Диск не успевает записывать буфер задержки. Стрим остановлен.'); return
    }
    this.pendingBytes += packet.bytes.length + 12
    this.queue.push({ packet, at })
    if (!this.writing) {
      this.writing = this.writeLoop().catch(() => this.fail('Не удалось записать буфер задержки. Проверьте свободное место на диске.'))
        .finally(() => { this.writing = null; this.checkFinished() })
    }
  }

  private file(index: number): string { return join(this.directory!, `${index}.buffer`) }

  private async writeLoop(): Promise<void> {
    await this.initialized
    while (!this.stopped && this.queue.length) {
      const { packet, at } = this.queue.shift()!
      if (this.writer && (this.committed >= SEGMENT_BYTES || at - this.segmentStarted >= 10_000)) {
        await this.writer.close(); this.writer = null
        this.writeIndex++; this.committed = 0
      }
      if (!this.writer) {
        this.writer = await open(this.file(this.writeIndex), 'wx', 0o600)
        this.segmentStarted = at
      }
      const header = Buffer.alloc(12)
      header.writeDoubleBE(at + this.seconds * 1000, 0); header.writeUInt32BE(packet.bytes.length, 8)
      const record = Buffer.concat([header, packet.bytes])
      await this.writer.writeFile(record)
      this.committed += record.length; this.storedBytes += record.length
      this.pendingBytes -= record.length
    }
  }

  private startReading(): void {
    if (this.stopped || this.reading) return
    this.reading = this.readLoop().catch(() => this.fail('Не удалось прочитать буфер задержки. Стрим остановлен.'))
      .finally(() => { this.reading = null; this.checkFinished() })
  }

  private async readExact(handle: FileHandle, size: number, position: number): Promise<Buffer> {
    const bytes = Buffer.alloc(size)
    let offset = 0
    while (offset < size) {
      const read = await handle.read(bytes, offset, size - offset, position + offset)
      if (!read.bytesRead) throw new Error('Incomplete delay record')
      offset += read.bytesRead
    }
    return bytes
  }

  private async readLoop(): Promise<void> {
    await this.initialized
    for (let count = 0; count < 200 && !this.stopped; count++) {
      if (!this.reader) {
        if (this.readIndex === this.writeIndex && !this.committed) return
        this.reader = await open(this.file(this.readIndex), 'r')
      }
      const available = this.readIndex < this.writeIndex ? (await this.reader.stat()).size : this.committed
      if (this.readPosition === available && this.readIndex < this.writeIndex) {
        await this.reader.close(); this.reader = null
        await unlink(this.file(this.readIndex))
        this.storedBytes -= available
        this.readIndex++; this.readPosition = 0; this.pendingHeader = null
        continue
      }
      if (available - this.readPosition < 12) return
      if (!this.pendingHeader) {
        const header = await this.readExact(this.reader, 12, this.readPosition)
        this.pendingHeader = { due: header.readDoubleBE(0), size: header.readUInt32BE(8) }
        if (!Number.isFinite(this.pendingHeader.due) || this.pendingHeader.size < 15 || this.pendingHeader.size > 4 * 1024 * 1024 + 15) {
          throw new Error('Invalid delay record')
        }
      }
      const { due, size } = this.pendingHeader
      if (available - this.readPosition < size + 12 || this.clock() < due) return
      if (this.clock() - due > 5000) { this.fail('Чтение буфера задержки отстало от эфира. Проверьте нагрузку на диск.'); return }
      const bytes = await this.readExact(this.reader, size, this.readPosition + 12)
      if (this.stopped) return
      this.deliver(flvPacketFromBytes(bytes))
      this.readPosition += size + 12; this.pendingHeader = null
    }
  }

  snapshot() {
    const now = this.clock()
    return { seconds: this.seconds, storedBytes: Math.max(0, this.storedBytes),
      buffering: this.firstAt === null || now < this.firstAt + this.seconds * 1000,
      remainingMs: this.finishedInput || this.draining ? Math.max(0, this.lastAt + this.seconds * 1000 - now)
        : this.firstAt === null ? this.seconds * 1000 : Math.max(0, this.firstAt + this.seconds * 1000 - now) }
  }

  finish(): Promise<void> {
    this.finishedInput = true
    return new Promise((resolve, reject) => {
      this.finishResolve = resolve; this.finishReject = reject
      this.checkFinished()
    })
  }

  beginDrain(): void { this.draining = true }

  private checkFinished(): void {
    if (this.finishedInput && !this.stopped && !this.writing && !this.queue.length &&
      this.readIndex === this.writeIndex && this.readPosition === this.committed) {
      this.finishResolve?.(); this.finishResolve = undefined; this.finishReject = undefined
    }
  }

  private fail(message: string): void {
    if (this.stopped || this.failed) return
    this.failed = true
    this.onError(message)
    void this.stop()
  }

  stop(): Promise<void> {
    if (this.cleanup) return this.cleanup
    this.stopped = true
    clearInterval(this.timer); clearInterval(this.spaceTimer)
    this.queue = []; this.pendingBytes = 0
    this.finishReject?.(new Error('Отправка буфера отменена.'))
    this.finishResolve = undefined; this.finishReject = undefined
    this.cleanup = (async () => {
      await Promise.allSettled([this.initialized, this.writing, this.reading])
      await Promise.allSettled([this.writer?.close(), this.reader?.close()])
      if (this.directory) await rm(this.directory, { recursive: true, force: true })
      this.writer = null; this.reader = null; this.storedBytes = 0
    })().catch(() => { /* abandoned buffers are retried at the next start */ })
    return this.cleanup
  }
}
