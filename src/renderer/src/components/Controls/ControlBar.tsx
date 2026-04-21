import { useState, useEffect, useRef } from 'react'
import { useAppStore } from '../../stores/useAppStore'

export function ControlBar(): JSX.Element {
  const {
    activeFile,
    isPlaying,
    setIsPlaying,
    currentSlide,
    totalSlides,
    setCurrentSlide,
    navigatePptx,
  } = useAppStore()

  const [goToSlide, setGoToSlide] = useState('')
  const [videoLoop, setVideoLoop] = useState(false)
  const [videoTime, setVideoTime] = useState(0)
  const [videoDuration, setVideoDuration] = useState(0)
  const pendingNavCount = useRef(0)

  // Listen for video time/state updates from presentation window
  useEffect(() => {
    const unsubTime = window.api.on('video-time', (...args: unknown[]) => {
      const data = args[0] as { currentTime: number; duration: number }
      setVideoTime(data.currentTime)
      setVideoDuration(data.duration)
    })
    const unsubState = window.api.on('video-state', (...args: unknown[]) => {
      const data = args[0] as { playing: boolean; duration: number; currentTime: number }
      setVideoTime(data.currentTime)
      setVideoDuration(data.duration)
      setIsPlaying(data.playing)
    })
    return () => { unsubTime(); unsubState() }
  }, [])

  if (!activeFile) {
    return (
      <div className="h-16 bg-surface-300 border-t border-gray-800 flex items-center justify-center text-gray-600 text-sm shrink-0">
        Трансляция остановлена
      </div>
    )
  }

  const handlePptxNav = (direction: 'next' | 'prev'): void => {
    const optimistic = direction === 'next' ? currentSlide + 1 : currentSlide - 1
    setCurrentSlide(optimistic)
    pendingNavCount.current++
    navigatePptx(direction).then((result) => {
      pendingNavCount.current--
      if (pendingNavCount.current > 0) return
      if (result.success && result.output) {
        try {
          const data = JSON.parse(result.output)
          if (typeof data.CurrentSlide === 'number' && data.CurrentSlide > 0) {
            useAppStore.getState().setCurrentSlide(data.CurrentSlide)
          }
        } catch { /* ignore */ }
      }
    }).catch(() => { pendingNavCount.current-- })
  }

  const handlePrev = (): void => {
    if (currentSlide <= 1) return

    if (activeFile.type === 'presentation') {
      handlePptxNav('prev')
    } else if (activeFile.type === 'pdf') {
      const newSlide = currentSlide - 1
      setCurrentSlide(newSlide)
      window.api.sendToPresentation('navigate-slide', newSlide)
    }
  }

  const handleNext = (): void => {
    if (totalSlides > 0 && currentSlide >= totalSlides) return

    if (activeFile.type === 'presentation') {
      handlePptxNav('next')
    } else if (activeFile.type === 'pdf') {
      const newSlide = currentSlide + 1
      setCurrentSlide(newSlide)
      window.api.sendToPresentation('navigate-slide', newSlide)
    }
  }

  const handleGoToSlide = (): void => {
    const num = parseInt(goToSlide)
    if (num < 1 || (totalSlides > 0 && num > totalSlides)) return

    if (activeFile.type === 'presentation') {
      setCurrentSlide(num)
      pendingNavCount.current++
      navigatePptx('goto', num).then((result) => {
        pendingNavCount.current--
        if (pendingNavCount.current > 0) return
        if (result.success && result.output) {
          try {
            const data = JSON.parse(result.output)
            if (typeof data.CurrentSlide === 'number' && data.CurrentSlide > 0) {
              useAppStore.getState().setCurrentSlide(data.CurrentSlide)
            }
          } catch { /* ignore */ }
        }
      }).catch(() => { pendingNavCount.current-- })
    } else if (activeFile.type === 'pdf') {
      setCurrentSlide(num)
      window.api.sendToPresentation('navigate-slide', num)
    }
    setGoToSlide('')
  }

  const formatTime = (s: number): string => {
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60)
    return `${m}:${sec.toString().padStart(2, '0')}`
  }

  const handlePlayPause = (): void => {
    const newState = !isPlaying
    setIsPlaying(newState)
    window.api.sendToPresentation('play-pause', newState)
  }

  const handleStop = (): void => {
    setIsPlaying(false)
    setVideoTime(0)
    window.api.sendToPresentation('stop')
  }

  const handleVideoSeek = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const time = parseFloat(e.target.value)
    setVideoTime(time)
    window.api.sendToPresentation('seek', time)
  }

  return (
    <div className="h-16 bg-surface-300 border-t border-gray-800 flex items-center justify-center px-4 gap-4 shrink-0">
      {activeFile.type === 'video' && (
        <div className="flex items-center gap-2 flex-1">
          <button onClick={handlePlayPause} className="btn-icon text-lg">
            {isPlaying ? '⏸' : '▶'}
          </button>
          <button onClick={handleStop} className="btn-icon text-lg">
            ⏹
          </button>
          <button
            onClick={() => {
              const newLoop = !videoLoop
              setVideoLoop(newLoop)
              window.api.sendToPresentation('set-loop', newLoop)
            }}
            className={`btn-icon text-sm px-2 py-1 rounded transition-colors ${
              videoLoop ? 'bg-blue-600/80 text-white' : 'text-gray-400'
            }`}
            title={videoLoop ? 'Зацикливание ВКЛ' : 'Зацикливание видео'}
          >
            🔁
          </button>

          <div className="w-px h-8 bg-gray-800 mx-1" />

          <span className="text-[10px] text-gray-400 tabular-nums w-[38px] text-right">
            {formatTime(videoTime)}
          </span>
          <input
            type="range"
            min={0}
            max={videoDuration > 0 ? videoDuration : 100}
            step={0.5}
            value={videoTime}
            onChange={handleVideoSeek}
            disabled={videoDuration === 0}
            className="flex-1 h-1 accent-blue-500 disabled:opacity-30 min-w-[120px]"
          />
          <span className="text-[10px] text-gray-400 tabular-nums w-[38px]">
            {formatTime(videoDuration)}
          </span>
        </div>
      )}

      {(activeFile.type === 'pdf' || activeFile.type === 'presentation') && (
        <div className="flex items-center gap-2">
          <button
            onClick={handlePrev}
            disabled={currentSlide <= 1}
            className="btn-icon text-sm disabled:opacity-30"
          >
            ◀
          </button>

          <span className="text-sm text-gray-300 min-w-[80px] text-center tabular-nums">
            {currentSlide} / {totalSlides || '—'}
          </span>

          <button
            onClick={handleNext}
            disabled={totalSlides > 0 && currentSlide >= totalSlides}
            className="btn-icon text-sm disabled:opacity-30"
          >
            ▶
          </button>

          <div className="w-px h-6 bg-gray-800 mx-1" />

          <input
            type="text"
            value={goToSlide}
            onChange={(e) => setGoToSlide(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleGoToSlide()}
            placeholder="№ слайда"
            className="w-24 bg-surface-100 text-gray-300 text-xs rounded-md px-2 py-1.5 border border-gray-700 focus:outline-none focus:border-accent"
          />
        </div>
      )}
    </div>
  )
}
