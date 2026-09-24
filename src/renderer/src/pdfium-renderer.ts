import {
  PDFiumWorkerClient,
  type PDFiumWorkerDocument
} from '@hyzyla/pdfium/worker'
import pdfiumWasmUrl from '@hyzyla/pdfium/pdfium.wasm?url'

export type PdfiumRenderLane = 'interactive' | 'background'

export interface PdfiumCanvasFrame {
  canvas: HTMLCanvasElement
  cached: boolean
  originalWidth: number
  originalHeight: number
}

interface PdfiumDocumentEntry {
  key: string
  lane: PdfiumRenderLane
  filePath: string
  signature: string
  releaseToken: string
  document: PDFiumWorkerDocument
  activeRenders: number
  renderCount: number
  evictWhenIdle: boolean
  releaseWhenIdle: boolean
  destroying: boolean
}

interface PdfiumLaneState {
  clientPromise: Promise<PDFiumWorkerClient> | null
  documents: Map<string, Promise<PdfiumDocumentEntry>>
  loadedDocuments: Map<string, PdfiumDocumentEntry>
}

interface CachedFrame {
  canvas: HTMLCanvasElement
  originalWidth: number
  originalHeight: number
}

const MAX_FRAME_CACHE_PIXELS = 24_000_000
const MAX_DOCUMENTS_PER_LANE = 2
const MAX_RENDER_HANDLES_PER_DOCUMENT = 48

const laneStates: Record<PdfiumRenderLane, PdfiumLaneState> = {
  interactive: { clientPromise: null, documents: new Map(), loadedDocuments: new Map() },
  background: { clientPromise: null, documents: new Map(), loadedDocuments: new Map() }
}

const latestDocumentKeyByPath = new Map<string, string>()
const fileReleaseGeneration = new Map<string, number>()
let allReleaseGeneration = 0
const activePdfiumCallsByPath = new Map<string, number>()
const pendingFileReleases = new Set<string>()
const pendingFileReleaseTimers = new Map<string, ReturnType<typeof setTimeout>>()
const frameCache = new Map<string, CachedFrame>()
const frameInflight: Record<PdfiumRenderLane, Map<string, Promise<PdfiumCanvasFrame>>> = {
  interactive: new Map(),
  background: new Map()
}
let frameCachePixels = 0
let wasmBinaryPromise: Promise<ArrayBuffer> | null = null
let idleWorkerTerminationTimer: ReturnType<typeof setTimeout> | null = null

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

function getAbsoluteWasmUrl(): string {
  return new URL(pdfiumWasmUrl, window.location.href).href
}

async function getWasmBinary(): Promise<ArrayBuffer> {
  if (!wasmBinaryPromise) {
    wasmBinaryPromise = fetch(getAbsoluteWasmUrl())
      .then((response) => response.arrayBuffer())
      .catch((error) => {
        wasmBinaryPromise = null
        throw error
      })
  }
  return wasmBinaryPromise
}

async function getClient(lane: PdfiumRenderLane): Promise<PDFiumWorkerClient> {
  const state = laneStates[lane]
  if (!state.clientPromise) {
    const started = performance.now()
    state.clientPromise = getWasmBinary()
      .then((wasmBinary) => PDFiumWorkerClient.spawn({ wasmBinary: wasmBinary.slice(0) }))
      .then((client) => {
        window.api.dbgLog(
          `PDFium: worker READY lane=${lane} dur=${Math.round(performance.now() - started)}ms`
        )
        return client
      })
      .catch((error) => {
        state.clientPromise = null
        throw error
      })
  }
  return state.clientPromise
}

function touchDocument(entry: PdfiumDocumentEntry): boolean {
  if (entry.destroying) return false
  const loaded = laneStates[entry.lane].loadedDocuments
  loaded.delete(entry.key)
  loaded.set(entry.key, entry)
  return true
}

function getReleaseToken(filePath: string): string {
  return `${allReleaseGeneration}:${fileReleaseGeneration.get(filePath) ?? 0}`
}

