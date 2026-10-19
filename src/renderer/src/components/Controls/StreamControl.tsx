import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { DEFAULT_STREAM_SETTINGS, formatStreamDuration, streamDelayStorageBytes, type StreamSettings, type StreamStatus } from '../../../../shared/streaming'
import { connectedProgramDisplayId, useAppStore } from '../../stores/useAppStore'

const field = 'w-full rounded border border-gray-600 bg-gray-900 px-2 py-1.5 text-sm text-white disabled:opacity-50'
const button = 'rounded border border-gray-600 px-3 py-1.5 text-sm hover:bg-gray-700 disabled:opacity-40'
const errorText = (error: unknown): string => String(error instanceof Error ? error.message : error)
  .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')

export function StreamControl(): JSX.Element {
  const [open, setOpen] = useState(false)
  const [settings, setSettings] = useState<StreamSettings>(structuredClone(DEFAULT_STREAM_SETTINGS))
  const [status, setStatus] = useState<StreamStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [available, setAvailable] = useState(false)
  const [canSave, setCanSave] = useState(false)
  const [message, setMessage] = useState('')
  const [devices, setDevices] = useState<Array<{ id: string; label: string }>>([])
  const [platform, setPlatform] = useState('VK Видео')
  const [destinationId, setDestinationId] = useState('')
  const panelRef = useRef<HTMLElement>(null)
  const [panelFit, setPanelFit] = useState({ width: 1000, height: 0, scale: 1 })
  const mounted = useRef(true)
  const selectedDisplayId = useAppStore((s) => s.selectedDisplayId)
  const displayAssignments = useAppStore((s) => s.displayAssignments)
  const setInternalProgramOutputConsumer = useAppStore((s) => s.setInternalProgramOutputConsumer)
  const displays = useAppStore((s) => s.displays)
  const pipAudioEnabled = useAppStore((s) => s.programScene.enabled && s.programScene.audio?.enabled)
  const active = status?.phase === 'running' || status?.phase === 'starting' || status?.phase === 'draining'
  const locked = busy || active

  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!open || !panel) return
    const measure = (): void => {
      const width = Math.min(1000, Math.max(320, window.innerWidth - 24))
      panel.style.width = `${width}px`
      const height = panel.offsetHeight
      const scale = Math.min(1, (window.innerWidth - 24) / width, (window.innerHeight - 24) / Math.max(1, height))
      setPanelFit((previous) => previous.width === width && previous.height === height && Math.abs(previous.scale - scale) < 0.001
        ? previous : { width, height, scale })
    }
    const observer = new ResizeObserver(measure)
    observer.observe(panel); window.addEventListener('resize', measure); measure()
    return () => { observer.disconnect(); window.removeEventListener('resize', measure) }
  }, [open])

  useEffect(() => {
    mounted.current = true
    void window.api.streaming.load().then((result) => {
      if (!mounted.current) return
      setSettings(result.settings); setCanSave(result.canSave); setAvailable(result.available)
      if (result.warning) setMessage(result.warning)
    }).catch((e) => { if (mounted.current) setMessage(errorText(e)) })
    let pending = false
    const poll = (): void => {
      if (pending) return
      pending = true
      void window.api.streaming.status().then((result) => { if (mounted.current) setStatus(result) })
        .catch(() => {}).finally(() => { pending = false })
    }
    poll()
    const timer = setInterval(poll, 1000)
    return () => { mounted.current = false; clearInterval(timer) }
  }, [])

  const update = (patch: Partial<StreamSettings>): void => { setSettings((s) => ({ ...s, ...patch })); setMessage('') }
  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true); setMessage('')
    try { await action(); setStatus(await window.api.streaming.status()) }
    catch (e) { setMessage(errorText(e)) }
    finally { setBusy(false) }
  }
  const duration = status?.startedAt ? Math.floor((Date.now() - status.startedAt) / 1000) : 0
  const elapsed = `${Math.floor(duration / 3600).toString().padStart(2, '0')}:${Math.floor(duration / 60 % 60).toString().padStart(2, '0')}:${(duration % 60).toString().padStart(2, '0')}`
  const live = status?.destinations.some((d) => d.phase === 'live')
  const programDisplayId = connectedProgramDisplayId({ displays, displayAssignments, selectedDisplayId })
  const display = displays.find((d) => d.id === programDisplayId)
  const delaySeconds = settings.delaySeconds ?? 0
  const delayStorage = streamDelayStorageBytes(delaySeconds, settings.bitrateKbps)
  const destination = settings.destinations.find((d) => d.id === destinationId) || settings.destinations[0]

  useEffect(() => {
    if (status?.source !== 'internal') return
    if (status.phase === 'idle' || status.phase === 'error') setInternalProgramOutputConsumer('stream', false)
  }, [setInternalProgramOutputConsumer, status?.phase, status?.source])

  return <>
    <button type="button" onClick={() => setOpen(true)}
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      title={live ? `Трансляция ${elapsed}` : 'Трансляция в Telegram, VK и другие сервисы'}
      className={`whitespace-nowrap rounded-lg border px-2 py-1 text-[11px] font-medium ${live ? 'border-red-500 bg-red-600 text-white' : active || status?.phase === 'error' ? 'border-amber-500 text-amber-300' : 'border-gray-700 bg-surface-100 text-gray-300 hover:bg-gray-700'}`}>
      ● Стрим{active && !live ? ' …' : ''}
    </button>
    {open && createPortal(
      <div className="fixed inset-0 z-[150] flex items-center justify-center overflow-hidden bg-black/75 p-3" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <div className="relative shrink-0" style={{ width: panelFit.width * panelFit.scale, height: panelFit.height * panelFit.scale }}>
        <section ref={panelRef} data-pdm-training-panel="stream" role="dialog" aria-modal="true" aria-label="Стрим"
          className="absolute left-0 top-0 rounded-2xl border border-gray-600 bg-gray-800 p-4 text-white shadow-2xl"
          style={{ width: panelFit.width, transform: `scale(${panelFit.scale})`, transformOrigin: 'top left' }}>
          <div className="mb-2 flex items-center justify-between gap-3">
            <div><h2 className="text-lg font-semibold">Стрим</h2>
              <p className="mt-0.5 text-[11px] text-gray-400">{display ? `${display.label || display.id} · ${display.bounds.width}×${display.bounds.height}` : 'Внутренний выход PDM · до 30 кадров/с'}</p></div>
            <button data-pdm-training-close type="button" className={button} onClick={() => setOpen(false)} aria-label="Закрыть настройки стрима">✕</button>
          </div>
          <p className="mb-3 text-[11px] text-gray-300">В трансляцию попадает эфирный экран вместе с PiP, титрами и QR. Посторонние окна на этом экране тоже видны зрителям.</p>
          <div className="grid grid-cols-2 gap-4">
            <fieldset disabled={locked} className="min-w-0 space-y-3">
              <div className="rounded-xl border border-gray-700 bg-gray-900/35 p-3">
                <h3 className="mb-2 text-xs font-semibold text-gray-200">Качество и звук</h3>
                <div className="grid grid-cols-2 gap-2 text-[11px] text-gray-300">
                  <label>Разрешение<select className={field} value={settings.resolution} onChange={(e) => update({ resolution: Number(e.target.value) as 720 | 1080 })}><option value={1080}>1920×1080</option><option value={720}>1280×720</option></select></label>
                  <label>Кадров/с<select className={field} value={settings.fps} onChange={(e) => update({ fps: Number(e.target.value) as StreamSettings['fps'] })}>{[25, 30, 50, 60].map((fps) => <option key={fps}>{fps}</option>)}</select></label>
                  <label>Битрейт, кбит/с<input className={field} type="number" min={500} max={20000} step={500} value={settings.bitrateKbps} onChange={(e) => update({ bitrateKbps: Number(e.target.value) })} /></label>
                  <label>Кодирование<select className={field} value={settings.encoder} onChange={(e) => update({ encoder: e.target.value as StreamSettings['encoder'] })}><option value="auto">Авто</option><option value="software">Процессор</option>{window.api.platform === 'darwin' ? <option value="h264_videotoolbox">Apple VideoToolbox</option> : <><option value="h264_nvenc">NVIDIA</option><option value="h264_qsv">Intel</option><option value="h264_amf">AMD</option></>}</select></label>
                  <label className={settings.audio === 'microphone' || settings.audio === 'both' ? '' : 'col-span-2'}>Звук<select className={field} value={settings.audio} onChange={(e) => update({ audio: e.target.value as StreamSettings['audio'] })}><option value="system">Весь системный звук</option><option value="microphone">Микрофон / звуковая карта</option><option value="both">Системный звук + микрофон</option><option value="none">Без звука</option></select></label>
                  {(settings.audio === 'microphone' || settings.audio === 'both') && <div><label>Аудиовход<select className={field} value={settings.microphoneId} onChange={(e) => update({ microphoneId: e.target.value })}><option value="">По умолчанию</option>{settings.microphoneId && !devices.some((d) => d.id === settings.microphoneId) && <option value={settings.microphoneId}>Сохранённый аудиовход</option>}{devices.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}</select></label>
                    <button type="button" className="mt-1 text-blue-300 underline" onClick={() => void run(async () => setDevices(await window.api.streaming.devices()))}>Обновить входы</button></div>}
                </div>
                {(settings.audio === 'system' || settings.audio === 'both') && <p className="mt-2 text-[10px] leading-snug text-amber-200/90">Системный звук включает уведомления и звуки других программ.</p>}
                {pipAudioEnabled && settings.audio === 'both' && <p className="mt-1 text-[10px] leading-snug text-amber-200/90">Не выбирайте аудиовход камеры PiP повторно: её звук уже входит в системный.</p>}
              </div>
              <div className="rounded-xl border border-gray-700 bg-gray-900/35 p-3">
                <div className="grid grid-cols-[140px_1fr] gap-3 text-[11px] text-gray-300">
                  <label>Задержка, секунд<input aria-label="Задержка, секунд" className={field} type="number" min={0} step={1} value={delaySeconds} onChange={(e) => update({ delaySeconds: Number(e.target.value) })} /></label>
                  <label>При остановке<select aria-label="При остановке стрима" className={field} value={settings.drainOnStop === false ? 'immediate' : 'drain'} onChange={(e) => update({ drainOnStop: e.target.value === 'drain' })}><option value="drain">Дослать накопленный эфир</option><option value="immediate">Остановить сразу</option></select></label>
                </div>
                <p className="mt-2 text-[10px] leading-snug text-gray-400">0 — отправка сразу. Буферизация площадки добавляется отдельно.</p>
                {delaySeconds > 0 && <p className="mt-1 text-[10px] leading-snug text-blue-200">Буфер {formatStreamDuration(delaySeconds)} · примерно {(delayStorage / 1024 ** 3).toFixed(2)} ГБ на диске. Отправка начнётся после накопления.</p>}
                <p className="mt-1 text-[10px] leading-snug text-gray-400">Для досылки оставьте PDM открытым.</p>
              </div>
            </fieldset>
            <div className="min-w-0 rounded-xl border border-gray-700 bg-gray-900/35 p-3">
              <h3 className="mb-2 text-xs font-semibold text-gray-200">Площадки</h3>
              <div className="mb-3 flex flex-wrap gap-1.5" role="tablist" aria-label="Площадки трансляции">
                {settings.destinations.map((d) => <button key={d.id} type="button" role="tab" aria-selected={d.id === destination?.id} onClick={() => setDestinationId(d.id)}
                  className={`max-w-full truncate rounded-md border px-2.5 py-1 text-xs ${d.id === destination?.id ? 'border-blue-500 bg-blue-500/15 text-blue-200' : 'border-gray-700 text-gray-400 hover:text-white'}`}>
                  <span className={d.enabled ? 'mr-1.5 text-green-400' : 'mr-1.5 text-gray-600'}>●</span>{d.name}
                </button>)}
              </div>
              <fieldset disabled={locked} className="space-y-2.5 text-[11px] text-gray-300">
                {destination ? <div className="rounded-lg border border-gray-700 bg-gray-800/50 p-2.5">
                  <div className="mb-2 flex items-center justify-between gap-2"><label className="flex min-w-0 items-center gap-2"><input type="checkbox" checked={destination.enabled} onChange={(e) => update({ destinations: settings.destinations.map(d => d.id === destination.id ? { ...d, enabled: e.target.checked } : d) })} /><span className="truncate">Передавать в {destination.name}</span></label>
                    <button type="button" className="text-gray-400 hover:text-red-300" onClick={() => update({ destinations: settings.destinations.filter(d => d.id !== destination.id) })}>Удалить</button></div>
                  <label className="mb-2 block">Адрес сервера<input className={field} type="text" autoComplete="off" spellCheck={false} placeholder="rtmps://…" value={destination.server} onChange={(e) => update({ destinations: settings.destinations.map(d => d.id === destination.id ? { ...d, server: e.target.value } : d) })} /></label>
                  <label className="block">Ключ потока<input className={field} type="password" autoComplete="new-password" spellCheck={false} placeholder="Ключ с площадки" value={destination.key} onChange={(e) => update({ destinations: settings.destinations.map(d => d.id === destination.id ? { ...d, key: e.target.value } : d) })} /></label>
                </div> : <div className="rounded-lg border border-dashed border-gray-600 p-4 text-center text-gray-400">Добавьте площадку для трансляции</div>}
                <div className="flex gap-2"><select aria-label="Добавляемая площадка" className={`${field} min-w-0 flex-1`} value={platform} onChange={(e) => setPlatform(e.target.value)}>{['Telegram', 'VK Видео', 'YouTube', 'Rutube', 'Другой сервис'].map((name) => <option key={name}>{name}</option>)}</select>
                  <button type="button" className={button} disabled={settings.destinations.length >= 5} onClick={() => { const id = crypto.randomUUID(); update({ destinations: [...settings.destinations, { id, name: platform, enabled: true, server: '', key: '' }] }); setDestinationId(id) }}>Добавить</button></div>
              </fieldset>
              <p className="my-2 text-[10px] leading-snug text-gray-400">Скопируйте сервер и ключ из настроек трансляции площадки. Все включённые площадки получают одинаковый поток.</p>
              <button type="button" className={`${button} text-xs`} disabled={locked} onClick={() => void run(async () => {
                const results = await window.api.streaming.check(settings)
                setMessage(results.map(r => `${r.name}: ${r.reachable ? 'сервер доступен' : 'нет соединения — проверьте адрес, порт и интернет'}`).join('; ') + '. Проверка не отправляет эфир и не проверяет ключ.')
              })}>Проверить адреса без эфира</button>
            </div>
          </div>
          {active && <div className="mt-3 rounded-xl border border-gray-700 bg-gray-900/70 px-3 py-2 text-[11px]" aria-live="polite">
            <div className="text-gray-300">{status?.phase === 'starting' ? 'Подготовка захвата и кодера…' : `${elapsed} · ${status?.encoder} · ${status?.fps.toFixed(1)} кадр/с · ${status?.bitrateKbps} кбит/с · отставание кодера ${status?.encoderLagMs ?? 0} мс`}</div>
            {status?.delay && <div className="mt-1 text-blue-200">{status.phase === 'draining' ? `Досылаем эфир · осталось ${formatStreamDuration(status.delay.remainingMs / 1000)}` : status.delay.buffering ? `Накопление буфера · до отправки ${formatStreamDuration(status.delay.remainingMs / 1000)}` : `Задержка отправки ${status.delay.seconds} с`} · буфер {(status.delay.storedBytes / 1024 ** 2).toFixed(1)} МБ</div>}
            <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1">{status?.destinations.map(d => <div key={d.id} className={d.phase === 'live' ? 'text-green-300' : 'text-amber-300'}>
              {d.name}: {status.delay?.buffering ? 'ожидание буфера' : d.phase === 'live' ? `${d.bitrateKbps} кбит/с · очередь ${d.bufferedMs} мс` : d.phase === 'connecting' ? 'подключение…' : `переподключение ${d.retries}`}{d.error && <div>{d.error}</div>}
            </div>)}</div>
          </div>}
          {(message || status?.error) && <p role="status" className="mt-2 break-words text-xs text-amber-200">{message || status?.error}</p>}
          {!available && <p className="mt-2 text-xs text-amber-200">Нужна Stream-редакция PDM с модулем FFmpeg.</p>}
          <div className="mt-3 flex items-center justify-between gap-2 border-t border-gray-700 pt-3">
            <button type="button" className={`${button} text-xs`} disabled={locked || !canSave} onClick={() => void run(async () => { await window.api.streaming.save(settings); setMessage('Настройки сохранены. Ключи зашифрованы для текущего пользователя.'); })}>Сохранить настройки</button>
            <div className="flex gap-2"><button type="button" className={`${button} text-xs`} onClick={() => setOpen(false)}>Закрыть</button>
              {active ? <button type="button" className="rounded-lg bg-red-600 px-4 py-1.5 text-xs font-medium hover:bg-red-500" onClick={() => void run(async () => {
                try { await window.api.streaming.stop(status?.phase === 'draining') }
                finally { setInternalProgramOutputConsumer('stream', false) }
              })}>{status?.phase === 'draining' ? 'Остановить сразу' : delaySeconds > 0 && settings.drainOnStop !== false ? 'Завершить с досылкой' : 'Остановить стрим'}</button>
                : <button type="button" className="rounded-lg bg-red-600 px-4 py-1.5 text-xs font-medium hover:bg-red-500 disabled:opacity-40" disabled={busy || !available || (programDisplayId === null && settings.fps > 30)} onClick={() => void run(async () => {
                  setInternalProgramOutputConsumer('stream', programDisplayId === null)
                  try {
                    if (programDisplayId === null) await window.api.prepareInternalProgramOutput()
                    else if (!await window.api.placePresentationWindow(programDisplayId)) throw new Error('Не удалось подготовить назначенный эфирный экран.')
                    await window.api.streaming.start(settings, programDisplayId)
                  } catch (error) { setInternalProgramOutputConsumer('stream', false); throw error }
                })}>Начать трансляцию</button>}
            </div>
          </div>
        </section></div>
      </div>, document.body)}
  </>
}
