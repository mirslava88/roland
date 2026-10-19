export interface PixelSize { width: number; height: number }

export interface PresentationCaptureProfile extends PixelSize {
  displayId: number
  frameRate: number
}

export interface PresentationCaptureQuality {
  path: string
  sourceWidth: number
  sourceHeight: number
  requiredWidth: number
  requiredHeight: number
  native: boolean
  lost?: boolean
}

export interface CaptureDisplay {
  id: number
  bounds: { x: number; y: number; width: number; height: number }
  workArea: { x: number; y: number; width: number; height: number }
  scaleFactor: number
  displayFrequency?: number
}

/** Pixels occupied by the whole slide, preserving its proportions. */
export function fittedSlidePixels(output: PixelSize, aspect: number): PixelSize {
  if (![output.width, output.height, aspect].every((v) => Number.isFinite(v) && v > 0)) {
    throw new Error('Invalid presentation output size')
  }
  return output.width / output.height > aspect
    ? { width: Math.ceil(output.height * aspect), height: Math.ceil(output.height) }
    : { width: Math.ceil(output.width), height: Math.ceil(output.width / aspect) }
}

/** Choose an actual rendering screen, accounting for Retina and menu/Dock space. */
export function planPresentationCapture(target: CaptureDisplay, hosts: CaptureDisplay[], aspect: number) {
  const pixels = fittedSlidePixels({ width: target.bounds.width * target.scaleFactor,
    height: target.bounds.height * target.scaleFactor }, aspect)
  const leftEdge = Math.min(...hosts.map((d) => d.bounds.x))
  const rightEdge = Math.max(...hosts.map((d) => d.bounds.x + d.bounds.width))
  // A parked window must be outside the entire desktop. Parking just to the
  // right of a monitor located left of the laptop would expose it on the
  // operator's screen. Interior monitors cannot safely host this window.
  const ranked = hosts.map((host, index) => {
    // Keynote constrains its window to the host's available height, even when
    // parked outside the desktop. Width can extend beyond the screen.
    const availableHeight = Math.floor(host.workArea.height * host.scaleFactor)
    return { host, index, availableHeight }
  }).filter(({ host }) => host.bounds.x === leftEdge || host.bounds.x + host.bounds.width === rightEdge)
    .sort((a, b) => {
    const sufficientA = a.availableHeight >= pixels.height
    const sufficientB = b.availableHeight >= pixels.height
    if (sufficientA !== sufficientB) return sufficientA ? -1 : 1
    // Prefer the operator screen when it can deliver native output. It keeps
    // Keynote independent of a projection display positioned left/above it.
    return sufficientA ? a.index - b.index : b.availableHeight - a.availableHeight
  })
  const host = ranked[0]?.host
  if (!host) throw new Error('No display available for presentation rendering')
  const profile: PresentationCaptureProfile = { ...pixels, displayId: target.id,
    frameRate: Math.max(30, Math.min(60, Math.round(target.displayFrequency || 60))) }
  const windowWidth = Math.ceil(pixels.width / host.scaleFactor)
  return { profile, host, windowWidth,
    windowHeight: Math.ceil(pixels.height / host.scaleFactor),
    parkedX: host.bounds.x + host.bounds.width === rightEdge
      ? rightEdge - 1 : leftEdge + 1 - windowWidth,
    // Keep the full height aligned with the host. Parking a small player
    // below the desktop can make ScreenCaptureKit return only a 2x2 frame.
    parkedY: host.workArea.y }
}

/** Small rounding differences are harmless; a genuine upscale must be reported. */
export function hasNativeSlideResolution(source: PixelSize, required: PixelSize): boolean {
  return source.width + 2 >= required.width && source.height + 2 >= required.height
}
