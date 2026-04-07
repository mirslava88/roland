import { useAppStore } from '../../stores/useAppStore'

const TYPE_LABELS: Record<string, string> = {
  presentation: 'PPTX',
  pdf: 'PDF',
  video: 'Видео'
}

const TYPE_COLORS: Record<string, string> = {
  presentation: 'bg-orange-500/20 text-orange-400',
  pdf: 'bg-red-500/20 text-red-400',
  video: 'bg-blue-500/20 text-blue-400'
}

export function NowPlaying(): JSX.Element | null {
  const { activeFile, currentSlide, totalSlides, isPlaying } = useAppStore()

  if (!activeFile) return null

  return (
    <div className="h-9 bg-surface-200 border-b border-gray-800 flex items-center px-4 gap-3 shrink-0">
      <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse shrink-0" />
      <span className="text-[10px] font-bold uppercase text-gray-500 shrink-0">Сейчас в эфире</span>

      <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${TYPE_COLORS[activeFile.type] || 'text-gray-400'}`}>
        {TYPE_LABELS[activeFile.type] || activeFile.extension}
      </span>

      <span className="text-sm text-gray-200 font-medium truncate">
        {activeFile.name}
      </span>

      {(activeFile.type === 'pdf' || activeFile.type === 'presentation') && totalSlides > 0 && (
        <span className="text-xs text-gray-500 tabular-nums shrink-0">
          {currentSlide} / {totalSlides}
        </span>
      )}

      {activeFile.type === 'video' && (
        <span className="text-xs text-gray-500 shrink-0">
          {isPlaying ? '▶ Воспроизведение' : '⏸ Пауза'}
        </span>
      )}
    </div>
  )
}
