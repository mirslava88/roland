import { useEffect, useMemo, useRef } from 'react'
import { mediaUrl } from '../../media'
import type { ProgramSceneMediaLayer } from '../../../../shared/program-scene'

type Placement = 'below' | 'above' | 'all'

interface SurfaceProps {
  layers: ProgramSceneMediaLayer[]
  placement: Placement
  interactive?: boolean
  selectedId?: string | null
  onSelect?: (id: string) => void
  onMove?: (id: string, xPercent: number, yPercent: number) => void
  onScale?: (id: string, widthPercent: number) => void
  onAspectRatio?: (id: string, aspectRatio: number) => void
  onPlaybackTime?: (id: string, currentTime: number, duration: number) => void
}

interface EditorProps {
  layers: ProgramSceneMediaLayer[]
  selectedId: string | null
  onSelect: (id: string) => void
  onChange: (layers: ProgramSceneMediaLayer[]) => void
  onReorder: (id: string, direction: 'up' | 'down') => void
  onAddLayer: () => void
}

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value))

interface VideoSessionState {
  currentTime: number
  capturedAt: number
  playing: boolean
  controlRevision: number
  restartRevision: number
}

const videoSessions = new Map<string, VideoSessionState>()

function expectedVideoTime(layer: ProgramSceneMediaLayer): number {
  const storedSession = videoSessions.get(layer.id)
  const session = storedSession?.restartRevision === layer.restartRevision &&
    storedSession.controlRevision === layer.controlRevision
    ? storedSession
    : undefined
  const base = session?.currentTime ?? layer.currentTime
  const startedAt = session?.playing
    ? session.capturedAt
    : layer.playing
      ? layer.playbackStartedAt
      : null
  return Math.max(0, base + (startedAt ? Math.max(0, Date.now() - startedAt) / 1000 : 0))
}

function ProgramSceneVideoLayer({
  layer,
  onAspectRatio,
  onPlaybackTime
}: {
  layer: ProgramSceneMediaLayer
  onAspectRatio?: SurfaceProps['onAspectRatio']
  onPlaybackTime?: SurfaceProps['onPlaybackTime']
}): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const lastReportRef = useRef(0)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const target = expectedVideoTime(layer)
    if (Number.isFinite(target) && Math.abs(video.currentTime - target) > 0.2) {
      try { video.currentTime = Math.min(target, video.duration || target) } catch { /* metadata can still be pending */ }
    }
    if (layer.playing) void video.play().catch(() => undefined)
    else video.pause()
  }, [layer.controlRevision, layer.currentTime, layer.playbackStartedAt, layer.playing, layer.restartRevision])

  useEffect(() => () => {
    const video = videoRef.current
    if (!video) return
    videoSessions.set(layer.id, {
      currentTime: video.currentTime,
      capturedAt: Date.now(),
      playing: !video.paused && !video.ended,
      controlRevision: layer.controlRevision,
      restartRevision: layer.restartRevision
    })
  }, [layer.controlRevision, layer.id, layer.restartRevision])

  return (
    <video
      ref={videoRef}
      src={mediaUrl(layer.path)}
      className="h-full w-full object-contain pointer-events-none"
      autoPlay={layer.playing}
      playsInline
      loop={layer.loop}
      muted={layer.muted}
      onLoadedMetadata={(event) => {
        const video = event.currentTarget
        const target = expectedVideoTime(layer)
        if (target > 0) video.currentTime = Math.min(target, video.duration || target)
        if (video.videoWidth > 0 && video.videoHeight > 0) {
          onAspectRatio?.(layer.id, video.videoWidth / video.videoHeight)
        }
        onPlaybackTime?.(layer.id, video.currentTime, video.duration || 0)
      }}
      onTimeUpdate={(event) => {
        const video = event.currentTarget
        videoSessions.set(layer.id, {
          currentTime: video.currentTime,
          capturedAt: Date.now(),
          playing: !video.paused && !video.ended,
          controlRevision: layer.controlRevision,
          restartRevision: layer.restartRevision
        })
        const now = Date.now()
        if (now - lastReportRef.current >= 500) {
          lastReportRef.current = now
          onPlaybackTime?.(layer.id, video.currentTime, video.duration || 0)
        }
      }}
    />
  )
}

