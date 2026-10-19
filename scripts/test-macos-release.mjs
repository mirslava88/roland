import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { macReleasePlan } from './plan-macos-release.mjs'
import { prepareMacRelease, publishMacRelease } from './publish-macos-release.mjs'
import { createRequire } from 'node:module'

const { editionInfo, macReleaseTag } = createRequire(import.meta.url)('../build/editions.cjs')
const standard = editionInfo('standard', 'darwin'), streamInfo = editionInfo('stream', 'darwin')

assert.deepEqual(macReleasePlan('branch', 'master').editions, ['standard', 'stream'])
assert.deepEqual(macReleasePlan('tag', macReleaseTag('standard')).editions, ['standard'])
assert.deepEqual(macReleasePlan('tag', macReleaseTag('stream')).editions, ['stream'])
for (const tag of [`${macReleaseTag('standard')}-other`, `${macReleaseTag('stream')}-other`]) assert.throws(() => macReleasePlan('tag', tag), /Expected Mac tag/)
for (const tag of ['v1.1.6', 'v1.1.6-stream', 'macos-v0.0.0', 'macos-v1.1.6;echo bad']) assert.throws(() => macReleasePlan('tag', tag), /Expected Mac tag/)
assert.throws(() => macReleasePlan('branch', 'master', 'windows'), /Invalid Mac edition/)
const directory = mkdtempSync(join(tmpdir(), 'pdm-macos-release-'))
try {
  assert.throws(() => prepareMacRelease('standard', directory), /ENOENT/)
  for (const edition of ['standard', 'stream']) {
    const stream = edition === 'stream'
    const info = editionInfo(edition, 'darwin')
    for (const arch of ['x64', 'arm64']) writeFileSync(join(directory, `PDM${stream ? '-Stream' : ''}-${info.version}-mac-${arch}.dmg`), `test-${edition}-${arch}`)
    const release = prepareMacRelease(edition, directory)
    assert.equal(release.tag, macReleaseTag(edition))
    assert.equal(release.files.length, 3)
    assert.equal(readFileSync(join(directory, 'SHA256SUMS.txt'), 'utf8').trim().split('\n').length, 2)
    // The test also runs on real release tags. Always give the publication
    // guard a non-tag context so fixtures can never reach GitHub operations.
    const previous = process.env.GITHUB_REF_TYPE
    process.env.GITHUB_REF_TYPE = 'branch'
    try { assert.throws(() => publishMacRelease(edition, directory), /Publication requires/) }
    finally {
      if (previous === undefined) delete process.env.GITHUB_REF_TYPE
      else process.env.GITHUB_REF_TYPE = previous
    }
  }
} finally { rmSync(directory, { recursive: true, force: true }) }
console.log('PASS: Mac-only tags, edition selection, complete DMGs, checksums, publication guard')
