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
  dpiScale?: number
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
  dpiScale = 1,
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
  const safeDpiScale = clamp(dpiScale, 0.5, 4)
  const wideTime = duration >= 3600 || remaining >= 3600 || remaining <= -3600

  const geometry = useMemo(() => {
    // Exact SizeToContent footprint of timer-overlay.ps1: a 176/260 DIP text
    // reserve, 48 DIP one-line text and 4x2 DIP transparent padding. WPF uses
    // the operator display DPI, so preview and internal Program use the same
    // physical ratio instead of the former approximate 280x80 rectangle.
    const widthDip = (wideTime ? 260 : 176) + 8
    const heightDip = 48 + 4
    const widthPercent = clamp(
      widthDip * safeScale * safeDpiScale / Math.max(1, outputWidth) * 100,
      1,
      100
    )
    const heightPercent = clamp(
      heightDip * safeScale * safeDpiScale / Math.max(1, outputHeight) * 100,
      1,
      100
    )
    return {
      widthPercent,
      heightPercent,
      leftPercent: clamp(position.x, 0, 100) / 100 * (100 - widthPercent),
      topPercent: clamp(position.y, 0, 100) / 100 * (100 - heightPercent)
    }
  }, [outputHeight, outputWidth, position.x, position.y, safeDpiScale, safeScale, wideTime])

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
  const edgeAlignment = position.x <= 0.001
    ? 'flex-start'
    : position.x >= 99.999
      ? 'flex-end'
      : 'center'

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
      style={{ containerType: 'inline-size' }}
      onPointerMove={move}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
    >
      <div
        ref={timerRef}
        data-program-scene-timer-preview
        data-timer-scale={safeScale}
        className={`absolute flex items-center overflow-hidden font-mono font-black tabular-nums leading-none ${interactive ? `pointer-events-auto cursor-move touch-none select-none ${selected ? 'ring-2 ring-blue-300' : 'ring-1 ring-blue-300/50 hover:ring-2'}` : ''}`}
        style={{
          left: `${geometry.leftPercent}%`,
          top: `${geometry.topPercent}%`,
          width: `${geometry.widthPercent}%`,
          height: `${geometry.heightPercent}%`,
          color: foreground,
          opacity: clamp(textOpacity, 0.1, 1),
          justifyContent: edgeAlignment,
          boxSizing: 'border-box',
          padding: `${2 * safeScale * safeDpiScale / Math.max(1, outputWidth) * 100}cqw ${4 * safeScale * safeDpiScale / Math.max(1, outputWidth) * 100}cqw`,
          fontSize: `${48 * safeScale * safeDpiScale / Math.max(1, outputWidth) * 100}cqw`,
          lineHeight: 1,
          textShadow: '0 2px 8px rgba(0,0,0,0.8)'
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
        title={interactive ? 'Перетяните таймер; колесо мыши меняет размер' : undefined}
      >
        {formatTime(remaining)}
      </div>
    </div>
  )
}
