import { useState } from 'react'
import { useAppStore } from '../../stores/useAppStore'
import { Timer } from './Timer'
import { MusicPlayer } from './MusicPlayer'
import { SettingsModal } from './SettingsModal'

export function Toolbar(): JSX.Element {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const {
    isPresentationWindowOpen,
    setPresentationWindowOpen,
    activeFile,
    setActiveFile,
    displays,
    selectedDisplayId,
    setSelectedDisplayId,
    backdropImage,
    setBackdropImage,
    globalHookEnabled,
    setGlobalHookEnabled,
    selectedChannel
  } = useAppStore()

  const setLiveChannelNull = (): void => useAppStore.setState({ liveChannel: null })

  const isOutputActive = (isPresentationWindowOpen && activeFile !== null) || activeFile?.type === 'presentation' || (activeFile?.type === 'other' && !activeFile.isImage)

  const handleTogglePresentation = async (): Promise<void> => {
    if (isOutputActive) {
      // Minimize external file (Word/Excel) if open — don't close it
      if (activeFile?.type === 'other' && !activeFile.isImage) {
        await window.api.minimizeExternalFile(activeFile.path)
      }
      if (activeFile?.type === 'presentation' && backdropImage) {
        // Seamless: open black window first, then close PowerPoint, then show backdrop
        if (!isPresentationWindowOpen) {
          await window.api.openPresentationWindow(selectedDisplayId ?? undefined)
          setPresentationWindowOpen(true)
        }
        await window.api.powerpointCommand('close')
        window.api.sendToPresentation('load-content', {
          type: 'backdrop',
          path: backdropImage,
          name: 'Backdrop'
        })
      } else {
        if (activeFile?.type === 'presentation') {
          await window.api.powerpointCommand('close')
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
        } else if (isPresentationWindowOpen) {
          await window.api.closePresentationWindow()
          setPresentationWindowOpen(false)
        }
      }
      setActiveFile(null)
      setLiveChannelNull()
    } else {
      // If a channel is selected, take it
      if (selectedChannel) {
        const ch = selectedChannel === 'A' ? 'channelA' : 'channelB'
        const channel = useAppStore.getState()[ch]
        if (channel.file) {
          window.dispatchEvent(new CustomEvent('take-channel', { detail: selectedChannel }))
          return
        }
      }
      // Switch audio to external display
      await window.api.switchAudioToExternal()
      if (!isPresentationWindowOpen) {
        await window.api.openPresentationWindow(selectedDisplayId ?? undefined)
        setPresentationWindowOpen(true)
      }
      if (backdropImage) {
        window.api.sendToPresentation('load-content', {
          type: 'backdrop',
          path: backdropImage,
          name: 'Backdrop'
        })
      }
    }
  }

  const handleSelectBackdrop = async (): Promise<void> => {
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
    <div className="relative h-12 bg-surface-300 border-b border-gray-800 flex items-center px-4 gap-3 shrink-0 select-none" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
      <button
        onClick={() => setSettingsOpen(true)}
        className="text-xs text-gray-400 hover:text-white transition-colors px-1 flex items-center gap-1.5"
        title="Настройки"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <span className="text-base">⚙</span> Настройки
      </button>

      <div className="flex-1" />

      <Timer />

      <MusicPlayer />

      <button
        onClick={handleSelectBackdrop}
        className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-colors border ${
          backdropImage
            ? 'bg-purple-600/80 hover:bg-purple-600 text-white border-transparent'
            : 'bg-purple-900/50 text-purple-300 hover:bg-purple-800/50 border-purple-700/50'
        }`}
        title={backdropImage || 'Выбрать подложку'}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        🖼 Подложка (Фон)
      </button>

      <button
        onClick={async () => {
          const newState = !globalHookEnabled
          const result = await window.api.toggleGlobalHook(newState)
          setGlobalHookEnabled(result)
        }}
        className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-colors border ${
          globalHookEnabled
            ? 'bg-yellow-600/80 hover:bg-yellow-600 text-white border-transparent'
            : 'bg-surface-100 text-gray-300 hover:bg-gray-700 border-gray-700'
        }`}
        title={globalHookEnabled ? 'Кликер активен — нажмите для отключения' : 'Включить кликер'}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        🎮 {globalHookEnabled ? 'Кликер ВКЛ' : 'Кликер'}
      </button>

      <button
        onClick={handleTogglePresentation}
        className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-colors ${
          isOutputActive
            ? 'bg-red-600/80 hover:bg-red-600 text-white'
            : 'bg-red-600 hover:bg-red-500 text-white'
        }`}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        {isOutputActive ? '⏹ Выйти из эфира' : '▶ В эфир'}
      </button>

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  )
}