function beginPdfiumCall(filePath: string): void {
  if (idleWorkerTerminationTimer) {
    clearTimeout(idleWorkerTerminationTimer)
    idleWorkerTerminationTimer = null
  }
  const timer = pendingFileReleaseTimers.get(filePath)
  if (timer) {
    clearTimeout(timer)
    pendingFileReleaseTimers.delete(filePath)
  }
  // A new render/prewarm for the same file supersedes a deferred close. If
  // the tombstone survives after its timer is cancelled, endPdfiumCall()
  // reschedules it and destroys the document/frame that this call just made.
  pendingFileReleases.delete(filePath)
  activePdfiumCallsByPath.set(filePath, (activePdfiumCallsByPath.get(filePath) ?? 0) + 1)
}

function schedulePendingFileRelease(filePath: string): void {
  if (!pendingFileReleases.has(filePath) || pendingFileReleaseTimers.has(filePath)) return
  const timer = setTimeout(() => {
    pendingFileReleaseTimers.delete(filePath)
    if ((activePdfiumCallsByPath.get(filePath) ?? 0) > 0) return
    pendingFileReleases.delete(filePath)
    performPdfiumRelease(filePath)
  }, 0)
  pendingFileReleaseTimers.set(filePath, timer)
}

function endPdfiumCall(filePath: string): void {
  const remaining = Math.max(0, (activePdfiumCallsByPath.get(filePath) ?? 1) - 1)
  if (remaining > 0) activePdfiumCallsByPath.set(filePath, remaining)
  else activePdfiumCallsByPath.delete(filePath)
  if (remaining === 0) schedulePendingFileRelease(filePath)
  schedulePdfiumWorkerTerminationIfIdle()
}

function removeCachedFrame(key: string, zeroCanvas = false): void {
  const cached = frameCache.get(key)
  if (!cached) return
  const pixels = cached.canvas.width * cached.canvas.height
  frameCache.delete(key)
  frameCachePixels = Math.max(0, frameCachePixels - pixels)
  if (zeroCanvas) {
    cached.canvas.width = 0
    cached.canvas.height = 0
  }
}

function purgeFrameCache(prefix?: string): void {
  for (const key of Array.from(frameCache.keys())) {
    if (!prefix || key.startsWith(prefix)) removeCachedFrame(key, true)
  }
}

function destroyDocumentEntry(entry: PdfiumDocumentEntry): void {
  if (entry.destroying) return
  if (entry.activeRenders > 0) {
    entry.evictWhenIdle = true
    return
  }

  entry.destroying = true
  const state = laneStates[entry.lane]
  state.documents.delete(entry.key)
  state.loadedDocuments.delete(entry.key)
  if (entry.releaseWhenIdle) purgeFrameCache(`${entry.key}|`)
  void Promise.resolve()
    .then(() => entry.document.destroy())
    .catch((error) => {
      window.api.dbgLog(
        `PDFium: document destroy ERROR lane=${entry.lane} file=${entry.filePath} error=${String(error)}`
      )
    })
}

function evictExcessDocuments(lane: PdfiumRenderLane, keepKey: string): void {
  const loaded = laneStates[lane].loadedDocuments
  let attempts = loaded.size
  while (loaded.size > MAX_DOCUMENTS_PER_LANE && attempts > 0) {
    attempts -= 1
    const oldest = loaded.values().next().value as PdfiumDocumentEntry | undefined
    if (!oldest) break
    if (oldest.key === keepKey) {
      touchDocument(oldest)
      continue
    }
    destroyDocumentEntry(oldest)
    // A running render remains in the map until its finally block. Move it to
    // the end so another idle document can be considered for eviction.
    if (oldest.activeRenders > 0) touchDocument(oldest)
  }
}

function finishDocumentRender(entry: PdfiumDocumentEntry): void {
  entry.activeRenders = Math.max(0, entry.activeRenders - 1)
  if (
    entry.activeRenders === 0 &&
    (entry.evictWhenIdle || entry.renderCount >= MAX_RENDER_HANDLES_PER_DOCUMENT)
  ) {
    destroyDocumentEntry(entry)
  }
}

async function acquireDocument(
  filePath: string,
  lane: PdfiumRenderLane,
  sourceData?: ArrayBuffer
): Promise<PdfiumDocumentEntry> {
  // A resolved load promise can be evicted before this continuation runs when
  // the operator switches through several PDFs very quickly. Retry with a new
  // document instead of touching a handle that is already being destroyed.
  for (let attempt = 0; attempt < 2; attempt++) {
    const entry = await getDocument(filePath, lane, sourceData)
    if (entry.destroying) continue
    // JavaScript cannot interleave eviction between this check and increment.
    // From this point destroyDocumentEntry only marks evictWhenIdle.
    entry.activeRenders += 1
    touchDocument(entry)
    return entry
  }
  throw new Error(`PDFium document could not be acquired: ${filePath}`)
}

