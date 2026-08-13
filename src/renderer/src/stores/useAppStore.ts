import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'

// Module-state for collapsing rapid PPTX goto calls. См. navigatePptx
// для контекста. inflight = текущая chain promise; pendingTarget = последний
// запрошенный target slide (null если нет ожидающего).
type PptxResult = { success: boolean; output?: string; error?: string }
let _pptxGotoInflight: Promise<PptxResult> | null = null
let _pptxGotoPendingTarget: number | null = null

// Reset collapse state. Вызывается из handleTake перед launchPowerPoint
// чтобы chain от навигации предыдущего файла не пересекался с новым PPTX.
// Если предыдущий chain ещё в процессе await — его resolve просто не
// повлияет на новые клики (мы пере-стартуем chain как только pending
// будет установлен следующим кликом).
export function resetPptxNavState(): void {
  _pptxGotoInflight = null
  _pptxGotoPendingTarget = null
}

// Ждёт пока goto-chain полностью завершится. Используется в handleTake
// перед snapshotSlideshow чтобы не захватить промежуточный слайд PP
// если user кликал кликером ВО ВРЕМЯ launchPowerPoint (queued goto's
// ещё не отработали daemon-ом к моменту snapshot → overlay pinned с
// картинкой не того слайда, который PP в итоге покажет).
export async function awaitPptxGotoChainIdle(): Promise<void> {
  while (_pptxGotoInflight) {
    try { await _pptxGotoInflight } catch { /* ignore */ }
  }
}

function dispatchPptxGotoCollapsed(target: number): Promise<PptxResult> {
  _pptxGotoPendingTarget = target
  const wasInflight = !!_pptxGotoInflight
  window.api.dbgLog(`dispatchPptxGoto: target=${target} wasInflight=${wasInflight}`)
  if (_pptxGotoInflight) return _pptxGotoInflight
  const chain = (async (): Promise<PptxResult> => {
    let lastResult: PptxResult = { success: true }
    while (_pptxGotoPendingTarget !== null) {
      const t = _pptxGotoPendingTarget
      _pptxGotoPendingTarget = null
      lastResult = await new Promise<PptxResult>((resolve) => {
        const timer = setTimeout(() => {
          resolve({ success: false, error: `goto(${t}) timeout 3000ms` })
        }, 3000)
        window.api.powerpointCommand('goto', t).then(
          (r) => { clearTimeout(timer); resolve(r) },
          (e) => { clearTimeout(timer); resolve({ success: false, error: String(e) }) }
        )
      })
    }
    _pptxGotoInflight = null
    // Sync UI с РЕАЛЬНЫМ состоянием PP. daemon goto всегда возвращает
    // фактический slide (даже при out-of-bounds GotoSlide — PP остаётся
    // на предыдущем слайде). Если optimistic UI ушёл в N+1 а PP не
    // смог туда попасть, lastResult.slide = реальный N. Откатываем UI
    // в N — иначе на следующий клик UI «пропустит» слайд догоняя PP.
    try {
      const data = lastResult.output ? JSON.parse(lastResult.output) : null
      const actualSlide = data?.CurrentSlide
      if (typeof actualSlide === 'number' && actualSlide > 0) {
        const { currentSlide, setCurrentSlide } = useAppStore.getState()
        if (actualSlide !== currentSlide) {
          window.api.dbgLog(`dispatchPptxGoto: sync UI ${currentSlide}→${actualSlide} (PP actual)`)
          setCurrentSlide(actualSlide)
        }
      }
    } catch { /* ignore */ }
    return lastResult
  })()
  _pptxGotoInflight = chain
  return chain
}

export type ContentType = 'presentation' | 'pdf' | 'video' | 'capture' | 'other' | null
export type FilterType = 'all' | 'presentation' | 'pdf' | 'video' | 'other'
export type ChannelId = string
export type ChannelCacheStatus = 'loading' | 'ready' | 'error'

export type OverlayState =
  | { kind: 'hidden' }
  | { kind: 'pinned-pptx'; pptxPath: string }
  | { kind: 'pinned-pdf'; pdfPath: string }

export type ChannelGridSize = 4 | 9
export const DEFAULT_CHANNELS_PER_PAGE: ChannelGridSize = 4

// 0 -> '1', 1 -> '2', 2 -> '3', ...
export function channelIdFromIndex(i: number): ChannelId {
  return String(i + 1)
}

export interface ChannelState {
  file: FileEntry | null
  slide: number
  totalSlides: number
  videoEndChannel: ChannelId | null
  caption: string
}

const EMPTY_CHANNEL: ChannelState = { file: null, slide: 1, totalSlides: 0, videoEndChannel: null, caption: '' }

function makeInitialChannels(): { channels: Record<ChannelId, ChannelState>; channelIds: ChannelId[] } {
  const channelIds: ChannelId[] = []
  const channels: Record<ChannelId, ChannelState> = {}
  for (let i = 0; i < DEFAULT_CHANNELS_PER_PAGE; i++) {
    const id = channelIdFromIndex(i)
    channelIds.push(id)
    channels[id] = { ...EMPTY_CHANNEL }
  }
  return { channels, channelIds }
}

export interface SubfolderEntry {
  name: string
  path: string
}

export interface VideoPlaybackState {
  currentTime: number
  duration: number
  playing: boolean
}

export type InformationMediaType = 'presentation' | 'pdf' | 'video' | 'image' | 'capture'
export type DisplayOutputMode = 'off' | 'program' | 'speaker' | 'information' | 'timer' | 'event-timer'
export type DisplayAssignments = Record<string, DisplayOutputMode>

export type EventTimerCentralMode = 'current' | 'timer' | 'to-start' | 'to-end'
export type EventTimerHeadings = Record<EventTimerCentralMode, string>

export interface EventTimerVisibility {
  clock: boolean
  schedule: boolean
  heading: boolean
  eventName: boolean
  remaining: boolean
  cost: boolean
}

export interface EventTimerState {
  eventName: string
  headings: EventTimerHeadings
  startTime: string
  endTime: string
  costPerMinute: number
  overtimeCostTotal: number
  backgroundMode: 'solid' | 'gradient'
  backgroundColor: string
  backgroundGradientColor: string
  backgroundGradientAngle: number
  fontColor: string
  backgroundImage: string | null
  centralTimeMode: EventTimerCentralMode
  visibility: EventTimerVisibility
  duration: number
  remaining: number
  running: boolean
  live: boolean
}

