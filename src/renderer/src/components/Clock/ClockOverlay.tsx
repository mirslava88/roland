import { useEffect, useState } from 'react'
import { formatWallClock, type ClockOverlayConfig } from '../../../../shared/clock-overlay'

export function useWallClock(): string {
  const [time, setTime] = useState(() => formatWallClock(new Date()))
  useEffect(() => {
    const update = (): void => setTime(formatWallClock(new Date()))
    const interval = window.setInterval(update, 250)
    return () => window.clearInterval(interval)
  }, [])
  return time
}

export function ClockOverlay({ config, target }: {
  config: ClockOverlayConfig
  target: 'program' | 'speaker'
}): JSX.Element | null {
  const time = useWallClock()
  if (!config.enabled) return null
  const speaker = target === 'speaker'
  return <div
    data-clock-overlay={target}
    className="pointer-events-none absolute z-[60] whitespace-nowrap px-2 py-1 text-center font-mono font-black leading-none tabular-nums tracking-tight"
    style={{
      left: `${config.position.x}%`,
      top: `${config.position.y}%`,
      transform: speaker
        ? `translate(-50%, -50%) scale(${config.scale})`
        : `translate(-${config.position.x}%, -${config.position.y}%)`,
      transformOrigin: 'center center',
      fontSize: speaker ? 'clamp(34px, 4.8vw, 82px)' : `${48 * config.scale}px`,
      color: config.color,
      opacity: config.opacity,
      textShadow: '0 2px 8px rgba(0,0,0,.95)'
    }}
  >{time}</div>
}
