import { useState, useEffect, useRef, useCallback } from 'react'
import { useAppStore } from '../../stores/useAppStore'

export function MusicPlayer(): JSX.Element {
  const playlist = useAppStore((s) => s.musicPlaylist)
  const setPlaylist = useAppStore((s) => s.setMusicPlaylist)
  const [state, setState] = useState<MusicState | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [showMusicMenu, setShowMusicMenu] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const musicMenuRef = useRef<HTMLDivElement>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const pollState = useCallback(async () => {
    const s = await window.api.musicGetState()
    if (s) setState(s)
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
      setPlaylist(files)
      await window.api.musicSetPlaylist(files, 0)
      pollState()
    }
  }

  const handleSelectFolder = async (): Promise<void> => {
    setShowMusicMenu(false)
    const files = await window.api.selectMusicFolder()
    if (files && files.length > 0) {
      setPlaylist(files)
      await window.api.musicSetPlaylist(files, 0)
      pollState()
    }
  }

  const handlePlay = async (): Promise<void> => { await window.api.musicPlay(); pollState() }
  const handlePause = async (): Promise<void> => { await window.api.musicPause(); pollState() }
  const handleStop = async (): Promise<void> => { await window.api.musicStop(); pollState() }
  const handleNext = async (): Promise<void> => { await window.api.musicNext(); pollState() }
  const handlePrev = async (): Promise<void> => { await window.api.musicPrev(); pollState() }

  const handleToggleLoopTrack = async (): Promise<void> => {
    const newVal = !(state?.loopTrack ?? false)
    await window.api.musicSetLoopTrack(newVal)
    pollState()
  }

  const handleSeek = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const time = parseFloat(e.target.value)
    await window.api.musicSeek(time)
    pollState()
  }

  const handlePlayTrack = async (index: number): Promise<void> => {
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

  return (
    <>
      <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <button
          ref={toggleRef}
          onClick={() => setExpanded(!expanded)}
          className={`text-xs px-2 py-1.5 rounded-lg font-medium transition-colors border ${
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
          ref={panelRef}
          className="absolute top-10 left-1/2 -translate-x-1/2 bg-surface-100 border border-gray-700 rounded-lg shadow-xl p-3 z-50 min-w-[360px] max-w-[420px]"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <div className="text-[11px] text-gray-400 font-bold uppercase mb-2">Фоновая музыка</div>

          {/* Select music */}
          <div className="flex items-center gap-2 mb-3 relative">
            <button
              onClick={() => setShowMusicMenu(!showMusicMenu)}
              className="text-[10px] px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors"
            >
              Выбор музыки ▾
            </button>
            {showMusicMenu && (
              <div ref={musicMenuRef} className="absolute top-full left-0 mt-1 bg-surface-200 border border-gray-600 rounded shadow-lg z-50 overflow-hidden">
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
            <button onClick={handlePrev} className="text-sm w-8 h-8 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors" title="Предыдущий">⏮</button>
            {isPlaying ? (
              <button onClick={handlePause} className="text-sm w-8 h-8 rounded bg-yellow-700 hover:bg-yellow-600 text-white transition-colors" title="Пауза">⏸</button>
            ) : (
              <button onClick={handlePlay} className="text-sm w-8 h-8 rounded bg-green-700 hover:bg-green-600 text-white transition-colors" title="Воспроизвести">▶</button>
            )}
            <button onClick={handleStop} className="text-sm w-8 h-8 rounded bg-red-700 hover:bg-red-600 text-white transition-colors" title="Стоп">⏹</button>
            <button onClick={handleNext} className="text-sm w-8 h-8 rounded bg-gray-700 hover:bg-gray-600 text-gray-300 transition-colors" title="Следующий">⏭</button>

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
            <div className="border-t border-gray-700 pt-2 mt-1 max-h-[200px] overflow-y-auto">
              {playlist.map((path, i) => (
                <div
                  key={path}
                  onClick={() => handlePlayTrack(i)}
                  className={`text-[10px] px-2 py-1 rounded cursor-pointer truncate transition-colors ${
                    state && state.currentIndex === i
                      ? 'bg-green-800/40 text-green-300'
                      : 'text-gray-400 hover:bg-gray-700/50 hover:text-gray-200'
                  }`}
                  title={getFileName(path)}
                >
                  <span className="text-gray-600 mr-1">{i + 1}.</span>
                  {getFileName(path)}
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
