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
    setSelectedDisplayId
  } = useAppStore()

  const isOutputActive = isPresentationWindowOpen || activeFile?.type === 'presentation'

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
      if (activeFile?.type === 'presentation') {
        await window.api.powerpointCommand('close')
        setActiveFile(null)
      }
      if (isPresentationWindowOpen) {
        await window.api.closePresentationWindow()
        setPresentationWindowOpen(false)
      }
    } else {
      await window.api.openPresentationWindow(selectedDisplayId ?? undefined)
      setPresentationWindowOpen(true)
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
