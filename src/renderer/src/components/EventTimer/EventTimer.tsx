import { useEffect, useState } from 'react'
import {
  useAppStore,
  type EventTimerCentralMode,
  type EventTimerState,
  type EventTimerVisibility
} from '../../stores/useAppStore'
import { EventTimerScene } from './EventTimerScene'

function defaultHeading(mode: EventTimerCentralMode): string {
  if (mode === 'current') return 'Текущее время:'
  if (mode === 'timer') return 'Таймер:'
  if (mode === 'to-start') return 'До начала мероприятия:'
  return 'До конца мероприятия:'
}

function nextTimerTick(timer: EventTimerState): Pick<EventTimerState, 'remaining' | 'overtimeCostTotal'> {
  const remaining = timer.remaining - 1
  const overtimeIncrement = remaining < 0 && timer.costPerMinute > 0
    ? timer.costPerMinute / 60
    : 0
  return {
    remaining,
    overtimeCostTotal: Math.max(0, timer.overtimeCostTotal + overtimeIncrement)
  }
}

type EditableTimePart = 'hours' | 'minutes' | 'seconds'
type EditableTimeParts = Record<EditableTimePart, string>

function timePartsFromSeconds(totalSeconds: number): EditableTimeParts {
  const absolute = Math.abs(Math.trunc(totalSeconds))
  const hours = Math.min(99, Math.floor(absolute / 3600))
  const minutes = Math.floor((absolute % 3600) / 60)
  const seconds = absolute % 60
  const pad = (value: number): string => String(value).padStart(2, '0')
  return { hours: pad(hours), minutes: pad(minutes), seconds: pad(seconds) }
}

function normalizeTimePart(part: EditableTimePart, value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 2)
  if (!digits) return ''
  const maximum = part === 'hours' ? 99 : 59
  return String(Math.min(maximum, Number(digits))).padStart(digits.length, '0')
}

function secondsFromTimeParts(parts: EditableTimeParts): number {
  const hours = Math.min(99, Number(parts.hours) || 0)
  const minutes = Math.min(59, Number(parts.minutes) || 0)
  const seconds = Math.min(59, Number(parts.seconds) || 0)
  return hours * 3600 + minutes * 60 + seconds
}

const visibilityLabels: Array<[keyof EventTimerVisibility, string]> = [
  ['clock', 'Часы слева'],
  ['schedule', 'Начало / конец'],
  ['heading', 'Заголовок'],
  ['eventName', 'Название мероприятия'],
  ['remaining', 'До завершения'],
  ['cost', 'Стоимость']
]

