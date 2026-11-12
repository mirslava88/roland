export type RecordingShortcut = 'copy' | 'cut' | 'paste' | 'undo' | 'redo' |
  'select-all' | 'save' | 'delete' | 'play-pause' | null

export interface RecordingKeyEvent {
  code: string
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

const russianKeys: Record<string, string> = {
  'ф': 'KeyA', 'с': 'KeyC', 'м': 'KeyV', 'ч': 'KeyX',
  'я': 'KeyZ', 'н': 'KeyY', 'ы': 'KeyS'
}

export function recordingShortcut(event: RecordingKeyEvent): RecordingShortcut {
  if (event.altKey) return null
  if (event.ctrlKey || event.metaKey) {
    // code names the physical key, so these commands also work in a Russian layout.
    const key = event.code || russianKeys[event.key.toLowerCase()] || `Key${event.key.toUpperCase()}`
    if (key === 'KeyC' && !event.shiftKey) return 'copy'
    if (key === 'KeyX' && !event.shiftKey) return 'cut'
    if (key === 'KeyV' && !event.shiftKey) return 'paste'
    if (key === 'KeyZ') return event.shiftKey ? 'redo' : 'undo'
    if (key === 'KeyY' && !event.shiftKey) return 'redo'
    if (key === 'KeyA' && !event.shiftKey) return 'select-all'
    if (key === 'KeyS' && !event.shiftKey) return 'save'
    return null
  }
  if (event.code === 'Delete' || event.code === 'Backspace') return 'delete'
  if (event.code === 'Space') return 'play-pause'
  return null
}
