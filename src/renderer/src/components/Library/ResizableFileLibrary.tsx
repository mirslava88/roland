import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'

const STORAGE_KEY = 'pdm-library-width-v1'
const MIN_WIDTH = 200
const MAX_WIDTH = 560
// Includes workspace padding/gap, leaving roughly 520px for the stage.
const MIN_STAGE_WIDTH = 550

export function clampLibraryWidth(width: number, viewportWidth: number): number {
  const available = Math.max(MIN_WIDTH, viewportWidth - MIN_STAGE_WIDTH)
  const maximum = Math.min(MAX_WIDTH, available)
  return Math.round(Math.max(MIN_WIDTH, Math.min(maximum, width)))
}

function readSavedWidth(): number | null {
  try {
    const value = Number(window.localStorage.getItem(STORAGE_KEY))
    return Number.isFinite(value) && value >= MIN_WIDTH && value <= MAX_WIDTH ? value : null
  } catch {
    return null
  }
}

function saveWidth(width: number | null): void {
  try {
    if (width === null) window.localStorage.removeItem(STORAGE_KEY)
    else window.localStorage.setItem(STORAGE_KEY, String(width))
  } catch {
    // Storage can be unavailable in the isolated training window.
  }
}

export function ResizableFileLibrary({ children }: { children: ReactNode }): JSX.Element {
  const [width, setWidth] = useState<number | null>(readSavedWidth)
  const panelRef = useRef<HTMLDivElement>(null)
  const stopDragRef = useRef<(() => void) | null>(null)

  useEffect(() => () => stopDragRef.current?.(), [])

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    stopDragRef.current?.()

    const pointerId = event.pointerId
    const startX = event.clientX
    const startWidth = panelRef.current?.getBoundingClientRect().width ?? 288
    let nextWidth = startWidth
    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const stop = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      window.removeEventListener('blur', finishOnBlur)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      stopDragRef.current = null
    }
    const move = (pointerEvent: PointerEvent): void => {
      if (pointerEvent.pointerId !== pointerId) return
      nextWidth = clampLibraryWidth(startWidth + pointerEvent.clientX - startX, window.innerWidth)
      setWidth(nextWidth)
    }
    const finish = (pointerEvent: PointerEvent): void => {
      if (pointerEvent.pointerId !== pointerId) return
      stop()
      saveWidth(nextWidth)
    }
    const finishOnBlur = (): void => {
      stop()
      saveWidth(nextWidth)
    }
    stopDragRef.current = stop
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    window.addEventListener('blur', finishOnBlur)
  }

  const resizeWithKeyboard = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    let nextWidth: number
    const currentWidth = panelRef.current?.getBoundingClientRect().width ?? 288
    if (event.key === 'ArrowRight') nextWidth = currentWidth + (event.shiftKey ? 40 : 20)
    else if (event.key === 'ArrowLeft') nextWidth = currentWidth - (event.shiftKey ? 40 : 20)
    else if (event.key === 'Home') nextWidth = MIN_WIDTH
    else if (event.key === 'End') nextWidth = MAX_WIDTH
    else return
    event.preventDefault()
    const clampedWidth = clampLibraryWidth(nextWidth, window.innerWidth)
    setWidth(clampedWidth)
    saveWidth(clampedWidth)
  }

  return (
    <div ref={panelRef} className="pdm-library-resizable" style={width === null ? undefined : { width }}>
      {children}
      <div
        className="pdm-library-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Изменить ширину списка материалов"
        title="Потяните для изменения ширины. Двойной щелчок — сброс."
        tabIndex={0}
        onPointerDown={startDrag}
        onKeyDown={resizeWithKeyboard}
        onDoubleClick={() => { stopDragRef.current?.(); setWidth(null); saveWidth(null) }}
      />
    </div>
  )
}
