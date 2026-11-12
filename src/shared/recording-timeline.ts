export interface RecordingClip {
  start: number
  end: number
}

const EPSILON = 0.0001

export function timelineDuration(clips: RecordingClip[]): number {
  return clips.reduce((total, clip) => total + clip.end - clip.start, 0)
}

export function normalizeClips(clips: RecordingClip[]): RecordingClip[] {
  return clips.filter(clip => Number.isFinite(clip.start) && Number.isFinite(clip.end) && clip.end - clip.start >= EPSILON)
    .map(clip => ({ start: clip.start, end: clip.end }))
}

export function extractClips(clips: RecordingClip[], start: number, end: number): RecordingClip[] {
  const result: RecordingClip[] = []
  let offset = 0
  for (const clip of clips) {
    const duration = clip.end - clip.start
    const from = Math.max(start, offset)
    const to = Math.min(end, offset + duration)
    if (to - from > EPSILON) result.push({ start: clip.start + from - offset, end: clip.start + to - offset })
    offset += duration
  }
  return normalizeClips(result)
}

export function deleteClips(clips: RecordingClip[], start: number, end: number): RecordingClip[] {
  return normalizeClips([...extractClips(clips, 0, start), ...extractClips(clips, end, timelineDuration(clips))])
}

export function insertClips(clips: RecordingClip[], at: number, inserted: RecordingClip[]): RecordingClip[] {
  return normalizeClips([...extractClips(clips, 0, at), ...inserted, ...extractClips(clips, at, timelineDuration(clips))])
}

export function sourceAt(clips: RecordingClip[], time: number): { clipIndex: number; sourceTime: number; timelineStart: number } | null {
  let offset = 0
  for (let index = 0; index < clips.length; index++) {
    const clip = clips[index]
    const duration = clip.end - clip.start
    if (time < offset + duration - EPSILON || index === clips.length - 1) {
      return { clipIndex: index, sourceTime: clip.start + Math.max(0, Math.min(duration, time - offset)), timelineStart: offset }
    }
    offset += duration
  }
  return null
}
