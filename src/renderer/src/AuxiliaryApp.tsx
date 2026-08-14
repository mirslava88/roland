import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { mediaUrl } from './media'
import { renderPdfiumPageToCanvas } from './pdfium-renderer'
import { EventTimerScene } from './components/EventTimer/EventTimerScene'
import { BroadcastTitlesOverlay } from './components/BroadcastTitles/BroadcastTitlesOverlay'

const requestedRole = new URLSearchParams(window.location.search).get('role')
const requestedDisplayId = Number(new URLSearchParams(window.location.search).get('displayId'))
const auxiliaryDisplayId = Number.isFinite(requestedDisplayId) ? requestedDisplayId : null
const MIRROR_PDF_SAFE_WIDTH_RATIO = 0.96
const MIRROR_PDF_MAX_HORIZONTAL_STRETCH = 1.08
const PROGRAM_MIRROR_CONNECTING_STATUS = 'Подключение к основному эфиру…'
const PROGRAM_MIRROR_FRAME_TIMEOUT_MS = 5_000
const PROGRAM_MIRROR_MAX_RETRIES = 4
const role: AuxiliaryDisplayRole = requestedRole === 'mirror' ||
  requestedRole === 'info' ||
  requestedRole === 'timer' ||
  requestedRole === 'event-timer' ||
  requestedRole === 'backdrop'
  ? requestedRole
  : 'speaker'

function captureVideoFrame(video: HTMLVideoElement): string | null {
  if (
    video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
    video.videoWidth < 1 ||
    video.videoHeight < 1
  ) return null
  try {
    const scale = Math.min(1, 1920 / video.videoWidth, 1080 / video.videoHeight)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(2, Math.round(video.videoWidth * scale))
    canvas.height = Math.max(2, Math.round(video.videoHeight * scale))
    const context = canvas.getContext('2d')
    if (!context) return null
    context.drawImage(video, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/jpeg', 0.9)
  } catch {
    return null
  }
}

function playAndWaitForVideoFrame(
  video: HTMLVideoElement,
  timeoutMs = PROGRAM_MIRROR_FRAME_TIMEOUT_MS
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    let videoFrameHandle: number | null = null
    let firstAnimationFrame: number | null = null
    let secondAnimationFrame: number | null = null
    let staticFrameFallback: ReturnType<typeof setTimeout> | null = null

    const cleanup = (): void => {
      clearTimeout(timeout)
      video.removeEventListener('loadeddata', requestFrame)
      if (videoFrameHandle !== null && typeof video.cancelVideoFrameCallback === 'function') {
        video.cancelVideoFrameCallback(videoFrameHandle)
      }
      if (firstAnimationFrame !== null) cancelAnimationFrame(firstAnimationFrame)
      if (secondAnimationFrame !== null) cancelAnimationFrame(secondAnimationFrame)
      if (staticFrameFallback) clearTimeout(staticFrameFallback)
    }
    const finish = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const requestFrame = (): void => {
      if (settled) return
      if (typeof video.requestVideoFrameCallback === 'function') {
        videoFrameHandle = video.requestVideoFrameCallback(() => finish())
        // A static PowerPoint slide may not produce another damage frame even
        // though HAVE_CURRENT_DATA already contains the first painted frame.
        staticFrameFallback = setTimeout(() => {
          if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) finish()
        }, 250)
        return
      }
      firstAnimationFrame = requestAnimationFrame(() => {
        secondAnimationFrame = requestAnimationFrame(() => finish())
      })
    }
    const timeout = setTimeout(() => {
      fail(new Error('Timeout waiting for the first program mirror frame'))
    }, timeoutMs)

    void video.play().then(() => {
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) requestFrame()
      else video.addEventListener('loadeddata', requestFrame, { once: true })
    }).catch(fail)
  })
}

