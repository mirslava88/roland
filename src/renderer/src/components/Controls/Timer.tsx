import { useState, useEffect, useRef } from 'react'
import { connectedProgramDisplayId, useAppStore } from '../../stores/useAppStore'
import { mediaUrl } from '../../media'
import {
  playTimerSound,
  reduceTimerCommand,
  shouldShowTimerOnProgram,
  TIMER_COMMAND_EVENT,
  type TimerCommand
} from '../../timer-controls'

function formatTime(totalSeconds: number): string {
  const negative = totalSeconds < 0
  const abs = Math.abs(totalSeconds)
  const h = Math.floor(abs / 3600)
  const m = Math.floor((abs % 3600) / 60)
  const s = abs % 60
  const pad = (n: number): string => n.toString().padStart(2, '0')
  const time = h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
  return negative ? `-${time}` : time
}

type TimerPreviewTarget = 'program' | 'speaker'

export function Timer(): JSX.Element {
  const {
    timerDuration,
    timerRemaining,
    timerRunning,
    timerOutputVisible,
    timerOutputOwner,
    timerSpeakerOutputEnabled,
    timerSpeakerPosition,
    timerSpeakerScale,
    activeFile,
    currentSlide,
    totalSlides,
    pptxSlidesMap,
    pptxThumbnailsMap,
    backdropImage,
    programScene,
    timerSoundEnd,
    timerSoundWarning,
    timerTextColor,
    timerWarningTextColor,
    timerOvertimeTextColor,
    timerTextOpacity,
    timerOverlayPosition,
    timerOverlayScale,
    displays,
    displayAssignments,
    selectedDisplayId,
    internalProgramOutputActive,
    setTimerDuration,
    setTimerRemaining,
    setTimerRunning,
    setTimerOutputState,
    setTimerSpeakerOutputEnabled,
    setTimerSpeakerPosition,
    setTimerSpeakerScale,
    addTimerMinutes,
    resetTimer,
    setTimerSoundEnd,
    setTimerSoundWarning,
    setTimerTextColor,
    setTimerWarningTextColor,
    setTimerOvertimeTextColor,
    setTimerTextOpacity,
    setTimerOverlayPosition,
    setTimerOverlayScale
  } = useAppStore()

  const [inputH, setInputH] = useState('0')
  const [inputM, setInputM] = useState('15')
  const [addMinInput, setAddMinInput] = useState('')
  const [subMinInput, setSubMinInput] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [timerLayoutReady, setTimerLayoutReady] = useState(false)
  const [timerPreviewTarget, setTimerPreviewTarget] = useState<TimerPreviewTarget>('program')
  const [programDraftPosition, setProgramDraftPosition] = useState(() => ({ ...timerOverlayPosition }))
  const [programDraftScale, setProgramDraftScale] = useState(timerOverlayScale)
  const [speakerDraftPosition, setSpeakerDraftPosition] = useState(() => ({ ...timerSpeakerPosition }))
  const [speakerDraftScale, setSpeakerDraftScale] = useState(timerSpeakerScale)
  const [previewPdfFrames, setPreviewPdfFrames] = useState<{ current: string | null; next: string | null }>({
    current: null,
    next: null
  })

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const warnedRef = useRef(false)
  const endedRef = useRef(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const timerPreviewRef = useRef<HTMLDivElement>(null)
  const timerPreviewValueRef = useRef<HTMLDivElement>(null)

  const hasDedicatedTimerDisplay = displays.some((display) => (
    !display.isPrimary && displayAssignments[String(display.id)] === 'timer'
  ))
  const speakerDisplay = displays.find((display) => (
    !display.isPrimary && displayAssignments[String(display.id)] === 'speaker'
  ))
  const programDisplayId = connectedProgramDisplayId({ displays, displayAssignments, selectedDisplayId })
  const programDisplay = displays.find((display) => display.id === programDisplayId)
  const hasSpeakerDisplay = speakerDisplay !== undefined
  const activePreviewTarget: TimerPreviewTarget = timerPreviewTarget === 'speaker' &&
    timerSpeakerOutputEnabled && hasSpeakerDisplay
    ? 'speaker'
    : 'program'
  const timerTargetsProgram = shouldShowTimerOnProgram({
    duration: timerDuration,
    outputVisible: timerOutputVisible,
    outputOwner: timerOutputOwner,
    hasDedicatedTimerDisplay
  })
  const timerUsesProgramOverlay = !internalProgramOutputActive && timerTargetsProgram
  const programLayoutDirty =
    Math.abs(programDraftPosition.x - timerOverlayPosition.x) > 0.01 ||
    Math.abs(programDraftPosition.y - timerOverlayPosition.y) > 0.01 ||
    Math.abs(programDraftScale - timerOverlayScale) > 0.001
  const speakerLayoutDirty =
    Math.abs(speakerDraftPosition.x - timerSpeakerPosition.x) > 0.01 ||
    Math.abs(speakerDraftPosition.y - timerSpeakerPosition.y) > 0.01 ||
    Math.abs(speakerDraftScale - timerSpeakerScale) > 0.001
  const activeLayoutDirty = activePreviewTarget === 'speaker' ? speakerLayoutDirty : programLayoutDirty
  const activeDraftScale = activePreviewTarget === 'speaker' ? speakerDraftScale : programDraftScale
  const programDisplayWidth = Math.max(
    1,
    (programDisplay?.bounds.width || 1920) * (programDisplay?.scaleFactor || 1)
  )
  const programDisplayHeight = Math.max(
    1,
    (programDisplay?.bounds.height || 1080) * (programDisplay?.scaleFactor || 1)
  )
  // The transparent WPF overlay is created by a PowerShell process whose
  // logical 48 DIP timer follows the operator display DPI. Account for that
  // scale in the miniature so its invisible text reserve and edge position
  // match the real physical Program monitor.
  const programOverlayDpiScale = Math.max(
    0.5,
    displays.find((display) => display.isPrimary)?.scaleFactor || 1
  )
  const programPreviewAspect = programDisplayWidth / programDisplayHeight
  const programPreviewFontCqw = (48 * programOverlayDpiScale / programDisplayWidth) * 100
  const programPreviewPaddingXCqw = (4 * programOverlayDpiScale / programDisplayWidth) * 100
  const programPreviewPaddingYCqw = (2 * programOverlayDpiScale / programDisplayWidth) * 100
  const speakerPreviewAspect = speakerDisplay
    ? Math.max(1, speakerDisplay.bounds.width / Math.max(1, speakerDisplay.bounds.height))
    : 16 / 9
  const speakerDisplayWidth = Math.max(1, speakerDisplay?.bounds.width || 1920)
  const speakerOutputFontSize = Math.max(34, Math.min(speakerDisplayWidth * 0.048, 82))
  const speakerPreviewFontCqw = (speakerOutputFontSize / speakerDisplayWidth) * 100
  const speakerPreviewPaddingXCqw = (8 / speakerDisplayWidth) * 100
  const speakerPreviewPaddingYCqw = (4 / speakerDisplayWidth) * 100
  const speakerPptxFrames = activeFile?.type === 'presentation'
    ? pptxSlidesMap[activeFile.path] || pptxThumbnailsMap[activeFile.path] || []
    : []
  const speakerCurrentFrame = activeFile?.type === 'presentation'
    ? speakerPptxFrames[Math.max(0, currentSlide - 1)] || null
    : activeFile?.type === 'pdf'
      ? previewPdfFrames.current
      : null
  const speakerNextFrame = activeFile?.type === 'presentation'
    ? speakerPptxFrames[Math.max(0, currentSlide)] || null
    : activeFile?.type === 'pdf'
      ? previewPdfFrames.next
      : null

  const clampSpeakerDraftPosition = (
    position: { x: number; y: number },
    scale = speakerDraftScale
  ): { x: number; y: number } => {
    const preview = timerPreviewRef.current
    const timer = timerPreviewValueRef.current
    if (!preview || !timer || preview.clientWidth <= 0 || preview.clientHeight <= 0) {
      return {
        x: Math.max(8, Math.min(92, position.x)),
        y: Math.max(8, Math.min(92, position.y))
      }
    }
    const horizontalInset = Math.max(8, Math.min(49, (timer.offsetWidth * scale / preview.clientWidth) * 50 + 1))
    const verticalInset = Math.max(8, Math.min(49, (timer.offsetHeight * scale / preview.clientHeight) * 50 + 1))
    return {
      x: Math.max(horizontalInset, Math.min(100 - horizontalInset, position.x)),
      y: Math.max(verticalInset, Math.min(100 - verticalInset, position.y))
    }
  }

  const updateSpeakerTimerPosition = (clientX: number, clientY: number): void => {
    const bounds = timerPreviewRef.current?.getBoundingClientRect()
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return
    setSpeakerDraftPosition(clampSpeakerDraftPosition({
      x: ((clientX - bounds.left) / bounds.width) * 100,
      y: ((clientY - bounds.top) / bounds.height) * 100
    }))
  }

  const updateProgramTimerPosition = (clientX: number, clientY: number): void => {
    const preview = timerPreviewRef.current
    const timer = timerPreviewValueRef.current
    const bounds = preview?.getBoundingClientRect()
    if (!preview || !timer || !bounds || bounds.width <= 0 || bounds.height <= 0) return
    const availableWidth = Math.max(0, preview.clientWidth - timer.offsetWidth)
    const availableHeight = Math.max(0, preview.clientHeight - timer.offsetHeight)
    const desiredLeft = clientX - bounds.left - timer.offsetWidth / 2
    const desiredTop = clientY - bounds.top - timer.offsetHeight / 2
    setProgramDraftPosition({
      x: availableWidth > 0
        ? Math.max(0, Math.min(100, (desiredLeft / availableWidth) * 100))
        : 50,
      y: availableHeight > 0
        ? Math.max(0, Math.min(100, (desiredTop / availableHeight) * 100))
        : 50
    })
  }

  const updatePreviewTimerPosition = (clientX: number, clientY: number): void => {
    if (activePreviewTarget === 'speaker') updateSpeakerTimerPosition(clientX, clientY)
    else updateProgramTimerPosition(clientX, clientY)
  }

  useEffect(() => {
    if (!expanded || activePreviewTarget !== 'speaker') return
    const frame = requestAnimationFrame(() => {
      setSpeakerDraftPosition((current) => {
        const clamped = clampSpeakerDraftPosition(current, speakerDraftScale)
        return Math.abs(clamped.x - current.x) < 0.01 && Math.abs(clamped.y - current.y) < 0.01
          ? current
          : clamped
      })
    })
    return () => cancelAnimationFrame(frame)
  }, [
    expanded,
    activePreviewTarget,
    speakerDraftScale,
    speakerPreviewAspect,
    speakerPreviewFontCqw,
    timerDuration,
    timerRemaining
  ])

  useEffect(() => {
    if (timerSpeakerOutputEnabled && hasSpeakerDisplay) return
    setTimerPreviewTarget('program')
  }, [hasSpeakerDisplay, timerSpeakerOutputEnabled])

  useEffect(() => {
    if (programLayoutDirty) return
    setProgramDraftPosition({ ...timerOverlayPosition })
    setProgramDraftScale(timerOverlayScale)
  }, [programLayoutDirty, timerOverlayPosition, timerOverlayScale])

  useEffect(() => {
    if (speakerLayoutDirty) return
    setSpeakerDraftPosition({ ...timerSpeakerPosition })
    setSpeakerDraftScale(timerSpeakerScale)
  }, [speakerLayoutDirty, timerSpeakerPosition, timerSpeakerScale])

  useEffect(() => {
    if (!expanded || activeFile?.type !== 'pdf') {
      setPreviewPdfFrames({ current: null, next: null })
      return
    }
    let cancelled = false
    const currentPage = Math.max(1, currentSlide)
    const nextPage = currentPage < totalSlides ? currentPage + 1 : null
    void Promise.all([
      window.api.renderPdfPage(activeFile.path, currentPage - 1, 720),
      nextPage ? window.api.renderPdfPage(activeFile.path, nextPage - 1, 420) : Promise.resolve(null)
    ]).then(([current, next]) => {
      if (!cancelled) setPreviewPdfFrames({ current, next })
    }).catch(() => {
      if (!cancelled) setPreviewPdfFrames({ current: null, next: null })
    })
    return () => { cancelled = true }
  }, [activeFile, currentSlide, expanded, totalSlides])

  useEffect(() => {
    if (!programScene.enabled && timerOutputOwner === 'scene') {
      setTimerOutputState(false, null)
    }
  }, [programScene.enabled, setTimerOutputState, timerOutputOwner])

  // The native timer can also be dragged directly on the output. Read its
  // last persisted layout once before renderer updates begin so the Scene
  // preview and the real overlay start from the exact same place and size.
  useEffect(() => {
    let cancelled = false
    void window.api.getTimerOverlayLayout().then((layout) => {
      if (cancelled) return
      const restoredPosition = { x: layout.x * 100, y: layout.y * 100 }
      setTimerOverlayPosition(restoredPosition)
      setTimerOverlayScale(layout.scale)
      setProgramDraftPosition(restoredPosition)
      setProgramDraftScale(layout.scale)
      setTimerLayoutReady(true)
    }).catch(() => {
      if (!cancelled) setTimerLayoutReady(true)
    })
    return () => { cancelled = true }
  }, [setTimerOverlayPosition, setTimerOverlayScale])

  // Keep the native overlay data current for the automatic fallback. The
  // update is sent before the overlay is opened so its first frame is never
  // an empty/zero timer.
  useEffect(() => {
    if (!timerLayoutReady || timerDuration <= 0 || !timerOutputVisible || !timerUsesProgramOverlay) return
    window.api.updateTimerOverlay({
      remaining: timerRemaining,
      running: timerRunning,
      duration: timerDuration,
      posX: timerOverlayPosition.x,
      posY: timerOverlayPosition.y,
      scale: timerOverlayScale,
      textColor: timerTextColor,
      warningTextColor: timerWarningTextColor,
      overtimeTextColor: timerOvertimeTextColor,
      textOpacity: timerTextOpacity
    })
  }, [
    timerUsesProgramOverlay,
    timerLayoutReady,
    timerDuration,
    timerOverlayPosition.x,
    timerOverlayPosition.y,
    timerOverlayScale,
    timerOvertimeTextColor,
    timerRemaining,
    timerRunning,
    timerOutputVisible,
    timerTextColor,
    timerTextOpacity,
    timerWarningTextColor
  ])

  // "Screens" is the only explicit output selector. Without a dedicated
  // timer display, fall back to the main program display as an overlay.
  useEffect(() => {
    if (timerDuration > 0 && timerOutputVisible && timerUsesProgramOverlay) {
      const programDisplayId = connectedProgramDisplayId(useAppStore.getState())
      if (programDisplayId !== null) void window.api.showTimerOverlay(programDisplayId)
    } else {
      void window.api.hideTimerOverlay()
    }
  }, [selectedDisplayId, timerDuration, timerOutputVisible, timerUsesProgramOverlay])

  // Timer tick
  useEffect(() => {
    if (timerRunning) {
      intervalRef.current = setInterval(() => {
        const { timerRemaining: r, timerSoundWarning: sw, timerSoundEnd: se } = useAppStore.getState()
        const newR = r - 1
        setTimerRemaining(newR)

        // Warning sound: первый тик где remaining опускается на/ниже 60
        // (но не в overtime). Было `=== 60` — ломалось если interval-drift
        // или add/sub-minutes перепрыгивали через 60 точно.
        if (newR <= 60 && newR >= 0 && sw && !warnedRef.current) {
          warnedRef.current = true
          window.api.dbgLog(`Timer: tick r=${r}→${newR}, warning triggered (sw=${!!sw})`)
          playTimerSound(sw, 'warning')
        }

        // End sound: первый тик где remaining достиг 0 или ушёл в overtime.
        if (newR <= 0 && se && !endedRef.current) {
          endedRef.current = true
          window.api.dbgLog(`Timer: tick r=${r}→${newR}, end triggered (se=${!!se})`)
          playTimerSound(se, 'end')
        }
      }, 1000)
    } else if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [timerRunning, setTimerRemaining])

  // Close settings panel on click outside
  useEffect(() => {
    if (!expanded) return
    const handleClickOutside = (e: MouseEvent): void => {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        toggleRef.current && !toggleRef.current.contains(e.target as Node)
      ) {
        setExpanded(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [expanded])

  const handleSetTime = (): void => {
    const h = parseInt(inputH) || 0
    const m = parseInt(inputM) || 0
    const total = h * 3600 + m * 60
    window.api.dbgLog(`Timer: handleSetTime inputH="${inputH}" inputM="${inputM}" h=${h} m=${m} total=${total}`)
    if (total > 0) {
      setTimerDuration(total)
      setTimerOutputState(true, 'toolbar')
      const after = useAppStore.getState()
      window.api.dbgLog(`Timer: after setTimerDuration store={duration=${after.timerDuration}, remaining=${after.timerRemaining}, running=${after.timerRunning}}`)
      warnedRef.current = false
      endedRef.current = false
    } else {
      window.api.dbgLog(`Timer: handleSetTime total=0, SKIP setTimerDuration`)
    }
  }

  const handleStart = (): void => {
    if (timerDuration === 0) {
      handleSetTime()
    }
    // КРИТИЧНО: читаем timerRemaining свежим через getState().
    // handleSetTime выше вызывает setTimerDuration → setTimerRemaining(total)
    // в store, но React ещё не перерендерил компонент к этому моменту.
    // Destructured `timerRemaining` из useAppStore() в closure = СТАРОЕ
    // значение (обычно 0 если юзер не клацал «Установить» отдельно).
    // warnedRef=(0<=60)=true и endedRef=(0<=0)=true гасят ОБА звука навсегда,
    // interval.tick никогда не проходит guard → sound не играет.
    const freshRemaining = useAppStore.getState().timerRemaining
    warnedRef.current = freshRemaining <= 60
    endedRef.current = freshRemaining <= 0
    window.api.dbgLog(`Timer: handleStart freshRemaining=${freshRemaining} warnedRef=${warnedRef.current} endedRef=${endedRef.current}`)
    setTimerRunning(true)
    const owner = useAppStore.getState().timerOutputOwner
    setTimerOutputState(true, owner ?? 'toolbar')
  }

  const handlePause = (): void => {
    setTimerRunning(false)
  }

  const handleStop = (): void => {
    setTimerRunning(false)
    setTimerDuration(0)
    setTimerRemaining(0)
    setTimerOutputState(false, null)
    warnedRef.current = false
    endedRef.current = false
  }

  const handleReset = (): void => {
    resetTimer()
    warnedRef.current = false
    endedRef.current = false
  }

  const handleAddMin = (min: number): void => {
    addTimerMinutes(min)
    const state = useAppStore.getState()
    if (state.timerDuration <= 0) return
    if (!state.timerOutputVisible) setTimerOutputState(true, 'toolbar')
    const newR = useAppStore.getState().timerRemaining
    if (newR > 0) endedRef.current = false
    if (newR > 60) warnedRef.current = false
  }

  const handleCustomAdd = (): void => {
    const v = parseInt(addMinInput)
    if (v && v > 0) {
      handleAddMin(v)
      setAddMinInput('')
    }
  }

  const handleCustomSub = (): void => {
    const v = parseInt(subMinInput)
    if (v && v > 0) {
      handleAddMin(-v)
      setSubMinInput('')
    }
  }

  useEffect(() => {
    const handleSceneCommand = (event: Event): void => {
      const command = (event as CustomEvent<TimerCommand>).detail
      if (!command) return
      const state = useAppStore.getState()
      const current = {
        duration: state.timerDuration,
        remaining: state.timerRemaining,
        running: state.timerRunning,
        outputVisible: state.timerOutputVisible,
        outputOwner: state.timerOutputOwner,
        warned: warnedRef.current,
        ended: endedRef.current
      }
      const next = reduceTimerCommand(current, command)
      if (next === current) return
      state.setTimerDuration(next.duration)
      state.setTimerRemaining(next.remaining)
      state.setTimerRunning(next.running)
      state.setTimerOutputState(next.outputVisible, next.outputOwner)
      warnedRef.current = next.warned
      endedRef.current = next.ended
      if (command.type === 'start') {
        window.api.dbgLog(
          `Timer: external command started countdown and enabled output owner=${next.outputOwner ?? 'toolbar'}`
        )
      }
    }
    window.addEventListener(TIMER_COMMAND_EVENT, handleSceneCommand)
    return () => window.removeEventListener(TIMER_COMMAND_EVENT, handleSceneCommand)
  }, [])

  const isOvertime = timerRemaining < 0
  const isWarning = timerRemaining <= 60 && timerRemaining >= 0 && timerRunning
  const timerColor = isOvertime ? 'text-red-500' : isWarning ? 'text-yellow-400' : 'text-green-400'
  const currentTimerTextColor = isOvertime
    ? timerOvertimeTextColor
    : isWarning
      ? timerWarningTextColor
      : timerTextColor

  return (
    <>
      <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        {/* Timer display */}
        <button
          ref={toggleRef}
          onClick={() => setExpanded(!expanded)}
          className={`text-[11px] font-mono font-bold px-1.5 py-1 rounded-lg transition-colors ${timerColor} ${
            timerRunning ? 'bg-gray-800' : 'bg-gray-800/50 hover:bg-gray-800'
          }`}
          title="Таймер доклада"
        >
          ⏱{' '}
          <span
            className="inline-block min-w-[4.5em] text-right"
            style={{ color: currentTimerTextColor, opacity: timerTextOpacity }}
          >
            {timerDuration > 0 || timerRunning ? formatTime(timerRemaining) : '--:--'}
          </span>
        </button>

        {/* Quick controls when timer is set */}
        {timerDuration > 0 && (
          <>
            {!timerRunning ? (
              <button onClick={handleStart} className="btn-icon text-[10px] text-green-400" title="Старт">▶</button>
            ) : (
              <button onClick={handlePause} className="btn-icon text-[10px] text-yellow-400" title="Пауза">⏸</button>
            )}
            <button onClick={handleStop} className="btn-icon text-[10px] text-red-400" title="Стоп">⏹</button>
          </>
        )}

      </div>

      {/* Expanded panel */}
      {expanded && (
        <div
          data-pdm-training-panel="timer"
          ref={panelRef}
          className="absolute top-full mt-1 left-1/2 -translate-x-1/2 bg-surface-100 border border-gray-700 rounded-lg shadow-xl p-3 z-50 w-[800px] max-w-[calc(100vw-16px)]"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <div className="text-[11px] text-gray-400 font-bold uppercase mb-2">Настройки таймера</div>

          <div className="grid grid-cols-[minmax(0,1fr)_minmax(280px,0.68fr)] gap-3">
            <div className="min-w-0">

          {/* Time input */}
          <div className="flex items-center gap-2 mb-3">
            <label className="text-[11px] text-gray-400 shrink-0">Время:</label>
            <div className="flex items-center gap-0.5">
              <input
                type="number"
                min={0}
                max={23}
                value={inputH}
                onChange={(e) => setInputH(e.target.value)}
                className="w-14 bg-gray-800 text-white text-xs text-center rounded-sm px-1 py-1 border border-gray-600"
              />
              <span className="text-[10px] text-gray-500">ч</span>
            </div>
            <span className="text-gray-500 text-xs">:</span>
            <div className="flex items-center gap-0.5">
              <input
                type="number"
                min={0}
                max={59}
                value={inputM}
                onChange={(e) => setInputM(e.target.value)}
                className="w-14 bg-gray-800 text-white text-xs text-center rounded-sm px-1 py-1 border border-gray-600"
              />
              <span className="text-[10px] text-gray-500">мин</span>
            </div>
            <button onClick={handleSetTime} className="text-[10px] px-2 py-1 rounded-sm bg-blue-600 hover:bg-blue-500 text-white transition-colors">
              Установить
            </button>
            {!timerRunning ? (
              <button onClick={handleStart} className="text-[10px] px-2 py-1 rounded-sm bg-green-700 hover:bg-green-600 text-white transition-colors" title="Старт">▶</button>
            ) : (
              <button onClick={handlePause} className="text-[10px] px-2 py-1 rounded-sm bg-yellow-700 hover:bg-yellow-600 text-white transition-colors" title="Пауза">⏸</button>
            )}
            <button onClick={handleStop} className="text-[10px] px-2 py-1 rounded-sm bg-red-700 hover:bg-red-600 text-white transition-colors" title="Стоп">⏹</button>
          </div>

          {/* Add/subtract minutes */}
          <div className="flex items-center gap-2 mb-1">
            <label className="text-[11px] text-gray-400 shrink-0 w-16">Добавить:</label>
            <button onClick={() => handleAddMin(1)} className="text-[10px] w-14 py-1 rounded-sm bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors text-center">+1 мин</button>
            <button onClick={() => handleAddMin(5)} className="text-[10px] w-14 py-1 rounded-sm bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors text-center">+5 мин</button>
            <button onClick={() => handleAddMin(10)} className="text-[10px] w-16 py-1 rounded-sm bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors text-center">+10 мин</button>
            <input
              type="number"
              min={1}
              value={addMinInput}
              onChange={(e) => setAddMinInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCustomAdd()}
              className="w-14 bg-gray-800 text-white text-xs text-center rounded-sm px-1 py-1 border border-gray-600"
              placeholder="мин"
            />
            <button onClick={handleCustomAdd} className="text-[10px] px-2 py-1 rounded-sm bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors">+</button>
          </div>
          <div className="flex items-center gap-2 mb-3">
            <label className="text-[11px] text-gray-400 shrink-0 w-16">Убавить:</label>
            <button onClick={() => handleAddMin(-1)} className="text-[10px] w-14 py-1 rounded-sm bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors text-center">-1 мин</button>
            <button onClick={() => handleAddMin(-5)} className="text-[10px] w-14 py-1 rounded-sm bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors text-center">-5 мин</button>
            <button onClick={() => handleAddMin(-10)} className="text-[10px] w-16 py-1 rounded-sm bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors text-center">-10 мин</button>
            <input
              type="number"
              min={1}
              value={subMinInput}
              onChange={(e) => setSubMinInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCustomSub()}
              className="w-14 bg-gray-800 text-white text-xs text-center rounded-sm px-1 py-1 border border-gray-600"
              placeholder="мин"
            />
            <button onClick={handleCustomSub} className="text-[10px] px-2 py-1 rounded-sm bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors">-</button>
          </div>

          <div className="border-t border-gray-700 pt-2 mt-2 mb-2">
            <label
              className={`flex items-center gap-2 text-[11px] ${
                hasSpeakerDisplay ? 'cursor-pointer text-gray-200' : 'cursor-not-allowed text-gray-500'
              }`}
              title={hasSpeakerDisplay
                ? 'Показывать таймер поверх содержимого суфлёра'
                : 'Сначала назначьте подключённому экрану режим «Суфлёр»'}
            >
              <input
                data-timer-speaker-output
                type="checkbox"
                checked={timerSpeakerOutputEnabled}
                disabled={!hasSpeakerDisplay}
                onChange={(event) => {
                  setTimerSpeakerOutputEnabled(event.target.checked)
                  if (!event.target.checked) setTimerPreviewTarget('program')
                }}
                className="h-3.5 w-3.5 accent-blue-500 disabled:cursor-not-allowed"
              />
              <span>Отправить в суфлёр</span>
            </label>
            {!hasSpeakerDisplay && (
              <div className="mt-1 pl-[22px] text-[10px] text-gray-600">
                Назначьте экрану режим «Суфлёр»
              </div>
            )}
            <div className="mt-2 rounded-md border border-gray-700 bg-gray-950/80 p-2">
              {hasSpeakerDisplay && timerSpeakerOutputEnabled && (
                <div data-timer-preview-selector className="mb-2 grid grid-cols-2 gap-1 rounded bg-gray-900 p-1">
                  <button
                    type="button"
                    data-timer-preview-target="program"
                    onClick={() => setTimerPreviewTarget('program')}
                    className={`rounded px-2 py-1 text-[10px] font-semibold transition-colors ${activePreviewTarget === 'program'
                      ? 'bg-blue-600 text-white'
                      : 'text-gray-400 hover:bg-gray-800 hover:text-white'}`}
                  >
                    Основной эфир
                  </button>
                  <button
                    type="button"
                    data-timer-preview-target="speaker"
                    onClick={() => setTimerPreviewTarget('speaker')}
                    className={`rounded px-2 py-1 text-[10px] font-semibold transition-colors ${activePreviewTarget === 'speaker'
                      ? 'bg-blue-600 text-white'
                      : 'text-gray-400 hover:bg-gray-800 hover:text-white'}`}
                  >
                    Суфлёр
                  </button>
                </div>
              )}
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <span className="text-[10px] text-gray-400">
                  {activePreviewTarget === 'speaker' ? 'Суфлёр' : 'Основной эфир'}: перетаскивание · колёсико — размер
                </span>
                <div className="flex shrink-0 items-center">
                  <button
                    type="button"
                    data-timer-layout-refresh
                    data-pending-changes={activeLayoutDirty ? 'true' : 'false'}
                    aria-label={`Обновить таймер: ${activePreviewTarget === 'speaker' ? 'суфлёр' : 'основной эфир'}`}
                    title={activeLayoutDirty
                      ? `Передать положение и размер в ${activePreviewTarget === 'speaker' ? 'суфлёр' : 'основной эфир'}`
                      : 'Положение и размер уже обновлены'}
                    disabled={!activeLayoutDirty}
                    onClick={() => {
                      if (activePreviewTarget === 'speaker') {
                        setTimerSpeakerPosition(speakerDraftPosition)
                        setTimerSpeakerScale(speakerDraftScale)
                      } else {
                        setTimerOverlayPosition(programDraftPosition)
                        setTimerOverlayScale(programDraftScale)
                      }
                    }}
                    className={`flex h-7 w-7 items-center justify-center rounded-full border text-base font-bold leading-none transition-colors ${activeLayoutDirty
                      ? 'program-scene-refresh-attention border-blue-300 bg-blue-600 text-white hover:bg-blue-500'
                      : 'cursor-default border-gray-700 bg-surface-100 text-gray-500'}`}
                  >
                    ↻
                  </button>
                </div>
              </div>
              <div
                ref={timerPreviewRef}
                data-timer-layout-preview
                data-preview-target={activePreviewTarget}
                className="relative w-full cursor-move select-none overflow-hidden rounded border border-gray-600 bg-[#090b10]"
                style={{
                  touchAction: 'none',
                  aspectRatio: activePreviewTarget === 'speaker' ? speakerPreviewAspect : programPreviewAspect,
                  containerType: 'inline-size'
                }}
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId)
                  updatePreviewTimerPosition(event.clientX, event.clientY)
                }}
                onPointerMove={(event) => {
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                    updatePreviewTimerPosition(event.clientX, event.clientY)
                  }
                }}
                onPointerUp={(event) => {
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                    event.currentTarget.releasePointerCapture(event.pointerId)
                  }
                }}
                onWheel={(event) => {
                  event.preventDefault()
                  const direction = event.deltaY < 0 ? 0.1 : -0.1
                  if (activePreviewTarget === 'speaker') {
                    const nextScale = Math.max(0.5, Math.min(
                      2,
                      Math.round((speakerDraftScale + direction) * 10) / 10
                    ))
                    setSpeakerDraftScale(nextScale)
                    setSpeakerDraftPosition((current) => clampSpeakerDraftPosition(current, nextScale))
                  } else {
                    const nextScale = Math.max(0.5, Math.min(
                      8,
                      Math.round((programDraftScale + direction) * 10) / 10
                    ))
                    setProgramDraftScale(nextScale)
                  }
                }}
                title="Перетаскивание — положение, колёсико — размер"
              >
                {activePreviewTarget === 'speaker' ? (
                  activeFile && (activeFile.type === 'presentation' || activeFile.type === 'pdf') ? (
                    <div className={`pointer-events-none absolute inset-1 grid grid-cols-[2fr_1fr] gap-1 ${activeFile.type === 'pdf'
                      ? 'grid-rows-1'
                      : 'grid-rows-[minmax(0,1fr)_minmax(16px,0.34fr)]'}`}
                    >
                      <div className="min-h-0 overflow-hidden rounded-sm border border-gray-700 bg-black">
                        {speakerCurrentFrame ? (
                          <img
                            src={mediaUrl(speakerCurrentFrame)}
                            className="h-full w-full object-contain"
                            draggable={false}
                          />
                        ) : (
                          <div className="flex h-full items-center justify-center text-[8px] text-gray-500">Текущий слайд</div>
                        )}
                      </div>
                      <div className="flex min-h-0 flex-col gap-1">
                        <div className="min-h-0 flex-1 overflow-hidden rounded-sm border border-gray-700 bg-black">
                          {speakerNextFrame ? (
                            <img
                              src={mediaUrl(speakerNextFrame)}
                              className="h-full w-full object-contain"
                              draggable={false}
                            />
                          ) : (
                            <div className="flex h-full items-center justify-center text-[7px] text-gray-500">Следующий слайд</div>
                          )}
                        </div>
                        <div className="flex h-3 items-center justify-between gap-1 rounded-sm border border-gray-700 bg-gray-900 px-1 text-[6px] text-gray-400">
                          <span className="min-w-0 truncate">{activeFile.name}</span>
                          <span className="shrink-0">{currentSlide}/{totalSlides || '—'}</span>
                        </div>
                      </div>
                      {activeFile.type === 'presentation' && (
                        <div className="col-span-2 min-h-0 rounded-sm border border-gray-700 bg-gray-900/90 px-1 py-0.5 text-[6px] text-gray-500">
                          Заметки докладчика
                        </div>
                      )}
                    </div>
                  ) : backdropImage ? (
                    <img
                      src={mediaUrl(backdropImage)}
                      className="pointer-events-none absolute inset-0 h-full w-full object-cover"
                      draggable={false}
                    />
                  ) : (
                    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-gray-500">
                      <span className="text-[10px]">Суфлёр</span>
                      <span className="text-[7px]">Ожидание презентации</span>
                    </div>
                  )
                ) : (
                  <>
                    {backdropImage && (
                      <img
                        src={mediaUrl(backdropImage)}
                        className="pointer-events-none absolute inset-0 h-full w-full object-cover"
                        draggable={false}
                      />
                    )}
                    {activeFile && (activeFile.type === 'presentation' || activeFile.type === 'pdf') ? (
                      speakerCurrentFrame ? (
                        <img
                          src={mediaUrl(speakerCurrentFrame)}
                          className="pointer-events-none absolute inset-0 h-full w-full object-contain"
                          draggable={false}
                        />
                      ) : (
                        <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[8px] text-gray-500">
                          Материал готовится
                        </div>
                      )
                    ) : activeFile?.isImage ? (
                      <img
                        src={mediaUrl(activeFile.path)}
                        className="pointer-events-none absolute inset-0 h-full w-full object-contain"
                        draggable={false}
                      />
                    ) : activeFile?.type === 'video' ? (
                      <video
                        src={mediaUrl(activeFile.path)}
                        className="pointer-events-none absolute inset-0 h-full w-full object-contain"
                        muted
                      />
                    ) : !backdropImage ? (
                      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-gray-500">
                        <span className="text-[10px]">Основной эфир</span>
                        <span className="text-[7px]">Ожидание материала</span>
                      </div>
                    ) : null}
                  </>
                )}
                <div
                  ref={timerPreviewValueRef}
                  data-timer-preview-value
                  className="pointer-events-none absolute whitespace-nowrap font-mono font-black leading-none text-white"
                  style={activePreviewTarget === 'speaker' ? {
                    left: `${speakerDraftPosition.x}%`,
                    top: `${speakerDraftPosition.y}%`,
                    transform: `translate(-50%, -50%) scale(${speakerDraftScale})`,
                    transformOrigin: 'center center',
                    color: currentTimerTextColor,
                    opacity: timerTextOpacity,
                    textShadow: '0 1px 4px rgba(0,0,0,0.95)',
                    fontSize: `${speakerPreviewFontCqw}cqw`,
                    padding: `${speakerPreviewPaddingYCqw}cqw ${speakerPreviewPaddingXCqw}cqw`,
                    minWidth: timerDuration >= 3600 || timerRemaining >= 3600 || timerRemaining <= -3600
                      ? '9ch'
                      : '6ch',
                    textAlign: 'center'
                  } : {
                    left: `${programDraftPosition.x}%`,
                    top: `${programDraftPosition.y}%`,
                    transform: `translate(-${programDraftPosition.x}%, -${programDraftPosition.y}%)`,
                    boxSizing: 'content-box',
                    color: currentTimerTextColor,
                    opacity: timerTextOpacity,
                    textShadow: '0 1px 4px rgba(0,0,0,0.95)',
                    fontSize: `${programPreviewFontCqw * programDraftScale}cqw`,
                    padding: `${programPreviewPaddingYCqw * programDraftScale}cqw ${programPreviewPaddingXCqw * programDraftScale}cqw`,
                    minWidth: timerDuration >= 3600 || timerRemaining >= 3600 || timerRemaining <= -3600
                      ? '5.42em'
                      : '3.67em',
                    textAlign: programDraftPosition.x <= 0.001
                      ? 'left'
                      : programDraftPosition.x >= 99.999
                        ? 'right'
                        : 'center'
                  }}
                >
                  {timerDuration > 0 ? formatTime(timerRemaining) : '15:00'}
                </div>
              </div>
              <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-gray-500">
                <span>{activeLayoutDirty
                  ? 'Есть изменения — нажмите ↻'
                  : `${activePreviewTarget === 'speaker' ? 'Суфлёр' : 'Основной эфир'} обновлён`}</span>
                <span className="tabular-nums">Размер {Math.round(activeDraftScale * 100)}%</span>
              </div>
            </div>
          </div>

            </div>
            <div className="min-w-0 self-start">

          {/* Appearance settings */}
          <div className="border-t border-gray-700 pt-2 mb-2 space-y-2">
            <div className="grid grid-cols-[minmax(0,1fr)_48px_54px] items-center gap-2">
              <label className="min-w-0 text-[11px] leading-tight text-gray-400">Цвет основного таймера:</label>
              <input
                type="color"
                value={timerTextColor}
                onChange={(e) => setTimerTextColor(e.target.value)}
                className="h-7 w-12 cursor-pointer rounded-sm border border-gray-600 bg-gray-800 p-0.5"
                title="Цвет основного таймера"
              />
              <span className="text-[10px] font-mono text-gray-400 uppercase">{timerTextColor}</span>
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_48px_54px] items-center gap-2">
              <label className="min-w-0 text-[11px] leading-tight text-gray-400">Цвет за 1 мин до конца:</label>
              <input
                type="color"
                value={timerWarningTextColor}
                onChange={(e) => setTimerWarningTextColor(e.target.value)}
                className="h-7 w-12 cursor-pointer rounded-sm border border-gray-600 bg-gray-800 p-0.5"
                title="Цвет таймера за одну минуту до окончания"
              />
              <span className="text-[10px] font-mono text-gray-400 uppercase">{timerWarningTextColor}</span>
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_48px_54px] items-center gap-2">
              <label className="min-w-0 text-[11px] leading-tight text-gray-400">Цвет перелимита времени:</label>
              <input
                type="color"
                value={timerOvertimeTextColor}
                onChange={(e) => setTimerOvertimeTextColor(e.target.value)}
                className="h-7 w-12 cursor-pointer rounded-sm border border-gray-600 bg-gray-800 p-0.5"
                title="Цвет таймера после окончания времени"
              />
              <span className="text-[10px] font-mono text-gray-400 uppercase">{timerOvertimeTextColor}</span>
            </div>
            <div className="min-w-0 space-y-1">
              <div className="flex items-center justify-between gap-2">
                <label className="min-w-0 text-[11px] text-gray-400">Прозрачность шрифта:</label>
                <span className="shrink-0 text-right text-[10px] tabular-nums text-gray-300">
                  {Math.round(timerTextOpacity * 100)}%
                </span>
              </div>
              <input
                type="range"
                min={10}
                max={100}
                step={5}
                value={Math.round(timerTextOpacity * 100)}
                onChange={(e) => setTimerTextOpacity(Number(e.target.value) / 100)}
                className="block h-1 w-full min-w-0 cursor-pointer accent-blue-500"
              />
            </div>
            <div className="grid grid-cols-3 gap-1 rounded-sm bg-black/60 px-2 py-1.5 text-center font-mono text-lg font-bold">
              <span style={{ color: timerTextColor, opacity: timerTextOpacity }}>15:00</span>
              <span style={{ color: timerWarningTextColor, opacity: timerTextOpacity }}>00:59</span>
              <span style={{ color: timerOvertimeTextColor, opacity: timerTextOpacity }}>-00:01</span>
            </div>
            <button
              onClick={() => {
                setTimerTextColor('#ffffff')
                setTimerWarningTextColor('#facc15')
                setTimerOvertimeTextColor('#ef4444')
              }}
              className="text-[10px] text-gray-500 hover:text-white transition-colors"
            >
              Сбросить цвета
            </button>
          </div>

          {/* Sound settings */}
          <div className="border-t border-gray-700 pt-2 mt-2 space-y-2">
            <div className="min-w-0 space-y-1">
              <label className="block text-[11px] text-gray-400">Звук (1 мин):</label>
              <div className="flex min-w-0 items-center gap-2">
              <button
                onClick={async (e) => {
                  e.stopPropagation()
                  const path = await window.api.selectSoundFile()
                  if (path) setTimerSoundWarning(path)
                }}
                className="min-w-0 flex-1 truncate rounded-sm bg-gray-700 px-2 py-1 text-[10px] text-gray-300 transition-colors hover:bg-gray-600"
                title={timerSoundWarning || 'Выбрать звук'}
              >
                {timerSoundWarning ? timerSoundWarning.split(/[\\/]/).pop() : '🔔 Выбрать'}
              </button>
              {timerSoundWarning && (
                <>
                  <button
                    onClick={() => playTimerSound(timerSoundWarning, 'warning')}
                    className="text-[10px] text-gray-400 hover:text-white"
                    title="Проверить"
                  >🔊</button>
                  <button onClick={() => setTimerSoundWarning(null)} className="text-[10px] text-gray-500 hover:text-white">✕</button>
                </>
              )}
              </div>
            </div>
            <div className="min-w-0 space-y-1">
              <label className="block text-[11px] text-gray-400">Звук (конец):</label>
              <div className="flex min-w-0 items-center gap-2">
              <button
                onClick={async (e) => {
                  e.stopPropagation()
                  const path = await window.api.selectSoundFile()
                  if (path) setTimerSoundEnd(path)
                }}
                className="min-w-0 flex-1 truncate rounded-sm bg-gray-700 px-2 py-1 text-[10px] text-gray-300 transition-colors hover:bg-gray-600"
                title={timerSoundEnd || 'Выбрать звук'}
              >
                {timerSoundEnd ? timerSoundEnd.split(/[\\/]/).pop() : '🔔 Выбрать'}
              </button>
              {timerSoundEnd && (
                <>
                  <button
                    onClick={() => playTimerSound(timerSoundEnd, 'end')}
                    className="text-[10px] text-gray-400 hover:text-white"
                    title="Проверить"
                  >🔊</button>
                  <button onClick={() => setTimerSoundEnd(null)} className="text-[10px] text-gray-500 hover:text-white">✕</button>
                </>
              )}
              </div>
            </div>
          </div>
            </div>
          </div>

          {/* Close button */}
          <button
            data-pdm-training-close
            onClick={() => setExpanded(false)}
            className="absolute top-2 right-2 text-gray-500 hover:text-white text-sm"
          >✕</button>
        </div>
      )}
    </>
  )
}
