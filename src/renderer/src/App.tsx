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

    const handleKeyDown = async (e: KeyboardEvent): Promise<void> => {
      const { activeFile, currentSlide, totalSlides } = useAppStore.getState()
      if (!activeFile) return

      const isNext = e.key === 'PageDown' || e.key === 'ArrowRight' || e.key === 'ArrowDown'
      const isPrev = e.key === 'PageUp' || e.key === 'ArrowLeft' || e.key === 'ArrowUp'
      if (!isNext && !isPrev) return
      e.preventDefault()

      if (activeFile.type === 'presentation') {
        const result = await window.api.powerpointCommand(isNext ? 'next' : 'prev')
        if (result.success && result.output) {
          try {
            const data = JSON.parse(result.output)
            if (data.CurrentSlide) useAppStore.getState().setCurrentSlide(data.CurrentSlide)
          } catch { /* ignore */ }
        }
      } else if (activeFile.type === 'pdf') {
        const newSlide = isNext
          ? Math.min(currentSlide + 1, totalSlides || currentSlide + 1)
          : Math.max(currentSlide - 1, 1)
        if (newSlide !== currentSlide) {
          useAppStore.getState().setCurrentSlide(newSlide)
          window.api.sendToPresentation('navigate-slide', newSlide)
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)

    return () => {
      unsubClose()
      unsubSlideInfo()
      unsubVideoState()
      unsubVideoTime()
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