export function moveProgramSceneMediaLayer(
  layers: ProgramSceneMediaLayer[],
  id: string,
  direction: 'up' | 'down'
): ProgramSceneMediaLayer[] {
  const content = { kind: 'content' as const }
  const stack: Array<ProgramSceneMediaLayer | typeof content> = [
    ...layers.filter((layer) => !layer.aboveContent),
    content,
    ...layers.filter((layer) => layer.aboveContent)
  ]
  const index = stack.findIndex((entry) => 'id' in entry && entry.id === id)
  const nextIndex = direction === 'up' ? index + 1 : index - 1
  if (index < 0 || nextIndex < 0 || nextIndex >= stack.length) return layers
  ;[stack[index], stack[nextIndex]] = [stack[nextIndex], stack[index]]
  const contentIndex = stack.indexOf(content)
  return stack.flatMap((entry, stackIndex) => (
    entry.kind === 'content' ? [] : [{ ...entry, aboveContent: stackIndex > contentIndex }]
  ))
}

export function ProgramSceneMediaLayerSurface({
  layers,
  placement,
  interactive = false,
  selectedId = null,
  onSelect,
  onMove,
  onScale,
  onAspectRatio,
  onPlaybackTime
}: SurfaceProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{
    id: string
    mode: 'move' | 'resize'
    offsetX: number
    offsetY: number
    startClientX: number
    startWidthPercent: number
  } | null>(null)
  const visibleLayers = useMemo(
    () => layers.filter((layer) => layer.visible && (placement === 'all' || layer.aboveContent === (placement === 'above'))),
    [layers, placement]
  )

  useEffect(() => {
    const root = rootRef.current
    if (!root || !interactive || !onScale) return
    const handleWheel = (event: WheelEvent): void => {
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-program-scene-media-id]')
      const id = target?.dataset.programSceneMediaId
      if (!id) return
      const layer = layers.find((entry) => entry.id === id)
      if (!layer) return
      event.preventDefault()
      event.stopPropagation()
      onSelect?.(id)
      onScale(id, clamp(layer.widthPercent + (event.deltaY < 0 ? 2 : -2), 5, 100))
    }
    root.addEventListener('wheel', handleWheel, { passive: false })
    return () => root.removeEventListener('wheel', handleWheel)
  }, [interactive, layers, onScale, onSelect])

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    const root = rootRef.current
    if (!drag || !root) return
    const layer = layers.find((entry) => entry.id === drag.id)
    if (!layer || layer.locked) return
    const bounds = root.getBoundingClientRect()
    if (bounds.width <= 0 || bounds.height <= 0) return
    if (drag.mode === 'resize') {
      onScale?.(
        drag.id,
        clamp(drag.startWidthPercent + (event.clientX - drag.startClientX) / bounds.width * 200, 5, 100)
      )
      return
    }
    if (!onMove) return
    const widthPx = bounds.width * layer.widthPercent / 100
    const heightPx = widthPx / Math.max(0.1, layer.aspectRatio)
    const halfX = widthPx / bounds.width * 50
    const halfY = heightPx / bounds.height * 50
    onMove(
      drag.id,
      clamp((event.clientX - bounds.left - drag.offsetX) / bounds.width * 100, halfX, 100 - halfX),
      halfY >= 50
        ? 50
        : clamp((event.clientY - bounds.top - drag.offsetY) / bounds.height * 100, halfY, 100 - halfY)
    )
  }

  return (
    <div
      ref={rootRef}
      data-program-scene-media-surface={placement}
      className="pointer-events-none absolute inset-0 overflow-hidden"
      // In the editor, one parent retains each keyed media element across the
      // presentation level. Its children stack directly with content/camera.
      style={placement === 'all' ? undefined : { zIndex: placement === 'below' ? 1 : 6, isolation: 'isolate' }}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => {
        dragRef.current = null
        event.currentTarget.releasePointerCapture?.(event.pointerId)
      }}
      onPointerCancel={() => { dragRef.current = null }}
    >
      {visibleLayers.map((layer, index) => (
        <div
          key={layer.id}
          data-program-scene-media-id={layer.id}
          className={`absolute overflow-hidden select-none ${interactive ? 'pointer-events-auto' : ''} ${interactive && !layer.locked ? 'cursor-move' : 'cursor-default'} ${interactive && selectedId === layer.id ? 'ring-2 ring-accent ring-offset-2 ring-offset-black/70' : ''}`}
          style={{
            left: `${layer.xPercent}%`,
            top: `${layer.yPercent}%`,
            width: `${layer.widthPercent}%`,
            aspectRatio: String(layer.aspectRatio),
            transform: 'translate(-50%, -50%)',
            zIndex: placement === 'all' ? (layer.aboveContent ? 6 : 1) : index + 1,
            opacity: layer.opacity,
            touchAction: 'none'
          }}
          onPointerDown={(event) => {
            if (!interactive || event.button !== 0) return
            onSelect?.(layer.id)
            if (layer.locked) return
            const bounds = event.currentTarget.getBoundingClientRect()
            dragRef.current = {
              id: layer.id,
              mode: 'move',
              offsetX: event.clientX - bounds.left - bounds.width / 2,
              offsetY: event.clientY - bounds.top - bounds.height / 2,
              startClientX: event.clientX,
              startWidthPercent: layer.widthPercent
            }
            event.currentTarget.parentElement?.setPointerCapture?.(event.pointerId)
            event.preventDefault()
          }}
        >
          <div className="h-full w-full" style={{
            clipPath: `inset(${layer.cropTop}% ${layer.cropRight}% ${layer.cropBottom}% ${layer.cropLeft}%)`
          }}>
          {layer.kind === 'video' ? (
            <ProgramSceneVideoLayer
              layer={layer}
              onAspectRatio={onAspectRatio}
              onPlaybackTime={onPlaybackTime}
            />
          ) : (
            <img
              src={mediaUrl(layer.path)}
              alt={layer.name}
              draggable={false}
              className="h-full w-full object-contain pointer-events-none"
              onLoad={(event) => {
                const image = event.currentTarget
                if (image.naturalWidth > 0 && image.naturalHeight > 0) {
                  onAspectRatio?.(layer.id, image.naturalWidth / image.naturalHeight)
                }
              }}
            />
          )}
          </div>
          {interactive && !layer.locked && selectedId === layer.id && (
            <button
              type="button"
              aria-label="Изменить размер слоя"
              data-program-scene-media-resize={layer.id}
              className="pointer-events-auto absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize rounded-tl border-l border-t border-white bg-accent shadow"
              onPointerDown={(event) => {
                if (event.button !== 0) return
                dragRef.current = {
                  id: layer.id,
                  mode: 'resize',
                  offsetX: 0,
                  offsetY: 0,
                  startClientX: event.clientX,
                  startWidthPercent: layer.widthPercent
                }
                onSelect?.(layer.id)
                event.currentTarget.closest('[data-program-scene-media-surface]')?.setPointerCapture?.(event.pointerId)
                event.stopPropagation()
                event.preventDefault()
              }}
            />
          )}
        </div>
      ))}
    </div>
  )
}

