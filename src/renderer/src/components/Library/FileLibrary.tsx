import { useState } from 'react'
import { useAppStore, FilterType } from '../../stores/useAppStore'
import { FileItem } from './FileItem'
import { FileItemGrid } from './FileItemGrid'

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
    activeFile
  } = useAppStore()

  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list')

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
        <div className="flex gap-1 bg-surface-400 rounded-lg p-0.5 mb-2">
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
        <div className="flex justify-end gap-1">
          <button
            onClick={() => setViewMode('list')}
            className={`btn-icon text-[10px] p-1 ${viewMode === 'list' ? 'text-white bg-surface-100' : ''}`}
            title="List view"
          >
            ☰
          </button>
          <button
            onClick={() => setViewMode('grid')}
            className={`btn-icon text-[10px] p-1 ${viewMode === 'grid' ? 'text-white bg-surface-100' : ''}`}
            title="Grid view"
          >
            ▦
          </button>
        </div>
      </div>

      <div className={`flex-1 overflow-y-auto p-2 ${viewMode === 'grid' ? 'grid grid-cols-2 gap-2 auto-rows-min content-start' : 'space-y-1'}`}>
        {filteredFiles.length === 0 ? (
          <p className="text-gray-500 text-xs text-center mt-8 col-span-2">No files found</p>
        ) : (
          filteredFiles.map((file) =>
            viewMode === 'list' ? (
              <FileItem
                key={file.id}
                file={file}
                isSelected={selectedFile?.id === file.id}
                isActive={activeFile?.id === file.id}
                onSelect={() => selectFile(file)}
              />
            ) : (
              <FileItemGrid
                key={file.id}
                file={file}
                isSelected={selectedFile?.id === file.id}
                isActive={activeFile?.id === file.id}
                onSelect={() => selectFile(file)}
              />
            )
          )
        )}
      </div>

      <div className="px-3 py-2 border-t border-gray-800 text-xs text-gray-500">
        {filteredFiles.length} files
      </div>
    </div>
  )
}
