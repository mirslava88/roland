import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = async (path) => readFile(path, 'utf8')
const [windows, rendererSecurity, ipcHandlers, main, outputPreload, timerPreload, store, appConfig, secrets, diagnostics, workflow] = await Promise.all([
  source('src/main/windows.ts'),
  source('src/main/renderer-security.ts'),
  source('src/main/ipc-handlers.ts'),
  source('src/main/index.ts'),
  source('src/preload/output.ts'),
  source('src/preload/timer.ts'),
  source('src/renderer/src/stores/useAppStore.ts'),
  source('src/renderer/src/app-config.ts'),
  source('src/main/secure-secrets.ts'),
  source('src/main/diagnostic-log.ts'),
  source('.github/workflows/build-windows.yml')
])

assert.doesNotMatch(windows, /webSecurity:\s*false/)
assert.equal((windows.match(/preload: join\(__dirname, '\.\.\/preload\/index\.js'\)/g) || []).length, 1)
assert.equal((windows.match(/preload: join\(__dirname, '\.\.\/preload\/output\.js'\)/g) || []).length, 2)
assert.equal((windows.match(/preload: join\(__dirname, '\.\.\/preload\/timer\.js'\)/g) || []).length, 1)
assert.match(rendererSecurity, /if \(app\.isPackaged\) return null/)
assert.match(rendererSecurity, /LOOPBACK_HOSTS/)
assert.doesNotMatch(main, /url\.startsWith\(['"]file:\/\//)
assert.match(main, /contents\.on\('will-navigate', \(event\) => event\.preventDefault\(\)\)/)

// Every general-purpose filesystem/Office handler is registered through the
// trusted-control wrapper. The single raw registration is the wrapper itself.
assert.equal((ipcHandlers.match(/ipcMain\.handle\(/g) || []).length, 1)
assert.match(ipcHandlers, /isTrustedWindowMainFrame\(event, controlWindow, 'index\.html'\)/)
assert.match(ipcHandlers, /handleControl\('read-file'/)
assert.match(ipcHandlers, /info\.size > 1024 \* 1024 \* 1024/)
assert.match(ipcHandlers, /handleControl\('delete-items'/)
assert.match(ipcHandlers, /paths\.length > 500/)

for (const forbidden of ['read-file', 'delete-items', 'open-file-external', 'launch-powerpoint', 'direct-stream-deck']) {
  assert.doesNotMatch(outputPreload, new RegExp(forbidden))
  assert.doesNotMatch(timerPreload, new RegExp(forbidden))
}
assert.match(outputPreload, /INBOUND_CHANNELS/)
assert.match(outputPreload, /OUTBOUND_CHANNELS/)
assert.match(outputPreload, /ipcRenderer\.invoke\('read-output-file', filePath\)/)
for (const channel of [
  'navigate-slide', 'navigate-pdf', 'play-pause', 'seek', 'set-volume', 'set-loop',
  'capture-source-state-request', 'capture-source-register', 'capture-source-unregister',
  'capture-devices-request', 'program-scene-audio-retry', 'program-scene-audio-update',
  'program-scene-audio-status-request'
]) {
  assert.match(outputPreload, new RegExp(`'${channel}'`), `output preload must receive ${channel}`)
}
for (const channel of [
  'slide-info', 'request-close-presentation', 'video-state', 'video-time', 'video-ended',
  'capture-source-state', 'capture-preview-frame', 'capture-devices-response',
  'capture-devices-changed', 'capture-hub-ready', 'program-scene-audio-status',
  'program-scene-audio-ready'
]) {
  assert.match(outputPreload, new RegExp(`'${channel}'`), `output preload must send ${channel}`)
  assert.match(main, new RegExp(`'${channel}'`), `main process must accept ${channel} from Presentation Output`)
}
for (const method of [
  'readFile', 'getWindowDisplayScaleFactor', 'renderPdfPage',
  'getScreenCaptureSource', 'prepareDesktopCaptureSource',
  'releaseBrowserFullscreen', 'releaseProgramMirrorHold',
  'sendToControl', 'signalReady', 'dbgLog', 'on'
]) {
  assert.match(outputPreload, new RegExp(`\\b${method}:`), `output preload must expose ${method}`)
}
assert.match(main, /allowed\?\.has\(normalizedOutputPath\(filePath\)\)/)
assert.match(main, /authorizeOutputFilePaths\(presentationWindow\.webContents\.id, args\)/)
assert.match(timerPreload, /move-timer-overlay/)
assert.match(timerPreload, /resize-timer-overlay/)

assert.match(secrets, /safeStorage\.encryptString/)
assert.match(secrets, /safeStorage\.decryptString/)
assert.match(store, /qrOverlay: \{ \.\.\.state\.qrOverlay, enabled: false, wifiPassword: '' \}/)
assert.match(appConfig, /qrOverlay: \{ \.\.\.state\.qrOverlay, enabled: false, wifiPassword: '' \}/)
assert.match(diagnostics, /redactDiagnosticText\(message\)/)
assert.match(diagnostics, /REDACTED_STREAM_URL/)
assert.match(diagnostics, /%USERPROFILE%/)

assert.match(workflow, /permissions:\s*\r?\n\s+contents: read/)
assert.match(workflow, /publish-release:[\s\S]*permissions:\s*\r?\n\s+contents: write/)
assert.doesNotMatch(workflow, /uses:\s+[^\s@]+@v\d+/)
assert.match(workflow, /actions\/checkout@[0-9a-f]{40}/)
assert.match(workflow, /actions\/setup-node@[0-9a-f]{40}/)
assert.equal((workflow.match(/persist-credentials: false/g) || []).length, 2)

console.log('PASS: Electron isolation, IPC authorization, encrypted QR secret and CI least privilege checks')
