export type DirectStreamDeckActionKind =
  | 'none'
  | 'take-channel'
  | 'play-channel-video'
  | 'previous-slide'
  | 'next-slide'
  | 'toggle-output'
  | 'scene-toggle'
  | 'scene-content'
  | 'scene-participant'
  | 'scene-both'
  | 'titles-speaker'
  | 'titles-event'
  | 'titles-all'
  | 'titles-hide'
  | 'qr-toggle'
  | 'timer-start-pause'
  | 'timer-reset'
  | 'timer-plus-5'
  | 'timer-minus-5'
  | 'music-previous'
  | 'music-play-pause'
  | 'music-stop'
  | 'music-next'

export interface DirectStreamDeckAction {
  kind: DirectStreamDeckActionKind
  channelId?: string
  speakerId?: string
}

export interface DirectStreamDeckConfig {
  enabled: boolean
  serialNumber: string | null
  brightness: number
  mappings: Record<string, DirectStreamDeckAction>
}

export interface DirectStreamDeckDeviceInfo {
  model: string
  path: string
  serialNumber: string | null
  name: string
}

export interface DirectStreamDeckStatus {
  enabled: boolean
  connecting: boolean
  connected: boolean
  deviceName: string | null
  serialNumber: string | null
  keyCount: number
  columns: number
  rows: number
  error: string | null
}

export interface DirectStreamDeckKeyState {
  index: number
  label: string
  color: string
  active?: boolean
  disabled?: boolean
}

export interface DirectStreamDeckCommand {
  keyIndex: number
  action: DirectStreamDeckAction
}

export const DIRECT_STREAM_DECK_STORAGE_KEY = 'pdm-direct-stream-deck-v1'
export const DIRECT_STREAM_DECK_CONFIG_EVENT = 'pdm-direct-stream-deck-config-changed'

export function escapeDirectStreamDeckXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
  })[character] || character)
}

export function normalizeDirectStreamDeckColor(value: string, fallback = '#17212b'): string {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback
}

export function splitDirectStreamDeckLabel(label: string): string[] {
  const clean = label.replace(/\s+/g, ' ').trim()
  if (!clean) return []
  const words = clean.split(' ')
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word
    if (candidate.length <= 10 || !line) line = candidate
    else {
      lines.push(line)
      line = word
    }
  }
  if (line) lines.push(line)
  return lines.slice(0, 3).map((entry, index, entries) => (
    index === entries.length - 1 && lines.length > 3 ? `${entry.slice(0, 8).trimEnd()}…` : entry
  ))
}

export function normalizeDirectStreamDeckKeyStates(states: DirectStreamDeckKeyState[]): DirectStreamDeckKeyState[] {
  return states
    .filter((state) => Number.isInteger(state.index) && state.index >= 0)
    .slice(0, 256)
    .map((state) => ({
      index: state.index,
      label: String(state.label || '').slice(0, 60),
      color: normalizeDirectStreamDeckColor(String(state.color || '')),
      active: state.active === true,
      disabled: state.disabled === true
    }))
}

export const DIRECT_STREAM_DECK_ACTION_LABELS: Record<DirectStreamDeckActionKind, string> = {
  none: 'Нет действия',
  'take-channel': 'Вывести канал',
  'play-channel-video': 'Запустить видео из канала',
  'previous-slide': 'Предыдущий слайд',
  'next-slide': 'Следующий слайд',
  'toggle-output': 'В эфир / выйти',
  'scene-toggle': 'Сцена: показать / выйти',
  'scene-content': 'Сцена: только презентация',
  'scene-participant': 'Сцена: только участник',
  'scene-both': 'Сцена: участник + презентация',
  'titles-speaker': 'Титр: выступающий',
  'titles-event': 'Титр: мероприятие',
  'titles-all': 'Титры: показать всё',
  'titles-hide': 'Титры: скрыть',
  'qr-toggle': 'Показать / скрыть QR',
  'timer-start-pause': 'Таймер: старт / пауза',
  'timer-reset': 'Таймер: сброс',
  'timer-plus-5': 'Таймер: +5 минут',
  'timer-minus-5': 'Таймер: −5 минут',
  'music-previous': 'Музыка: предыдущая',
  'music-play-pause': 'Музыка: старт / пауза',
  'music-stop': 'Музыка: стоп',
  'music-next': 'Музыка: следующая'
}

export const DIRECT_STREAM_DECK_ACTIONS = Object.keys(
  DIRECT_STREAM_DECK_ACTION_LABELS
) as DirectStreamDeckActionKind[]

export function createDefaultDirectStreamDeckConfig(): DirectStreamDeckConfig {
  const mappings: Record<string, DirectStreamDeckAction> = {}
  for (let index = 0; index < 16; index++) {
    mappings[String(index)] = { kind: 'take-channel', channelId: String(index + 1) }
  }
  const actions: DirectStreamDeckActionKind[] = [
    'previous-slide', 'next-slide', 'toggle-output', 'titles-speaker',
    'titles-event', 'titles-all', 'titles-hide', 'qr-toggle',
    'music-previous', 'music-play-pause', 'music-stop', 'music-next',
    'timer-minus-5', 'timer-start-pause', 'timer-plus-5', 'timer-reset'
  ]
  actions.forEach((kind, offset) => { mappings[String(16 + offset)] = { kind } })
  // Direct USB is the primary PDM integration: on a fresh profile an attached
  // Stream Deck should light up without requiring a hidden first-time toggle.
  // An explicit user choice is still persisted and can disable it afterwards.
  return { enabled: true, serialNumber: null, brightness: 70, mappings }
}

function isActionKind(value: unknown): value is DirectStreamDeckActionKind {
  return typeof value === 'string' && value in DIRECT_STREAM_DECK_ACTION_LABELS
}

export function normalizeDirectStreamDeckConfig(value: unknown): DirectStreamDeckConfig {
  const fallback = createDefaultDirectStreamDeckConfig()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback
  const raw = value as Partial<DirectStreamDeckConfig>
  const mappings: Record<string, DirectStreamDeckAction> = { ...fallback.mappings }
  if (raw.mappings && typeof raw.mappings === 'object' && !Array.isArray(raw.mappings)) {
    for (const [key, action] of Object.entries(raw.mappings)) {
      const index = Number(key)
      if (!Number.isInteger(index) || index < 0 || index > 255 || !action || typeof action !== 'object') continue
      const candidate = action as Partial<DirectStreamDeckAction>
      if (!isActionKind(candidate.kind)) continue
      mappings[String(index)] = {
        kind: candidate.kind,
        ...((candidate.kind === 'take-channel' || candidate.kind === 'play-channel-video') &&
          typeof candidate.channelId === 'string'
          ? { channelId: candidate.channelId.slice(0, 80) }
          : {}),
        ...((candidate.kind === 'titles-speaker' || candidate.kind === 'titles-all') &&
          typeof candidate.speakerId === 'string'
          ? { speakerId: candidate.speakerId.slice(0, 80) }
          : {})
      }
    }
  }
  return {
    enabled: raw.enabled === true,
    serialNumber: typeof raw.serialNumber === 'string' && raw.serialNumber.trim()
      ? raw.serialNumber.trim().slice(0, 120)
      : null,
    brightness: Math.max(10, Math.min(100, Math.round(Number(raw.brightness) || fallback.brightness))),
    mappings
  }
}