async function getDocument(
  filePath: string,
  lane: PdfiumRenderLane,
  sourceData?: ArrayBuffer
): Promise<PdfiumDocumentEntry> {
  const releaseToken = getReleaseToken(filePath)
  let data = sourceData
  let signature: string

  if (data) {
    signature = getPdfSignature(data)
  } else {
    const latestKey = latestDocumentKeyByPath.get(filePath)
    if (latestKey) {
      const existing = laneStates[lane].documents.get(latestKey)
      if (existing) return existing
    }
    const loadedData = await window.api.readFile(filePath)
    if (getReleaseToken(filePath) !== releaseToken) {
      throw new Error(`PDFium document load was released: ${filePath}`)
    }
    data = loadedData
    signature = getPdfSignature(loadedData)
  }

  const documentKey = `${filePath}|${signature}|${releaseToken}`
  latestDocumentKeyByPath.set(filePath, documentKey)

  const state = laneStates[lane]
  const existing = state.documents.get(documentKey)
  if (existing) return existing

  const started = performance.now()
  const loadPromise = (async (): Promise<PdfiumDocumentEntry> => {
    const client = await getClient(lane)
    // The worker transfers this buffer, so always give it a private copy.
    const bytes = new Uint8Array(data!.slice(0))
    const document = await client.loadDocument(bytes)
    const pages = await document.getPageCount()
    if (getReleaseToken(filePath) !== releaseToken) {
      await document.destroy().catch(() => undefined)
      throw new Error(`PDFium document load was released: ${filePath}`)
    }
    window.api.dbgLog(
      `PDFium: document READY lane=${lane} pages=${pages} dur=${Math.round(performance.now() - started)}ms file=${filePath}`
    )
    const entry: PdfiumDocumentEntry = {
      key: documentKey,
      lane,
      filePath,
      signature,
      releaseToken,
      document,
      activeRenders: 0,
      renderCount: 0,
      evictWhenIdle: false,
      releaseWhenIdle: false,
      destroying: false
    }
    state.loadedDocuments.set(documentKey, entry)
    evictExcessDocuments(lane, documentKey)
    return entry
  })().catch((error) => {
    if (state.documents.get(documentKey) === loadPromise) {
      state.documents.delete(documentKey)
    }
    throw error
  })

  state.documents.set(documentKey, loadPromise)
  return loadPromise
}

function frameKey(
  documentEntry: PdfiumDocumentEntry,
  pageNumber: number,
  targetWidth: number,
  targetHeight: number
): string {
  return `${documentEntry.key}|${pageNumber}|${targetWidth}x${targetHeight}`
}

function readCachedFrame(key: string): PdfiumCanvasFrame | null {
  const cached = frameCache.get(key)
  if (!cached) return null
  frameCache.delete(key)
  frameCache.set(key, cached)
  return { ...cached, cached: true }
}

function cacheFrame(key: string, frame: CachedFrame): void {
  const pixels = frame.canvas.width * frame.canvas.height
  if (pixels > MAX_FRAME_CACHE_PIXELS) return

  const previous = frameCache.get(key)
  if (previous) {
    frameCachePixels -= previous.canvas.width * previous.canvas.height
    frameCache.delete(key)
  }

  while (frameCache.size > 0 && frameCachePixels + pixels > MAX_FRAME_CACHE_PIXELS) {
    const oldestKey = frameCache.keys().next().value as string | undefined
    if (!oldestKey) break
    removeCachedFrame(oldestKey)
  }

  frameCache.set(key, frame)
  frameCachePixels += pixels
}

export async function warmPdfiumDocument(
  filePath: string,
  lane: PdfiumRenderLane,
  sourceData?: ArrayBuffer
): Promise<number> {
  beginPdfiumCall(filePath)
  try {
    const entry = await acquireDocument(filePath, lane, sourceData)
    try {
      return await entry.document.getPageCount()
    } finally {
      finishDocumentRender(entry)
    }
  } finally {
    endPdfiumCall(filePath)
  }
}

