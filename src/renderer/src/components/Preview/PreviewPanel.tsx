import { useEffect, useRef, useCallback, useState } from 'react'
import { useAppStore, ChannelState } from '../../stores/useAppStore'
import * as pdfjsLib from 'pdfjs-dist'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url
).toString()

const EXT_TYPE_MAP: Record<string, FileEntry['type']> = {}
;['.pptx', '.ppt'].forEach((e) => (EXT_TYPE_MAP[e] = 'presentation'))
;['.pdf'].forEach((e) => (EXT_TYPE_MAP[e] = 'pdf'))
;['.mp4', '.mov', '.avi', '.webm', '.mkv'].forEach((e) => (EXT_TYPE_MAP[e] = 'video'))
;['.doc', '.docx', '.xls', '.xlsx', '.txt', '.rtf', '.odt', '.ods',
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.tif', '.svg',
  '.mp3', '.wav', '.ogg', '.aac', '.m4a', '.flac', '.wma'].forEach((e) => (EXT_TYPE_MAP[e] = 'other'))

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.tif', '.svg'])
const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.aac', '.m4a', '.flac', '.wma'])

function nativeFileToEntry(filePath: string): FileEntry | null {
  const parts = filePath.replace(/\\/g, '/').split('/')
  const fullName = parts.pop() || ''
  const dotIdx = fullName.lastIndexOf('.')
  const ext = dotIdx >= 0 ? fullName.substring(dotIdx).toLowerCase() : ''
  const name = dotIdx >= 0 ? fullName.substring(0, dotIdx) : fullName
  const type = EXT_TYPE_MAP[ext]
  if (!type) return null
  return {
    id: `${fullName}-${Date.now()}`,
    name,
    path: filePath,
    type,
    extension: ext,
    size: 0,
    isImage: IMAGE_EXT.has(ext),
    isAudio: AUDIO_EXT.has(ext)
  }
}

