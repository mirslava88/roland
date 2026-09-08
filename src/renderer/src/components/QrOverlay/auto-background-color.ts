import * as pdfjsLib from 'pdfjs-dist'
import type { QrOverlayConfig } from '../../../../shared/qr-overlay'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url
).toString()

const OFFICE_DOCUMENT_EXTENSIONS = new Set(['.doc', '.docx', '.rtf', '.odt', '.xls', '.xlsx', '.ods'])

interface SampledFrame {
  width: number
  height: number
  pixels: Uint8ClampedArray
}

interface OutputRect {
  x: number
  y: number
  width: number
  height: number
}

export interface QrAutoColorLayout {
  outputWidth: number
  outputHeight: number
  contentRect?: OutputRect
  // PowerPoint can export a 4:3 preview bitmap for a 16:9 presentation. The
  // program output follows the real slide geometry, so sampling must map the
  // bitmap through that geometry instead of trusting the bitmap dimensions.
  contentAspectRatio?: number | null
  config: Pick<
    QrOverlayConfig,
    | 'description'
    | 'descriptionFontScale'
    | 'descriptionWidthPercent'
    | 'sizePercent'
    | 'xPercent'
    | 'yPercent'
  >
}

interface AutoBackgroundColorSource {
  file: FileEntry | null
  currentSlide: number
  pptxThumbnails: string[]
  docPreviewPath?: string | null
  layout: QrAutoColorLayout
}

const frameCache = new Map<string, Promise<SampledFrame | null>>()

function byteToHex(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')
}

function sampledFrame(canvas: HTMLCanvasElement): SampledFrame | null {
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context || canvas.width < 1 || canvas.height < 1) return null
  return {
    width: canvas.width,
    height: canvas.height,
    pixels: context.getImageData(0, 0, canvas.width, canvas.height).data
  }
}

function representativeColor(frame: SampledFrame, crop?: OutputRect): string | null {
  const startX = Math.max(0, Math.min(frame.width - 1, Math.floor(crop?.x ?? 0)))
  const startY = Math.max(0, Math.min(frame.height - 1, Math.floor(crop?.y ?? 0)))
  const endX = Math.max(startX + 1, Math.min(frame.width, Math.ceil(
    crop ? crop.x + crop.width : frame.width
  )))
  const endY = Math.max(startY + 1, Math.min(frame.height, Math.ceil(
    crop ? crop.y + crop.height : frame.height
  )))
  const buckets = new Map<string, { weight: number; red: number; green: number; blue: number }>()

  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      const offset = (y * frame.width + x) * 4
      const alpha = frame.pixels[offset + 3]
      if (alpha < 128) continue
      const red = frame.pixels[offset]
      const green = frame.pixels[offset + 1]
      const blue = frame.pixels[offset + 2]
      const key = `${red >> 4}:${green >> 4}:${blue >> 4}`
      const bucket = buckets.get(key) ?? { weight: 0, red: 0, green: 0, blue: 0 }
      bucket.weight += 1
      bucket.red += red
      bucket.green += green
      bucket.blue += blue
      buckets.set(key, bucket)
    }
  }

  let winner: { weight: number; red: number; green: number; blue: number } | null = null
  for (const bucket of buckets.values()) {
    if (!winner || bucket.weight > winner.weight) winner = bucket
  }
  if (!winner || winner.weight < 1) return null
  return `#${byteToHex(winner.red / winner.weight)}${byteToHex(winner.green / winner.weight)}${byteToHex(winner.blue / winner.weight)}`
}

function labelRect(layout: QrAutoColorLayout): OutputRect {
  const width = Math.max(1, layout.outputWidth)
  const height = Math.max(1, layout.outputHeight)
  const config = layout.config
  const size = height * config.sizePercent / 100
  const gap = config.description.trim() ? Math.max(8, size * 0.045) : 0
  const descriptionWidth = config.description.trim()
    ? Math.min(size * config.descriptionWidthPercent / 100, Math.max(0, width - size - gap - 16))
    : 0
  const blockWidth = size + gap + descriptionWidth
  const halfXPercent = blockWidth / width * 50
  const halfYPercent = size / height * 50
  const centerXPercent = Math.max(halfXPercent + 1, Math.min(100 - halfXPercent - 1, config.xPercent))
  const centerYPercent = halfYPercent >= 50
    ? 50
    : Math.max(halfYPercent + 1, Math.min(100 - halfYPercent - 1, config.yPercent))
  const fontSize = Math.max(10, size * 0.075 * config.descriptionFontScale)
  const padding = Math.max(6, size * 0.055)
  const charactersPerLine = Math.max(1, descriptionWidth / Math.max(1, fontSize * 0.58))
  const lines = Math.max(1, Math.ceil(config.description.trim().length / charactersPerLine))
  const descriptionHeight = Math.min(size, lines * fontSize * 1.15 + padding * 2)
  const blockLeft = centerXPercent / 100 * width - blockWidth / 2
  const centerY = centerYPercent / 100 * height
  return {
    x: blockLeft + size + gap,
    y: centerY - descriptionHeight / 2,
    width: descriptionWidth,
    height: descriptionHeight
  }
}

