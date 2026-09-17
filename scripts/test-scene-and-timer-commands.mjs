import assert from 'node:assert/strict'
import { build } from 'esbuild'

async function moduleFrom(path) {
  const result = await build({ entryPoints: [path], bundle: true, platform: 'node', format: 'esm', write: false })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}

const { resolveProgramSceneChannel } = await moduleFrom('src/renderer/src/program-scene-channel.ts')
const { reduceTimerCommand } = await moduleFrom('src/renderer/src/timer-controls.ts')

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

console.log('PASS: live Scene channel priority and timer start/pause/overtime/reset/output ownership transitions')
