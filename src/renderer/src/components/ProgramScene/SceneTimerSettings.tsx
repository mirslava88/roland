import { useEffect, useState } from 'react'
import { useAppStore } from '../../stores/useAppStore'
import { playTimerSound } from '../../timer-controls'

interface Props {
  duration: number
  remaining: number
  running: boolean
  position: { x: number; y: number }
  scale: number
  textColor: string
  warningTextColor: string
  overtimeTextColor: string
  textOpacity: number
  onPositionChange: (position: { x: number; y: number }) => void
  onScaleChange: (scale: number) => void
  onTextColorChange: (color: string) => void
  onWarningTextColorChange: (color: string) => void
  onOvertimeTextColorChange: (color: string) => void
  onTextOpacityChange: (opacity: number) => void
  onSetDuration: (seconds: number) => void
  onStart: () => void
  onPause: () => void
  onStop: () => void
  onReset: () => void
  onAddMinutes: (minutes: number) => void
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))

function percent(value: number): number {
  return Math.round(clamp(value, 0, 100))
}

function formatTime(totalSeconds: number): string {
  const negative = totalSeconds < 0
  const absolute = Math.abs(totalSeconds)
  const hours = Math.floor(absolute / 3600)
  const minutes = Math.floor((absolute % 3600) / 60)
  const seconds = absolute % 60
  const pad = (value: number): string => value.toString().padStart(2, '0')
  const value = hours > 0
    ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`
  return negative ? `-${value}` : value
}

function fileName(path: string | null): string {
  return path?.replace(/\\/g, '/').split('/').pop() || ''
}

export function SceneTimerSettings({
  duration: timerDuration,
  remaining: timerRemaining,
  running: timerRunning,
  position,
  scale,
  textColor,
  warningTextColor,
  overtimeTextColor,
  textOpacity,
  onPositionChange,
  onScaleChange,
  onTextColorChange,
  onWarningTextColorChange,
  onOvertimeTextColorChange,
  onTextOpacityChange,
  onSetDuration,
  onStart,
  onPause,
  onStop,
  onReset,
  onAddMinutes
}: Props): JSX.Element {
  const timerSoundWarning = useAppStore((state) => state.timerSoundWarning)
  const timerSoundEnd = useAppStore((state) => state.timerSoundEnd)
  const setTimerSoundWarning = useAppStore((state) => state.setTimerSoundWarning)
  const setTimerSoundEnd = useAppStore((state) => state.setTimerSoundEnd)
  const initialTimerSeconds = timerDuration > 0 ? timerDuration : 15 * 60
  const [inputHours, setInputHours] = useState(() => String(Math.floor(initialTimerSeconds / 3600)))
  const [inputMinutes, setInputMinutes] = useState(() => String(Math.floor((initialTimerSeconds % 3600) / 60)))
  const [addMinutes, setAddMinutes] = useState('')
  const [subtractMinutes, setSubtractMinutes] = useState('')
  const [activeSection, setActiveSection] = useState<'time' | 'appearance' | 'sound'>('time')

  useEffect(() => {
    if (timerDuration <= 0) return
    setInputHours(String(Math.floor(timerDuration / 3600)))
    setInputMinutes(String(Math.floor((timerDuration % 3600) / 60)))
  }, [timerDuration])

  const requestedSeconds = (): number => {
    const hours = clamp(parseInt(inputHours) || 0, 0, 23)
    const minutes = clamp(parseInt(inputMinutes) || 0, 0, 59)
    return hours * 3600 + minutes * 60
  }

  const setTime = (): void => {
    const seconds = requestedSeconds()
    if (seconds > 0) onSetDuration(seconds)
  }

  const start = (): void => {
    if (timerDuration <= 0) setTime()
    onStart()
  }

  const changeCustomMinutes = (direction: 1 | -1): void => {
    const source = direction > 0 ? addMinutes : subtractMinutes
    const minutes = parseInt(source)
    if (!Number.isFinite(minutes) || minutes <= 0) return
    onAddMinutes(minutes * direction)
    if (direction > 0) setAddMinutes('')
    else setSubtractMinutes('')
  }

  const chooseSound = async (kind: 'warning' | 'end'): Promise<void> => {
    const path = await window.api.selectSoundFile()
    if (!path) return
    if (kind === 'warning') setTimerSoundWarning(path)
    else setTimerSoundEnd(path)
  }

  const overtime = timerRemaining < 0
  const warning = timerRunning && timerRemaining >= 0 && timerRemaining <= 60
  const currentColor = overtime ? overtimeTextColor : warning ? warningTextColor : textColor

  const colors = [
    { label: 'Основной', value: textColor, onChange: onTextColorChange },
    { label: '1 минута', value: warningTextColor, onChange: onWarningTextColorChange },
    { label: 'Перелимит', value: overtimeTextColor, onChange: onOvertimeTextColorChange }
  ]

  return (
    <div data-program-scene-timer-settings className="grid h-full min-h-0 content-start gap-2 overflow-hidden rounded-lg border border-blue-500/50 bg-surface-100 p-2.5 shadow-sm shadow-blue-950/30">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-white">Настройки таймера</div>
          <div className="text-[9px] leading-tight text-gray-400">Положение и оформление попадут в эфир после ↻.</div>
        </div>
        <div className="rounded bg-black/60 px-2 py-1 font-mono text-base font-bold tabular-nums" style={{ color: currentColor, opacity: textOpacity }}>
          {timerDuration > 0 || timerRunning ? formatTime(timerRemaining) : '--:--'}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-1 rounded-md bg-gray-950/60 p-1">
        {([
          ['time', 'Время'],
          ['appearance', 'Положение и вид'],
          ['sound', 'Звуки']
        ] as const).map(([section, label]) => (
          <button key={section} type="button" data-program-scene-timer-tab={section}
            onClick={() => setActiveSection(section)}
            className={`h-7 rounded px-1 text-[10px] font-medium transition-colors ${activeSection === section
              ? 'bg-blue-600 text-white'
              : 'text-gray-300 hover:bg-gray-700 hover:text-white'}`}>
            {label}
          </button>
        ))}
      </div>

      {activeSection === 'time' && <div data-program-scene-timer-time className="space-y-1.5 rounded-md border border-gray-700 bg-gray-950/45 p-2">
        <div className="flex items-center gap-1">
          <span className="mr-0.5 text-[10px] text-gray-400">Время</span>
          <input aria-label="Часы таймера" type="number" min={0} max={23} value={inputHours}
            onChange={(event) => setInputHours(event.target.value)}
            className="h-7 w-10 rounded border border-gray-600 bg-gray-800 px-1 text-center text-[11px] text-white" />
          <span className="text-[9px] text-gray-500">ч</span>
          <input aria-label="Минуты таймера" type="number" min={0} max={59} value={inputMinutes}
            onChange={(event) => setInputMinutes(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') setTime() }}
            className="h-7 w-10 rounded border border-gray-600 bg-gray-800 px-1 text-center text-[11px] text-white" />
          <span className="text-[9px] text-gray-500">мин</span>
          <button type="button" data-program-scene-timer-set onClick={setTime} className="h-7 rounded bg-blue-600 px-2 text-[10px] text-white hover:bg-blue-500">Установить</button>
          <button type="button" data-program-scene-timer-start-pause onClick={() => timerRunning
            ? onPause()
            : start()}
            className={`flex h-7 w-7 items-center justify-center rounded text-[11px] text-white ${timerRunning ? 'bg-yellow-700 hover:bg-yellow-600' : 'bg-green-700 hover:bg-green-600'}`}
            title={timerRunning ? 'Пауза' : 'Старт'}>{timerRunning ? '⏸' : '▶'}</button>
          <button type="button" onClick={onStop}
            className="flex h-7 w-7 items-center justify-center rounded bg-red-700 text-[11px] text-white hover:bg-red-600" title="Стоп">⏹</button>
          <button type="button" onClick={onReset}
            disabled={timerDuration <= 0}
            className="h-7 rounded bg-gray-700 px-1.5 text-[10px] text-gray-200 hover:bg-gray-600 disabled:opacity-40" title="Вернуть установленное время">Сброс</button>
        </div>

        {([1, -1] as const).map((direction) => {
          const adding = direction > 0
          const value = adding ? addMinutes : subtractMinutes
          return (
            <div key={direction} className="grid grid-cols-[45px_repeat(3,minmax(0,1fr))_38px_24px] items-center gap-1">
              <span className="text-[9px] text-gray-400">{adding ? 'Добавить' : 'Убавить'}</span>
              {[1, 5, 10].map((minutes) => (
                <button key={minutes} type="button" data-program-scene-timer-adjust={minutes * direction} onClick={() => onAddMinutes(minutes * direction)}
                  className="h-6 rounded bg-gray-700 px-0.5 text-[9px] text-gray-200 hover:bg-gray-600">
                  {adding ? '+' : '-'}{minutes}
                </button>
              ))}
              <input aria-label={`${adding ? 'Добавить' : 'Убавить'} минут`} type="number" min={1} value={value}
                onChange={(event) => adding ? setAddMinutes(event.target.value) : setSubtractMinutes(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') changeCustomMinutes(direction) }}
                className="h-6 min-w-0 rounded border border-gray-600 bg-gray-800 px-0.5 text-center text-[10px] text-white" />
              <button type="button" onClick={() => changeCustomMinutes(direction)}
                className="h-6 rounded bg-gray-700 text-[10px] text-gray-200 hover:bg-gray-600">{adding ? '+' : '−'}</button>
            </div>
          )
        })}
      </div>}

      {activeSection === 'appearance' && <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1.5 rounded-md border border-gray-700 bg-gray-950/45 p-2">
          <div className="flex items-center justify-between text-[10px] font-medium text-gray-300">
            <span>Положение и размер</span><span className="tabular-nums text-white">{Math.round(scale * 100)}%</span>
          </div>
          <input data-program-scene-timer-scale type="range" min={50} max={800} step={10}
            value={Math.round(scale * 100)} onChange={(event) => onScaleChange(Number(event.target.value) / 100)}
            className="h-1.5 w-full cursor-pointer accent-blue-500" />
          {(['x', 'y'] as const).map((axis) => (
            <div key={axis} className="grid grid-cols-[14px_minmax(0,1fr)_30px] items-center gap-1 text-[9px] text-gray-400">
              <span>{axis.toUpperCase()}</span>
              <input aria-label={`Положение таймера по ${axis === 'x' ? 'горизонтали' : 'вертикали'}`} type="range" min={0} max={100} step={1}
                value={percent(position[axis])}
                onChange={(event) => onPositionChange({ ...position, [axis]: Number(event.target.value) })}
                className="h-1.5 w-full cursor-pointer accent-blue-500" />
              <span className="text-right tabular-nums text-gray-200">{percent(position[axis])}%</span>
            </div>
          ))}
          <button type="button" onClick={() => { onPositionChange({ x: 90, y: 90 }); onScaleChange(1) }}
            className="text-[9px] text-gray-400 hover:text-white">Вернуть положение</button>
        </div>

        <div className="space-y-1.5 rounded-md border border-gray-700 bg-gray-950/45 p-2">
          <div className="text-[10px] font-medium text-gray-300">Оформление</div>
          {colors.map((item) => (
            <label key={item.label} className="flex items-center justify-between gap-1 text-[9px] text-gray-400">
              <span>{item.label}</span>
              <input type="color" value={item.value} onChange={(event) => item.onChange(event.target.value)}
                className="h-6 w-9 cursor-pointer rounded border border-gray-600 bg-gray-800 p-0.5" />
            </label>
          ))}
          <div className="flex items-center gap-1 text-[9px] text-gray-400">
            <span>Прозр.</span>
            <input aria-label="Прозрачность таймера" type="range" min={10} max={100} step={5}
              value={Math.round(textOpacity * 100)} onChange={(event) => onTextOpacityChange(Number(event.target.value) / 100)}
              className="h-1.5 min-w-0 flex-1 cursor-pointer accent-blue-500" />
            <span className="w-7 text-right tabular-nums text-gray-200">{Math.round(textOpacity * 100)}%</span>
          </div>
          <button type="button" onClick={() => {
            onTextColorChange('#ffffff'); onWarningTextColorChange('#facc15'); onOvertimeTextColorChange('#ef4444')
          }} className="text-[9px] text-gray-400 hover:text-white">Сбросить цвета</button>
        </div>
      </div>}

      {activeSection === 'sound' && <div className="space-y-1.5 rounded-md border border-gray-700 bg-gray-950/45 p-2">
        <div className="text-[10px] font-medium text-gray-300">Звуковые сигналы</div>
        {([
          { kind: 'warning' as const, label: 'За 1 минуту', path: timerSoundWarning, clear: () => setTimerSoundWarning(null) },
          { kind: 'end' as const, label: 'Окончание', path: timerSoundEnd, clear: () => setTimerSoundEnd(null) }
        ]).map((sound) => (
          <div key={sound.kind} data-program-scene-timer-sound={sound.kind} className="grid grid-cols-[68px_minmax(0,1fr)_25px_25px] items-center gap-1">
            <span className="text-[9px] text-gray-400">{sound.label}</span>
            <button type="button" onClick={() => void chooseSound(sound.kind)} title={sound.path || 'Выбрать звук'}
              className="h-6 min-w-0 truncate rounded bg-gray-700 px-1.5 text-left text-[9px] text-gray-200 hover:bg-gray-600">
              {sound.path ? fileName(sound.path) : '🔔 Выбрать файл'}
            </button>
            <button type="button" disabled={!sound.path} onClick={() => sound.path && playTimerSound(sound.path, sound.kind)}
              className="h-6 rounded text-[10px] text-gray-300 hover:bg-gray-700 hover:text-white disabled:opacity-30" title="Проверить звук">🔊</button>
            <button type="button" disabled={!sound.path} onClick={sound.clear}
              className="h-6 rounded text-[10px] text-gray-400 hover:bg-red-900/60 hover:text-white disabled:opacity-30" title="Удалить звук">✕</button>
          </div>
        ))}
      </div>}
    </div>
  )
}
