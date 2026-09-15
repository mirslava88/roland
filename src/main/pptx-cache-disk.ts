import { writeFileSync } from 'fs'
import { lstat, readdir, rm } from 'fs/promises'
import { randomUUID } from 'crypto'
import { basename, dirname, join, resolve } from 'path'
import { tmpdir } from 'os'

const cacheName = /^pdm-(slides|thumbs)-[a-f0-9]{24}$/
const ownerName = /^pdm-pptx-cache-owner-([1-9][0-9]*)-[a-f0-9-]{36}\.lock$/

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) {
    // Access denied is not proof that another cache user has exited.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

// Cache names are shared by editions. A live second PDM keeps the shared disk
// cache; the last normal exit removes it, including stale/unfinished caches.
export function createPptxDiskCache(
  temporaryDirectory = tmpdir(),
  isAlive: (pid: number) => boolean = processIsAlive
) {
  const root = resolve(temporaryDirectory)
  const owner = join(root, `pdm-pptx-cache-owner-${process.pid}-${randomUUID()}.lock`)
  let registered = false
  let closed = false
  return {
    claim(directory: string): string {
      if (closed) throw new Error('PPTX disk cache is shutting down')
      const target = resolve(directory)
      if (dirname(target) !== root || !cacheName.test(basename(target))) {
        throw new Error('Invalid PDM PowerPoint cache directory')
      }
      if (!registered) {
        writeFileSync(owner, '', { flag: 'wx' })
        registered = true
      }
      return target
    },
    async clear(): Promise<{ removed: number; shared: boolean }> {
      closed = true
      if (registered) await rm(owner, { force: true })
      const entries = await readdir(root, { withFileTypes: true })
      for (const entry of entries) {
        const match = ownerName.exec(entry.name)
        if (!match) continue
        const path = join(root, entry.name)
        const info = await lstat(path).catch(() => null)
        if (!info) continue
        // Never follow a registry junction/link or guess whether it is safe.
        if (!info.isFile() || info.isSymbolicLink() || isAlive(Number(match[1]))) {
          return { removed: 0, shared: true }
        }
        await rm(path, { force: true })
      }
      let removed = 0
      const failures: unknown[] = []
      for (const entry of entries) {
        if (!cacheName.test(entry.name)) continue
        const target = resolve(root, entry.name)
        if (dirname(target) !== root) continue
        const info = await lstat(target).catch(() => null)
        if (!info?.isDirectory() || info.isSymbolicLink()) continue
        try {
          await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
          removed++
        } catch (error) { failures.push(error) }
      }
      if (failures.length) throw new AggregateError(failures, 'PPTX disk cache cleanup incomplete')
      return { removed, shared: false }
    }
  }
}
