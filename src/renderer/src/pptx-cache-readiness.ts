export function cachedPptxPrefix(frames: readonly string[]): number {
  let count = 0
  while (count < frames.length && typeof frames[count] === 'string' && frames[count].length > 0) count++
  return count
}

export function canStartPptx(status: string | undefined, frames: readonly string[], total: number): boolean {
  if (status === 'ready' || status === 'error') return true // Existing native fallback.
  return total > 0 && cachedPptxPrefix(frames) >= Math.max(1, Math.ceil(total * 0.25))
}
