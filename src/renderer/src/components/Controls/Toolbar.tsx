import { Component, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react'
import { useAppStore } from '../../stores/useAppStore'
import { Timer } from './Timer'
import { StreamControl } from './StreamControl'
import { EventTimer } from '../EventTimer/EventTimer'
import { MusicPlayer } from './MusicPlayer'
import { VideoPlayer } from './VideoPlayer'
import { SettingsModal } from './SettingsModal'
import { AuxiliaryDisplaysModal } from '../AuxiliaryDisplays/AuxiliaryDisplaysModal'
import { BroadcastTitles } from '../BroadcastTitles/BroadcastTitles'
import { ProgramSceneModal } from '../ProgramScene/ProgramSceneModal'
import { QrOverlayModal } from '../QrOverlay/QrOverlayModal'
import { hasQrData } from '../../../../shared/qr-overlay'
import { acquireOutputTransition } from '../../output-transition-lock'
import {
  PROGRAM_SCENE_TRANSITION_DURATION_MS,
  type ProgramSceneViewMode
} from '../../../../shared/program-scene'

const PROGRAM_SCENE_VIEW_BUTTONS: Array<{ mode: ProgramSceneViewMode; title: string }> = [
  { mode: 'participant', title: 'Участник на весь экран' },
  { mode: 'content', title: 'Контент на весь экран' },
  { mode: 'both', title: 'Участник и контент' }
]

class ProgramSceneModalBoundary extends Component<
  { children: ReactNode; onClose: () => void },
  { error: string | null }
> {
  state = { error: null as string | null }

  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? error.message : String(error) }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    window.api.dbgLog(`ProgramSceneModal render failed: ${String(error)} ${info.componentStack || ''}`)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4">
        <div className="w-[420px] max-w-[92vw] rounded-xl border border-red-500/60 bg-surface-300 p-4 text-white shadow-2xl">
          <div className="text-sm font-semibold">Не удалось открыть настройки</div>
          <div className="mt-2 text-xs text-gray-300">Ошибка записана в диагностический лог.</div>
          <button
            type="button"
            onClick={this.props.onClose}
            className="mt-4 rounded-lg bg-blue-600 px-4 py-1.5 text-sm hover:bg-blue-500"
          >
            Закрыть
          </button>
        </div>
      </div>
    )
  }
}

