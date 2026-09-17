import { spawnSync } from 'node:child_process'

const editionBuilds = [
  ['Standard build', process.execPath, ['scripts/build-edition.mjs', 'standard']],
  ['Stream build', process.execPath, ['scripts/build-edition.mjs', 'stream']]
]
const integrationChecks = [
  ['Streaming engine', process.execPath, ['scripts/test-streaming.mjs']],
  ['Streaming handshake', process.execPath, ['scripts/test-streaming-handshake.mjs']],
  ['Streaming keyframes', process.execPath, ['scripts/test-streaming-keyframes.mjs']]
]

const suites = {
  core: [
    ['Security hardening', process.execPath, ['scripts/test-security-hardening.mjs']],
    ['Stream Deck commands', process.execPath, ['scripts/test-direct-stream-deck.mjs']],
    ['Scene and timer commands', process.execPath, ['scripts/test-scene-and-timer-commands.mjs']],
    ['PPTX cache', process.execPath, ['scripts/test-pptx-cache.mjs']],
    ['PPTX cache shutdown', process.execPath, ['scripts/test-pptx-cache-shutdown.mjs']],
    ['PPTX early start', process.execPath, ['scripts/test-pptx-early-start.mjs']],
    ['PPTX thumbnails', process.execPath, ['scripts/test-pptx-thumbnail.mjs']],
    ['Scene audio', process.execPath, ['scripts/test-program-scene-audio.mjs']],
    ['Scene composition', process.execPath, ['scripts/test-program-scene-background.mjs']],
    ['PowerPoint display recovery', process.execPath, ['scripts/test-powerpoint-display-recovery.mjs']],
    ['PowerPoint output recovery', process.execPath, ['scripts/test-powerpoint-output-recovery.mjs']]
  ],
  ui: [
    ['Toolbar UI', process.execPath, ['scripts/test-toolbar-ui.mjs']],
    ['Onboarding UI', process.execPath, ['scripts/test-onboarding-ui.mjs']],
    ['Scene audio UI', process.execPath, ['scripts/test-program-scene-audio-ui.mjs']],
    ['Scene video UI', process.execPath, ['scripts/test-program-scene-video-ui.mjs']]
  ],
  integration: [...editionBuilds, ...integrationChecks]
}

const requested = process.argv[2] || 'all'
if (requested !== 'all' && !suites[requested]) {
  throw new Error(`Unknown critical test suite: ${requested}`)
}
const tests = requested === 'all'
  ? [...suites.core, ...editionBuilds, ...suites.ui, ...integrationChecks]
  : requested === 'ui'
    ? [...editionBuilds, ...suites.ui]
    : suites[requested]
const started = Date.now()
let passed = 0
for (const [name, command, args] of tests) {
  console.log(`\n[critical ${passed + 1}/${tests.length}] ${name}`)
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
    windowsHide: true
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    console.error(`FAILED: ${name} (exit ${result.status ?? 'unknown'})`)
    process.exit(result.status || 1)
  }
  passed++
}
console.log(`\nPASS: ${passed}/${tests.length} critical checks in ${Math.round((Date.now() - started) / 1000)}s`)
