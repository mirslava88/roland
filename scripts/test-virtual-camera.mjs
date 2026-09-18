import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const nativeDir = resolve(root, 'native', 'virtual-camera', 'bin', 'x64', 'Release')
const host = resolve(nativeDir, 'PDMVirtualCameraHost.exe')
const source = resolve(nativeDir, 'PDMVirtualCameraSource.dll')
if (process.platform === 'win32' && (!existsSync(host) || !existsSync(source))) {
  const built = spawnSync(process.execPath, [resolve(root, 'scripts', 'build-native-virtual-camera.mjs')], { cwd: root, stdio: 'inherit', windowsHide: true })
  if (built.error) throw built.error
  assert.equal(built.status, 0, 'native virtual-camera build must pass')
}
assert.ok(existsSync(host), 'native virtual-camera host must be built')
assert.ok(existsSync(source), 'native virtual-camera media source must be built')

const selfTest = JSON.parse(execFileSync(host, ['--self-test'], { encoding: 'utf8', windowsHide: true }))
assert.deepEqual(selfTest, { ok: true, width: 1920, height: 1080, fps: 30 })
const sourceTest = JSON.parse(execFileSync(host, ['--test-source', source], { encoding: 'utf8', windowsHide: true }))
assert.deepEqual(sourceTest, { ok: true, streams: 1, hresult: 0 })

const frameSource = readFileSync(resolve(root, 'src', 'main', 'virtual-camera-frame.ts'), 'utf8')
assert.match(frameSource, /Math\.min\(targetWidth \/ sourceWidth, targetHeight \/ sourceHeight\)/, 'fit must preserve aspect ratio')
assert.match(frameSource, /quality: 'best'/, 'internal frames must use best-quality resize')
assert.match(frameSource, /opaqueBlackFrame/, 'letterbox and pillarbox areas must be opaque black')

