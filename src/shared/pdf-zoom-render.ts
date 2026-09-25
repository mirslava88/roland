// Render a magnified PDF from its vectors instead of enlarging the 100% bitmap.
// Bound the backing store so a large/high-DPI output cannot exhaust the GPU.
export function pdfZoomRenderSize(
  cssWidth: number,
  cssHeight: number,
  deviceScale: number,
  zoomScale: number,
  maxWidth = 8192,
  maxHeight = 8192,
  maxPixels = 16_000_000
): { width: number; height: number } {
  const baseWidth = Math.max(1, Math.round(cssWidth * Math.max(1, deviceScale)))
  const baseHeight = Math.max(1, Math.round(cssHeight * Math.max(1, deviceScale)))
  const requestedZoom = Number.isFinite(zoomScale) ? Math.max(1, zoomScale) : 1
  const extraScale = Math.max(1, Math.min(
    requestedZoom,
    maxWidth / baseWidth,
    maxHeight / baseHeight,
    Math.sqrt(maxPixels / (baseWidth * baseHeight))
  ))
  return {
    width: Math.max(1, Math.round(baseWidth * extraScale)),
    height: Math.max(1, Math.round(baseHeight * extraScale))
  }
}
