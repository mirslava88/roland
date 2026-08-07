import * as pdfjsLib from 'pdfjs-dist'
import { renderPdfiumPageToCanvas, warmPdfiumDocument } from './pdfium-renderer'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url
).toString()

// A small safe area protects PDF edges on displays/projectors with overscan.
// PowerPoint, video and every auxiliary output keep their existing sizing.
export const PDF_LIVE_SAFE_INSET_CSS_PX = 16

export interface PdfLivePrewarmRequest {
  filePath: string
  cacheKey: string
  targetWidth: number
  targetHeight: number
  anchorPage: number
}

export interface PdfLivePrewarmResult {
  success: boolean
  totalPages: number
  cachedPages: number
  error?: string
}

const pdfLivePrewarmJobs = new Map<string, Promise<PdfLivePrewarmResult>>()
let pdfLivePrewarmQueue: Promise<void> = Promise.resolve()

export function getPdfLiveTargetSize(display: DisplayInfo): { width: number; height: number } {
  const scaleFactor = Math.max(1, display.scaleFactor || 1)
  const cssWidth = Math.max(64, display.bounds.width - PDF_LIVE_SAFE_INSET_CSS_PX * 2)
  const cssHeight = Math.max(64, display.bounds.height - PDF_LIVE_SAFE_INSET_CSS_PX * 2)
  return {
    width: Math.max(64, Math.round(cssWidth * scaleFactor)),
    height: Math.max(64, Math.round(cssHeight * scaleFactor))
  }
}

export function makePdfLiveCacheKey(
  filePath: string,
  targetWidth: number,
  targetHeight: number
): string {
  return `${filePath}|${targetWidth}x${targetHeight}`
}

function pageOrder(totalPages: number, anchorPage: number): number[] {
  const anchor = Math.max(1, Math.min(totalPages, Math.round(anchorPage) || 1))
  const result = [anchor]
  for (let distance = 1; result.length < totalPages; distance++) {
    const after = anchor + distance
    const before = anchor - distance
    if (after <= totalPages) result.push(after)
    if (before >= 1) result.push(before)
  }
  return result
}

/**
 * Prepare the exact full-screen frames used by PdfViewer. This function runs
 * inside the already-warm presentation renderer, so PDFium's interactive
 * cache is shared with the eventual TAKE. Successful native Windows renders
 * are also cached on disk by the main process and survive renderer eviction.
 */
export function ensurePdfLiveCache(
  request: PdfLivePrewarmRequest,
  onProgress?: (cachedPages: number, totalPages: number) => void
): Promise<PdfLivePrewarmResult> {
  const existing = pdfLivePrewarmJobs.get(request.cacheKey)
  if (existing) return existing

  let job: Promise<PdfLivePrewarmResult>
  const run = async (): Promise<PdfLivePrewarmResult> => {
    let document: pdfjsLib.PDFDocumentProxy | null = null
    try {
      window.api.dbgLog(
        `PDF channel cache: BEGIN file=${request.filePath} target=${request.targetWidth}x${request.targetHeight}`
      )
      const data = await window.api.readFile(request.filePath)
      const pdfiumWarm = warmPdfiumDocument(
        request.filePath,
        'interactive',
        data.slice(0)
      ).catch((error) => {
        window.api.dbgLog(`PDF channel cache: PDFium warm ERROR ${String(error)}`)
        return 0
      })
      document = await pdfjsLib.getDocument({ data }).promise
      await pdfiumWarm

      const totalPages = document.numPages
      let cachedPages = 0
      for (const pageNumber of pageOrder(totalPages, request.anchorPage)) {
        const started = performance.now()
        try {
          const page = await document.getPage(pageNumber)
          const viewport = page.getViewport({ scale: 1 })
          const fitScale = Math.min(
            request.targetWidth / viewport.width,
            request.targetHeight / viewport.height
          )
          const frameWidth = Math.max(1, Math.round(viewport.width * fitScale))
          const frameHeight = Math.max(1, Math.round(viewport.height * fitScale))

          // PdfViewer always tries this native cache first. When WinRT is not
          // available or rejects a visually invalid page, keep an exact PDFium
          // frame in the same renderer as the live viewer.
          const nativePath = await window.api.renderPdfPage(
            request.filePath,
            pageNumber - 1,
            frameWidth
          )
          if (!nativePath) {
            await renderPdfiumPageToCanvas({
              filePath: request.filePath,
              pageNumber,
              targetWidth: frameWidth,
              targetHeight: frameHeight,
              lane: 'interactive'
            })
          }

          cachedPages += 1
          onProgress?.(cachedPages, totalPages)
          window.api.dbgLog(
            `PDF channel cache: READY page=${pageNumber}/${totalPages} renderer=${nativePath ? 'native' : 'PDFium'} dur=${Math.round(performance.now() - started)}ms`
          )
        } catch (error) {
          window.api.dbgLog(
            `PDF channel cache: page ERROR page=${pageNumber}/${totalPages} error=${String(error)}`
          )
        }

        // Yield between heavy pages so video/capture and operator IPC stay
        // responsive while a large document is being prepared.
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
      }

      const success = totalPages > 0 && cachedPages > 0
      window.api.dbgLog(
        `PDF channel cache: END cached=${cachedPages}/${totalPages} success=${success}`
      )
      return { success, totalPages, cachedPages }
    } catch (error) {
      window.api.dbgLog(`PDF channel cache: ERROR file=${request.filePath} error=${String(error)}`)
      return {
        success: false,
        totalPages: 0,
        cachedPages: 0,
        error: String(error)
      }
    } finally {
      // PDF.js cleanup can occasionally wait forever after every page has
      // already been rendered (notably when another PDF document is open for
      // thumbnails). Do not let that block the completed cache result, the UI
      // status or every following document in the prewarm queue.
      try {
        if (document) void document.destroy().catch(() => undefined)
      } catch (error) {
        // Some PDF.js document states throw synchronously from destroy(). The
        // exact-size pages are already cached, so cleanup must never turn a
        // successful preparation into a false "cache not ready" result.
        window.api.dbgLog(
          `PDF channel cache: cleanup ignored file=${request.filePath} error=${String(error)}`
        )
      } finally {
        if (pdfLivePrewarmJobs.get(request.cacheKey) === job) {
          pdfLivePrewarmJobs.delete(request.cacheKey)
        }
      }
    }
  }

  // A numbered-folder import may add many PDFs at once. Prepare documents in
  // order so background caching never launches a storm of PowerShell/WinRT
  // renderers that could slow the operator UI or the current live output.
  job = pdfLivePrewarmQueue.then(run, run)
  pdfLivePrewarmQueue = job.then(() => undefined, () => undefined)
  pdfLivePrewarmJobs.set(request.cacheKey, job)
  return job
}