export function EventTimer(): JSX.Element {
  const {
    eventTimer,
    eventTimerOutput,
    setEventTimer,
    setEventTimerOutput,
    displays,
    displayAssignments
  } = useAppStore()
  const [open, setOpen] = useState(false)
  const [hasUnpublishedChanges, setHasUnpublishedChanges] = useState(false)
  const [liveControlEnabled, setLiveControlEnabled] = useState(false)
  const [editingTime, setEditingTime] = useState(false)
  const [timePartsDirty, setTimePartsDirty] = useState(false)
  const [timeParts, setTimeParts] = useState(() => timePartsFromSeconds(eventTimer.remaining))
  const isLive = eventTimerOutput !== null

  const assignedDisplays = displays.filter((display) => (
    !display.isPrimary && displayAssignments[String(display.id)] === 'event-timer'
  ))

  useEffect(() => {
    if (!eventTimer.running && !eventTimerOutput?.running) return
    const interval = setInterval(() => {
      const state = useAppStore.getState()
      if (state.eventTimer.running) {
        state.setEventTimer(nextTimerTick(state.eventTimer))
      }
      if (state.eventTimerOutput?.running) {
        state.setEventTimerOutput({
          ...state.eventTimerOutput,
          ...nextTimerTick(state.eventTimerOutput)
        })
      }
    }, 1000)
    return () => clearInterval(interval)
  }, [eventTimer.running, eventTimerOutput?.running])

  useEffect(() => {
    if (!editingTime) setTimeParts(timePartsFromSeconds(eventTimer.remaining))
  }, [editingTime, eventTimer.remaining])

  useEffect(() => {
    if (!isLive) setLiveControlEnabled(false)
  }, [isLive])

  const updateDraft = (update: Partial<EventTimerState>): void => {
    setEventTimer(update)
    if (isLive) setHasUnpublishedChanges(true)
  }

  const updateTimerControl = (
    update: Partial<Pick<EventTimerState, 'duration' | 'remaining' | 'running'>>
  ): void => {
    const nextDraft = { ...eventTimer, ...update }
    setEventTimer(update)
    if (isLive && liveControlEnabled && eventTimerOutput) {
      setEventTimerOutput({
        ...eventTimerOutput,
        duration: nextDraft.duration,
        remaining: nextDraft.remaining,
        running: nextDraft.running
      })
      return
    }
    if (isLive) setHasUnpublishedChanges(true)
  }

  const commitTimeParts = (): void => {
    if (!timePartsDirty) {
      setTimeParts(timePartsFromSeconds(eventTimer.remaining))
      setEditingTime(false)
      return
    }
    const nextSeconds = secondsFromTimeParts(timeParts)
    updateTimerControl({
      remaining: nextSeconds,
      duration: nextSeconds,
      running: false
    })
    setTimeParts(timePartsFromSeconds(nextSeconds))
    setEditingTime(false)
    setTimePartsDirty(false)
  }

  const updateSchedule = (field: 'startTime' | 'endTime', value: string): void => {
    updateDraft({ [field]: value })
  }

  const selectCentralTimeMode = (mode: EventTimerCentralMode): void => {
    updateDraft({ centralTimeMode: mode })
  }

  const start = (): void => updateTimerControl({ running: true })

  const stop = (): void => updateTimerControl({ running: false, remaining: eventTimer.duration })

  const adjustMinutes = (minutes: number): void => {
    const delta = minutes * 60
    updateTimerControl({
      duration: Math.max(0, eventTimer.duration + delta),
      remaining: eventTimer.remaining + delta
    })
  }

  const restoreTimerFromLive = (): void => {
    if (!eventTimerOutput) return
    const nextDraft = {
      ...eventTimer,
      duration: eventTimerOutput.duration,
      remaining: eventTimerOutput.remaining,
      running: eventTimerOutput.running
    }
    setEventTimer({
      duration: eventTimerOutput.duration,
      remaining: eventTimerOutput.remaining,
      running: eventTimerOutput.running
    })
    setTimeParts(timePartsFromSeconds(eventTimerOutput.remaining))
    setEditingTime(false)
    setTimePartsDirty(false)
    setHasUnpublishedChanges(JSON.stringify(nextDraft) !== JSON.stringify(eventTimerOutput))
  }

  const toggleVisibility = (key: keyof EventTimerVisibility): void => {
    updateDraft({
      visibility: { ...eventTimer.visibility, [key]: !eventTimer.visibility[key] }
    })
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`text-xs px-2 py-1.5 rounded-lg font-medium transition-colors border ${
          isLive
            ? 'bg-emerald-600/80 border-emerald-500 text-white hover:bg-emerald-600'
            : 'bg-surface-100 border-gray-700 text-gray-300 hover:bg-gray-700'
        }`}
        title="Дополнительный таймер мероприятия"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        ◷ Таймер+
      </button>

      {open && (
        <div className="event-timer-ui fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-3">
          <div
            className="flex h-[calc(100vh-24px)] w-[min(1440px,calc(100vw-24px))] flex-col overflow-hidden rounded-2xl border border-gray-700 bg-surface-300 shadow-2xl"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <header className="flex shrink-0 items-center justify-between border-b border-gray-700 px-5 py-3">
              <div>
                <h2 className="text-base font-semibold text-white">Таймер мероприятия</h2>
                <p className="mt-0.5 text-[10px] text-gray-500">
                  Дополнительный полноэкранный таймер; простой таймер PDM работает независимо
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className={`text-[10px] ${assignedDisplays.length ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {assignedDisplays.length
                    ? `Назначено экранов: ${assignedDisplays.length}`
                    : 'Назначьте «Таймер мероприятия» в разделе «Экраны»'}
                </span>
                <button type="button" onClick={() => setOpen(false)} className="text-xl text-gray-500 hover:text-white">✕</button>
              </div>
            </header>

            <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.65fr)_minmax(320px,0.85fr)] gap-3 p-3">
              <section className="flex min-h-0 min-w-0 flex-col gap-3 rounded-xl border border-gray-700 bg-surface-200 p-3">
                <h3 className="text-center text-sm font-semibold text-white">Настройка таймера</h3>
                <div className="grid shrink-0 grid-cols-2 gap-x-4 gap-y-2">
                  <label className="space-y-1 text-[11px] text-gray-400">
                    <span className="flex items-center justify-between gap-2">
                      <span>Заголовок:</span>
                      {eventTimer.headings[eventTimer.centralTimeMode] !== defaultHeading(eventTimer.centralTimeMode) && (
                        <button
                          type="button"
                          onClick={() => updateDraft({
                            headings: {
                              ...eventTimer.headings,
                              [eventTimer.centralTimeMode]: defaultHeading(eventTimer.centralTimeMode)
                            }
                          })}
                          className="text-[9px] text-emerald-400 hover:text-emerald-300"
                          title="Вернуть автоматический заголовок выбранного режима"
                        >
                          Авто
                        </button>
                      )}
                    </span>
                    <input
                      value={eventTimer.headings[eventTimer.centralTimeMode]}
                      maxLength={120}
                      onChange={(event) => updateDraft({
                        headings: {
                          ...eventTimer.headings,
                          [eventTimer.centralTimeMode]: event.target.value
                        }
                      })}
                      className="w-full rounded-lg border border-gray-700 bg-surface-100 px-3 py-2 text-xs text-white outline-hidden focus:border-emerald-500"
                    />
                  </label>
                  <div className="space-y-1 text-[11px] text-gray-400">
                    <span>Время мероприятия:</span>
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        type="time"
                        value={eventTimer.startTime}
                        onChange={(event) => updateSchedule('startTime', event.target.value)}
                        className="rounded-lg border border-gray-700 bg-surface-100 px-3 py-2 text-center text-xs text-white outline-hidden focus:border-emerald-500"
                      />
                      <input
                        type="time"
                        value={eventTimer.endTime}
                        onChange={(event) => updateSchedule('endTime', event.target.value)}
                        className="rounded-lg border border-gray-700 bg-surface-100 px-3 py-2 text-center text-xs text-white outline-hidden focus:border-emerald-500"
                      />
                    </div>
                  </div>
                  <label className="space-y-1 text-[11px] text-gray-400">
                    <span>Название мероприятия:</span>
                    <input
                      value={eventTimer.eventName}
                      maxLength={120}
                      onChange={(event) => updateDraft({ eventName: event.target.value })}
                      className="w-full rounded-lg border border-gray-700 bg-surface-100 px-3 py-2 text-xs text-white outline-hidden focus:border-emerald-500"
                    />
                  </label>
                  <label className="space-y-1 text-[11px] text-gray-400">
                    <span>Расчёт стоимости:</span>
                    <div className="flex gap-2">
                      <div className="relative min-w-0 flex-1">
                        <input
                          type="number"
                          min={0}
                          step={1}
                          value={eventTimer.costPerMinute || ''}
                          placeholder="Стоимость (руб/мин)"
                          onChange={(event) => updateDraft({ costPerMinute: Math.max(0, Number(event.target.value) || 0) })}
                          className="w-full rounded-lg border border-gray-700 bg-surface-100 px-3 py-2 pr-16 text-xs text-white outline-hidden focus:border-emerald-500"
                        />
                        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-gray-500">₽ / мин</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => updateDraft({ overtimeCostTotal: 0 })}
                        className="shrink-0 rounded-lg border border-red-900/70 bg-red-950/40 px-2.5 py-2 text-[9px] text-red-300 transition-colors hover:bg-red-900/60"
                        title="Сбросить общую накопленную стоимость перелимита"
                      >
                        Сбросить итог
                      </button>
                    </div>
                  </label>
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-xl border border-gray-700 bg-surface-300/50 p-2 text-[10px] text-gray-400">
                  <span className="mr-1">Фон:</span>
                  <button
                    type="button"
                    onClick={async () => {
                      const path = await window.api.selectBackdropImage()
                      if (path) updateDraft({ backgroundImage: path })
                    }}
                    className="rounded-lg border border-gray-700 bg-surface-100 px-2.5 py-1.5 text-gray-200 hover:border-gray-500"
                  >
                    Изображение
                  </button>
                  {eventTimer.backgroundImage && (
                    <button
                      type="button"
                      onClick={() => updateDraft({ backgroundImage: null })}
                      className="rounded-lg border border-gray-700 bg-surface-100 px-2.5 py-1.5 text-gray-400 hover:text-white"
                    >
                      Убрать
                    </button>
                  )}
                  <div className="flex rounded-lg border border-gray-700 bg-surface-100 p-0.5">
                    {([['solid', 'Один цвет'], ['gradient', 'Градиент']] as const).map(([mode, label]) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => updateDraft({ backgroundMode: mode })}
                        className={`rounded-md px-2 py-1 text-[9px] transition-colors ${
                          eventTimer.backgroundMode === mode
                            ? 'bg-emerald-600 text-white'
                            : 'text-gray-400 hover:text-white'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <label className="flex items-center gap-1.5 rounded-lg border border-gray-700 bg-surface-100 px-2 py-1 text-gray-200">
                    Цвет 1
                    <input
                      type="color"
                      value={eventTimer.backgroundColor}
                      onChange={(event) => updateDraft({ backgroundColor: event.target.value })}
                      className="h-5 w-8 cursor-pointer border-0 bg-transparent p-0"
                    />
                  </label>
                  <label className="flex items-center gap-1.5 rounded-lg border border-gray-700 bg-surface-100 px-2 py-1 text-gray-200">
                    Цвет шрифта
                    <input
                      type="color"
                      value={eventTimer.fontColor}
                      onChange={(event) => updateDraft({ fontColor: event.target.value })}
                      className="h-5 w-8 cursor-pointer border-0 bg-transparent p-0"
                    />
                  </label>
                  {eventTimer.backgroundMode === 'gradient' && (
                    <>
                      <label className="flex items-center gap-1.5 rounded-lg border border-gray-700 bg-surface-100 px-2 py-1 text-gray-200">
                        Цвет 2
                        <input
                          type="color"
                          value={eventTimer.backgroundGradientColor}
                          onChange={(event) => updateDraft({ backgroundGradientColor: event.target.value })}
                          className="h-5 w-8 cursor-pointer border-0 bg-transparent p-0"
                        />
                      </label>
                      <label className="flex items-center gap-1.5 rounded-lg border border-gray-700 bg-surface-100 px-2 py-1 text-gray-200">
                        Угол
                        <input
                          type="number"
                          min={0}
                          max={360}
                          value={eventTimer.backgroundGradientAngle}
                          onChange={(event) => updateDraft({
                            backgroundGradientAngle: Math.min(360, Math.max(0, Number(event.target.value) || 0))
                          })}
                          className="w-12 bg-transparent text-right text-[10px] text-white outline-hidden"
                        />
                        °
                      </label>
                    </>
                  )}
                </div>

                <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-gray-600 bg-black shadow-inner">
                  <EventTimerScene timer={eventTimer} />
                </div>
                <div className="shrink-0 text-center text-xs text-gray-500">Превью</div>
              </section>

              <aside className="flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto">
                <section className="rounded-xl border border-gray-700 bg-surface-200 p-3">
                  <h3 className="mb-3 text-center text-sm font-semibold text-white">Отображение элементов на экране</h3>
                  <div className="mb-3 space-y-2">
                    <div className="text-center text-[11px] text-gray-400">Центральное время:</div>
                    <div className="grid grid-cols-2 gap-1 rounded-xl border border-gray-700 bg-surface-100 p-1">
                      {([
                        ['current', 'Текущее время'],
                        ['timer', 'Таймер'],
                        ['to-start', 'До начала'],
                        ['to-end', 'До конца']
                      ] as const).map(([value, label]) => (
                        <button
                          key={value}
                          type="button"
                          onClick={() => selectCentralTimeMode(value)}
                          className={`rounded-full px-2 py-1.5 text-[10px] transition-colors ${
                            eventTimer.centralTimeMode === value
                              ? 'bg-emerald-600 text-white'
                              : 'text-gray-400 hover:text-white'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="mb-2 text-[11px] text-gray-400">Отображаемые элементы:</div>
                  <div className="grid grid-cols-2 gap-1.5 rounded-xl bg-emerald-950/30 p-2">
                    {visibilityLabels.map(([key, label]) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => toggleVisibility(key)}
                        className={`rounded-full px-2 py-1.5 text-[9px] transition-colors ${
                          eventTimer.visibility[key]
                            ? 'bg-emerald-600 text-white'
                            : 'bg-surface-100 text-gray-500 hover:text-gray-300'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </section>

                <section className="rounded-xl border border-gray-700 bg-surface-200 p-3">
                  <h3 className="mb-2 text-center text-sm font-semibold text-white">Управление таймером</h3>
                  <div className={`flex items-center justify-center gap-1 font-mono font-light tabular-nums ${
                    eventTimer.remaining < 0 ? 'text-red-500' : 'text-white'
                  }`}>
                    {eventTimer.remaining < 0 && <span className="text-[clamp(28px,3.5vw,50px)]">−</span>}
                    {(['hours', 'minutes', 'seconds'] as const).map((part, index) => (
                      <div key={part} className="flex items-center gap-1">
                        {index > 0 && <span className="text-[clamp(28px,3.5vw,50px)] text-gray-500">:</span>}
                        <input
                          type="text"
                          inputMode="numeric"
                          pattern="[0-9]*"
                          maxLength={2}
                          spellCheck={false}
                          value={timeParts[part]}
                          aria-label={part === 'hours' ? 'Часы' : part === 'minutes' ? 'Минуты' : 'Секунды'}
                          title="Не более двух цифр"
                          onFocus={(event) => {
                            setEditingTime(true)
                            setTimePartsDirty(false)
                            event.currentTarget.select()
                          }}
                          onChange={(event) => {
                            if (!timePartsDirty && eventTimer.running) updateTimerControl({ running: false })
                            setTimePartsDirty(true)
                            setTimeParts((current) => ({
                              ...current,
                              [part]: normalizeTimePart(part, event.target.value)
                            }))
                          }}
                          onBlur={commitTimeParts}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') event.currentTarget.blur()
                          }}
                          className="w-[1.65em] cursor-text rounded-lg border border-gray-700 bg-surface-100 px-0.5 text-center text-[clamp(28px,3.5vw,50px)] text-inherit outline-hidden transition-colors hover:border-gray-500 focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500/30"
                        />
                      </div>
                    ))}
                  </div>
                  <div className="mt-1 text-center text-[9px] text-gray-600">Отдельно измените часы, минуты или секунды</div>
                  <div className="mx-auto mt-2 flex w-fit items-center gap-2 rounded-full bg-surface-100 px-4 py-2">
                    <button type="button" onClick={() => updateTimerControl({ running: false })} className="btn-icon text-yellow-400" title="Пауза">Ⅱ</button>
                    <button type="button" onClick={start} className="btn-icon text-emerald-400" title="Старт">▶</button>
                    <button type="button" onClick={stop} className="btn-icon text-red-400" title="Стоп и сброс">■</button>
                    <button
                      type="button"
                      disabled={!isLive}
                      onClick={() => setLiveControlEnabled((enabled) => !enabled)}
                      className={`rounded-lg border px-2 py-1.5 text-[9px] font-black tracking-wide transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${
                        liveControlEnabled
                          ? 'border-red-400 bg-red-600 text-white shadow-[0_0_10px_rgba(239,68,68,0.45)]'
                          : 'border-gray-700 bg-surface-300 text-gray-500 hover:text-gray-300'
                      }`}
                      title={isLive
                        ? 'Применять команды управления таймером к эфиру немедленно'
                        : 'Сначала отправьте таймер в эфир'}
                    >
                      ⚡ LIVE
                    </button>
                  </div>
                  <div className="mt-3 grid grid-cols-7 gap-1">
                    {[-10, -5, -1, 0, 1, 5, 10].map((minutes) => (
                      <button
                        key={minutes}
                        type="button"
                        disabled={minutes === 0 && !eventTimerOutput}
                        onClick={() => minutes === 0 ? restoreTimerFromLive() : adjustMinutes(minutes)}
                        title={minutes === 0
                          ? eventTimerOutput
                            ? 'Вернуть в превью время и состояние таймера, которые сейчас идут в эфире'
                            : 'Сначала отправьте таймер в эфир'
                          : undefined}
                        className={`rounded-full px-1 py-1.5 text-[8px] transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                          minutes < 0
                            ? 'bg-red-950/70 text-red-300 hover:bg-red-900'
                            : minutes > 0
                              ? 'bg-emerald-950/70 text-emerald-300 hover:bg-emerald-900'
                              : 'bg-surface-100 text-gray-300 hover:bg-gray-700'
                        }`}
                      >
                        {minutes === 0 ? 'Сейчас' : `${minutes > 0 ? '+' : ''}${minutes} мин`}
                      </button>
                    ))}
                  </div>

                  {!isLive ? (
                    <button
                      type="button"
                      onClick={() => {
                        const output = {
                          ...eventTimer,
                          headings: { ...eventTimer.headings },
                          visibility: { ...eventTimer.visibility },
                          live: true
                        }
                        setEventTimer({ live: true })
                        setEventTimerOutput(output)
                        setHasUnpublishedChanges(false)
                        setLiveControlEnabled(false)
                      }}
                      className="mt-4 w-full rounded-full bg-emerald-600 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-emerald-500"
                    >
                      Отправить в эфир
                    </button>
                  ) : (
                    <div className="mt-4 grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        disabled={!hasUnpublishedChanges}
                        onClick={() => {
                          setEventTimerOutput({
                            ...eventTimer,
                            headings: { ...eventTimer.headings },
                            visibility: { ...eventTimer.visibility },
                            live: true
                          })
                          setHasUnpublishedChanges(false)
                        }}
                        className="rounded-full bg-blue-600 px-3 py-2 text-[11px] font-semibold text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-gray-700 disabled:text-gray-500"
                        title="Применить изменения из превью к экрану в эфире"
                      >
                        {hasUnpublishedChanges ? 'Обновить эфир' : 'Эфир обновлён'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEventTimerOutput(null)
                          setEventTimer({ live: false })
                          setHasUnpublishedChanges(false)
                          setLiveControlEnabled(false)
                        }}
                        className="rounded-full bg-red-600 px-3 py-2 text-[11px] font-semibold text-white transition-colors hover:bg-red-500"
                      >
                        Убрать из эфира
                      </button>
                    </div>
                  )}
                </section>
              </aside>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
