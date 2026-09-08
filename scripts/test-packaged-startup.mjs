// Run on a disposable Windows CI runner, never over an operator's live session.
// Only loopback DevTools is opened; this test never starts a broadcast.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true') {
  throw new Error('Run this startup smoke test only on an isolated Windows GitHub Actions runner.')
}
const require = createRequire(import.meta.url)
const { editionInfo } = require('../build/editions.cjs')
const info = editionInfo(process.argv[2])
const probe = createServer().listen(0, '127.0.0.1')
await once(probe, 'listening')
const port = probe.address().port
await new Promise((done) => probe.close(done))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
const child = spawn(resolve(`dist/${info.edition}/win-unpacked/${info.productName}.exe`),
  [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'],
  { env, windowsHide: true, stdio: 'ignore' })
const exited = once(child, 'exit')
let socket
let sequence = 0
const pending = new Map()
const exceptions = []
async function until(predicate, label, timeout = 25000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`App exited early: ${child.exitCode}`)
    const result = await predicate()
    if (result) return result
    await delay(200)
  }
  throw new Error(`Timed out: ${label}`)
}
function call(method, params = {}) {
  const id = ++sequence
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 10000)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const value = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (value.exceptionDetails) throw new Error(value.exceptionDetails.text)
  return value.result.value
}
try {
  const page = await until(async () => {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) })).json()
      return pages.find((page) => page.type === 'page' && page.url.endsWith('/index.html'))
    } catch { return false }
  }, 'control renderer')
  socket = new WebSocket(page.webSocketDebuggerUrl)
  await once(socket, 'open')
  socket.addEventListener('message', (event) => {
    const value = JSON.parse(event.data)
    if (value.method === 'Runtime.exceptionThrown') exceptions.push(value.params.exceptionDetails.text)
    const request = pending.get(value.id)
    if (!request) return
    clearTimeout(request.timer)
    pending.delete(value.id)
    if (value.error) request.reject(new Error(value.error.message))
    else request.resolve(value.result)
  })
  await call('Runtime.enable')
  await until(() => evaluate('!!window.api && !!document.querySelector(\'[title="Настройки"]\')'), 'toolbar ready')
  assert.equal(await evaluate('window.api.getAppVersion()'), info.displayVersion)
  assert.equal(await evaluate('!!window.api.streaming'), info.stream)
  if (info.stream) assert.equal(await evaluate('(async () => (await window.api.streaming.status()).phase)()'), 'idle')
  await evaluate('document.querySelector(\'[title="Настройки"]\').click()')
  await until(() => evaluate(`document.body.innerText.includes(${JSON.stringify(`Версия ${info.displayVersion}`)})`), 'settings version visible')
  assert.deepEqual(exceptions, [], 'no renderer exceptions during startup/settings')
  console.log(`PASS: packaged ${info.displayVersion} starts; settings version visible; stream API ${info.stream ? 'present and idle' : 'absent'}`)
  await call('Browser.close').catch(() => {})
  await Promise.race([exited, delay(15000)])
} finally {
  socket?.close()
  for (const request of pending.values()) clearTimeout(request.timer)
  // CI-only fallback: kill exactly the test process tree, never arbitrary Electron/Office processes.
  if (child.exitCode === null && child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
}
