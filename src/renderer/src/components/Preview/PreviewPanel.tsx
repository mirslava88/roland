import { useEffect, useRef, useCallback, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  captureSourceIdentity,
  DEFAULT_BROADCAST_TITLES_OUTPUT,
  useAppStore,
  ChannelState,
  ChannelId,
  resetPptxNavState,
  awaitPptxGotoChainIdle
} from '../../stores/useAppStore'
import { mediaUrl } from '../../media'
import { CaptureThumbnail } from '../Capture/CaptureThumbnail'
import { BroadcastTitlesOverlay } from '../BroadcastTitles/BroadcastTitlesOverlay'
import {
  beginNavigationTransition,
  drainNavigationTransition,
  pendingNavigationCount,
  finishNavigationTransition
} from '../../navigation-transition'
import * as pdfjsLib from 'pdfjs-dist'
import {
  getPdfLiveTargetSize,
  makePdfLiveCacheKey,
  type PdfLivePrewarmRequest
} from '../../pdf-live-cache'
import { acquireOutputTransition } from '../../output-transition-lock'
import { DEFAULT_CONTENT_ZOOM } from '../../../../shared/content-zoom'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url
).toString()

const EXT_TYPE_MAP: Record<string, FileEntry['type']> = {}
;['.pptx', '.ppt'].forEach((e) => (EXT_TYPE_MAP[e] = 'presentation'))
;['.pdf'].forEach((e) => (EXT_TYPE_MAP[e] = 'pdf'))
;['.mp4', '.mov', '.avi', '.webm', '.mkv'].forEach((e) => (EXT_TYPE_MAP[e] = 'video'))
;['.doc', '.docx', '.xls', '.xlsx', '.txt', '.rtf', '.odt', '.ods',
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.tif', '.svg',
  '.mp3', '.wav', '.ogg', '.aac', '.m4a', '.flac', '.wma'].forEach((e) => (EXT_TYPE_MAP[e] = 'other'))

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.tif', '.svg'])
const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.aac', '.m4a', '.flac', '.wma'])
const OFFICE_ZOOM_EXT = new Set(['.doc', '.docx', '.rtf', '.odt', '.xls', '.xlsx', '.ods'])

interface AdHocTakeOptions {
  channel: ChannelState
  liveChannel: ChannelId | null
  videoAutoplay?: boolean
  videoLoop?: boolean
}

function supportsContentZoom(file?: FileEntry | null): boolean {
  return file?.type === 'presentation' ||
    file?.type === 'pdf' ||
    (file?.type === 'capture' && file.capture?.captureKind === 'desktop') ||
    (file?.type === 'other' && OFFICE_ZOOM_EXT.has(file.extension.toLowerCase()))
}

function desktopWindowSourceKey(file?: FileEntry | null): string | undefined {
  const capture = file?.type === 'capture' ? file.capture : undefined
  const isWindow = capture?.captureKind === 'desktop' && (
    capture.desktopSourceType === 'window' ||
    (!capture.desktopSourceType && capture.desktopSourceId?.startsWith('window:'))
  )
  return isWindow ? (capture.desktopSourceKey || capture.desktopSourceId) : undefined
}

// Read an image file (PNG/JPEG) from disk via main process and convert to
// base64 dataUrl for embedding into overlay. Used for PPTX freeze-frame
// (pre-rendered slides via generatePptxSlides).
async function imageFileToDataUrl(filePath: string): Promise<string | null> {
  try {
    const ab = await window.api.readFile(filePath)
    const bytes = new Uint8Array(ab)
    let binary = ''
    const chunkSize = 0x8000
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(
        null,
        Array.from(bytes.subarray(i, i + chunkSize))
      )
    }
    const base64 = btoa(binary)
    const lower = filePath.toLowerCase()
    const mime = lower.endsWith('.jpg') || lower.endsWith('.jpeg') ? 'image/jpeg' : 'image/png'
    return `data:${mime};base64,${base64}`
  } catch {
    return null
  }
}

function nativeFileToEntry(filePath: string): FileEntry | null {
  const parts = filePath.replace(/\\/g, '/').split('/')
  const fullName = parts.pop() || ''
  const dotIdx = fullName.lastIndexOf('.')
  const ext = dotIdx >= 0 ? fullName.substring(dotIdx).toLowerCase() : ''
  const name = dotIdx >= 0 ? fullName.substring(0, dotIdx) : fullName
  const type = EXT_TYPE_MAP[ext]
  if (!type) return null
  return {
    id: `${fullName}-${Date.now()}`,
    name,
    path: filePath,
    type,
    extension: ext,
    size: 0,
    isImage: IMAGE_EXT.has(ext),
    isAudio: AUDIO_EXT.has(ext)
  }
}

type PptxCacheResult = { success: boolean; slideCount: number; error?: string }
type ChannelCacheStatus = 'loading' | 'ready' | 'error'

// One background preparation job per physical PPTX. The main process also
// serializes PowerPoint exports, while this renderer-side map prevents the
// same deck from being requested by several channel cards at once.
const pptxChannelCacheJobs = new Map<string, Promise<PptxCacheResult>>()
let pptxChannelCacheTail: Promise<void> = Promise.resolve()

function isPptxStillAssigned(filePath: string): boolean {
  const state = useAppStore.getState()
  return state.channelIds.some((id) => (
    state.channels[id]?.file?.type === 'presentation' &&
    state.channels[id]?.file?.path === filePath
  ))
}

function applyPptxSlideCount(filePath: string, slideCount: number): void {
  if (slideCount < 1) return
  const state = useAppStore.getState()
  let changed = false
  const channels = { ...state.channels }
  for (const [channelId, channel] of Object.entries(channels)) {
    if (channel.file?.type !== 'presentation' || channel.file.path !== filePath) continue
    if (channel.totalSlides === slideCount) continue
    channels[channelId] = { ...channel, totalSlides: slideCount }
    changed = true
  }
  if (changed) useAppStore.setState({ channels })
}

function ensurePptxChannelCache(filePath: string): Promise<PptxCacheResult> {
  const existing = pptxChannelCacheJobs.get(filePath)
  if (existing) return existing

  let job: Promise<PptxCacheResult>
  const run = async (): Promise<PptxCacheResult> => {
    window.api.dbgLog(`PPTX channel cache: BEGIN file=${filePath}`)
    try {
      // Serialize the complete prepare/export/release pipeline. Serializing
      // only daemon commands used to open every queued deck before the first
      // one reached cleanup, producing a large avoidable POWERPNT memory peak.
      if (!isPptxStillAssigned(filePath)) {
        return { success: false, slideCount: 0, error: 'Presentation was removed from channels' }
      }

      const prepared = await window.api.preparePowerPoint(filePath)
      if (!prepared.success) {
        throw new Error(prepared.error || 'PowerPoint did not prepare the presentation')
      }
      if (!isPptxStillAssigned(filePath)) {
        return { success: false, slideCount: 0, error: 'Presentation was removed during preparation' }
      }
      if (prepared.aspectRatio && Number.isFinite(prepared.aspectRatio)) {
        const aspectState = useAppStore.getState()
        useAppStore.setState({
          pptxAspectRatios: {
            ...aspectState.pptxAspectRatios,
            [filePath]: prepared.aspectRatio
          }
        })
        window.api.dbgLog(
          `PPTX channel cache: ASPECT file=${filePath} ratio=${prepared.aspectRatio.toFixed(6)}`
        )
      }
      if (prepared.slideCount) applyPptxSlideCount(filePath, prepared.slideCount)

      const stateAfterPrepare = useAppStore.getState()
      const cachedSlides = stateAfterPrepare.pptxSlidesMap[filePath]
      if (cachedSlides?.length) {
        if (!stateAfterPrepare.pptxThumbnailsMap[filePath]?.length) {
          useAppStore.setState({
            pptxThumbnailsMap: { ...stateAfterPrepare.pptxThumbnailsMap, [filePath]: cachedSlides }
          })
        }
        const slideCount = prepared.slideCount || cachedSlides.length
        applyPptxSlideCount(filePath, slideCount)
        window.api.dbgLog(`PPTX channel cache: READY native=true file=${filePath} slides=${slideCount}`)
        return { success: true, slideCount }
      }

      // With the native deck already open, generate the lightweight channel
      // preview and then the full-size frames without reopening PowerPoint.
      if (!stateAfterPrepare.pptxThumbnailsMap[filePath]?.length) {
        const thumbnails = await window.api.generatePptxThumbnails(filePath, true)
        if (!isPptxStillAssigned(filePath)) {
          return { success: false, slideCount: 0, error: 'Presentation was removed during thumbnail export' }
        }
        if (thumbnails.success && thumbnails.thumbnails?.length) {
          const thumbnailState = useAppStore.getState()
          useAppStore.setState({
            pptxThumbnailsMap: {
              ...thumbnailState.pptxThumbnailsMap,
              [filePath]: thumbnails.thumbnails
            }
          })
          applyPptxSlideCount(filePath, thumbnails.slideCount || thumbnails.thumbnails.length)
        }
      }

      if (!isPptxStillAssigned(filePath)) {
        return { success: false, slideCount: 0, error: 'Presentation was removed before slide export' }
      }
      const slides = await window.api.generatePptxSlides(filePath)
      if (!isPptxStillAssigned(filePath)) {
        return { success: false, slideCount: 0, error: 'Presentation was removed during slide export' }
      }
      if (!slides.success || !slides.slides?.length) {
        throw new Error(slides.error || 'PowerPoint не подготовил слайды')
      }
      const finalState = useAppStore.getState()
      useAppStore.setState({
        pptxSlidesMap: { ...finalState.pptxSlidesMap, [filePath]: slides.slides },
        pptxThumbnailsMap: {
          ...finalState.pptxThumbnailsMap,
          [filePath]: finalState.pptxThumbnailsMap[filePath]?.length
            ? finalState.pptxThumbnailsMap[filePath]
            : slides.slides
        }
      })
      const slideCount = slides.slideCount || slides.slides.length
      applyPptxSlideCount(filePath, slideCount)
      window.api.dbgLog(`PPTX channel cache: READY native=true file=${filePath} slides=${slideCount}`)
      return { success: true, slideCount }
    } catch (error) {
      window.api.dbgLog(`PPTX channel cache: ERROR file=${filePath} error=${String(error)}`)
      return { success: false, slideCount: 0, error: String(error) }
    } finally {
      if (pptxChannelCacheJobs.get(filePath) === job) {
        pptxChannelCacheJobs.delete(filePath)
      }
      // Channel preparation may open a full native Presentation object. The
      // exported slide/thumbnail files remain available on disk, but a deck
      // that is not currently on air must not stay loaded in POWERPNT.EXE.
      // No queued deck is open yet; the daemon itself protects an actually
      // live slideshow or an in-flight transactional TAKE.
      const released = await window.api.syncPreparedPowerPoints([]).catch((error: unknown) => ({
        success: false,
        error: String(error)
      }))
      window.api.dbgLog(
        `PPTX channel cache: native document release file=${filePath} success=${released.success} error=${released.error ?? '-'}`
      )
      if (!released.success) {
        // A rendered disk cache is not a successful *memory* cache operation
        // until the native Presentation object has actually been released.
        // Returning an error prevents the UI from claiming READY and gives a
        // later operator action a truthful chance to retry cleanup.
        return {
          success: false,
          slideCount: 0,
          error: released.error || 'PowerPoint prepared the files but did not release the native presentation'
        }
      }
    }
  }
  job = pptxChannelCacheTail.then(run, run)
  pptxChannelCacheTail = job.then(() => undefined, () => undefined)
  pptxChannelCacheJobs.set(filePath, job)
  return job
}

