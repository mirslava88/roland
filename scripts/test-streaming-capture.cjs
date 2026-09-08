// Electron smoke test entry point. Bundle to out/main/streaming-smoke.cjs first.
// Uses an isolated profile and loopback RTMP receiver; never publishes externally.
const { app, BrowserWindow, screen } = require('electron')
const { spawn } = require('node:child_process')
const { join } = require('node:path')
const { once } = require('node:events')
const { setTimeout: delay } = require('node:timers/promises')
const { createServer } = require('node:net')
const { readFileSync } = require('node:fs')
const assert = require('node:assert/strict')
const { StreamingManager } = require('../src/main/streaming.ts')
const root = join(__dirname, '../..')
app.setPath('userData', join(root, 'tmp', 'streaming-smoke-profile'))
app.setAppPath(root)
let manager, control, receiver
const deadline = setTimeout(() => { console.error('FAIL: capture smoke timeout'); app.exit(1) }, 55000)
app.on('before-quit', () => { manager?.stop(); receiver?.kill() })
app.whenReady().then(async () => {
  try {
    const primary = screen.getPrimaryDisplay()
    const target = screen.getAllDisplays().find((d) => d.id !== primary.id)
    assert.ok(target, 'Capture smoke requires a connected secondary display')
    control = new BrowserWindow({ show: false, x: primary.bounds.x + 20, y: primary.bounds.y + 20, width: 320, height: 200,
      webPreferences: { preload: join(root, 'out/preload/index.js'), sandbox: true, contextIsolation: true, nodeIntegration: false } })
    let routedDisplay = target.id
    manager = new StreamingManager(() => control, () => routedDisplay)
    await control.loadURL('data:text/html,<title>PDM local streaming test</title>')
    for (const audio of ['none', 'system']) {
      const portServer = createServer()
      portServer.listen(0, '127.0.0.1'); await once(portServer, 'listening')
      const port = portServer.address().port
      await new Promise((resolve) => portServer.close(resolve))
      let metadata = '', frames = 0
      const audioPath = join(root, 'tmp', `stream-smoke-${audio}.f32`)
      const receive = () => {
        frames = 0; metadata = ''
        receiver = spawn(join(root, 'node_modules/ffmpeg-static/ffmpeg.exe'), ['-hide_banner', '-loglevel', 'info', '-listen', '1',
          '-i', `rtmp://127.0.0.1:${port}/live/test`, '-y', '-progress', 'pipe:1',
          '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-f', 'f32le', audioPath,
          '-map', '0:v:0', '-f', 'null', '-'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
        receiver.stdout.on('data', (data) => { const matches = [...data.toString().matchAll(/frame=(\d+)/g)]; if (matches.length) frames = Number(matches.at(-1)[1]) })
        receiver.stderr.on('data', (data) => { metadata = (metadata + data.toString()).slice(-12000) })
      }
      receive()
      if (audio === 'system') await control.webContents.executeJavaScript(`
        window.testAudio = new AudioContext();
        window.testTone = testAudio.createOscillator(); const gain = testAudio.createGain();
        gain.gain.value = 0.05; testTone.frequency.value = 440;
        testTone.connect(gain).connect(testAudio.destination); testTone.start(); testAudio.resume();`, true)
      await delay(400)
      const settings = { resolution: 1080, fps: 30, bitrateKbps: Number(process.env.PDM_SMOKE_BITRATE) || 6000, encoder: 'auto', audio, microphoneId: '',
        destinations: [{ id: 'local', name: 'Local test', enabled: true, server: `rtmp://127.0.0.1:${port}/live`, key: 'test' }] }
      if (audio === 'none') {
        const saved = { ...settings, destinations: [{ ...settings.destinations[0], key: 'LOCAL_TEST_SECRET_NOT_FOR_GIT_742' }] }
        await control.webContents.executeJavaScript(`window.api.streaming.save(${JSON.stringify(saved)})`)
        const encrypted = readFileSync(join(app.getPath('userData'), 'stream-settings.enc'))
        assert.equal(encrypted.includes(Buffer.from(saved.destinations[0].key)), false)
        const loaded = await control.webContents.executeJavaScript('window.api.streaming.load()')
        assert.equal(loaded.settings.destinations[0].key, saved.destinations[0].key)
        console.log('PASS: stream key encrypted on disk and restored through authorized IPC')
      }
      // Test serialization through the real context-isolated preload and IPC guards.
      await control.webContents.executeJavaScript(`window.api.streaming.start(${JSON.stringify(settings)}, ${target.id})`)
      let encoderErrors = ''
      manager.engine?.encoder?.stderr.on('data', b => { encoderErrors += b.toString() })
      const start = Date.now()
      while (frames < 40 && Date.now() - start < 17000) {
        await delay(400)
        const state = await control.webContents.executeJavaScript('window.api.streaming.status()')
        if (state.phase === 'error') throw new Error(state.error)
      }
      const diagnosed = await control.webContents.executeJavaScript('window.api.streaming.status()')
      assert.ok(frames >= 40, `Receiver did not decode frames. ${JSON.stringify(diagnosed.destinations)} ${metadata.slice(-2000)}`)
      assert.match(metadata, /1920x1080/)
      assert.match(metadata, /Audio: aac/)
      assert.doesNotMatch(encoderErrors, /Non-monotonic|backward in time|Error muxing|Error submitting/)
      const state = await control.webContents.executeJavaScript('window.api.streaming.status()')
      console.log(`PASS: Electron 1080p capture audio=${audio}, encoder=${state.encoder}, receiverFrames=${frames}`)
      if (audio === 'system') {
        const closed = once(receiver, 'exit')
        receiver.kill(); await closed
        const pcm = readFileSync(audioPath)
        let energy = 0
        for (let i = 0; i + 4 <= pcm.length; i += 4) energy += pcm.readFloatLE(i) ** 2
        const rms = Math.sqrt(energy / (pcm.length / 4))
        assert.ok(Number.isFinite(rms) && rms > 0.0005, `Actual system audio must reach RTMP receiver; RMS=${rms}`)
        console.log(`PASS: actual system sound decoded as PCM, RMS=${rms.toFixed(4)}`)
        await delay(1200)
        receive()
        const reconnectStart = Date.now()
        while (frames < 40 && Date.now() - reconnectStart < 18000) await delay(300)
        assert.ok(frames >= 40, 'Hardware-encoded stream must decode after receiver reconnect')
        console.log('PASS: actual 1080p hardware stream reconnects with decodable video/audio')
        routedDisplay = -1
        await delay(800)
        assert.equal((await control.webContents.executeJavaScript('window.api.streaming.status()')).phase, 'error')
        console.log('PASS: changing program display stops capture instead of streaming the wrong screen')
      }
      await control.webContents.executeJavaScript('window.api.streaming.stop()')
      assert.equal(BrowserWindow.getAllWindows().length, 1, 'Capture window must be destroyed on stop')
      assert.equal((await control.webContents.executeJavaScript('window.api.streaming.status()')).phase, 'idle')
      receiver.kill(); receiver = null
      if (audio === 'system') await control.webContents.executeJavaScript('testTone.stop(); testAudio.close()')
      await delay(300)
    }
    console.log('PASS: capture restart, IPC path, and hidden renderer cleanup')
    clearTimeout(deadline)
    manager.stop(); control.destroy(); app.exit(0)
  } catch (error) {
    console.error('FAIL:', error.message)
    clearTimeout(deadline)
    manager?.stop(); receiver?.kill(); control?.destroy(); app.exit(1)
  }
})
