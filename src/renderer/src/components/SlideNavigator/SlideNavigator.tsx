import { useEffect, useState, useRef, useCallback } from 'react'
import { useAppStore } from '../../stores/useAppStore'
import { queueAbsoluteNavigationDuringTransition } from '../../navigation-transition'
import { mediaUrl } from '../../media'
import * as pdfjsLib from 'pdfjs-dist'
import { renderPdfiumPageToCanvas, warmPdfiumDocument } from '../../pdfium-renderer'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url
).toString()

interface SlideThumb {
  index: number
  dataUrl: string
}

interface CachedPdfThumbnails {
  signature: string
  totalSlides: number
  thumbnails: SlideThumb[]
  complete: boolean
}

const MAX_PDF_THUMBNAIL_CACHE_FILES = 8
const pdfThumbnailCache = new Map<string, CachedPdfThumbnails>()

function getPdfSignature(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data)
  let hash = 2166136261
  const sampleCount = Math.min(256, bytes.length)
  for (let index = 0; index < sampleCount; index++) {
    const byteIndex = sampleCount <= 1
      ? 0
      : Math.floor(index * (bytes.length - 1) / (sampleCount - 1))
    hash ^= bytes[byteIndex]
    hash = Math.imul(hash, 16777619)
  }
  return `${bytes.length}:${hash >>> 0}`
}

function touchPdfThumbnailCache(filePath: string, entry: CachedPdfThumbnails): void {
  pdfThumbnailCache.delete(filePath)
  pdfThumbnailCache.set(filePath, entry)
  while (pdfThumbnailCache.size > MAX_PDF_THUMBNAIL_CACHE_FILES) {
    const oldestPath = pdfThumbnailCache.keys().next().value as string | undefined
    if (!oldestPath) break
    pdfThumbnailCache.delete(oldestPath)
  }
}

