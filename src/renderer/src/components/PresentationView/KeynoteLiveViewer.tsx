import { useEffect, useRef, useState } from 'react'
import { acquireKeynoteCapture } from '../../keynote-capture-pool'
import { hasNativeSlideResolution, type PresentationCaptureProfile } from '../../../../shared/presentation-output'

interface KeynoteLiveViewerProps {
  sourceId: string
  onReady: () => void
  onError: (message: string) => void
  roundedContent?: boolean
  sourceLabel?: string
  crop?: { x: number; y: number; width: number; height: number }
  filePath?: string
  captureProfile?: PresentationCaptureProfile
}

export function KeynoteLiveViewer({ sourceId, onReady, onError, roundedContent = false, sourceLabel = 'Keynote', crop,
  filePath, captureProfile }: KeynoteLiveViewerProps): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const freezeRef = useRef<HTMLCanvasElement>(null)
  const holdingFrame = useRef(false)
  const [frozen, setFrozen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ width: 0, height: 0 })
  const [sourceSize, setSourceSize] = useState({ width: 0, height: 0 })
  const [signalLost, setSignalLost] = useState(false)
  const [captureRevision, setCaptureRevision] = useState(0)
  const recovery = useRef({ sourceId: '', started: 0, attempts: 0 })
  const everReady = useRef(false)
  const onReadyRef = useRef(onReady)
  const onErrorRef = useRef(onError)
  const profileRef = useRef(captureProfile)
  profileRef.current = captureProfile
  onReadyRef.current = onReady
  onErrorRef.current = onError

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const update = (): void => setViewport({ width: container.clientWidth, height: container.clientHeight })
    const observer = new ResizeObserver(update)
    observer.observe(container)
    update()
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const track = (videoRef.current?.srcObject as MediaStream | null)?.getVideoTracks()[0]
    if (!track || !captureProfile) return
    // Changing the output mode must not blank a live slide. Update the same
    // track while Keynote's resized backing surface starts delivering frames.
    void track.applyConstraints({ width: { max: Math.max(8192, captureProfile.width) },
      height: { max: Math.max(8192, captureProfile.height) }, frameRate: { max: captureProfile.frameRate } })
      .catch((error) => window.api.dbgLog(`Keynote capture constraints update failed: ${String(error)}`))
  }, [captureProfile?.width, captureProfile?.height, captureProfile?.frameRate])

  useEffect(() => {
    if (!captureProfile || !filePath || sourceSize.width < 1 || sourceSize.height < 1) return
    const native = !signalLost && hasNativeSlideResolution(sourceSize, captureProfile)
    const quality = { path: filePath, sourceWidth: sourceSize.width, sourceHeight: sourceSize.height,
      requiredWidth: captureProfile.width, requiredHeight: captureProfile.height, native, lost: signalLost }
    window.api.sendToControl('keynote-capture-quality', quality)
    window.api.dbgLog(`PPTX capture ${native ? 'native' : 'UPSCALED'}: ${sourceSize.width}x${sourceSize.height} ` +
      `required=${captureProfile.width}x${captureProfile.height} display=${captureProfile.displayId}`)
  }, [captureProfile?.width, captureProfile?.height, captureProfile?.displayId, filePath, sourceSize.width, sourceSize.height, signalLost])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    let disposed = false
    let stream: MediaStream | null = null
    let releaseCapture: (() => void) | undefined
    let captureRetired = (): boolean => false
    const trackListeners: {track: MediaStreamTrack; event: string; listener: () => void}[] = []
    let frameCallback = 0
    let recoveryTimer: number | undefined
    let ready = false
    let playbackStarted = false
    const needsNativeRefresh = sourceLabel === 'Keynote' && window.api.platform === 'darwin'
    const refreshRequestId = needsNativeRefresh ? crypto.randomUUID() : undefined
    let refreshComplete = !needsNativeRefresh
    const holdLastFrame = (): void => {
      const canvas = freezeRef.current
      if (holdingFrame.current || !canvas || video.videoWidth < 16 || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return
      try {
        canvas.width = video.videoWidth; canvas.height = video.videoHeight
        const context = canvas.getContext('2d')
        if (!context) return
        context.drawImage(video, 0, 0)
        holdingFrame.current = true; setFrozen(true)
      } catch { /* the capturer may already have released its final frame */ }
    }
    const recoverNativePlayer = (): void => {
      if (sourceLabel === 'Keynote' && !captureRetired()) window.api.sendToControl('keynote-capture-lost', { sourceId })
    }
    const recoverEndedCapture = (): void => {
      if (disposed) return
      if (sourceLabel === 'Keynote' && captureRetired()) return
      holdLastFrame()
      setSignalLost(true)
      if (sourceLabel !== 'Keynote' || captureRetired()) return
      const now = Date.now()
      if (recovery.current.sourceId !== sourceId || now - recovery.current.started > 60_000) {
        recovery.current = { sourceId, started: now, attempts: 0 }
      }
      if (recovery.current.attempts >= 3) return
      const attempt = ++recovery.current.attempts
      recoverNativePlayer()
      window.api.dbgLog(`Keynote capture ended; reconnect source=${sourceId} attempt=${attempt}`)
      recoveryTimer = window.setTimeout(() => {
        if (!disposed && !captureRetired()) setCaptureRevision(value => value + 1)
      }, attempt * 250)
    }
    const updateSize = (): void => {
      if (video.videoWidth < 16 || video.videoHeight < 16) {
        if (ready) setSignalLost(true)
        return
      }
      setSignalLost(false)
      setSourceSize({ width: video.videoWidth, height: video.videoHeight })
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) firstFrame()
    }
    video.addEventListener('resize', updateSize)
    const fail = (error: unknown): void => {
      if (disposed || ready) return
      if (!everReady.current) onErrorRef.current(String(error))
      else {
        holdLastFrame()
        setSignalLost(true)
        window.api.dbgLog(`Keynote live capture reconnect failed: ${String(error)}`)
        recoverNativePlayer()
      }
    }
    const firstFrame = (): void => {
      if (disposed || ready || !refreshComplete || (needsNativeRefresh && !playbackStarted) || video.videoWidth < 16 || video.videoHeight < 16 ||
        video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return
      setSourceSize({ width: video.videoWidth, height: video.videoHeight })
      setSignalLost(false)
      everReady.current = true
      holdingFrame.current = false; setFrozen(false)
      ready = true
      if (needsNativeRefresh) window.api.dbgLog(`Keynote first frame ready after native redraw source=${sourceId}`)
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (!disposed) onReadyRef.current()
      }))
    }
    // The native refresh resizes the player twice to make a static slide
    // repaint. Its intermediate frame must stay behind the transition cover.
    // Static captures may not emit another frame after the completion ACK;
    // use their already-painted current frame once geometry has settled.
    const offRefreshed = needsNativeRefresh ? window.api.on('keynote-capture-refreshed', (...args: unknown[]) => {
      const result = args[0] as { sourceId?: string; requestId?: string; success?: boolean; error?: string } | undefined
      if (disposed || result?.sourceId !== sourceId || result.requestId !== refreshRequestId) return
      if (!result.success) { fail(result.error || 'Keynote не закончил перерисовку первого кадра'); return }
      refreshComplete = true
      firstFrame()
    }) : undefined
    const open = async (): Promise<void> => {
      try {
        const constraints = {
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: sourceId,
              // Do not reduce a native 5K/8K window to the old 4096x2160 cap.
              // Width/height are ceilings only: they never manufacture detail
              // by forcing a smaller source to upscale inside the capturer.
              maxWidth: Math.max(8192, profileRef.current?.width || 0),
              maxHeight: Math.max(8192, profileRef.current?.height || 0),
              maxFrameRate: profileRef.current?.frameRate || 60
            }
          } as unknown as MediaTrackConstraints,
          audio: false
        }
        if (sourceLabel === 'Keynote') {
          const lease = await acquireKeynoteCapture(sourceId, profileRef.current)
          stream = lease.stream
          releaseCapture = lease.release
          captureRetired = lease.isRetired
        } else stream = await navigator.mediaDevices.getUserMedia(constraints)
        if (disposed) {
          if (releaseCapture) releaseCapture()
          else stream.getTracks().forEach((track) => track.stop())
          return
        }
        for (const track of stream.getVideoTracks()) {
          for (const [event, listener] of Object.entries({
            ended: recoverEndedCapture,
            mute: () => { if (!disposed && ready) setSignalLost(true) },
            unmute: () => { if (!disposed) updateSize() }
          })) {
            track.addEventListener(event, listener)
            trackListeners.push({track, event, listener})
          }
        }
        video.srcObject = stream
        if (sourceLabel === 'Keynote') window.api.sendToControl('keynote-capture-started', { sourceId,
          ...(refreshRequestId ? { requestId: refreshRequestId } : {}) })
        await video.play()
        playbackStarted = true
        // play() resolves after the first frame is available. A static slide
        // may never produce another frame, so registering a frame callback
        // only now can wait forever even though the slide is ready to show.
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth >= 16 && video.videoHeight >= 16) {
          firstFrame()
        } else if (typeof video.requestVideoFrameCallback === 'function') {
          frameCallback = video.requestVideoFrameCallback(() => firstFrame())
        } else {
          video.addEventListener('loadeddata', firstFrame, { once: true })
        }
      } catch (error) { fail(error) }
    }
    void open()
    const timeout = window.setTimeout(() => fail(`${sourceLabel} не передал кадр за 8 секунд`), 8_000)
    return () => {
      disposed = true
      offRefreshed?.()
      if (recoveryTimer) clearTimeout(recoveryTimer)
      clearTimeout(timeout)
      video.removeEventListener('loadeddata', firstFrame)
      video.removeEventListener('resize', updateSize)
      if (frameCallback && typeof video.cancelVideoFrameCallback === 'function') {
        video.cancelVideoFrameCallback(frameCallback)
      }
      video.pause()
      video.srcObject = null
      for (const {track, event, listener} of trackListeners) track.removeEventListener(event, listener)
      if (releaseCapture) releaseCapture()
      else stream?.getTracks().forEach((track) => track.stop())
    }
  }, [sourceId, sourceLabel, captureRevision])

  let cropStyle: React.CSSProperties | undefined
  let cropContainerStyle: React.CSSProperties | undefined
  if (crop && sourceSize.width > 0 && viewport.width > 0 && crop.width > 0 && crop.height > 0) {
    const contentWidth = sourceSize.width * crop.width
    const contentHeight = sourceSize.height * crop.height
    const scale = Math.min(viewport.width / contentWidth, viewport.height / contentHeight)
    const width = sourceSize.width * scale
    const height = sourceSize.height * scale
    cropContainerStyle = { position: 'absolute', width: contentWidth * scale, height: contentHeight * scale,
      left: (viewport.width - contentWidth * scale) / 2,
      top: (viewport.height - contentHeight * scale) / 2 }
    cropStyle = { position: 'absolute', width, height,
      left: -crop.x * width, top: -crop.y * height,
      maxWidth: 'none', objectFit: 'fill' }
  }
  return <div ref={containerRef} className="relative h-full w-full overflow-hidden bg-black"
    style={{ borderRadius: roundedContent ? '1.25rem' : 0 }}><div
      className="relative h-full w-full overflow-hidden" style={cropContainerStyle}><video
    ref={videoRef}
    autoPlay
    playsInline
    muted
    className="h-full w-full object-contain bg-black select-none"
    style={cropStyle}
  /><canvas ref={freezeRef} className="absolute inset-0 h-full w-full object-contain pointer-events-none"
    style={{ ...cropStyle, display: frozen ? 'block' : 'none' }} /></div></div>
}
