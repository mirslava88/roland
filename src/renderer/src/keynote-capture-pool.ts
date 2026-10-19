import type { PresentationCaptureProfile } from '../../shared/presentation-output'

interface Entry { stream: Promise<MediaStream>; leases: number; retired: boolean; intentional: boolean }
const entries = new Map<string, Entry>()
function entryFor(sourceId: string, profile?: PresentationCaptureProfile): Entry {
  let entry = entries.get(sourceId)
  if (entry && !entry.retired) return entry
  const created: Entry = { leases: 0, retired: false, intentional: false, stream: Promise.resolve(null!) }
  created.stream = navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: {
    chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId,
    maxWidth: Math.max(8192, profile?.width || 0), maxHeight: Math.max(8192, profile?.height || 0),
    maxFrameRate: profile?.frameRate || 60
  } } as unknown as MediaTrackConstraints }).then(stream => {
    for (const track of stream.getTracks()) track.addEventListener('ended', () => {
      // Keep the ended entry until replacement/retirement so a native stop
      // racing with the ended event can still mark the lease intentional.
      created.retired = true
    }, { once: true })
    if (created.retired && created.leases === 0) stream.getTracks().forEach(track => track.stop())
    return stream
  }).catch(error => { if (entries.get(sourceId) === created) entries.delete(sourceId); throw error })
  entries.set(sourceId, created)
  return created
}
export async function acquireKeynoteCapture(sourceId: string, profile?: PresentationCaptureProfile): Promise<{stream: MediaStream; release(): void; isRetired(): boolean}> {
  const entry = entryFor(sourceId, profile)
  entry.leases++
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    entry.leases--
    if (entry.retired && entry.leases === 0) void entry.stream.then(stream => stream.getTracks().forEach(track => track.stop())).catch(() => undefined)
  }
  try { return { stream: await entry.stream, release, isRetired: () => entry.intentional } }
  catch (error) { release(); throw error }
}
export function retireKeynoteCapture(sourceId: string): void {
  const entry = entries.get(sourceId)
  if (!entry) return
  entries.delete(sourceId)
  entry.retired = true
  entry.intentional = true
  if (entry.leases === 0) void entry.stream.then(stream => stream.getTracks().forEach(track => track.stop())).catch(() => undefined)
}
export function installKeynoteCapturePool(): () => void {
  const offWarm = window.api.on('keynote-source-prewarm', (...args: unknown[]) => {
    const request = args[0] as {sourceId?: string; profile?: PresentationCaptureProfile}
    if (!request?.sourceId?.startsWith('window:')) return
    void entryFor(request.sourceId, request.profile).stream.catch(error => window.api.dbgLog(`Keynote capture prewarm failed: ${String(error)}`))
  })
  const offRetire = window.api.on('keynote-source-retire', (...args: unknown[]) => {
    const sourceId = (args[0] as {sourceId?: string})?.sourceId
    if (sourceId) retireKeynoteCapture(sourceId)
  })
  return () => { offWarm(); offRetire(); for (const id of entries.keys()) retireKeynoteCapture(id) }
}
