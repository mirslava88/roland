import { create } from 'zustand'

export type ContentType = 'presentation' | 'pdf' | 'video' | 'other' | null
export type FilterType = 'all' | 'presentation' | 'pdf' | 'video' | 'other'
export type ChannelId = string

export type OverlayState =
  | { kind: 'hidden' }
  | { kind: 'pinned-pptx'; pptxPath: string }

export const CHANNELS_PER_PAGE = 4

// 0 -> 'A' ... 25 -> 'Z' ... 26 -> 'AA' ... 27 -> 'AB'
export function channelIdFromIndex(i: number): ChannelId {
  let n = i
  let result = ''
  while (true) {
    result = String.fromCharCode(65 + (n % 26)) + result
    n = Math.floor(n / 26) - 1
    if (n < 0) break
  }
  return result
}

export interface ChannelState {
  file: FileEntry | null
  slide: number
  totalSlides: number
}

const EMPTY_CHANNEL: ChannelState = { file: null, slide: 1, totalSlides: 0 }

function makeInitialChannels(): { channels: Record<ChannelId, ChannelState>; channelIds: ChannelId[] } {
  const channelIds: ChannelId[] = []
  const channels: Record<ChannelId, ChannelState> = {}
  for (let i = 0; i < CHANNELS_PER_PAGE; i++) {
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
  displays: DisplayInfo[]
  selectedDisplayId: number | null
  backdropImage: string | null
  globalHookEnabled: boolean

  overlayState: OverlayState
  setOverlayState: (state: OverlayState) => void
  navigatePptx: (command: 'next' | 'prev' | 'goto', arg?: number) => Promise<{ success: boolean; output?: string; error?: string }>

  channels: Record<ChannelId, ChannelState>
  channelIds: ChannelId[]
  currentChannelPage: number
  liveChannel: ChannelId | null
  selectedChannel: ChannelId | null

  setSelectedChannel: (ch: ChannelId | null) => void
  setChannelFile: (ch: ChannelId, file: FileEntry | null) => void
  setChannelSlide: (ch: ChannelId, slide: number) => void
  setChannelTotalSlides: (ch: ChannelId, total: number) => void
  setLiveChannel: (ch: ChannelId) => void
  addChannelPage: () => void
  removeChannelPage: (page: number) => void
  setCurrentChannelPage: (page: number) => void

  setPptxThumbnails: (thumbnails: string[]) => void
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
  setDisplays: (displays: DisplayInfo[]) => void
  setSelectedDisplayId: (id: number | null) => void
  setBackdropImage: (path: string | null) => void
  setGlobalHookEnabled: (enabled: boolean) => void

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
  setVideoPlaylist: (files: string[]) => void
  setVideoCurrentIndex: (idx: number) => void
  setVideoIsPlaying: (playing: boolean) => void
  setVideoLoopTrack: (v: boolean) => void
  setVideoLoopPlaylist: (v: boolean) => void

  // Timer
  timerDuration: number // total seconds set
  timerRemaining: number // seconds remaining (negative = overtime)
  timerRunning: boolean
  timerSoundEnd: string | null
  timerSoundWarning: string | null
  timerOverlayPosition: { x: number; y: number } // percent from top-left
  timerOverlayScale: number
  setTimerDuration: (seconds: number) => void
  setTimerRemaining: (seconds: number) => void
  setTimerRunning: (running: boolean) => void
  addTimerMinutes: (minutes: number) => void
  resetTimer: () => void
  setTimerSoundEnd: (path: string | null) => void
  setTimerSoundWarning: (path: string | null) => void
  setTimerOverlayPosition: (pos: { x: number; y: number }) => void
  setTimerOverlayScale: (scale: number) => void
}

export const useAppStore = create<AppState>((set, get) => {
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
  displays: [],
  selectedDisplayId: null,
  backdropImage: null,
  globalHookEnabled: true,

  overlayState: { kind: 'hidden' } as OverlayState,

  channels: initial.channels,
  channelIds: initial.channelIds,
  currentChannelPage: 0,
  liveChannel: null,
  selectedChannel: null,

  setSelectedChannel: (ch) => set({ selectedChannel: ch }),

  setChannelFile: (ch, file) => {
    const { channels, slidePositions } = get()
    const saved = file ? slidePositions[file.path] || 1 : 1
    set({
      channels: { ...channels, [ch]: { file, slide: saved, totalSlides: 0 } }
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

  setLiveChannel: (ch) => {
    const { channels } = get()
    const channel = channels[ch]
    if (channel?.file) {
      set({ liveChannel: ch, activeFile: channel.file, currentSlide: channel.slide })
    }
  },

  addChannelPage: () => {
    const { channels, channelIds } = get()
    const startIdx = channelIds.length
    const newChannels = { ...channels }
    const newIds = [...channelIds]
    for (let i = 0; i < CHANNELS_PER_PAGE; i++) {
      const id = channelIdFromIndex(startIdx + i)
      newIds.push(id)
      newChannels[id] = { ...EMPTY_CHANNEL }
    }
    const newPage = Math.floor(startIdx / CHANNELS_PER_PAGE)
    set({ channels: newChannels, channelIds: newIds, currentChannelPage: newPage })
  },

  removeChannelPage: (page) => {
    const { channels, channelIds, currentChannelPage, liveChannel, selectedChannel } = get()
    const totalPages = Math.ceil(channelIds.length / CHANNELS_PER_PAGE)
    // Can't remove last remaining page (always keep at least one)
    if (totalPages <= 1) return
    const start = page * CHANNELS_PER_PAGE
    const pageIds = channelIds.slice(start, start + CHANNELS_PER_PAGE)
    // Only remove if all channels on that page are empty
    const hasFiles = pageIds.some((id) => channels[id]?.file)
    if (hasFiles) return
    // Don't orphan live/selected channel
    if (liveChannel && pageIds.includes(liveChannel)) return
    const newIds = [...channelIds.slice(0, start), ...channelIds.slice(start + CHANNELS_PER_PAGE)]
    const newChannels = { ...channels }
    for (const id of pageIds) delete newChannels[id]
    let newPage = currentChannelPage
    if (newPage >= Math.ceil(newIds.length / CHANNELS_PER_PAGE)) {
      newPage = Math.max(0, Math.ceil(newIds.length / CHANNELS_PER_PAGE) - 1)
    }
    const newSelected = selectedChannel && pageIds.includes(selectedChannel) ? null : selectedChannel
    set({
      channels: newChannels,
      channelIds: newIds,
      currentChannelPage: newPage,
      selectedChannel: newSelected
    })
  },

  setCurrentChannelPage: (page) => {
    const { channelIds } = get()
    const totalPages = Math.ceil(channelIds.length / CHANNELS_PER_PAGE)
    const clamped = Math.max(0, Math.min(page, totalPages - 1))
    set({ currentChannelPage: clamped })
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

  setDisplays: (displays) => set({ displays }),

  setSelectedDisplayId: (id) => set({ selectedDisplayId: id }),
  setBackdropImage: (path) => set({ backdropImage: path }),
  setGlobalHookEnabled: (enabled) => set({ globalHookEnabled: enabled }),

  setOverlayState: (state) => set({ overlayState: state }),

  // Navigate active PPTX. Если оверлей в pinned-pptx (висит после file-switch),
  // прячем его параллельно с PP-командой — DWM-гонка на hide попадает внутрь
  // PP slide-transition анимации и становится визуально неразличимой.
  navigatePptx: async (command, arg) => {
    const { overlayState } = get()
    if (overlayState.kind === 'pinned-pptx') {
      window.api.hideOverlay()
      set({ overlayState: { kind: 'hidden' } })
    }
    if (command === 'goto' && typeof arg === 'number') {
      return window.api.powerpointCommand('goto', arg)
    }
    return window.api.powerpointCommand(command)
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
  setVideoPlaylist: (files) => set({ videoPlaylist: files }),
  setVideoCurrentIndex: (idx) => set({ videoCurrentIndex: idx }),
  setVideoIsPlaying: (playing) => set({ videoIsPlaying: playing }),
  setVideoLoopTrack: (v) => set({ videoLoopTrack: v }),
  setVideoLoopPlaylist: (v) => set({ videoLoopPlaylist: v }),

  // Timer
  timerDuration: 0,
  timerRemaining: 0,
  timerRunning: false,
  timerSoundEnd: null,
  timerSoundWarning: null,
  timerOverlayPosition: { x: 90, y: 90 },
  timerOverlayScale: 1,
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
  setTimerOverlayScale: (scale) => set({ timerOverlayScale: scale })
  }
})
