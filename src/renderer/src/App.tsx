import { useEffect } from 'react'
import { useAppStore } from './stores/useAppStore'
import { FileLibrary } from './components/Library/FileLibrary'
import { PreviewPanel } from './components/Preview/PreviewPanel'
import { ControlBar } from './components/Controls/ControlBar'
import { Toolbar } from './components/Controls/Toolbar'
import { NowPlaying } from './components/Controls/NowPlaying'
import { SlideNavigator } from './components/SlideNavigator/SlideNavigator'

export default function App(): JSX.Element {
  const {
    setPresentationWindowOpen,
    setDisplays,
    setCurrentSlide,
    setTotalSlides,
    setIsPlaying
  } = useAppStore()

  useEffect(() => {
    window.api.getDisplays().then(setDisplays)

    const unsubClose = window.api.on('presentation-window-closed', () => {
      setPresentationWindowOpen(false)
    })

    const unsubDisplays = window.api.on('displays-changed', (...args: unknown[]) => {
      setDisplays(args[0] as DisplayInfo[])
    })

    const unsubSlideInfo = window.api.on('slide-info', (...args: unknown[]) => {
      const data = args[0] as { current: number; total: number }
      setCurrentSlide(data.current)
      setTotalSlides(data.total)
    })

    const unsubVideoState = window.api.on('video-state', (...args: unknown[]) => {
      const data = args[0] as { playing: boolean }
      setIsPlaying(data.playing)
    })

    const unsubVideoTime = window.api.on('video-time', (...args: unknown[]) => {
      const data = args[0] as { currentTime: number; duration: number }
      void data
    })

    let isNavigating = false

    const navigateSlide = async (direction: 'next' | 'prev'): Promise<void> => {
      if (isNavigating) return
      isNavigating = true
      try {
        const { activeFile, currentSlide, totalSlides } = useAppStore.getState()
        if (!activeFile) return

        if (activeFile.type === 'presentation') {
          // Get total from channel if top-level not set
          const state = useAppStore.getState()
          const ch = state.liveChannel === 'A' ? state.channelA : state.liveChannel === 'B' ? state.channelB : null
          const total = totalSlides || ch?.totalSlides || 0
          // Don't go past the last slide (would exit slideshow)
          if (direction === 'next' && total > 0 && currentSlide >= total) return
          if (direction === 'prev' && currentSlide <= 1) return
          const result = await window.api.powerpointCommand(direction === 'next' ? 'next' : 'prev')
          if (result.success && result.output) {
            try {
              const data = JSON.parse(result.output)
              if (data.CurrentSlide) useAppStore.getState().setCurrentSlide(data.CurrentSlide)
            } catch { /* ignore */ }
          }
        } else if (activeFile.type === 'pdf') {
          const isNext = direction === 'next'
          const newSlide = isNext
            ? Math.min(currentSlide + 1, totalSlides || currentSlide + 1)
            : Math.max(currentSlide - 1, 1)
          if (newSlide !== currentSlide) {
            useAppStore.getState().setCurrentSlide(newSlide)
            window.api.sendToPresentation('navigate-slide', newSlide)
          }
        }
      } finally {
        isNavigating = false
      }
    }

    const handleKeyDown = async (e: KeyboardEvent): Promise<void> => {
      const isNext = e.key === 'PageDown' || e.key === 'ArrowRight' || e.key === 'ArrowDown'
      const isPrev = e.key === 'PageUp' || e.key === 'ArrowLeft' || e.key === 'ArrowUp'
      if (!isNext && !isPrev) return
      e.preventDefault()
      navigateSlide(isNext ? 'next' : 'prev')
    }

    const unsubGlobalKey = window.api.on('global-key', (...args: unknown[]) => {
      const direction = args[0] as 'next' | 'prev'
      navigateSlide(direction)
    })

    window.addEventListener('keydown', handleKeyDown)

    return () => {
      unsubClose()
      unsubDisplays()
      unsubSlideInfo()
      unsubVideoState()
      unsubVideoTime()
      unsubGlobalKey()
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [])

  return (
    <div className="h-screen flex flex-col overflow-hidden dark">
      <Toolbar />
      <NowPlaying />
      <div className="flex flex-1 overflow-hidden">
        <FileLibrary />
        <div className="flex-1 flex flex-col overflow-hidden">
          <PreviewPanel />
          <ControlBar />
        </div>
        <SlideNavigator />
      </div>
    </div>
  )
}
