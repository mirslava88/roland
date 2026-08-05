import { useEffect, useState } from 'react'

interface CaptureThumbnailProps {
  config: CaptureSourceConfig
  className?: string
  showName?: boolean
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
  showName = false
}: CaptureThumbnailProps): JSX.Element {
  const deferredDesktop = config.captureKind === 'desktop' && !config.desktopSourceId
  const [frame, setFrame] = useState<string | null>(null)
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
    config.audioDeviceId
  ])

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
    <div className={`relative overflow-hidden bg-black flex items-center justify-center ${className}`}>
      {!showDesktopIcon && !deferredDesktop && frame ? (
        <img
          src={frame}
          alt={`Превью: ${config.videoLabel}`}
          draggable={false}
          className="w-full h-full object-contain select-none"
        />
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
