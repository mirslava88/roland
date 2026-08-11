import { warmPdfiumDocument } from './pdfium-renderer'
import {
  channelIdFromIndex,
  DEFAULT_BROADCAST_TITLES,
  DEFAULT_BROADCAST_TITLES_OUTPUT,
  DEFAULT_EVENT_TIMER_STATE,
  useAppStore,
  type ChannelGridSize,
  type ChannelId,
  type ChannelState,
  type BroadcastTitlesDraft,
  type BroadcastTitleEffect,
  type BroadcastTitlePosition,
  type BroadcastTitleStyle,
  type DisplayAssignments,
  type DisplayOutputMode,
  type EventTimerState,
  type FilterType,
  type InformationMediaConfig
} from './stores/useAppStore'

const CONFIG_FORMAT = 'pdm-configuration'
const CONFIG_SCHEMA_VERSION = 1
const MAX_CHANNELS = 360
const MAX_PLAYLIST_ITEMS = 1000
const MAX_SLIDE_POSITIONS = 1000

type ConfigResult = {
  canceled: boolean
  path?: string
  error?: string
  warnings: string[]
}

type AudioDeviceInfo = { id: string; name: string; isDefault: boolean }
type ValidatedPath = { path: string; exists: boolean; isDirectory: boolean }

interface SavedDisplayOutput {
  id: number
  label: string
  customName: string
  width: number
  height: number
  x: number
  y: number
  scaleFactor: number
  mode: DisplayOutputMode
  isMainProgram: boolean
  order: number
}

interface PdmConfigV1 {
  format: typeof CONFIG_FORMAT
  schemaVersion: typeof CONFIG_SCHEMA_VERSION
  createdAt: string
  library: {
    folderPath: string | null
    rootFolderPath: string | null
    filter: FilterType
  }
  channels: {
    gridSize: ChannelGridSize
    currentPage: number
    selectedChannel: ChannelId | null
    items: Array<{
      id: ChannelId
      file: FileEntry | null
      slide: number
      totalSlides: number
      videoEndChannel: ChannelId | null
      caption: string
    }>
  }
  displays: SavedDisplayOutput[]
  backdropImage: string | null
  informationMedia: InformationMediaConfig | null
  captureSources: FileEntry[]
  slidePositions: Record<string, number>
  input: {
    globalHookEnabled: boolean
    channelBoundaryNavigationEnabled: boolean
  }
  audio: {
    outputDeviceId: string | null
  }
  music: {
    playlist: string[]
    currentIndex: number
    currentTime: number
    volume: number
    loopTrack: boolean
    loopPlaylist: boolean
  }
  video: {
    playlist: string[]
    currentIndex: number
    loopTrack: boolean
    loopPlaylist: boolean
    playback: Record<string, { currentTime: number; duration: number; playing: false }>
  }
  timer: {
    duration: number
    remaining: number
    soundEnd: string | null
    soundWarning: string | null
    overlayPosition: { x: number; y: number }
    overlayScale: number
    textColor: string
    warningTextColor: string
    overtimeTextColor: string
    textOpacity: number
  }
  eventTimer: EventTimerState
  broadcastTitles: BroadcastTitlesDraft
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function safeString(value: unknown, maxLength = 32768): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || value.includes('\0')) return null
  return value
}

function safeNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback
}

function safeInteger(value: unknown, fallback: number, min: number, max: number): number {
  return Math.round(safeNumber(value, fallback, min, max))
}

function safeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function safeColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback
}

function safeCapture(value: unknown): CaptureSourceConfig | null {
  if (!isRecord(value)) return null
  const sourceId = safeString(value.sourceId, 256)
  const videoLabel = safeString(value.videoLabel, 512)
  const videoDeviceId = safeString(value.videoDeviceId, 2048)
  if (!sourceId || !videoLabel || !videoDeviceId) return null
  // Desktop/window source identifiers are tied to a particular running Windows
  // session and must never be replayed from a saved configuration.
  if (value.captureKind === 'desktop') return null
  return {
    sourceId,
    captureKind: 'device',
    videoDeviceId,
    videoLabel,
    videoGroupId: safeString(value.videoGroupId, 2048) || undefined,
    audioEnabled: safeBoolean(value.audioEnabled, false),
    audioDeviceId: safeString(value.audioDeviceId, 2048) || undefined,
    audioGroupId: safeString(value.audioGroupId, 2048) || undefined,
    audioLabel: safeString(value.audioLabel, 512) || undefined
  }
}

function safeFileEntry(value: unknown): FileEntry | null {
  if (!isRecord(value)) return null
  const type = value.type
  if (!['presentation', 'pdf', 'video', 'capture', 'other', 'unknown'].includes(String(type))) return null
  let capture: CaptureSourceConfig | undefined
  if (type === 'capture') {
    const parsedCapture = safeCapture(value.capture)
    if (!parsedCapture) return null
    capture = parsedCapture
  }
  const path = safeString(value.path)
  const name = safeString(value.name, 1024)
  if (!path || !name) return null
  return {
    id: safeString(value.id, 1024) || path,
    name,
    path,
    type: type as FileEntry['type'],
    extension: safeString(value.extension, 64) || '',
    size: safeNumber(value.size, 0, 0, Number.MAX_SAFE_INTEGER),
    isImage: value.isImage === true || undefined,
    isAudio: value.isAudio === true || undefined,
    capture
  }
}

function serializableCapture(value: CaptureSourceConfig | undefined): CaptureSourceConfig | undefined {
  if (!value || value.captureKind === 'desktop') return undefined
  return {
    sourceId: value.sourceId,
    captureKind: 'device',
    videoDeviceId: value.videoDeviceId,
    videoLabel: value.videoLabel,
    videoGroupId: value.videoGroupId,
    audioEnabled: value.audioEnabled,
    audioDeviceId: value.audioDeviceId,
    audioGroupId: value.audioGroupId,
    audioLabel: value.audioLabel
  }
}