export function PreviewPanel(): JSX.Element {
  const {
    channels, channelIds, channelGridSize, currentChannelPage,
    liveChannel, selectedChannel, setSelectedChannel,
    setChannelFile, setChannelSlide, setChannelTotalSlides,
    setChannelVideoEndChannel, setChannelCaption,
    setPresentationWindowOpen,
    setActiveFile, setCurrentSlide, setTotalSlides, setLiveChannel,
    clearSlidePosition,
    addChannelPage, removeChannelPage, setCurrentChannelPage, setChannelGridSize,
    pptxThumbnailsMap, pptxSlidesMap, pptxCacheStatuses, setPptxCacheStatuses,
    displays, selectedDisplayId, setOverlayState,
    contentZoom, setContentZoom
  } = useAppStore()

  const takeInFlightRef = useRef<ChannelId | null>(null)
  const queuedTakeRef = useRef<ChannelId | null>(null)
  const takeGenerationRef = useRef(0)
  const activeTakeIdRef = useRef<string | null>(null)
  const clearingChannelsRef = useRef<Set<ChannelId>>(new Set())
  const cancelTakeCleanupRef = useRef<{ takeId: string; run: () => Promise<void> } | null>(null)
  const cancelOutputIntentRef = useRef<{ backdropImage: string | null; selectedDisplayId: number | null }>({
    backdropImage: null,
    selectedDisplayId: null
  })
  const hasPowerPointStartedRef = useRef(false)
  const [takeProgress, setTakeProgress] = useState<{
    channelId: ChannelId
    message: string | null
  } | null>(null)
  const [pdfCacheStatuses, setPdfCacheStatuses] = useState<Record<string, ChannelCacheStatus>>({})
  const pdfCacheRequestKeysRef = useRef<Record<string, string>>({})
  const prewarmedPdfPathsRef = useRef<Set<string>>(new Set())

  const pptxChannelPaths = [...new Set(channelIds
    .map((id) => channels[id]?.file)
    .filter((file): file is FileEntry => file?.type === 'presentation')
    .map((file) => file.path))]
  const pptxChannelPathKey = pptxChannelPaths.join('\u0000')

  const pdfChannelFiles = [...new Map(channelIds
    .map((id) => channels[id])
    .filter((channel): channel is ChannelState => channel?.file?.type === 'pdf')
    .map((channel) => [channel.file!.path, {
      filePath: channel.file!.path,
      anchorPage: Math.max(1, channel.slide || 1)
    }])).values()]
  const pdfChannelPathKey = pdfChannelFiles.map((file) => file.filePath).join('\u0000')
  const programDisplay = displays.find((display) => display.id === selectedDisplayId) ||
    displays.find((display) => !display.isPrimary) ||
    displays[0]
  const pdfTargetSize = programDisplay ? getPdfLiveTargetSize(programDisplay) : null
  const pdfTargetKey = pdfTargetSize ? `${pdfTargetSize.width}x${pdfTargetSize.height}` : 'none'

  useEffect(() => {
    window.api.sendToPresentation('content-zoom-update', contentZoom)
    const activeFile = useAppStore.getState().activeFile
    if (activeFile?.type !== 'presentation' && !(
      activeFile?.type === 'other' && OFFICE_ZOOM_EXT.has(activeFile.extension.toLowerCase())
    )) return
    const timer = setTimeout(() => {
      const state = useAppStore.getState()
      const currentFile = state.activeFile
      if (currentFile?.type === 'other' && OFFICE_ZOOM_EXT.has(currentFile.extension.toLowerCase())) {
        void window.api.setExternalFileZoom(currentFile.path, state.contentZoom).then((result) => {
          if (!result.success) window.api.dbgLog(`Office magnifier update failed: ${result.error || 'unknown error'}`)
        }).catch((error: unknown) => {
          window.api.dbgLog(`Office magnifier update failed: ${String(error)}`)
        })
        return
      }
      if (currentFile?.type !== 'presentation') return
      const target = state.displays.find((display) => display.id === state.selectedDisplayId) ||
        state.displays.find((display) => !display.isPrimary)
      if (!target) return
      void window.api.setPowerPointZoom(target.id, state.contentZoom).catch((error: unknown) => {
        window.api.dbgLog(`PowerPoint magnifier update failed: ${String(error)}`)
      })
    }, 45)
    return () => clearTimeout(timer)
  }, [contentZoom])

  useEffect(() => window.api.on('content-zoom-ready', () => {
    window.api.sendToPresentation('content-zoom-update', useAppStore.getState().contentZoom)
  }), [])

  useEffect(() => {
    const activePaths = new Set(pptxChannelPaths)
    setPptxCacheStatuses((current) => {
      const filtered = Object.fromEntries(
        Object.entries(current).filter(([path]) => activePaths.has(path))
      )
      return Object.keys(filtered).length === Object.keys(current).length ? current : filtered
    })
    for (const filePath of pptxChannelPaths) {
      if (useAppStore.getState().pptxCacheStatuses[filePath] !== undefined) continue
      setPptxCacheStatuses((current) => ({ ...current, [filePath]: 'loading' }))
      void ensurePptxChannelCache(filePath).then((result) => {
        if (!useAppStore.getState().channelIds.some((id) => (
          useAppStore.getState().channels[id]?.file?.path === filePath
        ))) return
        setPptxCacheStatuses((current) => ({
          ...current,
          [filePath]: result.success ? 'ready' : 'error'
        }))
      })
    }
  }, [pptxChannelPathKey, pptxCacheStatuses])

  useEffect(() => window.api.on('pdf-channel-cache-status', (...args: unknown[]) => {
    const update = args[0] as {
      filePath?: string
      cacheKey?: string
      status?: ChannelCacheStatus
      totalPages?: number
    }
    if (!update?.filePath || !update.cacheKey || !update.status) return
    const state = useAppStore.getState()
    const pathIsStillInChannel = state.channelIds.some((id) => (
      state.channels[id]?.file?.type === 'pdf' &&
      state.channels[id]?.file?.path === update.filePath
    ))
    if (!pathIsStillInChannel) return

    const expectedKey = pdfCacheRequestKeysRef.current[update.filePath]
    window.api.dbgLog(
      `PDF channel cache status: status=${update.status} keyMatch=${expectedKey === update.cacheKey} file=${update.filePath}`
    )
    if (update.status === 'ready') {
      // A display refresh can replace the expected key while an already-valid
      // job is finishing. The frames are still cached by file/content/size;
      // never leave the current PDF displaying an endless "Кэширование…".
      setPdfCacheStatuses((current) => {
        const next = { ...current }
        delete next[update.filePath as string]
        return next
      })
    } else {
      // Loading/error from an older display size must not overwrite the state
      // of a newer request. Only successful completion is safe across keys.
      if (expectedKey !== update.cacheKey) return
      setPdfCacheStatuses((current) => ({
        ...current,
        [update.filePath as string]: update.status as ChannelCacheStatus
      }))
    }
    if (update.status === 'ready' && Number.isFinite(update.totalPages)) {
      for (const id of state.channelIds) {
        const channel = state.channels[id]
        if (channel?.file?.type === 'pdf' && channel.file.path === update.filePath) {
          state.setChannelTotalSlides(id, Math.max(1, Math.round(update.totalPages as number)))
        }
      }
    }
  }), [])

  useEffect(() => {
    const activePaths = new Set(pdfChannelFiles.map((file) => file.filePath))
    for (const previousPath of prewarmedPdfPathsRef.current) {
      if (!activePaths.has(previousPath)) {
        window.api.sendToPresentation('release-prewarmed-pdf', { filePath: previousPath })
      }
    }
    prewarmedPdfPathsRef.current = activePaths
    pdfCacheRequestKeysRef.current = Object.fromEntries(
      Object.entries(pdfCacheRequestKeysRef.current).filter(([path]) => activePaths.has(path))
    )
    setPdfCacheStatuses((current) => Object.fromEntries(
      Object.entries(current).filter(([path]) => activePaths.has(path))
    ))
    if (!pdfTargetSize) return

    for (const file of pdfChannelFiles) {
      const cacheKey = makePdfLiveCacheKey(
        file.filePath,
        pdfTargetSize.width,
        pdfTargetSize.height
      )
      pdfCacheRequestKeysRef.current[file.filePath] = cacheKey
      setPdfCacheStatuses((current) => ({
        ...current,
        [file.filePath]: 'loading'
      }))
      const request: PdfLivePrewarmRequest = {
        filePath: file.filePath,
        cacheKey,
        targetWidth: pdfTargetSize.width,
        targetHeight: pdfTargetSize.height,
        anchorPage: file.anchorPage
      }
      window.api.sendToPresentation('prewarm-pdf', request)
    }
  }, [pdfChannelPathKey, pdfTargetKey])

  useEffect(() => () => {
    for (const filePath of prewarmedPdfPathsRef.current) {
      window.api.sendToPresentation('release-prewarmed-pdf', { filePath })
    }
    prewarmedPdfPathsRef.current.clear()
  }, [])

  useEffect(() => {
    const cancelCurrentTake = (event: Event): void => {
      if (!activeTakeIdRef.current) return
      event.preventDefault()
      const detail = (event as CustomEvent<{
        backdropImage?: string | null
        selectedDisplayId?: number | null
      }>).detail
      const state = useAppStore.getState()
      cancelOutputIntentRef.current = {
        backdropImage: detail?.backdropImage ?? state.backdropImage ?? null,
        selectedDisplayId: detail?.selectedDisplayId ?? state.selectedDisplayId ?? null
      }
      takeGenerationRef.current += 1
      queuedTakeRef.current = null
      if (activeTakeIdRef.current) {
        window.api.sendToPresentation('cancel-content-load', { takeId: activeTakeIdRef.current })
      }
    }
    window.addEventListener('cancel-active-take', cancelCurrentTake)
    return () => window.removeEventListener('cancel-active-take', cancelCurrentTake)
  }, [])

  const totalPages = Math.max(1, Math.ceil(channelIds.length / channelGridSize))
  const nextChannelGridSize = channelGridSize === 4 ? 9 : 4
  const pageStart = currentChannelPage * channelGridSize
  const pageIds = channelIds.slice(pageStart, pageStart + channelGridSize)
  const liveChannelPage = liveChannel
    ? Math.floor(channelIds.indexOf(liveChannel) / channelGridSize)
    : -1
  const currentPageIsEmpty = pageIds.every((id) => !channels[id]?.file && !channels[id]?.caption.trim())

  const clearHeavyPresentationOutput = async (
    backdropImage: string | null,
    selectedDisplayId: number | null,
    reason: string
  ): Promise<boolean> => {
    let outputWindowOpen = useAppStore.getState().isPresentationWindowOpen
    try {
      if (backdropImage && !outputWindowOpen) {
        await window.api.openPresentationWindow(selectedDisplayId ?? undefined)
        setPresentationWindowOpen(true)
        outputWindowOpen = true
      }

      // Always unmount the outgoing PDF/video/capture layer first. Loading the
      // backdrop without this clear could leave the previous decoder/document
      // alive if the image is slow or fails to paint.
      window.api.sendToPresentation('clear-active-content')

      if (!backdropImage) {
        if (outputWindowOpen) {
          await window.api.closePresentationWindow()
          setPresentationWindowOpen(false)
        }
        return true
      }

      const takeId = `clear-backdrop-${crypto.randomUUID()}`
      const backdropReady = new Promise<boolean>((resolve) => {
        let settled = false
        let timeout: ReturnType<typeof setTimeout> | null = null
        let unsubscribe = (): void => {}
        const finish = (ready: boolean): void => {
          if (settled) return
          settled = true
          if (timeout) clearTimeout(timeout)
          unsubscribe()
          resolve(ready)
        }
        unsubscribe = window.api.on('presentation-content-ready', (...args: unknown[]) => {
          const payload = args[0] as { takeId?: string; type?: string }
          if (payload?.takeId !== takeId || payload.type !== 'backdrop') return
          finish(true)
        })
        timeout = setTimeout(() => finish(false), 8_000)
      })

      window.api.sendToPresentation('load-content', {
        type: 'backdrop',
        path: backdropImage,
        name: 'Backdrop',
        takeId
      })
      const painted = await backdropReady
      if (painted) return true

      window.api.dbgLog(`${reason}: backdrop did not paint; closing empty output after heavy-content release`)
    } catch (error) {
      window.api.dbgLog(`${reason}: output cleanup failed; forcing empty output: ${String(error)}`)
    }

    // Once native PPT/Word/Excel has been released, a renderer/window error
    // must not leave a pinned cover, stale live state or the old decoder in
    // memory. This fallback is deliberately idempotent and non-throwing.
    try { window.api.sendToPresentation('clear-active-content') } catch { /* best effort */ }
    try { await window.api.closePresentationWindow() } catch { /* best effort */ }
    if (outputWindowOpen || useAppStore.getState().isPresentationWindowOpen) {
      setPresentationWindowOpen(false)
    }
    return false
  }

  const handleClear = async (ch: ChannelId): Promise<void> => {
    const requestedChannel = useAppStore.getState().channels[ch]
    if (!requestedChannel || clearingChannelsRef.current.has(ch)) return
    const requestedFilePath = requestedChannel.file?.path
    const requestedFileId = requestedChannel.file?.id
    clearingChannelsRef.current.add(ch)
    const releaseOutputTransition = await acquireOutputTransition(`clear-channel:${ch}`)
    let liveOutputReleased = false
    try {
    const currentState = useAppStore.getState()
    const channel = currentState.channels[ch]
    if (
      !channel ||
      channel.file?.path !== requestedFilePath ||
      channel.file?.id !== requestedFileId
    ) return
    const clearedFilePath = channel.file?.path
    // If this channel is live, close the presentation
    if (currentState.liveChannel === ch && channel.file) {
      if (channel.file.type === 'capture') {
        window.api.sendToPresentation('capture-audio-live', null)
      }
      const { backdropImage, selectedDisplayId } = useAppStore.getState()
      const isPptx = channel.file.type === 'presentation'
      const isExternalDoc = channel.file.type === 'other' && !channel.file.isImage && !channel.file.isAudio
      const isAudio = channel.file.type === 'other' && channel.file.isAudio
      // PPTX / Word / Excel run outside Electron. The Electron presentation
      // window is NOT topmost — when PowerPoint's slideshow exits via
      // View.Exit(), its editor window can pop above and flash on the
      // external display. We use the screen-saver-level overlay (same one
      // handleTake uses for channel switches) to reliably hide everything
      // underneath while we tear down external content.
      const hasPinnedOverlay = useAppStore.getState().overlayState.kind !== 'hidden'
      const needsCover = !isAudio || Boolean(backdropImage) || hasPinnedOverlay

      if (needsCover) {
        await window.api.showOverlay(selectedDisplayId ?? undefined)
      }

      // Close underlying content (hidden behind overlay)
      if (isPptx) {
        const closed = await window.api.powerpointCommand('close')
        if (!closed.success) {
          window.api.dbgLog(`channel clear: PowerPoint release failed ${closed.error || '-'}`)
          if (needsCover) {
            await window.api.hideOverlay()
            setOverlayState({ kind: 'hidden' })
          }
          setTakeProgress({
            channelId: ch,
            message: closed.error || 'Не удалось закрыть и освободить презентацию PowerPoint.'
          })
          await new Promise((resolve) => setTimeout(resolve, 3500))
          return
        }
        liveOutputReleased = true
      }
      if (isAudio) {
        await window.api.musicStop()
        liveOutputReleased = true
      }
      if (isExternalDoc) {
        const closed = await window.api.closeExternalFile(channel.file.path)
        if (!closed.success) {
          window.api.dbgLog(`channel clear: external window close failed ${closed.error || '-'}`)
          if (needsCover) {
            await window.api.hideOverlay()
            setOverlayState({ kind: 'hidden' })
          }
          setTakeProgress({
            channelId: ch,
            message: closed.error || 'Не удалось закрыть окно Word/Excel. Канал и эфир оставлены без изменений.'
          })
          await new Promise((resolve) => setTimeout(resolve, 3500))
          return
        }
        liveOutputReleased = true
      }

      if (!isPptx && !isExternalDoc && !isAudio) liveOutputReleased = true

      const backdropPainted = await clearHeavyPresentationOutput(
        backdropImage,
        selectedDisplayId,
        `channel clear ${ch}`
      )
      if (backdropImage && !backdropPainted) {
        window.alert('Фон не удалось подготовить. Контент закрыт, память освобождена.')
      }

      if (needsCover) {
        await window.api.hideOverlay()
        setOverlayState({ kind: 'hidden' })
      }

      await window.api.releaseBrowserFullscreen()
      setActiveFile(null)
      useAppStore.setState({ liveChannel: null })
    }
    setChannelFile(ch, null)
    // setActiveFile(null) intentionally saves the outgoing position for normal
    // channel switches. An explicit X means unload, so forget it afterwards.
    if (clearedFilePath) clearSlidePosition(clearedFilePath)
    } catch (error) {
      window.api.dbgLog(`channel clear ${ch} failed afterRelease=${liveOutputReleased}: ${String(error)}`)
      try { await window.api.hideOverlay() } catch { /* best effort */ }
      setOverlayState({ kind: 'hidden' })
      if (liveOutputReleased) {
        try { window.api.sendToPresentation('clear-active-content') } catch { /* best effort */ }
        try { await window.api.closePresentationWindow() } catch { /* best effort */ }
        setPresentationWindowOpen(false)
        try { await window.api.releaseBrowserFullscreen() } catch { /* best effort */ }
        useAppStore.setState({ activeFile: null, liveChannel: null, isPlaying: false })
        setChannelFile(ch, null)
        if (requestedFilePath) clearSlidePosition(requestedFilePath)
      }
      window.alert(
        liveOutputReleased
          ? 'Эфир закрыт, но дополнительное оформление не удалось подготовить. Тяжёлый контент выгружен из памяти.'
          : `Не удалось закрыть эфир: ${String(error)}`
      )
    } finally {
      releaseOutputTransition()
      clearingChannelsRef.current.delete(ch)
    }
  }

  const handleTake = async (ch: ChannelId): Promise<void> => {
    const freshState = useAppStore.getState()
    const file = freshState.channels[ch]?.file
    if (!file) return
    if (freshState.contentZoom.enabled) {
      freshState.setContentZoom(DEFAULT_CONTENT_ZOOM)
    }
    if (freshState.overlayState.kind === 'blocked') {
      setTakeProgress({
        channelId: ch,
        message: freshState.overlayState.reason
      })
      setTimeout(() => {
        setTakeProgress((current) => current?.channelId === ch ? null : current)
      }, 3500)
      return
    }
    if (
      file.type === 'capture' &&
      file.capture?.captureKind === 'desktop' &&
      file.capture.desktopSourceType === 'screen' &&
      file.capture.desktopDisplayId &&
      freshState.selectedDisplayId !== null &&
      file.capture.desktopDisplayId === String(freshState.selectedDisplayId)
    ) {
      setTakeProgress({
        channelId: ch,
        message: 'Этот экран выбран для эфира. Выберите другое окно или экран.'
      })
      window.api.dbgLog(
        `TAKE blocked: captured screen is output display=${file.capture.desktopDisplayId}`
      )
      setTimeout(() => {
        setTakeProgress((current) => current?.channelId === ch ? null : current)
      }, 3500)
      return
    }
    if (takeInFlightRef.current) {
      // Keep TAKE pipelines sequential (they share PowerPoint and the output
      // overlay), but never lose the operator's latest channel selection.
      queuedTakeRef.current = takeInFlightRef.current === ch ? null : ch
      return
    }

    const isSameFilePptx =
      file.type === 'presentation' &&
      freshState.activeFile?.type === 'presentation' &&
      freshState.activeFile.path === file.path
    if (freshState.activeFile?.type === 'presentation') {
      hasPowerPointStartedRef.current = true
    }
    const isUnpreparedPowerPointStart =
      file.type === 'presentation' &&
      !isSameFilePptx &&
      !hasPowerPointStartedRef.current &&
      pptxCacheStatuses[file.path] !== 'ready'
    const message = isUnpreparedPowerPointStart
      ? 'Ожидайте, презентация открывается...'
      : file.type === 'video'
        ? 'Ожидайте, видеоролик открывается...'
        : file.type === 'capture'
          ? 'Ожидайте, внешний источник подключается...'
        : null

    // Close the same-tick double-click gap before React renders disabled UI.
    // Concurrent TAKE pipelines race over PowerPoint, overlay and live state.
    takeInFlightRef.current = ch
    const takeId = crypto.randomUUID()
    const takeGeneration = ++takeGenerationRef.current
    activeTakeIdRef.current = takeId
    const releaseOutputTransition = await acquireOutputTransition(`take:${ch}:${takeId}`)

    // Top-level safety net: если handleTake бросит (daemon crash,
    // launchPowerPoint reject, capturePage fail), overlay оставался бы
    // opacity=1 чёрным НАВСЕГДА — юзер видит зависший чёрный экран без
    // способа recovery (audit F-205). Ловим, логируем, force-hide overlay.
    try {
      beginNavigationTransition()
      setTakeProgress({ channelId: ch, message })
      await doTake(ch, takeId, takeGeneration)
    } catch (err) {
      console.error('[TAKE] unhandled error, forcing overlay hide:', err)
      const cancelledCleanup = cancelTakeCleanupRef.current
      if (
        takeGenerationRef.current !== takeGeneration &&
        cancelledCleanup?.takeId === takeId
      ) {
        try { await cancelledCleanup.run() } catch { /* cleanup best effort */ }
      } else {
        try { await window.api.hideOverlay() } catch { /* last resort */ }
        setOverlayState({ kind: 'hidden' })
      }
    } finally {
      try {
        const mirrorResult = await window.api.completeProgramMirrorTransition(takeId)
        window.api.dbgLog(
          `TAKE mirror transition complete id=${takeId} ` +
          `released=${mirrorResult.released} remaining=${mirrorResult.remaining}`
        )
      } catch (error) {
        window.api.dbgLog(`TAKE mirror transition completion failed id=${takeId}: ${String(error)}`)
      }
      const finalCancelledCleanup = cancelTakeCleanupRef.current
      if (
        takeGenerationRef.current !== takeGeneration &&
        finalCancelledCleanup?.takeId === takeId
      ) {
        try {
          await finalCancelledCleanup.run()
        } catch (error) {
          window.api.dbgLog(`TAKE final cancellation cleanup failed id=${takeId}: ${String(error)}`)
        }
      }
      const queuedNavigation = finishNavigationTransition()
      if (takeInFlightRef.current === ch) {
        takeInFlightRef.current = null
        setTakeProgress((current) => current?.channelId === ch ? null : current)
      }
      if (activeTakeIdRef.current === takeId) activeTakeIdRef.current = null
      if (cancelTakeCleanupRef.current?.takeId === takeId) cancelTakeCleanupRef.current = null
      releaseOutputTransition()

      const queued = queuedTakeRef.current
      queuedTakeRef.current = null
      if (queued && useAppStore.getState().channels[queued]?.file) {
        void handleTake(queued)
      } else if (queuedNavigation.length > 0) {
        window.dispatchEvent(new CustomEvent('flush-take-navigation', {
          detail: queuedNavigation
        }))
      }
    }
  }

  const doTake = async (
    ch: ChannelId,
    takeId: string,
    takeGeneration: number,
    adHoc?: AdHocTakeOptions
  ): Promise<void> => {
    // Always read fresh state from the store (not stale closure values)
    const freshState = useAppStore.getState()
    let channel = adHoc?.channel ?? freshState.channels[ch]
    if (!channel?.file) return

    // Save previous active file before overwriting
    const prevActiveFile = freshState.activeFile

    const T0 = performance.now()
    const isTakeCancelled = (): boolean => takeGenerationRef.current !== takeGeneration
    const log = (step: string): void => {
      const ms = (performance.now() - T0).toFixed(0)
      console.log(`[TAKE ${ms}ms] ${step}`)
      // Дублируем в main stdout чтобы иметь единый timeline вместе с
      // [MAIN], [DAEMON], [R] логами при диагностике мерцаний.
      window.api.dbgLog(`TAKE +${ms}ms: ${step}`)
    }
    const clearCommittedCaptureTitleSource = (reason: string): void => {
      const state = useAppStore.getState()
      if (!state.programCaptureTitlesSourceIdentity) return
      state.setProgramCaptureTitlesSourceIdentity(null)
      log(`program capture titles cleared after ${reason}`)
    }
    let cancelCleanupPromise: Promise<void> | null = null
    const finishCancelledTake = (): Promise<void> => {
      if (cancelCleanupPromise) return cancelCleanupPromise
      cancelCleanupPromise = (async () => {
        log('cancellation cleanup BEGIN')
        window.api.sendToPresentation('cancel-content-load', { takeId })
        window.api.sendToPresentation('capture-audio-live', null)
        const cancellationIntent = cancelOutputIntentRef.current
        try {
          await window.api.showOverlay(cancellationIntent.selectedDisplayId ?? undefined)
        } catch (error) {
          log(`cancellation cover failed: ${String(error)}`)
        }
        try { await window.api.musicStop() } catch { /* already stopped */ }
        const targetExternalPath = channel.file?.type === 'other' &&
          !channel.file.isImage && !channel.file.isAudio
          ? channel.file.path
          : null
        const previousExternalPath = prevActiveFile?.type === 'other' &&
          !prevActiveFile.isImage && !prevActiveFile.isAudio
          ? prevActiveFile.path
          : null
        let targetExternalClosed: { success: boolean; error?: string } = { success: true }
        if (targetExternalPath && targetExternalPath !== previousExternalPath) {
          targetExternalClosed = await window.api.closeExternalFile(targetExternalPath).catch((error: unknown) => ({
            success: false,
            error: String(error)
          }))
        }
        let powerPointClosed: { success: boolean; error?: string } = { success: true }
        if (prevActiveFile?.type === 'presentation' || channel.file?.type === 'presentation') {
          powerPointClosed = await window.api.powerpointCommand('close').catch((error: unknown) => ({
            success: false,
            error: String(error)
          }))
        }
        let previousExternalMinimized: { success: boolean; error?: string } = { success: true }
        if (previousExternalPath) {
          // Match normal STOP semantics for a document that was already live:
          // park the user's Word/Excel window, never leave it on the program
          // display and never destroy their document just because TAKE was cancelled.
          previousExternalMinimized = await window.api.minimizeExternalFile(previousExternalPath).catch((error: unknown) => ({
            success: false,
            error: String(error)
          }))
        }

        if (!targetExternalClosed.success || !powerPointClosed.success || !previousExternalMinimized.success) {
          const retainedFile = !targetExternalClosed.success && targetExternalPath
            ? channel.file
            : !powerPointClosed.success
              ? channel.file?.type === 'presentation'
                ? channel.file
                : prevActiveFile?.type === 'presentation'
                  ? prevActiveFile
                  : null
              : prevActiveFile
          const retainedLiveChannel = retainedFile === channel.file ? ch : freshState.liveChannel

          // A failed native cleanup must not retain a committed/staged PDF,
          // video decoder or capture stream underneath the truthful native
          // output. Keep only the empty warm BrowserWindow.
          window.api.sendToPresentation('clear-active-content')
          if (useAppStore.getState().isPresentationWindowOpen) {
            await window.api.closePresentationWindow()
            setPresentationWindowOpen(false)
          }
          useAppStore.setState({
            activeFile: retainedFile,
            liveChannel: retainedLiveChannel,
            isPlaying: false
          })
          if (retainedFile) window.api.setActiveContentType(retainedFile.type)
          await window.api.hideOverlay()
          setOverlayState({ kind: 'hidden' })
          const cleanupErrors = [
            !targetExternalClosed.success
              ? targetExternalClosed.error || 'Не удалось закрыть новое окно Word/Excel.'
              : null,
            !powerPointClosed.success
              ? powerPointClosed.error || 'Не удалось закрыть и освободить презентацию PowerPoint.'
              : null,
            !previousExternalMinimized.success
              ? previousExternalMinimized.error || 'Не удалось свернуть прежнее окно Word/Excel.'
              : null
          ].filter((value): value is string => Boolean(value))
          window.alert(`${cleanupErrors.join('\n')} Эфир оставлен в фактическом состоянии; повторите остановку.`)
          log(`cancellation cleanup incomplete: ${cleanupErrors.join(' | ')}`)
          return
        }

        useAppStore.setState({ activeFile: null, liveChannel: null, isPlaying: false })
        const intent = cancellationIntent
        const backdropPainted = await clearHeavyPresentationOutput(
          intent.backdropImage,
          intent.selectedDisplayId,
          `TAKE cancellation ${takeId}`
        )
        if (intent.backdropImage && !backdropPainted) {
          window.alert('Фон не удалось подготовить. Контент закрыт, память освобождена.')
        }
        await window.api.hideOverlay()
        setOverlayState({ kind: 'hidden' })
        await window.api.releaseBrowserFullscreen()
        log('cancellation cleanup END')
      })()
      return cancelCleanupPromise
    }
    cancelTakeCleanupRef.current = { takeId, run: finishCancelledTake }
    log(`BEGIN prev=${prevActiveFile?.type} next=${channel.file.type} slide=${channel.slide}`)

    // TAKE can wait behind a display-routing transaction. Re-check both the
    // cancellation token and selected program display only after acquiring
    // that shared lock, otherwise a queued screen source may start capturing
    // the monitor that has just become the main output.
    if (isTakeCancelled()) {
      await finishCancelledTake()
      return
    }
    if (
      channel.file.type === 'capture' &&
      channel.file.capture?.captureKind === 'desktop' &&
      channel.file.capture.desktopSourceType === 'screen' &&
      channel.file.capture.desktopDisplayId &&
      freshState.selectedDisplayId !== null &&
      channel.file.capture.desktopDisplayId === String(freshState.selectedDisplayId)
    ) {
      const message = 'Этот экран выбран для эфира. Выберите другое окно или экран.'
      log(`blocked after routing: captured screen is output display=${channel.file.capture.desktopDisplayId}`)
      setTakeProgress({ channelId: ch, message })
      setTimeout(() => {
        setTakeProgress((current) => current?.channelId === ch ? null : current)
      }, 3500)
      await new Promise((resolve) => setTimeout(resolve, 3500))
      return
    }

    // A minimized native window is intentionally added without touching it.
    // Resolve and restore it only after the operator explicitly presses TAKE,
    // before changing any visible output or overlay state.
    const captureConfig = channel.file.type === 'capture' ? channel.file.capture : undefined
    const isDeferredDesktopWindow = (
      captureConfig?.captureKind === 'desktop' &&
      (
        captureConfig.desktopSourceType === 'window' ||
        (!captureConfig.desktopSourceType && captureConfig.desktopSourceId?.startsWith('window:'))
      )
    )
    if (captureConfig && isDeferredDesktopWindow) {
      const sourceKey = captureConfig.desktopSourceKey || captureConfig.desktopSourceId
      const captureSourceId = captureConfig.sourceId
      if (!sourceKey) {
        log('desktop window prepare aborted: stable source key is missing')
        setTakeProgress({
          channelId: ch,
          message: 'Не удалось подключить окно: источник больше недоступен. Добавьте его заново.'
        })
        await new Promise((resolve) => setTimeout(resolve, 3000))
        return
      }

      log(`desktop window prepare BEGIN key=${sourceKey}`)
      const prepared = await window.api.prepareDesktopCaptureSource(sourceKey)
      if (isTakeCancelled()) {
        log('desktop window prepare cancelled before output changes')
        await finishCancelledTake()
        return
      }

      // The channel may have been cleared or replaced while Windows was
      // restoring/enumerating the native window. Never resurrect stale state.
      const currentState = useAppStore.getState()
      const currentChannel = currentState.channels[ch]
      if (currentChannel?.file?.capture?.sourceId !== captureSourceId) {
        log('desktop window prepare ignored: channel source changed')
        await window.api.releaseBrowserFullscreen(desktopWindowSourceKey(prevActiveFile))
        return
      }

      const resolvedCaptureId = prepared.source?.captureId || (
        prepared.source?.id.startsWith('window:') ? prepared.source.id : undefined
      )
      if (!prepared.success || !prepared.source || !resolvedCaptureId) {
        const error = prepared.error || 'Windows не смогла подготовить выбранное окно.'
        log(`desktop window prepare failed: ${error}`)
        setTakeProgress({ channelId: ch, message: error })
        await new Promise((resolve) => setTimeout(resolve, 3500))
        return
      }

      const resolvedCapture: CaptureSourceConfig = {
        ...captureConfig,
        desktopSourceId: resolvedCaptureId,
        desktopSourceKey: captureConfig.desktopSourceKey || prepared.source.id,
        desktopSourceType: 'window',
        desktopAppIcon: prepared.source.appIcon || captureConfig.desktopAppIcon,
        audioEnabled: false,
        videoLabel: prepared.source.name || captureConfig.videoLabel
      }
      const resolvedEntry: FileEntry = {
        ...currentChannel.file,
        name: resolvedCapture.videoLabel,
        capture: resolvedCapture
      }
      const sameCaptureSource = (file?: FileEntry | null): boolean => (
        file?.capture?.sourceId === captureSourceId
      )

      // One FileEntry is referenced from the source library, one or more
      // channels and sometimes selected/active state. Replace all copies in a
      // single store transaction while preserving each channel's slide state.
      useAppStore.setState((state) => {
        const updatedChannels = Object.fromEntries(
          Object.entries(state.channels).map(([channelId, stateChannel]) => [
            channelId,
            sameCaptureSource(stateChannel.file)
              ? { ...stateChannel, file: resolvedEntry }
              : stateChannel
          ])
        ) as Record<ChannelId, ChannelState>
        const hasLibraryEntry = state.captureSources.some(sameCaptureSource)
        return {
          channels: updatedChannels,
          captureSources: hasLibraryEntry
            ? state.captureSources.map((source) => sameCaptureSource(source) ? resolvedEntry : source)
            : [...state.captureSources, resolvedEntry],
          selectedFile: sameCaptureSource(state.selectedFile) ? resolvedEntry : state.selectedFile,
          activeFile: sameCaptureSource(state.activeFile) ? resolvedEntry : state.activeFile
        }
      })
      channel = { ...currentChannel, file: resolvedEntry }
      log(`desktop window prepare END captureId=${resolvedCaptureId}`)
    }

    // Once the replacement is visibly ready, leave only that browser (if
    // any) in F11. This keeps browser -> PDF/PPTX/video transitions covered by
    // the existing seamless layer until the old browser changes back to a
    // regular window.
    const releaseInactiveBrowserFullscreen = async (): Promise<void> => {
      await window.api.releaseBrowserFullscreen(desktopWindowSourceKey(channel.file))
    }

    const FINAL_NAVIGATION_QUIET_MS = 70
    const MAX_MATCHED_FRAME_PASSES = 6

    const waitForLateNavigation = async (): Promise<boolean> => {
      // capturePage/PrintWindow resolves just before Windows delivers some
      // global-shortcut callbacks. Give those callbacks one short turn to join
      // the protected queue before revealing the live output.
      await new Promise((resolve) => setTimeout(resolve, FINAL_NAVIGATION_QUIET_MS))
      return pendingNavigationCount() > 0
    }

    const applyQueuedNavigationUnderOverlay = async (
      contentType: FileEntry['type']
    ): Promise<number> => {
      const requests = drainNavigationTransition()
      if (requests.length === 0) return 0

      const description = requests.map((request) => (
        request.kind === 'relative' ? request.direction : `goto:${request.slide}`
      )).join(',')
      log(`applying queued navigation under overlay: type=${contentType} requests=${description}`)
      if (contentType === 'pdf') {
        for (const request of requests) {
          // PdfViewer emits content-ready only after drawImage + two animation
          // frames. Subscribe first so the fast native-cache path cannot beat
          // the listener. Boundary clicks may not repaint, hence the timeout.
          const painted = new Promise<void>((resolve) => {
            let settled = false
            let timer: ReturnType<typeof setTimeout> | undefined
            let unsub = (): void => {}
            const done = (): void => {
              if (settled) return
              settled = true
              if (timer) clearTimeout(timer)
              unsub()
              resolve()
            }
            unsub = window.api.on('presentation-content-ready', done)
            timer = setTimeout(done, 500)
          })
          if (request.kind === 'relative') {
            window.api.sendToPresentation('navigate-pdf', request.direction)
          } else {
            window.api.sendToPresentation('navigate-slide', request.slide)
          }
          await painted
        }
      } else if (contentType === 'presentation') {
        for (const request of requests) {
          const result = request.kind === 'relative'
            ? await useAppStore.getState().navigatePptx(request.direction === 'next' ? 'next' : 'prev')
            : await useAppStore.getState().navigatePptx('goto', request.slide)
          if (result.success && result.output) {
            try {
              const data = JSON.parse(result.output)
              if (typeof data.CurrentSlide === 'number' && data.CurrentSlide > 0) {
                useAppStore.getState().setCurrentSlide(data.CurrentSlide)
              }
            } catch { /* ignore malformed diagnostics */ }
          }
        }
      }

      log(`queued navigation applied under overlay: count=${requests.length}`)
      return requests.length
    }

    const isPptxToPptx =
      prevActiveFile?.type === 'presentation' && channel.file.type === 'presentation'
    // Same-file PPTX→PPTX: PowerPoint handles this as an instant GotoSlide on
    // the already-running slideshow (no Run(), no teardown). There is nothing
    // to mask — showing an overlay only creates its own visible flicker as it
    // appears/disappears with PNG renders that don't pixel-match PP's live
    // DirectWrite output. Skip the overlay entirely in this case.
    const isSameFilePptx =
      isPptxToPptx &&
      prevActiveFile?.type === 'presentation' &&
      channel.file.type === 'presentation' &&
      prevActiveFile.path === channel.file.path
    const hadPinnedOverlay = freshState.overlayState.kind !== 'hidden'
    // PdfViewer keeps its existing canvas while loading and renders the new
    // page offscreen before one synchronous draw. PDF→PDF therefore needs no
    // separate HWND overlay or screenshot at all.
    const canSwapPdfInPlace =
      prevActiveFile?.type === 'pdf' &&
      channel.file.type === 'pdf' &&
      freshState.isPresentationWindowOpen
    const useLiveLayerSwitch =
      !isSameFilePptx &&
      (
        (prevActiveFile?.type === 'presentation' &&
          (channel.file.type === 'presentation' || channel.file.type === 'pdf' || channel.file.type === 'video' || channel.file.type === 'capture')) ||
        ((prevActiveFile?.type === 'pdf' || prevActiveFile?.type === 'video' || prevActiveFile?.type === 'capture') &&
          channel.file.type === 'presentation')
      )
    const useBufferedElectronSwitch =
      (prevActiveFile?.type === 'pdf' || prevActiveFile?.type === 'video' || prevActiveFile?.type === 'capture') &&
      (channel.file.type === 'pdf' || channel.file.type === 'video' || channel.file.type === 'capture') &&
      (
        prevActiveFile?.type === 'video' ||
        prevActiveFile?.type === 'capture' ||
        channel.file.type === 'video' ||
        channel.file.type === 'capture'
      )
    const useSeamlessLayerSwitch = useLiveLayerSwitch || useBufferedElectronSwitch
    const hasReadyProgramScene = freshState.programScene.enabled &&
      !!freshState.backdropImage &&
      freshState.captureSources.some(
        (entry) => entry.capture?.sourceId === freshState.programScene.captureSourceId
      )
    const keepProgramSceneParticipantOnTop =
      hasReadyProgramScene &&
      channel.file.type === 'presentation' &&
      freshState.programScene.viewMode === 'participant'
    // In the program scene PowerPoint only occupies the presentation pane.
    // Stage it below the live Chromium output, then suspend just the outgoing
    // document before promoting the already-painted native window. The scene
    // backdrop, camera and titles stay live and no bitmap cover is introduced.
    const stageProgramSceneElectronToPptx =
      hasReadyProgramScene &&
      channel.file.type === 'presentation' &&
      (keepProgramSceneParticipantOnTop ||
        prevActiveFile?.type === 'pdf' ||
        prevActiveFile?.type === 'video' ||
        prevActiveFile?.type === 'capture')

    if (useSeamlessLayerSwitch && hadPinnedOverlay) {
      await window.api.hideOverlay()
      setOverlayState({ kind: 'hidden' })
      log('live-layer switch: released stale pinned bitmap')
    }

    if (canSwapPdfInPlace && hadPinnedOverlay) {
      // The pinned PDF bitmap and the underlying warm PDF window contain the
      // same pixels. Remove the redundant layer before using the proven
      // in-place PDF->PDF canvas swap, so that fast path stays unchanged.
      await window.api.hideOverlay()
      setOverlayState({ kind: 'hidden' })
      log('PDF-to-PDF: released matched pinned frame before in-place swap')
    }
    // Freeze exactly the OLD output and keep it until the NEW output is fully
    // painted. Rendering the target PDF here used a different raster pipeline
    // from the presentation window; the later capture swap therefore changed
    // brightness/antialiasing a second time and looked like a flash.
    let freezeFrame: string | null = null
    let freezeImagePath: string | null = null
    if (!useSeamlessLayerSwitch && !isSameFilePptx && !canSwapPdfInPlace && !hadPinnedOverlay) {
      try {
        if (freshState.isPresentationWindowOpen && prevActiveFile?.type !== 'presentation') {
          // PDF/video/image/backdrop all live in the same Chromium output
          // window. capturePage gives an exact old frame without desktop
          // thumbnail scaling or cursor/timer duplication.
          log('freezeFrame: capture current presentation window BEGIN')
          freezeFrame = await window.api.capturePresentationFrame()
          log(`freezeFrame: current presentation window ${freezeFrame ? 'ok' : 'null'}`)
        }
      } catch (e) {
        log(`freezeFrame: presentation capture error ${String(e)}`)
      }

      // Capture PowerPoint directly through PrintWindow. desktopCapturer
      // touches the live display pipeline and was itself taking 0.3–1.2s on
      // the affected 4K PC, sometimes producing the visible blink.
      if (!freezeFrame && prevActiveFile?.type === 'presentation') {
        try {
          log('freezeFrame: snapshot current PowerPoint BEGIN')
          freezeImagePath = await window.api.snapshotSlideshow()
          log(`freezeFrame: current PowerPoint ${freezeImagePath ? 'ok' : 'null'}`)
        } catch { /* use display fallback below */ }
      }

      // External Office windows live outside Chromium. Also use this as a
      // fallback if capturePage/PrintWindow was unavailable.
      if (!freezeFrame && !freezeImagePath && (prevActiveFile || freshState.isPresentationWindowOpen)) {
        try {
          freezeFrame = await window.api.captureDisplay(freshState.selectedDisplayId ?? undefined)
          log(`freezeFrame: current display fallback ${freezeFrame ? 'ok' : 'null'}`)
        } catch { /* fall back to black overlay */ }
      }
    }

    if (!useSeamlessLayerSwitch && !isSameFilePptx && !canSwapPdfInPlace) {
      if (hadPinnedOverlay) {
        // The overlay already contains the exact visible PowerPoint frame.
        // Reassert its z-order without replacing the bitmap. Otherwise closing
        // the foreground PowerPoint window can briefly expose Explorer/Start.
        await window.api.showOverlay(
          freshState.selectedDisplayId ?? undefined,
          undefined,
          undefined,
          'cover'
        )
        log('existing frame retained as transition cover')
      } else {
        await window.api.showOverlay(
          freshState.selectedDisplayId ?? undefined,
          freezeFrame || undefined,
          freezeImagePath || undefined,
          'cover'
        )
        log('old frame armed as transition cover')
      }
      // While TAKE is protected, queued PowerPoint navigation must not treat
      // the physical overlay as a user-facing pinned frame and hide it early.
      setOverlayState({ kind: 'hidden' })
    } else if (useSeamlessLayerSwitch) {
      log(useLiveLayerSwitch
        ? 'live-layer switch: no screenshot window; old live output remains visible'
        : 'buffered Electron switch: old DOM layer remains visible until target paint')
    } else if (isSameFilePptx) {
      log('same-file PPTX: skipping overlay (PP GotoSlide is instant)')
      if (hadPinnedOverlay) {
        setOverlayState({ kind: 'hidden' })
      }
    } else {
      log('PDF-to-PDF: skipping overlay, persistent canvas owns atomic swap')
    }

    if (isTakeCancelled()) {
      await finishCancelledTake()
      return
    }

    // A recovered/cached channel can be marked ready before this renderer has
    // learned the deck aspect (the ratio is intentionally session-only). Make
    // it available before activeFile changes, otherwise the mirror receives
    // its first PPTX state with `pptxAspect=missing` and keeps the whole
    // ultrawide desktop letterboxed on a Full HD target.
    if (
      channel.file.type === 'presentation' &&
      !useAppStore.getState().pptxAspectRatios[channel.file.path]
    ) {
      const preparedGeometry = await window.api.preparePowerPoint(channel.file.path)
      if (preparedGeometry.success && preparedGeometry.aspectRatio) {
        const geometryState = useAppStore.getState()
        useAppStore.setState({
          pptxAspectRatios: {
            ...geometryState.pptxAspectRatios,
            [channel.file.path]: preparedGeometry.aspectRatio
          }
        })
        log(`PPTX aspect ready before TAKE ratio=${preparedGeometry.aspectRatio.toFixed(6)}`)
      } else {
        log(`PPTX aspect unavailable before TAKE error=${preparedGeometry.error || 'missing geometry'}`)
      }
    }

    // The main output already keeps its old layer until the target is ready.
    // Give every live-copy window the same transaction boundary: capture its
    // exact last composed frame (including letterbox and timer) before the
    // store publishes the next activeFile. The mirror releases this hold only
    // after this TAKE finishes and its own target frame has painted.
    if (
      prevActiveFile !== null ||
      freshState.backdropImage !== null ||
      freshState.isPresentationWindowOpen
    ) {
      log('program mirror freeze BEGIN')
      const mirrorFreeze = await window.api.freezeProgramMirrors(takeId)
      log(`program mirror freeze END armed=${mirrorFreeze.armed}`)
      if (isTakeCancelled()) {
        await finishCancelledTake()
        return
      }
    }

    // Keep the previous Word/Excel window visible until another native
    // document has been verified on the program display. The external-target
    // branch minimizes it only after the replacement succeeds.
    const nextIsExternalDocument =
      channel.file.type === 'other' && !channel.file.isImage && !channel.file.isAudio
    const previousExternalFile =
      prevActiveFile?.type === 'other' &&
      !prevActiveFile.isImage &&
      !prevActiveFile.isAudio
        ? prevActiveFile
        : null
    const shouldDeferPreviousExternalMinimize = Boolean(previousExternalFile && !nextIsExternalDocument)
    const minimizePreviousExternalAfterTargetReady = async (): Promise<{
      success: boolean
      error?: string
    }> => {
      if (!shouldDeferPreviousExternalMinimize || !previousExternalFile) return { success: true }
      let minimized = await window.api.minimizeExternalFile(previousExternalFile.path)
      if (!minimized.success) {
        await new Promise((resolve) => setTimeout(resolve, 150))
        minimized = await window.api.minimizeExternalFile(previousExternalFile.path)
      }
      if (!minimized.success) {
        log(`previous external window minimize failed after target ready: ${minimized.error || 'unknown error'}`)
      }
      return minimized
    }

    setActiveFile(channel.file)
    if (adHoc) {
      // setLiveChannel only accepts real populated channel IDs. Ad-hoc
      // playlist playback deliberately has no live channel, so publish that
      // state directly instead of leaving the previous channel marked live.
      useAppStore.setState({ liveChannel: adHoc.liveChannel })
    } else {
      setLiveChannel(ch)
    }

    if (channel.file.type === 'presentation') {
      const selectedSceneCapture = freshState.captureSources.find(
        (entry) => entry.capture?.sourceId === freshState.programScene.captureSourceId
      )?.capture ?? null
      const programSceneActive = freshState.programScene.enabled &&
        !!freshState.backdropImage &&
        !!selectedSceneCapture
      const programSceneContentAspectRatio = freshState.pptxAspectRatios[channel.file.path] ?? null
      if (programSceneActive) {
        await window.api.openPresentationWindow(freshState.selectedDisplayId ?? undefined, true)
        setPresentationWindowOpen(true)
        window.api.sendToPresentation('capture-source-register', selectedSceneCapture)
        window.api.sendToPresentation('program-scene-update', {
          active: true,
          capture: selectedSceneCapture,
          backdropPath: freshState.backdropImage,
          placement: freshState.programScene.placement,
          participantSize: freshState.programScene.participantSize,
          participantScale: freshState.programScene.participantScale,
          cornerStyle: freshState.programScene.cornerStyle,
          viewMode: freshState.programScene.viewMode,
          transitionEffect: freshState.programScene.transitionEffect,
          transitionDurationMs: freshState.programScene.transitionDurationMs,
          contentAspectRatio: programSceneContentAspectRatio
        })
        // Keep the outgoing PDF/video visible in the program-scene content
        // pane until native PowerPoint has painted and reached its target
        // slide. Clearing it here exposed the backdrop for the whole (possibly
        // slow) Office startup instead of making the TAKE visually atomic.
        const targetDisplay = freshState.displays.find(
          (display) => !display.isPrimary && display.id === freshState.selectedDisplayId
        ) || freshState.displays.find((display) => !display.isPrimary)
        if (targetDisplay) {
          // A reduced PowerPoint slideshow no longer covers the Windows
          // taskbar. Start the comparatively slow shell operation in parallel
          // with Office startup; waiting for a fresh PowerShell process here
          // added more than a second to every PDF -> PPTX TAKE.
          void window.api.hideTaskbar(targetDisplay.bounds).catch((error) => {
            log(`pre-launch taskbar hide failed: ${String(error)}`)
          })
        }
        log('program scene underlay prepared; outgoing content retained until PowerPoint is ready')
      }
      window.api.setActiveContentType('presentation')
      // Reset goto-collapse state — старая chain от навигации предыдущего
      // PPTX может быть inflight и блокировать новые goto на новом файле
      // (все клики получали бы зависший shared promise → preview advances
      // optimistic, PP не двигается). После reset новые клики стартуют
      // свежий chain на новый daemon-loaded PP.
      resetPptxNavState()
      // Switch audio if coming from non-PPTX content
      if (prevActiveFile?.type !== 'presentation') {
        window.api.switchAudioToExternal() // fire-and-forget, don't await
      }

      // Launch PowerPoint FIRST (while overlay still covers the screen).
      // Pass target slide so the daemon starts the slideshow directly at it —
      // no slide-1 flash before jumping.
      const targetSlide = channel.slide > 1 ? channel.slide : undefined
      log('launchPowerPoint: BEGIN')
      // Снимок currentSlide ДО await launchPowerPoint. Если юзер во время
      // launch нажал Next/Prev на кликере (globalShortcut → App.navigateSlide
      // → setCurrentSlide(optimistic) + navigatePptx goto), значение в store
      // изменится. После await сравним — и если был user nav, НЕ override
      // currentSlide результатом launch (data.CurrentSlide отражает только
      // Run()'s starting slide, не учитывает queued goto's выполненные daemon
      // после Run → откат UI назад к 1 при PP уже на 2 = off-by-N рассинхрон).
      const slideBeforeLaunch = useAppStore.getState().currentSlide
      const pptxPath = channel.file.path
      const stopListeningForVisible = window.api.on(
        'powerpoint-slideshow-visible',
        (visiblePath) => {
          if (
            typeof visiblePath === 'string' &&
            visiblePath.toLowerCase() === pptxPath.toLowerCase() &&
            takeInFlightRef.current === ch
          ) {
            hasPowerPointStartedRef.current = true
            setTakeProgress((current) => current?.channelId === ch ? null : current)
            if (prevActiveFile?.type === 'capture') {
              window.api.sendToPresentation('capture-audio-live', null)
            }
          }
        }
      )
      let result: Awaited<ReturnType<typeof window.api.launchPowerPoint>>
      try {
        result = await window.api.launchPowerPoint(
          pptxPath,
          freshState.selectedDisplayId ?? undefined,
          targetSlide,
          programSceneActive
            ? {
                enabled: true,
                placement: freshState.programScene.placement,
                participantSize: freshState.programScene.participantSize,
                participantScale: freshState.programScene.participantScale,
                cornerStyle: freshState.programScene.cornerStyle,
                viewMode: freshState.programScene.viewMode,
                transitionEffect: freshState.programScene.transitionEffect,
                transitionDurationMs: freshState.programScene.transitionDurationMs,
                contentAspectRatio: programSceneContentAspectRatio
              }
            : undefined,
          stageProgramSceneElectronToPptx
        )
      } finally {
        stopListeningForVisible()
      }
      log(`launchPowerPoint: END success=${result.success} error=${result.error ?? '-'}`)
      const requiresLockedFailureCover = !result.success && result.safeToUncover === false
      if (isTakeCancelled() && !requiresLockedFailureCover) {
        log('PowerPoint TAKE cancelled while launching')
        await finishCancelledTake()
        return
      }
      if (result.success) {
        hasPowerPointStartedRef.current = true
        setTakeProgress((current) => current?.channelId === ch ? null : current)
        if (prevActiveFile?.type === 'capture') {
          window.api.sendToPresentation('capture-audio-live', null)
        }
      }

      // A cold PowerPoint COM start can fail before Run() creates a slideshow.
      // Never continue into close-presentation-window + pinned overlay in that
      // state: it replaces the existing backdrop with a permanent black screen.
      if (!result.success) {
        const rollbackMessage = result.error ||
          'PowerPoint rollback was not verified. Restart PDM before continuing.'
        if (result.safeToUncover === false) {
          log('launchPowerPoint failed: rollback unverified; pinning safety cover')
          try {
            let safetyCoverLocked = false
            for (let attempt = 1; attempt <= 3 && !safetyCoverLocked; attempt++) {
              safetyCoverLocked = await window.api.showOverlay(
                freshState.selectedDisplayId ?? undefined,
                freezeFrame || undefined,
                freezeImagePath || undefined,
                'cover',
                true
              )
              if (!safetyCoverLocked && attempt < 3) {
                await new Promise((resolve) => setTimeout(resolve, 50))
              }
            }
            if (!safetyCoverLocked) {
              throw new Error('PowerPoint safety cover could not be locked')
            }
          } catch (error) {
            log(`failed to arm PowerPoint safety cover: ${String(error)}`)
          }
          setOverlayState({ kind: 'blocked', reason: rollbackMessage })
          if (cancelTakeCleanupRef.current?.takeId === takeId) {
            cancelTakeCleanupRef.current = null
          }
          setTakeProgress({ channelId: ch, message: rollbackMessage })
        } else {
          log('launchPowerPoint failed: revealing verified previous output')
          await window.api.hideOverlay()
          setOverlayState({ kind: 'hidden' })
        }
        useAppStore.setState({
          activeFile: prevActiveFile,
          liveChannel: freshState.liveChannel,
          currentSlide: freshState.currentSlide,
          totalSlides: freshState.totalSlides,
          isPlaying: freshState.isPlaying
        })
        if (prevActiveFile) {
          window.api.setActiveContentType(prevActiveFile.type)
        } else if (freshState.backdropImage) {
          window.api.setActiveContentType('backdrop')
        } else {
          window.api.sendToPresentation('clear-active-content')
        }
        if (result.safeToUncover === false) {
          await new Promise((resolve) => setTimeout(resolve, 3500))
        }
        return
      }

      // КРИТИЧНО: ждём пока goto-chain (от user-кликов кликером во время
      // launch) полностью отработает daemon. Иначе snapshotSlideshow
      // ниже захватит ПРОМЕЖУТОЧНЫЙ слайд PP, а не финальный, на котором
      // юзер действительно остановился — overlay pinned с картинкой
      // не той страницы → PP под overlay показывает одно, overlay поверх
      // другое.
      log('awaitPptxGotoChainIdle: BEGIN')
      await awaitPptxGotoChainIdle()
      log('awaitPptxGotoChainIdle: END')
      if (isTakeCancelled()) {
        await finishCancelledTake()
        return
      }

      // The slideshow is ready but still covered. Apply clicks made while it
      // was opening now, so the first revealed frame is already the requested
      // slide instead of briefly exposing the launch slide.
      await applyQueuedNavigationUnderOverlay('presentation')
      if (isTakeCancelled()) {
        await finishCancelledTake()
        return
      }

      // Скрываем Shell_SecondaryTrayWnd на внешнем дисплее. PP slideshow
      // идёт HWND_TOPMOST, но во время GotoSlide/Next transition-гонок
      // таскбар иногда проскакивает поверх — юзер видит его на слайде.
      // Прячем явно через ShowWindow(SW_HIDE); восстанавливаем на exit.
      try {
        const { selectedDisplayId: sid, displays: disps } = useAppStore.getState()
        const td = disps.find((d) => !d.isPrimary && d.id === sid) ||
          disps.find((d) => !d.isPrimary)
        // The program-scene branch already started this operation before the
        // PowerPoint launch, giving it the whole Office startup interval to
        // finish. Do not launch and await a duplicate shell process now.
        if (td && !programSceneActive) await window.api.hideTaskbar(td.bounds)
      } catch (error) {
        log(`post-launch taskbar hide failed: ${String(error)}`)
      }

      const slideAfterLaunch = useAppStore.getState().currentSlide
      const userNavigatedDuringLaunch = slideAfterLaunch !== slideBeforeLaunch
      log(`userNavigatedDuringLaunch=${userNavigatedDuringLaunch} (${slideBeforeLaunch}→${slideAfterLaunch})`)

      if (stageProgramSceneElectronToPptx) {
        if (keepProgramSceneParticipantOnTop) {
          // The daemon has painted and verified the slideshow behind the
          // persistent Chromium output. Participant focus deliberately keeps
          // that window above PowerPoint; promotion here would expose the deck
          // for the remainder of TAKE and only hide it again at the end.
          log('participant focus retained; warmed PowerPoint remains staged underneath')
        } else {
        const contentSuspended = new Promise<boolean>((resolve) => {
          let settled = false
          let timeout: ReturnType<typeof setTimeout> | undefined
          let unsubscribe = (): void => {}
          const finish = (confirmed: boolean): void => {
            if (settled) return
            settled = true
            if (timeout) clearTimeout(timeout)
            unsubscribe()
            resolve(confirmed)
          }
          unsubscribe = window.api.on('presentation-content-suspended', () => finish(true))
          timeout = setTimeout(() => finish(false), 1_000)
        })
        window.api.sendToPresentation('suspend-active-content')
        const suspendConfirmed = await contentSuspended
        const currentDisplayState = useAppStore.getState()
        const targetDisplay = currentDisplayState.displays.find(
          (display) => display.id === currentDisplayState.selectedDisplayId
        ) || currentDisplayState.displays.find((display) => !display.isPrimary)
        const promotion = suspendConfirmed && targetDisplay
          ? await window.api.relocatePowerPoint(targetDisplay.id, {
              enabled: true,
              placement: freshState.programScene.placement,
              participantSize: freshState.programScene.participantSize,
              participantScale: freshState.programScene.participantScale,
              cornerStyle: freshState.programScene.cornerStyle,
              viewMode: freshState.programScene.viewMode,
              transitionEffect: freshState.programScene.transitionEffect,
              transitionDurationMs: freshState.programScene.transitionDurationMs,
              contentAspectRatio: programSceneContentAspectRatio
            })
          : {
              success: false,
              error: suspendConfirmed
                ? 'Эфирный дисплей больше не подключён.'
                : 'Эфирное окно не подтвердило переключение.'
            }
        if (!promotion.success) {
          window.api.sendToPresentation('resume-active-content')
          hasPowerPointStartedRef.current = false
          const stagedClosed = await window.api.powerpointCommand('close').catch(() => ({ success: false }))
          useAppStore.setState({
            activeFile: prevActiveFile,
            liveChannel: freshState.liveChannel,
            currentSlide: freshState.currentSlide,
            totalSlides: freshState.totalSlides,
            isPlaying: freshState.isPlaying
          })
          if (prevActiveFile) window.api.setActiveContentType(prevActiveFile.type)
          log(`staged PowerPoint promotion failed; close=${stagedClosed.success} error=${promotion.error || '-'}`)
          setTakeProgress({
            channelId: ch,
            message: promotion.error || 'Не удалось безопасно показать PowerPoint.'
          })
          await new Promise((resolve) => setTimeout(resolve, 3500))
          return
        }
        log('program-scene hand-off complete: outgoing content suspended, warmed PowerPoint promoted')
        }
      }

      // NOW close the Electron presentation window — PowerPoint slideshow is already visible
      // ВСЕГДА закрываем при переходе на PPTX (даже если флаг isPresentationWindowOpen
      // не синхрон с реальностью — например после PDF→PPTX без переоткрытия,
      // window мог остаться. Не закрытый window перекрывает PP slideshow белым
      // фоном на target дисплее → юзер видит белое, anim играют невидимо.
      // A fullscreen Electron window stays above PowerPoint on this Windows
      // build even after SetWindowPos(HWND_TOP) raises the slideshow. Park the
      // Electron window with native opacity=0 only after PowerPoint is fully
      // composed and while the transition overlay is still opaque. Unlike
      // BrowserWindow.hide(), this keeps its renderer/GPU surface warm, so the
      // next PPTX→PDF reveal remains fast.
      if (useAppStore.getState().isPresentationWindowOpen) {
        // PowerPoint is fully painted and still covered. Drop the old
        // PDF/video/capture layer now; keeping the empty renderer warm retains
        // fast window activation without retaining the old document/decoder.
        if (programSceneActive) {
          const oldContentCleared = new Promise<boolean>((resolve) => {
            let settled = false
            let timeout: ReturnType<typeof setTimeout> | undefined
            let unsubscribe = (): void => {}
            const finish = (confirmed: boolean): void => {
              if (settled) return
              settled = true
              if (timeout) clearTimeout(timeout)
              unsubscribe()
              resolve(confirmed)
            }
            unsubscribe = window.api.on('presentation-content-cleared', () => finish(true))
            timeout = setTimeout(() => finish(false), 1_000)
          })
          window.api.sendToPresentation('clear-active-content')
          const clearConfirmed = await oldContentCleared
          log(`presentation output retained as program-scene backdrop under PowerPoint; old content clear=${clearConfirmed ? 'painted' : 'timeout'}`)
        } else if (!useLiveLayerSwitch) {
          await window.api.closePresentationWindow()
          setPresentationWindowOpen(false)
          log('empty presentation output parked at opacity=0 under ready PowerPoint')
        } else {
          window.api.sendToPresentation('clear-active-content')
          log('old Electron content released under ready PowerPoint')
        }
        // Clearing/parking only removes the hidden Electron underlay. The real
        // program output is still PowerPoint and must remain the authoritative
        // target for display/DPI reconnect handling in main.
        window.api.setActiveContentType('presentation')
      }
      if (result.success && result.output) {
        try {
          const data = JSON.parse(result.output)
          if (data.SlideCount) {
            setTotalSlides(data.SlideCount)
            setChannelTotalSlides(ch, data.SlideCount)
            if (!userNavigatedDuringLaunch) {
              setCurrentSlide(data.CurrentSlide || channel.slide)
            } else {
              log('skipping setCurrentSlide override — preserving user navigation during launch')
            }
          }
        } catch { /* ignore */ }
      }
      // PowerPoint has already reported a positioned, visible slideshow and
      // the daemon flushed DWM before replying. Reveal that live window
      // directly. A target PrintWindow snapshot added 1–2.6 seconds and then
      // introduced another bitmap-to-live composition boundary (the flash).
      for (let pass = 1; pass <= MAX_MATCHED_FRAME_PASSES; pass++) {
        await applyQueuedNavigationUnderOverlay('presentation')
        if (!(await waitForLateNavigation())) break
        log('navigation arrived before PowerPoint reveal; applying under old frame')
      }
      if (isTakeCancelled()) {
        await finishCancelledTake()
        return
      }
      const previousExternalMinimized = await minimizePreviousExternalAfterTargetReady()
      if (!previousExternalMinimized.success) {
        let targetClosed = await window.api.powerpointCommand('close')
        if (!targetClosed.success) {
          await new Promise((resolve) => setTimeout(resolve, 150))
          targetClosed = await window.api.powerpointCommand('close')
        }
        if (targetClosed.success && previousExternalFile) {
          useAppStore.setState({ activeFile: previousExternalFile, liveChannel: freshState.liveChannel })
          window.api.setActiveContentType(previousExternalFile.type)
        }
        await window.api.hideOverlay()
        setOverlayState({ kind: 'hidden' })
        setTakeProgress({
          channelId: ch,
          message: previousExternalMinimized.error || (
            targetClosed.success
              ? 'Не удалось свернуть прежнее окно Word/Excel. Переключение на PowerPoint отменено.'
              : 'Не удалось завершить переключение между Word/Excel и PowerPoint. Проверьте эфирный дисплей.'
          )
        })
        await new Promise((resolve) => setTimeout(resolve, 3500))
        return
      }
      clearCommittedCaptureTitleSource('PowerPoint takeover')
      if (programSceneActive && freshState.programScene.viewMode === 'participant') {
        // In participant focus the slideshow was never promoted above the
        // persistent scene, so there is no late z-order correction (and no
        // interval in which the audience can see PowerPoint).
        log('participant focus remained above ready PowerPoint throughout TAKE')
      }
      const shouldPinPowerPointTarget =
        !programSceneActive &&
        !useSeamlessLayerSwitch &&
        (prevActiveFile?.type === 'pdf' ||
          prevActiveFile?.type === 'video' ||
          (isPptxToPptx && (!isSameFilePptx || hadPinnedOverlay)))
      if (shouldPinPowerPointTarget) {
        log('target snapshot: PowerPoint BEGIN')
        const targetSnapshot = await window.api.snapshotSlideshow()
        log(`target snapshot: PowerPoint END path=${targetSnapshot ? 'ok' : 'null'}`)
        if (isTakeCancelled()) {
          await finishCancelledTake()
          return
        }
        if (targetSnapshot) {
          await window.api.swapOverlayImage(targetSnapshot)
          await window.api.pinOverlay()
          setOverlayState({ kind: 'pinned-pptx', pptxPath })
          log('atomic target swap complete: PowerPoint frame pinned until navigation')
        } else {
          await window.api.hideOverlay()
          setOverlayState({ kind: 'hidden' })
          log('target snapshot unavailable: live PowerPoint revealed')
        }
      } else {
        if (!stageProgramSceneElectronToPptx) {
          await window.api.hideOverlay()
        }
        setOverlayState({ kind: 'hidden' })
        log(stageProgramSceneElectronToPptx
          ? 'staged program-scene switch complete without bitmap overlay'
          : useLiveLayerSwitch
            ? 'live-layer switch complete: warmed PowerPoint promoted once'
            : 'direct reveal: live PowerPoint ready')
      }
      // Channel assignment starts preview/full-slide preparation immediately.
      // Do not launch a second export after TAKE: besides being redundant, it
      // used to make diagnostics look as if caching only began on air.
      await releaseInactiveBrowserFullscreen()
      return
    }

    // Prepare the replacement first. PowerPoint is the last trustworthy
    // picture on the program display and must remain live until the target
    // PDF/video/image/capture (or audio cue + backdrop) is actually ready.
    if (prevActiveFile?.type !== channel.file.type) {
      // Audio-device enumeration can block for 5–6 seconds on this machine.
      // It is independent from video output, so never hold the visual TAKE on
      // it; the device switch completes in parallel after the new frame shows.
      void window.api.switchAudioToExternal()
    }
    const deferPowerPointCloseUntilTargetReady = prevActiveFile?.type === 'presentation'
    if (isTakeCancelled()) {
      await finishCancelledTake()
      return
    }

    // Audio files — play in built-in music player + show backdrop
    if (channel.file.type === 'other' && channel.file.isAudio) {
      if (prevActiveFile?.type === 'capture') {
        window.api.sendToPresentation('capture-audio-live', null)
      }
      const { backdropImage, selectedDisplayId } = useAppStore.getState()
      const outputWindowOpen = useAppStore.getState().isPresentationWindowOpen
      const rollbackAudioTake = async (
        message: string,
        backdropWasCommitted = false
      ): Promise<void> => {
        window.api.sendToPresentation('cancel-content-load', { takeId })
        try { await window.api.musicStop() } catch { /* best effort */ }
        if (backdropWasCommitted) {
          window.api.sendToPresentation('clear-active-content')
        }
        const presentationWindowOpen = useAppStore.getState().isPresentationWindowOpen
        const shouldClosePresentationWindow = presentationWindowOpen && (
          !outputWindowOpen || (backdropWasCommitted && prevActiveFile?.type === 'presentation')
        )
        if (shouldClosePresentationWindow) {
          await window.api.closePresentationWindow()
          setPresentationWindowOpen(false)
        }
        useAppStore.setState({
          activeFile: prevActiveFile,
          liveChannel: freshState.liveChannel,
          currentSlide: freshState.currentSlide,
          totalSlides: freshState.totalSlides,
          isPlaying: freshState.isPlaying
        })
        if (prevActiveFile) {
          window.api.setActiveContentType(prevActiveFile.type)
        } else if (freshState.backdropImage) {
          window.api.setActiveContentType('backdrop')
        } else {
          window.api.sendToPresentation('clear-active-content')
        }
        await window.api.hideOverlay()
        setOverlayState({ kind: 'hidden' })
        setTakeProgress({ channelId: ch, message })
        await new Promise((resolve) => setTimeout(resolve, 3500))
      }

      // A resolved play IPC only means that the command reached the hidden
      // player. Keep the old program picture until the media element confirms
      // that playback has actually started.
      try {
        useAppStore.getState().setMusicPlaylist([channel.file.path])
        await window.api.musicSetPlaylist([channel.file.path], 0)
        if (isTakeCancelled()) {
          await finishCancelledTake()
          return
        }
        await window.api.musicPlay()
      } catch (error) {
        log(`audio take failed before playback: ${String(error)}`)
        await rollbackAudioTake('Не удалось запустить аудиофайл.')
        return
      }
      const audioReadyDeadline = performance.now() + 8_000
      let audioReady = false
      while (!audioReady && performance.now() < audioReadyDeadline) {
        if (isTakeCancelled()) {
          await finishCancelledTake()
          return
        }
        const musicState = await window.api.musicGetState().catch(() => null)
        audioReady = musicState?.playing === true
        if (!audioReady) {
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      }
      if (!audioReady) {
        log('audio take aborted: playback did not start within 8000ms')
        await rollbackAudioTake('Аудиофайл не начал воспроизводиться.')
        return
      }

      let backdropWasCommitted = false
      if (backdropImage) {
        if (!outputWindowOpen) {
          const placementReady = await window.api.placePresentationWindow(selectedDisplayId ?? undefined)
          if (!placementReady) {
            log('audio backdrop window placement failed')
            await rollbackAudioTake('Не удалось подготовить фон для аудиофайла.')
            return
          }
        }
        if (isTakeCancelled()) {
          await finishCancelledTake()
          return
        }

        // Subscribe before load-content. The backdrop is staged in the spare
        // slot and only replaces the prior Electron layer after <img>.onLoad.
        const backdropReady = new Promise<{ ready: boolean; cancelled?: boolean }>((resolve) => {
          let settled = false
          let timeout: ReturnType<typeof setTimeout> | undefined
          let unsubscribe = (): void => {}
          let unsubscribeCommitted = (): void => {}
          let handleTakeCancelled = (): void => {}
          let committed = false
          const finish = (result: { ready: boolean; cancelled?: boolean }): void => {
            if (settled) return
            settled = true
            if (timeout) clearTimeout(timeout)
            unsubscribe()
            unsubscribeCommitted()
            window.removeEventListener('cancel-active-take', handleTakeCancelled)
            resolve(result)
          }
          handleTakeCancelled = (): void => finish({ ready: false, cancelled: true })
          unsubscribe = window.api.on('presentation-content-ready', (...args: unknown[]) => {
            const ready = args[0] as { takeId?: string }
            if (ready?.takeId !== takeId) return
            finish({ ready: true })
          })
          unsubscribeCommitted = window.api.on('presentation-content-committed', (...args: unknown[]) => {
            const marker = args[0] as { takeId?: string; type?: string }
            if (marker?.takeId !== takeId || marker.type !== 'backdrop') return
            committed = true
            log(`audio backdrop committed; awaiting painted ACK take=${takeId}`)
          })
          window.addEventListener('cancel-active-take', handleTakeCancelled)
          // Close the tiny gap between the check above and listener setup.
          if (isTakeCancelled()) {
            finish({ ready: false, cancelled: true })
            return
          }
          timeout = setTimeout(() => {
            const finishAfterCommitBoundary = (): void => {
              if (!committed) {
                finish({ ready: false })
                return
              }
              // The target image has loaded and the layer swap is queued. Give
              // the painted ACK a bounded cross-process grace instead of rolling
              // back an already-committed backdrop at the timeout boundary.
              timeout = setTimeout(() => finish({ ready: true }), 1_000)
            }
            if (committed) {
              finishAfterCommitBoundary()
              return
            }
            // The output renderer may have swapped at the exact deadline while
            // its IPC marker is still queued behind this timer. Keep listeners
            // alive briefly before deciding that the load itself timed out.
            timeout = setTimeout(finishAfterCommitBoundary, 500)
          }, 8_000)
        })
        if (!isTakeCancelled()) {
          window.api.sendToPresentation('load-content', {
            type: 'backdrop',
            path: backdropImage,
            name: 'Backdrop',
            takeId
          })
        }
        const backdropResult = await backdropReady
        if (backdropResult.cancelled || isTakeCancelled()) {
          await finishCancelledTake()
          return
        }
        if (!backdropResult.ready) {
          log('audio take aborted: backdrop did not paint within 8000ms')
          await rollbackAudioTake('Фон не успел подготовиться для аудиофайла.')
          return
        }
        backdropWasCommitted = true
        if (isTakeCancelled()) {
          await finishCancelledTake()
          return
        }
        if (!outputWindowOpen) {
          try {
            // The image has already painted in the opacity-zero warm renderer.
            // Reveal that completed frame behind PowerPoint, then release PPT.
            await window.api.openPresentationWindow(
              selectedDisplayId ?? undefined,
              deferPowerPointCloseUntilTargetReady
            )
            setPresentationWindowOpen(true)
          } catch (error) {
            log(`audio backdrop reveal failed: ${String(error)}`)
            await rollbackAudioTake('Не удалось показать подготовленный фон для аудиофайла.', true)
            return
          }
        }
      }

      if (isTakeCancelled()) {
        await finishCancelledTake()
        return
      }
      if (deferPowerPointCloseUntilTargetReady) {
        let closed = await window.api.powerpointCommand('close').catch((error: unknown) => ({
          success: false,
          error: String(error)
        }))
        if (!closed.success) {
          await new Promise((resolve) => setTimeout(resolve, 150))
          closed = await window.api.powerpointCommand('close').catch((error: unknown) => ({
            success: false,
            error: String(error)
          }))
        }
        if (!closed.success) {
          log(`PowerPoint close after audio readiness failed: ${closed.error || 'unknown error'}`)
          await rollbackAudioTake(
            closed.error || 'Не удалось завершить предыдущую презентацию PowerPoint.',
            backdropWasCommitted
          )
          return
        }
        log('live PowerPoint released only after audio and backdrop were ready')
      }
      const previousExternalMinimized = await minimizePreviousExternalAfterTargetReady()
      if (!previousExternalMinimized.success) {
        await rollbackAudioTake(
          previousExternalMinimized.error || 'Не удалось свернуть прежнее окно Word/Excel. Переключение на аудио отменено.',
          backdropWasCommitted
        )
        return
      }
      if (!backdropImage && useAppStore.getState().isPresentationWindowOpen) {
        await window.api.closePresentationWindow()
        setPresentationWindowOpen(false)
      }
      clearCommittedCaptureTitleSource('audio takeover')
      await window.api.hideOverlay()
      setOverlayState({ kind: 'hidden' })
      await releaseInactiveBrowserFullscreen()
      return
    }

    // For 'other' non-image files (Word, Excel, etc.), open/restore on external display
    if (channel.file.type === 'other' && !channel.file.isImage) {
      const displays = await window.api.getDisplays()
      if (isTakeCancelled()) {
        await finishCancelledTake()
        return
      }
      const outputState = useAppStore.getState()
      const requestedProgramDisplayId = outputState.selectedDisplayId
      const selectedExternal = displays.find((display) => (
        !display.isPrimary && display.id === requestedProgramDisplayId
      ))
      const external = requestedProgramDisplayId === null
        ? displays.find((display) => !display.isPrimary)
        : selectedExternal
      if (!external) {
        useAppStore.setState({
          activeFile: prevActiveFile,
          liveChannel: freshState.liveChannel
        })
        await window.api.hideOverlay()
        setOverlayState({ kind: 'hidden' })
        setTakeProgress({
          channelId: ch,
          message: 'Главный эфирный дисплей не подключён.'
        })
        await new Promise((resolve) => setTimeout(resolve, 3500))
        return
      }
      const selectedSceneCapture = outputState.captureSources.find(
        (entry) => entry.capture?.sourceId === outputState.programScene.captureSourceId
      )?.capture ?? null
      const officeProgramSceneActive = OFFICE_ZOOM_EXT.has(channel.file.extension.toLowerCase()) &&
        outputState.programScene.enabled &&
        !!outputState.backdropImage &&
        !!selectedSceneCapture
      const officeSceneLayout = officeProgramSceneActive
        ? {
            enabled: true,
            placement: outputState.programScene.placement,
            participantSize: outputState.programScene.participantSize,
            participantScale: outputState.programScene.participantScale,
            cornerStyle: outputState.programScene.cornerStyle,
            viewMode: outputState.programScene.viewMode,
            transitionEffect: outputState.programScene.transitionEffect,
            transitionDurationMs: outputState.programScene.transitionDurationMs,
            contentAspectRatio: null
          } as const
        : undefined
      if (officeProgramSceneActive && selectedSceneCapture) {
        // Prepare the backdrop/camera surface before raising Word/Excel. The
        // transition cover remains above both windows until the exact Office
        // HWND has been placed and verified inside its content pane.
        await window.api.openPresentationWindow(external.id, true)
        setPresentationWindowOpen(true)
        window.api.sendToPresentation('capture-source-register', selectedSceneCapture)
        window.api.sendToPresentation('program-scene-update', {
          active: true,
          capture: selectedSceneCapture,
          backdropPath: outputState.backdropImage,
          placement: outputState.programScene.placement,
          participantSize: outputState.programScene.participantSize,
          participantScale: outputState.programScene.participantScale,
          cornerStyle: outputState.programScene.cornerStyle,
          viewMode: outputState.programScene.viewMode,
          transitionEffect: outputState.programScene.transitionEffect,
          transitionDurationMs: outputState.programScene.transitionDurationMs,
          contentAspectRatio: null
        })
        log('Office program scene underlay prepared')
      }
      // Hide taskbar FIRST, wait for Windows to update work area, then position window
      await window.api.hideTaskbar(external.bounds)
      await new Promise((r) => setTimeout(r, 500))
      if (isTakeCancelled()) {
        await finishCancelledTake()
        return
      }

      // Try to restore; if not tracked yet, open fresh. Do not commit a
      // logical TAKE or tear down the previous visual output until Windows has
      // confirmed that the new native document is on the selected display.
      const targetWasPreviousExternal =
        prevActiveFile?.type === 'other' &&
        !prevActiveFile.isImage &&
        !prevActiveFile.isAudio &&
        prevActiveFile.path === channel.file.path
      const settleExternalTakeFailure = async (message: string): Promise<void> => {
        let targetClosed: { success: boolean; error?: string } = { success: true }
        if (!targetWasPreviousExternal) {
          // A failed open may never have created/tracked a HWND. Closing is
          // intentionally idempotent: an untracked target is already gone,
          // while a partially-created window must be verified as destroyed.
          targetClosed = await window.api.closeExternalFile(channel.file!.path).catch((error: unknown) => ({
            success: false,
            error: String(error)
          }))
        }
        const retainedFile = targetClosed.success ? prevActiveFile : channel.file
        const retainedLiveChannel = targetClosed.success ? freshState.liveChannel : ch
        if (!targetClosed.success) {
          // The failed target window is still physically present. Make it the
          // truthful native output and release any PDF/video/capture underlay.
          window.api.sendToPresentation('clear-active-content')
          if (useAppStore.getState().isPresentationWindowOpen) {
            await window.api.closePresentationWindow()
            setPresentationWindowOpen(false)
          }
        }
        useAppStore.setState({ activeFile: retainedFile, liveChannel: retainedLiveChannel })
        if (retainedFile) window.api.setActiveContentType(retainedFile.type)
        await window.api.hideOverlay()
        setOverlayState({ kind: 'hidden' })
        setTakeProgress({
          channelId: ch,
          message: targetClosed.success
            ? message
            : `${message} ${targetClosed.error || 'Новое окно Word/Excel не удалось закрыть; оно оставлено текущим эфиром.'}`
        })
        await new Promise((resolve) => setTimeout(resolve, 3500))
      }
      const restored = await window.api.restoreExternalFile(channel.file.path, external.bounds, officeSceneLayout)
      if (!restored.success) {
        log(`external document restore failed: ${restored.error || 'unknown error'}`)
        await settleExternalTakeFailure(
          restored.error || 'Не удалось вывести окно программы на главный эфирный дисплей.'
        )
        return
      }
      if (isTakeCancelled()) {
        await finishCancelledTake()
        return
      }

      // Verify the same HWND a second time before touching the previous
      // output. This absorbs slow Office maximize/focus transitions without
      // turning a failed TAKE into a blank program display.
      let foregrounded = await window.api.restoreExternalFile(channel.file.path, external.bounds, officeSceneLayout)
      if (!foregrounded.success) {
        await new Promise((resolve) => setTimeout(resolve, 150))
        foregrounded = await window.api.restoreExternalFile(channel.file.path, external.bounds, officeSceneLayout)
      }
      if (!foregrounded.success) {
        log(`external document foreground verification failed: ${foregrounded.error || 'unknown error'}`)
        await settleExternalTakeFailure(
          foregrounded.error || 'Не удалось вывести окно программы поверх главного эфира.'
        )
        return
      }
      if (isTakeCancelled()) {
        await finishCancelledTake()
        return
      }

      // Only now replace the surface behind Word/Excel and stop the previous
      // native output. Never raise a newly-created backdrop window above the
      // verified Office window; the idle-output path will create it on exit.
      const { backdropImage } = useAppStore.getState()
      const outputWindowOpen = useAppStore.getState().isPresentationWindowOpen
      if (outputWindowOpen) {
        // Word/Excel is already verified in front. Unmount the old hidden
        // PDF/video now; a backdrop load failure must never retain its heavy
        // document/decoder indefinitely behind the native Office window.
        window.api.sendToPresentation('clear-active-content')
        if (officeProgramSceneActive && selectedSceneCapture) {
          window.api.sendToPresentation('capture-source-register', selectedSceneCapture)
          window.api.sendToPresentation('program-scene-update', {
            active: true,
            capture: selectedSceneCapture,
            backdropPath: backdropImage,
            placement: outputState.programScene.placement,
            participantSize: outputState.programScene.participantSize,
            participantScale: outputState.programScene.participantScale,
            cornerStyle: outputState.programScene.cornerStyle,
            viewMode: outputState.programScene.viewMode,
            transitionEffect: outputState.programScene.transitionEffect,
            transitionDurationMs: outputState.programScene.transitionDurationMs,
            contentAspectRatio: null
          })
        } else if (backdropImage) {
          window.api.sendToPresentation('load-content', {
            type: 'backdrop',
            path: backdropImage,
            name: 'Backdrop'
          })
        } else {
          await window.api.closePresentationWindow()
          setPresentationWindowOpen(false)
        }
      }
      if (prevActiveFile?.type === 'presentation') {
        let closed = await window.api.powerpointCommand('close')
        if (!closed.success) {
          await new Promise((resolve) => setTimeout(resolve, 150))
          closed = await window.api.powerpointCommand('close')
        }
        if (!closed.success) {
          log(`PowerPoint close before external TAKE failed: ${closed.error || 'unknown error'}`)
          await settleExternalTakeFailure(
            closed.error || 'Не удалось завершить предыдущую презентацию PowerPoint.'
          )
          return
        }
      }
      if (
        prevActiveFile?.type === 'other' &&
        !prevActiveFile.isImage &&
        !prevActiveFile.isAudio &&
        prevActiveFile.path !== channel.file.path
      ) {
        const previousMinimized = await window.api.minimizeExternalFile(prevActiveFile.path)
        if (!previousMinimized.success) {
          let targetRemoved = await window.api.minimizeExternalFile(channel.file.path).catch((error: unknown) => ({
            success: false,
            error: String(error)
          }))
          if (!targetRemoved.success) {
            targetRemoved = await window.api.closeExternalFile(channel.file.path).catch((error: unknown) => ({
              success: false,
              error: String(error)
            }))
          }
          const previousRestored = await window.api.restoreExternalFile(
            prevActiveFile.path,
            external.bounds,
            OFFICE_ZOOM_EXT.has(prevActiveFile.extension.toLowerCase()) ? officeSceneLayout : undefined
          )
          const previousIsAuthoritative = targetRemoved.success || previousRestored.success
          if (previousIsAuthoritative) {
            useAppStore.setState({ activeFile: prevActiveFile, liveChannel: freshState.liveChannel })
            window.api.setActiveContentType(prevActiveFile.type)
          } else {
            useAppStore.setState({ activeFile: channel.file, liveChannel: ch })
            window.api.setActiveContentType(channel.file.type)
          }
          await window.api.hideOverlay()
          setOverlayState({ kind: 'hidden' })
          setTakeProgress({
            channelId: ch,
            message: previousMinimized.error || (
              previousIsAuthoritative
                ? 'Не удалось свернуть прежнее окно Word/Excel. Переключение отменено.'
                : 'Windows не завершила переключение окон Word/Excel. Проверьте эфирный дисплей и повторите действие.'
            )
          })
          await new Promise((resolve) => setTimeout(resolve, 3500))
          return
        }
      }
      if (prevActiveFile?.type === 'capture') {
        window.api.sendToPresentation('capture-audio-live', null)
      }
      if (isTakeCancelled()) {
        await finishCancelledTake()
        return
      }
      // Closing PowerPoint or minimizing the previous Office document can
      // change foreground ownership. Make the new Word/Excel HWND the final
      // verified z-order operation before the transition cover disappears.
      const finalForeground = await window.api.restoreExternalFile(
        channel.file.path,
        external.bounds,
        officeSceneLayout
      )
      if (!finalForeground.success) {
        await settleExternalTakeFailure(
          finalForeground.error || 'Word/Excel не удалось закрепить поверх фона и камеры.'
        )
        return
      }
      if (officeProgramSceneActive && outputState.programScene.viewMode === 'participant') {
        await window.api.raisePresentationWindow()
        log('participant focus restored above ready Word/Excel window')
      }
      clearCommittedCaptureTitleSource('external document takeover')
      await window.api.hideOverlay()
      setOverlayState({ kind: 'hidden' })
      await releaseInactiveBrowserFullscreen()
      return
    }

    const outputWindowWasOpen = useAppStore.getState().isPresentationWindowOpen
    const programDisplayId = useAppStore.getState().selectedDisplayId ?? undefined
    // A warm PDF/video surface survives underneath native PowerPoint to keep
    // transitions fast and flicker-free. If the primary program display was
    // changed while that surface was parked, move it before preparing the next
    // Chromium frame. This operation deliberately does not touch opacity or
    // z-order, so the existing seamless transition remains intact.
    const presentationPlacementReady = await window.api.placePresentationWindow(programDisplayId)
    if (!presentationPlacementReady) {
      log(`presentation output placement failed display=${programDisplayId ?? 'default'}`)
      useAppStore.setState({
        activeFile: prevActiveFile,
        liveChannel: freshState.liveChannel
      })
      await window.api.hideOverlay()
      setOverlayState({ kind: 'hidden' })
      setTakeProgress({
        channelId: ch,
        message: 'Не удалось подготовить главный эфирный дисплей.'
      })
      await new Promise((resolve) => setTimeout(resolve, 3500))
      return
    }
    const revealWarmOutputAfterPaint =
      !outputWindowWasOpen && prevActiveFile?.type === 'presentation'
    if (!outputWindowWasOpen && !revealWarmOutputAfterPaint) {
      await window.api.openPresentationWindow(programDisplayId)
      setPresentationWindowOpen(true)
    }
    if (isTakeCancelled()) {
      await finishCancelledTake()
      return
    }

    // Subscribe BEFORE sending load-content so we can't miss the signal.
    // PdfViewer emits 'presentation-content-ready' after its first drawImage;
    // <img> elements emit it after onLoad; VideoViewer emits it after the
    // first decoded frame is submitted for composition.
    const contentReady = new Promise<{ ready: boolean; error?: string; cancelled?: boolean }>((resolve) => {
      const timeoutMs = channel.file?.type === 'capture'
        ? 16_000
        : channel.file?.type === 'video'
          ? 12_000
          : channel.file?.type === 'pdf'
            ? 10_000
            : 8_000
      let settled = false
      let timeout: ReturnType<typeof setTimeout> | undefined
      let unsubReady = (): void => {}
      let unsubError = (): void => {}
      let unsubPrepared = (): void => {}
      let unsubCommitted = (): void => {}
      let captureCommitSent = false
      let slotCommitSeen = false
      let handleTakeCancelled = (): void => {}
      const finish = (
        result: { ready: boolean; error?: string; cancelled?: boolean },
        reason: 'received' | 'timeout' | 'error' | 'cancelled' | 'committed'
      ): void => {
        if (settled) return
        settled = true
        if (timeout) clearTimeout(timeout)
        unsubReady()
        unsubError()
        unsubPrepared()
        unsubCommitted()
        window.removeEventListener('cancel-active-take', handleTakeCancelled)
        log(
          reason === 'received'
            ? 'content-ready received'
            : reason === 'committed'
              ? 'content-ready ACK timeout after commit; committed output retained'
            : reason === 'cancelled'
              ? 'content-ready CANCELLED by operator'
            : reason === 'error'
              ? `content-ready ERROR ${result.error ?? '-'}`
              : `content-ready TIMEOUT (${timeoutMs}ms)`
        )
        resolve(result)
      }
      handleTakeCancelled = (): void => finish(
        { ready: false, cancelled: true, error: 'TAKE отменён оператором.' },
        'cancelled'
      )
      unsubReady = window.api.on('presentation-content-ready', (...args: unknown[]) => {
        const ready = args[0] as { takeId?: string }
        if (ready?.takeId !== takeId) return
        finish({ ready: true }, 'received')
      })
      unsubPrepared = window.api.on('presentation-content-prepared', (...args: unknown[]) => {
        const prepared = args[0] as { takeId?: string; type?: string; sourceId?: string }
        if (
          captureCommitSent ||
          channel.file?.type !== 'capture' ||
          prepared?.takeId !== takeId ||
          prepared.type !== 'capture' ||
          prepared.sourceId !== channel.file.capture?.sourceId
        ) return
        captureCommitSent = true
        log(`capture prepared; committing take=${takeId}`)
        window.api.sendToPresentation('commit-content-load', { takeId })
      })
      unsubCommitted = window.api.on('presentation-content-committed', (...args: unknown[]) => {
        const committed = args[0] as { takeId?: string; type?: string }
        if (committed?.takeId !== takeId || channel.file?.type === 'capture') return
        slotCommitSeen = true
        log(`content committed; awaiting painted ACK take=${takeId}`)
      })
      unsubError = window.api.on('presentation-content-error', (...args: unknown[]) => {
        const error = args[0] as { takeId?: string; type?: string; sourceId?: string; message?: string }
        if (channel.file?.type !== 'capture' || error?.type !== 'capture') return
        if (error.takeId !== takeId) return
        if (error.sourceId && error.sourceId !== channel.file.capture?.sourceId) return
        finish({ ready: false, error: error.message || 'Внешний источник не готов.' }, 'error')
      })
      window.addEventListener('cancel-active-take', handleTakeCancelled)
      // Slow machines and high-bitrate local videos can need more than two
      // seconds to initialize a decoder. Do not capture the window while it
      // is still black unless the renderer genuinely failed to become ready.
      // CaptureHub allows a cold desktop stream up to 12 seconds for its first
      // frame and its TAKE waiter up to 14 seconds. Keep the controller's
      // outer timeout last in the chain so it cannot cancel a nearly-ready
      // Word/Excel capture like the previous 7s/8s race did.
      timeout = setTimeout(() => {
        if (channel.file?.type === 'capture' && captureCommitSent) {
          finish({ ready: true }, 'committed')
          return
        }
        const finishAfterSlotCommitBoundary = (): void => {
          if (!slotCommitSeen) {
            const typeLabel = channel.file?.type === 'video'
              ? 'Видео'
              : channel.file?.type === 'pdf'
                ? 'PDF'
                : 'Контент'
            finish({
              ready: false,
              error: `${typeLabel} не успел подготовить первый кадр за ${Math.round(timeoutMs / 1000)} с.`
            }, 'timeout')
            return
          }
          // The target has a real frame and its layer swap is queued. Keep
          // waiting briefly for the painted ACK; never issue
          // cancel-content-load against an already committed slot.
          timeout = setTimeout(() => finish({ ready: true }, 'committed'), 1_000)
        }
        if (slotCommitSeen) {
          finishAfterSlotCommitBoundary()
          return
        }
        if (channel.file?.type === 'capture') {
          finish({ ready: false, error: 'Видеосигнал не появился за 16 секунд.' }, 'timeout')
          return
        }
        // A renderer can cross the commit boundary just before this timer while
        // the committed/ready IPC is still queued. Preserve both listeners for
        // a short delivery grace before issuing a transactional cancel.
        timeout = setTimeout(finishAfterSlotCommitBoundary, 500)
      }, timeoutMs)
    })

    const savedVideo = channel.file.type === 'video' && !adHoc
      ? useAppStore.getState().videoPlayback[channel.file.path]
      : undefined
    if (savedVideo) {
      log(`video restore: time=${savedVideo.currentTime.toFixed(3)} savedPlaying=${savedVideo.playing} startPaused=true`)
    }

    if (channel.file.type === 'capture' && channel.file.capture) {
      // Idempotent registration also recovers a source if the prewarmed output
      // renderer was recreated after a display change.
      window.api.sendToPresentation('capture-source-register', channel.file.capture)
    }
    window.api.sendToPresentation('load-content', {
      type: channel.file.type,
      path: channel.file.path,
      name: channel.file.name,
      startSlide: channel.slide,
      startTime: savedVideo?.currentTime,
      autoplay: channel.file.type === 'video'
        ? adHoc?.videoAutoplay ?? false
        : undefined,
      isImage: channel.file.isImage,
      capture: channel.file.capture,
      captureAudioOnCommit: channel.file.type === 'capture'
        ? prevActiveFile?.type !== 'presentation'
        : undefined,
      takeId
    })
    if (channel.file.type === 'video') {
      // Channel videos are single-shot cues. Do not inherit a loop flag that
      // may have been enabled earlier in the independent video playlist;
      // otherwise `ended` never fires and the configured channel transition
      // can never run.
      window.api.sendToPresentation('set-loop', adHoc?.videoLoop ?? false)
    }

    const readiness = await contentReady
    if (readiness.cancelled || isTakeCancelled()) {
      log('TAKE stopped after operator cancellation')
      await finishCancelledTake()
      return
    }
    if (!readiness.ready) {
      window.api.sendToPresentation('cancel-content-load', { takeId })
      log(`${channel.file.type} take aborted; previous output preserved error=${readiness.error ?? '-'}`)
      useAppStore.setState({
        activeFile: prevActiveFile,
        liveChannel: freshState.liveChannel,
        currentSlide: freshState.currentSlide,
        totalSlides: freshState.totalSlides,
        isPlaying: freshState.isPlaying
      })
      if (prevActiveFile) {
        window.api.setActiveContentType(prevActiveFile.type)
      } else if (freshState.backdropImage) {
        window.api.setActiveContentType('backdrop')
      } else {
        window.api.sendToPresentation('clear-active-content')
      }
      if (!prevActiveFile && !outputWindowWasOpen && useAppStore.getState().isPresentationWindowOpen) {
        await window.api.closePresentationWindow()
        setPresentationWindowOpen(false)
      }
      await window.api.hideOverlay()
      setOverlayState({ kind: 'hidden' })
      return
    }
    if (channel.file.type !== 'capture' && prevActiveFile?.type === 'capture') {
      window.api.sendToPresentation('capture-audio-live', null)
    }
    // The target is already painted in the persistent output window underneath
    // the old freeze frame. Reveal it directly: capturePage→PNG→base64→decode
    // added 300–2600ms and created a second visible image boundary of its own.
    if (channel.file.type === 'pdf') {
      // Apply clicks accumulated during PDF startup while the old frame still
      // covers the output. The short quiet window catches a key delivered at
      // the same DWM boundary without taking another 4K screenshot.
      for (let pass = 1; pass <= MAX_MATCHED_FRAME_PASSES; pass++) {
        await applyQueuedNavigationUnderOverlay('pdf')
        if (!(await waitForLateNavigation())) break
        log('navigation arrived before PDF reveal; applying under old frame')
      }
    }
    if (isTakeCancelled()) {
      await finishCancelledTake()
      return
    }
    const previousExternalMinimized = await minimizePreviousExternalAfterTargetReady()
    if (!previousExternalMinimized.success) {
      window.api.sendToPresentation('capture-audio-live', null)
      window.api.sendToPresentation('clear-active-content')
      if (useAppStore.getState().isPresentationWindowOpen) {
        await window.api.closePresentationWindow()
        setPresentationWindowOpen(false)
      }
      if (previousExternalFile) {
        useAppStore.setState({ activeFile: previousExternalFile, liveChannel: freshState.liveChannel })
        window.api.setActiveContentType(previousExternalFile.type)
      }
      await window.api.hideOverlay()
      setOverlayState({ kind: 'hidden' })
      setTakeProgress({
        channelId: ch,
        message: previousExternalMinimized.error || 'Не удалось свернуть прежнее окно Word/Excel. Переключение отменено.'
      })
      await new Promise((resolve) => setTimeout(resolve, 3500))
      return
    }
    if (revealWarmOutputAfterPaint) {
      // Keep the fullscreen Electron HWND transparent while its new PDF/video
      // is rendered. Promoting it before content-ready caused PDF→PPTX→PDF
      // flashes above the old-frame overlay. The active z-order guard masks
      // this single final opacity promotion.
      await window.api.openPresentationWindow(
        useAppStore.getState().selectedDisplayId ?? undefined,
        deferPowerPointCloseUntilTargetReady
      )
      setPresentationWindowOpen(true)
      log(deferPowerPointCloseUntilTargetReady
        ? 'painted Electron target revealed behind live PowerPoint'
        : 'warm output revealed only after target paint')
    }
    if (isTakeCancelled()) {
      await finishCancelledTake()
      return
    }
    if (deferPowerPointCloseUntilTargetReady) {
      const closed = await window.api.powerpointCommand('close')
      if (!closed.success) {
        log(`PowerPoint close failed; prepared target discarded: ${closed.error || 'unknown error'}`)
        window.api.sendToPresentation('clear-active-content')
        if (useAppStore.getState().isPresentationWindowOpen) {
          await window.api.closePresentationWindow()
          setPresentationWindowOpen(false)
        }
        useAppStore.setState({ activeFile: prevActiveFile, liveChannel: freshState.liveChannel })
        window.api.setActiveContentType('presentation')
        await window.api.hideOverlay()
        setOverlayState({ kind: 'hidden' })
        setTakeProgress({
          channelId: ch,
          message: closed.error || 'Не удалось освободить предыдущую презентацию PowerPoint.'
        })
        await new Promise((resolve) => setTimeout(resolve, 3500))
        return
      }
      log('live PowerPoint closed and released only after Electron target was ready underneath')
    }
    if (isTakeCancelled()) {
      await finishCancelledTake()
      return
    }
    if (channel.file.type === 'capture') {
      window.api.sendToPresentation('capture-audio-live', channel.file.capture?.sourceId ?? null)
    }
    const shouldPinPdfTarget =
      !useSeamlessLayerSwitch &&
      channel.file.type === 'pdf' &&
      (prevActiveFile?.type === 'presentation' || prevActiveFile?.type === 'video')
    if (shouldPinPdfTarget) {
      log('target capture: PDF BEGIN')
      const targetSwapped = await window.api.captureAndSwapOverlay()
      log(`target capture: PDF END swapped=${targetSwapped}`)
      if (isTakeCancelled()) {
        await finishCancelledTake()
        return
      }
      if (targetSwapped) {
        await window.api.pinOverlay()
        setOverlayState({ kind: 'pinned-pdf', pdfPath: channel.file.path })
        log('atomic target swap complete: PDF frame pinned until navigation')
        await releaseInactiveBrowserFullscreen()
        return
      }
    }
    log(useSeamlessLayerSwitch
      ? 'seamless layer switch complete: prepared target exposed once'
      : 'direct reveal: target output ready')
    if (isTakeCancelled()) {
      await finishCancelledTake()
      return
    }
    await window.api.hideOverlay()
    setOverlayState({ kind: 'hidden' })
    await releaseInactiveBrowserFullscreen()
  }

  // The toolbar playlist is an ad-hoc source rather than a channel, but it
  // still changes the same physical program output. Run it through doTake so
  // native windows and previous captures retire only after the first decoded
  // video frame has painted.
  useEffect(() => {
    const handler = (event: Event): void => {
      const detail = (event as CustomEvent<{
        file?: FileEntry
        loop?: boolean
      }>).detail
      if (!detail?.file || detail.file.type !== 'video') return

      const targetFile = detail.file
      const targetLoop = detail.loop === true
      void (async () => {
        const releaseOutputTransition = await acquireOutputTransition(
          `playlist-video:${targetFile.path}`
        )
        const marker: ChannelId = '__playlist_video__'
        const takeId = crypto.randomUUID()
        const takeGeneration = ++takeGenerationRef.current
        takeInFlightRef.current = marker
        activeTakeIdRef.current = takeId
        try {
          beginNavigationTransition()
          const state = useAppStore.getState()
          if (state.contentZoom.enabled) state.setContentZoom(DEFAULT_CONTENT_ZOOM)
          if (state.overlayState.kind === 'blocked') {
            window.alert(state.overlayState.reason)
            return
          }

          await doTake(marker, takeId, takeGeneration, {
            channel: {
              file: targetFile,
              slide: 1,
              totalSlides: 0,
              videoEndChannel: null,
              caption: ''
            },
            liveChannel: null,
            videoAutoplay: true,
            videoLoop: targetLoop
          })

          const resultState = useAppStore.getState()
          if (
            resultState.activeFile?.type !== 'video' ||
            resultState.activeFile.path !== targetFile.path ||
            resultState.liveChannel !== null
          ) {
            resultState.setVideoIsPlaying(false)
            window.alert('Не удалось вывести видеоролик в эфир. Предыдущий источник оставлен без изменений.')
          } else {
            // Re-apply after the new VideoViewer has mounted; the immediate
            // command sent during staging can still be received by the old
            // slot when React has not committed the spare slot yet.
            window.api.sendToPresentation('set-loop', targetLoop)
            window.api.setActiveContentType('video')
          }
        } catch (error) {
          console.error('[PLAYLIST VIDEO TAKE] unhandled error:', error)
          useAppStore.getState().setVideoIsPlaying(false)
          try { await window.api.hideOverlay() } catch { /* last resort */ }
          setOverlayState({ kind: 'hidden' })
          window.alert(`Не удалось вывести видеоролик в эфир: ${String(error)}`)
        } finally {
          try {
            const mirrorResult = await window.api.completeProgramMirrorTransition(takeId)
            window.api.dbgLog(
              `playlist video mirror transition complete id=${takeId} ` +
              `released=${mirrorResult.released} remaining=${mirrorResult.remaining}`
            )
          } catch (error) {
            window.api.dbgLog(`playlist video mirror transition completion failed id=${takeId}: ${String(error)}`)
          }
          finishNavigationTransition()
          if (takeInFlightRef.current === marker) takeInFlightRef.current = null
          if (activeTakeIdRef.current === takeId) activeTakeIdRef.current = null
          if (cancelTakeCleanupRef.current?.takeId === takeId) cancelTakeCleanupRef.current = null
          releaseOutputTransition()

          const queued = queuedTakeRef.current
          queuedTakeRef.current = null
          if (queued && useAppStore.getState().channels[queued]?.file) {
            void handleTake(queued)
          }
        }
      })()
    }

    window.addEventListener('take-playlist-video', handler)
    return () => window.removeEventListener('take-playlist-video', handler)
  })

  // Listen for take-channel events from Toolbar's Open Output button
  useEffect(() => {
    const handler = (e: Event): void => {
      const ch = (e as CustomEvent).detail as ChannelId
      handleTake(ch)
    }
    window.addEventListener('take-channel', handler)
    return () => window.removeEventListener('take-channel', handler)
  })

  // A channel video can hand the live output to one explicitly selected
  // channel when playback reaches its natural end. The source path guards
  // against a late `ended` event from a video that has already left the air.
  useEffect(() => {
    return window.api.on('video-ended', (...args: unknown[]) => {
      const data = args[0] as { path?: string } | undefined
      const state = useAppStore.getState()
      const sourceChannelId = state.liveChannel
      if (!sourceChannelId || state.activeFile?.type !== 'video') return
      const sourceChannel = state.channels[sourceChannelId]
      if (!sourceChannel?.file || sourceChannel.file.type !== 'video') return
      if (data?.path && data.path !== sourceChannel.file.path) {
        window.api.dbgLog(
          `video-end channel switch ignored stale path=${data.path} live=${sourceChannel.file.path}`
        )
        return
      }

      const targetChannelId = sourceChannel.videoEndChannel
      if (!targetChannelId) return
      if (!state.channels[targetChannelId]?.file || targetChannelId === sourceChannelId) {
        state.setChannelVideoEndChannel(sourceChannelId, null)
        window.api.dbgLog(
          `video-end channel switch cleared invalid target source=${sourceChannelId} target=${targetChannelId}`
        )
        return
      }

      state.setSelectedChannel(targetChannelId)
      const targetIndex = state.channelIds.indexOf(targetChannelId)
      if (targetIndex >= 0) {
        state.setCurrentChannelPage(Math.floor(targetIndex / state.channelGridSize))
      }
      window.api.dbgLog(
        `video-end channel switch source=${sourceChannelId} target=${targetChannelId} path=${sourceChannel.file.path}`
      )
      void handleTake(targetChannelId)
    })
  })

  return (
    <div className="pdm-preview-panel flex-1 flex flex-col overflow-hidden">
      <div className="pdm-preview-header shrink-0 h-8 bg-surface-300 border-b border-gray-800 flex items-center justify-between px-3 select-none">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">Каналы</span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setChannelGridSize(nextChannelGridSize)}
            className="h-6 w-6 shrink-0 rounded-md border border-gray-700 bg-surface-100 text-gray-400 hover:border-gray-600 hover:bg-surface-200 hover:text-white transition-colors flex items-center justify-center"
            title={channelGridSize === 4 ? 'Показать 9 каналов сеткой 3×3' : 'Показать 4 канала сеткой 2×2'}
            aria-label={channelGridSize === 4 ? 'Переключить на 9 каналов' : 'Переключить на 4 канала'}
          >
            <span
              aria-hidden="true"
              className={`grid h-3.5 w-3.5 ${
                nextChannelGridSize === 4
                  ? 'grid-cols-2 grid-rows-2 gap-[2px]'
                  : 'grid-cols-3 grid-rows-3 gap-px'
              }`}
            >
              {Array.from({ length: nextChannelGridSize }).map((_, index) => (
                <span
                  key={index}
                  className={`${nextChannelGridSize === 4 ? 'rounded-[1.5px]' : 'rounded-full'} bg-current`}
                />
              ))}
            </span>
          </button>
          <button
            onClick={() => addChannelPage()}
            title={`Добавить ${channelGridSize} каналов на новой странице`}
            className="h-6 min-w-6 rounded-md border border-gray-700 bg-surface-100 px-2 text-sm leading-none text-gray-300 hover:border-accent/70 hover:bg-accent/80 hover:text-white transition-colors"
          >
            +
          </button>
        </div>
      </div>

      <div className={`pdm-channel-grid flex-1 grid overflow-hidden relative ${
        channelGridSize === 9
          ? 'grid-cols-3 grid-rows-3 gap-1.5 p-2'
          : 'grid-cols-2 grid-rows-2 gap-2 p-3'
      }`}>
        {pageIds.map((id) => {
          const channel = channels[id] || { file: null, slide: 1, totalSlides: 0, videoEndChannel: null, caption: '' }
          return (
            <ChannelPanel
              key={id}
              label={id}
              channel={channel}
              isLive={liveChannel === id}
              isSelected={selectedChannel === id}
              isTaking={takeProgress?.channelId === id}
              openingMessage={takeProgress?.channelId === id ? takeProgress.message : null}
              onDrop={(file) => setChannelFile(id, file)}
              onSlideChange={(s) => setChannelSlide(id, s)}
              onSetTotalSlides={(t) => setChannelTotalSlides(id, t)}
              onVideoEndChannelChange={(target) => setChannelVideoEndChannel(id, target)}
              onCaptionChange={(caption) => setChannelCaption(id, caption)}
              onSelect={() => setSelectedChannel(id)}
              onTake={() => handleTake(id)}
              onClear={() => handleClear(id)}
              pptxThumbnails={channel.file ? pptxThumbnailsMap[channel.file.path] || [] : []}
              cacheStatus={channel.file?.type === 'presentation'
                ? pptxCacheStatuses[channel.file.path]
                : channel.file?.type === 'pdf'
                  ? pdfCacheStatuses[channel.file.path]
                  : undefined}
              videoEndChannelOptions={channelIds.filter((targetId) => (
                targetId !== id && Boolean(channels[targetId]?.file)
              ))}
              compact={channelGridSize === 9}
            />
          )
        })}
      </div>

      {/* Pagination footer — показываем только если есть больше одной страницы.
          Dots wrapped в overflow-x-auto чтобы при 30+ страницах они не
          выталкивали кнопку удаления за край окна. ✕ delete placed вне
          scrollable — всегда доступен на правом краю. */}
      {totalPages > 1 && (
        <div className="pdm-pagination shrink-0 h-8 bg-surface-300 border-t border-gray-800 flex items-center gap-1 px-3 select-none">
          <button
            onClick={() => setCurrentChannelPage(currentChannelPage - 1)}
            disabled={currentChannelPage === 0}
            className="shrink-0 w-7 h-6 rounded-sm text-gray-400 hover:text-white hover:bg-gray-700 disabled:opacity-30 disabled:hover:bg-transparent transition-colors text-sm"
            title="Предыдущая страница"
          >
            ‹
          </button>

          {/* Dots с указанием страницы где live.
              flex-1 + min-w-0 позволяет контейнеру сжиматься и скроллиться
              при большом количестве страниц. justify-center внутри центрирует
              точки когда их мало, но overflow-x-auto даёт скролл когда много.
              onWheel: превращаем вертикальную прокрутку колёсика (deltaY)
              в горизонтальный scrollLeft — юзер крутит мышь прямо по точкам
              без Shift. */}
          <div
            className="flex-1 min-w-0 overflow-x-auto"
            onWheel={(e) => {
              if (e.deltaY !== 0) {
                e.currentTarget.scrollLeft += e.deltaY
              }
            }}
          >
            <div className="flex items-center gap-1 px-1 justify-center min-w-min">
              {Array.from({ length: totalPages }).map((_, i) => {
                const isActive = i === currentChannelPage
                const isLive = i === liveChannelPage
                return (
                  <button
                    key={i}
                    onClick={() => setCurrentChannelPage(i)}
                    className={`shrink-0 min-w-[22px] h-5 px-1.5 rounded text-[10px] font-medium transition-colors ${
                      isActive
                        ? 'bg-blue-600/80 text-white'
                        : isLive
                        ? 'bg-red-900/50 text-red-300 hover:bg-red-800/60'
                        : 'bg-surface-100 text-gray-400 hover:bg-gray-700 hover:text-white'
                    }`}
                    title={isLive ? `Страница ${i + 1} — в эфире` : `Страница ${i + 1}`}
                  >
                    {i + 1}
                    {isLive && <span className="ml-0.5">●</span>}
                  </button>
                )
              })}
            </div>
          </div>

          <button
            onClick={() => setCurrentChannelPage(currentChannelPage + 1)}
            disabled={currentChannelPage >= totalPages - 1}
            className="shrink-0 w-7 h-6 rounded-sm text-gray-400 hover:text-white hover:bg-gray-700 disabled:opacity-30 disabled:hover:bg-transparent transition-colors text-sm"
            title="Следующая страница"
          >
            ›
          </button>

          {/* Удалить страницу (если она не единственная и не live).
              shrink-0 + вне scrollable: кнопка всегда видна и доступна.
              Если на странице есть файлы — confirm() + очистка перед
              removeChannelPage (store сам не удаляет непустые страницы,
              поэтому чистим channel.file у всех каналов страницы). */}
          {totalPages > 1 && liveChannelPage !== currentChannelPage && (
            <button
              onClick={() => {
                if (!currentPageIsEmpty) {
                  const ok = window.confirm(
                    'На странице есть материалы или подписи каналов. Удалить страницу со всем содержимым?'
                  )
                  if (!ok) return
                  pageIds.forEach((id) => {
                    setChannelFile(id, null)
                    setChannelCaption(id, '')
                  })
                }
                removeChannelPage(currentChannelPage)
              }}
              className="shrink-0 ml-1 w-6 h-6 rounded-sm text-gray-500 hover:text-red-400 hover:bg-red-900/30 transition-colors text-xs"
              title={currentPageIsEmpty ? 'Удалить страницу' : 'Удалить страницу (с подтверждением)'}
            >
              ✕
            </button>
          )}
        </div>
      )}
    </div>
  )
}

interface ChannelPanelProps {
  label: ChannelId
  channel: ChannelState
  isLive: boolean
  isSelected: boolean
  isTaking: boolean
  openingMessage: string | null
  onDrop: (file: FileEntry) => void
  onSlideChange: (slide: number) => void
  onSetTotalSlides: (total: number) => void
  onVideoEndChannelChange: (target: ChannelId | null) => void
  onCaptionChange: (caption: string) => void
  onSelect: () => void
  onTake: () => void
  onClear: () => void
  pptxThumbnails: string[]
  cacheStatus?: ChannelCacheStatus
  videoEndChannelOptions: ChannelId[]
  compact: boolean
}

function ChannelPanel({
  label, channel, isLive, isSelected, isTaking, openingMessage,
  onDrop, onSlideChange, onSetTotalSlides, onVideoEndChannelChange, onCaptionChange,
  onSelect, onTake, onClear, pptxThumbnails, cacheStatus, videoEndChannelOptions, compact
}: ChannelPanelProps): JSX.Element {
  const [dragOver, setDragOver] = useState(false)
  const [slideInput, setSlideInput] = useState('')
  const [slideFocused, setSlideFocused] = useState(false)
  const [captionEditing, setCaptionEditing] = useState(false)
  const [captionDraft, setCaptionDraft] = useState(channel.caption)
  const [titlesMenu, setTitlesMenu] = useState<{
    x: number
    y: number
    sourceIdentity: string
  } | null>(null)
  const captionInputRef = useRef<HTMLInputElement>(null)
  const cancelCaptionOnBlurRef = useRef(false)
  const zoomDragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    originX: number
    originY: number
    viewportWidth: number
    viewportHeight: number
    scale: number
  } | null>(null)
  const [isZoomDragging, setIsZoomDragging] = useState(false)

  // Keep input synced with channel.slide when not being edited
  useEffect(() => {
    if (!slideFocused) setSlideInput(String(channel.slide))
  }, [channel.slide, slideFocused])

  useEffect(() => {
    if (!captionEditing) setCaptionDraft(channel.caption)
  }, [captionEditing, channel.caption])

  useEffect(() => {
    if (!captionEditing) return
    captionInputRef.current?.focus()
    captionInputRef.current?.select()
  }, [captionEditing])

  const finishCaptionEditing = (): void => {
    onCaptionChange(captionDraft.trim())
    setCaptionEditing(false)
  }

  const cancelCaptionEditing = (): void => {
    setCaptionDraft(channel.caption)
    setCaptionEditing(false)
  }

  const handleDragOver = (e: React.DragEvent): void => {
    e.preventDefault()
    if (isTaking) {
      e.dataTransfer.dropEffect = 'none'
      return
    }
    e.dataTransfer.dropEffect = 'copy'
    setDragOver(true)
  }

  const handleDragLeave = (): void => setDragOver(false)

  const handleDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    if (isTaking) return

    let file: FileEntry | null = null

    // Try internal drag first
    try {
      const jsonData = e.dataTransfer.getData('application/json')
      if (jsonData) {
        file = JSON.parse(jsonData) as FileEntry
      }
    } catch { /* ignore */ }

    // If no internal data, try native file drop from Windows Explorer
    if (!file && e.dataTransfer.files.length > 0) {
      const nativePath = window.api.getPathForFile(e.dataTransfer.files[0])
      if (nativePath) {
        file = nativeFileToEntry(nativePath)
      }
    }

    if (!file) return

    onDrop(file)
    if (isLive) {
      // A file dropped into the live channel is still taken automatically, but
      // a PPTX must first finish the same native preparation as an offline
      // channel. Otherwise this path could bypass the disabled TAKE buttons.
      if (file.type === 'presentation') {
        void ensurePptxChannelCache(file.path).then((result) => {
          if (result.success) onTake()
        })
      } else {
        setTimeout(() => onTake(), 50)
      }
    }
  }

  const {
    isPresentationWindowOpen,
    activeFile: storeActiveFile,
    broadcastTitles,
    captureTitlesOutputs,
    captureSources,
    contentZoom,
    programScene,
    setBroadcastTitles,
    setCaptureTitlesOutput,
    setContentZoom
  } = useAppStore()
  const channelSourceIdentity = channel.file?.type === 'capture'
    ? captureSourceIdentity(channel.file.capture)
    : null
  const sceneCaptureSourceIdentity = programScene.enabled && isLive
    ? captureSourceIdentity(captureSources.find(
        (entry) => entry.capture?.sourceId === programScene.captureSourceId
      )?.capture)
    : null
  // A regular PDF/PPTX/video channel has no capture identity of its own, but
  // while it is live in the program scene its titles belong to the participant
  // source selected in "Картинка в картинке".
  const titlesContextSourceIdentity = sceneCaptureSourceIdentity || channelSourceIdentity
  const channelTitlesOutput = channelSourceIdentity
    ? captureTitlesOutputs[channelSourceIdentity] || DEFAULT_BROADCAST_TITLES_OUTPUT
    : DEFAULT_BROADCAST_TITLES_OUTPUT
  const titlesMenuOutput = titlesMenu
    ? captureTitlesOutputs[titlesMenu.sourceIdentity] || DEFAULT_BROADCAST_TITLES_OUTPUT
    : channelTitlesOutput

  const publishSpeaker = (sourceIdentity: string, speakerId: string): void => {
    const speaker = useAppStore.getState().broadcastTitles.speakers.find((item) => item.id === speakerId)
    if (!speaker?.name.trim()) return
    const titles = useAppStore.getState().broadcastTitles
    setCaptureTitlesOutput(sourceIdentity, {
      speakerId: speaker.id,
      speakerName: speaker.name,
      speakerRole: speaker.role,
      speakerEnterEffect: titles.speakerEnterEffect,
      speakerExitEffect: titles.speakerExitEffect,
      speakerAutoHideSeconds: titles.speakerAutoHideSeconds,
      speakerStyle: titles.speakerStyle,
      speakerTextColor: titles.speakerTextColor,
      speakerBackgroundStart: titles.speakerBackgroundStart,
      speakerBackgroundEnd: titles.speakerBackgroundEnd,
      speakerAccentStart: titles.speakerAccentStart,
      speakerAccentEnd: titles.speakerAccentEnd,
      speakerVisible: true
    })
  }

  const publishEventTitle = (sourceIdentity: string): void => {
    const titles = useAppStore.getState().broadcastTitles
    if (!titles.eventInfo.trim()) return
    setCaptureTitlesOutput(sourceIdentity, {
      eventLabel: titles.eventLabel,
      eventInfo: titles.eventInfo,
      eventEnterEffect: titles.eventEnterEffect,
      eventExitEffect: titles.eventExitEffect,
      eventAutoHideSeconds: titles.eventAutoHideSeconds,
      eventPosition: titles.eventPosition,
      eventStyle: titles.eventStyle,
      eventTextColor: titles.eventTextColor,
      eventBackgroundStart: titles.eventBackgroundStart,
      eventBackgroundEnd: titles.eventBackgroundEnd,
      eventAccentStart: titles.eventAccentStart,
      eventAccentEnd: titles.eventAccentEnd,
      eventVisible: true
    })
  }

  useEffect(() => {
    if (!titlesContextSourceIdentity) {
      setTitlesMenu(null)
    }
  }, [titlesContextSourceIdentity])

  useEffect(() => {
    setTitlesMenu((current) => (
      current && current.sourceIdentity !== titlesContextSourceIdentity ? null : current
    ))
  }, [titlesContextSourceIdentity])

  const handleTitlesContextMenu = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (!titlesContextSourceIdentity) return
    event.preventDefault()
    event.stopPropagation()
    const menuWidth = 310
    const menuHeight = Math.min(610, 270 + broadcastTitles.speakers.length * 54)
    setTitlesMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8)),
      sourceIdentity: titlesContextSourceIdentity
    })
  }

  const publishChannelSpeaker = (speakerId: string): void => {
    const sourceIdentity = titlesMenu?.sourceIdentity
    setTitlesMenu(null)
    setBroadcastTitles({ selectedSpeakerId: speakerId })
    if (sourceIdentity) publishSpeaker(sourceIdentity, speakerId)
  }

  const publishChannelEvent = (): void => {
    const sourceIdentity = titlesMenu?.sourceIdentity
    setTitlesMenu(null)
    if (!broadcastTitles.eventInfo.trim()) return
    if (sourceIdentity) publishEventTitle(sourceIdentity)
  }
  const isOutputActive = (isPresentationWindowOpen && storeActiveFile !== null) || storeActiveFile?.type === 'presentation' || (storeActiveFile?.type === 'other' && !storeActiveFile.isImage)
  const showSelected = isSelected && !isOutputActive
  const pptxIsPreparing = channel.file?.type === 'presentation' &&
    cacheStatus !== 'ready' && cacheStatus !== 'error'
  const zoomSupported = supportsContentZoom(channel.file)

  return (
    <div
      className={`pdm-channel-card ${isLive ? 'is-live' : showSelected ? 'is-selected' : ''} flex-1 flex flex-col overflow-hidden ${compact ? 'rounded-md border' : 'rounded-lg border-2'} transition-colors cursor-pointer ${
        dragOver ? 'border-accent bg-accent/5' :
        isLive ? 'border-red-500/60' :
        showSelected ? 'border-blue-500/60' : 'border-gray-700/50'
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={onSelect}
      onDoubleClick={isTaking || pptxIsPreparing ? undefined : onTake}
      onContextMenu={handleTitlesContextMenu}
      aria-busy={isTaking || pptxIsPreparing}
    >
      {/* Header. min-w-0 на flex-контейнере + shrink-0 на фиксированных
          элементах (dot, label, ✕). Имя файла с flex-1 + min-w-0 + truncate
          — сжимается и обрезается многоточием вместо выталкивания ✕. */}
      <div className={`pdm-channel-header flex items-center min-w-0 ${compact ? 'gap-1 px-2 py-1' : 'gap-2 px-3 py-1.5'} ${isLive ? 'bg-red-900/30' : showSelected ? 'bg-blue-900/20' : 'bg-surface-200'}`}>
        <span className={`pdm-channel-state-dot ${compact ? 'w-1.5 h-1.5' : 'w-2 h-2'} rounded-full shrink-0 ${isLive ? 'bg-red-500 animate-pulse' : showSelected ? 'bg-blue-500' : 'bg-gray-600'}`} />
        <span className={`pdm-channel-status shrink-0 ${compact ? 'text-[9px]' : 'text-[10px]'} font-bold uppercase ${isLive ? 'text-red-400' : showSelected ? 'text-blue-400' : 'text-gray-500'}`}>
          Канал {label} {isLive ? '• В ЭФИРЕ' : showSelected ? '• ВЫБРАНО' : ''}
        </span>
        {captionEditing ? (
          <input
            ref={captionInputRef}
            type="text"
            value={captionDraft}
            maxLength={80}
            placeholder="Введите подпись"
            aria-label={`Подпись канала ${label}`}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onChange={(event) => setCaptionDraft(event.target.value)}
            onBlur={() => {
              if (cancelCaptionOnBlurRef.current) {
                cancelCaptionOnBlurRef.current = false
                cancelCaptionEditing()
              } else {
                finishCaptionEditing()
              }
            }}
            onKeyDown={(event) => {
              event.stopPropagation()
              if (event.key === 'Enter') {
                event.preventDefault()
                event.currentTarget.blur()
              } else if (event.key === 'Escape') {
                event.preventDefault()
                cancelCaptionOnBlurRef.current = true
                event.currentTarget.blur()
              }
            }}
            className={`flex-1 min-w-0 bg-transparent text-right text-gray-100 outline-hidden placeholder:text-gray-600 ${compact ? 'text-[8px]' : 'text-[11px] ml-1'}`}
          />
        ) : (
          <span
            className={`flex-1 min-w-0 overflow-hidden whitespace-nowrap text-right ${compact ? 'text-[8px]' : 'text-[11px] ml-1'} ${channel.caption ? 'font-medium text-gray-200' : 'text-gray-500'}`}
            title={channel.caption || channel.file?.name || 'Подпись не задана'}
          >
            {channel.caption || channel.file?.name || ''}
          </span>
        )}
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            if (captionEditing) finishCaptionEditing()
            else {
              setCaptionDraft(channel.caption)
              setCaptionEditing(true)
            }
          }}
          onDoubleClick={(event) => event.stopPropagation()}
          disabled={isTaking}
          className={`shrink-0 rounded-sm text-gray-500 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-30 ${compact ? 'p-0.5' : 'p-1'}`}
          title={channel.caption ? 'Изменить подпись канала' : 'Добавить подпись канала'}
          aria-label={channel.caption ? `Изменить подпись канала ${label}` : `Добавить подпись канала ${label}`}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={compact ? 'h-3 w-3' : 'h-3.5 w-3.5'}
            aria-hidden="true"
          >
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
          </svg>
        </button>
        {channel.file && (
          <button
            onClick={(e) => { e.stopPropagation(); onClear() }}
            onDoubleClick={(e) => e.stopPropagation()}
            disabled={isTaking}
            className={`shrink-0 text-gray-500 hover:text-white ${compact ? 'text-xs px-0.5' : 'text-sm px-1'} leading-none rounded-sm hover:bg-white/10 transition-colors disabled:opacity-30 disabled:hover:text-gray-500 disabled:hover:bg-transparent`}
            title="Убрать материал"
          >
            ✕
          </button>
        )}
      </div>

      {/* Preview area */}
      <div
        className={`relative flex-1 flex items-center justify-center overflow-hidden bg-black/40 ${
          isLive && contentZoom.enabled &&
          zoomSupported
            ? contentZoom.scale > 1
              ? isZoomDragging ? 'cursor-grabbing' : 'cursor-grab'
              : 'cursor-zoom-in'
            : ''
        }`}
        style={isLive && contentZoom.enabled ? { touchAction: 'none' } : undefined}
        onClick={(event) => {
          if (isLive && contentZoom.enabled) event.stopPropagation()
        }}
        onDoubleClick={(event) => {
          if (isLive && contentZoom.enabled) event.stopPropagation()
        }}
        onPointerDown={(event) => {
          if (
            event.button !== 0 ||
            !isLive ||
            !contentZoom.enabled ||
            contentZoom.scale <= 1 ||
            !zoomSupported
          ) return
          event.preventDefault()
          event.stopPropagation()
          const rect = event.currentTarget.getBoundingClientRect()
          zoomDragRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            originX: contentZoom.originX,
            originY: contentZoom.originY,
            viewportWidth: Math.max(1, rect.width),
            viewportHeight: Math.max(1, rect.height),
            scale: contentZoom.scale
          }
          event.currentTarget.setPointerCapture(event.pointerId)
          setIsZoomDragging(true)
        }}
        onPointerMove={(event) => {
          const drag = zoomDragRef.current
          if (!drag || drag.pointerId !== event.pointerId) return
          event.preventDefault()
          event.stopPropagation()
          const overflowScale = Math.max(0.001, drag.scale - 1)
          setContentZoom({
            originX: drag.originX - (event.clientX - drag.startX) / (drag.viewportWidth * overflowScale),
            originY: drag.originY - (event.clientY - drag.startY) / (drag.viewportHeight * overflowScale)
          })
        }}
        onPointerUp={(event) => {
          const drag = zoomDragRef.current
          if (!drag || drag.pointerId !== event.pointerId) return
          event.preventDefault()
          event.stopPropagation()
          zoomDragRef.current = null
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId)
          }
          setIsZoomDragging(false)
        }}
        onPointerCancel={(event) => {
          const drag = zoomDragRef.current
          if (!drag || drag.pointerId !== event.pointerId) return
          zoomDragRef.current = null
          setIsZoomDragging(false)
        }}
        onWheel={(event) => {
          if (
            !isLive ||
            !contentZoom.enabled ||
            !zoomSupported
          ) return
          event.preventDefault()
          event.stopPropagation()
          const rect = event.currentTarget.getBoundingClientRect()
          const originX = Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)))
          const originY = Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height)))
          const direction = event.deltaY < 0 ? 1 : -1
          const scale = Math.max(1, Math.min(3, Math.round((contentZoom.scale + direction * 0.25) * 4) / 4))
          setContentZoom({ scale, originX, originY })
        }}
      >
        {channel.file ? (
          <div
            className="flex h-full w-full items-center justify-center"
            style={isLive && contentZoom.enabled ? {
              transform: `scale(${contentZoom.scale})`,
              transformOrigin: `${contentZoom.originX * 100}% ${contentZoom.originY * 100}%`
            } : undefined}
          >
            <SlideRenderer
              file={channel.file}
              slideNum={channel.slide}
              pptxThumbnails={pptxThumbnails}
              onTotalSlides={onSetTotalSlides}
            />
          </div>
        ) : (
          <div className={`${compact ? 'text-[10px] p-1' : 'text-xs p-4'} text-gray-600 text-center select-none`}>
            <div className={`${compact ? 'text-lg mb-0.5' : 'text-2xl mb-2'} opacity-30`}>📥</div>
            Перетащите материал сюда
          </div>
        )}
        {channel.file?.type === 'capture' && (
          <BroadcastTitlesOverlay
            key={channelSourceIdentity || 'no-channel-title-source'}
            titles={channelTitlesOutput}
          />
        )}
        {isLive && zoomSupported && (
          <button
            type="button"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              setContentZoom(!contentZoom.enabled
                ? { enabled: true, scale: 1, originX: 0.5, originY: 0.5 }
                : contentZoom.scale > 1
                  ? { enabled: true, scale: 1, originX: 0.5, originY: 0.5 }
                  : DEFAULT_CONTENT_ZOOM)
            }}
            onDoubleClick={(event) => event.stopPropagation()}
            className={`absolute left-2 top-2 z-20 rounded-md border px-2 py-1 text-[9px] font-semibold shadow-lg ${
              contentZoom.enabled
                ? 'border-cyan-400 bg-cyan-700 text-white'
                : 'border-gray-600 bg-gray-900/85 text-gray-300 hover:bg-gray-700'
            }`}
            title={contentZoom.enabled
              ? contentZoom.scale > 1
                ? 'Крутите колесо над нужной точкой. Зажмите левую кнопку мыши и двигайте документ. Нажмите, чтобы вернуться к 100%, не выключая лупу.'
                : 'Лупа включена. Крутите колесо над нужной точкой для увеличения. Нажмите, чтобы выключить лупу.'
              : 'Включить увеличение презентации колесом мыши'}
          >
            🔍 {contentZoom.enabled ? `${Math.round(contentZoom.scale * 100)}%` : 'Лупа'}
          </button>
        )}
        {isTaking && openingMessage && (
          <div
            className={`absolute inset-0 z-10 pointer-events-none flex flex-col items-center justify-center ${compact ? 'gap-1 px-2' : 'gap-3 px-4'} bg-black/75`}
            role="status"
            aria-live="polite"
          >
            <span className={`${compact ? 'h-4 w-4' : 'h-6 w-6'} rounded-full border-2 border-gray-500 border-t-white animate-spin`} />
            <span className={`${compact ? 'text-[9px]' : 'text-xs'} font-medium text-gray-100 text-center`}>
              {openingMessage}
            </span>
          </div>
        )}
        {!isTaking &&
          (channel.file?.type === 'presentation' || channel.file?.type === 'pdf') &&
          cacheStatus === 'loading' && (
          <div
            className={`absolute right-2 top-2 z-10 flex items-center rounded-sm bg-blue-700/90 text-white shadow ${compact ? 'gap-1 px-1 py-0.5 text-[8px]' : 'gap-1.5 px-2 py-1 text-[9px]'}`}
            title={channel.file.type === 'pdf'
              ? 'PDM заранее подготавливает полноразмерные страницы PDF для эфира'
               : 'PDM заранее открывает презентацию в PowerPoint и готовит слайды к мгновенному выводу'}
          >
            <span className={`${compact ? 'h-2.5 w-2.5' : 'h-3 w-3'} rounded-full border border-blue-200 border-t-transparent animate-spin`} />
            Кэширование…
          </div>
        )}
        {!isTaking &&
          (channel.file?.type === 'presentation' || channel.file?.type === 'pdf') &&
          cacheStatus === 'error' && (
          <div
            className={`absolute right-2 top-2 z-10 rounded-sm bg-red-800/90 text-white shadow ${compact ? 'px-1 py-0.5 text-[8px]' : 'px-2 py-1 text-[9px]'}`}
            title={`Не удалось заранее подготовить ${channel.file.type === 'pdf' ? 'PDF' : 'презентацию'}. При запуске PDM попробует открыть материал обычным способом.`}
          >
            Кэш не готов
          </div>
        )}
      </div>

      {/* Navigation — only for non-live channel */}
      {!isLive && channel.file && (channel.file.type === 'pdf' || channel.file.type === 'presentation') && (
        <div
          className={`flex items-center justify-center ${compact ? 'gap-1 py-0.5 px-1' : 'gap-3 py-1.5'} bg-surface-200 border-t border-gray-800 relative`}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={(e) => { e.stopPropagation(); if (channel.slide > 1) onSlideChange(channel.slide - 1) }}
            onDoubleClick={(e) => e.stopPropagation()}
            className={`btn-icon text-[10px] ${compact ? 'p-1' : ''}`}
            disabled={isTaking || channel.slide <= 1}
          >
            ◀
          </button>
          <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
            <input
              type="number"
              min={1}
              max={channel.totalSlides || undefined}
              value={slideInput}
              disabled={isTaking}
              onClick={(e) => { e.stopPropagation(); (e.target as HTMLInputElement).select() }}
              onFocus={(e) => { setSlideFocused(true); e.target.select() }}
              onDoubleClick={(e) => e.stopPropagation()}
              onChange={(e) => setSlideInput(e.target.value)}
              onBlur={() => {
                const n = parseInt(slideInput, 10)
                if (!isNaN(n) && n >= 1 && (channel.totalSlides === 0 || n <= channel.totalSlides)) {
                  onSlideChange(n)
                } else {
                  setSlideInput(String(channel.slide))
                }
                setSlideFocused(false)
              }}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                if (e.key === 'Escape') {
                  setSlideInput(String(channel.slide))
                  ;(e.target as HTMLInputElement).blur()
                }
              }}
              className={`${compact ? 'w-9 text-[9px]' : 'w-12 text-[10px]'} text-center bg-surface-100 border border-gray-600 focus:border-accent rounded-sm px-1 py-0.5 text-white tabular-nums outline-hidden`}
              title="Введите номер слайда и нажмите Enter"
            />
            {channel.totalSlides > 0 && (
              <span className={`${compact ? 'text-[8px]' : 'text-[10px]'} text-gray-500 tabular-nums`}>/ {channel.totalSlides}</span>
            )}
          </div>
          <button
            onClick={(e) => { e.stopPropagation(); if (channel.totalSlides === 0 || channel.slide < channel.totalSlides) onSlideChange(channel.slide + 1) }}
            onDoubleClick={(e) => e.stopPropagation()}
            className={`btn-icon text-[10px] ${compact ? 'p-1' : ''}`}
            disabled={isTaking || (channel.totalSlides > 0 && channel.slide >= channel.totalSlides)}
          >
            ▶
          </button>
          {!compact && (
            <button
              onClick={(e) => { e.stopPropagation(); if (channel.slide > 1) onSlideChange(1) }}
              onDoubleClick={(e) => e.stopPropagation()}
              className="btn-icon text-[10px]"
              disabled={isTaking || channel.slide <= 1}
              title="К первому слайду"
            >
              ⏮
            </button>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); onTake() }}
            onDoubleClick={(e) => e.stopPropagation()}
            disabled={isTaking || pptxIsPreparing}
            title={pptxIsPreparing ? 'Презентация ещё подготавливается в PowerPoint' : undefined}
            className={`absolute ${compact ? 'right-1 text-[8px] px-1.5 py-0.5' : 'right-2 text-[9px] px-2 py-1'} bg-red-600 hover:bg-red-500 text-white font-bold rounded-sm transition-colors disabled:opacity-40 disabled:hover:bg-red-600`}
          >
            В эфир
          </button>
        </div>
      )}

      {titlesMenu && createPortal(
        <>
          <div
            className="fixed inset-0 z-[240]"
            onMouseDown={(event) => {
              event.stopPropagation()
              setTitlesMenu(null)
            }}
            onContextMenu={(event) => {
              event.preventDefault()
              event.stopPropagation()
              setTitlesMenu(null)
            }}
          />
          <div
            className="fixed z-[241] w-[310px] overflow-hidden rounded-xl border border-gray-700 bg-surface-300 shadow-2xl"
            style={{ left: titlesMenu.x, top: titlesMenu.y }}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onContextMenu={(event) => {
              event.preventDefault()
              event.stopPropagation()
            }}
          >
            <div className="border-b border-gray-700 px-3 py-2.5">
              <div className="text-xs font-semibold text-white">Титры внешнего источника</div>
              <div className="mt-0.5 text-[10px] text-gray-500">
                Канал {label} · основной эфир не переключается
              </div>
            </div>

            <div className="border-b border-gray-700 p-1.5">
              <div className="px-2 pb-1 pt-0.5 text-[9px] font-semibold uppercase tracking-[.12em] text-emerald-400">
                Информация о мероприятии
              </div>
              <button
                type="button"
                disabled={!broadcastTitles.eventInfo.trim()}
                onClick={publishChannelEvent}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
                  titlesMenuOutput.eventVisible ? 'bg-emerald-900/40' : 'hover:bg-gray-700/70'
                }`}
              >
                <span className={`h-2 w-2 shrink-0 rounded-full ${titlesMenuOutput.eventVisible ? 'bg-red-500' : 'bg-emerald-500'}`} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-gray-100">
                    {broadcastTitles.eventLabel.trim() || 'Без заголовка'}
                  </span>
                  <span className="block truncate text-[10px] text-gray-500">
                    {broadcastTitles.eventInfo.trim() || 'Заполните информацию через кнопку «▰ Титры»'}
                  </span>
                </span>
                {titlesMenuOutput.eventVisible && <span className="text-[8px] font-semibold text-red-300">ВКЛ</span>}
              </button>
              {titlesMenuOutput.eventVisible && (
                <button
                  type="button"
                  onClick={() => {
                    const sourceIdentity = titlesMenu.sourceIdentity
                    setTitlesMenu(null)
                    setCaptureTitlesOutput(sourceIdentity, { eventVisible: false })
                  }}
                  className="mt-1 w-full rounded-md px-2.5 py-1.5 text-left text-[10px] font-medium text-red-300 hover:bg-red-950/40"
                >
                  Скрыть информацию о мероприятии
                </button>
              )}
            </div>

            <div className="px-3 pb-1 pt-2 text-[9px] font-semibold uppercase tracking-[.12em] text-cyan-400">
              Выступающие
            </div>

            {broadcastTitles.speakers.length > 0 ? (
              <div className="max-h-[360px] overflow-y-auto p-1.5">
                {broadcastTitles.speakers.map((speaker) => {
                  const live = titlesMenuOutput.speakerVisible && titlesMenuOutput.speakerId === speaker.id
                  return (
                    <button
                      key={speaker.id}
                      type="button"
                      disabled={!speaker.name.trim()}
                      onClick={() => publishChannelSpeaker(speaker.id)}
                      className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
                        live ? 'bg-cyan-900/45' : 'hover:bg-gray-700/70'
                      }`}
                    >
                      <span className={`h-2 w-2 shrink-0 rounded-full ${live ? 'bg-red-500' : 'bg-cyan-600'}`} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium text-gray-100">
                          {speaker.name.trim() || 'ФИО не заполнено'}
                        </span>
                        <span className="block truncate text-[10px] text-gray-500">
                          {speaker.role.trim() || 'Должность не указана'}
                        </span>
                      </span>
                      {live && <span className="text-[8px] font-semibold text-red-300">ВКЛ</span>}
                    </button>
                  )
                })}
              </div>
            ) : (
              <div className="px-3 py-5 text-center text-[11px] text-gray-500">
                Сначала добавьте выступающих через кнопку «▰ Титры».
              </div>
            )}

            {titlesMenuOutput.speakerVisible && (
              <button
                type="button"
                onClick={() => {
                  const sourceIdentity = titlesMenu.sourceIdentity
                  setTitlesMenu(null)
                  setCaptureTitlesOutput(sourceIdentity, { speakerVisible: false })
                }}
                className="w-full border-t border-gray-700 px-3 py-2.5 text-left text-[11px] font-medium text-red-300 hover:bg-red-950/40"
              >
                Скрыть титр выступающего
              </button>
            )}
          </div>
        </>,
        document.body
      )}
      {/* Take button for video/capture/other in non-live channel */}
      {!isLive && channel.file && (channel.file.type === 'video' || channel.file.type === 'capture' || channel.file.type === 'other') && (
        <div
          className={`flex items-center ${channel.file.type === 'video' ? 'justify-between gap-1' : 'justify-end'} ${compact ? 'py-0.5 px-1' : 'py-1.5 px-2'} bg-surface-200 border-t border-gray-800`}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {channel.file.type === 'video' && (
            <label
              className={`flex min-w-0 items-center ${compact ? 'gap-0.5' : 'gap-1.5'} text-gray-500`}
              title="Канал, который автоматически выйдет в эфир после окончания ролика"
              onClick={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
            >
              {!compact && <span className="shrink-0 text-[9px]">После:</span>}
              <select
                value={channel.videoEndChannel || ''}
                disabled={isTaking}
                onChange={(event) => onVideoEndChannelChange(event.target.value || null)}
                className={`${compact ? 'max-w-[76px] px-0.5 py-0 text-[8px]' : 'max-w-[145px] px-1.5 py-0.5 text-[9px]'} min-w-0 rounded-sm border border-gray-700 bg-surface-100 text-gray-300 outline-hidden hover:border-gray-600 focus:border-accent disabled:opacity-40`}
              >
                <option value="">Не переключать</option>
                {videoEndChannelOptions.map((targetId) => (
                  <option key={targetId} value={targetId}>Канал {targetId}</option>
                ))}
              </select>
            </label>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); onTake() }}
            onDoubleClick={(e) => e.stopPropagation()}
            disabled={isTaking}
            className={`bg-red-600 hover:bg-red-500 text-white ${compact ? 'text-[8px] px-1.5 py-0.5' : 'text-[9px] px-2 py-1'} font-bold rounded-sm transition-colors disabled:opacity-40 disabled:hover:bg-red-600`}
          >
            В эфир
          </button>
        </div>
      )}
    </div>
  )
}

export function SlideRenderer({ file, slideNum, pptxThumbnails, onTotalSlides }: {
  file: FileEntry
  slideNum: number
  pptxThumbnails: string[]
  onTotalSlides: (total: number) => void
}): JSX.Element {
  if (file.type === 'pdf') return <PdfPreview file={file} currentSlide={slideNum} onTotalSlides={onTotalSlides} />
  if (file.type === 'presentation') return <PptxPreview file={file} currentSlide={slideNum} pptxThumbnails={pptxThumbnails} />
  if (file.type === 'video') return <VideoPreview key={file.path} file={file} />
  if (file.type === 'capture') {
    return file.capture
      ? <CaptureThumbnail config={file.capture} className="w-full h-full" />
      : <div className="text-red-400 text-xs">Параметры видеовхода отсутствуют</div>
  }
  if (file.type === 'other') return <OtherPreview file={file} />
  return <div className="text-gray-500 text-xs">Unsupported</div>
}

function PdfPreview({ file, currentSlide, onTotalSlides }: {
  file: FileEntry; currentSlide: number; onTotalSlides: (t: number) => void
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const loadingTaskRef = useRef<pdfjsLib.PDFDocumentLoadingTask | null>(null)
  const renderTaskRef = useRef<pdfjsLib.RenderTask | null>(null)
  const renderGenerationRef = useRef(0)
  const onTotalSlidesRef = useRef(onTotalSlides)
  onTotalSlidesRef.current = onTotalSlides

  useEffect(() => {
    let cancelled = false
    const generation = ++renderGenerationRef.current
    renderTaskRef.current?.cancel()
    renderTaskRef.current = null
    if (loadingTaskRef.current) {
      void loadingTaskRef.current.destroy().catch(() => undefined)
      loadingTaskRef.current = null
    }

    async function render(): Promise<void> {
      let loadingTask: pdfjsLib.PDFDocumentLoadingTask | null = null
      let page: pdfjsLib.PDFPageProxy | null = null
      let renderTask: pdfjsLib.RenderTask | null = null
      try {
        const data = await window.api.readFile(file.path)
        if (cancelled || generation !== renderGenerationRef.current) return
        loadingTask = pdfjsLib.getDocument({ data })
        loadingTaskRef.current = loadingTask
        const doc = await loadingTask.promise
        if (cancelled || generation !== renderGenerationRef.current) return
        onTotalSlidesRef.current(doc.numPages)
        const pageNumber = Math.max(1, Math.min(doc.numPages, currentSlide))
        page = await doc.getPage(pageNumber)
        if (
          cancelled ||
          generation !== renderGenerationRef.current ||
          !canvasRef.current ||
          !containerRef.current
        ) return

        const canvas = canvasRef.current
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        const containerWidth = Math.max(1, containerRef.current.clientWidth)
        const containerHeight = Math.max(1, containerRef.current.clientHeight)
        const viewport = page.getViewport({ scale: 1 })
        const scale = Math.min(containerWidth / viewport.width, containerHeight / viewport.height)
        const scaledViewport = page.getViewport({ scale })
        canvas.width = Math.max(1, Math.round(scaledViewport.width))
        canvas.height = Math.max(1, Math.round(scaledViewport.height))

        renderTask = page.render({ canvas, canvasContext: ctx, viewport: scaledViewport })
        renderTaskRef.current = renderTask
        await renderTask.promise
      } catch (err) {
        if (!cancelled && generation === renderGenerationRef.current) {
          console.error('Preview: Failed to render PDF:', err)
        }
      } finally {
        if (renderTaskRef.current === renderTask) renderTaskRef.current = null
        page?.cleanup()
        if (loadingTask) {
          if (loadingTaskRef.current === loadingTask) loadingTaskRef.current = null
          await loadingTask.destroy().catch(() => undefined)
        }
      }
    }
    void render()
    return () => {
      cancelled = true
      renderGenerationRef.current += 1
      renderTaskRef.current?.cancel()
      renderTaskRef.current = null
      const loadingTask = loadingTaskRef.current
      loadingTaskRef.current = null
      if (loadingTask) void loadingTask.destroy().catch(() => undefined)
    }
  }, [currentSlide, file.path])

  return (
    <div ref={containerRef} className="w-full h-full flex items-center justify-center">
      <canvas ref={canvasRef} className="max-w-full max-h-full" />
    </div>
  )
}

function PptxPreview({ file, currentSlide, pptxThumbnails }: {
  file: FileEntry; currentSlide: number; pptxThumbnails: string[]
}): JSX.Element {
  const thumbPath = pptxThumbnails[currentSlide - 1]

  if (!thumbPath) {
    return (
      <div className="text-center text-gray-500 p-4">
        <div className="text-3xl mb-2">📊</div>
        <p className="text-[11px]">{file.name}</p>
        <p className="text-[10px] text-gray-600 mt-1">Двойной клик для запуска</p>
      </div>
    )
  }

  return (
    <div className="w-full h-full flex items-center justify-center">
      <img
        src={mediaUrl(thumbPath)}
        alt={`Slide ${currentSlide}`}
        className="max-w-full max-h-full object-contain"
      />
    </div>
  )
}

function VideoPreview({ file }: { file: FileEntry }): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const capturedRef = useRef(false)
  const desiredTimeRef = useRef(0)
  const posterTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [poster, setPoster] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  const releaseVideo = (video: HTMLVideoElement): void => {
    video.pause()
    video.removeAttribute('src')
    video.load()
  }

  useEffect(() => {
    const video = videoRef.current
    posterTimeoutRef.current = setTimeout(() => {
      if (!video || capturedRef.current) return
      releaseVideo(video)
      setFailed(true)
    }, 8_000)
    return () => {
      if (posterTimeoutRef.current) clearTimeout(posterTimeoutRef.current)
      posterTimeoutRef.current = null
      if (!video) return
      releaseVideo(video)
    }
  }, [])

  const capturePoster = (video: HTMLVideoElement): void => {
    if (capturedRef.current || video.videoWidth < 1 || video.videoHeight < 1) return

    const maxWidth = 480
    const scale = Math.min(1, maxWidth / video.videoWidth)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale))
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale))
    const context = canvas.getContext('2d')
    if (!context) {
      canvas.width = 0
      canvas.height = 0
      releaseVideo(video)
      setFailed(true)
      return
    }

    try {
      context.drawImage(video, 0, 0, canvas.width, canvas.height)
      capturedRef.current = true
      if (posterTimeoutRef.current) clearTimeout(posterTimeoutRef.current)
      posterTimeoutRef.current = null
      setPoster(canvas.toDataURL('image/jpeg', 0.72))
      releaseVideo(video)
    } catch (error) {
      console.warn('Preview: Failed to capture video poster:', error)
      releaseVideo(video)
      setFailed(true)
    } finally {
      canvas.width = 0
      canvas.height = 0
    }
  }

  if (poster) {
    return (
      <div className="w-full h-full flex items-center justify-center">
        <img src={poster} alt={file.name} className="max-w-full max-h-full rounded-lg object-contain" />
      </div>
    )
  }

  if (failed) {
    return (
      <div className="w-full h-full flex items-center justify-center text-center text-gray-500 p-4">
        <div>
          <div className="text-3xl mb-2">🎬</div>
          <p className="text-[11px]">{file.name}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="w-full h-full flex items-center justify-center">
      <video
        ref={videoRef}
        src={mediaUrl(file.path)}
        className="max-w-full max-h-full rounded-lg"
        controls={false}
        muted
        preload="auto"
        onLoadedMetadata={(event) => {
          const video = event.currentTarget
          desiredTimeRef.current = Number.isFinite(video.duration) && video.duration > 0
            ? Math.min(1, video.duration / 2)
            : 0
          if (desiredTimeRef.current > 0.05) {
            try {
              video.currentTime = desiredTimeRef.current
            } catch {
              // loadeddata will capture the first decoded frame instead
            }
          }
        }}
        onLoadedData={(event) => {
          const video = event.currentTarget
          if (
            desiredTimeRef.current <= 0.05 ||
            Math.abs(video.currentTime - desiredTimeRef.current) <= 0.1
          ) {
            capturePoster(video)
          }
        }}
        onSeeked={(event) => capturePoster(event.currentTarget)}
        onError={(event) => {
          if (posterTimeoutRef.current) clearTimeout(posterTimeoutRef.current)
          posterTimeoutRef.current = null
          releaseVideo(event.currentTarget)
          setFailed(true)
        }}
      />
    </div>
  )
}

const EXT_ICONS: Record<string, string> = {
  '.doc': '📝', '.docx': '📝', '.rtf': '📝', '.odt': '📝', '.txt': '📄',
  '.xls': '📊', '.xlsx': '📊', '.ods': '📊',
  '.mp3': '🎵', '.wav': '🎵', '.ogg': '🎵', '.aac': '🎵', '.m4a': '🎵', '.flac': '🎵', '.wma': '🎵'
}

const DOC_EXTENSIONS = ['.doc', '.docx', '.rtf', '.odt', '.txt', '.xls', '.xlsx', '.ods']

function OtherPreview({ file }: { file: FileEntry }): JSX.Element {
  if (file.isImage) {
    return (
      <div className="w-full h-full flex items-center justify-center">
        <img
          src={mediaUrl(file.path)}
          alt={file.name}
          className="max-w-full max-h-full object-contain"
        />
      </div>
    )
  }

  if (file.isAudio) {
    return (
      <div className="text-center text-gray-500 p-4">
        <div className="text-3xl mb-2">🎵</div>
        <p className="text-[11px]">{file.name}{file.extension}</p>
        <p className="text-[10px] text-gray-600 mt-1">Откроется во встроенном плеере</p>
      </div>
    )
  }

  if (DOC_EXTENSIONS.includes(file.extension)) {
    return <DocPreview file={file} />
  }

  const icon = EXT_ICONS[file.extension] || '📎'
  return (
    <div className="text-center text-gray-500 p-4">
      <div className="text-3xl mb-2">{icon}</div>
      <p className="text-[11px]">{file.name}{file.extension}</p>
      <p className="text-[10px] text-gray-600 mt-1">Откроется в системной программе</p>
    </div>
  )
}

function DocPreview({ file }: { file: FileEntry }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const loadingTaskRef = useRef<pdfjsLib.PDFDocumentLoadingTask | null>(null)
  const renderTaskRef = useRef<pdfjsLib.RenderTask | null>(null)
  const { docPreviewsMap } = useAppStore()
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)

  // Generate preview PDF if not cached
  useEffect(() => {
    if (docPreviewsMap[file.path] || failed) return
    let cancelled = false
    setLoading(true)
    window.api.generateDocPreview(file.path).then((result) => {
      if (cancelled) return
      if (result.success && result.pdfPath) {
        const { docPreviewsMap: current } = useAppStore.getState()
        useAppStore.setState({ docPreviewsMap: { ...current, [file.path]: result.pdfPath } })
      } else {
        setFailed(true)
      }
      setLoading(false)
    }).catch(() => {
      if (!cancelled) { setFailed(true); setLoading(false) }
    })
    return () => { cancelled = true }
  }, [file.path, failed])

  // Render first page of preview PDF
  const pdfPath = docPreviewsMap[file.path]

  useEffect(() => {
    if (!pdfPath || !canvasRef.current || !containerRef.current) return
    let cancelled = false

    async function render(): Promise<void> {
      let loadingTask: pdfjsLib.PDFDocumentLoadingTask | null = null
      let page: pdfjsLib.PDFPageProxy | null = null
      let renderTask: pdfjsLib.RenderTask | null = null
      try {
        const data = await window.api.readFile(pdfPath!)
        if (cancelled) return
        loadingTask = pdfjsLib.getDocument({ data })
        loadingTaskRef.current = loadingTask
        const doc = await loadingTask.promise
        page = await doc.getPage(1)
        if (cancelled || !canvasRef.current || !containerRef.current) return

        const containerWidth = containerRef.current.clientWidth
        const containerHeight = containerRef.current.clientHeight
        const viewport = page.getViewport({ scale: 1 })
        const scale = Math.min(containerWidth / viewport.width, containerHeight / viewport.height)
        const scaledViewport = page.getViewport({ scale })

        canvasRef.current.width = scaledViewport.width
        canvasRef.current.height = scaledViewport.height

        const ctx = canvasRef.current.getContext('2d')
        if (ctx) {
          renderTask = page.render({
            canvas: canvasRef.current,
            canvasContext: ctx,
            viewport: scaledViewport
          })
          renderTaskRef.current = renderTask
          await renderTask.promise
        }
      } catch {
        if (!cancelled) setFailed(true)
      } finally {
        if (renderTaskRef.current === renderTask) renderTaskRef.current = null
        page?.cleanup()
        if (loadingTask) {
          if (loadingTaskRef.current === loadingTask) loadingTaskRef.current = null
          await loadingTask.destroy().catch(() => undefined)
        }
      }
    }

    render()
    return () => {
      cancelled = true
      renderTaskRef.current?.cancel()
      renderTaskRef.current = null
      const loadingTask = loadingTaskRef.current
      loadingTaskRef.current = null
      if (loadingTask) void loadingTask.destroy().catch(() => undefined)
    }
  }, [pdfPath])

  if (pdfPath) {
    return (
      <div ref={containerRef} className="w-full h-full flex items-center justify-center">
        <canvas ref={canvasRef} className="max-w-full max-h-full" />
      </div>
    )
  }

  const icon = EXT_ICONS[file.extension] || '📎'
  return (
    <div className="text-center text-gray-500 p-4">
      <div className="text-3xl mb-2">{icon}</div>
      <p className="text-[11px]">{file.name}{file.extension}</p>
      <p className="text-[10px] text-gray-600 mt-1">
        {loading ? <span className="animate-pulse">Генерация предпросмотра...</span> : 'Откроется в системной программе'}
      </p>
    </div>
  )
}
