import { useEffect, useLayoutEffect, useRef } from 'react'
import {
  PROGRAM_SCENE_TEXT_FONT_FAMILIES,
  type ProgramSceneTextOverlay
} from '../../../../shared/program-scene'

interface LayerProps {
  overlays: ProgramSceneTextOverlay[]
  interactive?: boolean
  selectedId?: string | null
  onSelect?: (id: string) => void
  onMove?: (id: string, xPercent: number, yPercent: number) => void
  onScale?: (id: string, fontSizePercent: number) => void
  onWidthChange?: (id: string, widthPercent: number) => void
  onTextChange?: (id: string, text: string) => void
}

type DragState =
  | {
      kind: 'move'
      id: string
      offsetX: number
      offsetY: number
      startClientX: number
      startClientY: number
      active: boolean
    }
  | { kind: 'resize'; id: string; startX: number; startWidthPercent: number }

interface InlineTextEditorProps {
  id: string
  text: string
  interactive: boolean
  onFocus?: () => void
  onTextChange?: (text: string) => void
}

function InlineTextEditor({
  id,
  text,
  interactive,
  onFocus,
  onTextChange
}: InlineTextEditorProps): JSX.Element {
  const elementRef = useRef<HTMLDivElement>(null)
  const editingRef = useRef(false)

  useLayoutEffect(() => {
    const element = elementRef.current
    if (!element || editingRef.current || element.textContent === text) return
    element.textContent = text
  }, [text])

  return (
    <div
      ref={elementRef}
      data-program-scene-inline-text={id}
      contentEditable={interactive ? 'plaintext-only' : false}
      suppressContentEditableWarning
      spellCheck={false}
      dir="ltr"
      className={`min-h-[1.15em] whitespace-pre-wrap break-words text-left outline-none ${interactive ? 'cursor-text select-text' : ''}`}
      onFocus={() => {
        editingRef.current = true
        onFocus?.()
      }}
      onBlur={() => { editingRef.current = false }}
      onInput={(event) => {
        if (!interactive || !onTextChange) return
        onTextChange(event.currentTarget.innerText.replace(/\r\n?/g, '\n'))
      }}
    />
  )
}

