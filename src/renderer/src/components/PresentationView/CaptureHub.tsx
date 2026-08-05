import { useCallback, useEffect, useRef, useState } from 'react'

export interface CaptureTakeRequest {
  sourceId: string
  revision: number
}

interface CaptureHubProps {
  activeSourceId: string | null
  audioSourceId: string | null
  takeRequest: CaptureTakeRequest | null
  onTakeReady: (sourceId: string, revision: number) => void
  onTakeError: (sourceId: string, revision: number, message: string) => void
}

interface CaptureDevicesRequest {
  requestId: string
}

interface CaptureDevicesResponse {
  requestId: string
  devices: CaptureDeviceDescriptor[]
  error?: string
}

interface FrameWaiter {
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

type VideoWithFrameCallbacks = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: (now: number, metadata: unknown) => void) => number
  cancelVideoFrameCallback?: (handle: number) => void
}

function describeMediaError(error: unknown, desktop = false): string {
  const name = error instanceof DOMException ? error.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return desktop
      ? 'Захват окна или экрана запрещён системой.'
      : 'Доступ к камере запрещён. Разрешите доступ для настольных приложений в настройках Windows.'
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return desktop
      ? 'Окно или экран больше недоступны. Добавьте источник заново.'
      : 'Устройство не найдено. Проверьте подключение платы захвата или камеры.'
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'Устройство занято другой программой или не может начать захват.'
  }
  if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
    return 'Устройство не поддерживает выбранный режим видеозахвата.'
  }
  if (error instanceof Error && error.message) return error.message
  return 'Не удалось открыть внешний источник.'
}

function stopStream(stream: MediaStream | null): void {
  if (!stream) return
  for (const track of stream.getTracks()) {
    track.onended = null
    track.onmute = null
    track.onunmute = null
    track.stop()
  }
}

async function enumerateCaptureDevices(requestId: string): Promise<CaptureDevicesResponse> {
  if (!navigator.mediaDevices?.enumerateDevices || !navigator.mediaDevices?.getUserMedia) {
    return { requestId, devices: [], error: 'Захват видео не поддерживается на этом компьютере.' }
  }

  let probe: MediaStream | null = null
  let permissionError: string | undefined
  try {
    // Do not probe again once labels have already been unlocked. Reopening the
    // default camera whenever the picker is shown can disturb inexpensive UVC
    // capture cards and also creates a devicechange -> enumerate loop.
    const initialDevices = await navigator.mediaDevices.enumerateDevices()
    const labelsAvailable = initialDevices.some(
      (device) => device.kind === 'videoinput' && !!device.label
    )
    if (!labelsAvailable) {
      // A short video-only probe unlocks stable labels/deviceIds in the same
      // renderer that will later own the long-lived stream.
      probe = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
    }
  } catch (error) {
    permissionError = describeMediaError(error)
  } finally {
    stopStream(probe)
  }

  try {
    const rawDevices = await navigator.mediaDevices.enumerateDevices()
    let videoIndex = 0
    let audioIndex = 0
    const devices: CaptureDeviceDescriptor[] = rawDevices
      .filter((device) => (
        (device.kind === 'videoinput' || device.kind === 'audioinput') &&
        !!device.deviceId
      ))
      .map((device) => {
        const isVideo = device.kind === 'videoinput'
        if (isVideo) videoIndex += 1
        else audioIndex += 1
        return {
          deviceId: device.deviceId,
          groupId: device.groupId,
          kind: device.kind as 'videoinput' | 'audioinput',
          label: device.label || (isVideo ? `Видеоустройство ${videoIndex}` : `Аудиовход ${audioIndex}`)
        }
      })

    const hasVideo = devices.some((device) => device.kind === 'videoinput')
    return {
      requestId,
      devices,
      error: hasVideo ? undefined : permissionError || 'Камеры и платы видеозахвата не найдены.'
    }
  } catch (error) {
    return { requestId, devices: [], error: permissionError || describeMediaError(error) }
  }
}

