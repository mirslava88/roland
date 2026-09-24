import { useEffect, useRef, useState } from 'react'
import { connectedProgramDisplayId, useAppStore } from '../../stores/useAppStore'
import { SlideNavigator } from '../SlideNavigator/SlideNavigator'

const PANEL_CAPTURE_INTERVAL_MS = 180
const LARGE_CAPTURE_INTERVAL_MS = 100

function ActualProgramFrame({ large = false }: { large?: boolean }): JSX.Element {
  const [frame, setFrame] = useState<string | null>(null)
  const [waiting, setWaiting] = useState(true)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    let timer: ReturnType<typeof setTimeout> | undefined
    let generation = 0

    const schedule = (delay: number): void => {
      if (!mountedRef.current) return
      timer = setTimeout(() => { void capture() }, delay)
    }
    const capture = async (): Promise<void> => {
      if (document.visibilityState === 'hidden') {
        schedule(750)
        return
      }
      const requestGeneration = ++generation
      try {
        const result = await window.api.captureProgramPreviewFrame()
        if (!mountedRef.current || requestGeneration !== generation) return
        if (!result?.dataUrl) {
          setWaiting(true)
          schedule(400)
          return
        }
        const decoded = new Image()
        decoded.src = result.dataUrl
        try { await decoded.decode() } catch { /* the img element can still decode it */ }
        if (!mountedRef.current || requestGeneration !== generation) return
        setFrame(result.dataUrl)
        setWaiting(false)
      } catch {
        if (mountedRef.current) setWaiting(true)
      }
      schedule(large ? LARGE_CAPTURE_INTERVAL_MS : PANEL_CAPTURE_INTERVAL_MS)
    }

    void capture()
    return () => {
      mountedRef.current = false
      generation++
      if (timer) clearTimeout(timer)
    }
  }, [large])

  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden bg-black">
      {frame ? (
        <img
          data-pdm-program-monitor-frame
          src={frame}
          alt="Текущий эфир PDM"
          draggable={false}
          className="h-full w-full select-none object-contain"
        />
      ) : (
        <div className="px-4 text-center text-[11px] text-gray-500">
          {waiting ? 'Подготовка внутреннего эфира…' : 'Эфир пока пуст'}
        </div>
      )}
      <div className="pointer-events-none absolute left-2 top-2 flex items-center gap-1.5 rounded bg-black/75 px-2 py-1 text-[9px] font-bold tracking-[0.16em] text-white">
        <span className="h-2 w-2 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,.95)]" />
        ЭФИР
      </div>
    </div>
  )
}

export function HeadlessProgramRail(): JSX.Element {
  const displays = useAppStore((state) => state.displays)
  const displayAssignments = useAppStore((state) => state.displayAssignments)
  const selectedDisplayId = useAppStore((state) => state.selectedDisplayId)
  const [collapsed, setCollapsed] = useState(false)
  const [large, setLarge] = useState(false)
  const headless = connectedProgramDisplayId({ displays, displayAssignments, selectedDisplayId }) === null

  useEffect(() => {
    if (!headless) setLarge(false)
  }, [headless])

  useEffect(() => {
    if (!large) return
    const close = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setLarge(false)
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [large])

  if (!headless) return <SlideNavigator />

  if (collapsed) {
    return (
      <>
        <aside className="pdm-program-monitor-collapsed flex w-9 shrink-0 items-stretch overflow-hidden rounded-md border border-red-900/70 bg-surface-300">
          <button
            type="button"
            data-pdm-program-monitor-expand
            onClick={() => setCollapsed(false)}
            title="Показать текущий эфир"
            className="flex flex-1 items-center justify-center gap-2 text-[9px] font-bold tracking-[0.14em] text-red-200 hover:bg-red-950/40 hover:text-white"
            style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
          >
            <span className="h-2 w-2 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,.9)]" />
            ПОКАЗАТЬ ЭФИР
          </button>
        </aside>
        <SlideNavigator />
      </>
    )
  }

  return (
    <>
      <aside data-pdm-program-monitor className="pdm-headless-program-rail flex w-[clamp(276px,24vw,360px)] shrink-0 flex-col overflow-hidden rounded-md border border-red-900/70 bg-surface-300">
        <header className="flex min-h-[42px] items-center gap-2 border-b border-gray-800 bg-surface-200 px-3">
          <span className="h-2.5 w-2.5 rounded-full bg-red-500 shadow-[0_0_10px_rgba(239,68,68,.95)]" />
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-bold tracking-[0.16em] text-white">ЭФИР</div>
            <div className="truncate text-[9px] text-gray-500">Внутренний выход · без монитора</div>
          </div>
          <button type="button" onClick={() => setLarge(true)} title="Увеличить эфир" aria-label="Увеличить эфир"
            className="flex h-7 w-7 items-center justify-center rounded border border-gray-700 text-sm text-gray-300 hover:border-red-500 hover:bg-red-950/40 hover:text-white">
            ⛶
          </button>
          <button type="button" onClick={() => setCollapsed(true)} title="Свернуть монитор эфира" aria-label="Свернуть монитор эфира"
            className="flex h-7 w-7 items-center justify-center rounded border border-gray-700 text-base text-gray-300 hover:border-gray-500 hover:bg-gray-800 hover:text-white">
            ›
          </button>
        </header>
        <div className="m-2 aspect-video shrink-0 overflow-hidden rounded border border-red-900/80 bg-black shadow-[0_0_18px_rgba(127,29,29,.24)]">
          <ActualProgramFrame />
        </div>
        <div className="border-b border-gray-800 px-3 pb-2 text-[9px] leading-4 text-gray-500">
          Здесь показан кадр, который получает виртуальная камера и стрим.
        </div>
        <div className="pdm-headless-program-slides min-h-0 flex-1">
          <SlideNavigator />
        </div>
      </aside>

      {large && (
        <div data-pdm-program-monitor-large className="fixed inset-0 z-40 flex items-center justify-center bg-black/85 p-8" onMouseDown={() => setLarge(false)}>
          <div className="flex max-h-full w-full max-w-6xl flex-col overflow-hidden rounded-lg border border-red-700/80 bg-surface-300 shadow-2xl" onMouseDown={(event) => event.stopPropagation()}>
            <header className="flex h-11 shrink-0 items-center gap-2 border-b border-red-900/70 px-4">
              <span className="h-2.5 w-2.5 rounded-full bg-red-500 shadow-[0_0_10px_rgba(239,68,68,.95)]" />
              <strong className="text-xs tracking-[0.16em] text-white">ЭФИР</strong>
              <span className="text-[10px] text-gray-500">Фактический внутренний выход PDM</span>
              <button type="button" onClick={() => setLarge(false)} aria-label="Закрыть увеличенный эфир"
                className="ml-auto flex h-7 w-7 items-center justify-center rounded border border-gray-700 text-gray-300 hover:border-red-500 hover:bg-red-950/40 hover:text-white">
                ✕
              </button>
            </header>
            <div className="aspect-video min-h-0 w-full bg-black">
              <ActualProgramFrame large />
            </div>
          </div>
        </div>
      )}
    </>
  )
}
