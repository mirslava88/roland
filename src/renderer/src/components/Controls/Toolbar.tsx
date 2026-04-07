import { useAppStore } from '../../stores/useAppStore'

export function Toolbar(): JSX.Element {
  const {
    folderPath,
    setFolderPath,
    setFiles,
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

  const isOutputActive = (isPresentationWindowOpen && activeFile !== null) || activeFile?.type === 'presentation'

  const handleOpenFolder = async (): Promise<void> => {
    const path = await window.api.selectFolder()
    if (path) {
      setFolderPath(path)
      const files = await window.api.loadFolder(path)
      setFiles(files)
    }
  }

  const handleTogglePresentation = async (): Promise<void> => {
    if (isOutputActive) {
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
          await window.api.restoreAudioDevice()
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

  const handleRefresh = async (): Promise<void> => {
    if (folderPath) {
      const files = await window.api.loadFolder(folderPath)
      setFiles(files)
    }
  }

  return (
    <div className="h-12 bg-surface-300 border-b border-gray-800 flex items-center px-4 gap-3 shrink-0 select-none" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
      <h1 className="text-sm font-semibold text-gray-300 mr-4" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        PDM
      </h1>

      <button
        onClick={handleOpenFolder}
        className="btn-secondary text-xs"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <span className="mr-1.5">📁</span> Обзор
      </button>

      {folderPath && (
        <button
          onClick={handleRefresh}
          className="btn-icon text-xs"
          title="Обновить"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          ↻
        </button>
      )}

      <div className="flex-1" />

      <button
        onClick={async () => {
          const newState = !globalHookEnabled
          const result = await window.api.toggleGlobalHook(newState)
          setGlobalHookEnabled(result)
        }}
        className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-colors ${
          globalHookEnabled
            ? 'bg-yellow-600/80 hover:bg-yellow-600 text-white'
            : 'btn-secondary'
        }`}
        title={globalHookEnabled ? 'Кликер активен — нажмите для отключения' : 'Включить кликер'}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        🎮 {globalHookEnabled ? 'Кликер ВКЛ' : 'Кликер'}
      </button>

      <button
        onClick={handleSelectBackdrop}
        className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-colors ${
          backdropImage
            ? 'bg-purple-600/80 hover:bg-purple-600 text-white'
            : 'btn-secondary'
        }`}
        title={backdropImage || 'Выбрать подложку'}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        🖼 Подложка
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
        {isOutputActive ? '⏹ Закрыть эфир' : '▶ В эфир'}
      </button>
    </div>
  )
}
