export interface PositionedTimerSnapshot {
  position: { x: number; y: number }
}

export interface ProgramSnapshotTimerSelection<T extends PositionedTimerSnapshot> {
  timer: T
  applyToLiveTimer: boolean
}

/**
 * A QR or layout-only publication must not take ownership of the live timer.
 * Keep the already published Scene timer in the immutable snapshot and update
 * the live timer only when the caller explicitly publishes a timer draft.
 */
export function selectProgramSnapshotTimer<T extends PositionedTimerSnapshot>(
  explicitTimer: T | undefined,
  previousPublishedTimer: T | null | undefined,
  sceneDraftTimer: T
): ProgramSnapshotTimerSelection<T> {
  const selected = explicitTimer ?? previousPublishedTimer ?? sceneDraftTimer
  return {
    timer: { ...selected, position: { ...selected.position } },
    applyToLiveTimer: explicitTimer !== undefined
  }
}