export const DEFAULT_EVENT_TIMER_STATE: EventTimerState = {
  eventName: 'Оперативное совещание',
  headings: {
    current: 'Текущее время:',
    timer: 'Таймер:',
    'to-start': 'До начала мероприятия:',
    'to-end': 'До конца мероприятия:'
  },
  startTime: '14:30',
  endTime: '16:00',
  costPerMinute: 0,
  overtimeCostTotal: 0,
  backgroundMode: 'gradient',
  backgroundColor: '#18c56e',
  backgroundGradientColor: '#19b9d1',
  backgroundGradientAngle: 115,
  fontColor: '#ffffff',
  backgroundImage: null,
  centralTimeMode: 'to-end',
  visibility: {
    clock: true,
    schedule: true,
    heading: true,
    eventName: true,
    remaining: true,
    cost: true
  },
  duration: 90 * 60,
  remaining: 90 * 60,
  running: false,
  live: false
}

export interface InformationMediaConfig {
  type: InformationMediaType
  path: string
  name: string
  currentSlide: number
  totalSlides: number
  slideImages: string[]
  playing: boolean
  currentTime?: number
  duration?: number
  seekRevision?: number
  loop?: boolean
  capture?: CaptureSourceConfig
}

export type BroadcastTitleEffect = 'instant' | 'fade' | 'slide-left' | 'slide-right' | 'slide-up' | 'scale'
export type BroadcastTitleStyle = 'rounded' | 'rectangle' | 'slant-right' | 'slant-left' | 'pill'
export type BroadcastTitlePosition =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'center-left'
  | 'center'
  | 'center-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right'

export interface BroadcastSpeaker {
  id: string
  name: string
  role: string
}

function normalizeBroadcastColor(value: string | undefined, fallback: string): string {
  return value && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback
}

export interface BroadcastTitlesDraft {
  speakers: BroadcastSpeaker[]
  selectedSpeakerId: string | null
  eventLabel: string
  eventInfo: string
  speakerEnterEffect: BroadcastTitleEffect
  speakerExitEffect: BroadcastTitleEffect
  speakerAutoHideSeconds: number
  speakerStyle: BroadcastTitleStyle
  speakerTextColor: string
  speakerBackgroundStart: string
  speakerBackgroundEnd: string
  speakerAccentStart: string
  speakerAccentEnd: string
  eventEnterEffect: BroadcastTitleEffect
  eventExitEffect: BroadcastTitleEffect
  eventAutoHideSeconds: number
  eventPosition: BroadcastTitlePosition
  eventStyle: BroadcastTitleStyle
  eventTextColor: string
  eventBackgroundStart: string
  eventBackgroundEnd: string
  eventAccentStart: string
  eventAccentEnd: string
}

export interface BroadcastTitlesOutput {
  speakerId: string | null
  speakerName: string
  speakerRole: string
  eventLabel: string
  eventInfo: string
  speakerEnterEffect: BroadcastTitleEffect
  speakerExitEffect: BroadcastTitleEffect
  speakerAutoHideSeconds: number
  speakerStyle: BroadcastTitleStyle
  speakerTextColor: string
  speakerBackgroundStart: string
  speakerBackgroundEnd: string
  speakerAccentStart: string
  speakerAccentEnd: string
  eventEnterEffect: BroadcastTitleEffect
  eventExitEffect: BroadcastTitleEffect
  eventAutoHideSeconds: number
  eventPosition: BroadcastTitlePosition
  eventStyle: BroadcastTitleStyle
  eventTextColor: string
  eventBackgroundStart: string
  eventBackgroundEnd: string
  eventAccentStart: string
  eventAccentEnd: string
  speakerVisible: boolean
  eventVisible: boolean
}

export const DEFAULT_BROADCAST_TITLES: BroadcastTitlesDraft = {
  speakers: [],
  selectedSpeakerId: null,
  eventLabel: 'МЕРОПРИЯТИЕ',
  eventInfo: '',
  speakerEnterEffect: 'slide-left',
  speakerExitEffect: 'slide-left',
  speakerAutoHideSeconds: 0,
  speakerStyle: 'rounded',
  speakerTextColor: '#ffffff',
  speakerBackgroundStart: '#070d18',
  speakerBackgroundEnd: '#0f222e',
  speakerAccentStart: '#3ee59b',
  speakerAccentEnd: '#24b8d8',
  eventEnterEffect: 'fade',
  eventExitEffect: 'fade',
  eventAutoHideSeconds: 0,
  eventPosition: 'top-right',
  eventStyle: 'rounded',
  eventTextColor: '#ffffff',
  eventBackgroundStart: '#070d18',
  eventBackgroundEnd: '#0d1b28',
  eventAccentStart: '#5be5b2',
  eventAccentEnd: '#24b8d8'
}

export const DEFAULT_BROADCAST_TITLES_OUTPUT: BroadcastTitlesOutput = {
  speakerId: null,
  speakerName: '',
  speakerRole: '',
  eventLabel: DEFAULT_BROADCAST_TITLES.eventLabel,
  eventInfo: '',
  speakerEnterEffect: DEFAULT_BROADCAST_TITLES.speakerEnterEffect,
  speakerExitEffect: DEFAULT_BROADCAST_TITLES.speakerExitEffect,
  speakerAutoHideSeconds: DEFAULT_BROADCAST_TITLES.speakerAutoHideSeconds,
  speakerStyle: DEFAULT_BROADCAST_TITLES.speakerStyle,
  speakerTextColor: DEFAULT_BROADCAST_TITLES.speakerTextColor,
  speakerBackgroundStart: DEFAULT_BROADCAST_TITLES.speakerBackgroundStart,
  speakerBackgroundEnd: DEFAULT_BROADCAST_TITLES.speakerBackgroundEnd,
  speakerAccentStart: DEFAULT_BROADCAST_TITLES.speakerAccentStart,
  speakerAccentEnd: DEFAULT_BROADCAST_TITLES.speakerAccentEnd,
  eventEnterEffect: DEFAULT_BROADCAST_TITLES.eventEnterEffect,
  eventExitEffect: DEFAULT_BROADCAST_TITLES.eventExitEffect,
  eventAutoHideSeconds: DEFAULT_BROADCAST_TITLES.eventAutoHideSeconds,
  eventPosition: DEFAULT_BROADCAST_TITLES.eventPosition,
  eventStyle: DEFAULT_BROADCAST_TITLES.eventStyle,
  eventTextColor: DEFAULT_BROADCAST_TITLES.eventTextColor,
  eventBackgroundStart: DEFAULT_BROADCAST_TITLES.eventBackgroundStart,
  eventBackgroundEnd: DEFAULT_BROADCAST_TITLES.eventBackgroundEnd,
  eventAccentStart: DEFAULT_BROADCAST_TITLES.eventAccentStart,
  eventAccentEnd: DEFAULT_BROADCAST_TITLES.eventAccentEnd,
  speakerVisible: false,
  eventVisible: false
}

