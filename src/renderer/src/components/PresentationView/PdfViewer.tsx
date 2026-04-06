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

  useEffect(() => {
    let cancelled = false

    async function loadPdf(): Promise<void> {
      try {
        const data = await window.api.readFile(filePath)
        const doc = await pdfjsLib.getDocument({ data }).promise
        if (cancelled) return
        setPdf(doc)
        setTotalPages(doc.numPages)
        const initial = startSlide && startSlide >= 1 && startSlide <= doc.numPages ? startSlide : 1
        setCurrentPage(initial)
        window.api.sendToControl('slide-info', { current: initial, total: doc.numPages })
      } catch (err) {
        console.error('Failed to load PDF:', err)
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

      const page = await pdf.getPage(pageNum)
      const canvas = canvasRef.current
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      const containerWidth = window.innerWidth
      const containerHeight = window.innerHeight
      const viewport = page.getViewport({ scale: 1 })

      const scaleX = containerWidth / viewport.width
      const scaleY = containerHeight / viewport.height
      const scale = Math.min(scaleX, scaleY)

      const scaledViewport = page.getViewport({ scale })

      canvas.width = scaledViewport.width
      canvas.height = scaledViewport.height

      await page.render({
        canvasContext: ctx,
        viewport: scaledViewport
      }).promise
    },
    [pdf]
  )

  useEffect(() => {
    renderPage(currentPage)
  }, [currentPage, renderPage])

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
