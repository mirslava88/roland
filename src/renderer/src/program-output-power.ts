import type { ProgramOutputStatus, ProgramSnapshot } from './stores/useAppStore'

export function shouldKeepProgramAwake(state: {
  activeFile: FileEntry | null
  programSnapshot: ProgramSnapshot | null
  programOutputStatus: ProgramOutputStatus
}): boolean {
  if (state.activeFile !== null) return true
  if (state.programSnapshot === null) return false
  const { phase, confirmedRevision } = state.programOutputStatus
  return phase === 'live' || (confirmedRevision > 0 && (phase === 'publishing' || phase === 'error'))
}
