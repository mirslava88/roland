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
  document: PDFiumWorkerDocument
  activeRenders: number
  renderCount: number
  evictWhenIdle: boolean
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
const frameCache = new Map<string, CachedFrame>()
const frameInflight: Record<PdfiumRenderLane, Map<string, Promise<PdfiumCanvasFrame>>> = {
  interactive: new Map(),
  background: new Map()
}
let frameCachePixels = 0
let wasmBinaryPromise: Promise<ArrayBuffer> | null = null

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
  void entry.document.destroy().catch((error) => {
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
  let data = sourceData
  let signature: string
  let documentKey: string

  if (data) {
    signature = getPdfSignature(data)
    documentKey = `${filePath}|${signature}`
    latestDocumentKeyByPath.set(filePath, documentKey)
  } else {
    const latestKey = latestDocumentKeyByPath.get(filePath)
    if (latestKey) {
      const existing = laneStates[lane].documents.get(latestKey)
      if (existing) return existing
    }
    const loadedData = await window.api.readFile(filePath)
    data = loadedData
    signature = getPdfSignature(loadedData)
    documentKey = `${filePath}|${signature}`
    latestDocumentKeyByPath.set(filePath, documentKey)
  }

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
    window.api.dbgLog(
      `PDFium: document READY lane=${lane} pages=${pages} dur=${Math.round(performance.now() - started)}ms file=${filePath}`
    )
    const entry: PdfiumDocumentEntry = {
      key: documentKey,
      lane,
      filePath,
      signature,
      document,
      activeRenders: 0,
      renderCount: 0,
      evictWhenIdle: false,
      destroying: false
    }
    state.loadedDocuments.set(documentKey, entry)
    evictExcessDocuments(lane, documentKey)
    return entry
  })().catch((error) => {
    state.documents.delete(documentKey)
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
  return `${documentEntry.filePath}|${documentEntry.signature}|${pageNumber}|${targetWidth}x${targetHeight}`
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
    const oldest = frameCache.get(oldestKey)
    frameCache.delete(oldestKey)
    if (oldest) frameCachePixels -= oldest.canvas.width * oldest.canvas.height
  }

  frameCache.set(key, frame)
  frameCachePixels += pixels
}

export async function warmPdfiumDocument(
  filePath: string,
  lane: PdfiumRenderLane,
  sourceData?: ArrayBuffer
): Promise<number> {
  const entry = await acquireDocument(filePath, lane, sourceData)
  try {
    return await entry.document.getPageCount()
  } finally {
    finishDocumentRender(entry)
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
      const result = await page.render({
        width: targetWidth,
        height: targetHeight,
        renderFormFields: true,
        transparent: false
      })
      const canvas = document.createElement('canvas')
      canvas.width = result.width
      canvas.height = result.height
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Canvas 2D context is unavailable')
      const imageData = new ImageData(result.width, result.height)
      imageData.data.set(result.data)
      context.putImageData(imageData, 0, 0)

      const frame: CachedFrame = {
        canvas,
        originalWidth: result.originalWidth,
        originalHeight: result.originalHeight
      }
      cacheFrame(key, frame)
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
