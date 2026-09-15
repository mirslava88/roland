import { mkdir, open, readFile, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'

export async function readPptxCacheImages(directory: string): Promise<string[] | null> {
  try {
    const count = Number((await readFile(join(directory, 'complete.txt'), 'utf8')).trim())
    if (!Number.isInteger(count) || count < 1) return null
    const images: string[] = []
    for (let slide = 1; slide <= count; slide++) {
      const path = join(directory, `slide_${slide}.png`)
      const file = await open(path, 'r')
      try {
        const header = Buffer.alloc(24)
        const { bytesRead } = await file.read(header, 0, 24, 0)
        if (bytesRead !== 24 || !header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
          header.toString('ascii', 12, 16) !== 'IHDR' || !header.readUInt32BE(16) || !header.readUInt32BE(20)) return null
        const info = await file.stat()
        if (info.size < 45) return null
        const tail = Buffer.alloc(12)
        await file.read(tail, 0, 12, info.size - 12)
        if (!tail.equals(Buffer.from([0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]))) return null
      } finally { await file.close() }
      images.push(path)
    }
    return images
  } catch { return null }
}

export interface PptxCacheProgress {
  filePath: string
  slide: number
  slideCount: number
  slidePath: string
  thumbnailPath: string
  aspectRatio: number
}

export interface PptxCacheResult {
  slides: string[]
  thumbnails: string[]
  slideCount: number
  aspectRatio: number
}

interface ExportEvent {
  event?: string
  slide?: number
  slideCount?: number
  slideWidth?: number
  slideHeight?: number
  path?: string
}

interface Dependencies {
  directory(path: string, size: number, mtime: number, width: number, height: number): string
  readCache(directory: string): Promise<string[] | null>
  export(path: string, directory: string, width: number, height: number,
    onEvent: (event: ExportEvent) => void, signal?: AbortSignal): Promise<ExportEvent & { ok: boolean; error?: string; bulkExport?: boolean }>
  prepare(path: string): Promise<{ ok: boolean; slideWidth?: number; slideHeight?: number; error?: string }>
  resize(path: string): Promise<Uint8Array>
  enqueue<T>(key: string, work: () => Promise<T>): Promise<T>
  release(path: string): Promise<{ success: boolean; error?: string }>
  log(message: string): void
}

function aspectRatio(value: { slideWidth?: number; slideHeight?: number }): number | null {
  const ratio = Number(value.slideWidth) / Number(value.slideHeight)
  return Number.isFinite(ratio) && ratio >= 0.2 && ratio <= 5 ? ratio : null
}

// All callers (channel, navigator and full-frame consumer) share one export.
// Thumbnail work holds only one decoded image at a time, never an entire deck.
export function createPptxCache(deps: Dependencies) {
  let stopped = false
  const inflight = new Map<string, {
    controller: AbortController
    promise: Promise<PptxCacheResult>
    listeners: Set<(progress: PptxCacheProgress) => void>
    progress: Map<number, PptxCacheProgress>
  }>()

  const preparePptxCache = async function (
    filePath: string, width = 1920, height = 1080,
    onProgress?: (progress: PptxCacheProgress) => void
  ): Promise<PptxCacheResult> {
    if (stopped) throw new Error('PPTX cache is shutting down')
    const source = await stat(filePath)
    if (stopped) throw new Error('PPTX cache is shutting down')
    const directory = deps.directory(filePath, source.size, source.mtimeMs, width, height)
    const existing = inflight.get(directory)
    if (existing) {
      if (onProgress) {
        existing.listeners.add(onProgress)
        for (const progress of existing.progress.values()) {
          try { onProgress(progress) } catch { /* Ignore a closed subscriber. */ }
        }
      }
      return existing.promise
    }
    const controller = new AbortController()
    const checkCancellation = (): void => controller.signal.throwIfAborted()
    const listeners = new Set<(progress: PptxCacheProgress) => void>()
    if (onProgress) listeners.add(onProgress)
    const progressFrames = new Map<number, PptxCacheProgress>()
    const notify = (progress: PptxCacheProgress): void => {
      if (controller.signal.aborted) return
      progressFrames.set(progress.slide, progress)
      for (const listener of listeners) {
        try { listener(progress) } catch { /* A closed renderer must not fail the export. */ }
      }
    }
    const promise = deps.enqueue(`cache:${directory}`, async () => {
      checkCancellation()
      const started = Date.now()
      let touchedPowerPoint = false
      let nativeCleaned = false
      let thumbnailQueue = Promise.resolve()
      const thumbnailDir = join(directory, 'thumbnails')
      const thumbnailJobs = new Map<number, Promise<string>>()
      const makeThumbnail = (slide: number, slidePath: string): Promise<string> => {
        const prior = thumbnailJobs.get(slide)
        if (prior) return prior
        const path = join(thumbnailDir, `slide_${slide}.png`)
        const job = thumbnailQueue.then(async () => {
          checkCancellation()
          await mkdir(thumbnailDir, { recursive: true })
          const bytes = await deps.resize(slidePath)
          checkCancellation()
          if (!bytes.length) throw new Error(`Empty thumbnail for slide ${slide}`)
          await writeFile(path, bytes)
          return path
        })
        thumbnailQueue = job.then(() => undefined)
        // Progress callbacks cannot await this job; attach a handler immediately.
        void thumbnailQueue.catch(() => undefined)
        void job.catch(() => undefined)
        thumbnailJobs.set(slide, job)
        return job
      }
      try {
        let slides = await deps.readCache(directory)
        checkCancellation()
        let ratio: number | null = null
        if (slides) {
          try {
            const metadata = JSON.parse(await readFile(join(directory, 'metadata.json'), 'utf8'))
            if (metadata.version === 1 && metadata.slideCount === slides.length &&
              metadata.width === width && metadata.height === height &&
              Number.isFinite(metadata.aspectRatio) && metadata.aspectRatio >= 0.2 && metadata.aspectRatio <= 5) {
              ratio = metadata.aspectRatio
            }
          } catch { /* Old caches need a one-time metadata upgrade, not a new export. */ }
          if (ratio !== null) deps.log(`cache hit count=${slides.length}`)
        }
        if (!slides) {
          checkCancellation()
          // Retire only certificates, never the source or another export job.
          // Old metadata must not bless a failed replacement export/cleanup.
          await rm(join(directory, 'metadata.json'), { force: true })
          await rm(join(thumbnailDir, 'complete.txt'), { force: true })
          checkCancellation()
          touchedPowerPoint = true
          const result = await deps.export(filePath, directory, width, height, (event) => {
            if (controller.signal.aborted) return
            const eventRatio = aspectRatio(event)
            if (event.event !== 'slide-exported' || !event.path || !eventRatio ||
              !Number.isInteger(event.slide) || !Number.isInteger(event.slideCount) ||
              event.slide! < 1 || event.slide! > event.slideCount!) return
            // Only accept the exact image belonging to this export directory.
            if (event.path !== join(directory, `slide_${event.slide}.png`)) return
            void makeThumbnail(event.slide!, event.path).then((thumbnailPath) => notify({
              filePath, slide: event.slide!, slideCount: event.slideCount!,
              slidePath: event.path!, thumbnailPath, aspectRatio: eventRatio
            })).catch(() => undefined)
          }, controller.signal)
          checkCancellation()
          // Do not reuse progress thumbnails after the daemon's bulk fallback:
          // its replacement PNGs may differ from the partial individual export.
          if (result.bulkExport) {
            await thumbnailQueue.catch(() => undefined)
            thumbnailJobs.clear()
            thumbnailQueue = Promise.resolve()
          } else {
            await thumbnailQueue
          }
          if (!result.ok) throw new Error(result.error || 'PowerPoint slide export failed')
          ratio = aspectRatio(result)
          slides = await deps.readCache(directory)
          if (!slides) throw new Error('Incomplete full-slide export')
        }
        if (ratio === null) {
          checkCancellation()
          touchedPowerPoint = true
          const metadata = await deps.prepare(filePath)
          checkCancellation()
          if (!metadata.ok) throw new Error(metadata.error || 'Could not read slide dimensions')
          ratio = aspectRatio(metadata)
          if (ratio === null) throw new Error('Invalid PowerPoint slide dimensions')
        }
        // Existing small frames are reusable only as a complete set.
        let thumbnails = await deps.readCache(thumbnailDir)
        checkCancellation()
        if (!thumbnails || thumbnails.length !== slides.length) {
          thumbnails = []
          for (let index = 0; index < slides.length; index++) {
            const path = await makeThumbnail(index + 1, slides[index])
            thumbnails.push(path)
            notify({ filePath, slide: index + 1, slideCount: slides.length,
              slidePath: slides[index], thumbnailPath: path, aspectRatio: ratio })
          }
          checkCancellation()
          await writeFile(join(thumbnailDir, 'complete.txt'), String(slides.length))
        }
        const current = await stat(filePath)
        if (current.size !== source.size || current.mtimeMs !== source.mtimeMs) {
          throw new Error('Presentation changed during cache preparation; retry')
        }
        if (touchedPowerPoint) {
          const released = await deps.release(filePath)
          if (!released.success) throw new Error(released.error || 'PowerPoint resources were not released')
          nativeCleaned = true
        }
        // Metadata certifies both completeness AND successful native cleanup.
        checkCancellation()
        await writeFile(join(directory, 'metadata.json'), JSON.stringify({
          version: 1, width, height, slideCount: slides.length, aspectRatio: ratio
        }))
        deps.log(`ready count=${slides.length} dur=${Date.now() - started}ms native=${touchedPowerPoint}`)
        return { slides, thumbnails, slideCount: slides.length, aspectRatio: ratio }
      } finally {
        // Pending image work must finish before cleanup/retry touches its files.
        await thumbnailQueue.catch(() => undefined)
        if (touchedPowerPoint && !nativeCleaned) {
          const released = await deps.release(filePath)
          if (!released.success) throw new Error(released.error || 'PowerPoint resources were not released')
        }
      }
    })
    inflight.set(directory, { promise, listeners, progress: progressFrames, controller })
    try { return await promise } finally { inflight.delete(directory) }
  }
  return Object.assign(preparePptxCache, {
    async stop(): Promise<void> {
      stopped = true
      const jobs = [...inflight.values()]
      for (const job of jobs) job.controller.abort()
      // An active COM batch and thumbnail write must drain before disk purge.
      await Promise.allSettled(jobs.map((job) => job.promise))
    }
  })
}
