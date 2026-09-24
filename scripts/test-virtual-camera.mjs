import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

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

// A previously loaded DLL cannot be overwritten on Windows. Registration
// must stage immutable content-addressed copies instead of reusing that path.
const stagingDirectory = mkdtempSync(join(tmpdir(), 'pdm-virtual-camera-stage-'))
try {
  const input = join(stagingDirectory, 'new-source.dll')
  const legacy = join(stagingDirectory, 'PDMVirtualCameraSource.dll')
  writeFileSync(legacy, 'loaded legacy source must remain untouched')
  writeFileSync(input, 'new source version A')
  const stage = () => JSON.parse(execFileSync(host,
    ['--test-stage-source', input, stagingDirectory], { encoding: 'utf8', windowsHide: true }))
  const first = stage()
  assert.equal(first.ok, true)
  assert.match(first.path, /PDMVirtualCameraSource-[a-f0-9]{64}\.dll$/)
  assert.equal(readFileSync(legacy, 'utf8'), 'loaded legacy source must remain untouched')
  assert.equal(readFileSync(first.path, 'utf8'), 'new source version A')
  assert.equal(stage().path, first.path, 'reinstalling identical source must reuse its immutable copy')
  writeFileSync(input, 'new source version B')
  const second = stage()
  assert.notEqual(second.path, first.path, 'a source update must not overwrite a loaded old DLL')
  assert.equal(readFileSync(first.path, 'utf8'), 'new source version A')
  assert.equal(readFileSync(second.path, 'utf8'), 'new source version B')
} finally {
  rmSync(stagingDirectory, { recursive: true, force: true })
}

