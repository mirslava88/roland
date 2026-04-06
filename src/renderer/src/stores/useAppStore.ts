import { create } from 'zustand'

export type ContentType = 'presentation' | 'pdf' | 'video' | null
export type FilterType = 'all' | 'presentation' | 'pdf' | 'video'

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
  displays: DisplayInfo[]
  selectedDisplayId: number | null

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
  displays: [],
  selectedDisplayId: null,

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
    // Save position of the file we're leaving
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

  setCurrentSlide: (slide) => set({ currentSlide: slide }),

  setTotalSlides: (total) => set({ totalSlides: total }),

  saveSlidePosition: () => {
    const { activeFile, currentSlide, slidePositions } = get()
    if (activeFile) {
      set({ slidePositions: { ...slidePositions, [activeFile.path]: currentSlide } })
    }
  },

  setDisplays: (displays) => set({ displays }),

  setSelectedDisplayId: (id) => set({ selectedDisplayId: id })
}))