export function SlideNavigator(): JSX.Element {
  const { activeFile, currentSlide, setCurrentSlide, setTotalSlides, setPptxThumbnails } = useAppStore()
  const [thumbnails, setThumbnails] = useState<SlideThumb[]>([])
  const [loading, setLoading] = useState(false)
  const activeRef = useRef<HTMLDivElement>(null)
  const pdfThumbnailGenerationRef = useRef(0)
  const pdfThumbnailRenderTaskRef = useRef<pdfjsLib.PDFRenderTask | null>(null)
  const currentSlideRef = useRef(currentSlide)
  currentSlideRef.current = currentSlide

  // Scroll active thumbnail into view
  useEffect(() => {
    activeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [currentSlide])

  // Generate PDF thumbnails
  const loadPdfThumbnails = useCallback(async (filePath: string) => {
    pdfThumbnailRenderTaskRef.current?.cancel()
    pdfThumbnailRenderTaskRef.current = null
    const generation = ++pdfThumbnailGenerationRef.current
    const started = performance.now()
    const remembered = pdfThumbnailCache.get(filePath)
    if (remembered) {
      setThumbnails(remembered.thumbnails.map((thumb) => ({ ...thumb })))
      setTotalSlides(remembered.totalSlides)
      setLoading(false)
    } else {
      setLoading(true)
      setThumbnails([])
    }
    window.api.dbgLog(`SlideNavigator: PDF thumbnails BEGIN file=${filePath}`)

    let doc: pdfjsLib.PDFDocumentProxy | null = null
    try {
      const readStarted = performance.now()
      const data = await window.api.readFile(filePath)
      if (generation !== pdfThumbnailGenerationRef.current) return
      window.api.dbgLog(
        `SlideNavigator: PDF read READY bytes=${data.byteLength} dur=${Math.round(performance.now() - readStarted)}ms file=${filePath}`
      )

      const signature = getPdfSignature(data)
      void warmPdfiumDocument(filePath, 'background', data.slice(0)).catch((error) => {
        window.api.dbgLog(`SlideNavigator: PDFium warm ERROR file=${filePath} error=${String(error)}`)
      })
      const cached = pdfThumbnailCache.get(filePath)
      if (cached?.signature === signature && cached.complete) {
        touchPdfThumbnailCache(filePath, cached)
        setTotalSlides(cached.totalSlides)
        setThumbnails(cached.thumbnails.map((thumb) => ({ ...thumb })))
        setLoading(false)
        window.api.dbgLog(
          `SlideNavigator: PDF thumbnail cache HIT pages=${cached.totalSlides} dur=${Math.round(performance.now() - started)}ms file=${filePath}`
        )
        return
      }

      doc = await pdfjsLib.getDocument({ data }).promise
      if (generation !== pdfThumbnailGenerationRef.current) return
      setTotalSlides(doc.numPages)
      const cacheEntry: CachedPdfThumbnails = cached?.signature === signature && cached.totalSlides === doc.numPages
        ? cached
        : {
            signature,
            totalSlides: doc.numPages,
            thumbnails: Array.from({ length: doc.numPages }, (_, index) => ({
              index: index + 1,
              dataUrl: ''
            })),
            complete: false
          }
      touchPdfThumbnailCache(filePath, cacheEntry)
      setThumbnails(cacheEntry.thumbnails.map((thumb) => ({ ...thumb })))
      setLoading(false)

      window.api.dbgLog(
        `SlideNavigator: PDF document READY pages=${doc.numPages} dur=${Math.round(performance.now() - started)}ms file=${filePath}`
      )

      // Render the current slide first, then its neighbours. Remaining pages
      // are filled in one at a time so a complex PDF cannot freeze the UI.
      const firstPage = Math.max(1, Math.min(doc.numPages, currentSlideRef.current))
      const pageOrder: number[] = cacheEntry.thumbnails[firstPage - 1]?.dataUrl ? [] : [firstPage]
      for (let distance = 1; distance <= doc.numPages; distance++) {
        const after = firstPage + distance
        const before = firstPage - distance
        if (after <= doc.numPages && !cacheEntry.thumbnails[after - 1]?.dataUrl) pageOrder.push(after)
        if (before >= 1 && !cacheEntry.thumbnails[before - 1]?.dataUrl) pageOrder.push(before)
      }

      for (const pageNumber of pageOrder) {
        if (generation !== pdfThumbnailGenerationRef.current) return
        const pageStarted = performance.now()
        const page = await doc.getPage(pageNumber)
        const baseViewport = page.getViewport({ scale: 1 })
        // The panel is 176 CSS pixels wide. A 224-pixel bitmap stays sharp at
        // common Windows scaling factors without doing the old 576px render.
        const scale = Math.min(1, 224 / baseViewport.width)
        const viewport = page.getViewport({ scale })
        const targetWidth = Math.max(1, Math.ceil(viewport.width))
        const targetHeight = Math.max(1, Math.ceil(viewport.height))
        let canvas: HTMLCanvasElement
        let renderer = 'PDFium'
        try {
          const frame = await renderPdfiumPageToCanvas({
            filePath,
            pageNumber,
            targetWidth,
            targetHeight,
            lane: 'background'
          })
          canvas = frame.canvas
        } catch (error) {
          renderer = 'pdf.js'
          window.api.dbgLog(
            `SlideNavigator: PDFium ERROR page=${pageNumber} file=${filePath} error=${String(error)}; using pdf.js`
          )
          canvas = document.createElement('canvas')
          canvas.width = targetWidth
          canvas.height = targetHeight
          const ctx = canvas.getContext('2d')
          if (!ctx) throw new Error('Canvas 2D context is unavailable')
          const renderTask = page.render({ canvasContext: ctx, viewport })
          pdfThumbnailRenderTaskRef.current = renderTask
          try {
            await renderTask.promise
          } finally {
            if (pdfThumbnailRenderTaskRef.current === renderTask) {
              pdfThumbnailRenderTaskRef.current = null
            }
          }
        }
        if (generation !== pdfThumbnailGenerationRef.current) return

        const dataUrl = canvas.toDataURL('image/png')
        cacheEntry.thumbnails[pageNumber - 1] = { index: pageNumber, dataUrl }
        setThumbnails((previous) => {
          if (generation !== pdfThumbnailGenerationRef.current) return previous
          const next = [...previous]
          next[pageNumber - 1] = { index: pageNumber, dataUrl }
          return next
        })
        page.cleanup()
        window.api.dbgLog(
          `SlideNavigator: PDF thumbnail READY renderer=${renderer} page=${pageNumber} size=${canvas.width}x${canvas.height} dur=${Math.round(performance.now() - pageStarted)}ms file=${filePath}`
        )

        // Yield between pages: navigation and TAKE must always win over
        // background thumbnail generation on slower computers.
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
      }

      cacheEntry.complete = cacheEntry.thumbnails.every((thumb) => Boolean(thumb.dataUrl))
      touchPdfThumbnailCache(filePath, cacheEntry)

      window.api.dbgLog(
        `SlideNavigator: PDF thumbnails END pages=${doc.numPages} complete=${cacheEntry.complete} dur=${Math.round(performance.now() - started)}ms file=${filePath}`
      )
    } catch (err) {
      if (generation === pdfThumbnailGenerationRef.current) {
        console.error('Failed to generate PDF thumbnails:', err)
        window.api.dbgLog(`SlideNavigator: PDF thumbnails ERROR file=${filePath} error=${String(err)}`)
      }
    } finally {
      if (doc) await doc.destroy()
      if (generation === pdfThumbnailGenerationRef.current) setLoading(false)
    }
  }, [setTotalSlides])

  // pdf.js fallback tasks can be cancelled. PDFium runs in its own background
  // worker, so live output no longer stops the whole thumbnail queue.
  useEffect(() => {
    return () => {
      pdfThumbnailGenerationRef.current += 1
      pdfThumbnailRenderTaskRef.current?.cancel()
      pdfThumbnailRenderTaskRef.current = null
    }
  }, [])

  // Generate PPTX thumbnails
  const loadPptxThumbnails = useCallback(async (filePath: string) => {
    setLoading(true)
    setThumbnails([])
    // Wait for PowerPoint slideshow to finish launching before generating thumbnails
    await new Promise((r) => setTimeout(r, 2500))
    try {
      const result = await window.api.generatePptxThumbnails(filePath)
      if (result.success && result.thumbnails) {
        const thumbs: SlideThumb[] = result.thumbnails.map((path, i) => ({
          index: i + 1,
          dataUrl: mediaUrl(path)
        }))
        setThumbnails(thumbs)
        setPptxThumbnails(result.thumbnails)
        // Also update per-file map so channel previews stay in sync
        const { pptxThumbnailsMap } = useAppStore.getState()
        useAppStore.setState({ pptxThumbnailsMap: { ...pptxThumbnailsMap, [filePath]: result.thumbnails } })
        if (result.slideCount) setTotalSlides(result.slideCount)
      }
    } catch (err) {
      console.error('Failed to generate PPTX thumbnails:', err)
    }
    setLoading(false)
  }, [setTotalSlides])

  useEffect(() => {
    if (!activeFile) {
      pdfThumbnailGenerationRef.current += 1
      setThumbnails([])
      return
    }
    if (activeFile.type === 'pdf') {
      loadPdfThumbnails(activeFile.path)
    } else if (activeFile.type === 'presentation') {
      pdfThumbnailGenerationRef.current += 1
      // Check if thumbnails already exist in the map (generated by handleTake)
      const { pptxThumbnailsMap } = useAppStore.getState()
      const existing = pptxThumbnailsMap[activeFile.path]
      if (existing && existing.length > 0) {
        const thumbs: SlideThumb[] = existing.map((path, i) => ({
          index: i + 1,
          dataUrl: mediaUrl(path)
        }))
        setThumbnails(thumbs)
        setPptxThumbnails(existing)
        if (existing.length > 0) setTotalSlides(existing.length)
      } else {
        loadPptxThumbnails(activeFile.path)
      }
    } else {
      pdfThumbnailGenerationRef.current += 1
      setThumbnails([])
    }
  }, [activeFile?.path, activeFile?.type, loadPdfThumbnails, loadPptxThumbnails])

  const handleClick = (index: number): void => {
    if (queueAbsoluteNavigationDuringTransition(index)) return
    setCurrentSlide(index)
    if (activeFile?.type === 'presentation') {
      useAppStore.getState().navigatePptx('goto', index)
    } else if (activeFile?.type === 'pdf') {
      window.dispatchEvent(new Event('pdf-navigation-priority'))
      useAppStore.getState().releasePinnedPdfOverlay()
      window.api.sendToPresentation('navigate-slide', index)
    }
  }

  return (
    <div className="w-48 border-l border-gray-800 bg-surface-300 flex flex-col shrink-0 overflow-hidden">
      <div className="px-3 py-2 border-b border-gray-800 text-xs text-gray-400 font-medium">
        Слайды
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {!activeFile || (activeFile.type !== 'pdf' && activeFile.type !== 'presentation') ? (
          <div className="flex items-center justify-center py-8 text-gray-600 text-xs">
            Нет слайдов
          </div>
        ) : loading ? (
          <div className="flex items-center justify-center py-8 text-gray-600 text-xs">
            Загрузка...
          </div>
        ) : thumbnails.length === 0 ? (
          <div className="flex items-center justify-center py-8 text-gray-600 text-xs">
            Нет превью
          </div>
        ) : null}

        {thumbnails.map((thumb) => (
          <div
            key={thumb.index}
            ref={thumb.index === currentSlide ? activeRef : undefined}
            onClick={() => handleClick(thumb.index)}
            className={`cursor-pointer rounded-lg overflow-hidden border-2 transition-colors ${
              thumb.index === currentSlide
                ? 'border-accent'
                : 'border-transparent hover:border-gray-600'
            }`}
          >
            {thumb.dataUrl ? (
              <img
                src={thumb.dataUrl}
                alt={`Slide ${thumb.index}`}
                className="w-full block"
                draggable={false}
              />
            ) : (
              <div className="w-full aspect-video bg-gray-800/70 animate-pulse" />
            )}
            <div className={`text-center text-[10px] py-0.5 ${
              thumb.index === currentSlide ? 'text-accent bg-accent/10' : 'text-gray-500'
            }`}>
              {thumb.index}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
