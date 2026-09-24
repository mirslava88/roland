import assert from 'node:assert/strict'

const targets = await (await fetch('http://127.0.0.1:9222/json')).json()
const target = targets.find(value => /^http:\/\/localhost:\d+\/$/.test(value.url))
assert.ok(target, 'The operator window must exist, not just Presentation Output')
const socket = new WebSocket(target.webSocketDebuggerUrl)
const requests = new Map()
let sequence = 0
socket.addEventListener('message', event => {
  const result = JSON.parse(event.data)
  const pending = requests.get(result.id)
  if (!pending) return
  requests.delete(result.id)
  clearTimeout(pending.timer)
  if (result.error) pending.reject(new Error(result.error.message))
  else pending.resolve(result.result)
})
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
function send(method, params = {}) {
  const id = ++sequence
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { requests.delete(id); reject(new Error(`Timeout: ${method}`)) }, 15000)
    requests.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  assert.ok(!response.exceptionDetails, response.exceptionDetails?.text)
  return response.result.value
}
try {
  if (process.argv.includes('--cleanup-test-output')) {
    await evaluate(`(async () => {
      await window.api.virtualCamera.stop()
      window.dispatchEvent(new CustomEvent('close-program-output'))
      return true
    })()`)
  }
  await send('Page.bringToFront')
  const status = await evaluate(`(async () => {
    const {useAppStore} = await import('/src/stores/useAppStore.ts')
    const state = useAppStore.getState()
    return {
      buttons: document.querySelectorAll('button').length,
      toolbarItems: document.querySelectorAll('[data-toolbar-item]').length,
      programDisplayAssigned: state.displays.some(display => !display.isPrimary && state.displayAssignments[String(display.id)] === 'program'),
      cameraPhase: (await window.api.virtualCamera.status()).phase,
      sceneSnapshot: Boolean(state.programSnapshot),
      deckConnected: (await window.api.getDirectStreamDeckStatus())?.connected ?? false
    }
  })()`)
  assert.ok(status.buttons > 10 && status.toolbarItems > 5, 'Operator controls must be rendered')
  console.log('PASS operator runtime:', status)
} finally {
  socket.close()
}
