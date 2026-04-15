import { useState } from 'react'
import { useAppStore, FilterType, SubfolderEntry } from '../../stores/useAppStore'
import { FileItem } from './FileItem'
import { FileItemGrid } from './FileItemGrid'

const FILTERS: { label: string; value: FilterType }[] = [
  { label: 'Все', value: 'all' },
  { label: 'PPTX', value: 'presentation' },
  { label: 'PDF', value: 'pdf' },
  { label: 'Видео', value: 'video' },
  { label: 'Разное', value: 'other' }
]

export function FileLibrary(): JSX.Element {
  const {
    folderPath,
    rootFolderPath,
    setFolderPath,
    setFiles,
    setSubfolders,
    subfolders,
    filteredFiles,
    filter,
    setFilter,
    selectedFile,
    selectFile,
    activeFile
  } = useAppStore()

  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list')
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null)

  const refreshCurrentFolder = async (): Promise<void> => {
    if (!folderPath) return
    const result = await window.api.loadFolder(folderPath)
    setFiles(result.files)
    setSubfolders(result.subfolders)
  }

  const handleMoveFile = async (destFolder: string, e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    setDragOverFolder(null)
    try {
      const file = JSON.parse(e.dataTransfer.getData('application/json')) as FileEntry
      if (!file?.path) return
      const result = await window.api.moveFile(file.path, destFolder)
      if (result.success) {
        await refreshCurrentFolder()
      }
    } catch { /* ignore */ }
  }

  const handleOpenFolder = async (): Promise<void> => {
    const path = await window.api.selectFolder()
    if (path) {
      setFolderPath(path)
      useAppStore.setState({ rootFolderPath: path })
      const result = await window.api.loadFolder(path)
      setFiles(result.files)
      setSubfolders(result.subfolders)
    }
  }

  const handleNavigateToFolder = async (folder: SubfolderEntry): Promise<void> => {
    setFolderPath(folder.path)
    const result = await window.api.loadFolder(folder.path)
    setFiles(result.files)
    setSubfolders(result.subfolders)
  }

  const getParentPath = (): string | null => {
    if (!folderPath) return null
    const parent = folderPath.replace(/[\\/][^\\/]+$/, '')
    if (!parent || parent === folderPath) return null
    if (rootFolderPath && !parent.startsWith(rootFolderPath.replace(/[\\/]$/, '')) && parent !== rootFolderPath) return null
    return parent
  }

  const handleGoBack = async (): Promise<void> => {
    const parent = getParentPath()
    if (!parent) return
    setFolderPath(parent)
    const result = await window.api.loadFolder(parent)
    setFiles(result.files)
    setSubfolders(result.subfolders)
  }

  const canGoBack = folderPath && rootFolderPath && folderPath !== rootFolderPath
  const currentFolderName = folderPath ? folderPath.split(/[\\/]/).pop() : ''

  if (!folderPath) {
    return (
      <div
        className="w-72 border-r border-gray-800 flex flex-col items-center justify-center text-gray-500 p-6 cursor-pointer hover:bg-surface-200 transition-colors"
        onClick={handleOpenFolder}
      >
        <div className="text-4xl mb-4 opacity-50">📂</div>
        <p className="text-sm text-center">
          Откройте папку для загрузки презентаций, PDF и видео
        </p>
      </div>
    )
  }

  const parentPath = getParentPath()

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
        {/* Breadcrumb / back navigation — also accepts drop to move file to parent */}
        {canGoBack && (
          <div
            className={`flex items-center gap-1 mb-2 rounded transition-colors ${
              dragOverFolder === '__parent__' ? 'bg-accent/20 ring-1 ring-accent' : ''
            }`}
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOverFolder('__parent__') }}
            onDragLeave={() => setDragOverFolder(null)}
            onDrop={(e) => parentPath && handleMoveFile(parentPath, e)}
          >
            <button
              onClick={handleGoBack}
              className="text-[11px] text-gray-400 hover:text-white transition-colors flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-surface-100"
            >
              <span>&#8592;</span> Назад
            </button>
            <span className="text-[10px] text-gray-600 truncate" title={folderPath}>
              {currentFolderName}
            </span>
          </div>
        )}
        <div className="flex justify-end gap-1">
          <button
            onClick={() => setViewMode('list')}
            className={`btn-icon text-[10px] p-1 ${viewMode === 'list' ? 'text-white bg-surface-100' : ''}`}
            title="Список"
          >
            ☰
          </button>
          <button
            onClick={() => setViewMode('grid')}
            className={`btn-icon text-[10px] p-1 ${viewMode === 'grid' ? 'text-white bg-surface-100' : ''}`}
            title="Плитка"
          >
            ▦
          </button>
        </div>
      </div>

      <div className={`flex-1 overflow-y-auto p-2 ${viewMode === 'grid' ? 'grid grid-cols-2 gap-2 auto-rows-min content-start' : 'space-y-1'}`}>
        {/* Subfolders — accept file drops */}
        {subfolders.map((folder) => (
          <div
            key={folder.path}
            onClick={() => handleNavigateToFolder(folder)}
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOverFolder(folder.path) }}
            onDragLeave={() => setDragOverFolder(null)}
            onDrop={(e) => handleMoveFile(folder.path, e)}
            className={`flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer transition-colors duration-100 select-none border ${
              dragOverFolder === folder.path
                ? 'border-accent bg-accent/10'
                : 'border-transparent hover:bg-surface-100/50'
            } ${viewMode === 'grid' ? 'flex-col text-center gap-1 py-3' : ''}`}
          >
            <span className={viewMode === 'grid' ? 'text-2xl' : 'text-lg shrink-0'}>📁</span>
            <p className={`text-gray-300 truncate ${viewMode === 'grid' ? 'text-[10px] w-full' : 'text-sm font-medium'}`}>
              {folder.name}
            </p>
          </div>
        ))}

        {/* Files */}
        {filteredFiles.length === 0 && subfolders.length === 0 ? (
          <p className="text-gray-500 text-xs text-center mt-8 col-span-2">Файлы не найдены</p>
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
        {filteredFiles.length} {(() => { const n = filteredFiles.length; const m = n % 10; const h = n % 100; if (h >= 11 && h <= 14) return 'файлов'; if (m === 1) return 'файл'; if (m >= 2 && m <= 4) return 'файла'; return 'файлов' })()}
      </div>
    </div>
  )
}
