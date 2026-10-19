import { createHash, randomUUID } from 'crypto'
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'

export interface KeynoteSource {
  path: string
  key: string
}

// A native Keynote copy is derived data. Never save over the operator's PPTX.
export async function keynoteSource(path: string): Promise<KeynoteSource> {
  const canonical = await realpath(path)
  const file = await stat(canonical)
  if (!file.isFile()) throw new Error('Presentation is not a file')
  const key = createHash('sha256').update(JSON.stringify([
    'pdm-keynote-v1', canonical, file.size, file.mtimeMs
  ])).digest('hex')
  return { path: canonical, key }
}

export class KeynoteDiskCache {
  constructor(private readonly root: string) {}

  async find(source: KeynoteSource): Promise<string | null> {
    const directory = join(this.root, source.key)
    try {
      const manifest = JSON.parse(await readFile(join(directory, 'ready.json'), 'utf8'))
      if (manifest.key !== source.key) return null
      const path = join(directory, `${source.key}.key`)
      const file = await stat(path)
      return file.isDirectory() || file.size > 0 ? path : null
    } catch { return null }
  }

  async save(source: KeynoteSource, saveDocument: (destination: string) => Promise<void>): Promise<string> {
    await mkdir(this.root, { recursive: true })
    const staging = join(this.root, `.preparing-${randomUUID()}`)
    await mkdir(staging)
    try {
      await saveDocument(join(staging, `${source.key}.key`))
      const file = await stat(join(staging, `${source.key}.key`))
      if (!file.isDirectory() && file.size === 0) throw new Error('Empty Keynote cache')
      if ((await keynoteSource(source.path)).key !== source.key) {
        throw new Error('Presentation changed during preparation')
      }
      await writeFile(join(staging, 'ready.json'), JSON.stringify({ key: source.key }))
      const destination = join(this.root, source.key)
      // Only a complete directory is published. Concurrent editions/processes
      // may already have produced the same immutable generation.
      try { await rename(staging, destination) }
      catch (error) { if (!await this.find(source)) throw error }
      return join(destination, `${source.key}.key`)
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }

  async invalidate(source: KeynoteSource): Promise<void> {
    // Generated hash only: neither source paths nor renderer input are deleted.
    if (!/^[a-f0-9]{64}$/.test(source.key)) throw new Error('Invalid cache key')
    await rm(join(this.root, source.key), { recursive: true, force: true })
  }
}

// Keynote accepts one app operation at a time. Select operator work before
// pending background imports; a running Apple event must finish safely.
export class KeynoteQueue {
  private running = false
  private foreground: Array<() => Promise<void>> = []
  private background: Array<() => Promise<void>> = []

  private keys = new WeakMap<() => Promise<void>, string>()

  promote(key: string): void {
    const index = this.background.findIndex(task => this.keys.get(task) === key)
    if (index < 0) return
    this.foreground.unshift(this.background.splice(index, 1)[0])
    this.pump()
  }

  run<T>(operation: () => Promise<T>, background = false, key?: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const task = async (): Promise<void> => {
        try { resolve(await operation()) } catch (error) { reject(error) }
      }
      if (key) this.keys.set(task, key)
      ;(background ? this.background : this.foreground).push(task)
      this.pump()
    })
  }

  get workload(): number { return (this.running ? 1 : 0) + this.foreground.length + this.background.length }

  private pump(): void {
    if (this.running) return
    const task = this.foreground.shift() || this.background.shift()
    if (!task) return
    this.running = true
    void task().finally(() => { this.running = false; this.pump() })
  }
}