export function PreviewPanel(): JSX.Element {
  const {
    channelA, channelB, liveChannel, selectedChannel, setSelectedChannel,
    setChannelFile, setChannelSlide, setChannelTotalSlides,
    isPresentationWindowOpen, setPresentationWindowOpen,
    setActiveFile, setCurrentSlide, setTotalSlides, setLiveChannel,
    pptxThumbnailsMap
  } = useAppStore()

  const handleClear = async (ch: 'A' | 'B'): Promise<void> => {
    const channel = ch === 'A' ? channelA : channelB
    // Reset saved slide position so next open starts from slide 1
    if (channel.file) {
      const { slidePositions } = useAppStore.getState()
      const newPositions = { ...slidePositions }
      delete newPositions[channel.file.path]
      useAppStore.setState({ slidePositions: newPositions })
    }
    // If this channel is live, close the presentation
    if (liveChannel === ch && channel.file) {
      if (channel.file.type === 'presentation') {
        await window.api.powerpointCommand('close')
      }
      if (channel.file.type === 'other' && channel.file.isAudio) {
        await window.api.musicStop()
      }
      if (channel.file.type === 'other' && !channel.file.isImage && !channel.file.isAudio) {
        await window.api.closeExternalFile(channel.file.path)
        // Restore taskbar that was hidden for Word/Excel
        await window.api.showTaskbar()
      }

      // Show backdrop if set, otherwise close presentation window
      const { backdropImage, selectedDisplayId } = useAppStore.getState()
      if (backdropImage) {
        if (!isPresentationWindowOpen) {
          await window.api.openPresentationWindow(selectedDisplayId ?? undefined)
          setPresentationWindowOpen(true)
          await new Promise((r) => setTimeout(r, 300))
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

      await window.api.restoreAudioDevice()
      setActiveFile(null)
      useAppStore.setState({ liveChannel: null })
    }
    setChannelFile(ch, null)
  }

  const handleTake = async (ch: 'A' | 'B'): Promise<void> => {
    // Always read fresh state from the store (not stale closure values)
    const freshState = useAppStore.getState()
    const channel = ch === 'A' ? freshState.channelA : freshState.channelB
    if (!channel.file) return

    // Save previous active file before overwriting
    const prevActiveFile = freshState.activeFile

    // Show overlay during transition
    await window.api.showOverlay()

    setActiveFile(channel.file)
    setLiveChannel(ch)

    // Minimize previously opened external file (Word/Excel) when switching to other content
    if (prevActiveFile?.type === 'other' && !prevActiveFile.isImage) {
      await window.api.minimizeExternalFile(prevActiveFile.path)
    }

    if (channel.file.type === 'presentation') {
      window.api.setActiveContentType('presentation')
      // Close Electron presentation window and switch audio in parallel
      const parallelTasks: Promise<unknown>[] = [window.api.switchAudioToExternal()]
      if (isPresentationWindowOpen && prevActiveFile?.type !== 'presentation') {
        parallelTasks.push(window.api.closePresentationWindow().then(() => setPresentationWindowOpen(false)))
      }
      await Promise.all(parallelTasks)

      const result = await window.api.launchPowerPoint(channel.file.path)
      if (result.success && result.output) {
        try {
          const data = JSON.parse(result.output)
          if (data.SlideCount) {
            setTotalSlides(data.SlideCount)
            setChannelTotalSlides(ch, data.SlideCount)
            if (channel.slide > 1) {
              await window.api.powerpointCommand('goto', channel.slide)
            }
            setCurrentSlide(channel.slide)
          }
        } catch { /* ignore */ }
      }
      // Generate thumbnails in background (fire-and-forget)
      window.api.generatePptxThumbnails(channel.file.path).then((thumbResult) => {
        if (thumbResult.success && thumbResult.thumbnails) {
          const { pptxThumbnailsMap } = useAppStore.getState()
          useAppStore.setState({ pptxThumbnailsMap: { ...pptxThumbnailsMap, [channel.file!.path]: thumbResult.thumbnails } })
        }
      })
      await window.api.hideOverlay()
      return
    }

    // PDF / Video / Other — close PowerPoint and switch audio in parallel
    const parallelTasks: Promise<unknown>[] = [window.api.switchAudioToExternal()]
    if (prevActiveFile?.type === 'presentation') {
      parallelTasks.push(window.api.powerpointCommand('close'))
    }
    await Promise.all(parallelTasks)

    // Audio files — play in built-in music player + show backdrop
    if (channel.file.type === 'other' && channel.file.isAudio) {
      const { backdropImage, selectedDisplayId } = useAppStore.getState()
      if (backdropImage) {
        if (!isPresentationWindowOpen) {
          await window.api.openPresentationWindow(selectedDisplayId ?? undefined)
          setPresentationWindowOpen(true)
          await new Promise((r) => setTimeout(r, 300))
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
      useAppStore.getState().setMusicPlaylist([channel.file.path])
      await window.api.musicSetPlaylist([channel.file.path], 0)
      await window.api.musicPlay()
      await window.api.hideOverlay()
      return
    }

    // For 'other' non-image files (Word, Excel, etc.), open/restore on external display
    if (channel.file.type === 'other' && !channel.file.isImage) {
      // Show backdrop on presentation window so it's visible when Word/Excel is minimized
      const { backdropImage, selectedDisplayId } = useAppStore.getState()
      if (backdropImage) {
        if (!isPresentationWindowOpen) {
          await window.api.openPresentationWindow(selectedDisplayId ?? undefined)
          setPresentationWindowOpen(true)
          await new Promise((r) => setTimeout(r, 300))
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
      const displays = await window.api.getDisplays()
      const external = displays.find((d) => !d.isPrimary)
      // Minimize previous other file (different file) — don't close
      if (prevActiveFile?.type === 'other' && !prevActiveFile.isImage && prevActiveFile.path !== channel.file.path) {
        await window.api.minimizeExternalFile(prevActiveFile.path)
      }
      // Hide taskbar FIRST, wait for Windows to update work area, then position window
      if (external) {
        await window.api.hideTaskbar(external.bounds)
        await new Promise((r) => setTimeout(r, 500))
      }
      // Try to restore; if not tracked yet, open fresh
      await window.api.restoreExternalFile(channel.file.path, external?.bounds)
      await window.api.hideOverlay()
      return
    }

    if (!isPresentationWindowOpen) {
      await window.api.openPresentationWindow()
      setPresentationWindowOpen(true)
      await new Promise((r) => setTimeout(r, 300))
    }

    window.api.sendToPresentation('load-content', {
      type: channel.file.type,
      path: channel.file.path,
      name: channel.file.name,
      startSlide: channel.slide,
      isImage: channel.file.isImage
    })

    await new Promise((r) => setTimeout(r, 150))
    await window.api.hideOverlay()
  }

  // Listen for take-channel events from Toolbar's Open Output button
  useEffect(() => {
    const handler = (e: Event): void => {
      const ch = (e as CustomEvent).detail as 'A' | 'B'
      handleTake(ch)
    }
    window.addEventListener('take-channel', handler)
    return () => window.removeEventListener('take-channel', handler)
  })

  return (
    <div className="flex-1 flex gap-2 overflow-hidden p-3">
      <ChannelPanel
        label="A"
        channel={channelA}
        isLive={liveChannel === 'A'}
        isSelected={selectedChannel === 'A'}
        onDrop={(file) => setChannelFile('A', file)}
        onSlideChange={(s) => setChannelSlide('A', s)}
        onSetTotalSlides={(t) => setChannelTotalSlides('A', t)}
        onSelect={() => setSelectedChannel('A')}
        onTake={() => handleTake('A')}
        onClear={() => handleClear('A')}
        pptxThumbnails={channelA.file ? pptxThumbnailsMap[channelA.file.path] || [] : []}
      />

      <ChannelPanel
        label="B"
        channel={channelB}
        isLive={liveChannel === 'B'}
        isSelected={selectedChannel === 'B'}
        onDrop={(file) => setChannelFile('B', file)}
        onSlideChange={(s) => setChannelSlide('B', s)}
        onSetTotalSlides={(t) => setChannelTotalSlides('B', t)}
        onSelect={() => setSelectedChannel('B')}
        onTake={() => handleTake('B')}
        onClear={() => handleClear('B')}
        pptxThumbnails={channelB.file ? pptxThumbnailsMap[channelB.file.path] || [] : []}
      />
    </div>
  )
}

interface ChannelPanelProps {
  label: string
  channel: ChannelState
  isLive: boolean
  isSelected: boolean
  onDrop: (file: FileEntry) => void
  onSlideChange: (slide: number) => void
  onSetTotalSlides: (total: number) => void
  onSelect: () => void
  onTake: () => void
  onClear: () => void
  pptxThumbnails: string[]
}

function ChannelPanel({
  label, channel, isLive, isSelected, onDrop, onSlideChange, onSetTotalSlides, onSelect, onTake, onClear, pptxThumbnails
}: ChannelPanelProps): JSX.Element {
  const [dragOver, setDragOver] = useState(false)

  const handleDragOver = (e: React.DragEvent): void => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDragOver(true)
  }

  const handleDragLeave = (): void => setDragOver(false)

  const handleDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)

    let file: FileEntry | null = null

    // Try internal drag first
    try {
      const jsonData = e.dataTransfer.getData('application/json')
      if (jsonData) {
        file = JSON.parse(jsonData) as FileEntry
      }
    } catch { /* ignore */ }

    // If no internal data, try native file drop from Windows Explorer
    if (!file && e.dataTransfer.files.length > 0) {
      const nativePath = window.api.getPathForFile(e.dataTransfer.files[0])
      if (nativePath) {
        file = nativeFileToEntry(nativePath)
      }
    }

    if (!file) return

    onDrop(file)
    // Pre-generate thumbnails for PPTX
    if (file.type === 'presentation') {
      const result = await window.api.generatePptxThumbnails(file.path)
      if (result.success && result.thumbnails) {
        const { pptxThumbnailsMap } = useAppStore.getState()
        useAppStore.setState({ pptxThumbnailsMap: { ...pptxThumbnailsMap, [file.path]: result.thumbnails } })
        if (result.slideCount) onSetTotalSlides(result.slideCount)
      }
    }
    if (isLive) {
      // Auto-take when dropping into the live channel
      setTimeout(() => onTake(), 50)
    }
  }

  const { isPresentationWindowOpen, activeFile: storeActiveFile } = useAppStore()
  const isOutputActive = (isPresentationWindowOpen && storeActiveFile !== null) || storeActiveFile?.type === 'presentation' || (storeActiveFile?.type === 'other' && !storeActiveFile.isImage)
  const showSelected = isSelected && !isOutputActive

  return (
    <div
      className={`flex-1 flex flex-col overflow-hidden rounded-lg border-2 transition-colors cursor-pointer ${
        dragOver ? 'border-accent bg-accent/5' :
        isLive ? 'border-red-500/60' :
        showSelected ? 'border-blue-500/60' : 'border-gray-700/50'
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={onSelect}
      onDoubleClick={onTake}
    >
      {/* Header */}
      <div className={`flex items-center gap-2 px-3 py-1.5 ${isLive ? 'bg-red-900/30' : showSelected ? 'bg-blue-900/20' : 'bg-surface-200'}`}>
        <span className={`w-2 h-2 rounded-full shrink-0 ${isLive ? 'bg-red-500 animate-pulse' : showSelected ? 'bg-blue-500' : 'bg-gray-600'}`} />
        <span className={`text-[10px] font-bold uppercase ${isLive ? 'text-red-400' : showSelected ? 'text-blue-400' : 'text-gray-500'}`}>
          Канал {label} {isLive ? '• В ЭФИРЕ' : showSelected ? '• ВЫБРАНО' : ''}
        </span>
        {channel.file && (
          <span className="text-[11px] text-gray-400 truncate ml-1">{channel.file.name}</span>
        )}
        {channel.file && (
          <button
            onClick={(e) => { e.stopPropagation(); onClear() }}
            onDoubleClick={(e) => e.stopPropagation()}
            className="ml-auto text-gray-500 hover:text-white text-sm leading-none px-1 rounded hover:bg-white/10 transition-colors"
            title="Убрать файл"
          >
            ✕
          </button>
        )}
      </div>

      {/* Preview area */}
      <div className="flex-1 flex items-center justify-center overflow-hidden bg-black/40">
        {channel.file ? (
          <SlideRenderer
            file={channel.file}
            slideNum={channel.slide}
            pptxThumbnails={pptxThumbnails}
            onTotalSlides={onSetTotalSlides}
          />
        ) : (
          <div className="text-gray-600 text-xs text-center select-none p-4">
            <div className="text-2xl mb-2 opacity-30">📥</div>
            Перетащите файл сюда
          </div>
        )}
      </div>

      {/* Navigation — only for non-live channel */}
      {!isLive && channel.file && (channel.file.type === 'pdf' || channel.file.type === 'presentation') && (
        <div
          className="flex items-center justify-center gap-3 py-1.5 bg-surface-200 border-t border-gray-800 relative"
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={(e) => { e.stopPropagation(); if (channel.slide > 1) onSlideChange(channel.slide - 1) }}
            onDoubleClick={(e) => e.stopPropagation()}
            className="btn-icon text-[10px]"
            disabled={channel.slide <= 1}
          >
            ◀
          </button>
          <span className="text-[10px] text-gray-400 tabular-nums min-w-[40px] text-center">
            {channel.slide}{channel.totalSlides > 0 ? ` / ${channel.totalSlides}` : ''}
          </span>
          <button
            onClick={(e) => { e.stopPropagation(); if (channel.totalSlides === 0 || channel.slide < channel.totalSlides) onSlideChange(channel.slide + 1) }}
            onDoubleClick={(e) => e.stopPropagation()}
            className="btn-icon text-[10px]"
            disabled={channel.totalSlides > 0 && channel.slide >= channel.totalSlides}
          >
            ▶
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onTake() }}
            onDoubleClick={(e) => e.stopPropagation()}
            className="absolute right-2 bg-red-600 hover:bg-red-500 text-white text-[9px] font-bold px-2 py-1 rounded transition-colors"
          >
            В эфир
          </button>
        </div>
      )}
      {/* Take button for video/other in non-live channel */}
      {!isLive && channel.file && (channel.file.type === 'video' || channel.file.type === 'other') && (
        <div
          className="flex items-center justify-end py-1.5 px-2 bg-surface-200 border-t border-gray-800"
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={(e) => { e.stopPropagation(); onTake() }}
            onDoubleClick={(e) => e.stopPropagation()}
            className="bg-red-600 hover:bg-red-500 text-white text-[9px] font-bold px-2 py-1 rounded transition-colors"
          >
            В эфир
          </button>
        </div>
      )}
    </div>
  )
}

function SlideRenderer({ file, slideNum, pptxThumbnails, onTotalSlides }: {
  file: FileEntry
  slideNum: number
  pptxThumbnails: string[]
  onTotalSlides: (total: number) => void
}): JSX.Element {
  if (file.type === 'pdf') return <PdfPreview file={file} currentSlide={slideNum} onTotalSlides={onTotalSlides} />
  if (file.type === 'presentation') return <PptxPreview file={file} currentSlide={slideNum} pptxThumbnails={pptxThumbnails} />
  if (file.type === 'video') return <VideoPreview file={file} />
  if (file.type === 'other') return <OtherPreview file={file} />
  return <div className="text-gray-500 text-xs">Unsupported</div>
}

function PdfPreview({ file, currentSlide, onTotalSlides }: {
  file: FileEntry; currentSlide: number; onTotalSlides: (t: number) => void
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [pdf, setPdf] = useState<pdfjsLib.PDFDocumentProxy | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load(): Promise<void> {
      try {
        const data = await window.api.readFile(file.path)
        const doc = await pdfjsLib.getDocument({ data }).promise
        if (!cancelled) {
          setPdf(doc)
          onTotalSlides(doc.numPages)
        }
      } catch (err) {
        console.error('Preview: Failed to load PDF:', err)
      }
    }
    load()
    return () => { cancelled = true }
  }, [file.path])

  const renderPage = useCallback(async (pageNum: number) => {
    if (!pdf || !canvasRef.current || !containerRef.current) return
    const page = await pdf.getPage(pageNum)
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const containerWidth = containerRef.current.clientWidth
    const containerHeight = containerRef.current.clientHeight
    const viewport = page.getViewport({ scale: 1 })
    const scale = Math.min(containerWidth / viewport.width, containerHeight / viewport.height)
    const scaledViewport = page.getViewport({ scale })

    canvas.width = scaledViewport.width
    canvas.height = scaledViewport.height

    await page.render({ canvasContext: ctx, viewport: scaledViewport }).promise
  }, [pdf])

  useEffect(() => {
    if (pdf && currentSlide >= 1 && currentSlide <= pdf.numPages) {
      renderPage(currentSlide)
    }
  }, [currentSlide, pdf, renderPage])

  return (
    <div ref={containerRef} className="w-full h-full flex items-center justify-center">
      <canvas ref={canvasRef} className="max-w-full max-h-full" />
    </div>
  )
}

function PptxPreview({ file, currentSlide, pptxThumbnails }: {
  file: FileEntry; currentSlide: number; pptxThumbnails: string[]
}): JSX.Element {
  const thumbPath = pptxThumbnails[currentSlide - 1]

  if (!thumbPath) {
    return (
      <div className="text-center text-gray-500 p-4">
        <div className="text-3xl mb-2">📊</div>
        <p className="text-[11px]">{file.name}</p>
        <p className="text-[10px] text-gray-600 mt-1">Двойной клик для запуска</p>
      </div>
    )
  }

  return (
    <div className="w-full h-full flex items-center justify-center">
      <img
        src={`file://${thumbPath}`}
        alt={`Slide ${currentSlide}`}
        className="max-w-full max-h-full object-contain"
      />
    </div>
  )
}

function VideoPreview({ file }: { file: FileEntry }): JSX.Element {
  return (
    <div className="w-full h-full flex items-center justify-center">
      <video
        src={`file://${file.path}`}
        className="max-w-full max-h-full rounded-lg"
        controls={false}
        muted
        preload="metadata"
        onLoadedMetadata={(e) => { e.currentTarget.currentTime = 1 }}
      />
    </div>
  )
}

const EXT_ICONS: Record<string, string> = {
  '.doc': '📝', '.docx': '📝', '.rtf': '📝', '.odt': '📝', '.txt': '📄',
  '.xls': '📊', '.xlsx': '📊', '.ods': '📊',
  '.mp3': '🎵', '.wav': '🎵', '.ogg': '🎵', '.aac': '🎵', '.m4a': '🎵', '.flac': '🎵', '.wma': '🎵'
}

const DOC_EXTENSIONS = ['.doc', '.docx', '.rtf', '.odt', '.txt', '.xls', '.xlsx', '.ods']

function OtherPreview({ file }: { file: FileEntry }): JSX.Element {
  if (file.isImage) {
    return (
      <div className="w-full h-full flex items-center justify-center">
        <img
          src={`file://${file.path}`}
          alt={file.name}
          className="max-w-full max-h-full object-contain"
        />
      </div>
    )
  }

  if (file.isAudio) {
    return (
      <div className="text-center text-gray-500 p-4">
        <div className="text-3xl mb-2">🎵</div>
        <p className="text-[11px]">{file.name}{file.extension}</p>
        <p className="text-[10px] text-gray-600 mt-1">Откроется во встроенном плеере</p>
      </div>
    )
  }

  if (DOC_EXTENSIONS.includes(file.extension)) {
    return <DocPreview file={file} />
  }

  const icon = EXT_ICONS[file.extension] || '📎'
  return (
    <div className="text-center text-gray-500 p-4">
      <div className="text-3xl mb-2">{icon}</div>
      <p className="text-[11px]">{file.name}{file.extension}</p>
      <p className="text-[10px] text-gray-600 mt-1">Откроется в системной программе</p>
    </div>
  )
}

function DocPreview({ file }: { file: FileEntry }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const { docPreviewsMap } = useAppStore()
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)

  // Generate preview PDF if not cached
  useEffect(() => {
    if (docPreviewsMap[file.path] || failed) return
    let cancelled = false
    setLoading(true)
    window.api.generateDocPreview(file.path).then((result) => {
      if (cancelled) return
      if (result.success && result.pdfPath) {
        const { docPreviewsMap: current } = useAppStore.getState()
        useAppStore.setState({ docPreviewsMap: { ...current, [file.path]: result.pdfPath } })
      } else {
        setFailed(true)
      }
      setLoading(false)
    }).catch(() => {
      if (!cancelled) { setFailed(true); setLoading(false) }
    })
    return () => { cancelled = true }
  }, [file.path, failed])

  // Render first page of preview PDF
  const pdfPath = docPreviewsMap[file.path]

  useEffect(() => {
    if (!pdfPath || !canvasRef.current || !containerRef.current) return
    let cancelled = false

    async function render(): Promise<void> {
      try {
        const data = await window.api.readFile(pdfPath!)
        const doc = await pdfjsLib.getDocument({ data }).promise
        const page = await doc.getPage(1)
        if (cancelled || !canvasRef.current || !containerRef.current) return

        const containerWidth = containerRef.current.clientWidth
        const containerHeight = containerRef.current.clientHeight
        const viewport = page.getViewport({ scale: 1 })
        const scale = Math.min(containerWidth / viewport.width, containerHeight / viewport.height)
        const scaledViewport = page.getViewport({ scale })

        canvasRef.current.width = scaledViewport.width
        canvasRef.current.height = scaledViewport.height

        const ctx = canvasRef.current.getContext('2d')
        if (ctx) {
          await page.render({ canvasContext: ctx, viewport: scaledViewport }).promise
        }
      } catch {
        if (!cancelled) setFailed(true)
      }
    }

    render()
    return () => { cancelled = true }
  }, [pdfPath])

  if (pdfPath) {
    return (
      <div ref={containerRef} className="w-full h-full flex items-center justify-center">
        <canvas ref={canvasRef} className="max-w-full max-h-full" />
      </div>
    )
  }

  const icon = EXT_ICONS[file.extension] || '📎'
  return (
    <div className="text-center text-gray-500 p-4">
      <div className="text-3xl mb-2">{icon}</div>
      <p className="text-[11px]">{file.name}{file.extension}</p>
      <p className="text-[10px] text-gray-600 mt-1">
        {loading ? <span className="animate-pulse">Генерация предпросмотра...</span> : 'Откроется в системной программе'}
      </p>
    </div>
  )
}
