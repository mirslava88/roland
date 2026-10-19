// Exercise the real role transaction with fake displays and output IPC.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const { transformSync } = require('esbuild')
const source = fs.readFileSync(path.join(__dirname, '../src/renderer/src/program-display-routing.ts'), 'utf8')
const code = transformSync(source, { loader: 'ts', format: 'cjs' }).code
function setup(type = 'presentation', mode = 'program') {
  const calls = []
  const connected = s => s.displays.find(d => !d.isPrimary && s.displayAssignments[d.id] === 'program')?.id ?? null
  const state = { displays: [{ id: 1, isPrimary: true }, { id: 2, isPrimary: false }],
    selectedDisplayId: mode === 'program' ? 2 : null, displayAssignments: { 2: mode },
    activeFile: { type, path: '/fixture' }, isPresentationWindowOpen: true, liveChannel: '1',
    programScene: {}, captureSources: [],
    setDisplayAssignment(id, next) { this.displayAssignments[id] = next; this.selectedDisplayId = connected(this) }
  }
  const activeFile = state.activeFile
  const api = { platform: 'darwin', dbgLog() {},
    async prepareInternalProgramOutput(detach) { calls.push(['internal', detach]); if (api.fail) throw Error('Render display failed') },
    async openPresentationWindow(id) { calls.push(['physical', id]) }
  }
  const module = { exports: {} }
  vm.runInNewContext(code, { module, exports: module.exports, setTimeout, clearTimeout,
    window: { api, dispatchEvent() { throw Error('Mac role switch must not restart TAKE') } },
    require(name) {
      if (name === './stores/useAppStore') return { useAppStore: { getState: () => state }, connectedProgramDisplayId: connected,
        isSpeakerOnlyDisplayRouting: s => connected(s) === null && Object.values(s.displayAssignments).includes('speaker') }
      if (name === './output-transition-lock') return { acquireOutputTransition: async () => { calls.push(['lock']); return () => calls.push(['release']) } }
      if (name === './program-scene-background') return { resolveProgramSceneBackground: () => null }
      throw Error('Unexpected dependency ' + name)
    }
  })
  return { state, calls, api, activeFile, route: module.exports.setDisplayAssignmentWithProgramRouting }
}
(async () => {
  let passed = 0
  for (const type of ['presentation', 'pdf', 'video', 'capture', 'other']) {
    for (const mode of ['speaker', 'information', 'off', 'timer', 'event-timer']) {
      const t = setup(type)
      assert.equal((await t.route(2, mode)).success, true)
      assert.equal(t.state.selectedDisplayId, null)
      assert.deepEqual(t.calls, [['lock'], ['internal', true], ['release']])
      assert.equal(t.state.activeFile, t.activeFile)
      assert.equal(t.state.liveChannel, '1')
      t.calls.length = 0
      assert.equal((await t.route(2, 'program')).success, true)
      assert.equal(t.state.selectedDisplayId, 2)
      assert.deepEqual(t.calls, [['lock'], ['physical', 2], ['release']])
      assert.equal(t.state.activeFile, t.activeFile)
      passed++
    }
  }
  const t = setup(); t.api.fail = true
  assert.equal((await t.route(2, 'information')).success, false)
  assert.equal(t.state.selectedDisplayId, 2)
  assert.equal(t.state.displayAssignments[2], 'program')
  assert.equal(t.calls.at(-1)[0], 'release')
  console.log(`Mac display routing: ${passed + 1} cases passed`)
})().catch(error => { console.error(error); process.exitCode = 1 })
