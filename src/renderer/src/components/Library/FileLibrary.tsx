import { useState, useEffect, useRef } from 'react'
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

function formatSize(bytes: number): string {
  if (bytes <= 0) return ''
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} ГБ`
  return `${(bytes / (1024 * 1024 * 1024 * 1024)).toFixed(1)} ТБ`
}

export function FileLibrary(): JSX.Element {
  const {
    folderPath,
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
  const [drives, setDrives] = useState<DriveInfo[]>([])
  const [renamingFile, setRenamingFile] = useState<string | null>(null)
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null)
  const [clipboardFile, setClipboardFile] = useState<{ path: string; cut: boolean; isFolder?: boolean } | null>(null)
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; file?: FileEntry; folderPath?: string; folderName?: string } | null>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Load drives on mount and periodically
  useEffect(() => {
    const loadDrives = async (): Promise<void> => {
      const d = await window.api.getDrives()
      setDrives(d)
    }
    loadDrives()
    const interval = setInterval(loadDrives, 5000)
    return () => clearInterval(interval)
  }, [])

  // Hydrate folder contents on mount: persist восстанавливает folderPath,
  // но files/subfolders — нет (это runtime-данные ФС). Без этого юзер
  // видит сохранённый путь, но "Файлы не найдены" пока вручную не зайдёт
  // в папку. Подгружаем содержимое один раз при монтировании.
  useEffect(() => {
    const fp = useAppStore.getState().folderPath
    if (!fp) return
    window.api.loadFolder(fp).then((result) => {
      useAppStore.getState().setFiles(result.files)
      useAppStore.getState().setSubfolders(result.subfolders)
    }).catch(() => { /* ignore — folder may have been deleted */ })
  }, [])

  // Watch текущей папки через fs.watch в main процессе. Любое изменение
  // (новый файл, удаление, переименование извне Windows Explorer) триггерит
  // 'folder-changed' → re-load список.
  useEffect(() => {
    window.api.watchFolder(folderPath ?? null)
    if (!folderPath) return
    const unsub = window.api.on('folder-changed', (...args: unknown[]) => {
      const changedPath = args[0] as string
      // Только если изменилась активно открытая папка
      const cur = useAppStore.getState().folderPath
      if (changedPath !== cur) return
      window.api.loadFolder(cur).then((result) => {
        useAppStore.getState().setFiles(result.files)
        useAppStore.getState().setSubfolders(result.subfolders)
      }).catch(() => { /* ignore */ })
    })
    return () => {
      unsub()
    }
  }, [folderPath])

  const refreshCurrentFolder = async (): Promise<void> => {
    // Always read fresh folderPath from store (not from closure which can be stale)
    const currentPath = useAppStore.getState().folderPath
    if (!currentPath) return
    const result = await window.api.loadFolder(currentPath)
    useAppStore.getState().setFiles(result.files)
    useAppStore.getState().setSubfolders(result.subfolders)
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
      navigateToPath(path)
    }
  }

  const navigateToPath = async (path: string): Promise<void> => {
    setFolderPath(path)
    const result = await window.api.loadFolder(path)
    setFiles(result.files)
    setSubfolders(result.subfolders)
  }

  const handleNavigateToFolder = async (folder: SubfolderEntry): Promise<void> => {
    navigateToPath(folder.path)
  }

  const handleNavigateToDrive = async (drive: DriveInfo): Promise<void> => {
    navigateToPath(drive.root)
  }

  const getParentPath = (): string | null => {
    if (!folderPath) return null
    const parent = folderPath.replace(/[\\/][^\\/]+$/, '')
    if (!parent || parent === folderPath) return null
    // Allow navigating to drive root (e.g. C:\)
    if (parent.match(/^[A-Za-z]:$/)) return parent + '\\'
    return parent
  }

  const handleGoBack = async (): Promise<void> => {
    const parent = getParentPath()
    if (parent) {
      navigateToPath(parent)
    } else {
      // Go to drives view
      setFolderPath(null)
      setFiles([])
      setSubfolders([])
    }
  }

  const handleGoToDrives = (): void => {
    setFolderPath(null)
    setFiles([])
    setSubfolders([])
  }

  // Rename handlers
  const startRename = (file: FileEntry): void => {
    setRenamingFile(file.id)
    setRenameValue(file.name)
    setTimeout(() => renameInputRef.current?.select(), 50)
  }

  const commitRename = async (file: FileEntry): Promise<void> => {
    if (!renameValue.trim() || renameValue === file.name) {
      setRenamingFile(null)
      return
    }
    const result = await window.api.renameFile(file.path, renameValue.trim())
    if (result.success) {
      await refreshCurrentFolder()
    }
    setRenamingFile(null)
  }

  const cancelRename = (): void => {
    setRenamingFile(null)
    setRenamingFolder(null)
  }

  const startFolderRename = (folder: { name: string; path: string }): void => {
    setRenamingFolder(folder.path)
    setRenameValue(folder.name)
    setTimeout(() => renameInputRef.current?.select(), 50)
  }

  const commitFolderRename = async (folderPath: string): Promise<void> => {
    const oldName = folderPath.split(/[\\/]/).pop() || ''
    if (!renameValue.trim() || renameValue === oldName) {
      setRenamingFolder(null)
      return
    }
    const result = await window.api.renameFile(folderPath, renameValue.trim())
    if (result.success) {
      await refreshCurrentFolder()
    }
    setRenamingFolder(null)
  }

  // Context menu handlers
  const handleFileContextMenu = (e: React.MouseEvent, file: FileEntry): void => {
    e.preventDefault()
    selectFile(file)
    setSelectedFolder(null)
    setContextMenu({ x: e.clientX, y: e.clientY, file })
  }

  const handleFolderContextMenu = (e: React.MouseEvent, folder: { name: string; path: string }): void => {
    e.preventDefault()
    e.stopPropagation()
    selectFile(null)
    setSelectedFolder(folder.path)
    setContextMenu({ x: e.clientX, y: e.clientY, folderPath: folder.path, folderName: folder.name })
  }

  const ctxCopy = (path: string, isFolder?: boolean): void => {
    setClipboardFile({ path, cut: false, isFolder })
    setCopyFeedback('Скопировано в буфер')
    setTimeout(() => setCopyFeedback(null), 1500)
    setContextMenu(null)
  }

  const ctxCut = (path: string, isFolder?: boolean): void => {
    setClipboardFile({ path, cut: true, isFolder })
    setCopyFeedback('Вырезано в буфер')
    setTimeout(() => setCopyFeedback(null), 1500)
    setContextMenu(null)
  }

  const ctxPaste = async (): Promise<void> => {
    setContextMenu(null)
    const fp = useAppStore.getState().folderPath
    const clip = clipboardRef.current
    if (!fp || !clip) return
    if (clip.cut) {
      const result = await window.api.moveItem(clip.path, fp)
      if (result.success) { setCopyFeedback('Перемещено'); setClipboardFile(null) }
      else setCopyFeedback('Ошибка перемещения')
    } else {
      const results = await window.api.copyItemsToFolder([clip.path], fp)
      setCopyFeedback(results[0]?.success ? 'Вставлено' : 'Ошибка копирования')
    }
    setTimeout(() => setCopyFeedback(null), 1500)
    await refreshCurrentFolder()
  }

  const ctxRename = (file: FileEntry): void => {
    setContextMenu(null)
    startRename(file)
  }

  const ctxRenameFolder = (folderPath: string, folderName: string): void => {
    setContextMenu(null)
    startFolderRename({ name: folderName, path: folderPath })
  }

  const ctxDelete = async (path: string, permanent: boolean): Promise<void> => {
    setContextMenu(null)
    const results = await window.api.deleteItems([path], permanent)
    if (results[0]?.success) {
      setCopyFeedback(permanent ? 'Удалено' : 'В корзину')
      // Clear selection if deleted item was selected
      const { selectedFile: sel } = useAppStore.getState()
      if (sel && sel.path === path) selectFile(null)
      if (selectedFolder === path) setSelectedFolder(null)
    } else {
      setCopyFeedback('Ошибка удаления')
    }
    setTimeout(() => setCopyFeedback(null), 1500)
    await refreshCurrentFolder()
  }

  // Close context menu on click outside
  useEffect(() => {
    if (!contextMenu) return
    const close = (): void => setContextMenu(null)
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [contextMenu])

  // Keyboard shortcuts
  const clipboardRef = useRef(clipboardFile)
  clipboardRef.current = clipboardFile
  const renamingRef = useRef(renamingFile || renamingFolder)
  renamingRef.current = renamingFile || renamingFolder
  const selectedFolderRef = useRef(selectedFolder)
  selectedFolderRef.current = selectedFolder

  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent): Promise<void> => {
      if (renamingRef.current) return
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return

      const ctrl = e.ctrlKey || e.metaKey
      const { selectedFile: sel, folderPath: fp } = useAppStore.getState()
      const selFolder = selectedFolderRef.current
      const code = e.code

      // Selected item path (file or folder)
      const selPath = sel?.path || selFolder
      const isFolder = !sel && !!selFolder

      // F2 — rename selected file or folder
      if (e.key === 'F2') {
        if (sel) {
          e.preventDefault()
          startRename(sel)
          return
        }
        if (selFolder) {
          e.preventDefault()
          const { subfolders: subs } = useAppStore.getState()
          const f = subs.find(s => s.path === selFolder)
          if (f) startFolderRename(f)
          return
        }
      }

      // Ctrl+C — copy
      if (ctrl && code === 'KeyC' && selPath) {
        e.preventDefault()
        setClipboardFile({ path: selPath, cut: false, isFolder })
        setCopyFeedback('Скопировано в буфер')
        setTimeout(() => setCopyFeedback(null), 1500)
        return
      }

      // Ctrl+X — cut
      if (ctrl && code === 'KeyX' && selPath) {
        e.preventDefault()
        setClipboardFile({ path: selPath, cut: true, isFolder })
        setCopyFeedback('Вырезано в буфер')
        setTimeout(() => setCopyFeedback(null), 1500)
        return
      }

      // Ctrl+V — paste
      if (ctrl && code === 'KeyV' && fp) {
        e.preventDefault()
        const clip = clipboardRef.current
        if (clip) {
          if (clip.cut) {
            const result = await window.api.moveItem(clip.path, fp)
            if (result.success) { setCopyFeedback('Перемещено'); setClipboardFile(null) }
            else setCopyFeedback('Ошибка перемещения')
          } else {
            const results = await window.api.copyItemsToFolder([clip.path], fp)
            setCopyFeedback(results[0]?.success ? 'Вставлено' : 'Ошибка копирования')
          }
          setTimeout(() => setCopyFeedback(null), 1500)
          await refreshCurrentFolder()
        }
        return
      }

      // Delete — recycle bin, Shift+Delete — permanent
      if (e.key === 'Delete' && selPath) {
        e.preventDefault()
        const permanent = e.shiftKey
        const results = await window.api.deleteItems([selPath], permanent)
        if (results[0]?.success) {
          setCopyFeedback(permanent ? 'Удалено' : 'В корзину')
          if (sel) selectFile(null)
          if (selFolder) setSelectedFolder(null)
        } else {
          setCopyFeedback('Ошибка удаления')
        }
        setTimeout(() => setCopyFeedback(null), 1500)
        await refreshCurrentFolder()
        return
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, []) // register once, read fresh state inside

  // Handle native file drop from Windows Explorer onto the file list
  const handleNativeDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    const fp = useAppStore.getState().folderPath
    if (!fp) return

    // Check if it's an internal drag (has JSON data) — let the folder drop handler deal with it
    try {
      const jsonData = e.dataTransfer.getData('application/json')
      if (jsonData) return
    } catch { /* ignore — getData can throw for native drops */ }

    // Collect native file paths synchronously before any await
    const nativeFiles = e.dataTransfer?.files
    if (!nativeFiles || nativeFiles.length === 0) return

    const filePaths: string[] = []
    for (let i = 0; i < nativeFiles.length; i++) {
      const p = window.api.getPathForFile(nativeFiles[i])
      if (p) filePaths.push(p)
    }
    if (filePaths.length === 0) return

    setCopyFeedback(`Копирование ${filePaths.length} файл(ов)...`)
    const results = await window.api.copyFilesToFolder(filePaths, fp)
    const ok = results.filter((r) => r.success).length
    setCopyFeedback(`Скопировано: ${ok} из ${filePaths.length}`)
    setTimeout(() => setCopyFeedback(null), 2000)
    await refreshCurrentFolder()
  }

  const currentFolderName = folderPath ? folderPath.split(/[\\/]/).pop() || folderPath : ''

  // Drives view (no folder selected)
  if (!folderPath) {
    return (
      <div className="w-72 border-r border-gray-800 flex flex-col bg-surface-300 shrink-0">
        <div className="p-3 border-b border-gray-800">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold text-gray-400 uppercase">Выбор презентаций</span>
            <button
              onClick={handleOpenFolder}
              className="text-[10px] text-gray-400 hover:text-white px-2 py-1 rounded hover:bg-surface-100 transition-colors"
              title="Открыть папку"
            >
              📂 Обзор
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {drives.map((drive) => (
            <div
              key={drive.root}
              onClick={() => handleNavigateToDrive(drive)}
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer transition-colors duration-100 select-none border border-transparent hover:bg-surface-100/50"
            >
              <span className="text-lg shrink-0">{drive.isRemovable ? (<svg className="w-5 h-5 inline" viewBox="0 0 24 24" fill="currentColor"><path d="M8 2a2 2 0 0 0-2 2v1H5a2 2 0 0 0-2 2v12a3 3 0 0 0 3 3h12a3 3 0 0 0 3-3V7a2 2 0 0 0-2-2h-1V4a2 2 0 0 0-2-2H8zm0 2h8v1H8V4zm-1 3h10a1 1 0 0 1 1 1v11a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8a1 1 0 0 1 1-1zm2 3a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1H9z"/></svg>) : (<svg className="w-5 h-5 inline" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="16" x2="21" y2="16" stroke="currentColor" strokeWidth="1.5" opacity="0.2"/><circle cx="18" cy="19" r="1" fill="#4ade80"/></svg>)}</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-200 truncate">
                  {drive.label || `Диск ${drive.name}`} ({drive.name}:)
                </p>
                {drive.totalSize > 0 && (
                  <div className="mt-1">
                    <div className="w-full h-1 bg-gray-700 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${drive.freeSize / drive.totalSize < 0.1 ? 'bg-red-500' : 'bg-accent'}`}
                        style={{ width: `${((drive.totalSize - drive.freeSize) / drive.totalSize) * 100}%` }}
                      />
                    </div>
                    <p className="text-[9px] text-gray-500 mt-0.5">
                      {formatSize(drive.freeSize)} свободно из {formatSize(drive.totalSize)}
                    </p>
                  </div>
                )}
              </div>
            </div>
          ))}
          {drives.length === 0 && (
            <p className="text-gray-500 text-xs text-center mt-8">Загрузка дисков...</p>
          )}
        </div>
      </div>
    )
  }

  const parentPath = getParentPath()

  return (
    <div className="w-72 border-r border-gray-800 flex flex-col bg-surface-300 shrink-0">
      <div className="p-3 border-b border-gray-800">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-bold text-gray-400 uppercase">Выбор презентаций</span>
          <button
            onClick={handleOpenFolder}
            className="text-[10px] text-gray-400 hover:text-white px-2 py-1 rounded hover:bg-surface-100 transition-colors"
            title="Открыть папку"
          >
            📂 Обзор
          </button>
        </div>
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
        {/* Navigation bar */}
        <div className="flex items-center gap-1 mb-2">
          <button
            onClick={handleGoToDrives}
            className="text-[11px] text-gray-400 hover:text-white transition-colors px-1 py-0.5 rounded hover:bg-surface-100"
            title="Все диски"
          >
            <svg className="w-3.5 h-3.5 inline" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="16" x2="21" y2="16" stroke="currentColor" strokeWidth="1.5" opacity="0.2"/><circle cx="18" cy="19" r="1" fill="#4ade80"/></svg>
          </button>
          <div className="text-[10px] text-gray-500 truncate flex-1" title={folderPath}>
            {(() => {
              if (!folderPath) return null
              // Split path into segments: "C:\Users\mirslava" -> ["C:", "Users", "mirslava"]
              const segments = folderPath.split(/[\\/]/).filter(Boolean)
              return segments.map((seg, i) => {
                const segPath = segments.slice(0, i + 1).join('\\') + (i === 0 ? '\\' : '')
                const isLast = i === segments.length - 1
                return (
                  <span key={i}>
                    {i > 0 && <span className="text-gray-600 mx-px">\</span>}
                    <span
                      onClick={(e) => { e.stopPropagation(); if (!isLast) navigateToPath(segPath) }}
                      className={isLast ? 'text-gray-400' : 'text-gray-500 hover:text-white cursor-pointer hover:underline'}
                    >
                      {seg}
                    </span>
                  </span>
                )
              })
            })()}
          </div>
        </div>
        {copyFeedback && (
          <div className="text-[10px] text-accent mb-1 animate-pulse">{copyFeedback}</div>
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

      <div
        ref={listRef}
        className={`flex-1 overflow-y-auto p-2 ${viewMode === 'grid' ? 'grid grid-cols-2 gap-2 auto-rows-min content-start' : 'space-y-1'}`}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }}
        onDrop={handleNativeDrop}
        onContextMenu={(e) => {
          if ((e.target as HTMLElement).closest('[data-file-item]')) return
          if (!clipboardFile) return
          e.preventDefault()
          setContextMenu({ x: e.clientX, y: e.clientY })
        }}
      >
        {/* Go up (..) — styled like a regular folder */}
        {parentPath && (
          <div
            onClick={handleGoBack}
            onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOverFolder('__parent__') }}
            onDragLeave={() => setDragOverFolder(null)}
            onDrop={(e) => handleMoveFile(parentPath, e)}
            className={`flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors duration-100 select-none border ${
              dragOverFolder === '__parent__'
                ? 'border-accent bg-accent/10'
                : 'border-transparent hover:bg-surface-100/50'
            } ${viewMode === 'grid' ? 'flex-col text-center gap-1 py-3' : ''}`}
          >
            <span className={viewMode === 'grid' ? 'text-2xl' : 'text-sm shrink-0'}>📁</span>
            <p className={`text-yellow-500 truncate ${viewMode === 'grid' ? 'text-[10px] w-full' : 'text-xs font-medium'}`} title={parentPath}>
              ..
            </p>
          </div>
        )}

        {/* Subfolders — accept file drops, support selection & context menu */}
        {subfolders.map((folder) => (
          renamingFolder === folder.path ? (
            <div key={folder.path} className="flex items-center gap-2 px-2 py-1.5 bg-surface-100 rounded-md">
              <span className="text-sm shrink-0">📁</span>
              <input
                ref={renameInputRef}
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitFolderRename(folder.path)
                  if (e.key === 'Escape') cancelRename()
                }}
                onBlur={() => commitFolderRename(folder.path)}
                className="flex-1 bg-surface-400 text-white text-xs px-2 py-0.5 rounded outline-none border border-accent"
                autoFocus
              />
            </div>
          ) : (
            <div
              key={folder.path}
              onClick={(e) => { e.stopPropagation(); setSelectedFolder(folder.path); selectFile(null) }}
              onDoubleClick={() => handleNavigateToFolder(folder)}
              onContextMenu={(e) => handleFolderContextMenu(e, folder)}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOverFolder(folder.path) }}
              onDragLeave={() => setDragOverFolder(null)}
              onDrop={(e) => handleMoveFile(folder.path, e)}
              className={`flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors duration-100 select-none border ${
                dragOverFolder === folder.path
                  ? 'border-accent bg-accent/10'
                  : selectedFolder === folder.path
                    ? 'border-accent/50 bg-accent/5'
                    : 'border-transparent hover:bg-surface-100/50'
              } ${viewMode === 'grid' ? 'flex-col text-center gap-1 py-3' : ''}`}
            >
              <span className={viewMode === 'grid' ? 'text-2xl' : 'text-sm shrink-0'}>📁</span>
              <p className={`text-gray-300 truncate ${viewMode === 'grid' ? 'text-[10px] w-full' : 'text-xs font-medium'}`}>
                {folder.name}
              </p>
            </div>
          )
        ))}

        {/* Files */}
        {filteredFiles.length === 0 && subfolders.length === 0 ? (
          <p className="text-gray-500 text-xs text-center mt-8 col-span-2">Файлы не найдены</p>
        ) : (
          filteredFiles.map((file) => (
            <div key={file.id} className="relative group" onContextMenu={(e) => handleFileContextMenu(e, file)}>
              {renamingFile === file.id ? (
                <div className="flex items-center gap-1 px-2 py-2 bg-surface-100 rounded-lg">
                  <input
                    ref={renameInputRef}
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename(file)
                      if (e.key === 'Escape') cancelRename()
                    }}
                    onBlur={() => commitRename(file)}
                    className="flex-1 bg-surface-400 text-white text-xs px-2 py-1 rounded outline-none border border-accent"
                    autoFocus
                  />
                </div>
              ) : viewMode === 'list' ? (
                <FileItem
                  file={file}
                  isSelected={selectedFile?.id === file.id}
                  isActive={activeFile?.id === file.id}
                  onSelect={() => selectFile(file)}
                  onRename={() => startRename(file)}
                />
              ) : (
                <FileItemGrid
                  file={file}
                  isSelected={selectedFile?.id === file.id}
                  isActive={activeFile?.id === file.id}
                  onSelect={() => selectFile(file)}
                  onRename={() => startRename(file)}
                />
              )}
            </div>
          ))
        )}
      </div>

      <div className="px-3 py-2 border-t border-gray-800 text-xs text-gray-500">
        {filteredFiles.length} {(() => { const n = filteredFiles.length; const m = n % 10; const h = n % 100; if (h >= 11 && h <= 14) return 'файлов'; if (m === 1) return 'файл'; if (m >= 2 && m <= 4) return 'файла'; return 'файлов' })()}
      </div>

      {/* Context menu */}
      {contextMenu && (() => {
        const itemPath = contextMenu.file?.path || contextMenu.folderPath
        const isFolder = !!contextMenu.folderPath
        const cls = "w-full text-left px-3 py-1.5 text-xs text-gray-200 hover:bg-accent/20 hover:text-white flex items-center justify-between"
        return (
          <div
            className="fixed z-50 bg-surface-100 border border-gray-700 rounded-lg shadow-xl py-1 min-w-[200px]"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            {itemPath && (
              <>
                <button onClick={() => { ctxCopy(itemPath, isFolder) }} className={cls}>
                  <span>Копировать</span> <span className="text-gray-500 text-[10px] ml-4">Ctrl+C</span>
                </button>
                <button onClick={() => { ctxCut(itemPath, isFolder) }} className={cls}>
                  <span>Вырезать</span> <span className="text-gray-500 text-[10px] ml-4">Ctrl+X</span>
                </button>
              </>
            )}
            {clipboardFile && (
              <button onClick={ctxPaste} className={cls}>
                <span>Вставить</span> <span className="text-gray-500 text-[10px] ml-4">Ctrl+V</span>
              </button>
            )}
            {(contextMenu.file || contextMenu.folderPath) && (
              <>
                <div className="border-t border-gray-700 my-1" />
                <button onClick={() => contextMenu.file ? ctxRename(contextMenu.file) : ctxRenameFolder(contextMenu.folderPath!, contextMenu.folderName!)} className={cls}>
                  <span>Переименовать</span> <span className="text-gray-500 text-[10px] ml-4">F2</span>
                </button>
              </>
            )}
            {itemPath && (
              <>
                <div className="border-t border-gray-700 my-1" />
                <button onClick={() => ctxDelete(itemPath, false)} className={cls}>
                  <span>В корзину</span> <span className="text-gray-500 text-[10px] ml-4">Del</span>
                </button>
                <button onClick={() => ctxDelete(itemPath, true)} className={`${cls} text-red-400 hover:text-red-300`}>
                  <span>Удалить</span> <span className="text-gray-500 text-[10px] ml-4">Shift+Del</span>
                </button>
              </>
            )}
          </div>
        )
      })()}
    </div>
  )
}
