import { normalizeProgramSceneBackground } from '../../shared/program-scene'

export type ProgramSceneBackgroundPayload =
  | {
      type: 'image' | 'video' | 'pdf'
      path: string
      name: string
      slide: number
      loop: boolean
      muted: boolean
    }
  | {
      type: 'capture'
      path: string
      name: string
      slide: number
      loop: boolean
      muted: boolean
      capture: CaptureSourceConfig
    }

interface ProgramSceneBackgroundState {
  programScene: {
    background: unknown
  }
  channels: Record<string, { file: FileEntry | null; slide: number }>
  pptxSlidesMap: Record<string, string[]>
  pptxThumbnailsMap: Record<string, string[]>
}

export function isProgramSceneBackgroundChannelSupported(file?: FileEntry | null): boolean {
  return !!file && (
    file.type === 'presentation' ||
    file.type === 'pdf' ||
    file.type === 'video' ||
    (file.type === 'other' && file.isImage === true) ||
    (file.type === 'capture' && !!file.capture)
  )
}

export function resolveProgramSceneBackground(state: ProgramSceneBackgroundState): ProgramSceneBackgroundPayload | null {
  const config = normalizeProgramSceneBackground(state.programScene.background)
  if (config.kind === 'image') {
    return config.imagePath
      ? {
          type: 'image',
          path: config.imagePath,
          name: 'Заполнение хромакея',
          slide: 1,
          loop: config.loop,
          muted: config.muted
        }
      : null
  }
  if (config.kind === 'video') {
    return config.videoPath
      ? {
          type: 'video',
          path: config.videoPath,
          name: 'Фоновое видео',
          slide: 1,
          loop: config.loop,
          muted: config.muted
        }
      : null
  }

  const channel = config.channelId ? state.channels[config.channelId] : null
  const file = channel?.file
  if (!channel || !isProgramSceneBackgroundChannelSupported(file) || !file) return null
  const common = {
    path: file.path,
    name: file.name,
    slide: Math.max(1, channel.slide || 1),
    loop: config.loop,
    muted: config.muted
  }
  if (file.type === 'capture' && file.capture) {
    return { ...common, type: 'capture', capture: file.capture }
  }
  if (file.type === 'presentation') {
    const frames = state.pptxSlidesMap[file.path] || state.pptxThumbnailsMap[file.path] || []
    const framePath = frames[Math.min(frames.length - 1, common.slide - 1)]
    return framePath ? { ...common, type: 'image', path: framePath } : null
  }
  if (file.type === 'pdf') return { ...common, type: 'pdf' }
  if (file.type === 'video') return { ...common, type: 'video' }
  if (file.type === 'other' && file.isImage) return { ...common, type: 'image' }
  return null
}
