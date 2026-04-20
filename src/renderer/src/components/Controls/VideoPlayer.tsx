import { useState, useEffect, useRef, useCallback } from 'react'
import { useAppStore } from '../../stores/useAppStore'

function basename(p: string): string {
  return p.split(/[\\/]/).pop() || p
}

function stripExt(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.substring(0, i) : name
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.substring(i).toLowerCase() : ''
}

export function VideoPlayer(): JSX.Element {
  const playlist = useAppStore((s) => s.videoPlaylist)
  const currentIndex = useAppStore((s) => s.videoCurrentIndex)
  const isPlaying = useAppStore((s) => s.videoIsPlaying)
  const loopTrack = useAppStore((s) => s.videoLoopTrack)
  const loopPlaylist = useAppStore((s) => s.videoLoopPlaylist)
  const setPlaylist = useAppStore((s) => s.setVideoPlaylist)
  const setCurrentIndex = useAppStore((s) => s.setVideoCurrentIndex)
  const setIsPlayingStore = useAppStore((s) => s.setVideoIsPlaying)
  const setLoopTrackStore = useAppStore((s) => s.setVideoLoopTrack)
  const setLoopPlaylistStore = useAppStore((s) => s.setVideoLoopPlaylist)

  const activeFile = useAppStore((s) => s.activeFile)
  const setActiveFile = useAppStore((s) => s.setActiveFile)
  const isPresentationWindowOpen = useAppStore((s) => s.isPresentationWindowOpen)
  const setPresentationWindowOpen = useAppStore((s) => s.setPresentationWindowOpen)
  const selectedDisplayId = useAppStore((s) => s.selectedDisplayId)

  const [expanded, setExpanded] = useState(false)
  const [showMenu, setShowMenu] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const panelRef = useRef<HTMLDivElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Close panel on outside click
  useEffect(() => {
    if (!expanded) return
    const handleClick = (e: MouseEvent): void => {
      if (
        panelRef.current && !panelRef.current.contains(e.target as Node) &&
        toggleRef.current && !toggleRef.current.contains(e.target as Node)
      ) {
        setExpanded(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [expanded])

  useEffect(() => {
    if (!showMenu) return
    const handleClick = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showMenu])

  const playTrack = useCallback(async (index: number): Promise<void> => {
    const { videoPlaylist } = useAppStore.getState()
    if (index < 0 || index >= videoPlaylist.length) return
    const path = videoPlaylist[index]
    const filename = basename(path)
    const fileEntry: FileEntry = {
      id: `video-playlist-${Date.now()}`,
      name: stripExt(filename),
      path,
      type: 'video',
      extension: extOf(filename),
      size: 0
    }

    if (!useAppStore.getState().isPresentationWindowOpen) {
      await window.api.openPresentationWindow(selectedDisplayId ?? undefined)
      setPresentationWindowOpen(true)
      await new Promise((r) => setTimeout(r, 300))
    }

    setActiveFile(fileEntry)
    useAppStore.setState({ liveChannel: null })
    setCurrentIndex(index)
    setIsPlayingStore(true)

    window.api.sendToPresentation('load-content', {
      type: 'video',
      path,
      name: filename
    })

    // Apply loopTrack to video element (video.loop = true → browser handles repeat natively)
    const { videoLoopTrack } = useAppStore.getState()
    setTimeout(() => {
      window.api.sendToPresentation('set-loop', videoLoopTrack)
    }, 250)
  }, [selectedDisplayId, setActiveFile, setCurrentIndex, setIsPlayingStore, setPresentationWindowOpen])

  // Подписка на video-time/video-state от VideoViewer для seek bar.
  // Эти же события слушает ControlBar — они broadcast'ятся обоим,
  // два независимых слушателя друг другу не мешают.
  useEffect(() => {
    const unsubTime = window.api.on('video-time', (...args: unknown[]) => {
      const data = args[0] as { currentTime: number; duration: number }
      setCurrentTime(data.currentTime)
      if (data.duration && !isNaN(data.duration)) setDuration(data.duration)
    })
    const unsubState = window.api.on('video-state', (...args: unknown[]) => {
      const data = args[0] as { playing: boolean; duration: number; currentTime: number }
      setCurrentTime(data.currentTime)
      if (data.duration && !isNaN(data.duration)) setDuration(data.duration)
    })
    return () => {
      unsubTime()
      unsubState()
    }
  }, [])

  // Reset seek when track changes
  useEffect(() => {
    setCurrentTime(0)
    setDuration(0)
  }, [currentIndex])

  // Listen for video end — auto-advance playlist
  useEffect(() => {
    const unsub = window.api.on('video-ended', () => {
      const st = useAppStore.getState()
      // Только если текущее активное видео — из нашего плейлиста
      if (!st.activeFile || st.activeFile.type !== 'video') return
      const idx = st.videoCurrentIndex
      if (idx < 0 || idx >= st.videoPlaylist.length) return
      if (st.activeFile.path !== st.videoPlaylist[idx]) return

      // loopTrack handled via video.loop — 'ended' не прилетает. Но подстрахуемся.
      if (st.videoLoopTrack) {
        playTrack(idx)
        return
      }
      if (idx < st.videoPlaylist.length - 1) {
        playTrack(idx + 1)
      } else if (st.videoLoopPlaylist && st.videoPlaylist.length > 0) {
        playTrack(0)
      } else {
        setIsPlayingStore(false)
      }
    })
    return unsub
  }, [playTrack, setIsPlayingStore])

  // Sync isPlaying flag when activeFile changes away from video playlist
  useEffect(() => {
    if (!activeFile || activeFile.type !== 'video') {
      if (isPlaying) setIsPlayingStore(false)
      return
    }
    const currentPlaylistTrack = playlist[currentIndex]
    if (activeFile.path !== currentPlaylistTrack && isPlaying) {
      setIsPlayingStore(false)
    }
  }, [activeFile, playlist, currentIndex, isPlaying, setIsPlayingStore])

  const handleSelectFiles = async (): Promise<void> => {
    setShowMenu(false)
    const files = await window.api.selectVideoFiles()
    if (files && files.length > 0) {
      setPlaylist(files)
      setCurrentIndex(0)
    }
  }

  const handleSelectFolder = async (): Promise<void> => {
    setShowMenu(false)
    const files = await window.api.selectVideoFolder()
    if (files && files.length > 0) {
      setPlaylist(files)
      setCurrentIndex(0)
    }
  }

  const handlePlay = async (): Promise<void> => {
    if (playlist.length === 0) return
    // Если активное видео то же что текущий трек — продолжить; иначе запустить
    const currentTrack = playlist[currentIndex]
    if (activeFile?.type === 'video' && activeFile.path === currentTrack) {
      window.api.sendToPresentation('play-pause', true)
      setIsPlayingStore(true)
    } else {
      await playTrack(currentIndex)
    }
  }

  const handlePause = (): void => {
    window.api.sendToPresentation('play-pause', false)
    setIsPlayingStore(false)
  }

  const handleStop = (): void => {
    window.api.sendToPresentation('stop')
    setIsPlayingStore(false)
  }

  const handleNext = async (): Promise<void> => {
    if (playlist.length === 0) return
    const next = (currentIndex + 1) % playlist.length
    await playTrack(next)
  }

  const handlePrev = async (): Promise<void> => {
    if (playlist.length === 0) return
    const prev = (currentIndex - 1 + playlist.length) % playlist.length
    await playTrack(prev)
  }

  const handleToggleLoopTrack = (): void => {
    const newVal = !loopTrack
    setLoopTrackStore(newVal)
    // Немедленно применяем к текущему видео, если играет
    if (activeFile?.type === 'video') {
      window.api.sendToPresentation('set-loop', newVal)
    }
  }

  const handleToggleLoopPlaylist = (): void => {
    setLoopPlaylistStore(!loopPlaylist)
  }

  const trackName = playlist[currentIndex] ? basename(playlist[currentIndex]) : ''
  const liveIcon = isPlaying ? '▶' : '🎬'

  const formatTime = (s: number): string => {
    if (!isFinite(s) || s < 0) s = 0
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60)
    return `${m}:${sec.toString().padStart(2, '0')}`
  }

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const time = parseFloat(e.target.value)
    setCurrentTime(time)
    window.api.sendToPresentation('seek', time)
  }

  return (
    <>
      <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <button
          ref={toggleRef}
          onClick={() => setExpanded(!expanded)}
          className={`text-xs px-2 py-1.5 rounded-lg font-medium transition-colors border ${
            isPlaying
              ? 'bg-blue-600/80 hover:bg-blue-600 text-white border-transparent'
              : 'bg-surface-100 text-gray-300 hover:bg-gray-700 border-gray-700'
          }`}
          title="Плейлист видео"
        >
          {liveIcon} Видео
        </button>

        {playlist.length > 0 && (
          <>
            {!isPlaying ? (
              <button onClick={handlePlay} className="btn-icon text-[10px] text-green-400" title="Воспроизвести">▶</button>
            ) : (
              <button onClick={handlePause} className="btn-icon text-[10px] text-yellow-400" title="Пауза">⏸</button>
            )}
            <button onClick={handleStop} className="btn-icon text-[10px] text-red-400" title="Стоп">⏹</button>
          </>
        )}
      </div>

      {expanded && (
        <div
          ref={panelRef}
          className="absolute top-10 left-1/2 -translate-x-1/2 bg-surface-100 border border-gray-700 rounded-lg shadow-xl p-3 z-50 min-w-[380px] max-w-[460px]"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <div className="text-[11px] text-gray-400 font-bold uppercase mb-2">Плейлист видео</div>

          <div className="flex items-center gap-2 mb-3 relative">
            <button
              onClick={() => setShowMenu(!showMenu)}
              className="text-[10px] px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors"
            >
              Выбор видео ▾
            </button>
            {showMenu && (
              <div ref={menuRef} className="absolute top-full left-0 mt-1 bg-surface-200 border border-gray-600 rounded shadow-lg z-50 overflow-hidden">
                <button onClick={handleSelectFiles} className="block w-full text-left text-[10px] px-3 py-1.5 text-gray-300 hover:bg-gray-600 transition-colors whitespace-nowrap">
                  Выбрать файлы
                </button>
                <button onClick={handleSelectFolder} className="block w-full text-left text-[10px] px-3 py-1.5 text-gray-300 hover:bg-gray-600 transition-colors whitespace-nowrap">
                  Выбрать папку
                </button>
              </div>
            )}
            {playlist.length > 0 && (
              <span className="text-[10px] text-gray-500">
                {playlist.length} {playlist.length === 1 ? 'ролик' : playlist.length < 5 ? 'ролика' : 'роликов'}
              </span>
            )}
          </div>

          {/* Now playing — имя ролика */}
          <div className="text-[10px] text-gray-300 mb-1 truncate h-4" title={trackName}>
            {trackName ? `${currentIndex + 1}/${playlist.length} — ${trackName}` : '\u00A0'}
          </div>

          {/* Seek bar — всегда видимая */}
          <div className="flex items-center gap-2 mb-2 h-5">
            <input
              type="range"
              min={0}
              max={duration > 0 ? duration : 100}
              step={0.5}
              value={currentTime}
              onChange={handleSeek}
              disabled={duration === 0}
              className="flex-1 h-1 accent-blue-500 disabled:opacity-30"
            />
            <span className="text-[10px] text-gray-500 whitespace-nowrap w-[82px] text-right tabular-nums">
              {duration > 0 ? `${formatTime(currentTime)} / ${formatTime(duration)}` : '0:00 / 0:00'}
            </span>
          </div>

          {/* Controls */}
          <div className="flex items-center gap-1 mb-2">
            <button onClick={handlePrev} disabled={playlist.length === 0} className="text-sm w-8 h-8 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors disabled:opacity-30" title="Предыдущий">⏮</button>
            {isPlaying ? (
              <button onClick={handlePause} className="text-sm w-8 h-8 rounded bg-yellow-700 hover:bg-yellow-600 text-white transition-colors" title="Пауза">⏸</button>
            ) : (
              <button onClick={handlePlay} disabled={playlist.length === 0} className="text-sm w-8 h-8 rounded bg-green-700 hover:bg-green-600 text-white transition-colors disabled:opacity-30" title="Воспроизвести">▶</button>
            )}
            <button onClick={handleStop} className="text-sm w-8 h-8 rounded bg-red-700 hover:bg-red-600 text-white transition-colors" title="Стоп">⏹</button>
            <button onClick={handleNext} disabled={playlist.length === 0} className="text-sm w-8 h-8 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors disabled:opacity-30" title="Следующий">⏭</button>

            <div className="w-px h-6 bg-gray-600 mx-1" />

            <button
              onClick={handleToggleLoopTrack}
              className={`text-sm w-8 h-8 rounded transition-colors ${
                loopTrack ? 'bg-blue-600/80 hover:bg-blue-600 text-white' : 'bg-gray-700 hover:bg-gray-600 text-gray-300'
              }`}
              title={loopTrack ? 'Зацикливание ролика ВКЛ' : 'Зацикливание ролика'}
            >🔂</button>
            <button
              onClick={handleToggleLoopPlaylist}
              className={`text-sm w-8 h-8 rounded transition-colors ${
                loopPlaylist ? 'bg-blue-600/80 hover:bg-blue-600 text-white' : 'bg-gray-700 hover:bg-gray-600 text-gray-300'
              }`}
              title={loopPlaylist ? 'Зацикливание плейлиста ВКЛ' : 'Зацикливание плейлиста'}
            >🔁</button>
          </div>

          {/* Track list */}
          {playlist.length > 0 && (
            <div className="border-t border-gray-700 pt-2 mt-1 max-h-[220px] overflow-y-auto">
              {playlist.map((path, i) => (
                <div
                  key={path}
                  onClick={() => playTrack(i)}
                  className={`text-[10px] px-2 py-1 rounded cursor-pointer truncate transition-colors ${
                    i === currentIndex && isPlaying
                      ? 'bg-blue-800/40 text-blue-300'
                      : i === currentIndex
                      ? 'bg-gray-700/50 text-gray-200'
                      : 'text-gray-400 hover:bg-gray-700/50 hover:text-gray-200'
                  }`}
                  title={basename(path)}
                >
                  <span className="text-gray-600 mr-1">{i + 1}.</span>
                  {basename(path)}
                </div>
              ))}
            </div>
          )}

          <button
            onClick={() => setExpanded(false)}
            className="absolute top-2 right-2 text-gray-500 hover:text-white text-sm"
          >✕</button>
        </div>
      )}
    </>
  )
}
