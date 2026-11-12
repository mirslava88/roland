export function formatTimerTime(totalSeconds: number): string {
  const negative = totalSeconds < 0
  const absolute = Math.abs(totalSeconds)
  const hours = Math.floor(absolute / 3600)
  const minutes = Math.floor((absolute % 3600) / 60)
  const seconds = absolute % 60
  const pad = (value: number): string => value.toString().padStart(2, '0')
  const value = hours > 0
    ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`
  return negative ? `-${value}` : value
}

export function resolveTimerTextColor(timer: {
  remaining: number
  running: boolean
  textColor: string
  warningTextColor: string
  overtimeTextColor: string
}): string {
  return timer.remaining < 0
    ? timer.overtimeTextColor
    : timer.remaining <= 60 && timer.running
      ? timer.warningTextColor
      : timer.textColor
}
