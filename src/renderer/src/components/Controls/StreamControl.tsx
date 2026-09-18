import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { DEFAULT_STREAM_SETTINGS, type StreamSettings, type StreamStatus } from '../../../../shared/streaming'
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
  const mounted = useRef(true)
  const selectedDisplayId = useAppStore((s) => s.selectedDisplayId)
  const displayAssignments = useAppStore((s) => s.displayAssignments)
  const setInternalProgramOutputConsumer = useAppStore((s) => s.setInternalProgramOutputConsumer)
  const displays = useAppStore((s) => s.displays)
  const pipAudioEnabled = useAppStore((s) => s.programScene.enabled && s.programScene.audio?.enabled)
  const active = status?.phase === 'running' || status?.phase === 'starting'
  const locked = busy || active

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
      <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/75 p-4" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <section data-pdm-training-panel="stream" role="dialog" aria-modal="true" aria-label="Стрим" className="max-h-[92vh] w-[720px] max-w-[96vw] overflow-y-auto rounded-xl border border-gray-700 bg-gray-800 p-4 text-white shadow-2xl">
          <div className="mb-3 flex items-center justify-between"><h2 className="text-lg font-semibold">Стрим</h2>
            <button data-pdm-training-close type="button" className={button} onClick={() => setOpen(false)} aria-label="Закрыть настройки стрима">✕</button></div>
          <p className="mb-3 text-xs text-gray-300">В трансляцию попадает всё, что видно на эфирном экране, включая PowerPoint, PiP, титры и QR. Посторонние окна на этом экране тоже будут видны.</p>
          <div className="mb-3 text-xs text-gray-300">Источник изображения: {display ? `${display.label || display.id} (${display.bounds.width}×${display.bounds.height})` : 'внутренний программный выход PDM (без дополнительного монитора)'}</div>
          {!display && <p className="mb-3 text-xs text-blue-200">Внутренний режим не показывает панель управления и работает при 25/30 кадрах в секунду.</p>}
          <fieldset disabled={locked} className="space-y-3 disabled:opacity-75">
            <div className="grid grid-cols-4 gap-2 text-xs">
              <label>Разрешение<select className={field} value={settings.resolution} onChange={(e) => update({ resolution: Number(e.target.value) as 720 | 1080 })}><option value={1080}>1920×1080</option><option value={720}>1280×720</option></select></label>
              <label>Кадров/с<select className={field} value={settings.fps} onChange={(e) => update({ fps: Number(e.target.value) as StreamSettings['fps'] })}>{[25, 30, 50, 60].map((fps) => <option key={fps}>{fps}</option>)}</select></label>
              <label>Битрейт, кбит/с<input className={field} type="number" min={500} max={20000} step={500} value={settings.bitrateKbps} onChange={(e) => update({ bitrateKbps: Number(e.target.value) })} /></label>
              <label>Кодирование<select className={field} value={settings.encoder} onChange={(e) => update({ encoder: e.target.value as StreamSettings['encoder'] })}><option value="auto">Авто</option><option value="software">Процессор</option><option value="h264_nvenc">NVIDIA</option><option value="h264_qsv">Intel</option><option value="h264_amf">AMD</option></select></label>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <label>Звук<select className={field} value={settings.audio} onChange={(e) => update({ audio: e.target.value as StreamSettings['audio'] })}><option value="system">Весь системный звук</option><option value="microphone">Микрофон / звуковая карта</option><option value="both">Системный звук + микрофон</option><option value="none">Без звука</option></select></label>
              {(settings.audio === 'microphone' || settings.audio === 'both') && <div><label>Аудиовход<select className={field} value={settings.microphoneId} onChange={(e) => update({ microphoneId: e.target.value })}><option value="">По умолчанию</option>{settings.microphoneId && !devices.some((d) => d.id === settings.microphoneId) && <option value={settings.microphoneId}>Сохранённый аудиовход</option>}{devices.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}</select></label>
                <button type="button" className="mt-1 text-xs text-blue-300 underline" onClick={() => void run(async () => setDevices(await window.api.streaming.devices()))}>Обновить аудиовходы</button></div>}
            </div>
            {(settings.audio === 'system' || settings.audio === 'both') && <p className="text-xs text-amber-200">Системный захват включает звуки других программ и уведомлений с текущего устройства воспроизведения Windows.</p>}
            {pipAudioEnabled && settings.audio === 'both' && <p className="text-xs text-amber-200">Звук камеры PiP уже входит в системный звук. Не выбирайте тот же аудиовход здесь повторно — иначе голос будет дублироваться. Для звука PiP и роликов достаточно «Весь системный звук».</p>}
            <div className="space-y-2">
              {settings.destinations.map((d) => <div key={d.id} className="rounded-lg border border-gray-600 p-2">
                <div className="mb-2 flex items-center gap-2 text-sm"><label className="flex flex-1 items-center gap-2"><input type="checkbox" checked={d.enabled} onChange={(e) => update({ destinations: settings.destinations.map((item) => item.id === d.id ? { ...item, enabled: e.target.checked } : item) })} />{d.name}</label>
                  <button type="button" className="text-xs text-gray-400 hover:text-red-300" onClick={() => update({ destinations: settings.destinations.filter((item) => item.id !== d.id) })}>Удалить</button></div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <label>Адрес сервера<input className={field} type="text" autoComplete="off" spellCheck={false} placeholder="rtmps://…" value={d.server} onChange={(e) => update({ destinations: settings.destinations.map((item) => item.id === d.id ? { ...item, server: e.target.value } : item) })} /></label>
                  <label>Ключ потока<input className={field} type="password" autoComplete="new-password" spellCheck={false} placeholder="Ключ с площадки" value={d.key} onChange={(e) => update({ destinations: settings.destinations.map((item) => item.id === d.id ? { ...item, key: e.target.value } : item) })} /></label>
                </div>
              </div>)}
            </div>
            <div className="flex gap-2"><select aria-label="Добавляемая площадка" className={`${field} flex-1`} value={platform} onChange={(e) => setPlatform(e.target.value)}>{['Telegram', 'VK Видео', 'YouTube', 'Rutube', 'Другой сервис'].map((name) => <option key={name}>{name}</option>)}</select>
              <button type="button" className={button} disabled={settings.destinations.length >= 5} onClick={() => update({ destinations: [...settings.destinations, { id: crypto.randomUUID(), name: platform, enabled: true, server: '', key: '' }] })}>Добавить площадку</button></div>
          </fieldset>
          <p className="my-3 text-xs text-gray-400">Создайте трансляцию на площадке и скопируйте её сервер и ключ. Все выбранные площадки получают одинаковое качество. При нескольких площадках исходящая скорость суммируется.</p>
          <button type="button" className={button} disabled={locked} onClick={() => void run(async () => {
            const results = await window.api.streaming.check(settings)
            setMessage(results.map((r) => `${r.name}: ${r.reachable ? 'сервер доступен' : 'нет соединения — проверьте адрес, порт и интернет'}`).join('; ') + '. Проверка не отправляет эфир и не проверяет ключ потока.')
          })}>Проверить адреса без эфира</button>
          {active && <div className="my-3 rounded-lg bg-gray-900 p-2 text-xs" aria-live="polite">
            <div>{status?.phase === 'starting' ? 'Подготовка захвата и кодера…' : `${elapsed} · ${status?.encoder} · ${status?.fps.toFixed(1)} кадр/с · ${status?.bitrateKbps} кбит/с · отставание кодера: ${status?.encoderLagMs ?? 0} мс`}</div>
            {status?.destinations.map((d) => <div key={d.id} className={d.phase === 'live' ? 'mt-1 text-green-300' : 'mt-1 text-amber-300'}>{d.name}: {d.phase === 'live' ? `передача · ${d.bitrateKbps} кбит/с · очередь отправки ${d.bufferedMs} мс` : d.phase === 'connecting' ? 'подключение…' : `переподключение, попытка ${d.retries}`}{d.error && <div className="mt-1 text-xs">{d.error}</div>}</div>)}
            <div className="mt-1 text-gray-400">Здесь показана задержка внутри PDM. Буфер плеера площадки измеряется отдельно.</div>
          </div>}
          {(message || status?.error) && <p role="status" className="my-2 break-words text-sm text-amber-200">{message || status?.error}</p>}
          {!available && <p className="my-2 text-xs text-amber-200">Для стриминга нужна Windows-сборка PDM с установленным модулем FFmpeg.</p>}
          <div className="mt-3 flex items-center justify-between gap-2">
            <button type="button" className={button} disabled={locked || !canSave} onClick={() => void run(async () => { await window.api.streaming.save(settings); setMessage('Настройки сохранены. Ключи зашифрованы для текущего пользователя.'); })}>Сохранить настройки</button>
            <div className="flex gap-2"><button type="button" className={button} onClick={() => setOpen(false)}>Закрыть</button>
              {active ? <button type="button" className="rounded bg-red-600 px-4 py-1.5 text-sm hover:bg-red-500" onClick={() => void run(async () => {
                try { await window.api.streaming.stop() }
                finally { setInternalProgramOutputConsumer('stream', false) }
              })}>Остановить стрим</button>
                : <button type="button" className="rounded bg-red-600 px-4 py-1.5 text-sm hover:bg-red-500 disabled:opacity-40" disabled={busy || !available || (programDisplayId === null && settings.fps > 30)} onClick={() => void run(async () => {
                  setInternalProgramOutputConsumer('stream', programDisplayId === null)
                  try {
                    if (programDisplayId === null) await window.api.prepareInternalProgramOutput()
                    else if (!await window.api.placePresentationWindow(programDisplayId)) {
                      throw new Error('Не удалось подготовить назначенный эфирный экран.')
                    }
                    await window.api.streaming.start(settings, programDisplayId)
                  }
                  catch (error) { setInternalProgramOutputConsumer('stream', false); throw error }
                })}>Начать трансляцию</button>}
            </div>
          </div>
        </section>
      </div>, document.body)}
  </>
}
