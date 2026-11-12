import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { DEFAULT_RECORDING_SETTINGS, type RecordingSettings, type RecordingStatus } from '../../../../shared/recording'
import { connectedProgramDisplayId, useAppStore } from '../../stores/useAppStore'
import { RecordingEditor } from './RecordingEditor'

const field = 'w-full rounded border border-gray-600 bg-gray-900 px-2 py-1.5 text-sm text-white'
const button = 'rounded border border-gray-600 px-3 py-1.5 text-sm hover:bg-gray-700 disabled:opacity-40'
const errorText = (error: unknown): string => String(error instanceof Error ? error.message : error)
  .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')

export function RecordControl(): JSX.Element {
  const [open, setOpen] = useState(false)
  const [confirmStop, setConfirmStop] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [autoOpenLastRequest, setAutoOpenLastRequest] = useState(0)
  const [settings, setSettings] = useState<RecordingSettings>({ ...DEFAULT_RECORDING_SETTINGS })
  const [status, setStatus] = useState<RecordingStatus | null>(null)
  const [devices, setDevices] = useState<Array<{ id: string; label: string }>>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const mounted = useRef(true)
  const starting = useRef(false)
  const displays = useAppStore(s => s.displays)
  const selectedDisplayId = useAppStore(s => s.selectedDisplayId)
  const displayAssignments = useAppStore(s => s.displayAssignments)
  const setInternalConsumer = useAppStore(s => s.setInternalProgramOutputConsumer)
  const programDisplayId = connectedProgramDisplayId({ displays, displayAssignments, selectedDisplayId })
  const active = status?.phase === 'running' || status?.phase === 'starting' || status?.phase === 'stopping'

  useEffect(() => {
    if (status?.phase === 'idle' || status?.phase === 'error') setConfirmStop(false)
  }, [status?.phase])

  useEffect(() => {
    mounted.current = true
    void window.api.recording.load().then(result => { if (mounted.current) setSettings(result) }).catch(() => {})
    let pending = false
    const poll = (): void => {
      if (pending) return
      pending = true
      void window.api.recording.status().then(result => {
        if (!mounted.current) return
        setStatus(result)
        if (!starting.current && (result.phase === 'idle' || result.phase === 'error')) setInternalConsumer('recording', false)
      }).catch(() => {}).finally(() => { pending = false })
    }
    poll()
    const timer = setInterval(poll, 1000)
    return () => { mounted.current = false; clearInterval(timer) }
  }, [setInternalConsumer])

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true); setMessage('')
    try { await action(); setStatus(await window.api.recording.status()) }
    catch (error) { setMessage(errorText(error)); setStatus(await window.api.recording.status().catch(() => null)) }
    finally { setBusy(false) }
  }
  const startedAt = status?.startedAt
  const duration = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0
  const elapsed = `${Math.floor(duration / 3600).toString().padStart(2, '0')}:${Math.floor(duration / 60 % 60).toString().padStart(2, '0')}:${(duration % 60).toString().padStart(2, '0')}`
  const size = status ? `${(status.sizeBytes / 1024 / 1024).toFixed(1)} МБ` : ''

  return <>
    <button data-pdm-training-record-open type="button" onClick={() => setOpen(true)} title={active ? `Запись эфира ${elapsed}` : 'Запись эфира в файл'}
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      className={`whitespace-nowrap rounded-lg border px-2 py-1 text-[11px] font-medium ${active ? 'border-red-500 bg-red-600 text-white' : 'border-gray-700 bg-surface-100 text-gray-300 hover:bg-gray-700'}`}>
      ● Запись{active ? ` ${elapsed}` : ''}
    </button>
    {open && createPortal(<div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/75 p-4" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
      <section data-pdm-training-panel="recording" data-pdm-training-record-phase={status?.phase} data-pdm-training-record-has-file={!!status?.path}
        role="dialog" aria-modal="true" aria-label="Запись эфира" className="w-[590px] max-w-[96vw] rounded-xl border border-gray-700 bg-gray-800 p-4 text-white shadow-2xl">
        <div className="mb-3 flex items-center justify-between"><h2 className="text-lg font-semibold">Запись эфира</h2>
          <button data-pdm-training-close type="button" className={button} onClick={() => setOpen(false)} aria-label="Закрыть настройки записи">✕</button></div>
        <p className="mb-3 text-xs text-gray-300">Сохраняется итоговая картинка эфира и выбранный звук. Запись работает независимо от стрима.</p>
        <p className="mb-3 text-xs text-gray-300">Источник: {programDisplayId === null ? 'внутренний выход PDM' : displays.find(d => d.id === programDisplayId)?.label || 'эфирный экран'}</p>
        <fieldset disabled={active || busy} className="space-y-3 disabled:opacity-65">
          <div className="grid grid-cols-2 gap-2 text-xs">
            <label>Качество<select data-pdm-training-record-quality className={field} value={settings.format} onChange={e => setSettings(s => ({ ...s, format: e.target.value as RecordingSettings['format'] }))}>
              <option value="lossless-mkv">MKV — без потерь</option><option value="quality-mp4">MP4 — высокое качество</option>
            </select></label>
            <label>Кадров/с<select className={field} value={settings.fps} onChange={e => setSettings(s => ({ ...s, fps: Number(e.target.value) as RecordingSettings['fps'] }))}>
              {[25, 30, 50, 60].map(fps => <option key={fps}>{fps}</option>)}
            </select></label>
          </div>
          <label className="block text-xs">Звук<select data-pdm-training-record-audio className={field} value={settings.audio} onChange={e => setSettings(s => ({ ...s, audio: e.target.value as RecordingSettings['audio'] }))}>
            <option value="system">Системный звук</option><option value="microphone">Микрофон / звуковая карта</option>
            <option value="both">Системный звук + микрофон</option><option value="none">Без звука</option>
          </select></label>
          {(settings.audio === 'microphone' || settings.audio === 'both') && <div className="text-xs"><label>Аудиовход<select className={field} value={settings.microphoneId} onChange={e => setSettings(s => ({ ...s, microphoneId: e.target.value }))}>
            <option value="">По умолчанию</option>{settings.microphoneId && !devices.some(d => d.id === settings.microphoneId) && <option value={settings.microphoneId}>Сохранённый аудиовход</option>}
            {devices.map(d => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select></label><button type="button" className="mt-1 text-blue-300 underline" onClick={() => void run(async () => { setDevices(await window.api.recording.devices()) })}>Обновить аудиовходы</button></div>}
        </fieldset>
        {programDisplayId === null && settings.fps > 30 && <p className="mt-2 text-xs text-amber-200">Без дополнительного эфирного экрана выберите 25 или 30 кадров/с.</p>}
        {settings.format === 'lossless-mkv' && <p className="mt-3 text-xs text-amber-200">MKV сохраняет кадры и звук без сжатия с потерями. Файл может быть очень большим; проверьте свободное место.</p>}
        {settings.audio === 'system' || settings.audio === 'both' ? <p className="mt-3 text-xs text-amber-200">Системный звук включает звуки других программ и уведомлений Windows.</p> : null}
        {active && <div className="mt-3 rounded-lg bg-gray-900 p-2 text-xs" aria-live="polite">
          {status?.phase === 'starting' ? 'Подготовка записи…' : status?.phase === 'stopping' ? 'Завершение файла…' : `${elapsed} · ${size} · ${status?.frames} кадров · кодирование ${status?.fps.toFixed(1)} кадр/с · пропущено ${status?.droppedFrames}`}
          {status?.path && <div className="mt-1 break-all text-gray-300">{status.path}</div>}
        </div>}
        {status?.phase === 'running' && duration >= 10 && (status.fps < settings.fps * 0.8 || status.droppedFrames > 0) &&
          <p className="mt-2 text-xs text-amber-200">Запись не успевает за выбранной частотой кадров. Проверьте файл; уменьшите частоту до 25 кадров/с или освободите ресурсы компьютера.</p>}
        {!active && status?.path && <div className="mt-3 break-all text-xs text-gray-300">Последний файл: {status.path} · {size}</div>}
        {(message || status?.error) && <p role="status" className="mt-3 text-sm text-amber-200">{message || status?.error}</p>}
        <div className="mt-4 flex items-center justify-between gap-2">
          <div className="flex gap-2"><button type="button" className={button} disabled={active || busy} onClick={() => void run(async () => { await window.api.recording.save(settings); setMessage('Настройки записи сохранены.') })}>Сохранить настройки</button>
            <button data-pdm-training-record-montage type="button" className={button} disabled={active || busy} onClick={() => { setOpen(false); setEditorOpen(true) }}>Монтаж записи</button></div>
          <div className="flex gap-2"><button type="button" className={button} onClick={() => setOpen(false)}>Закрыть</button>
            {active ? <button data-pdm-training-record-stop type="button" disabled={busy || status?.phase === 'stopping'} className="rounded bg-red-600 px-4 py-1.5 text-sm disabled:opacity-40" onClick={() => setConfirmStop(true)}>Остановить запись</button>
              : <button data-pdm-training-record-start type="button" disabled={busy || (programDisplayId === null && settings.fps > 30)} className="rounded bg-red-600 px-4 py-1.5 text-sm disabled:opacity-40" onClick={() => void run(async () => {
                starting.current = true
                setInternalConsumer('recording', programDisplayId === null)
                try {
                  if (programDisplayId === null) await window.api.prepareInternalProgramOutput()
                  else if (!await window.api.placePresentationWindow(programDisplayId)) throw new Error('Не удалось подготовить эфирный экран.')
                  const started = await window.api.recording.start(settings, programDisplayId)
                  if (!started) setInternalConsumer('recording', false)
                } catch (error) { setInternalConsumer('recording', false); throw error }
                finally { starting.current = false }
              })}>Начать запись</button>}
          </div>
        </div>
      </section>
    </div>, document.body)}
    {open && confirmStop && active && createPortal(<div className="fixed inset-0 z-[160] flex items-center justify-center bg-black/80 p-4" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
      <section role="alertdialog" aria-modal="true" aria-labelledby="record-stop-title" aria-describedby="record-stop-description" className="w-[420px] max-w-[96vw] rounded-xl border border-amber-500/60 bg-gray-800 p-5 text-white shadow-2xl">
        <h2 id="record-stop-title" className="text-lg font-semibold">Остановить запись?</h2>
        <p id="record-stop-description" className="mt-2 text-sm text-gray-200">PDM завершит файл записи. Продолжить запись в этот же файл после остановки нельзя.</p>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" autoFocus className={button} onClick={() => setConfirmStop(false)}>Продолжить запись</button>
          <button data-pdm-training-record-confirm type="button" disabled={busy || status?.phase === 'stopping'} className="rounded bg-red-600 px-4 py-1.5 text-sm hover:bg-red-500 disabled:opacity-40" onClick={() => {
            setConfirmStop(false)
            void run(async () => {
              await window.api.recording.stop()
              setInternalConsumer('recording', false)
              const finished = await window.api.recording.status()
              if (finished.phase === 'idle' && finished.path) setAutoOpenLastRequest(value => value + 1)
            })
          }}>Остановить запись</button>
        </div>
      </section>
    </div>, document.body)}
    <RecordingEditor open={editorOpen} onClose={() => setEditorOpen(false)} lastAvailable={status?.phase === 'idle' && !!status.path}
      autoOpenLastRequest={autoOpenLastRequest} />
  </>
}
