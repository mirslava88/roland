import { useEffect, useRef, useState } from 'react'
import type { VirtualCameraStatus } from '../../../../shared/virtual-camera'
import { connectedProgramDisplayId, useAppStore } from '../../stores/useAppStore'

const button = 'rounded-lg border px-4 py-2 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40'
const errorText = (error: unknown): string => String(error instanceof Error ? error.message : error)
  .replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')

export function VirtualCameraSettings(): JSX.Element {
  const [status, setStatus] = useState<VirtualCameraStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const mounted = useRef(true)
  const displays = useAppStore((state) => state.displays)
  const displayAssignments = useAppStore((state) => state.displayAssignments)
  const selectedDisplayId = useAppStore((state) => state.selectedDisplayId)
  const setInternalProgramOutputConsumer = useAppStore((state) => state.setInternalProgramOutputConsumer)
  const programDisplayId = connectedProgramDisplayId({ displays, displayAssignments, selectedDisplayId })
  const display = displays.find((item) => item.id === programDisplayId)
  const active = status?.phase === 'running' || status?.phase === 'starting'
  const recovering = status?.phase === 'running' && !!status.error

  useEffect(() => {
    mounted.current = true
    let pending = false
    const refresh = (): void => {
      if (pending) return
      pending = true
      void window.api.virtualCamera.status()
        .then((value) => {
          if (!mounted.current) return
          setStatus(value)
          setInternalProgramOutputConsumer(
            'virtualCamera',
            (value.phase === 'running' || value.phase === 'starting') && value.source === 'internal'
          )
        })
        .catch((error) => { if (mounted.current) setMessage(errorText(error)) })
        .finally(() => { pending = false })
    }
    refresh()
    const timer = setInterval(refresh, 1000)
    return () => { mounted.current = false; clearInterval(timer) }
  }, [setInternalProgramOutputConsumer])

  const run = async (action: () => Promise<VirtualCameraStatus>): Promise<void> => {
    setBusy(true)
    setMessage('')
    try {
      const value = await action()
      if (mounted.current) setStatus(value)
    } catch (error) {
      if (mounted.current) setMessage(errorText(error))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }

  const start = async (): Promise<VirtualCameraStatus> => {
    if (status && !status.supported) {
      throw new Error('Виртуальная камера PDM доступна только в Windows 11 и более новых версиях Windows.')
    }
    const internal = programDisplayId === null
    setInternalProgramOutputConsumer('virtualCamera', internal)
    try {
      if (internal) await window.api.prepareInternalProgramOutput()
      else if (!await window.api.placePresentationWindow(programDisplayId)) {
        throw new Error('Не удалось подготовить назначенный эфирный экран.')
      }
      return await window.api.virtualCamera.start(programDisplayId)
    } catch (error) {
      setInternalProgramOutputConsumer('virtualCamera', false)
      throw error
    }
  }

  const stop = async (): Promise<VirtualCameraStatus> => {
    try { return await window.api.virtualCamera.stop() }
    finally { setInternalProgramOutputConsumer('virtualCamera', false) }
  }

  return (
    <div data-pdm-virtual-camera-settings className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-gray-200">Виртуальная камера PDM</h3>
        <p className="mt-1 text-[11px] leading-5 text-gray-400">
          В Zoom, Teams, Telegram и других программах выберите камеру «PDM Virtual Camera».
          В некоторых программах Windows добавляет к названию слова «Windows Virtual Camera».
          Она показывает итоговый эфир PDM: презентацию, сцену, титры, QR-код и таймер.
          Дополнительный монитор для этого не нужен — без него PDM автоматически использует скрытый внутренний эфир.
        </p>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-lg border border-gray-700 bg-surface-100 p-3">
          <div className="text-[10px] text-gray-500">Качество</div>
          <div className="mt-1 text-xs font-medium text-white">1920×1080 · 30 кадров/с</div>
        </div>
        <div className="rounded-lg border border-gray-700 bg-surface-100 p-3">
          <div className="text-[10px] text-gray-500">Пропорции</div>
          <div className="mt-1 text-xs font-medium text-white">Без растягивания</div>
        </div>
        <div className="rounded-lg border border-gray-700 bg-surface-100 p-3">
          <div className="text-[10px] text-gray-500">Источник</div>
          <div className="mt-1 text-xs font-medium text-white">
            {display ? display.label || `Дисплей ${display.id}` : 'Внутренний эфир PDM'}
          </div>
        </div>
      </div>

      <div className={`rounded-lg border p-3 ${recovering ? 'border-amber-500/60 bg-amber-950/25' : active ? 'border-emerald-500/60 bg-emerald-950/25' : 'border-gray-700 bg-surface-100'}`}>
        <div className="flex items-center justify-between gap-4">
          <div>
            <div className="text-xs font-medium text-white">
              {recovering ? 'Восстановление изображения…' : status?.phase === 'running' ? 'Виртуальная камера включена' :
                status?.phase === 'starting' ? 'Запуск виртуальной камеры…' :
                  status?.phase === 'installing' ? 'Установка компонента…' :
                    status?.phase === 'error' ? 'Виртуальная камера остановлена' : 'Виртуальная камера выключена'}
            </div>
            <div className="mt-1 text-[10px] text-gray-400">
              {recovering ? 'Камера остаётся включённой. PDM повторяет подключение к изображению эфира.' : active ? 'Изображение доступно другим программам как обычная веб-камера.' : 'Включите её перед выбором камеры в программе для видеозвонка или записи.'}
            </div>
          </div>
          <span className={`h-3 w-3 shrink-0 rounded-full ${recovering ? 'bg-amber-400' : status?.phase === 'running' ? 'bg-emerald-400 shadow-[0_0_10px_#34d399]' : status?.phase === 'error' ? 'bg-red-500' : 'bg-gray-600'}`} />
        </div>
      </div>

      {status && !status.supported && (
        <p className="rounded-lg border border-amber-700/60 bg-amber-950/25 p-3 text-xs text-amber-200">
          Виртуальная камера PDM доступна только в Windows 11 и более новых версиях Windows.
        </p>
      )}
      {status?.supported && !status.installed && (
        <div className="rounded-lg border border-blue-700/60 bg-blue-950/20 p-3">
          <p className="text-xs text-blue-100">Один раз установите системный компонент. Windows покажет стандартное подтверждение.</p>
          <button type="button" disabled={busy} onClick={() => void run(() => window.api.virtualCamera.install())}
            className={`${button} mt-3 border-blue-500 bg-blue-600 text-white hover:bg-blue-500`}>
            Установить виртуальную камеру
          </button>
        </div>
      )}

      {(message || status?.error) && <p role="status" className="break-words text-xs text-amber-200">{message || status?.error}</p>}

      <div className="flex items-center justify-between gap-3 border-t border-gray-700 pt-4">
        <p className="text-[10px] leading-4 text-gray-500">Виртуальная камера не передаёт звук — микрофон или звуковую карту выберите отдельно в программе видеосвязи.</p>
        {active ? (
          <button type="button" disabled={busy} onClick={() => void run(stop)} className={`${button} shrink-0 border-red-500 bg-red-600 text-white hover:bg-red-500`}>
            Выключить камеру
          </button>
        ) : (
          <button type="button" data-pdm-virtual-camera-start disabled={busy || (!status?.available && status?.supported !== false)} onClick={() => void run(start)} className={`${button} shrink-0 border-emerald-500 bg-emerald-600 text-white hover:bg-emerald-500`}>
            Включить камеру
          </button>
        )}
      </div>
    </div>
  )
}
