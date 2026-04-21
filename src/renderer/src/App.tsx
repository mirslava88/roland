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

  // Enable native file drops from Windows Explorer:
  // 1. dragover preventDefault — tells browser "this element accepts drops"
  // 2. drop preventDefault — prevents Electron from navigating to the dropped file
  // Both use ONLY preventDefault (NOT stopPropagation) so React handlers still fire.
  // React synthetic event handlers fire BEFORE document-level handlers in bubble phase.
  useEffect(() => {
    const onDragOver = (e: DragEvent): void => { e.preventDefault() }
    const onDrop = (e: DragEvent): void => { e.preventDefault() }
    document.addEventListener('dragover', onDragOver)
    document.addEventListener('drop', onDrop)
    return () => {
      document.removeEventListener('dragover', onDragOver)
      document.removeEventListener('drop', onDrop)
    }
  }, [])

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

    let pendingNavCount = 0

    const navigateSlide = async (direction: 'next' | 'prev'): Promise<void> => {
      const { activeFile, currentSlide, totalSlides } = useAppStore.getState()
      if (!activeFile) return

      if (activeFile.type === 'presentation') {
        const state = useAppStore.getState()
        const ch = state.liveChannel ? state[`channel${state.liveChannel}` as const] : null
        const total = totalSlides || ch?.totalSlides || 0
        // Don't go past the last slide (would exit slideshow)
        if (direction === 'next' && total > 0 && currentSlide >= total) return
        if (direction === 'prev' && currentSlide <= 1) return

        // Optimistic UI update — instant feedback.
        const optimistic = direction === 'next' ? currentSlide + 1 : currentSlide - 1
        useAppStore.getState().setCurrentSlide(optimistic)

        // Reconcile with real slide index from PowerPoint.
        // Only the LAST in a rapid burst reconciles — avoids UI bouncing
        // when user clicks faster than PPT responds.
        pendingNavCount++
        useAppStore.getState().navigatePptx(direction).then((result) => {
          pendingNavCount--
          if (pendingNavCount > 0) return
          if (result.success && result.output) {
            try {
              const data = JSON.parse(result.output)
              if (typeof data.CurrentSlide === 'number' && data.CurrentSlide > 0) {
                useAppStore.getState().setCurrentSlide(data.CurrentSlide)
              }
            } catch { /* ignore */ }
          }
        }).catch(() => { pendingNavCount-- })
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