export function fitPdfPageInsideRenderBox(
  originalWidth: number,
  originalHeight: number,
  targetWidth: number,
  targetHeight: number
): { width: number; height: number } {
  const safeOriginalWidth = Math.max(1, originalWidth)
  const safeOriginalHeight = Math.max(1, originalHeight)
  const safeTargetWidth = Math.max(1, Math.round(targetWidth))
  const safeTargetHeight = Math.max(1, Math.round(targetHeight))
  const scale = Math.min(
    safeTargetWidth / safeOriginalWidth,
    safeTargetHeight / safeOriginalHeight
  )
  return {
    width: Math.max(1, Math.round(safeOriginalWidth * scale)),
    height: Math.max(1, Math.round(safeOriginalHeight * scale))
  }
}

export async function renderPdfiumPageToCanvas(options: {
  filePath: string
  pageNumber: number
  targetWidth: number
  targetHeight: number
  lane: PdfiumRenderLane
  sourceData?: ArrayBuffer
}): Promise<PdfiumCanvasFrame> {
  const targetWidth = Math.max(1, Math.round(options.targetWidth))
  const targetHeight = Math.max(1, Math.round(options.targetHeight))
  beginPdfiumCall(options.filePath)
  try {
    const documentEntry = await acquireDocument(
      options.filePath,
      options.lane,
      options.sourceData
    )
    try {
      const key = frameKey(documentEntry, options.pageNumber, targetWidth, targetHeight)
      const cached = readCachedFrame(key)
      if (cached) {
        window.api.dbgLog(
          `PDFium: frame cache HIT lane=${options.lane} page=${options.pageNumber} size=${targetWidth}x${targetHeight}`
        )
        return cached
      }

      const existing = frameInflight[options.lane].get(key)
      if (existing) {
        window.api.dbgLog(
          `PDFium: frame JOIN lane=${options.lane} page=${options.pageNumber} size=${targetWidth}x${targetHeight}`
        )
        return await existing
      }

      const started = performance.now()
      let job: Promise<PdfiumCanvasFrame>
      job = (async (): Promise<PdfiumCanvasFrame> => {
        documentEntry.renderCount += 1
        // page.render() closes the native page handle. Always request a fresh one.
        const page = await documentEntry.document.getPage(options.pageNumber - 1)
        // PDFium treats explicit width and height as independent dimensions.
        // Passing the rectangular speaker/info panel size therefore stretches
        // portrait and non-16:9 pages before CSS object-contain can see them.
        // Fit the page into the requested render box while retaining its own
        // aspect ratio. Existing live-view callers already request a fitted
        // box, so their output dimensions remain effectively unchanged.
        const originalSize = await page.getOriginalSize()
        const renderSize = fitPdfPageInsideRenderBox(
          originalSize.originalWidth,
          originalSize.originalHeight,
          targetWidth,
          targetHeight
        )
        const result = await page.render({
          width: renderSize.width,
          height: renderSize.height,
          renderFormFields: true,
          transparent: false
        })
        const canvas = document.createElement('canvas')
        canvas.width = result.width
        canvas.height = result.height
        // PDFium already produced CPU pixels. Avoid uploading this raster cache
        // only to synchronously read it back for thumbnails when the GPU stalls.
        // The visible output canvas retains accelerated composition.
        const context = canvas.getContext('2d', { willReadFrequently: true })
        if (!context) throw new Error('Canvas 2D context is unavailable')
        const imageData = new ImageData(result.width, result.height)
        imageData.data.set(result.data)
        context.putImageData(imageData, 0, 0)

        const frame: CachedFrame = {
          canvas,
          originalWidth: result.originalWidth,
          originalHeight: result.originalHeight
        }
        // A close/file-switch can happen while PDFium is rendering. Return the
        // completed frame to the stale caller so its promise settles, but never
        // put released pixels back into the global cache.
        if (
          !documentEntry.releaseWhenIdle &&
          getReleaseToken(documentEntry.filePath) === documentEntry.releaseToken
        ) {
          cacheFrame(key, frame)
        }
        window.api.dbgLog(
          `PDFium: frame READY lane=${options.lane} page=${options.pageNumber} size=${result.width}x${result.height} dur=${Math.round(performance.now() - started)}ms`
        )
        return { ...frame, cached: false }
      })()

      frameInflight[options.lane].set(key, job)
      try {
        return await job
      } finally {
        if (frameInflight[options.lane].get(key) === job) {
          frameInflight[options.lane].delete(key)
        }
      }
    } finally {
      finishDocumentRender(documentEntry)
    }
  } finally {
    endPdfiumCall(options.filePath)
  }
}

