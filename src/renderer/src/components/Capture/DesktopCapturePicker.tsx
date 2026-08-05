import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

interface DesktopCapturePickerProps {
  excludedDisplayId: number | null
  onClose: () => void
  onSelect: (source: DesktopCaptureSourceDescriptor) => void
}

export function DesktopCapturePicker({
  excludedDisplayId,
  onClose,
  onSelect
}: DesktopCapturePickerProps): JSX.Element {
  const [kind, setKind] = useState<'window' | 'screen'>('window')
  const [sources, setSources] = useState<DesktopCaptureSourceDescriptor[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const generationRef = useRef(0)
  const requestInFlightRef = useRef(false)

  const loadSources = useCallback(async (mode: 'foreground' | 'silent' = 'foreground'): Promise<void> => {
    if (mode === 'silent' && requestInFlightRef.current) return
    const generation = ++generationRef.current
    requestInFlightRef.current = true
    if (mode === 'foreground') {
      setLoading(true)
      setError(null)
    }
    try {
      const next = await window.api.getDesktopCaptureSources(
        [kind],
        excludedDisplayId ?? undefined
      )
      if (generation !== generationRef.current) return
      setSources((current) => {
        const previousById = new Map(current.map((source) => [source.id, source]))
        return next.map((source) => {
          const previous = previousById.get(source.id)
          if (!previous) return source
          return {
            ...source,
            // Polling should update the inventory, not repaint every preview.
            thumbnail: previous.thumbnail || source.thumbnail,
            appIcon: previous.appIcon || source.appIcon
          }
        })
      })
      setError(null)
    } catch (loadError) {
      if (generation !== generationRef.current) return
      // A temporary polling failure must not make existing cards disappear.
      if (mode === 'foreground') {
        setSources([])
        setError(loadError instanceof Error ? loadError.message : 'Не удалось получить список окон и экранов.')
      }
    } finally {
      if (generation === generationRef.current) {
        requestInFlightRef.current = false
        if (mode === 'foreground') setLoading(false)
      }
    }
  }, [excludedDisplayId, kind])

  useEffect(() => {
    void loadSources('foreground')
    return () => {
      generationRef.current += 1
      requestInFlightRef.current = false
    }
  }, [loadSources])

  // Keep the currently open picker in sync with Windows. Refreshes are silent:
  // existing cards stay on screen instead of flashing a loading state.
  useEffect(() => {
    const refreshTimer = setInterval(() => {
      void loadSources('silent')
    }, 1800)
    return () => clearInterval(refreshTimer)
  }, [loadSources])

  // Chromium does not expose minimized Windows applications as capturable
  // sources. If the operator restores a target app and comes back to PDM, make
  // it appear immediately without requiring an extra "refresh" click.
  useEffect(() => {
    let refreshTimer: ReturnType<typeof setTimeout> | null = null
    const refreshAfterReturningToPdm = (): void => {
      if (refreshTimer) clearTimeout(refreshTimer)
      // Give Windows a moment to finish restoring the other app's HWND before
      // Chromium enumerates capturable sources.
      refreshTimer = setTimeout(() => { void loadSources('silent') }, 300)
    }
    window.addEventListener('focus', refreshAfterReturningToPdm)
    return () => {
      window.removeEventListener('focus', refreshAfterReturningToPdm)
      if (refreshTimer) clearTimeout(refreshTimer)
    }
  }, [loadSources])

  const visibleSources = useMemo(
    () => sources.filter((source) => source.kind === kind),
    [kind, sources]
  )

  useEffect(() => {
    setSelectedId((current) => (
      visibleSources.some((source) => source.id === current)
        ? current
        : visibleSources[0]?.id || ''
    ))
  }, [visibleSources])

  const selectedSource = visibleSources.find((source) => source.id === selectedId)

  const selectSource = (source: DesktopCaptureSourceDescriptor): void => {
    // Adding a channel must never change the state of another application.
    // Minimized windows are restored and resolved to a Chromium capture id
    // only when the operator actually presses "В эфир".
    onSelect(source)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[86vh] w-full max-w-4xl flex-col rounded-xl border border-gray-700 bg-surface-300 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-700 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold text-white">Добавить окно или экран</h2>
            <p className="mt-1 text-xs text-gray-500">
              Список обновляется автоматически; свёрнутое окно развернётся только после нажатия «В эфир»
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-xl text-gray-500 hover:text-white"
          >
            ✕
          </button>
        </div>

        <div className="flex items-center gap-2 border-b border-gray-700 px-5 py-3">
          <button
            onClick={() => {
              if (kind === 'window') return
              setLoading(true)
              setError(null)
              setKind('window')
            }}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              kind === 'window' ? 'bg-blue-600 text-white' : 'bg-surface-100 text-gray-400 hover:text-white'
            }`}
          >
            Окна программ
          </button>
          <button
            onClick={() => {
              if (kind === 'screen') return
              setLoading(true)
              setError(null)
              setKind('screen')
            }}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              kind === 'screen' ? 'bg-blue-600 text-white' : 'bg-surface-100 text-gray-400 hover:text-white'
            }`}
          >
            Экраны
          </button>
          {kind === 'screen' && (
            <span className="ml-2 text-[10px] text-gray-500">
              Экран эфира скрыт из списка, чтобы не появлялось бесконечное зеркало.
            </span>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          {loading ? (
            <div className="flex items-center justify-center gap-3 py-16 text-sm text-gray-400">
              <span className="h-5 w-5 animate-spin rounded-full border-2 border-gray-600 border-t-white" />
              Получение списка окон…
            </div>
          ) : visibleSources.length > 0 ? (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
              {visibleSources.map((source) => {
                const selected = source.id === selectedId
                return (
                  <button
                    key={source.id}
                    onClick={() => setSelectedId(source.id)}
                    onDoubleClick={() => selectSource(source)}
                    className={`overflow-hidden rounded-lg border bg-surface-200 text-left transition-colors ${
                      selected
                        ? 'border-blue-500 ring-1 ring-blue-500/60'
                        : 'border-gray-700 hover:border-gray-500'
                    }`}
                  >
                    <div className="relative flex aspect-video items-center justify-center bg-black">
                      {source.isMinimized && source.appIcon ? (
                        <img src={source.appIcon} alt="" draggable={false} className="h-14 w-14 object-contain" />
                      ) : source.thumbnail ? (
                        <img
                          src={source.thumbnail}
                          alt={`Превью: ${source.name}`}
                          draggable={false}
                          className="h-full w-full object-contain"
                        />
                      ) : source.appIcon ? (
                        <img src={source.appIcon} alt="" draggable={false} className="h-12 w-12" />
                      ) : (
                        <span className="text-3xl text-gray-600">{kind === 'window' ? '▣' : '▤'}</span>
                      )}
                      {source.isMinimized && (
                        <span className="absolute right-2 top-2 rounded bg-amber-500/90 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-black">
                          Свёрнуто
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 px-2.5 py-2">
                      {source.appIcon && (
                        <img src={source.appIcon} alt="" draggable={false} className="h-4 w-4 shrink-0" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs text-gray-200" title={source.name}>
                          {source.name || (kind === 'window' ? 'Окно без названия' : 'Экран')}
                        </span>
                        {source.processName && (
                          <span className="mt-0.5 block truncate text-[10px] text-gray-600">
                            {source.processName}
                          </span>
                        )}
                      </span>
                    </div>
                  </button>
                )
              })}
            </div>
          ) : (
            <div className="py-16 text-center text-sm text-gray-500">
              {kind === 'window' ? (
                <>
                  <p>Окна программ для захвата не найдены.</p>
                  <p className="mx-auto mt-2 max-w-lg text-xs leading-relaxed text-gray-600">
                    Список обновляется автоматически. Откройте нужную программу и подождите пару секунд.
                  </p>
                </>
              ) : (
                'Других экранов для захвата не найдено.'
              )}
            </div>
          )}

          {error && (
            <div className="mt-4 rounded-md border border-red-800/70 bg-red-950/40 px-3 py-2 text-xs text-red-300">
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-gray-700 px-5 py-4">
          <button
            onClick={() => void loadSources('foreground')}
            disabled={loading}
            className="text-xs text-gray-400 hover:text-white disabled:opacity-40"
          >
            Обновить список
          </button>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="rounded-md px-4 py-2 text-xs text-gray-300 hover:bg-surface-100"
            >
              Отмена
            </button>
            <button
              onClick={() => { if (selectedSource) selectSource(selectedSource) }}
              disabled={loading || !selectedSource}
              className="rounded-md bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-500 disabled:opacity-40"
            >
              Добавить
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
