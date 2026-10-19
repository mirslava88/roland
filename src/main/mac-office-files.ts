import { mkdir, mkdtemp } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'

// Typed file-URL Apple events grant Keynote access to each managed copy and
// export destination. Keep these files in PDM's cache: probing another app's
// container can wait for App Data Protection and stall every cold import.
export async function createOfficeWorkspace(application: 'keynote' | 'powerpoint', prefix: string): Promise<string> {
  const cache = join(homedir(), 'Library', 'Caches', 'Presentation Display Manager', application)
  await mkdir(cache, { recursive: true, mode: 0o700 })
  return mkdtemp(join(cache, prefix))
}
