import { create } from 'zustand'

export type ContentType = 'presentation' | 'pdf' | 'video' | null
export type FilterType = 'all' | 'presentation' | 'pdf' | 'video'

export interface ChannelState {
  file: FileEntry | null
  slide: number
  totalSlides: number
}

interface AppState {
  folderPath: string | null
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

  channelA: ChannelState
  channelB: ChannelState
  liveChannel: 'A' | 'B' | null

  setChannelFile: (ch: 'A' | 'B', file: FileEntry | null) => void
  setChannelSlide: (ch: 'A' | 'B', slide: number) => void
  setChannelTotalSlides: (ch: 'A' | 'B', total: number) => void
  setLiveChannel: (ch: 'A' | 'B') => void

  setPptxThumbnails: (thumbnails: string[]) => void
  setFolderPath: (path: string | null) => void
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
}

export const useAppStore = create<AppState>((set, get) => ({
  folderPath: null,
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

  channelA: { file: null, slide: 1, totalSlides: 0 },
  channelB: { file: null, slide: 1, totalSlides: 0 },
  liveChannel: null,

  setChannelFile: (ch, file) => {
    const key = ch === 'A' ? 'channelA' : 'channelB'
    const { slidePositions } = get()
    const saved = file ? slidePositions[file.path] || 1 : 1
    set({ [key]: { file, slide: saved, totalSlides: 0 } })
  },

  setChannelSlide: (ch, slide) => {
    const key = ch === 'A' ? 'channelA' : 'channelB'
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
    const key = ch === 'A' ? 'channelA' : 'channelB'
    const channel = get()[key]
    set({ [key]: { ...channel, totalSlides: total } })
  },

  setLiveChannel: (ch) => {
    const key = ch === 'A' ? 'channelA' : 'channelB'
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
    const { liveChannel, channelA, channelB } = get()
    const updates: Partial<AppState> = { currentSlide: slide }
    if (liveChannel === 'A') updates.channelA = { ...channelA, slide }
    if (liveChannel === 'B') updates.channelB = { ...channelB, slide }
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
  setBackdropImage: (path) => set({ backdropImage: path })
}))