function serializableFile(file: FileEntry | null): FileEntry | null {
  if (!file) return null
  if (file.type === 'capture') {
    const capture = serializableCapture(file.capture)
    if (!capture) return null
    return { ...file, capture }
  }
  return { ...file, capture: undefined }
}

function serializableInformationMedia(media: InformationMediaConfig | null): InformationMediaConfig | null {
  if (!media) return null
  if (media.type === 'capture') {
    const capture = serializableCapture(media.capture)
    if (!capture) return null
    return { ...media, capture, slideImages: [], playing: false, seekRevision: 0 }
  }
  return { ...media, slideImages: [], playing: false, seekRevision: 0 }
}

function collectConfigPaths(raw: Record<string, unknown>): string[] {
  const paths = new Set<string>()
  const addFile = (value: unknown): void => {
    const file = safeFileEntry(value)
    if (file && file.type !== 'capture') paths.add(file.path)
  }
  const addPath = (value: unknown): void => {
    const path = safeString(value)
    if (path) paths.add(path)
  }

  const library = isRecord(raw.library) ? raw.library : {}
  addPath(library.folderPath)
  addPath(library.rootFolderPath)

  const channels = isRecord(raw.channels) ? raw.channels : {}
  const items = Array.isArray(channels.items) ? channels.items.slice(0, MAX_CHANNELS) : []
  for (const item of items) {
    if (isRecord(item)) addFile(item.file)
  }

  const captureSources = Array.isArray(raw.captureSources) ? raw.captureSources.slice(0, MAX_CHANNELS) : []
  for (const item of captureSources) addFile(item)

  const media = isRecord(raw.informationMedia) ? raw.informationMedia : null
  if (media && media.type !== 'capture') addPath(media.path)
  addPath(raw.backdropImage)

  const slidePositions = isRecord(raw.slidePositions) ? Object.keys(raw.slidePositions).slice(0, MAX_SLIDE_POSITIONS) : []
  for (const path of slidePositions) addPath(path)

  const music = isRecord(raw.music) ? raw.music : {}
  const video = isRecord(raw.video) ? raw.video : {}
  for (const path of Array.isArray(music.playlist) ? music.playlist.slice(0, MAX_PLAYLIST_ITEMS) : []) addPath(path)
  for (const path of Array.isArray(video.playlist) ? video.playlist.slice(0, MAX_PLAYLIST_ITEMS) : []) addPath(path)
  const videoPlayback = isRecord(video.playback) ? Object.keys(video.playback).slice(0, MAX_PLAYLIST_ITEMS) : []
  for (const path of videoPlayback) addPath(path)

  const timer = isRecord(raw.timer) ? raw.timer : {}
  addPath(timer.soundEnd)
  addPath(timer.soundWarning)
  const eventTimer = isRecord(raw.eventTimer) ? raw.eventTimer : {}
  addPath(eventTimer.backgroundImage)
  return [...paths]
}

function matchDisplays(savedDisplays: SavedDisplayOutput[]): {
  assignments: DisplayAssignments
  displayNames: Record<string, string>
  selectedDisplayId: number | null
  warnings: string[]
} {
  const state = useAppStore.getState()
  const current = state.displays
    .filter((display) => !display.isPrimary)
    .sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y)
  const used = new Set<number>()
  const assignments: DisplayAssignments = {}
  const displayNames: Record<string, string> = {}
  const matches = new Map<number, number>()
  const warnings: string[] = []

  const selectCandidate = (saved: SavedDisplayOutput): DisplayInfo | null => {
    const exact = current.find((display) => display.id === saved.id && !used.has(display.id))
    if (exact) return exact

    const byLabelAndSize = current.filter((display) => (
      !used.has(display.id) &&
      display.label === saved.label &&
      display.bounds.width === saved.width &&
      display.bounds.height === saved.height
    ))
    if (byLabelAndSize.length === 1) return byLabelAndSize[0]

    const bySize = current.filter((display) => (
      !used.has(display.id) &&
      display.bounds.width === saved.width &&
      display.bounds.height === saved.height &&
      Math.abs(display.scaleFactor - saved.scaleFactor) < 0.01
    ))
    if (bySize.length === 1) return bySize[0]

    if (savedDisplays.length === current.length) {
      const atSamePosition = current[saved.order]
      if (
        atSamePosition && !used.has(atSamePosition.id) &&
        atSamePosition.bounds.width === saved.width &&
        atSamePosition.bounds.height === saved.height
      ) return atSamePosition
    }
    return null
  }

  for (const saved of savedDisplays.sort((a, b) => a.order - b.order)) {
    const target = selectCandidate(saved)
    if (!target) {
      warnings.push(`Не найден монитор «${saved.label}» ${saved.width}×${saved.height}; его назначение пропущено.`)
      continue
    }
    used.add(target.id)
    matches.set(saved.id, target.id)
    assignments[String(target.id)] = saved.mode
    if (saved.customName) displayNames[String(target.id)] = saved.customName
  }

  if (matches.size === 0 && savedDisplays.length > 0) {
    return {
      assignments: state.displayAssignments,
      displayNames: state.displayNames,
      selectedDisplayId: state.selectedDisplayId,
      warnings: [...warnings, 'Назначения экранов оставлены текущими: безопасных совпадений не найдено.']
    }
  }

  for (const display of current) {
    if (!(String(display.id) in assignments)) assignments[String(display.id)] = 'off'
  }
  const savedMain = savedDisplays.find((display) => display.isMainProgram && display.mode === 'program')
  const selectedDisplayId = savedMain ? matches.get(savedMain.id) ?? null : null
  const firstProgram = current.find((display) => assignments[String(display.id)] === 'program')?.id ?? null
  return { assignments, displayNames, selectedDisplayId: selectedDisplayId ?? firstProgram, warnings }
}

