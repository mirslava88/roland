import { useEffect, useRef, useState, useCallback } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import { mediaUrl } from '../../media'
import {
  renderPdfiumPageToCanvas,
  warmPdfiumDocument,
  type PdfiumRenderLane
} from '../../pdfium-renderer'
import { PDF_LIVE_SAFE_INSET_CSS_PX } from '../../pdf-live-cache'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url
).toString()

interface PdfViewerProps {
  filePath: string
  startSlide?: number
  requestId: number
  onReady?: () => void
}

type RenderedPageFrame =
  | { kind: 'native'; image: HTMLImageElement }
  | { kind: 'pdfjs'; canvas: HTMLCanvasElement; cached: boolean }

const NATIVE_FAST_PATH_MS = 150
const MAX_PDFJS_FRAME_CACHE_PIXELS = 24_000_000

export function PdfViewer({ filePath, startSlide, requestId, onReady }: PdfViewerProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [pdf, setPdf] = useState<pdfjsLib.PDFDocumentProxy | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [totalPages, setTotalPages] = useState(0)
  const renderTokenRef = useRef(0)
  const currentPageRef = useRef(1)
  const totalPagesRef = useRef(0)
  const pendingNavigationRef = useRef<number | null>(null)
  const pendingRelativeNavigationRef = useRef(0)
  const appliedStartSlideRef = useRef<number | undefined>(undefined)
  const loadedFilePathRef = useRef<string | null>(null)
  const lastPaintedRef = useRef<{ filePath: string; page: number } | null>(null)
  const pdfjsFrameCacheRef = useRef(new Map<string, HTMLCanvasElement>())
  const pdfjsFrameInflightRef = useRef(new Map<string, Promise<HTMLCanvasElement | null>>())
  const pdfjsFrameCachePixelsRef = useRef(0)
  const pdfPageMetricsRef = useRef(new Map<number, { width: number; height: number }>())
  const pdfPrewarmGenerationRef = useRef(0)
  const pdfPrewarmStartedRef = useRef(false)
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady
  const notifyContentReady = useCallback((): void => {
    if (onReadyRef.current) onReadyRef.current()
    else window.api.sendToControl('presentation-content-ready')
  }, [])

  useEffect(() => {
    let cancelled = false
    const fname = filePath.split(/[\\\\/]/).pop() || filePath
    window.api.dbgLog(`PdfViewer: useEffect[filePath] fired file=${fname}, clearing pdf state`)
    totalPagesRef.current = 0
    pendingNavigationRef.current = null
    pendingRelativeNavigationRef.current = 0
    appliedStartSlideRef.current = startSlide
    pdfjsFrameCacheRef.current.clear()
    pdfjsFrameInflightRef.current.clear()
    pdfjsFrameCachePixelsRef.current = 0
    pdfPageMetricsRef.current.clear()
    pdfPrewarmGenerationRef.current += 1
    pdfPrewarmStartedRef.current = false
    // Cancel any page render belonging to the previous file while preserving
    // its already-painted canvas until the replacement is ready.
    renderTokenRef.current += 1

    // КРИТИЧНО: сбрасываем pdf в null СИНХРОННО при смене filePath.
    // Иначе startSlide-effect (reacts to startSlide prop change в тот же
    // render cycle) вызывает setCurrentPage(newSlide) пока pdf ещё СТАРЫЙ,
    // renderPage useEffect срабатывает и рендерит страницу STAROGO документа
    // (если у обоих PDF одинаковое число страниц, guards проходят). drawImage
    // кладёт СТАРЫЙ page на onscreen canvas → sendToControl(content-ready) →
    // hideOverlay → зритель видит STARYY кадр поверх «нового» контекста.
    // Через ~70мс приходит NEW pdf и второй render — видно моргание OLD→NEW.
    // Установка pdf=null заставляет renderPage early-return (`if (!pdf)`)
    // и startSlide-effect тоже bailout, пока loadPdf асинхронно не подставит
    // NEW document.
    setPdf(null)

    async function loadPdf(): Promise<void> {
      try {
        window.api.dbgLog(`PdfViewer: readFile BEGIN ${fname}`)
        const data = await window.api.readFile(filePath)
        window.api.dbgLog(`PdfViewer: readFile END bytes=${data.byteLength}`)
        // Start the fast PDFium worker while pdf.js reads document metadata.
        // A private copy is required because both workers transfer their input.
        void warmPdfiumDocument(filePath, 'interactive', data.slice(0)).catch((error) => {
          window.api.dbgLog(`PdfViewer: PDFium warm ERROR ${String(error)}`)
        })
        const doc = await pdfjsLib.getDocument({ data }).promise
        window.api.dbgLog(`PdfViewer: getDocument END pages=${doc.numPages}`)
        if (cancelled) {
          window.api.dbgLog('PdfViewer: loadPdf cancelled post-getDocument')
          return
        }
        loadedFilePathRef.current = filePath
        setPdf(doc)
        setTotalPages(doc.numPages)
        totalPagesRef.current = doc.numPages
        const queuedPage = pendingNavigationRef.current
        const baseInitial = queuedPage && queuedPage >= 1 && queuedPage <= doc.numPages
          ? queuedPage
          : startSlide && startSlide >= 1 && startSlide <= doc.numPages
            ? startSlide
            : 1
        const queuedDelta = pendingRelativeNavigationRef.current
        const initial = Math.max(1, Math.min(doc.numPages, baseInitial + queuedDelta))
        pendingNavigationRef.current = null
        pendingRelativeNavigationRef.current = 0
        currentPageRef.current = initial
        setCurrentPage(initial)
        window.api.dbgLog(
          `PdfViewer: setPdf+setCurrentPage(${initial}) done queued=${queuedPage ?? 'none'} delta=${queuedDelta}`
        )
        window.api.sendToControl('slide-info', { current: initial, total: doc.numPages })
      } catch (err) {
        console.error('Failed to load PDF:', err)
        window.api.dbgLog(`PdfViewer: loadPdf ERROR ${String(err)}`)
      }
    }

    loadPdf()
    return () => {
      cancelled = true
    }
  }, [filePath])

  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 })

  // Track container size — window.innerWidth/innerHeight могло быть нестабильным
  // (читалось до того как окно достигнет финального размера на внешнем дисплее).
  // ResizeObserver гарантирует re-render когда div родителя реально получит
  // финальные dimensions.
  useEffect(() => {
    const c = containerRef.current
    if (!c) return
    const update = (): void => {
      const w = c.clientWidth
      const h = c.clientHeight
      setContainerSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }))
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(c)
    window.addEventListener('resize', update)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [])

  const getPdfjsFrame = useCallback(async (
    doc: pdfjsLib.PDFDocumentProxy,
    generation: number,
    pageNum: number,
    targetBufW: number,
    targetBufH: number,
    pageHint?: pdfjsLib.PDFPageProxy,
    lane: PdfiumRenderLane = 'interactive'
  ): Promise<RenderedPageFrame | null> => {
    const cacheKey = `${generation}|${pageNum}|${targetBufW}x${targetBufH}`
    const cachedCanvas = pdfjsFrameCacheRef.current.get(cacheKey)
    if (cachedCanvas) {
      pdfjsFrameCacheRef.current.delete(cacheKey)
      pdfjsFrameCacheRef.current.set(cacheKey, cachedCanvas)
      window.api.dbgLog(`PdfViewer: raster frame cache HIT page=${pageNum} size=${targetBufW}x${targetBufH}`)
      return { kind: 'pdfjs', canvas: cachedCanvas, cached: true }
    }

    const inflightKey = `${lane}|${cacheKey}`
    const existing = pdfjsFrameInflightRef.current.get(inflightKey)
    if (existing) {
      window.api.dbgLog(`PdfViewer: raster frame JOIN lane=${lane} page=${pageNum} size=${targetBufW}x${targetBufH}`)
      const canvas = await existing
      return canvas ? { kind: 'pdfjs', canvas, cached: false } : null
    }

    let job: Promise<HTMLCanvasElement | null>
    job = (async (): Promise<HTMLCanvasElement | null> => {
      const page = pageHint ?? await doc.getPage(pageNum)
      const baseViewport = page.getViewport({ scale: 1 })
      if (generation !== pdfPrewarmGenerationRef.current) return null
      pdfPageMetricsRef.current.set(pageNum, {
        width: baseViewport.width,
        height: baseViewport.height
      })

      const started = performance.now()
      let fallbackCanvas: HTMLCanvasElement
      let renderer = 'PDFium'
      try {
        const pdfiumFrame = await renderPdfiumPageToCanvas({
          filePath,
          pageNumber: pageNum,
          targetWidth: targetBufW,
          targetHeight: targetBufH,
          lane
        })
        fallbackCanvas = pdfiumFrame.canvas
      } catch (error) {
        renderer = 'pdf.js'
        window.api.dbgLog(
          `PdfViewer: PDFium ERROR lane=${lane} page=${pageNum} error=${String(error)}; using pdf.js`
        )
        fallbackCanvas = document.createElement('canvas')
        fallbackCanvas.width = targetBufW
        fallbackCanvas.height = targetBufH
        const offCtx = fallbackCanvas.getContext('2d')
        if (!offCtx) return null
        const outputScaleX = targetBufW / baseViewport.width
        const outputScaleY = targetBufH / baseViewport.height
        await page.render({
          canvasContext: offCtx,
          viewport: baseViewport,
          transform: [outputScaleX, 0, 0, outputScaleY, 0, 0]
        }).promise
      }
      if (generation !== pdfPrewarmGenerationRef.current) return null

      const pixels = fallbackCanvas.width * fallbackCanvas.height
      if (pixels <= MAX_PDFJS_FRAME_CACHE_PIXELS) {
        while (
          pdfjsFrameCacheRef.current.size > 0 &&
          pdfjsFrameCachePixelsRef.current + pixels > MAX_PDFJS_FRAME_CACHE_PIXELS
        ) {
          const oldestKey = pdfjsFrameCacheRef.current.keys().next().value as string | undefined
          if (!oldestKey) break
          const oldest = pdfjsFrameCacheRef.current.get(oldestKey)
          pdfjsFrameCacheRef.current.delete(oldestKey)
          if (oldest) pdfjsFrameCachePixelsRef.current -= oldest.width * oldest.height
        }
        pdfjsFrameCacheRef.current.set(cacheKey, fallbackCanvas)
        pdfjsFrameCachePixelsRef.current += pixels
      }

      window.api.dbgLog(
        `PdfViewer: raster frame READY renderer=${renderer} lane=${lane} page=${pageNum} buffer=${fallbackCanvas.width}x${fallbackCanvas.height} dur=${Math.round(performance.now() - started)}ms`
      )
      return fallbackCanvas
    })()

    pdfjsFrameInflightRef.current.set(inflightKey, job)
    try {
      const canvas = await job
      return canvas ? { kind: 'pdfjs', canvas, cached: false } : null
    } finally {
      if (pdfjsFrameInflightRef.current.get(inflightKey) === job) {
        pdfjsFrameInflightRef.current.delete(inflightKey)
      }
    }
  }, [filePath])

  const startPdfPrewarm = useCallback((
    doc: pdfjsLib.PDFDocumentProxy,
    generation: number,
    anchorPage: number,
    containerWidth: number,
    containerHeight: number,
    dpr: number
  ): void => {
    if (pdfPrewarmStartedRef.current) return
    pdfPrewarmStartedRef.current = true

    const pageOrder: number[] = []
    for (let distance = 1; pageOrder.length < doc.numPages - 1; distance++) {
      const after = anchorPage + distance
      const before = anchorPage - distance
      if (after <= doc.numPages) pageOrder.push(after)
      if (before >= 1) pageOrder.push(before)
    }

    void (async () => {
      window.api.dbgLog(`PdfViewer: prewarm BEGIN anchor=${anchorPage} pages=${pageOrder.join(',')}`)
      try {
        for (const candidate of pageOrder) {
          if (
            generation !== pdfPrewarmGenerationRef.current ||
            loadedFilePathRef.current !== filePath
          ) return

          const started = performance.now()
          try {
            const page = await doc.getPage(candidate)
            const viewport = page.getViewport({ scale: 1 })
            pdfPageMetricsRef.current.set(candidate, {
              width: viewport.width,
              height: viewport.height
            })
            const fitScale = Math.min(
              containerWidth / viewport.width,
              containerHeight / viewport.height
            )
            const targetWidth = Math.max(1, Math.round(viewport.width * fitScale * dpr))
            const targetHeight = Math.max(1, Math.round(viewport.height * fitScale * dpr))

            const nativePath = await window.api.renderPdfPage(
              filePath,
              candidate - 1,
              targetWidth
            )
            if (!nativePath) {
              await getPdfjsFrame(
                doc,
                generation,
                candidate,
                targetWidth,
                targetHeight,
                page,
                'background'
              )
            }
            window.api.dbgLog(
              `PdfViewer: prewarm READY page=${candidate} renderer=${nativePath ? 'native' : 'pdf.js'} dur=${Math.round(performance.now() - started)}ms`
            )
          } catch (error) {
            window.api.dbgLog(`PdfViewer: prewarm ERROR page=${candidate} error=${String(error)}`)
          }

          await new Promise<void>((resolve) => setTimeout(resolve, 0))
        }
      } finally {
        window.api.dbgLog('PdfViewer: prewarm END')
      }
    })()
  }, [filePath, getPdfjsFrame])

  const renderPage = useCallback(
    async (pageNum: number, cw: number, ch: number) => {
      if (
        !pdf ||
        loadedFilePathRef.current !== filePath ||
        !canvasRef.current ||
        cw === 0 ||
        ch === 0
      ) return
      const token = ++renderTokenRef.current
      const generation = pdfPrewarmGenerationRef.current
      const rendererDpr = window.devicePixelRatio || 1
      let displayScaleFactor = rendererDpr
      try {
        displayScaleFactor = await window.api.getWindowDisplayScaleFactor()
      } catch { /* renderer DPR remains a safe fallback */ }
      if (token !== renderTokenRef.current) return
      // Prefer the larger value: a stale DPR from the primary display must not
      // undersample a high-DPI output. Oversampling in the opposite direction
      // costs a little memory but preserves quality.
      const dpr = Math.max(1, rendererDpr, displayScaleFactor || 1)
      window.api.dbgLog(
        `PdfViewer: renderPage BEGIN page=${pageNum} container=${cw}x${ch} rendererDpr=${rendererDpr} displayScale=${displayScaleFactor} effectiveDpr=${dpr} winInner=${window.innerWidth}x${window.innerHeight}`
      )

      // Reassigning canvas.width/height clears the canvas to transparent —
      // if we do that BEFORE await page.render() resolves, the audience sees
      // a black frame for 100-300ms on first view of a page (pdf.js decodes
      // on first touch, cached afterwards). Render to an offscreen canvas
      // first, keeping the visible canvas showing the PREVIOUS page the
      // whole time, then swap dimensions+content in one synchronous step.
      let pageHint: pdfjsLib.PDFPageProxy | undefined
      let pageMetrics = pdfPageMetricsRef.current.get(pageNum)
      if (!pageMetrics) {
        pageHint = await pdf.getPage(pageNum)
        if (token !== renderTokenRef.current) {
          window.api.dbgLog(`PdfViewer: renderPage STALE token post-getPage page=${pageNum}`)
          return
        }
        const viewport = pageHint.getViewport({ scale: 1 })
        pageMetrics = { width: viewport.width, height: viewport.height }
        pdfPageMetricsRef.current.set(pageNum, pageMetrics)
      }

      const fitScale = Math.min(cw / pageMetrics.width, ch / pageMetrics.height)
      const cssWidth = Math.round(pageMetrics.width * fitScale)
      const cssHeight = Math.round(pageMetrics.height * fitScale)
      const targetBufW = Math.round(cssWidth * dpr)
      const targetBufH = Math.round(cssHeight * dpr)

      // КРИТИЧНО: pdf.js имеет баг с TilingPattern при scale > 1 — pattern
      // не покрывает всю область, контент обрезается справа. PDF от PowerPoint
      // часто использует tiling pattern для фона. Пытаемся отрендерить через
      // нативный Windows.Data.Pdf engine (без бага, pixel-perfect качество).
      // Native render возвращает путь к PNG; рисуем его на canvas через Image.
      window.api.dbgLog(
        `PdfViewer: renderPage SCALE pdf=${pageMetrics.width}x${pageMetrics.height} fit=${fitScale.toFixed(3)} css=${cssWidth}x${cssHeight} bufTarget=${targetBufW}x${targetBufH}`
      )

      const renderStarted = performance.now()
      const nativeImagePromise = (async (): Promise<HTMLImageElement | null> => {
        try {
          const nativePath = await window.api.renderPdfPage(filePath, pageNum - 1, targetBufW)
          if (!nativePath || token !== renderTokenRef.current) return null
          return await new Promise<HTMLImageElement>((resolve, reject) => {
            const im = new Image()
            im.onload = () => resolve(im)
            im.onerror = () => reject(new Error('image load failed'))
            im.src = `${mediaUrl(nativePath)}?t=${Date.now()}`
          })
        } catch (e) {
          window.api.dbgLog(`PdfViewer: native image load failed ${String(e)}, fallback to pdf.js`)
          return null
        }
      })()

      const renderPdfjsFrame = (): Promise<RenderedPageFrame | null> => (
        getPdfjsFrame(
          pdf,
          generation,
          pageNum,
          targetBufW,
          targetBufH,
          pageHint
        ).catch((error) => {
          window.api.dbgLog(
            `PdfViewer: raster fallback failed for page ${pageNum}: ${String(error)}`
          )
          return null
        })
      )

      // Cached native frames arrive almost immediately. If Windows must render
      // from scratch, race it against pdf.js and commit only the first complete
      // frame. The native result may finish into disk cache, but never replaces
      // an already visible pdf.js frame, which preserves flicker-free output.
      const quickNative = await Promise.race([
        nativeImagePromise,
        new Promise<undefined>((resolve) => setTimeout(resolve, NATIVE_FAST_PATH_MS))
      ])
      if (token !== renderTokenRef.current) return

      let frame: RenderedPageFrame | null
      if (quickNative) {
        frame = { kind: 'native', image: quickNative }
      } else {
        const pdfjsFramePromise = renderPdfjsFrame()
        const nativeFramePromise = nativeImagePromise.then<RenderedPageFrame | null>((image) => (
          image ? { kind: 'native', image } : null
        ))
        frame = await Promise.race([
          nativeFramePromise.then((result) => result ?? pdfjsFramePromise),
          pdfjsFramePromise.then((result) => result ?? nativeFramePromise)
        ])
      }

      if (token !== renderTokenRef.current || !frame) return
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      // Commit only after either native decode or the complete pdf.js render.
      // Resizing canvas clears it, so doing this before the fallback await
      // would expose a white/black frame during navigation.
      if (canvas.width !== targetBufW || canvas.height !== targetBufH) {
        canvas.width = targetBufW
        canvas.height = targetBufH
      }
      canvas.style.width = `${cssWidth}px`
      canvas.style.height = `${cssHeight}px`
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'

      if (frame.kind === 'native') {
        // Lossless native render — draw directly (native image can be larger
        // than targetBuf when Windows.Data.Pdf applies its own DPI).
        ctx.drawImage(frame.image, 0, 0, frame.image.naturalWidth, frame.image.naturalHeight, 0, 0, targetBufW, targetBufH)
        window.api.dbgLog(
          `PdfViewer: drawImage NATIVE done page=${pageNum} src=${frame.image.naturalWidth}x${frame.image.naturalHeight} dst=${targetBufW}x${targetBufH} total=${Math.round(performance.now() - renderStarted)}ms`
        )
      } else {
        ctx.drawImage(frame.canvas, 0, 0)
        window.api.dbgLog(
          `PdfViewer: drawImage RASTER_RACE done page=${pageNum} buffer=${frame.canvas.width}x${frame.canvas.height} cached=${frame.cached} total=${Math.round(performance.now() - renderStarted)}ms`
        )
      }

      // This is the only trustworthy readiness marker: React state and
      // currentPageRef can already point at the requested page while the
      // visible canvas still contains the previous frame.
      lastPaintedRef.current = { filePath, page: pageNum }

      // Once the first visible frame is safe, prepare every remaining page in
      // the background. Slow pdf.js pages share an in-flight job with a later
      // click, so navigation never starts the same multi-second render twice.
      void nativeImagePromise.then(() => {
        if (generation !== pdfPrewarmGenerationRef.current) return
        startPdfPrewarm(pdf, generation, pageNum, cw, ch, dpr)
      })

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          window.api.dbgLog(`PdfViewer: sendToControl(presentation-content-ready) page=${pageNum}`)
          notifyContentReady()
        })
      })
    },
    [pdf, filePath, getPdfjsFrame, notifyContentReady, startPdfPrewarm]
  )

  useEffect(() => {
    if (containerSize.w > 0 && containerSize.h > 0) {
      renderPage(currentPage, containerSize.w, containerSize.h)
    }
  }, [currentPage, renderPage, containerSize])

  // Реагируем на изменение startSlide когда файл уже загружен (тот же PDF
  // активируется из другого канала с заранее выставленным слайдом).
  // Load-effect выше зависит только от filePath и не сработает для одного
  // и того же пути.
  useEffect(() => {
    if (!pdf || !startSlide) return
    if (appliedStartSlideRef.current === startSlide) return
    if (startSlide < 1 || startSlide > totalPages) return
    appliedStartSlideRef.current = startSlide
    if (startSlide === currentPage) return
    currentPageRef.current = startSlide
    setCurrentPage(startSlide)
    window.api.sendToControl('slide-info', { current: startSlide, total: totalPages })
  }, [startSlide, pdf, totalPages])

  useEffect(() => {
    // Taking a PDF that is already loaded behind PowerPoint may require no
    // repaint at all. A repaint-driven ready signal would never arrive and
    // the TAKE waited for the full five-second timeout. Each load-content has
    // a new requestId, so acknowledge an already-painted target explicitly;
    // if another page is requested, trigger its normal render instead.
    if (!pdf || loadedFilePathRef.current !== filePath) return
    const requestedPage = Math.max(1, Math.min(totalPagesRef.current, startSlide || 1))
    appliedStartSlideRef.current = requestedPage

    if (requestedPage !== currentPageRef.current || requestedPage !== currentPage) {
      currentPageRef.current = requestedPage
      setCurrentPage(requestedPage)
      window.api.sendToControl('slide-info', { current: requestedPage, total: totalPagesRef.current })
      return
    }

    const painted = lastPaintedRef.current
    if (!painted || painted.filePath !== filePath || painted.page !== requestedPage) {
      // A render can be pending even though both page state values already
      // equal the target. Start (or replace) it explicitly and let the real
      // drawImage path emit presentation-content-ready.
      if (containerSize.w > 0 && containerSize.h > 0) {
        window.api.dbgLog(
          `PdfViewer: requested page not painted yet page=${requestedPage} request=${requestId}; forcing render`
        )
        void renderPage(requestedPage, containerSize.w, containerSize.h)
      }
      return
    }

    let frame1 = 0
    let frame2 = 0
    frame1 = requestAnimationFrame(() => {
      frame2 = requestAnimationFrame(() => {
        window.api.dbgLog(`PdfViewer: reuse painted page=${requestedPage} request=${requestId}`)
        notifyContentReady()
      })
    })
    return () => {
      cancelAnimationFrame(frame1)
      cancelAnimationFrame(frame2)
    }
  }, [requestId])

  useEffect(() => {
    const unsubNavigate = window.api.on('navigate-slide', (...args: unknown[]) => {
      const pageNum = args[0] as number
      if (!Number.isInteger(pageNum) || pageNum < 1) return

      const knownTotal = totalPagesRef.current
      if (knownTotal === 0) {
        // A presenter click can arrive while pdf.js is still loading the file.
        // Remember the latest target instead of silently dropping the click.
        pendingNavigationRef.current = pageNum
        window.api.dbgLog(`PdfViewer: navigate queued page=${pageNum} while loading`)
        return
      }

      if (pageNum > knownTotal) return
      pendingNavigationRef.current = null
      currentPageRef.current = pageNum
      setCurrentPage(pageNum)
      // The control window already updates its page optimistically before
      // sending this command. Echoing the page back here can arrive after a
      // newer click and roll its store backwards, making the next click look
      // swallowed. Only local output-window key events need slide-info echoes.
      window.api.dbgLog(`PdfViewer: navigate applied page=${pageNum}`)
      window.api.sendToControl('slide-info', { current: pageNum, total: knownTotal })
    })

    const unsubRelativeNavigate = window.api.on('navigate-pdf', (...args: unknown[]) => {
      const direction = args[0] as 'next' | 'prev'
      if (direction !== 'next' && direction !== 'prev') return
      const delta = direction === 'next' ? 1 : -1
      const knownTotal = totalPagesRef.current

      if (knownTotal === 0) {
        pendingRelativeNavigationRef.current += delta
        window.api.dbgLog(
          `PdfViewer: relative navigate queued direction=${direction} delta=${pendingRelativeNavigationRef.current}`
        )
        return
      }

      const from = currentPageRef.current
      const target = Math.max(1, Math.min(knownTotal, from + delta))
      window.api.dbgLog(`PdfViewer: relative navigate ${direction} ${from}->${target}/${knownTotal}`)
      if (target === from) return
      currentPageRef.current = target
      setCurrentPage(target)
      window.api.sendToControl('slide-info', { current: target, total: knownTotal })
    })

    return () => {
      unsubNavigate()
      unsubRelativeNavigate()
    }
  }, [])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
        e.preventDefault()
        if (currentPage < totalPages) {
          const newPage = currentPage + 1
          currentPageRef.current = newPage
          setCurrentPage(newPage)
          window.api.sendToControl('slide-info', { current: newPage, total: totalPages })
        }
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault()
        if (currentPage > 1) {
          const newPage = currentPage - 1
          currentPageRef.current = newPage
          setCurrentPage(newPage)
          window.api.sendToControl('slide-info', { current: newPage, total: totalPages })
        }
      } else if (e.key === 'Escape') {
        window.api.sendToControl('request-close-presentation')
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [currentPage, totalPages])

  return (
    <div className="w-full h-full flex items-center justify-center bg-black">
      <div
        ref={containerRef}
        className="flex items-center justify-center"
        style={{
          width: `calc(100% - ${PDF_LIVE_SAFE_INSET_CSS_PX * 2}px)`,
          height: `calc(100% - ${PDF_LIVE_SAFE_INSET_CSS_PX * 2}px)`
        }}
      >
        <canvas ref={canvasRef} />
      </div>
    </div>
  )
}
