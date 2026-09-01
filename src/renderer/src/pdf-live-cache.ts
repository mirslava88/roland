import * as pdfjsLib from 'pdfjs-dist'
import {
  releasePdfiumResources,
  renderPdfiumPageToCanvas,
  warmPdfiumDocument
} from './pdfium-renderer'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url
).toString()

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
const pdfLivePrewarmJobFiles = new Map<string, string>()
let pdfLivePrewarmQueue: Promise<void> = Promise.resolve()
let pdfLivePrewarmGeneration = 0
const pdfLiveFileGenerations = new Map<string, number>()
const pdfLiveLoadingTasks = new Map<pdfjsLib.PDFDocumentLoadingTask, string>()

/**
 * Stop background PDF preparation when the program output is explicitly
 * cleared. Channel cards can request it again later; an idle output must not
 * keep a PDF.js worker/document alive just because a cache job was queued.
 */
export function cancelPdfLivePrewarmJobs(): void {
  pdfLivePrewarmGeneration += 1
  pdfLivePrewarmJobs.clear()
  pdfLivePrewarmJobFiles.clear()
  for (const task of pdfLiveLoadingTasks.keys()) {
    void task.destroy().catch(() => undefined)
  }
  pdfLiveLoadingTasks.clear()
  window.api.dbgLog('PDF channel cache: cancelled all pending jobs')
}

/**
 * Forget one PDF as soon as its last channel assignment disappears. This is
 * deliberately file-scoped: releasing every PDF here could invalidate a
 * different document that is still live or being previewed in this renderer.
 */
export function cancelPdfLivePrewarmFile(filePath: string): void {
  pdfLiveFileGenerations.set(filePath, (pdfLiveFileGenerations.get(filePath) || 0) + 1)
  for (const [cacheKey, jobFilePath] of pdfLivePrewarmJobFiles) {
    if (jobFilePath !== filePath) continue
    pdfLivePrewarmJobs.delete(cacheKey)
    pdfLivePrewarmJobFiles.delete(cacheKey)
  }
  for (const [task, taskFilePath] of pdfLiveLoadingTasks) {
    if (taskFilePath !== filePath) continue
    pdfLiveLoadingTasks.delete(task)
    void task.destroy().catch(() => undefined)
  }
  releasePdfiumResources(filePath)
  window.api.dbgLog(`PDF channel cache: cancelled/released file=${filePath}`)
}

export function getPdfLiveTargetSize(display: DisplayInfo): { width: number; height: number } {
  const scaleFactor = Math.max(1, display.scaleFactor || 1)
  return {
    width: Math.max(64, Math.round(display.bounds.width * scaleFactor)),
    height: Math.max(64, Math.round(display.bounds.height * scaleFactor))
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
  const generation = pdfLivePrewarmGeneration
  const fileGeneration = pdfLiveFileGenerations.get(request.filePath) || 0
  const isCancelled = (): boolean => (
    generation !== pdfLivePrewarmGeneration ||
    fileGeneration !== (pdfLiveFileGenerations.get(request.filePath) || 0)
  )

  let job: Promise<PdfLivePrewarmResult>
  const run = async (): Promise<PdfLivePrewarmResult> => {
    let loadingTask: pdfjsLib.PDFDocumentLoadingTask | null = null
    try {
      if (isCancelled()) {
        return { success: false, totalPages: 0, cachedPages: 0, error: 'cancelled' }
      }
      window.api.dbgLog(
        `PDF channel cache: BEGIN file=${request.filePath} target=${request.targetWidth}x${request.targetHeight}`
      )
      const data = await window.api.readFile(request.filePath)
      if (isCancelled()) {
        return { success: false, totalPages: 0, cachedPages: 0, error: 'cancelled' }
      }
      const pdfiumWarm = warmPdfiumDocument(
        request.filePath,
        'interactive',
        data.slice(0)
      ).catch((error) => {
        window.api.dbgLog(`PDF channel cache: PDFium warm ERROR ${String(error)}`)
        return 0
      })
      loadingTask = pdfjsLib.getDocument({ data })
      pdfLiveLoadingTasks.set(loadingTask, request.filePath)
      const document = await loadingTask.promise
      if (isCancelled()) {
        return { success: false, totalPages: 0, cachedPages: 0, error: 'cancelled' }
      }
      await pdfiumWarm
      if (isCancelled()) {
        return { success: false, totalPages: 0, cachedPages: 0, error: 'cancelled' }
      }

      const totalPages = document.numPages
      let cachedPages = 0
      for (const pageNumber of pageOrder(totalPages, request.anchorPage)) {
        if (isCancelled()) {
          return { success: false, totalPages, cachedPages, error: 'cancelled' }
        }
        const started = performance.now()
        let page: pdfjsLib.PDFPageProxy | null = null
        try {
          page = await document.getPage(pageNumber)
          if (isCancelled()) {
            return { success: false, totalPages, cachedPages, error: 'cancelled' }
          }
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
          if (isCancelled()) {
            return { success: false, totalPages, cachedPages, error: 'cancelled' }
          }
          if (!nativePath) {
            await renderPdfiumPageToCanvas({
              filePath: request.filePath,
              pageNumber,
              targetWidth: frameWidth,
              targetHeight: frameHeight,
              lane: 'interactive'
            })
            if (isCancelled()) {
              return { success: false, totalPages, cachedPages, error: 'cancelled' }
            }
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
        } finally {
          page?.cleanup()
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
      if (loadingTask) {
        pdfLiveLoadingTasks.delete(loadingTask)
        // pdfjs-dist 6 owns the worker through PDFDocumentLoadingTask. Calling
        // destroy on PDFDocumentProxy is no longer supported and used to leave
        // the worker/document alive after a seemingly successful cleanup.
        await loadingTask.destroy().catch((error) => {
          window.api.dbgLog(
            `PDF channel cache: cleanup ignored file=${request.filePath} error=${String(error)}`
          )
        })
      }
      if (pdfLivePrewarmJobs.get(request.cacheKey) === job) {
        pdfLivePrewarmJobs.delete(request.cacheKey)
        pdfLivePrewarmJobFiles.delete(request.cacheKey)
      }
    }
  }

  // A numbered-folder import may add many PDFs at once. Prepare documents in
  // order so background caching never launches a storm of PowerShell/WinRT
  // renderers that could slow the operator UI or the current live output.
  job = pdfLivePrewarmQueue.then(run, run)
  pdfLivePrewarmQueue = job.then(() => undefined, () => undefined)
  pdfLivePrewarmJobs.set(request.cacheKey, job)
  pdfLivePrewarmJobFiles.set(request.cacheKey, request.filePath)
  return job
}
