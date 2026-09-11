import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const [daemon, main, preview] = await Promise.all([
  readFile(new URL('./powerpoint-daemon.ps1', import.meta.url), 'utf8'),
  readFile(new URL('../src/main/index.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/renderer/src/components/Preview/PreviewPanel.tsx', import.meta.url), 'utf8')
])

assert.match(
  daemon,
  /return \[string\]::IsNullOrEmpty\(\$currentKey\) -or \$currentKey -eq \$expectedKey/,
  'a stale managed PowerPoint RCW must retain ownership by exact COM identity'
)
assert.match(
  daemon,
  /\$key = \$trackedKey/,
  'stale managed presentation cleanup must retire its registered path key'
)
assert.match(
  daemon,
  /\$sw = Resolve-PdmSlideShowWindow \$ppt/,
  'CLOSE must validate the cached slideshow instead of calling a dead RCW'
)
assert.match(
  main,
  /scheduleDisplayMetricsSync\('display-added-stable'\)/,
  'a returned monitor must receive a stable delayed PowerPoint relocation pass'
)
assert.match(
  main,
  /powerpoint-output-recovery-needed/,
  'failed relocation on the returned output must request transactional recovery'
)
assert.match(
  preview,
  /on\('powerpoint-output-recovery-needed'[\s\S]*?void handleTake\(liveChannelId\)/,
  'the live PowerPoint channel must be reopened through the normal TAKE pipeline'
)

console.log('PowerPoint display reconnect recovery contracts: OK')
