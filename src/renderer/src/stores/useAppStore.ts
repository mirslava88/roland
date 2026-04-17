import { create } from 'zustand'

export type ContentType = 'presentation' | 'pdf' | 'video' | 'other' | null
export type FilterType = 'all' | 'presentation' | 'pdf' | 'video' | 'other'
export type ChannelId = 'A' | 'B' | 'C' | 'D'

export const CHANNEL_IDS: ChannelId[] = ['A', 'B', 'C', 'D']

export interface ChannelState {
  file: FileEntry | null
  slide: number
  totalSlides: number
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
  displays: DisplayInfo[]
  selectedDisplayId: number | null
  backdropImage: string | null
  globalHookEnabled: boolean

  channelA: ChannelState
  channelB: ChannelState
  channelC: ChannelState
  channelD: ChannelState
  liveChannel: ChannelId | null
  selectedChannel: ChannelId | null

  setSelectedChannel: (ch: ChannelId | null) => void
  setChannelFile: (ch: ChannelId, file: FileEntry | null) => void
  setChannelSlide: (ch: ChannelId, slide: number) => void
  setChannelTotalSlides: (ch: ChannelId, total: number) => void
  setLiveChannel: (ch: ChannelId) => void

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

export const useAppStore = create<AppState>((set, get) => ({
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
  displays: [],
  selectedDisplayId: null,
  backdropImage: null,
  globalHookEnabled: true,

  channelA: { file: null, slide: 1, totalSlides: 0 },
  channelB: { file: null, slide: 1, totalSlides: 0 },
  channelC: { file: null, slide: 1, totalSlides: 0 },
  channelD: { file: null, slide: 1, totalSlides: 0 },
  liveChannel: null,
  selectedChannel: null,

  setSelectedChannel: (ch) => set({ selectedChannel: ch }),
  setChannelFile: (ch, file) => {
    const key = `channel${ch}` as const
    const { slidePositions } = get()
    const saved = file ? slidePositions[file.path] || 1 : 1
    set({ [key]: { file, slide: saved, totalSlides: 0 } })
  },

  setChannelSlide: (ch, slide) => {
    const key = `channel${ch}` as const
    const channel = get()[key]
    const { slidePositions, liveChannel } = get()
    if (channel.file) {
      slidePositions[channel.file.path] = slide
    }
    const updates: Partial<AppState> = { [key]: { ...channel, slide }, slidePositions: { ...slidePositions } }
    // Sync currentSlide if this is the live channel
    if (liveChannel === ch) {
      updates.currentSlide = slide
    }
    set(updates)
  },

  setChannelTotalSlides: (ch, total) => {
    const key = `channel${ch}` as const
    const channel = get()[key]
    set({ [key]: { ...channel, totalSlides: total } })
  },

  setLiveChannel: (ch) => {
    const key = `channel${ch}` as const
    const channel = get()[key]
    if (channel.file) {
      set({ liveChannel: ch, activeFile: channel.file, currentSlide: channel.slide })
    }
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
    const { liveChannel } = state
    const updates: Partial<AppState> = { currentSlide: slide }
    if (liveChannel) {
      const key = `channel${liveChannel}` as const
      updates[key] = { ...state[key], slide }
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

  // Doc previews
  docPreviewsMap: {},

  // Music
  musicPlaylist: [],
  setMusicPlaylist: (files) => set({ musicPlaylist: files }),

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
}))