function parseDisplayOutputs(value: unknown): SavedDisplayOutput[] {
  if (!Array.isArray(value)) return []
  const outputs: SavedDisplayOutput[] = []
  for (const [index, item] of value.slice(0, 32).entries()) {
    if (!isRecord(item)) continue
    const id = safeInteger(item.id, Number.NaN, -2147483648, 2147483647)
    const mode = String(item.mode)
    if (!Number.isFinite(id) || !['off', 'program', 'speaker', 'information', 'timer', 'event-timer'].includes(mode)) continue
    outputs.push({
      id,
      label: safeString(item.label, 512) || `Монитор ${index + 1}`,
      customName: safeString(item.customName, 80) || '',
      width: safeInteger(item.width, 0, 0, 32768),
      height: safeInteger(item.height, 0, 0, 32768),
      x: safeInteger(item.x, 0, -100000, 100000),
      y: safeInteger(item.y, 0, -100000, 100000),
      scaleFactor: safeNumber(item.scaleFactor, 1, 0.25, 8),
      mode: mode as DisplayOutputMode,
      isMainProgram: item.isMainProgram === true,
      order: safeInteger(item.order, index, 0, 31)
    })
  }
  return outputs
}

function pathExists(path: string | null, validation: Map<string, { exists: boolean; isDirectory: boolean }>, directory = false): boolean {
  if (!path) return false
  const result = validation.get(path)
  return !!result?.exists && (directory ? result.isDirectory : !result.isDirectory)
}

function warnMissing(warnings: string[], description: string, path: string): void {
  warnings.push(`${description} пропущен: файл не найден — ${path}`)
}

async function restoreInformationMedia(
  value: unknown,
  validation: Map<string, { exists: boolean; isDirectory: boolean }>,
  warnings: string[]
): Promise<InformationMediaConfig | null> {
  if (!isRecord(value)) return null
  const type = String(value.type)
  if (!['presentation', 'pdf', 'video', 'image', 'capture'].includes(type)) return null
  if (type === 'capture') {
    const capture = safeCapture(value.capture)
    if (!capture) {
      warnings.push('Контент информационного экрана пропущен: окно/экран или устройство захвата больше недоступно.')
      return null
    }
    return {
      type: 'capture',
      path: `capture://${capture.sourceId}`,
      name: safeString(value.name, 1024) || capture.videoLabel,
      currentSlide: 1,
      totalSlides: 1,
      slideImages: [],
      playing: true,
      capture
    }
  }

  const path = safeString(value.path)
  if (!path || !pathExists(path, validation)) {
    if (path) warnMissing(warnings, 'Контент информационного экрана', path)
    return null
  }
  const name = safeString(value.name, 1024) || path.split(/[\\/]/).pop() || path
  let totalSlides = type === 'image' ? 1 : 0
  let slideImages: string[] = []
  try {
    if (type === 'presentation') {
      const result = await window.api.generatePptxSlides(path, 1920, 1080)
      if (!result.success || !result.slides?.length) throw new Error(result.error || 'нет подготовленных слайдов')
      slideImages = result.slides
      totalSlides = result.slideCount || result.slides.length
    } else if (type === 'pdf') {
      const data = await window.api.readFile(path)
      totalSlides = await warmPdfiumDocument(path, 'background', data.slice(0))
    }
  } catch (error) {
    warnings.push(`Контент информационного экрана «${name}» не удалось подготовить: ${String(error)}`)
    return null
  }
  const currentSlide = safeInteger(value.currentSlide, 1, 1, Math.max(1, totalSlides))
  return {
    type: type as InformationMediaConfig['type'],
    path,
    name,
    currentSlide,
    totalSlides,
    slideImages,
    playing: false,
    currentTime: type === 'video' ? safeNumber(value.currentTime, 0, 0, 30 * 24 * 60 * 60) : 0,
    duration: type === 'video' ? safeNumber(value.duration, 0, 0, 30 * 24 * 60 * 60) : 0,
    seekRevision: 0,
    loop: type === 'video' ? safeBoolean(value.loop, false) : false
  }
}

