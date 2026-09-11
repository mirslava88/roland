import { useCallback, useEffect, useRef, useState } from 'react'
import {
  normalizeProgramSceneChromaKey,
  type ProgramSceneChromaKeyConfig
} from '../../../../shared/program-scene'
import { ChromaKeyRenderer, rgbToHex } from './chroma-key-renderer'

interface CaptureThumbnailProps {
  config: CaptureSourceConfig
  className?: string
  showName?: boolean
  fit?: 'contain' | 'cover'
  chromaKey?: ProgramSceneChromaKeyConfig
  colorPickerActive?: boolean
  onColorPick?: (color: string) => void
}

const STATUS_TEXT: Record<CaptureSourceState['status'], string> = {
  connecting: 'Подключение…',
  ready: 'Готово',
  muted: 'Нет сигнала',
  reconnecting: 'Переподключение…',
  error: 'Ошибка устройства',
  ended: 'Устройство отключено'
}

export function CaptureThumbnail({
  config,
  className = '',
  showName = false,
  fit = 'contain',
  chromaKey,
  colorPickerActive = false,
  onColorPick
}: CaptureThumbnailProps): JSX.Element {
  const deferredDesktop = config.captureKind === 'desktop' && !config.desktopSourceId
  const [frame, setFrame] = useState<string | null>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const chromaCanvasRef = useRef<HTMLCanvasElement>(null)
  const chromaRendererRef = useRef<ChromaKeyRenderer | null>(null)
  const [chromaReady, setChromaReady] = useState(false)
  const normalizedChromaKey = normalizeProgramSceneChromaKey(chromaKey)
  const chromaActive = config.captureKind === 'device' && normalizedChromaKey.enabled && !!frame
  const [state, setState] = useState<CaptureSourceState>({
    sourceId: config.sourceId,
    status: 'connecting',
    message: 'Подключение видеовхода…'
  })

  useEffect(() => {
    const register = (): void => {
      // A minimized native window intentionally has no Chromium source id yet.
      // Do not make the capture hub touch it until "В эфир" resolves the id.
      if (config.captureKind === 'desktop' && !config.desktopSourceId) return
      window.api.sendToPresentation('capture-source-register', config)
      window.api.sendToPresentation('capture-source-state-request', config.sourceId)
    }
    if (config.captureKind === 'desktop' && !config.desktopSourceId) {
      setFrame(null)
      setState({
        sourceId: config.sourceId,
        status: 'connecting',
        message: 'Окно подключится после нажатия «В эфир».'
      })
    }
    const unsubFrame = window.api.on('capture-preview-frame', (...args: unknown[]) => {
      const payload = args[0] as {
        sourceId?: string
        dataUrl?: string
        state?: CaptureSourceState
      }
      if (payload?.sourceId !== config.sourceId) return
      if (payload.dataUrl) setFrame(payload.dataUrl)
      if (payload.state) setState(payload.state)
    })
    const unsubState = window.api.on('capture-source-state', (...args: unknown[]) => {
      const payload = args[0] as CaptureSourceState
      if (payload?.sourceId === config.sourceId) setState(payload)
    })
    const unsubHubReady = window.api.on('capture-hub-ready', register)
    register()
    return () => {
      unsubFrame()
      unsubState()
      unsubHubReady()
    }
  }, [
    config.sourceId,
    config.captureKind,
    config.videoDeviceId,
    config.videoLabel,
    config.desktopSourceId,
    config.desktopSourceType,
    config.desktopDisplayId,
    config.audioEnabled,
    config.audioDeviceId,
    config.audioGroupId,
    config.audioLabel
  ])

  const renderChromaFrame = useCallback((): void => {
    if (!chromaActive) {
      chromaRendererRef.current?.dispose()
      chromaRendererRef.current = null
      setChromaReady(false)
      return
    }
    const image = imageRef.current
    const canvas = chromaCanvasRef.current
    if (!image?.complete || !image.naturalWidth || !canvas) return
    try {
      const renderer = chromaRendererRef.current ?? new ChromaKeyRenderer(canvas)
      chromaRendererRef.current = renderer
      setChromaReady(renderer.draw(image, normalizedChromaKey))
    } catch {
      setChromaReady(false)
    }
  }, [chromaActive, normalizedChromaKey.color, normalizedChromaKey.softness, normalizedChromaKey.spill, normalizedChromaKey.tolerance])

  useEffect(() => {
    renderChromaFrame()
  }, [frame, renderChromaFrame])

  useEffect(() => () => {
    chromaRendererRef.current?.dispose()
    chromaRendererRef.current = null
  }, [])

  const pickColor = (event: React.PointerEvent<HTMLButtonElement>): void => {
    const image = imageRef.current
    if (!image?.complete || !image.naturalWidth || !image.naturalHeight || !onColorPick) return
    const rect = event.currentTarget.getBoundingClientRect()
    const scale = fit === 'cover'
      ? Math.max(rect.width / image.naturalWidth, rect.height / image.naturalHeight)
      : Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight)
    const drawnWidth = image.naturalWidth * scale
    const drawnHeight = image.naturalHeight * scale
    const x = event.clientX - rect.left - (rect.width - drawnWidth) / 2
    const y = event.clientY - rect.top - (rect.height - drawnHeight) / 2
    if (x < 0 || y < 0 || x >= drawnWidth || y >= drawnHeight) return
    const sample = document.createElement('canvas')
    sample.width = 1
    sample.height = 1
    const context = sample.getContext('2d', { willReadFrequently: true })
    if (!context) return
    try {
      context.drawImage(image, x / scale, y / scale, 1, 1, 0, 0, 1, 1)
      const pixel = context.getImageData(0, 0, 1, 1).data
      onColorPick(rgbToHex(pixel[0], pixel[1], pixel[2]))
    } catch { /* a frame can disappear while the device reconnects */ }
  }

  const ready = state.status === 'ready'
  const warning = ready && !!state.message
  const showDesktopIcon = (
    config.captureKind === 'desktop' &&
    !!config.desktopAppIcon &&
    (
      deferredDesktop ||
      !frame ||
      state.status === 'muted' ||
      state.status === 'error' ||
      state.status === 'ended'
    )
  )

  return (
    <div className={`relative overflow-hidden flex items-center justify-center ${chromaActive && chromaReady ? 'bg-transparent' : 'bg-black'} ${className}`}>
      {!showDesktopIcon && !deferredDesktop && frame ? (
        <>
          <img
            ref={imageRef}
            src={frame}
            alt={`Превью: ${config.videoLabel}`}
            draggable={false}
            onLoad={renderChromaFrame}
            className={`w-full h-full select-none ${fit === 'cover' ? 'object-cover' : 'object-contain'} ${chromaActive && chromaReady ? 'opacity-0' : 'opacity-100'}`}
          />
          <canvas
            ref={chromaCanvasRef}
            data-chroma-key-canvas="preview"
            className={`pointer-events-none absolute inset-0 h-full w-full select-none ${fit === 'cover' ? 'object-cover' : 'object-contain'} ${chromaActive && chromaReady ? 'opacity-100' : 'opacity-0'}`}
          />
        </>
      ) : (
        <div className="flex flex-col items-center justify-center text-gray-500 select-none px-3 text-center">
          {showDesktopIcon ? (
            <img
              src={config.desktopAppIcon!}
              alt=""
              draggable={false}
              className="mb-1.5 h-10 w-10 object-contain"
            />
          ) : (
            <span className="text-3xl opacity-50 mb-1">📹</span>
          )}
          <span className="text-[10px]">
            {deferredDesktop ? 'Подключится при выходе в эфир' : STATUS_TEXT[state.status]}
          </span>
        </div>
      )}

      {colorPickerActive && frame && config.captureKind === 'device' && (
        <button
          type="button"
          aria-label="Выбрать цвет хромакея на изображении"
          data-chroma-key-picker-surface
          onPointerDown={pickColor}
          className="absolute inset-0 z-20 cursor-crosshair bg-transparent"
          title="Нажмите на цвет фона, который нужно убрать"
        >
          <span className="absolute left-1/2 top-2 -translate-x-1/2 whitespace-nowrap rounded bg-black/80 px-2 py-1 text-[9px] font-medium text-white shadow">
            Нажмите на цвет фона
          </span>
        </button>
      )}

      <div className="absolute left-2 bottom-2 right-2 flex items-end justify-between gap-2 pointer-events-none">
        {showName ? (
          <span className="min-w-0 truncate rounded-sm bg-black/70 px-1.5 py-0.5 text-[9px] text-gray-200">
            {config.videoLabel}
          </span>
        ) : <span />}
        {deferredDesktop ? (
          <span
            className="shrink-0 rounded-sm bg-gray-700/90 px-1.5 py-0.5 text-[9px] font-bold text-gray-200"
            title="Окно будет подключено после нажатия «В эфир»"
          >
            ГОТОВО К ЭФИРУ
          </span>
        ) : (!ready || warning) && (
          <span
            className={`shrink-0 rounded-sm px-1.5 py-0.5 text-[9px] font-bold ${
              warning
                ? 'bg-yellow-600/90 text-white'
                : state.status === 'connecting' || state.status === 'reconnecting'
                  ? 'bg-blue-600/90 text-white animate-pulse'
                  : 'bg-red-700/90 text-white'
            }`}
            title={state.message || STATUS_TEXT[state.status]}
          >
            {warning ? 'БЕЗ ЗВУКА' : STATUS_TEXT[state.status]}
          </span>
        )}
      </div>
    </div>
  )
}
