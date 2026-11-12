import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import type { RecordingEditSource, RecordingEditStatus, RecordingSettings } from '../../../../shared/recording'
import { deleteClips, extractClips, insertClips, sourceAt, timelineDuration, type RecordingClip } from '../../../../shared/recording-timeline'
import { fallbackWaveformForTile, frameDisplayForTime, timelineEdgeScrollDelta, timelineScrollForAnchor, timelineTimeAtX, visibleFrameTiles, visibleRulerTicks, visibleWaveformTiles, type CachedWaveformWindow, type WaveformViewport } from '../../../../shared/recording-waveform'
import { recordingShortcut } from '../../../../shared/recording-shortcuts'
import { mediaUrl } from '../../media'
import trainingRecordingUrl from '../../assets/training-recording.mp4?inline'

const button = 'rounded border border-gray-600 px-3 py-1.5 text-sm hover:bg-gray-700 disabled:opacity-40'
const toolButton = 'rounded border border-gray-600 px-2 py-1 text-xs hover:bg-gray-700 disabled:opacity-40'
const input = 'w-[120px] rounded border border-gray-600 bg-gray-900 px-2 py-1.5 text-center text-sm text-white'
const errorText = (error: unknown): string => String(error instanceof Error ? error.message : error)
  .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
type EditSnapshot = { clips: RecordingClip[]; start: number; end: number; playhead: number }
type TimelineMenu = { x: number; y: number; time: number }
const MAX_ZOOM = 512
const waveKey = (start: number, end: number, width: number): string => `${start.toFixed(6)}:${end.toFixed(6)}:${width}`

