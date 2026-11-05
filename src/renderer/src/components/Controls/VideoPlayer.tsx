import { useState, useEffect, useRef, useCallback } from 'react'
import { useAppStore } from '../../stores/useAppStore'
import { reconcileMediaFolderPlaylist, sameMediaPlaylist } from './media-folder-playlist'

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
  const folderPath = useAppStore((s) => s.videoFolderPath)
  const setFolderPath = useAppStore((s) => s.setVideoFolderPath)
  const currentIndex = useAppStore((s) => s.videoCurrentIndex)
  const isPlaying = useAppStore((s) => s.videoIsPlaying)
  const loopTrack = useAppStore((s) => s.videoLoopTrack)
  const loopPlaylist = useAppStore((s) => s.videoLoopPlaylist)
  const stopAfterTrack = useAppStore((s) => s.videoStopAfterTrack)
  const channelVideoAutoplay = useAppStore((s) => s.channelVideoAutoplay)
  const nextActions = useAppStore((s) => s.videoNextActions)
  const channels = useAppStore((s) => s.channels)
  const channelIds = useAppStore((s) => s.channelIds)
  const setPlaylist = useAppStore((s) => s.setVideoPlaylist)
  const setCurrentIndex = useAppStore((s) => s.setVideoCurrentIndex)
  const setIsPlayingStore = useAppStore((s) => s.setVideoIsPlaying)
  const setLoopTrackStore = useAppStore((s) => s.setVideoLoopTrack)
  const setLoopPlaylistStore = useAppStore((s) => s.setVideoLoopPlaylist)
  const setStopAfterTrackStore = useAppStore((s) => s.setVideoStopAfterTrack)
  const setChannelVideoAutoplay = useAppStore((s) => s.setChannelVideoAutoplay)
  const setNextAction = useAppStore((s) => s.setVideoNextAction)
  const movePlaylistItem = useAppStore((s) => s.moveVideoPlaylistItem)

  const activeFile = useAppStore((s) => s.activeFile)

  const [expanded, setExpanded] = useState(false)
  const [showMenu, setShowMenu] = useState(false)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  useEffect(() => {
    if (selectedPath && !playlist.includes(selectedPath)) setSelectedPath(null)
  }, [playlist, selectedPath])
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const returnChannelRef = useRef<string | null>(null)
  const dragIndexRef = useRef<number | null>(null)
  const handledEndedFileIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (!folderPath) return
    let cancelled = false
    let refreshing = false
    const refresh = async (): Promise<void> => {
      if (refreshing) return
      refreshing = true
      try {
        const files = await window.api.scanMediaFolder('video', folderPath)
        if (cancelled || !files || useAppStore.getState().videoFolderPath !== folderPath) return
        const state = useAppStore.getState()
        const loadedPath = state.activeFile?.type === 'video' && state.activeFile.id.startsWith('video-playlist-')
          ? state.activeFile.path : null
        const next = reconcileMediaFolderPlaylist(state.videoPlaylist, files, loadedPath)
        if (!sameMediaPlaylist(state.videoPlaylist, next)) setPlaylist(next)
      } finally {
        refreshing = false
      }
    }
    const timer = setInterval(() => { void refresh().catch(() => undefined) }, 2000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [folderPath, setPlaylist])

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
    const state = useAppStore.getState()
    const { videoPlaylist } = state
    if (index < 0 || index >= videoPlaylist.length) return
    if (state.activeFile?.id.startsWith('video-playlist-')) handledEndedFileIdRef.current = state.activeFile.id
    const path = videoPlaylist[index]
    setSelectedPath(path)
    const filename = basename(path)
    const fileEntry: FileEntry = {
      id: `video-playlist-${Date.now()}`,
      name: stripExt(filename),
      path,
      type: 'video',
      extension: extOf(filename),
      size: 0
    }

    // Remember the real channel that owned the air before this independent
    // playlist took over. Advancing within the playlist has liveChannel=null,
    // so it keeps the original return target intact.
    if (state.liveChannel && state.channels[state.liveChannel]?.file) {
      returnChannelRef.current = state.liveChannel
    }

    setCurrentIndex(index)
    setIsPlayingStore(false)

    // Route playlist playback through the same transactional TAKE pipeline as
    // channel content. It waits for the first decoded frame before releasing
    // PowerPoint/Word/Excel or the previous capture, so native windows cannot
    // remain above a video that is already playing underneath.
    window.dispatchEvent(new CustomEvent('take-playlist-video', {
      detail: {
        file: fileEntry,
        loop: useAppStore.getState().videoLoopTrack && !useAppStore.getState().videoStopAfterTrack
      }
    }))
  }, [setCurrentIndex, setIsPlayingStore])

  useEffect(() => {
    if (activeFile?.id !== handledEndedFileIdRef.current) handledEndedFileIdRef.current = null
  }, [activeFile?.id])

  const stopPlayback = useCallback((): void => {
    const state = useAppStore.getState()
    const playlistOwnsOutput =
      state.activeFile?.type === 'video' &&
      state.activeFile.id.startsWith('video-playlist-') &&
      state.liveChannel === null
    if (playlistOwnsOutput) window.api.sendToPresentation('stop')
    setIsPlayingStore(false)
    const returnChannel = playlistOwnsOutput ? returnChannelRef.current : null
    returnChannelRef.current = null
    if (!returnChannel || !state.channels[returnChannel]?.file) return

    state.setSelectedChannel(returnChannel)
    const returnIndex = state.channelIds.indexOf(returnChannel)
    if (returnIndex >= 0) {
      state.setCurrentChannelPage(Math.floor(returnIndex / state.channelGridSize))
    }
    window.dispatchEvent(new CustomEvent('take-channel', { detail: returnChannel }))
  }, [setIsPlayingStore])

  // Подписка на video-time/video-state от VideoViewer для seek bar.
  // Эти же события слушает ControlBar — они broadcast'ятся обоим,
  // два независимых слушателя друг другу не мешают.
  useEffect(() => {
    const unsubTime = window.api.on('video-time', (...args: unknown[]) => {
      if (!useAppStore.getState().activeFile?.id.startsWith('video-playlist-')) return
      const data = args[0] as { path?: string; currentTime: number; duration: number }
      const active = useAppStore.getState().activeFile
      if (active?.type !== 'video' || (data.path && data.path !== active.path)) return
      setCurrentTime(data.currentTime)
      if (data.duration && !isNaN(data.duration)) setDuration(data.duration)
    })
    const unsubState = window.api.on('video-state', (...args: unknown[]) => {
      if (!useAppStore.getState().activeFile?.id.startsWith('video-playlist-')) return
      const data = args[0] as { path?: string; playing: boolean; duration: number; currentTime: number }
      const active = useAppStore.getState().activeFile
      if (active?.type !== 'video' || (data.path && data.path !== active.path)) return
      setCurrentTime(data.currentTime)
      if (data.duration && !isNaN(data.duration)) setDuration(data.duration)
      setIsPlayingStore(data.playing)
    })
    return () => {
      unsubTime()
      unsubState()
    }
  }, [setIsPlayingStore])

  // Reset seek when track changes
  useEffect(() => {
    setCurrentTime(0)
    setDuration(0)
  }, [currentIndex])

  // Listen for video end — auto-advance playlist
  useEffect(() => {
    const unsub = window.api.on('video-ended', (...args: unknown[]) => {
      const st = useAppStore.getState()
      // A video assigned to a channel has its own explicit end target. The
      // channel grid owns that transition; the independent playlist must not
      // start another video at the same time.
      if (st.liveChannel) return
      // Только если текущее активное видео — из нашего плейлиста
      if (!st.activeFile || st.activeFile.type !== 'video' || !st.activeFile.id.startsWith('video-playlist-')) return
      const data = args[0] as { path?: string } | undefined
      if (data?.path && data.path !== st.activeFile.path) return
      const idx = st.videoCurrentIndex
      if (idx < 0 || idx >= st.videoPlaylist.length) return
      if (st.activeFile.path !== st.videoPlaylist[idx]) return
      if (handledEndedFileIdRef.current === st.activeFile.id) return
      handledEndedFileIdRef.current = st.activeFile.id

      if (st.videoStopAfterTrack) {
        stopPlayback()
        return
      }

      // loopTrack handled via video.loop — 'ended' не прилетает. Но подстрахуемся.
      if (st.videoLoopTrack) {
        playTrack(idx)
        return
      }
      const nextAction = st.videoNextActions[st.activeFile.path]
      if (nextAction?.kind === 'stop') {
        stopPlayback()
        return
      }
      if (nextAction?.kind === 'video') {
        const nextIndex = st.videoPlaylist.indexOf(nextAction.path)
        if (nextIndex >= 0 && nextIndex !== idx) playTrack(nextIndex)
        else stopPlayback()
        return
      }
      if (nextAction?.kind === 'channel') {
        const target = st.channels[nextAction.channelId]?.file
        if (target?.type !== 'presentation' && target?.type !== 'pdf') {
          stopPlayback()
          return
        }
        setIsPlayingStore(false)
        returnChannelRef.current = null
        st.setSelectedChannel(nextAction.channelId)
        const targetIndex = st.channelIds.indexOf(nextAction.channelId)
        if (targetIndex >= 0) st.setCurrentChannelPage(Math.floor(targetIndex / st.channelGridSize))
        window.dispatchEvent(new CustomEvent('take-channel', { detail: nextAction.channelId }))
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
  }, [playTrack, setIsPlayingStore, stopPlayback])

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
      setFolderPath(null)
      setSelectedPath(null)
      setPlaylist(files)
      setCurrentIndex(0)
    }
  }

  const handleSelectFolder = async (): Promise<void> => {
    setShowMenu(false)
    const selected = await window.api.selectVideoFolder()
    if (selected) {
      setSelectedPath(null)
      setPlaylist(selected.files)
      setCurrentIndex(0)
      setFolderPath(selected.folderPath)
    }
  }

  const handlePlay = async (): Promise<void> => {
    if (playlist.length === 0) return
    handledEndedFileIdRef.current = null
    // Если активное видео то же что текущий трек — продолжить; иначе запустить
    const selectedIndex = selectedPath ? playlist.indexOf(selectedPath) : currentIndex
    if (selectedIndex < 0) return
    const currentTrack = playlist[selectedIndex]
    if (activeFile?.type === 'video' && activeFile.id.startsWith('video-playlist-') && activeFile.path === currentTrack) {
      window.api.sendToPresentation('play-pause', true)
      setIsPlayingStore(true)
    } else {
      await playTrack(selectedIndex)
    }
  }

  const handlePause = (): void => {
    if (useAppStore.getState().activeFile?.id.startsWith('video-playlist-')) {
      window.api.sendToPresentation('play-pause', false)
    }
    setIsPlayingStore(false)
  }

  const handleStop = stopPlayback

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
    if (newVal) setStopAfterTrackStore(false)
    // Playlist repeat must not change a separate video channel on air.
    if (activeFile?.type === 'video' && activeFile.id.startsWith('video-playlist-') && useAppStore.getState().liveChannel === null) {
      window.api.sendToPresentation('set-loop', newVal)
    }
  }

  const handleToggleLoopPlaylist = (): void => {
    const newVal = !loopPlaylist
    setLoopPlaylistStore(newVal)
    if (newVal) setStopAfterTrackStore(false)
  }

  const handleToggleStopAfterTrack = (): void => {
    const newVal = !stopAfterTrack
    setStopAfterTrackStore(newVal)
    if (!newVal) return
    setLoopTrackStore(false)
    setLoopPlaylistStore(false)
    if (activeFile?.type === 'video' && activeFile.id.startsWith('video-playlist-')) {
      window.api.sendToPresentation('set-loop', false)
    }
  }

  const handleNextActionChange = (path: string, value: string): void => {
    if (value === 'default') {
      setNextAction(path, null)
      return
    }
    if (value === 'stop') setNextAction(path, { kind: 'stop' })
    else if (value.startsWith('video:')) setNextAction(path, { kind: 'video', path: value.slice(6) })
    else if (value.startsWith('channel:')) setNextAction(path, { kind: 'channel', channelId: value.slice(8) })
    else return
    setStopAfterTrackStore(false)
    setLoopTrackStore(false)
    if (activeFile?.type === 'video' && activeFile.id.startsWith('video-playlist-')) {
      window.api.sendToPresentation('set-loop', false)
    }
  }

  const handleDrop = (to: number): void => {
    const from = dragIndexRef.current
    dragIndexRef.current = null
    setDraggedIndex(null)
    setDragOverIndex(null)
    if (from !== null) movePlaylistItem(from, to)
  }

  const presentationChannels = channelIds.filter((id) => {
    const type = channels[id]?.file?.type
    return type === 'presentation' || type === 'pdf'
  })

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
          className={`text-[11px] px-1.5 py-1 rounded-lg font-medium transition-colors border whitespace-nowrap ${
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
          data-pdm-training-panel="video"
          ref={panelRef}
          className="absolute top-full mt-1 left-1/2 -translate-x-1/2 bg-surface-100 border border-gray-700 rounded-lg shadow-xl p-3 z-50 min-w-[380px] max-w-[460px]"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <div className="text-[11px] text-gray-400 font-bold uppercase mb-2">Плейлист видео</div>

          <div className="flex items-center gap-2 mb-3 relative">
            <button
              onClick={() => setShowMenu(!showMenu)}
              className="text-[10px] px-2 py-1 rounded-sm bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors"
            >
              Выбор видео ▾
            </button>
            {showMenu && (
              <div ref={menuRef} className="absolute top-full left-0 mt-1 bg-surface-200 border border-gray-600 rounded-sm shadow-lg z-50 overflow-hidden">
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

          {folderPath && <div className="text-[10px] text-gray-500 mb-2 truncate" title={folderPath}>Папка обновляется автоматически: {basename(folderPath)}</div>}

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
            <button onClick={handlePrev} disabled={playlist.length === 0} className="text-sm w-8 h-8 rounded-sm bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors disabled:opacity-30" title="Предыдущий">⏮</button>
            {isPlaying ? (
              <button onClick={handlePause} className="text-sm w-8 h-8 rounded-sm bg-yellow-700 hover:bg-yellow-600 text-white transition-colors" title="Пауза">⏸</button>
            ) : (
              <button onClick={handlePlay} disabled={playlist.length === 0} className="text-sm w-8 h-8 rounded-sm bg-green-700 hover:bg-green-600 text-white transition-colors disabled:opacity-30" title="Воспроизвести">▶</button>
            )}
            <button onClick={handleStop} className="text-sm w-8 h-8 rounded-sm bg-red-700 hover:bg-red-600 text-white transition-colors" title="Стоп">⏹</button>
            <button onClick={handleNext} disabled={playlist.length === 0} className="text-sm w-8 h-8 rounded-sm bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors disabled:opacity-30" title="Следующий">⏭</button>

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
            <button
              data-video-stop-after-track
              type="button"
              onClick={handleToggleStopAfterTrack}
              aria-label="Один ролик — затем стоп"
              aria-pressed={stopAfterTrack}
              className={`text-[11px] font-bold w-8 h-8 rounded transition-colors ${
                stopAfterTrack ? 'bg-blue-600/80 hover:bg-blue-600 text-white' : 'bg-gray-700 hover:bg-gray-600 text-gray-300'
              }`}
              title={stopAfterTrack ? 'Один ролик — затем стоп ВКЛ' : 'Один ролик — затем стоп'}
            >1⏹</button>
          </div>

          <label className="flex items-center gap-2 border-t border-gray-700 pt-2 mb-2 text-[11px] text-gray-300 cursor-pointer">
            <input
              data-channel-video-autoplay
              type="checkbox"
              checked={channelVideoAutoplay}
              onChange={(event) => setChannelVideoAutoplay(event.target.checked)}
              className="accent-blue-500"
            />
            Автозапуск ролика при выводе видеоканала в эфир
          </label>

          {/* Track list */}
          {playlist.length > 0 && (
            <div className="border-t border-gray-700 pt-2 mt-1">
              <div className="text-[10px] text-gray-500 mb-1">Один клик — выбрать, двойной — запустить · тяните ⠿ для смены порядка</div>
              <div className="max-h-[220px] overflow-y-auto">
              {playlist.map((path, i) => (
                <div
                  key={`${path}-${i}`}
                  data-video-playlist-row={i}
                  onClick={() => setSelectedPath(path)}
                  onDoubleClick={() => { void playTrack(i) }}
                  onDragOver={(event) => {
                    if (dragIndexRef.current === null) return
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                    setDragOverIndex(i)
                  }}
                  onDrop={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    handleDrop(i)
                  }}
                  className={`text-[10px] px-2 py-1 rounded cursor-pointer transition-colors ${
                    dragOverIndex === i && draggedIndex !== i ? 'ring-1 ring-blue-400 ' : ''
                  }${
                    i === currentIndex && isPlaying
                      ? 'bg-blue-800/40 text-blue-300'
                      : i === currentIndex
                      ? 'bg-gray-700/50 text-gray-200'
                      : 'text-gray-400 hover:bg-gray-700/50 hover:text-gray-200'
                  }${selectedPath === path ? ' ring-1 ring-blue-400' : ''}`}
                  title={basename(path)}
                >
                  <div className="flex items-center gap-1 min-w-0">
                    <button
                      type="button"
                      draggable
                      data-video-drag-handle={i}
                      onClick={(event) => event.stopPropagation()}
                      onDragStart={(event) => {
                        dragIndexRef.current = i
                        setDraggedIndex(i)
                        event.dataTransfer.effectAllowed = 'move'
                        event.dataTransfer.setData('text/plain', String(i))
                      }}
                      onDragEnd={() => { dragIndexRef.current = null; setDraggedIndex(null); setDragOverIndex(null) }}
                      className="shrink-0 px-1 text-gray-500 hover:text-white cursor-grab active:cursor-grabbing"
                      title="Перетащите, чтобы изменить порядок роликов"
                      aria-label={`Переместить ролик ${i + 1}: ${basename(path)}`}
                    >⠿</button>
                    <span className="shrink-0 text-gray-600">{i + 1}.</span>
                    <span className="min-w-0 flex-1 truncate">{basename(path)}</span>
                    <select
                      data-video-next-action={i}
                      value={nextActions[path]?.kind === 'video' ? `video:${nextActions[path].path}`
                        : nextActions[path]?.kind === 'channel' ? `channel:${nextActions[path].channelId}`
                        : nextActions[path]?.kind === 'stop' ? 'stop' : 'default'}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => handleNextActionChange(path, event.target.value)}
                      className="w-[160px] shrink-0 rounded bg-surface-200 border border-gray-600 px-1 py-1 text-[10px] text-gray-200"
                      title={`После ${basename(path)}`}
                      aria-label={`После ролика ${basename(path)}`}
                    >
                      <option value="default">Далее по списку</option>
                      <option value="stop">Остановить</option>
                      {playlist.map((candidate, j) => candidate !== path && (
                        <option key={`${candidate}-${j}`} value={`video:${candidate}`}>Ролик {j + 1}: {basename(candidate)}</option>
                      ))}
                      {presentationChannels.map((id) => (
                        <option key={id} value={`channel:${id}`}>
                          Канал {id}: {channels[id].caption || channels[id].file?.name || 'Презентация'}
                        </option>
                      ))}
                      {nextActions[path]?.kind === 'channel' && !presentationChannels.includes(nextActions[path].channelId) && (
                        <option value={`channel:${nextActions[path].channelId}`} disabled>Канал недоступен</option>
                      )}
                    </select>
                  </div>
                </div>
              ))}
              </div>
            </div>
          )}

          <button
            data-pdm-training-close
            onClick={() => setExpanded(false)}
            className="absolute top-2 right-2 text-gray-500 hover:text-white text-sm"
          >✕</button>
        </div>
      )}
    </>
  )
}
