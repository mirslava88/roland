import { useEffect, useState } from 'react'
import { useAppStore } from '../../stores/useAppStore'
import * as pdfjsLib from 'pdfjs-dist'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url
).toString()

interface FileItemGridProps {
  file: FileEntry
  isSelected: boolean
  isActive: boolean
  onSelect: () => void
}

const TYPE_COLORS: Record<string, string> = {
  presentation: 'bg-orange-500/20 text-orange-400',
  pdf: 'bg-red-500/20 text-red-400',
  video: 'bg-blue-500/20 text-blue-400',
  other: 'bg-green-500/20 text-green-400'
}

export function FileItemGrid({
  file,
  isSelected,
  isActive,
  onSelect
}: FileItemGridProps): JSX.Element {
  const [thumbnail, setThumbnail] = useState<string | null>(null)
  const pptxThumbnailsMap = useAppStore((s) => s.pptxThumbnailsMap)

  useEffect(() => {
    let cancelled = false

    async function generateThumb(): Promise<void> {
      if (file.type === 'pdf') {
        try {
          const data = await window.api.readFile(file.path)
          const doc = await pdfjsLib.getDocument({ data }).promise
          const page = await doc.getPage(1)
          const viewport = page.getViewport({ scale: 0.4 })
          const canvas = document.createElement('canvas')
          canvas.width = viewport.width
          canvas.height = viewport.height
          const ctx = canvas.getContext('2d')!
          await page.render({ canvasContext: ctx, viewport }).promise
          if (!cancelled) setThumbnail(canvas.toDataURL())
        } catch { /* ignore */ }
      } else if (file.type === 'presentation') {
        const cached = pptxThumbnailsMap[file.path]
        if (cached && cached.length > 0) {
          setThumbnail(`file://${cached[0]}`)
        } else {
          try {
            const result = await window.api.generatePptxThumbnails(file.path)
            if (!cancelled && result.success && result.thumbnails && result.thumbnails.length > 0) {
              setThumbnail(`file://${result.thumbnails[0]}`)
              const current = useAppStore.getState().pptxThumbnailsMap
              useAppStore.setState({ pptxThumbnailsMap: { ...current, [file.path]: result.thumbnails } })
            }
          } catch { /* ignore */ }
        }
      } else if (file.type === 'other' && file.isImage) {
        if (!cancelled) setThumbnail(`file://${file.path}`)
      } else if (file.type === 'video') {
        // Video thumbnail via hidden video element
        try {
          const video = document.createElement('video')
          video.src = `file://${file.path}`
          video.muted = true
          video.preload = 'metadata'
          await new Promise<void>((resolve) => {
            video.onloadedmetadata = () => {
              video.currentTime = 1
            }
            video.onseeked = () => {
              const canvas = document.createElement('canvas')
              canvas.width = video.videoWidth * 0.2
              canvas.height = video.videoHeight * 0.2
              const ctx = canvas.getContext('2d')!
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
              if (!cancelled) setThumbnail(canvas.toDataURL())
              resolve()
            }
            video.onerror = () => resolve()
          })
        } catch { /* ignore */ }
      }
    }

    generateThumb()
    return () => { cancelled = true }
  }, [file.path, file.type, pptxThumbnailsMap])

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('application/json', JSON.stringify(file))
        e.dataTransfer.effectAllowed = 'copy'
      }}
      onClick={onSelect}
      className={`
        flex flex-col rounded-lg cursor-pointer overflow-hidden
        transition-colors duration-100 select-none
        ${isActive ? 'ring-2 ring-accent' : ''}
        ${isSelected && !isActive ? 'ring-2 ring-gray-600' : ''}
        ${!isSelected && !isActive ? 'hover:ring-1 hover:ring-gray-700' : ''}
      `}
    >
      <div className="aspect-[4/3] bg-black/60 flex items-center justify-center overflow-hidden relative">
        {thumbnail ? (
          <img src={thumbnail} alt={file.name} className="w-full h-full object-cover" draggable={false} />
        ) : (
          <span className="text-2xl opacity-30">
            {file.type === 'presentation' ? '📊' : file.type === 'pdf' ? '📄' : file.type === 'video' ? '🎬' : '📎'}
          </span>
        )}
        {isActive && (
          <span className="absolute top-1 left-1 w-2 h-2 rounded-full bg-red-500 animate-pulse" />
        )}
        <span className={`absolute top-1 right-1 text-[8px] font-bold px-1 py-0.5 rounded ${TYPE_COLORS[file.type] || 'text-gray-400'}`}>
          {file.extension.replace('.', '').toUpperCase()}
        </span>
      </div>
      <div className="px-1.5 py-1 bg-surface-200">
        <p className="text-[10px] text-gray-300 leading-tight break-words">{file.name}</p>
      </div>
    </div>
  )
}
