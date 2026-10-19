import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { acquireWorkspaceLock, copyMacTree, requireCleanAudit, workspacePackage } from './build-macos.mjs'

const require = createRequire(import.meta.url)
const readJson = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
const project = readJson('../package.json')
const mac = readJson('../build/macos/package.json')
const lock = readJson('../build/macos/package-lock.json')
const before = JSON.stringify(project)
const isolated = workspacePackage(project, mac)
assert.equal(JSON.stringify(project), before, 'Mac workspace mutated the project manifest')
assert.equal(isolated.build, project.build, 'Mac workspace lost project metadata/resources')
assert.equal(isolated.devDependencies.electron, readJson('../build/mac-runtime.json').electronVersion)
assert.notEqual(isolated.devDependencies, project.devDependencies)
for (const group of ['dependencies', 'devDependencies']) {
  assert.deepEqual(lock.packages[''][group], mac[group], 'Mac lockfile is out of sync')
  for (const [name, version] of Object.entries(mac[group])) {
    assert.equal(lock.packages[`node_modules/${name}`].version, version)
    assert.ok(require('semver').satisfies(version, project[group][name]), `${name} no longer satisfies the project requirement`)
  }
}
assert.throws(() => workspacePackage({ ...project, dependencies: { ...project.dependencies, 'new-runtime': '1' } }, mac), /Update build\/macos/)
assert.equal(Object.keys(lock.packages).some(p => /node_modules\/(sprintf-js|roarr)$/.test(p)), false, 'Vulnerable formatting chain returned')
assert.equal(lock.packages['node_modules/global-agent'].version, '4.1.3')
assert.equal(typeof require('global-agent').bootstrap, 'function', 'Electron downloader proxy API changed')
assert.throws(() => requireCleanAudit({ status: 1, stdout: JSON.stringify({ metadata: { vulnerabilities: { total: 1 } } }) }), /audit failed/)
assert.throws(() => requireCleanAudit({ status: 1, stdout: JSON.stringify({ error: { code: 'ENOAUDIT' } }) }), /audit failed/)
assert.throws(() => requireCleanAudit({ status: 0, stdout: '{}' }), /audit failed/)
assert.throws(() => requireCleanAudit({ status: 0, stdout: 'not JSON' }), /valid JSON/)
assert.equal(requireCleanAudit({ status: 0, stdout: JSON.stringify({ metadata: { vulnerabilities: { total: 0 } } }) }).metadata.vulnerabilities.total, 0)
const lockTest = mkdtempSync(join(tmpdir(), 'pdm-mac-build-lock-'))
try {
  const release = acquireWorkspaceLock(join(lockTest, 'workspace.lock'))
  assert.throws(() => acquireWorkspaceLock(join(lockTest, 'workspace.lock')), /Another Mac build/)
  release()
  acquireWorkspaceLock(join(lockTest, 'workspace.lock'))()
  const source = join(lockTest, 'source.framework'), target = join(lockTest, 'copied.framework')
  mkdirSync(join(source, 'Versions/A/Resources'), { recursive: true })
  writeFileSync(join(source, 'Versions/A/Resources/icu.dat'), 'test resource')
  symlinkSync('A', join(source, 'Versions/Current'))
  symlinkSync('Versions/Current/Resources', join(source, 'Resources'))
  copyMacTree(source, target)
  rmSync(source, { recursive: true })
  assert.equal(readlinkSync(join(target, 'Resources')), 'Versions/Current/Resources')
  assert.equal(readFileSync(join(target, 'Resources/icu.dat'), 'utf8'), 'test resource', 'Copied bundle still depends on its build workspace')
} finally { rmSync(lockTest, { recursive: true, force: true }) }

// global-agent changes major version. Exercise the exact downloader used by
// electron-builder against a local proxy, rather than only checking exports.
let requests = 0
const server = createServer((request, response) => {
  assert.equal(request.url, 'http://pdm-proxy-test.invalid/artifact')
  requests++
  response.end('verified proxy response')
})
await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok) })
try {
  const proxy = `http://127.0.0.1:${server.address().port}`
  await new Promise((ok, fail) => {
    const child = spawn(process.execPath, ['-e', `
      const {createRequire}=require('node:module');
      const downloader=createRequire(require.resolve('app-builder-lib/package.json'))('@electron/get');
      downloader.initializeProxy();
      require('node:http').get('http://pdm-proxy-test.invalid/artifact',res=>{
        let data='';res.on('data',part=>data+=part);res.on('end',()=>{
          if(res.statusCode!==200||data!=='verified proxy response')process.exitCode=1;
        });
      }).on('error',()=>{process.exitCode=1});
    `], { cwd: new URL('..', import.meta.url), env: { ...process.env, HTTP_PROXY: proxy, GLOBAL_AGENT_HTTP_PROXY: proxy, NO_PROXY: '', GLOBAL_AGENT_NO_PROXY: '' }, stdio: 'pipe' })
    const timer = setTimeout(() => { child.kill(); fail(Error('Mac downloader proxy test timed out')) }, 10_000)
    child.once('error', error => { clearTimeout(timer); fail(error) })
    child.once('exit', code => { clearTimeout(timer); code === 0 ? ok() : fail(Error('Mac downloader proxy failed')) })
  })
  assert.equal(requests, 1)
} finally {
  server.closeAllConnections()
  await new Promise(ok => server.close(ok))
}
console.log('PASS: Mac dependency isolation, portable framework links, build lock, downloader proxy, fail-closed audit gate')
