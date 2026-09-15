import assert from 'node:assert/strict'
import { build } from 'esbuild'

async function moduleFrom(path) {
  const result = await build({ entryPoints: [path], bundle: true, platform: 'node', format: 'esm', write: false })
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)
}
const { ProgramSceneAudioSession } = await moduleFrom('src/renderer/src/components/ProgramScene/program-scene-audio-session.ts')
const { normalizeProgramSceneAudio, resolveProgramSceneAudioDevice } = await moduleFrom('src/shared/program-scene-audio.ts')
const config = { enabled: true, deviceId: 'camera-audio', groupId: 'camera-group', label: 'Camera audio' }
const input = (deviceId = config.deviceId, groupId = config.groupId) => ({ kind: 'audioinput', deviceId, groupId, label: config.label })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const flush = () => new Promise((resolve) => setImmediate(resolve))
function media() {
  const track = { readyState: 'live', muted: false, stops: 0, stop() { this.stops++; this.readyState = 'ended' } }
  return { track, getTracks: () => [track], getAudioTracks: () => [track] }
}
function fixture() {
  const state = { devices: [input()], requests: [], outputs: [], streams: [], statuses: [], request: null }
  state.session = new ProgramSceneAudioSession({
    enumerateDevices: async () => state.devices,
    getUserMedia: async (constraints) => {
      assert.equal(constraints.video, false, 'audio control must never reopen a camera')
      state.requests.push(constraints)
      if (state.request) return state.request()
      const stream = media(); state.streams.push(stream); return stream
    }
  }, () => {
    const output = { srcObject: null, muted: true, plays: 0, pauses: 0,
      async play() { this.plays++; if (state.playWait) await state.playWait.promise }, pause() { this.pauses++ } }
    state.outputs.push(output); return output
  }, (status) => state.statuses.push(status))
  return state
}

assert.deepEqual(normalizeProgramSceneAudio(undefined), { enabled: false, deviceId: '', groupId: '', label: '' })
assert.equal(normalizeProgramSceneAudio({ enabled: 'true', deviceId: 1 }).enabled, false)
assert.equal(resolveProgramSceneAudioDevice(config, [input('new-id')]), 'new-id')
assert.equal(resolveProgramSceneAudioDevice(config, [input('unrelated', 'other-group'), input('ambiguous', 'third-group')]), null)
assert.equal(resolveProgramSceneAudioDevice(config, [{ kind: 'audioinput', deviceId: 'default', groupId: '', label: 'Other mic' }]), null)

{
  const f = fixture()
  await f.session.set(null)
  await f.session.set({ ...config, enabled: false })
  assert.equal(f.requests.length, 0, 'preview/disabled PiP never captures audio')
  await f.session.set(config)
  assert.equal(f.statuses.at(-1).phase, 'live')
  for (const mode of ['participant', 'content', 'both', 'both']) await f.session.set({ ...config, mode })
  assert.equal(f.requests.length, 1, 'view/layout/slide changes retain the same audio stream')
  await f.session.devicesChanged()
  assert.equal(f.requests.length, 1, 'unrelated device changes do not interrupt a live microphone')
  f.session.stop()
  assert.equal(f.outputs[0].srcObject, null)
  assert.equal(f.outputs[0].muted, true)
  assert.equal(f.streams[0].track.readyState, 'ended')
  assert.equal(f.statuses.at(-1).phase, 'idle')
  await f.session.devicesChanged()
  assert.equal(f.requests.length, 1, 'device reconnect cannot revive disabled PiP audio')
}
{
  const f = fixture(), pending = deferred(), late = media()
  f.request = () => pending.promise
  const connecting = f.session.set(config)
  await flush()
  f.session.stop()
  pending.resolve(late)
  await connecting
  assert.equal(late.track.readyState, 'ended', 'late permission result is released after disable/unmount')
  assert.equal(f.outputs.length, 0, 'late audio never plays')
}
{
  const f = fixture(), pending = deferred(), old = media()
  f.devices.push(input('second-input', 'second-group'))
  f.request = () => pending.promise
  const connecting = f.session.set(config)
  await flush()
  f.request = null
  await f.session.set({ ...config, deviceId: 'second-input', groupId: 'second-group' })
  pending.resolve(old)
  await connecting
  assert.equal(old.track.readyState, 'ended')
  assert.equal(f.outputs.length, 1)
  assert.equal(f.outputs[0].srcObject, f.streams[0], 'stale input cannot replace/mute the newer input')
  f.session.stop()
}
{
  const f = fixture()
  await f.session.set(config)
  f.devices = []
  f.streams[0].track.onended()
  assert.equal(f.outputs[0].srcObject, null)
  assert.equal(f.statuses.at(-1).phase, 'error')
  await f.session.devicesChanged()
  assert.equal(f.requests.length, 1, 'missing camera does not select a random mic')
  f.devices = [input('reconnected-id')]
  await f.session.devicesChanged()
  assert.equal(f.requests.length, 2)
  assert.equal(f.requests[1].audio.deviceId.exact, 'reconnected-id')
  f.streams[1].track.onmute()
  assert.equal(f.statuses.at(-1).phase, 'error')
  f.streams[1].track.onunmute()
  assert.equal(f.statuses.at(-1).phase, 'live')
  f.session.stop()
}
{
  const f = fixture()
  f.request = () => Promise.reject(Object.assign(new Error('permission'), { name: 'NotAllowedError' }))
  await f.session.set(config)
  assert.equal(f.statuses.at(-1).phase, 'error')
  assert.match(f.statuses.at(-1).message, /Доступ к микрофону/)
  assert.equal(f.outputs.length, 0)
  f.session.stop()
}

