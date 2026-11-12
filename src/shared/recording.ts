import type { StreamAudio } from './streaming'
import type { RecordingClip } from './recording-timeline'

export interface RecordingSettings {
  format: 'lossless-mkv' | 'quality-mp4'
  fps: 25 | 30 | 50 | 60
  audio: StreamAudio
  microphoneId: string
}

export interface RecordingStatus {
  phase: 'idle' | 'starting' | 'running' | 'stopping' | 'error'
  startedAt: number | null
  path?: string
  error?: string
  source?: 'display' | 'internal'
  frames: number
  fps: number
  droppedFrames: number
  sizeBytes: number
}

export interface RecordingApi {
  load(): Promise<RecordingSettings>
  save(settings: RecordingSettings): Promise<void>
  devices(): Promise<Array<{ id: string; label: string }>>
  start(settings: RecordingSettings, displayId: number | null): Promise<boolean>
  stop(): Promise<void>
  status(): Promise<RecordingStatus>
  editOpen(useLast?: boolean): Promise<RecordingEditSource | null>
  editFrame(time: number): Promise<string>
  editThumbnails(): Promise<string[]>
  editTimelineFrames(times: number[]): Promise<string[]>
  editWaveform(): Promise<string | null>
  editWaveformWindows(windows: RecordingWaveformWindow[]): Promise<(string | null)[]>
  editTimelineCancel(): Promise<void>
  editExport(options: RecordingEditOptions): Promise<RecordingEditStatus>
  editStatus(): Promise<RecordingEditStatus>
  editCancel(): Promise<void>
}

export interface RecordingEditSource {
  path: string
  duration: number
  hasAudio: boolean
  format: 'mkv' | 'mp4'
  frameRate: number
}

export interface RecordingWaveformWindow {
  start: number
  end: number
  width: number
}

export interface RecordingEditOptions {
  mode: 'fragment' | 'separate' | 'timeline'
  start: number
  end: number
  format: RecordingSettings['format']
  clips?: RecordingClip[]
}

export interface RecordingEditStatus {
  phase: 'idle' | 'running' | 'done' | 'error'
  progress: number
  outputs: string[]
  message?: string
}

export const DEFAULT_RECORDING_SETTINGS: RecordingSettings = {
  format: 'quality-mp4', fps: 30, audio: 'system', microphoneId: ''
}

export function validateRecordingSettings(value: RecordingSettings): RecordingSettings {
  if (!value || !['lossless-mkv', 'quality-mp4'].includes(value.format) ||
    ![25, 30, 50, 60].includes(value.fps) ||
    !['system', 'microphone', 'both', 'none'].includes(value.audio) ||
    typeof value.microphoneId !== 'string' || value.microphoneId.length > 1024) {
    throw new Error('Проверьте настройки записи и звука.')
  }
  return { format: value.format, fps: value.fps, audio: value.audio, microphoneId: value.microphoneId }
}
