import { useEffect, useRef, useState, useCallback } from 'react'
import * as pdfjsLib from 'pdfjs-dist'

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

  const renderPage = useCallback(
    async (pageNum: number) => {
      if (!pdf || !canvasRef.current) return
      window.api.dbgLog(`PdfViewer: renderPage BEGIN page=${pageNum}`)

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

      const containerWidth = window.innerWidth
      const containerHeight = window.innerHeight
      const viewport = page.getViewport({ scale: 1 })
      const scale = Math.min(containerWidth / viewport.width, containerHeight / viewport.height)
      const scaledViewport = page.getViewport({ scale })

      const off = document.createElement('canvas')
      off.width = scaledViewport.width
      off.height = scaledViewport.height
      const offCtx = off.getContext('2d')
      if (!offCtx) return

      await page.render({ canvasContext: offCtx, viewport: scaledViewport }).promise
      if (token !== renderTokenRef.current) {
        window.api.dbgLog(`PdfViewer: renderPage STALE token post-render page=${pageNum}`)
        return
      }

      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      // Переназначение canvas.width/height — даже с тем же значением —
      // всегда сбрасывает canvas в transparent. Если между reset и drawImage
      // DWM compositor захватит frame, зритель видит BG родителя (bg-black)
      // вместо предыдущего кадра → micro-flash. Для PDF→PDF где оба файла
      // рендерятся 1112x1440, это даёт заметное мерцание на transition.
      // Меняем размер только когда он РЕАЛЬНО изменился.
      if (canvas.width !== off.width || canvas.height !== off.height) {
        canvas.width = off.width
        canvas.height = off.height
      }
      ctx.drawImage(off, 0, 0)
      window.api.dbgLog(`PdfViewer: drawImage done page=${pageNum} size=${off.width}x${off.height}, scheduling 2xrAF → content-ready`)
      // drawImage writes the canvas backing store, but the compositor needs
      // 1–2 frames before the new pixels actually reach the screen. If we
      // fire content-ready synchronously, the overlay starts its 150ms fade
      // while the canvas is still showing the OLD page, producing a brief
      // visible swap through the partially-faded overlay. Wait two rAFs so
      // the new frame is committed before telling the control window it's
      // safe to lift the cover.
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
    renderPage(currentPage)
  }, [currentPage, renderPage])

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
    <div className="w-full h-full flex items-center justify-center bg-black">
      <canvas ref={canvasRef} />
    </div>
  )
}
