import { Component, useEffect, useLayoutEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react'
import { connectedProgramDisplayId, useAppStore } from '../../stores/useAppStore'
import { Timer } from './Timer'
import { StreamControl } from './StreamControl'
import { EventTimer } from '../EventTimer/EventTimer'
import { MusicPlayer } from './MusicPlayer'
import { VideoPlayer } from './VideoPlayer'
import { SettingsModal } from './SettingsModal'
import { AuxiliaryDisplaysModal } from '../AuxiliaryDisplays/AuxiliaryDisplaysModal'
import { ProgramSceneModal } from '../ProgramScene/ProgramSceneModal'
import { acquireOutputTransition } from '../../output-transition-lock'
import { canStartPptx } from '../../pptx-cache-readiness'
import { resolveProgramSceneChannel } from '../../program-scene-channel'
import type { ToolbarItemId } from '../../../../shared/toolbar'
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

// Hiding an operator control must not unmount its playback/timer effects.
function ToolbarItem({ id, visible, children }: { id: ToolbarItemId; visible: boolean; children: ReactNode }): JSX.Element {
  return <div className="pdm-toolbar-item" data-toolbar-item={id} hidden={!visible}
    style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>{children}</div>
}

export function Toolbar(): JSX.Element {
  const toolbarRef = useRef<HTMLDivElement>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [auxiliaryDisplaysOpen, setAuxiliaryDisplaysOpen] = useState(false)
  const [outputCloseInFlight, setOutputCloseInFlight] = useState(false)
  const [programSceneOpen, setProgramSceneOpen] = useState(false)
  const [programSceneInitialEditor, setProgramSceneInitialEditor] = useState<'qr' | undefined>()
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
  const setProgramScene = useAppStore((state) => state.setProgramScene)
  const qrOverlay = useAppStore((state) => state.qrOverlay)
  const toolbarVisibility = useAppStore((state) => state.toolbarVisibility)
  const videoQuickControls = useAppStore((state) => state.videoPlaylist.length > 0)
  const musicQuickControls = useAppStore((state) => state.musicPlaylist.length > 0)
  const timerQuickControls = useAppStore((state) => state.timerDuration > 0)

  useEffect(() => {
    const openProgramScene = (event: Event): void => {
      const detail = (event as CustomEvent<{ editor?: 'qr' }>).detail
      setProgramSceneInitialEditor(detail?.editor === 'qr' ? 'qr' : undefined)
      setProgramSceneOpen(true)
    }
    window.addEventListener('open-program-scene', openProgramScene)
    return () => window.removeEventListener('open-program-scene', openProgramScene)
  }, [])

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current
    if (!toolbar) return
    // Both rows share one primary-button width. Secondary controls keep their
    // compact size; only the evenly spaced row gaps absorb the difference.
    const resizeButtons = (): void => {
      const widths = Array.from(toolbar.querySelectorAll<HTMLElement>('.pdm-toolbar-row')).flatMap((row) => {
        const items = Array.from(row.querySelectorAll<HTMLElement>(':scope > .pdm-toolbar-item:not([hidden])'))
        const rowStyle = getComputedStyle(row)
        let fixedWidth = Math.max(0, items.length - 1) * parseFloat(rowStyle.columnGap)
        let mainCount = 0
        for (const item of items) {
          const primary = item.dataset.toolbarItem === 'pipViews' ? null : item.querySelector<HTMLElement>(
            ':scope > button, :scope > div:not(.fixed):not(.absolute) > button:first-child'
          )
          fixedWidth += item.getBoundingClientRect().width - (primary?.getBoundingClientRect().width ?? 0)
          if (primary) mainCount++
        }
        const available = row.clientWidth - parseFloat(rowStyle.paddingLeft) - parseFloat(rowStyle.paddingRight)
        return mainCount ? [(available - fixedWidth) / mainCount] : []
      })
      if (widths.length) {
        const width = `${Math.max(1, Math.floor(Math.min(...widths) * 4) / 4)}px`
        if (toolbar.style.getPropertyValue('--pdm-toolbar-button-width') !== width) {
          toolbar.style.setProperty('--pdm-toolbar-button-width', width)
        }
      }
    }
    resizeButtons()
    let previousWidth = toolbar.clientWidth
    let frame = 0
    const observer = new ResizeObserver(() => {
      if (toolbar.clientWidth === previousWidth) return
      previousWidth = toolbar.clientWidth
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(resizeButtons)
    })
    observer.observe(toolbar)
    return () => { observer.disconnect(); cancelAnimationFrame(frame) }
  }, [toolbarVisibility, videoQuickControls, musicQuickControls, timerQuickControls])

  const setLiveChannelNull = (): void => useAppStore.setState({ liveChannel: null })

  useEffect(() => {
    const handleOpenAuxiliaryDisplays = (): void => setAuxiliaryDisplaysOpen(true)
    window.addEventListener('open-auxiliary-displays', handleOpenAuxiliaryDisplays)
    return () => window.removeEventListener('open-auxiliary-displays', handleOpenAuxiliaryDisplays)
  }, [])

  const isOutputActive = programScene.enabled ||
    (isPresentationWindowOpen && activeFile !== null) ||
    activeFile?.type === 'presentation' ||
    (activeFile?.type === 'other' && !activeFile.isImage)
  const selectedChannelHasContent = selectedChannel !== null && Boolean(channels[selectedChannel]?.file)
  const selectedChannelFile = selectedChannel !== null ? channels[selectedChannel]?.file : null
  const selectedPptxIsPreparing = selectedChannelFile?.type === 'presentation' &&
    !canStartPptx(pptxCacheStatuses[selectedChannelFile.path],
      useAppStore.getState().pptxSlidesMap[selectedChannelFile.path] || [],
      selectedChannel !== null ? channels[selectedChannel]?.totalSlides || 0 : 0)
  const canTogglePresentation = isOutputActive || (selectedChannelHasContent && !selectedPptxIsPreparing)
  const assignedModes = displays
    .filter((display) => !display.isPrimary)
    .map((display) => displayAssignments[String(display.id)] || 'off')
  const hasAdditionalScreenOutput = assignedModes.some((mode) => mode !== 'program') ||
    assignedModes.filter((mode) => mode === 'program').length > 1
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
      if (state.programSnapshot) useAppStore.getState().publishProgramSnapshot()
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
        const targetDisplayId = connectedProgramDisplayId(latest)
        const targetDisplay = latest.displays.find((display) => display.id === targetDisplayId)
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
    if (useAppStore.getState().programSnapshot) {
      useAppStore.getState().publishProgramSnapshot()
    }
  }

  const handleToggleProgramScene = async (): Promise<void> => {
    const initial = useAppStore.getState()
    if (initial.programSnapshot) {
      window.dispatchEvent(new CustomEvent('close-program-output'))
      return
    }

    // A Stream Deck scene command must wrap the source that is really on air.
    // The draft may still remember a different preview channel from an earlier
    // edit; only use it when there is no committed live channel.
    const channelToTake = resolveProgramSceneChannel({
      liveChannel: initial.liveChannel,
      sceneContentChannelId: initial.programScene.contentChannelId,
      selectedChannel: initial.selectedChannel,
      channels: initial.channels
    })
    const channelFile = channelToTake ? initial.channels[channelToTake]?.file : null
    if (channelToTake && channelFile && (
      initial.liveChannel !== channelToTake || initial.activeFile?.path !== channelFile.path
    )) {
      await new Promise<void>((resolve) => {
        let timeout: ReturnType<typeof setTimeout> | undefined
        const listener = (event: Event): void => {
          const detail = (event as CustomEvent<{ channelId?: string }>).detail
          if (detail?.channelId !== channelToTake) return
          window.removeEventListener('take-channel-completed', listener)
          if (timeout) clearTimeout(timeout)
          resolve()
        }
        window.addEventListener('take-channel-completed', listener)
        timeout = setTimeout(() => {
          window.removeEventListener('take-channel-completed', listener)
          resolve()
        }, 30_000)
        window.dispatchEvent(new CustomEvent('take-channel', { detail: channelToTake }))
      })
      const committed = useAppStore.getState()
      if (committed.liveChannel !== channelToTake || committed.activeFile?.path !== channelFile.path) {
        window.api.dbgLog(`Stream Deck scene start cancelled: channel ${channelToTake} was not committed`)
        return
      }
    }

    const state = useAppStore.getState()
    state.setProgramScene({ enabled: true })
    if (!state.activeFile && !state.isPresentationWindowOpen) {
      const programDisplayId = connectedProgramDisplayId(state)
      if (programDisplayId !== null) {
        await window.api.openPresentationWindow(programDisplayId)
        state.setPresentationWindowOpen(true)
        window.api.setActiveContentType('backdrop')
      } else if (state.internalProgramOutputActive) {
        await window.api.prepareInternalProgramOutput()
        state.setPresentationWindowOpen(true)
        window.api.setActiveContentType('backdrop')
      }
    }
    const revision = useAppStore.getState().publishProgramSnapshot(channelToTake)
    window.api.dbgLog(`Stream Deck scene published revision=${revision} channel=${channelToTake ?? 'none'}`)
  }

  useEffect(() => {
    const toggleScene = (): void => { void handleToggleProgramScene() }
    const setSceneViewMode = (event: Event): void => {
      const mode = (event as CustomEvent<ProgramSceneViewMode>).detail
      if (mode !== 'content' && mode !== 'participant' && mode !== 'both') return
      if (!useAppStore.getState().programSnapshot) return
      void handleProgramSceneViewMode(mode)
    }
    window.addEventListener('pdm-toggle-program-scene', toggleScene)
    window.addEventListener('pdm-program-scene-view-mode', setSceneViewMode)
    return () => {
      window.removeEventListener('pdm-toggle-program-scene', toggleScene)
      window.removeEventListener('pdm-program-scene-view-mode', setSceneViewMode)
    }
  })

  const handleTogglePresentation = async (): Promise<void> => {
    if (isOutputActive) {
      if (outputCloseInFlightRef.current) return
      const cancelHandledByTake = !window.dispatchEvent(new CustomEvent('cancel-active-take', {
        cancelable: true,
        detail: {
          backdropImage,
          selectedDisplayId: connectedProgramDisplayId(useAppStore.getState())
        }
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
      const outputStillActive = currentState.programScene.enabled ||
        (closingWindowOpen && closingFile !== null) ||
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
      currentState.setProgramScene({ enabled: false })
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
          useAppStore.getState().setProgramScene({ enabled: false })
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

  useEffect(() => {
    const closeProgramOutput = (): void => {
      if (isOutputActive) void handleTogglePresentation()
    }
    const toggleProgramOutput = (): void => {
      void handleTogglePresentation()
    }
    window.addEventListener('close-program-output', closeProgramOutput)
    window.addEventListener('pdm-toggle-program-output', toggleProgramOutput)
    return () => {
      window.removeEventListener('close-program-output', closeProgramOutput)
      window.removeEventListener('pdm-toggle-program-output', toggleProgramOutput)
    }
  })

  const handleSelectBackdrop = async (): Promise<void> => {
    if (backdropImage) {
      const sceneIsLive = useAppStore.getState().programSnapshot !== null
      setBackdropImage(null)
      if (!activeFile && !sceneIsLive) {
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
      if (!activeFile && useAppStore.getState().programSnapshot === null) {
        await window.api.switchAudioToExternal()
        if (!isPresentationWindowOpen) {
          const programDisplayId = connectedProgramDisplayId(useAppStore.getState())
          if (programDisplayId === null) return
          await window.api.openPresentationWindow(programDisplayId)
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
    <div ref={toolbarRef} className="pdm-toolbar relative bg-surface-300 border-b border-gray-800 shrink-0 select-none" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
      <div className="pdm-toolbar-row pdm-toolbar-program" role="toolbar" aria-label="Управление эфиром">
        <div className="pdm-toolbar-item" data-toolbar-item="settings" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button
            onClick={() => setSettingsOpen(true)}
            className="text-[11px] text-gray-300 hover:text-white hover:bg-gray-700 bg-surface-100 border border-gray-700 rounded-lg transition-colors px-2 flex items-center justify-center gap-1 whitespace-nowrap"
            title="Настройки"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            <span className="text-base">⚙</span> Настройки
          </button>
        </div>
        <ToolbarItem id="video" visible={toolbarVisibility.video}>
          <VideoPlayer />
        </ToolbarItem>
        <ToolbarItem id="music" visible={toolbarVisibility.music}>
          <MusicPlayer />
        </ToolbarItem>
        <ToolbarItem id="backdrop" visible={toolbarVisibility.backdrop}>
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
        </ToolbarItem>
        <ToolbarItem id="auto" visible={toolbarVisibility.auto}>
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
        </ToolbarItem>
        <ToolbarItem id="clicker" visible={toolbarVisibility.clicker}>
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
        </ToolbarItem>
        <ToolbarItem id="output" visible>
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
                  : 'В эфир'
              : 'Выйти из эфира'}
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            {isOutputActive ? '⏹ Выйти из эфира' : '▶ В эфир'}
          </button>
        </ToolbarItem>
      </div>
      <div className="pdm-toolbar-row pdm-toolbar-tools" role="toolbar" aria-label="Инструменты">
        <ToolbarItem id="displays" visible={toolbarVisibility.displays}>
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
        </ToolbarItem>
        <ToolbarItem id="timer" visible={toolbarVisibility.timer}>
          <Timer />
        </ToolbarItem>
        <ToolbarItem id="eventTimer" visible={toolbarVisibility.eventTimer}>
          <EventTimer />
        </ToolbarItem>
        <ToolbarItem id="pip" visible={toolbarVisibility.pip}>
          <button
            type="button"
            onClick={() => {
              setProgramSceneInitialEditor(undefined)
              setProgramSceneOpen(true)
            }}
            className={`whitespace-nowrap rounded-lg border px-2 py-1 text-[11px] font-medium transition-colors ${
              programScene.enabled || qrOverlay.enabled
                ? 'border-cyan-500 bg-cyan-600/80 text-white hover:bg-cyan-600'
                : 'border-gray-700 bg-surface-100 text-gray-300 hover:bg-gray-700'
            }`}
            title="Сцена: картинка, текст, титры и QR-код"
            aria-label="Открыть Сцену"
            style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          >
            ◫ Сцена
          </button>
        </ToolbarItem>
        <ToolbarItem id="pipViews" visible={toolbarVisibility.pip}>
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
                  title={programScene.enabled ? title : 'Сначала включите картинку в Сцене'}
                  disabled={!programScene.enabled}
                  aria-label={title}
                  aria-pressed={selected}
                  className={`disabled:cursor-not-allowed disabled:opacity-35 flex h-7 w-9 items-center justify-center border-l border-gray-700 first:border-l-0 transition-colors ${selected
                    ? 'bg-cyan-600 text-white'
                    : 'text-gray-400 hover:bg-gray-700 hover:text-white'}`}
                >
                  <ProgramSceneViewIcon mode={mode} />
                </button>
              )
            })}
          </div>
        </ToolbarItem>
        {__PDM_STREAM_ENABLED__ && (
          <ToolbarItem id="stream" visible={toolbarVisibility.stream}>
            <StreamControl />
          </ToolbarItem>
        )}
      </div>

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      {auxiliaryDisplaysOpen && (
        <AuxiliaryDisplaysModal onClose={() => setAuxiliaryDisplaysOpen(false)} />
      )}
      {programSceneOpen && (
        <ProgramSceneModalBoundary onClose={() => setProgramSceneOpen(false)}>
          <ProgramSceneModal
            initialEditor={programSceneInitialEditor}
            onClose={() => {
              setProgramSceneOpen(false)
              setProgramSceneInitialEditor(undefined)
            }}
          />
        </ProgramSceneModalBoundary>
      )}
    </div>
  )
}
