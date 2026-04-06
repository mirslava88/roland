import { useEffect, useRef, useState } from 'react'

interface VideoViewerProps {
  filePath: string
}

export function VideoViewer({ filePath }: VideoViewerProps): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [isPlaying, setIsPlaying] = useState(false)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    video.src = `file://${filePath}`
    video.load()

    const handleCanPlay = (): void => {
      video.play()
      setIsPlaying(true)
      window.api.sendToControl('video-state', {
        playing: true,
        duration: video.duration,
        currentTime: 0
      })
    }

    video.addEventListener('canplay', handleCanPlay, { once: true })
    return () => video.removeEventListener('canplay', handleCanPlay)
  }, [filePath])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const interval = setInterval(() => {
      if (!video.paused) {
        window.api.sendToControl('video-time', {
          currentTime: video.currentTime,
          duration: video.duration
        })
      }
    }, 500)

    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    const unsubPlayPause = window.api.on('play-pause', (...args: unknown[]) => {
      const shouldPlay = args[0] as boolean
      const video = videoRef.current
      if (!video) return

      if (shouldPlay) {
        video.play()
        setIsPlaying(true)
      } else {
        video.pause()
        setIsPlaying(false)
      }
    })

    const unsubStop = window.api.on('stop', () => {
      const video = videoRef.current
      if (!video) return
      video.pause()
      video.currentTime = 0
      setIsPlaying(false)
    })

    const unsubSeek = window.api.on('seek', (...args: unknown[]) => {
      const time = args[0] as number
      const video = videoRef.current
      if (video) {
        video.currentTime = time
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
  }, [])

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
          playing: !video.paused,
          duration: video.duration,
          currentTime: video.currentTime
        })
      } else if (e.key === 'Escape') {
        window.api.sendToControl('request-close-presentation')
      } else if (e.key === 'ArrowRight') {
        video.currentTime = Math.min(video.currentTime + 5, video.duration)
      } else if (e.key === 'ArrowLeft') {
        video.currentTime = Math.max(video.currentTime - 5, 0)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const handleVideoEnded = (): void => {
    setIsPlaying(false)
    window.api.sendToControl('video-state', {
      playing: false,
      duration: videoRef.current?.duration || 0,
      currentTime: videoRef.current?.duration || 0
    })
  }

  return (
    <div className="w-full h-full flex items-center justify-center bg-black">
      <video
        ref={videoRef}
        className="w-full h-full object-contain"
        onEnded={handleVideoEnded}
        playsInline
      />
    </div>
  )
}
