import { useState, useEffect } from 'react'

interface AudioDevice {
  id: string
  name: string
  isDefault: boolean
}

interface SettingsModalProps {
  onClose: () => void
}

export function SettingsModal({ onClose }: SettingsModalProps): JSX.Element {
  const [tab, setTab] = useState<'audio' | 'help'>('audio')
  const [devices, setDevices] = useState<AudioDevice[]>([])
  const [loading, setLoading] = useState(false)

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

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-surface-200 border border-gray-700 rounded-xl shadow-2xl w-[600px] max-h-[80vh] flex flex-col"
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

          {tab === 'help' && (
            <div className="space-y-5 text-xs text-gray-300 leading-relaxed">
              <section>
                <h3 className="text-sm font-semibold text-white mb-2">Presentation Display Manager</h3>
                <p className="text-gray-400 mb-3">
                  Приложение для управления контентом на внешнем дисплее или проекторе.
                  Поддерживает презентации PowerPoint, PDF, видео, изображения, документы Word/Excel и музыку.
                </p>
              </section>

              <section>
                <h4 className="text-xs font-semibold text-accent mb-1.5">1. Проводник (левая панель)</h4>
                <ul className="list-disc pl-4 space-y-1 text-gray-400">
                  <li>Выберите диск или папку с файлами</li>
                  <li>Фильтры вверху: Все, PPTX, PDF, Видео, Разное</li>
                  <li>Двойной клик на папку — войти внутрь, <code className="text-gray-300 bg-surface-400 px-1 rounded">..</code> — назад</li>
                  <li>Перетаскивание файлов между папками и из Проводника Windows</li>
                  <li>Правый клик — контекстное меню (копировать, вырезать, вставить, переименовать, удалить)</li>
                </ul>
              </section>

              <section>
                <h4 className="text-xs font-semibold text-accent mb-1.5">2. Каналы A / B</h4>
                <ul className="list-disc pl-4 space-y-1 text-gray-400">
                  <li>Перетащите файл в канал A или B для подготовки</li>
                  <li>Нажмите <code className="text-gray-300 bg-surface-400 px-1 rounded">В эфир</code> чтобы вывести на внешний дисплей</li>
                  <li>Два канала позволяют подготовить следующий контент пока текущий в эфире</li>
                  <li>Для PPTX: навигация по слайдам стрелками или PageUp/PageDown</li>
                </ul>
              </section>

              <section>
                <h4 className="text-xs font-semibold text-accent mb-1.5">3. Подложка (Фон)</h4>
                <ul className="list-disc pl-4 space-y-1 text-gray-400">
                  <li>Кнопка <code className="text-gray-300 bg-surface-400 px-1 rounded">🖼 Подложка</code> — выбор фонового изображения</li>
                  <li>Подложка отображается когда нет активного контента</li>
                  <li>При открытии Word/Excel подложка видна если свернуть документ</li>
                </ul>
              </section>

              <section>
                <h4 className="text-xs font-semibold text-accent mb-1.5">4. Таймер</h4>
                <ul className="list-disc pl-4 space-y-1 text-gray-400">
                  <li>Обратный отсчет с настраиваемой длительностью</li>
                  <li>Отображается поверх контента на внешнем дисплее</li>
                  <li>Можно задать звук оповещения при истечении времени</li>
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
                  <li>Когда включен — стрелки и PageUp/PageDown работают глобально</li>
                  <li>Используйте для переключения слайдов с помощью презентера (кликера)</li>
                  <li>Отключите если нужно использовать стрелки в других приложениях</li>
                </ul>
              </section>

              <section>
                <h4 className="text-xs font-semibold text-accent mb-1.5">7. Горячие клавиши</h4>
                <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-gray-400 mt-2">
                  <span><code className="text-gray-300 bg-surface-400 px-1 rounded">Ctrl+C</code> — Копировать</span>
                  <span><code className="text-gray-300 bg-surface-400 px-1 rounded">Ctrl+X</code> — Вырезать</span>
                  <span><code className="text-gray-300 bg-surface-400 px-1 rounded">Ctrl+V</code> — Вставить</span>
                  <span><code className="text-gray-300 bg-surface-400 px-1 rounded">F2</code> — Переименовать</span>
                  <span><code className="text-gray-300 bg-surface-400 px-1 rounded">Del</code> — В корзину</span>
                  <span><code className="text-gray-300 bg-surface-400 px-1 rounded">Shift+Del</code> — Удалить навсегда</span>
                  <span><code className="text-gray-300 bg-surface-400 px-1 rounded">←→</code> — Слайды</span>
                  <span><code className="text-gray-300 bg-surface-400 px-1 rounded">PgUp/PgDn</code> — Слайды</span>
                </div>
              </section>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
