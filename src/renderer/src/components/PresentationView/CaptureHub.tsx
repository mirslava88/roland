import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import type { ProgramSceneChromaKeyConfig } from '../../../../shared/program-scene'
import { ChromaKeyRenderer } from '../Capture/chroma-key-renderer'
import { canvasToDataUrl } from '../../canvas-export'

export interface CaptureTakeRequest {
  sourceId: string
  revision: number
}

interface CaptureHubProps {
  activeSourceId: string | null
  audioSourceId: string | null
  activeSceneStyle?: CSSProperties
  activeZoomStyle?: CSSProperties
  sceneSourceId?: string | null
  backgroundSourceId?: string | null
  sceneStyle?: CSSProperties
  backgroundSceneStyle?: CSSProperties
  sceneChromaKey: ProgramSceneChromaKeyConfig
  onActiveAspectRatio?: (sourceId: string, aspectRatio: number) => void
  takeRequest: CaptureTakeRequest | null
  onTakeReady: (sourceId: string, revision: number) => void
  onTakeError: (sourceId: string, revision: number, message: string) => void
}

interface CaptureDevicesRequest {
  requestId: string
  includeAudio?: boolean
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

function getUserMediaWithTimeout(
  constraints: MediaStreamConstraints,
  timeoutMs: number,
  timeoutMessage: string
): Promise<MediaStream> {
  return new Promise<MediaStream>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(timeoutMessage))
    }, timeoutMs)

    void navigator.mediaDevices.getUserMedia(constraints).then((stream) => {
      if (settled) {
        // getUserMedia cannot be aborted. If Windows eventually completes a
        // request which PDM already timed out, release it instead of leaving a
        // hidden camera stream alive and starving the next attempt.
        stopStream(stream)
        return
      }
      settled = true
      clearTimeout(timer)
      resolve(stream)
    }, (error: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
  })
}

function configuredVideoDeviceAvailable(
  config: CaptureSourceConfig,
  devices: MediaDeviceInfo[]
): boolean {
  if (config.captureKind !== 'device') return true
  const videoDevices = devices.filter((device) => device.kind === 'videoinput')
  return videoDevices.some((device) => (
    device.deviceId === config.videoDeviceId ||
    (!!config.videoGroupId && !!device.groupId && device.groupId === config.videoGroupId) ||
    (!!config.videoLabel && !!device.label && device.label === config.videoLabel)
  ))
}

async function enumerateCaptureDevices(requestId: string, includeAudio = false): Promise<CaptureDevicesResponse> {
  if (!navigator.mediaDevices?.enumerateDevices || !navigator.mediaDevices?.getUserMedia) {
    return { requestId, devices: [], error: 'Захват видео не поддерживается на этом компьютере.' }
  }

  let probe: MediaStream | null = null
  let permissionError: string | undefined
  let audioPermissionError: string | undefined
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
    // Only an explicit audio-picker action may unlock microphone labels.
    // This probe never plays audio and is released immediately.
    if (includeAudio) {
      const devices = await navigator.mediaDevices.enumerateDevices()
      if (!devices.some((device) => device.kind === 'audioinput' && device.label)) {
        let audioProbe: MediaStream | null = null
        try {
          audioProbe = await navigator.mediaDevices.getUserMedia({ video: false, audio: true })
        } catch {
          audioPermissionError = 'Нет доступа к аудиовходу. Проверьте разрешение на микрофон.'
        } finally { stopStream(audioProbe) }
      }
    }
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
      error: hasVideo ? audioPermissionError : permissionError || 'Камеры и платы видеозахвата не найдены.'
    }
  } catch (error) {
    return { requestId, devices: [], error: permissionError || describeMediaError(error) }
  }
}

