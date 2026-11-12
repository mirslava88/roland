export type SpeakerCaption = 'current' | 'next' | 'title'

export interface SpeakerCaptionPlacement {
  x: number
  y: number
  scale: number
}

export interface SpeakerSlideLayout {
  currentWidth: number
  currentHeight: number
  nextWidth: number
  nextHeight: number
  showNotes: boolean
  showBackdrop: boolean
  showTitle: boolean
  captions: Record<SpeakerCaption, SpeakerCaptionPlacement | null>
}

export const DEFAULT_SPEAKER_SLIDE_LAYOUT: SpeakerSlideLayout = {
  currentWidth: 62,
  currentHeight: 100,
  nextWidth: 30,
  nextHeight: 76,
  showNotes: true,
  showBackdrop: true,
  showTitle: true,
  captions: { current: null, next: null, title: null }
}

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, value))

const finite = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

const normalizeCaption = (value: unknown): SpeakerCaptionPlacement | null => {
  if (!value || typeof value !== 'object') return null
  const input = value as Partial<SpeakerCaptionPlacement>
  return {
    x: clamp(finite(input.x, 0), 0, 98),
    y: clamp(finite(input.y, 0), 0, 98),
    scale: clamp(finite(input.scale, 1), 0.5, 2)
  }
}

export function normalizeSpeakerSlideLayout(value: unknown): SpeakerSlideLayout {
  const input = value && typeof value === 'object'
    ? value as Partial<SpeakerSlideLayout> & { previousWidth?: number; previousHeight?: number }
    : {}
  const currentWidth = clamp(finite(input.currentWidth, DEFAULT_SPEAKER_SLIDE_LAYOUT.currentWidth), 24, 72)
  const nextWidth = clamp(finite(input.nextWidth ?? input.previousWidth, DEFAULT_SPEAKER_SLIDE_LAYOUT.nextWidth), 16, 94 - currentWidth)
  return {
    currentWidth,
    currentHeight: clamp(finite(input.currentHeight, DEFAULT_SPEAKER_SLIDE_LAYOUT.currentHeight), 30, 100),
    nextWidth,
    nextHeight: clamp(finite(input.nextHeight ?? input.previousHeight, DEFAULT_SPEAKER_SLIDE_LAYOUT.nextHeight), 30, 100),
    showNotes: input.showNotes !== false,
    showBackdrop: input.showBackdrop !== false,
    showTitle: input.showTitle !== false,
    captions: {
      current: normalizeCaption(input.captions?.current),
      next: normalizeCaption(input.captions?.next),
      title: normalizeCaption(input.captions?.title)
    }
  }
}

export function speakerCaptionPlacement(
  layout: SpeakerSlideLayout,
  caption: SpeakerCaption,
  isPdf: boolean
): SpeakerCaptionPlacement {
  const saved = layout.captions[caption]
  if (saved) return saved
  const currentRect = speakerSlideRect(layout, 'current', isPdf)
  const nextRect = speakerSlideRect(layout, 'next', isPdf)
  if (caption === 'current') return { x: currentRect.left + 0.45, y: currentRect.top + 0.7, scale: 1 }
  if (caption === 'next') return { x: nextRect.left + 0.45, y: nextRect.top + 0.7, scale: 1 }
  const titleTop = nextRect.top + nextRect.height + 1 <= (isPdf || !layout.showNotes ? 89 : 72)
    ? nextRect.top + nextRect.height + 1
    : nextRect.top + 1
  return { x: nextRect.left, y: titleTop, scale: 1 }
}

export function selectSpeakerCaptions(
  selected: SpeakerCaption[],
  caption: SpeakerCaption,
  additive: boolean
): SpeakerCaption[] {
  if (!additive) return [caption]
  return selected.includes(caption)
    ? selected.filter((item) => item !== caption)
    : [...selected, caption]
}

export function scaleSpeakerCaptions(
  layout: SpeakerSlideLayout,
  targets: Array<{ caption: SpeakerCaption; widthAtScaleOne: number; heightAtScaleOne: number }>,
  percent: number,
  isPdf: boolean
): SpeakerSlideLayout {
  const scale = clamp(Math.round(percent), 50, 200) / 100
  const captions = { ...layout.captions }
  for (const { caption, widthAtScaleOne, heightAtScaleOne } of targets) {
    const placement = speakerCaptionPlacement(layout, caption, isPdf)
    captions[caption] = {
      x: clamp(placement.x, 0, Math.max(0, 100 - widthAtScaleOne * scale)),
      y: clamp(placement.y, 0, Math.max(0, 100 - heightAtScaleOne * scale)),
      scale
    }
  }
  return { ...layout, captions }
}

export function sameSpeakerSlideLayout(a: unknown, b: unknown): boolean {
  const first = normalizeSpeakerSlideLayout(a)
  const second = normalizeSpeakerSlideLayout(b)
  return first.currentWidth === second.currentWidth &&
    first.currentHeight === second.currentHeight &&
    first.nextWidth === second.nextWidth &&
    first.nextHeight === second.nextHeight &&
    first.showNotes === second.showNotes &&
    first.showBackdrop === second.showBackdrop &&
    first.showTitle === second.showTitle &&
    (['current', 'next', 'title'] as const).every((caption) => {
      const left = first.captions[caption]
      const right = second.captions[caption]
      return left === null ? right === null : right !== null &&
        left.x === right.x && left.y === right.y && left.scale === right.scale
    })
}

export function resizeSpeakerSlide(
  layout: SpeakerSlideLayout,
  slide: 'current' | 'next',
  dxPercent: number,
  dyPercent: number
): SpeakerSlideLayout {
  const next = { ...normalizeSpeakerSlideLayout(layout) }
  if (slide === 'current') {
    next.currentWidth = clamp(next.currentWidth + dxPercent, 24, 94 - next.nextWidth)
    next.currentHeight = clamp(next.currentHeight + dyPercent, 30, 100)
  } else {
    // The next slide is anchored at the right edge; its inner handle moves left.
    next.nextWidth = clamp(next.nextWidth - dxPercent, 16, 94 - next.currentWidth)
    next.nextHeight = clamp(next.nextHeight + dyPercent, 30, 100)
  }
  return next
}

export function speakerSlideRect(
  layout: SpeakerSlideLayout,
  slide: 'current' | 'next',
  isPdf: boolean
): { left: number; top: number; width: number; height: number } {
  const availableHeight = isPdf || !layout.showNotes ? 96 : 76
  return slide === 'current'
    ? { left: 2, top: 2, width: layout.currentWidth, height: availableHeight * layout.currentHeight / 100 }
    : { left: 98 - layout.nextWidth, top: 2, width: layout.nextWidth, height: availableHeight * layout.nextHeight / 100 }
}