interface AppState {
  folderPath: string | null
  rootFolderPath: string | null
  subfolders: SubfolderEntry[]
  files: FileEntry[]
  filteredFiles: FileEntry[]
  filter: FilterType
  selectedFile: FileEntry | null
  activeFile: FileEntry | null
  isPlaying: boolean
  isPresentationWindowOpen: boolean
  currentSlide: number
  totalSlides: number
  slidePositions: Record<string, number>
  pptxThumbnails: string[]
  pptxThumbnailsMap: Record<string, string[]>
  pptxSlidesMap: Record<string, string[]>
  pptxAspectRatios: Record<string, number>
  pptxCacheStatuses: Record<string, ChannelCacheStatus>
  displays: DisplayInfo[]
  displayAssignments: DisplayAssignments
  displayNames: Record<string, string>
  selectedDisplayId: number | null
  informationMedia: InformationMediaConfig | null
  backdropImage: string | null
  globalHookEnabled: boolean
  channelBoundaryNavigationEnabled: boolean
  eventTimer: EventTimerState
  eventTimerOutput: EventTimerState | null
  broadcastTitles: BroadcastTitlesDraft
  broadcastTitlesOutput: BroadcastTitlesOutput

  overlayState: OverlayState
  setOverlayState: (state: OverlayState) => void
  releasePinnedPdfOverlay: () => void
  navigatePptx: (
    command: 'next' | 'prev' | 'goto',
    arg?: number,
    stopAtBoundary?: boolean
  ) => Promise<{ success: boolean; output?: string; error?: string }>

  channels: Record<ChannelId, ChannelState>
  channelIds: ChannelId[]
  channelGridSize: ChannelGridSize
  currentChannelPage: number
  liveChannel: ChannelId | null
  selectedChannel: ChannelId | null
  captureSources: FileEntry[]

  setSelectedChannel: (ch: ChannelId | null) => void
  setChannelFile: (ch: ChannelId, file: FileEntry | null) => void
  setChannelSlide: (ch: ChannelId, slide: number) => void
  setChannelTotalSlides: (ch: ChannelId, total: number) => void
  setChannelVideoEndChannel: (ch: ChannelId, target: ChannelId | null) => void
  setChannelCaption: (ch: ChannelId, caption: string) => void
  setLiveChannel: (ch: ChannelId) => void
  addChannelPage: () => void
  removeChannelPage: (page: number) => void
  setCurrentChannelPage: (page: number) => void
  setChannelGridSize: (size: ChannelGridSize) => void
  addCaptureSource: (source: FileEntry) => void
  removeCaptureSource: (sourceId: string) => void

  setPptxThumbnails: (thumbnails: string[]) => void
  setPptxCacheStatuses: (
    update: Record<string, ChannelCacheStatus> | ((current: Record<string, ChannelCacheStatus>) => Record<string, ChannelCacheStatus>)
  ) => void
  setFolderPath: (path: string | null) => void
  setRootFolderPath: (path: string | null) => void
  setSubfolders: (subfolders: SubfolderEntry[]) => void
  setFiles: (files: FileEntry[]) => void
  setFilter: (filter: FilterType) => void
  selectFile: (file: FileEntry | null) => void
  setActiveFile: (file: FileEntry | null) => void
  setIsPlaying: (playing: boolean) => void
  setPresentationWindowOpen: (open: boolean) => void
  setCurrentSlide: (slide: number) => void
  setTotalSlides: (total: number) => void
  saveSlidePosition: () => void
  clearSlidePosition: (filePath: string) => void
  setDisplays: (displays: DisplayInfo[]) => void
  setDisplayAssignment: (displayId: number, mode: DisplayOutputMode) => void
  setDisplayName: (displayId: number, name: string) => void
  setSelectedDisplayId: (id: number | null) => void
  setInformationMedia: (media: InformationMediaConfig | null) => void
  setBackdropImage: (path: string | null) => void
  setGlobalHookEnabled: (enabled: boolean) => void
  setChannelBoundaryNavigationEnabled: (enabled: boolean) => void
  setEventTimer: (update: Partial<EventTimerState>) => void
  setEventTimerOutput: (timer: EventTimerState | null) => void
  setBroadcastTitles: (update: Partial<BroadcastTitlesDraft>) => void
  setBroadcastTitlesOutput: (update: Partial<BroadcastTitlesOutput>) => void

  // Doc previews (Word/Excel -> temp PDF path)
  docPreviewsMap: Record<string, string>

  // Music playlist (shared between MusicPlayer and channel take)
  musicPlaylist: string[]
  setMusicPlaylist: (files: string[]) => void

  // Video playlist — plays in presentation window, auto-advance on 'ended'
  videoPlaylist: string[]
  videoCurrentIndex: number
  videoIsPlaying: boolean
  videoLoopTrack: boolean
  videoLoopPlaylist: boolean
  videoPlayback: Record<string, VideoPlaybackState>
  setVideoPlaylist: (files: string[]) => void
  setVideoCurrentIndex: (idx: number) => void
  setVideoIsPlaying: (playing: boolean) => void
  setVideoLoopTrack: (v: boolean) => void
  setVideoLoopPlaylist: (v: boolean) => void
  setVideoPlayback: (path: string, state: Partial<VideoPlaybackState>) => void

