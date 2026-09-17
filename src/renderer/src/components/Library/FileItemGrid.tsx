import { useEffect, useState } from 'react'
import { useAppStore } from '../../stores/useAppStore'
import { mediaUrl } from '../../media'
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
  onRename?: () => void
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
  onSelect,
  onRename
}: FileItemGridProps): JSX.Element {
  const [thumbnail, setThumbnail] = useState<string | null>(null)
  const pptxThumbnailsMap = useAppStore((s) => s.pptxThumbnailsMap)
  const cachedPptxThumbnails = pptxThumbnailsMap[file.path]

  useEffect(() => {
    let cancelled = false
    let loadingTask: pdfjsLib.PDFDocumentLoadingTask | null = null
    let renderTask: pdfjsLib.RenderTask | null = null
    let thumbnailVideo: HTMLVideoElement | null = null
    let settleVideo: (() => void) | null = null

    async function generateThumb(): Promise<void> {
      if (file.type === 'pdf') {
        let page: pdfjsLib.PDFPageProxy | null = null
        let canvas: HTMLCanvasElement | null = null
        try {
          const data = await window.api.readFile(file.path)
          if (cancelled) return
          loadingTask = pdfjsLib.getDocument({ data })
          const doc = await loadingTask.promise
          page = await doc.getPage(1)
          const viewport = page.getViewport({ scale: 0.4 })
          canvas = document.createElement('canvas')
          canvas.width = viewport.width
          canvas.height = viewport.height
          const ctx = canvas.getContext('2d')!
          renderTask = page.render({ canvas, canvasContext: ctx, viewport })
          await renderTask.promise
          if (!cancelled) setThumbnail(canvas.toDataURL())
        } catch { /* ignore */ }
        finally {
          renderTask = null
          page?.cleanup()
          if (canvas) {
            canvas.width = 0
            canvas.height = 0
          }
          if (loadingTask) {
            const task = loadingTask
            loadingTask = null
            await task.destroy().catch(() => undefined)
          }
        }
      } else if (file.type === 'presentation') {
        const cached = cachedPptxThumbnails
        if (cached && cached.length > 0) {
          setThumbnail(mediaUrl(cached[0]))
        } else {
          try {
            const result = await window.api.generatePptxThumbnails(file.path)
            if (!cancelled && result.success && result.thumbnails && result.thumbnails.length > 0) {
              setThumbnail(mediaUrl(result.thumbnails[0]))
              const current = useAppStore.getState().pptxThumbnailsMap
              useAppStore.setState({ pptxThumbnailsMap: { ...current, [file.path]: result.thumbnails } })
            }
          } catch { /* ignore */ }
        }
      } else if (file.type === 'other' && file.isImage) {
        if (!cancelled) setThumbnail(mediaUrl(file.path))
      } else if (file.type === 'video') {
        // Video thumbnail via hidden video element
        try {
          const video = document.createElement('video')
          thumbnailVideo = video
          video.src = mediaUrl(file.path)
          video.muted = true
          video.preload = 'metadata'
          await new Promise<void>((resolve) => {
            let settled = false
            let timeout: ReturnType<typeof setTimeout> | null = null
            const finish = (): void => {
              if (settled) return
              settled = true
              if (timeout) clearTimeout(timeout)
              timeout = null
              settleVideo = null
              resolve()
            }
            settleVideo = finish
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
              canvas.width = 0
              canvas.height = 0
              finish()
            }
            video.onerror = finish
            timeout = setTimeout(finish, 8_000)
          })
        } catch { /* ignore */ }
        finally {
          if (thumbnailVideo) {
            thumbnailVideo.onloadedmetadata = null
            thumbnailVideo.onseeked = null
            thumbnailVideo.onerror = null
            thumbnailVideo.pause()
            thumbnailVideo.removeAttribute('src')
            thumbnailVideo.load()
            thumbnailVideo = null
          }
        }
      }
    }

    generateThumb()
    return () => {
      cancelled = true
      settleVideo?.()
      settleVideo = null
      renderTask?.cancel()
      renderTask = null
      if (loadingTask) {
        void loadingTask.destroy().catch(() => undefined)
        loadingTask = null
      }
      if (thumbnailVideo) {
        thumbnailVideo.onloadedmetadata = null
        thumbnailVideo.onseeked = null
        thumbnailVideo.onerror = null
        thumbnailVideo.pause()
        thumbnailVideo.removeAttribute('src')
        thumbnailVideo.load()
        thumbnailVideo = null
      }
    }
  }, [file.path, file.type, cachedPptxThumbnails])

  return (
    <div
      data-pdm-file-item
      data-pdm-file-id={file.id}
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
      <div className="aspect-4/3 bg-black/60 flex items-center justify-center overflow-hidden relative">
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
        <span className={`absolute top-1 right-1 text-[8px] font-bold px-1 py-0.5 rounded-sm ${TYPE_COLORS[file.type] || 'text-gray-400'}`}>
          {file.extension.replace('.', '').toUpperCase()}
        </span>
      </div>
      <div className="px-1.5 py-1 bg-surface-200 relative group">
        <p className="text-[10px] text-gray-300 leading-tight wrap-break-word">{file.name}</p>
        {onRename && (
          <button
            onClick={(e) => { e.stopPropagation(); onRename() }}
            className="absolute top-0.5 right-0.5 opacity-0 group-hover:opacity-100 text-gray-500 hover:text-white text-[8px] px-0.5 rounded-sm hover:bg-white/10 transition-all"
            title="Переименовать"
          >
            ✏️
          </button>
        )}
      </div>
    </div>
  )
}
