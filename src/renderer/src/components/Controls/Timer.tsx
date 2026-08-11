import { useState, useEffect, useRef } from 'react'
import { useAppStore } from '../../stores/useAppStore'
import { mediaUrl } from '../../media'

// Play timer sound file. File URL требует URL-encoding для кириллицы/
// пробелов/других non-ASCII символов в пути — иначе Chromium не загружает
// (load error, тихо отваливается, sound не слышен). Ошибки логируются
// через dbgLog чтобы диагностируемо было в main stdout.
function playTimerSound(rawPath: string, kind: 'warning' | 'end'): void {
  try {
    // Served via the pdm-media:// privileged scheme (mediaUrl handles encoding
    // of Cyrillic/spaces/backslashes) so it loads under webSecurity:true.
    const url = mediaUrl(rawPath)
    window.api.dbgLog(`Timer: play ${kind} sound url=${url}`)
    const a = new Audio(url)
    a.volume = 1.0
    a.play().then(() => {
      window.api.dbgLog(`Timer: ${kind} sound playing OK`)
    }).catch((e) => {
      window.api.dbgLog(`Timer: ${kind} sound play() failed: ${String(e)}`)
    })
  } catch (e) {
    window.api.dbgLog(`Timer: ${kind} sound Audio() threw: ${String(e)}`)
  }
}

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

export function Timer(): JSX.Element {
  const {
    timerDuration,
    timerRemaining,
    timerRunning,
    timerSoundEnd,
    timerSoundWarning,
    timerTextColor,
    timerWarningTextColor,
    timerOvertimeTextColor,
    timerTextOpacity,
    displays,
    displayAssignments,
    selectedDisplayId,
    setTimerDuration,
    setTimerRemaining,
    setTimerRunning,
    addTimerMinutes,
    resetTimer,
    setTimerSoundEnd,
    setTimerSoundWarning,
    setTimerTextColor,
    setTimerWarningTextColor,
    setTimerOvertimeTextColor,
    setTimerTextOpacity
  } = useAppStore()

  const [inputH, setInputH] = useState('0')
  const [inputM, setInputM] = useState('15')
  const [addMinInput, setAddMinInput] = useState('')
  const [subMinInput, setSubMinInput] = useState('')
  const [expanded, setExpanded] = useState(false)

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const warnedRef = useRef(false)
  const endedRef = useRef(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)

  const hasDedicatedTimerDisplay = displays.some((display) => (
    !display.isPrimary && displayAssignments[String(display.id)] === 'timer'
  ))

  // Keep the native overlay data current for the automatic fallback. The
  // update is sent before the overlay is opened so its first frame is never
  // an empty/zero timer.
  useEffect(() => {
    if (timerDuration <= 0 || hasDedicatedTimerDisplay) return
    window.api.updateTimerOverlay({
      remaining: timerRemaining,
      running: timerRunning,
      duration: timerDuration,
      posX: 90,
      posY: 90,
      scale: 1,
      textColor: timerTextColor,
      warningTextColor: timerWarningTextColor,
      overtimeTextColor: timerOvertimeTextColor,
      textOpacity: timerTextOpacity
    })
  }, [
    hasDedicatedTimerDisplay,
    timerDuration,
    timerOvertimeTextColor,
    timerRemaining,
    timerRunning,
    timerTextColor,
    timerTextOpacity,
    timerWarningTextColor
  ])

  // "Screens" is the only explicit output selector. Without a dedicated
  // timer display, fall back to the main program display as an overlay.
  useEffect(() => {
    if (timerDuration > 0 && !hasDedicatedTimerDisplay) {
      void window.api.showTimerOverlay(selectedDisplayId ?? undefined)
    } else {
      void window.api.hideTimerOverlay()
    }
  }, [hasDedicatedTimerDisplay, selectedDisplayId, timerDuration])

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
  }

  const handlePause = (): void => {
    setTimerRunning(false)
  }

  const handleStop = (): void => {
    setTimerRunning(false)
    setTimerDuration(0)
    setTimerRemaining(0)
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
          ref={panelRef}
          className="absolute top-full mt-1 left-1/2 -translate-x-1/2 bg-surface-100 border border-gray-700 rounded-lg shadow-xl p-3 z-50 min-w-[320px]"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <div className="text-[11px] text-gray-400 font-bold uppercase mb-2">Настройки таймера</div>

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

          {/* Appearance settings */}
          <div className="border-t border-gray-700 pt-2 mt-2 mb-2 space-y-2">
            <div className="flex items-center gap-2">
              <label className="text-[11px] text-gray-400 shrink-0 w-40">Цвет основного таймера:</label>
              <input
                type="color"
                value={timerTextColor}
                onChange={(e) => setTimerTextColor(e.target.value)}
                className="h-7 w-12 cursor-pointer rounded-sm border border-gray-600 bg-gray-800 p-0.5"
                title="Цвет основного таймера"
              />
              <span className="text-[10px] font-mono text-gray-400 uppercase">{timerTextColor}</span>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-[11px] text-gray-400 shrink-0 w-40">Цвет за 1 мин до конца:</label>
              <input
                type="color"
                value={timerWarningTextColor}
                onChange={(e) => setTimerWarningTextColor(e.target.value)}
                className="h-7 w-12 cursor-pointer rounded-sm border border-gray-600 bg-gray-800 p-0.5"
                title="Цвет таймера за одну минуту до окончания"
              />
              <span className="text-[10px] font-mono text-gray-400 uppercase">{timerWarningTextColor}</span>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-[11px] text-gray-400 shrink-0 w-40">Цвет перелимита времени:</label>
              <input
                type="color"
                value={timerOvertimeTextColor}
                onChange={(e) => setTimerOvertimeTextColor(e.target.value)}
                className="h-7 w-12 cursor-pointer rounded-sm border border-gray-600 bg-gray-800 p-0.5"
                title="Цвет таймера после окончания времени"
              />
              <span className="text-[10px] font-mono text-gray-400 uppercase">{timerOvertimeTextColor}</span>
            </div>
            <div className="flex items-center gap-2">
              <label className="text-[11px] text-gray-400 shrink-0 w-40">Прозрачность шрифта:</label>
              <input
                type="range"
                min={10}
                max={100}
                step={5}
                value={Math.round(timerTextOpacity * 100)}
                onChange={(e) => setTimerTextOpacity(Number(e.target.value) / 100)}
                className="h-1 flex-1 cursor-pointer accent-blue-500"
              />
              <span className="w-9 text-right text-[10px] tabular-nums text-gray-300">
                {Math.round(timerTextOpacity * 100)}%
              </span>
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
            <div className="flex items-center gap-2">
              <label className="text-[11px] text-gray-400 shrink-0 w-28">Звук (1 мин):</label>
              <button
                onClick={async (e) => {
                  e.stopPropagation()
                  const path = await window.api.selectSoundFile()
                  if (path) setTimerSoundWarning(path)
                }}
                className="text-[10px] px-2 py-1 rounded-sm bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors truncate max-w-[160px]"
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
            <div className="flex items-center gap-2">
              <label className="text-[11px] text-gray-400 shrink-0 w-28">Звук (конец):</label>
              <button
                onClick={async (e) => {
                  e.stopPropagation()
                  const path = await window.api.selectSoundFile()
                  if (path) setTimerSoundEnd(path)
                }}
                className="text-[10px] px-2 py-1 rounded-sm bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors truncate max-w-[160px]"
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

          {/* Close button */}
          <button
            onClick={() => setExpanded(false)}
            className="absolute top-2 right-2 text-gray-500 hover:text-white text-sm"
          >✕</button>
        </div>
      )}
    </>
  )
}
