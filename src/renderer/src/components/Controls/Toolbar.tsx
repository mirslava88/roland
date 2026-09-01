import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '../../stores/useAppStore'
import { Timer } from './Timer'
import { EventTimer } from '../EventTimer/EventTimer'
import { MusicPlayer } from './MusicPlayer'
import { VideoPlayer } from './VideoPlayer'
import { SettingsModal } from './SettingsModal'
import { AuxiliaryDisplaysModal } from '../AuxiliaryDisplays/AuxiliaryDisplaysModal'
import { BroadcastTitles } from '../BroadcastTitles/BroadcastTitles'
import { acquireOutputTransition } from '../../output-transition-lock'

export function Toolbar(): JSX.Element {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [auxiliaryDisplaysOpen, setAuxiliaryDisplaysOpen] = useState(false)
  const [outputCloseInFlight, setOutputCloseInFlight] = useState(false)
  const outputCloseInFlightRef = useRef(false)
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
      // The same button is a real toggle. While material is on air, only
      // remove its future fallback; do not interrupt the current TAKE.
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
    <div className="relative h-11 bg-surface-300 border-b border-gray-800 flex items-center px-3 gap-1.5 shrink-0 select-none" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
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
    </div>
  )
}
