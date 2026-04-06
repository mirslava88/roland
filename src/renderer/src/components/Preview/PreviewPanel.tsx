import { useAppStore } from '../../stores/useAppStore'

export function PreviewPanel(): JSX.Element {
  const { selectedFile, activeFile } = useAppStore()
  const file = selectedFile || activeFile

  if (!file) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-600">
        <div className="text-center">
          <div className="text-5xl mb-4 opacity-30">🖥️</div>
          <p className="text-sm">Select a file to preview</p>
          <p className="text-xs mt-1 text-gray-700">Double-click to show on output display</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden p-4">
      <div className="flex items-center gap-3 mb-3">
        <h2 className="text-sm font-semibold text-gray-200 truncate">{file.name}</h2>
        <span className="text-[10px] px-2 py-0.5 rounded-full bg-surface-100 text-gray-400 uppercase font-semibold shrink-0">
          {file.extension.replace('.', '')}
        </span>
        {activeFile?.id === file.id && (
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-green-900/50 text-green-400 font-medium shrink-0">
            LIVE
          </span>
        )}
      </div>

      <div className="flex-1 panel flex items-center justify-center overflow-hidden">
        {file.type === 'pdf' && <PdfPreview file={file} />}
        {file.type === 'video' && <VideoPreview file={file} />}
        {file.type === 'presentation' && <PresentationPreview file={file} />}
      </div>
    </div>
  )
}

function PdfPreview({ file }: { file: FileEntry }): JSX.Element {
  return (
    <div className="text-center text-gray-400 p-8">
      <div className="text-4xl mb-3">📄</div>
      <p className="text-sm font-medium">{file.name}</p>
      <p className="text-xs text-gray-500 mt-1">PDF — Double-click in library to display</p>
    </div>
  )
}

function VideoPreview({ file }: { file: FileEntry }): JSX.Element {
  return (
    <div className="w-full h-full flex items-center justify-center p-4">
      <video
        src={`file://${file.path}`}
        className="max-w-full max-h-full rounded-lg"
        controls={false}
        muted
        preload="metadata"
        onLoadedMetadata={(e) => {
          const video = e.currentTarget
          video.currentTime = 1
        }}
      />
    </div>
  )
}

function PresentationPreview({ file }: { file: FileEntry }): JSX.Element {
  return (
    <div className="text-center text-gray-400 p-8">
      <div className="text-4xl mb-3">📊</div>
      <p className="text-sm font-medium">{file.name}</p>
      <p className="text-xs text-gray-500 mt-1">
        PowerPoint — Uses native PowerPoint for display
      </p>
      <p className="text-xs text-gray-600 mt-0.5">
        Animations, transitions, and embedded video preserved
      </p>
    </div>
  )
}
