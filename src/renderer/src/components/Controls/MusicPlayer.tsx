import { useState, useEffect, useRef, useCallback } from 'react'
import { useAppStore } from '../../stores/useAppStore'
import { reconcileMediaFolderPlaylist, sameMediaPlaylist } from './media-folder-playlist'

export function MusicPlayer(): JSX.Element {
  const playlist = useAppStore((s) => s.musicPlaylist)
  const setPlaylist = useAppStore((s) => s.setMusicPlaylist)
  const folderPath = useAppStore((s) => s.musicFolderPath)
  const setFolderPath = useAppStore((s) => s.setMusicFolderPath)
  const movePlaylistItem = useAppStore((s) => s.moveMusicPlaylistItem)
  const stopAfterTrack = useAppStore((s) => s.musicStopAfterTrack)
  const setStopAfterTrack = useAppStore((s) => s.setMusicStopAfterTrack)
  const nextActions = useAppStore((s) => s.musicNextActions)
  const setNextAction = useAppStore((s) => s.setMusicNextAction)
  const channels = useAppStore((s) => s.channels)
  const channelIds = useAppStore((s) => s.channelIds)
  const [state, setState] = useState<MusicState | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [showMusicMenu, setShowMusicMenu] = useState(false)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  useEffect(() => {
    if (selectedPath && !playlist.includes(selectedPath)) setSelectedPath(null)
  }, [playlist, selectedPath])
  const panelRef = useRef<HTMLDivElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const musicMenuRef = useRef<HTMLDivElement>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const dragIndexRef = useRef<number | null>(null)
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)

  const pollState = useCallback(async () => {
    const s = await window.api.musicGetState()
    if (!s) return
    setState(s)
    if (s.pendingChannel) {
      const channelId = await window.api.musicConsumeChannelTransition(s.transitionSerial)
      if (!channelId) return
      const app = useAppStore.getState()
      const target = app.channels[channelId]?.file
      if (target?.type !== 'presentation' && target?.type !== 'pdf') return
      app.setSelectedChannel(channelId)
      const index = app.channelIds.indexOf(channelId)
      if (index >= 0) app.setCurrentChannelPage(Math.floor(index / app.channelGridSize))
      window.dispatchEvent(new CustomEvent('take-channel', { detail: channelId }))
    }
  }, [])

  useEffect(() => {
    if (playlist.length === 0) return
    pollRef.current = setInterval(pollState, 1000)
    pollState()
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [playlist, pollState])

  useEffect(() => {
    if (!folderPath) return
    let cancelled = false
    let refreshing = false
    const refresh = async (): Promise<void> => {
      if (refreshing) return
      refreshing = true
      try {
        const files = await window.api.scanMediaFolder('music', folderPath)
        if (cancelled || !files || useAppStore.getState().musicFolderPath !== folderPath) return
        const playerState = await window.api.musicGetState()
        if (cancelled || useAppStore.getState().musicFolderPath !== folderPath) return
        const current = useAppStore.getState().musicPlaylist
        const next = reconcileMediaFolderPlaylist(current, files, playerState?.loadedPath ?? null)
        if (sameMediaPlaylist(current, next)) return
        if (playerState) await window.api.musicReorderPlaylist(next)
        else await window.api.musicSetPlaylist(next, 0, false)
        if (cancelled || useAppStore.getState().musicFolderPath !== folderPath) return
        setPlaylist(next)
        await window.api.musicSetNextActions(useAppStore.getState().musicNextActions)
        void pollState()
      } finally {
        refreshing = false
      }
    }
    const timer = setInterval(() => { void refresh().catch(() => undefined) }, 2000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [folderPath, pollState, setPlaylist])

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

  // Close music menu on outside click
  useEffect(() => {
    if (!showMusicMenu) return
    const handleClick = (e: MouseEvent): void => {
      if (musicMenuRef.current && !musicMenuRef.current.contains(e.target as Node)) {
        setShowMusicMenu(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [showMusicMenu])

  const handleSelectFiles = async (): Promise<void> => {
    setShowMusicMenu(false)
    const files = await window.api.selectMusicFiles()
    if (files && files.length > 0) {
      setFolderPath(null)
      setSelectedPath(null)
      setPlaylist(files)
      await window.api.musicSetPlaylist(files, 0)
      await window.api.musicSetNextActions(useAppStore.getState().musicNextActions)
      pollState()
    }
  }

  const handleSelectFolder = async (): Promise<void> => {
    setShowMusicMenu(false)
    const selected = await window.api.selectMusicFolder()
    if (selected) {
      setSelectedPath(null)
      setPlaylist(selected.files)
      setFolderPath(selected.folderPath)
      await window.api.musicSetPlaylist(selected.files, 0)
      await window.api.musicSetNextActions(useAppStore.getState().musicNextActions)
      pollState()
    }
  }

  const handlePlay = async (): Promise<void> => {
    const loadedIndex = state?.loadedPath ? playlist.indexOf(state.loadedPath) : -1
    const index = selectedPath ? playlist.indexOf(selectedPath) : loadedIndex >= 0 ? loadedIndex : (state?.currentIndex ?? 0)
    if (index < 0 || index >= playlist.length) return
    if (state?.loadedPath === playlist[index]) await window.api.musicPlay()
    else await window.api.musicSetPlaylist(playlist, index, true)
    pollState()
  }
  const handlePause = async (): Promise<void> => { await window.api.musicPause(); pollState() }
  const handleStop = async (): Promise<void> => { await window.api.musicStop(); pollState() }
  const handleNext = async (): Promise<void> => { await window.api.musicNext(); pollState() }
  const handlePrev = async (): Promise<void> => { await window.api.musicPrev(); pollState() }

  const handleToggleLoopTrack = async (): Promise<void> => {
    const newVal = !(state?.loopTrack ?? false)
    await window.api.musicSetLoopTrack(newVal)
    if (newVal) setStopAfterTrack(false)
    pollState()
  }

  const handleToggleLoopPlaylist = async (): Promise<void> => {
    const newVal = !(state?.loopPlaylist ?? true)
    await window.api.musicSetLoopPlaylist(newVal)
    if (newVal) setStopAfterTrack(false)
    pollState()
  }

  const handleToggleStopAfterTrack = async (): Promise<void> => {
    const newVal = !stopAfterTrack
    setStopAfterTrack(newVal)
    await window.api.musicSetStopAfterTrack(newVal)
    pollState()
  }

  const handleNextActionChange = async (path: string, value: string): Promise<void> => {
    if (value === 'default') setNextAction(path, null)
    else if (value === 'stop') setNextAction(path, { kind: 'stop' })
    else if (value.startsWith('music:')) setNextAction(path, { kind: 'music', path: value.slice(6) })
    else if (value.startsWith('channel:')) setNextAction(path, { kind: 'channel', channelId: value.slice(8) })
    else return
    if (value !== 'default') {
      setStopAfterTrack(false)
      await window.api.musicSetStopAfterTrack(false)
      await window.api.musicSetLoopTrack(false)
    }
    await window.api.musicSetNextActions(useAppStore.getState().musicNextActions)
    pollState()
  }

  const handleDrop = async (to: number): Promise<void> => {
    const from = dragIndexRef.current
    dragIndexRef.current = null
    setDraggedIndex(null)
    setDragOverIndex(null)
    if (from === null || from === to) return
    const files = [...useAppStore.getState().musicPlaylist]
    const [moved] = files.splice(from, 1)
    files.splice(to, 0, moved)
    await window.api.musicReorderPlaylist(files)
    movePlaylistItem(from, to)
    pollState()
  }

  const handleSeek = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const time = parseFloat(e.target.value)
    await window.api.musicSeek(time)
    pollState()
  }

  const handlePlayTrack = async (index: number): Promise<void> => {
    setSelectedPath(playlist[index] ?? null)
    await window.api.musicSetPlaylist(playlist, index, true)
    pollState()
  }

  const isPlaying = state?.playing ?? false
  const trackName = state?.trackName ?? ''

  const formatTime = (s: number): string => {
    const m = Math.floor(s / 60)
    const sec = Math.floor(s % 60)
    return `${m}:${sec.toString().padStart(2, '0')}`
  }

  const getFileName = (path: string): string => path.split(/[\\/]/).pop() || path
  const presentationChannels = channelIds.filter((id) => {
    const type = channels[id]?.file?.type
    return type === 'presentation' || type === 'pdf'
  })

  return (
    <>
      <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <button
          ref={toggleRef}
          onClick={() => setExpanded(!expanded)}
          className={`text-[11px] px-1.5 py-1 rounded-lg font-medium transition-colors border whitespace-nowrap ${
            isPlaying
              ? 'bg-green-600/80 hover:bg-green-600 text-white border-transparent'
              : 'bg-surface-100 text-gray-300 hover:bg-gray-700 border-gray-700'
          }`}
          title="Фоновая музыка"
        >
          {isPlaying ? '♫' : '♪'} Музыка
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
          data-pdm-training-panel="music"
          ref={panelRef}
          className="absolute top-full mt-1 left-1/2 -translate-x-1/2 bg-surface-100 border border-gray-700 rounded-lg shadow-xl p-3 z-50 min-w-[360px] max-w-[420px]"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <div className="text-[11px] text-gray-400 font-bold uppercase mb-2">Фоновая музыка</div>

          {/* Select music */}
          <div className="flex items-center gap-2 mb-3 relative">
            <button
              onClick={() => setShowMusicMenu(!showMusicMenu)}
              className="text-[10px] px-2 py-1 rounded-sm bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors"
            >
              Выбор музыки ▾
            </button>
            {showMusicMenu && (
              <div ref={musicMenuRef} className="absolute top-full left-0 mt-1 bg-surface-200 border border-gray-600 rounded-sm shadow-lg z-50 overflow-hidden">
                <button onClick={handleSelectFiles} className="block w-full text-left text-[10px] px-3 py-1.5 text-gray-300 hover:bg-gray-600 transition-colors whitespace-nowrap">
                  Выбрать файлы
                </button>
                <button onClick={handleSelectFolder} className="block w-full text-left text-[10px] px-3 py-1.5 text-gray-300 hover:bg-gray-600 transition-colors whitespace-nowrap">
                  Выбрать папку
                </button>
              </div>
            )}
            {playlist.length > 0 && (
              <span className="text-[10px] text-gray-500">{playlist.length} {playlist.length === 1 ? 'трек' : 'треков'}</span>
            )}
          </div>

          {/* Now playing */}
          {folderPath && <div className="text-[10px] text-gray-500 mb-2 truncate" title={folderPath}>Папка обновляется автоматически: {getFileName(folderPath)}</div>}
          <div className="text-[10px] text-gray-300 mb-1 truncate h-4" title={trackName}>
            {trackName ? `${(state?.currentIndex ?? 0) + 1}/${state?.playlistLength ?? 0} — ${trackName}` : '\u00A0'}
          </div>

          {/* Seek bar — always visible */}
          <div className="flex items-center gap-2 mb-2 h-5">
            <input
              type="range"
              min={0}
              max={state && state.duration > 0 ? state.duration : 100}
              step={1}
              value={state?.currentTime ?? 0}
              onChange={handleSeek}
              disabled={!state || state.duration === 0}
              className="flex-1 h-1 accent-green-500 disabled:opacity-30"
            />
            <span className="text-[10px] text-gray-500 whitespace-nowrap w-[75px] text-right">
              {state && state.duration > 0 ? `${formatTime(state.currentTime)} / ${formatTime(state.duration)}` : '0:00 / 0:00'}
            </span>
          </div>

          {/* Playback controls */}
          <div className="flex items-center gap-1 mb-2">
            <button onClick={handlePrev} className="text-sm w-8 h-8 rounded-sm bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors" title="Предыдущий">⏮</button>
            {isPlaying ? (
              <button onClick={handlePause} className="text-sm w-8 h-8 rounded-sm bg-yellow-700 hover:bg-yellow-600 text-white transition-colors" title="Пауза">⏸</button>
            ) : (
              <button onClick={handlePlay} className="text-sm w-8 h-8 rounded-sm bg-green-700 hover:bg-green-600 text-white transition-colors" title="Воспроизвести">▶</button>
            )}
            <button onClick={handleStop} className="text-sm w-8 h-8 rounded-sm bg-red-700 hover:bg-red-600 text-white transition-colors" title="Стоп">⏹</button>
            <button onClick={handleNext} className="text-sm w-8 h-8 rounded-sm bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors" title="Следующий">⏭</button>

            <div className="w-px h-6 bg-gray-600 mx-1" />

            <button
              onClick={handleToggleLoopTrack}
              className={`text-sm w-8 h-8 rounded transition-colors ${
                state?.loopTrack
                  ? 'bg-blue-600/80 hover:bg-blue-600 text-white'
                  : 'bg-gray-700 hover:bg-gray-600 text-gray-300'
              }`}
              title={state?.loopTrack ? 'Зацикливание трека ВКЛ' : 'Зацикливание трека'}
            >🔂</button>
            <button
              onClick={handleToggleLoopPlaylist}
              className={`text-sm w-8 h-8 rounded transition-colors ${
                state?.loopPlaylist ? 'bg-blue-600/80 hover:bg-blue-600 text-white' : 'bg-gray-700 hover:bg-gray-600 text-gray-300'
              }`}
              title={state?.loopPlaylist ? 'Зацикливание плейлиста ВКЛ' : 'Зацикливание плейлиста'}
            >🔁</button>
            <button
              data-music-stop-after-track
              type="button"
              onClick={handleToggleStopAfterTrack}
              aria-label="Один трек — затем стоп"
              aria-pressed={stopAfterTrack}
              className={`text-[11px] font-bold w-8 h-8 rounded transition-colors ${
                stopAfterTrack ? 'bg-blue-600/80 hover:bg-blue-600 text-white' : 'bg-gray-700 hover:bg-gray-600 text-gray-300'
              }`}
              title={stopAfterTrack ? 'Один трек — затем стоп ВКЛ' : 'Один трек — затем стоп'}
            >1⏹</button>

            <div className="w-px h-6 bg-gray-600 mx-1" />
            <span className="text-[10px] text-gray-500">🔊</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={state?.volume ?? 1}
              onChange={async (e) => {
                await window.api.musicSetVolume(parseFloat(e.target.value))
                pollState()
              }}
              className="w-20 h-1 accent-blue-500"
            />
          </div>

          {/* Track list */}
          {playlist.length > 0 && (
            <div className="border-t border-gray-700 pt-2 mt-1">
              <div className="text-[10px] text-gray-500 mb-1">Один клик — выбрать, двойной — запустить · тяните ⠿ для смены порядка</div>
              <div className="max-h-[220px] overflow-y-auto">
              {playlist.map((path, i) => (
                <div
                  key={`${path}-${i}`}
                  data-music-playlist-row={i}
                  onClick={() => setSelectedPath(path)}
                  onDoubleClick={() => { void handlePlayTrack(i) }}
                  onDragOver={(event) => {
                    if (dragIndexRef.current === null) return
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                    setDragOverIndex(i)
                  }}
                  onDrop={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    void handleDrop(i)
                  }}
                  className={`text-[10px] px-2 py-1 rounded cursor-pointer transition-colors ${
                    dragOverIndex === i && draggedIndex !== i ? 'ring-1 ring-green-400 ' : ''
                  }${
                    state && state.currentIndex === i && state.playing
                      ? 'bg-green-800/40 text-green-300'
                      : 'text-gray-400 hover:bg-gray-700/50 hover:text-gray-200'
                  }${selectedPath === path ? ' ring-1 ring-green-400' : ''}`}
                  title={getFileName(path)}
                >
                  <div className="flex items-center gap-1 min-w-0">
                    <button
                      type="button"
                      draggable
                      data-music-drag-handle={i}
                      onClick={(event) => event.stopPropagation()}
                      onDragStart={(event) => {
                        dragIndexRef.current = i
                        setDraggedIndex(i)
                        event.dataTransfer.effectAllowed = 'move'
                        event.dataTransfer.setData('text/plain', String(i))
                      }}
                      onDragEnd={() => { dragIndexRef.current = null; setDraggedIndex(null); setDragOverIndex(null) }}
                      className="shrink-0 px-1 text-gray-500 hover:text-white cursor-grab active:cursor-grabbing"
                      title="Перетяните, чтобы изменить порядок треков"
                      aria-label={`Переместить трек ${i + 1}: ${getFileName(path)}`}
                    >⠿</button>
                    <span className="shrink-0 text-gray-600">{i + 1}.</span>
                    <span className="min-w-0 flex-1 truncate">{getFileName(path)}</span>
                    <select
                      data-music-next-action={i}
                      value={nextActions[path]?.kind === 'music' ? `music:${nextActions[path].path}`
                        : nextActions[path]?.kind === 'channel' ? `channel:${nextActions[path].channelId}`
                        : nextActions[path]?.kind === 'stop' ? 'stop' : 'default'}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => { void handleNextActionChange(path, event.target.value) }}
                      className="w-[160px] shrink-0 rounded bg-surface-200 border border-gray-600 px-1 py-1 text-[10px] text-gray-200"
                      title={`После ${getFileName(path)}`}
                      aria-label={`После трека ${getFileName(path)}`}
                    >
                      <option value="default">Далее по списку</option>
                      <option value="stop">Остановить</option>
                      {playlist.map((candidate, j) => candidate !== path && (
                        <option key={`${candidate}-${j}`} value={`music:${candidate}`}>Трек {j + 1}: {getFileName(candidate)}</option>
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
