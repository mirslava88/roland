import { useState, useEffect, useCallback, useRef } from 'react'
import { mediaUrl } from './media'
import { PdfViewer } from './components/PresentationView/PdfViewer'
import { VideoViewer } from './components/PresentationView/VideoViewer'

interface ContentPayload {
  type: 'presentation' | 'pdf' | 'video' | 'backdrop' | 'other'
  path: string
  name: string
  startSlide?: number
  isImage?: boolean
}

export function PresentationApp(): JSX.Element {
  const [content, setContent] = useState<ContentPayload | null>(null)
  const contentRef = useRef<ContentPayload | null>(null)

  // Keep ref in sync with state
  contentRef.current = content

  // Content swap is instant — the overlay (screen-saver level, managed from
  // the control window) is what masks the switch. A local fade here just
  // creates a visible black period between the old and new content: the
  // overlay is hidden as soon as content-ready fires, but if we were also
  // mid-fade the audience would see the presentation window blink through
  // black. No fade → overlay fully owns the transition.
  const loadContent = useCallback((payload: ContentPayload) => {
    window.api.dbgLog(`PresApp: setContent type=${payload.type} path=${payload.path.split(/[\\\\/]/).pop()} startSlide=${payload.startSlide ?? '-'}`)
    setContent(payload)
  }, [])

  useEffect(() => {
    const unsubLoad = window.api.on('load-content', (...args: unknown[]) => {
      const p = args[0] as ContentPayload
      window.api.dbgLog(`PresApp: load-content received type=${p.type}`)
      loadContent(p)
    })

    const unsubStop = window.api.on('stop', () => {
      // For video, don't clear content — VideoViewer handles pause+rewind
      if (contentRef.current?.type !== 'video') {
        setContent(null)
      }
    })

    // Signal to main process that this window is ready to receive content
    window.api.signalReady()

    return () => {
      unsubLoad()
      unsubStop()
    }
  }, [loadContent])

  const signalContentReady = (): void => {
    // img.onLoad fires after decode but BEFORE the new pixels are composited
    // to the screen — ~1 frame of latency. Defer the ready signal by two
    // rAFs so the overlay fade starts against a fully-painted presentation
    // window; otherwise the audience sees a brief cross-fade between old
    // and new content through the still-translucent overlay.
    window.api.dbgLog('PresApp: onLoad fired, scheduling 2xrAF → content-ready')
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        window.api.dbgLog('PresApp: sendToControl(presentation-content-ready)')
        window.api.sendToControl('presentation-content-ready')
      })
    })
  }

  return (
    <div className="w-screen h-screen bg-black flex items-center justify-center overflow-hidden">
      {!content && (
        <div className="text-gray-700 text-lg select-none">
          Waiting for content...
        </div>
      )}

      {content?.type === 'pdf' && <PdfViewer filePath={content.path} startSlide={content.startSlide} />}
      {content?.type === 'video' && <VideoViewer filePath={content.path} />}
      {content?.type === 'backdrop' && (
        <img
          src={mediaUrl(content.path)}
          alt="Backdrop"
          className="w-full h-full object-cover select-none"
          draggable={false}
          onLoad={signalContentReady}
        />
      )}
      {content?.type === 'other' && content.isImage && (
        <img
          src={mediaUrl(content.path)}
          alt={content.name}
          className="w-full h-full object-contain select-none"
          draggable={false}
          onLoad={signalContentReady}
        />
      )}
      {content?.type === 'presentation' && (
        <div className="text-gray-500 text-center select-none">
          <p className="text-lg mb-2">PowerPoint Presentation Active</p>
          <p className="text-sm text-gray-600">{content.name}</p>
          <p className="text-xs text-gray-700 mt-2">
            Managed by native PowerPoint application
          </p>
        </div>
      )}
    </div>
  )
}
