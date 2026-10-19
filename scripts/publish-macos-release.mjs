import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const { editionInfo } = createRequire(import.meta.url)('../build/editions.cjs')

export function prepareMacRelease(edition, directory) {
  const info = editionInfo(edition)
  const tag = `macos-v${info.version}`
  const metadata = JSON.parse(readFileSync(new URL(`../docs/releases/macos-${info.version.replace(/-stream$/, '')}.json`, import.meta.url), 'utf8'))[edition]
  if (typeof metadata?.title !== 'string' || typeof metadata?.body !== 'string') throw new Error('Missing Mac release metadata')
  const files = ['x64', 'arm64'].map(arch => join(directory, `PDM${info.stream ? '-Stream' : ''}-${info.version}-mac-${arch}.dmg`))
  const sums = files.map(file => {
    if (!statSync(file).isFile()) throw new Error(`Missing DMG: ${file}`)
    return `${createHash('sha256').update(readFileSync(file)).digest('hex')}  ${file.slice(directory.length + 1)}`
  })
  const checksum = join(directory, 'SHA256SUMS.txt'), notes = join(directory, 'RELEASE_NOTES.txt')
  writeFileSync(checksum, sums.join('\n') + '\n')
  writeFileSync(notes, metadata.body + '\n')
  return { tag, title: metadata.title, files: [...files, checksum], notes }
}

export function publishMacRelease(edition, directory) {
  const release = prepareMacRelease(edition, directory)
  if (process.env.GITHUB_REF_TYPE !== 'tag' || process.env.GITHUB_REF_NAME !== release.tag) throw new Error('Publication requires the exact macOS release tag')
  const repo = process.env.GITHUB_REPOSITORY
  if (!repo) throw new Error('Missing GitHub repository')
  const existing = spawnSync('gh', ['release', 'view', release.tag, '--repo', repo], { stdio: 'ignore' })
  if (existing.error) throw existing.error
  if (existing.status === 0) {
    console.log('Mac release already exists; preserving its notes and assets.')
    return
  }
  execFileSync('gh', ['release', 'create', release.tag, ...release.files, '--repo', repo,
    '--verify-tag', '--title', release.title, '--notes-file', release.notes,
    '--draft', '--prerelease', '--latest=false'], { stdio: 'inherit' })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [action, edition, directory] = process.argv.slice(2)
  const path = resolve(directory || '.')
  if (action === 'prepare') console.log(JSON.stringify(prepareMacRelease(edition, path)))
  else if (action === 'publish') publishMacRelease(edition, path)
  else throw new Error('Expected prepare or publish')
}
