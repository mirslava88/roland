import { useState } from 'react'
import { useAppStore } from '../../stores/useAppStore'

export function ControlBar(): JSX.Element {
  const {
    activeFile,
    isPlaying,
    setIsPlaying,
    currentSlide,
    totalSlides,
    setCurrentSlide,
    isPresentationWindowOpen,
    filteredFiles,
    setActiveFile
  } = useAppStore()

  const [goToSlide, setGoToSlide] = useState('')

  if (!activeFile) {
    return (
      <div className="h-16 bg-surface-300 border-t border-gray-800 flex items-center justify-center text-gray-600 text-sm shrink-0">
        No active content
      </div>
    )
  }

  const currentIndex = filteredFiles.findIndex((f) => f.id === activeFile.id)
  const hasPrev = currentIndex > 0
  const hasNext = currentIndex < filteredFiles.length - 1

  const handlePrev = async (): Promise<void> => {
    if (currentSlide <= 1) return

    if (activeFile.type === 'presentation') {
      const result = await window.api.powerpointCommand('prev')
      if (result.success && result.output) {
        try {
          const data = JSON.parse(result.output)
          if (data.CurrentSlide) setCurrentSlide(data.CurrentSlide)
        } catch { setCurrentSlide(currentSlide - 1) }
      }
    } else if (activeFile.type === 'pdf') {
      const newSlide = currentSlide - 1
      setCurrentSlide(newSlide)
      window.api.sendToPresentation('navigate-slide', newSlide)
    }
  }

  const handleNext = async (): Promise<void> => {
    if (totalSlides > 0 && currentSlide >= totalSlides) return

    if (activeFile.type === 'presentation') {
      const result = await window.api.powerpointCommand('next')
      if (result.success && result.output) {
        try {
          const data = JSON.parse(result.output)
          if (data.CurrentSlide) setCurrentSlide(data.CurrentSlide)
        } catch { setCurrentSlide(currentSlide + 1) }
      }
    } else if (activeFile.type === 'pdf') {
      const newSlide = currentSlide + 1
      setCurrentSlide(newSlide)
      window.api.sendToPresentation('navigate-slide', newSlide)
    }
  }

  const handleGoToSlide = async (): Promise<void> => {
    const num = parseInt(goToSlide)
    if (num < 1 || (totalSlides > 0 && num > totalSlides)) return

    if (activeFile.type === 'presentation') {
      const result = await window.api.powerpointCommand('goto', num)
      if (result.success) setCurrentSlide(num)
    } else if (activeFile.type === 'pdf') {
      setCurrentSlide(num)
      window.api.sendToPresentation('navigate-slide', num)
    }
    setGoToSlide('')
  }

  const handlePlayPause = (): void => {
    const newState = !isPlaying
    setIsPlaying(newState)
    window.api.sendToPresentation('play-pause', newState)
  }

  const handleStop = (): void => {
    setIsPlaying(false)
    window.api.sendToPresentation('stop')
  }

  const switchFile = (direction: 'prev' | 'next'): void => {
    const newIndex = direction === 'prev' ? currentIndex - 1 : currentIndex + 1
    const newFile = filteredFiles[newIndex]
    if (newFile) {
      setActiveFile(newFile)
      if (isPresentationWindowOpen) {
        window.api.sendToPresentation('load-content', {
          type: newFile.type,
          path: newFile.path,
          name: newFile.name
        })
      }
    }
  }

  return (
    <div className="h-16 bg-surface-300 border-t border-gray-800 flex items-center px-4 gap-4 shrink-0">
      {/* File navigation */}
      <div className="flex items-center gap-1">
        <button
          onClick={() => switchFile('prev')}
          disabled={!hasPrev}
          className="btn-icon text-sm disabled:opacity-30 disabled:cursor-not-allowed"
          title="Previous file"
        >
          ⏮
        </button>
        <button
          onClick={() => switchFile('next')}
          disabled={!hasNext}
          className="btn-icon text-sm disabled:opacity-30 disabled:cursor-not-allowed"
          title="Next file"
        >
          ⏭
        </button>
      </div>

      <div className="w-px h-8 bg-gray-800" />

      {/* Content controls */}
      {activeFile.type === 'video' && (
        <div className="flex items-center gap-2">
          <button onClick={handlePlayPause} className="btn-icon text-lg">
            {isPlaying ? '⏸' : '▶'}
          </button>
          <button onClick={handleStop} className="btn-icon text-lg">
            ⏹
          </button>
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
            placeholder="Go to #"
            className="w-16 bg-surface-100 text-gray-300 text-xs rounded-md px-2 py-1.5 border border-gray-700 focus:outline-none focus:border-accent"
          />
        </div>
      )}

      <div className="flex-1" />

      {/* Active file name */}
      <div className="flex items-center gap-2">
        {isPresentationWindowOpen && (
          <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
        )}
        <span className="text-xs text-gray-400 truncate max-w-[200px]">
          {activeFile.name}{activeFile.extension}
        </span>
      </div>
    </div>
  )
}
