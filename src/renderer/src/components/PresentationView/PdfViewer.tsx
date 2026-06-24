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
}

export function PdfViewer({ filePath, startSlide }: PdfViewerProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [pdf, setPdf] = useState<pdfjsLib.PDFDocumentProxy | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [totalPages, setTotalPages] = useState(0)
  const renderTokenRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    const fname = filePath.split(/[\\\\/]/).pop() || filePath
    window.api.dbgLog(`PdfViewer: useEffect[filePath] fired file=${fname}, clearing pdf state`)

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
        setPdf(doc)
        setTotalPages(doc.numPages)
        const initial = startSlide && startSlide >= 1 && startSlide <= doc.numPages ? startSlide : 1
        setCurrentPage(initial)
        window.api.dbgLog(`PdfViewer: setPdf+setCurrentPage(${initial}) done`)
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
      if (!pdf || !canvasRef.current || cw === 0 || ch === 0) return
      const dpr = window.devicePixelRatio || 1
      window.api.dbgLog(
        `PdfViewer: renderPage BEGIN page=${pageNum} container=${cw}x${ch} dpr=${dpr} winInner=${window.innerWidth}x${window.innerHeight}`
      )

      // Reassigning canvas.width/height clears the canvas to transparent —
      // if we do that BEFORE await page.render() resolves, the audience sees
      // a black frame for 100-300ms on first view of a page (pdf.js decodes
      // on first touch, cached afterwards). Render to an offscreen canvas
      // first, keeping the visible canvas showing the PREVIOUS page the
      // whole time, then swap dimensions+content in one synchronous step.
      const token = ++renderTokenRef.current
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
        // Fallback: pdf.js на native scale + upscale (низкое качество, но
        // обходит TilingPattern bug). Срабатывает если native engine не
        // отработал (не-Win платформа, ошибка PS, и т.д.).
        const off = document.createElement('canvas')
        off.width = Math.round(baseViewport.width)
        off.height = Math.round(baseViewport.height)
        const offCtx = off.getContext('2d')
        if (!offCtx) return
        await page.render({ canvasContext: offCtx, viewport: baseViewport }).promise
        if (token !== renderTokenRef.current) return
        ctx.drawImage(off, 0, 0, off.width, off.height, 0, 0, targetBufW, targetBufH)
        window.api.dbgLog(
          `PdfViewer: drawImage FALLBACK pdf.js page=${pageNum} src=${off.width}x${off.height} dst=${targetBufW}x${targetBufH}`
        )
      }
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          window.api.dbgLog(`PdfViewer: sendToControl(presentation-content-ready) page=${pageNum}`)
          window.api.sendToControl('presentation-content-ready')
        })
      })
    },
    [pdf]
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
    if (startSlide < 1 || startSlide > totalPages) return
    if (startSlide === currentPage) return
    setCurrentPage(startSlide)
    window.api.sendToControl('slide-info', { current: startSlide, total: totalPages })
  }, [startSlide, pdf, totalPages])

  useEffect(() => {
    const unsubNavigate = window.api.on('navigate-slide', (...args: unknown[]) => {
      const pageNum = args[0] as number
      if (pageNum >= 1 && pageNum <= totalPages) {
        setCurrentPage(pageNum)
        window.api.sendToControl('slide-info', { current: pageNum, total: totalPages })
      }
    })

    return () => {
      unsubNavigate()
    }
  }, [totalPages])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
        e.preventDefault()
        if (currentPage < totalPages) {
          const newPage = currentPage + 1
          setCurrentPage(newPage)
          window.api.sendToControl('slide-info', { current: newPage, total: totalPages })
        }
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault()
        if (currentPage > 1) {
          const newPage = currentPage - 1
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
