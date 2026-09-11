import { TOOLBAR_ITEMS, TOOLBAR_NON_CONFIGURABLE_ITEMS } from '../../../../shared/toolbar'
import { useAppStore } from '../../stores/useAppStore'

export function ToolbarAppearanceSettings(): JSX.Element {
  const visibility = useAppStore((state) => state.toolbarVisibility)
  const setVisible = useAppStore((state) => state.setToolbarButtonVisible)
  const reset = useAppStore((state) => state.resetToolbarVisibility)
  return (
    <section className="mt-5 border-t border-gray-700 pt-4" aria-label="Кнопки верхней панели">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-gray-200">Кнопки верхней панели</h3>
        <button type="button" onClick={reset} className="text-xs text-blue-300 hover:text-blue-200">Показать все</button>
      </div>
      <p className="mb-3 text-[11px] leading-4 text-gray-400">
        Отметьте нужные кнопки. Изменения применяются сразу и сохраняются на этом компьютере.
        Скрытие кнопки не выключает функцию и не останавливает эфир или воспроизведение.
        «В эфир» доступна всегда, а три раскладки показываются вместе со Сценой.
      </p>
      <div className="grid grid-cols-2 gap-4">
        {(['program', 'tools'] as const).map((row) => (
          <fieldset key={row} className="min-w-0">
            <legend className="mb-2 text-xs font-medium text-gray-300">{row === 'program' ? 'Верхний ряд — эфир' : 'Нижний ряд — инструменты'}</legend>
            {row === 'program' && (
              <label className="mb-1 flex items-center gap-2 py-1 text-xs text-gray-500" title="Настройки всегда доступны, чтобы вернуть скрытые кнопки">
                <input type="checkbox" checked disabled />Настройки — всегда доступны
              </label>
            )}
            {TOOLBAR_ITEMS.filter((item) => (
              item.row === row &&
              !TOOLBAR_NON_CONFIGURABLE_ITEMS.has(item.id) &&
              (item.id !== 'stream' || __PDM_STREAM_ENABLED__)
            )).map((item) => (
              <label key={item.id} className="mb-1 flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-xs text-gray-200 hover:bg-surface-100">
                <input type="checkbox" checked={visibility[item.id]} onChange={(event) => setVisible(item.id, event.target.checked)}
                  className="accent-blue-500" data-toolbar-option={item.id} />
                {item.label}
              </label>
            ))}
            {row === 'program' && (
              <label className="mb-1 flex items-center gap-2 py-1 text-xs text-gray-500" title="Главная кнопка эфира не скрывается">
                <input type="checkbox" checked disabled data-toolbar-locked="output" />В эфир — всегда доступна
              </label>
            )}
          </fieldset>
        ))}
      </div>
    </section>
  )
}
