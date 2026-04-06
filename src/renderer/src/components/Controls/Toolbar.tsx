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
    setBackdropImage
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
        }
      }
      setActiveFile(null)
      setLiveChannelNull()
    } else {
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
      // Immediately show backdrop on presentation window
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
        <span className="mr-1.5">📁</span> Open Folder
      </button>

      {folderPath && (
        <button
          onClick={handleRefresh}
          className="btn-icon text-xs"
          title="Refresh"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          ↻
        </button>
      )}

      <div className="flex-1" />

      <button
        onClick={handleSelectBackdrop}
        className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-colors ${
          backdropImage
            ? 'bg-purple-600/80 hover:bg-purple-600 text-white'
            : 'btn-secondary'
        }`}
        title={backdropImage || 'Select backdrop image'}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        🖼 Backdrop
      </button>

      {displays.length > 1 && (
        <select
          value={selectedDisplayId ?? ''}
          onChange={(e) =>
            setSelectedDisplayId(e.target.value ? Number(e.target.value) : null)
          }
          className="bg-surface-100 text-gray-300 text-xs rounded-lg px-2 py-1.5 border border-gray-700 focus:outline-none"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <option value="">Auto (external)</option>
          {displays.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label} {d.isPrimary ? '(Primary)' : ''}
            </option>
          ))}
        </select>
      )}

      <button
        onClick={handleTogglePresentation}
        className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-colors ${
          isOutputActive
            ? 'bg-red-600/80 hover:bg-red-600 text-white'
            : 'btn-primary'
        }`}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        {isOutputActive ? '⏹ Close Output' : '▶ Open Output'}
      </button>
    </div>
  )
}
