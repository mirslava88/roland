const { app, BrowserWindow, ipcMain } = require('electron')
const { resolve } = require('node:path')
const { writeFileSync } = require('node:fs')
const assert = require('node:assert/strict')

app.setPath('userData', resolve('tmp/channel-large-preview-ui/profile'))
const deadline = setTimeout(() => app.exit(1), 30000)
const pause = (ms) => new Promise((done) => setTimeout(done, ms))

app.whenReady().then(async () => {
  let win
  const fullscreenCalls = []
  const keyboardGuardCalls = []
  try {
    win = new BrowserWindow({ show: true, width: 1280, height: 800, webPreferences: {
      preload: resolve('scripts/test-channel-preview-preload.cjs'),
      sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false
    } })
    ipcMain.handle('set-control-preview-fullscreen', async (event, enabled) => {
      assert.equal(event.sender, win.webContents)
      assert.equal(typeof enabled, 'boolean')
      fullscreenCalls.push(enabled)
      return await new Promise((done) => {
        const eventName = enabled ? 'enter-full-screen' : 'leave-full-screen'
        const timeout = setTimeout(() => done(win.isFullScreen() === enabled), 1500)
        win.once(eventName, () => { clearTimeout(timeout); done(win.isFullScreen() === enabled) })
        win.setFullScreen(enabled)
      })
    })
    ipcMain.handle('set-channel-preview-keyboard-guard', (event, enabled) => {
      assert.equal(event.sender, win.webContents)
      assert.equal(typeof enabled, 'boolean')
      keyboardGuardCalls.push(enabled)
      return true
    })
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
    await js('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
    win.webContents.invalidate()
    await pause(150)
    writeFileSync(resolve('tmp/channel-large-preview-ui/preview.png'), (await win.webContents.capturePage()).toPNG())
    assert.equal(await js(`document.querySelector('[data-channel-preview-dialog] img')?.getAttribute('src')`),
      await js('window.testFrames[1]'), 'Large preview uses the full-resolution PPTX frame')
    assert.equal(await js('document.body.style.overflow'), 'hidden', 'Preview has no page scrollbar')
    assert.deepEqual(keyboardGuardCalls, [true], 'Preview enables arrow-key protection')
    assert.equal(await js(`Boolean(document.querySelector('[data-channel-preview-keyboard-warning]'))`), true)
    await js(`document.querySelector('[data-channel-preview-fullscreen]').click()`)
    await pause(50)
    assert.deepEqual(fullscreenCalls, [true], 'Fullscreen button requests native window fullscreen')
    assert.equal(win.isFullScreen(), true, 'Control window is actually fullscreen')
    assert.equal(await js(`document.querySelector('[data-channel-preview-fullscreen]').textContent.trim()`), 'В окно')
    await js(`document.querySelector('[data-channel-preview-fullscreen]').click()`)
    await pause(50)
    assert.deepEqual(fullscreenCalls, [true, false], 'Windowed button restores normal size')
    assert.equal(win.isFullScreen(), false, 'Control window returns to windowed mode')
    await js(`document.querySelector('[data-channel-preview-fullscreen]').click()`)
    await pause(50)
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`)
    assert.equal(await js(`document.querySelector('[data-channel-preview-dialog] img')?.getAttribute('alt')`), 'Слайд 2',
      'Keyboard arrows do not move the preview')
    await js(`document.querySelector('[aria-label="Следующий слайд"]').click()`)
    await pause(50)
    assert.equal(await js(`document.querySelector('[data-channel-preview-dialog] img')?.getAttribute('alt')`), 'Слайд 3')
    await js(`(() => {
      const input = document.querySelector('[data-channel-preview-slide-input]');
      input.focus();
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    })()`)
    assert.equal(await js(`document.querySelector('[data-channel-preview-dialog] img')?.getAttribute('alt')`), 'Слайд 3',
      'Arrow keys in the number field do not switch slides')
    await js(`(() => {
      const input = document.querySelector('[data-channel-preview-slide-input]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '1');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`)
    await pause(50)
    assert.equal(await js(`document.querySelector('[data-channel-preview-dialog] img')?.getAttribute('alt')`), 'Слайд 1',
      'Entering a slide number jumps within the preview')
    await js(`(() => {
      const input = document.querySelector('[data-channel-preview-slide-input]');
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '99');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`)
    await pause(50)
    assert.equal(await js(`document.querySelector('[data-channel-preview-dialog] img')?.getAttribute('alt')`), 'Слайд 3',
      'Out-of-range page number is clamped to the last slide')
    assert.equal(await js('window.testStore.getState().channels[window.testChannelId].slide'), 2,
      'Preview navigation does not change the channel slide')
    assert.equal(await js('window.testTakeCalls'), 0, 'Preview never takes a channel on air')
    await js(`document.querySelector('[aria-label="Закрыть предпросмотр"]').click()`)
    await pause(50)
    assert.equal(await js(`Boolean(document.querySelector('[data-channel-preview-dialog]'))`), false)
    assert.deepEqual(fullscreenCalls, [true, false, true, false], 'Closing preview restores the control window')
    assert.deepEqual(keyboardGuardCalls, [true, false], 'Closing preview releases arrow-key protection')
    assert.equal(win.isFullScreen(), false, 'Closing preview leaves normal window mode')
    assert.deepEqual(await js('window.testErrors'), [])
    console.log('PASS: channel preview fullscreen and direct slide-number navigation leave air untouched')
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    clearTimeout(deadline)
    ipcMain.removeHandler('set-control-preview-fullscreen')
    ipcMain.removeHandler('set-channel-preview-keyboard-guard')
    if (win && !win.isDestroyed()) win.destroy()
    app.exit(process.exitCode || 0)
  }
}).catch((error) => { clearTimeout(deadline); console.error(error); app.exit(1) })