function CaptureSourceLayer({
  config,
  active,
  audioActive,
  takeRevision,
  onTakeReady,
  onTakeError
}: {
  config: CaptureSourceConfig
  active: boolean
  audioActive: boolean
  takeRevision?: number
  onTakeReady: (sourceId: string, revision: number) => void
  onTakeError: (sourceId: string, revision: number, message: string) => void
}): JSX.Element {
  const isDesktopCapture = config.captureKind === 'desktop'
  const desktopTarget = config.desktopSourceType === 'screen' ? 'экрана' : 'окна'
  const videoRef = useRef<VideoWithFrameCallbacks>(null)
  const holdImageRef = useRef<HTMLImageElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const generationRef = useRef(0)
  const retryAttemptRef = useRef(0)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const muteWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const frameCallbackRef = useRef<number | null>(null)
  const fallbackFrameTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const frameWaitersRef = useRef(new Set<FrameWaiter>())
  const handledTakeRevisionRef = useRef<number | null>(null)
  const lastPreviewAtRef = useRef(0)
  const lastFrameDataUrlRef = useRef<string | null>(null)
  const latestStateRef = useRef<CaptureSourceState>({
    sourceId: config.sourceId,
    status: 'connecting',
    message: isDesktopCapture ? `Подключение ${desktopTarget}…` : 'Подключение видеовхода…'
  })
  const [hasAudio, setHasAudio] = useState(false)

  const emitState = useCallback((state: Omit<CaptureSourceState, 'sourceId'>): void => {
    const nextState: CaptureSourceState = { sourceId: config.sourceId, ...state }
    latestStateRef.current = nextState
    window.api.sendToControl('capture-source-state', nextState)
  }, [config.sourceId])

  const resolveFrameWaiters = useCallback((): void => {
    const waiters = [...frameWaitersRef.current]
    frameWaitersRef.current.clear()
    for (const waiter of waiters) {
      clearTimeout(waiter.timer)
      waiter.resolve()
    }
  }, [])

  const rejectFrameWaiters = useCallback((message: string): void => {
    const waiters = [...frameWaitersRef.current]
    frameWaitersRef.current.clear()
    for (const waiter of waiters) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error(message))
    }
  }, [])

  const waitForNextFrame = useCallback((timeoutMs = 12000): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      const waiter: FrameWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          frameWaitersRef.current.delete(waiter)
          reject(new Error(`Видеосигнал не появился за ${Math.ceil(timeoutMs / 1000)} секунд.`))
        }, timeoutMs)
      }
      frameWaitersRef.current.add(waiter)
    })
  }, [])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.muted = !audioActive || !hasAudio
    if (audioActive) void video.play().catch(() => { /* the autoplay switch handles normal cases */ })
  }, [audioActive, hasAudio])

  useEffect(() => {
    let cancelled = false
    const generation = ++generationRef.current

    const clearFramePump = (): void => {
      const video = videoRef.current
      if (frameCallbackRef.current !== null && video?.cancelVideoFrameCallback) {
        video.cancelVideoFrameCallback(frameCallbackRef.current)
      }
      frameCallbackRef.current = null
      if (fallbackFrameTimerRef.current) clearTimeout(fallbackFrameTimerRef.current)
      fallbackFrameTimerRef.current = null
    }

    const clearMuteWatchdog = (): void => {
      if (muteWatchdogRef.current) clearTimeout(muteWatchdogRef.current)
      muteWatchdogRef.current = null
    }

    const showHeldFrame = (): void => {
      const image = holdImageRef.current
      const frame = lastFrameDataUrlRef.current
      if (!image || !frame) return
      if (image.src !== frame) image.src = frame
      image.style.opacity = '1'
    }

    const drawPreview = (now: number): void => {
      const video = videoRef.current
      if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) return
      resolveFrameWaiters()
      if (holdImageRef.current) holdImageRef.current.style.opacity = '0'
      // Three preview frames per second are ample for the operator thumbnail
      // and avoid JPEG/IPC/GC spikes during presentation layer swaps.
      if (now - lastPreviewAtRef.current < 330) return
      lastPreviewAtRef.current = now

      const canvas = canvasRef.current || document.createElement('canvas')
      canvasRef.current = canvas
      const width = 640
      const height = 360
      if (canvas.width !== width) canvas.width = width
      if (canvas.height !== height) canvas.height = height
      const context = canvas.getContext('2d', { alpha: false })
      if (!context) return
      context.fillStyle = '#000000'
      context.fillRect(0, 0, width, height)
      const scale = Math.min(width / video.videoWidth, height / video.videoHeight)
      const drawWidth = video.videoWidth * scale
      const drawHeight = video.videoHeight * scale
      const left = (width - drawWidth) / 2
      const top = (height - drawHeight) / 2
      context.drawImage(video, left, top, drawWidth, drawHeight)
      try {
        const dataUrl = canvas.toDataURL('image/jpeg', 0.72)
        lastFrameDataUrlRef.current = dataUrl
        window.api.sendToControl('capture-preview-frame', {
          sourceId: config.sourceId,
          dataUrl,
          state: latestStateRef.current
        })
      } catch { /* renderer may be closing */ }
    }

    const startFramePump = (): void => {
      clearFramePump()
      const video = videoRef.current
      if (!video) return
      if (video.requestVideoFrameCallback) {
        const tick = (now: number): void => {
          if (cancelled || generation !== generationRef.current) return
          drawPreview(now)
          frameCallbackRef.current = video.requestVideoFrameCallback!(tick)
        }
        frameCallbackRef.current = video.requestVideoFrameCallback(tick)
        return
      }
      const tick = (): void => {
        if (cancelled || generation !== generationRef.current) return
        drawPreview(performance.now())
        fallbackFrameTimerRef.current = setTimeout(tick, 100)
      }
      tick()
    }

    function scheduleReconnect(message: string): void {
      if (cancelled || generation !== generationRef.current) return
      clearMuteWatchdog()
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
      const delayMs = Math.min(30000, 2500 * (2 ** retryAttemptRef.current))
      retryAttemptRef.current += 1
      retryTimerRef.current = setTimeout(() => {
        emitState({
          status: 'reconnecting',
          message: isDesktopCapture
            ? `Повторное подключение ${desktopTarget}…`
            : 'Повторное подключение устройства…'
        })
        void openStream(true).catch(handleOpenError)
      }, delayMs)
      window.api.dbgLog(
        `Capture ${config.sourceId.slice(-8)}: reconnect scheduled delay=${delayMs}ms reason=${message}`
      )
    }

    async function openStream(isRetry = false): Promise<void> {
      if (cancelled || generation !== generationRef.current) return
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
      clearMuteWatchdog()
      clearFramePump()
      if (streamRef.current) showHeldFrame()
      stopStream(streamRef.current)
      streamRef.current = null
      setHasAudio(false)
      const video = videoRef.current
      if (video) video.srcObject = null
      emitState({
        status: isRetry ? 'reconnecting' : 'connecting',
        message: isRetry
          ? (isDesktopCapture ? `Повторное подключение ${desktopTarget}…` : 'Повторное подключение устройства…')
          : (isDesktopCapture ? `Подключение ${desktopTarget}…` : 'Подключение видеовхода…')
      })
      const startedAt = performance.now()

      let resolvedVideoDeviceId = config.videoDeviceId
      if (!isDesktopCapture) {
        try {
          const devices = (await navigator.mediaDevices.enumerateDevices())
            .filter((device) => device.kind === 'videoinput')
          if (!devices.some((device) => device.deviceId === resolvedVideoDeviceId)) {
            const replacement = (
              (config.videoGroupId
                ? devices.find((device) => device.groupId && device.groupId === config.videoGroupId)
                : undefined) ||
              devices.find((device) => device.label && device.label === config.videoLabel)
            )
            if (replacement) {
              resolvedVideoDeviceId = replacement.deviceId
              window.api.dbgLog(
                `Capture ${config.sourceId.slice(-8)}: recovered deviceId by ${replacement.groupId === config.videoGroupId ? 'group' : 'label'}`
              )
            }
          }
        } catch { /* getUserMedia below will report the actionable error */ }
      }

      if (isDesktopCapture && !config.desktopSourceId) {
        throw new Error('Источник окна или экрана не выбран.')
      }
      if (
        isDesktopCapture &&
        config.desktopSourceType &&
        !config.desktopSourceId?.startsWith(`${config.desktopSourceType}:`)
      ) {
        throw new Error('Windows не подтвердила источник для захвата.')
      }
      if (!isDesktopCapture && !resolvedVideoDeviceId) {
        throw new Error('Устройство видеозахвата не выбрано.')
      }

      const videoConstraints: MediaTrackConstraints = isDesktopCapture
        ? ({
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: config.desktopSourceId,
              // 4K preserves text/detail on typical presentation outputs while
              // avoiding an 8K compositor stream for every prewarmed source.
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
      const audioConstraints: MediaTrackConstraints | false = !isDesktopCapture && config.audioEnabled && config.audioDeviceId
        ? {
            deviceId: { exact: config.audioDeviceId },
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
          }
        : false

      let stream: MediaStream
      let audioWarning: string | undefined
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: audioConstraints })
      } catch (firstError) {
        if (isDesktopCapture || !config.audioEnabled) throw firstError
        // A missing/blocked HDMI audio endpoint must not discard a healthy
        // video signal. Continue video-only and surface a clear warning.
        audioWarning = 'Видео подключено, но звук устройства недоступен.'
        stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false })
      }

      if (cancelled || generation !== generationRef.current) {
        stopStream(stream)
        return
      }

      streamRef.current = stream
      const videoTrack = stream.getVideoTracks()[0]
      if (!videoTrack) throw new Error(isDesktopCapture
        ? 'Источник не передал изображение.'
        : 'Устройство не передало видеодорожку.')
      if (isDesktopCapture) videoTrack.contentHint = 'detail'
      const audioAvailable = stream.getAudioTracks().length > 0
      const audioTrack = stream.getAudioTracks()[0]
      const isAudioCurrentlyAvailable = (): boolean => (
        !!audioTrack && audioTrack.readyState === 'live' && !audioTrack.muted
      )
      setHasAudio(isAudioCurrentlyAvailable())

      videoTrack.onmute = () => {
        showHeldFrame()
        emitState({
          status: 'muted',
          message: isDesktopCapture
            ? 'Изображение временно недоступно. Проверьте, не свёрнуто ли окно.'
            : 'Видеосигнал временно отсутствует.'
        })
        window.api.dbgLog(`Capture ${config.sourceId.slice(-8)}: video track muted`)
        clearMuteWatchdog()
        if (isDesktopCapture) return
        muteWatchdogRef.current = setTimeout(() => {
          if (cancelled || generation !== generationRef.current) return
          emitState({ status: 'reconnecting', message: 'Сигнал не восстановился. Переподключение устройства…' })
          window.api.dbgLog(`Capture ${config.sourceId.slice(-8)}: mute watchdog reconnect`)
          void openStream(true).catch(handleOpenError)
        }, 6000)
      }
      videoTrack.onunmute = () => {
        clearMuteWatchdog()
        const settings = videoTrack.getSettings()
        emitState({
          status: 'ready',
          width: settings.width,
          height: settings.height,
          frameRate: settings.frameRate,
          hasAudio: isAudioCurrentlyAvailable(),
          message: audioWarning || (
            config.audioEnabled && !isAudioCurrentlyAvailable()
              ? 'Видео подключено, но аудиосигнал отсутствует.'
              : undefined
          )
        })
        window.api.dbgLog(`Capture ${config.sourceId.slice(-8)}: video track unmuted`)
      }
      videoTrack.onended = () => {
        showHeldFrame()
        clearMuteWatchdog()
        const message = isDesktopCapture
          ? 'Источник закрыт или отключён. Добавьте его заново.'
          : 'Устройство отключено. Ожидается повторное подключение.'
        emitState({ status: 'ended', message })
        rejectFrameWaiters(message)
        if (!isDesktopCapture) scheduleReconnect(message)
      }

      if (audioTrack) {
        audioTrack.onmute = () => {
          setHasAudio(false)
          const settings = videoTrack.getSettings()
          emitState({
            status: 'ready',
            width: settings.width,
            height: settings.height,
            frameRate: settings.frameRate,
            hasAudio: false,
            message: 'Видео подключено, но аудиосигнал временно отсутствует.'
          })
        }
        audioTrack.onunmute = () => {
          setHasAudio(true)
          const settings = videoTrack.getSettings()
          emitState({
            status: 'ready',
            width: settings.width,
            height: settings.height,
            frameRate: settings.frameRate,
            hasAudio: true,
            message: audioWarning
          })
        }
        audioTrack.onended = () => {
          setHasAudio(false)
          const message = 'Аудиовход отключён. Видеосигнал продолжает работать.'
          emitState({ status: 'ready', hasAudio: false, message })
        }
      }

      const outputVideo = videoRef.current
      if (!outputVideo) throw new Error('Не удалось создать видеоповерхность.')
      outputVideo.srcObject = stream
      // Start muted so Chromium can begin decoding without a gesture. The
      // separate active/hasAudio effect unmutes only the on-air layer.
      outputVideo.muted = true
      await outputVideo.play()
      startFramePump()
      await waitForNextFrame()
      if (cancelled || generation !== generationRef.current) return
      retryAttemptRef.current = 0

      const settings = videoTrack.getSettings()
      emitState({
        status: 'ready',
        width: settings.width,
        height: settings.height,
        frameRate: settings.frameRate,
        hasAudio: isAudioCurrentlyAvailable(),
        message: audioWarning || (
          config.audioEnabled && !isAudioCurrentlyAvailable()
            ? 'Видео подключено, но аудиосигнал отсутствует.'
            : undefined
        )
      })
      window.api.dbgLog(
        `Capture ${config.sourceId.slice(-8)}: ready label=${config.videoLabel} ` +
        `size=${settings.width ?? '-'}x${settings.height ?? '-'} fps=${settings.frameRate ?? '-'} ` +
        `audio=${audioAvailable} ms=${(performance.now() - startedAt).toFixed(0)}`
      )
    }

    function handleOpenError(error: unknown): void {
      const message = describeMediaError(error, isDesktopCapture)
      showHeldFrame()
      clearFramePump()
      clearMuteWatchdog()
      stopStream(streamRef.current)
      streamRef.current = null
      if (videoRef.current) videoRef.current.srcObject = null
      emitState({ status: 'error', message })
      rejectFrameWaiters(message)
      window.api.dbgLog(`Capture ${config.sourceId.slice(-8)}: open error=${message}`)
      const errorName = error instanceof DOMException ? error.name : ''
      if (!isDesktopCapture && errorName !== 'NotAllowedError' && errorName !== 'SecurityError') {
        scheduleReconnect(message)
      }
    }

    void openStream().catch(handleOpenError)

    return () => {
      cancelled = true
      generationRef.current += 1
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
      clearFramePump()
      clearMuteWatchdog()
      rejectFrameWaiters('Источник был отключён.')
      stopStream(streamRef.current)
      streamRef.current = null
      if (videoRef.current) videoRef.current.srcObject = null
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
    emitState,
    rejectFrameWaiters,
    resolveFrameWaiters,
    waitForNextFrame
  ])

  useEffect(() => {
    if (takeRevision === undefined || handledTakeRevisionRef.current === takeRevision) return
    handledTakeRevisionRef.current = takeRevision
    let cancelled = false
    const prepareTake = async (): Promise<void> => {
      const video = videoRef.current
      const alreadyHasUsableFrame = (
        latestStateRef.current.status === 'ready' &&
        !!lastFrameDataUrlRef.current &&
        !!video &&
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
      )
      if (alreadyHasUsableFrame) {
        // A static desktop window may not emit a new frame just because the
        // operator pressed TAKE. Its already-decoded warm frame is valid; two
        // animation frames are enough to align the layer swap with Chromium.
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        })
      } else {
        // Cold Windows Graphics Capture streams for Office/Terminal commonly
        // need a little over seven seconds on slower PCs. This waiter must be
        // longer than openStream's own 12-second first-frame budget; otherwise
        // TAKE can abort milliseconds before the source reports ready.
        await waitForNextFrame(14000)
      }
      if (!cancelled) onTakeReady(config.sourceId, takeRevision)
    }
    void prepareTake().catch((error) => {
      if (!cancelled) onTakeError(
        config.sourceId,
        takeRevision,
        describeMediaError(error, isDesktopCapture)
      )
    })
    return () => { cancelled = true }
  }, [config.sourceId, isDesktopCapture, onTakeError, onTakeReady, takeRevision, waitForNextFrame])

  useEffect(() => {
    return window.api.on('capture-source-state-request', (...args: unknown[]) => {
      const sourceId = args[0] as string
      if (sourceId === config.sourceId) {
        window.api.sendToControl('capture-source-state', latestStateRef.current)
        if (lastFrameDataUrlRef.current) {
          window.api.sendToControl('capture-preview-frame', {
            sourceId: config.sourceId,
            dataUrl: lastFrameDataUrlRef.current,
            state: latestStateRef.current
          })
        }
      }
    })
  }, [config.sourceId])

  return (
    <div
      className="absolute inset-0 flex items-center justify-center bg-black"
      style={{
        opacity: active ? 1 : 0,
        zIndex: active ? 2 : 0,
        pointerEvents: 'none'
      }}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={!audioActive || !hasAudio}
        className="w-full h-full object-contain bg-black select-none"
      />
      <img
        ref={holdImageRef}
        alt="Последний кадр источника"
        draggable={false}
        className="absolute inset-0 w-full h-full object-contain bg-black opacity-0 select-none"
      />
    </div>
  )
}

