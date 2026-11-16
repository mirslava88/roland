// Electron display bounds are CSS pixels. WPF's 48 DIP timer and Electron's
// 48 CSS-pixel clock must be reduced by the same target-display width.
export function programOverlayPreviewMetrics(display?: {
  bounds: { width: number; height: number }
}): {
  aspect: number
  fontCqw: number
  timerPaddingXCqw: number
  timerPaddingYCqw: number
  clockPaddingXCqw: number
  clockPaddingYCqw: number
} {
  const width = Math.max(1, display?.bounds.width || 1920)
  const height = Math.max(1, display?.bounds.height || 1080)
  const toCqw = (pixels: number): number => pixels / width * 100
  return {
    aspect: width / height,
    fontCqw: toCqw(48),
    timerPaddingXCqw: toCqw(4),
    timerPaddingYCqw: toCqw(2),
    clockPaddingXCqw: toCqw(8),
    clockPaddingYCqw: toCqw(4)
  }
}

export function maxProgramTimerScale(display: {
  bounds: { width: number; height: number }
} | undefined, wideTime: boolean): number {
  const width = Math.max(1, display?.bounds.width || 1920)
  const height = Math.max(1, display?.bounds.height || 1080)
  // WPF measures 176/260 DIP of text plus 4 DIP on each side, and 48 DIP
  // of line height plus 2 DIP above and below. Leave 8 DIP for rounding.
  const baseWidth = wideTime ? 268 : 184
  return Math.max(0.5, Math.min(8, (width - 8) / baseWidth, (height - 8) / 52))
}