export async function saveCurrentAppConfig(): Promise<ConfigResult> {
  const state = useAppStore.getState()
  const warnings: string[] = []
  const hasDesktopCapture = state.captureSources.some((file) => file.capture?.captureKind === 'desktop') ||
    state.channelIds.some((id) => state.channels[id]?.file?.capture?.captureKind === 'desktop') ||
    state.informationMedia?.capture?.captureKind === 'desktop'
  if (hasDesktopCapture) {
    warnings.push('Захват окон и экранов не сохранён: после загрузки эти источники нужно выбрать заново.')
  }
  const devices: AudioDeviceInfo[] = await window.api.getAudioDevices().catch(() => [])
  const musicState: MusicState | null = await window.api.musicGetState().catch(() => null)
  const outputDeviceId = devices.find((device) => device.isDefault)?.id || null
  const externalDisplays = state.displays
    .filter((display) => !display.isPrimary)
    .sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y)

  const captureSources = state.captureSources
    .map(serializableFile)
    .filter((file): file is FileEntry => !!file)
  const slidePositions = Object.fromEntries(
    Object.entries(state.slidePositions)
      .filter(([path, slide]) => !!safeString(path) && Number.isFinite(slide))
      .slice(0, MAX_SLIDE_POSITIONS)
      .map(([path, slide]) => [path, safeInteger(slide, 1, 1, 100000)])
  )
  const videoPlayback = Object.fromEntries(
    Object.entries(state.videoPlayback)
      .filter(([path, playback]) => !!safeString(path) && Number.isFinite(playback.currentTime))
      .slice(0, MAX_PLAYLIST_ITEMS)
      .map(([path, playback]) => [path, {
        currentTime: safeNumber(playback.currentTime, 0, 0, 30 * 24 * 60 * 60),
        duration: safeNumber(playback.duration, 0, 0, 30 * 24 * 60 * 60),
        playing: false as const
      }])
  )

  const config: PdmConfigV1 = {
    format: CONFIG_FORMAT,
    schemaVersion: CONFIG_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    library: {
      folderPath: state.folderPath,
      rootFolderPath: state.rootFolderPath,
      filter: state.filter
    },
    channels: {
      gridSize: state.channelGridSize,
      currentPage: state.currentChannelPage,
      selectedChannel: state.selectedChannel,
      items: state.channelIds.slice(0, MAX_CHANNELS).map((id) => ({
        id,
        file: serializableFile(state.channels[id]?.file || null),
        slide: state.channels[id]?.slide || 1,
        totalSlides: state.channels[id]?.totalSlides || 0,
        videoEndChannel: state.channels[id]?.videoEndChannel || null,
        caption: state.channels[id]?.caption || ''
      }))
    },
    displays: externalDisplays.map((display, order) => ({
      id: display.id,
      label: display.label,
      customName: state.displayNames[String(display.id)] || '',
      width: display.bounds.width,
      height: display.bounds.height,
      x: display.bounds.x,
      y: display.bounds.y,
      scaleFactor: display.scaleFactor,
      mode: state.displayAssignments[String(display.id)] || 'off',
      isMainProgram: display.id === state.selectedDisplayId,
      order
    })),
    backdropImage: state.backdropImage,
    informationMedia: serializableInformationMedia(state.informationMedia),
    captureSources,
    slidePositions,
    input: {
      globalHookEnabled: state.globalHookEnabled,
      channelBoundaryNavigationEnabled: state.channelBoundaryNavigationEnabled
    },
    audio: { outputDeviceId },
    music: {
      playlist: state.musicPlaylist.slice(0, MAX_PLAYLIST_ITEMS),
      currentIndex: musicState?.currentIndex ?? 0,
      currentTime: musicState?.currentTime ?? 0,
      volume: musicState?.volume ?? 1,
      loopTrack: musicState?.loopTrack ?? false,
      loopPlaylist: musicState?.loopPlaylist ?? true
    },
    video: {
      playlist: state.videoPlaylist.slice(0, MAX_PLAYLIST_ITEMS),
      currentIndex: state.videoCurrentIndex,
      loopTrack: state.videoLoopTrack,
      loopPlaylist: state.videoLoopPlaylist,
      playback: videoPlayback
    },
    timer: {
      duration: state.timerDuration,
      remaining: state.timerRemaining,
      soundEnd: state.timerSoundEnd,
      soundWarning: state.timerSoundWarning,
      overlayPosition: state.timerOverlayPosition,
      overlayScale: state.timerOverlayScale,
      textColor: state.timerTextColor,
      warningTextColor: state.timerWarningTextColor,
      overtimeTextColor: state.timerOvertimeTextColor,
      textOpacity: state.timerTextOpacity
    },
    eventTimer: {
      ...state.eventTimer,
      headings: { ...state.eventTimer.headings },
      visibility: { ...state.eventTimer.visibility },
      running: false,
      live: false
    },
    broadcastTitles: {
      ...state.broadcastTitles,
      speakers: state.broadcastTitles.speakers.map((speaker) => ({ ...speaker }))
    }
  }

  const result = await window.api.saveAppConfig(JSON.stringify(config, null, 2))
  return {
    canceled: result.canceled,
    path: result.path,
    error: result.success || result.canceled ? undefined : result.error || 'Не удалось сохранить конфигурацию.',
    warnings
  }
}

