// Update a stopped, already packaged Mac app while preserving its dependencies.
// Wait for ASAR's write stream: createPackageWithOptions can return before the
// final queued writes finish. Copying sooner can leave zero bytes at the tail.
import { createRequire } from 'node:module'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const asar = require('@electron/asar')
const { editionInfo } = require('../build/editions.cjs')
const [edition, appPath, template] = process.argv.slice(2)
const info = editionInfo(edition)
if (!appPath) throw new Error('Usage: edition app-path [pristine-extracted-template]')
const contents = join(resolve(appPath), 'Contents')
const resources = join(contents, 'Resources')
const target = join(resources, 'app.asar')
const root = mkdtempSync(join(tmpdir(), 'pdm-asar-'))
try {
  const source = join(root, 'source'), archive = join(root, 'app.asar')
  if (template) cpSync(template, source, { recursive: true })
  else asar.extractAll(target, source)
  const metadata = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
  if (metadata.name !== info.name || metadata.version !== info.version) throw new Error('Packaged edition metadata mismatch')
  rmSync(join(source, 'out'), { recursive: true, force: true })
  cpSync(resolve(`out/${edition}`), join(source, 'out'), { recursive: true })
  const output = await asar.createPackageWithOptions(source, archive, { unpack: '**/*.node' })
  if (output && !output.writableFinished) await once(output, 'finish')
  if (output && !output.closed) await once(output, 'close')
  if (JSON.parse(asar.extractFile(archive, 'package.json').toString()).name !== info.name) throw new Error('ASAR metadata verification failed')
  for (const full of asar.listPackage(archive)) {
    const file = full.replace(/^\//, '')
    const entry = asar.statFile(archive, file, false)
    if (entry.files || entry.link || !entry.integrity) continue
    const digest = createHash('sha256').update(asar.extractFile(archive, file)).digest('hex')
    if (digest !== entry.integrity.hash) throw new Error(`ASAR integrity verification failed: ${file}`)
  }
  cpSync(archive, target)
  if (existsSync(`${archive}.unpacked`)) cpSync(`${archive}.unpacked`, `${target}.unpacked`, { recursive: true })
  const hash = createHash('sha256').update(asar.getRawHeader(archive).headerString).digest('hex')
  execFileSync('/usr/bin/python3', ['-c',
    "import plistlib,sys\np=sys.argv[1]\nwith open(p,'rb') as f:d=plistlib.load(f)\nif 'ElectronAsarIntegrity' in d: d['ElectronAsarIntegrity']={'Resources/app.asar':{'algorithm':'SHA256','hash':sys.argv[2]}}\nwith open(p,'wb') as f:plistlib.dump(d,f,sort_keys=False)",
    join(contents, 'Info.plist'), hash])
  console.log(`Mac ${edition} ASAR refreshed; metadata, file hashes and embedded header hash verified`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
