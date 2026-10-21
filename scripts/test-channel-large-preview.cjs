const { app, BrowserWindow } = require('electron')
const { resolve } = require('node:path')
const assert = require('node:assert/strict')

app.setPath('userData', resolve('tmp/channel-large-preview-ui/profile'))
const deadline = setTimeout(() => app.exit(1), 30000)
const pause = (ms) => new Promise((done) => setTimeout(done, ms))

app.whenReady().then(async () => {
  let win
  try {
    win = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: {
      sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false
    } })
    const js = (code) => win.webContents.executeJavaScript(code)
    await win.loadFile(resolve('tmp/channel-large-preview-ui/test.html'))
    await pause(250)
    await js(`(() => {
      const card=document.querySelector('.pdm-channel-card');
      card?.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:120,clientY:120}));
    })()`)
    await pause(50)
    const menuProbe = await js(`({card:Boolean(document.querySelector('.pdm-channel-card')),preview:Boolean(document.querySelector('[data-channel-large-preview]')),errors:window.testErrors,body:document.body.textContent.slice(0,250)})`)
    assert.equal(menuProbe.preview, true, `Channel context menu offers Preview: ${JSON.stringify(menuProbe)}`)
    await js(`document.querySelector('[data-channel-large-preview]').click()`)
    await pause(100)
    assert.equal(await js(`document.querySelector('[data-channel-preview-dialog] img')?.getAttribute('src')`),
      await js('window.testFrames[1]'), 'Large preview uses the full-resolution PPTX frame')
    await js(`document.querySelector('[aria-label="Следующий слайд"]').click()`)
    await pause(50)
    assert.equal(await js(`document.querySelector('[data-channel-preview-dialog] img')?.getAttribute('alt')`), 'Слайд 3')
    assert.equal(await js('window.testStore.getState().channels[window.testChannelId].slide'), 2,
      'Preview navigation does not change the channel slide')
    assert.equal(await js('window.testTakeCalls'), 0, 'Preview never takes a channel on air')
    await js(`document.querySelector('[aria-label="Закрыть предпросмотр"]').click()`)
    await pause(50)
    assert.equal(await js(`Boolean(document.querySelector('[data-channel-preview-dialog]'))`), false)
    assert.deepEqual(await js('window.testErrors'), [])
    console.log('PASS: channel right-click opens high-resolution local preview; navigation leaves air untouched')
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    clearTimeout(deadline)
    if (win && !win.isDestroyed()) win.destroy()
    app.exit(process.exitCode || 0)
  }
}).catch((error) => { clearTimeout(deadline); console.error(error); app.exit(1) })
