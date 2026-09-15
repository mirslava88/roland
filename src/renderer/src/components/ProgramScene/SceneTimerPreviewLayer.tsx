import { useEffect, useMemo, useRef } from 'react'

interface Props {
  remaining: number
  running: boolean
  duration: number
  position: { x: number; y: number }
  scale: number
  textColor: string
  warningTextColor: string
  overtimeTextColor: string
  textOpacity: number
  outputWidth: number
  outputHeight: number
  interactive?: boolean
  selected?: boolean
  onSelect?: () => void
  onPositionChange?: (position: { x: number; y: number }) => void
  onScaleChange?: (scale: number) => void
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))

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

export function SceneTimerPreviewLayer({
  remaining,
  running,
  duration,
  position,
  scale,
  textColor,
  warningTextColor,
  overtimeTextColor,
  textOpacity,
  outputWidth,
  outputHeight,
  interactive = false,
  selected = false,
  onSelect,
  onPositionChange,
  onScaleChange
}: Props): JSX.Element | null {
  const layerRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null)
  const safeScale = clamp(scale, 0.5, 8)

  const geometry = useMemo(() => {
    // The native WPF timer is SizeToContent. These dimensions mirror its
    // normal 48 px Consolas text and 24/8 px padding closely enough that the
    // preview uses the same normalized travel coordinates as the output.
    const widthPercent = clamp(280 * safeScale / Math.max(1, outputWidth) * 100, 1, 100)
    const heightPercent = clamp(80 * safeScale / Math.max(1, outputHeight) * 100, 1, 100)
    return {
      widthPercent,
      heightPercent,
      leftPercent: clamp(position.x, 0, 100) / 100 * (100 - widthPercent),
      topPercent: clamp(position.y, 0, 100) / 100 * (100 - heightPercent)
    }
  }, [outputHeight, outputWidth, position.x, position.y, safeScale])

  useEffect(() => {
    const timer = timerRef.current
    if (!timer || !interactive || !onScaleChange) return
    const handleWheel = (event: WheelEvent): void => {
      if (event.deltaY === 0) return
      event.preventDefault()
      event.stopPropagation()
      onSelect?.()
      const next = Math.round(clamp(safeScale + (event.deltaY < 0 ? 0.1 : -0.1), 0.5, 8) * 10) / 10
      onScaleChange(next)
    }
    timer.addEventListener('wheel', handleWheel, { passive: false })
    return () => timer.removeEventListener('wheel', handleWheel)
  }, [interactive, onScaleChange, onSelect, safeScale])

  if (duration <= 0) return null

  const warning = remaining >= 0 && remaining <= 60 && running
  const overtime = remaining < 0
  const foreground = overtime ? overtimeTextColor : warning ? warningTextColor : textColor
  const background = overtime
    ? 'rgba(60, 0, 0, 0.71)'
    : warning
      ? 'rgba(60, 20, 0, 0.63)'
      : 'rgba(0, 0, 0, 0.5)'

  const move = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    const layer = layerRef.current
    if (!interactive || !drag || drag.pointerId !== event.pointerId || !layer || !onPositionChange) return
    const rect = layer.getBoundingClientRect()
    const timerWidth = rect.width * geometry.widthPercent / 100
    const timerHeight = rect.height * geometry.heightPercent / 100
    const travelX = Math.max(0, rect.width - timerWidth)
    const travelY = Math.max(0, rect.height - timerHeight)
    const left = clamp(event.clientX - rect.left - drag.offsetX, 0, travelX)
    const top = clamp(event.clientY - rect.top - drag.offsetY, 0, travelY)
    onPositionChange({
      x: travelX > 0 ? left / travelX * 100 : 0,
      y: travelY > 0 ? top / travelY * 100 : 0
    })
  }

  const finishDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    dragRef.current = null
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    } catch { /* pointer already ended */ }
  }

  return (
    <div
      ref={layerRef}
      className="pointer-events-none absolute inset-0 z-[12] overflow-hidden"
      data-program-scene-timer-layer
      onPointerMove={move}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
    >
      <div
        ref={timerRef}
        data-program-scene-timer-preview
        data-timer-scale={safeScale}
        className={`absolute flex items-center justify-center overflow-hidden rounded-[10px] font-mono font-bold tabular-nums shadow-lg ${interactive ? `pointer-events-auto cursor-move touch-none select-none ${selected ? 'ring-2 ring-blue-300' : 'ring-1 ring-blue-300/50 hover:ring-2'}` : ''}`}
        style={{
          left: `${geometry.leftPercent}%`,
          top: `${geometry.topPercent}%`,
          width: `${geometry.widthPercent}%`,
          height: `${geometry.heightPercent}%`,
          color: foreground,
          opacity: clamp(textOpacity, 0.1, 1),
          background,
          fontSize: `${48 * safeScale / Math.max(1, outputWidth) * 100}cqw`,
          lineHeight: 1
        }}
        onPointerDown={(event) => {
          const layer = layerRef.current
          if (!interactive || !layer || event.button !== 0) return
          onSelect?.()
          const rect = layer.getBoundingClientRect()
          dragRef.current = {
            pointerId: event.pointerId,
            offsetX: event.clientX - rect.left - rect.width * geometry.leftPercent / 100,
            offsetY: event.clientY - rect.top - rect.height * geometry.topPercent / 100
          }
          layer.setPointerCapture(event.pointerId)
          event.preventDefault()
          event.stopPropagation()
        }}
        title={interactive ? 'Перетащите таймер; колесо мыши меняет размер' : undefined}
      >
        {formatTime(remaining)}
      </div>
    </div>
  )
}
