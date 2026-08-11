import { useEffect, useState } from 'react'
import { useAppStore } from '../../stores/useAppStore'
import { Timer } from './Timer'
import { EventTimer } from '../EventTimer/EventTimer'
import { MusicPlayer } from './MusicPlayer'
import { VideoPlayer } from './VideoPlayer'
import { SettingsModal } from './SettingsModal'
import { AuxiliaryDisplaysModal } from '../AuxiliaryDisplays/AuxiliaryDisplaysModal'
import { BroadcastTitles } from '../BroadcastTitles/BroadcastTitles'

export function Toolbar(): JSX.Element {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [auxiliaryDisplaysOpen, setAuxiliaryDisplaysOpen] = useState(false)
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
  const assignedModes = Object.values(displayAssignments)
  const hasAdditionalScreenOutput = assignedModes.some((mode) => mode !== 'program') ||
    assignedModes.filter((mode) => mode === 'program').length > 1

  const handleTogglePresentation = async (): Promise<void> => {
    if (isOutputActive) {
      const cancelHandledByTake = !window.dispatchEvent(new CustomEvent('cancel-active-take', {
        cancelable: true,
        detail: { backdropImage, selectedDisplayId }
      }))
      if (cancelHandledByTake) return
      if (activeFile?.type === 'capture') {
        window.api.sendToPresentation('capture-audio-live', null)
      }
      if (activeFile?.type === 'other' && activeFile.isAudio) {
        await window.api.musicStop()
      }
      // Minimize external file (Word/Excel) if open — don't close it
      if (activeFile?.type === 'other' && !activeFile.isImage && !activeFile.isAudio) {
        await window.api.minimizeExternalFile(activeFile.path)
      }
      if (activeFile?.type === 'presentation' && backdropImage) {
        // Seamless: open black window first, then close PowerPoint, then show backdrop
        if (!isPresentationWindowOpen) {
          await window.api.openPresentationWindow(selectedDisplayId ?? undefined)
          setPresentationWindowOpen(true)
        }
        await window.api.powerpointCommand('close')
        await window.api.showTaskbar()
        window.api.sendToPresentation('load-content', {
          type: 'backdrop',
          path: backdropImage,
          name: 'Backdrop'
        })
        // Дать backdrop отрисоваться в Electron окне до того как уберём
        // overlay — иначе overlay (с PP snap) исчезнет, а под ним ещё не
        // нарисованный backdrop = чёрный flash.
        await new Promise((r) => setTimeout(r, 200))
      } else {
        if (activeFile?.type === 'presentation') {
          await window.api.powerpointCommand('close')
          await window.api.showTaskbar()
        }
        if (backdropImage) {
          if (!isPresentationWindowOpen) {
            await window.api.openPresentationWindow(selectedDisplayId ?? undefined)
            setPresentationWindowOpen(true)
          }
          window.api.sendToPresentation('load-content', {
            type: 'backdrop',
            path: backdropImage,
            name: 'Backdrop'
          })
          await new Promise((r) => setTimeout(r, 200))
        } else {
          window.api.sendToPresentation('clear-active-content')
          if (isPresentationWindowOpen) {
            await window.api.closePresentationWindow()
            setPresentationWindowOpen(false)
          }
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
        disabled={!canTogglePresentation}
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