  // Timer
  timerDuration: number // total seconds set
  timerRemaining: number // seconds remaining (negative = overtime)
  timerRunning: boolean
  timerSoundEnd: string | null
  timerSoundWarning: string | null
  timerOverlayPosition: { x: number; y: number } // percent from top-left
  timerOverlayScale: number
  timerTextColor: string
  timerWarningTextColor: string
  timerOvertimeTextColor: string
  timerTextOpacity: number
  setTimerDuration: (seconds: number) => void
  setTimerRemaining: (seconds: number) => void
  setTimerRunning: (running: boolean) => void
  addTimerMinutes: (minutes: number) => void
  resetTimer: () => void
  setTimerSoundEnd: (path: string | null) => void
  setTimerSoundWarning: (path: string | null) => void
  setTimerOverlayPosition: (pos: { x: number; y: number }) => void
  setTimerOverlayScale: (scale: number) => void
  setTimerTextColor: (color: string) => void
  setTimerWarningTextColor: (color: string) => void
  setTimerOvertimeTextColor: (color: string) => void
  setTimerTextOpacity: (opacity: number) => void
}

export const useAppStore = create<AppState>()(persist(
  (set, get) => {
  const initial = makeInitialChannels()
  return {
  folderPath: null,
  rootFolderPath: null,
  subfolders: [],
  files: [],
  filteredFiles: [],
  filter: 'all',
  selectedFile: null,
  activeFile: null,
  isPlaying: false,
  isPresentationWindowOpen: false,
  currentSlide: 1,
  totalSlides: 0,
  slidePositions: {},
  pptxThumbnails: [],
  pptxThumbnailsMap: {},
  pptxSlidesMap: {},
  pptxAspectRatios: {},
  pptxCacheStatuses: {},
  displays: [],
  displayAssignments: {},
  displayNames: {},
  selectedDisplayId: null,
  informationMedia: null,
  backdropImage: null,
  globalHookEnabled: true,
  channelBoundaryNavigationEnabled: false,
  eventTimer: {
    ...DEFAULT_EVENT_TIMER_STATE,
    headings: { ...DEFAULT_EVENT_TIMER_STATE.headings },
    visibility: { ...DEFAULT_EVENT_TIMER_STATE.visibility }
  },
  eventTimerOutput: null,
  broadcastTitles: { ...DEFAULT_BROADCAST_TITLES },
  broadcastTitlesOutput: { ...DEFAULT_BROADCAST_TITLES_OUTPUT },

  overlayState: { kind: 'hidden' } as OverlayState,

  channels: initial.channels,
  channelIds: initial.channelIds,
  channelGridSize: DEFAULT_CHANNELS_PER_PAGE,
  currentChannelPage: 0,
  liveChannel: null,
  selectedChannel: null,
  captureSources: [],

  setSelectedChannel: (ch) => set({ selectedChannel: ch }),

  setPptxCacheStatuses: (update) => set((state) => ({
    pptxCacheStatuses: typeof update === 'function' ? update(state.pptxCacheStatuses) : update
  })),

  setChannelFile: (ch, file) => {
    const { channels, slidePositions } = get()
    const saved = file ? slidePositions[file.path] || 1 : 1
    const current = channels[ch] || EMPTY_CHANNEL
    const keepVideoEndChannel = (
      current.file?.type === 'video' &&
      file?.type === 'video' &&
      current.file.path === file.path
    )
    const nextChannels = {
      ...channels,
      [ch]: {
        file,
        slide: saved,
        totalSlides: 0,
        videoEndChannel: keepVideoEndChannel ? current.videoEndChannel : null,
        caption: current.caption || ''
      }
    }
    if (!file) {
      for (const [channelId, channel] of Object.entries(nextChannels)) {
        if (channel.videoEndChannel === ch) {
          nextChannels[channelId] = { ...channel, videoEndChannel: null }
        }
      }
    }
    set({
      channels: nextChannels
    })
  },

  setChannelSlide: (ch, slide) => {
    const { channels, slidePositions, liveChannel } = get()
    const channel = channels[ch]
    if (!channel) return
    if (channel.file) {
      slidePositions[channel.file.path] = slide
    }
    const updates: Partial<AppState> = {
      channels: { ...channels, [ch]: { ...channel, slide } },
      slidePositions: { ...slidePositions }
    }
    if (liveChannel === ch) {
      updates.currentSlide = slide
    }
    set(updates)
  },

  setChannelTotalSlides: (ch, total) => {
    const { channels } = get()
    const channel = channels[ch]
    if (!channel) return
    set({ channels: { ...channels, [ch]: { ...channel, totalSlides: total } } })
  },

  setChannelVideoEndChannel: (ch, target) => {
    const { channels } = get()
    const channel = channels[ch]
    if (!channel || channel.file?.type !== 'video') return
    const safeTarget = target && target !== ch && channels[target]?.file ? target : null
    set({
      channels: {
        ...channels,
        [ch]: { ...channel, videoEndChannel: safeTarget }
      }
    })
  },

  setChannelCaption: (ch, caption) => {
    const { channels } = get()
    const channel = channels[ch]
    if (!channel) return
    set({
      channels: {
        ...channels,
        [ch]: { ...channel, caption: caption.slice(0, 80) }
      }
    })
  },

  setLiveChannel: (ch) => {
    const { channels } = get()
    const channel = channels[ch]
    if (channel?.file) {
      set({ liveChannel: ch, activeFile: channel.file, currentSlide: channel.slide })
    }
  },

  addChannelPage: () => {
    const { channels, channelIds, channelGridSize } = get()
    const startIdx = channelIds.length
    const newChannels = { ...channels }
    const newIds = [...channelIds]
    for (let i = 0; i < channelGridSize; i++) {
      const id = channelIdFromIndex(startIdx + i)
      newIds.push(id)
      newChannels[id] = { ...EMPTY_CHANNEL }
    }
    const newPage = Math.floor(startIdx / channelGridSize)
    set({ channels: newChannels, channelIds: newIds, currentChannelPage: newPage })
  },

  removeChannelPage: (page) => {
    const { channels, channelIds, channelGridSize, currentChannelPage, liveChannel, selectedChannel } = get()
    const totalPages = Math.ceil(channelIds.length / channelGridSize)
    // Can't remove last remaining page (always keep at least one)
    if (totalPages <= 1) return
    const start = page * channelGridSize
    const pageIds = channelIds.slice(start, start + channelGridSize)
    // Only remove if all channels on that page are empty
    const hasContent = pageIds.some((id) => channels[id]?.file || channels[id]?.caption.trim())
    if (hasContent) return
    // Don't orphan live/selected channel
    if (liveChannel && pageIds.includes(liveChannel)) return
    const remainingIds = [...channelIds.slice(0, start), ...channelIds.slice(start + channelGridSize)]
    const idMap = new Map<ChannelId, ChannelId>()
    const newIds = remainingIds.map((oldId, index) => {
      const newId = channelIdFromIndex(index)
      idMap.set(oldId, newId)
      return newId
    })
    const newChannels: Record<ChannelId, ChannelState> = {}
    for (const oldId of remainingIds) {
      const channel = channels[oldId]
      newChannels[idMap.get(oldId)!] = {
        ...channel,
        videoEndChannel: channel.videoEndChannel
          ? idMap.get(channel.videoEndChannel) ?? null
          : null
      }
    }
    let newPage = currentChannelPage
    if (page < currentChannelPage) newPage--
    if (newPage >= Math.ceil(newIds.length / channelGridSize)) {
      newPage = Math.max(0, Math.ceil(newIds.length / channelGridSize) - 1)
    }
    const newLive = liveChannel ? idMap.get(liveChannel) ?? null : null
    const newSelected = selectedChannel ? idMap.get(selectedChannel) ?? null : null
    set({
      channels: newChannels,
      channelIds: newIds,
      currentChannelPage: newPage,
      liveChannel: newLive,
      selectedChannel: newSelected
    })
  },

  setCurrentChannelPage: (page) => {
    const { channelIds, channelGridSize } = get()
    const totalPages = Math.ceil(channelIds.length / channelGridSize)
    const clamped = Math.max(0, Math.min(page, totalPages - 1))
    set({ currentChannelPage: clamped })
  },

  setChannelGridSize: (size) => {
    const state = get()
    if (state.channelGridSize === size) return

    const oldPageStart = state.currentChannelPage * state.channelGridSize
    const lastRequiredIndex = state.channelIds.reduce((last, id, index) => (
      state.channels[id]?.file || state.channels[id]?.caption.trim() || id === state.liveChannel || id === state.selectedChannel
        ? index
        : last
    ), -1)
    const requiredCount = Math.max(size, lastRequiredIndex + 1)
    const normalizedCount = Math.ceil(requiredCount / size) * size
    const nextChannels = { ...state.channels }
    const nextIds = state.channelIds.slice(0, normalizedCount)

    for (let index = nextIds.length; index < normalizedCount; index++) {
      const id = channelIdFromIndex(index)
      nextIds.push(id)
      nextChannels[id] = { ...EMPTY_CHANNEL }
    }
    for (const id of state.channelIds.slice(normalizedCount)) {
      delete nextChannels[id]
    }

    const anchorIndex = Math.min(oldPageStart, normalizedCount - 1)
    set({
      channels: nextChannels,
      channelIds: nextIds,
      channelGridSize: size,
      currentChannelPage: Math.floor(anchorIndex / size)
    })
  },

  addCaptureSource: (source) => {
    const { captureSources } = get()
    const sourceId = source.capture?.sourceId
    if (!sourceId) return
    const existingIndex = captureSources.findIndex((item) => item.capture?.sourceId === sourceId)
    if (existingIndex >= 0) {
      const next = [...captureSources]
      next[existingIndex] = source
      set({ captureSources: next })
      return
    }
    set({ captureSources: [...captureSources, source] })
  },

  removeCaptureSource: (sourceId) => {
    const { captureSources, selectedFile } = get()
    set({
      captureSources: captureSources.filter((item) => item.capture?.sourceId !== sourceId),
      selectedFile: selectedFile?.capture?.sourceId === sourceId ? null : selectedFile
    })
  },

  setPptxThumbnails: (thumbnails) => {
    const { activeFile, pptxThumbnailsMap } = get()
    const updates: Partial<AppState> = { pptxThumbnails: thumbnails }
    if (activeFile) {
      updates.pptxThumbnailsMap = { ...pptxThumbnailsMap, [activeFile.path]: thumbnails }
    }
    set(updates)
  },

  setFolderPath: (path) => set({ folderPath: path }),
  setRootFolderPath: (path) => set({ rootFolderPath: path }),
  setSubfolders: (subfolders) => set({ subfolders }),

  setFiles: (files) => {
    const { filter } = get()
    set({
      files,
      filteredFiles: filter === 'all' ? files : files.filter((f) => f.type === filter)
    })
  },

  setFilter: (filter) => {
    const { files } = get()
    set({
      filter,
      filteredFiles: filter === 'all' ? files : files.filter((f) => f.type === filter)
    })
  },

  selectFile: (file) => set({ selectedFile: file }),

  setActiveFile: (file) => {
    const { activeFile, currentSlide, slidePositions } = get()
    if (activeFile) {
      slidePositions[activeFile.path] = currentSlide
    }
    const savedSlide = file ? slidePositions[file.path] || 1 : 1
    set({
      activeFile: file,
      slidePositions: { ...slidePositions },
      currentSlide: savedSlide,
      totalSlides: 0,
      isPlaying: false
    })
  },

  setIsPlaying: (playing) => set({ isPlaying: playing }),

  setPresentationWindowOpen: (open) => set({ isPresentationWindowOpen: open }),

  setCurrentSlide: (slide) => {
    const state = get()
    const { liveChannel, channels } = state
    const updates: Partial<AppState> = { currentSlide: slide }
    if (liveChannel && channels[liveChannel]) {
      updates.channels = { ...channels, [liveChannel]: { ...channels[liveChannel], slide } }
    }
    set(updates)
  },

  setTotalSlides: (total) => set({ totalSlides: total }),

  saveSlidePosition: () => {
    const { activeFile, currentSlide, slidePositions } = get()
    if (activeFile) {
      set({ slidePositions: { ...slidePositions, [activeFile.path]: currentSlide } })
    }
  },

  clearSlidePosition: (filePath) => {
    const { slidePositions } = get()
    if (!(filePath in slidePositions)) return
    const nextPositions = { ...slidePositions }
    delete nextPositions[filePath]
    set({ slidePositions: nextPositions })
  },

  setDisplays: (displays) => {
    const state = get()
    const primaryId = displays.find((display) => display.isPrimary)?.id ?? null
    const externalIds = displays
      .filter((display) => display.id !== primaryId)
      .sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y)
      .map((display) => display.id)
    const assignments: DisplayAssignments = {}
    for (const id of externalIds) {
      const mode = state.displayAssignments[String(id)]
      if (mode) assignments[String(id)] = mode
    }

    if (Object.keys(assignments).length === 0) {
      if (externalIds[0] !== undefined) assignments[String(externalIds[0])] = 'program'
    }

    const programIds = externalIds.filter((id) => assignments[String(id)] === 'program')
    const presentationId = state.selectedDisplayId !== null && programIds.includes(state.selectedDisplayId)
      ? state.selectedDisplayId
      : programIds[0] ?? null

    set({
      displays,
      displayAssignments: assignments,
      selectedDisplayId: presentationId
    })
  },

  setDisplayAssignment: (displayId, mode) => {
    const state = get()
    const assignments = {
      ...state.displayAssignments,
      [String(displayId)]: mode
    }

    const externalIds = state.displays
      .filter((display) => !display.isPrimary)
      .sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y)
      .map((display) => display.id)
    const programIds = externalIds.filter((id) => assignments[String(id)] === 'program')
    const selectedDisplayId = state.selectedDisplayId !== null && programIds.includes(state.selectedDisplayId)
      ? state.selectedDisplayId
      : programIds[0] ?? null

    set({
      displayAssignments: assignments,
      selectedDisplayId
    })
  },

  setDisplayName: (displayId, name) => {
    const { displayNames } = get()
    const key = String(displayId)
    const normalized = name.replace(/[\r\n\t]+/g, ' ').slice(0, 80)
    const nextNames = { ...displayNames }
    if (normalized.trim()) nextNames[key] = normalized
    else delete nextNames[key]
    set({ displayNames: nextNames })
  },

  setSelectedDisplayId: (id) => {
    const { displayAssignments } = get()
    if (id === null || displayAssignments[String(id)] === 'program') {
      set({ selectedDisplayId: id })
    }
  },
  setInformationMedia: (media) => set({ informationMedia: media }),
  setBackdropImage: (path) => set({ backdropImage: path }),
  setGlobalHookEnabled: (enabled) => set({ globalHookEnabled: enabled }),
  setChannelBoundaryNavigationEnabled: (enabled) => set({ channelBoundaryNavigationEnabled: enabled }),
  setEventTimer: (update) => set((state) => ({
    eventTimer: {
      ...state.eventTimer,
      ...update,
      headings: update.headings
        ? { ...state.eventTimer.headings, ...update.headings }
        : state.eventTimer.headings,
      visibility: update.visibility
        ? { ...state.eventTimer.visibility, ...update.visibility }
        : state.eventTimer.visibility
    }
  })),
  setEventTimerOutput: (timer) => set({
    eventTimerOutput: timer
      ? { ...timer, headings: { ...timer.headings }, visibility: { ...timer.visibility } }
      : null
  }),
  setBroadcastTitles: (update) => set((state) => ({
    broadcastTitles: {
      ...state.broadcastTitles,
      ...update,
      speakers: (update.speakers ?? state.broadcastTitles.speakers).map((speaker) => ({
        id: String(speaker.id).slice(0, 80),
        name: String(speaker.name).slice(0, 120),
        role: String(speaker.role).slice(0, 180)
      })),
      eventLabel: (update.eventLabel ?? state.broadcastTitles.eventLabel).replace(/[\r\n\t]+/g, ' ').slice(0, 80),
      eventInfo: (update.eventInfo ?? state.broadcastTitles.eventInfo).replace(/\r/g, '').slice(0, 320),
      speakerAutoHideSeconds: Math.max(0, Math.min(86400, Math.round(
        update.speakerAutoHideSeconds ?? state.broadcastTitles.speakerAutoHideSeconds
      ))),
      speakerTextColor: normalizeBroadcastColor(update.speakerTextColor, state.broadcastTitles.speakerTextColor),
      speakerBackgroundStart: normalizeBroadcastColor(update.speakerBackgroundStart, state.broadcastTitles.speakerBackgroundStart),
      speakerBackgroundEnd: normalizeBroadcastColor(update.speakerBackgroundEnd, state.broadcastTitles.speakerBackgroundEnd),
      speakerAccentStart: normalizeBroadcastColor(update.speakerAccentStart, state.broadcastTitles.speakerAccentStart),
      speakerAccentEnd: normalizeBroadcastColor(update.speakerAccentEnd, state.broadcastTitles.speakerAccentEnd),
      eventAutoHideSeconds: Math.max(0, Math.min(86400, Math.round(
        update.eventAutoHideSeconds ?? state.broadcastTitles.eventAutoHideSeconds
      ))),
      eventTextColor: normalizeBroadcastColor(update.eventTextColor, state.broadcastTitles.eventTextColor),
      eventBackgroundStart: normalizeBroadcastColor(update.eventBackgroundStart, state.broadcastTitles.eventBackgroundStart),
      eventBackgroundEnd: normalizeBroadcastColor(update.eventBackgroundEnd, state.broadcastTitles.eventBackgroundEnd),
      eventAccentStart: normalizeBroadcastColor(update.eventAccentStart, state.broadcastTitles.eventAccentStart),
      eventAccentEnd: normalizeBroadcastColor(update.eventAccentEnd, state.broadcastTitles.eventAccentEnd)
    }
  })),
  setBroadcastTitlesOutput: (update) => set((state) => ({
    broadcastTitlesOutput: {
      ...state.broadcastTitlesOutput,
      ...update,
      speakerId: update.speakerId === undefined
        ? state.broadcastTitlesOutput.speakerId
        : update.speakerId?.slice(0, 80) || null,
      speakerName: (update.speakerName ?? state.broadcastTitlesOutput.speakerName).slice(0, 120),
      speakerRole: (update.speakerRole ?? state.broadcastTitlesOutput.speakerRole).slice(0, 180),
      eventLabel: (update.eventLabel ?? state.broadcastTitlesOutput.eventLabel).replace(/[\r\n\t]+/g, ' ').slice(0, 80),
      eventInfo: (update.eventInfo ?? state.broadcastTitlesOutput.eventInfo).replace(/\r/g, '').slice(0, 320),
      speakerAutoHideSeconds: Math.max(0, Math.min(86400, Math.round(
        update.speakerAutoHideSeconds ?? state.broadcastTitlesOutput.speakerAutoHideSeconds
      ))),
      speakerTextColor: normalizeBroadcastColor(update.speakerTextColor, state.broadcastTitlesOutput.speakerTextColor),
      speakerBackgroundStart: normalizeBroadcastColor(update.speakerBackgroundStart, state.broadcastTitlesOutput.speakerBackgroundStart),
      speakerBackgroundEnd: normalizeBroadcastColor(update.speakerBackgroundEnd, state.broadcastTitlesOutput.speakerBackgroundEnd),
      speakerAccentStart: normalizeBroadcastColor(update.speakerAccentStart, state.broadcastTitlesOutput.speakerAccentStart),
      speakerAccentEnd: normalizeBroadcastColor(update.speakerAccentEnd, state.broadcastTitlesOutput.speakerAccentEnd),
      eventAutoHideSeconds: Math.max(0, Math.min(86400, Math.round(
        update.eventAutoHideSeconds ?? state.broadcastTitlesOutput.eventAutoHideSeconds
      ))),
      eventTextColor: normalizeBroadcastColor(update.eventTextColor, state.broadcastTitlesOutput.eventTextColor),
      eventBackgroundStart: normalizeBroadcastColor(update.eventBackgroundStart, state.broadcastTitlesOutput.eventBackgroundStart),
      eventBackgroundEnd: normalizeBroadcastColor(update.eventBackgroundEnd, state.broadcastTitlesOutput.eventBackgroundEnd),
      eventAccentStart: normalizeBroadcastColor(update.eventAccentStart, state.broadcastTitlesOutput.eventAccentStart),
      eventAccentEnd: normalizeBroadcastColor(update.eventAccentEnd, state.broadcastTitlesOutput.eventAccentEnd)
    }
  })),

  setOverlayState: (state) => set({ overlayState: state }),

  releasePinnedPdfOverlay: () => {
    const { overlayState } = get()
    if (overlayState.kind !== 'pinned-pdf') return
    window.api.dbgLog('releasePinnedPdfOverlay: hiding matched target frame before PDF navigation')
    void window.api.hideOverlay()
    set({ overlayState: { kind: 'hidden' } })
  },

  // Navigate active PPTX. Если оверлей в pinned-pptx (висит после file-switch),
  // прячем его параллельно с PP-командой — DWM-гонка на hide попадает внутрь
  // PP slide-transition анимации и становится визуально неразличимой.
  //
  // Goto rapid-click collapsing: при быстрой навигации (5 нажатий next подряд)
  // все вызовы goto делят ОДИН inflight chain — pending target обновляется
  // на каждом клике, но в PP отправляется только текущий inflight + затем
  // финальный pending. Это предотвращает рассинхрон UI/PP когда оптимистичный
  // setCurrentSlide уходит вперёд, а PP не успевает (PP transitions ~200-500мс
  // каждый, retry-on-stuck может пропустить click). После collapsing PP
  // прыгает напрямую к финальному target — синхрон гарантирован.
  navigatePptx: async (command, arg, stopAtBoundary = false) => {
    window.api.dbgLog(
      `navigatePptx: ENTER command=${command} arg=${arg} ` +
      `typeof-arg=${typeof arg} stopAtBoundary=${stopAtBoundary}`
    )
    const { overlayState } = get()
    if (overlayState.kind === 'pinned-pptx') {
      window.api.hideOverlay()
      set({ overlayState: { kind: 'hidden' } })
    }
    if (command === 'goto' && typeof arg === 'number') {
      window.api.dbgLog(`navigatePptx: dispatching goto(${arg})`)
      return dispatchPptxGotoCollapsed(arg)
    }
    window.api.dbgLog(`navigatePptx: direct powerpointCommand(${command})`)
    return window.api.powerpointCommand(command, stopAtBoundary ? { stopAtBoundary: true } : undefined)
  },

  // Doc previews
  docPreviewsMap: {},

  // Music
  musicPlaylist: [],
  setMusicPlaylist: (files) => set({ musicPlaylist: files }),

  // Video playlist
  videoPlaylist: [],
  videoCurrentIndex: 0,
  videoIsPlaying: false,
  videoLoopTrack: false,
  videoLoopPlaylist: true,
  videoPlayback: {},
  setVideoPlaylist: (files) => set({ videoPlaylist: files }),
  setVideoCurrentIndex: (idx) => set({ videoCurrentIndex: idx }),
  setVideoIsPlaying: (playing) => set({ videoIsPlaying: playing }),
  setVideoLoopTrack: (v) => set({ videoLoopTrack: v }),
  setVideoLoopPlaylist: (v) => set({ videoLoopPlaylist: v }),
  setVideoPlayback: (path, state) => set((current) => ({
    videoPlayback: {
      ...current.videoPlayback,
      [path]: {
        currentTime: 0,
        duration: 0,
        playing: true,
        ...current.videoPlayback[path],
        ...state
      }
    }
  })),

  // Timer
  timerDuration: 0,
  timerRemaining: 0,
  timerRunning: false,
  timerSoundEnd: null,
  timerSoundWarning: null,
  timerOverlayPosition: { x: 90, y: 90 },
  timerOverlayScale: 1,
  timerTextColor: '#ffffff',
  timerWarningTextColor: '#facc15',
  timerOvertimeTextColor: '#ef4444',
  timerTextOpacity: 1,
  setTimerDuration: (seconds) => set({ timerDuration: seconds, timerRemaining: seconds }),
  setTimerRemaining: (seconds) => set({ timerRemaining: seconds }),
  setTimerRunning: (running) => set({ timerRunning: running }),
  addTimerMinutes: (minutes) => {
    const { timerDuration, timerRemaining } = get()
    set({
      timerDuration: Math.max(0, timerDuration + minutes * 60),
      timerRemaining: timerRemaining + minutes * 60
    })
  },
  resetTimer: () => {
    const { timerDuration } = get()
    set({ timerRemaining: timerDuration, timerRunning: false })
  },
  setTimerSoundEnd: (path) => set({ timerSoundEnd: path }),
  setTimerSoundWarning: (path) => set({ timerSoundWarning: path }),
  setTimerOverlayPosition: (pos) => set({ timerOverlayPosition: pos }),
  setTimerOverlayScale: (scale) => set({ timerOverlayScale: scale }),
  setTimerTextColor: (color) => set({ timerTextColor: color }),
  setTimerWarningTextColor: (color) => set({ timerWarningTextColor: color }),
  setTimerOvertimeTextColor: (color) => set({ timerOvertimeTextColor: color }),
  setTimerTextOpacity: (opacity) => set({ timerTextOpacity: Math.max(0.1, Math.min(1, opacity)) })
  }
  },
  {
    // Сохраняем user-preferences и подготовленную сетку каналов как локальный
    // crash-recovery снимок. При подтверждённом оператором закрытии main-процесс
    // удаляет workspace-поля из этого снимка; при падении запись остаётся и
    // восстанавливается на следующем запуске. live-channel/activeFile никогда
    // не сохраняются, поэтому эфир сам не запускается.
    //
    // NOT persist-ится:
    // - backdropImage — подложка относится только к текущему эфиру. Каждая
    //   новая сессия начинается без фона, пока оператор не выберет его снова;
    // - timerSoundEnd/Warning — юзер явно не хочет чтобы звуки подтягивались
    //   автоматом. Каждая сессия начинается с null.
    //
    // channelBoundaryNavigationEnabled is session-only: every launch starts
    // safely with the automatic channel transition disabled.
    // timerDuration/timerRemaining/timerRunning — runtime state, не persist.
    name: 'roland-app-preferences',
    version: 14,
    storage: createJSONStorage(() => localStorage),
    migrate: (persistedState, version) => {
      if (!persistedState || typeof persistedState !== 'object') return persistedState
      const migrated = { ...(persistedState as Record<string, unknown>) }
      // v1 → v2: timer sounds became session-only.
      if (version < 2) {
        delete migrated.timerSoundEnd
        delete migrated.timerSoundWarning
      }
      // v2 → v3: backdrop became session-only. This also clears the stale
      // path already saved by previous releases on the first v3 launch.
      if (version < 3) {
        delete migrated.backdropImage
      }
      // v3 -> v4: channel boundary navigation is deliberately session-only
      // and must start disabled on every application launch.
      if (version < 4) {
        delete migrated.channelBoundaryNavigationEnabled
      }
      // v5 -> v6: the agenda/message scene editor was replaced by a
      // session-only multimedia output for Display 3.
      if (version < 6) {
        delete migrated.informationScene
      }
      // v6 -> v7: fixed Display 1/2/3 roles became repeatable assignments.
      if (version < 7) {
        const assignments: DisplayAssignments = {}
        const selectedDisplayId = migrated.selectedDisplayId
        const speakerDisplayId = migrated.speakerDisplayId
        const informationDisplayId = migrated.informationDisplayId
        if (typeof selectedDisplayId === 'number') assignments[String(selectedDisplayId)] = 'program'
        if (typeof speakerDisplayId === 'number') assignments[String(speakerDisplayId)] = 'speaker'
        if (typeof informationDisplayId === 'number') assignments[String(informationDisplayId)] = 'information'
        migrated.displayAssignments = assignments
      }
      // v7 -> v8: timer output is controlled exclusively by display assignments.
      if (version < 8) {
        delete migrated.timerDisplayTarget
      }
      // v9 -> v10: a single speaker became a reusable speaker list and title
      // animation/position settings were added. Preserve the old draft.
      if (version < 10) {
        const rawTitles = migrated.broadcastTitles && typeof migrated.broadcastTitles === 'object'
          ? migrated.broadcastTitles as Record<string, unknown>
          : {}
        const oldName = typeof rawTitles.speakerName === 'string' ? rawTitles.speakerName.slice(0, 120) : ''
        const oldRole = typeof rawTitles.speakerRole === 'string' ? rawTitles.speakerRole.slice(0, 180) : ''
        const speakerId = oldName || oldRole ? 'speaker-migrated' : null
        migrated.broadcastTitles = {
          ...DEFAULT_BROADCAST_TITLES,
          speakers: speakerId ? [{ id: speakerId, name: oldName, role: oldRole }] : [],
          selectedSpeakerId: speakerId,
          eventInfo: typeof rawTitles.eventInfo === 'string'
            ? rawTitles.eventInfo.replace(/\r/g, '').slice(0, 320)
            : ''
        }
      }
      // v10 -> v11: the event title label became editable.
      if (version < 11) {
        const rawTitles = migrated.broadcastTitles && typeof migrated.broadcastTitles === 'object'
          ? migrated.broadcastTitles as Record<string, unknown>
          : {}
        migrated.broadcastTitles = {
          ...DEFAULT_BROADCAST_TITLES,
          ...rawTitles,
          eventLabel: typeof rawTitles.eventLabel === 'string'
            ? rawTitles.eventLabel.replace(/[\r\n\t]+/g, ' ').slice(0, 80)
            : DEFAULT_BROADCAST_TITLES.eventLabel
        }
      }
      // v11 -> v12: add reusable title shapes and customizable colors.
      if (version < 12) {
        const rawTitles = migrated.broadcastTitles && typeof migrated.broadcastTitles === 'object'
          ? migrated.broadcastTitles as Record<string, unknown>
          : {}
        migrated.broadcastTitles = {
          ...DEFAULT_BROADCAST_TITLES,
          ...rawTitles
        }
      }
      // v12 -> v13: replace the single clipped corner with two full-height
      // diagonal side variants. The old option maps to a slanted right side.
      if (version < 13) {
        const rawTitles = migrated.broadcastTitles && typeof migrated.broadcastTitles === 'object'
          ? migrated.broadcastTitles as Record<string, unknown>
          : {}
        migrated.broadcastTitles = {
          ...rawTitles,
          speakerStyle: rawTitles.speakerStyle === 'cut-corner' ? 'slant-right' : rawTitles.speakerStyle,
          eventStyle: rawTitles.eventStyle === 'cut-corner' ? 'slant-right' : rawTitles.eventStyle
        }
      }
      // v13 -> v14: the prepared channel workspace is now included in the
      // automatic crash-recovery snapshot. Runtime/live output stays omitted.
      return migrated
    },
    partialize: (state) => ({
      channels: state.channels,
      channelIds: state.channelIds,
      channelGridSize: state.channelGridSize,
      currentChannelPage: state.currentChannelPage,
      selectedChannel: state.selectedChannel,
      captureSources: state.captureSources,
      slidePositions: state.slidePositions,
      selectedDisplayId: state.selectedDisplayId,
      displayAssignments: state.displayAssignments,
      displayNames: state.displayNames,
      folderPath: state.folderPath,
      rootFolderPath: state.rootFolderPath,
      globalHookEnabled: state.globalHookEnabled,
      timerOverlayPosition: state.timerOverlayPosition,
      timerOverlayScale: state.timerOverlayScale,
      timerTextColor: state.timerTextColor,
      timerWarningTextColor: state.timerWarningTextColor,
      timerOvertimeTextColor: state.timerOvertimeTextColor,
      timerTextOpacity: state.timerTextOpacity,
      broadcastTitles: state.broadcastTitles,
    }),
  }
))
