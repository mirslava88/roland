import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { mediaUrl } from './media'
import { renderPdfiumPageToCanvas } from './pdfium-renderer'
import { EventTimerScene } from './components/EventTimer/EventTimerScene'

const requestedRole = new URLSearchParams(window.location.search).get('role')
const requestedDisplayId = Number(new URLSearchParams(window.location.search).get('displayId'))
const auxiliaryDisplayId = Number.isFinite(requestedDisplayId) ? requestedDisplayId : null
const MIRROR_PDF_SAFE_WIDTH_RATIO = 0.96
const MIRROR_PDF_MAX_HORIZONTAL_STRETCH = 1.08
const role: AuxiliaryDisplayRole = requestedRole === 'mirror' ||
  requestedRole === 'info' ||
  requestedRole === 'timer' ||
  requestedRole === 'event-timer' ||
  requestedRole === 'backdrop'
  ? requestedRole
  : 'speaker'

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
    live: false
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
    : <div className="h-screen w-screen bg-black" />
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

function InformationCapture({ config }: { config: CaptureSourceConfig }): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [status, setStatus] = useState('Подключение источника…')
  const [retryRevision, setRetryRevision] = useState(0)

  useEffect(() => {
    let cancelled = false
    let stream: MediaStream | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    const desktop = config.captureKind === 'desktop'

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
      setStatus(desktop
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
          setStatus('Источник отключён. Повторное подключение…')
          retryTimer = setTimeout(() => setRetryRevision((value) => value + 1), 1200)
        }
        videoTrack.onmute = () => {
          if (!cancelled) setStatus(desktop ? 'Изображение окна временно недоступно.' : 'Видеосигнал временно отсутствует.')
        }
        videoTrack.onunmute = () => {
          if (!cancelled) setStatus('')
        }

        const video = videoRef.current
        if (!video) return
        video.srcObject = stream
        await video.play()
        if (cancelled) return
        const settings = videoTrack.getSettings()
        setStatus('')
        window.api.dbgLog(
          `information capture ready source=${config.sourceId.slice(-8)} kind=${desktop ? config.desktopSourceType : 'device'} ` +
          `size=${settings.width || 0}x${settings.height || 0} fps=${settings.frameRate || 0}`
        )
      } catch (error) {
        stopStream()
        if (cancelled) return
        const message = describeInformationCaptureError(error, desktop)
        setStatus(message)
        window.api.dbgLog(`information capture failed source=${config.sourceId.slice(-8)}: ${String(error)}`)
        // USB capture devices are often connected a moment after Windows has
        // announced them. Keep retrying video devices so the information
        // screen recovers without forcing the operator to select it again.
        if (!desktop && !(error instanceof DOMException && (
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
    backdropImage: null
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
  onReady
}: {
  content: ProgramDirectContent
  onReady: () => void
}): JSX.Element {
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
  const [mirrorState, setMirrorState] = useState<{
    sourceDisplayId: number | null
    sourcePixelWidth: number | null
    sourcePixelHeight: number | null
    contentType: string | null
    directContent: ProgramDirectContent | null
    active: boolean
    backdropImage: string | null
  }>({
    sourceDisplayId: null,
    sourcePixelWidth: null,
    sourcePixelHeight: null,
    contentType: null,
    directContent: null,
    active: false,
    backdropImage: null
  })
  const [status, setStatus] = useState('Ожидание основного эфира…')
  const [reconnectRevision, setReconnectRevision] = useState(0)
  const [nativeReady, setNativeReady] = useState(false)

  useEffect(() => window.api.on('mirror-state', (...args: unknown[]) => {
    const data = args[0] as {
      sourceDisplayId?: number | null
      sourcePixelWidth?: number | null
      sourcePixelHeight?: number | null
      contentType?: string | null
      directContent?: ProgramDirectContent | null
      active?: boolean
      backdropImage?: string | null
    }
    setMirrorState({
      sourceDisplayId: typeof data?.sourceDisplayId === 'number' ? data.sourceDisplayId : null,
      sourcePixelWidth: typeof data?.sourcePixelWidth === 'number' ? data.sourcePixelWidth : null,
      sourcePixelHeight: typeof data?.sourcePixelHeight === 'number' ? data.sourcePixelHeight : null,
      contentType: typeof data?.contentType === 'string' ? data.contentType : null,
      directContent: data?.directContent && typeof data.directContent.path === 'string'
        ? data.directContent
        : null,
      active: data?.active === true,
      backdropImage: data?.backdropImage || null
    })
  }), [])

  const directIdentity = mirrorState.directContent
    ? `${mirrorState.directContent.type}|${mirrorState.directContent.path}`
    : ''
  const hasDirectContent = mirrorState.directContent !== null
  useEffect(() => setNativeReady(false), [directIdentity])

  useEffect(() => {
    let cancelled = false
    let stream: MediaStream | null = null

    const connect = async (): Promise<void> => {
      if (!mirrorState.active) {
        setStatus('')
        return
      }
      // PDF, video, images and the backdrop are rendered directly in this
      // window. Keeping a full-resolution desktop capture alive underneath
      // that opaque layer doubled GPU/encoder load for no visible benefit.
      if (hasDirectContent && nativeReady) {
        setStatus('')
        window.api.dbgLog(`program mirror desktop capture skipped direct=${mirrorState.directContent?.type || 'none'}`)
        return
      }
      if (mirrorState.sourceDisplayId === null) {
        setStatus('Основной эфирный дисплей не назначен')
        return
      }
      setStatus('Подключение к основному эфиру…')
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
          track.onended = () => setReconnectRevision((value) => value + 1)
          const settings = track.getSettings()
          window.api.dbgLog(
            `program mirror ready display=${mirrorState.sourceDisplayId} ` +
            `source=${sourceWidth || 0}x${sourceHeight || 0} ` +
            `target=${targetWidth}x${targetHeight} requested=${captureWidth}x${captureHeight} ` +
            `actual=${settings.width || 0}x${settings.height || 0} fps=${settings.frameRate || 0}`
          )
        }
        await video.play()
        setStatus('')
        window.api.sendToControl('program-mirror-ready', {
          displayId: auxiliaryDisplayId,
          sourceDisplayId: mirrorState.sourceDisplayId
        })
      } catch (error) {
        if (!cancelled) {
          setStatus(`Не удалось показать копию эфира: ${String(error)}`)
          window.api.dbgLog(`program mirror failed display=${mirrorState.sourceDisplayId}: ${String(error)}`)
        }
      }
    }

    void connect()
    return () => {
      cancelled = true
      if (stream) {
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
    reconnectRevision
  ])

  return (
    <div
      className="relative h-screen w-screen overflow-hidden bg-black bg-cover bg-center bg-no-repeat select-none"
      style={{
        backgroundImage: !mirrorState.active && mirrorState.backdropImage
          ? `url("${mediaUrl(mirrorState.backdropImage)}")`
          : undefined
      }}
    >
      <video
        ref={videoRef}
        className={`absolute inset-0 h-full w-full object-fill bg-black ${
          mirrorState.active && (!hasDirectContent || !nativeReady) ? '' : 'hidden'
        }`}
        style={{
          transform: mirrorState.contentType === 'pdf'
            ? `scaleX(${MIRROR_PDF_SAFE_WIDTH_RATIO})`
            : undefined,
          transformOrigin: 'center center'
        }}
        muted
        playsInline
      />
      {mirrorState.directContent && (
        <div
          className={`absolute inset-0 z-10 overflow-hidden bg-black transition-none ${nativeReady ? 'opacity-100' : 'opacity-0'}`}
        >
          <ProgramDirectLayer
            content={mirrorState.directContent}
            onReady={() => {
              setNativeReady(true)
              window.api.sendToControl('program-mirror-ready', {
                displayId: auxiliaryDisplayId,
                sourceDisplayId: mirrorState.sourceDisplayId
              })
            }}
          />
        </div>
      )}
      {status && !nativeReady && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-black text-xl text-gray-400">
          {status}
        </div>
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
