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

    const navigateSlide = async (direction: 'next' | 'prev'): Promise<void> => {
      const { activeFile, currentSlide, totalSlides } = useAppStore.getState()
      if (!activeFile) return

      if (activeFile.type === 'presentation') {
        // НЕ блокируем next/prev по slide index. На слайдах с pending
        // click-анимациями slide index не меняется при Next()/Previous() —
        // старые guard'ы ловили эти случаи и не пускали анимацию в daemon.
        // Для prev на первом слайде Previous() откатывает анимацию назад
        // (clickIndex уменьшается). Daemon сам останавливается на границах
        // через retry-on-stuck guards $sBefore < $total и $sBefore > 1.

        // View.Next()/Previous() — уважают click-анимации внутри слайда.
        // Если на слайде есть pending entrance-эффекты, Next() проиграет
        // следующий шаг, slide index не меняется. Когда все анимации
        // сыграны, Next() переходит на следующий слайд. UI обновляется
        // по фактическому slide от daemon (а не optimistic — иначе counter
        // обгонит PP когда тот ещё проигрывает анимацию на текущем).
        const cmd = direction === 'next' ? 'next' : 'prev'
        const result = await useAppStore.getState().navigatePptx(cmd)
        if (result?.success && result.output) {
          try {
            const data = JSON.parse(result.output)
            if (typeof data.CurrentSlide === 'number' && data.CurrentSlide > 0) {
              useAppStore.getState().setCurrentSlide(data.CurrentSlide)
            }
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
