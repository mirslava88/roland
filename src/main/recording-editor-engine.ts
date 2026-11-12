import { execFile, spawn, type ChildProcess } from 'child_process'
import type { RecordingEditSource, RecordingSettings } from '../shared/recording'
import type { RecordingClip } from '../shared/recording-timeline'
import { progressReader } from './streaming-engine'

const seconds = (value: number): string => value.toFixed(3)
const silentWaveform = (width: number): string => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="96" viewBox="0 0 ${width} 96" preserveAspectRatio="none"><path d="M0 24H${width} M0 72H${width}" fill="none" stroke="#8da6bd" stroke-width="1"/></svg>`
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
}

export function probeRecording(ffmpegPath: string, path: string): Promise<RecordingEditSource> {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, ['-hide_banner', '-i', path],
      { windowsHide: true, timeout: 15000, maxBuffer: 512 * 1024 }, (_error, _stdout, stderr) => {
        const info = String(stderr)
        const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(info)
        const hasVideo = /Stream #\d+:\d+[^\r\n]*Video:/.test(info)
        if (!match || !hasVideo) { reject(new Error('Файл не содержит готовую видеозапись PDM.')); return }
        const duration = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
        if (!Number.isFinite(duration) || duration <= 0) { reject(new Error('Не удалось определить длительность записи.')); return }
        const videoLine = info.split(/\r?\n/).find(line => /Stream #\d+:\d+[^\r\n]*Video:/.test(line)) || ''
        const reportedRate = Number(/(?:^|,)\s*(\d+(?:\.\d+)?)\s+tbr\b/.exec(videoLine)?.[1] ||
          /(?:^|,)\s*(\d+(?:\.\d+)?)\s+fps\b/.exec(videoLine)?.[1])
        const frameRate = Number.isFinite(reportedRate) && reportedRate >= 1 && reportedRate <= 240 ? reportedRate : 30
        resolve({ path, duration, hasAudio: /Stream #\d+:\d+[^\r\n]*Audio:/.test(info),
          format: path.toLowerCase().endsWith('.mkv') ? 'mkv' : 'mp4', frameRate })
      })
  })
}

export function previewFrame(ffmpegPath: string, source: RecordingEditSource, time: number): Promise<string> {
  const position = Math.max(0, Math.min(time, source.duration - 0.05))
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-ss', seconds(position), '-i', source.path,
      '-frames:v', '1', '-vf', 'scale=960:-2:force_original_aspect_ratio=decrease',
      '-c:v', 'mjpeg', '-q:v', '3', '-f', 'image2pipe', 'pipe:1'],
    { windowsHide: true, timeout: 20000, maxBuffer: 5 * 1024 * 1024, encoding: 'buffer' },
    (error, stdout) => {
      if (error || !stdout?.length) { reject(new Error('Не удалось показать кадр записи.')); return }
      resolve(`data:image/jpeg;base64,${stdout.toString('base64')}`)
    })
  })
}

export function timelineFrame(ffmpegPath: string, source: RecordingEditSource, time: number,
  signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-ss', seconds(time), '-i', source.path,
      '-frames:v', '1', '-vf', 'scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2',
      '-c:v', 'mjpeg', '-q:v', '2', '-f', 'image2pipe', 'pipe:1'],
    { windowsHide: true, timeout: 20000, maxBuffer: 2 * 1024 * 1024, encoding: 'buffer', signal },
    (error, stdout) => {
      if (error || !stdout?.length) { reject(new Error('Не удалось построить ленту кадров.')); return }
      resolve(`data:image/jpeg;base64,${stdout.toString('base64')}`)
    })
  })
}

export async function timelineThumbnails(ffmpegPath: string, source: RecordingEditSource,
  signal?: AbortSignal): Promise<string[]> {
  const count = 12
  const frames: string[] = new Array(count)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < count) {
      if (signal?.aborted) throw new Error('Построение ленты отменено.')
      const index = next++
      const position = Math.min(source.duration - 0.05, (index + 0.5) / count * source.duration)
      frames[index] = await timelineFrame(ffmpegPath, source, Math.max(0, position), signal)
    }
  }
  await Promise.all([worker(), worker()])
  return frames
}

export function timelineWaveform(ffmpegPath: string, source: RecordingEditSource,
  signal?: AbortSignal): Promise<string | null> {
  return timelineWaveformRange(ffmpegPath, source, 0, source.duration, 1200, signal)
}

export function timelineWaveformRange(ffmpegPath: string, source: RecordingEditSource,
  start: number, end: number, width: number, signal?: AbortSignal): Promise<string | null> {
  if (!source.hasAudio) return Promise.resolve(null)
  if (end - start <= 0.75) return timelineWaveformSamples(ffmpegPath, source, start, end, width, signal)
  const filter = (end - start) / width < 0.0005 ? 'average' : 'peak'
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-ss', start.toFixed(6), '-t', (end - start).toFixed(6), '-i', source.path,
      '-filter_complex', `[0:a:0]showwavespic=s=${width}x96:split_channels=1:colors=0x22d3ee|0xa78bfa:scale=sqrt:filter=${filter}[wave]`,
      '-map', '[wave]', '-frames:v', '1', '-c:v', 'png', '-f', 'image2pipe', 'pipe:1'],
    { windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024, encoding: 'buffer', signal },
    (error, stdout, stderr) => {
      if (error || !stdout?.length) {
        if (signal?.aborted) { reject(error || new Error('Построение звуковой волны отменено.')); return }
        if (!error) { resolve(silentWaveform(width)); return }
        console.warn('[record-edit-waveform] FFmpeg failed', { start, end, width,
          error: error?.message, details: String(stderr).slice(-500) })
        reject(new Error('Не удалось построить звуковую волну.')); return
      }
      resolve(`data:image/png;base64,${stdout.toString('base64')}`)
    })
  })
}

function timelineWaveformSamples(ffmpegPath: string, source: RecordingEditSource,
  start: number, end: number, width: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-ss', start.toFixed(6),
      '-t', (end - start).toFixed(6), '-i', source.path, '-map', '0:a:0', '-vn',
      '-ac', '2', '-ar', '48000', '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1'],
    { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024, encoding: 'buffer', signal },
    (error, stdout) => {
      if (error || !stdout?.length) {
        if (!error) { resolve(silentWaveform(width)); return }
        reject(new Error('Не удалось построить звуковую волну.')); return
      }
      const frames = Math.floor(stdout.length / 8)
      if (!frames) { reject(new Error('Не удалось построить звуковую волну.')); return }
      const paths = [0, 1].map(channel => {
        const points: string[] = []
        const center = channel === 0 ? 24 : 72
        const visual = (sample: number): number => Math.asinh(Math.max(-1, Math.min(1, sample)) * 8) / Math.asinh(8) * 22
        if (frames <= width * 1.5) {
          for (let index = 0; index < frames; index++) {
            const sample = stdout.readFloatLE(index * 8 + channel * 4)
            const x = index / Math.max(1, frames - 1) * (width - 1)
            points.push(`${index ? 'L' : 'M'}${x.toFixed(2)} ${(center - visual(sample)).toFixed(2)}`)
          }
        } else {
          for (let pixel = 0; pixel < width; pixel++) {
            const first = Math.floor(pixel / width * frames)
            const last = Math.max(first + 1, Math.floor((pixel + 1) / width * frames))
            let low = 1
            let high = -1
            for (let index = first; index < last; index++) {
              const sample = stdout.readFloatLE(index * 8 + channel * 4)
              low = Math.min(low, sample)
              high = Math.max(high, sample)
            }
            points.push(`M${pixel} ${(center - visual(high)).toFixed(2)}L${pixel} ${(center - visual(low)).toFixed(2)}`)
          }
        }
        return `<path d="${points.join(' ')}" stroke="${channel === 0 ? '#22d3ee' : '#a78bfa'}"/>`
      })
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="96" viewBox="0 0 ${width} 96" preserveAspectRatio="none"><g fill="none" stroke-width="1.4" stroke-linejoin="round">${paths.join('')}</g></svg>`
      resolve(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)
    })
  })
}