export function CaptureHub({
  activeSourceId,
  audioSourceId,
  takeRequest,
  onTakeReady,
  onTakeError
}: CaptureHubProps): JSX.Element {
  const [sources, setSources] = useState<CaptureSourceConfig[]>([])

  useEffect(() => {
    const unsubRegister = window.api.on('capture-source-register', (...args: unknown[]) => {
      const config = args[0] as CaptureSourceConfig
      const hasTarget = config?.captureKind === 'desktop'
        ? !!config.desktopSourceId
        : !!config?.videoDeviceId
      if (!config?.sourceId || !hasTarget) return
      setSources((current) => {
        const index = current.findIndex((item) => item.sourceId === config.sourceId)
        if (index < 0) return [...current, config]
        const next = [...current]
        next[index] = config
        return next
      })
      window.api.dbgLog(`CaptureHub: register source=${config.sourceId.slice(-8)} label=${config.videoLabel}`)
    })

    const unsubUnregister = window.api.on('capture-source-unregister', (...args: unknown[]) => {
      const sourceId = args[0] as string
      setSources((current) => current.filter((item) => item.sourceId !== sourceId))
      window.api.dbgLog(`CaptureHub: unregister source=${sourceId?.slice(-8) ?? '-'}`)
    })

    const unsubDevices = window.api.on('capture-devices-request', (...args: unknown[]) => {
      const request = args[0] as CaptureDevicesRequest
      if (!request?.requestId) return
      void enumerateCaptureDevices(request.requestId).then((response) => {
        window.api.sendToControl('capture-devices-response', response)
        window.api.dbgLog(
          `CaptureHub: devices response video=${response.devices.filter((d) => d.kind === 'videoinput').length} ` +
          `audio=${response.devices.filter((d) => d.kind === 'audioinput').length} error=${response.error ?? '-'}`
        )
      })
    })

    const handleDeviceChange = (): void => {
      window.api.sendToControl('capture-devices-changed')
      window.api.dbgLog('CaptureHub: mediaDevices devicechange')
    }
    navigator.mediaDevices?.addEventListener?.('devicechange', handleDeviceChange)
    window.api.sendToControl('capture-hub-ready')

    return () => {
      unsubRegister()
      unsubUnregister()
      unsubDevices()
      navigator.mediaDevices?.removeEventListener?.('devicechange', handleDeviceChange)
    }
  }, [])

  return (
    <>
      {sources.map((config) => (
        <CaptureSourceLayer
          key={config.sourceId}
          config={config}
          active={activeSourceId === config.sourceId}
          audioActive={audioSourceId === config.sourceId}
          takeRevision={takeRequest?.sourceId === config.sourceId ? takeRequest.revision : undefined}
          onTakeReady={onTakeReady}
          onTakeError={onTakeError}
        />
      ))}
    </>
  )
}
