import { useEffect, useRef, useState } from 'react'
import { mediaUrl } from '../../media'

interface VideoViewerProps {
  filePath: string
  startTime?: number
  autoplay?: boolean
  onReady?: () => void
}

export function VideoViewer({ filePath, startTime = 0, autoplay = true, onReady }: VideoViewerProps): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady
  const [isPlaying, setIsPlaying] = useState(false)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    let readySent = false
    let playRequested = false
    let disposed = false
    const fileName = filePath.split(/[\\/]/).pop() || filePath

    const sendContentReady = (waitForVideoFrame = true): void => {
      if (readySent || disposed) return
      readySent = true
      window.api.dbgLog(`VideoViewer: content-ready file=${fileName} time=${video.currentTime.toFixed(3)} readyState=${video.readyState}`)
      const notifyAfterPaint = (): void => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (!disposed) {
              if (onReadyRef.current) onReadyRef.current()
              else window.api.sendToControl('presentation-content-ready')
            }
          })
        })
      }
      // Wait for an actual decoded frame to enter Chromium's compositor.
      if (waitForVideoFrame && typeof video.requestVideoFrameCallback === 'function') {
        video.requestVideoFrameCallback(() => notifyAfterPaint())
      } else {
        notifyAfterPaint()
      }
    }

    const handleCanPlay = (): void => {
      if (playRequested || disposed) return
      playRequested = true
      window.api.dbgLog(`VideoViewer: canplay file=${fileName} readyState=${video.readyState} networkState=${video.networkState}`)
      if (!autoplay) {
        video.pause()
        setIsPlaying(false)
        window.api.sendToControl('video-state', {
          path: filePath,
          playing: false,
          duration: video.duration,
          currentTime: video.currentTime
        })
        if (startTime <= 0.05 || video.currentTime <= 0.05) sendContentReady(false)
        return
      }
      const p = video.play()
      if (p && typeof p.then === 'function') {
        p.catch((error) => {
          if (disposed) return
          window.api.dbgLog(`VideoViewer: play rejected file=${fileName} error=${String(error)}`)
          setIsPlaying(false)
          window.api.sendToControl('video-state', {
            path: filePath,
            playing: false,
            duration: video.duration,
            currentTime: video.currentTime
          })
        })
      }
    }

    const handlePlaying = (): void => {
      if (disposed) return
      window.api.dbgLog(`VideoViewer: playing file=${fileName} time=${video.currentTime.toFixed(3)}`)
      setIsPlaying(true)
      window.api.sendToControl('video-state', {
        path: filePath,
        playing: true,
        duration: video.duration,
        currentTime: video.currentTime
      })
      sendContentReady()
    }

    const handleLoadedData = (): void => {
      window.api.dbgLog(`VideoViewer: loadeddata file=${fileName} readyState=${video.readyState}`)
      if (!autoplay && (startTime <= 0.05 || video.currentTime <= 0.05)) sendContentReady(false)
    }

    const handleLoadedMetadata = (): void => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0
      const resumeAt = duration > 0
        ? Math.min(Math.max(startTime, 0), Math.max(0, duration - 0.05))
        : Math.max(startTime, 0)
      if (resumeAt > 0.05) {
        window.api.dbgLog(`VideoViewer: seek resume file=${fileName} time=${resumeAt.toFixed(3)}`)
        video.currentTime = resumeAt
      }
    }

    const handleSeeked = (): void => {
      window.api.dbgLog(`VideoViewer: seeked file=${fileName} time=${video.currentTime.toFixed(3)}`)
      if (!autoplay) sendContentReady(false)
    }

    const handleError = (): void => {
      const mediaError = video.error
      window.api.dbgLog(`VideoViewer: error file=${fileName} code=${mediaError?.code ?? '-'} message=${mediaError?.message || '-'}`)
    }

    // Subscribe BEFORE src/load. A cached local file can emit `canplay`
    // immediately; the old A→B→A path subscribed afterwards and missed it,
    // leaving the returned video paused on a black frame.
    video.addEventListener('canplay', handleCanPlay, { once: true })
    video.addEventListener('playing', handlePlaying, { once: true })
    video.addEventListener('loadedmetadata', handleLoadedMetadata, { once: true })
    video.addEventListener('loadeddata', handleLoadedData, { once: true })
    video.addEventListener('seeked', handleSeeked, { once: true })
    video.addEventListener('error', handleError)
    window.api.dbgLog(`VideoViewer: load BEGIN file=${fileName} startTime=${startTime.toFixed(3)} autoplay=${autoplay}`)
    video.src = mediaUrl(filePath)
    video.load()

    return () => {
      disposed = true
      video.removeEventListener('canplay', handleCanPlay)
      video.removeEventListener('playing', handlePlaying)
      video.removeEventListener('loadedmetadata', handleLoadedMetadata)
      video.removeEventListener('loadeddata', handleLoadedData)
      video.removeEventListener('seeked', handleSeeked)
      video.removeEventListener('error', handleError)
      const finalTime = Number.isFinite(video.currentTime) ? video.currentTime : 0
      const finalDuration = Number.isFinite(video.duration) ? video.duration : 0
      const wasPlaying = !video.paused && !video.ended
      window.api.sendToControl('video-state', {
        path: filePath,
        playing: wasPlaying,
        duration: finalDuration,
        currentTime: finalTime,
        ended: video.ended
      })
      video.pause()
      video.removeAttribute('src')
      video.load()
      window.api.dbgLog(`VideoViewer: cleanup file=${fileName}`)
    }
  }, [filePath, startTime, autoplay])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const interval = setInterval(() => {
      if (!video.paused) {
        window.api.sendToControl('video-time', {
          path: filePath,
          currentTime: video.currentTime,
          duration: video.duration
        })
      }
    }, 500)

    return () => clearInterval(interval)
  }, [filePath])

  useEffect(() => {
    const unsubPlayPause = window.api.on('play-pause', (...args: unknown[]) => {
      const shouldPlay = args[0] as boolean
      const video = videoRef.current
      if (!video) return

      if (shouldPlay) {
        const playPromise = video.play()
        if (playPromise && typeof playPromise.then === 'function') {
          playPromise.then(() => {
            setIsPlaying(true)
            window.api.sendToControl('video-state', {
              path: filePath,
              playing: true,
              duration: video.duration,
              currentTime: video.currentTime
            })
          }).catch((error) => {
            setIsPlaying(false)
            window.api.dbgLog(`VideoViewer: resume rejected file=${filePath.split(/[\\/]/).pop() || filePath} error=${String(error)}`)
            window.api.sendToControl('video-state', {
              path: filePath,
              playing: false,
              duration: video.duration,
              currentTime: video.currentTime
            })
          })
        }
      } else {
        video.pause()
        setIsPlaying(false)
        window.api.sendToControl('video-state', {
          path: filePath,
          playing: false,
          duration: video.duration,
          currentTime: video.currentTime
        })
      }
    })

    const unsubStop = window.api.on('stop', () => {
      const video = videoRef.current
      if (!video) return
      video.pause()
      video.currentTime = 0
      setIsPlaying(false)
      window.api.sendToControl('video-state', {
        path: filePath,
        playing: false,
        duration: video.duration,
        currentTime: 0
      })
    })

    const unsubSeek = window.api.on('seek', (...args: unknown[]) => {
      const time = args[0] as number
      const video = videoRef.current
      if (video) {
        video.currentTime = time
        window.api.sendToControl('video-time', {
          path: filePath,
          currentTime: time,
          duration: video.duration
        })
      }
    })

    const unsubVolume = window.api.on('set-volume', (...args: unknown[]) => {
      const volume = args[0] as number
      const video = videoRef.current
      if (video) {
        video.volume = volume
      }
    })

    const unsubLoop = window.api.on('set-loop', (...args: unknown[]) => {
      const loop = args[0] as boolean
      const video = videoRef.current
      if (video) {
        video.loop = loop
      }
    })

    return () => {
      unsubPlayPause()
      unsubStop()
      unsubSeek()
      unsubVolume()
      unsubLoop()
    }
  }, [filePath])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      const video = videoRef.current
      if (!video) return

      if (e.key === ' ') {
        e.preventDefault()
        if (video.paused) {
          video.play()
          setIsPlaying(true)
        } else {
          video.pause()
          setIsPlaying(false)
        }
        window.api.sendToControl('video-state', {
          path: filePath,
          playing: !video.paused,
          duration: video.duration,
          currentTime: video.currentTime
        })
      } else if (e.key === 'Escape') {
        window.api.sendToControl('request-close-presentation')
      } else if (e.key === 'ArrowRight') {
        video.currentTime = Math.min(video.currentTime + 5, video.duration)
        window.api.sendToControl('video-time', {
          path: filePath,
          currentTime: video.currentTime,
          duration: video.duration
        })
      } else if (e.key === 'ArrowLeft') {
        video.currentTime = Math.max(video.currentTime - 5, 0)
        window.api.sendToControl('video-time', {
          path: filePath,
          currentTime: video.currentTime,
          duration: video.duration
        })
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [filePath])

  const handleVideoEnded = (): void => {
    setIsPlaying(false)
    window.api.sendToControl('video-state', {
      path: filePath,
      playing: false,
      duration: videoRef.current?.duration || 0,
      currentTime: videoRef.current?.duration || 0,
      ended: true
    })
    // Сигнал для плейлиста в control — переключает на след. ролик.
    // Не вызывается когда video.loop=true (браузер не шлёт 'ended' при loop).
    window.api.sendToControl('video-ended', { path: filePath })
  }

  return (
    <div className="w-full h-full flex items-center justify-center bg-black">
      <video
        ref={videoRef}
        className="w-full h-full object-contain"
        onEnded={handleVideoEnded}
        preload="auto"
        playsInline
      />
    </div>
  )
}