export function ProgramSceneTextOverlayLayer({
  overlays,
  interactive = false,
  selectedId = null,
  onSelect,
  onMove,
  onScale,
  onWidthChange,
  onTextChange
}: LayerProps): JSX.Element {
  const layerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)

  useEffect(() => {
    const layer = layerRef.current
    if (!layer || !interactive || !onScale) return
    const handleWheel = (event: WheelEvent): void => {
      const target = event.target
      const block = target instanceof Element
        ? target.closest<HTMLElement>('[data-program-scene-text-id]')
        : null
      if (!block || !layer.contains(block)) return
      const id = block.dataset.programSceneTextId
      const overlay = overlays.find((entry) => entry.id === id)
      if (!overlay) return
      // Chromium may register framework wheel handlers as passive. A native
      // non-passive listener guarantees that scaling text never scrolls the
      // PiP settings window at the same time.
      event.preventDefault()
      event.stopPropagation()
      const direction = event.deltaY < 0 ? 0.5 : -0.5
      onScale(overlay.id, Math.max(1, Math.min(10, overlay.fontSizePercent + direction)))
      onSelect?.(overlay.id)
    }
    layer.addEventListener('wheel', handleWheel, { passive: false })
    return () => layer.removeEventListener('wheel', handleWheel)
  }, [interactive, onScale, onSelect, overlays])

  const startDrag = (event: React.PointerEvent<HTMLDivElement>, overlay: ProgramSceneTextOverlay): void => {
    if (!interactive || !layerRef.current || event.button !== 0) return
    event.stopPropagation()
    const layerRect = layerRef.current.getBoundingClientRect()
    dragRef.current = {
      kind: 'move',
      id: overlay.id,
      offsetX: event.clientX - layerRect.left - layerRect.width * overlay.xPercent / 100,
      offsetY: event.clientY - layerRect.top - layerRect.height * overlay.yPercent / 100,
      startClientX: event.clientX,
      startClientY: event.clientY,
      active: false
    }
    onSelect?.(overlay.id)
  }

  const moveDrag = (event: React.PointerEvent<HTMLDivElement>, overlay: ProgramSceneTextOverlay): void => {
    const drag = dragRef.current
    const layer = layerRef.current
    if (!interactive || !drag || drag.id !== overlay.id || !layer) return
    const layerRect = layer.getBoundingClientRect()
    if (drag.kind === 'resize') {
      const widthPercent = drag.startWidthPercent +
        (event.clientX - drag.startX) / Math.max(1, layerRect.width) * 100
      onWidthChange?.(
        overlay.id,
        Math.max(5, Math.min(100 - overlay.xPercent, widthPercent))
      )
      return
    }
    if (!drag.active) {
      const distance = Math.hypot(
        event.clientX - drag.startClientX,
        event.clientY - drag.startClientY
      )
      if (distance < 4) return
      drag.active = true
      const editor = event.currentTarget.querySelector<HTMLElement>('[data-program-scene-inline-text]')
      if (document.activeElement === editor) editor.blur()
      window.getSelection()?.removeAllRanges()
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // Synthetic UI tests do not create a native active pointer. Real mouse
        // and touch events do, so capture remains available during operation.
      }
    }
    event.preventDefault()
    event.stopPropagation()
    const blockRect = event.currentTarget.getBoundingClientRect()
    const maxX = Math.max(0, 100 - overlay.widthPercent)
    const maxY = Math.max(0, 100 - blockRect.height / Math.max(1, layerRect.height) * 100)
    const xPercent = (event.clientX - layerRect.left - drag.offsetX) / Math.max(1, layerRect.width) * 100
    const yPercent = (event.clientY - layerRect.top - drag.offsetY) / Math.max(1, layerRect.height) * 100
    onMove?.(
      overlay.id,
      Math.max(0, Math.min(maxX, xPercent)),
      Math.max(0, Math.min(maxY, yPercent))
    )
  }

  return (
    <div
      ref={layerRef}
      className="pointer-events-none absolute inset-0 z-[8] overflow-hidden"
      style={{ containerType: 'size' }}
      data-program-scene-text-layer
    >
      {overlays.filter((overlay) => overlay.visible !== false).map((overlay) => (
        <div
          key={overlay.id}
          data-program-scene-text-id={overlay.id}
          className={`absolute leading-[1.15] ${interactive
            ? `pointer-events-auto rounded-sm outline outline-1 ${selectedId === overlay.id ? 'outline-blue-300' : 'outline-white/35'}`
            : 'pointer-events-none select-none'}`}
          style={{
            left: `${overlay.xPercent}%`,
            top: `${overlay.yPercent}%`,
            width: `${overlay.widthPercent}%`,
            color: overlay.color,
            fontFamily: PROGRAM_SCENE_TEXT_FONT_FAMILIES[overlay.fontFamily],
            fontSize: `${overlay.fontSizePercent}cqh`,
            textShadow: '0 1px 3px rgba(0,0,0,.95), 0 0 8px rgba(0,0,0,.72)',
            overflowWrap: 'anywhere'
          }}
          onPointerDown={(event) => {
            if (!interactive) return
            if ((event.target as Element).closest('[data-program-scene-text-resize]')) return
            startDrag(event, overlay)
          }}
          onPointerMove={(event) => moveDrag(event, overlay)}
          onPointerUp={(event) => {
            const wasDragging = dragRef.current?.kind === 'move' &&
              dragRef.current.id === overlay.id && dragRef.current.active
            if (dragRef.current?.id === overlay.id) dragRef.current = null
            if (wasDragging) {
              event.preventDefault()
              event.stopPropagation()
            }
            try {
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId)
              }
            } catch { /* pointer already ended */ }
          }}
          onPointerCancel={() => { dragRef.current = null }}
          title={interactive ? 'Нажмите и печатайте; перетаскивайте сам текст; подведите курсор к правой границе для изменения ширины' : undefined}
        >
          <InlineTextEditor
            id={overlay.id}
            text={overlay.text}
            interactive={interactive}
            onFocus={() => onSelect?.(overlay.id)}
            onTextChange={(text) => onTextChange?.(overlay.id, text)}
          />
          {interactive && selectedId === overlay.id && (
            <button
              type="button"
              contentEditable={false}
              data-program-scene-text-resize={overlay.id}
              aria-label="Изменить ширину текстового поля"
              title="Потяните правую границу, чтобы изменить ширину"
              className="pointer-events-auto absolute -right-1 top-0 z-[2] h-full min-h-5 w-2 cursor-ew-resize touch-none bg-transparent p-0"
              onPointerDown={(event) => {
                if (!interactive || event.button !== 0) return
                event.preventDefault()
                event.stopPropagation()
                dragRef.current = {
                  kind: 'resize',
                  id: overlay.id,
                  startX: event.clientX,
                  startWidthPercent: overlay.widthPercent
                }
                try {
                  event.currentTarget.setPointerCapture(event.pointerId)
                } catch { /* synthetic pointer */ }
                onSelect?.(overlay.id)
              }}
              onPointerUp={(event) => {
                dragRef.current = null
                try {
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                    event.currentTarget.releasePointerCapture(event.pointerId)
                  }
                } catch { /* pointer already ended */ }
              }}
              onPointerCancel={() => { dragRef.current = null }}
            />
          )}
        </div>
      ))}
    </div>
  )
}

