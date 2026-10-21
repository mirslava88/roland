const { app, BrowserWindow } = require('electron')
const { resolve } = require('node:path')
const assert = require('node:assert/strict')

app.setPath('userData', resolve('tmp/library-resize-ui/profile'))
const deadline = setTimeout(() => app.exit(1), 30000)
const pause = ms => new Promise(done => setTimeout(done, ms))

app.whenReady().then(async () => {
  let win
  try {
    win = new BrowserWindow({ show: false, frame: false, width: 1280, height: 800, useContentSize: true,
      webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false } })
    const js = code => win.webContents.executeJavaScript(code)
    const width = () => js('document.querySelector(".pdm-library-resizable").getBoundingClientRect().width')
    await win.loadFile(resolve('tmp/library-resize-ui/test.html'))
    await js('localStorage.removeItem("pdm-library-width-v1")')
    await win.loadFile(resolve('tmp/library-resize-ui/test.html'))
    await pause(100)

    assert.ok(Math.abs((await width()) - 256) < 2, 'Broadcast Pro keeps its default width')
    await js(`(() => {
      const handle=document.querySelector('.pdm-library-resize-handle');
      const x=handle.getBoundingClientRect().x+3;
      handle.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:7,button:0,clientX:x}));
      window.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:7,clientX:x+180}));
      window.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:7,clientX:x+180}));
    })()`)
    await pause(50)
    assert.ok(Math.abs((await width()) - 436) < 2, 'Dragging expands the panel')
    assert.equal(await js('localStorage.getItem("pdm-library-width-v1")'), '436')
    await win.loadFile(resolve('tmp/library-resize-ui/test.html'))
    await pause(100)
    assert.ok(Math.abs((await width()) - 436) < 2, 'Saved width survives reload')

    win.setContentSize(880, 800)
    await pause(100)
    assert.ok((await width()) <= 330, 'Narrow window clamps the panel')
    const stage = await js('document.querySelector(".pdm-stage").getBoundingClientRect().width')
    assert.ok(stage >= 520, 'Main workspace remains usable')
    const child = await js('document.querySelector(".pdm-library").getBoundingClientRect().width')
    assert.ok(Math.abs(child - (await width())) < 2, 'Library content fills resized panel')

    await js('document.querySelector(".pdm-library-resize-handle").dispatchEvent(new MouseEvent("dblclick",{bubbles:true}))')
    await pause(50)
    assert.equal(await js('localStorage.getItem("pdm-library-width-v1")'), null)
    assert.ok(Math.abs((await width()) - 225) < 2, 'Double click restores responsive default')
    await js('document.querySelector(".pdm-library-resize-handle").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true}))')
    await pause(50)
    assert.ok(Math.abs((await width()) - 245) < 2, 'Keyboard adjustment works')
    assert.deepEqual(await js('window.testErrors'), [])
    console.log('PASS: library resize drag, persistence, narrow layout, reset and keyboard')
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    clearTimeout(deadline)
    if (win && !win.isDestroyed()) win.destroy()
    app.quit()
  }
}).catch(error => { clearTimeout(deadline); console.error(error); app.exit(1) })
