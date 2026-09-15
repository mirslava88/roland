import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

const result = await build({
  entryPoints: ['src/main/powerpoint-daemon.ts'], bundle: true, write: false,
  platform: 'node', format: 'cjs', plugins: [{ name: 'no-office-test', setup(builder) {
    builder.onResolve({ filter: /^\.\/(paths|diagnostic-log)$/ }, args => ({ path: args.path, namespace: 'fixture' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents:
      'export const scriptPath=()=>{throw Error("No Office may spawn in this test")}; export const diagnosticLog=()=>{}; export const formatDiagnosticError=String;' }))
  } }]
})
const module = { exports: {} }
new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
const { pptDaemon, PowerPointPreOpenRecoveryError } = module.exports
function fixture(onRequest) {
  const daemon = new pptDaemon.constructor()
  const calls = []
  const reply = message => daemon.handleLine(JSON.stringify(message), null, () => {})
  daemon.proc = { killed: false, exitCode: null, signalCode: null, stdin: { write(line, callback) {
    const request = JSON.parse(line); calls.push(request.cmd)
    callback?.(); queueMicrotask(() => onRequest(request, reply, daemon))
  } } }
  daemon.ready = Promise.resolve()
  return { daemon, calls }
}
const complete = (request, reply, ok = true) => {
  reply({ id: request.id, ok: true, cleanupPending: true })
  setTimeout(() => reply({ id: request.id, ok, event: 'command-complete', error: ok ? undefined : 'host still alive' }), 15)
}

// Reproduce OPEN queued during a CLOSE that ACKs success, then fails cleanup.
let closes = 0
const first = fixture((request, reply) => {
  if (request.cmd === 'close') complete(request, reply, ++closes > 1)
  else if (request.cmd === 'commit-open') complete(request, reply)
  else reply({ id: request.id, ok: true })
})
await first.daemon.send('close', {}, 0)
const take = first.daemon.runExclusive(async send => {
  assert.equal((await send('open', {}, 1000)).ok, true)
  assert.equal(first.daemon.cleanupRecoveryRequired, null)
  assert.equal(first.daemon.cleanupBarrier, null, 'OPEN must wait for terminal recovery, not its ACK')
  await send('commit-open', {}, 0)
})
const preparation = first.daemon.send('prepare', {}, 1000)
await Promise.all([take, preparation])
assert.deepEqual(first.calls, ['close', 'close', 'open', 'commit-open', 'prepare'])

// Retained failure has bounded retries and never sends OPEN/ABORT.
const retained = fixture((request, reply) => complete(request, reply, false))
retained.daemon.cleanupRecoveryRequired = 'close'
await assert.rejects(retained.daemon.send('open', {}, 1000), PowerPointPreOpenRecoveryError)
assert.deepEqual(retained.calls, ['close', 'close', 'close'])
retained.daemon.clearCloseCleanupRetryTimer()

const uncertain = fixture(() => assert.fail('fatal session must not send a request'))
uncertain.daemon.sessionUncertain = true
uncertain.daemon.cleanupRecoveryRequired = 'close'
await assert.rejects(uncertain.daemon.send('open'), /uncertain/)
assert.deepEqual(uncertain.calls, [])

const timedOut = fixture(() => assert.fail('timed-out ownership mutation must remain protected'))
timedOut.daemon.timedOutStatefulRequests.set(99, { cmd: 'open', args: {} })
await assert.rejects(timedOut.daemon.send('open'), /timed out/)
assert.deepEqual(timedOut.calls, [])

const commitFailure = fixture(() => assert.fail('CLOSE must not destroy a valid new target to recover old cleanup'))
commitFailure.daemon.cleanupRecoveryRequired = 'commit-open'
await assert.rejects(commitFailure.daemon.send('open'), /cleanup is incomplete/)
assert.deepEqual(commitFailure.calls, [])

const warm = fixture((request, reply) => reply({ id: request.id, ok: true }))
await warm.daemon.send('open')
assert.deepEqual(warm.calls, ['open'], 'normal TAKE must not add a CLOSE')

// Load the real Zustand store against isolated storage, not the UI fixture.
const themeBuild = await build({ entryPoints: ['src/renderer/src/stores/useAppStore.ts'],
  bundle: true, write: false, platform: 'node', format: 'cjs' })
for (const [saved, expected] of [[null, 'broadcast-pro'], ['classic', 'classic'], ['broadcast-pro', 'broadcast-pro'], ['bad-value', 'broadcast-pro']]) {
  const values = new Map(saved === null ? [] : [['pdm-operator-theme', saved]])
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
  const themeModule = { exports: {} }
  new Function('require', 'module', 'exports', 'localStorage', 'window', themeBuild.outputFiles[0].text)(
    createRequire(import.meta.url), themeModule, themeModule.exports, storage, { localStorage: storage, api: { dbgLog() {} } })
  assert.equal(themeModule.exports.useAppStore.getState().appTheme, expected)
}

const [main, ipc, store, native] = await Promise.all([
  readFile('src/main/index.ts', 'utf8'), readFile('src/main/ipc-handlers.ts', 'utf8'),
  readFile('src/renderer/src/stores/useAppStore.ts', 'utf8'), readFile('scripts/powerpoint-daemon.ps1', 'utf8')
])
assert.match(main, /registerIpcHandlers\(controlWindow, \(\) => presentationWindow, \(\) => \{[\s\S]*?overlaySafetyLocked = false/)
assert.match(main, /'hide-overlay', async \(\) => \{\s*if \(overlaySafetyLocked\)/)
assert.match(ipc, /onPowerPointOutputCommitted\(\)\s*return \{ success: true, output \}/)
assert.match(ipc, /error instanceof PowerPointPreOpenRecoveryError && res\.id === 0/)
assert.match(store, /appTheme: readStoredAppTheme\(\) \?\? 'broadcast-pro'/)
assert.match(store, /value === 'classic' \|\| value === 'broadcast-pro' \? value : null/)
assert.match(native, /PromoteWarmedOutput\([\s\S]*?EndDeferWindowPos\(batch\)/)
assert.doesNotMatch(native, /lowered persistent output.*before slideshow promotion/)
console.log('PASS: queued CLOSE failure/recovery, terminal ACK barrier, bounded retries, atomic transaction, fatal/timeout guards, safety cover proof and theme default')

if (process.platform === 'win32') {
  for (const script of ['scripts/_test-powerpoint-output-native.ps1', 'scripts/_test-powerpoint-linked-pictures.ps1']) {
    const nativeTest = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { stdio: 'inherit', windowsHide: true })
    assert.equal(nativeTest.status, 0, `${script} failed`)
  }
}