const nativeSource = readFileSync(resolve(root, 'native', 'virtual-camera', 'source', 'SimpleFrameGenerator.cpp'), 'utf8')
assert.match(nativeSource, /kStaleAfterMs/, 'stale frames must become black')
assert.match(nativeSource, /sequenceBefore == sequenceAfter/, 'shared frames must be copied without tearing')
assert.match(nativeSource, /m_hasLastFrame/, 'shared-frame contention must hold the last complete frame instead of flashing black')
assert.match(nativeSource, /SwitchToThread\(\)/, 'shared-frame contention retries must yield instead of busy-spinning')
assert.match(nativeSource, /std::ptrdiff_t\>\(pitch\)/, 'negative Media Foundation stride must use signed row addressing')
assert.ok(!/ZeroMemory\(pBuf,/.test(nativeSource), 'negative stride must never zero memory as one forward block')

const nativeHost = readFileSync(resolve(root, 'native', 'virtual-camera', 'host', 'host.cpp'), 'utf8')
assert.match(nativeHost, /;;;LS\)/, 'installed source ACL must grant LocalService read and execute access')
assert.match(nativeHost, /PROTECTED_DACL_SECURITY_INFORMATION/, 'installed source ACL must not inherit a restrictive staging DACL')
assert.match(nativeHost, /camera\.Reset\(\);\s*MFShutdown\(\)/, 'virtual camera COM object must be released before Media Foundation shutdown')
assert.match(nativeHost, /std::thread\(\[&, x, y, width, height\]/, 'display coordinates must be copied into the long-lived capture thread')
assert.match(nativeHost, /DuplicateOutput\(/, 'physical program display capture must use Desktop Duplication')
assert.ok(!/GetDC\(nullptr\)|CAPTUREBLT/.test(nativeHost), 'display capture must not use cursor-flickering desktop GDI reads')
assert.ok(!/CopyFrameHorizontallyMirrored/.test(nativeHost), 'virtual-camera output must stay unmirrored because conferencing apps mirror only their local preview')
assert.match(nativeHost, /Camera applications commonly mirror only their local preview/, 'remote-participant orientation contract must be documented')
assert.match(nativeHost, /CopyMemory\(\s*pdm::virtual_camera::BufferAt\(header, next\),\s*frame, pdm::virtual_camera::kFrameBytes\);\s*MemoryBarrier\(\);\s*InterlockedIncrement\(&header->sequence\)/s, 'inactive frame buffer must be filled before the short shared-memory commit')
assert.ok(!existsSync(resolve(root, 'native', 'virtual-camera', 'host', 'audio_bridge.cpp')), 'virtual-camera audio bridge must stay removed')
assert.ok(!/--audio-process|audioBridge|VB-CABLE/i.test(nativeHost), 'virtual-camera host must remain video-only')

const managerSource = readFileSync(resolve(root, 'src', 'main', 'virtual-camera.ts'), 'utf8')
assert.ok(!/VB-CABLE|audioCable|audioServicePid|--audio-process/i.test(managerSource), 'virtual-camera manager must remain video-only')
assert.match(managerSource, /доступна только в Windows 11 и более новых версиях Windows/, 'unsupported Windows versions must receive a clear activation error')

const settingsSource = readFileSync(resolve(root, 'src', 'renderer', 'src', 'components', 'Controls', 'VirtualCameraSettings.tsx'), 'utf8')
assert.match(settingsSource, /!status\.supported[\s\S]*доступна только в Windows 11/, 'Windows 10 activation must show the compatibility warning before preparing output')
assert.match(settingsSource, /status\?\.supported !== false/, 'activation button must remain clickable on unsupported Windows so the warning can be shown')

const storeSource = readFileSync(resolve(root, 'src', 'renderer', 'src', 'stores', 'useAppStore.ts'), 'utf8')
assert.match(storeSource, /consumers\.stream \|\| consumers\.virtualCamera/, 'stream and virtual camera must share the internal output safely')

const capturePickerSource = readFileSync(resolve(root, 'src', 'renderer', 'src', 'components', 'Capture', 'CaptureSourcesPanel.tsx'), 'utf8')
assert.match(capturePickerSource, /response\.devices\.filter\(\(device\) => !isPdmVirtualCamera\(device\)\)/, 'PDM virtual camera output must not be selectable as its own input')
assert.match(capturePickerSource, /output -> camera -> output recursion/, 'self-capture prevention must document the feedback-loop failure mode')

const registered = spawnSync(host, ['--source-registered'], { encoding: 'utf8', windowsHide: true })
let liveEnumerationPassed = false
if (registered.status === 0) {
  const child = spawn(host, ['--internal'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let output = ''
  let earlyExitCode = null
  const running = await new Promise((resolveRunning, reject) => {
    const timer = setTimeout(() => reject(new Error('virtual-camera host did not start')), 15_000)
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8')
      if (output.includes('"phase":"running"')) { clearTimeout(timer); resolveRunning(true) }
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      earlyExitCode = code
      if (code === 24) resolveRunning(false)
      else reject(new Error(`virtual-camera host exited early: ${code}`))
    })
  })
  if (running) {
    const ffmpeg = resolve(root, 'node_modules', 'ffmpeg-static', 'ffmpeg.exe')
    if (existsSync(ffmpeg)) {
      let devices = ''
      for (let attempt = 0; attempt < 10 && !/PDM Virtual Camera/i.test(devices); attempt++) {
        const listed = spawnSync(ffmpeg, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 })
        devices = `${listed.stdout || ''}\n${listed.stderr || ''}`
        if (!/PDM Virtual Camera/i.test(devices)) await new Promise((resolveDelay) => setTimeout(resolveDelay, 300))
      }
      assert.match(devices, /PDM Virtual Camera/i, 'Windows must enumerate the running PDM virtual camera')
      liveEnumerationPassed = true
    }
    child.stdin.end()
    await new Promise((resolveExit) => {
      const timer = setTimeout(() => { child.kill(); resolveExit() }, 5000)
      child.once('exit', () => { clearTimeout(timer); resolveExit() })
    })
  } else {
    assert.equal(earlyExitCode, 24, 'only an in-use Windows camera session may skip live enumeration')
    console.log('SKIP: live Windows enumeration (virtual camera is currently in use)')
  }
}

console.log(`PASS: PDM virtual camera native source, aspect ratio and shared-output lifecycle${liveEnumerationPassed ? ', including Windows enumeration' : ''}`)