/**
 * Release every PDFium resource owned by one presentation file. Running
 * renders are allowed to finish, then their document and any late frame are
 * discarded. Other prepared channel files remain untouched.
 */
function performPdfiumRelease(filePath?: string): void {
  if (filePath) {
    fileReleaseGeneration.set(filePath, (fileReleaseGeneration.get(filePath) ?? 0) + 1)
    latestDocumentKeyByPath.delete(filePath)
    purgeFrameCache(`${filePath}|`)
  } else {
    allReleaseGeneration += 1
    fileReleaseGeneration.clear()
    latestDocumentKeyByPath.clear()
    purgeFrameCache()
    for (const lane of Object.keys(frameInflight) as PdfiumRenderLane[]) {
      frameInflight[lane].clear()
    }
  }

  for (const lane of Object.keys(laneStates) as PdfiumRenderLane[]) {
    const state = laneStates[lane]
    for (const entry of Array.from(state.loadedDocuments.values())) {
      if (filePath && entry.filePath !== filePath) continue
      entry.releaseWhenIdle = true
      entry.evictWhenIdle = true
      if (entry.activeRenders === 0) destroyDocumentEntry(entry)
    }
  }
  window.api.dbgLog(`PDFium: release requested file=${filePath ?? 'all'}`)
  schedulePdfiumWorkerTerminationIfIdle()
}

function hasLivePdfiumResources(): boolean {
  if (activePdfiumCallsByPath.size > 0 || frameCache.size > 0) return true
  for (const lane of Object.keys(laneStates) as PdfiumRenderLane[]) {
    const state = laneStates[lane]
    if (
      state.documents.size > 0 ||
      state.loadedDocuments.size > 0 ||
      frameInflight[lane].size > 0
    ) {
      return true
    }
  }
  return false
}

function schedulePdfiumWorkerTerminationIfIdle(): void {
  if (idleWorkerTerminationTimer) return
  idleWorkerTerminationTimer = setTimeout(() => {
    idleWorkerTerminationTimer = null
    if (hasLivePdfiumResources()) return
    terminatePdfiumWorkers()
  }, 0)
}

function terminatePdfiumWorkers(): void {
  if (idleWorkerTerminationTimer) {
    clearTimeout(idleWorkerTerminationTimer)
    idleWorkerTerminationTimer = null
  }
  for (const lane of Object.keys(laneStates) as PdfiumRenderLane[]) {
    const state = laneStates[lane]
    const clientPromise = state.clientPromise
    state.clientPromise = null
    state.documents.clear()
    if (clientPromise) {
      void clientPromise
        .then((client) => client.destroy())
        .catch((error) => {
          window.api.dbgLog(`PDFium: worker destroy ignored lane=${lane} error=${String(error)}`)
        })
    }
  }
  // The next PDF reloads the small WASM binary and starts fresh workers. A
  // true output close favors returning memory to Windows over a warm decoder.
  wasmBinaryPromise = null
  window.api.dbgLog('PDFium: all workers terminated after output close')
}

export function releasePdfiumResources(filePath?: string): void {
  if (filePath) {
    pendingFileReleases.add(filePath)
    schedulePendingFileRelease(filePath)
    return
  }

  for (const timer of pendingFileReleaseTimers.values()) clearTimeout(timer)
  pendingFileReleaseTimers.clear()
  pendingFileReleases.clear()
  performPdfiumRelease()
  terminatePdfiumWorkers()
}

window.addEventListener('beforeunload', () => {
  for (const lane of Object.keys(laneStates) as PdfiumRenderLane[]) {
    const state = laneStates[lane]
    for (const entry of state.loadedDocuments.values()) {
      entry.evictWhenIdle = true
      if (entry.activeRenders === 0) destroyDocumentEntry(entry)
    }
    if (state.clientPromise) {
      void state.clientPromise.then((client) => client.destroy()).catch(() => undefined)
      state.clientPromise = null
    }
  }
})
