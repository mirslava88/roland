interface FileItemProps {
  file: FileEntry
  isSelected: boolean
  isActive: boolean
  onSelect: () => void
  onRename?: () => void
}

const TYPE_ICONS: Record<string, string> = {
  presentation: '📊',
  pdf: '📄',
  video: '🎬'
}

const TYPE_COLORS: Record<string, string> = {
  presentation: 'text-orange-400',
  pdf: 'text-red-400',
  video: 'text-blue-400'
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function FileItem({
  file,
  isSelected,
  isActive,
  onSelect,
  onRename
}: FileItemProps): JSX.Element {
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('application/json', JSON.stringify(file))
        e.dataTransfer.effectAllowed = 'copy'
      }}
      onClick={onSelect}
      className={`
        flex items-center gap-3 px-3 py-2.5 rounded-lg cursor-pointer
        transition-colors duration-100 select-none group
        ${isActive ? 'bg-accent/20 border border-accent/40' : ''}
        ${isSelected && !isActive ? 'bg-surface-100 border border-gray-700' : ''}
        ${!isSelected && !isActive ? 'border border-transparent hover:bg-surface-100/50' : ''}
      `}
    >
      {isActive && (
        <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse shrink-0" />
      )}
      <span className="text-lg shrink-0">{TYPE_ICONS[file.type] || '📎'}</span>

      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-200 truncate">{file.name}</p>
        <div className="flex items-center gap-2 mt-0.5">
          <span className={`text-[10px] font-semibold uppercase ${TYPE_COLORS[file.type] || 'text-gray-500'}`}>
            {file.extension.replace('.', '')}
          </span>
          <span className="text-[10px] text-gray-600">{formatSize(file.size)}</span>
        </div>
      </div>
      {onRename && (
        <button
          onClick={(e) => { e.stopPropagation(); onRename() }}
          className="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-white text-[10px] px-1 py-0.5 rounded hover:bg-white/10 transition-all shrink-0"
          title="Переименовать"
        >
          ✏️
        </button>
      )}
    </div>
  )
}
