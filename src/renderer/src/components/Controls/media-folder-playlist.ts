// Keep the operator's drag order, append newly discovered files and remove
// vanished files. A currently loaded track remains until playback moves away.
export function reconcileMediaFolderPlaylist(
  current: string[],
  scanned: string[],
  loadedPath: string | null
): string[] {
  const available = new Set(scanned)
  const seen = new Set<string>()
  const result: string[] = []
  for (const path of current) {
    if ((available.has(path) || path === loadedPath) && !seen.has(path)) {
      seen.add(path)
      result.push(path)
    }
  }
  for (const path of scanned) {
    if (!seen.has(path)) {
      seen.add(path)
      result.push(path)
    }
  }
  return result
}

export function sameMediaPlaylist(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((path, index) => path === b[index])
}
