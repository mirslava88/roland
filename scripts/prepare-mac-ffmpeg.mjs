import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { gunzipSync } from 'node:zlib'
import { resolve } from 'node:path'

if (process.platform !== 'darwin') process.exit(0)
const hashes = {
  x64: '929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106',
  arm64: '8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa'
}
mkdirSync('build', { recursive: true })
const pieces = []
for (const [arch, hash] of Object.entries(hashes)) {
  const archive = resolve(`build/mac-ffmpeg-${arch}.gz`)
  if (!existsSync(archive)) {
    const response = await fetch(`https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-darwin-${arch}.gz`)
    if (!response.ok) throw new Error(`FFmpeg download failed: HTTP ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error(`FFmpeg checksum mismatch for ${arch}`)
    writeFileSync(archive, bytes)
  }
  const bytes = readFileSync(archive)
  if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error(`FFmpeg checksum mismatch for ${arch}`)
  const target = resolve(`build/mac-ffmpeg-${arch}`)
  if (!existsSync(target) || statSync(target).mtimeMs < statSync(archive).mtimeMs) { writeFileSync(target, gunzipSync(bytes)); chmodSync(target, 0o755) }
  pieces.push(target)
}
const result = spawnSync('xcrun', ['lipo', '-create', ...pieces, '-output', resolve('build/mac-ffmpeg')], { stdio: 'inherit' })
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status || 1)
chmodSync('build/mac-ffmpeg', 0o755)
