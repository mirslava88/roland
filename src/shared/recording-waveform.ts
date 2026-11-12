import type { RecordingClip } from './recording-timeline'
import type { RecordingWaveformWindow } from './recording'

export interface WaveformViewport {
  start: number
  end: number
  width: number
}

export interface WaveformTile {
  timelineStart: number
  timelineEnd: number
  request: RecordingWaveformWindow
}

export interface CachedWaveformWindow extends RecordingWaveformWindow {
  image: string
}

export interface WaveformFallback {
  image: string
  imageWidth: number
  imageX: number
  imageVisibleWidth: number
  timelineStart: number
  timelineEnd: number
}

export interface FrameTile {
  timelineStart: number
  timelineEnd: number
  sourceTime: number
  frameIndex: number | null
}

export interface RulerTick {
  time: number
  label: string
}

export interface FrameDisplay {
  image: string | undefined
  exact: boolean
}

export function timelineTimeAtX(scrollLeft: number, scrollWidth: number, x: number, duration: number): number {
  if (scrollWidth <= 0 || duration <= 0) return 0
  return Math.max(0, Math.min(duration, (scrollLeft + x) / scrollWidth * duration))
}

export function timelineScrollForAnchor(time: number, duration: number, scrollWidth: number,
  clientWidth: number, x: number): number {
  if (duration <= 0 || scrollWidth <= 0) return 0
  return Math.max(0, Math.min(Math.max(0, scrollWidth - clientWidth),
    time / duration * scrollWidth - x))
}

interface SourceTile {
  timelineStart: number
  timelineEnd: number
  sourceStart: number
  sourceEnd: number
}

function visibleSourceTiles(clips: RecordingClip[], viewport: WaveformViewport,
  targetPixels: number, limit: number): SourceTile[] {
  const span = viewport.end - viewport.start
  if (!Number.isFinite(span) || span <= 0 || !Number.isFinite(viewport.width) || viewport.width <= 0) return []
  const pixelsPerSecond = viewport.width / span
  const tileDuration = Math.max(0.0005, targetPixels / pixelsPerSecond)
  const tiles: SourceTile[] = []
  let offset = 0
  for (const clip of clips) {
    const clipDuration = clip.end - clip.start
    const from = Math.max(0, Math.floor((viewport.start - offset) / tileDuration))
    const to = Math.min(Math.ceil(clipDuration / tileDuration) - 1,
      Math.floor((viewport.end - offset - 0.000001) / tileDuration))
    for (let index = from; index <= to && tiles.length < limit; index++) {
      const relativeStart = index * tileDuration
      const relativeEnd = Math.min(clipDuration, (index + 1) * tileDuration)
      if (relativeEnd - relativeStart < 0.0005) continue
      tiles.push({ timelineStart: offset + relativeStart, timelineEnd: offset + relativeEnd,
        sourceStart: clip.start + relativeStart, sourceEnd: clip.start + relativeEnd })
    }
    offset += clipDuration
  }
  return tiles
}

export function visibleWaveformTiles(clips: RecordingClip[], viewport: WaveformViewport): WaveformTile[] {
  const pixelsPerSecond = viewport.width / (viewport.end - viewport.start)
  return visibleSourceTiles(clips, viewport, 480, 24).map(tile => ({
    timelineStart: tile.timelineStart, timelineEnd: tile.timelineEnd,
    request: { start: tile.sourceStart, end: tile.sourceEnd,
      width: Math.max(16, Math.min(2048, Math.round((tile.sourceEnd - tile.sourceStart) * pixelsPerSecond))) }
  }))
}

export function fallbackWaveformForTile(tile: WaveformTile, cached: CachedWaveformWindow[]): WaveformFallback | null {
  const candidates = cached.map(window => ({ window,
    start: Math.max(tile.request.start, window.start), end: Math.min(tile.request.end, window.end) }))
    .filter(item => item.end - item.start > 0.000001)
  const covering = candidates.filter(item => item.start <= tile.request.start + 0.000001 &&
    item.end >= tile.request.end - 0.000001)
  const best = covering.length ? covering.reduce((best, item) =>
    item.window.end - item.window.start < best.window.end - best.window.start ? item : best)
    : candidates.reduce<typeof candidates[number] | null>((best, item) => !best || item.end - item.start > best.end - best.start ? item : best, null)
  if (!best) return null
  const imageSpan = best.window.end - best.window.start
  return { image: best.window.image, imageWidth: best.window.width,
    imageX: (best.start - best.window.start) / imageSpan * best.window.width,
    imageVisibleWidth: (best.end - best.start) / imageSpan * best.window.width,
    timelineStart: tile.timelineStart + best.start - tile.request.start,
    timelineEnd: tile.timelineStart + best.end - tile.request.start }
}

