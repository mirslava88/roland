import { useState, useEffect, useCallback } from 'react'
import { PdfViewer } from './components/PresentationView/PdfViewer'
import { VideoViewer } from './components/PresentationView/VideoViewer'

interface ContentPayload {
  type: 'presentation' | 'pdf' | 'video' | 'backdrop'
  path: string
  name: string
  startSlide?: number
}

export function PresentationApp(): JSX.Element {
  const [content, setContent] = useState<ContentPayload | null>(null)
  const [isTransitioning, setIsTransitioning] = useState(false)
  const [opacity, setOpacity] = useState(1)

  const loadContent = useCallback((payload: ContentPayload) => {
    setIsTransitioning(true)
    setOpacity(0)

    setTimeout(() => {
      setContent(payload)
      setTimeout(() => {
        setOpacity(1)
        setIsTransitioning(false)
      }, 50)
    }, 300)
  }, [])

  useEffect(() => {
    const unsubLoad = window.api.on('load-content', (...args: unknown[]) => {
      loadContent(args[0] as ContentPayload)
    })

    const unsubStop = window.api.on('stop', () => {
      setContent(null)
    })

    // Signal to main process that this window is ready to receive content
    window.api.signalReady()

    return () => {
      unsubLoad()
      unsubStop()
    }
  }, [loadContent])

  return (
    <div
      className="w-screen h-screen bg-black flex items-center justify-center overflow-hidden"
      style={{
        opacity,
        transition: 'opacity 300ms ease-in-out'
      }}
    >
      {!content && (
        <div className="text-gray-700 text-lg select-none">
          Waiting for content...
        </div>
      )}

      {content?.type === 'pdf' && <PdfViewer filePath={content.path} startSlide={content.startSlide} />}
      {content?.type === 'video' && <VideoViewer filePath={content.path} />}
      {content?.type === 'backdrop' && (
        <img
          src={`file://${content.path}`}
          alt="Backdrop"
          className="w-full h-full object-cover select-none"
          draggable={false}
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