function timeLabel(value: number): string {
  const centiseconds = Math.max(0, Math.round(value * 100))
  const hours = Math.floor(centiseconds / 360000)
  const minutes = Math.floor(centiseconds / 6000) % 60
  const seconds = Math.floor(centiseconds / 100) % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centiseconds % 100).padStart(2, '0')}`
}

function parseTime(value: string): number | null {
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,2}))?$/.exec(value.trim())
  if (!match || Number(match[3]) >= 60 || (match[1] && Number(match[2]) >= 60)) return null
  return Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number((match[4] || '').padEnd(2, '0')) / 100
}

export function RecordingEditor({ open, onClose, lastAvailable, autoOpenLastRequest }: {
  open: boolean; onClose(): void; lastAvailable: boolean; autoOpenLastRequest: number
}): JSX.Element | null {
  const [source, setSource] = useState<RecordingEditSource | null>(null)
  const [format, setFormat] = useState<RecordingSettings['format']>('quality-mp4')
  const [playhead, setPlayhead] = useState(0)
  const [clips, setClips] = useState<RecordingClip[]>([])
  const [clipboard, setClipboard] = useState<RecordingClip[]>([])
  const [undoStack, setUndoStack] = useState<EditSnapshot[]>([])
  const [redoStack, setRedoStack] = useState<EditSnapshot[]>([])
  const [zoom, setZoom] = useState(1)
  const [waveformView, setWaveformView] = useState<WaveformViewport>({ start: 0, end: 0, width: 0 })
  const [detailWaves, setDetailWaves] = useState<Record<string, string | null>>({})
  const [overviewWaves, setOverviewWaves] = useState<Record<string, string>>({})
  const [waveformFailures, setWaveformFailures] = useState<Record<string, number>>({})
  const [waveformError, setWaveformError] = useState('')
  const [menu, setMenu] = useState<TimelineMenu | null>(null)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  const [start, setStart] = useState(0)
  const [end, setEnd] = useState(0)
  const [startText, setStartText] = useState('00:00:00.00')
  const [endText, setEndText] = useState('00:00:00.00')
  const [frame, setFrame] = useState('')
  const [videoFailed, setVideoFailed] = useState(false)
  const [previewFullscreen, setPreviewFullscreen] = useState(false)
  const [previewFullscreenPending, setPreviewFullscreenPending] = useState(false)
  const [thumbnails, setThumbnails] = useState<string[]>([])
  const [detailedFrames, setDetailedFrames] = useState<Record<string, string>>({})
  const [thumbnailFailed, setThumbnailFailed] = useState(false)
  const [timelineError, setTimelineError] = useState('')
  const [status, setStatus] = useState<RecordingEditStatus>({ phase: 'idle', progress: 0, outputs: [] })
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const video = useRef<HTMLVideoElement>(null)
  const previewFullscreenOwned = useRef(false)
  const previewFullscreenRequest = useRef(0)
  const dialog = useRef<HTMLElement>(null)
  const timelineViewport = useRef<HTMLDivElement>(null)
  const pendingZoomAnchor = useRef<{ time: number; x: number; serial: number } | null>(null)
  const zoomGesture = useRef<{ time: number; x: number; lastAt: number } | null>(null)
  const zoomValue = useRef(zoom)
  const zoomAnchorSerial = useRef(0)
  const activeClip = useRef(0)
  const timelineDrag = useRef<{ kind: 'seek' | 'start' | 'end' | 'select'; anchor: number; x: number;
    clientX: number; element: HTMLDivElement; start: number; end: number } | null>(null)
  const dragScrollFrame = useRef<number | null>(null)
  const lastDragTick = useRef(0)
  const frameSession = useRef(0)
  const handledAutoOpenLastRequest = useRef(0)
  const fallback = videoFailed
  const duration = timelineDuration(clips)
  const editingDisabled = busy || status.phase === 'running'
  const frameTiles = useMemo(() => zoom > 1 ? visibleFrameTiles(clips, waveformView, source?.frameRate) : [],
    [clips, waveformView, zoom, source?.frameRate])
  const visibleTiles = useMemo(() => visibleWaveformTiles(clips, waveformView), [clips, waveformView])
  const rulerTicks = useMemo(() => visibleRulerTicks(waveformView), [waveformView])
  const cachedWaveWindows = useMemo(() => Object.entries({ ...overviewWaves, ...detailWaves }).flatMap(([key, image]): CachedWaveformWindow[] => {
    if (!image) return []
    const [start, end, width] = key.split(':').map(Number)
    return Number.isFinite(start) && Number.isFinite(end) && Number.isFinite(width) && end > start
      ? [{ start, end, width, image }] : []
  }), [overviewWaves, detailWaves])
  const fallbackWaves = useMemo(() => visibleTiles.map(tile => {
    const key = waveKey(tile.request.start, tile.request.end, tile.request.width)
    return detailWaves[key] || overviewWaves[key] ? null : fallbackWaveformForTile(tile, cachedWaveWindows)
  }), [visibleTiles, detailWaves, overviewWaves, cachedWaveWindows])

  const leavePreviewFullscreen = useCallback((): void => {
    const request = ++previewFullscreenRequest.current
    setPreviewFullscreen(false)
    if (!previewFullscreenOwned.current) return
    previewFullscreenOwned.current = false
    setPreviewFullscreenPending(true)
    void window.api.setControlPreviewFullscreen(false).then(ok => {
      if (request === previewFullscreenRequest.current && !ok) setMessage('Не удалось выйти из полноэкранного режима.')
    }).catch(error => {
      if (request === previewFullscreenRequest.current) setMessage(errorText(error))
    }).finally(() => {
      if (request === previewFullscreenRequest.current) setPreviewFullscreenPending(false)
    })
  }, [])

  const enterPreviewFullscreen = (): void => {
    if (!source || previewFullscreenPending || previewFullscreen) return
    const request = ++previewFullscreenRequest.current
    setPreviewFullscreenPending(true)
    setMessage('')
    void window.api.setControlPreviewFullscreen(true).then(ok => {
      if (request !== previewFullscreenRequest.current) {
        if (ok) void window.api.setControlPreviewFullscreen(false)
        return
      }
      if (!ok) { setMessage('Не удалось открыть предпросмотр на весь экран.'); return }
      previewFullscreenOwned.current = true
      setPreviewFullscreen(true)
    }).catch(error => {
      if (request === previewFullscreenRequest.current) setMessage(errorText(error))
    }).finally(() => {
      if (request === previewFullscreenRequest.current) setPreviewFullscreenPending(false)
    })
  }

  useEffect(() => {
    if (!open) leavePreviewFullscreen()
  }, [open, leavePreviewFullscreen])

  useEffect(() => () => {
    previewFullscreenRequest.current++
    if (previewFullscreenOwned.current) {
      previewFullscreenOwned.current = false
      void window.api.setControlPreviewFullscreen(false)
    }
  }, [])

  useEffect(() => {
    if (!previewFullscreen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      leavePreviewFullscreen()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [previewFullscreen, leavePreviewFullscreen])

  useEffect(() => {
    if (!open) return
    dialog.current?.focus()
    void window.api.recording.editStatus().then(setStatus).catch(() => {})
    const timer = setInterval(() => { void window.api.recording.editStatus().then(setStatus).catch(() => {}) }, 500)
    return () => { clearInterval(timer); void window.api.recording.editTimelineCancel().catch(() => {}) }
  }, [open])

  useEffect(() => {
    if (!open || !source || !fallback) return
    let cancelled = false
    const timer = setTimeout(() => {
      const position = sourceAt(clips, playhead)?.sourceTime ?? 0
      void window.api.recording.editFrame(position).then(image => { if (!cancelled) setFrame(image) })
        .catch(error => { if (!cancelled) setMessage(errorText(error)) })
    }, 180)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [open, source, fallback, playhead, clips])

  useEffect(() => {
    if (!open || !source || fallback) return
    let animation = 0
    const tick = (): void => {
      const player = video.current
      const clip = clips[activeClip.current]
      if (player && clip && !player.paused) {
        const offset = clips.slice(0, activeClip.current).reduce((total, item) => total + item.end - item.start, 0)
        if (player.currentTime >= clip.end - 0.012) {
          const next = clips[activeClip.current + 1]
          if (next) { activeClip.current++; player.currentTime = next.start; setPlayhead(offset + clip.end - clip.start) }
          else { player.pause(); setPlayhead(duration) }
        } else setPlayhead(offset + Math.max(0, player.currentTime - clip.start))
      }
      animation = requestAnimationFrame(tick)
    }
    animation = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(animation)
  }, [open, source, fallback, clips, duration])

  useEffect(() => {
    if (!open || !source) return
    let cancelled = false
    setThumbnails([]); setTimelineError('')
    setThumbnailFailed(false)
    void window.api.recording.editThumbnails().then(images => { if (!cancelled) setThumbnails(images) })
      .catch(error => { if (!cancelled) { setThumbnailFailed(true); setTimelineError(errorText(error)) } })
    return () => { cancelled = true }
  }, [open, source])

  useEffect(() => {
    if (!open || !source || !frameTiles.length) return
    const middle = (waveformView.start + waveformView.end) / 2
    const times = [...new Map(frameTiles.map(tile => [tile.sourceTime.toFixed(3),
      { time: tile.sourceTime, position: (tile.timelineStart + tile.timelineEnd) / 2 }])).entries()]
      .filter(([key]) => !(key in detailedFrames))
      .map(([, item]) => item)
      .sort((a, b) => Math.abs(a.position - middle) - Math.abs(b.position - middle))
      .slice(0, 4).map(item => item.time)
    if (!times.length) return
    const session = frameSession.current
    const timer = setTimeout(() => {
      void window.api.recording.editTimelineFrames(times).then(images => {
        if (session === frameSession.current) setDetailedFrames(previous => Object.fromEntries(Object.entries({ ...previous,
          ...Object.fromEntries(times.map((time, index) => [time.toFixed(3), images[index]])) }).slice(-256)))
      }).catch(error => { if (session === frameSession.current) setTimelineError(errorText(error)) })
    }, 100)
    return () => clearTimeout(timer)
  }, [open, source, frameTiles, detailedFrames, waveformView])

  useLayoutEffect(() => {
    const viewport = timelineViewport.current
    if (!open || !source || !viewport || !duration) return
    const anchor = pendingZoomAnchor.current
    const updateView = (): void => {
      const width = viewport.clientWidth
      const start = timelineTimeAtX(viewport.scrollLeft, viewport.scrollWidth, 0, duration)
      const end = timelineTimeAtX(viewport.scrollLeft, viewport.scrollWidth, width, duration)
      setWaveformView({ start, end, width })
    }
    if (!anchor) { updateView(); return }
    const align = (): void => {
      viewport.scrollLeft = timelineScrollForAnchor(anchor.time, duration, viewport.scrollWidth,
        viewport.clientWidth, anchor.x)
      updateView()
    }
    align()
    pendingZoomAnchor.current = null
    const frame = requestAnimationFrame(() => {
      if (zoomAnchorSerial.current === anchor.serial && timelineViewport.current === viewport) align()
    })
    return () => cancelAnimationFrame(frame)
  }, [open, source, clips, duration, zoom])

  useEffect(() => {
    const viewport = timelineViewport.current
    if (!open || !source || !viewport) return
    const wheel = (event: WheelEvent): void => {
      event.preventDefault()
      if (event.shiftKey || event.deltaY === 0 && event.deltaX !== 0) {
        zoomGesture.current = null
        zoomAnchorSerial.current++
        pendingZoomAnchor.current = null
        viewport.scrollLeft += event.deltaX || event.deltaY; return
      }
      const bounds = viewport.getBoundingClientRect()
      const x = Math.max(0, Math.min(bounds.width, event.clientX - bounds.left))
      const now = performance.now()
      const previous = zoomGesture.current
      const time = previous && now - previous.lastAt < 260 && Math.abs(previous.x - x) < 3
        ? previous.time : timelineTimeAtX(viewport.scrollLeft, viewport.scrollWidth, x, duration)
      zoomGesture.current = { time, x, lastAt: now }
      const next = Math.max(1, Math.min(MAX_ZOOM,
        Math.round(zoomValue.current * Math.exp(-event.deltaY * 0.003) * 1000) / 1000))
      if (next === zoomValue.current) return
      zoomValue.current = next
      pendingZoomAnchor.current = { time, x, serial: ++zoomAnchorSerial.current }
      setZoom(next)
    }
    viewport.addEventListener('wheel', wheel, { passive: false })
    return () => viewport.removeEventListener('wheel', wheel)
  }, [open, source, duration])

  useEffect(() => {
    if (!open || !source?.hasAudio || !visibleTiles.length) return
    const lastZoom = zoomGesture.current
    const focusTime = lastZoom && performance.now() - lastZoom.lastAt < 500 &&
      lastZoom.time >= waveformView.start && lastZoom.time <= waveformView.end
      ? lastZoom.time : (waveformView.start + waveformView.end) / 2
    const missing = visibleTiles.filter(tile => { const key = waveKey(tile.request.start, tile.request.end, tile.request.width)
      return !detailWaves[key] && !overviewWaves[key] && (waveformFailures[key] ?? 0) < 2 })
      .sort((a, b) => Math.abs((a.timelineStart + a.timelineEnd) / 2 - focusTime) -
        Math.abs((b.timelineStart + b.timelineEnd) / 2 - focusTime))
    if (!missing.length) {
      if (visibleTiles.every(tile => detailWaves[waveKey(tile.request.start, tile.request.end, tile.request.width)] ||
        overviewWaves[waveKey(tile.request.start, tile.request.end, tile.request.width)])) setWaveformError('')
      return
    }
    setWaveformError('')
    let cancelled = false
    const timer = setTimeout(() => {
      void window.api.recording.editWaveformWindows(missing.map(tile => tile.request)).then(images => {
        if (cancelled) return
        const successes = missing.flatMap((tile, index) => images[index]
          ? [[waveKey(tile.request.start, tile.request.end, tile.request.width), images[index]] as const] : [])
        if (successes.length) setDetailWaves(previous => Object.fromEntries(Object.entries({ ...previous,
          ...Object.fromEntries(successes) }).slice(-128)))
        if (zoom <= 1.05 && successes.length) setOverviewWaves(previous => ({ ...previous, ...Object.fromEntries(successes) }))
        const failures = missing.filter((_, index) => !images[index])
        if (failures.length) setWaveformFailures(previous => ({ ...previous,
          ...Object.fromEntries(failures.map(tile => { const key = waveKey(tile.request.start, tile.request.end, tile.request.width)
            return [key, (previous[key] ?? 0) + 1] })) }))
        setWaveformError(failures.length ? 'Не удалось построить часть звуковой волны.' : '')
      }).catch(error => { if (!cancelled) {
        setWaveformFailures(previous => ({ ...previous,
          ...Object.fromEntries(missing.map(tile => { const key = waveKey(tile.request.start, tile.request.end, tile.request.width)
            return [key, (previous[key] ?? 0) + 1] })) }))
        setWaveformError(errorText(error))
      } })
    }, 45)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [open, source, visibleTiles, detailWaves, overviewWaves, waveformFailures, zoom])

  const run = useCallback(async (action: () => Promise<void>): Promise<void> => {
    setBusy(true); setMessage('')
    try { await action() } catch (error) { setMessage(errorText(error)) } finally { setBusy(false) }
  }, [])

  const choose = useCallback((useLast: boolean): void => { void run(async () => {
    const chosen = await window.api.recording.editOpen(useLast)
    if (!chosen) return
    frameSession.current++
    setSource(chosen)
    setFormat(chosen.format === 'mkv' ? 'lossless-mkv' : 'quality-mp4')
    setClips([{ start: 0, end: chosen.duration }]); setClipboard([]); setUndoStack([]); setRedoStack([]); setZoom(1)
    zoomValue.current = 1; zoomGesture.current = null; pendingZoomAnchor.current = null; zoomAnchorSerial.current++
    setDetailedFrames({}); setDetailWaves({}); setOverviewWaves({}); setWaveformFailures({}); setWaveformError(''); setMenu(null)
    activeClip.current = 0; setPlaying(false)
    setPlayhead(0); setStart(0); setEnd(chosen.duration)
    setStartText(timeLabel(0)); setEndText(timeLabel(chosen.duration))
    setFrame(''); setVideoFailed(false)
    setStatus({ phase: 'idle', progress: 0, outputs: [] })
  }) }, [run])

  useEffect(() => {
    if (!open || !autoOpenLastRequest || handledAutoOpenLastRequest.current === autoOpenLastRequest) return
    handledAutoOpenLastRequest.current = autoOpenLastRequest
    choose(true)
  }, [open, autoOpenLastRequest, choose])

  const updateMark = (which: 'start' | 'end', value: number): void => {
    if (!source || editingDisabled || !Number.isFinite(value) || value < 0 || value > duration) return
    if (which === 'start') {
      if (value > end) { setEnd(duration); setEndText(timeLabel(duration)) }
      setStart(value); setStartText(timeLabel(value))
    } else {
      if (value < start) { setStart(0); setStartText(timeLabel(0)) }
      setEnd(value); setEndText(timeLabel(value))
    }
  }
  const commitText = (which: 'start' | 'end', text: string): void => {
    const parsed = parseTime(text)
    if (parsed === null || !source || parsed > duration) {
      setMessage('Время должно быть внутри записи, в формате часы:минуты:секунды.')
      which === 'start' ? setStartText(timeLabel(start)) : setEndText(timeLabel(end))
      return
    }
    updateMark(which, parsed)
  }
  const seekIn = (items: RecordingClip[], value: number): void => {
    const position = Math.max(0, Math.min(timelineDuration(items), value))
    setPlayhead(position)
    const located = sourceAt(items, position)
    if (located) {
      activeClip.current = located.clipIndex
      if (video.current && !fallback) video.current.currentTime = located.sourceTime
    }
  }
  const seek = (value: number): void => seekIn(clips, value)
  const setSelection = (from: number, to: number): void => {
    setStart(from); setEnd(to); setStartText(timeLabel(from)); setEndText(timeLabel(to))
  }
  const snapshot = (): EditSnapshot => ({ clips, start, end, playhead })
  const applySnapshot = (next: EditSnapshot): void => {
    setClips(next.clips); setSelection(next.start, next.end); seekIn(next.clips, next.playhead)
  }
  const commitEdit = (nextClips: RecordingClip[], nextStart: number, nextEnd: number, nextPlayhead: number): void => {
    if (editingDisabled) return
    if (nextClips.some(clip => clip.end - clip.start < 0.04)) {
      setMessage('Слишком короткий фрагмент. Передвиньте границу хотя бы на 0,04 секунды.'); return
    }
    video.current?.pause()
    setUndoStack(previous => [...previous.slice(-49), snapshot()]); setRedoStack([])
    applySnapshot({ clips: nextClips, start: nextStart, end: nextEnd, playhead: nextPlayhead })
    setMessage(''); setStatus({ phase: 'idle', progress: 0, outputs: [] })
  }
  const selectedClips = (): RecordingClip[] => extractClips(clips, start, end)
  const copySelection = (): void => {
    if (end - start < 0.04) { setMessage('Сначала выделите фрагмент на дорожке.'); return }
    setClipboard(selectedClips()); setMessage('Фрагмент скопирован.')
  }
  const removeSelection = (copy: boolean): void => {
    if (end - start < 0.04) { setMessage('Сначала выделите фрагмент на дорожке.'); return }
    if (copy) setClipboard(selectedClips())
    commitEdit(deleteClips(clips, start, end), start, start, start)
  }
  const pasteSelection = (at = playhead): void => {
    if (!clipboard.length) { setMessage('Сначала скопируйте или вырежьте фрагмент.'); return }
    const added = timelineDuration(clipboard)
    commitEdit(insertClips(clips, at, clipboard), at, at + added, at)
  }
  const splitAtPlayhead = (at = playhead): void => {
    const found = sourceAt(clips, at)
    if (!found || found.sourceTime - clips[found.clipIndex].start < 0.04 ||
      clips[found.clipIndex].end - found.sourceTime < 0.04) { setMessage('Поставьте курсор внутри фрагмента, не у его края.'); return }
    const clip = clips[found.clipIndex]
    const next = [...clips.slice(0, found.clipIndex), { start: clip.start, end: found.sourceTime },
      { start: found.sourceTime, end: clip.end }, ...clips.slice(found.clipIndex + 1)]
    commitEdit(next, at, at, at)
  }
  const undo = (): void => {
    if (editingDisabled) return
    const previous = undoStack[undoStack.length - 1]
    if (!previous) return
    video.current?.pause()
    setUndoStack(undoStack.slice(0, -1)); setRedoStack(items => [...items, snapshot()]); applySnapshot(previous); setMessage('')
  }
  const redo = (): void => {
    if (editingDisabled) return
    const next = redoStack[redoStack.length - 1]
    if (!next) return
    video.current?.pause()
    setRedoStack(redoStack.slice(0, -1)); setUndoStack(items => [...items, snapshot()]); applySnapshot(next); setMessage('')
  }
  const togglePlayback = (): void => {
    const player = video.current
    if (!player || fallback || !clips.length) return
    if (player.paused) {
      if (playhead >= duration - 0.04) seek(0)
      void player.play().catch(error => setMessage(errorText(error)))
    } else player.pause()
  }
  const stopPlayback = (): void => {
    video.current?.pause()
    seek(0)
  }
  const dragPosition = (drag: NonNullable<typeof timelineDrag.current>): { x: number; position: number } => {
    const viewportBounds = timelineViewport.current?.getBoundingClientRect()
    const clientX = viewportBounds ? Math.max(viewportBounds.left, Math.min(viewportBounds.right, drag.clientX)) : drag.clientX
    const bounds = drag.element.getBoundingClientRect()
    const x = Math.max(0, Math.min(bounds.width, clientX - bounds.left))
    return { x, position: x / bounds.width * duration }
  }
  const updateDragSelection = (drag: NonNullable<typeof timelineDrag.current>): void => {
    const { x, position } = dragPosition(drag)
    if (drag.kind === 'start') setSelection(Math.min(position, drag.end), drag.end)
    else if (drag.kind === 'end') setSelection(drag.start, Math.max(position, drag.start))
    else if (Math.abs(x - drag.x) > 4 || drag.kind === 'select') {
      drag.kind = 'select'
      setSelection(Math.min(drag.anchor, position), Math.max(drag.anchor, position))
      seek(position)
    }
  }
  const stopDragScroll = (): void => {
    timelineDrag.current = null
    if (dragScrollFrame.current !== null) cancelAnimationFrame(dragScrollFrame.current)
    dragScrollFrame.current = null
  }
  const autoScrollDrag = (now: number): void => {
    const drag = timelineDrag.current
    const viewport = timelineViewport.current
    if (!drag || !viewport) { dragScrollFrame.current = null; return }
    const bounds = viewport.getBoundingClientRect()
    const before = viewport.scrollLeft
    viewport.scrollLeft += timelineEdgeScrollDelta(drag.clientX, bounds.left, bounds.right, now - lastDragTick.current)
    lastDragTick.current = now
    if (viewport.scrollLeft !== before) updateDragSelection(drag)
    dragScrollFrame.current = requestAnimationFrame(autoScrollDrag)
  }
  const timelinePointer = (event: ReactPointerEvent<HTMLDivElement>, phase: 'down' | 'move' | 'up'): void => {
    if (phase === 'up') { stopDragScroll(); return }
    if (!source || !duration || editingDisabled) return
    if (phase === 'move' && !timelineDrag.current) return
    if (phase === 'down' && event.button !== 0) return
    if (phase === 'down') {
      const bounds = event.currentTarget.getBoundingClientRect()
      const x = Math.max(0, Math.min(bounds.width, event.clientX - bounds.left))
      const position = x / bounds.width * duration
      const startDistance = Math.abs(x - start / duration * bounds.width)
      const endDistance = Math.abs(x - end / duration * bounds.width)
      const kind = Math.min(startDistance, endDistance) <= 8 && end - start >= 0.04
        ? startDistance <= endDistance ? 'start' : 'end' : 'seek'
      timelineDrag.current = { kind, anchor: position, x, clientX: event.clientX,
        element: event.currentTarget, start, end }
      event.currentTarget.setPointerCapture(event.pointerId)
      if (kind === 'seek') seek(position)
      lastDragTick.current = performance.now()
      dragScrollFrame.current = requestAnimationFrame(autoScrollDrag)
      return
    }
    const drag = timelineDrag.current
    if (drag) { drag.clientX = event.clientX; updateDragSelection(drag) }
  }
  useEffect(() => {
    if (open && !editingDisabled) return
    stopDragScroll()
  }, [open, editingDisabled])
  useEffect(() => () => stopDragScroll(), [])
  const timelineOverlay = source && duration ? <>
    <div className="pointer-events-none absolute inset-y-0 border-x border-yellow-300 bg-blue-500/20"
      style={{ left: `${start / duration * 100}%`, width: `${Math.max(0, end - start) / duration * 100}%` }} />
    <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-white shadow-[0_0_6px_white]"
      style={{ left: `${playhead / duration * 100}%` }} />
  </> : null
  const exportEdit = (mode: 'fragment' | 'separate' | 'timeline'): void => { void run(async () => {
    const selected = mode === 'timeline' ? clips : selectedClips()
    if (!source || timelineDuration(selected) < 0.04) throw new Error('Выберите фрагмент для сохранения.')
    setStatus(await window.api.recording.editExport({ mode, start, end, format, clips: selected }))
  }) }
  const handleShortcut = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && menu) { event.preventDefault(); setMenu(null); return }
    const target = event.target as HTMLElement
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable) return
    if (editingDisabled) return
    const command = recordingShortcut(event)
    if (!command) return
    event.preventDefault()
    if (command === 'copy') copySelection()
    else if (command === 'cut') removeSelection(true)
    else if (command === 'paste') pasteSelection()
    else if (command === 'undo') undo()
    else if (command === 'redo') redo()
    else if (command === 'select-all') setSelection(0, duration)
    else if (command === 'save') exportEdit('timeline')
    else if (command === 'delete') removeSelection(false)
    else if (command === 'play-pause') togglePlayback()
  }
  useEffect(() => {
    if (!open) return
    window.addEventListener('keydown', handleShortcut, true)
    return () => window.removeEventListener('keydown', handleShortcut, true)
  })
  const changeZoom = (next: number, time = playhead, x?: number): void => {
    const viewport = timelineViewport.current
    zoomGesture.current = null
    const value = Math.max(1, Math.min(MAX_ZOOM, Math.round(next * 1000) / 1000))
    if (viewport && duration) pendingZoomAnchor.current = { time, x: x ?? viewport.clientWidth / 2,
      serial: ++zoomAnchorSerial.current }
    zoomValue.current = value
    setZoom(value)
  }
  const openTimelineMenu = (event: ReactMouseEvent<HTMLElement>, at?: number): void => {
    event.preventDefault()
    if (!source || !duration) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const position = at ?? Math.max(0, Math.min(duration, (event.clientX - bounds.left) / bounds.width * duration))
    seek(position)
    setMenu({ x: Math.max(8, Math.min(event.clientX, window.innerWidth - 460)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 360)), time: position })
  }
  const menuAction = (label: string, action: () => void, disabled = false): JSX.Element =>
    <button type="button" className="block w-full px-3 py-1.5 text-left text-sm hover:bg-blue-600 disabled:text-gray-500 disabled:hover:bg-transparent"
      disabled={disabled} onClick={() => { setMenu(null); action() }}>{label}</button>

  if (!open) return null
  return createPortal(<div className="fixed inset-0 z-[160] flex items-center justify-center bg-black/80 p-3" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
    <section data-pdm-training-panel="montage" ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Монтаж записи" className="flex h-[min(900px,98vh)] w-[1100px] max-w-[98vw] flex-col gap-2 overflow-y-auto rounded-xl border border-gray-700 bg-gray-800 p-4 text-white shadow-2xl max-[680px]:gap-1 max-[680px]:p-2">
      <div className="flex items-center justify-between gap-3"><h2 className="text-lg font-semibold">Монтаж записи</h2>
        <button data-pdm-training-close type="button" className={button} onClick={onClose} aria-label="Закрыть монтаж">✕</button></div>
      <div className="flex items-center gap-2">
        <button type="button" className={button} disabled={busy || status.phase === 'running'} onClick={() => choose(false)}>Выбрать запись…</button>
        {lastAvailable && <button data-pdm-training-edit-last type="button" className={button} disabled={busy || status.phase === 'running'} onClick={() => choose(true)}>Последняя запись</button>}
        {source && <span className="min-w-0 flex-1 truncate text-xs text-gray-300" title={source.path === 'training://recording.mp4' ? 'Учебная запись.mp4' : source.path}>{source.path === 'training://recording.mp4' ? 'Учебная запись.mp4' : source.path}</span>}
      </div>
      <div data-pdm-training-edit-preview={previewFullscreen ? 'fullscreen' : 'window'} className={previewFullscreen
        ? 'fixed inset-0 z-[180] overflow-hidden bg-black'
        : 'relative min-h-[96px] flex-1 overflow-hidden rounded-lg border border-gray-700 bg-black'}
        onContextMenu={event => openTimelineMenu(event, playhead)}>
        {!source ? <div className="flex h-full items-center justify-center text-sm text-gray-400">Выберите готовую запись MP4 или MKV.</div>
          : fallback ? frame ? <img src={frame} className="h-full w-full object-contain" alt="Кадр записи" />
            : <div className="flex h-full items-center justify-center text-sm text-gray-400">Загрузка кадра…</div>
          : <video key={source.path} ref={video} src={source.path === 'training://recording.mp4' ? trainingRecordingUrl : mediaUrl(source.path)} muted={muted} className="h-full w-full object-contain"
              onClick={togglePlayback} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
              onError={() => setVideoFailed(true)} />}
        {previewFullscreen && <div className="absolute right-4 top-4 z-10 flex items-center gap-3 rounded-lg bg-black/75 px-3 py-2 text-xs text-white">
          <span>Предпросмотр записи · Esc — выйти</span>
          <button data-pdm-training-edit-window type="button" className={toolButton} onClick={leavePreviewFullscreen}>В окно</button>
        </div>}
        {previewFullscreen && source && <div className="absolute inset-x-0 bottom-0 z-10 space-y-3 bg-gradient-to-t from-black via-black/90 to-transparent px-6 pb-5 pt-12 text-white"
          onClick={event => event.stopPropagation()} onContextMenu={event => event.stopPropagation()}>
          <div className="relative flex h-5 items-center">
            <div className="pointer-events-none absolute inset-x-0 h-1.5 rounded-full bg-white/35" />
            {duration > 0 && <div className="pointer-events-none absolute h-1.5 bg-blue-400/80"
              style={{ left: `${start / duration * 100}%`, width: `${Math.max(0, end - start) / duration * 100}%` }} />}
            <input data-pdm-training-edit-scrub type="range" min={0} max={duration || 0} step="0.01" value={Math.min(playhead, duration)}
              aria-label="Промотка записи" title={timeLabel(playhead)} disabled={!clips.length}
              className="relative w-full cursor-pointer accent-blue-400 disabled:cursor-default"
              onChange={event => seek(Number(event.currentTarget.value))} />
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <button type="button" className={button} onClick={togglePlayback} disabled={!clips.length || fallback}>{playing ? '⏸ Пауза' : '▶ Воспроизвести'}</button>
            <button data-pdm-training-edit-stop type="button" className={button} onClick={stopPlayback} disabled={!clips.length}>⏹ Стоп</button>
            <span className="min-w-[150px] tabular-nums">{timeLabel(playhead)} / {timeLabel(duration)}</span>
            <button type="button" className={button} onClick={() => updateMark('start', playhead)} disabled={editingDisabled || !clips.length}>Отметить начало</button>
            <button type="button" className={button} onClick={() => updateMark('end', playhead)} disabled={editingDisabled || !clips.length}>Отметить конец</button>
            <span className="ml-auto text-xs text-gray-300">Esc — выйти</span>
          </div>
        </div>}
      </div>
      {source && <>
        <div className="flex flex-wrap items-center gap-1 rounded-lg bg-gray-900 p-1.5">
          <button type="button" className={toolButton} onClick={togglePlayback} disabled={!clips.length || fallback}>{playing ? '⏸ Пауза' : '▶ Воспроизвести'}</button>
          <button type="button" className={toolButton} onClick={() => setMuted(!muted)} disabled={!source.hasAudio}>{muted ? 'Звук выкл.' : 'Звук вкл.'}</button>
          <button data-pdm-training-edit-fullscreen type="button" className={toolButton} onClick={enterPreviewFullscreen} disabled={previewFullscreenPending}>На весь экран</button>
          <span className="mx-1 h-5 border-l border-gray-600" />
          <button type="button" className={toolButton} onClick={undo} disabled={editingDisabled || !undoStack.length}>↶ Отменить</button>
          <button type="button" className={toolButton} onClick={redo} disabled={editingDisabled || !redoStack.length}>↷ Повторить</button>
          <button type="button" className={toolButton} onClick={copySelection} disabled={editingDisabled || end - start < 0.04}>Копировать</button>
          <button type="button" className={toolButton} onClick={() => removeSelection(true)} disabled={editingDisabled || end - start < 0.04}>Вырезать</button>
          <button type="button" className={toolButton} onClick={() => pasteSelection()} disabled={editingDisabled || !clipboard.length}>Вставить</button>
          <button type="button" className={toolButton} onClick={() => removeSelection(false)} disabled={editingDisabled || end - start < 0.04}>Удалить</button>
          <button type="button" className={toolButton} onClick={() => splitAtPlayhead()} disabled={editingDisabled || !clips.length}>Разделить</button>
          <button type="button" className={toolButton} onClick={() => commitEdit([{ start: 0, end: source.duration }], 0, source.duration, 0)} disabled={editingDisabled || !undoStack.length}>Вернуть исходник</button>
          <span className="ml-auto text-xs text-cyan-200" title="Колёсико над дорожками меняет масштаб">Колёсико: {zoom.toFixed(1)}×</span>
        </div>
        <div className="space-y-1 rounded-lg border border-gray-700 bg-gray-900 p-2 max-[680px]:p-1">
          <div className="flex justify-between text-xs text-gray-300"><span>Курсор: {timeLabel(playhead)} · {clips.length} фрагм.</span><span>Длительность монтажа: {timeLabel(duration)}</span></div>
          <div className="grid grid-cols-[62px_minmax(0,1fr)] gap-x-2">
            <div className="flex flex-col justify-between py-5 text-xs font-semibold text-gray-300"><span>Видео</span><span>Звук</span></div>
            <div data-pdm-training-edit-timeline ref={timelineViewport} className="min-w-0 overflow-x-auto overflow-y-hidden rounded border border-gray-700"
              style={{ overflowAnchor: 'none' }}
              onScroll={event => { const node = event.currentTarget; if (duration && node.scrollWidth) setWaveformView({
                start: node.scrollLeft / node.scrollWidth * duration,
                end: (node.scrollLeft + node.clientWidth) / node.scrollWidth * duration, width: node.clientWidth }) }}
              aria-label="Монтажная шкала">
              <div style={{ width: `${zoom * 100}%`, minWidth: '100%' }}>
                <div className="relative h-5 text-[10px] text-gray-300" onContextMenu={event => openTimelineMenu(event)}>
                  {rulerTicks.map(tick => <span key={tick.time.toFixed(6)} className="absolute top-0 border-l border-gray-600 pl-1 tabular-nums"
                    style={{ left: `${tick.time / duration * 100}%` }}>{tick.label}</span>)}
                </div>
                <div className="relative flex h-24 cursor-crosshair overflow-hidden border-t border-gray-600 bg-[#0c1726] touch-none max-[680px]:h-12"
                  onPointerDown={event => timelinePointer(event, 'down')} onPointerMove={event => timelinePointer(event, 'move')}
                  onPointerUp={event => timelinePointer(event, 'up')} onPointerCancel={event => timelinePointer(event, 'up')}
                  onLostPointerCapture={stopDragScroll}
                  onContextMenu={event => openTimelineMenu(event)}
                  aria-label="Видеодорожка с миниатюрами кадров">
                  {clips.map((clip, clipIndex) => { const previewCount = Math.max(1, Math.round((clip.end - clip.start) / duration * 6))
                    return <div key={clipIndex} className="relative flex h-full min-w-0 overflow-hidden border-r-2 border-blue-400/80"
                    style={{ flexGrow: clip.end - clip.start, flexBasis: 0 }}>
                    {zoom <= 1 && Array.from({ length: previewCount }, (_, index) => {
                      const time = clip.start + (index + 0.5) / previewCount * (clip.end - clip.start)
                      const image = thumbnails[Math.min(11, Math.floor(time / source.duration * 12))]
                      return image ? <img key={index} src={image} alt="" draggable={false} className="h-full min-w-0 flex-1 bg-black object-contain pointer-events-none" />
                        : <div key={index} className="h-full min-w-0 flex-1 bg-gray-800" />
                    })}
                  </div>})}
                  {frameTiles.map(tile => <div key={`cell:${tile.timelineStart.toFixed(6)}:${tile.sourceTime.toFixed(3)}`}
                    className={`pointer-events-none absolute inset-y-0 border-l border-cyan-400/60 ${tile.frameIndex === null ? 'bg-[#15283a]' : tile.frameIndex % 2 ? 'bg-[#102338]' : 'bg-[#162a40]'}`}
                    style={{ left: `${tile.timelineStart / duration * 100}%`, width: `${(tile.timelineEnd - tile.timelineStart) / duration * 100}%` }} />)}
                  {frameTiles.map(tile => {
                    const display = frameDisplayForTime(tile.sourceTime, source.frameRate, source.duration,
                      detailedFrames, thumbnails)
                    const visibleStart = Math.max(tile.timelineStart, waveformView.start)
                    const visibleEnd = Math.min(tile.timelineEnd, waveformView.end)
                    const width = Math.min(170, Math.max(0, (visibleEnd - visibleStart) / (waveformView.end - waveformView.start) * waveformView.width))
                    if (width < 2) return null
                    return <div key={`thumb:${tile.timelineStart.toFixed(6)}:${tile.sourceTime.toFixed(3)}`}
                      className="pointer-events-none absolute inset-y-0 overflow-hidden border-r border-white/15 bg-[#21364a]"
                      style={{ left: `${visibleStart / duration * 100}%`, width }}>
                      {display.image && <img src={display.image} alt="" draggable={false}
                        className={`h-full w-full bg-black object-contain ${display.exact ? '' : 'opacity-70'}`} />}
                      <span className="absolute bottom-0 left-0 max-w-full truncate bg-black/75 px-1 text-[10px] font-medium text-white">
                        {display.exact ? `Кадр · ${tile.sourceTime.toFixed(3)} с` : 'Обновляю кадр…'}</span>
                    </div>
                  })}
                  {timelineOverlay}
                  {!clips.length ? <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-gray-300">Все фрагменты удалены. Вставьте скопированное или отмените действие.</span>
                    : !thumbnails.length && !Object.keys(detailedFrames).length && <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-gray-300">{thumbnailFailed ? 'Лента кадров недоступна' : 'Строю ленту кадров…'}</span>}
                </div>
                <div className="relative flex h-24 cursor-crosshair overflow-hidden border-t border-gray-600 bg-[#091725] touch-none max-[680px]:h-12"
                  onPointerDown={event => timelinePointer(event, 'down')} onPointerMove={event => timelinePointer(event, 'move')}
                  onPointerUp={event => timelinePointer(event, 'up')} onPointerCancel={event => timelinePointer(event, 'up')}
                  onLostPointerCapture={stopDragScroll}
                  onContextMenu={event => openTimelineMenu(event)}
                  aria-label="Звуковая волна">
                  {clips.map((clip, index) => <div key={index} className="relative h-full min-w-0 overflow-hidden border-r-2 border-blue-400/80"
                    style={{ flexGrow: clip.end - clip.start, flexBasis: 0 }} />)}
                  {source.hasAudio && <div className="pointer-events-none absolute inset-0" style={{
                    background: 'linear-gradient(to bottom, transparent 24%, #4882aa55 25%, transparent 26%, transparent 74%, #8869b255 75%, transparent 76%)' }} />}
                  {visibleTiles.map((tile, index) => { const key = waveKey(tile.request.start, tile.request.end, tile.request.width)
                    const image = detailWaves[key] || overviewWaves[key]
                    const fallback = fallbackWaves[index]
                    return image ? <img key={`${tile.timelineStart.toFixed(6)}:${key}`} src={image} alt=""
                      draggable={false} className="pointer-events-none absolute top-0 h-full max-w-none"
                      style={{ left: `${tile.timelineStart / duration * 100}%`, width: `${(tile.timelineEnd - tile.timelineStart) / duration * 100}%` }} />
                      : fallback ? <svg key={`fallback:${tile.timelineStart.toFixed(6)}:${key}`} aria-hidden="true"
                        className="pointer-events-none absolute top-0 h-full opacity-70"
                        style={{ left: `${fallback.timelineStart / duration * 100}%`,
                          width: `${(fallback.timelineEnd - fallback.timelineStart) / duration * 100}%` }}
                        viewBox={`${fallback.imageX} 0 ${fallback.imageVisibleWidth} 96`} preserveAspectRatio="none">
                        <image href={fallback.image} width={fallback.imageWidth} height="96" preserveAspectRatio="none" />
                      </svg> : null })}
                  {(!source.hasAudio || !visibleTiles.some((tile, index) =>
                    detailWaves[waveKey(tile.request.start, tile.request.end, tile.request.width)] ||
                    overviewWaves[waveKey(tile.request.start, tile.request.end, tile.request.width)] || fallbackWaves[index])) &&
                    <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-gray-400">
                      {source.hasAudio ? visibleTiles.some(tile => (waveformFailures[waveKey(tile.request.start, tile.request.end, tile.request.width)] ?? 0) >= 2)
                        ? 'Не удалось построить звуковую волну.' : 'Строю подробную звуковую волну…' : 'В записи нет звука'}</span>}
                  {timelineOverlay}
                </div>
              </div>
            </div>
          </div>
          <p className="text-[11px] text-gray-400 max-[680px]:hidden">Потяните по дорожке для выделения. Правый клик открывает монтажные действия. Колёсико меняет масштаб; Shift + колёсико перемещает шкалу.</p>
          {timelineError && <p className="text-xs text-amber-200">{timelineError}</p>}
          {waveformError && <p className="text-xs text-amber-200">{waveformError}</p>}
          {fallback && <p className="text-xs text-gray-400">Показывается кадр выбранного момента.</p>}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-gray-900 p-2 text-sm max-[680px]:p-1">
          <div className="flex items-center gap-2"><span>Начало</span><input data-pdm-training-edit-start-time className={input} value={startText} disabled={editingDisabled} onChange={event => setStartText(event.target.value)}
            onBlur={() => commitText('start', startText)} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} aria-label="Начало фрагмента" />
            <button data-pdm-training-edit-start-mark type="button" className={button} disabled={editingDisabled} onClick={() => updateMark('start', playhead)}>Отметить здесь</button></div>
          <div className="flex items-center gap-2"><span>Конец</span><input data-pdm-training-edit-end-time className={input} value={endText} disabled={editingDisabled} onChange={event => setEndText(event.target.value)}
            onBlur={() => commitText('end', endText)} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} aria-label="Конец фрагмента" />
            <button data-pdm-training-edit-end-mark type="button" className={button} disabled={editingDisabled} onClick={() => updateMark('end', playhead)}>Отметить здесь</button></div>
        </div>
        <div className="flex items-center justify-between gap-3 text-sm">
          <label className="flex items-center gap-2">Качество результата
            <select className="rounded border border-gray-600 bg-gray-900 px-2 py-1.5" value={format} disabled={status.phase === 'running'}
              onChange={event => setFormat(event.target.value as RecordingSettings['format'])}>
              <option value="lossless-mkv">MKV — без потерь</option><option value="quality-mp4">MP4 — высокое качество</option>
            </select></label>
          <span className="text-xs text-gray-300">Выбрано: {timeLabel(Math.max(0, end - start))}</span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-gray-400">Исходный файл не изменяется. Звук отдельно сохраняется в WAV.</p>
          <div className="flex gap-2">
            {status.phase === 'running' ? <button type="button" className={button} onClick={() => void run(async () => { await window.api.recording.editCancel(); setStatus(await window.api.recording.editStatus()) })}>Отменить монтаж</button>
              : <><button type="button" className={button} disabled={busy || duration < 0.04} onClick={() => exportEdit('timeline')}>Сохранить монтаж</button>
                <button type="button" className={button} disabled={busy || end - start < 0.04} onClick={() => exportEdit('fragment')}>Сохранить выделенное</button>
                <button type="button" className="rounded bg-blue-600 px-3 py-1.5 text-sm hover:bg-blue-500 disabled:opacity-40" disabled={busy || !source.hasAudio || end - start < 0.04}
                  onClick={() => exportEdit('separate')}>Разделить видео и звук</button></>}
          </div>
        </div>
      </>}
      {status.phase === 'running' && <div className="text-xs text-blue-200" aria-live="polite">Монтаж: {Math.round(status.progress * 100)}%</div>}
      {status.phase === 'done' && <div className="text-xs text-green-300" aria-live="polite">Готово: {status.outputs.map(path => <div key={path} className="break-all">{path}</div>)}</div>}
      {(message || status.phase === 'error' && status.message) && <p role="status" className="text-xs text-amber-200">{message || status.message}</p>}
    </section>
    {menu && <div className="fixed inset-0 z-[170]" onMouseDown={() => setMenu(null)}
      onKeyDown={event => { if (event.key === 'Escape') setMenu(null) }}
      onContextMenu={event => { event.preventDefault(); setMenu(null) }}>
      <div data-pdm-training-edit-menu role="menu" aria-label="Монтаж записи" className="absolute w-[450px] max-w-[calc(100vw-16px)] max-h-[calc(100vh-16px)] overflow-y-auto rounded-lg border border-gray-500 bg-gray-900 py-1 text-white shadow-2xl"
        style={{ left: menu.x, top: menu.y }} onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
        <div className="border-b border-gray-700 px-3 py-1 text-xs text-cyan-200">Позиция: {timeLabel(menu.time)} · масштаб {zoom.toFixed(1)}×</div>
        <div className="grid grid-cols-2 divide-x divide-gray-700">
          <div>
            {menuAction(playing ? 'Пауза' : 'Воспроизвести', togglePlayback, !clips.length || fallback)}
            {menuAction(muted ? 'Включить звук' : 'Выключить звук', () => setMuted(!muted), !source?.hasAudio)}
            {menuAction('Предпросмотр на весь экран', enterPreviewFullscreen, previewFullscreenPending)}
            <div className="my-1 border-t border-gray-700" />
            {menuAction('Отметить начало здесь', () => updateMark('start', menu.time), editingDisabled)}
            {menuAction('Отметить конец здесь', () => updateMark('end', menu.time), editingDisabled)}
            {menuAction('Выделить всё', () => setSelection(0, duration), editingDisabled || !duration)}
            {menuAction('Снять выделение', () => setSelection(menu.time, menu.time), editingDisabled || end - start < 0.04)}
          </div>
          <div>
            {menuAction('Копировать', copySelection, editingDisabled || end - start < 0.04)}
            {menuAction('Вырезать', () => removeSelection(true), editingDisabled || end - start < 0.04)}
            {menuAction('Вставить сюда', () => pasteSelection(menu.time), editingDisabled || !clipboard.length)}
            {menuAction('Удалить', () => removeSelection(false), editingDisabled || end - start < 0.04)}
            {menuAction('Разделить здесь', () => splitAtPlayhead(menu.time), editingDisabled || !clips.length)}
            <div className="my-1 border-t border-gray-700" />
            {menuAction('Отменить действие', undo, editingDisabled || !undoStack.length)}
            {menuAction('Повторить действие', redo, editingDisabled || !redoStack.length)}
            {menuAction('Вернуть исходник', () => commitEdit([{ start: 0, end: source?.duration ?? 0 }], 0, source?.duration ?? 0, 0), editingDisabled || !undoStack.length)}
            <div className="my-1 border-t border-gray-700" />
            {menuAction('Качество: MP4', () => setFormat('quality-mp4'), editingDisabled || format === 'quality-mp4')}
          </div>
        </div>
      </div>
    </div>}
  </div>, document.body)
}
