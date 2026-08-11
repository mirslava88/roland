import { useState, useEffect } from 'react'
import { useAppStore, type DisplayOutputMode } from '../../stores/useAppStore'
import { loadAppConfigFromFile, saveCurrentAppConfig } from '../../app-config'

interface AudioDevice {
  id: string
  name: string
  isDefault: boolean
}

interface DisplayMode {
  width: number
  height: number
  frequency: number
}

interface DisplayInfoFull {
  deviceName: string
  friendlyName: string
  isPrimary: boolean
  current: DisplayMode
  modes: DisplayMode[]
}

type DisplayMultiMode = 'internal' | 'clone' | 'extend' | 'external'

const DISPLAY_MODE_LABELS: Record<DisplayMultiMode, string> = {
  internal: 'Только этот экран',
  clone: 'Дублировать',
  extend: 'Расширить',
  external: 'Только второй экран'
}

interface SettingsModalProps {
  onClose: () => void
}

export function SettingsModal({ onClose }: SettingsModalProps): JSX.Element {
  const {
    displays: connectedDisplays,
    displayAssignments,
    displayNames,
    selectedDisplayId,
    setDisplayAssignment,
    setDisplayName
  } = useAppStore()
  const [tab, setTab] = useState<'audio' | 'display' | 'config' | 'diagnostics' | 'help'>('audio')
  const [devices, setDevices] = useState<AudioDevice[]>([])
  const [loading, setLoading] = useState(false)
  const [displayModes, setDisplayModes] = useState<DisplayInfoFull[]>([])
  const [displaysLoading, setDisplaysLoading] = useState(false)
  const [applyingMode, setApplyingMode] = useState<DisplayMultiMode | null>(null)
  const [diagnosticStatus, setDiagnosticStatus] = useState('')
  const [configBusy, setConfigBusy] = useState(false)
  const [configStatus, setConfigStatus] = useState('')
  const [configWarnings, setConfigWarnings] = useState<string[]>([])

  const saveConfig = async (): Promise<void> => {
    setConfigBusy(true)
    setConfigStatus('Подготавливаю конфигурацию…')
    setConfigWarnings([])
    try {
      const result = await saveCurrentAppConfig()
      if (result.canceled) setConfigStatus('Сохранение отменено.')
      else if (result.error) setConfigStatus(`Не удалось сохранить: ${result.error}`)
      else setConfigStatus(`Конфигурация сохранена: ${result.path || ''}`)
      setConfigWarnings(result.warnings)
    } catch (error) {
      setConfigStatus(`Не удалось сохранить: ${String(error)}`)
    } finally {
      setConfigBusy(false)
    }
  }

  const loadConfig = async (): Promise<void> => {
    setConfigBusy(true)
    setConfigStatus('Проверяю и загружаю конфигурацию…')
    setConfigWarnings([])
    try {
      const result = await loadAppConfigFromFile()
      if (result.canceled) setConfigStatus('Загрузка отменена.')
      else if (result.error) setConfigStatus(`Не удалось загрузить: ${result.error}`)
      else setConfigStatus(`Конфигурация загружена: ${result.path || ''}`)
      setConfigWarnings(result.warnings)
    } catch (error) {
      setConfigStatus(`Не удалось загрузить: ${String(error)}`)
    } finally {
      setConfigBusy(false)
    }
  }

  const openDiagnosticLogs = async (): Promise<void> => {
    setDiagnosticStatus('Открываю папку...')
    try {
      const result = await window.api.openDiagnosticLogFolder()
      setDiagnosticStatus(result.success
        ? `Папка открыта: ${result.path}`
        : `Не удалось открыть папку: ${result.error || result.path}`)
    } catch (error) {
      setDiagnosticStatus(`Не удалось открыть папку: ${String(error)}`)
    }
  }

  const loadDisplays = async (): Promise<void> => {
    setDisplaysLoading(true)
    try {
      const d = await window.api.getDisplayModes()
      setDisplayModes(d || [])
    } finally {
      setDisplaysLoading(false)
    }
  }

  useEffect(() => {
    if (tab === 'display') loadDisplays()
  }, [tab])

  const applyMode = async (mode: DisplayMultiMode): Promise<void> => {
    setApplyingMode(mode)
    await window.api.setDisplayMode(mode)
    // Windows needs a moment to apply
    setTimeout(() => {
      loadDisplays()
      setApplyingMode(null)
    }, 1500)
  }

  const applyResolution = async (
    deviceName: string,
    width: number,
    height: number,
    frequency: number
  ): Promise<void> => {
    const result = await window.api.setDisplayResolution(deviceName, width, height, frequency)
    if (!result.success) {
      alert(`Не удалось применить разрешение: ${result.error || 'ошибка'}`)
    }
    setTimeout(loadDisplays, 500)
  }

  const loadDevices = async (): Promise<void> => {
    setLoading(true)
    const d = await window.api.getAudioDevices()
    setDevices(d)
    setLoading(false)
  }

  useEffect(() => {
    loadDevices()
  }, [])

  const handleSetDevice = async (deviceId: string): Promise<void> => {
    await window.api.setAudioDevice(deviceId)
    await loadDevices()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div
        className="bg-surface-200 border border-gray-700 rounded-xl shadow-2xl w-[680px] max-w-[90vw] max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-700">
          <div className="flex gap-1">
            <button
              onClick={() => setTab('audio')}
              className={`px-3 py-1.5 text-xs rounded-md font-medium transition-colors ${
                tab === 'audio' ? 'bg-accent text-white' : 'text-gray-400 hover:text-white hover:bg-surface-100'
              }`}
            >
              Аудиовыход
            </button>
            <button
              onClick={() => setTab('display')}
              className={`px-3 py-1.5 text-xs rounded-md font-medium transition-colors ${
                tab === 'display' ? 'bg-accent text-white' : 'text-gray-400 hover:text-white hover:bg-surface-100'
              }`}
            >
              Дисплеи
            </button>
            <button
              onClick={() => setTab('config')}
              className={`px-3 py-1.5 text-xs rounded-md font-medium transition-colors ${
                tab === 'config' ? 'bg-accent text-white' : 'text-gray-400 hover:text-white hover:bg-surface-100'
              }`}
            >
              Конфиг
            </button>
            <button
              onClick={() => setTab('diagnostics')}
              className={`px-3 py-1.5 text-xs rounded-md font-medium transition-colors ${
                tab === 'diagnostics' ? 'bg-accent text-white' : 'text-gray-400 hover:text-white hover:bg-surface-100'
              }`}
            >
              Диагностика
            </button>
            <button
              onClick={() => setTab('help')}
              className={`px-3 py-1.5 text-xs rounded-md font-medium transition-colors ${
                tab === 'help' ? 'bg-accent text-white' : 'text-gray-400 hover:text-white hover:bg-surface-100'
              }`}
            >
              Инструкция
            </button>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-white text-lg leading-none px-1">
            ✕
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-5">
          {tab === 'audio' && (
            <div>
              <h3 className="text-sm font-semibold text-gray-200 mb-3">Выберите аудиоустройство вывода</h3>
              {loading ? (
                <p className="text-xs text-gray-500">Загрузка устройств...</p>
              ) : devices.length === 0 ? (
                <p className="text-xs text-gray-500">Устройства не найдены</p>
              ) : (
                <div className="space-y-1">
                  {devices.map((dev) => (
                    <button
                      key={dev.id}
                      onClick={() => handleSetDevice(dev.id)}
                      className={`w-full text-left px-4 py-2.5 rounded-lg text-xs transition-colors flex items-center justify-between ${
                        dev.isDefault
                          ? 'bg-accent/20 border border-accent/40 text-white'
                          : 'bg-surface-100 border border-transparent text-gray-300 hover:bg-surface-100/80 hover:border-gray-600'
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <span>{dev.isDefault ? '🔊' : '🔇'}</span>
                        <span>{dev.name}</span>
                      </span>
                      {dev.isDefault && (
                        <span className="text-[10px] text-accent font-medium">По умолчанию</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
              <button
                onClick={loadDevices}
                className="mt-3 text-[10px] text-gray-500 hover:text-white transition-colors"
              >
                ↻ Обновить список
              </button>
            </div>
          )}

          {tab === 'display' && (
            <div className="space-y-5">
              <section>
                <h3 className="text-sm font-semibold text-gray-200 mb-2">Назначение дисплеев PDM</h3>
                <p className="text-[10px] text-gray-500 mb-3">
                  Каждый дополнительный монитор настраивается независимо. Один режим можно повторять на нескольких экранах.
                </p>
                <div className="space-y-2">
                  <div className="rounded-lg border border-gray-700 bg-surface-100 p-3 flex items-center justify-between gap-4">
                    <div>
                      <div className="text-xs font-medium text-white">Дисплей 0 — Интерфейс PDM</div>
                      <div className="text-[10px] text-gray-500">Основной экран ноутбука</div>
                    </div>
                    <span className="text-[10px] text-emerald-400">Назначается автоматически</span>
                  </div>

                  {connectedDisplays.filter((display) => !display.isPrimary).map((display, index) => {
                    const mode = displayAssignments[String(display.id)] || 'off'
                    const customName = displayNames[String(display.id)] || ''
                    return (
                    <label key={display.id} className="rounded-lg border border-gray-700 bg-surface-100 p-3 block">
                      <input
                        type="text"
                        value={customName}
                        maxLength={80}
                        placeholder="Добавить имя экрана"
                        aria-label={`Имя монитора ${index + 1}`}
                        onChange={(event) => setDisplayName(display.id, event.target.value)}
                        className="mb-1.5 w-full rounded-sm border border-gray-700 bg-surface-200 px-2 py-1.5 text-xs font-medium text-white outline-hidden placeholder:text-gray-600 hover:border-gray-600 focus:border-accent"
                      />
                      <span className="text-[10px] text-gray-400 block">Монитор {index + 1} · {display.label}</span>
                      <span className="text-[10px] text-gray-500 block mb-2">
                        {display.bounds.width}×{display.bounds.height}
                        {mode === 'program' && display.id === selectedDisplayId ? ' · главный эфир' : ''}
                        {mode === 'program' && display.id !== selectedDisplayId ? ' · копия эфира' : ''}
                      </span>
                      <select
                        className="w-full bg-surface-200 border border-gray-700 rounded-sm px-2 py-1.5 text-xs text-gray-200 outline-hidden hover:border-gray-600 focus:border-accent"
                        value={mode}
                        onChange={(event) => setDisplayAssignment(display.id, event.target.value as DisplayOutputMode)}
                      >
                        <option value="off">Выключен</option>
                        <option value="program">Основной эфир</option>
                        <option value="speaker">Суфлёр</option>
                        <option value="information">Информационный экран</option>
                        <option value="timer">Таймер</option>
                      </select>
                    </label>
                  )})}
                </div>
              </section>

              <section>
                <h3 className="text-sm font-semibold text-gray-200 mb-2">Режим нескольких экранов</h3>
                <div className="grid grid-cols-2 gap-2">
                  {(['extend', 'clone', 'internal', 'external'] as DisplayMultiMode[]).map((mode) => (
                    <button
                      key={mode}
                      onClick={() => applyMode(mode)}
                      disabled={applyingMode !== null}
                      className={`px-3 py-2 rounded-lg text-xs transition-colors border ${
                        applyingMode === mode
                          ? 'bg-accent/40 border-accent/60 text-white'
                          : 'bg-surface-100 border-gray-700 text-gray-200 hover:bg-surface-100/80 hover:border-gray-600'
                      } disabled:opacity-60`}
                    >
                      {applyingMode === mode ? 'Применение…' : DISPLAY_MODE_LABELS[mode]}
                    </button>
                  ))}
                </div>
              </section>

              <section>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-semibold text-gray-200">Подключённые дисплеи</h3>
                  <button
                    onClick={loadDisplays}
                    className="text-[10px] text-gray-500 hover:text-white transition-colors"
                  >
                    ↻ Обновить
                  </button>
                </div>
                {displaysLoading ? (
                  <p className="text-xs text-gray-500">Загрузка…</p>
                ) : displayModes.length === 0 ? (
                  <p className="text-xs text-gray-500">Дисплеи не найдены</p>
                ) : (
                  <div className="space-y-3">
                    {displayModes.map((d) => (
                      <div key={d.deviceName} className="bg-surface-100 border border-gray-700 rounded-lg p-3">
                        <div className="flex items-center justify-between mb-2">
                          <div>
                            <div className="text-xs font-medium text-white">
                              {d.friendlyName || d.deviceName}
                              {d.isPrimary && <span className="ml-2 text-[10px] text-accent">• Основной</span>}
                            </div>
                            <div className="text-[10px] text-gray-500">{d.deviceName}</div>
                          </div>
                          <div className="text-[10px] text-gray-300 tabular-nums">
                            {d.current.width}×{d.current.height} @ {d.current.frequency}Гц
                          </div>
                        </div>
                        <label className="text-[10px] text-gray-500 block mb-1">Разрешение</label>
                        <select
                          className="w-full bg-surface-200 border border-gray-700 rounded-sm px-2 py-1.5 text-xs text-gray-200 outline-hidden hover:border-gray-600 focus:border-accent"
                          value={`${d.current.width}x${d.current.height}x${d.current.frequency}`}
                          onChange={(e) => {
                            const [w, h, f] = e.target.value.split('x').map(Number)
                            applyResolution(d.deviceName, w, h, f)
                          }}
                        >
                          {d.modes.map((m) => (
                            <option key={`${m.width}x${m.height}x${m.frequency}`} value={`${m.width}x${m.height}x${m.frequency}`}>
                              {m.width}×{m.height} @ {m.frequency}Гц
                            </option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="pt-2 border-t border-gray-700">
                <button
                  onClick={() => window.api.openDisplaySettings()}
                  className="text-[10px] text-gray-500 hover:text-white transition-colors"
                >
                  Открыть системные настройки Windows →
                </button>
              </section>
            </div>
          )}

          {tab === 'config' && (
            <div className="space-y-4 text-xs text-gray-300 leading-relaxed">
              <section className="rounded-md border border-accent/40 bg-surface-300 p-4">
                <h3 className="text-sm font-semibold text-white mb-2">Конфигурация PDM</h3>
                <p className="text-gray-400 mb-4">
                  Сохраните всю подготовку мероприятия в один файл: материалы в каналах, номера слайдов,
                  раскладку каналов, назначения дисплеев, подложку, информационный экран, плейлисты,
                  таймер, кликер и аудиовыход.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={saveConfig}
                    disabled={configBusy}
                    className="rounded bg-accent px-4 py-2.5 text-xs font-medium text-white hover:bg-accent/80 transition-colors disabled:cursor-wait disabled:opacity-50"
                  >
                    💾 Сохранить конфиг
                  </button>
                  <button
                    onClick={loadConfig}
                    disabled={configBusy}
                    className="rounded border border-gray-600 bg-surface-100 px-4 py-2.5 text-xs font-medium text-white hover:border-accent hover:bg-surface-100/70 transition-colors disabled:cursor-wait disabled:opacity-50"
                  >
                    📂 Загрузить конфиг
                  </button>
                </div>
                {configStatus && (
                  <p className="mt-3 break-all text-[10px] text-gray-300">{configStatus}</p>
                )}
              </section>

              <section className="rounded-md border border-gray-700 bg-surface-100 p-4 text-[11px] text-gray-400">
                <h4 className="text-xs font-semibold text-gray-200 mb-2">Безопасное восстановление</h4>
                <ul className="list-disc pl-4 space-y-1">
                  <li>Перед загрузкой нужно выйти из эфира. После загрузки ничего не запускается автоматически.</li>
                  <li>Если файл удалён или переименован, PDM не угадывает замену: канал останется пустым, а путь появится в предупреждениях.</li>
                  <li>USB-камеры и платы захвата сохраняются. Окна программ и захват экрана нужно выбрать заново.</li>
                  <li>Назначение монитора применяется только при безопасном совпадении подключённого дисплея.</li>
                </ul>
              </section>

              {configWarnings.length > 0 && (
                <section className="rounded-md border border-yellow-700/60 bg-yellow-950/20 p-4">
                  <h4 className="text-xs font-semibold text-yellow-300 mb-2">
                    Загружено с предупреждениями: {configWarnings.length}
                  </h4>
                  <ul className="list-disc pl-4 space-y-1 text-[10px] text-yellow-100/80 break-all">
                    {configWarnings.slice(0, 20).map((warning, index) => (
                      <li key={`${index}-${warning}`}>{warning}</li>
                    ))}
                  </ul>
                  {configWarnings.length > 20 && (
                    <p className="mt-2 text-[10px] text-yellow-300">И ещё {configWarnings.length - 20}…</p>
                  )}
                </section>
              )}
            </div>
          )}

          {tab === 'diagnostics' && (
            <div className="space-y-4 text-xs text-gray-300 leading-relaxed">
              <section className="rounded-md border border-accent/40 bg-surface-300 p-4">
                <h3 className="text-sm font-semibold text-white mb-2">Диагностика PPTX и PDF</h3>
                <p className="text-gray-400 mb-3">
                  Сначала воспроизведите проблему с превью или качеством PDF, затем откройте папку и передайте разработчику файл <code className="text-gray-300 bg-surface-400 px-1 rounded-sm">pdm-diagnostic.log</code>.
                </p>
                <button
                  onClick={openDiagnosticLogs}
                  className="rounded bg-accent px-4 py-2 text-xs font-medium text-white hover:bg-accent/80 transition-colors"
                >
                  Открыть папку логов
                </button>
                {diagnosticStatus && (
                  <p className="mt-3 break-all text-[10px] text-gray-400">{diagnosticStatus}</p>
                )}
              </section>

              <section>
                <h4 className="text-xs font-semibold text-accent mb-1.5">Что записывается</h4>
                <ul className="list-disc pl-4 space-y-1 text-gray-400">
                  <li>версия Windows, приложения, PowerPoint и Office;</li>
                  <li>параметры мониторов и масштаб Windows;</li>
                  <li>запуск PowerPoint и COM-ошибки;</li>
                  <li>экспорт превью каждого слайда и ошибки загрузки PNG.</li>
                  <li>размер PDF-кадра и причина переключения на запасной рендер.</li>
                </ul>
              </section>
            </div>
          )}

          {tab === 'help' && (
            <div className="space-y-5 text-xs text-gray-300 leading-relaxed">
              <section>
                <h3 className="text-sm font-semibold text-white mb-2">Presentation Display Manager</h3>
                <p className="text-gray-400 mb-3">
                  Приложение для управления контентом на внешнем дисплее или проекторе.
                  Поддерживает презентации PowerPoint, PDF, видео, изображения, документы Word/Excel,
                  музыку, USB-камеры, платы видеозахвата, открытые окна программ и экраны.
                </p>
              </section>

              <section>
                <h4 className="text-xs font-semibold text-accent mb-1.5">1. Выбор материалов (левая панель)</h4>
                <ul className="list-disc pl-4 space-y-1 text-gray-400">
                  <li>Выберите диск или папку с файлами</li>
                  <li>Кнопка <code className="text-gray-300 bg-surface-400 px-1 rounded-sm">123...-&gt;</code> автоматически раскладывает по каналам пронумерованные материалы из открытой папки: <code className="text-gray-300 bg-surface-400 px-1 rounded-sm">3.pdf</code>, <code className="text-gray-300 bg-surface-400 px-1 rounded-sm">03-Ролик.mp4</code>, <code className="text-gray-300 bg-surface-400 px-1 rounded-sm">4. Презентация.pptx</code> и похожие имена. Файлы без номера в начале не перемещаются</li>
                  <li>Для камеры или платы захвата нажмите <code className="text-gray-300 bg-surface-400 px-1 rounded-sm">Внешний источник</code>, выберите устройство и добавьте его</li>
                  <li>Для показа браузера или другой открытой программы нажмите <code className="text-gray-300 bg-surface-400 px-1 rounded-sm">＋ Окно / экран</code>. Не сворачивайте выбранное окно во время эфира</li>
                  <li>Фильтры вверху: Все, PPTX, PDF, Видео, Разное</li>
                  <li>Двойной клик на папку — войти внутрь, <code className="text-gray-300 bg-surface-400 px-1 rounded-sm">..</code> — назад</li>
                  <li>Перетаскивание файлов между папками и из Проводника Windows</li>
                  <li>Правый клик — контекстное меню (копировать, вырезать, вставить, переименовать, удалить)</li>
                </ul>
              </section>

              <section>
                <h4 className="text-xs font-semibold text-accent mb-1.5">2. Каналы</h4>
                <ul className="list-disc pl-4 space-y-1 text-gray-400">
                  <li>Квадратная кнопка переключает сетку между 4 каналами (2×2) и 9 каналами (3×3). Значок показывает следующую раскладку: в режиме 2×2 видны 9 точек, а в режиме 3×3 — 4 квадрата</li>
                  <li>Кнопка <code className="text-gray-300 bg-surface-400 px-1 rounded-sm">+</code> справа сверху добавляет новую страницу из 4 или 9 каналов — в зависимости от выбранной раскладки</li>
                  <li>Навигация между страницами: кнопки <code className="text-gray-300 bg-surface-400 px-1 rounded-sm">‹ ›</code> и номера внизу. Красная точка • отмечает страницу с live-каналом</li>
                  <li>Пустую страницу можно удалить кнопкой <code className="text-gray-300 bg-surface-400 px-1 rounded-sm">✕</code> справа от пагинации</li>
                  <li>Перетащите файл или внешний источник в любой канал и выберите этот канал. Кнопка <code className="text-gray-300 bg-surface-400 px-1 rounded-sm">В эфир</code> станет доступна только для выбранного канала с контентом</li>
                  <li>Карандаш справа в заголовке канала добавляет понятную подпись. Нажмите Enter или щёлкните вне поля для сохранения, Escape — для отмены</li>
                  <li>Для запуска нажмите <code className="text-gray-300 bg-surface-400 px-1 rounded-sm">В эфир</code> или дважды щёлкните по каналу</li>
                  <li>PPTX и PDF начинают готовиться сразу после добавления в канал: PPTX скрыто открывается в PowerPoint и получает готовые эфирные слайды, а PDF — страницы под разрешение выбранного дисплея. Пока идёт подготовка, на карточке виден статус <code className="text-gray-300 bg-surface-400 px-1 rounded-sm">Кэширование…</code>, а запуск этого PPTX в эфир временно недоступен</li>
                  <li>В карточке видеоканала слева от кнопки «В эфир» находится список «После». Выберите другой непустой канал для автоматического перехода либо «Не переключать»</li>
                  <li>В панели управления видео доступны воспроизведение, пауза, остановка, переход по таймлайну и зацикливание ролика либо всего видеоплейлиста. Ролик после выхода в эфир запускается только вручную</li>
                  <li>Активный канал подсвечен красным; крестик <code className="text-gray-300 bg-surface-400 px-1 rounded-sm">✕</code> полностью убирает контент с внешнего дисплея (включая PDF, видео, Word/Excel)</li>
                  <li>Для PPTX и PDF: стрелки <code className="text-gray-300 bg-surface-400 px-1 rounded-sm">◀ ▶</code> и поле с номером слайда — введите номер и Enter для быстрого перехода</li>
                  <li>Поле номера слайда видно даже в неактивном канале — позволяет заранее выставить нужный слайд</li>
                  <li><code className="text-gray-300 bg-surface-400 px-1 rounded-sm">⇆ Автопереход</code> находится между кнопками «Видео» и «Подложка (Фон)» и при каждом запуске программы выключен</li>
                  <li>При включённом автопереходе нажатие вперёд после последнего слайда PPTX/PDF открывает ближайший следующий канал с контентом, а нажатие назад на первом слайде — предыдущий. Пустые каналы пропускаются</li>
                </ul>
              </section>

              <section>
                <h4 className="text-xs font-semibold text-accent mb-1.5">2.1. Титры внешнего источника</h4>
                <ul className="list-disc pl-4 space-y-1 text-gray-400">
                  <li>Кнопка <code className="text-gray-300 bg-surface-400 px-1 rounded-sm">▰ Титры</code> открывает панель эфирной графики поверх камеры, платы видеозахвата, окна программы или захваченного экрана</li>
                  <li>В блоке «Выступающие» заранее добавьте любое количество спикеров с ФИО и должностями, затем выбирайте нужного из списка и нажимайте «Показать»</li>
                  <li>Для каждого титра отдельно выбираются эффекты появления и исчезновения, а также время автоматического скрытия в секундах; значение 0 отключает таймер</li>
                  <li>Для спикера и мероприятия независимо настраиваются форма, цвет текста, градиент фона и два цвета боковой полоски; диагональный стиль доступен с наклоном левой или правой стороны</li>
                  <li>Для информации о мероприятии можно выбрать одну из девяти позиций: слева, по центру или справа в верхней, центральной либо нижней части экрана</li>
                  <li>Заголовок «МЕРОПРИЯТИЕ» можно заменить своим текстом или оставить пустым</li>
                  <li>Нажмите правой кнопкой мыши на канал с внешним источником, чтобы показать информацию о мероприятии или выбрать спикера; информация находится над списком ФИО</li>
                  <li>Редактирование меняет только предварительный просмотр. Если титр уже в эфире, нажмите «Обновить», чтобы зрители увидели новый текст</li>
                  <li>«Скрыть все титры» одновременно убирает оба слоя. На PPTX, PDF и видео титры не выводятся</li>
                  <li>Тексты сохраняются в конфигурации, но после запуска программы или загрузки конфига титры остаются выключенными</li>
                </ul>
              </section>

              <section>
                <h4 className="text-xs font-semibold text-accent mb-1.5">3. Подложка (Фон) и выход из эфира</h4>
                <ul className="list-disc pl-4 space-y-1 text-gray-400">
                  <li>Кнопка <code className="text-gray-300 bg-surface-400 px-1 rounded-sm">🖼 Подложка (Фон)</code> выбирает и включает фон; повторное нажатие той же кнопки отключает его</li>
                  <li>Подложка применяется ко всем включённым дополнительным дисплеям. На суфлёре она показывается только когда в эфире нет PPTX/PDF, например во время видео</li>
                  <li>Обычно подложка действует до закрытия программы; перенести её в следующую сессию можно через вкладку «Конфиг»</li>
                  <li>Кнопка <code className="text-gray-300 bg-surface-400 px-1 rounded-sm">⏹ Выйти из эфира</code> — убирает любой активный материал, включая видеовход, и показывает подложку. Если подложка не настроена — внешний экран освобождается</li>
                </ul>
              </section>

              <section>
                <h4 className="text-xs font-semibold text-accent mb-1.5">4. Таймер (⏱)</h4>
                <ul className="list-disc pl-4 space-y-1 text-gray-400">
                  <li>Обратный отсчёт с настраиваемой длительностью (часы/минуты)</li>
                  <li>Кнопка <code className="text-gray-300 bg-surface-400 px-1 rounded-sm">Установить</code> применяет введённое время. Нажатие <code className="text-gray-300 bg-surface-400 px-1 rounded-sm">▶</code> без «Установить» стартует со значения из полей</li>
                  <li>Быстрые кнопки: +1/+5/+10 мин, -1/-5/-10 мин и произвольное значение</li>
                  <li>Дисплей для таймера назначается кнопкой «Экраны»: выберите для нужного монитора режим «Таймер». Если такой дисплей не назначен, таймер автоматически показывается поверх основного эфира</li>
                  <li>Цвета: зелёный — идёт отсчёт; жёлтый — меньше минуты; красный — overtime (минусовое время)</li>
                  <li>Два звука оповещения: <b>«Звук (1 мин)»</b> срабатывает при достижении 60 секунд, <b>«Звук (конец)»</b> — при достижении 0</li>
                  <li>Кнопка <code className="text-gray-300 bg-surface-400 px-1 rounded-sm">🔊</code> — принудительный запуск звука таймера</li>
                </ul>
              </section>

              <section>
                <h4 className="text-xs font-semibold text-accent mb-1.5">4.1. Дополнительный таймер мероприятия (◷ Таймер+)</h4>
                <ul className="list-disc pl-4 space-y-1 text-gray-400">
                  <li>Это отдельный таймер с собственной панелью управления — обычный таймер PDM остаётся без изменений и работает независимо</li>
                  <li>Укажите заголовок, название мероприятия, время начала и окончания, стоимость минуты, фон и цвет текста</li>
                  <li>Четыре взаимоисключающих режима управляют крупным центральным значением: «Текущее время», «Таймер», «До начала» и «До конца»</li>
                  <li>Каждый из четырёх режимов запоминает собственный заголовок. «До начала» и «До конца» по умолчанию используют текст «До начала мероприятия» и «До конца мероприятия», а кнопка «Авто» сбрасывает только текущий режим</li>
                  <li>В превью можно отдельно включить верхние часы, расписание, заголовок, название, остаток и итоговую стоимость</li>
                  <li>Кнопки ▶, Ⅱ и ■ запускают, ставят на паузу и сбрасывают отсчёт; поправки ±1/±5/±10 минут доступны прямо в панели</li>
                  <li>Часы, минуты и секунды редактируются тремя отдельными блоками по две цифры; минуты и секунды не могут быть больше 59</li>
                  <li>Кнопка «Сейчас» возвращает в превью точное время и состояние таймера, которые идут в эфире; до выхода в эфир она недоступна</li>
                  <li>Нижняя строка «До завершения» показывает реальную разницу между окончанием мероприятия и текущим временем</li>
                  <li>Кнопка «⚡ LIVE» рядом со Stop разрешает немедленное управление эфирным таймером. Без неё Play/Pause/Stop, поправки и ввод времени меняют только превью</li>
                  <li>Стоимость начисляется только после перехода в минус. Новый таймер прибавляет следующий перелимит к прежнему итогу, а «Сбросить итог» рядом с ценой минуты обнуляет только общую сумму</li>
                  <li>При перелимите большой таймер и стоимость становятся красными, а отсчёт продолжает идти в минус</li>
                  <li>В «Экранах» назначьте нужному монитору режим «Таймер мероприятия», затем нажмите «Отправить в эфир» в панели нового таймера</li>
                  <li>После выхода в эфир настройки меняют только превью. Кнопка «Обновить эфир» применяет их на внешнем экране, а «Убрать из эфира» отключает табло</li>
                </ul>
              </section>

              <section>
                <h4 className="text-xs font-semibold text-accent mb-1.5">5. Музыкальный плеер</h4>
                <ul className="list-disc pl-4 space-y-1 text-gray-400">
                  <li>Добавьте музыкальные файлы или папку</li>
                  <li>Управление воспроизведением: play/pause, next/prev, громкость</li>
                  <li>Зацикливание трека или плейлиста</li>
                </ul>
              </section>

              <section>
                <h4 className="text-xs font-semibold text-accent mb-1.5">6. Кликер (глобальные клавиши)</h4>
                <ul className="list-disc pl-4 space-y-1 text-gray-400">
                  <li><code className="text-gray-300 bg-surface-400 px-1 rounded-sm">🎮 Кликер в эфире</code> — стрелки и PageUp/PageDown работают глобально (для презентера)</li>
                  <li><code className="text-gray-300 bg-surface-400 px-1 rounded-sm">🎮 Кликер вне эфира</code> — клавиши работают только когда приложение в фокусе</li>
                  <li>Переключается одним кликом по кнопке на панели инструментов</li>
                </ul>
              </section>

              <section>
                <h4 className="text-xs font-semibold text-accent mb-1.5">7. Настройки — вкладка «Дисплеи»</h4>
                <ul className="list-disc pl-4 space-y-1 text-gray-400">
                  <li>Основной экран ноутбука с интерфейсом PDM назначается автоматически и не используется как дополнительный выход</li>
                  <li>Для каждого внешнего монитора выберите режим: «Основной эфир», «Суфлёр», «Информационный экран», «Таймер», «Таймер мероприятия» или «Выключен»</li>
                  <li>В поле «Добавить имя экрана» подпишите физические мониторы понятными именами; подписи сохраняются между запусками и вместе с конфигурацией</li>
                  <li>В режиме «Выключен» на монитор выводится выбранная подложка; если подложка не выбрана, экран остаётся чёрным</li>
                  <li>Одинаковый режим можно назначить нескольким мониторам. Второй «Основной эфир» становится живой беззвучной копией главного выхода</li>
                  <li>Главный эфирный дисплей выделен жёлтой рамкой. Кнопка «Сделать главным» переносит основной выход на другую копию эфира, в том числе прямо во время показа</li>
                  <li>Быстрый выбор доступен по кнопке «🖥 Экраны»; в настройках остаются те же назначения и параметры Windows</li>
                  <li>Прямо из приложения: режим (Расширить / Дублировать / Только основной / Только внешний)</li>
                  <li>Для каждого подключённого дисплея — выбор разрешения и частоты из выпадающего списка</li>
                  <li>При подключении нового монитора автоматически включается режим «Расширить»</li>
                  <li>Кнопка «Открыть системные настройки Windows» как резервный вариант</li>
                </ul>
              </section>

              <section>
                <h4 className="text-xs font-semibold text-accent mb-1.5">8. Универсальные экраны</h4>
                <ul className="list-disc pl-4 space-y-1 text-gray-400">
                  <li>Нажмите <code className="text-gray-300 bg-surface-400 px-1 rounded-sm">🖥 Экраны</code> и выберите режим отдельно для каждого подключённого монитора</li>
                  <li>Несколько суфлёров синхронно следуют за PPTX/PDF, который сейчас находится в эфире. Для другого контента они переходят в режим ожидания</li>
                  <li>Несколько инфоэкранов синхронно показывают выбранный независимый PPTX, PDF, видеоролик, изображение, внешний видеовход либо окно/экран компьютера</li>
                  <li>PPTX/PDF на инфоэкранах листаются отдельными стрелками в окне «Экраны». Для видео доступны «Воспроизвести / Пауза», «Стоп», полоса перехода с текущим временем и длительностью, а также кнопка зацикливания</li>
                  <li>Кнопка «Внешний источник» подключает плату видеозахвата или USB-камеру, а «Окно / экран» показывает выбранную программу или целый дисплей; звук этих источников не передаётся</li>
                  <li>Несколько экранов режима «Основной эфир» показывают одну презентацию; главный выход управляет PowerPoint, остальные получают его живую копию</li>
                  <li>Кнопка «Отключить контент на информационном экране» возвращает общую подложку или чёрный фон</li>
                  <li>Если назначенный монитор отключён, PDM закрывает только его окно и не переносит изображение на другой экран</li>
                </ul>
              </section>

              <section>
                <h4 className="text-xs font-semibold text-accent mb-1.5">9. Настройки — вкладка «Аудиовыход»</h4>
                <ul className="list-disc pl-4 space-y-1 text-gray-400">
                  <li>Выбор устройства вывода звука (колонки, наушники, HDMI)</li>
                  <li>При выводе контента на внешний дисплей звук автоматически переключается на выбранное устройство, а после — возвращается на исходное</li>
                </ul>
              </section>

              <section>
                <h4 className="text-xs font-semibold text-accent mb-1.5">10. Сохранение конфигурации</h4>
                <ul className="list-disc pl-4 space-y-1 text-gray-400">
                  <li>Откройте «Настройки → Конфиг», чтобы сохранить всю подготовку мероприятия в один файл</li>
                  <li>Сохраняются материалы и подписи каналов, переходы после видео, позиции слайдов и видео, раскладка, дисплеи и их имена, подложка, информационный экран и зацикливание его видео, плейлисты, оба таймера, кликер и аудиовыход</li>
                  <li>Перед загрузкой выйдите из эфира. После загрузки ничего не запускается автоматически</li>
                  <li>Удалённый или переименованный файл пропускается, его канал остаётся пустым, а PDM показывает предупреждение</li>
                  <li>USB-камеры и платы сохраняются; окна программ и захват экрана после загрузки выбираются заново</li>
                </ul>
              </section>

              <section>
                <h4 className="text-xs font-semibold text-accent mb-1.5">11. Горячие клавиши</h4>
                <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-gray-400 mt-2">
                  <span><code className="text-gray-300 bg-surface-400 px-1 rounded-sm">Ctrl+C</code> — Копировать</span>
                  <span><code className="text-gray-300 bg-surface-400 px-1 rounded-sm">Ctrl+X</code> — Вырезать</span>
                  <span><code className="text-gray-300 bg-surface-400 px-1 rounded-sm">Ctrl+V</code> — Вставить</span>
                  <span><code className="text-gray-300 bg-surface-400 px-1 rounded-sm">F2</code> — Переименовать</span>
                  <span><code className="text-gray-300 bg-surface-400 px-1 rounded-sm">Del</code> — В корзину</span>
                  <span><code className="text-gray-300 bg-surface-400 px-1 rounded-sm">Shift+Del</code> — Удалить навсегда</span>
                  <span><code className="text-gray-300 bg-surface-400 px-1 rounded-sm">←→</code> — Слайды</span>
                  <span><code className="text-gray-300 bg-surface-400 px-1 rounded-sm">PgUp/PgDn</code> — Слайды</span>
                </div>
              </section>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