function colorUnderDescription(frame: SampledFrame, layout: QrAutoColorLayout): string | null {
  const contentRect = layout.contentRect ?? {
    x: 0,
    y: 0,
    width: layout.outputWidth,
    height: layout.outputHeight
  }
  const sourceAspectRatio = layout.contentAspectRatio &&
    Number.isFinite(layout.contentAspectRatio) && layout.contentAspectRatio > 0
    ? layout.contentAspectRatio
    : frame.width / frame.height
  const fittedWidth = Math.min(contentRect.width, contentRect.height * sourceAspectRatio)
  const fittedHeight = Math.min(contentRect.height, fittedWidth / sourceAspectRatio)
  const fittedRect: OutputRect = {
    x: contentRect.x + (contentRect.width - fittedWidth) / 2,
    y: contentRect.y + (contentRect.height - fittedHeight) / 2,
    width: fittedWidth,
    height: fittedHeight
  }
  const target = labelRect(layout)
  const left = Math.max(target.x, fittedRect.x)
  const top = Math.max(target.y, fittedRect.y)
  const right = Math.min(target.x + target.width, fittedRect.x + fittedRect.width)
  const bottom = Math.min(target.y + target.height, fittedRect.y + fittedRect.height)
  if (right <= left || bottom <= top) return representativeColor(frame)
  return representativeColor(frame, {
    x: (left - fittedRect.x) / fittedRect.width * frame.width,
    y: (top - fittedRect.y) / fittedRect.height * frame.height,
    width: (right - left) / fittedRect.width * frame.width,
    height: (bottom - top) / fittedRect.height * frame.height
  })
}

async function loadImageFrame(filePath: string): Promise<SampledFrame | null> {
  const bytes = await window.api.readFile(filePath)
  const bitmap = await createImageBitmap(new Blob([bytes]))
  try {
    const scale = Math.min(192 / bitmap.width, 108 / bitmap.height, 1)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext('2d')
    if (!context) return null
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    return sampledFrame(canvas)
  } finally {
    bitmap.close()
  }
}

async function loadPdfFrame(filePath: string, requestedPage: number): Promise<SampledFrame | null> {
  const bytes = await window.api.readFile(filePath)
  const loadingTask = pdfjsLib.getDocument({ data: bytes })
  let page: pdfjsLib.PDFPageProxy | null = null
  try {
    const pdfDocument = await loadingTask.promise
    const pageNumber = Math.max(1, Math.min(pdfDocument.numPages, requestedPage))
    page = await pdfDocument.getPage(pageNumber)
    const baseViewport = page.getViewport({ scale: 1 })
    const scale = Math.min(192 / baseViewport.width, 108 / baseViewport.height)
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(viewport.width))
    canvas.height = Math.max(1, Math.round(viewport.height))
    const context = canvas.getContext('2d')
    if (!context) return null
    await page.render({ canvas, canvasContext: context, viewport }).promise
    return sampledFrame(canvas)
  } finally {
    page?.cleanup()
    await loadingTask.destroy().catch(() => undefined)
  }
}

function cachedFrame(key: string, factory: () => Promise<SampledFrame | null>): Promise<SampledFrame | null> {
  const cached = frameCache.get(key)
  if (cached) return cached
  const value = factory().catch((error: unknown) => {
    window.api.dbgLog(`QR automatic background color failed: ${String(error)}`)
    return null
  })
  frameCache.set(key, value)
  if (frameCache.size > 80) frameCache.delete(frameCache.keys().next().value as string)
  return value
}

export async function detectQrDescriptionBackgroundColor({
  file,
  currentSlide,
  pptxThumbnails,
  docPreviewPath,
  layout
}: AutoBackgroundColorSource): Promise<string | null> {
  if (!file) return null
  let frame: SampledFrame | null = null
  if (file.type === 'presentation') {
    const thumbnailPath = pptxThumbnails[Math.max(0, currentSlide - 1)]
    frame = thumbnailPath
      ? await cachedFrame(`image:${thumbnailPath}`, () => loadImageFrame(thumbnailPath))
      : null
  } else if (file.type === 'pdf') {
    frame = await cachedFrame(`pdf:${file.path}:${currentSlide}`, () => loadPdfFrame(file.path, currentSlide))
  } else if (file.type === 'other' && file.isImage === true) {
    frame = await cachedFrame(`image:${file.path}`, () => loadImageFrame(file.path))
  } else if (
    file.type === 'other' &&
    OFFICE_DOCUMENT_EXTENSIONS.has(file.extension.toLowerCase()) &&
    docPreviewPath
  ) {
    frame = await cachedFrame(`pdf:${docPreviewPath}:${currentSlide}`, () => loadPdfFrame(docPreviewPath, currentSlide))
  }
  return frame ? colorUnderDescription(frame, layout) : null
}

export function contrastingQrDescriptionTextColor(backgroundColor: string): '#000000' | '#ffffff' {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(backgroundColor)
  if (!match) return '#ffffff'
  const linear = (hex: string): number => {
    const value = Number.parseInt(hex, 16) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  const luminance = 0.2126 * linear(match[1]) + 0.7152 * linear(match[2]) + 0.0722 * linear(match[3])
  return luminance > 0.179 ? '#000000' : '#ffffff'
}
