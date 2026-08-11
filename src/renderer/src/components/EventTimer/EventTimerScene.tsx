import { useEffect, useState } from 'react'
import { mediaUrl } from '../../media'
import type { EventTimerState } from '../../stores/useAppStore'

export function formatEventTimer(totalSeconds: number): string {
  const negative = totalSeconds < 0
  const absolute = Math.abs(Math.trunc(totalSeconds))
  const hours = Math.floor(absolute / 3600)
  const minutes = Math.floor((absolute % 3600) / 60)
  const seconds = absolute % 60
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${negative ? '−' : ''}${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
}

export function calculateEventTimerCost(timer: EventTimerState): number {
  return Math.max(0, timer.overtimeCostTotal)
}

function currentClock(date: Date): string {
  return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

function currentClockWithSeconds(date: Date): string {
  return date.toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

function secondsUntilTime(now: Date, time: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(time)
  if (!match) return 0
  const target = new Date(now)
  target.setHours(Number(match[1]), Number(match[2]), 0, 0)
  return Math.round((target.getTime() - now.getTime()) / 1000)
}

export function EventTimerScene({ timer, className = '' }: {
  timer: EventTimerState
  className?: string
}): JSX.Element {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(interval)
  }, [])

  const centralSeconds = timer.centralTimeMode === 'timer'
    ? timer.remaining
    : timer.centralTimeMode === 'to-start'
      ? secondsUntilTime(now, timer.startTime)
      : timer.centralTimeMode === 'to-end'
        ? secondsUntilTime(now, timer.endTime)
        : null
  const overtime = centralSeconds !== null && centralSeconds < 0
  const totalCost = calculateEventTimerCost(timer)
  const scheduledRemaining = secondsUntilTime(now, timer.endTime)
  const formattedCost = totalCost.toLocaleString('ru-RU', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  })
  const centralText = timer.centralTimeMode === 'current'
    ? currentClockWithSeconds(now)
    : formatEventTimer(centralSeconds ?? 0)
  const alertColor = '#ef1717'
  const background = timer.backgroundMode === 'gradient'
    ? `linear-gradient(${timer.backgroundGradientAngle}deg, ${timer.backgroundColor} 0%, ${timer.backgroundGradientColor} 100%)`
    : timer.backgroundColor

  return (
    <div
      className={`event-timer-scene relative h-full w-full overflow-hidden bg-black font-sans select-none ${className}`}
      style={{ containerType: 'size', color: timer.fontColor, background }}
    >
      {timer.backgroundImage && (
        <img
          src={mediaUrl(timer.backgroundImage)}
          className="absolute inset-0 h-full w-full object-cover"
          draggable={false}
        />
      )}

      {timer.visibility.clock && (
        <div className="event-scene-clock">
          {currentClock(now)}
        </div>
      )}

      {timer.visibility.schedule && (
        <div className="event-scene-schedule">
          <div>Начало:&nbsp; {timer.startTime}</div>
          <div>Конец:&nbsp; {timer.endTime}</div>
        </div>
      )}

      <div className="event-scene-center">
        {timer.visibility.heading && (
          <div className="event-scene-heading">
            {timer.headings[timer.centralTimeMode] || (
              timer.centralTimeMode === 'current'
                ? 'Текущее время:'
                : timer.centralTimeMode === 'timer'
                  ? 'Таймер:'
                  : timer.centralTimeMode === 'to-start'
                    ? 'До начала мероприятия:'
                    : 'До конца мероприятия:'
            )}
          </div>
        )}
        <div
          className="event-scene-time"
          style={{ color: overtime ? alertColor : undefined }}
        >
          {centralText}
        </div>
        {timer.visibility.eventName && (
          <div className="event-scene-event-wrap">
            <div
              className="event-scene-event"
              title={timer.eventName}
            >
              {timer.eventName || 'МЕРОПРИЯТИЕ'}
            </div>
          </div>
        )}
      </div>

      {timer.visibility.remaining && (
        <div className="event-scene-remaining">
          До завершения: {formatEventTimer(scheduledRemaining)}
        </div>
      )}

      {timer.visibility.cost && (
        <div
          className="event-scene-cost"
          style={{ color: overtime ? alertColor : undefined }}
        >
          Итого: {formattedCost}₽
        </div>
      )}
    </div>
  )
}
