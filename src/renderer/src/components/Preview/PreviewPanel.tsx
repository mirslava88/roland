import { useEffect, useRef, useCallback, useState } from 'react'
import { useAppStore, ChannelState } from '../../stores/useAppStore'
import * as pdfjsLib from 'pdfjs-dist'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url
).toString()

export function PreviewPanel(): JSX.Element {
  const {
    channelA, channelB, liveChannel, selectedChannel, setSelectedChannel,
    setChannelFile, setChannelSlide, setChannelTotalSlides,
    isPresentationWindowOpen, setPresentationWindowOpen,
    setActiveFile, setCurrentSlide, setTotalSlides, setLiveChannel,
    pptxThumbnailsMap
  } = useAppStore()

  const handleTake = async (ch: 'A' | 'B'): Promise<void> => {
    const channel = ch === 'A' ? channelA : channelB
    if (!channel.file) return

    // Save previous active file before overwriting
    const prevActiveFile = useAppStore.getState().activeFile

    // Show overlay during transition
    await window.api.showOverlay()

    setActiveFile(channel.file)
    setLiveChannel(ch)

    if (channel.file.type === 'presentation') {
      // Close Electron presentation window only if it was open for PDF/video
      if (isPresentationWindowOpen && prevActiveFile?.type !== 'presentation') {
        await window.api.closePresentationWindow()
        setPresentationWindowOpen(false)
      }
      // Switch audio to external display
      await window.api.switchAudioToExternal()
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
      // Generate thumbnails for channel preview
      const thumbResult = await window.api.generatePptxThumbnails(channel.file.path)
      if (thumbResult.success && thumbResult.thumbnails) {
        const { pptxThumbnailsMap } = useAppStore.getState()
        useAppStore.setState({ pptxThumbnailsMap: { ...pptxThumbnailsMap, [channel.file.path]: thumbResult.thumbnails } })
      }
      await window.api.hideOverlay()
      return
    }

    // PDF / Video — close PowerPoint if it was previously active
    if (prevActiveFile?.type === 'presentation') {
      await window.api.powerpointCommand('close')
    }

    // Switch audio to external display
    await window.api.switchAudioToExternal()

    if (!isPresentationWindowOpen) {
      await window.api.openPresentationWindow()
      setPresentationWindowOpen(true)
      await new Promise((r) => setTimeout(r, 500))
    }

    window.api.sendToPresentation('load-content', {
      type: channel.file.type,
      path: channel.file.path,
      name: channel.file.name,
      startSlide: channel.slide
    })

    await new Promise((r) => setTimeout(r, 300))
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
  pptxThumbnails: string[]
}

function ChannelPanel({
  label, channel, isLive, isSelected, onDrop, onSlideChange, onSetTotalSlides, onSelect, onTake, pptxThumbnails
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
    setDragOver(false)
    try {
      const file = JSON.parse(e.dataTransfer.getData('application/json')) as FileEntry
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
    } catch { /* ignore */ }
  }

  const { isPresentationWindowOpen, activeFile: storeActiveFile } = useAppStore()
  const isOutputActive = (isPresentationWindowOpen && storeActiveFile !== null) || storeActiveFile?.type === 'presentation'
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
