const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { transformSync } = require('esbuild')
const moduleObject = { exports: {} }
vm.runInNewContext(transformSync(fs.readFileSync('src/main/mac-keynote-launcher.ts', 'utf8'), { loader: 'ts', format: 'cjs' }).code,
  { module: moduleObject, exports: moduleObject.exports, Set, Promise, Error })
const { MacKeynoteLauncher } = moduleObject.exports
function fixture() {
  let processes = [10], launches = 0
  const runtime = { processes: async () => [...processes], delay: async () => {}, attempts: 2,
    launch: async () => { launches++ } }
  return { runtime, launcher: new MacKeynoteLauncher(runtime),
    visible: value => { processes = value }, get launches() { return launches } }
}
;(async () => {
  const missing = fixture()
  for (let i = 0; i < 8; i++) await assert.rejects(missing.launcher.spawn(), /Keynote/)
  assert.equal(missing.launches, 1, 'failed TAKE retries must not accumulate Dock processes')
  missing.visible([10, 11])
  assert.equal(await missing.launcher.spawn(), 11, 'a late process must be recovered')
  assert.equal(missing.launches, 1)

  const borrowed = fixture()
  await assert.rejects(borrowed.launcher.spawn(), /Keynote/)
  borrowed.visible([10, 11])
  borrowed.runtime.launch = async () => { borrowed.visible([10, 11, 12]) }
  assert.equal(await borrowed.launcher.spawn([10, 11]), 12, 'an adopted late engine cannot also become its own standby')

  const concurrent = fixture()
  let pid = 10
  concurrent.runtime.launch = async () => { concurrent.visible([10, ++pid]) }
  const pids = await Promise.all([concurrent.launcher.spawn(), concurrent.launcher.spawn()])
  assert.deepEqual(pids, [11, 12], 'independent concurrent launches need distinct PIDs')

  const definite = fixture()
  let attempts = 0
  definite.runtime.launch = async () => { attempts++; throw Object.assign(Error('not installed'), { code: 1 }) }
  await assert.rejects(definite.launcher.spawn(), /not installed/)
  definite.runtime.launch = async () => { attempts++; definite.visible([10, 11]) }
  assert.equal(await definite.launcher.spawn(), 11, 'a definite launch failure must be retryable after installation')
  assert.equal(attempts, 2)

  const timedOut = fixture()
  let uncertain = 0
  timedOut.runtime.launch = async () => { uncertain++; throw Object.assign(Error('open timed out'), { code: 1, killed: true, signal: 'SIGTERM' }) }
  await assert.rejects(timedOut.launcher.spawn(), /timed out/)
  await assert.rejects(timedOut.launcher.spawn(), /Keynote/)
  assert.equal(uncertain, 1, 'uncertain open timeout must not issue another open -n')
  timedOut.visible([10, 11])
  assert.equal(await timedOut.launcher.spawn(), 11)
  console.log('PASS: timed-out TAKE retries launch once, late workers recover, adopted and concurrent workers remain distinct, definite failures are retryable')
})().catch(error => { console.error(error); process.exitCode = 1 })
