import assert from 'node:assert/strict'
import { build } from 'esbuild'

const result = await build({
  entryPoints: ['./src/renderer/src/program-output-power.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false
})
const { shouldKeepProgramAwake } = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
)

const state = (activeFile, programSnapshot = null, phase = 'idle', confirmedRevision = 0) => ({
  activeFile,
  programSnapshot,
  programOutputStatus: { phase, confirmedRevision, desiredRevision: confirmedRevision, error: null }
})
const file = (type) => ({ type, path: `C:/test.${type}` })

for (const type of ['other', 'presentation', 'pdf', 'video', 'capture']) {
  assert.equal(shouldKeepProgramAwake(state(file(type))), true,
    `${type} on air must keep Windows awake`)
}
assert.equal(shouldKeepProgramAwake(state(null)), false, 'idle operator view must not hold a request')
assert.equal(shouldKeepProgramAwake(state(null, {}, 'publishing')), false,
  'a first unconfirmed Scene must not count as live')
assert.equal(shouldKeepProgramAwake(state(null, {}, 'live', 1)), true,
  'a Scene with no channel file can still be on air')
assert.equal(shouldKeepProgramAwake(state(null, {}, 'publishing', 1)), true,
  'refreshing an existing Scene must not release the request')
assert.equal(shouldKeepProgramAwake(state(null, {}, 'error', 1)), true,
  'a failed refresh can leave the previous Scene on air')
assert.equal(shouldKeepProgramAwake(state(null, null, 'idle', 1)), false,
  'leaving the air must release the request')

console.log('Program output power state: image, other sources, Scene transitions and exit passed')
