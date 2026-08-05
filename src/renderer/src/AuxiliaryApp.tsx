import { useEffect, useRef, useState } from 'react'
import { mediaUrl } from './media'
import { renderPdfiumPageToCanvas } from './pdfium-renderer'

const role = new URLSearchParams(window.location.search).get('role') === 'info'
  ? 'info'
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
  compact = false
}: {
  filePath: string
  page: number | null
  compact?: boolean
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [frameUrl, setFrameUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

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
      const targetWidth = Math.min(2560, Math.max(640, Math.round(size.width * dpr)))
      const targetHeight = Math.min(1600, Math.max(360, Math.round(size.height * dpr)))
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
  }, [filePath, page, size.width, size.height])

  return (
    <div ref={containerRef} className="relative h-full w-full overflow-hidden bg-black flex items-center justify-center">
      {page === null ? (
        <div className="text-center text-gray-400">
          <div className={compact ? 'text-2xl' : 'text-4xl'}>Конец презентации</div>
        </div>
      ) : frameUrl ? (
        <img src={frameUrl} className="h-full w-full object-contain" draggable={false} />
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
        <div className="text-4xl mb-3">Дисплей 2</div>
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

function InformationVideo({ path, playing }: { path: string; playing: boolean }): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null)

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

  return (
    <video
      ref={videoRef}
      src={mediaUrl(path)}
      className="h-full w-full object-contain bg-black"
      playsInline
      onEnded={() => window.api.sendToControl('information-video-ended')}
    />
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
    <div
      className="relative h-screen w-screen overflow-hidden select-none bg-black bg-cover bg-center bg-no-repeat"
      style={{
        backgroundImage: state.backdropImage ? `url("${mediaUrl(state.backdropImage)}")` : undefined
      }}
    >
      {state.displayTimer ? (
        <div className="absolute inset-0 flex items-center justify-center bg-black/45 px-[4vw] text-center text-[clamp(110px,20vw,380px)]">
          <TimerValue timer={timer} />
        </div>
      ) : state.media?.type === 'presentation' ? (
        <SpeakerImageFrame path={state.media.slideImages[state.media.currentSlide - 1]} />
      ) : state.media?.type === 'pdf' ? (
        <SpeakerPdfFrame filePath={state.media.path} page={state.media.currentSlide} />
      ) : state.media?.type === 'video' ? (
        <InformationVideo path={state.media.path} playing={state.media.playing} />
      ) : state.media?.type === 'image' ? (
        <img src={mediaUrl(state.media.path)} className="absolute inset-0 h-full w-full object-contain" draggable={false} />
      ) : !state.backdropImage ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-500">
          <div className="text-4xl mb-3">Дисплей 3</div>
          <div className="text-xl">Файл не выбран</div>
        </div>
      ) : null}
    </div>
  )
}

export function AuxiliaryApp(): JSX.Element {
  useEffect(() => {
    document.title = role === 'speaker' ? 'PDM Speaker Display' : 'PDM Information Display'
  }, [])
  return role === 'speaker' ? <SpeakerDisplay /> : <InformationDisplay />
}
