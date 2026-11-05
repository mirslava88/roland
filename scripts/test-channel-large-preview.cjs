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
        const timeout = setTimeout(() => done(win.isFullScreen() === enabled), 2500)
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
    const badgeProbe = await js(`(() => {
      const badge = document.querySelector('[data-pdm-presentation-audit]');
      const preview = badge?.parentElement;
      return { summary: Object.fromEntries([...badge.querySelectorAll('[data-pdm-audit-summary]')].map((part) => [part.dataset.pdmAuditSummary, part.textContent.trim()])), width: badge.getBoundingClientRect().width, previewWidth: preview?.getBoundingClientRect().width };
    })()`)
    assert.deepEqual(Object.keys(badgeProbe.summary), ['video', 'audio', 'animation', 'fonts', 'links'])
    assert.deepEqual(badgeProbe.summary, { video: 'Видео', audio: 'Аудио', animation: 'Анимации', fonts: 'Шрифты', links: 'Ссылки' }, `Compact badge only names categories: ${JSON.stringify(badgeProbe)}`)
    assert.ok(badgeProbe.width <= badgeProbe.previewWidth, `Audit badge stays inside preview: ${JSON.stringify(badgeProbe)}`)
    await js(`document.querySelector('[data-pdm-presentation-audit]').scrollIntoView({block:'center'})`)
    await pause(50)
    writeFileSync(resolve('tmp/channel-large-preview-ui/audit-badge.png'), (await win.webContents.capturePage()).toPNG())
    await js(`document.querySelector('[data-pdm-presentation-audit]').click()`)
    await pause(50)
    const auditProbe = await js(`({open:Boolean(document.querySelector('[data-pdm-presentation-audit-dialog]')),text:document.querySelector('[data-pdm-presentation-audit-dialog]')?.textContent||'',errors:window.testErrors})`)
    assert.equal(auditProbe.open, true, `Presentation audit opens: ${JSON.stringify(auditProbe)}`)
    assert.ok(auditProbe.text.includes('Отсутствующий шрифт') && auditProbe.text.includes('Анимации') && auditProbe.text.includes('Медиа по ссылке'))
    await js(`document.querySelector('[aria-label="Закрыть проверку"]').click()`)
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
    assert.deepEqual(keyboardGuardCalls, [true])
    assert.equal(await js(`Boolean(document.querySelector('[data-channel-preview-keyboard-warning]'))`), true)
    await js(`document.querySelector('[data-channel-preview-fullscreen]').click()`)
    await pause(50)
    assert.deepEqual(fullscreenCalls, [true])
    assert.equal(win.isFullScreen(), true)
    await js(`document.querySelector('[data-channel-preview-fullscreen]').click()`)
    await pause(50)
    assert.equal(win.isFullScreen(), false)
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`)
    assert.equal(await js(`document.querySelector('[data-channel-preview-dialog] img')?.getAttribute('alt')`), 'Слайд 2')
    await js(`document.querySelector('[aria-label="Следующий слайд"]').click()`)
    await pause(50)
    assert.equal(await js(`document.querySelector('[data-channel-preview-dialog] img')?.getAttribute('alt')`), 'Слайд 3')
    await js(`(() => {
      const input = document.querySelector('[data-channel-preview-slide-input]')
      input.focus()
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '1')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })()`)
    await pause(50)
    assert.equal(await js(`document.querySelector('[data-channel-preview-dialog] img')?.getAttribute('alt')`), 'Слайд 1')
    assert.equal(await js('window.testStore.getState().channels[window.testChannelId].slide'), 2,
      'Preview navigation does not change the channel slide')
    assert.equal(await js('window.testTakeCalls'), 0, 'Preview never takes a channel on air')
    await js(`document.querySelector('[aria-label="Закрыть предпросмотр"]').click()`)
    await pause(50)
    assert.equal(await js(`Boolean(document.querySelector('[data-channel-preview-dialog]'))`), false)
    assert.deepEqual(keyboardGuardCalls, [true, false])
    assert.equal(win.isFullScreen(), false)
    await js('window.testRenderLiveVideo()')
    await pause(100)
    writeFileSync(resolve('tmp/channel-large-preview-ui/live-video-end.png'), (await win.webContents.capturePage()).toPNG())
    assert.equal(await js(`Boolean(document.querySelector('[data-channel-video-end-target]'))`), true,
      'An on-air video channel keeps its end target selector visible')
    assert.equal(await js(`document.querySelector('[data-channel-video-end-target]').disabled`), false)
    assert.equal(await js(`Boolean(document.querySelector('[data-pdm-channel-take]'))`), false,
      'An on-air video channel must not show a second Take button')
    await js(`(() => {
      const select=document.querySelector('[data-channel-video-end-target]');
      select.value=window.testVideoTarget;
      select.dispatchEvent(new Event('change',{bubbles:true}));
    })()`)
    await pause(100)
    assert.equal(await js(`window.testStore.getState().channels[window.testChannelId].videoEndChannel`),
      await js('window.testVideoTarget'), 'Changing the end target while live updates the current channel')
    assert.equal(await js(`document.querySelector('[data-channel-video-end-target]').value`),
      await js('window.testVideoTarget'), 'The live selector reflects the newly selected channel')
    assert.equal(await js('window.testTakeCalls'), 0, 'Changing the live end target does not restart the video')
    await js('window.testRenderLiveMusic()')
    await pause(75)
    assert.equal(await js(`Boolean(document.querySelector('[aria-label^="Канал после окончания музыки"]'))`), true)
    await js(`(() => {
      const select=document.querySelector('[aria-label^="Канал после окончания музыки"]');
      select.value=window.testVideoTarget;
      select.dispatchEvent(new Event('change',{bubbles:true}));
    })()`)
    await pause(75)
    assert.equal(await js(`window.testStore.getState().channels[window.testChannelId].videoEndChannel`),
      await js('window.testVideoTarget'))
    assert.equal(await js('window.testTakeCalls'), 0)
    assert.deepEqual(await js('window.testErrors'), [])
    console.log('PASS: channel preview and editable live-video end target leave air untouched')
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
