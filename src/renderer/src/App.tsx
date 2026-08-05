import { useEffect } from 'react'
import { useAppStore } from './stores/useAppStore'
import { FileLibrary } from './components/Library/FileLibrary'
import { PreviewPanel } from './components/Preview/PreviewPanel'
import { ControlBar } from './components/Controls/ControlBar'
import { Toolbar } from './components/Controls/Toolbar'
import { NowPlaying } from './components/Controls/NowPlaying'
import { SlideNavigator } from './components/SlideNavigator/SlideNavigator'
import { OperatorCursorGuard } from './components/Capture/OperatorCursorGuard'
import { queueNavigationDuringTransition } from './navigation-transition'
import type { NavigationRequest } from './navigation-transition'
import { takeAdjacentChannel } from './channel-boundary-navigation'

export default function App(): JSX.Element {
  const {
    captureSources,
    setPresentationWindowOpen,
    setDisplays,
    setCurrentSlide,
    setTotalSlides,
    setIsPlaying
  } = useAppStore()

  // Window-capture streams stay alive to feed operator thumbnails even while
  // another channel is on air. Guarding only the live source therefore lets
  // the native cursor leak into those background preview frames. Keep the
  // guard active whenever at least one program-window source is registered;
  // OperatorCursorGuard itself applies it only while PDM has focus.
  const protectCapturedWindowFromOperatorCursor = captureSources.some((source) => (
    source.capture?.captureKind === 'desktop' &&
    (
      source.capture.desktopSourceType === 'window' ||
      (!source.capture.desktopSourceType && source.capture.desktopSourceId?.startsWith('window:'))
    )
  ))

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
      const data = args[0] as { path?: string; playing: boolean; currentTime?: number; duration?: number; ended?: boolean }
      setIsPlaying(data.playing)
      if (data.path) {
        useAppStore.getState().setVideoPlayback(data.path, {
          currentTime: data.ended ? 0 : (data.currentTime ?? 0),
          duration: data.duration ?? 0,
          playing: data.playing
        })
      }
    })

    const unsubVideoTime = window.api.on('video-time', (...args: unknown[]) => {
      const data = args[0] as { path?: string; currentTime: number; duration: number }
      if (data.path) {
        useAppStore.getState().setVideoPlayback(data.path, {
          currentTime: data.currentTime,
          duration: data.duration
        })
      }
    })

    const navigateSlide = async (direction: 'next' | 'prev'): Promise<void> => {
      if (queueNavigationDuringTransition(direction)) return

      const {
        activeFile,
        currentSlide,
        totalSlides,
        channelBoundaryNavigationEnabled,
        liveChannel
      } = useAppStore.getState()
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
        const result = await useAppStore.getState().navigatePptx(
          cmd,
          undefined,
          channelBoundaryNavigationEnabled
        )
        if (result?.success && result.output) {
          try {
            const data = JSON.parse(result.output)
            if (typeof data.CurrentSlide === 'number' && data.CurrentSlide > 0) {
              useAppStore.getState().setCurrentSlide(data.CurrentSlide)
            }
            if (data.Boundary === true) {
              const latest = useAppStore.getState()
              if (
                latest.liveChannel === liveChannel &&
                latest.activeFile?.path === activeFile.path
              ) {
                takeAdjacentChannel(direction)
              }
            }
          } catch { /* ignore */ }
        }
      } else if (activeFile.type === 'pdf') {
        const atBoundary = totalSlides > 0 && (
          (direction === 'next' && currentSlide >= totalSlides) ||
          (direction === 'prev' && currentSlide <= 1)
        )
        if (channelBoundaryNavigationEnabled && atBoundary) {
          takeAdjacentChannel(direction)
          return
        }
        // Let the output window advance from the page it has actually drawn.
        // An absolute, optimistic page number can race with PDF initialization:
        // the control store moves to page 2, then the late page-1 ready signal
        // overwrites it, so the next physical click only repeats page 2. The
        // output is the source of truth and acknowledges the applied page via
        // slide-info immediately.
        window.api.dbgLog(
          `App: PDF navigate direction=${direction} control=${currentSlide}/${totalSlides} file=${activeFile.path}`
        )
        window.dispatchEvent(new Event('pdf-navigation-priority'))
        useAppStore.getState().releasePinnedPdfOverlay()
        window.api.sendToPresentation('navigate-pdf', direction)
      }
    }

    const handleKeyDown = async (e: KeyboardEvent): Promise<void> => {
      const isNext = e.key === 'PageDown' || e.key === 'ArrowRight' || e.key === 'ArrowDown'
      const isPrev = e.key === 'PageUp' || e.key === 'ArrowLeft' || e.key === 'ArrowUp'
      if (!isNext && !isPrev) return
      window.api.dbgLog(
        `App: local keydown key=${e.key} code=${e.code} repeat=${e.repeat} next=${isNext}`
      )
      e.preventDefault()
      navigateSlide(isNext ? 'next' : 'prev')
    }

    const unsubGlobalKey = window.api.on('global-key', (...args: unknown[]) => {
      const direction = args[0] as 'next' | 'prev'
      window.api.dbgLog(`App: global-key received direction=${direction}`)
      navigateSlide(direction)
    })

    const flushQueuedNavigation = (event: Event): void => {
      const requests = (event as CustomEvent<NavigationRequest[]>).detail || []
      void (async () => {
        window.api.dbgLog(`App: flushing queued navigation count=${requests.length}`)
        for (const request of requests) {
          if (request.kind === 'relative') {
            await navigateSlide(request.direction)
            continue
          }

          const { activeFile } = useAppStore.getState()
          if (activeFile?.type === 'presentation') {
            await useAppStore.getState().navigatePptx('goto', request.slide)
          } else if (activeFile?.type === 'pdf') {
            useAppStore.getState().releasePinnedPdfOverlay()
            window.api.sendToPresentation('navigate-slide', request.slide)
          }
        }
      })()
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('flush-take-navigation', flushQueuedNavigation)

    return () => {
      unsubClose()
      unsubDisplays()
      unsubSlideInfo()
      unsubVideoState()
      unsubVideoTime()
      unsubGlobalKey()
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('flush-take-navigation', flushQueuedNavigation)
    }
  }, [])

  return (
    <div className="h-screen flex flex-col overflow-hidden dark">
      <Toolbar />
      <NowPlaying />
      <OperatorCursorGuard enabled={protectCapturedWindowFromOperatorCursor} />
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