function CaptureSourceLayer({
  config,
  displayMode,
  activeSceneStyle,
  activeZoomStyle,
  sceneStyle,
  backgroundSceneStyle,
  sceneChromaKey,
  onAspectRatio,
  audioActive,
  deviceRevision,
  onStateChange,
  takeRevision,
  onTakeReady,
  onTakeError
}: {
  config: CaptureSourceConfig
  displayMode: 'hidden' | 'fullscreen' | 'content' | 'scene' | 'background'
  activeSceneStyle?: CSSProperties
  activeZoomStyle?: CSSProperties
  sceneStyle?: CSSProperties
  backgroundSceneStyle?: CSSProperties
  sceneChromaKey: ProgramSceneChromaKeyConfig
  onAspectRatio?: (sourceId: string, aspectRatio: number) => void
  audioActive: boolean
  deviceRevision: number
  onStateChange: (state: CaptureSourceState) => void
  takeRevision?: number
  onTakeReady: (sourceId: string, revision: number) => void
  onTakeError: (sourceId: string, revision: number, message: string) => void
}): JSX.Element {
  const isDesktopCapture = config.captureKind === 'desktop'
  const reconnectRevision = isDesktopCapture ? 0 : deviceRevision
  const desktopTarget = config.desktopSourceType === 'screen' ? 'экрана' : 'окна'
  const videoRef = useRef<VideoWithFrameCallbacks>(null)
  const holdImageRef = useRef<HTMLImageElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const chromaCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const chromaRendererRef = useRef<ChromaKeyRenderer | null>(null)
  const chromaReadyRef = useRef(false)
  const generationRef = useRef(0)
  const retryAttemptRef = useRef(0)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const muteWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const frameStallWatchdogRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const lastDecodedFrameAtRef = useRef(0)
  const lastVideoTimeRef = useRef(-1)
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
  const [chromaReady, setChromaReady] = useState(false)
  const chromaActive = displayMode === 'scene' && !isDesktopCapture && sceneChromaKey.enabled

  useEffect(() => {
    chromaReadyRef.current = chromaReady
  }, [chromaReady])

  useEffect(() => {
    if (!chromaActive) {
      chromaRendererRef.current?.dispose()
      chromaRendererRef.current = null
      chromaReadyRef.current = false
      setChromaReady(false)
      return
    }

    let cancelled = false
    let videoFrameHandle: number | null = null
    let animationFrameHandle: number | null = null
    let reportedFailure = false
    const video = videoRef.current
    const canvas = chromaCanvasRef.current
    if (!video || !canvas) return

    const draw = (): void => {
      if (cancelled || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return
      try {
        const renderer = chromaRendererRef.current ?? new ChromaKeyRenderer(canvas)
        chromaRendererRef.current = renderer
        if (renderer.draw(video, sceneChromaKey) && !chromaReadyRef.current) {
          chromaReadyRef.current = true
          setChromaReady(true)
        }
      } catch (error) {
        if (!reportedFailure) {
          reportedFailure = true
          window.api.dbgLog(`Capture ${config.sourceId.slice(-8)}: chroma key unavailable: ${String(error)}`)
        }
      }
    }

    if (video.requestVideoFrameCallback) {
      const tick = (): void => {
        if (cancelled) return
        draw()
        videoFrameHandle = video.requestVideoFrameCallback!(tick)
      }
      videoFrameHandle = video.requestVideoFrameCallback(tick)
    } else {
      const tick = (): void => {
        if (cancelled) return
        draw()
        animationFrameHandle = requestAnimationFrame(tick)
      }
      animationFrameHandle = requestAnimationFrame(tick)
    }

    return () => {
      cancelled = true
      if (videoFrameHandle !== null && video.cancelVideoFrameCallback) {
        video.cancelVideoFrameCallback(videoFrameHandle)
      }
      if (animationFrameHandle !== null) cancelAnimationFrame(animationFrameHandle)
    }
  }, [chromaActive, config.sourceId, sceneChromaKey])

  useEffect(() => () => {
    chromaRendererRef.current?.dispose()
    chromaRendererRef.current = null
  }, [])

  const emitState = useCallback((state: Omit<CaptureSourceState, 'sourceId'>): void => {
    const nextState: CaptureSourceState = { sourceId: config.sourceId, ...state }
    latestStateRef.current = nextState
    onStateChange(nextState)
    window.api.sendToControl('capture-source-state', nextState)
  }, [config.sourceId, onStateChange])

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
    let openAttempt = 0
    let previewEncoding = false

    const isStaleOpen = (attempt: number): boolean => (
      cancelled || generation !== generationRef.current || attempt !== openAttempt
    )

    function beginOpen(isRetry = false): void {
      const attempt = ++openAttempt
      void openStream(isRetry, attempt).catch((error) => handleOpenError(error, attempt))
    }

    const clearFramePump = (): void => {
      const video = videoRef.current
      if (frameCallbackRef.current !== null && video?.cancelVideoFrameCallback) {
        video.cancelVideoFrameCallback(frameCallbackRef.current)
      }
      frameCallbackRef.current = null
      if (fallbackFrameTimerRef.current) clearTimeout(fallbackFrameTimerRef.current)
      fallbackFrameTimerRef.current = null
      if (frameStallWatchdogRef.current) clearInterval(frameStallWatchdogRef.current)
      frameStallWatchdogRef.current = null
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
      if (previewEncoding || now - lastPreviewAtRef.current < 330) return
      lastPreviewAtRef.current = now

      const canvas = canvasRef.current || document.createElement('canvas')
      canvasRef.current = canvas
      // Preserve the source aspect ratio: baking a 4:3/portrait camera into a
      // black 16:9 frame makes PiP crop/scale those bars along with the image.
      // Keep the same thumbnail pixel budget and cadence as before.
      const scale = Math.min(640 / video.videoWidth, 360 / video.videoHeight)
      const width = Math.max(1, Math.round(video.videoWidth * scale))
      const height = Math.max(1, Math.round(video.videoHeight * scale))
      if (canvas.width !== width) canvas.width = width
      if (canvas.height !== height) canvas.height = height
      const context = canvas.getContext('2d', { alpha: false })
      if (!context) return
      context.fillStyle = '#000000'
      context.fillRect(0, 0, width, height)
      context.drawImage(video, 0, 0, width, height)
      // Do not queue more frames while encoding is pending, and never publish
      // a delayed frame after reconnecting the source or closing the renderer.
      previewEncoding = true
      const attempt = openAttempt
      void canvasToDataUrl(canvas, 'image/jpeg', 0.72).then((dataUrl) => {
        if (isStaleOpen(attempt)) return
        lastFrameDataUrlRef.current = dataUrl
        window.api.sendToControl('capture-preview-frame', {
          sourceId: config.sourceId,
          dataUrl,
          state: latestStateRef.current
        })
      }).catch(() => { /* renderer may be closing */ }).finally(() => {
        previewEncoding = false
      })
    }

    const startFramePump = (): void => {
      clearFramePump()
      const video = videoRef.current
      if (!video) return
      lastDecodedFrameAtRef.current = performance.now()
      lastVideoTimeRef.current = video.currentTime
      if (!isDesktopCapture) {
        frameStallWatchdogRef.current = setInterval(() => {
          if (cancelled || generation !== generationRef.current) return
          const status = latestStateRef.current.status
          if (status !== 'ready' && status !== 'muted') return
          const stalledForMs = performance.now() - lastDecodedFrameAtRef.current
          if (stalledForMs < 4_500) return
          showHeldFrame()
          emitState({
            status: 'reconnecting',
            message: 'Камера перестала передавать изображение. Переподключение…'
          })
          window.api.dbgLog(
            `Capture ${config.sourceId.slice(-8)}: frame stall ${Math.round(stalledForMs)}ms; reconnecting`
          )
          beginOpen(true)
        }, 1_000)
      }
      if (video.requestVideoFrameCallback) {
        const tick = (now: number): void => {
          if (cancelled || generation !== generationRef.current) return
          // A decoder-owned frame really arrived. Keep this independent from
          // the throttled JPEG preview cadence.
          lastDecodedFrameAtRef.current = performance.now()
          drawPreview(now)
          frameCallbackRef.current = video.requestVideoFrameCallback!(tick)
        }
        frameCallbackRef.current = video.requestVideoFrameCallback(tick)
        return
      }
      const tick = (): void => {
        if (cancelled || generation !== generationRef.current) return
        if (video.currentTime !== lastVideoTimeRef.current) {
          lastVideoTimeRef.current = video.currentTime
          lastDecodedFrameAtRef.current = performance.now()
        }
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
      emitState({
        status: 'reconnecting',
        message: isDesktopCapture
          ? `Ожидание ${desktopTarget}…`
          : 'Устройство не подключено. Ожидание подключения…'
      })
      retryTimerRef.current = setTimeout(() => {
        emitState({
          status: 'reconnecting',
          message: isDesktopCapture
            ? `Повторное подключение ${desktopTarget}…`
            : 'Повторное подключение устройства…'
        })
        beginOpen(true)
      }, delayMs)
      window.api.dbgLog(
        `Capture ${config.sourceId.slice(-8)}: reconnect scheduled delay=${delayMs}ms reason=${message}`
      )
    }

    async function openStream(isRetry: boolean, attempt: number): Promise<void> {
      if (isStaleOpen(attempt)) return
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
      clearMuteWatchdog()
      clearFramePump()
      const replacingLiveStream = !!streamRef.current
      if (replacingLiveStream) showHeldFrame()
      stopStream(streamRef.current)
      streamRef.current = null
      setHasAudio(false)
      const video = videoRef.current
      if (video) {
        video.pause()
        video.srcObject = null
        video.load()
      }
      emitState({
        status: isRetry ? 'reconnecting' : 'connecting',
        message: isRetry
          ? (isDesktopCapture ? `Повторное подключение ${desktopTarget}…` : 'Повторное подключение устройства…')
          : (isDesktopCapture ? `Подключение ${desktopTarget}…` : 'Подключение видеовхода…')
      })
      const startedAt = performance.now()

      // Several UVC drivers do not release their Media Foundation buffers in
      // the same task in which the old track is stopped. Reopening immediately
      // can then hang forever in getUserMedia and leave the UI on
      // "Подключение". Give Windows a short, bounded release interval.
      if (!isDesktopCapture && (replacingLiveStream || isRetry)) {
        await new Promise<void>((resolve) => setTimeout(resolve, 650))
        if (isStaleOpen(attempt)) return
      }

      let resolvedVideoDeviceId = config.videoDeviceId
      let resolvedAudioDeviceId = config.audioDeviceId
      if (!isDesktopCapture) {
        try {
          const devices = await navigator.mediaDevices.enumerateDevices()
          if (isStaleOpen(attempt)) return
          const videoDevices = devices.filter((device) => device.kind === 'videoinput')
          if (!videoDevices.some((device) => device.deviceId === resolvedVideoDeviceId)) {
            const replacement = (
              (config.videoGroupId
                ? videoDevices.find((device) => device.groupId && device.groupId === config.videoGroupId)
                : undefined) ||
              videoDevices.find((device) => device.label && device.label === config.videoLabel)
            )
            if (replacement) {
              resolvedVideoDeviceId = replacement.deviceId
              window.api.dbgLog(
                `Capture ${config.sourceId.slice(-8)}: recovered deviceId by ${replacement.groupId === config.videoGroupId ? 'group' : 'label'}`
              )
            }
          }
          if (config.audioEnabled && resolvedAudioDeviceId) {
            const audioDevices = devices.filter((device) => device.kind === 'audioinput')
            if (!audioDevices.some((device) => device.deviceId === resolvedAudioDeviceId)) {
              const replacement = (
                (config.audioGroupId
                  ? audioDevices.find((device) => device.groupId && device.groupId === config.audioGroupId)
                  : undefined) ||
                (config.audioLabel
                  ? audioDevices.find((device) => device.label && device.label === config.audioLabel)
                  : undefined)
              )
              if (replacement) {
                resolvedAudioDeviceId = replacement.deviceId
                window.api.dbgLog(
                  `Capture ${config.sourceId.slice(-8)}: recovered audio deviceId by ${replacement.groupId === config.audioGroupId ? 'group' : 'label'}`
                )
              }
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
      const audioConstraints: MediaTrackConstraints | false = !isDesktopCapture && config.audioEnabled && resolvedAudioDeviceId
        ? {
            deviceId: { exact: resolvedAudioDeviceId },
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
          }
        : false

      let stream: MediaStream
      let audioWarning: string | undefined
      try {
        window.api.dbgLog(`Capture ${config.sourceId.slice(-8)}: getUserMedia BEGIN attempt=${attempt}`)
        stream = await getUserMediaWithTimeout(
          { video: videoConstraints, audio: audioConstraints },
          10_000,
          'Камера не ответила за 10 секунд. Выполняется повторное подключение.'
        )
        window.api.dbgLog(`Capture ${config.sourceId.slice(-8)}: getUserMedia END attempt=${attempt}`)
      } catch (firstError) {
        if (isStaleOpen(attempt)) throw firstError
        if (isDesktopCapture || !config.audioEnabled) throw firstError
        // A missing/blocked HDMI audio endpoint must not discard a healthy
        // video signal. Continue video-only and surface a clear warning.
        audioWarning = 'Видео подключено, но звук устройства недоступен.'
        stream = await getUserMediaWithTimeout(
          { video: videoConstraints, audio: false },
          10_000,
          'Камера не ответила за 10 секунд. Выполняется повторное подключение.'
        )
      }

      if (isStaleOpen(attempt)) {
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
          beginOpen(true)
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
      if (isStaleOpen(attempt)) return
      retryAttemptRef.current = 0

      const settings = videoTrack.getSettings()
      const frameWidth = outputVideo.videoWidth || settings.width
      const frameHeight = outputVideo.videoHeight || settings.height
      if (frameWidth && frameHeight) onAspectRatio?.(config.sourceId, frameWidth / frameHeight)
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

    function handleOpenError(error: unknown, attempt: number): void {
      // Replacing a MediaStream rejects the old video.play() promise with
      // AbortError ("interrupted by a new load"). That cancelled attempt must
      // never overwrite the state of the replacement stream.
      if (isStaleOpen(attempt)) return
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

    beginOpen()

    return () => {
      cancelled = true
      openAttempt += 1
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
    config.videoGroupId,
    config.desktopSourceId,
    config.desktopSourceType,
    config.desktopDisplayId,
    config.audioEnabled,
    config.audioDeviceId,
    config.audioGroupId,
    config.audioLabel,
    reconnectRevision,
    emitState,
    rejectFrameWaiters,
    resolveFrameWaiters,
    waitForNextFrame,
    onAspectRatio
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
      className={`absolute flex items-center justify-center overflow-hidden shadow-2xl ${chromaActive && chromaReady ? 'bg-transparent' : 'bg-black'}`}
      style={{
        ...(displayMode === 'scene'
          ? sceneStyle
          : displayMode === 'background'
            ? (backgroundSceneStyle ?? { inset: 0 })
          : displayMode === 'content'
            ? activeSceneStyle
            : { inset: 0 }),
        opacity: displayMode === 'hidden'
          ? 0
          : displayMode === 'scene'
            ? sceneStyle?.opacity ?? 1
            : displayMode === 'background'
              ? backgroundSceneStyle?.opacity ?? 1
            : displayMode === 'content'
              ? activeSceneStyle?.opacity ?? 1
              : 1,
        zIndex: displayMode === 'scene' ? 4 : displayMode === 'background' ? 3 : displayMode === 'fullscreen' ? 2 : displayMode === 'content' ? 1 : 0,
        pointerEvents: 'none',
        borderRadius: displayMode === 'scene'
          ? (sceneStyle?.borderRadius ?? '0.5rem')
          : displayMode === 'background'
            ? (backgroundSceneStyle?.borderRadius ?? '0.5rem')
          : displayMode === 'content'
            ? (activeSceneStyle?.borderRadius ?? '0.5rem')
            : 0
      }}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={!audioActive || !hasAudio}
        className={`w-full h-full bg-black select-none ${(displayMode === 'scene' && !isDesktopCapture) || displayMode === 'background' ? 'object-cover' : 'object-contain'}`}
        style={{
          ...(displayMode === 'content' || displayMode === 'fullscreen' ? activeZoomStyle : undefined),
          opacity: chromaActive && chromaReady ? 0 : 1
        }}
      />
      <canvas
        ref={chromaCanvasRef}
        data-chroma-key-canvas="program"
        className={`absolute inset-0 h-full w-full select-none object-cover ${chromaActive && chromaReady ? 'opacity-100' : 'opacity-0'}`}
      />
      <img
        ref={holdImageRef}
        alt="Последний кадр источника"
        draggable={false}
        className={`absolute inset-0 w-full h-full bg-black opacity-0 select-none ${(displayMode === 'scene' && !isDesktopCapture) || displayMode === 'background' ? 'object-cover' : 'object-contain'}`}
        style={{
          ...(displayMode === 'content' || displayMode === 'fullscreen' ? activeZoomStyle : undefined),
          visibility: chromaActive && chromaReady ? 'hidden' : 'visible'
        }}
      />
    </div>
  )
}

export function CaptureHub({
  activeSourceId,
  audioSourceId,
  activeSceneStyle,
  activeZoomStyle,
  sceneSourceId = null,
  backgroundSourceId = null,
  sceneStyle,
  backgroundSceneStyle,
  sceneChromaKey,
  onActiveAspectRatio,
  takeRequest,
  onTakeReady,
  onTakeError
}: CaptureHubProps): JSX.Element {
  const [sources, setSources] = useState<CaptureSourceConfig[]>([])
  const [deviceRevisions, setDeviceRevisions] = useState<Record<string, number>>({})
  const sourcesRef = useRef<CaptureSourceConfig[]>([])
  const sourceStatesRef = useRef(new Map<string, CaptureSourceState>())
  const deviceAvailableRef = useRef(new Map<string, boolean>())

  useEffect(() => {
    sourcesRef.current = sources
  }, [sources])

  const rememberSourceState = useCallback((state: CaptureSourceState): void => {
    sourceStatesRef.current.set(state.sourceId, state)
    if (state.status === 'ready') deviceAvailableRef.current.set(state.sourceId, true)
  }, [])

  useEffect(() => {
    let disposed = false
    let deviceChangeTimer: ReturnType<typeof setTimeout> | null = null
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
      sourceStatesRef.current.delete(sourceId)
      deviceAvailableRef.current.delete(sourceId)
      setDeviceRevisions((current) => {
        if (!(sourceId in current)) return current
        const next = { ...current }
        delete next[sourceId]
        return next
      })
      window.api.dbgLog(`CaptureHub: unregister source=${sourceId?.slice(-8) ?? '-'}`)
    })

    const unsubReconnect = window.api.on('capture-source-reconnect', (...args: unknown[]) => {
      const sourceId = args[0] as string
      if (!sourceId || !sourcesRef.current.some((source) => (
        source.sourceId === sourceId && source.captureKind === 'device'
      ))) return
      setDeviceRevisions((current) => ({
        ...current,
        [sourceId]: (current[sourceId] ?? 0) + 1
      }))
      window.api.dbgLog(`CaptureHub: explicit reconnect source=${sourceId.slice(-8)}`)
    })

    const unsubDevices = window.api.on('capture-devices-request', (...args: unknown[]) => {
      const request = args[0] as CaptureDevicesRequest
      if (!request?.requestId) return
      void enumerateCaptureDevices(request.requestId, request.includeAudio === true).then((response) => {
        window.api.sendToControl('capture-devices-response', response)
        window.api.dbgLog(
          `CaptureHub: devices response video=${response.devices.filter((d) => d.kind === 'videoinput').length} ` +
          `audio=${response.devices.filter((d) => d.kind === 'audioinput').length} error=${response.error ?? '-'}`
        )
      })
    })

    const handleDeviceChange = (): void => {
      // Windows commonly emits a burst of devicechange events for one USB
      // transition (and also for unrelated audio endpoints). Coalesce the
      // burst, then restart only a source which actually returned or is
      // already known to be broken. A healthy camera must stay untouched.
      if (deviceChangeTimer) clearTimeout(deviceChangeTimer)
      deviceChangeTimer = setTimeout(() => {
        deviceChangeTimer = null
        if (disposed) return
        window.api.sendToControl('capture-devices-changed')
        void navigator.mediaDevices.enumerateDevices().then((devices) => {
          if (disposed) return
          const reconnectSourceIds: string[] = []
          for (const config of sourcesRef.current) {
            if (config.captureKind !== 'device') continue
            const available = configuredVideoDeviceAvailable(config, devices)
            const wasAvailable = deviceAvailableRef.current.get(config.sourceId)
            const status = sourceStatesRef.current.get(config.sourceId)?.status
            deviceAvailableRef.current.set(config.sourceId, available)
            const broken = status === 'error' || status === 'ended' ||
              status === 'reconnecting' || status === 'muted'
            if (available && (wasAvailable === false || broken)) {
              reconnectSourceIds.push(config.sourceId)
            }
          }
          if (reconnectSourceIds.length > 0) {
            setDeviceRevisions((current) => {
              const next = { ...current }
              for (const sourceId of reconnectSourceIds) {
                next[sourceId] = (next[sourceId] ?? 0) + 1
              }
              return next
            })
          }
          window.api.dbgLog(
            `CaptureHub: mediaDevices devicechange settled; reconnect=${reconnectSourceIds.length}`
          )
        }).catch((error) => {
          if (!disposed) window.api.dbgLog(`CaptureHub: devicechange enumeration failed=${String(error)}`)
        })
      }, 750)
    }
    navigator.mediaDevices?.addEventListener?.('devicechange', handleDeviceChange)
    window.api.sendToControl('capture-hub-ready')

    return () => {
      disposed = true
      if (deviceChangeTimer) clearTimeout(deviceChangeTimer)
      unsubRegister()
      unsubUnregister()
      unsubReconnect()
      unsubDevices()
      navigator.mediaDevices?.removeEventListener?.('devicechange', handleDeviceChange)
    }
  }, [])

  return (
    <>
      {sources.map((config) => {
        const displayMode = activeSourceId === config.sourceId
          ? activeSceneStyle ? 'content' : 'fullscreen'
          : sceneSourceId === config.sourceId
            ? 'scene'
            : backgroundSourceId === config.sourceId ? 'background' : 'hidden'
        const takeRevision = takeRequest?.sourceId === config.sourceId ? takeRequest.revision : undefined
        return (
          <CaptureSourceLayer
            key={config.sourceId}
            config={config}
            displayMode={displayMode}
            activeSceneStyle={activeSceneStyle}
            activeZoomStyle={activeZoomStyle}
            sceneStyle={sceneStyle}
            backgroundSceneStyle={backgroundSceneStyle}
            sceneChromaKey={sceneChromaKey}
            onAspectRatio={onActiveAspectRatio}
            audioActive={audioSourceId === config.sourceId}
            deviceRevision={deviceRevisions[config.sourceId] ?? 0}
            onStateChange={rememberSourceState}
            takeRevision={takeRevision}
            onTakeReady={onTakeReady}
            onTakeError={onTakeError}
          />
        )
      })}
    </>
  )
}
