import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'

async function moduleFrom(path) {
  const result = await build({ entryPoints: [path], bundle: true, platform: 'node', format: 'esm', write: false })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

const { resolveProgramSceneChannel } = await moduleFrom('src/renderer/src/program-scene-channel.ts')
const { reduceTimerCommand } = await moduleFrom('src/renderer/src/timer-controls.ts')
const { selectProgramSnapshotTimer } = await moduleFrom('src/renderer/src/program-snapshot-timer.ts')

const channels = {
  live: { file: { path: 'live.pdf' } },
  stale: { file: { path: 'stale.pptx' } },
  selected: { file: { path: 'selected.mp4' } },
  empty: { file: null }
}
assert.equal(resolveProgramSceneChannel({
  liveChannel: 'live', sceneContentChannelId: 'stale', selectedChannel: 'selected', channels
}), 'live', 'the committed live channel must win over stale Scene draft state')
assert.equal(resolveProgramSceneChannel({
  liveChannel: 'missing', sceneContentChannelId: 'stale', selectedChannel: 'selected', channels
}), 'stale')
assert.equal(resolveProgramSceneChannel({
  liveChannel: null, sceneContentChannelId: 'empty', selectedChannel: 'selected', channels
}), 'selected')
assert.equal(resolveProgramSceneChannel({
  liveChannel: null, sceneContentChannelId: null, selectedChannel: 'empty', channels
}), null)

const base = {
  duration: 900,
  remaining: 300,
  running: false,
  outputVisible: false,
  outputOwner: null,
  warned: false,
  ended: false
}
let timer = reduceTimerCommand(base, { type: 'start' })
assert.deepEqual(timer, { ...base, running: true, outputVisible: true, outputOwner: 'toolbar' })
timer = reduceTimerCommand(timer, { type: 'pause' })
assert.equal(timer.running, false)
assert.equal(timer.outputVisible, true, 'pause must not remove timer from output')

timer = reduceTimerCommand({ ...base, duration: 300, remaining: 300, outputVisible: true, outputOwner: 'scene' }, {
  type: 'add-minutes', minutes: -10
})
assert.equal(timer.duration, 0)
assert.equal(timer.remaining, -300)
assert.equal(timer.outputVisible, true, 'overtime after subtraction must remain visible')
assert.equal(timer.outputOwner, 'scene')

timer = reduceTimerCommand({ ...base, remaining: -5, warned: true, ended: true }, {
  type: 'add-minutes', minutes: 5
})
assert.equal(timer.remaining, 295)
assert.equal(timer.warned, false)
assert.equal(timer.ended, false)
assert.equal(timer.outputVisible, true)

timer = reduceTimerCommand(base, {
  type: 'apply-state', duration: 900.4, remaining: 61.2, running: true
})
assert.equal(timer.duration, 900)
assert.equal(timer.remaining, 61)
assert.equal(timer.outputOwner, 'scene')
assert.equal(timer.outputVisible, true)
assert.equal(timer.warned, false)

timer = reduceTimerCommand({ ...timer, remaining: -12, warned: true, ended: true }, { type: 'reset' })
assert.equal(timer.remaining, 900)
assert.equal(timer.running, false)
assert.equal(timer.outputVisible, true)
assert.equal(timer.outputOwner, 'scene')
assert.equal(timer.warned, false)
assert.equal(timer.ended, false)

timer = reduceTimerCommand(timer, { type: 'stop' })
assert.deepEqual(timer, {
  duration: 0, remaining: 0, running: false,
  outputVisible: false, outputOwner: null, warned: false, ended: false
})
assert.equal(reduceTimerCommand(base, { type: 'set-duration', seconds: 0 }), base)
assert.equal(reduceTimerCommand({ ...base, duration: 0 }, { type: 'start' }).outputVisible, false)

const publishedSceneTimer = {
  duration: 900,
  remaining: 420,
  running: true,
  visible: true,
  position: { x: 74, y: 12 },
  scale: 1.4
}
const independentToolbarTimer = {
  ...publishedSceneTimer,
  duration: 600,
  remaining: 295,
  position: { x: 50, y: 50 }
}
let selectedTimer = selectProgramSnapshotTimer(undefined, publishedSceneTimer, independentToolbarTimer)
assert.deepEqual(selectedTimer.timer, publishedSceneTimer, 'QR-only publication must preserve the published Scene timer')
assert.equal(selectedTimer.applyToLiveTimer, false, 'QR-only publication must not take ownership of the live toolbar timer')
assert.notEqual(selectedTimer.timer.position, publishedSceneTimer.position, 'published timer geometry must remain immutable')

selectedTimer = selectProgramSnapshotTimer(independentToolbarTimer, publishedSceneTimer, publishedSceneTimer)
assert.deepEqual(selectedTimer.timer, independentToolbarTimer, 'an explicit Scene timer publication must use the new draft')
assert.equal(selectedTimer.applyToLiveTimer, true, 'only an explicit timer publication may replace live timer state')

const [auxiliaryBridge, auxiliaryApp, outputPreload, mainProcess] = await Promise.all([
  readFile('src/renderer/src/components/AuxiliaryDisplays/AuxiliaryDisplayBridge.tsx', 'utf8'),
  readFile('src/renderer/src/AuxiliaryApp.tsx', 'utf8'),
  readFile('src/preload/output.ts', 'utf8'),
  readFile('src/main/index.ts', 'utf8')
])
assert.match(auxiliaryApp, /role === 'timer'[\s\S]*sendToControl\('timer-state-ready'/,
  'a newly opened timer display must announce that its listeners are ready')
assert.match(auxiliaryBridge, /on\('timer-state-ready'[\s\S]*sendToAuxiliary\('timer', 'information-state'[\s\S]*sendToAuxiliary\('timer', 'timer-update'/,
  'the timer ready handshake must replay visibility and the complete running timer snapshot')
assert.match(outputPreload, /'timer-state-ready'/,
  'the restricted output preload must allow the timer ready handshake')
assert.match(mainProcess, /timer: new Set\(\['timer-state-ready'\]\)/,
  'main must accept the timer handshake only from a timer auxiliary window')
assert.match(mainProcess, /channel === 'program-mirror-state-ready'[\s\S]*broadcastWpfTimerToMirrors\(true\)/,
  'a newly ready live copy must receive the current program timer overlay')
assert.match(auxiliaryApp, /PROGRAM_MIRROR_RETRY_DELAY_MS[\s\S]*retry scheduled[\s\S]*setReconnectRevision/,
  'a live copy must continue reconnecting after transient Windows capture failures')
assert.doesNotMatch(auxiliaryApp, /failure < PROGRAM_MIRROR_MAX_RETRIES/,
  'a live copy must not permanently stop after a fixed number of retries')

console.log('PASS: live Scene channel priority, timer transitions, auxiliary timer readiness, mirror recovery and QR-only publication ownership isolation')