{
  const f = fixture()
  f.playWait = deferred()
  const connecting = f.session.set(config)
  await flush()
  f.session.stop()
  f.playWait.resolve()
  await connecting
  assert.equal(f.outputs[0].srcObject, null, 'stop during play() cannot resume output')
  assert.equal(f.statuses.at(-1).phase, 'idle')
}
{
  const f = fixture()
  for (let i = 0; i < 25; i++) { await f.session.set(config); f.session.stop() }
  assert.equal(f.streams.length, 25)
  assert.ok(f.streams.every((stream) => stream.track.readyState === 'ended'))
  assert.ok(f.outputs.every((output) => output.srcObject === null && output.muted))
}

const storage = new Map()
globalThis.localStorage = { getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) }
const { useAppStore } = await moduleFrom('src/renderer/src/stores/useAppStore.ts')
const state = () => useAppStore.getState()
state().setProgramScene({ captureSourceId: 'camera-1', audio: config, enabled: true })
for (const viewMode of ['participant', 'content', 'both']) {
  state().setProgramScene({ viewMode })
  assert.equal(state().programScene.audio.enabled, true)
}
const saved = JSON.parse(storage.get('roland-app-preferences'))
assert.equal(saved.state.programScene.enabled, false, 'restoring config never starts PiP/audio automatically')
assert.equal(saved.state.programScene.audio.deviceId, config.deviceId)
state().setProgramScene({ captureSourceId: 'camera-2' })
assert.equal(state().programScene.audio.enabled, false, 'changing camera cannot keep an unrelated mic live')
assert.equal(state().programScene.audio.deviceId, '')
const snapshotRevision = state().publishProgramSnapshot(null, {
  timer: {
    duration: 900, remaining: 900, running: false, visible: true,
    position: { x: 50, y: 50 }, scale: 1,
    textColor: '#ffffff', warningTextColor: '#facc15', overtimeTextColor: '#ef4444', textOpacity: 1
  }
})
assert.equal(state().programOutputStatus.phase, 'publishing')
assert.equal(state().programSnapshot.revision, snapshotRevision)
assert.equal(Object.isFrozen(state().programSnapshot), true)
assert.equal(Object.isFrozen(state().programSnapshot.scene.mediaLayers), true)
state().confirmProgramSnapshot(snapshotRevision)
assert.equal(state().programOutputStatus.phase, 'live')
console.log('PASS: PiP audio defaults, one audio-only owner, mode changes, stop/cleanup, late results, input switching, unplug/reconnect, permission errors and safe saved settings')
