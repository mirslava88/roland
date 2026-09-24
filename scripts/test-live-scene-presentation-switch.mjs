import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const sleep = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms))

function parseArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, '')
    if (key) values[key] = argv[index + 1]
  }
  return values
}

class CdpClient {
  constructor(url) {
    this.url = url
    this.nextId = 1
    this.pending = new Map()
  }

  async connect() {
    this.socket = new WebSocket(this.url)
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (!message.id) return
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message))
      else pending.resolve(message.result)
    })
    await new Promise((resolveOpen, rejectOpen) => {
      this.socket.addEventListener('open', resolveOpen, { once: true })
      this.socket.addEventListener('error', rejectOpen, { once: true })
    })
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolveResult, rejectResult) => {
      this.pending.set(id, { resolve: resolveResult, reject: rejectResult })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Runtime.evaluate failed')
    return result.result?.value
  }

  close() {
    this.socket?.close()
  }
}

async function waitForTarget(port, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`)
      const targets = await response.json()
      const target = targets.find((candidate) => candidate.type === 'page' && (
        /\/index\.html(?:$|[?#])/.test(candidate.url) ||
        /^https?:\/\/localhost:\d+\/?(?:[?#].*)?$/.test(candidate.url)
      ))
      if (target?.webSocketDebuggerUrl) return target
    } catch {
      // PDM is still starting.
    }
    await sleep(500)
  }
  throw new Error(`PDM control page did not appear on port ${port}`)
}

async function waitUntil(label, callback, timeoutMs = 90_000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await callback()) return
    await sleep(intervalMs)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function writeDataUrl(filePath, dataUrl) {
  const match = /^data:image\/png;base64,(.+)$/s.exec(dataUrl || '')
  assert.ok(match, `Expected PNG data URL for ${filePath}`)
  writeFileSync(filePath, Buffer.from(match[1], 'base64'))
}

function dataUrlHash(dataUrl) {
  const match = /^data:image\/png;base64,(.+)$/s.exec(dataUrl || '')
  assert.ok(match, 'Expected PNG data URL')
  return createHash('sha256').update(Buffer.from(match[1], 'base64')).digest('hex')
}

function frameStats(filePath, ffmpeg) {
  const result = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'info', '-i', filePath,
    '-vf', 'signalstats,metadata=print:file=-', '-frames:v', '1', '-f', 'null', '-'
  ], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  assert.equal(result.status, 0, `FFmpeg could not inspect ${filePath}: ${result.stderr}`)
  const output = `${result.stdout || ''}\n${result.stderr || ''}`
  const value = (name) => Number(new RegExp(`lavfi\\.signalstats\\.${name}=([0-9.]+)`).exec(output)?.[1])
  return { yAverage: value('YAVG'), yLow: value('YLOW'), yHigh: value('YHIGH') }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const port = Number(args.port || 9222)
  const cycles = Math.max(2, Number(args.cycles || 4))
  const sceneMode = args.scene === 'disabled' ? 'disabled' : 'enabled'
  const output = resolve(args.output || 'tmp/live-scene-presentation-switch')
  mkdirSync(output, { recursive: true })
  const ffmpeg = resolve('node_modules/ffmpeg-static/ffmpeg.exe')

  const target = await waitForTarget(port)
  const client = new CdpClient(target.webSocketDebuggerUrl)
  await client.connect()
  await client.send('Runtime.enable')
  let savedRoutes = null
  let cameraConsumer = null
  let consumerFrames = 0
  let consumerBright = 0
  let consumerError = ''

  try {
    await client.evaluate(`(() => {
      document.querySelectorAll('[data-pdm-training-close]').forEach((button) => button.click())
      return true
    })()`)

    const channelTypes = await client.evaluate(`(() => {
      const raw = localStorage.getItem('roland-app-preferences')
      const state = raw ? JSON.parse(raw).state : null
      if (!state?.channels) return []
      return Object.entries(state.channels).map(([id, channel]) => ({
        id: String(id), type: channel?.file?.type || null, name: channel?.file?.name || null
      }))
    })()`)
    const pptx = channelTypes.find((channel) => channel.type === 'presentation')
    const pdf = channelTypes.find((channel) => channel.type === 'pdf')
    assert.ok(pptx, `No ready PPTX channel found: ${JSON.stringify(channelTypes)}`)
    assert.ok(pdf, `No ready PDF channel found: ${JSON.stringify(channelTypes)}`)

    const displays = await client.evaluate('window.api.getDisplays()')
    const externalDisplays = displays.filter((display) => !display.isPrimary)
    if (args.headless === 'true') {
      assert.match(target.url, /^https?:/, 'headless route test requires the development build')
      savedRoutes = await client.evaluate(`(async () => {
        const {useAppStore} = await import('/src/stores/useAppStore.ts')
        const state = useAppStore.getState()
        const saved = { assignments: state.displayAssignments, selected: state.selectedDisplayId }
        for (const display of state.displays) if (!display.isPrimary) state.setDisplayAssignment(display.id, 'off')
        return saved
      })()`)
      await sleep(1000)
    }
    const physicalDisplays = externalDisplays.length > 0
      ? externalDisplays
      : displays.filter((display) => display.isPrimary)
    const emulatedPhysicalRoute = externalDisplays.length === 0
    assert.ok(physicalDisplays.length > 0, `No physical display is available: ${JSON.stringify(displays)}`)
    if (emulatedPhysicalRoute) {
      process.stdout.write('NOTICE: Windows exposes one display; using the same real HWND/desktop visibility path on the primary display.\n')
    }

    const sceneOpened = await client.evaluate(`(() => {
      const button = document.querySelector('[data-toolbar-item="pip"] button') ||
        document.querySelector('[data-toolbar-item="pip"]')
      if (!button) return false
      button.click()
      return true
    })()`)
    assert.equal(sceneOpened, true, 'Scene button is unavailable')
    await waitUntil('Scene modal', async () => client.evaluate("Boolean(document.querySelector('[data-program-scene-modal]'))"))
    const sceneActivated = await client.evaluate(`(() => {
      const button = document.querySelector('[data-program-scene-picture-visible]')
      if (!button) return false
      const text = button.textContent || ''
      const shouldEnable = ${JSON.stringify(sceneMode)} === 'enabled'
      if (shouldEnable && /Показать/i.test(text)) button.click()
      if (!shouldEnable && /Выйти/i.test(text)) button.click()
      return true
    })()`)
    assert.equal(sceneActivated, true, 'Scene live button is unavailable')
    await sleep(1000)
    await client.evaluate("document.querySelector('[data-program-scene-close]')?.click(); true")

    // Reproduce the simultaneous physical + internal consumer which used to
    // turn the already-painted PDF surface transparent after every TAKE.
    if (args['physical-camera'] === 'true') {
      const cameraStatus = await client.evaluate(`(async () => {
        const current = await window.api.virtualCamera.status()
        if (current.phase === 'running') await window.api.virtualCamera.stop()
        return window.api.virtualCamera.start(${physicalDisplays[0].id})
      })()`)
      assert.equal(cameraStatus?.phase, 'running', `Virtual camera did not start: ${JSON.stringify(cameraStatus)}`)
      assert.equal(cameraStatus?.source, 'display', `Virtual camera did not select physical Program: ${JSON.stringify(cameraStatus)}`)
      await sleep(750)
    } else if (args['internal-camera'] === 'true') {
      const cameraStatus = await client.evaluate(`(async () => {
        const current = await window.api.virtualCamera.status()
        if (current.phase === 'running' && current.source !== 'internal') {
          await window.api.virtualCamera.stop()
        }
        return window.api.virtualCamera.start(null)
      })()`)
      assert.equal(cameraStatus?.phase, 'running', `Virtual camera did not start: ${JSON.stringify(cameraStatus)}`)
      assert.equal(cameraStatus?.source, 'internal', `Virtual camera did not select internal Program: ${JSON.stringify(cameraStatus)}`)
      await sleep(750)
    } else {
      await client.evaluate('window.api.prepareInternalProgramOutput().then(() => true)')
    }

    if (args['probe-camera'] === 'true') {
      const listed = spawnSync(ffmpeg, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'],
        { encoding: 'utf8', windowsHide: true, timeout: 15_000 })
      const cameraName = /"(PDM Virtual Camera[^"\r\n]*)" \(video\)/.exec(listed.stderr)?.[1]
      assert.ok(cameraName, 'Windows did not enumerate PDM Virtual Camera')
      cameraConsumer = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'dshow',
        '-i', `video=${cameraName}`, '-an', '-vf', 'scale=64:36', '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1'],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let pending = Buffer.alloc(0)
      cameraConsumer.on('error', error => { consumerError = String(error) })
      cameraConsumer.stderr.on('data', bytes => { consumerError = (consumerError + bytes.toString()).slice(-2000) })
      cameraConsumer.stdout.on('data', bytes => {
        pending = Buffer.concat([pending, bytes])
        while (pending.length >= 64 * 36) {
          consumerFrames++
          consumerBright = pending.subarray(0, 64 * 36).reduce((total, value) => total + (value > 20 ? 1 : 0), 0)
          pending = pending.subarray(64 * 36)
        }
      })
      await waitUntil('Windows camera consumer first frame', () => {
        assert.ok(cameraConsumer.exitCode === null, `Camera consumer exited: ${consumerError}`)
        return consumerFrames > 0
      }, 20_000)
    }

    // Closing the editor while TAKE is pending must not cancel publication.
    // A merely non-black camera tile is NOT proof that Scene was published.
    await client.evaluate(`(() => {
      (document.querySelector('[data-toolbar-item="pip"] button') || document.querySelector('[data-toolbar-item="pip"]'))?.click()
      return true
    })()`)
    await waitUntil('confirmed Scene publication after reopening editor', async () => client.evaluate(`(() => {
      const button = document.querySelector('[data-program-scene-picture-visible]')
      return Boolean(button && (${JSON.stringify(sceneMode)} === 'enabled'
        ? /Выйти/.test(button.textContent || '')
        : /Показать/.test(button.textContent || '')))
    })()`), 35_000)
    await client.evaluate("document.querySelector('[data-program-scene-close]')?.click(); true")

    const take = async (channelId, type) => {
      await waitUntil(`${type} channel readiness`, async () => client.evaluate(`(() => {
        const channel = document.querySelector(${JSON.stringify(`[data-pdm-channel-id="${channelId}"]`)})
        const button = channel?.querySelector('[data-pdm-channel-take]')
        return Boolean(channel && (channel.classList.contains('is-live') ||
          (button && !button.disabled && channel.getAttribute('aria-busy') !== 'true')))
      })()`), type === 'presentation' ? 180_000 : 90_000)
      const clicked = await client.evaluate(`(() => {
        const channel = document.querySelector(${JSON.stringify(`[data-pdm-channel-id="${channelId}"]`)})
        if (channel?.classList.contains('is-live')) return 'already-live'
        const button = channel?.querySelector('[data-pdm-channel-take]')
        if (!button || button.disabled) return false
        button.click()
        return 'clicked'
      })()`)
      assert.ok(clicked, `Could not TAKE ${type} channel ${channelId}`)
      await waitUntil(`${type} channel live`, async () => client.evaluate(
        `(() => {
          const channel = document.querySelector(${JSON.stringify(`[data-pdm-channel-id="${channelId}"].is-live`)})
          return Boolean(channel && channel.getAttribute('aria-busy') !== 'true')
        })()`
      ), 60_000)
      await sleep(type === 'presentation' ? 2500 : 1800)
    }

    let previousSurface = null
    let cameraWriter = null
    let previousConsumerFrames = 0
    for (let cycle = 1; cycle <= cycles; cycle += 1) {
      if (args['exit-scene'] === 'true') {
        // Reproduce the reported trigger using the real Scene button, not a
        // store-only approximation. Keep the same camera process throughout.
        for (const enabled of [true, false]) {
          await client.evaluate(`(() => {
            if (!document.querySelector('[data-program-scene-modal]')) document.querySelector('[data-toolbar-item="pip"] button')?.click()
          })()`)
          await waitUntil('Scene live control', () => client.evaluate("Boolean(document.querySelector('[data-program-scene-picture-visible]'))"))
          await client.evaluate(`(() => {
            const button = document.querySelector('[data-program-scene-picture-visible]')
            if (${enabled} ? /Показать/.test(button.textContent || '') : /Выйти/.test(button.textContent || '')) button.click()
          })()`)
          await waitUntil(`Scene ${enabled ? 'on' : 'off'} confirmed`, () => client.evaluate(`(() => {
            const button = document.querySelector('[data-program-scene-picture-visible]')
            return button && !button.disabled && (${enabled} ? /Выйти/.test(button.textContent || '') : /Показать/.test(button.textContent || ''))
          })()`), 60_000)
          await sleep(500)
        }
        await client.evaluate("document.querySelector('[data-program-scene-close]')?.click(); true")
      }
      const targetChannel = cycle % 2 === 1 ? pdf : pptx
      await take(targetChannel.id, targetChannel.type)
      // On a single-display bench connectedProgramDisplayId() intentionally
      // stays null. Explicitly revealing the same output HWND on the primary
      // display lets this test still exercise real Windows opacity/visibility,
      // then the internal preparation below reproduces the former race.
      if (emulatedPhysicalRoute) {
        await client.evaluate(`window.api.openPresentationWindow(${physicalDisplays[0].id}).then(() => true)`)
      }
      await client.evaluate('window.api.prepareInternalProgramOutput().then(() => true)')
      await sleep(350)

      const surfaceDataUrl = await client.evaluate('window.api.capturePresentationFrame()')
      assert.ok(surfaceDataUrl, `Presentation surface returned no frame after ${targetChannel.type} TAKE`)
      const surfacePath = join(output, `cycle-${cycle}-${targetChannel.type}-presentation-surface.png`)
      writeDataUrl(surfacePath, surfaceDataUrl)
      const surfaceStats = frameStats(surfacePath, ffmpeg)
      const surfaceHash = dataUrlHash(surfaceDataUrl)
      const camera = await client.evaluate('window.api.virtualCamera.status()')
      const nativeCapture = camera.phase === 'running' && camera.source === 'display'
      // Physical capture includes the native PowerPoint HWND. Its Chromium
      // underlay is intentionally transparent and is not the delivered frame.
      if (!nativeCapture) assert.ok(
        Number.isFinite(surfaceStats.yHigh) && surfaceStats.yHigh > 20,
        `Presentation surface is black after ${targetChannel.type} TAKE: ${JSON.stringify(surfaceStats)}`
      )
      if (!nativeCapture && previousSurface && previousSurface.type !== targetChannel.type) {
        assert.notEqual(
          surfaceHash,
          previousSurface.hash,
          `Program surface did not change for ${previousSurface.type} -> ${targetChannel.type}`
        )
      }
      previousSurface = nativeCapture ? null : { type: targetChannel.type, hash: surfaceHash }

      const captures = await client.evaluate(`Promise.all(
        ${JSON.stringify(physicalDisplays.map((display) => display.id))}.map(async (id) => ({ id, dataUrl: await window.api.captureDisplay(id) }))
      )`)
      const stats = []
      for (const capture of captures) {
        assert.ok(capture.dataUrl, `Display ${capture.id} returned no frame after ${targetChannel.type} TAKE`)
        const filePath = join(output, `cycle-${cycle}-${targetChannel.type}-display-${capture.id}.png`)
        writeDataUrl(filePath, capture.dataUrl)
        stats.push({ displayId: capture.id, ...frameStats(filePath, ffmpeg) })
      }
      if (nativeCapture || (args.headless !== 'true' && args['internal-camera'] !== 'true')) {
        assert.ok(
          stats.some((entry) => Number.isFinite(entry.yHigh) && entry.yHigh > 20),
          `All physical outputs are black after ${targetChannel.type} TAKE: ${JSON.stringify(stats)}`
        )
      }
      process.stdout.write(`cycle=${cycle} type=${targetChannel.type} capture=${camera.source} surface=${JSON.stringify(surfaceStats)} desktop=${JSON.stringify(stats)}\n`)
      if (args['probe-camera'] === 'true') {
        const probe = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
          resolve('scripts/test-virtual-camera-live-frame.ps1')], { encoding: 'utf8', windowsHide: true, timeout: 15_000 })
        assert.equal(probe.status, 0, `Shared camera frame probe failed: ${probe.stderr}`)
        const samples = JSON.parse(probe.stdout.trim())
        assert.ok(samples.at(-1).lastWriteTick > samples[0].lastWriteTick, 'Camera stopped publishing frames')
        assert.ok(samples.at(-1).sequence > samples[0].sequence, 'Camera sequence is stalled')
        for (const sample of samples) {
          assert.ok(sample.brightSamples > 0, 'Delivered camera frame is black')
          if (cameraWriter === null) cameraWriter = sample.writer
          assert.equal(sample.writer, cameraWriter, 'Camera host restarted during Scene transitions')
        }
        // spawnSync pauses JS; allow the consumer's queued frames to be read.
        await sleep(200)
        assert.ok(consumerFrames > previousConsumerFrames, `Windows consumer stalled: ${consumerError}`)
        assert.ok(consumerBright > 0, 'Windows camera consumer received a black frame')
        previousConsumerFrames = consumerFrames
        console.log(`camera frames advancing and non-black after cycle ${cycle}; same host`)
      }
    }

    console.log(`PASS: ${cycles} live ${sceneMode} PPTX/PDF transitions verified against the actual camera capture route`)
  } finally {
    cameraConsumer?.kill()
    if (savedRoutes) {
      await client.evaluate(`(async () => {
        const {useAppStore} = await import('/src/stores/useAppStore.ts')
        const saved = ${JSON.stringify(savedRoutes)}
        for (const [id, role] of Object.entries(saved.assignments)) useAppStore.getState().setDisplayAssignment(Number(id), role)
        useAppStore.getState().setSelectedDisplayId(saved.selected)
      })()`)
    }
    try {
      if ((await client.evaluate('window.api.getDisplays()')).filter((display) => !display.isPrimary).length === 0) {
        await client.evaluate('window.api.closePresentationWindow(); true')
      }
    } catch {
      // Preserve the original assertion if cleanup races application shutdown.
    }
    client.close()
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`)
  process.exitCode = 1
})