export function ProgramSceneMediaLayerEditor({
  layers,
  selectedId,
  onSelect,
  onChange,
  onReorder,
  onAddLayer
}: EditorProps): JSX.Element {
  const selected = layers.find((layer) => layer.id === selectedId) ?? layers.at(-1) ?? null
  const updateSelected = (update: Partial<ProgramSceneMediaLayer>): void => {
    if (!selected) return
    onChange(layers.map((layer) => layer.id === selected.id ? { ...layer, ...update } : layer))
  }
  const duplicateSelected = (): void => {
    if (!selected) return
    const duplicate: ProgramSceneMediaLayer = {
      ...selected,
      id: `media-${crypto.randomUUID()}`,
      name: `${selected.name} — копия`,
      xPercent: clamp(selected.xPercent + 3, 0, 100),
      yPercent: clamp(selected.yPercent + 3, 0, 100),
      currentTime: selected.kind === 'video' ? expectedVideoTime(selected) : 0,
      playbackStartedAt: null
    }
    onChange([...layers, duplicate])
    onSelect(duplicate.id)
  }
  const stack = [
    ...layers.filter((layer) => layer.aboveContent).reverse(),
    { id: '__content__', name: 'Презентация', visible: true },
    ...layers.filter((layer) => !layer.aboveContent).reverse()
  ]

  return (
    <div data-program-scene-media-editor className="flex min-h-0 flex-1 flex-col gap-3 rounded-xl border border-border bg-surface-100 p-3">
      <div>
        <button data-add-program-scene-layer type="button" className="w-full rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:bg-accent/90" onClick={onAddLayer}>Добавить слой</button>
      </div>

      {layers.length > 0 && (
        <select
          aria-label="Активный медиаслой"
          value={selected?.id ?? ''}
          onChange={(event) => onSelect(event.target.value)}
          className="w-full rounded-lg border border-border bg-surface-200 px-3 py-2 text-sm text-white"
        >
          {layers.map((layer) => <option key={layer.id} value={layer.id}>{layer.name}</option>)}
        </select>
      )}

      {selected ? (
        <>
          <div className="grid grid-cols-4 gap-2">
            <button type="button" className="rounded-lg bg-surface-300 px-2 py-2 text-xs font-semibold text-white hover:bg-surface-400" onClick={() => onReorder(selected.id, 'up')}>Выше</button>
            <button type="button" className="rounded-lg bg-surface-300 px-2 py-2 text-xs font-semibold text-white hover:bg-surface-400" onClick={() => onReorder(selected.id, 'down')}>Ниже</button>
            <button type="button" className="rounded-lg bg-surface-300 px-2 py-2 text-xs font-semibold text-white hover:bg-surface-400" onClick={duplicateSelected}>Копия</button>
            <button type="button" className="rounded-lg bg-red-950/70 px-2 py-2 text-xs font-semibold text-red-200 hover:bg-red-900" onClick={() => onChange(layers.filter((layer) => layer.id !== selected.id))}>Удалить</button>
          </div>

          <div className={`rounded-lg border px-3 py-2 text-center text-xs font-semibold ${selected.aboveContent ? 'border-accent/50 bg-accent/15 text-accent' : 'border-amber-500/40 bg-amber-500/10 text-amber-200'}`}>
            {selected.aboveContent ? 'Над презентацией' : 'Под презентацией'}
          </div>

          <label className="space-y-1 text-xs text-gray-300">
            <span className="flex justify-between"><span>Размер</span><span>{Math.round(selected.widthPercent)}%</span></span>
            <input type="range" min="5" max="100" step="1" value={selected.widthPercent} onChange={(event) => updateSelected({ widthPercent: Number(event.target.value) })} className="w-full accent-accent" />
          </label>

          <label className="space-y-1 text-xs text-gray-300">
            <span className="flex justify-between"><span>Прозрачность</span><span>{Math.round(selected.opacity * 100)}%</span></span>
            <input type="range" min="5" max="100" step="1" value={Math.round(selected.opacity * 100)} onChange={(event) => updateSelected({ opacity: Number(event.target.value) / 100 })} className="w-full accent-accent" />
          </label>

          <div className="grid grid-cols-3 gap-2">
            <button type="button" className={`rounded-lg px-2 py-2 text-xs font-semibold ${selected.visible ? 'bg-accent text-white' : 'bg-amber-500 text-gray-950 hover:bg-amber-400'}`} onClick={() => updateSelected({ visible: !selected.visible })}>{selected.visible ? 'Слой виден' : 'Слой скрыт'}</button>
            <button type="button" className="rounded-lg bg-surface-300 px-2 py-2 text-xs font-semibold text-white hover:bg-surface-400" onClick={() => updateSelected({ xPercent: 50, yPercent: 50 })}>По центру</button>
            <button type="button" className={`rounded-lg px-2 py-2 text-xs font-semibold ${selected.locked ? 'bg-amber-700 text-white' : 'bg-surface-300 text-gray-300'}`} onClick={() => updateSelected({ locked: !selected.locked })}>{selected.locked ? 'Закреплён' : 'Закрепить'}</button>
          </div>

          {selected.kind === 'video' && (
            <div className="space-y-2 rounded-lg border border-gray-700 bg-black/20 p-2">
              <div className="grid grid-cols-4 gap-1">
                <button type="button" className="rounded bg-surface-300 px-2 py-1.5 text-xs text-white" onClick={() => updateSelected({ playing: !selected.playing, currentTime: expectedVideoTime(selected), playbackStartedAt: null, controlRevision: selected.controlRevision + 1 })}>{selected.playing ? 'Пауза' : 'Старт'}</button>
                <button type="button" className="rounded bg-surface-300 px-2 py-1.5 text-xs text-white" onClick={() => updateSelected({ playing: true, currentTime: 0, playbackStartedAt: null, controlRevision: selected.controlRevision + 1, restartRevision: selected.restartRevision + 1 })}>Сначала</button>
                <button type="button" className={`rounded px-2 py-1.5 text-xs font-semibold ${selected.loop ? 'bg-accent text-white' : 'bg-surface-300 text-gray-300'}`} onClick={() => updateSelected({ loop: !selected.loop })}>Повтор</button>
                <button type="button" className={`rounded px-2 py-1.5 text-xs font-semibold ${selected.muted ? 'bg-surface-300 text-gray-300' : 'bg-accent text-white'}`} onClick={() => updateSelected({ muted: !selected.muted })}>{selected.muted ? 'Без звука' : 'Звук'}</button>
              </div>
              <input aria-label="Позиция видеослоя" type="range" min="0" max={Math.max(0.1, selected.duration)} step="0.1" value={Math.min(selected.currentTime, Math.max(0.1, selected.duration))} onChange={(event) => updateSelected({ currentTime: Number(event.target.value), playbackStartedAt: null, controlRevision: selected.controlRevision + 1 })} className="w-full accent-accent" />
            </div>
          )}

          <div className="grid grid-cols-4 gap-1 text-[10px] text-gray-400">
            {([['Сверху', 'cropTop'], ['Справа', 'cropRight'], ['Снизу', 'cropBottom'], ['Слева', 'cropLeft']] as const).map(([label, key]) => (
              <label key={key} className="space-y-1 text-center">
                <span>{label}</span>
                <input aria-label={`Обрезка ${label.toLowerCase()}`} type="number" min="0" max="45" step="1" value={Math.round(selected[key])} onChange={(event) => updateSelected({ [key]: Number(event.target.value) })} className="w-full rounded border border-gray-700 bg-surface-300 px-1 py-1 text-center text-xs text-white" />
              </label>
            ))}
          </div>

          <div className="min-h-0 overflow-hidden rounded-lg bg-black/25 p-2">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-500">Сверху вниз</div>
            <div className="space-y-1">
              {stack.slice(0, 4).map((entry) => (
                <div key={entry.id} className={`truncate rounded px-2 py-1 text-xs ${entry.id === '__content__' ? 'border border-dashed border-gray-600 text-gray-300' : entry.id === selected.id ? 'bg-accent/20 text-accent' : 'bg-surface-200 text-gray-400'}`}>
                  {entry.name}{entry.visible === false ? ' (скрыт)' : ''}
                </div>
              ))}
              {stack.length > 4 && <div className="px-2 text-[11px] text-gray-500">и ещё {stack.length - 4}</div>}
            </div>
          </div>
          {!selected.aboveContent && <div className="text-[11px] leading-snug text-amber-200/80">Слой под презентацией виден в свободных или прозрачных областях кадра.</div>}
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center rounded-lg border border-dashed border-border px-5 text-center text-sm text-gray-400">Добавьте картинку или видео. Затем двигайте слой мышкой, а колесом меняйте размер.</div>
      )}
    </div>
  )
}
