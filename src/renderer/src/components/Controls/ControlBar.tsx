import { useState, useEffect, useRef } from 'react'
import { navigateSpeakerOnlyPdf, useAppStore } from '../../stores/useAppStore'
import {
  queueAbsoluteNavigationDuringTransition,
  queueNavigationDuringTransition
} from '../../navigation-transition'
import { takeAdjacentChannel } from '../../channel-boundary-navigation'
import type { PresentationCaptureQuality } from '../../../../shared/presentation-output'

export function ControlBar(): JSX.Element {
  const {
    activeFile,
    liveChannel,
    channels,
    videoLoopTrack,
    setVideoLoopTrack,
    isPlaying,
    setIsPlaying,
    currentSlide,
    totalSlides,
    macStaticPptxFallbackPath,
    macKeynotePptxPath,
    setCurrentSlide,
    navigatePptx,
  } = useAppStore()

  const [goToSlide, setGoToSlide] = useState('')
  const [videoLoop, setVideoLoop] = useState(false)
  const [videoTime, setVideoTime] = useState(0)
  const [videoDuration, setVideoDuration] = useState(0)
  const [documentError, setDocumentError] = useState('')
  const [captureQuality, setCaptureQuality] = useState<PresentationCaptureQuality | null>(null)
  useEffect(() => window.api.on('keynote-capture-quality', (...args: unknown[]) => {
    const quality = args[0] as PresentationCaptureQuality
    if (quality?.path && quality.sourceWidth > 0 && quality.sourceHeight > 0) setCaptureQuality(quality)
  }), [])
  const [documentSheets, setDocumentSheets] = useState<string[]>([])
  const [documentSheet, setDocumentSheet] = useState('')
  const isMacDocument = window.api.platform === 'darwin' && activeFile?.type === 'other' &&
    ['.doc', '.docx', '.rtf', '.odt', '.txt', '.xls', '.xlsx', '.ods'].includes(activeFile.extension.toLowerCase())
  const isMacExcel = isMacDocument && ['.xls', '.xlsx', '.ods'].includes(activeFile!.extension.toLowerCase())
  const pendingNavCount = useRef(0)
  const activeVideoEndChannel = liveChannel && activeFile?.type === 'video'
    ? channels[liveChannel]?.videoEndChannel
    : null

  // A channel video starts as a single-shot cue. The playlist owns its own
  // repeat setting, so the lower control must follow the actual live source.
  useEffect(() => {
    setVideoLoop(liveChannel ? false : videoLoopTrack)
  }, [activeFile?.path, liveChannel])

  useEffect(() => {
    if (!liveChannel) setVideoLoop(videoLoopTrack)
  }, [videoLoopTrack, liveChannel])

  useEffect(() => {
    if (!liveChannel || !activeVideoEndChannel || !videoLoop) return
    setVideoLoop(false)
    window.api.sendToPresentation('set-loop', false)
  }, [activeVideoEndChannel, liveChannel, videoLoop])

  useEffect(() => {
    let cancelled = false
    setDocumentError(''); setDocumentSheets([]); setDocumentSheet('')
    const loadSheets = (): void => {
      if (!isMacExcel || !activeFile) return
      void window.api.getExternalDocumentSheets(activeFile.path).then((result) => {
        if (cancelled) return
        setDocumentSheets(result.sheets); setDocumentSheet(result.activeSheet)
      }).catch((error) => { if (!cancelled) setDocumentError(String(error)) })
    }
    const ready = (event: Event): void => {
      if ((event as CustomEvent<string>).detail === activeFile?.path) loadSheets()
    }
    loadSheets()
    window.addEventListener('pdm-office-document-ready', ready)
    return () => { cancelled = true; window.removeEventListener('pdm-office-document-ready', ready) }
  }, [activeFile?.path, isMacExcel])

  // Listen for video time/state updates from presentation window
  useEffect(() => {
    const unsubTime = window.api.on('video-time', (...args: unknown[]) => {
      const data = args[0] as { path?: string; currentTime: number; duration: number }
      const active = useAppStore.getState().activeFile
      if (active?.type !== 'video' || (data.path && data.path !== active.path)) return
      setVideoTime(data.currentTime)
      setVideoDuration(data.duration)
    })
    const unsubState = window.api.on('video-state', (...args: unknown[]) => {
      const data = args[0] as { path?: string; playing: boolean; duration: number; currentTime: number }
      const active = useAppStore.getState().activeFile
      if (active?.type !== 'video' || (data.path && data.path !== active.path)) return
      setVideoTime(data.currentTime)
      setVideoDuration(data.duration)
      setIsPlaying(data.playing)
    })
    return () => { unsubTime(); unsubState() }
  }, [])

  if (!activeFile) {
    return (
      <div className="pdm-control-bar h-16 bg-surface-300 border-t border-gray-800 flex items-center justify-center text-gray-600 text-sm shrink-0">
        Трансляция остановлена
      </div>
    )
  }

  const handlePptxNav = (direction: 'next' | 'prev'): void => {
    if (window.api.platform === 'darwin') {
      window.dispatchEvent(new CustomEvent('pdm-direct-navigation', { detail: direction }))
      return
    }

    // View.Next()/Previous() — уважают click-анимации внутри слайда.
    // Не выставляем optimistic currentSlide: на слайде с pending анимациями
    // Next() сыграет следующий шаг, slide index не изменится — optimistic
    // обгонит реальное состояние PP. UI обновляется по фактическому slide
    // от daemon после ответа.
    const { channelBoundaryNavigationEnabled, liveChannel } = useAppStore.getState()
    const sourcePath = activeFile.path
    navigatePptx(direction, undefined, channelBoundaryNavigationEnabled).then((result) => {
      const current = useAppStore.getState()
      if (current.activeFile?.path !== sourcePath || current.liveChannel !== liveChannel) return
      if (result?.success && result.output) {
        try {
          const data = JSON.parse(result.output)
          if (typeof data.CurrentSlide === 'number' && data.CurrentSlide > 0) {
            setCurrentSlide(data.CurrentSlide)
          }
          if (data.Boundary === true) {
            const latest = useAppStore.getState()
            if (
              latest.liveChannel === liveChannel &&
              latest.activeFile?.path === sourcePath
            ) {
              takeAdjacentChannel(direction)
            }
          }
        } catch { /* ignore */ }
      }
    })
  }

  const handlePrev = (): void => {
    if (queueNavigationDuringTransition('prev')) return
    if (isMacDocument) {
      void window.api.navigateExternalDocument(activeFile.path, 'prev').then((result) => setDocumentError(result.error || '')).catch((error) => setDocumentError(String(error)))
      return
    }
    const { currentSlide, channelBoundaryNavigationEnabled } = useAppStore.getState()
    if (
      activeFile.type === 'pdf' &&
      currentSlide <= 1 &&
      channelBoundaryNavigationEnabled
    ) {
      takeAdjacentChannel('prev')
      return
    }
    // Для PPTX НЕ блокируем prev на первом слайде — Previous() откатывает
    // click-анимацию назад (clickIndex уменьшается, slide index не меняется).
    // Daemon сам останавливается на границе через retry guard $sBefore > 1.
    if (activeFile.type !== 'presentation' && currentSlide <= 1) return

    if (activeFile.type === 'presentation') {
      handlePptxNav('prev')
    } else if (activeFile.type === 'pdf') {
      useAppStore.getState().releasePinnedPdfOverlay()
      if (!navigateSpeakerOnlyPdf('prev')) {
        window.api.sendToPresentation('navigate-pdf', 'prev')
      }
    }
  }

  const handleNext = (): void => {
    if (queueNavigationDuringTransition('next')) return
    if (isMacDocument) {
      void window.api.navigateExternalDocument(activeFile.path, 'next').then((result) => setDocumentError(result.error || '')).catch((error) => setDocumentError(String(error)))
      return
    }
    const {
      currentSlide,
      totalSlides,
      channelBoundaryNavigationEnabled
    } = useAppStore.getState()
    if (
      activeFile.type === 'pdf' &&
      totalSlides > 0 &&
      currentSlide >= totalSlides &&
      channelBoundaryNavigationEnabled
    ) {
      takeAdjacentChannel('next')
      return
    }
    // Для PPTX НЕ блокируем по slide index — анимации внутри слайда не
    // меняют slide index, guard «съедал» бы анимационные клики на последнем
    // слайде с pending entrance-эффектами. Daemon сам останавливается на
    // границе через retry-on-stuck guard $sBefore < $total.
    if (activeFile.type !== 'presentation' && totalSlides > 0 && currentSlide >= totalSlides) return

    if (activeFile.type === 'presentation') {
      handlePptxNav('next')
    } else if (activeFile.type === 'pdf') {
      useAppStore.getState().releasePinnedPdfOverlay()
      if (!navigateSpeakerOnlyPdf('next')) {
        window.api.sendToPresentation('navigate-pdf', 'next')
      }
    }
  }

  const handleGoToSlide = (): void => {
    const num = parseInt(goToSlide)
    if (num < 1 || (totalSlides > 0 && num > totalSlides)) return
    if (queueAbsoluteNavigationDuringTransition(num)) {
      setGoToSlide('')
      return
    }

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
      useAppStore.getState().releasePinnedPdfOverlay()
      if (!navigateSpeakerOnlyPdf(num)) {
        window.api.sendToPresentation('navigate-slide', num)
      }
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
    <div className="pdm-control-bar h-16 bg-surface-300 border-t border-gray-800 flex items-center justify-center px-4 gap-4 shrink-0">
      {activeFile.type === 'video' && (
        <div className="flex items-center gap-2 flex-1">
          <button onClick={handlePlayPause} className="btn-icon text-lg">
            {isPlaying ? '⏸' : '▶'}
          </button>
          <button onClick={handleStop} className="btn-icon text-lg">
            ⏹
          </button>
          <button
            type="button"
            onClick={() => {
              const newLoop = !videoLoop
              setVideoLoop(newLoop)
              if (!liveChannel) setVideoLoopTrack(newLoop)
              window.api.sendToPresentation('set-loop', newLoop)
            }}
            disabled={Boolean(activeVideoEndChannel)}
            aria-pressed={videoLoop}
            data-pdm-video-loop={videoLoop ? 'on' : 'off'}
            className={`btn-icon rounded px-2 py-1 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
              videoLoop
                ? 'bg-blue-600 text-white hover:bg-blue-500'
                : 'text-gray-400 hover:text-white'
            }`}
            title={activeVideoEndChannel
              ? 'Чтобы включить повтор, выберите «Не переключать» после видео'
              : videoLoop ? 'Повтор видео включён' : 'Повтор видео выключен'}
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

      {isMacDocument && <div className="flex items-center gap-3">
        <button type="button" className="btn-icon text-sm" onClick={handlePrev} title="Прокрутить документ назад">◀</button>
        <span className="text-xs text-gray-300">{isMacExcel ? 'Таблица Excel' : 'Документ Word'}</span>
        <button type="button" className="btn-icon text-sm" onClick={handleNext} title="Прокрутить документ вперёд">▶</button>
        <button type="button" className="btn-icon text-sm" title="К началу документа" onClick={() => {
          void window.api.navigateExternalDocument(activeFile.path, 'home').then((result) => setDocumentError(result.error || '')).catch((error) => setDocumentError(String(error)))
        }}>⏮</button>
        {isMacExcel && documentSheets.length > 0 && <label className="flex items-center gap-2 text-xs text-gray-400">
          Лист <select aria-label="Лист Excel в эфире" className="rounded border border-gray-700 bg-surface-100 px-2 py-1 text-gray-200"
            value={documentSheet} onChange={(event) => {
              const name = event.target.value
              void window.api.selectExternalDocumentSheet(activeFile.path, name).then((result) => {
                if (result.success) setDocumentSheet(name)
                setDocumentError(result.error || '')
              }).catch((error) => setDocumentError(String(error)))
            }}>{documentSheets.map((name) => <option key={name}>{name}</option>)}</select>
        </label>}
        {documentError && <span role="status" className="text-xs text-amber-300">{documentError}</span>}
      </div>}

      {(activeFile.type === 'pdf' || activeFile.type === 'presentation') && (
        <div className="flex items-center gap-2">
          <button
            onClick={handlePrev}
            disabled={activeFile.type === 'pdf' && currentSlide <= 1}
            className="btn-icon text-sm disabled:opacity-30"
          >
            ◀
          </button>

          <span className="text-sm text-gray-300 min-w-[80px] text-center tabular-nums">
            {currentSlide} / {totalSlides || '—'}
          </span>

          {activeFile.type === 'presentation' && macStaticPptxFallbackPath === activeFile.path && (
            <span className="text-xs text-amber-300" title="PowerPoint закрыл слайд-шоу. В эфире статичные кадры без анимации и видео.">
              Статичный показ · без анимации и видео
            </span>
          )}
          {activeFile.type === 'presentation' && macKeynotePptxPath === activeFile.path && (
            <span role="status" className={`text-xs ${captureQuality?.path === activeFile.path && !captureQuality.native ? 'text-amber-300' : 'text-sky-300'}`}
              title={captureQuality?.path === activeFile.path
                ? captureQuality.lost ? 'Живой источник PPTX перестал передавать кадры. Проверьте Keynote и доступ PDM к записи экрана.'
                : `Живой кадр: ${captureQuality.sourceWidth}×${captureQuality.sourceHeight}. Для слайда на этом выходе нужно ${captureQuality.requiredWidth}×${captureQuality.requiredHeight}. ${captureQuality.native ? 'Разрешения источника достаточно.' : 'Keynote/macOS ограничили размер источника: картинка увеличивается и может терять чёткость.'}`
                : 'Показ через Keynote после импорта PPTX. Проверяется разрешение живого кадра.'}>
              {captureQuality?.path === activeFile.path
                ? captureQuality.lost ? '⚠ PPTX — нет сигнала'
                : `${captureQuality.native ? 'PPTX' : '⚠ PPTX с увеличением'} · ${captureQuality.sourceWidth}×${captureQuality.sourceHeight}`
                : 'Показ через Keynote'}
            </span>
          )}

          <button
            onClick={handleNext}
            disabled={activeFile.type === 'pdf' && totalSlides > 0 && currentSlide >= totalSlides}
            className="btn-icon text-sm disabled:opacity-30"
          >
            ▶
          </button>

          <button
            onClick={() => {
              if (queueAbsoluteNavigationDuringTransition(1)) return
              if (activeFile.type === 'presentation') {
                setCurrentSlide(1)
                navigatePptx('goto', 1)
              } else if (activeFile.type === 'pdf') {
                setCurrentSlide(1)
                useAppStore.getState().releasePinnedPdfOverlay()
                if (!navigateSpeakerOnlyPdf(1)) {
                  window.api.sendToPresentation('navigate-slide', 1)
                }
              }
            }}
            disabled={currentSlide <= 1}
            className="btn-icon text-sm disabled:opacity-30"
            title="К первому слайду"
          >
            ⏮
          </button>

          <div className="w-px h-6 bg-gray-800 mx-1" />

          <input
            type="text"
            value={goToSlide}
            onChange={(e) => setGoToSlide(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleGoToSlide()}
            placeholder="№ слайда"
            className="w-24 bg-surface-100 text-gray-300 text-xs rounded-md px-2 py-1.5 border border-gray-700 focus:outline-hidden focus:border-accent"
          />
        </div>
      )}
    </div>
  )
}
