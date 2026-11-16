export interface ClockOverlayConfig {
  enabled: boolean
  position: { x: number; y: number }
  scale: number
  color: string
  opacity: number
}

export const DEFAULT_PROGRAM_CLOCK: ClockOverlayConfig = {
  enabled: false,
  position: { x: 10, y: 8 },
  scale: 1,
  color: '#ffffff',
  opacity: 1
}

export const DEFAULT_SPEAKER_CLOCK: ClockOverlayConfig = {
  enabled: false,
  position: { x: 50, y: 88 },
  scale: 1,
  color: '#ffffff',
  opacity: 1
}

export function normalizeClockOverlay(
  value: Partial<ClockOverlayConfig> | null | undefined,
  target: 'program' | 'speaker'
): ClockOverlayConfig {
  const defaults = target === 'speaker' ? DEFAULT_SPEAKER_CLOCK : DEFAULT_PROGRAM_CLOCK
  const limit = (n: unknown, fallback: number, min: number, max: number): number =>
    typeof n === 'number' && Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback
  const color = typeof value?.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(value.color)
    ? value.color
    : defaults.color
  return {
    enabled: value?.enabled === true,
    position: {
      x: limit(value?.position?.x, defaults.position.x, target === 'speaker' ? 8 : 0, target === 'speaker' ? 92 : 100),
      y: limit(value?.position?.y, defaults.position.y, target === 'speaker' ? 8 : 0, target === 'speaker' ? 92 : 100)
    },
    scale: limit(value?.scale, defaults.scale, 0.5, target === 'speaker' ? 2 : 8),
    color,
    opacity: limit(value?.opacity, defaults.opacity, 0.1, 1)
  }
}

export function formatWallClock(date: Date): string {
  return [date.getHours(), date.getMinutes()]
    .map((part) => String(part).padStart(2, '0')).join(':')
}
