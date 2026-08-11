import { useEffect, useRef, useCallback, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAppStore, ChannelState, ChannelId, resetPptxNavState, awaitPptxGotoChainIdle } from '../../stores/useAppStore'
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

  const job = (async (): Promise<PptxCacheResult> => {
    window.api.dbgLog(`PPTX channel cache: BEGIN file=${filePath}`)
    try {
      const beforeNativePrepare = useAppStore.getState()
      const isStillAssigned = beforeNativePrepare.channelIds.some((id) => (
        beforeNativePrepare.channels[id]?.file?.type === 'presentation' &&
        beforeNativePrepare.channels[id]?.file?.path === filePath
      ))
      if (!isStillAssigned) {
        return { success: false, slideCount: 0, error: 'Presentation was removed from channels' }
      }

      // Opening the native Presentation object is the expensive part of the
      // first TAKE. Keep it hidden in PowerPoint as soon as the file is placed
      // in a channel, before producing the remaining full-size cache.
      const prepared = await window.api.preparePowerPoint(filePath)
      if (!prepared.success) {
        throw new Error(prepared.error || 'PowerPoint did not prepare the presentation')
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
        const thumbnails = await window.api.generatePptxThumbnails(filePath)
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

      const slides = await window.api.generatePptxSlides(filePath)
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
      pptxChannelCacheJobs.delete(filePath)
    }
  })()
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
    displays, selectedDisplayId, setOverlayState
  } = useAppStore()

  const takeInFlightRef = useRef<ChannelId | null>(null)
  const queuedTakeRef = useRef<ChannelId | null>(null)
  const takeGenerationRef = useRef(0)
  const activeTakeIdRef = useRef<string | null>(null)
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

  useEffect(() => {
    void window.api.syncPreparedPowerPoints(pptxChannelPaths)
  }, [pptxChannelPathKey])

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

  const handleClear = async (ch: ChannelId): Promise<void> => {
    const channel = channels[ch]
    if (!channel) return
    const clearedFilePath = channel.file?.path
    // If this channel is live, close the presentation
    if (liveChannel === ch && channel.file) {
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
      const needsCover = isPptx || isExternalDoc || hasPinnedOverlay

      if (needsCover) {
        await window.api.showOverlay(selectedDisplayId ?? undefined)
      }

      // Close underlying content (hidden behind overlay)
      if (isPptx) {
        await window.api.powerpointCommand('close')
        // Restore taskbar hidden на take PPTX
        await window.api.showTaskbar()
      }
      if (isAudio) {
        await window.api.musicStop()
      }
      if (isExternalDoc) {
        await window.api.closeExternalFile(channel.file.path)
        await window.api.showTaskbar()
      }

      // Decide final state of the presentation window:
      // - with backdrop: show backdrop (for any content type)
      // - without backdrop: close the window entirely
      if (backdropImage) {
        if (!useAppStore.getState().isPresentationWindowOpen) {
          await window.api.openPresentationWindow(selectedDisplayId ?? undefined)
          setPresentationWindowOpen(true)
        }
        window.api.sendToPresentation('load-content', {
          type: 'backdrop',
          path: backdropImage,
          name: 'Backdrop'
        })
        // Give the renderer a moment to paint the backdrop before dropping the overlay
        if (needsCover) await new Promise((r) => setTimeout(r, 150))
      } else {
        window.api.sendToPresentation('clear-active-content')
        if (useAppStore.getState().isPresentationWindowOpen) {
          await window.api.closePresentationWindow()
          setPresentationWindowOpen(false)
        }
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
  }

  const handleTake = async (ch: ChannelId): Promise<void> => {
    const freshState = useAppStore.getState()
    const file = freshState.channels[ch]?.file
    if (!file) return
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
    beginNavigationTransition()
    setTakeProgress({ channelId: ch, message })

    // Top-level safety net: если handleTake бросит (daemon crash,
    // launchPowerPoint reject, capturePage fail), overlay оставался бы
    // opacity=1 чёрным НАВСЕГДА — юзер видит зависший чёрный экран без
    // способа recovery (audit F-205). Ловим, логируем, force-hide overlay.
    try {
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
      const queuedNavigation = finishNavigationTransition()
      if (takeInFlightRef.current === ch) {
        takeInFlightRef.current = null
        setTakeProgress((current) => current?.channelId === ch ? null : current)
      }
      if (activeTakeIdRef.current === takeId) activeTakeIdRef.current = null
      if (cancelTakeCleanupRef.current?.takeId === takeId) cancelTakeCleanupRef.current = null

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

  const doTake = async (ch: ChannelId, takeId: string, takeGeneration: number): Promise<void> => {
    // Always read fresh state from the store (not stale closure values)
    const freshState = useAppStore.getState()
    let channel = freshState.channels[ch]
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
    let cancelCleanupPromise: Promise<void> | null = null
    const finishCancelledTake = (): Promise<void> => {
      if (cancelCleanupPromise) return cancelCleanupPromise
      cancelCleanupPromise = (async () => {
        log('cancellation cleanup BEGIN')
        window.api.sendToPresentation('cancel-content-load', { takeId })
        window.api.sendToPresentation('capture-audio-live', null)
        if (prevActiveFile?.type === 'presentation' || channel.file?.type === 'presentation') {
          try { await window.api.powerpointCommand('close') } catch { /* already closed */ }
          try { await window.api.showTaskbar() } catch { /* best effort */ }
        }
        try { await window.api.musicStop() } catch { /* already stopped */ }
        if (channel.file?.type === 'other' && !channel.file.isImage && !channel.file.isAudio) {
          try { await window.api.closeExternalFile(channel.file.path) } catch { /* not opened */ }
        }

        useAppStore.setState({ activeFile: null, liveChannel: null, isPlaying: false })
        const intent = cancelOutputIntentRef.current
        if (intent.backdropImage) {
          if (!useAppStore.getState().isPresentationWindowOpen) {
            await window.api.openPresentationWindow(intent.selectedDisplayId ?? undefined)
            setPresentationWindowOpen(true)
          }
          window.api.sendToPresentation('load-content', {
            type: 'backdrop',
            path: intent.backdropImage,
            name: 'Backdrop'
          })
          await new Promise((resolve) => setTimeout(resolve, 150))
        } else {
          window.api.sendToPresentation('clear-active-content')
          if (useAppStore.getState().isPresentationWindowOpen) {
            await window.api.closePresentationWindow()
            setPresentationWindowOpen(false)
          }
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
        return
      }

      // The channel may have been cleared or replaced while Windows was
      // restoring/enumerating the native window. Never resurrect stale state.
      const currentState = useAppStore.getState()
      const currentChannel = currentState.channels[ch]
      if (currentChannel?.file?.capture?.sourceId !== captureSourceId) {
        log('desktop window prepare ignored: channel source changed')
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

    setActiveFile(channel.file)
    setLiveChannel(ch)

    // Minimize previously opened external file (Word/Excel) when switching to other content
    if (prevActiveFile?.type === 'other' && !prevActiveFile.isImage && !prevActiveFile.isAudio) {
      await window.api.minimizeExternalFile(prevActiveFile.path)
    }

    if (channel.file.type === 'presentation') {
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
          targetSlide
        )
      } finally {
        stopListeningForVisible()
      }
      log(`launchPowerPoint: END success=${result.success} error=${result.error ?? '-'}`)
      if (isTakeCancelled()) {
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
        log('launchPowerPoint failed: revealing previous output and aborting take')
        await window.api.hideOverlay()
        setOverlayState({ kind: 'hidden' })
        useAppStore.setState({
          activeFile: prevActiveFile,
          liveChannel: freshState.liveChannel
        })
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
        const td = disps.find((d) => d.id === sid) || disps.find((d) => !d.isPrimary) || disps[0]
        if (td) window.api.hideTaskbar(td.bounds)
      } catch { /* ignore */ }

      const slideAfterLaunch = useAppStore.getState().currentSlide
      const userNavigatedDuringLaunch = slideAfterLaunch !== slideBeforeLaunch
      log(`userNavigatedDuringLaunch=${userNavigatedDuringLaunch} (${slideBeforeLaunch}→${slideAfterLaunch})`)

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
      if (useAppStore.getState().isPresentationWindowOpen && !useLiveLayerSwitch) {
        await window.api.closePresentationWindow()
        setPresentationWindowOpen(false)
        log('presentation output parked at opacity=0 under ready PowerPoint')
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
      const shouldPinPowerPointTarget =
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
        await window.api.hideOverlay()
        setOverlayState({ kind: 'hidden' })
        log(useLiveLayerSwitch
          ? 'live-layer switch complete: warmed PowerPoint promoted once'
          : 'direct reveal: live PowerPoint ready')
      }
      // Channel assignment starts preview/full-slide preparation immediately.
      // Do not launch a second export after TAKE: besides being redundant, it
      // used to make diagnostics look as if caching only began on air.
      await releaseInactiveBrowserFullscreen()
      return
    }

    // PDF / Video / Other — close PowerPoint and switch audio in parallel
    const parallelTasks2: Promise<unknown>[] = []
    if (prevActiveFile?.type !== channel.file.type) {
      // Audio-device enumeration can block for 5–6 seconds on this machine.
      // It is independent from video output, so never hold the visual TAKE on
      // it; the device switch completes in parallel after the new frame shows.
      void window.api.switchAudioToExternal()
    }
    const deferPowerPointCloseUntilTargetReady =
      prevActiveFile?.type === 'presentation' &&
      (channel.file.type === 'pdf' || channel.file.type === 'video' || channel.file.type === 'capture') &&
      useLiveLayerSwitch
    if (prevActiveFile?.type === 'presentation' && !deferPowerPointCloseUntilTargetReady) {
      parallelTasks2.push(window.api.powerpointCommand('close'))
    }
    if (parallelTasks2.length > 0) await Promise.all(parallelTasks2)
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
      if (backdropImage) {
        if (!outputWindowOpen) {
          await window.api.openPresentationWindow(selectedDisplayId ?? undefined)
          setPresentationWindowOpen(true)
        }
        window.api.sendToPresentation('load-content', {
          type: 'backdrop',
          path: backdropImage,
          name: 'Backdrop'
        })
      } else if (outputWindowOpen) {
        await window.api.closePresentationWindow()
        setPresentationWindowOpen(false)
      }
      if (isTakeCancelled()) {
        await finishCancelledTake()
        return
      }
      useAppStore.getState().setMusicPlaylist([channel.file.path])
      await window.api.musicSetPlaylist([channel.file.path], 0)
      if (isTakeCancelled()) {
        await finishCancelledTake()
        return
      }
      await window.api.musicPlay()
      if (isTakeCancelled()) {
        await finishCancelledTake()
        return
      }
      await window.api.hideOverlay()
      setOverlayState({ kind: 'hidden' })
      await releaseInactiveBrowserFullscreen()
      return
    }

    // For 'other' non-image files (Word, Excel, etc.), open/restore on external display
    if (channel.file.type === 'other' && !channel.file.isImage) {
      if (prevActiveFile?.type === 'capture') {
        window.api.sendToPresentation('capture-audio-live', null)
      }
      // Show backdrop on presentation window so it's visible when Word/Excel is minimized
      const { backdropImage, selectedDisplayId } = useAppStore.getState()
      const outputWindowOpen = useAppStore.getState().isPresentationWindowOpen
      if (backdropImage) {
        if (!outputWindowOpen) {
          await window.api.openPresentationWindow(selectedDisplayId ?? undefined)
          setPresentationWindowOpen(true)
        }
        window.api.sendToPresentation('load-content', {
          type: 'backdrop',
          path: backdropImage,
          name: 'Backdrop'
        })
      } else if (outputWindowOpen) {
        await window.api.closePresentationWindow()
        setPresentationWindowOpen(false)
      }
      if (isTakeCancelled()) {
        await finishCancelledTake()
        return
      }
      const displays = await window.api.getDisplays()
      if (isTakeCancelled()) {
        await finishCancelledTake()
        return
      }
      const external = displays.find((d) => !d.isPrimary)
      // Minimize previous other file (different file) — don't close
      if (prevActiveFile?.type === 'other' && !prevActiveFile.isImage && !prevActiveFile.isAudio && prevActiveFile.path !== channel.file.path) {
        await window.api.minimizeExternalFile(prevActiveFile.path)
      }
      // Hide taskbar FIRST, wait for Windows to update work area, then position window
      if (external) {
        await window.api.hideTaskbar(external.bounds)
        await new Promise((r) => setTimeout(r, 500))
        if (isTakeCancelled()) {
          await finishCancelledTake()
          return
        }
      }
      // Try to restore; if not tracked yet, open fresh
      await window.api.restoreExternalFile(channel.file.path, external?.bounds)
      if (isTakeCancelled()) {
        await finishCancelledTake()
        return
      }
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
    await window.api.placePresentationWindow(programDisplayId)
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
      let settled = false
      let timeout: ReturnType<typeof setTimeout> | undefined
      let unsubReady = (): void => {}
      let unsubError = (): void => {}
      let unsubPrepared = (): void => {}
      let captureCommitSent = false
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
        window.removeEventListener('cancel-active-take', handleTakeCancelled)
        log(
          reason === 'received'
            ? 'content-ready received'
            : reason === 'committed'
              ? 'content-ready ACK timeout after capture commit; commit retained'
            : reason === 'cancelled'
              ? 'content-ready CANCELLED by operator'
            : reason === 'error'
              ? `content-ready ERROR ${result.error ?? '-'}`
              : `content-ready TIMEOUT (${channel.file?.type === 'capture' ? 16000 : 5000}ms)`
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
      const timeoutMs = channel.file?.type === 'capture' ? 16000 : 5000
      timeout = setTimeout(() => {
        if (channel.file?.type === 'capture' && captureCommitSent) {
          finish({ ready: true }, 'committed')
          return
        }
        finish(
          channel.file?.type === 'capture'
            ? { ready: false, error: 'Видеосигнал не появился за 16 секунд.' }
            : { ready: true },
          'timeout'
        )
      }, timeoutMs)
    })

    const savedVideo = channel.file.type === 'video'
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
      autoplay: channel.file.type === 'video' ? false : undefined,
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
      window.api.sendToPresentation('set-loop', false)
    }

    const readiness = await contentReady
    if (readiness.cancelled || isTakeCancelled()) {
      log('TAKE stopped after operator cancellation')
      await finishCancelledTake()
      return
    }
    if (!readiness.ready && channel.file.type === 'capture') {
      window.api.sendToPresentation('cancel-content-load', { takeId })
      log(`capture take aborted; previous output preserved error=${readiness.error ?? '-'}`)
      useAppStore.setState({
        activeFile: prevActiveFile,
        liveChannel: freshState.liveChannel,
        currentSlide: freshState.currentSlide,
        totalSlides: freshState.totalSlides,
        isPlaying: freshState.isPlaying
      })
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
      await window.api.powerpointCommand('close')
      log('live PowerPoint closed only after Electron target was ready underneath')
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
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="shrink-0 h-8 bg-surface-300 border-b border-gray-800 flex items-center justify-between px-3 select-none">
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

      <div className={`flex-1 grid overflow-hidden relative ${
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
        <div className="shrink-0 h-8 bg-surface-300 border-t border-gray-800 flex items-center gap-1 px-3 select-none">
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
  const [titlesMenu, setTitlesMenu] = useState<{ x: number; y: number } | null>(null)
  const [pendingSpeakerId, setPendingSpeakerId] = useState<string | null>(null)
  const [pendingEventTitle, setPendingEventTitle] = useState(false)
  const captionInputRef = useRef<HTMLInputElement>(null)
  const cancelCaptionOnBlurRef = useRef(false)

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
        void ensurePptxChannelCache(file.path).then(() => onTake())
      } else {
        setTimeout(() => onTake(), 50)
      }
    }
  }

  const {
    isPresentationWindowOpen,
    activeFile: storeActiveFile,
    broadcastTitles,
    broadcastTitlesOutput,
    setBroadcastTitles,
    setBroadcastTitlesOutput
  } = useAppStore()

  const publishSpeaker = (speakerId: string): void => {
    const speaker = useAppStore.getState().broadcastTitles.speakers.find((item) => item.id === speakerId)
    if (!speaker?.name.trim()) return
    const titles = useAppStore.getState().broadcastTitles
    setBroadcastTitlesOutput({
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

  const publishEventTitle = (): void => {
    const titles = useAppStore.getState().broadcastTitles
    if (!titles.eventInfo.trim()) return
    setBroadcastTitlesOutput({
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
    if (!pendingSpeakerId || channel.file?.type !== 'capture') return
    const expectedSourceId = channel.file.capture?.sourceId
    const activeSourceId = storeActiveFile?.type === 'capture' ? storeActiveFile.capture?.sourceId : null
    if (!expectedSourceId || activeSourceId !== expectedSourceId) return
    publishSpeaker(pendingSpeakerId)
    setPendingSpeakerId(null)
  }, [pendingSpeakerId, storeActiveFile, channel.file])

  useEffect(() => {
    if (!pendingEventTitle || channel.file?.type !== 'capture') return
    const expectedSourceId = channel.file.capture?.sourceId
    const activeSourceId = storeActiveFile?.type === 'capture' ? storeActiveFile.capture?.sourceId : null
    if (!expectedSourceId || activeSourceId !== expectedSourceId) return
    publishEventTitle()
    setPendingEventTitle(false)
  }, [pendingEventTitle, storeActiveFile, channel.file])

  useEffect(() => {
    if (channel.file?.type !== 'capture') {
      setTitlesMenu(null)
      setPendingSpeakerId(null)
      setPendingEventTitle(false)
    }
  }, [channel.file])

  const handleTitlesContextMenu = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (channel.file?.type !== 'capture') return
    event.preventDefault()
    event.stopPropagation()
    onSelect()
    const menuWidth = 310
    const menuHeight = Math.min(610, 270 + broadcastTitles.speakers.length * 54)
    setTitlesMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8))
    })
  }

  const takeAndPublishSpeaker = (speakerId: string): void => {
    setTitlesMenu(null)
    setBroadcastTitles({ selectedSpeakerId: speakerId })
    if (isLive) {
      publishSpeaker(speakerId)
      return
    }
    if (isTaking) return
    setPendingSpeakerId(speakerId)
    onTake()
  }

  const takeAndPublishEvent = (): void => {
    setTitlesMenu(null)
    if (!broadcastTitles.eventInfo.trim()) return
    if (isLive) {
      publishEventTitle()
      return
    }
    if (isTaking) return
    setPendingEventTitle(true)
    onTake()
  }
  const isOutputActive = (isPresentationWindowOpen && storeActiveFile !== null) || storeActiveFile?.type === 'presentation' || (storeActiveFile?.type === 'other' && !storeActiveFile.isImage)
  const showSelected = isSelected && !isOutputActive
  const pptxIsPreparing = channel.file?.type === 'presentation' &&
    cacheStatus !== 'ready' && cacheStatus !== 'error'

  return (
    <div
      className={`flex-1 flex flex-col overflow-hidden ${compact ? 'rounded-md border' : 'rounded-lg border-2'} transition-colors cursor-pointer ${
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
      <div className={`flex items-center min-w-0 ${compact ? 'gap-1 px-2 py-1' : 'gap-2 px-3 py-1.5'} ${isLive ? 'bg-red-900/30' : showSelected ? 'bg-blue-900/20' : 'bg-surface-200'}`}>
        <span className={`${compact ? 'w-1.5 h-1.5' : 'w-2 h-2'} rounded-full shrink-0 ${isLive ? 'bg-red-500 animate-pulse' : showSelected ? 'bg-blue-500' : 'bg-gray-600'}`} />
        <span className={`shrink-0 ${compact ? 'text-[9px]' : 'text-[10px]'} font-bold uppercase ${isLive ? 'text-red-400' : showSelected ? 'text-blue-400' : 'text-gray-500'}`}>
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
      <div className="relative flex-1 flex items-center justify-center overflow-hidden bg-black/40">
        {channel.file ? (
          <SlideRenderer
            file={channel.file}
            slideNum={channel.slide}
            pptxThumbnails={pptxThumbnails}
            onTotalSlides={onSetTotalSlides}
          />
        ) : (
          <div className={`${compact ? 'text-[10px] p-1' : 'text-xs p-4'} text-gray-600 text-center select-none`}>
            <div className={`${compact ? 'text-lg mb-0.5' : 'text-2xl mb-2'} opacity-30`}>📥</div>
            Перетащите материал сюда
          </div>
        )}
        {isLive && channel.file?.type === 'capture' && (
          <BroadcastTitlesOverlay titles={broadcastTitlesOutput} />
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
            onContextMenu={(event) => event.preventDefault()}
          >
            <div className="border-b border-gray-700 px-3 py-2.5">
              <div className="text-xs font-semibold text-white">Титры канала</div>
              <div className="mt-0.5 text-[10px] text-gray-500">
                Канал {label}{isLive ? ' уже в эфире' : ' будет отправлен в эфир'}
              </div>
            </div>

            <div className="border-b border-gray-700 p-1.5">
              <div className="px-2 pb-1 pt-0.5 text-[9px] font-semibold uppercase tracking-[.12em] text-emerald-400">
                Информация о мероприятии
              </div>
              <button
                type="button"
                disabled={!broadcastTitles.eventInfo.trim() || isTaking}
                onClick={takeAndPublishEvent}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
                  broadcastTitlesOutput.eventVisible ? 'bg-emerald-900/40' : 'hover:bg-gray-700/70'
                }`}
              >
                <span className={`h-2 w-2 shrink-0 rounded-full ${broadcastTitlesOutput.eventVisible ? 'bg-red-500' : 'bg-emerald-500'}`} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-gray-100">
                    {broadcastTitles.eventLabel.trim() || 'Без заголовка'}
                  </span>
                  <span className="block truncate text-[10px] text-gray-500">
                    {broadcastTitles.eventInfo.trim() || 'Заполните информацию через кнопку «▰ Титры»'}
                  </span>
                </span>
                {broadcastTitlesOutput.eventVisible && <span className="text-[8px] font-semibold text-red-300">ЭФИР</span>}
              </button>
              {broadcastTitlesOutput.eventVisible && (
                <button
                  type="button"
                  onClick={() => {
                    setTitlesMenu(null)
                    setBroadcastTitlesOutput({ eventVisible: false })
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
                  const live = broadcastTitlesOutput.speakerVisible && broadcastTitlesOutput.speakerId === speaker.id
                  return (
                    <button
                      key={speaker.id}
                      type="button"
                      disabled={!speaker.name.trim() || isTaking}
                      onClick={() => takeAndPublishSpeaker(speaker.id)}
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
                      {live && <span className="text-[8px] font-semibold text-red-300">ЭФИР</span>}
                    </button>
                  )
                })}
              </div>
            ) : (
              <div className="px-3 py-5 text-center text-[11px] text-gray-500">
                Сначала добавьте выступающих через кнопку «▰ Титры».
              </div>
            )}

            {broadcastTitlesOutput.speakerVisible && (
              <button
                type="button"
                onClick={() => {
                  setTitlesMenu(null)
                  setBroadcastTitlesOutput({ speakerVisible: false })
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

function SlideRenderer({ file, slideNum, pptxThumbnails, onTotalSlides }: {
  file: FileEntry
  slideNum: number
  pptxThumbnails: string[]
  onTotalSlides: (total: number) => void
}): JSX.Element {
  if (file.type === 'pdf') return <PdfPreview file={file} currentSlide={slideNum} onTotalSlides={onTotalSlides} />
  if (file.type === 'presentation') return <PptxPreview file={file} currentSlide={slideNum} pptxThumbnails={pptxThumbnails} />
  if (file.type === 'video') return <VideoPreview file={file} />
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
  const [pdf, setPdf] = useState<pdfjsLib.PDFDocumentProxy | null>(null)
  const renderTaskRef = useRef<pdfjsLib.PDFRenderTask | null>(null)
  const renderGenerationRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    async function load(): Promise<void> {
      try {
        const data = await window.api.readFile(file.path)
        const doc = await pdfjsLib.getDocument({ data }).promise
        if (!cancelled) {
          setPdf(doc)
          onTotalSlides(doc.numPages)
        }
      } catch (err) {
        console.error('Preview: Failed to load PDF:', err)
      }
    }
    load()
    return () => { cancelled = true }
  }, [file.path])

  const renderPage = useCallback(async (pageNum: number) => {
    if (!pdf || !canvasRef.current || !containerRef.current) return
    const generation = ++renderGenerationRef.current
    renderTaskRef.current?.cancel()
    const page = await pdf.getPage(pageNum)
    if (generation !== renderGenerationRef.current) return
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const containerWidth = containerRef.current.clientWidth
    const containerHeight = containerRef.current.clientHeight
    const viewport = page.getViewport({ scale: 1 })
    const scale = Math.min(containerWidth / viewport.width, containerHeight / viewport.height)
    const scaledViewport = page.getViewport({ scale })

    canvas.width = scaledViewport.width
    canvas.height = scaledViewport.height

    const renderTask = page.render({ canvasContext: ctx, viewport: scaledViewport })
    renderTaskRef.current = renderTask
    try {
      await renderTask.promise
    } catch (error) {
      if (generation === renderGenerationRef.current) throw error
    } finally {
      if (renderTaskRef.current === renderTask) renderTaskRef.current = null
    }
  }, [pdf])

  useEffect(() => {
    if (pdf && currentSlide >= 1 && currentSlide <= pdf.numPages) void renderPage(currentSlide)
    return () => {
      renderGenerationRef.current += 1
      renderTaskRef.current?.cancel()
      renderTaskRef.current = null
    }
  }, [currentSlide, pdf, renderPage])

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
  return (
    <div className="w-full h-full flex items-center justify-center">
      <video
        src={mediaUrl(file.path)}
        className="max-w-full max-h-full rounded-lg"
        controls={false}
        muted
        preload="metadata"
        onLoadedMetadata={(e) => { e.currentTarget.currentTime = 1 }}
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
      try {
        const data = await window.api.readFile(pdfPath!)
        const doc = await pdfjsLib.getDocument({ data }).promise
        const page = await doc.getPage(1)
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
          await page.render({ canvasContext: ctx, viewport: scaledViewport }).promise
        }
      } catch {
        if (!cancelled) setFailed(true)
      }
    }

    render()
    return () => { cancelled = true }
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
