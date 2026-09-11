export const TOOLBAR_ITEMS = [
  { id: 'video', label: 'Видео', row: 'program' },
  { id: 'music', label: 'Музыка', row: 'program' },
  { id: 'backdrop', label: 'Фон', row: 'program' },
  { id: 'auto', label: 'Автопереход между каналами', row: 'program' },
  { id: 'clicker', label: 'Кликер', row: 'program' },
  { id: 'output', label: 'В эфир / Выйти из эфира — всегда доступна', row: 'program' },
  { id: 'displays', label: 'Экраны', row: 'tools' },
  { id: 'timer', label: 'Таймер доклада', row: 'tools' },
  { id: 'eventTimer', label: 'Таймер+', row: 'tools' },
  { id: 'pip', label: 'Сцена: картинка, текст, титры, QR-код', row: 'tools' },
  { id: 'pipViews', label: 'Три раскладки Сцены', row: 'tools' },
  { id: 'stream', label: 'Стрим', row: 'tools' }
] as const

export type ToolbarItemId = typeof TOOLBAR_ITEMS[number]['id']
export type ToolbarVisibility = Record<ToolbarItemId, boolean>
export const TOOLBAR_STORAGE_KEY = 'pdm-operator-toolbar'
export const TOOLBAR_NON_CONFIGURABLE_ITEMS = new Set<ToolbarItemId>(['pipViews', 'output'])

// Missing/new buttons are visible. Ignore unknown keys and malformed values;
// in particular a saved preference can never hide the Settings entry point.
export function normalizeToolbarVisibility(value?: unknown): ToolbarVisibility {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
  const visibility = Object.fromEntries(
    TOOLBAR_ITEMS.map(({ id }) => [id, raw[id] !== false])
  ) as ToolbarVisibility
  visibility.output = true
  visibility.pipViews = visibility.pip
  return visibility
}

export function readToolbarVisibility(storage: Pick<Storage, 'getItem'>): ToolbarVisibility {
  try { return normalizeToolbarVisibility(JSON.parse(storage.getItem(TOOLBAR_STORAGE_KEY) ?? '{}')) }
  catch { return normalizeToolbarVisibility() }
}