export async function loadAppConfigFromFile(): Promise<ConfigResult> {
  const before = useAppStore.getState()
  if (before.activeFile || before.liveChannel) {
    return {
      canceled: false,
      error: 'Перед загрузкой конфигурации выйдите из эфира.',
      warnings: []
    }
  }

  const opened = await window.api.loadAppConfig()
  if (opened.canceled) return { canceled: true, warnings: [] }
  if (!opened.success || !opened.content) {
    return { canceled: false, error: opened.error || 'Не удалось загрузить конфигурацию.', warnings: [] }
  }

  let raw: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(opened.content)
    if (!isRecord(parsed)) throw new Error('корневой элемент должен быть объектом')
    raw = parsed
  } catch (error) {
    return { canceled: false, error: `Некорректный файл конфигурации: ${String(error)}`, warnings: [] }
  }
  if (raw.format !== CONFIG_FORMAT) {
    return { canceled: false, error: 'Выбранный файл не является конфигурацией PDM.', warnings: [] }
  }
  if (raw.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    return { canceled: false, error: `Версия конфигурации ${String(raw.schemaVersion)} пока не поддерживается.`, warnings: [] }
  }

  const warnings: string[] = []
  const validationResults: ValidatedPath[] = await window.api.validateConfigPaths(collectConfigPaths(raw))
  const validation = new Map<string, ValidatedPath>(validationResults.map((item: ValidatedPath) => [item.path, item]))

  const rawLibrary = isRecord(raw.library) ? raw.library : {}
  const requestedFolder = safeString(rawLibrary.folderPath)
  const requestedRoot = safeString(rawLibrary.rootFolderPath)
  const folderPath = pathExists(requestedFolder, validation, true)
    ? requestedFolder
    : pathExists(requestedRoot, validation, true) ? requestedRoot : null
  const rootFolderPath = pathExists(requestedRoot, validation, true) ? requestedRoot : folderPath
  if (requestedFolder && !pathExists(requestedFolder, validation, true)) {
    warnings.push(`Папка библиотеки не найдена: ${requestedFolder}`)
  }
  if (requestedRoot && !pathExists(requestedRoot, validation, true) && requestedRoot !== requestedFolder) {
    warnings.push(`Корневая папка библиотеки не найдена: ${requestedRoot}`)
  }
  const filter = ['all', 'presentation', 'pdf', 'video', 'other'].includes(String(rawLibrary.filter))
    ? rawLibrary.filter as FilterType
    : 'all'

  const rawChannels = isRecord(raw.channels) ? raw.channels : {}
  const gridSize: ChannelGridSize = rawChannels.gridSize === 9 ? 9 : 4
  const rawItems = Array.isArray(rawChannels.items) ? rawChannels.items.slice(0, MAX_CHANNELS) : []
  const requestedCount = Math.max(gridSize, Math.min(MAX_CHANNELS, rawItems.length || gridSize))
  const channelCount = Math.min(MAX_CHANNELS, Math.ceil(requestedCount / gridSize) * gridSize)
  const channelIds = Array.from({ length: channelCount }, (_, index) => channelIdFromIndex(index))
  const channels: Record<ChannelId, ChannelState> = {}
  const restoredCaptureSources = new Map<string, FileEntry>()

  for (let index = 0; index < channelCount; index++) {
    const id = channelIds[index]
    const rawItem = isRecord(rawItems[index]) ? rawItems[index] : {}
    let file = safeFileEntry(rawItem.file)
    if (file?.type === 'capture') {
      if (file.capture) restoredCaptureSources.set(file.capture.sourceId, file)
    } else if (file && !pathExists(file.path, validation)) {
      warnMissing(warnings, `Канал ${id} («${file.name}»)`, file.path)
      file = null
    }
    channels[id] = {
      file,
      slide: file ? safeInteger(rawItem.slide, 1, 1, 100000) : 1,
      totalSlides: file ? safeInteger(rawItem.totalSlides, 0, 0, 100000) : 0,
      videoEndChannel: file?.type === 'video' && typeof rawItem.videoEndChannel === 'string'
        ? rawItem.videoEndChannel
        : null,
      caption: safeString(rawItem.caption, 80) || ''
    }
  }

  for (const channel of Object.values(channels)) {
    if (channel.videoEndChannel && (
      !channels[channel.videoEndChannel]?.file ||
      channels[channel.videoEndChannel] === channel
    )) channel.videoEndChannel = null
  }

  const rawCaptureSources = Array.isArray(raw.captureSources) ? raw.captureSources.slice(0, MAX_CHANNELS) : []
  for (const value of rawCaptureSources) {
    const entry = safeFileEntry(value)
    if (entry?.type === 'capture' && entry.capture) restoredCaptureSources.set(entry.capture.sourceId, entry)
    else if (isRecord(value) && isRecord(value.capture) && value.capture.captureKind === 'desktop') {
      warnings.push('Захват окна/экрана не восстановлен: выберите открытое окно заново.')
    }
  }

  const displays = matchDisplays(parseDisplayOutputs(raw.displays))
  warnings.push(...displays.warnings)
  const informationMedia = await restoreInformationMedia(raw.informationMedia, validation, warnings)
  const backdropImage = safeString(raw.backdropImage)
  const restoredBackdrop = backdropImage && pathExists(backdropImage, validation) ? backdropImage : null
  if (backdropImage && !restoredBackdrop) warnMissing(warnings, 'Подложка', backdropImage)

  const rawPositions = isRecord(raw.slidePositions) ? raw.slidePositions : {}
  const slidePositions: Record<string, number> = {}
  for (const [path, slide] of Object.entries(rawPositions).slice(0, MAX_SLIDE_POSITIONS)) {
    if (pathExists(path, validation)) slidePositions[path] = safeInteger(slide, 1, 1, 100000)
  }

  const restorePlaylist = (value: unknown, label: string): string[] => {
    if (!Array.isArray(value)) return []
    const result: string[] = []
    for (const candidate of value.slice(0, MAX_PLAYLIST_ITEMS)) {
      const path = safeString(candidate)
      if (!path) continue
      if (pathExists(path, validation)) result.push(path)
      else warnMissing(warnings, label, path)
    }
    return result
  }
  const rawMusic = isRecord(raw.music) ? raw.music : {}
  const rawVideo = isRecord(raw.video) ? raw.video : {}
  const musicPlaylist = restorePlaylist(rawMusic.playlist, 'Музыкальный файл')
  const videoPlaylist = restorePlaylist(rawVideo.playlist, 'Видео из плейлиста')
  const rawVideoPlayback = isRecord(rawVideo.playback) ? rawVideo.playback : {}
  const videoPlayback: Record<string, { currentTime: number; duration: number; playing: boolean }> = {}
  for (const [path, value] of Object.entries(rawVideoPlayback).slice(0, MAX_PLAYLIST_ITEMS)) {
    if (!pathExists(path, validation) || !isRecord(value)) continue
    videoPlayback[path] = {
      currentTime: safeNumber(value.currentTime, 0, 0, 30 * 24 * 60 * 60),
      duration: safeNumber(value.duration, 0, 0, 30 * 24 * 60 * 60),
      playing: false
    }
  }

  const rawTimer = isRecord(raw.timer) ? raw.timer : {}
  const timerSoundEnd = safeString(rawTimer.soundEnd)
  const timerSoundWarning = safeString(rawTimer.soundWarning)
  const restoredSoundEnd = timerSoundEnd && pathExists(timerSoundEnd, validation) ? timerSoundEnd : null
  const restoredSoundWarning = timerSoundWarning && pathExists(timerSoundWarning, validation) ? timerSoundWarning : null
  if (timerSoundEnd && !restoredSoundEnd) warnMissing(warnings, 'Звук окончания таймера', timerSoundEnd)
  if (timerSoundWarning && !restoredSoundWarning) warnMissing(warnings, 'Звук предупреждения таймера', timerSoundWarning)
  const position = isRecord(rawTimer.overlayPosition) ? rawTimer.overlayPosition : {}
  const duration = safeInteger(rawTimer.duration, 0, 0, 7 * 24 * 60 * 60)
  const remaining = safeInteger(rawTimer.remaining, duration, -7 * 24 * 60 * 60, 7 * 24 * 60 * 60)

  const rawEventTimer = isRecord(raw.eventTimer) ? raw.eventTimer : {}
  const rawEventVisibility = isRecord(rawEventTimer.visibility) ? rawEventTimer.visibility : {}
  const eventBackgroundImage = safeString(rawEventTimer.backgroundImage)
  const restoredEventBackground = eventBackgroundImage && pathExists(eventBackgroundImage, validation)
    ? eventBackgroundImage
    : null
  if (eventBackgroundImage && !restoredEventBackground) {
    warnMissing(warnings, 'Фон таймера мероприятия', eventBackgroundImage)
  }
  const eventDuration = safeInteger(
    rawEventTimer.duration,
    DEFAULT_EVENT_TIMER_STATE.duration,
    0,
    7 * 24 * 60 * 60
  )
  const restoredCentralTimeMode: EventTimerState['centralTimeMode'] = (
    ['current', 'timer', 'to-start', 'to-end'].includes(String(rawEventTimer.centralTimeMode))
      ? rawEventTimer.centralTimeMode
      : rawEventTimer.countdownMode === 'to-start'
        ? 'to-start'
        : 'to-end'
  ) as EventTimerState['centralTimeMode']
  const rawEventHeadings = isRecord(rawEventTimer.headings) ? rawEventTimer.headings : {}
  const restoreEventHeading = (mode: EventTimerState['centralTimeMode']): string => {
    const value = safeString(rawEventHeadings[mode], 120)
    if (!value) return DEFAULT_EVENT_TIMER_STATE.headings[mode]
    if (mode === 'to-start' && value === 'До начала доклада:') {
      return DEFAULT_EVENT_TIMER_STATE.headings['to-start']
    }
    if (mode === 'to-end' && value === 'До конца доклада:') {
      return DEFAULT_EVENT_TIMER_STATE.headings['to-end']
    }
    return value
  }
  const restoredEventHeadings = {
    current: restoreEventHeading('current'),
    timer: restoreEventHeading('timer'),
    'to-start': restoreEventHeading('to-start'),
    'to-end': restoreEventHeading('to-end')
  }
  const legacyEventHeading = safeString(rawEventTimer.heading, 120)
  if (legacyEventHeading && Object.keys(rawEventHeadings).length === 0) {
    restoredEventHeadings[restoredCentralTimeMode] =
      restoredCentralTimeMode === 'to-start' && legacyEventHeading === 'До начала доклада:'
        ? DEFAULT_EVENT_TIMER_STATE.headings['to-start']
        : restoredCentralTimeMode === 'to-end' && legacyEventHeading === 'До конца доклада:'
          ? DEFAULT_EVENT_TIMER_STATE.headings['to-end']
          : legacyEventHeading
  }
  const eventTimer: EventTimerState = {
    eventName: safeString(rawEventTimer.eventName, 120) || DEFAULT_EVENT_TIMER_STATE.eventName,
    headings: restoredEventHeadings,
    startTime: /^\d{2}:\d{2}$/.test(String(rawEventTimer.startTime))
      ? String(rawEventTimer.startTime)
      : DEFAULT_EVENT_TIMER_STATE.startTime,
    endTime: /^\d{2}:\d{2}$/.test(String(rawEventTimer.endTime))
      ? String(rawEventTimer.endTime)
      : DEFAULT_EVENT_TIMER_STATE.endTime,
    costPerMinute: safeNumber(rawEventTimer.costPerMinute, 0, 0, 1000000000),
    overtimeCostTotal: safeNumber(rawEventTimer.overtimeCostTotal, 0, 0, 1000000000000),
    backgroundMode: rawEventTimer.backgroundMode === 'solid' ? 'solid' : 'gradient',
    backgroundColor: safeColor(rawEventTimer.backgroundColor, DEFAULT_EVENT_TIMER_STATE.backgroundColor),
    backgroundGradientColor: safeColor(
      rawEventTimer.backgroundGradientColor,
      DEFAULT_EVENT_TIMER_STATE.backgroundGradientColor
    ),
    backgroundGradientAngle: safeNumber(
      rawEventTimer.backgroundGradientAngle,
      DEFAULT_EVENT_TIMER_STATE.backgroundGradientAngle,
      0,
      360
    ),
    fontColor: safeColor(rawEventTimer.fontColor, DEFAULT_EVENT_TIMER_STATE.fontColor),
    backgroundImage: restoredEventBackground,
    centralTimeMode: restoredCentralTimeMode,
    visibility: {
      clock: safeBoolean(rawEventVisibility.clock, true),
      schedule: safeBoolean(rawEventVisibility.schedule, true),
      heading: safeBoolean(rawEventVisibility.heading, true),
      eventName: safeBoolean(rawEventVisibility.eventName, true),
      remaining: safeBoolean(rawEventVisibility.remaining, true),
      cost: safeBoolean(rawEventVisibility.cost, true)
    },
    duration: eventDuration,
    remaining: safeInteger(rawEventTimer.remaining, eventDuration, -7 * 24 * 60 * 60, 7 * 24 * 60 * 60),
    running: false,
    live: false
  }
  const rawBroadcastTitles = isRecord(raw.broadcastTitles) ? raw.broadcastTitles : {}
  const validTitleEffects: BroadcastTitleEffect[] = ['instant', 'fade', 'slide-left', 'slide-right', 'slide-up', 'scale']
  const validTitleStyles: BroadcastTitleStyle[] = ['rounded', 'rectangle', 'slant-right', 'slant-left', 'pill']
  const validTitlePositions: BroadcastTitlePosition[] = [
    'top-left', 'top-center', 'top-right',
    'center-left', 'center', 'center-right',
    'bottom-left', 'bottom-center', 'bottom-right'
  ]
  const titleEffect = (value: unknown, fallback: BroadcastTitleEffect): BroadcastTitleEffect => (
    typeof value === 'string' && validTitleEffects.includes(value as BroadcastTitleEffect)
      ? value as BroadcastTitleEffect
      : fallback
  )
  const titlePosition = (value: unknown): BroadcastTitlePosition => (
    typeof value === 'string' && validTitlePositions.includes(value as BroadcastTitlePosition)
      ? value as BroadcastTitlePosition
      : DEFAULT_BROADCAST_TITLES.eventPosition
  )
  const titleStyle = (value: unknown, fallback: BroadcastTitleStyle): BroadcastTitleStyle => (
    value === 'cut-corner'
      ? 'slant-right'
      :
    typeof value === 'string' && validTitleStyles.includes(value as BroadcastTitleStyle)
      ? value as BroadcastTitleStyle
      : fallback
  )
  const rawSpeakers = Array.isArray(rawBroadcastTitles.speakers)
    ? rawBroadcastTitles.speakers.slice(0, 500)
    : []
  const usedSpeakerIds = new Set<string>()
  const speakers = rawSpeakers.flatMap((value, index) => {
    if (!isRecord(value)) return []
    const name = safeString(value.name, 120) || ''
    const role = safeString(value.role, 180) || ''
    let id = safeString(value.id, 80) || `speaker-${index + 1}`
    while (usedSpeakerIds.has(id)) id = `${id}-${index + 1}`
    usedSpeakerIds.add(id)
    return [{ id, name, role }]
  })
  // Backward compatibility with configurations saved by the first titles build.
  if (speakers.length === 0) {
    const oldName = safeString(rawBroadcastTitles.speakerName, 120) || ''
    const oldRole = safeString(rawBroadcastTitles.speakerRole, 180) || ''
    if (oldName || oldRole) speakers.push({ id: 'speaker-migrated', name: oldName, role: oldRole })
  }
  const requestedSpeakerId = safeString(rawBroadcastTitles.selectedSpeakerId, 80)
  const broadcastTitles: BroadcastTitlesDraft = {
    speakers,
    selectedSpeakerId: requestedSpeakerId && speakers.some((speaker) => speaker.id === requestedSpeakerId)
      ? requestedSpeakerId
      : speakers[0]?.id || null,
    eventLabel: typeof rawBroadcastTitles.eventLabel === 'string'
      ? rawBroadcastTitles.eventLabel.replace(/[\r\n\t]+/g, ' ').slice(0, 80)
      : DEFAULT_BROADCAST_TITLES.eventLabel,
    eventInfo: (safeString(rawBroadcastTitles.eventInfo, 320) || DEFAULT_BROADCAST_TITLES.eventInfo).replace(/\r/g, ''),
    speakerEnterEffect: titleEffect(rawBroadcastTitles.speakerEnterEffect, DEFAULT_BROADCAST_TITLES.speakerEnterEffect),
    speakerExitEffect: titleEffect(rawBroadcastTitles.speakerExitEffect, DEFAULT_BROADCAST_TITLES.speakerExitEffect),
    speakerAutoHideSeconds: safeInteger(
      rawBroadcastTitles.speakerAutoHideSeconds,
      DEFAULT_BROADCAST_TITLES.speakerAutoHideSeconds,
      0,
      86400
    ),
    speakerStyle: titleStyle(rawBroadcastTitles.speakerStyle, DEFAULT_BROADCAST_TITLES.speakerStyle),
    speakerTextColor: safeColor(rawBroadcastTitles.speakerTextColor, DEFAULT_BROADCAST_TITLES.speakerTextColor),
    speakerBackgroundStart: safeColor(rawBroadcastTitles.speakerBackgroundStart, DEFAULT_BROADCAST_TITLES.speakerBackgroundStart),
    speakerBackgroundEnd: safeColor(rawBroadcastTitles.speakerBackgroundEnd, DEFAULT_BROADCAST_TITLES.speakerBackgroundEnd),
    speakerAccentStart: safeColor(rawBroadcastTitles.speakerAccentStart, DEFAULT_BROADCAST_TITLES.speakerAccentStart),
    speakerAccentEnd: safeColor(rawBroadcastTitles.speakerAccentEnd, DEFAULT_BROADCAST_TITLES.speakerAccentEnd),
    eventEnterEffect: titleEffect(rawBroadcastTitles.eventEnterEffect, DEFAULT_BROADCAST_TITLES.eventEnterEffect),
    eventExitEffect: titleEffect(rawBroadcastTitles.eventExitEffect, DEFAULT_BROADCAST_TITLES.eventExitEffect),
    eventAutoHideSeconds: safeInteger(
      rawBroadcastTitles.eventAutoHideSeconds,
      DEFAULT_BROADCAST_TITLES.eventAutoHideSeconds,
      0,
      86400
    ),
    eventPosition: titlePosition(rawBroadcastTitles.eventPosition),
    eventStyle: titleStyle(rawBroadcastTitles.eventStyle, DEFAULT_BROADCAST_TITLES.eventStyle),
    eventTextColor: safeColor(rawBroadcastTitles.eventTextColor, DEFAULT_BROADCAST_TITLES.eventTextColor),
    eventBackgroundStart: safeColor(rawBroadcastTitles.eventBackgroundStart, DEFAULT_BROADCAST_TITLES.eventBackgroundStart),
    eventBackgroundEnd: safeColor(rawBroadcastTitles.eventBackgroundEnd, DEFAULT_BROADCAST_TITLES.eventBackgroundEnd),
    eventAccentStart: safeColor(rawBroadcastTitles.eventAccentStart, DEFAULT_BROADCAST_TITLES.eventAccentStart),
    eventAccentEnd: safeColor(rawBroadcastTitles.eventAccentEnd, DEFAULT_BROADCAST_TITLES.eventAccentEnd)
  }

  let files: FileEntry[] = []
  let subfolders: Array<{ name: string; path: string }> = []
  if (folderPath) {
    try {
      const folder = await window.api.loadFolder(folderPath)
      files = folder.files
      subfolders = folder.subfolders
    } catch (error) {
      warnings.push(`Не удалось прочитать папку библиотеки: ${String(error)}`)
    }
  }

  // A backdrop-only program window is not an active TAKE, so loading is
  // allowed. Close it before applying the snapshot to guarantee that loading
  // itself never puts saved content on air.
  if (before.isPresentationWindowOpen) {
    await window.api.closePresentationWindow().catch(() => undefined)
    await window.api.hideOverlay().catch(() => undefined)
  }

  for (const oldCapture of before.captureSources) {
    if (oldCapture.capture?.sourceId) {
      window.api.sendToPresentation('capture-source-unregister', oldCapture.capture.sourceId)
    }
  }

  const rawInput = isRecord(raw.input) ? raw.input : {}
  const globalHookRequested = safeBoolean(rawInput.globalHookEnabled, true)
  const actualGlobalHook = await window.api.toggleGlobalHook(globalHookRequested).catch(() => false)
  if (actualGlobalHook !== globalHookRequested) {
    warnings.push('Настройку глобального кликера не удалось применить полностью.')
  }

  const selectedChannel = typeof rawChannels.selectedChannel === 'string' && channels[rawChannels.selectedChannel]
    ? rawChannels.selectedChannel
    : null
  const pageCount = Math.max(1, Math.ceil(channelIds.length / gridSize))
  const currentChannelPage = safeInteger(rawChannels.currentPage, 0, 0, pageCount - 1)

  useAppStore.setState({
    folderPath,
    rootFolderPath,
    subfolders,
    files,
    filteredFiles: filter === 'all' ? files : files.filter((file) => file.type === filter),
    filter,
    selectedFile: null,
    activeFile: null,
    isPlaying: false,
    isPresentationWindowOpen: false,
    currentSlide: 1,
    totalSlides: 0,
    slidePositions,
    pptxThumbnails: [],
    pptxThumbnailsMap: {},
    pptxSlidesMap: {},
    pptxCacheStatuses: {},
    displayAssignments: displays.assignments,
    displayNames: displays.displayNames,
    selectedDisplayId: displays.selectedDisplayId,
    informationMedia,
    backdropImage: restoredBackdrop,
    globalHookEnabled: actualGlobalHook,
    channelBoundaryNavigationEnabled: safeBoolean(rawInput.channelBoundaryNavigationEnabled, false),
    overlayState: { kind: 'hidden' },
    channels,
    channelIds,
    channelGridSize: gridSize,
    currentChannelPage,
    liveChannel: null,
    selectedChannel,
    captureSources: [...restoredCaptureSources.values()],
    docPreviewsMap: {},
    musicPlaylist,
    videoPlaylist,
    videoCurrentIndex: safeInteger(rawVideo.currentIndex, 0, 0, Math.max(0, videoPlaylist.length - 1)),
    videoIsPlaying: false,
    videoLoopTrack: safeBoolean(rawVideo.loopTrack, false),
    videoLoopPlaylist: safeBoolean(rawVideo.loopPlaylist, true),
    videoPlayback,
    timerDuration: duration,
    timerRemaining: remaining,
    timerRunning: false,
    timerSoundEnd: restoredSoundEnd,
    timerSoundWarning: restoredSoundWarning,
    timerOverlayPosition: {
      x: safeNumber(position.x, 90, 0, 100),
      y: safeNumber(position.y, 90, 0, 100)
    },
    timerOverlayScale: safeNumber(rawTimer.overlayScale, 1, 0.25, 8),
    timerTextColor: safeColor(rawTimer.textColor, '#ffffff'),
    timerWarningTextColor: safeColor(rawTimer.warningTextColor, '#facc15'),
    timerOvertimeTextColor: safeColor(rawTimer.overtimeTextColor, '#ef4444'),
    timerTextOpacity: safeNumber(rawTimer.textOpacity, 1, 0.1, 1),
    eventTimer,
    eventTimerOutput: null,
    broadcastTitles,
    broadcastTitlesOutput: { ...DEFAULT_BROADCAST_TITLES_OUTPUT }
  })

  await window.api.watchFolder(folderPath).catch(() => undefined)
  for (const entry of restoredCaptureSources.values()) {
    if (entry.capture) window.api.sendToPresentation('capture-source-register', entry.capture)
  }

  const musicIndex = safeInteger(rawMusic.currentIndex, 0, 0, Math.max(0, musicPlaylist.length - 1))
  await window.api.musicStop().catch(() => undefined)
  await window.api.musicSetPlaylist(musicPlaylist, musicIndex, false).catch(() => undefined)
  await window.api.musicSetLoopTrack(safeBoolean(rawMusic.loopTrack, false)).catch(() => undefined)
  await window.api.musicSetLoopPlaylist(safeBoolean(rawMusic.loopPlaylist, true)).catch(() => undefined)
  await window.api.musicSetVolume(safeNumber(rawMusic.volume, 1, 0, 1)).catch(() => undefined)
  const musicTime = safeNumber(rawMusic.currentTime, 0, 0, 30 * 24 * 60 * 60)
  if (musicPlaylist.length > 0 && musicTime > 0) {
    await window.api.musicSeek(musicTime).catch(() => undefined)
  }

  const rawAudio = isRecord(raw.audio) ? raw.audio : {}
  const outputDeviceId = safeString(rawAudio.outputDeviceId, 2048)
  if (outputDeviceId) {
    const audioDevices: AudioDeviceInfo[] = await window.api.getAudioDevices().catch(() => [])
    if (audioDevices.some((device) => device.id === outputDeviceId)) {
      const audioResult = await window.api.setAudioDevice(outputDeviceId).catch((error: unknown) => ({ success: false, error: String(error) }))
      if (!audioResult.success) warnings.push(`Не удалось восстановить аудиовыход: ${audioResult.error || 'ошибка'}`)
    } else {
      warnings.push('Сохранённый аудиовыход сейчас не подключён; оставлено текущее устройство.')
    }
  }

  return { canceled: false, path: opened.path, warnings }
}
