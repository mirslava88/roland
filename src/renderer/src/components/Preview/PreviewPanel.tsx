import { useEffect, useRef, useCallback, useState } from 'react'
import { useAppStore, ChannelState, ChannelId, CHANNELS_PER_PAGE, resetPptxNavState, awaitPptxGotoChainIdle } from '../../stores/useAppStore'
import { mediaUrl } from '../../media'
import {
  beginNavigationTransition,
  drainNavigationTransition,
  pendingNavigationCount,
  finishNavigationTransition
} from '../../navigation-transition'
import * as pdfjsLib from 'pdfjs-dist'

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

export function PreviewPanel(): JSX.Element {
  const {
    channels, channelIds, currentChannelPage,
    liveChannel, selectedChannel, setSelectedChannel,
    setChannelFile, setChannelSlide, setChannelTotalSlides,
    setPresentationWindowOpen,
    setActiveFile, setCurrentSlide, setTotalSlides, setLiveChannel,
    clearSlidePosition,
    addChannelPage, removeChannelPage, setCurrentChannelPage,
    pptxThumbnailsMap, setOverlayState
  } = useAppStore()

  const takeInFlightRef = useRef<ChannelId | null>(null)
  const queuedTakeRef = useRef<ChannelId | null>(null)
  const hasPowerPointStartedRef = useRef(false)
  const [takeProgress, setTakeProgress] = useState<{
    channelId: ChannelId
    message: string | null
  } | null>(null)

  const totalPages = Math.max(1, Math.ceil(channelIds.length / CHANNELS_PER_PAGE))
  const pageStart = currentChannelPage * CHANNELS_PER_PAGE
  const pageIds = channelIds.slice(pageStart, pageStart + CHANNELS_PER_PAGE)
  const liveChannelPage = liveChannel
    ? Math.floor(channelIds.indexOf(liveChannel) / CHANNELS_PER_PAGE)
    : -1
  const currentPageIsEmpty = pageIds.every((id) => !channels[id]?.file)

  const handleClear = async (ch: ChannelId): Promise<void> => {
    const channel = channels[ch]
    if (!channel) return
    const clearedFilePath = channel.file?.path
    // If this channel is live, close the presentation
    if (liveChannel === ch && channel.file) {
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
        if (useAppStore.getState().isPresentationWindowOpen) {
          await window.api.closePresentationWindow()
          setPresentationWindowOpen(false)
        }
      }

      if (needsCover) {
        await window.api.hideOverlay()
        setOverlayState({ kind: 'hidden' })
      }

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
    const isFirstPowerPointStart =
      file.type === 'presentation' &&
      !isSameFilePptx &&
      !hasPowerPointStartedRef.current
    const message = isFirstPowerPointStart
      ? 'Ожидайте, презентация открывается...'
      : file.type === 'video'
        ? 'Ожидайте, видеоролик открывается...'
        : null

    // Close the same-tick double-click gap before React renders disabled UI.
    // Concurrent TAKE pipelines race over PowerPoint, overlay and live state.
    takeInFlightRef.current = ch
    beginNavigationTransition()
    if (message) {
      setTakeProgress({ channelId: ch, message })
    }

    // Top-level safety net: если handleTake бросит (daemon crash,
    // launchPowerPoint reject, capturePage fail), overlay оставался бы
    // opacity=1 чёрным НАВСЕГДА — юзер видит зависший чёрный экран без
    // способа recovery (audit F-205). Ловим, логируем, force-hide overlay.
    try {
      await doTake(ch)
    } catch (err) {
      console.error('[TAKE] unhandled error, forcing overlay hide:', err)
      try { await window.api.hideOverlay() } catch { /* last resort */ }
      setOverlayState({ kind: 'hidden' })
    } finally {
      const queuedNavigation = finishNavigationTransition()
      if (takeInFlightRef.current === ch) {
        takeInFlightRef.current = null
        setTakeProgress((current) => current?.channelId === ch ? null : current)
      }

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

  const doTake = async (ch: ChannelId): Promise<void> => {
    // Always read fresh state from the store (not stale closure values)
    const freshState = useAppStore.getState()
    const channel = freshState.channels[ch]
    if (!channel?.file) return

    // Save previous active file before overwriting
    const prevActiveFile = freshState.activeFile

    const T0 = performance.now()
    const log = (step: string): void => {
      const ms = (performance.now() - T0).toFixed(0)
      console.log(`[TAKE ${ms}ms] ${step}`)
      // Дублируем в main stdout чтобы иметь единый timeline вместе с
      // [MAIN], [DAEMON], [R] логами при диагностике мерцаний.
      window.api.dbgLog(`TAKE +${ms}ms: ${step}`)
    }
    log(`BEGIN prev=${prevActiveFile?.type} next=${channel.file.type} slide=${channel.slide}`)

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
          (channel.file.type === 'presentation' || channel.file.type === 'pdf' || channel.file.type === 'video')) ||
        ((prevActiveFile?.type === 'pdf' || prevActiveFile?.type === 'video') &&
          channel.file.type === 'presentation')
      )
    const useBufferedElectronSwitch =
      (prevActiveFile?.type === 'pdf' || prevActiveFile?.type === 'video') &&
      (channel.file.type === 'pdf' || channel.file.type === 'video') &&
      (prevActiveFile?.type === 'video' || channel.file.type === 'video')
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

    setActiveFile(channel.file)
    setLiveChannel(ch)

    // Minimize previously opened external file (Word/Excel) when switching to other content
    if (prevActiveFile?.type === 'other' && !prevActiveFile.isImage) {
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
      if (result.success) {
        hasPowerPointStartedRef.current = true
        setTakeProgress((current) => current?.channelId === ch ? null : current)
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

      // The slideshow is ready but still covered. Apply clicks made while it
      // was opening now, so the first revealed frame is already the requested
      // slide instead of briefly exposing the launch slide.
      await applyQueuedNavigationUnderOverlay('presentation')

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
      const shouldPinPowerPointTarget =
        !useSeamlessLayerSwitch &&
        (prevActiveFile?.type === 'pdf' ||
          prevActiveFile?.type === 'video' ||
          (isPptxToPptx && (!isSameFilePptx || hadPinnedOverlay)))
      if (shouldPinPowerPointTarget) {
        log('target snapshot: PowerPoint BEGIN')
        const targetSnapshot = await window.api.snapshotSlideshow()
        log(`target snapshot: PowerPoint END path=${targetSnapshot ? 'ok' : 'null'}`)
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
      // Генерим превью/слайды ПОСЛЕ hideOverlay. Эти вызовы спавнят отдельный
      // powerpoint-control.ps1 процесс, который делает $ppt.WindowState=2 +
      // $ppt.Visible=1 + Hide-PPEditorWindow на том же COM-инстансе, который
      // daemon уже держит со слайдшоу. Если это делать ПОКА оверлей ещё висит,
      // PP может мигнуть editor-окном / ре-активировать slideshow прямо под
      // оверлеем — user видит новый слайд до того, как оверлей исчезает.
      window.api.generatePptxThumbnails(channel.file.path).then((thumbResult) => {
        if (thumbResult.success && thumbResult.thumbnails) {
          const { pptxThumbnailsMap } = useAppStore.getState()
          useAppStore.setState({ pptxThumbnailsMap: { ...pptxThumbnailsMap, [channel.file!.path]: thumbResult.thumbnails } })
        }
      })
      const { pptxSlidesMap: existingSlides } = useAppStore.getState()
      if (!existingSlides[pptxPath]) {
        window.api.generatePptxSlides(pptxPath).then((slidesResult) => {
          if (slidesResult.success && slidesResult.slides) {
            const { pptxSlidesMap } = useAppStore.getState()
            useAppStore.setState({ pptxSlidesMap: { ...pptxSlidesMap, [pptxPath]: slidesResult.slides } })
          }
        })
      }
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
      (channel.file.type === 'pdf' || channel.file.type === 'video') &&
      useLiveLayerSwitch
    if (prevActiveFile?.type === 'presentation' && !deferPowerPointCloseUntilTargetReady) {
      parallelTasks2.push(window.api.powerpointCommand('close'))
    }
    if (parallelTasks2.length > 0) await Promise.all(parallelTasks2)

    // Audio files — play in built-in music player + show backdrop
    if (channel.file.type === 'other' && channel.file.isAudio) {
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
      useAppStore.getState().setMusicPlaylist([channel.file.path])
      await window.api.musicSetPlaylist([channel.file.path], 0)
      await window.api.musicPlay()
      await window.api.hideOverlay()
      setOverlayState({ kind: 'hidden' })
      return
    }

    // For 'other' non-image files (Word, Excel, etc.), open/restore on external display
    if (channel.file.type === 'other' && !channel.file.isImage) {
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
      const displays = await window.api.getDisplays()
      const external = displays.find((d) => !d.isPrimary)
      // Minimize previous other file (different file) — don't close
      if (prevActiveFile?.type === 'other' && !prevActiveFile.isImage && prevActiveFile.path !== channel.file.path) {
        await window.api.minimizeExternalFile(prevActiveFile.path)
      }
      // Hide taskbar FIRST, wait for Windows to update work area, then position window
      if (external) {
        await window.api.hideTaskbar(external.bounds)
        await new Promise((r) => setTimeout(r, 500))
      }
      // Try to restore; if not tracked yet, open fresh
      await window.api.restoreExternalFile(channel.file.path, external?.bounds)
      await window.api.hideOverlay()
      setOverlayState({ kind: 'hidden' })
      return
    }

    const outputWindowWasOpen = useAppStore.getState().isPresentationWindowOpen
    const revealWarmOutputAfterPaint =
      !outputWindowWasOpen && prevActiveFile?.type === 'presentation'
    if (!outputWindowWasOpen && !revealWarmOutputAfterPaint) {
      await window.api.openPresentationWindow(useAppStore.getState().selectedDisplayId ?? undefined)
      setPresentationWindowOpen(true)
    }

    // Subscribe BEFORE sending load-content so we can't miss the signal.
    // PdfViewer emits 'presentation-content-ready' after its first drawImage;
    // <img> elements emit it after onLoad; VideoViewer emits it after the
    // first decoded frame is submitted for composition.
    const contentReady = new Promise<void>((resolve) => {
      let settled = false
      let timeout: ReturnType<typeof setTimeout> | undefined
      let unsub = (): void => {}
      const finish = (reason: 'received' | 'timeout'): void => {
        if (settled) return
        settled = true
        if (timeout) clearTimeout(timeout)
        unsub()
        log(reason === 'received' ? 'content-ready received' : 'content-ready TIMEOUT (5000ms)')
        resolve()
      }
      unsub = window.api.on('presentation-content-ready', () => finish('received'))
      // Slow machines and high-bitrate local videos can need more than two
      // seconds to initialize a decoder. Do not capture the window while it
      // is still black unless the renderer genuinely failed to become ready.
      timeout = setTimeout(() => finish('timeout'), 5000)
    })

    const savedVideo = channel.file.type === 'video'
      ? useAppStore.getState().videoPlayback[channel.file.path]
      : undefined
    if (savedVideo) {
      log(`video restore: time=${savedVideo.currentTime.toFixed(3)} savedPlaying=${savedVideo.playing} startPaused=true`)
    }

    window.api.sendToPresentation('load-content', {
      type: channel.file.type,
      path: channel.file.path,
      name: channel.file.name,
      startSlide: channel.slide,
      startTime: savedVideo?.currentTime,
      autoplay: channel.file.type === 'video' ? false : undefined,
      isImage: channel.file.isImage
    })

    await contentReady
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
    if (deferPowerPointCloseUntilTargetReady) {
      await window.api.powerpointCommand('close')
      log('live PowerPoint closed only after Electron target was ready underneath')
    }
    const shouldPinPdfTarget =
      !useSeamlessLayerSwitch &&
      channel.file.type === 'pdf' &&
      (prevActiveFile?.type === 'presentation' || prevActiveFile?.type === 'video')
    if (shouldPinPdfTarget) {
      log('target capture: PDF BEGIN')
      const targetSwapped = await window.api.captureAndSwapOverlay()
      log(`target capture: PDF END swapped=${targetSwapped}`)
      if (targetSwapped) {
        await window.api.pinOverlay()
        setOverlayState({ kind: 'pinned-pdf', pdfPath: channel.file.path })
        log('atomic target swap complete: PDF frame pinned until navigation')
        return
      }
    }
    log(useSeamlessLayerSwitch
      ? 'seamless layer switch complete: prepared target exposed once'
      : 'direct reveal: target output ready')
    await window.api.hideOverlay()
    setOverlayState({ kind: 'hidden' })
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

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="flex-1 grid grid-cols-2 grid-rows-2 gap-2 overflow-hidden p-3 relative">
        {pageIds.map((id) => {
          const channel = channels[id] || { file: null, slide: 1, totalSlides: 0 }
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
              onSelect={() => setSelectedChannel(id)}
              onTake={() => handleTake(id)}
              onClear={() => handleClear(id)}
              pptxThumbnails={channel.file ? pptxThumbnailsMap[channel.file.path] || [] : []}
            />
          )
        })}

        {/* Центральная "+" — добавить 4 новых канала на новой странице */}
        <button
          onClick={() => addChannelPage()}
          title="Добавить 4 канала (новая страница)"
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-surface-100/90 hover:bg-accent/90 hover:text-white text-gray-300 text-xl font-bold border border-gray-700 shadow-lg backdrop-blur-xs transition-colors z-10 flex items-center justify-center"
        >
          +
        </button>
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
                    'На странице есть файлы в каналах. Удалить страницу со всем содержимым?'
                  )
                  if (!ok) return
                  pageIds.forEach((id) => setChannelFile(id, null))
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
  onSelect: () => void
  onTake: () => void
  onClear: () => void
  pptxThumbnails: string[]
}

function ChannelPanel({
  label, channel, isLive, isSelected, isTaking, openingMessage,
  onDrop, onSlideChange, onSetTotalSlides, onSelect, onTake, onClear, pptxThumbnails
}: ChannelPanelProps): JSX.Element {
  const [dragOver, setDragOver] = useState(false)
  const [slideInput, setSlideInput] = useState('')
  const [slideFocused, setSlideFocused] = useState(false)

  // Keep input synced with channel.slide when not being edited
  useEffect(() => {
    if (!slideFocused) setSlideInput(String(channel.slide))
  }, [channel.slide, slideFocused])

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
    // Pre-generate thumbnails for PPTX
    if (file.type === 'presentation') {
      const result = await window.api.generatePptxThumbnails(file.path)
      if (result.success && result.thumbnails) {
        const { pptxThumbnailsMap } = useAppStore.getState()
        useAppStore.setState({ pptxThumbnailsMap: { ...pptxThumbnailsMap, [file.path]: result.thumbnails } })
        if (result.slideCount) onSetTotalSlides(result.slideCount)
      }
      // Pre-render full-resolution slides in background for zero-flicker
      // PPTX→PPTX channel switches (Option 2 Hybrid mode).
      const filePath = file.path
      const { pptxSlidesMap: existingSlides } = useAppStore.getState()
      if (!existingSlides[filePath]) {
        window.api.generatePptxSlides(filePath).then((slidesResult) => {
          if (slidesResult.success && slidesResult.slides) {
            const { pptxSlidesMap } = useAppStore.getState()
            useAppStore.setState({ pptxSlidesMap: { ...pptxSlidesMap, [filePath]: slidesResult.slides } })
          }
        })
      }
    }
    if (isLive) {
      // Auto-take when dropping into the live channel
      setTimeout(() => onTake(), 50)
    }
  }

  const { isPresentationWindowOpen, activeFile: storeActiveFile } = useAppStore()
  const isOutputActive = (isPresentationWindowOpen && storeActiveFile !== null) || storeActiveFile?.type === 'presentation' || (storeActiveFile?.type === 'other' && !storeActiveFile.isImage)
  const showSelected = isSelected && !isOutputActive

  return (
    <div
      className={`flex-1 flex flex-col overflow-hidden rounded-lg border-2 transition-colors cursor-pointer ${
        dragOver ? 'border-accent bg-accent/5' :
        isLive ? 'border-red-500/60' :
        showSelected ? 'border-blue-500/60' : 'border-gray-700/50'
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={onSelect}
      onDoubleClick={isTaking ? undefined : onTake}
      aria-busy={isTaking}
    >
      {/* Header. min-w-0 на flex-контейнере + shrink-0 на фиксированных
          элементах (dot, label, ✕). Имя файла с flex-1 + min-w-0 + truncate
          — сжимается и обрезается многоточием вместо выталкивания ✕. */}
      <div className={`flex items-center gap-2 px-3 py-1.5 min-w-0 ${isLive ? 'bg-red-900/30' : showSelected ? 'bg-blue-900/20' : 'bg-surface-200'}`}>
        <span className={`w-2 h-2 rounded-full shrink-0 ${isLive ? 'bg-red-500 animate-pulse' : showSelected ? 'bg-blue-500' : 'bg-gray-600'}`} />
        <span className={`shrink-0 text-[10px] font-bold uppercase ${isLive ? 'text-red-400' : showSelected ? 'text-blue-400' : 'text-gray-500'}`}>
          Канал {label} {isLive ? '• В ЭФИРЕ' : showSelected ? '• ВЫБРАНО' : ''}
        </span>
        {channel.file && (
          <span className="flex-1 min-w-0 text-[11px] text-gray-400 truncate ml-1" title={channel.file.name}>{channel.file.name}</span>
        )}
        {channel.file && (
          <button
            onClick={(e) => { e.stopPropagation(); onClear() }}
            onDoubleClick={(e) => e.stopPropagation()}
            disabled={isTaking}
            className="shrink-0 text-gray-500 hover:text-white text-sm leading-none px-1 rounded-sm hover:bg-white/10 transition-colors disabled:opacity-30 disabled:hover:text-gray-500 disabled:hover:bg-transparent"
            title="Убрать файл"
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
            isLive={isLive}
            pptxThumbnails={pptxThumbnails}
            onTotalSlides={onSetTotalSlides}
          />
        ) : (
          <div className="text-gray-600 text-xs text-center select-none p-4">
            <div className="text-2xl mb-2 opacity-30">📥</div>
            Перетащите файл сюда
          </div>
        )}
        {isTaking && openingMessage && (
          <div
            className="absolute inset-0 z-10 pointer-events-none flex flex-col items-center justify-center gap-3 bg-black/75 px-4"
            role="status"
            aria-live="polite"
          >
            <span className="h-6 w-6 rounded-full border-2 border-gray-500 border-t-white animate-spin" />
            <span className="text-xs font-medium text-gray-100 text-center">
              {openingMessage}
            </span>
          </div>
        )}
      </div>

      {/* Navigation — only for non-live channel */}
      {!isLive && channel.file && (channel.file.type === 'pdf' || channel.file.type === 'presentation') && (
        <div
          className="flex items-center justify-center gap-3 py-1.5 bg-surface-200 border-t border-gray-800 relative"
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={(e) => { e.stopPropagation(); if (channel.slide > 1) onSlideChange(channel.slide - 1) }}
            onDoubleClick={(e) => e.stopPropagation()}
            className="btn-icon text-[10px]"
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
              className="w-12 text-[10px] text-center bg-surface-100 border border-gray-600 focus:border-accent rounded-sm px-1 py-0.5 text-white tabular-nums outline-hidden"
              title="Введите номер слайда и нажмите Enter"
            />
            {channel.totalSlides > 0 && (
              <span className="text-[10px] text-gray-500 tabular-nums">/ {channel.totalSlides}</span>
            )}
          </div>
          <button
            onClick={(e) => { e.stopPropagation(); if (channel.totalSlides === 0 || channel.slide < channel.totalSlides) onSlideChange(channel.slide + 1) }}
            onDoubleClick={(e) => e.stopPropagation()}
            className="btn-icon text-[10px]"
            disabled={isTaking || (channel.totalSlides > 0 && channel.slide >= channel.totalSlides)}
          >
            ▶
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); if (channel.slide > 1) onSlideChange(1) }}
            onDoubleClick={(e) => e.stopPropagation()}
            className="btn-icon text-[10px]"
            disabled={isTaking || channel.slide <= 1}
            title="К первому слайду"
          >
            ⏮
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onTake() }}
            onDoubleClick={(e) => e.stopPropagation()}
            disabled={isTaking}
            className="absolute right-2 bg-red-600 hover:bg-red-500 text-white text-[9px] font-bold px-2 py-1 rounded-sm transition-colors disabled:opacity-40 disabled:hover:bg-red-600"
          >
            В эфир
          </button>
        </div>
      )}
      {/* Take button for video/other in non-live channel */}
      {!isLive && channel.file && (channel.file.type === 'video' || channel.file.type === 'other') && (
        <div
          className="flex items-center justify-end py-1.5 px-2 bg-surface-200 border-t border-gray-800"
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={(e) => { e.stopPropagation(); onTake() }}
            onDoubleClick={(e) => e.stopPropagation()}
            disabled={isTaking}
            className="bg-red-600 hover:bg-red-500 text-white text-[9px] font-bold px-2 py-1 rounded-sm transition-colors disabled:opacity-40 disabled:hover:bg-red-600"
          >
            В эфир
          </button>
        </div>
      )}
    </div>
  )
}

function SlideRenderer({ file, slideNum, isLive, pptxThumbnails, onTotalSlides }: {
  file: FileEntry
  slideNum: number
  isLive: boolean
  pptxThumbnails: string[]
  onTotalSlides: (total: number) => void
}): JSX.Element {
  if (file.type === 'pdf') return <PdfPreview file={file} currentSlide={slideNum} isLive={isLive} onTotalSlides={onTotalSlides} />
  if (file.type === 'presentation') return <PptxPreview file={file} currentSlide={slideNum} pptxThumbnails={pptxThumbnails} />
  if (file.type === 'video') return <VideoPreview file={file} />
  if (file.type === 'other') return <OtherPreview file={file} />
  return <div className="text-gray-500 text-xs">Unsupported</div>
}

function PdfPreview({ file, currentSlide, isLive, onTotalSlides }: {
  file: FileEntry; currentSlide: number; isLive: boolean; onTotalSlides: (t: number) => void
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
    if (isLive) {
      renderGenerationRef.current += 1
      renderTaskRef.current?.cancel()
      renderTaskRef.current = null
      return
    }
    if (pdf && currentSlide >= 1 && currentSlide <= pdf.numPages) void renderPage(currentSlide)
    return () => {
      renderGenerationRef.current += 1
      renderTaskRef.current?.cancel()
      renderTaskRef.current = null
    }
  }, [currentSlide, isLive, pdf, renderPage])

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
