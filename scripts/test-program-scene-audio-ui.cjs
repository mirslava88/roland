const { app, BrowserWindow } = require('electron')
const { resolve } = require('node:path')
const { writeFileSync } = require('node:fs')
const assert = require('node:assert/strict')
app.setPath('userData', resolve('tmp/pip-audio-ui/profile'))
const deadline = setTimeout(() => app.exit(1), 25000)
app.whenReady().then(async () => {
  let win
  try {
    win = new BrowserWindow({ show: false, useContentSize: true, width: 1280, height: 800,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
    await win.loadFile(resolve('tmp/pip-audio-ui/index.html'))
    for (const [width, height] of [[1280, 800], [1280, 600], [1000, 533]]) {
      win.setContentSize(width, height)
      await new Promise((done) => setTimeout(done, 150))
      const rect = await win.webContents.executeJavaScript(`(() => {
        const box = document.querySelector('body > div > div').getBoundingClientRect();
        const input = document.querySelector('[aria-label="Аудиовход камеры"]');
        return { top: box.top, bottom: box.bottom, width: box.width, height: innerHeight,
          hasInput: !!input, hasCheckbox: document.body.innerText.includes('Звук камеры') };
      })()`)
      assert.ok(rect.hasInput && rect.hasCheckbox)
      if (rect.top < 0 || rect.bottom > rect.height) {
        console.log(await win.webContents.executeJavaScript(`Array.from(document.querySelector('body > div > div').children).map(el => ({tag:el.tagName, cls:el.className, h:el.getBoundingClientRect().height}))`))
        writeFileSync(resolve('tmp/pip-audio-ui/preview.png'), (await win.webContents.capturePage()).toPNG())
      }
      assert.ok(rect.top >= 0 && rect.bottom <= rect.height, `PiP modal must fit without scrolling at ${width}x${height}: ${JSON.stringify(rect)}`)
      console.log(`PASS: PiP audio controls fit ${width}x${height} without scrolling (${Math.round(rect.bottom - rect.top)}px high)`)
    }
    writeFileSync(resolve('tmp/pip-audio-ui/preview.png'), (await win.webContents.capturePage()).toPNG())
    win.destroy()
    clearTimeout(deadline)
    app.exit(0)
  } catch (error) {
    console.error(error)
    win?.destroy()
    clearTimeout(deadline)
    app.exit(1)
  }
})
