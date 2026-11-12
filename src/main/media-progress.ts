export function progressReader(onProgress: (values: Record<string, number>) => void): (chunk: Buffer) => void {
  let rest = ''
  let values: Record<string, number> = {}
  return (chunk) => {
    rest += chunk.toString()
    const lines = rest.split(/\r?\n/)
    rest = (lines.pop() || '').slice(-4096)
    for (const line of lines) {
      const match = /^(frame|fps|drop_frames|out_time_us|total_size|speed)=\s*(-?\d+(?:\.\d+)?)(?:x)?$/.exec(line)
      if (match) values[match[1]] = Number(match[2])
      if (line.startsWith('progress=')) { onProgress(values); values = {} }
    }
  }
}
