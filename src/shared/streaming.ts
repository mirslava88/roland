export type StreamAudio = 'system' | 'microphone' | 'both' | 'none'
export type StreamEncoder = 'auto' | 'software' | 'h264_nvenc' | 'h264_qsv' | 'h264_amf' | 'h264_videotoolbox'
export interface StreamDestination {
  id: string
  name: string
  enabled: boolean
  server: string
  key: string
}
export interface StreamSettings {
  resolution: 720 | 1080
  fps: 25 | 30 | 50 | 60
  bitrateKbps: number
  encoder: StreamEncoder
  audio: StreamAudio
  microphoneId: string
  destinations: StreamDestination[]
  delaySeconds?: number
  drainOnStop?: boolean
}
export interface StreamStatus {
  phase: 'idle' | 'starting' | 'running' | 'draining' | 'error'
  error?: string
  startedAt: number | null
  encoder: string
  fps: number
  bitrateKbps: number
  droppedFrames: number
  encoderLagMs: number
  source?: 'display' | 'internal'
  delay?: { seconds: number; remainingMs: number; storedBytes: number; buffering: boolean }
  destinations: Array<{ id: string; name: string; phase: 'connecting' | 'live' | 'reconnecting'; retries: number; error?: string;
    bitrateKbps: number; bufferedMs: number; droppedFrames: number }>
}
export interface StreamCaptureSettings {
  resolution: 720 | 1080
  fps: number
  bitrateKbps: number
  audio: StreamAudio
  microphoneId: string
}
export interface StreamingApi {
  load(): Promise<{ settings: StreamSettings; canSave: boolean; available: boolean; warning?: string }>
  save(settings: StreamSettings): Promise<void>
  devices(): Promise<Array<{ id: string; label: string }>>
  check(settings: StreamSettings): Promise<Array<{ name: string; reachable: boolean }>>
  start(settings: StreamSettings, displayId: number | null): Promise<void>
  stop(immediate?: boolean): Promise<void>
  status(): Promise<StreamStatus>
}
export const DEFAULT_STREAM_SETTINGS: StreamSettings = {
  resolution: 1080, fps: 30, bitrateKbps: 6000, encoder: 'auto',
  audio: 'system', microphoneId: '', delaySeconds: 0, drainOnStop: true,
  destinations: [{ id: 'telegram', name: 'Telegram', enabled: true, server: '', key: '' }]
}

// Runtime validation is also used in main; renderer input is never trusted.
export function validateStreamSettings(value: StreamSettings, requireDestination = true): StreamSettings {
  const delaySeconds = value?.delaySeconds === undefined ? 0 : value.delaySeconds
  const drainOnStop = value?.drainOnStop === undefined ? true : value.drainOnStop
  if (typeof drainOnStop !== 'boolean') throw new Error('Проверьте поведение при остановке стрима.')
  if (!Number.isSafeInteger(delaySeconds) || delaySeconds < 0 || !Number.isSafeInteger(delaySeconds * 1000)) {
    throw new Error('Задержка должна быть целым неотрицательным числом секунд.')
  }
  if (!value || ![720, 1080].includes(value.resolution) || ![25, 30, 50, 60].includes(value.fps) ||
    !Number.isInteger(value.bitrateKbps) || value.bitrateKbps < 500 || value.bitrateKbps > 20000 ||
    !['auto', 'software', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_videotoolbox'].includes(value.encoder) ||
    !['system', 'microphone', 'both', 'none'].includes(value.audio) ||
    typeof value.microphoneId !== 'string' || value.microphoneId.length > 1024 ||
    !Array.isArray(value.destinations) || value.destinations.length > 5) {
    throw new Error('Проверьте настройки качества и звука.')
  }
  const ids = new Set<string>()
  const destinations = value.destinations.map((d) => {
    if (!d || typeof d.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(d.id) || ids.has(d.id) ||
      typeof d.name !== 'string' || d.name.length > 80 || typeof d.enabled !== 'boolean' ||
      typeof d.server !== 'string' || d.server.length > 2048 || typeof d.key !== 'string' || d.key.length > 2048) {
      throw new Error('Некорректные настройки площадки.')
    }
    ids.add(d.id)
    const result = { id: d.id, name: d.name.trim() || 'Площадка', enabled: d.enabled, server: d.server.trim(), key: d.key.trim() }
    if (result.server || (requireDestination && result.enabled)) streamDestinationUrl(result)
    return result
  })
  if (requireDestination && !destinations.some((d) => d.enabled)) throw new Error('Выберите хотя бы одну площадку.')
  return { resolution: value.resolution, fps: value.fps, bitrateKbps: value.bitrateKbps,
    encoder: value.encoder, audio: value.audio, microphoneId: value.microphoneId, destinations, delaySeconds, drainOnStop }
}

export function streamDelayStorageBytes(seconds: number, bitrateKbps: number): number {
  return Math.ceil(seconds * ((bitrateKbps + 160) * 125 + 2400) * 1.15)
}

export function formatStreamDuration(seconds: number): string {
  const value = Math.max(0, Math.ceil(seconds))
  return `${Math.floor(value / 3600)}:${String(Math.floor(value / 60) % 60).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
}

export function streamDestinationUrl(d: StreamDestination): string {
  const raw = d.key ? `${d.server.replace(/\/+$/, '')}/${d.key}` : d.server
  try {
    const url = new URL(raw)
    if (!['rtmp:', 'rtmps:'].includes(url.protocol) || !url.hostname || url.hash || /[\s\x00-\x1f]/.test(raw)) throw new Error()
    return raw
  } catch { throw new Error('Нужен адрес сервера rtmp:// или rtmps:// и корректный ключ потока.') }
}