function ProgramSceneViewIcon({ mode }: { mode: ProgramSceneViewMode }): JSX.Element {
  if (mode === 'participant') {
    return (
      <svg viewBox="0 0 28 20" className="h-4 w-6" fill="none" aria-hidden="true">
        <rect x="1" y="1" width="26" height="18" rx="2" stroke="currentColor" strokeWidth="1.6" />
        <circle cx="14" cy="7" r="2.6" fill="currentColor" />
        <path d="M8.8 16c.8-3.2 2.6-4.8 5.2-4.8s4.4 1.6 5.2 4.8" fill="currentColor" />
      </svg>
    )
  }
  if (mode === 'content') {
    return (
      <svg viewBox="0 0 28 20" className="h-4 w-6" fill="none" aria-hidden="true">
        <rect x="1" y="1" width="26" height="18" rx="2" stroke="currentColor" strokeWidth="1.6" />
        <rect x="5" y="5" width="8" height="7" rx="1" fill="currentColor" opacity="0.9" />
        <path d="M16 6h7M16 9h7M5 15h18" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 28 20" className="h-4 w-6" fill="none" aria-hidden="true">
      <rect x="1" y="1" width="26" height="18" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <rect x="4" y="4" width="12" height="12" rx="1" fill="currentColor" opacity="0.9" />
      <circle cx="21.5" cy="7.5" r="2" fill="currentColor" />
      <path d="M18 15c.5-2.7 1.7-4 3.5-4s3 1.3 3.5 4" fill="currentColor" />
    </svg>
  )
}

export function Toolbar(): JSX.Element {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [auxiliaryDisplaysOpen, setAuxiliaryDisplaysOpen] = useState(false)
  const [outputCloseInFlight, setOutputCloseInFlight] = useState(false)
  const [programSceneOpen, setProgramSceneOpen] = useState(false)
  const [qrOverlayOpen, setQrOverlayOpen] = useState(false)
  const outputCloseInFlightRef = useRef(false)
  const programSceneFocusGenerationRef = useRef(0)
  const {
    isPresentationWindowOpen,
    setPresentationWindowOpen,
    activeFile,
    setActiveFile,
    selectedDisplayId,
    backdropImage,
    setBackdropImage,
    globalHookEnabled,
    setGlobalHookEnabled,
    channelBoundaryNavigationEnabled,
    setChannelBoundaryNavigationEnabled,
    displays,
    displayAssignments,
    channels,
    selectedChannel,
    pptxCacheStatuses,
    setOverlayState
  } = useAppStore()
  const programScene = useAppStore((state) => state.programScene)
  const captureSources = useAppStore((state) => state.captureSources)
  const setProgramScene = useAppStore((state) => state.setProgramScene)
  const qrOverlay = useAppStore((state) => state.qrOverlay)
  const setQrOverlay = useAppStore((state) => state.setQrOverlay)

  const setLiveChannelNull = (): void => useAppStore.setState({ liveChannel: null })

  useEffect(() => {
    const handleOpenAuxiliaryDisplays = (): void => setAuxiliaryDisplaysOpen(true)
    window.addEventListener('open-auxiliary-displays', handleOpenAuxiliaryDisplays)
    return () => window.removeEventListener('open-auxiliary-displays', handleOpenAuxiliaryDisplays)
  }, [])

  const isOutputActive = (isPresentationWindowOpen && activeFile !== null) || activeFile?.type === 'presentation' || (activeFile?.type === 'other' && !activeFile.isImage)
  const selectedChannelHasContent = selectedChannel !== null && Boolean(channels[selectedChannel]?.file)
  const selectedChannelFile = selectedChannel !== null ? channels[selectedChannel]?.file : null
  const selectedPptxIsPreparing = selectedChannelFile?.type === 'presentation' &&
    pptxCacheStatuses[selectedChannelFile.path] !== 'ready' &&
    pptxCacheStatuses[selectedChannelFile.path] !== 'error'
  const canTogglePresentation = isOutputActive || (selectedChannelHasContent && !selectedPptxIsPreparing)
  const assignedModes = displays
    .filter((display) => !display.isPrimary)
    .map((display) => displayAssignments[String(display.id)] || 'off')
  const hasAdditionalScreenOutput = assignedModes.some((mode) => mode !== 'program') ||
    assignedModes.filter((mode) => mode === 'program').length > 1
  const programSceneReady = Boolean(backdropImage) && captureSources.some(
    (entry) => entry.capture?.sourceId === programScene.captureSourceId
  )

  const handleQuickProgramSceneToggle = (): void => {
    if (programScene.enabled) {
      setProgramScene({ enabled: false })
      return
    }
    if (!programSceneReady) {
      setProgramSceneOpen(true)
      return
    }
    const state = useAppStore.getState()
    const targetDisplay = state.displays.find((display) => (
      !display.isPrimary && display.id === state.selectedDisplayId
    )) || state.displays.find((display) => !display.isPrimary)
    if (targetDisplay) {
      void window.api.hideTaskbar(targetDisplay.bounds).catch((error: unknown) => {
        window.api.dbgLog(`program scene taskbar hide failed: ${String(error)}`)
      })
    }
    setProgramScene({ enabled: true, viewMode: 'both' })
  }

  const showPowerPointTransitionHold = (path: string, requestId: string): Promise<boolean> => (
    new Promise((resolve) => {
      let settled = false
      let readyUnsubscribe = (): void => {}
      let errorUnsubscribe = (): void => {}
      const finish = (ready: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        readyUnsubscribe()
        errorUnsubscribe()
        resolve(ready)
      }
      const timeout = setTimeout(() => finish(false), 1500)
      readyUnsubscribe = window.api.on('program-scene-powerpoint-hold-ready', (...args: unknown[]) => {
        if (args[0] === requestId) finish(true)
      })
      errorUnsubscribe = window.api.on('program-scene-powerpoint-hold-error', (...args: unknown[]) => {
        if (args[0] === requestId) finish(false)
      })
      window.api.sendToPresentation('program-scene-powerpoint-hold', { requestId, path })
    })
  )

  const handleProgramSceneViewMode = async (mode: ProgramSceneViewMode): Promise<void> => {
    const state = useAppStore.getState()
    const currentMode = state.programScene.viewMode ?? 'both'
    if (mode === currentMode) return
    const generation = ++programSceneFocusGenerationRef.current

    const transitionEffect = state.programScene.transitionEffect ?? 'smooth'
    const needsPowerPointHold = state.activeFile?.type === 'presentation' && (
      mode === 'participant' ||
      currentMode === 'participant' ||
      (transitionEffect !== 'smooth' && transitionEffect !== 'instant')
    )
    if (!needsPowerPointHold) {
      setProgramScene({ viewMode: mode })
      return
    }

    // Full-slide frames are generated while a PowerPoint channel is prepared.
    // Reuse that ready local frame so the scene starts reacting to the button
    // immediately. Capture the native slideshow only as a cold-cache fallback.
    const cachedSnapshotPath = state.activeFile?.type === 'presentation'
      ? state.pptxSlidesMap[state.activeFile.path]?.[Math.max(0, state.currentSlide - 1)] ?? null
      : null
    const snapshotPath = cachedSnapshotPath || await window.api.snapshotSlideshow().catch(() => null)
    if (generation !== programSceneFocusGenerationRef.current) return
    let participantFocusPrepared = false
    if (snapshotPath) {
      const requestId = `pptx-focus-${Date.now()}-${generation}`
      const holdReady = await showPowerPointTransitionHold(snapshotPath, requestId)
      if (generation !== programSceneFocusGenerationRef.current) return
      if (holdReady && (mode === 'participant' || (transitionEffect !== 'smooth' && transitionEffect !== 'instant'))) {
        await window.api.raisePresentationWindow()
        if (generation !== programSceneFocusGenerationRef.current) return
        participantFocusPrepared = mode === 'participant'
        const latest = useAppStore.getState()
        const targetDisplay = latest.displays.find((display) => (
          !display.isPrimary && display.id === latest.selectedDisplayId
        )) || latest.displays.find((display) => !display.isPrimary)
        if (targetDisplay) {
          void window.api.hideTaskbar(targetDisplay.bounds).catch((error: unknown) => {
            window.api.dbgLog(`participant focus taskbar hide failed: ${String(error)}`)
          })
        }
      }
    }
    // Even if the optional snapshot failed, make the Chromium scene the sole
    // owner of participant focus before its geometry starts changing.  The
    // native bridge observes this marker and will not reorder the same two
    // windows a second time in the middle of the animation.
    if (mode === 'participant' && !participantFocusPrepared) {
      await window.api.raisePresentationWindow()
      if (generation !== programSceneFocusGenerationRef.current) return
    }
    setProgramScene({
      viewMode: mode,
      transitionDurationMs: PROGRAM_SCENE_TRANSITION_DURATION_MS
    })
  }

  const handleTogglePresentation = async (): Promise<void> => {
    if (isOutputActive) {
      if (outputCloseInFlightRef.current) return
      const cancelHandledByTake = !window.dispatchEvent(new CustomEvent('cancel-active-take', {
        cancelable: true,
        detail: { backdropImage, selectedDisplayId }
      }))
      if (cancelHandledByTake) return
      outputCloseInFlightRef.current = true
      setOutputCloseInFlight(true)
      const releaseOutputTransition = await acquireOutputTransition('toolbar-close-output')
      let closeCanFinalize = false
      try {
      const currentState = useAppStore.getState()
      const closingFile = currentState.activeFile
      const closingWindowOpen = currentState.isPresentationWindowOpen
      const closingBackdrop = currentState.backdropImage
      const closingDisplayId = currentState.selectedDisplayId
      const outputStillActive = (closingWindowOpen && closingFile !== null) ||
        closingFile?.type === 'presentation' ||
        (closingFile?.type === 'other' && !closingFile.isImage)
      if (!outputStillActive) return

      const closingExternalDocument = closingFile?.type === 'other' &&
        !closingFile.isImage && !closingFile.isAudio
      const closingPowerPoint = closingFile?.type === 'presentation'
      closeCanFinalize = !closingExternalDocument && !closingPowerPoint

      if (closingFile?.type === 'capture') {
        window.api.sendToPresentation('capture-audio-live', null)
      }
      if (closingFile?.type === 'other' && closingFile.isAudio) {
        await window.api.musicStop()
      }
      // Minimize external file (Word/Excel) if open — don't close it
      if (closingExternalDocument) {
        const minimized = await window.api.minimizeExternalFile(closingFile.path)
        if (!minimized.success) {
          window.api.dbgLog(`toolbar stop: external window minimize failed ${minimized.error || '-'}`)
          window.alert(minimized.error || 'Не удалось свернуть окно Word/Excel. Эфир оставлен без изменений; повторите остановку.')
          return
        }
        closeCanFinalize = true
      }
      const shouldCoverVisualClose = Boolean(closingFile) && !(
        closingFile?.type === 'other' && !closingFile.isImage
      )
      if (shouldCoverVisualClose) {
        await window.api.showOverlay(closingDisplayId ?? undefined)
      }
      if (closingPowerPoint) {
        const closed = await window.api.powerpointCommand('close')
        if (!closed.success) {
          window.api.dbgLog(`toolbar stop: PowerPoint release failed ${closed.error || '-'}`)
          await window.api.hideOverlay()
          setOverlayState({ kind: 'hidden' })
          window.alert(closed.error || 'Не удалось закрыть и освободить презентацию PowerPoint.')
          return
        }
        closeCanFinalize = true
      }
      if (closingBackdrop) {
        let outputWindowOpen = closingWindowOpen
        if (!outputWindowOpen) {
          await window.api.openPresentationWindow(closingDisplayId ?? undefined)
          setPresentationWindowOpen(true)
          outputWindowOpen = true
        }

        // A true close first unmounts the old PDF/video decoder. Keep the
        // transition cover until the replacement image has actually painted;
        // this preserves the old seamless behavior without making resource
        // cleanup depend on an arbitrary 200 ms delay.
        const closeBackdropTakeId = `close-backdrop-${Date.now()}-${Math.random().toString(36).slice(2)}`
        const backdropReady = new Promise<boolean>((resolve) => {
          let settled = false
          let unsubscribe = (): void => {}
          const finish = (ready: boolean): void => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            unsubscribe()
            resolve(ready)
          }
          unsubscribe = window.api.on('presentation-content-ready', (...args: unknown[]) => {
            const payload = args[0] as { takeId?: string; type?: string }
            if (payload?.takeId !== closeBackdropTakeId || payload.type !== 'backdrop') return
            finish(true)
          })
          const timeout = setTimeout(() => finish(false), 8_000)
        })
        window.api.sendToPresentation('clear-active-content')
        window.api.sendToPresentation('load-content', {
          type: 'backdrop',
          path: closingBackdrop,
          name: 'Backdrop',
          takeId: closeBackdropTakeId
        })
        const backdropPainted = await backdropReady
        if (!backdropPainted) {
          window.api.dbgLog('toolbar stop: backdrop did not paint; closing empty output safely')
          window.api.sendToPresentation('clear-active-content')
          if (outputWindowOpen) {
            await window.api.closePresentationWindow()
            setPresentationWindowOpen(false)
          }
          window.alert('Фон не удалось подготовить. Контент закрыт, память освобождена.')
        }
      } else {
        window.api.sendToPresentation('clear-active-content')
        if (closingWindowOpen) {
          await window.api.closePresentationWindow()
          setPresentationWindowOpen(false)
        }
      }
      // КРИТИЧНО: всегда скрываем overlay при выходе из эфира. Если PPTX был
      // в эфире, overlay висит pinned-pptx (opacity=1, PP snapshot pixel-
      // perfect). Без hideOverlay юзер видит снапшот PP даже после close PP +
      // backdrop loaded — overlay поверх всего из-за screen-saver z-order.
      await window.api.hideOverlay()
      setOverlayState({ kind: 'hidden' })
      await window.api.releaseBrowserFullscreen()
      setActiveFile(null)
      setLiveChannelNull()
      } catch (error) {
        window.api.dbgLog(`toolbar stop failed afterRelease=${closeCanFinalize}: ${String(error)}`)
        try { await window.api.hideOverlay() } catch { /* best effort */ }
        setOverlayState({ kind: 'hidden' })
        if (closeCanFinalize) {
          try { window.api.sendToPresentation('clear-active-content') } catch { /* best effort */ }
          try { await window.api.closePresentationWindow() } catch { /* best effort */ }
          setPresentationWindowOpen(false)
          try { await window.api.releaseBrowserFullscreen() } catch { /* best effort */ }
          setActiveFile(null)
          setLiveChannelNull()
        }
        window.alert(
          closeCanFinalize
            ? 'Эфир закрыт, тяжёлый контент выгружен. Дополнительное оформление подготовить не удалось.'
            : `Не удалось закрыть эфир: ${String(error)}`
        )
      } finally {
        releaseOutputTransition()
        outputCloseInFlightRef.current = false
        setOutputCloseInFlight(false)
      }
    } else {
      if (!selectedChannelHasContent || selectedChannel === null) return
      window.dispatchEvent(new CustomEvent('take-channel', { detail: selectedChannel }))
    }
  }

  const handleSelectBackdrop = async (): Promise<void> => {
    if (backdropImage) {
      // The same button is a real toggle. A program scene cannot exist without
      // its full-screen backdrop, so disable that layout before removing it.
      useAppStore.getState().setProgramScene({ enabled: false })
      setBackdropImage(null)
      if (!activeFile) {
        window.api.sendToPresentation('clear-active-content')
        if (isPresentationWindowOpen) {
          await window.api.closePresentationWindow()
          setPresentationWindowOpen(false)
        }
        await window.api.hideOverlay()
        setOverlayState({ kind: 'hidden' })
      }
      return
    }

    const path = await window.api.selectBackdropImage()
    if (path) {
      setBackdropImage(path)
      // Only show backdrop immediately if no active content is playing
      if (!activeFile) {
        await window.api.switchAudioToExternal()
        if (!isPresentationWindowOpen) {
          await window.api.openPresentationWindow(selectedDisplayId ?? undefined)
          setPresentationWindowOpen(true)
        }
        window.api.sendToPresentation('load-content', {
          type: 'backdrop',
          path,
          name: 'Backdrop'
        })
      }
    }
  }

  return (
    <div className="pdm-toolbar relative h-11 bg-surface-300 border-b border-gray-800 flex items-center px-3 gap-1.5 shrink-0 select-none" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
      <div className="flex shrink-0 items-center gap-1">
        <button
          onClick={() => setSettingsOpen(true)}
          className="text-[11px] text-gray-400 hover:text-white transition-colors px-1 flex items-center gap-1 whitespace-nowrap"
          title="Настройки"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <span className="text-base">⚙</span> Настройки
        </button>

        <button
          onClick={() => setAuxiliaryDisplaysOpen(true)}
          className={`text-[11px] px-1.5 py-1 rounded-lg font-medium transition-colors border whitespace-nowrap ${
            hasAdditionalScreenOutput
              ? 'bg-blue-600/80 border-blue-500 text-white hover:bg-blue-600'
              : 'bg-surface-100 border-gray-700 text-gray-300 hover:bg-gray-700'
          }`}
          title="Суфлёр и информационный экран"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          🖥 Экраны
        </button>
      </div>

      <div className="flex-1" />

      <Timer />

      <EventTimer />

      <MusicPlayer />

      <VideoPlayer />

      {__PDM_STREAM_ENABLED__ && <StreamControl />}

      <BroadcastTitles />

      <button
        onClick={() => setChannelBoundaryNavigationEnabled(!channelBoundaryNavigationEnabled)}
        className={`text-[11px] px-2 py-1 rounded-lg font-medium transition-colors border whitespace-nowrap ${
          channelBoundaryNavigationEnabled
            ? 'bg-emerald-600/80 hover:bg-emerald-600 text-white border-transparent'
            : 'bg-surface-100 text-gray-300 hover:bg-gray-700 border-gray-700'
        }`}
        title={`По завершении презентации переключаться на следующий канал — ${channelBoundaryNavigationEnabled ? 'включено' : 'выключено'}`}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        ⇆ Авто: {channelBoundaryNavigationEnabled ? 'Вкл' : 'Выкл'}
      </button>

      <div
        className="flex shrink-0 items-stretch"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <button
          onClick={handleQuickProgramSceneToggle}
          className={`whitespace-nowrap rounded-l-lg border px-2 py-1 text-[11px] font-medium transition-colors ${
            programScene.enabled
              ? 'border-cyan-500 bg-cyan-600/80 text-white hover:bg-cyan-600'
              : programSceneReady
                ? 'border-gray-700 bg-surface-100 text-gray-300 hover:bg-gray-700'
                : 'border-gray-700 bg-surface-100 text-gray-500 hover:bg-gray-700 hover:text-gray-300'
          }`}
          title={programScene.enabled
            ? 'Выключить режим «Картинка в картинке»'
            : programSceneReady
              ? 'Включить режим «Картинка в картинке» с сохранёнными настройками'
              : 'Сначала настройте фон и внешний источник'}
        >
          ▣ PiP: {programScene.enabled ? 'Вкл' : 'Выкл'}
        </button>
        <button
          onClick={() => setProgramSceneOpen(true)}
          className={`rounded-r-lg border border-l-0 px-1.5 py-1 text-[12px] transition-colors ${
            programScene.enabled
              ? 'border-cyan-500 bg-cyan-700/80 text-white hover:bg-cyan-600'
              : 'border-gray-700 bg-surface-100 text-gray-400 hover:bg-gray-700 hover:text-white'
          }`}
          title="Настройки режима «Картинка в картинке»"
          aria-label="Настройки режима «Картинка в картинке»"
        >
          ⚙
        </button>
      </div>

      {programScene.enabled && (
        <div
          className="flex shrink-0 items-stretch overflow-hidden rounded-lg border border-gray-700 bg-surface-100"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          {PROGRAM_SCENE_VIEW_BUTTONS.map(({ mode, title }) => {
            const selected = (programScene.viewMode ?? 'both') === mode
            return (
              <button
                key={mode}
                type="button"
                onClick={() => { void handleProgramSceneViewMode(mode) }}
                title={title}
                aria-label={title}
                aria-pressed={selected}
                className={`flex h-7 w-9 items-center justify-center border-l border-gray-700 first:border-l-0 transition-colors ${selected
                  ? 'bg-cyan-600 text-white'
                  : 'text-gray-400 hover:bg-gray-700 hover:text-white'}`}
              >
                <ProgramSceneViewIcon mode={mode} />
              </button>
            )
          })}
        </div>
      )}

      <div
        className="flex shrink-0 items-stretch"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <button
          type="button"
          onClick={() => {
            if (qrOverlay.enabled) {
              setQrOverlay({ enabled: false })
            } else if (hasQrData(qrOverlay)) {
              setQrOverlay({ enabled: true })
            } else {
              setQrOverlayOpen(true)
            }
          }}
          className={`whitespace-nowrap rounded-l-lg border px-2 py-1 text-[11px] font-medium transition-colors ${qrOverlay.enabled
            ? 'border-emerald-500 bg-emerald-600/80 text-white hover:bg-emerald-600'
            : 'border-gray-700 bg-surface-100 text-gray-300 hover:bg-gray-700'}`}
          title={qrOverlay.enabled ? 'Убрать QR-код из эфира' : hasQrData(qrOverlay) ? 'Показать QR-код с сохранёнными настройками' : 'Сначала настройте QR-код'}
        >
          ▦ QR: {qrOverlay.enabled ? 'Вкл' : 'Выкл'}
        </button>
        <button
          type="button"
          onClick={() => setQrOverlayOpen(true)}
          className={`rounded-r-lg border border-l-0 px-1.5 py-1 text-[12px] transition-colors ${qrOverlay.enabled
            ? 'border-emerald-500 bg-emerald-700/80 text-white hover:bg-emerald-600'
            : 'border-gray-700 bg-surface-100 text-gray-400 hover:bg-gray-700 hover:text-white'}`}
          title="Настройки QR-кода"
          aria-label="Настройки QR-кода"
        >
          ⚙
        </button>
      </div>

      <button
        onClick={handleSelectBackdrop}
        className={`text-[11px] px-2 py-1 rounded-lg font-medium transition-colors border whitespace-nowrap ${
          backdropImage
            ? 'bg-purple-600/80 hover:bg-purple-600 text-white border-transparent'
            : 'bg-surface-100 text-gray-300 hover:bg-gray-700 border-gray-700'
        }`}
        title={backdropImage ? 'Отключить подложку' : 'Выбрать подложку'}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        {backdropImage ? '🖼 Фон: Вкл' : '🖼 Фон'}
      </button>

      <button
        onClick={async () => {
          const newState = !globalHookEnabled
          const result = await window.api.toggleGlobalHook(newState)
          setGlobalHookEnabled(result)
        }}
        className={`text-[11px] px-2 py-1 rounded-lg font-medium transition-colors border whitespace-nowrap ${
          globalHookEnabled
            ? 'bg-yellow-600/80 hover:bg-yellow-600 text-white border-transparent'
            : 'bg-surface-100 text-gray-300 hover:bg-gray-700 border-gray-700'
        }`}
        title={globalHookEnabled ? 'Кликер активен — нажмите для отключения' : 'Кликер выключен — нажмите для включения'}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        🎮 Кликер: {globalHookEnabled ? 'Вкл' : 'Выкл'}
      </button>

      <button
        onClick={handleTogglePresentation}
        disabled={!canTogglePresentation || outputCloseInFlight}
        className={`text-[11px] px-2 py-1 rounded-lg font-medium transition-colors whitespace-nowrap ${
          isOutputActive
            ? 'bg-red-600/80 hover:bg-red-600 text-white'
            : selectedChannelHasContent && !selectedPptxIsPreparing
              ? 'bg-red-600 hover:bg-red-500 text-white'
              : 'bg-gray-700 text-gray-500 cursor-not-allowed'
        }`}
        title={!isOutputActive
          ? selectedPptxIsPreparing
            ? 'PowerPoint подготавливает презентацию к эфиру'
            : !selectedChannelHasContent
              ? 'Выберите канал с контентом'
              : undefined
          : undefined}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        {isOutputActive ? '⏹ Выйти из эфира' : '▶ В эфир'}
      </button>

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {auxiliaryDisplaysOpen && (
        <AuxiliaryDisplaysModal onClose={() => setAuxiliaryDisplaysOpen(false)} />
      )}
      {programSceneOpen && (
        <ProgramSceneModalBoundary onClose={() => setProgramSceneOpen(false)}>
          <ProgramSceneModal onClose={() => setProgramSceneOpen(false)} />
        </ProgramSceneModalBoundary>
      )}
      {qrOverlayOpen && <QrOverlayModal onClose={() => setQrOverlayOpen(false)} />}
    </div>
  )
}
