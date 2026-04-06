import { useAppStore, FilterType } from '../../stores/useAppStore'
import { FileItem } from './FileItem'

const FILTERS: { label: string; value: FilterType }[] = [
  { label: 'All', value: 'all' },
  { label: 'PPTX', value: 'presentation' },
  { label: 'PDF', value: 'pdf' },
  { label: 'Video', value: 'video' }
]

export function FileLibrary(): JSX.Element {
  const {
    folderPath,
    filteredFiles,
    filter,
    setFilter,
    selectedFile,
    selectFile,
    activeFile,
    setActiveFile,
    isPresentationWindowOpen,
    setPresentationWindowOpen,
    setCurrentSlide,
    setTotalSlides,
    slidePositions
  } = useAppStore()

  const handleActivate = async (file: FileEntry): Promise<void> => {
    // Show black overlay to hide desktop during transition
    await window.api.showOverlay()

    setActiveFile(file)

    if (file.type === 'presentation') {
      if (isPresentationWindowOpen) {
        await window.api.closePresentationWindow()
        setPresentationWindowOpen(false)
      }
      const result = await window.api.launchPowerPoint(file.path)
      if (result.success && result.output) {
        try {
          const data = JSON.parse(result.output)
          if (data.SlideCount) {
            setTotalSlides(data.SlideCount)
            const saved = slidePositions[file.path] || 1
            setCurrentSlide(saved)
            if (saved > 1) {
              await window.api.powerpointCommand('goto', saved)
            }
          }
        } catch { /* ignore parse errors */ }
      } else if (!result.success) {
        console.error('Failed to launch PowerPoint:', result.error)
      }
      // Give PowerPoint time to render, then hide overlay
      await new Promise((r) => setTimeout(r, 800))
      await window.api.hideOverlay()
      return
    }

    // Close PowerPoint slideshow if switching from PPTX
    if (activeFile?.type === 'presentation') {
      await window.api.powerpointCommand('close')
    }

    if (!isPresentationWindowOpen) {
      await window.api.openPresentationWindow()
      setPresentationWindowOpen(true)
      await new Promise((r) => setTimeout(r, 500))
    }

    const savedSlide = slidePositions[file.path] || 1
    window.api.sendToPresentation('load-content', {
      type: file.type,
      path: file.path,
      name: file.name,
      startSlide: savedSlide
    })

    // Hide overlay after content loads
    await new Promise((r) => setTimeout(r, 300))
    await window.api.hideOverlay()
  }

  if (!folderPath) {
    return (
      <div className="w-72 border-r border-gray-800 flex flex-col items-center justify-center text-gray-500 p-6">
        <div className="text-4xl mb-4 opacity-50">📂</div>
        <p className="text-sm text-center">
          Open a folder to load presentations, PDFs, and videos
        </p>
      </div>
    )
  }

  return (
    <div className="w-72 border-r border-gray-800 flex flex-col bg-surface-300 shrink-0">
      <div className="p-3 border-b border-gray-800">
        <div className="flex gap-1 bg-surface-400 rounded-lg p-0.5">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={`flex-1 text-xs py-1.5 rounded-md transition-colors ${
                filter === f.value
                  ? 'bg-accent text-white'
                  : 'text-gray-400 hover:text-gray-200'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {filteredFiles.length === 0 ? (
          <p className="text-gray-500 text-xs text-center mt-8">No files found</p>
        ) : (
          filteredFiles.map((file) => (
            <FileItem
              key={file.id}
              file={file}
              isSelected={selectedFile?.id === file.id}
              isActive={activeFile?.id === file.id}
              onSelect={() => selectFile(file)}
              onActivate={() => handleActivate(file)}
            />
          ))
        )}
      </div>

      <div className="px-3 py-2 border-t border-gray-800 text-xs text-gray-500">
        {filteredFiles.length} files
      </div>
    </div>
  )
}
