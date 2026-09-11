import type { CSSProperties } from 'react'
import { mediaUrl } from '../../media'
import type { ProgramSceneBackgroundPayload } from '../../program-scene-background'
import { PdfViewer } from '../PresentationView/PdfViewer'

function requestIdFor(path: string, slide: number): number {
  let hash = slide || 1
  for (let index = 0; index < path.length; index++) {
    hash = ((hash * 31) + path.charCodeAt(index)) | 0
  }
  return Math.abs(hash) || 1
}

export function ProgramSceneBackgroundLayer({
  source,
  style
}: {
  source: ProgramSceneBackgroundPayload | null
  style?: CSSProperties
}): JSX.Element | null {
  if (!source || source.type === 'capture') return null
  return (
    <div
      data-program-scene-key-fill
      className="pointer-events-none absolute overflow-hidden bg-black"
      style={{ ...style, zIndex: 3 }}
    >
      {source.type === 'video' ? (
      <video
        key={source.path}
        data-program-scene-background="video"
        src={mediaUrl(source.path)}
        autoPlay
        playsInline
        loop={source.loop}
        muted={source.muted}
        className="absolute inset-0 h-full w-full bg-black object-cover"
      />
      ) : source.type === 'pdf' ? (
      <div data-program-scene-background="pdf" className="absolute inset-0 bg-black">
        <PdfViewer
          filePath={source.path}
          startSlide={source.slide}
          requestId={requestIdFor(source.path, source.slide)}
        />
      </div>
      ) : (
        <img
          key={source.path}
          data-program-scene-background="image"
          src={mediaUrl(source.path)}
          alt={source.name}
          className="absolute inset-0 h-full w-full select-none object-cover"
          draggable={false}
        />
      )}
    </div>
  )
}
