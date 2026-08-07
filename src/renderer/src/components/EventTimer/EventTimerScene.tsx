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

function secondsUntilEnd(now: Date, endTime: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(endTime)
  if (!match) return 0
  const end = new Date(now)
  end.setHours(Number(match[1]), Number(match[2]), 0, 0)
  return Math.round((end.getTime() - now.getTime()) / 1000)
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

  const overtime = timer.centralTimeMode !== 'current' && timer.remaining < 0
  const totalCost = calculateEventTimerCost(timer)
  const scheduledRemaining = secondsUntilEnd(now, timer.endTime)
  const formattedCost = totalCost.toLocaleString('ru-RU', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  })
  const centralText = timer.centralTimeMode === 'current'
    ? currentClockWithSeconds(now)
    : formatEventTimer(timer.remaining)
  const foreground = '#ffffff'
  const alertColor = '#ef1717'
  const background = timer.backgroundMode === 'gradient'
    ? `linear-gradient(${timer.backgroundGradientAngle}deg, ${timer.backgroundColor} 0%, ${timer.backgroundGradientColor} 100%)`
    : timer.backgroundColor

  return (
    <div
      className={`relative h-full w-full overflow-hidden bg-black font-sans select-none ${className}`}
      style={{ containerType: 'size', color: foreground, background }}
    >
      {timer.backgroundImage && (
        <img
          src={mediaUrl(timer.backgroundImage)}
          className="absolute inset-0 h-full w-full object-cover"
          draggable={false}
        />
      )}

      {timer.visibility.clock && (
        <div
          className="absolute left-[1.45cqw] top-[1.1cqh] font-light tabular-nums leading-none"
          style={{ fontSize: 'min(6.5cqw, 12cqh)' }}
        >
          {currentClock(now)}
        </div>
      )}

      {timer.visibility.schedule && (
        <div
          className="absolute right-[2.1cqw] top-[2.3cqh] text-right font-light leading-[1.18] tabular-nums"
          style={{ fontSize: 'min(2.65cqw, 5.2cqh)' }}
        >
          <div>Начало:&nbsp; {timer.startTime}</div>
          <div>Конец:&nbsp; {timer.endTime}</div>
        </div>
      )}

      <div className="absolute left-1/2 top-[50.5%] w-[58cqw] -translate-x-1/2 -translate-y-1/2 text-center">
        {timer.visibility.heading && (
          <div
            className="mb-[2.2cqh] font-light leading-none"
            style={{ fontSize: 'min(3.3cqw, 6.4cqh)' }}
          >
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
          className="font-extralight tabular-nums leading-[0.9] tracking-[-0.055em]"
          style={{
            color: overtime ? alertColor : foreground,
            fontSize: 'min(13.4cqw, 25cqh)'
          }}
        >
          {centralText}
        </div>
        {timer.visibility.eventName && (
          <div className="mx-auto mt-[4cqh] w-[76%] border-t border-white/35 pt-[3.1cqh]">
            <div
              className="truncate font-light uppercase leading-none"
              style={{ fontSize: 'min(3.05cqw, 5.9cqh)' }}
              title={timer.eventName}
            >
              {timer.eventName || 'МЕРОПРИЯТИЕ'}
            </div>
          </div>
        )}
      </div>

      {timer.visibility.remaining && (
        <div
          className="absolute bottom-[2.4cqh] left-[1.45cqw] font-light tabular-nums leading-none"
          style={{ fontSize: 'min(2.55cqw, 4.8cqh)' }}
        >
          Осталось времени: {formatEventTimer(scheduledRemaining)}
        </div>
      )}

      {timer.visibility.cost && (
        <div
          className="absolute bottom-[2.4cqh] right-[2.1cqw] font-light tabular-nums leading-none"
          style={{
            color: overtime ? alertColor : foreground,
            fontSize: 'min(2.55cqw, 4.8cqh)'
          }}
        >
          Итого: {formattedCost}₽
        </div>
      )}
    </div>
  )
}
