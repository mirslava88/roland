import { useState, useEffect, useRef } from 'react'

interface TimerData {
  remaining: number
  running: boolean
  duration: number
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

export function TimerOverlay(): JSX.Element {
  const [timer, setTimer] = useState<TimerData | null>(null)
  const [remaining, setRemaining] = useState(0)
  const [running, setRunning] = useState(false)
  const [position, setPosition] = useState({ x: 95, y: 92 })
  const [scale, setScale] = useState(1)
  const [dragging, setDragging] = useState(false)

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const dragStartRef = useRef({ x: 0, y: 0, posX: 0, posY: 0 })

  // Listen for timer updates from control window
  useEffect(() => {
    const unsub = window.api.on('timer-update', (...args: unknown[]) => {
      const data = args[0] as TimerData
      setTimer(data)
      setRemaining(data.remaining)
      setRunning(data.running)
    })
    return () => unsub()
  }, [])

  // Local countdown to keep display smooth between IPC updates
  useEffect(() => {
    if (running) {
      intervalRef.current = setInterval(() => {
        setRemaining((r) => r - 1)
      }, 1000)
    } else if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [running])

  // Drag handlers
  const handleMouseDown = (e: React.MouseEvent): void => {
    if (e.button === 2) return // right click for scale
    setDragging(true)
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      posX: position.x,
      posY: position.y
    }
  }

  useEffect(() => {
    if (!dragging) return

    const handleMouseMove = (e: MouseEvent): void => {
      const dx = ((e.clientX - dragStartRef.current.x) / window.innerWidth) * 100
      const dy = ((e.clientY - dragStartRef.current.y) / window.innerHeight) * 100
      setPosition({
        x: Math.max(5, Math.min(95, dragStartRef.current.posX + dx)),
        y: Math.max(5, Math.min(95, dragStartRef.current.posY + dy))
      })
    }

    const handleMouseUp = (): void => setDragging(false)

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [dragging])

  // Scroll to scale
  const handleWheel = (e: React.WheelEvent): void => {
    e.stopPropagation()
    setScale((s) => Math.max(0.3, Math.min(6, s + (e.deltaY > 0 ? -0.15 : 0.15))))
  }

  if (!timer || timer.duration === 0) return <></>

  const isOvertime = remaining < 0
  const isWarning = remaining <= 60 && remaining > 0 && running

  return (
    <div
      className="fixed z-50 select-none"
      style={{
        left: `${position.x}%`,
        top: `${position.y}%`,
        transform: `translate(-50%, -50%) scale(${scale})`,
        cursor: dragging ? 'grabbing' : 'grab'
      }}
      onMouseDown={handleMouseDown}
      onWheel={handleWheel}
    >
      <div
        className={`font-mono font-bold text-4xl px-4 py-2 rounded-lg backdrop-blur-md transition-colors ${
          isOvertime
            ? 'text-red-500 bg-red-950/70 border border-red-500/40'
            : isWarning
              ? 'text-yellow-400 bg-yellow-950/60 border border-yellow-500/30'
              : 'text-white bg-black/60 border border-white/10'
        }`}
        style={{ textShadow: '0 2px 8px rgba(0,0,0,0.8)' }}
      >
        {formatTime(remaining)}
      </div>
    </div>
  )
}