const installerScript = readFileSync(resolve(root, 'build', 'virtual-camera-installer.nsh'), 'utf8')
assert.match(installerScript, /--install-source[\s\S]*?Abort "PDM Virtual Camera registration failed/, 'installer must not silently continue after registration failure')
assert.match(installerScript, /--source-registered[\s\S]*?Abort "PDM Virtual Camera registration verification failed/, 'installer must verify registration before finishing')
assert.match(installerScript, /--install-source[^\n]*"\$\{APP_ID\}"/, 'installer must record which edition owns the shared camera source')
assert.match(installerScript, /--uninstall-source[^\n]*"\$\{APP_ID\}"/, 'uninstalling one edition must identify its ownership')

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
assert.match(nativeHost, /RemoveOwner\(owner, remaining\)[\s\S]*?if \(remaining > 0\) return ERROR_SUCCESS/, 'uninstalling one edition must preserve the shared registration for the other edition')
assert.match(nativeHost, /;;;LS\)/, 'installed source ACL must grant LocalService read and execute access')
assert.match(nativeHost, /PROTECTED_DACL_SECURITY_INFORMATION/, 'installed source ACL must not inherit a restrictive staging DACL')
assert.match(nativeHost, /camera\.Reset\(\);\s*MFShutdown\(\)/, 'virtual camera COM object must be released before Media Foundation shutdown')
assert.match(nativeHost, /kPipeControlMagic\[\] = "PDMVCR01"/, 'the native host must accept an in-session source switch command')
assert.match(nativeHost, /DuplicateOutput\(/, 'physical program display capture must use Desktop Duplication')
assert.ok(!/GetDC\(nullptr\)|CAPTUREBLT/.test(nativeHost), 'display capture must not use cursor-flickering desktop GDI reads')
assert.match(nativeHost, /internalFramesActive[\s\S]*?ReadExact\(input, frame\.data\(\), pdm::virtual_camera::kFrameBytes\)[\s\S]*?internalFramesActive\.store\(true\)/, 'a physical capture host must switch to internal frames without restarting the virtual camera device')
assert.match(nativeHost, /kPipeCommandUseDisplay[\s\S]*?InitializeDuplication\(nextX, nextY, nextWidth, nextHeight\)[\s\S]*?internalFramesActive\.store\(false\)/, 'the same native host must return to a reconnected physical display without restarting the camera device')
assert.match(nativeHost, /std::lock_guard<std::mutex> lock\(writerMutex\)/, 'physical and fallback frame writers must never race in shared memory')
assert.ok(!/CopyFrameHorizontallyMirrored/.test(nativeHost), 'virtual-camera output must stay unmirrored because conferencing apps mirror only their local preview')
assert.match(nativeHost, /Camera applications commonly mirror only their local preview/, 'remote-participant orientation contract must be documented')
assert.match(nativeHost, /CopyMemory\(\s*pdm::virtual_camera::BufferAt\(header, next\),\s*frame, pdm::virtual_camera::kFrameBytes\);\s*MemoryBarrier\(\);\s*InterlockedIncrement\(&header->sequence\)/s, 'inactive frame buffer must be filled before the short shared-memory commit')
assert.ok(!existsSync(resolve(root, 'native', 'virtual-camera', 'host', 'audio_bridge.cpp')), 'virtual-camera audio bridge must stay removed')
assert.ok(!/--audio-process|audioBridge|VB-CABLE/i.test(nativeHost), 'virtual-camera host must remain video-only')

const managerSource = readFileSync(resolve(root, 'src', 'main', 'virtual-camera.ts'), 'utf8')
assert.ok(!/VB-CABLE|audioCable|audioServicePid|--audio-process/i.test(managerSource), 'virtual-camera manager must remain video-only')
assert.match(managerSource, /доступна только в Windows 11 и более новых версиях Windows/, 'unsupported Windows versions must receive a clear activation error')
assert.match(managerSource, /display\.id === this\.displaySourceId[\s\S]*?this\.switchToInternalCapture\(display\.id\)/, 'disconnecting the captured display must switch the running virtual camera instead of stopping it')
assert.match(managerSource, /switchToInternalCapture[\s\S]*?source: 'internal'[\s\S]*?fallbackAwaitingProgramFrame = true/, 'virtual-camera fallback must keep the same native host while awaiting a painted internal Program frame')
assert.match(managerSource, /notifyProgramOutputReady[\s\S]*?startInternalCapture\(child\)/, 'virtual-camera fallback must begin internal capture only after the renderer confirms a painted frame')
assert.match(managerSource, /usePhysicalProgramDisplay[\s\S]*?PIPE_COMMAND_USE_DISPLAY[\s\S]*?child\.stdin\.write\(packet\)/, 'a reconnected Program display must request an in-session switch back to physical capture')
assert.match(managerSource, /generation !== this\.internalCaptureGeneration[\s\S]*?!this\.internalProgram[\s\S]*?return/, 'a late internal capture must not override the restored physical source')
assert.match(managerSource, /clearInterval\(this\.frameTimer\)[\s\S]*?this\.internalCaptureGeneration \+= 1[\s\S]*?PIPE_CONTROL_MAGIC/, 'the physical switch must invalidate in-flight internal captures before writing its command')
assert.match(managerSource, /physical source restored[\s\S]*?without camera restart/, 'the display restore must be diagnosable without recreating the virtual camera')
assert.match(managerSource, /fallbackCaptureTimer = setTimeout[\s\S]*?startInternalCapture\(child\)[\s\S]*?4_000/, 'capture/video fallback must have a bounded readiness timeout')
assert.match(managerSource, /publishStatus[\s\S]*?virtual-camera-status-changed/, 'virtual-camera route changes must be pushed to the always-mounted operator renderer')
assert.doesNotMatch(managerSource, /Эфирный экран отключён[^\n]*Виртуальная камера остановлена/, 'display disconnect must not deliberately stop the virtual camera')

const settingsSource = readFileSync(resolve(root, 'src', 'renderer', 'src', 'components', 'Controls', 'VirtualCameraSettings.tsx'), 'utf8')
assert.match(settingsSource, /!status\.supported[\s\S]*доступна только в Windows 11/, 'Windows 10 activation must show the compatibility warning before preparing output')
assert.match(settingsSource, /status\?\.supported !== false/, 'activation button must remain clickable on unsupported Windows so the warning can be shown')
assert.match(settingsSource, /value\.source === 'internal'/, 'the renderer must retain the virtual-camera internal Program consumer after physical fallback')

const storeSource = readFileSync(resolve(root, 'src', 'renderer', 'src', 'stores', 'useAppStore.ts'), 'utf8')
assert.match(storeSource, /InternalProgramOutputConsumer = 'headless' \| 'stream' \| 'virtualCamera'/, 'headless operation must be an explicit internal Program consumer')
assert.match(storeSource, /headless: presentationId === null/, 'missing physical Program display must automatically enable the hidden Program surface')
assert.match(storeSource, /consumers\.headless \|\| consumers\.stream \|\| consumers\.virtualCamera/, 'headless output, stream and virtual camera must share the internal output safely')

const mainSource = readFileSync(resolve(root, 'src', 'main', 'index.ts'), 'utf8')
assert.match(mainSource, /rendererInternalProgramOutputRequested \|\|/, 'main process must accept a renderer-owned hidden Program surface before stream or camera start')
assert.match(mainSource, /release-internal-program-output/, 'physical Program routing must be able to release the standalone hidden-output request')
assert.match(mainSource, /physicalProgramRouteConnected[\s\S]*?if \(!physicalProgramRouteConnected\) presentationWindow\.setOpacity\(0\)/, 'internal capture preparation must preserve a simultaneously visible physical Program surface')
assert.match(mainSource, /internal program output prepared alongside physical Program[\s\S]*?visibility preserved/, 'simultaneous physical and internal output routing must be diagnosable')
assert.match(mainSource, /physicalProgramRouteConnected[\s\S]*?usePhysicalProgramDisplay\(presentationDisplayId\)/, 'a restored physical Program route must return the running virtual camera to final display capture')
assert.match(mainSource, /presentation-content-ready[\s\S]*?presentation-content-committed[\s\S]*?program-scene-applied[\s\S]*?virtualCameraManager\?\.notifyProgramOutputReady\(\)/, 'painted Program acknowledgements must release the virtual-camera fallback frame gate')

const appSource = readFileSync(resolve(root, 'src', 'renderer', 'src', 'App.tsx'), 'utf8')
assert.match(appSource, /setInternalProgramOutputConsumer\('virtualCamera', active\)/, 'the always-mounted app must own the virtual-camera internal Program consumer')
assert.match(appSource, /virtual-camera-status-changed/, 'virtual-camera route changes must be observed even while Settings is closed')

const timerSource = readFileSync(resolve(root, 'src', 'renderer', 'src', 'components', 'Controls', 'Timer.tsx'), 'utf8')
assert.match(timerSource, /timerUsesProgramOverlay = programDisplayId !== null && timerTargetsProgram/, 'a reconnected physical Program display must retain its timer while virtual camera consumes the internal output')

const programSceneBridgeSource = readFileSync(resolve(root, 'src', 'renderer', 'src', 'components', 'ProgramScene', 'ProgramSceneBridge.tsx'), 'utf8')
assert.match(programSceneBridgeSource, /targetDisplayId !== null && upperMediaLayers\.length > 0/, 'a reconnected physical Program display must retain upper media layers while virtual camera consumes the internal output')
assert.doesNotMatch(programSceneBridgeSource, /targetDisplayId !== null && !internalProgramOutputActive/, 'physical overlays must not be disabled merely because a simultaneous internal consumer exists')
assert.match(
  programSceneBridgeSource,
  /if \(useAppStore\.getState\(\)\.internalProgramOutputActive\) \{[\s\S]*?preserved internal PPTX frame for stream\/virtual camera[\s\S]*?return[\s\S]*?closePresentationWindow\(\)/,
  'reactive Scene layout sync must not clear the first cached PPTX frame while an internal stream or virtual camera consumer is active'
)

const internalBridgeSource = readFileSync(resolve(root, 'src', 'renderer', 'src', 'components', 'ProgramScene', 'InternalProgramOutputBridge.tsx'), 'utf8')
assert.match(internalBridgeSource, /releaseInternalProgramOutput\(\)/, 'hidden Program lifecycle must follow the active output consumers')
assert.match(internalBridgeSource, /waitForNavigationTransitionEnd\(\)[\s\S]*?internal program output sync resumed after transactional TAKE/, 'an internal Program sync skipped during TAKE must resume without waiting for a slide change')
assert.match(internalBridgeSource, /pptx:\$\{physicalProgramDisplayId \?\? 'internal'\}[\s\S]*?physicalProgramDisplayId === null[\s\S]*?resume-active-content/, 'a headless Scene must republish and reveal its cached PPTX frame after HDMI removal')

const previewPanelSource = readFileSync(resolve(root, 'src', 'renderer', 'src', 'components', 'Preview', 'PreviewPanel.tsx'), 'utf8')
assert.match(previewPanelSource, /internalPptxFramePainted[\s\S]*?presentation-content-ready[\s\S]*?internal PPTX frame retained for simultaneous stream\/virtual-camera output/, 'PDF to native PPTX must paint and retain the first internal frame before releasing outgoing content')

const sceneBridgeSource = readFileSync(resolve(root, 'src', 'renderer', 'src', 'components', 'ProgramScene', 'ProgramSceneBridge.tsx'), 'utf8')
const presentationAppSource = readFileSync(resolve(root, 'src', 'renderer', 'src', 'PresentationApp.tsx'), 'utf8')
const qrBridgeSource = readFileSync(resolve(root, 'src', 'renderer', 'src', 'components', 'QrOverlay', 'QrOverlayBridge.tsx'), 'utf8')
const outputPreloadSource = readFileSync(resolve(root, 'src', 'preload', 'output.ts'), 'utf8')
assert.match(qrBridgeSource, /qr-overlay-renderer-update[\s\S]*?visible \? \{ \.\.\.config, enabled: true \} : null/, 'headless Program QR must use its own output bridge')
assert.match(qrBridgeSource, /on\('program-scene-ready', sendRendererQrOverlay\)/, 'a replacement hidden renderer must receive the current QR again')
assert.match(outputPreloadSource, /'qr-overlay-renderer-update'/, 'restricted output preload must allow only the dedicated QR update channel')
assert.match(sceneBridgeSource, /qrOverlay: null/, 'unrelated Scene updates must not own or clear headless QR')
assert.match(presentationAppSource, /\{rendererQrOverlay\?\.enabled && \([\s\S]*?<SceneQrPreviewLayer/, 'Presentation output must render dedicated QR independently of the optional Scene layout')

const programMonitorSource = readFileSync(resolve(root, 'src', 'renderer', 'src', 'components', 'ProgramMonitor', 'HeadlessProgramRail.tsx'), 'utf8')
assert.match(programMonitorSource, /connectedProgramDisplayId[\s\S]*=== null/, 'operator Program monitor must appear only without a physical Program display')
assert.match(programMonitorSource, /captureProgramPreviewFrame\(\)/, 'operator Program monitor must capture the authoritative hidden output')
assert.match(programMonitorSource, /data-pdm-program-monitor-large/, 'operator Program monitor must provide an enlarged view')
assert.match(mainSource, /capture-program-preview-frame[\s\S]*capturePage\(\)[\s\S]*toJPEG\(78\)/, 'operator Program monitor must use a bounded compressed frame instead of full PNG polling')

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