export function editArguments(source: RecordingEditSource, start: number, end: number,
  format: RecordingSettings['format'], track: 'both' | 'video' | 'audio', output: string): string[] {
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-ss', seconds(start), '-i', source.path,
    '-t', seconds(end - start)]
  if (track === 'audio') return [...args, '-map', '0:a:0', '-vn', '-c:a', 'pcm_f32le',
    '-progress', 'pipe:2', '-stats_period', '0.5', '-rf64', 'auto', '-f', 'wav', '-n', output]
  args.push('-map', '0:v:0')
  if (track === 'both' && source.hasAudio) args.push('-map', '0:a:0')
  args.push('-fps_mode', 'vfr')
  if (format === 'lossless-mkv') {
    args.push('-c:v', 'libx264rgb', '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'bgr0')
    if (track === 'both' && source.hasAudio) args.push('-c:a', 'pcm_f32le')
    args.push('-f', 'matroska')
  } else {
    args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '16', '-pix_fmt', 'yuv420p')
    if (track === 'both' && source.hasAudio) args.push('-c:a', 'aac', '-b:a', '320k')
    args.push('-movflags', '+faststart', '-f', 'mp4')
  }
  return [...args, '-progress', 'pipe:2', '-stats_period', '0.5', '-n', output]
}

export function editTimelineArguments(source: RecordingEditSource, clips: RecordingClip[],
  format: RecordingSettings['format'], track: 'both' | 'video' | 'audio', output: string): string[] {
  if (clips.length === 1) return editArguments(source, clips[0].start, clips[0].end, format, track, output)
  const count = clips.length
  const audio = track === 'audio' || track === 'both' && source.hasAudio
  const visual = track !== 'audio'
  const filters: string[] = []
  if (visual) {
    filters.push(`[0:v:0]split=${count}${clips.map((_, i) => `[v${i}]`).join('')}`)
    clips.forEach((clip, i) => filters.push(`[v${i}]trim=start=${seconds(clip.start)}:end=${seconds(clip.end)},setpts=PTS-STARTPTS[cv${i}]`))
  }
  if (audio) {
    filters.push(`[0:a:0]asplit=${count}${clips.map((_, i) => `[a${i}]`).join('')}`)
    clips.forEach((clip, i) => filters.push(`[a${i}]atrim=start=${seconds(clip.start)}:end=${seconds(clip.end)},asetpts=PTS-STARTPTS[ca${i}]`))
  }
  const inputs = clips.map((_, i) => `${visual ? `[cv${i}]` : ''}${audio ? `[ca${i}]` : ''}`).join('')
  filters.push(`${inputs}concat=n=${count}:v=${visual ? 1 : 0}:a=${audio ? 1 : 0}${visual ? '[outv]' : ''}${audio ? '[outa]' : ''}`)
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', source.path,
    '-filter_complex', filters.join(';')]
  if (visual) args.push('-map', '[outv]', '-fps_mode', 'vfr')
  if (audio) args.push('-map', '[outa]')
  if (track === 'audio') args.push('-c:a', 'pcm_f32le', '-rf64', 'auto', '-f', 'wav')
  else if (format === 'lossless-mkv') {
    args.push('-c:v', 'libx264rgb', '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'bgr0')
    if (audio) args.push('-c:a', 'pcm_f32le')
    args.push('-f', 'matroska')
  } else {
    args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '16', '-pix_fmt', 'yuv420p')
    if (audio) args.push('-c:a', 'aac', '-b:a', '320k')
    args.push('-movflags', '+faststart', '-f', 'mp4')
  }
  return [...args, '-progress', 'pipe:2', '-stats_period', '0.5', '-n', output]
}

export function startEdit(ffmpegPath: string, args: string[], duration: number,
  onProgress: (fraction: number) => void): { child: ChildProcess; done: Promise<void> } {
  const child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
  let tail = ''
  const progress = progressReader(values => {
    if (values.out_time_us !== undefined) onProgress(Math.min(1, Math.max(0, values.out_time_us / 1_000_000 / duration)))
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    progress(chunk)
    tail = (tail + chunk.toString()).slice(-3000)
  })
  const done = new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      error ? reject(error) : resolve()
    }
    child.once('error', () => finish(new Error('Не удалось запустить монтаж видео.')))
    child.once('close', code => finish(code === 0 ? undefined : new Error(
      tail.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ') || 'Монтаж остановлен до завершения файла.')))
  })
  return { child, done }
}
