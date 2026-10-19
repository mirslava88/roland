import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { macReleasePlan } from './plan-macos-release.mjs'
import { prepareMacRelease, publishMacRelease } from './publish-macos-release.mjs'

assert.deepEqual(macReleasePlan('branch', 'master').editions, ['standard', 'stream'])
assert.deepEqual(macReleasePlan('tag', 'macos-v1.1.6').editions, ['standard'])
assert.deepEqual(macReleasePlan('tag', 'macos-v1.1.6-stream').editions, ['stream'])
for (const tag of ['v1.1.6', 'v1.1.6-stream', 'macos-v0.0.0', 'macos-v1.1.6;echo bad']) assert.throws(() => macReleasePlan('tag', tag), /Expected Mac tag/)
assert.throws(() => macReleasePlan('branch', 'master', 'windows'), /Invalid Mac edition/)
const directory = mkdtempSync(join(tmpdir(), 'pdm-macos-release-'))
try {
  assert.throws(() => prepareMacRelease('standard', directory), /ENOENT/)
  for (const edition of ['standard', 'stream']) {
    const stream = edition === 'stream'
    for (const arch of ['x64', 'arm64']) writeFileSync(join(directory, `PDM${stream ? '-Stream' : ''}-1.1.6${stream ? '-stream' : ''}-mac-${arch}.dmg`), `test-${edition}-${arch}`)
    const release = prepareMacRelease(edition, directory)
    assert.ok(release.tag.startsWith('macos-v'))
    assert.equal(release.files.length, 3)
    assert.equal(readFileSync(join(directory, 'SHA256SUMS.txt'), 'utf8').trim().split('\n').length, 2)
    assert.throws(() => publishMacRelease(edition, directory), /Publication requires/)
  }
} finally { rmSync(directory, { recursive: true, force: true }) }
console.log('PASS: Mac-only tags, edition selection, complete DMGs, checksums, publication guard')