function formatTime(totalSeconds: number): string {
  const negative = totalSeconds < 0
  const absolute = Math.abs(totalSeconds)
  const hours = Math.floor(absolute / 3600)
  const minutes = Math.floor((absolute % 3600) / 60)
  const seconds = absolute % 60
  const pad = (value: number): string => value.toString().padStart(2, '0')
  const value = hours > 0
    ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`
  return negative ? `-${value}` : value
}

function SpeakerPdfFrame({
  filePath,
  page,
  compact = false,
  maxRenderWidth = 2560,
  maxRenderHeight = 1600,
  adaptiveMirrorWidth = false,
  imageStyle,
  onReady
}: {
  filePath: string
  page: number | null
  compact?: boolean
  maxRenderWidth?: number
  maxRenderHeight?: number
  adaptiveMirrorWidth?: boolean
  imageStyle?: CSSProperties
  onReady?: () => void
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [frameUrl, setFrameUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady

  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const update = (): void => setSize({
      width: element.clientWidth,
      height: element.clientHeight
    })
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    setFrameUrl(null)
    setFailed(false)
  }, [filePath])

  useEffect(() => {
    if (page === null || size.width < 1 || size.height < 1) return
    let cancelled = false
    const render = async (): Promise<void> => {
      const dpr = window.devicePixelRatio || 1
      const targetWidth = Math.min(maxRenderWidth, Math.max(640, Math.round(size.width * dpr)))
      const targetHeight = Math.min(maxRenderHeight, Math.max(360, Math.round(size.height * dpr)))
      try {
        const nativePath = await window.api.renderPdfPage(filePath, page - 1, targetWidth)
        if (cancelled) return
        if (nativePath) {
          setFrameUrl(mediaUrl(nativePath))
          setFailed(false)
          return
        }
        const frame = await renderPdfiumPageToCanvas({
          filePath,
          pageNumber: page,
          targetWidth,
          targetHeight,
          lane: 'background'
        })
        if (cancelled) return
        setFrameUrl(frame.canvas.toDataURL('image/png'))
        setFailed(false)
      } catch (error) {
        if (!cancelled) {
          setFailed(true)
          window.api.dbgLog(`speaker PDF render failed page=${page}: ${String(error)}`)
        }
      }
    }
    void render()
    return () => { cancelled = true }
  }, [filePath, maxRenderHeight, maxRenderWidth, page, size.width, size.height])

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden bg-black flex items-center justify-center">
      {page === null ? (
        <div className="text-center text-gray-400">
          <div className={compact ? 'text-2xl' : 'text-4xl'}>Конец презентации</div>
        </div>
      ) : frameUrl ? (
        <img
          src={frameUrl}
          className="h-full w-full object-contain"
          style={imageStyle}
          draggable={false}
          onLoad={(event) => {
            if (adaptiveMirrorWidth) {
              const image = event.currentTarget
              const container = containerRef.current
              if (container && image.naturalWidth > 0 && image.naturalHeight > 0) {
                const imageAspect = image.naturalWidth / image.naturalHeight
                const containerAspect = container.clientWidth / Math.max(1, container.clientHeight)
                // object-contain already fits the PDF. Stretch narrow pages a
                // little, but shrink wide pages enough to preserve both edges
                // on mirror displays with overscan or a different aspect ratio.
                const fittedWidthRatio = Math.min(1, imageAspect / Math.max(0.01, containerAspect))
                const scaleX = Math.min(
                  MIRROR_PDF_MAX_HORIZONTAL_STRETCH,
                  MIRROR_PDF_SAFE_WIDTH_RATIO / Math.max(0.01, fittedWidthRatio)
                )
                image.style.transform = `scaleX(${scaleX.toFixed(4)})`
                image.style.transformOrigin = 'center center'
                window.api.dbgLog(
                  `program mirror PDF fit image=${image.naturalWidth}x${image.naturalHeight} ` +
                  `container=${container.clientWidth}x${container.clientHeight} scaleX=${scaleX.toFixed(4)}`
                )
              }
            }
            onReadyRef.current?.()
          }}
        />
      ) : (
        <div className="text-lg text-gray-400">{failed ? 'Не удалось подготовить слайд' : 'Подготовка слайда…'}</div>
      )}
    </div>
  )
}

function SpeakerImageFrame({ path, isEnd = false }: { path?: string | null; isEnd?: boolean }): JSX.Element {
  if (isEnd) {
    return (
      <div className="h-full w-full bg-black flex items-center justify-center text-3xl text-gray-400">
        Конец презентации
      </div>
    )
  }
  if (!path) {
    return (
      <div className="h-full w-full bg-black flex items-center justify-center text-lg text-gray-400">
        Подготовка слайда…
      </div>
    )
  }
  return <img src={mediaUrl(path)} className="h-full w-full object-contain bg-black" draggable={false} />
}

function SpeakerDisplay(): JSX.Element {
  const [state, setState] = useState<SpeakerDisplayState>({
    active: false,
    fileType: null,
    filePath: null,
    fileName: '',
    currentSlide: 1,
    totalSlides: 0,
    notes: '',
    backdropImage: null
  })

  useEffect(() => window.api.on('speaker-state', (...args: unknown[]) => {
    setState(args[0] as SpeakerDisplayState)
  }), [])

  if (!state.active || !state.filePath || !state.fileType) {
    if (state.backdropImage) {
      return (
        <div
          className="h-screen w-screen bg-black bg-cover bg-center bg-no-repeat select-none"
          style={{ backgroundImage: `url("${mediaUrl(state.backdropImage)}")` }}
        />
      )
    }
    return (
      <div className="h-screen w-screen bg-black flex flex-col items-center justify-center text-gray-400 select-none">
        <div className="text-4xl mb-3">Суфлёр</div>
        <div className="text-xl">Ожидание презентации</div>
      </div>
    )
  }

  const nextSlide = state.currentSlide < state.totalSlides ? state.currentSlide + 1 : null
  const isPdf = state.fileType === 'pdf'

  return (
    <div
      className={`h-screen w-screen bg-[#090b10] text-white p-5 grid grid-cols-[minmax(0,2fr)_minmax(300px,1fr)] gap-4 select-none ${
        isPdf
          ? 'grid-rows-[minmax(0,1fr)]'
          : 'grid-rows-[minmax(0,1fr)_minmax(150px,0.34fr)]'
      }`}
    >
      <section className="min-w-0 min-h-0 rounded-xl border border-gray-700 bg-black overflow-hidden shadow-2xl">
        {isPdf ? (
          <SpeakerPdfFrame filePath={state.filePath} page={state.currentSlide} />
        ) : (
          <SpeakerImageFrame path={state.currentImagePath} />
        )}
      </section>

      <aside className="min-w-0 min-h-0 flex flex-col gap-3">
        <div className="text-sm uppercase tracking-[0.18em] text-gray-400">Следующий слайд</div>
        <div className="flex-1 min-h-0 rounded-xl border border-gray-700 bg-black overflow-hidden">
          {isPdf ? (
            <SpeakerPdfFrame filePath={state.filePath} page={nextSlide} compact />
          ) : (
            <SpeakerImageFrame path={state.nextImagePath} isEnd={nextSlide === null} />
          )}
        </div>
        <div className="rounded-lg bg-gray-900 border border-gray-700 px-4 py-3 flex items-center justify-between gap-4">
          <span className="truncate text-lg">{state.fileName}</span>
          <span className="shrink-0 text-2xl tabular-nums font-semibold">
            {state.currentSlide} / {state.totalSlides || '—'}
          </span>
        </div>
      </aside>

      {!isPdf && (
        <section className="col-span-2 min-h-0 rounded-xl border border-gray-700 bg-gray-900/80 px-5 py-4 overflow-hidden">
          <div className="text-xs uppercase tracking-[0.18em] text-gray-400 mb-2">Заметки докладчика</div>
          <div className="h-[calc(100%-24px)] overflow-hidden whitespace-pre-wrap text-[clamp(18px,2vw,34px)] leading-snug text-gray-100">
            {state.notes?.trim() || 'Заметок к этому слайду нет'}
          </div>
        </section>
      )}
    </div>
  )
}

function TimerValue({ timer }: { timer: TimerDisplayState }): JSX.Element {
  const color = timer.remaining < 0
    ? timer.overtimeTextColor
    : timer.remaining <= 60 && timer.running
      ? timer.warningTextColor
      : timer.textColor
  return (
    <div
      className="font-mono font-black tabular-nums leading-none tracking-tight"
      style={{ color, opacity: timer.textOpacity }}
    >
      {formatTime(timer.remaining)}
    </div>
  )
}

interface ProgramTimerOverlayState extends TimerDisplayState {
  visible: boolean
  x: number
  y: number
  scale: number
}

const EMPTY_PROGRAM_TIMER: ProgramTimerOverlayState = {
  visible: false,
  remaining: 0,
  running: false,
  duration: 0,
  textColor: '#ffffff',
  warningTextColor: '#facc15',
  overtimeTextColor: '#ef4444',
  textOpacity: 1,
  x: 0.976,
  y: 0.96,
  scale: 1
}

function ProgramTimerOverlay({
  timer,
  sourceDipHeight
}: {
  timer: ProgramTimerOverlayState
  sourceDipHeight: number | null
}): JSX.Element | null {
  if (!timer.visible || timer.duration <= 0) return null
  const color = timer.remaining < 0
    ? timer.overtimeTextColor
    : timer.remaining <= 60 && timer.remaining >= 0 && timer.running
      ? timer.warningTextColor
      : timer.textColor
  const background = timer.remaining < 0
    ? 'rgba(60, 0, 0, 0.71)'
    : timer.remaining <= 60 && timer.remaining >= 0 && timer.running
      ? 'rgba(60, 20, 0, 0.63)'
      : 'rgba(0, 0, 0, 0.5)'
  const sourceHeight = Math.max(1, sourceDipHeight || 1080)
  const fontVh = 100 * 48 * timer.scale / sourceHeight
  const horizontalPaddingVh = 100 * 24 * timer.scale / sourceHeight
  const verticalPaddingVh = 100 * 8 * timer.scale / sourceHeight
  const radiusVh = 100 * 10 * timer.scale / sourceHeight
  const x = Math.max(0, Math.min(1, timer.x))
  const y = Math.max(0, Math.min(1, timer.y))
  return (
    <div
      className="absolute z-30 select-none whitespace-nowrap font-mono font-black tabular-nums leading-none tracking-tight"
      style={{
        left: `${x * 100}%`,
        top: `${y * 100}%`,
        transform: `translate(-${x * 100}%, -${y * 100}%)`,
        color,
        background,
        fontSize: `${fontVh}vh`,
        padding: `${verticalPaddingVh}vh ${horizontalPaddingVh}vh`,
        borderRadius: `${radiusVh}vh`,
        textShadow: '0 2px 8px rgba(0,0,0,0.8)'
      }}
    >
      <span style={{ opacity: timer.textOpacity }}>{formatTime(timer.remaining)}</span>
    </div>
  )
}

function EventTimerDisplay(): JSX.Element {
  const [timer, setTimer] = useState<EventTimerDisplayState>({
    eventName: 'Оперативное совещание',
    headings: {
      current: 'Текущее время:',
      timer: 'Таймер:',
      'to-start': 'До начала мероприятия:',
      'to-end': 'До конца мероприятия:'
    },
    startTime: '14:30',
    endTime: '16:00',
    costPerMinute: 0,
    overtimeCostTotal: 0,
    backgroundMode: 'gradient',
    backgroundColor: '#18c56e',
    backgroundGradientColor: '#19b9d1',
    backgroundGradientAngle: 115,
    fontColor: '#ffffff',
    backgroundImage: null,
    centralTimeMode: 'to-end',
    visibility: {
      clock: true,
      schedule: true,
      heading: true,
      eventName: true,
      remaining: true,
      cost: true
    },
    duration: 90 * 60,
    remaining: 90 * 60,
    running: false,
    live: false,
    fallbackBackdropImage: null
  })

  useEffect(() => {
    const unsubscribe = window.api.on('event-timer-state', (...args: unknown[]) => {
      const next = args[0] as EventTimerDisplayState
      setTimer((previous) => {
        if (previous.live !== next.live) {
          window.api.dbgLog(`event timer display state live=${next.live} display=${auxiliaryDisplayId ?? 'unknown'}`)
        }
        return next
      })
    })
    window.api.dbgLog(`event timer display ready display=${auxiliaryDisplayId ?? 'unknown'}`)
    window.api.sendToControl('event-timer-ready', { displayId: auxiliaryDisplayId })
    return unsubscribe
  }, [])

  return timer.live
    ? (
        <div className="h-screen w-screen overflow-hidden bg-black">
          <EventTimerScene timer={timer} />
        </div>
      )
    : (
        <div className="relative h-screen w-screen overflow-hidden bg-black select-none">
          {timer.fallbackBackdropImage && (
            <img
              src={mediaUrl(timer.fallbackBackdropImage)}
              className="absolute inset-0 h-full w-full object-cover"
              draggable={false}
            />
          )}
        </div>
      )
}

function InformationVideo({
  path,
  playing,
  currentTime,
  seekRevision,
  loop
}: {
  path: string
  playing: boolean
  currentTime: number
  seekRevision: number
  loop: boolean
}): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const requestedTimeRef = useRef(currentTime)
  requestedTimeRef.current = currentTime

  const reportState = (): void => {
    const video = videoRef.current
    if (!video) return
    window.api.sendToControl('information-video-state', {
      path,
      currentTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
      duration: Number.isFinite(video.duration) ? video.duration : 0
    })
  }

  const applyRequestedTime = (): void => {
    const video = videoRef.current
    if (!video) return
    const duration = Number.isFinite(video.duration) ? video.duration : 0
    const target = Math.max(0, duration > 0
      ? Math.min(requestedTimeRef.current, duration)
      : requestedTimeRef.current)
    if (Math.abs(video.currentTime - target) < 0.05) return
    try {
      video.currentTime = target
    } catch (error) {
      window.api.dbgLog(`information video seek failed: ${String(error)}`)
    }
  }

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (playing) {
      void video.play().catch((error) => {
        window.api.dbgLog(`information video play failed: ${String(error)}`)
      })
    } else {
      video.pause()
    }
  }, [path, playing])

  useEffect(() => {
    applyRequestedTime()
  // `currentTime` is live feedback from the player. Only a new revision is an
  // operator seek command; otherwise every timeupdate would seek the video.
  }, [path, seekRevision])

  return (
    <video
      ref={videoRef}
      src={mediaUrl(path)}
      className="h-full w-full object-contain bg-black"
      preload="auto"
      playsInline
      loop={loop}
      onLoadedMetadata={() => { applyRequestedTime(); reportState() }}
      onDurationChange={reportState}
      onTimeUpdate={reportState}
      onSeeked={reportState}
      onEnded={() => {
        reportState()
        const video = videoRef.current
        window.api.sendToControl('information-video-ended', {
          path,
          currentTime: video?.currentTime || 0,
          duration: video && Number.isFinite(video.duration) ? video.duration : 0
        })
      }}
    />
  )
}

function describeInformationCaptureError(error: unknown, desktop: boolean): string {
  const name = error instanceof DOMException ? error.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return desktop
      ? 'Захват окна или экрана запрещён системой.'
      : 'Доступ к камере запрещён. Разрешите доступ для настольных приложений в настройках Windows.'
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return desktop
      ? 'Окно или экран больше недоступны. Выберите источник заново.'
      : 'Устройство не найдено. Проверьте подключение платы захвата или камеры.'
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'Устройство занято другой программой или не может начать захват.'
  }
  if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
    return 'Источник не поддерживает выбранный режим видеозахвата.'
  }
  if (error instanceof Error && error.message) return error.message
  return 'Не удалось открыть внешний источник.'
}

function InformationCapture({
  config,
  onReady,
  onStatus,
  retryDesktop = false,
  readyTimeoutMs = PROGRAM_MIRROR_FRAME_TIMEOUT_MS,
  logContext = 'information'
}: {
  config: CaptureSourceConfig
  onReady?: () => void
  onStatus?: (status: string) => void
  retryDesktop?: boolean
  readyTimeoutMs?: number
  logContext?: string
}): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const onReadyRef = useRef(onReady)
  const onStatusRef = useRef(onStatus)
  const [status, setStatus] = useState('Подключение источника…')
  const [retryRevision, setRetryRevision] = useState(0)
  onReadyRef.current = onReady
  onStatusRef.current = onStatus

  useEffect(() => {
    let cancelled = false
    let stream: MediaStream | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    const desktop = config.captureKind === 'desktop'
    const updateStatus = (nextStatus: string): void => {
      setStatus(nextStatus)
      onStatusRef.current?.(nextStatus)
    }

    const stopStream = (): void => {
      if (!stream) return
      for (const track of stream.getTracks()) {
        track.onended = null
        track.onmute = null
        track.stop()
      }
      stream = null
    }

    const connect = async (): Promise<void> => {
      updateStatus(desktop
        ? `Подключение ${config.desktopSourceType === 'screen' ? 'экрана' : 'окна'}…`
        : 'Подключение внешнего источника…')
      try {
        let desktopSourceId = config.desktopSourceId
        if (
          desktop &&
          (!desktopSourceId || !desktopSourceId.startsWith(`${config.desktopSourceType || 'window'}:`)) &&
          config.desktopSourceKey
        ) {
          const prepared = await window.api.prepareDesktopCaptureSource(config.desktopSourceKey)
          if (!prepared.success || !prepared.source) {
            throw new Error(prepared.error || 'Не удалось подготовить окно для захвата.')
          }
          desktopSourceId = prepared.source.captureId || (
            prepared.source.id.startsWith('window:') || prepared.source.id.startsWith('screen:')
              ? prepared.source.id
              : undefined
          )
        }

        let resolvedVideoDeviceId = config.videoDeviceId
        if (!desktop) {
          const devices = (await navigator.mediaDevices.enumerateDevices())
            .filter((device) => device.kind === 'videoinput')
          if (!devices.some((device) => device.deviceId === resolvedVideoDeviceId)) {
            const replacement = (
              (config.videoGroupId
                ? devices.find((device) => device.groupId && device.groupId === config.videoGroupId)
                : undefined) ||
              devices.find((device) => device.label && device.label === config.videoLabel)
            )
            resolvedVideoDeviceId = replacement?.deviceId
          }
        }

        if (desktop && !desktopSourceId) throw new Error('Источник окна или экрана не выбран.')
        if (!desktop && !resolvedVideoDeviceId) throw new Error('Устройство видеозахвата не выбрано.')

        const videoConstraints: MediaTrackConstraints = desktop
          ? ({
              mandatory: {
                chromeMediaSource: 'desktop',
                chromeMediaSourceId: desktopSourceId,
                maxWidth: 4096,
                maxHeight: 2160,
                maxFrameRate: 30
              }
            } as unknown as MediaTrackConstraints)
          : {
              deviceId: { exact: resolvedVideoDeviceId! },
              width: { ideal: 1920 },
              height: { ideal: 1080 },
              frameRate: { ideal: 30 }
            }

        stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false })
        if (cancelled) {
          stopStream()
          return
        }
        const videoTrack = stream.getVideoTracks()[0]
        if (!videoTrack) throw new Error('Источник не передал изображение.')
        if (desktop) videoTrack.contentHint = 'detail'
        videoTrack.onended = () => {
          if (cancelled) return
          updateStatus('Источник отключён. Повторное подключение…')
          retryTimer = setTimeout(() => setRetryRevision((value) => value + 1), 1200)
        }
        videoTrack.onmute = () => {
          if (!cancelled) updateStatus(desktop ? 'Изображение окна временно недоступно.' : 'Видеосигнал временно отсутствует.')
        }
        videoTrack.onunmute = () => {
          if (!cancelled) updateStatus('')
        }

        const video = videoRef.current
        if (!video) return
        video.srcObject = stream
        if (onReadyRef.current) await playAndWaitForVideoFrame(video, readyTimeoutMs)
        else await video.play()
        if (cancelled) return
        const settings = videoTrack.getSettings()
        updateStatus('')
        onReadyRef.current?.()
        window.api.dbgLog(
          `${logContext} capture ready source=${config.sourceId.slice(-8)} kind=${desktop ? config.desktopSourceType : 'device'} ` +
          `size=${settings.width || 0}x${settings.height || 0} fps=${settings.frameRate || 0}`
        )
      } catch (error) {
        stopStream()
        if (cancelled) return
        const message = describeInformationCaptureError(error, desktop)
        updateStatus(message)
        window.api.dbgLog(`${logContext} capture failed source=${config.sourceId.slice(-8)}: ${String(error)}`)
        // USB capture devices are often connected a moment after Windows has
        // announced them. Program mirrors also retry desktop sources because
        // an output/display topology change can invalidate them temporarily.
        if ((!desktop || retryDesktop) && !(error instanceof DOMException && (
          error.name === 'NotAllowedError' || error.name === 'SecurityError'
        ))) {
          retryTimer = setTimeout(() => setRetryRevision((value) => value + 1), 2500)
        }
      }
    }

    void connect()
    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
      stopStream()
      if (videoRef.current) videoRef.current.srcObject = null
      if (
        desktop &&
        (config.desktopSourceType === 'window' ||
          (!config.desktopSourceType && config.desktopSourceId?.startsWith('window:')))
      ) {
        void window.api.releaseBrowserFullscreen(
          config.desktopSourceKey || config.desktopSourceId
        )
      }
    }
  }, [
    config.captureKind,
    config.desktopSourceId,
    config.desktopSourceKey,
    config.desktopSourceType,
    config.sourceId,
    config.videoDeviceId,
    config.videoGroupId,
    config.videoLabel,
    logContext,
    readyTimeoutMs,
    retryDesktop,
    retryRevision
  ])

  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      <video ref={videoRef} className="h-full w-full bg-black object-contain" autoPlay muted playsInline />
      {status && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/80 px-8 text-center text-xl text-gray-300">
          {status}
        </div>
      )}
    </div>
  )
}

function InformationDisplay(): JSX.Element {
  const [state, setState] = useState<InformationDisplayState>({
    media: null,
    displayTimer: false,
    backdropImage: null,
    titles: null,
    titleSourceIdentity: null
  })
  const [timer, setTimer] = useState<TimerDisplayState>({
    remaining: 0,
    running: false,
    duration: 0,
    textColor: '#ffffff',
    warningTextColor: '#facc15',
    overtimeTextColor: '#ef4444',
    textOpacity: 1
  })

  useEffect(() => {
    const offState = window.api.on('information-state', (...args: unknown[]) => {
      setState(args[0] as InformationDisplayState)
    })
    const offTimer = window.api.on('timer-update', (...args: unknown[]) => {
      setTimer(args[0] as TimerDisplayState)
    })
    if (role === 'info') {
      window.api.sendToControl('information-state-ready', { displayId: auxiliaryDisplayId })
    }
    return () => { offState(); offTimer() }
  }, [])

  return (
    <div className="relative h-screen w-screen overflow-hidden select-none bg-black">
      {state.backdropImage && (
        <img
          src={mediaUrl(state.backdropImage)}
          className="absolute inset-0 z-0 h-full w-full object-cover"
          draggable={false}
        />
      )}
      {state.displayTimer ? (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/45 px-[4vw] text-center text-[clamp(110px,20vw,380px)]">
          <TimerValue timer={timer} />
        </div>
      ) : state.media?.type === 'presentation' ? (
        <SpeakerImageFrame path={state.media.slideImages[state.media.currentSlide - 1]} />
      ) : state.media?.type === 'pdf' ? (
        <SpeakerPdfFrame filePath={state.media.path} page={state.media.currentSlide} />
      ) : state.media?.type === 'video' ? (
        <InformationVideo
          path={state.media.path}
          playing={state.media.playing}
          currentTime={state.media.currentTime || 0}
          seekRevision={state.media.seekRevision || 0}
          loop={state.media.loop || false}
        />
      ) : state.media?.type === 'capture' && state.media.capture ? (
        <InformationCapture config={state.media.capture} />
      ) : state.media?.type === 'image' ? (
        <img src={mediaUrl(state.media.path)} className="absolute inset-0 h-full w-full object-contain" draggable={false} />
      ) : !state.backdropImage ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-500">
          <div className="text-4xl mb-3">Информационный экран</div>
          <div className="text-xl">Файл не выбран</div>
        </div>
      ) : null}
      {state.titles && (
        <BroadcastTitlesOverlay
          key={state.titleSourceIdentity || 'no-information-title-source'}
          titles={state.titles}
        />
      )}
    </div>
  )
}

function BackdropDisplay(): JSX.Element {
  const [backdropImage, setBackdropImage] = useState<string | null>(null)

  useEffect(() => window.api.on('backdrop-state', (...args: unknown[]) => {
    const state = args[0] as { backdropImage?: string | null }
    setBackdropImage(state.backdropImage || null)
  }), [])

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-black select-none">
      {backdropImage && (
        <img
          src={mediaUrl(backdropImage)}
          className="absolute inset-0 h-full w-full object-cover"
          draggable={false}
        />
      )}
    </div>
  )
}

function ProgramNativeVideo({
  content,
  onReady
}: {
  content: ProgramDirectContent
  onReady: () => void
}): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const targetTime = Number.isFinite(content.currentTime) ? content.currentTime || 0 : 0
    const drift = targetTime - video.currentTime
    video.loop = content.loop === true

    if (Math.abs(drift) > (content.playing ? 0.45 : 0.05)) {
      try { video.currentTime = Math.max(0, targetTime) } catch { /* metadata not ready yet */ }
      video.playbackRate = 1
    } else if (content.playing && Math.abs(drift) > 0.08) {
      video.playbackRate = drift > 0 ? 1.03 : 0.97
    } else {
      video.playbackRate = 1
    }

    if (content.playing) {
      if (video.paused) {
        void video.play().catch((error) => {
          window.api.dbgLog(`program native video play failed: ${String(error)}`)
        })
      }
    } else if (!video.paused) {
      video.pause()
    }
  }, [content.currentTime, content.loop, content.playing])

  const handleReady = (): void => {
    const video = videoRef.current
    if (!video) return
    const targetTime = Number.isFinite(content.currentTime) ? content.currentTime || 0 : 0
    try { video.currentTime = Math.max(0, targetTime) } catch { /* ignore */ }
    video.loop = content.loop === true
    if (content.playing) void video.play().catch(() => {})
    else video.pause()
    onReady()
    window.api.dbgLog(
      `program native video ready file=${content.path.split(/[\\/]/).pop() || content.path} ` +
      `size=${video.videoWidth}x${video.videoHeight}`
    )
  }

  return (
    <video
      ref={videoRef}
      src={mediaUrl(content.path)}
      className="h-full w-full object-fill bg-black"
      preload="auto"
      muted
      playsInline
      onLoadedData={handleReady}
    />
  )
}

function ProgramDirectLayer({
  content,
  onReady,
  onStatus
}: {
  content: ProgramDirectContent
  onReady: () => void
  onStatus?: (status: string) => void
}): JSX.Element {
  if (content.type === 'capture' && content.capture) {
    return (
      <InformationCapture
        config={content.capture}
        onReady={onReady}
        onStatus={onStatus}
        retryDesktop
        readyTimeoutMs={14_000}
        logContext="program mirror direct"
      />
    )
  }
  if (content.type === 'pdf') {
    return (
      <SpeakerPdfFrame
        filePath={content.path}
        page={content.currentSlide || 1}
        maxRenderWidth={8192}
        maxRenderHeight={4320}
        adaptiveMirrorWidth
        onReady={onReady}
      />
    )
  }
  if (content.type === 'video') {
    return <ProgramNativeVideo content={content} onReady={onReady} />
  }
  if (content.type === 'backdrop') {
    return (
      <img
        src={mediaUrl(content.path)}
        className="h-full w-full object-cover bg-black"
        draggable={false}
        onLoad={onReady}
      />
    )
  }
  return (
    <img
      src={mediaUrl(content.path)}
      className="h-full w-full object-fill bg-black"
      draggable={false}
      onLoad={onReady}
    />
  )
}

function ProgramMirrorDisplay(): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const directIdentityRef = useRef('')
  const reconnectFailuresRef = useRef(0)
  const lastPhysicalSizeRef = useRef(
    `${Math.round(window.innerWidth * (window.devicePixelRatio || 1))}x` +
    `${Math.round(window.innerHeight * (window.devicePixelRatio || 1))}`
  )
  const [mirrorState, setMirrorState] = useState<{
    sourceDisplayId: number | null
    sourcePixelWidth: number | null
    sourcePixelHeight: number | null
    sourceDipHeight: number | null
    contentType: string | null
    contentAspectRatio: number | null
    directContent: ProgramDirectContent | null
    active: boolean
    backdropImage: string | null
    titles: InformationDisplayState['titles']
    titleSourceIdentity: string | null
  }>({
    sourceDisplayId: null,
    sourcePixelWidth: null,
    sourcePixelHeight: null,
    sourceDipHeight: null,
    contentType: null,
    contentAspectRatio: null,
    directContent: null,
    active: false,
    backdropImage: null,
    titles: null,
    titleSourceIdentity: null
  })
  const [status, setStatus] = useState('Ожидание основного эфира…')
  const [reconnectRevision, setReconnectRevision] = useState(0)
  const [reconnectFrameUrl, setReconnectFrameUrl] = useState<string | null>(null)
  const [nativeReady, setNativeReady] = useState(false)
  const [programTimer, setProgramTimer] = useState<ProgramTimerOverlayState>(EMPTY_PROGRAM_TIMER)
  const [completedMirrorTransitionId, setCompletedMirrorTransitionId] = useState<string | null>(null)

  useEffect(() => {
    const unsubscribe = window.api.on('mirror-state', (...args: unknown[]) => {
      const data = args[0] as {
        sourceDisplayId?: number | null
        sourcePixelWidth?: number | null
        sourcePixelHeight?: number | null
        sourceDipHeight?: number | null
        contentType?: string | null
        contentAspectRatio?: number | null
        directContent?: ProgramDirectContent | null
        active?: boolean
        backdropImage?: string | null
        titles?: InformationDisplayState['titles']
        titleSourceIdentity?: string | null
      }
      const nextContentAspectRatio = typeof data?.contentAspectRatio === 'number' &&
        Number.isFinite(data.contentAspectRatio) && data.contentAspectRatio > 0
        ? data.contentAspectRatio
        : null
      const nextDirectContent = data?.directContent &&
        typeof data.directContent.path === 'string' &&
        (data.directContent.type !== 'capture' || typeof data.directContent.capture?.sourceId === 'string')
        ? data.directContent
        : null
      const nextDirectIdentity = nextDirectContent
        ? nextDirectContent.type === 'capture'
          ? `capture|${nextDirectContent.capture?.sourceId || nextDirectContent.path}`
          : `${nextDirectContent.type}|${nextDirectContent.path}`
        : ''
      if (nextDirectIdentity !== directIdentityRef.current) {
        directIdentityRef.current = nextDirectIdentity
        setNativeReady(false)
      }
      setMirrorState({
        sourceDisplayId: typeof data?.sourceDisplayId === 'number' ? data.sourceDisplayId : null,
        sourcePixelWidth: typeof data?.sourcePixelWidth === 'number' ? data.sourcePixelWidth : null,
        sourcePixelHeight: typeof data?.sourcePixelHeight === 'number' ? data.sourcePixelHeight : null,
        sourceDipHeight: typeof data?.sourceDipHeight === 'number' ? data.sourceDipHeight : null,
        contentType: typeof data?.contentType === 'string' ? data.contentType : null,
        contentAspectRatio: nextContentAspectRatio,
        directContent: nextDirectContent,
        active: data?.active === true,
        backdropImage: data?.backdropImage || null,
        titles: data?.titles || null,
        titleSourceIdentity: typeof data?.titleSourceIdentity === 'string'
          ? data.titleSourceIdentity
          : null
      })
      window.api.dbgLog(
        `program mirror state received display=${auxiliaryDisplayId ?? 'unknown'} ` +
        `active=${data?.active === true} direct=${nextDirectContent?.type || 'none'} ` +
        `backdrop=${data?.backdropImage ? 'yes' : 'no'}`
      )
      if (data?.contentType === 'presentation') {
        window.api.dbgLog(
          `program mirror geometry display=${auxiliaryDisplayId} ` +
          `source=${data.sourcePixelWidth ?? 0}x${data.sourcePixelHeight ?? 0} ` +
          `target=${window.innerWidth}x${window.innerHeight} ` +
          `pptxAspect=${nextContentAspectRatio ?? 'missing'}`
        )
      }
    })
    window.api.sendToControl('program-mirror-state-ready', { displayId: auxiliaryDisplayId })
    return unsubscribe
  }, [])

  useEffect(() => window.api.on('program-timer-overlay', (...args: unknown[]) => {
    const data = args[0] as Partial<ProgramTimerOverlayState> | undefined
    setProgramTimer({
      ...EMPTY_PROGRAM_TIMER,
      ...data,
      visible: data?.visible === true
    })
  }), [])

  useEffect(() => window.api.on('program-mirror-transition-complete', (...args: unknown[]) => {
    const data = args[0] as { transitionId?: string } | undefined
    if (!data?.transitionId) return
    window.api.dbgLog(
      `program mirror transition commit received display=${auxiliaryDisplayId ?? 'unknown'} ` +
      `id=${data.transitionId}`
    )
    setCompletedMirrorTransitionId(data.transitionId)
  }), [])

  useEffect(() => {
    // Fullscreen placement and a runtime resolution/DPI change both resize the
    // mirror renderer. Reopen desktop capture after the size has settled so
    // its requested buffer always matches this monitor, not the display on
    // which the BrowserWindow happened to be initialized.
    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    const handleResize = (): void => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        resizeTimer = null
        const nextPhysicalSize =
          `${Math.round(window.innerWidth * (window.devicePixelRatio || 1))}x` +
          `${Math.round(window.innerHeight * (window.devicePixelRatio || 1))}`
        if (nextPhysicalSize === lastPhysicalSizeRef.current) return
        window.api.dbgLog(
          `program mirror reconnect trigger=resize display=${auxiliaryDisplayId ?? 'unknown'} ` +
          `old=${lastPhysicalSizeRef.current} new=${nextPhysicalSize}`
        )
        lastPhysicalSizeRef.current = nextPhysicalSize
        reconnectFailuresRef.current = 0
        setReconnectRevision((value) => value + 1)
      }, 250)
    }
    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
      if (resizeTimer) clearTimeout(resizeTimer)
    }
  }, [])

  const directIdentity = mirrorState.directContent
    ? mirrorState.directContent.type === 'capture'
      ? `capture|${mirrorState.directContent.capture?.sourceId || mirrorState.directContent.path}`
      : `${mirrorState.directContent.type}|${mirrorState.directContent.path}`
    : ''
  const hasDirectContent = mirrorState.directContent !== null
  const isDirectBackdrop = mirrorState.directContent?.type === 'backdrop'
  const isDirectCapture = mirrorState.directContent?.type === 'capture'
  const showBackdropBehindStatus = Boolean(mirrorState.backdropImage && status)

  useEffect(() => {
    let cancelled = false
    let stream: MediaStream | null = null
    let firstFramePresented = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null

    const connect = async (): Promise<void> => {
      if (!mirrorState.active) {
        setStatus('')
        setReconnectFrameUrl(null)
        reconnectFailuresRef.current = 0
        return
      }
      // Chromium's desktop capture can return black when it captures another
      // BrowserWindow from this same Electron process. External sources are
      // therefore opened directly in the mirror renderer; PowerPoint keeps
      // using the existing display-capture path below.
      if (isDirectCapture) {
        if (nativeReady) {
          setStatus('')
          setReconnectFrameUrl(null)
          reconnectFailuresRef.current = 0
        } else {
          setStatus(PROGRAM_MIRROR_CONNECTING_STATUS)
        }
        return
      }
      if (isDirectBackdrop) {
        setStatus('')
        setReconnectFrameUrl(null)
        reconnectFailuresRef.current = 0
        return
      }
      // PDF, video, images and the backdrop are rendered directly in this
      // window. Keeping a full-resolution desktop capture alive underneath
      // that opaque layer doubled GPU/encoder load for no visible benefit.
      if (hasDirectContent && nativeReady) {
        setStatus('')
        setReconnectFrameUrl(null)
        reconnectFailuresRef.current = 0
        window.api.dbgLog(`program mirror desktop capture skipped direct=${mirrorState.directContent?.type || 'none'}`)
        return
      }
      if (mirrorState.sourceDisplayId === null) {
        setStatus('Основной эфирный дисплей не назначен')
        return
      }
      setStatus(PROGRAM_MIRROR_CONNECTING_STATUS)
      try {
        let sourceId: string | null = null
        for (let attempt = 0; attempt < 6 && !cancelled && !sourceId; attempt++) {
          sourceId = await window.api.getScreenCaptureSource(mirrorState.sourceDisplayId)
          if (!sourceId) await new Promise((resolve) => setTimeout(resolve, 300))
        }
        if (cancelled) return
        if (!sourceId) throw new Error('источник экрана не найден')

        const sourceWidth = mirrorState.sourcePixelWidth
        const sourceHeight = mirrorState.sourcePixelHeight
        const targetWidth = Math.max(2, Math.round(window.innerWidth * (window.devicePixelRatio || 1)))
        const targetHeight = Math.max(2, Math.round(window.innerHeight * (window.devicePixelRatio || 1)))
        let captureWidth = sourceWidth || targetWidth
        let captureHeight = sourceHeight || targetHeight
        if (sourceWidth && sourceHeight) {
          const fitScale = Math.min(1, targetWidth / sourceWidth, targetHeight / sourceHeight)
          captureWidth = Math.max(2, Math.round(sourceWidth * fitScale / 2) * 2)
          captureHeight = Math.max(2, Math.round(sourceHeight * fitScale / 2) * 2)
        }
        // 24 FPS keeps PowerPoint animations and cursor motion fluid while
        // avoiding the permanent 4K/30 capture cost on every live copy.
        const captureFrameRate = 24
        const desktopConstraints = (requestOptimizedSize: boolean): MediaStreamConstraints => ({
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: sourceId,
              ...(requestOptimizedSize
                ? {
                    minWidth: captureWidth,
                    maxWidth: captureWidth,
                    minHeight: captureHeight,
                    maxHeight: captureHeight
                  }
                : {}),
              maxFrameRate: captureFrameRate
            }
          } as unknown as MediaTrackConstraints
        })
        try {
          stream = await navigator.mediaDevices.getUserMedia(desktopConstraints(true))
        } catch (nativeError) {
          window.api.dbgLog(
            `program mirror native capture fallback display=${mirrorState.sourceDisplayId} ` +
            `source=${sourceWidth || 0}x${sourceHeight || 0} ` +
            `target=${targetWidth}x${targetHeight} requested=${captureWidth}x${captureHeight} ` +
            `error=${String(nativeError)}`
          )
          stream = await navigator.mediaDevices.getUserMedia(desktopConstraints(false))
        }
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        const video = videoRef.current
        if (!video) return
        video.srcObject = stream
        const track = stream.getVideoTracks()[0]
        if (track) {
          track.onended = () => {
            window.api.dbgLog(
              `program mirror reconnect trigger=track-ended display=${mirrorState.sourceDisplayId}`
            )
            reconnectFailuresRef.current = 0
            setReconnectRevision((value) => value + 1)
          }
          const settings = track.getSettings()
          window.api.dbgLog(
            `program mirror track acquired display=${mirrorState.sourceDisplayId} ` +
            `source=${sourceWidth || 0}x${sourceHeight || 0} ` +
            `target=${targetWidth}x${targetHeight} requested=${captureWidth}x${captureHeight} ` +
            `actual=${settings.width || 0}x${settings.height || 0} fps=${settings.frameRate || 0}`
          )
        }
        await playAndWaitForVideoFrame(video)
        if (cancelled || video.srcObject !== stream || track?.readyState === 'ended') return
        firstFramePresented = true
        reconnectFailuresRef.current = 0
        setStatus('')
        setReconnectFrameUrl(null)
        window.api.dbgLog(
          `program mirror first frame display=${mirrorState.sourceDisplayId} ` +
          `video=${video.videoWidth}x${video.videoHeight}`
        )
        window.api.sendToControl('program-mirror-ready', {
          displayId: auxiliaryDisplayId,
          sourceDisplayId: mirrorState.sourceDisplayId
        })
      } catch (error) {
        if (!cancelled) {
          if (stream) {
            stream.getTracks().forEach((track) => {
              track.onended = null
              track.stop()
            })
            stream = null
          }
          if (videoRef.current) videoRef.current.srcObject = null
          const failure = ++reconnectFailuresRef.current
          window.api.dbgLog(
            `program mirror failed display=${mirrorState.sourceDisplayId} ` +
            `attempt=${failure}/${PROGRAM_MIRROR_MAX_RETRIES}: ${String(error)}`
          )
          if (failure < PROGRAM_MIRROR_MAX_RETRIES) {
            setStatus(PROGRAM_MIRROR_CONNECTING_STATUS)
            const retryDelay = Math.min(3_000, 500 * (2 ** (failure - 1)))
            retryTimer = setTimeout(() => {
              retryTimer = null
              if (!cancelled) setReconnectRevision((value) => value + 1)
            }, retryDelay)
          } else {
            setStatus(`Не удалось показать копию эфира: ${String(error)}`)
          }
        }
      }
    }

    void connect()
    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
      if (stream) {
        if (firstFramePresented && videoRef.current?.srcObject === stream) {
          const frozenFrame = captureVideoFrame(videoRef.current)
          if (frozenFrame) setReconnectFrameUrl(frozenFrame)
        }
        stream.getTracks().forEach((track) => {
          track.onended = null
          track.stop()
        })
      }
      if (videoRef.current) videoRef.current.srcObject = null
    }
  }, [
    mirrorState.active,
    nativeReady,
    mirrorState.sourceDisplayId,
    mirrorState.sourcePixelHeight,
    mirrorState.sourcePixelWidth,
    mirrorState.contentAspectRatio,
    mirrorState.contentType,
    isDirectCapture,
    isDirectBackdrop,
    reconnectRevision
  ])

  useEffect(() => {
    const transitionId = completedMirrorTransitionId
    if (!transitionId) return
    let cancelled = false
    let videoFrameHandle: number | null = null
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null
    let firstAnimationFrame: number | null = null
    let secondAnimationFrame: number | null = null
    let releaseQueued = false

    const releaseAfterPaint = (): void => {
      if (releaseQueued || cancelled) return
      releaseQueued = true
      if (fallbackTimer) {
        clearTimeout(fallbackTimer)
        fallbackTimer = null
      }
      if (videoFrameHandle !== null && typeof videoRef.current?.cancelVideoFrameCallback === 'function') {
        videoRef.current.cancelVideoFrameCallback(videoFrameHandle)
        videoFrameHandle = null
      }
      firstAnimationFrame = requestAnimationFrame(() => {
        secondAnimationFrame = requestAnimationFrame(() => {
          if (cancelled) return
          void window.api.releaseProgramMirrorHold(transitionId).then((released) => {
            if (!released || cancelled) return
            window.api.dbgLog(
              `program mirror transition promoted display=${auxiliaryDisplayId ?? 'unknown'} ` +
              `id=${transitionId} direct=${mirrorState.directContent?.type || 'capture'}`
            )
            setCompletedMirrorTransitionId((current) => current === transitionId ? null : current)
          }).catch((error) => {
            if (cancelled) return
            window.api.dbgLog(
              `program mirror transition release failed display=${auxiliaryDisplayId ?? 'unknown'} ` +
              `id=${transitionId} error=${String(error)}`
            )
            // Let a subsequent state/ready update retry; main also has a final
            // watchdog so the frozen frame can never remain indefinitely.
            releaseQueued = false
          })
        })
      })
    }

    if (mirrorState.directContent) {
      if (!nativeReady) return
      releaseAfterPaint()
    } else if (!mirrorState.active) {
      releaseAfterPaint()
    } else {
      const video = videoRef.current
      if (!video || !video.srcObject || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return
      if (typeof video.requestVideoFrameCallback === 'function') {
        videoFrameHandle = video.requestVideoFrameCallback(() => releaseAfterPaint())
      }
      // A static first PowerPoint slide may not produce a damage frame after
      // TAKE commit. RVFC then waits until the operator presses Next/Prev and
      // the previous PDF hold appears stuck. The PowerPoint daemon has already
      // positioned the slideshow and flushed DWM before commit, so use a short
      // bounded fallback even when RVFC exists.
      fallbackTimer = setTimeout(releaseAfterPaint, 140)
    }

    return () => {
      cancelled = true
      if (videoFrameHandle !== null && typeof videoRef.current?.cancelVideoFrameCallback === 'function') {
        videoRef.current.cancelVideoFrameCallback(videoFrameHandle)
      }
      if (fallbackTimer) clearTimeout(fallbackTimer)
      if (firstAnimationFrame !== null) cancelAnimationFrame(firstAnimationFrame)
      if (secondAnimationFrame !== null) cancelAnimationFrame(secondAnimationFrame)
    }
  }, [
    completedMirrorTransitionId,
    directIdentity,
    mirrorState.active,
    nativeReady,
    reconnectRevision,
    status
  ])

  // PowerPoint fits the slide inside the source display and adds black bars
  // when their aspect ratios differ. Geometry is therefore applied in two
  // independent layers:
  // 1. pptxFrame fits the untouched slide aspect into THIS monitor;
  // 2. pptxSourceCrop enlarges the captured SOURCE display only enough to
  //    remove PowerPoint's source-side letterbox around that slide.
  // A 16:9 deck consequently fills 1920x1080, while the same deck retains
  // proper side bars on 3440x1440. Slide pixels are never distorted or cut.
  const sourceAspect = mirrorState.sourcePixelWidth && mirrorState.sourcePixelHeight
    ? mirrorState.sourcePixelWidth / mirrorState.sourcePixelHeight
    : null
  const slideAspect = mirrorState.contentType === 'presentation'
    ? mirrorState.contentAspectRatio
    : null
  const targetAspect = Math.max(1, window.innerWidth) / Math.max(1, window.innerHeight)
  const pptxFrame = slideAspect
    ? targetAspect > slideAspect
      ? {
          width: `${(slideAspect / targetAspect) * 100}%`,
          height: '100%',
          left: '50%',
          top: 0,
          transform: 'translateX(-50%)'
        }
      : targetAspect < slideAspect
        ? {
            width: '100%',
            height: `${(targetAspect / slideAspect) * 100}%`,
            left: 0,
            top: '50%',
            transform: 'translateY(-50%)'
          }
        : undefined
    : undefined
  const pptxSourceCrop = sourceAspect && slideAspect
    ? sourceAspect > slideAspect
      ? {
          width: `${(sourceAspect / slideAspect) * 100}%`,
          height: '100%',
          left: '50%',
          top: 0,
          transform: 'translateX(-50%)'
        }
      : sourceAspect < slideAspect
        ? {
            width: '100%',
            height: `${(slideAspect / sourceAspect) * 100}%`,
            left: 0,
            top: '50%',
            transform: 'translateY(-50%)'
          }
        : undefined
    : undefined

  return (
    <div
      className="relative h-screen w-screen overflow-hidden bg-black bg-cover bg-center bg-no-repeat select-none"
      style={{
        backgroundImage: mirrorState.backdropImage && (!mirrorState.active || isDirectBackdrop)
          ? `url("${mediaUrl(mirrorState.backdropImage)}")`
          : undefined
      }}
    >
      <div
        className={`absolute overflow-hidden bg-black ${
          mirrorState.active && !isDirectBackdrop && (!hasDirectContent || !nativeReady) ? '' : 'hidden'
        }`}
        style={{
          inset: slideAspect ? undefined : 0,
          width: pptxFrame?.width ?? (slideAspect ? '100%' : undefined),
          height: pptxFrame?.height ?? (slideAspect ? '100%' : undefined),
          left: pptxFrame?.left ?? (slideAspect ? 0 : undefined),
          top: pptxFrame?.top ?? (slideAspect ? 0 : undefined),
          transform: pptxFrame?.transform
        }}
      >
        <video
          ref={videoRef}
          className="absolute object-contain bg-black"
          style={{
            inset: pptxSourceCrop ? undefined : 0,
            width: pptxSourceCrop?.width ?? '100%',
            height: pptxSourceCrop?.height ?? '100%',
            // Tailwind's preflight applies both `max-width: 100%` and
            // `height: auto` to every video. The PPTX mirror intentionally
            // makes this element wider/taller than its clipping frame to
            // remove PowerPoint's source-display letterbox, so neither
            // global constraint may participate in this geometry.
            maxWidth: 'none',
            maxHeight: 'none',
            minWidth: 0,
            minHeight: 0,
            left: pptxSourceCrop?.left ?? 0,
            top: pptxSourceCrop?.top ?? 0,
            objectFit: 'contain',
            transform: pptxSourceCrop?.transform ?? (mirrorState.contentType === 'pdf'
              ? `scaleX(${MIRROR_PDF_SAFE_WIDTH_RATIO})`
              : undefined),
            transformOrigin: 'center center'
          }}
          muted
          playsInline
        />
      </div>
      {mirrorState.directContent && (
        <div
          className={`absolute inset-0 z-10 overflow-hidden bg-black transition-none ${nativeReady ? 'opacity-100' : 'opacity-0'}`}
        >
          <ProgramDirectLayer
            key={directIdentity}
            content={mirrorState.directContent}
            onStatus={setStatus}
            onReady={() => {
              if (directIdentityRef.current !== directIdentity) return
              setNativeReady(true)
              window.api.dbgLog(`program mirror direct ready identity=${directIdentity}`)
              window.api.sendToControl('program-mirror-ready', {
                displayId: auxiliaryDisplayId,
                sourceDisplayId: mirrorState.sourceDisplayId
              })
            }}
          />
        </div>
      )}
      {mirrorState.directContent?.type === 'capture' && mirrorState.titles && nativeReady && (
        <BroadcastTitlesOverlay
          key={mirrorState.titleSourceIdentity || 'no-program-mirror-title-source'}
          titles={mirrorState.titles}
        />
      )}
      {mirrorState.active && !isDirectBackdrop && status && !nativeReady && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black text-xl text-gray-400">
          {reconnectFrameUrl ? (
            <img
              src={reconnectFrameUrl}
              className="absolute inset-0 h-full w-full object-contain bg-black"
              draggable={false}
            />
          ) : showBackdropBehindStatus ? (
            <>
            <img
              src={mediaUrl(mirrorState.backdropImage as string)}
              className="absolute inset-0 h-full w-full object-cover"
              draggable={false}
            />
              {status !== PROGRAM_MIRROR_CONNECTING_STATUS && (
                <span className="relative z-10 rounded bg-black/70 px-4 py-2 text-sm text-gray-200">
                  {status}
                </span>
              )}
            </>
          ) : status}
        </div>
      )}
      {mirrorState.active && hasDirectContent && nativeReady && (
        <ProgramTimerOverlay timer={programTimer} sourceDipHeight={mirrorState.sourceDipHeight} />
      )}
    </div>
  )
}

export function AuxiliaryApp(): JSX.Element {
  useEffect(() => {
    document.title = role === 'mirror'
      ? 'PDM Program Mirror'
      : role === 'speaker'
        ? 'PDM Speaker Display'
      : role === 'timer'
          ? 'PDM Timer Display'
          : role === 'event-timer'
            ? 'PDM Event Timer Display'
          : role === 'backdrop'
            ? 'PDM Backdrop Display'
            : 'PDM Information Display'
  }, [])
  if (role === 'mirror') return <ProgramMirrorDisplay />
  if (role === 'speaker') return <SpeakerDisplay />
  if (role === 'event-timer') return <EventTimerDisplay />
  if (role === 'backdrop') return <BackdropDisplay />
  return <InformationDisplay />
}