interface EditorProps {
  overlays: ProgramSceneTextOverlay[]
  selectedId: string | null
  onSelectedIdChange: (id: string | null) => void
  onChange: (overlays: ProgramSceneTextOverlay[]) => void
}

const FONT_OPTIONS: Array<{ value: ProgramSceneTextOverlay['fontFamily']; label: string }> = [
  { value: 'arial', label: 'Arial' },
  { value: 'verdana', label: 'Verdana' },
  { value: 'georgia', label: 'Georgia' },
  { value: 'times', label: 'Times New Roman' },
  { value: 'impact', label: 'Impact' },
  { value: 'courier', label: 'Courier New' }
]

export function ProgramSceneTextOverlayEditor({
  overlays,
  selectedId,
  onSelectedIdChange,
  onChange
}: EditorProps): JSX.Element {
  const selected = overlays.find((overlay) => overlay.id === selectedId) ?? overlays[0] ?? null

  const updateSelected = (patch: Partial<ProgramSceneTextOverlay>): void => {
    if (!selected) return
    onChange(overlays.map((overlay) => overlay.id === selected.id ? { ...overlay, ...patch } : overlay))
  }

  const addText = (): void => {
    const offset = overlays.length % 12
    const next: ProgramSceneTextOverlay = {
      id: `text-${crypto.randomUUID()}`,
      text: 'Новый текст',
      visible: true,
      xPercent: 8 + offset * 2,
      yPercent: 8 + offset * 3,
      widthPercent: 34,
      fontFamily: 'arial',
      fontSizePercent: 4,
      color: '#ffffff'
    }
    onChange([...overlays, next])
    onSelectedIdChange(next.id)
  }

  return (
    <div className="rounded-lg border border-gray-700 bg-surface-100/70 p-2">
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <div>
          <div className="text-xs font-medium text-white">Текст на сцене</div>
          <div className="text-[10px] text-gray-400">Перетаскивайте блоки; колесо мыши меняет масштаб 10–100%.</div>
        </div>
        <button type="button" data-add-program-scene-text onClick={addText} className="rounded-md bg-blue-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-blue-500">
          + Добавить текст
        </button>
      </div>
      {selected ? (
        <div className="space-y-1.5">
          <div className="flex gap-2">
            <select
              aria-label="Текстовый блок"
              value={selected.id}
              onChange={(event) => onSelectedIdChange(event.target.value)}
              className="min-w-0 flex-1 rounded border border-gray-600 bg-gray-900 px-2 py-1 text-[11px] text-white"
            >
              {overlays.map((overlay, index) => (
                <option key={overlay.id} value={overlay.id}>
                  {index + 1}. {overlay.text.split('\n')[0].trim() || 'Без текста'}
                </option>
              ))}
            </select>
            <button
              type="button"
              data-program-scene-text-visibility
              onClick={() => updateSelected({ visible: selected.visible === false })}
              className={`rounded border px-2 py-1 text-[11px] ${selected.visible === false
                ? 'border-gray-600 text-gray-300 hover:bg-gray-800'
                : 'border-amber-700 text-amber-200 hover:bg-amber-950/40'}`}
            >
              {selected.visible === false ? 'Показать' : 'Скрыть'}
            </button>
            <button
              type="button"
              onClick={() => {
                const next = overlays.filter((overlay) => overlay.id !== selected.id)
                onChange(next)
                onSelectedIdChange(next[0]?.id ?? null)
              }}
              className="rounded border border-red-800 px-2 py-1 text-[11px] text-red-300 hover:bg-red-950/50"
            >
              Удалить
            </button>
          </div>
          <textarea
            data-program-scene-text-input
            aria-label="Текст на сцене"
            value={selected.text}
            rows={2}
            onChange={(event) => updateSelected({ text: event.target.value })}
            placeholder="Введите текст. Enter — новая строка."
            className="w-full resize-none rounded border border-gray-600 bg-gray-950 px-2 py-1 text-xs text-white outline-none focus:border-blue-500"
          />
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
            <label className="text-[11px] text-gray-300">Шрифт
              <select
                data-program-scene-text-font
                value={selected.fontFamily}
                onChange={(event) => updateSelected({ fontFamily: event.target.value as ProgramSceneTextOverlay['fontFamily'] })}
                className="mt-1 block w-full rounded border border-gray-600 bg-gray-900 px-2 py-1 text-[11px] text-white"
              >
                {FONT_OPTIONS.map((font) => <option key={font.value} value={font.value}>{font.label}</option>)}
              </select>
            </label>
            <label className="text-[11px] text-gray-300">Цвет
              <div className="mt-1 flex gap-2">
                <input
                  data-program-scene-text-color
                  type="color"
                  value={selected.color}
                  onChange={(event) => updateSelected({ color: event.target.value })}
                  className="h-7 w-10 cursor-pointer rounded border border-gray-600 bg-gray-900"
                />
                <input
                  value={selected.color}
                  maxLength={7}
                  onChange={(event) => {
                    if (/^#[0-9a-f]{6}$/i.test(event.target.value)) updateSelected({ color: event.target.value })
                  }}
                  className="min-w-0 flex-1 rounded border border-gray-600 bg-gray-900 px-2 py-1 font-mono text-[11px] text-white"
                />
              </div>
            </label>
            <label className="text-[11px] text-gray-300">Масштаб текста: {Math.round(selected.fontSizePercent * 10)}%
              <input
                data-program-scene-text-size
                type="range"
                min="1"
                max="10"
                step="0.5"
                value={selected.fontSizePercent}
                onChange={(event) => updateSelected({ fontSizePercent: Number(event.target.value) })}
                className="block h-2 w-full accent-blue-500"
              />
            </label>
            <label className="text-[11px] text-gray-300">Ширина поля: {Math.round(selected.widthPercent)}%
              <input
                data-program-scene-text-width
                type="range"
                min="5"
                max="100"
                step="1"
                value={selected.widthPercent}
                onChange={(event) => updateSelected({ widthPercent: Number(event.target.value) })}
                className="block h-2 w-full accent-blue-500"
              />
            </label>
          </div>
        </div>
      ) : (
        <div className="rounded border border-dashed border-gray-700 px-3 py-2 text-center text-[11px] text-gray-500">
          Текстовых блоков пока нет.
        </div>
      )}
    </div>
  )
}
