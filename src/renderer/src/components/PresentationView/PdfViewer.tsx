import { useEffect, useRef, useState, useCallback } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import { mediaUrl } from '../../media'

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
      const page = await pdf.getPage(pageNum)
      if (token !== renderTokenRef.current) {
        window.api.dbgLog(`PdfViewer: renderPage STALE token post-getPage page=${pageNum}`)
        return
      }

      const baseViewport = page.getViewport({ scale: 1 })
      const fitScale = Math.min(cw / baseViewport.width, ch / baseViewport.height)
      const cssWidth = Math.round(baseViewport.width * fitScale)
      const cssHeight = Math.round(baseViewport.height * fitScale)
      const targetBufW = Math.round(cssWidth * dpr)
      const targetBufH = Math.round(cssHeight * dpr)

      // КРИТИЧНО: pdf.js имеет баг с TilingPattern при scale > 1 — pattern
      // не покрывает всю область, контент обрезается справа. PDF от PowerPoint
      // часто использует tiling pattern для фона. Пытаемся отрендерить через
      // нативный Windows.Data.Pdf engine (без бага, pixel-perfect качество).
      // Native render возвращает путь к PNG; рисуем его на canvas через Image.
      window.api.dbgLog(
        `PdfViewer: renderPage SCALE pdf=${baseViewport.width}x${baseViewport.height} fit=${fitScale.toFixed(3)} css=${cssWidth}x${cssHeight} bufTarget=${targetBufW}x${targetBufH}`
      )

      const nativePath = await window.api.renderPdfPage(filePath, pageNum - 1, targetBufW)
      if (token !== renderTokenRef.current) {
        window.api.dbgLog(`PdfViewer: renderPage STALE token post-nativeRender page=${pageNum}`)
        return
      }

      let nativeImg: HTMLImageElement | null = null
      if (nativePath) {
        try {
          nativeImg = await new Promise<HTMLImageElement>((resolve, reject) => {
            const im = new Image()
            im.onload = () => resolve(im)
            im.onerror = () => reject(new Error('image load failed'))
            im.src = `${mediaUrl(nativePath)}?t=${Date.now()}`
          })
        } catch (e) {
          window.api.dbgLog(`PdfViewer: native image load failed ${String(e)}, fallback to pdf.js`)
        }
      }

      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      if (canvas.width !== targetBufW || canvas.height !== targetBufH) {
        canvas.width = targetBufW
        canvas.height = targetBufH
      }
      canvas.style.width = `${cssWidth}px`
      canvas.style.height = `${cssHeight}px`
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'

      if (nativeImg) {
        // Lossless native render — рисуем напрямую (native image может быть
        // больше targetBuf если Windows.Data.Pdf применил свой DPI; canvas
        // ужмёт его, всё равно качественно).
        ctx.drawImage(nativeImg, 0, 0, nativeImg.naturalWidth, nativeImg.naturalHeight, 0, 0, targetBufW, targetBufH)
        window.api.dbgLog(
          `PdfViewer: drawImage NATIVE done page=${pageNum} src=${nativeImg.naturalWidth}x${nativeImg.naturalHeight} dst=${targetBufW}x${targetBufH}`
        )
      } else {
        // HiDPI fallback for machines where Windows.Data.Pdf is unavailable.
        // Keep viewport.scale=1 to avoid the pdf.js TilingPattern regression,
        // but apply the standard output transform so vectors/text are painted
        // directly into the full-resolution display buffer. The old fallback
        // rendered a small base-size bitmap and stretched it, causing visibly
        // blurry text on the affected computer.
        const off = document.createElement('canvas')
        off.width = targetBufW
        off.height = targetBufH
        const offCtx = off.getContext('2d')
        if (!offCtx) return
        const outputScaleX = targetBufW / baseViewport.width
        const outputScaleY = targetBufH / baseViewport.height
        await page.render({
          canvasContext: offCtx,
          viewport: baseViewport,
          transform: [outputScaleX, 0, 0, outputScaleY, 0, 0]
        }).promise
        if (token !== renderTokenRef.current) return
        ctx.drawImage(off, 0, 0)
        window.api.dbgLog(
          `PdfViewer: drawImage FALLBACK_HIDPI pdf.js page=${pageNum} buffer=${off.width}x${off.height} outputScale=${outputScaleX.toFixed(3)}x${outputScaleY.toFixed(3)}`
        )
      }

      // This is the only trustworthy readiness marker: React state and
      // currentPageRef can already point at the requested page while the
      // visible canvas still contains the previous frame.
      lastPaintedRef.current = { filePath, page: pageNum }

      // Warm the pages the presenter is most likely to visit next. Native
      // Windows.Data.Pdf keeps the final quality, while navigation becomes a
      // disk-cache hit instead of paying PowerShell/WinRT startup each time.
      // The main process deduplicates this with an immediate user request.
      if (nativePath) {
        const nearbyPages = [pageNum + 1, pageNum + 2, pageNum - 1]
          .filter((candidate, index, pages) => (
            candidate >= 1 && candidate <= pdf.numPages && pages.indexOf(candidate) === index
          ))
        void (async () => {
          for (const nearbyPage of nearbyPages) {
            if (token !== renderTokenRef.current) return
            try {
              window.api.dbgLog(`PdfViewer: prefetch BEGIN page=${nearbyPage} width=${targetBufW}`)
              const prefetched = await window.api.renderPdfPage(filePath, nearbyPage - 1, targetBufW)
              window.api.dbgLog(`PdfViewer: prefetch END page=${nearbyPage} cached=${Boolean(prefetched)}`)
            } catch (error) {
              window.api.dbgLog(`PdfViewer: prefetch ERROR page=${nearbyPage} ${String(error)}`)
            }
          }
        })()
      }

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          window.api.dbgLog(`PdfViewer: sendToControl(presentation-content-ready) page=${pageNum}`)
          notifyContentReady()
        })
      })
    },
    [pdf, filePath, notifyContentReady]
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
    <div ref={containerRef} className="w-full h-full flex items-center justify-center bg-black">
      <canvas ref={canvasRef} />
    </div>
  )
}