export function visibleFrameTiles(clips: RecordingClip[], viewport: WaveformViewport,
  frameRate = 30): FrameTile[] {
  const span = viewport.end - viewport.start
  if (!Number.isFinite(span) || span <= 0 || !Number.isFinite(frameRate) || frameRate <= 0) return []
  const pixelsPerFrame = viewport.width / span / frameRate
  if (pixelsPerFrame < 90) return visibleSourceTiles(clips, viewport, 112, 40).map(tile => ({
    timelineStart: tile.timelineStart, timelineEnd: tile.timelineEnd,
    sourceTime: (tile.sourceStart + tile.sourceEnd) / 2,
    frameIndex: null
  }))
  const tiles: FrameTile[] = []
  let offset = 0
  for (const clip of clips) {
    const first = Math.max(0, Math.floor(Math.max(clip.start, clip.start + viewport.start - offset) * frameRate))
    const last = Math.ceil(Math.min(clip.end, clip.start + viewport.end - offset) * frameRate) - 1
    for (let index = first; index <= last && tiles.length < 40; index++) {
      const sourceStart = Math.max(clip.start, index / frameRate)
      const sourceEnd = Math.min(clip.end, (index + 1) / frameRate)
      if (sourceEnd <= sourceStart) continue
      const timelineStart = offset + sourceStart - clip.start
      const timelineEnd = offset + sourceEnd - clip.start
      if (timelineEnd <= viewport.start + 1e-9 || timelineStart >= viewport.end - 1e-9) continue
      tiles.push({ timelineStart, timelineEnd,
        sourceTime: (sourceStart + sourceEnd) / 2, frameIndex: index })
    }
    offset += clip.end - clip.start
  }
  return tiles
}

export function frameDisplayForTime(time: number, frameRate: number, duration: number,
  detailedFrames: Record<string, string>, thumbnails: string[]): FrameDisplay {
  const exact = detailedFrames[time.toFixed(3)]
  if (exact) return { image: exact, exact: true }
  const tolerance = 1 / Math.max(1, frameRate) + 0.001
  let nearest: string | undefined
  let distance = tolerance
  for (const [key, image] of Object.entries(detailedFrames)) {
    const difference = Math.abs(Number(key) - time)
    if (image && difference < distance) { nearest = image; distance = difference }
  }
  if (nearest) return { image: nearest, exact: false }
  if (!thumbnails.length || !Number.isFinite(duration) || duration <= 0) return { image: undefined, exact: false }
  const index = Math.max(0, Math.min(thumbnails.length - 1, Math.floor(time / duration * thumbnails.length)))
  return { image: thumbnails[index], exact: false }
}

export function timelineEdgeScrollDelta(pointerX: number, left: number, right: number, elapsedMs: number): number {
  if (right <= left || elapsedMs <= 0) return 0
  const zone = Math.min(48, (right - left) / 4)
  const distance = pointerX < left + zone ? pointerX - (left + zone)
    : pointerX > right - zone ? pointerX - (right - zone) : 0
  if (!distance) return 0
  const speed = Math.min(2600, 160 + Math.abs(distance) / zone * 800)
  return Math.sign(distance) * speed * Math.min(elapsedMs, 50) / 1000
}

export function visibleRulerTicks(viewport: WaveformViewport): RulerTick[] {
  const span = viewport.end - viewport.start
  if (!Number.isFinite(span) || span <= 0 || !Number.isFinite(viewport.width) || viewport.width <= 0) return []
  const desired = span * 105 / viewport.width
  const magnitude = 10 ** Math.floor(Math.log10(desired))
  const step = ([1, 2, 5, 10].find(value => value * magnitude >= desired) || 10) * magnitude
  const precision = step < 0.01 ? 3 : step < 1 ? 2 : 0
  const first = Math.ceil((viewport.start - step * 0.00001) / step)
  const last = Math.floor((viewport.end + step * 0.00001) / step)
  const ticks: RulerTick[] = []
  for (let index = first; index <= last && ticks.length < 30; index++) {
    const time = index * step
    const unit = 10 ** precision
    const rounded = Math.round(time * unit)
    const hours = Math.floor(rounded / (3600 * unit))
    const minutes = Math.floor(rounded / (60 * unit)) % 60
    const seconds = Math.floor(rounded / unit) % 60
    const fraction = precision ? `.${String(rounded % unit).padStart(precision, '0')}` : ''
    ticks.push({ time, label: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}${fraction}` })
  }
  return ticks
}
