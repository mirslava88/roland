const { app, BrowserWindow } = require('electron')
const { resolve } = require('node:path')
const { writeFileSync } = require('node:fs')
const assert = require('node:assert/strict')
app.setPath('userData', resolve('tmp/mac-features-ui/profile'))
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
const deadline = setTimeout(() => app.exit(1), 45000)
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1280, height: 900,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  win.webContents.setAudioMuted(true)
  const js = code => win.webContents.executeJavaScript(code)
  const wait = async (code, description) => {
    for (let n = 0; n < 80; n++) { if (await js(code)) return; await new Promise(done => setTimeout(done, 50)) }
    throw new Error(description + ': ' + JSON.stringify(await js('window.testErrors')))
  }
  try {
    for (const edition of ['standard', 'stream']) {
      await win.loadFile(resolve(`tmp/mac-features-ui/${edition}.html`))
      await wait('!!window.showTestTour', 'fixture mounted')
      assert.equal(await js('!!document.querySelector("[data-pdm-training-record-open]")'), edition === 'stream')
      assert.equal(await js('document.body.textContent.includes("Заметки спикера")'), true)
      if (edition === 'stream') {
        await js('document.querySelector("[data-pdm-training-record-open]").click()')
        await wait('!!document.querySelector("[data-pdm-training-panel=recording]")', 'record panel')
        assert.equal(await js('document.querySelector("[data-pdm-training-panel=recording]").textContent.includes("Windows")'), false)
        await js('document.querySelector("[data-pdm-training-record-start]").click()')
        await wait('document.querySelector("[data-pdm-training-record-phase=running]")!==null', 'record starts')
        await js('document.querySelector("[data-pdm-training-close]").click()')
        assert.equal(await js('window.testCalls.filter(c=>c==="stop").length'), 0, 'closing settings must not stop recording')
        await js('document.querySelector("[data-pdm-training-record-open]").click()')
        await wait('!!document.querySelector("[data-pdm-training-record-stop]")', 'reopened recording panel')
        await js('document.querySelector("[data-pdm-training-record-stop]").click()')
        await wait('!!document.querySelector("[role=alertdialog]")', 'stop confirmation')
        assert.equal(await js('window.testCalls.filter(c=>c==="stop").length'), 0)
        await js('document.querySelector("[data-pdm-training-record-confirm]").click()')
        await wait('document.querySelector("[data-pdm-training-record-phase=idle]")!==null', 'record stopped')
        await js('document.querySelector("[data-pdm-training-record-montage]").click()')
        await wait('window.testCalls.includes("editOpen:true")&&!!document.querySelector("[data-pdm-training-edit-start-time]")', 'last recording opens in editor')
        await js('document.querySelector("[data-pdm-training-edit-fullscreen]").click()')
        await wait('!!document.querySelector("[data-pdm-training-edit-preview=fullscreen]")', 'large editor preview')
        await js('window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))')
        await wait('document.querySelector("[data-pdm-training-edit-preview=fullscreen]")===null', 'large preview closes')
        assert.deepEqual(await js('window.fullscreenCalls'), [true, false])
        await wait('document.querySelectorAll("[data-pdm-training-panel=montage] img").length>3', 'editor filmstrip and waveform');
        writeFileSync(resolve('tmp/mac-features-ui/stream-editor.png'), (await win.webContents.capturePage()).toPNG())
      }
      await js('window.showTestTour()')
      await wait('document.body.textContent.includes("Разрешения macOS")', 'Mac lesson replaces virtual camera')
      assert.deepEqual(await js('window.testErrors'), [])
      console.log(`PASS: Mac ${edition}, recording edition gate, speaker canvas and Mac training`)
    }
    clearTimeout(deadline); win.destroy(); app.exit(0)
  } catch (error) {
    console.error(error); console.error(await js('window.testErrors').catch(() => []))
    clearTimeout(deadline); win.destroy(); app.exit(1)
  }
})
