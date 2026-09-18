const { app, BrowserWindow } = require('electron')
const { resolve } = require('node:path')
const { writeFileSync } = require('node:fs')
const assert = require('node:assert/strict')
app.setPath('userData', resolve('tmp/pip-video-ui/profile'))
const deadline = setTimeout(() => app.exit(1), 120000)
app.whenReady().then(async () => {
  let win
  let stage = 'startup'
  try {
    win = new BrowserWindow({ show: false, width: 1280, height: 800, useContentSize: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
    if (process.env.PDM_SCENE_TIMER_CLOSE_ONLY) {
      stage = 'independent timer layout applies when the Scene closes'
      await win.loadFile(resolve('tmp/pip-video-ui/index.html'), { search: 'preview&device' })
      await new Promise(done => setTimeout(done, 350))
      const before = await win.webContents.executeJavaScript(`({...window.testScene.timerOverlayPosition})`)
      await win.webContents.executeJavaScript(`(() => {
        const timer=document.querySelector('[data-program-scene-timer-preview]');
        const layer=document.querySelector('[data-program-scene-timer-layer]');
        const preview=document.querySelector('[data-program-scene-preview]').getBoundingClientRect();
        const rect=timer.getBoundingClientRect(); const pointerId=40;
        timer.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,button:0,pointerId,clientX:rect.left+rect.width/2,clientY:rect.top+rect.height/2}));
        layer.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,cancelable:true,pointerId,clientX:preview.left+preview.width*.68,clientY:preview.top+preview.height*.62}));
        layer.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,pointerId,clientX:preview.left+preview.width*.68,clientY:preview.top+preview.height*.62}));
      })()`)
      await new Promise(done => setTimeout(done, 50))
      await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-close]').click()`)
      await new Promise(done => setTimeout(done, 80))
      assert.deepEqual(await win.webContents.executeJavaScript(`({...window.testScene.timerOverlayPosition})`), before,
        'Closing a live combined Scene must not bypass the explicit refresh transaction')
      await win.webContents.executeJavaScript(`window.remountTest();window.testScene.setProgramScene({enabled:false})`)
      await new Promise(done => setTimeout(done, 120))
      await win.webContents.executeJavaScript(`(() => {
        const timer=document.querySelector('[data-program-scene-timer-preview]');
        const layer=document.querySelector('[data-program-scene-timer-layer]');
        const preview=document.querySelector('[data-program-scene-preview]').getBoundingClientRect();
        const rect=timer.getBoundingClientRect(); const pointerId=41;
        timer.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,button:0,pointerId,clientX:rect.left+rect.width/2,clientY:rect.top+rect.height/2}));
        layer.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,cancelable:true,pointerId,clientX:preview.left+preview.width*.32,clientY:preview.top+preview.height*.28}));
        layer.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,pointerId,clientX:preview.left+preview.width*.32,clientY:preview.top+preview.height*.28}));
      })()`)
      await new Promise(done => setTimeout(done, 50))
      assert.deepEqual(await win.webContents.executeJavaScript(`({...window.testScene.timerOverlayPosition})`), before,
        'Moving the independent timer in Scene preview must stay local until the Scene window closes')
      await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-close]').click()`)
      await new Promise(done => setTimeout(done, 100))
      const after = await win.webContents.executeJavaScript(`({position:{...window.testScene.timerOverlayPosition},visible:window.testScene.timerOutputVisible,owner:window.testScene.timerOutputOwner,snapshot:window.testScene.programSnapshot,lastOverlay:window.lastTimerOverlay})`)
      assert.notDeepEqual(after.position, before, 'Closing a disabled Scene must apply the drafted timer position')
      assert.equal(after.visible, true, 'Applying the timer layout must not hide the independent timer')
      assert.equal(after.owner, 'toolbar', 'Applying the timer layout must preserve independent timer ownership')
      assert.equal(after.snapshot, null, 'Applying the independent timer layout must not enable the combined Scene')
      assert.equal(after.lastOverlay?.posX, after.position.x, 'The live timer overlay must receive the applied horizontal position')
      assert.equal(after.lastOverlay?.posY, after.position.y, 'The live timer overlay must receive the applied vertical position')
      await win.webContents.executeJavaScript(`window.unmountTest()`)
      clearTimeout(deadline);win.destroy();app.quit()
      console.log('PASS: disabled Scene applies timer layout on close without changing timer ownership or visibility')
      return
    }
    if (process.env.PDM_SCENE_DIRTY_ONLY) {
      stage = 'Scene refresh attention survives editor remount'
      await win.loadFile(resolve('tmp/pip-video-ui/index.html'), { search: 'preview&device' })
      await new Promise(done => setTimeout(done, 350))
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-refresh]').dataset.pendingChanges`), 'false')
      await win.webContents.executeJavaScript(`window.testScene.setProgramScene({textOverlays:[{id:'persistent-draft',text:'Р§РµСЂРЅРѕРІРёРє',xPercent:50,yPercent:50,widthPercent:30,fontSizePercent:36,fontFamily:'Arial',fontWeight:700,color:'#ffffff',backgroundColor:'#000000',backgroundOpacity:.4,textAlign:'left',visible:true}]});window.remountTest()`)
      await new Promise(done => setTimeout(done, 120))
      assert.deepEqual(await win.webContents.executeJavaScript(`(() => {const button=document.querySelector('[data-program-scene-refresh]');return {pending:button.dataset.pendingChanges,blue:button.className.includes('bg-blue-600'),attention:button.className.includes('program-scene-refresh-attention')}})()`),
        {pending:'true',blue:true,attention:true}, 'A saved Scene draft must keep the blue glowing refresh button after reopening the editor')
      await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-refresh]').click()`)
      await new Promise(done => setTimeout(done, 100))
      assert.deepEqual(await win.webContents.executeJavaScript(`(() => {const button=document.querySelector('[data-program-scene-refresh]');return {pending:button.dataset.pendingChanges,attention:button.className.includes('program-scene-refresh-attention')}})()`),
        {pending:'false',attention:false}, 'Publishing the Scene draft must clear refresh attention')
      await win.webContents.executeJavaScript(`window.unmountTest()`)
      clearTimeout(deadline);win.destroy();app.quit()
      console.log('PASS: Scene refresh attention survives reopening and clears after publication')
      return
    }
    if (process.env.PDM_SCENE_CONTENT_FOLLOW_ONLY) {
      stage = 'Scene content follows committed channels, not a stale video'
      await win.loadFile(resolve('tmp/pip-video-ui/index.html'), { search: 'preview&content-follow' })
      await new Promise(done => setTimeout(done, 350))
      assert.equal(await win.webContents.executeJavaScript(`!!document.querySelector('.pdm-pip-content-preview video')`), false,
        'Opening Scene with a live PDF must not show the previously saved video channel')
      const previewPath=()=>win.webContents.executeJavaScript(`document.querySelector('.pdm-pip-content-preview').dataset.scenePreviewContentPath`)
      const take=async id=>{
        await win.webContents.executeJavaScript(`(() => {const state=window.testScene;state.liveChannel=${JSON.stringify(id)};
          state.activeFile=state.channels[state.liveChannel].file;state.currentSlide=state.channels[state.liveChannel].slide;state.setProgramScene({});})()`)
        await new Promise(done => setTimeout(done, 100))
      }
      assert.equal(await previewPath(), 'synthetic-live.pdf')
      await take('A')
      assert.equal(await previewPath(), 'synthetic-video.mp4')
      await take('B')
      assert.equal(await previewPath(), 'synthetic-live.pdf')
      assert.equal(await win.webContents.executeJavaScript(`!!document.querySelector('.pdm-pip-content-preview video')`), false)
      await take('C')
      assert.equal(await previewPath(), 'synthetic-live.pptx')
      assert.equal(await win.webContents.executeJavaScript(`!!document.querySelector('.pdm-pip-content-preview img')`), true)
      await win.webContents.executeJavaScript(`(() => {const state=window.testScene;
        state.selectedChannel='A';state.selectedFile=state.channels.A.file;
        state.channels={...state.channels,A:{...state.channels.A,file:{...state.channels.A.file,path:'synthetic-replaced.mp4'}}};state.setProgramScene({});})()`)
      await new Promise(done => setTimeout(done, 60))
      assert.equal(await previewPath(), 'synthetic-live.pptx', 'Selecting/dropping another video must not steal the preview')
      await win.webContents.executeJavaScript(`(() => {const content=document.querySelector('.pdm-pip-content-preview');const rect=content.getBoundingClientRect();
        content.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:rect.left+rect.width/2,clientY:rect.top+rect.height/2}));})()`)
      await new Promise(done => setTimeout(done, 40))
      await win.webContents.executeJavaScript(`document.querySelector('[data-scene-content-channel="D"]').click()`)
      await new Promise(done => setTimeout(done, 60))
      assert.equal(await previewPath(), 'synthetic-draft.pdf', 'Explicit draft selection must still work without TAKE')
      assert.equal(await win.webContents.executeJavaScript(`window.testScene.activeFile.path`), 'synthetic-live.pptx')
      assert.deepEqual(await win.webContents.executeJavaScript(`window.sceneTakeChannels`), [])
      await win.webContents.executeJavaScript(`window.testScene.setProgramScene({participantScale:1.2})`)
      await new Promise(done => setTimeout(done, 60))
      assert.equal(await previewPath(), 'synthetic-draft.pdf', 'Unrelated scene edits must keep the manual draft')
      await take('B')
      assert.equal(await previewPath(), 'synthetic-live.pdf', 'The next committed TAKE must replace the previous preview source')
      writeFileSync(resolve('tmp/pip-video-ui/scene-content-follow.png'), (await win.webContents.capturePage()).toPNG())
      await win.webContents.executeJavaScript(`window.unmountTest()`)
      clearTimeout(deadline);win.destroy();app.quit()
      console.log('PASS: stale video on opening, video→PDF→PPTX TAKE, unrelated drop/selection, manual draft and next TAKE synchronization')
      return
    }
    if (process.env.PDM_SCENE_HINT_ONLY) {
      stage = 'Scene right-click discoverability hint'
      await win.loadFile(resolve('tmp/pip-video-ui/index.html'), { search: 'preview&device' })
      await new Promise(done => setTimeout(done, 350))
      for (const width of [1280, 880]) {
        win.setContentSize(width, 800)
        await new Promise(done => setTimeout(done, 100))
        const layout = await win.webContents.executeJavaScript(`(() => {
          const hint=document.querySelector('[data-scene-context-hint]');
          const preview=document.querySelector('[data-program-scene-preview]');
          const rect=hint.getBoundingClientRect(), canvas=preview.getBoundingClientRect();
          const section=hint.closest('section').getBoundingClientRect();
          return {text:hint.textContent.trim(),outsideCanvas:!preview.contains(hint),
            above:rect.bottom<=canvas.top, fits:rect.left>=section.left-1&&rect.right<=section.right+1,
            bounds:{left:rect.left,right:rect.right,sectionLeft:section.left,sectionRight:section.right},
            visible:rect.width>0&&rect.height>0, noOverflow:hint.scrollWidth<=hint.clientWidth};
        })()`)
        assert.equal(layout.text, 'Правая кнопка мыши — добавить в сцену')
        assert.ok(layout.outsideCanvas && layout.above && layout.fits && layout.visible && layout.noOverflow,
          `Hint must fit above the preview without hiding scene objects at ${width}px: ${JSON.stringify(layout)}`)
      }
      win.setContentSize(1280, 800)
      await new Promise(done => setTimeout(done, 100))
      writeFileSync(resolve('tmp/pip-video-ui/scene-context-hint.png'), (await win.webContents.capturePage()).toPNG())
      await win.webContents.executeJavaScript(`(() => {
        const preview=document.querySelector('[data-program-scene-preview]');const rect=preview.getBoundingClientRect();
        preview.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:rect.left+8,clientY:rect.top+8}));
      })()`)
      await new Promise(done => setTimeout(done, 60))
      assert.deepEqual(await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[data-scene-context-menu] [data-scene-add]')).map(button=>button.textContent.trim())`),
        ['Фон','Текст','QR-код','Таймер','Добавить слой'])
      await win.webContents.executeJavaScript(`window.unmountTest();`)
      console.log('PASS: visible right-click hint at 1280/880px, outside preview/output, existing Add to Scene menu unchanged')
      clearTimeout(deadline)
      win.destroy()
      app.quit()
      return
    }
    if (!process.env.PDM_LAYER_ORDER_ONLY) {
    stage = 'reject a DPI-enlarged native PDF bitmap before it can shrink the page'
    await win.loadFile(resolve('tmp/pip-video-ui/index.html'), { search: 'pdf-native-dpi' })
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (await win.webContents.executeJavaScript('window.pdfReadyCount >= 1')) break
      await new Promise(done => setTimeout(done, 40))
    }
    const dpiFallbackPixel = await win.webContents.executeJavaScript(`(() => {
      const canvas=document.querySelector('canvas'); const data=canvas.getContext('2d').getImageData(canvas.width-2,canvas.height-2,1,1).data;
      return Array.from(data);
    })()`)
    assert.ok(
      dpiFallbackPixel[1] > 140 && dpiFallbackPixel[3] === 255,
      'An oversized native bitmap must fall back to the correctly sized PDF frame'
    )
    console.log('PASS: DPI-enlarged native PDF frames cannot shrink the visible page')
    stage = 'replace a transparent PDF page without retaining the previous page'
    await win.loadFile(resolve('tmp/pip-video-ui/index.html'), { search: 'pdf-replace' })
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (await win.webContents.executeJavaScript('window.pdfReadyCount >= 1')) break
      await new Promise(done => setTimeout(done, 40))
    }
    const firstPdfPixel = await win.webContents.executeJavaScript(`(() => {
      const canvas=document.querySelector('canvas'); const data=canvas.getContext('2d').getImageData(2,2,1,1).data;
      return Array.from(data);
    })()`)
    assert.ok(firstPdfPixel[0] > 180 && firstPdfPixel[3] === 255, 'First PDF page must paint the complete canvas')
    await win.webContents.executeJavaScript(`window.testEmit('navigate-slide', 2)`)
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (await win.webContents.executeJavaScript('window.pdfReadyCount >= 2')) break
      await new Promise(done => setTimeout(done, 40))
    }
    const replacedPdfPixels = await win.webContents.executeJavaScript(`(() => {
      const canvas=document.querySelector('canvas'); const ctx=canvas.getContext('2d');
      return {
        corner:Array.from(ctx.getImageData(2,2,1,1).data),
        center:Array.from(ctx.getImageData(Math.floor(canvas.width/2),Math.floor(canvas.height/2),1,1).data)
      };
    })()`)
    assert.equal(replacedPdfPixels.corner[3], 0, 'Transparent pixels of a new PDF page must not retain the previous page')
    assert.ok(replacedPdfPixels.center[2] > 180 && replacedPdfPixels.center[3] === 255, 'The new PDF page must be fully committed')
    console.log('PASS: transparent PDF page replacement clears the previous page atomically')
    await win.loadFile(resolve('tmp/pip-video-ui/index.html'), { search: 'preview&device' })
    await new Promise(done => setTimeout(done, 350))
    const startupRendered = await win.webContents.executeJavaScript(`document.body.innerText.includes('Сцена')`)
    if (!startupRendered) console.error(await win.webContents.executeJavaScript(`document.documentElement.outerHTML`))
    assert.equal(startupRendered, true)
    assert.deepEqual(await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[data-scene-panel]')).map(button => button.textContent.trim())`),
      ['Сцена для эфира', 'Титры'])
    stage = 'global Scene backdrop needs no chroma fill prompt'
    assert.deepEqual(await win.webContents.executeJavaScript(`({
      backdropVisible:!!document.querySelector('[data-program-scene-canvas-background]'),
      fillPrompt:Array.from(document.querySelectorAll('button')).some(button=>button.textContent.trim()==='Выберите фоновое изображение'),
      chromaFillInGeneralSettings:!!document.querySelector('[data-program-scene-background]')
    })`), {backdropVisible:true,fillPrompt:false,chromaFillInGeneralSettings:false},
      'A selected global backdrop must appear without asking for a separate chroma fill')
    console.log('PASS: selected global Scene backdrop has no chroma-fill prompt')
    stage = 'open participant context menu for chroma isolation'
    await win.webContents.executeJavaScript(`(() => {
      const preview=document.querySelector('[data-program-scene-preview]');
      const participant=document.querySelector('[data-program-scene-participant-preview]').getBoundingClientRect();
      preview.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:participant.left+participant.width/2,clientY:participant.top+participant.height/2}));
    })()`)
    await new Promise(done => setTimeout(done, 30))
    stage = 'open chroma settings for isolation'
    await win.webContents.executeJavaScript(`document.querySelector('[data-scene-object-action="chroma"]').click()`)
    await new Promise(done => setTimeout(done, 30))
    stage = 'prepare independent chroma and backdrop paths'
    await win.webContents.executeJavaScript(`(() => {
      window.testScene.backdropImage='global-backdrop-must-stay';
      window.testScene.setProgramScene({background:{...window.testScene.programScene.background,kind:'image',imagePath:null}});
    })()`)
    await new Promise(done => setTimeout(done, 30))
    stage = 'pick independent chroma image fill'
    await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-chroma-fill-image]').click()`)
    await new Promise(done => setTimeout(done, 50))
    stage = 'verify independent chroma image fill'
    assert.equal(await win.webContents.executeJavaScript(`String(window.testScene.backdropImage)`), 'global-backdrop-must-stay',
      'Choosing a chroma-key image must not replace the global Scene backdrop')
    assert.equal(await win.webContents.executeJavaScript(`String(window.testScene.programScene.background.imagePath).includes('e11d48')`), true,
      'Choosing a chroma-key image must store a dedicated fill path')
    console.log('PASS: chroma-key image fill stays independent from the global Scene backdrop')
    stage = 'hide chroma fill until an external source is selected'
    await win.loadFile(resolve('tmp/pip-video-ui/index.html'), { search: 'preview&no-participant' })
    await new Promise(done => setTimeout(done, 350))
    assert.deepEqual(await win.webContents.executeJavaScript(`({
      prompt:!!document.querySelector('[data-program-scene-select-external-source]'),
      fillMedia:!!document.querySelector('[data-program-scene-key-fill-preview] img, [data-program-scene-key-fill-preview] video')
    })`), {prompt:true,fillMedia:false},
      'A chroma fill must not occupy the participant frame before an external source is selected')
    console.log('PASS: chroma fill stays hidden without an external source')
    stage = 'default empty Scene timer to fifteen minutes'
    await win.loadFile(resolve('tmp/pip-video-ui/index.html'), { search: 'preview&device&timer-empty' })
    await new Promise(done => setTimeout(done, 350))
    await win.webContents.executeJavaScript(`(() => {
      const preview=document.querySelector('[data-program-scene-preview]'); const rect=preview.getBoundingClientRect();
      preview.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:rect.left+8,clientY:rect.top+8}));
    })()`)
    await new Promise(done => setTimeout(done, 20))
    await win.webContents.executeJavaScript(`document.querySelector('[data-scene-add="timer"]').click()`)
    await new Promise(done => setTimeout(done, 20))
    assert.deepEqual(await win.webContents.executeJavaScript(`({
      hours:document.querySelector('[aria-label="Часы таймера"]').value,
      minutes:document.querySelector('[aria-label="Минуты таймера"]').value
    })`), {hours:'0',minutes:'15'}, 'An unset Scene timer must default to fifteen minutes')
    await win.webContents.executeJavaScript(`(() => {
      const input=document.querySelector('[aria-label="Минуты таймера"]');
      const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
      setter.call(input,'5'); input.dispatchEvent(new Event('input',{bubbles:true}));
    })()`)
    await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-timer-set]').click()`)
    await new Promise(done => setTimeout(done, 50))
    assert.deepEqual(await win.webContents.executeJavaScript(`({
      preview:document.querySelector('[data-program-scene-timer-preview]')?.textContent.trim(),
      outputVisible:window.testScene.timerOutputVisible,
      outputShows:window.timerOverlayShows
    })`), {preview:'05:00',outputVisible:false,outputShows:0},
      'Set in the Scene timer must update only the preview and keep the output hidden')
    await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-timer-adjust="-10"]').click()`)
    await new Promise(done => setTimeout(done, 40))
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-timer-preview]')?.textContent.trim()`), '-05:00',
      'Subtracting past zero must keep the Scene timer visible in overtime')
    await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-picture-visible]').click()`)
    await new Promise(done => setTimeout(done, 80))
    assert.deepEqual(await win.webContents.executeJavaScript(`({
      scene:window.testScene.programScene.enabled,
      outputVisible:window.testScene.timerOutputVisible,
      outputOwner:window.testScene.timerOutputOwner,
      outputShows:window.timerOverlayShows
    })`), {scene:true,outputVisible:true,outputOwner:'scene',outputShows:0},
      'Show on air must publish the prepared Scene timer without choosing an unrelated monitor')
    await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-picture-visible]').click()`)
    await new Promise(done => setTimeout(done, 80))
    assert.deepEqual(await win.webContents.executeJavaScript(`({
      scene:window.testScene.programScene.enabled,
      outputVisible:window.testScene.timerOutputVisible,
      outputOwner:window.testScene.timerOutputOwner
    })`), {scene:false,outputVisible:false,outputOwner:null},
      'Leaving the Scene output must hide a timer published by the Scene')
    await win.webContents.executeJavaScript(`window.testScene.setTimerOutputState(true,'toolbar')`)
    await new Promise(done => setTimeout(done, 40))
    assert.deepEqual(await win.webContents.executeJavaScript(`({
      outputVisible:window.testScene.timerOutputVisible,
      outputOwner:window.testScene.timerOutputOwner
    })`), {outputVisible:true,outputOwner:'toolbar'},
      'A standalone toolbar timer must not be hidden merely because the Scene is off')
    console.log('PASS: empty Scene timer defaults to 15 minutes')
    await win.loadFile(resolve('tmp/pip-video-ui/index.html'), { search: 'preview&device' })
    await new Promise(done => setTimeout(done, 350))
    const sceneFrameScript = `(() => { const rect=document.querySelector('[data-program-scene-modal]').getBoundingClientRect(); return {x:Math.round(rect.x),y:Math.round(rect.y),width:Math.round(rect.width),height:Math.round(rect.height)}; })()`
    const sceneModalFrame = await win.webContents.executeJavaScript(sceneFrameScript)
    const picturePreviewSize = await win.webContents.executeJavaScript(`(() => { const rect=document.querySelector('[data-program-scene-preview]').getBoundingClientRect(); return {width:Math.round(rect.width),height:Math.round(rect.height)}; })()`)
    stage = 'move and scale running timer in Scene preview'
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-timer-preview]').textContent.trim()`), '07:00',
      'A configured talk timer must be visible in the unified Scene preview')
    await win.webContents.executeJavaScript(`(() => {
      const preview=document.querySelector('[data-program-scene-preview]'); const rect=preview.getBoundingClientRect();
      preview.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:rect.left+8,clientY:rect.top+8}));
    })()`)
    await new Promise(done => setTimeout(done, 20))
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-scene-add="timer"]').textContent.trim()`), 'Таймер',
      'Scene context menu must offer Add to Scene — Timer')
    await win.webContents.executeJavaScript(`document.querySelector('[data-scene-add="timer"]').click()`)
    await new Promise(done => setTimeout(done, 20))
    assert.equal(await win.webContents.executeJavaScript(`!!document.querySelector('[data-program-scene-timer-settings]')`), true,
      'Add to Scene — Timer must open the full timer settings')
    const timerWheelCancelled = await win.webContents.executeJavaScript(`(() => {
      const timer=document.querySelector('[data-program-scene-timer-preview]');
      const wheel=new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:-120});
      timer.dispatchEvent(wheel);
      return wheel.defaultPrevented;
    })()`)
    await new Promise(done => setTimeout(done, 40))
    assert.equal(timerWheelCancelled, true, 'Timer wheel scaling must not scroll the Scene window')
    assert.equal(await win.webContents.executeJavaScript(`window.testScene.timerOverlayScale`), 1,
      'Wheel scaling in Scene preview must remain a draft before refresh')
    assert.equal(await win.webContents.executeJavaScript(`Number(document.querySelector('[data-program-scene-timer-preview]').dataset.timerScale)`), 1.1,
      'Wheel up over the timer must increase its Scene preview scale')
    assert.equal(await win.webContents.executeJavaScript(`!!document.querySelector('[data-program-scene-timer-settings]')`), true,
      'Selecting the timer must open its contextual settings to the right of the preview')
    assert.deepEqual(await win.webContents.executeJavaScript(`(() => ({
      time:!!document.querySelector('[data-program-scene-timer-time]'),
      tabs:Array.from(document.querySelectorAll('[data-program-scene-timer-tab]')).map(button=>button.textContent.trim())
    }))()`), {time:true,tabs:['Время','Положение и вид','Звуки']},
      'Scene timer settings must expose clearly named sections and open on time controls')
    const liveRemainingBeforeDraft = await win.webContents.executeJavaScript(`window.testScene.timerRemaining`)
    const liveOutputShowsBeforeDraft = await win.webContents.executeJavaScript(`window.timerOverlayShows`)
    await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-timer-adjust="5"]').click()`)
    await new Promise(done => setTimeout(done, 40))
    assert.deepEqual(await win.webContents.executeJavaScript(`({
      preview:document.querySelector('[data-program-scene-timer-preview]').textContent.trim(),
      liveRemaining:window.testScene.timerRemaining,
      outputVisible:window.testScene.timerOutputVisible,
      outputShows:window.timerOverlayShows
    })`), {
      preview:'12:00',
      liveRemaining:liveRemainingBeforeDraft,
      outputVisible:true,
      outputShows:liveOutputShowsBeforeDraft
    }, 'Adding five minutes in the Scene must change only the preview and keep the current timer on air')
    await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-timer-tab="sound"]').click()`)
    await new Promise(done => setTimeout(done, 20))
    assert.deepEqual(await win.webContents.executeJavaScript(`(() => {
      const panel=document.querySelector('[data-program-scene-timer-settings]');
      const sounds=Array.from(panel.querySelectorAll('[data-program-scene-timer-sound]'));
      const panelRect=panel.getBoundingClientRect(); const lastRect=sounds.at(-1).getBoundingClientRect();
      return {sounds:sounds.map(item=>item.dataset.programSceneTimerSound),fullyVisible:lastRect.bottom<=panelRect.bottom+1};
    })()`), {sounds:['warning','end'],fullyVisible:true},
      'Both Scene timer sound selectors must be fully visible in the Sound section')
    const timerPositionBeforeDrag = await win.webContents.executeJavaScript(`({...window.testScene.timerOverlayPosition})`)
    const timerPreviewPositionBeforeDrag = await win.webContents.executeJavaScript(`(() => { const timer=document.querySelector('[data-program-scene-timer-preview]'); return {left:timer.style.left,top:timer.style.top}; })()`)
    await win.webContents.executeJavaScript(`(() => {
      const timer=document.querySelector('[data-program-scene-timer-preview]');
      const layer=document.querySelector('[data-program-scene-timer-layer]');
      const preview=document.querySelector('[data-program-scene-preview]').getBoundingClientRect();
      const rect=timer.getBoundingClientRect();
      const pointerId=17;
      timer.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,button:0,pointerId,clientX:rect.left+rect.width/2,clientY:rect.top+rect.height/2}));
      layer.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,cancelable:true,pointerId,clientX:preview.left+preview.width*.35,clientY:preview.top+preview.height*.3}));
      layer.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,pointerId,clientX:preview.left+preview.width*.35,clientY:preview.top+preview.height*.3}));
    })()`)
    await new Promise(done => setTimeout(done, 40))
    const timerPositionAfterDrag = await win.webContents.executeJavaScript(`({...window.testScene.timerOverlayPosition})`)
    const timerPreviewPositionAfterDrag = await win.webContents.executeJavaScript(`(() => { const timer=document.querySelector('[data-program-scene-timer-preview]'); return {left:timer.style.left,top:timer.style.top}; })()`)
    assert.deepEqual(timerPositionAfterDrag, timerPositionBeforeDrag,
      'Dragging the timer in Scene preview must not update its on-air position before refresh')
    assert.notDeepEqual(timerPreviewPositionAfterDrag, timerPreviewPositionBeforeDrag,
      'Dragging the timer must update its local Scene preview position')
    await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-refresh]').click()`)
    await new Promise(done => setTimeout(done, 40))
    const publishedTimer = await win.webContents.executeJavaScript(`({position:{...window.testScene.timerOverlayPosition},scale:window.testScene.timerOverlayScale})`)
    assert.equal(publishedTimer.scale, 1.1, 'Scene refresh must publish the drafted timer scale')
    assert.ok(publishedTimer.position.x >= 0 && publishedTimer.position.x <= 100 && publishedTimer.position.y >= 0 && publishedTimer.position.y <= 100,
      'Published timer position must stay inside the Scene')
    assert.notDeepEqual(publishedTimer.position, timerPositionBeforeDrag,
      'Scene refresh must publish the drafted timer position')
    assert.ok(await win.webContents.executeJavaScript(`window.testScene.timerRemaining`) >= liveRemainingBeforeDraft + 299,
      'Scene refresh must publish the drafted +5 minutes to the on-air timer')
    console.log('PASS: Scene timer edits stay local, open contextual settings, and publish on refresh')
    await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-preview]').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,button:0,pointerId:19}))`)
    await new Promise(done => setTimeout(done, 20))
    const keyFillGeometry = await win.webContents.executeJavaScript(`(() => {
      const preview=document.querySelector('[data-program-scene-preview]').getBoundingClientRect();
      const participant=document.querySelector('[data-program-scene-participant-preview]').getBoundingClientRect();
      const fill=document.querySelector('[data-program-scene-key-fill-preview]').getBoundingClientRect();
      const canvasBackground=document.querySelector('[data-program-scene-canvas-background]').getBoundingClientRect();
      const compact=rect=>({x:Math.round(rect.x),y:Math.round(rect.y),width:Math.round(rect.width),height:Math.round(rect.height)});
      return {preview:compact(preview),participant:compact(participant),fill:compact(fill),canvasBackground:compact(canvasBackground)};
    })()`)
    assert.ok(
      Math.abs(keyFillGeometry.canvasBackground.x-keyFillGeometry.preview.x)<=1 &&
      Math.abs(keyFillGeometry.canvasBackground.y-keyFillGeometry.preview.y)<=1 &&
      Math.abs(keyFillGeometry.canvasBackground.width-keyFillGeometry.preview.width)<=2 &&
      Math.abs(keyFillGeometry.canvasBackground.height-keyFillGeometry.preview.height)<=2,
      'Selected backdrop must fill the complete Scene preview canvas'
    )
    assert.deepEqual(keyFillGeometry.fill, keyFillGeometry.participant,
      'Picture/video/channel fill must be clipped to the participant camera frame in preview')
    assert.ok(keyFillGeometry.fill.width < keyFillGeometry.preview.width && keyFillGeometry.fill.height < keyFillGeometry.preview.height,
      'Chroma fill must not cover the complete Scene preview')
    await win.webContents.executeJavaScript(`window.testScene.backdropImage=null; window.testScene.setProgramScene({})`)
    await new Promise(done => setTimeout(done, 20))
    const sizeButtons = await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[data-scene-size]')).map(button => ({
      text: button.textContent.trim(), clientWidth: button.clientWidth, scrollWidth: button.scrollWidth,
      top: Math.round(button.getBoundingClientRect().top), background: getComputedStyle(button).backgroundColor
    }))`)
    assert.deepEqual(sizeButtons.map(button => button.text), ['Меньше', 'Средний', 'Больше', 'Пополам'])
    assert.equal(new Set(sizeButtons.map(button => button.top)).size, 2, 'Participant sizes must use a clear 2×2 grid')
    assert.ok(sizeButtons.every(button => button.scrollWidth <= button.clientWidth), 'Participant size labels must fit completely')
    assert.notEqual(sizeButtons[1].background, 'rgba(0, 0, 0, 0)', 'Selected participant size must fill the complete button')
    const pictureBarTop = await win.webContents.executeJavaScript(`(() => { const modal=document.querySelector('[data-program-scene-modal]').getBoundingClientRect(); const bar=document.querySelector('[data-scene-air-bar]').getBoundingClientRect(); return Math.round(bar.top-modal.top); })()`)
    assert.match(await win.webContents.executeJavaScript(`document.querySelector('[data-scene-air-status]').textContent.trim()`), /^Сцена (?:в эфире|скрыта)$/)
    assert.deepEqual(await win.webContents.executeJavaScript(`(() => { const control=document.querySelector('[data-program-scene-picture-visible]'); return {tag:control?.tagName,inputCount:control?.querySelectorAll('input').length,red:control?.className.includes('bg-red')}; })()`),
      {tag:'BUTTON',inputCount:0,red:true}, 'Picture Show on air must be a red button, not a checkbox')
    assert.deepEqual(await win.webContents.executeJavaScript(`(() => { const refresh=document.querySelector('[data-program-scene-refresh]'); const show=document.querySelector('[data-program-scene-picture-visible]'); return {tag:refresh?.tagName,round:refresh?.className.includes('rounded-full'),afterShow:show?.nextElementSibling===refresh,enabled:!refresh?.disabled}; })()`),
      {tag:'BUTTON',round:true,afterShow:true,enabled:true}, 'Scene refresh must be a round button immediately after Show on air')
    stage = 'external source context actions and camera-free Scene'
    await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-participant-preview]').click()`)
    await new Promise(done => setTimeout(done, 30))
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-scene-external-source="device:video"]').textContent.includes('Synthetic camera')`), true,
      'Left-clicking the current external-source window must open the source picker')
    await win.webContents.executeJavaScript(`document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`)
    await new Promise(done => setTimeout(done, 30))
    const participantScaleBeforeWheel = await win.webContents.executeJavaScript(`window.testScene.programScene.participantScale`)
    const cameraWheelCancelled = await win.webContents.executeJavaScript(`(() => {
      const participant=document.querySelector('[data-program-scene-participant-preview]');
      const wheel=new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:-120});
      participant.dispatchEvent(wheel);
      return wheel.defaultPrevented;
    })()`)
    await new Promise(done => setTimeout(done, 40))
    assert.equal(cameraWheelCancelled, true, 'Camera-height wheel must not scroll the Scene window')
    assert.deepEqual(await win.webContents.executeJavaScript(`({
      scale:window.testScene.programScene.participantScale,
      slider:Number(document.querySelector('[data-program-scene-participant-scale]').value)
    })`), {scale:Math.min(2.5,participantScaleBeforeWheel+0.05),slider:Math.round(Math.min(2.5,participantScaleBeforeWheel+0.05)*100)},
      'Wheel up over the external source must change the same camera-height value as the settings slider')
    await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-participant-preview]').dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:120}))`)
    await new Promise(done => setTimeout(done, 30))
    await win.webContents.executeJavaScript(`(() => {
      const preview=document.querySelector('[data-program-scene-preview]');
      const participant=document.querySelector('[data-program-scene-participant-preview]').getBoundingClientRect();
      preview.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:participant.left+participant.width/2,clientY:participant.top+participant.height/2}));
    })()`)
    await new Promise(done => setTimeout(done, 40))
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-scene-external-source-picker]')`), null,
      'Right-clicking the external source must not open the source picker')
    assert.deepEqual(await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[data-scene-object-action]')).map(button=>button.textContent.trim())`),
      ['Хромакей','Скрыть'], 'Right-clicking the current external source must expose Chroma key and keep the red Hide action')
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-scene-object-action="hide"]').className.includes('bg-red')`), true)
    await win.webContents.executeJavaScript(`document.querySelector('[data-scene-object-action="chroma"]').click()`)
    await new Promise(done => setTimeout(done, 40))
    assert.deepEqual(await win.webContents.executeJavaScript(`({
      chroma:!!document.querySelector('[data-program-scene-chroma]'),
      participantPosition:document.body.innerText.includes('Положение участника'),
      participantSize:document.body.innerText.includes('Размер участника'),
      backgroundSettings:!!document.querySelector('[data-program-scene-background]'),
      backgroundKinds:Array.from(document.querySelectorAll('[data-scene-background-kind]')).map(button=>button.dataset.sceneBackgroundKind)
    })`), {chroma:true,participantPosition:false,participantSize:false,backgroundSettings:true,backgroundKinds:['image','video','channel']},
      'Contextual Chroma editor must contain chroma-key controls and its picture/video/channel fill')
    await win.webContents.executeJavaScript(`(() => {
      const preview=document.querySelector('[data-program-scene-preview]');
      const participant=document.querySelector('[data-program-scene-participant-preview]').getBoundingClientRect();
      preview.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:participant.left+participant.width/2,clientY:participant.top+participant.height/2}));
    })()`)
    await new Promise(done => setTimeout(done, 30))
    await win.webContents.executeJavaScript(`document.querySelector('[data-scene-object-action="hide"]').click()`)
    await new Promise(done => setTimeout(done, 40))
    assert.deepEqual(await win.webContents.executeJavaScript(`({capture:window.testScene.programScene.captureSourceId,enabled:window.testScene.programScene.enabled})`),
      {capture:null,enabled:true}, 'Hiding the external source must not stop an already running Scene')
    await win.webContents.executeJavaScript(`(() => { window.testScene.backdropImage='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="960" height="540" fill="#7c3aed"/></svg>'); window.testScene.setProgramScene({enabled:false}); })()`)
    await new Promise(done => setTimeout(done, 40))
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-picture-visible]').disabled`), false,
      'Scene must be startable without an external source')
    await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-picture-visible]').click()`)
    await new Promise(done => setTimeout(done, 50))
    assert.equal(await win.webContents.executeJavaScript(`window.testScene.programScene.enabled`), true,
      'Show on air must enable a camera-free Scene')
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-select-external-source]').textContent.trim()`), 'Выберите внешний источник')
    await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-select-external-source]').click()`)
    await new Promise(done => setTimeout(done, 30))
    assert.equal(await win.webContents.executeJavaScript(`!!document.querySelector('[data-scene-external-source-picker]')`), true,
      'Clicking the preview placeholder must open the external-source context menu')
    assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('[data-scene-context-menu] [data-scene-add]').length`), 0,
      'The left-click external-source chooser must not contain unrelated add actions')
    await win.webContents.executeJavaScript(`document.querySelector('[data-scene-external-source="device:video"]').click()`)
    await new Promise(done => setTimeout(done, 30))
    assert.equal(await win.webContents.executeJavaScript(`window.testScene.programScene.captureSourceId`), 'camera',
      'Choosing a camera in the Scene context menu must update the participant source')
    await win.webContents.executeJavaScript(`(() => { window.testScene.backdropImage=null; window.testScene.setProgramScene({captureSourceId:'camera',enabled:true}); })()`)
    await new Promise(done => setTimeout(done, 40))
    stage = 'choose presentation channel from Scene content area'
    await win.webContents.executeJavaScript(`(() => {
      const frame='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="960" height="540" fill="#22c55e"/></svg>');
      window.testScene.channels={A:{file:{id:'deck',name:'deck.pptx',path:'C:/presentations/deck.pptx',type:'presentation',extension:'.pptx',size:1},slide:1,totalSlides:1,videoEndChannel:null,caption:'Главный доклад'}};
      window.testScene.channelIds=['A']; window.testScene.pptxSlidesMap={'C:/presentations/deck.pptx':[frame]}; window.testScene.setProgramScene({});
    })()`)
    await new Promise(done => setTimeout(done, 40))
    await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-select-content]').click()`)
    await new Promise(done => setTimeout(done, 30))
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-scene-content-channel="A"]').textContent.includes('Главный доклад')`), true,
      'Left-clicking the empty presentation area must open the channel chooser')
    assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('[data-scene-context-menu] [data-scene-add]').length`), 0,
      'The left-click presentation chooser must not contain unrelated add actions')
    await win.webContents.executeJavaScript(`document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`)
    await new Promise(done => setTimeout(done, 30))
    await win.webContents.executeJavaScript(`(() => { const content=document.querySelector('.pdm-pip-content-preview').getBoundingClientRect(); document.querySelector('[data-program-scene-preview]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:content.left+content.width/2,clientY:content.top+content.height/2})); })()`)
    await new Promise(done => setTimeout(done, 30))
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-scene-content-channel="A"]').textContent.includes('Главный доклад')`), true,
      'Scene content menu must prefer the manually entered channel caption')
    await win.webContents.executeJavaScript(`document.querySelector('[data-scene-content-channel="A"]').click()`)
    await new Promise(done => setTimeout(done, 50))
    assert.equal(await win.webContents.executeJavaScript(`window.testScene.selectedChannel`), 'A',
      'Choosing content in Scene must select the channel without taking it on air')
    assert.deepEqual(await win.webContents.executeJavaScript(`window.sceneTakeChannels`), [],
      'Choosing content for preview alone must not take the channel on air')
    assert.equal(await win.webContents.executeJavaScript(`!!document.querySelector('.pdm-pip-content-preview img')`), true,
      'Chosen presentation channel must appear in Scene preview')
    await win.webContents.executeJavaScript(`(() => { window.testScene.backdropImage='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="960" height="540" fill="#7c3aed"/></svg>'); window.testScene.setProgramScene({enabled:false}); })()`)
    await new Promise(done => setTimeout(done, 40))
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-picture-visible]').textContent.trim()`), 'Показать в эфире')
    await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-picture-visible]').click()`)
    await new Promise(done => setTimeout(done, 300))
    assert.deepEqual(await win.webContents.executeJavaScript(`window.sceneTakeChannels`), ['A'],
      'Showing the Scene on air must take its explicitly chosen channel through the regular channel path')
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-picture-visible]').textContent.trim()`), 'Выйти из эфира',
      'An active Scene button must change its label to Exit air')
    stage = 'check unified Scene context editor'
    await win.webContents.executeJavaScript(`(() => {
      const preview=document.querySelector('[data-program-scene-preview]');
      const rect=preview.getBoundingClientRect();
      preview.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:rect.left+rect.width*.55,clientY:rect.top+rect.height*.4}));
    })()`)
    await new Promise(done => setTimeout(done, 30))
    assert.deepEqual(await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[data-scene-context-menu] [data-scene-add]')).map(button=>button.textContent.trim())`),
      ['Фон','Текст','QR-код','Таймер','Добавить слой'], 'Scene context menu must put every add action at the top and keep source selection out of right click')
    await win.webContents.executeJavaScript(`document.querySelector('[data-scene-add="text"]').click()`)
    await new Promise(done => setTimeout(done, 40))
    assert.equal(await win.webContents.executeJavaScript(`!!document.querySelector('[data-program-scene-text-id]') && !!document.querySelector('[data-program-scene-text-input]')`), true,
      'A text object added on the Scene canvas must appear there and open its settings')
    stage = 'edit text directly on Scene canvas and refresh program'
    await win.webContents.executeJavaScript(`(() => { const inline=document.querySelector('[data-program-scene-inline-text]'); inline.focus(); inline.textContent=''; inline.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContent'})); })()`)
    for (const character of 'Мероприятие 2026') {
      win.webContents.insertText(character)
      await new Promise(done => setTimeout(done, 4))
    }
    await new Promise(done => setTimeout(done, 80))
    stage = 'verify text Scene draft after inline typing'
    assert.equal(await win.webContents.executeJavaScript(`window.testScene.programScene.textOverlays.length`), 0,
      'Direct typing in preview must remain a draft before refresh')
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-inline-text]').innerText`), 'Мероприятие 2026',
      'Sequential typing must keep the caret at the end instead of reversing text')
    stage = 'resize text directly on Scene canvas'
    const textWidthBefore = await win.webContents.executeJavaScript(`(() => {
      const text=document.querySelector('[data-program-scene-text-id]'); const before=parseFloat(text.style.width);
      const handle=document.querySelector('[data-program-scene-text-resize]'); const rect=handle.getBoundingClientRect();
      handle.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:27,button:0,buttons:1,clientX:rect.left+2,clientY:rect.top+4}));
      handle.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:27,buttons:1,clientX:rect.left+82,clientY:rect.top+4}));
      handle.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:27,clientX:rect.left+82,clientY:rect.top+4}));
      return before;
    })()`)
    await new Promise(done => setTimeout(done, 40))
    assert.ok(await win.webContents.executeJavaScript(`parseFloat(document.querySelector('[data-program-scene-text-id]').style.width)`) > textWidthBefore,
      'Text width must resize directly on the Scene preview')
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-text-drag]')`), null,
      'Text must not have a separate move icon covering its first letters')
    stage = 'drag text directly on Scene canvas'
    await win.webContents.executeJavaScript(`(() => {
      const preview=document.querySelector('[data-program-scene-preview]').getBoundingClientRect();
      const text=document.querySelector('[data-program-scene-text-id]'); const rect=text.getBoundingClientRect();
      text.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:28,button:0,buttons:1,clientX:rect.left+4,clientY:rect.top+4}));
      text.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:28,buttons:1,clientX:preview.left+4,clientY:preview.top+4}));
      text.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:28,clientX:preview.left+4,clientY:preview.top+4}));
    })()`)
    await new Promise(done => setTimeout(done, 40))
    assert.ok(await win.webContents.executeJavaScript(`parseFloat(document.querySelector('[data-program-scene-text-id]').style.left)`) < 1,
      'Dragging the text itself must move it into the preview corner without a handle')
    stage = 'open text object context menu'
    await win.webContents.executeJavaScript(`(() => { const text=document.querySelector('[data-program-scene-text-id]'); const rect=text.getBoundingClientRect(); text.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:rect.left+5,clientY:rect.top+5})); })()`)
    await new Promise(done => setTimeout(done, 30))
    assert.deepEqual(await win.webContents.executeJavaScript(`Array.from(document.querySelector('[data-scene-context-menu]').children).map(element=>element.textContent.trim()).filter(text=>text==='Добавить в сцену'||text==='Настроить')`),
      ['Добавить в сцену','Настроить'], 'Add section must stay above object actions and Configure must stay at the bottom')
    assert.deepEqual(await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[data-scene-object-action]')).map(button=>button.textContent.trim())`), ['Скрыть'],
      'Text context menu must expose Hide')
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-scene-object-action="hide"]').className.includes('bg-red')`), true)
    await win.webContents.executeJavaScript(`document.querySelector('[data-scene-context-menu]').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})); document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`)
    await new Promise(done => setTimeout(done, 30))
    stage = 'refresh direct text Scene edits'
    await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-refresh]').click()`)
    await new Promise(done => setTimeout(done, 80))
    const refreshedText = await win.webContents.executeJavaScript(`({draft:window.testScene.programScene.textOverlays,snapshot:window.testScene.programSnapshot?.scene?.textOverlays,status:window.testScene.programOutputStatus,disabled:document.querySelector('[data-program-scene-refresh]')?.disabled})`)
    assert.equal(refreshedText.draft[0]?.text, 'Мероприятие 2026',
      'Scene refresh must publish direct preview edits')
    assert.ok(refreshedText.draft[0]?.widthPercent > 34,
      'Scene refresh must publish text width changed directly in preview')
    stage = 'remove refreshed Scene text object'
    await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()==='Удалить')?.click()`)
    await new Promise(done => setTimeout(done, 30))
    stage = 'refresh after removing Scene text object'
    await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-refresh]')?.click()`)
    await new Promise(done => setTimeout(done, 50))
    stage = 'verify removed Scene text object'
    assert.equal(await win.webContents.executeJavaScript(`window.testScene.programScene.textOverlays?.length ?? -1`), 0,
      'Refreshing after removing a text object must remove it from program output')
    await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-preview]').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`)
    await new Promise(done => setTimeout(done, 30))
    assert.equal(await win.webContents.executeJavaScript(`!!document.querySelector('[data-program-scene-participant-source]')`), true,
      'Clicking an empty canvas area must return to Scene settings')
    await win.webContents.executeJavaScript(`(() => { window.testScene.backdropImage='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="960" height="540" fill="#7c3aed"/></svg>'); window.testScene.setProgramScene({}); })()`)
    await new Promise(done => setTimeout(done, 30))
    await win.webContents.executeJavaScript(`(() => { const preview=document.querySelector('[data-program-scene-preview]'); const rect=preview.getBoundingClientRect(); preview.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:rect.left+rect.width*.02,clientY:rect.top+rect.height*.96})); })()`)
    await new Promise(done => setTimeout(done, 30))
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-scene-context-menu]').firstElementChild.textContent.trim()`), 'Добавить в сцену',
      'Add to Scene must be the first section of the context menu')
    await win.webContents.executeJavaScript(`window.testScene.backdropImage=null; document.querySelector('[data-scene-add="background"]').click()`)
    await new Promise(done => setTimeout(done, 50))
    assert.deepEqual(await win.webContents.executeJavaScript(`({opens:window.backdropPickerOpens,selected:window.testScene.backdropImage?.includes('#e11d48')||window.testScene.backdropImage?.includes('%23e11d48'),fill:window.testScene.programScene.background.imagePath??null})`),
      {opens:1,selected:true,fill:null}, 'Background in Add to Scene must select only the global backdrop')
    await win.webContents.executeJavaScript(`window.testScene.backdropImage=null; window.testScene.setProgramScene({})`)
    await new Promise(done => setTimeout(done, 30))
    stage = 'check chroma key controls'
    await win.webContents.executeJavaScript(`(() => {
      const preview=document.querySelector('[data-program-scene-preview]');
      const participant=document.querySelector('[data-program-scene-participant-preview]').getBoundingClientRect();
      preview.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:participant.left+participant.width/2,clientY:participant.top+participant.height/2}));
    })()`)
    await new Promise(done => setTimeout(done, 30))
    await win.webContents.executeJavaScript(`document.querySelector('[data-scene-object-action="chroma"]').click()`)
    await new Promise(done => setTimeout(done, 30))
    const backgroundKinds = await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[data-scene-background-kind]')).map(button => ({kind:button.dataset.sceneBackgroundKind,text:button.textContent.trim(),top:Math.round(button.getBoundingClientRect().top),fits:button.scrollWidth<=button.clientWidth}))`)
    assert.deepEqual(backgroundKinds.map(item => item.kind), ['image','video','channel'], 'Chroma settings must expose image, video and channel fill types')
    assert.equal(new Set(backgroundKinds.map(item => item.top)).size, 1, 'Chroma fill type buttons must stay on one compact row')
    assert.ok(backgroundKinds.every(item => item.fits), 'Every chroma fill type label must fit completely')
    for (const kind of ['video','channel','image']) {
      await win.webContents.executeJavaScript(`document.querySelector('[data-scene-background-kind="${kind}"]').click()`)
      await new Promise(done => setTimeout(done, 30))
      assert.equal(await win.webContents.executeJavaScript(`window.testScene.programScene.background.kind`), kind)
    }
    await win.webContents.executeJavaScript(`(() => {
      window.testScene.backdropImage='global-backdrop-must-stay';
      window.testScene.setProgramScene({background:{...window.testScene.programScene.background,kind:'image',imagePath:null}});
    })()`)
    await new Promise(done => setTimeout(done, 30))
    await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-chroma-fill-image]').click()`)
    await new Promise(done => setTimeout(done, 50))
    assert.deepEqual(await win.webContents.executeJavaScript(`({
      opens:window.backdropPickerOpens,
      backdrop:window.testScene.backdropImage,
      fillSelected:Boolean(window.testScene.programScene.background.imagePath?.includes('#e11d48')||window.testScene.programScene.background.imagePath?.includes('%23e11d48'))
    })`), {opens:2,backdrop:'global-backdrop-must-stay',fillSelected:true},
      'Choosing a chroma-key image must not replace the global Scene backdrop')
    assert.deepEqual(await win.webContents.executeJavaScript(`(() => {
      const panel=document.querySelector('[data-program-scene-chroma]');
      return {
        panel:!!panel,
        toggleDisabled:document.querySelector('[data-program-scene-chroma-toggle]').disabled,
        picker:!!document.querySelector('[data-program-scene-chroma-picker]'),
        presets:Array.from(document.querySelectorAll('[data-program-scene-chroma-preset]')).map(button=>button.dataset.programSceneChromaPreset),
        controls:Array.from(document.querySelectorAll('[data-program-scene-chroma-control]')).map(input=>input.dataset.programSceneChromaControl),
        fits:panel.scrollHeight<=panel.clientHeight && document.querySelector('[data-program-scene-modal]').scrollHeight<=document.querySelector('[data-program-scene-modal]').clientHeight
      };
    })()`), {
      panel:true,toggleDisabled:false,picker:true,presets:['green','blue'],controls:['tolerance','softness','spill'],fits:true
    }, 'Camera Scene must expose compact chroma key controls without scrolling')
    await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-chroma-preset="blue"]').click()`)
    await new Promise(done => setTimeout(done, 40))
    for (const [key, value] of [['tolerance','41'],['softness','22'],['spill','63']]) {
      await win.webContents.executeJavaScript(`(() => {
        const input=document.querySelector('[data-program-scene-chroma-control="${key}"]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'${value}');
        input.dispatchEvent(new Event('input',{bubbles:true}));
      })()`)
      await new Promise(done => setTimeout(done, 30))
    }
    assert.deepEqual(await win.webContents.executeJavaScript(`window.testScene.programScene.chromaKey`), {
      enabled:true,color:'#1769e0',tolerance:41,softness:22,spill:63
    }, 'Chroma settings must update the prepared/live Scene state immediately')
    stage = 'pick chroma key color from preview'
    await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-chroma-picker]').click()`)
    await new Promise(done => setTimeout(done, 50))
    assert.equal(await win.webContents.executeJavaScript(`!!document.querySelector('[data-chroma-key-picker-surface]')`), true,
      'Eyedropper must make the camera preview selectable')
    await win.webContents.executeJavaScript(`(() => {
      const surface=document.querySelector('[data-chroma-key-picker-surface]');
      const rect=surface.getBoundingClientRect();
      surface.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:rect.left+rect.width*.25,clientY:rect.top+rect.height*.5}));
    })()`)
    await new Promise(done => setTimeout(done, 120))
    assert.equal(await win.webContents.executeJavaScript(`window.testScene.programScene.chromaKey.color`), '#20c060',
      'Eyedropper must sample the original camera frame')
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-chroma-key-picker-surface]') === null`), true,
      'Eyedropper must close after choosing a color')
    assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('[data-chroma-key-canvas="preview"]')).opacity`), '1',
      'Preview must switch to the GPU chroma surface')
    writeFileSync(resolve('tmp/pip-video-ui/scene-chroma-key-layout.png'), (await win.webContents.capturePage()).toPNG())
    stage = 'check independent media layers'
    await win.webContents.executeJavaScript(`(() => {
      const preview=document.querySelector('[data-program-scene-preview]'); const rect=preview.getBoundingClientRect();
      preview.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:rect.left+2,clientY:rect.top+2}));
    })()`)
    await new Promise(done => setTimeout(done, 30))
    await win.webContents.executeJavaScript(`document.querySelector('[data-scene-add="layer"]').click()`)
    await new Promise(done => setTimeout(done, 40))
    assert.equal(await win.webContents.executeJavaScript(`!!document.querySelector('[data-program-scene-media-editor]')`), true,
      'Adding a layer from the Scene context menu must open its editor')
    assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('[data-program-scene-media-id]').length >= 1`), true,
      'An image layer must appear in the preview')
    assert.equal(await win.webContents.executeJavaScript(`!!document.querySelector('[data-program-scene-media-resize]')`), true,
      'Selected media layer must expose a direct mouse resize handle')
    await win.webContents.executeJavaScript(`(() => { const layer=document.querySelector('[data-program-scene-media-id]'); const rect=layer.getBoundingClientRect(); layer.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:rect.left+5,clientY:rect.top+5})); })()`)
    await new Promise(done => setTimeout(done, 30))
    assert.deepEqual(await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[data-scene-object-action]')).map(button=>button.textContent.trim())`),
      ['Выше','Ниже','Скрыть'], 'Media-layer context menu must expose Up, Down and Hide')
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-scene-object-action="hide"]').className.includes('bg-red')`), true)
    await win.webContents.executeJavaScript(`document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`)
    await new Promise(done => setTimeout(done, 30))
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-media-editor]').innerText.includes('Над презентацией')`), true)
    await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[data-program-scene-media-editor] button')).find(button => button.textContent.trim()==='Ниже').click()`)
    await new Promise(done => setTimeout(done, 30))
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-media-editor]').innerText.includes('Под презентацией')`), true,
      'Down must move a layer through the fixed Presentation level')
    assert.deepEqual(await win.webContents.executeJavaScript(`(() => {
      const layer=document.querySelector('[data-program-scene-media-id]');
      const content=document.querySelector('.pdm-pip-content-preview');
      return {layerZ:getComputedStyle(layer).zIndex,contentZ:getComputedStyle(content).zIndex,surface:layer.parentElement.dataset.programSceneMediaSurface};
    })()`), {layerZ:'1',contentZ:'2',surface:'all'},
      'Preview layer must stack below the presentation before any publication')
    await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[data-program-scene-media-editor] button')).find(button => button.textContent.trim()==='Выше').click()`)
    await new Promise(done => setTimeout(done, 30))
    const scaleBefore = await win.webContents.executeJavaScript(`Number(document.querySelector('[data-program-scene-media-editor] input[type="range"]').value)`)
    await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-media-id]').dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:-100}))`)
    await new Promise(done => setTimeout(done, 40))
    const scaleAfter = await win.webContents.executeJavaScript(`Number(document.querySelector('[data-program-scene-media-editor] input[type="range"]').value)`)
    assert.ok(scaleAfter > scaleBefore, 'Mouse wheel up must enlarge the selected media layer')
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-modal]').scrollHeight<=document.querySelector('[data-program-scene-modal]').clientHeight`), true,
      'Layers editor must fit without modal scrolling')
    await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-picture-visible]').click()`)
    await new Promise(done => setTimeout(done, 80))
    await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-picture-visible]').click()`)
    await new Promise(done => setTimeout(done, 40))
    assert.deepEqual(await win.webContents.executeJavaScript(`({visible:window.testScene.programScene.mediaLayersVisible,count:window.testScene.programScene.mediaLayers.length})`), {visible:true,count:1},
      'Show on air must commit prepared media layers as one operation')
    await win.webContents.executeJavaScript(`new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))`)
    win.webContents.invalidate()
    await new Promise(done => setTimeout(done, 120))
    writeFileSync(resolve('tmp/pip-video-ui/scene-media-layers-layout.png'), (await win.webContents.capturePage()).toPNG())
    stage = 'recover a hidden Scene layer from the canvas context menu'
    await win.webContents.executeJavaScript(`(() => { const layer=document.querySelector('[data-program-scene-media-id]'); const rect=layer.getBoundingClientRect(); layer.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:rect.left+5,clientY:rect.top+5})); })()`)
    await new Promise(done => setTimeout(done, 30))
    await win.webContents.executeJavaScript(`document.querySelector('[data-scene-object-action="hide"]').click()`)
    await new Promise(done => setTimeout(done, 30))
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-media-id]') === null`), true,
      'A hidden layer must disappear from the canvas')
    await win.webContents.executeJavaScript(`(() => {
      const preview=document.querySelector('[data-program-scene-preview]'); const rect=preview.getBoundingClientRect();
      preview.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:rect.left+2,clientY:rect.top+2}));
    })()`)
    await new Promise(done => setTimeout(done, 30))
    assert.equal(await win.webContents.executeJavaScript(`!!document.querySelector('[data-scene-manage="layers"]')`), true,
      'Canvas context menu must keep access to hidden and under-presentation layers')
    await win.webContents.executeJavaScript(`document.querySelector('[data-scene-manage="layers"]').click()`)
    await new Promise(done => setTimeout(done, 30))
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-media-editor]').innerText.includes('(скрыт)')`), true,
      'Scene layers manager must identify the hidden layer')
    assert.equal(await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[data-program-scene-media-editor] button')).find(button=>button.textContent.trim()==='Слой скрыт').className.includes('bg-amber-500')`), true,
      'Hidden layer must have an amber visibility button')
    await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[data-program-scene-media-editor] button')).find(button=>button.textContent.trim()==='Слой скрыт').click()`)
    await new Promise(done => setTimeout(done, 30))
    assert.equal(await win.webContents.executeJavaScript(`!!document.querySelector('[data-program-scene-media-id]')`), true,
      'A hidden layer must be restorable without finding it behind the presentation')
    await win.webContents.executeJavaScript(`document.querySelector('[data-scene-panel="titles"]').click()`)
    await new Promise(done => setTimeout(done, 50))
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-scene-panel="titles"]').getAttribute('aria-selected')`), 'true',
      'Titles tab must become selected')
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-scene-editor="titles"]').hidden`), false,
      'Titles editor must live inside Scene')
    assert.deepEqual(await win.webContents.executeJavaScript(sceneFrameScript), sceneModalFrame,
      'Switching from Picture to Titles must not move or resize the Scene window')
    assert.equal(await win.webContents.executeJavaScript(`(() => { const modal=document.querySelector('[data-program-scene-modal]').getBoundingClientRect(); const bar=document.querySelector('[data-scene-editor="titles"] [data-scene-air-bar]').getBoundingClientRect(); return Math.round(bar.top-modal.top); })()`), pictureBarTop,
      'Every Scene panel must place its on-air controls directly below the tabs')
    const titlesLayout = await win.webContents.executeJavaScript(`(() => {
      const modal = document.querySelector('[data-program-scene-modal]');
      const editor = document.querySelector('[data-broadcast-titles-editor]');
      const modalRect = modal.getBoundingClientRect(); const editorRect = editor.getBoundingClientRect();
      const previewRect = editor.querySelector('[data-broadcast-titles-preview]').getBoundingClientRect();
      const sections = Array.from(editor.querySelectorAll('aside > section')).map(section => ({clientHeight:section.clientHeight,scrollHeight:section.scrollHeight}));
      return {modalFits:modal.scrollHeight<=modal.clientHeight,editorVisible:editorRect.top>=modalRect.top&&editorRect.bottom<=modalRect.bottom,documentFits:document.documentElement.scrollHeight<=innerHeight,modalRect:{top:modalRect.top,bottom:modalRect.bottom,width:modalRect.width,height:modalRect.height},editorRect:{top:editorRect.top,bottom:editorRect.bottom,width:editorRect.width,height:editorRect.height},preview:{width:previewRect.width,height:previewRect.height},sections};
    })()`)
    if (!titlesLayout.modalFits || !titlesLayout.editorVisible || !titlesLayout.documentFits || titlesLayout.sections.some(section => section.scrollHeight > section.clientHeight)) {
      writeFileSync(resolve('tmp/pip-video-ui/scene-titles-layout-failure.png'), (await win.webContents.capturePage()).toPNG())
      console.error('Titles layout metrics', titlesLayout)
    }
    assert.equal(titlesLayout.modalFits, true, 'Titles Scene panel must fit without modal scrolling')
    assert.equal(titlesLayout.editorVisible, true, 'Titles editor must remain completely inside Scene')
    assert.equal(titlesLayout.documentFits, true, 'Titles Scene panel must not scroll the document')
    assert.ok(titlesLayout.sections.every(section => section.scrollHeight <= section.clientHeight),
      'Every Titles settings column must fit without a scrollbar')
    assert.ok(titlesLayout.preview.width >= 380 && titlesLayout.preview.height >= 380,
      'Titles preview must remain large enough to inspect both title layers')
    await win.webContents.executeJavaScript(`Array.from(document.querySelector('[data-broadcast-titles-editor]').querySelectorAll('button')).find(button => button.textContent.includes('Добавить')).click()`)
    await new Promise(done => setTimeout(done, 50))
    assert.equal(await win.webContents.executeJavaScript(`Array.from(document.querySelector('[data-broadcast-titles-editor] aside').querySelectorAll(':scope > section')).every(section => section.scrollHeight <= section.clientHeight)`), true,
      'Speaker editor must also fit after adding a speaker')
    assert.deepEqual(await win.webContents.executeJavaScript(`(() => {
      const controls=Array.from(document.querySelectorAll('[data-broadcast-titles-color]'));
      const labels=controls.map(control=>control.dataset.broadcastTitlesColor);
      const inputs=Array.from(document.querySelectorAll('[data-broadcast-titles-auto-hide] input[type="number"]'));
      return {labels,labelsFit:controls.every(control=>{const span=control.querySelector('span');return span.scrollWidth<=span.clientWidth;}),compactSeconds:inputs.every(input=>input.getBoundingClientRect().width<=60)};
    })()`), {
      labels: ['Текст','Фон 1','Фон 2','Начало','Конец','Текст','Фон 1','Фон 2','Начало','Конец'],
      labelsFit: true,
      compactSeconds: true
    }, 'Titles colors must keep complete labels and auto-hide inputs must stay compact')
    win.setContentSize(1280, 600)
    await new Promise(done => setTimeout(done, 100))
    assert.equal(await win.webContents.executeJavaScript(`(() => { const modal=document.querySelector('[data-program-scene-modal]'); const sections=Array.from(document.querySelector('[data-broadcast-titles-editor] aside').querySelectorAll(':scope > section')); return modal.scrollHeight<=modal.clientHeight && sections.every(section=>section.scrollHeight<=section.clientHeight); })()`), true,
      'Titles editor must fit without scrolling at 1280×600')
    win.setContentSize(1280, 800)
    await new Promise(done => setTimeout(done, 100))
    await win.webContents.executeJavaScript(`new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))`)
    win.webContents.invalidate()
    await new Promise(done => setTimeout(done, 150))
    writeFileSync(resolve('tmp/pip-video-ui/scene-titles-layout.png'), (await win.webContents.capturePage()).toPNG())
    stage = 'select information title source ahead of off-air selected channel'
    await win.webContents.executeJavaScript(`(() => {
      window.testScene.setProgramScene({enabled:false});
      window.testScene.activeFile = null;
      window.testScene.programCaptureTitlesSourceIdentity = null;
      window.testScene.selectedChannel = 'A';
      window.testScene.channels = {A:{file:{type:'capture',capture:{sourceId:'selected-camera',captureKind:'device',videoDeviceId:'selected-video',videoLabel:'Off-air camera'}}}};
      window.testScene.informationMedia = {type:'capture',capture:{sourceId:'information-camera',captureKind:'device',videoDeviceId:'information-video',videoLabel:'Information camera'}};
      window.testScene.displays = [{id:'info-display',isPrimary:false}];
      window.testScene.displayAssignments = {'info-display':'information'};
      window.testScene.setBroadcastTitles({speakerAutoHideSeconds:1,eventAutoHideSeconds:2});
    })()`)
    await new Promise(done => setTimeout(done, 50))
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-scene-editor="titles"] [data-scene-air-bar]')?.innerText.includes('Слой виден на информационном экране')`), true,
      'Visible information capture must win over a merely selected off-air channel')
    stage = 'fill title inputs'
    const titleInputsFound = await win.webContents.executeJavaScript(`(() => {
      const name = document.querySelector('input[placeholder="Имя выступающего"]');
      const eventInfo = document.querySelector('textarea[placeholder^="Ежегодная конференция"]');
      if (!name || !eventInfo) return {name:!!name,eventInfo:!!eventInfo};
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(name,'Тестовый выступающий');
      name.dispatchEvent(new Event('input',{bubbles:true}));
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(eventInfo,'Тестовое мероприятие');
      eventInfo.dispatchEvent(new Event('input',{bubbles:true}));
      return {name:true,eventInfo:true};
    })()`)
    assert.deepEqual(titleInputsFound, {name:true,eventInfo:true}, 'Show all test inputs must be available')
    await new Promise(done => setTimeout(done, 50))
    stage = 'check show all button'
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-broadcast-titles-show-all]')?.disabled`), false,
      'Show all must become available when a source, speaker, and event information are selected')
    assert.deepEqual(await win.webContents.executeJavaScript(`['speaker','event'].map(kind => { const control=document.querySelector('[data-broadcast-titles-'+kind+'-visible]'); return {tag:control?.tagName,inputCount:control?.querySelectorAll('input').length,pressed:control?.getAttribute('aria-pressed')}; })`), [
      { tag: 'BUTTON', inputCount: 0, pressed: 'false' },
      { tag: 'BUTTON', inputCount: 0, pressed: 'false' }
    ], 'Speaker and event controls must be buttons, not checkboxes')
    assert.deepEqual(await win.webContents.executeJavaScript(`['[data-broadcast-titles-show-all]','[data-broadcast-titles-speaker-visible]','[data-broadcast-titles-event-visible]'].map(selector => document.querySelector(selector)?.className.includes('red-'))`), [true, true, true],
      'Every title control that sends content on air must use the red on-air style')
    assert.equal(await win.webContents.executeJavaScript(`Array.from(document.querySelector('[data-broadcast-titles-editor]').querySelectorAll('button')).some(button => ['Показать','Обновить','Скрыть'].includes(button.textContent.trim()))`), false,
      'Titles editor must not duplicate the top on-air controls with separate Show, Update, or Hide buttons')
    stage = 'click show all button'
    await win.webContents.executeJavaScript(`document.querySelector('[data-broadcast-titles-show-all]').click()`)
    await new Promise(done => setTimeout(done, 50))
    stage = 'verify all titles output'
    assert.deepEqual(await win.webContents.executeJavaScript(`(() => { const output=window.testScene.captureTitlesOutputs['information-camera']; return {speakerVisible:output.speakerVisible,eventVisible:output.eventVisible,speakerName:output.speakerName,eventInfo:output.eventInfo}; })()`), {
      speakerVisible: true,
      eventVisible: true,
      speakerName: 'Тестовый выступающий',
      eventInfo: 'Тестовое мероприятие'
    }, 'Show all must publish both titles to the information display capture')
    await win.webContents.executeJavaScript(`window.testEmit('information-titles-update', {titleSourceIdentity:'information-camera',titles:window.testScene.captureTitlesOutputs['information-camera']})`)
    await new Promise(done => setTimeout(done, 80))
    assert.deepEqual(await win.webContents.executeJavaScript(`(() => { const layer=document.querySelector('[data-information-titles-layer]'); return {present:!!layer,speaker:layer?.querySelector('.broadcast-speaker-name')?.textContent,event:layer?.querySelector('.broadcast-event-title-text')?.textContent}; })()`), {
      present: true,
      speaker: 'Тестовый выступающий',
      event: 'Тестовое мероприятие'
    }, 'Information display must render both titles above its external source')
    assert.deepEqual(await win.webContents.executeJavaScript(`['speaker','event'].map(kind => document.querySelector('[data-broadcast-titles-'+kind+'-visible]').getAttribute('aria-pressed'))`), ['true', 'true'],
      'Both title buttons must remain pressed while their titles are visible')
    stage = 'wait for speaker title auto-hide'
    await new Promise(done => setTimeout(done, 1100))
    assert.deepEqual(await win.webContents.executeJavaScript(`['speaker','event'].map(kind => document.querySelector('[data-broadcast-titles-'+kind+'-visible]').getAttribute('aria-pressed'))`), ['false', 'true'],
      'Speaker button must release when its own auto-hide timer expires')
    stage = 'wait for event title auto-hide'
    await new Promise(done => setTimeout(done, 1050))
    assert.deepEqual(await win.webContents.executeJavaScript(`['speaker','event'].map(kind => document.querySelector('[data-broadcast-titles-'+kind+'-visible]').getAttribute('aria-pressed'))`), ['false', 'false'],
      'Event button must release independently when its own auto-hide timer expires')
    stage = 'clean title output'
    await win.webContents.executeJavaScript(`(() => {
      window.testScene.setCaptureTitlesOutput('information-camera',{speakerVisible:false,eventVisible:false});
      window.testScene.programCaptureTitlesSourceIdentity = null;
      window.testScene.activeFile = null;
      window.testScene.informationMedia = null;
      window.testScene.selectedChannel = null;
      window.testScene.channels = {};
      window.testScene.displays = [];
      window.testScene.displayAssignments = {};
      window.testScene.setProgramScene({});
    })()`)
    await new Promise(done => setTimeout(done, 50))
    const resizedSceneModalFrame = await win.webContents.executeJavaScript(sceneFrameScript)
    await win.webContents.executeJavaScript(`(() => {
      window.testScene.displays = [{id:'display-2',isPrimary:false,bounds:{x:0,y:0,width:1920,height:1080}}];
      window.testScene.selectedDisplayId = 'display-2';
      window.testScene.isPresentationWindowOpen = true;
      window.testScene.setQrOverlay({});
      window.testScene.setProgramScene({enabled:false});
      document.querySelector('[data-scene-panel="picture"]').click();
    })()`)
    await new Promise(done => setTimeout(done, 50))
    await win.webContents.executeJavaScript(`(() => {
      const preview=document.querySelector('[data-program-scene-preview]'); const rect=preview.getBoundingClientRect();
      preview.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:rect.left+2,clientY:rect.top+2}));
    })()`)
    await new Promise(done => setTimeout(done, 30))
    await win.webContents.executeJavaScript(`document.querySelector('[data-scene-add="qr"]').click()`)
    await new Promise(done => setTimeout(done, 50))
    assert.equal(await win.webContents.executeJavaScript(`!!document.querySelector('[data-qr-overlay-editor]')`), true,
      'QR controls must remain available contextually when the Scene is disabled')
    assert.deepEqual(await win.webContents.executeJavaScript(sceneFrameScript), resizedSceneModalFrame,
      'Opening QR settings from the Scene must not move or resize the Scene window')
    assert.equal(await win.webContents.executeJavaScript(`window.testScene.programScene.enabled`), false)
    const qrSceneLayout = await win.webContents.executeJavaScript(`(() => {
      const modal = document.querySelector('[data-program-scene-modal]');
      const editor = document.querySelector('[data-qr-overlay-editor]');
      const modalRect = modal.getBoundingClientRect();
      const editorRect = editor.getBoundingClientRect();
      const previewRect = document.querySelector('[data-program-scene-preview]').getBoundingClientRect();
      const settingsRect = editor.querySelector('[data-qr-overlay-settings]').getBoundingClientRect();
      return {
        modalFits: modal.scrollHeight <= modal.clientHeight,
        editorVisible: editorRect.top >= modalRect.top && editorRect.bottom <= modalRect.bottom,
        documentFits: document.documentElement.scrollHeight <= innerHeight,
        previewBeforeSettings: previewRect.left < settingsRect.left,
        columnsTopAligned: Math.abs(previewRect.top - settingsRect.top) <= 40,
        previewSize: {width:Math.round(previewRect.width),height:Math.round(previewRect.height)},
        hasDuplicatePreview: !!editor.querySelector('[data-qr-overlay-preview]'),
        barTop: Math.round(modal.querySelector('[data-scene-air-bar]').getBoundingClientRect().top - modalRect.top)
      };
    })()`)
    assert.equal(qrSceneLayout.modalFits, true, 'QR Scene panel must fit without modal scrolling or clipping')
    assert.equal(qrSceneLayout.editorVisible, true, 'The complete QR editor must remain visible inside Scene')
    assert.equal(qrSceneLayout.documentFits, true, 'QR Scene panel must not scroll the document')
    assert.equal(qrSceneLayout.previewBeforeSettings, true, 'QR preview must be on the left and its settings on the right')
    assert.equal(qrSceneLayout.columnsTopAligned, true, 'QR preview and settings must start in the same workspace row')
    assert.deepEqual(qrSceneLayout.previewSize, picturePreviewSize, 'QR preview must match the Picture and Text preview size')
    assert.equal(qrSceneLayout.hasDuplicatePreview, false, 'QR must use the shared Scene preview without a second canvas')
    assert.equal(qrSceneLayout.barTop, pictureBarTop, 'QR on-air controls must align with the other Scene panels')
    await win.webContents.executeJavaScript(`(() => {
      const description=document.querySelector('input[placeholder="Например: Задать вопрос спикеру"]');
      const url=document.querySelector('input[placeholder="https://example.ru"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(description,'Задать вопрос спикеру');
      description.dispatchEvent(new Event('input',{bubbles:true}));
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(url,'https://example.test/preview');
      url.dispatchEvent(new Event('input',{bubbles:true}));
    })()`)
    await new Promise(done => setTimeout(done, 350))
    stage = 'restore QR to Scene after hiding it from a channel'
    await win.webContents.executeJavaScript(`(() => {
      window.testScene.setQrOverlay({enabled:false,sceneVisible:false});
      document.querySelector('[data-scene-panel="picture"]').click();
    })()`)
    await new Promise(done => setTimeout(done, 60))
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-scene-qr-object]') === null`), true,
      'A QR hidden from the Scene must disappear from its preview')
    await win.webContents.executeJavaScript(`(() => {
      const preview=document.querySelector('[data-program-scene-preview]'); const rect=preview.getBoundingClientRect();
      preview.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:rect.left+2,clientY:rect.top+2}));
    })()`)
    await new Promise(done => setTimeout(done, 30))
    await win.webContents.executeJavaScript(`document.querySelector('[data-scene-add="qr"]').click()`)
    await new Promise(done => setTimeout(done, 180))
    assert.deepEqual(await win.webContents.executeJavaScript(`({enabled:window.testScene.qrOverlay.enabled,sceneVisible:window.testScene.qrOverlay.sceneVisible,shown:!!document.querySelector('[data-scene-qr-object]')})`),
      {enabled:false,sceneVisible:true,shown:true}, 'Adding QR must restore it to the Scene preview without sending the draft on air')
    stage = 'edit QR description directly on shared Scene canvas'
    await win.webContents.executeJavaScript(`(() => { const inline=document.querySelector('[data-qr-description-inline-editor]'); inline.focus(); inline.textContent=''; inline.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContent'})); })()`)
    for (const character of 'Сканируйте здесь') {
      win.webContents.insertText(character)
      await new Promise(done => setTimeout(done, 4))
    }
    await new Promise(done => setTimeout(done, 80))
    assert.deepEqual(await win.webContents.executeJavaScript(`({dom:document.querySelector('[data-qr-description-inline-editor]').innerText,state:window.testScene.qrOverlay.description})`),
      {dom:'Сканируйте здесь',state:'Сканируйте здесь'}, 'QR description must be editable directly in preview without reversing text')
    await win.webContents.executeJavaScript(`(() => { const qr=document.querySelector('[data-scene-qr-object]'); const rect=qr.getBoundingClientRect(); qr.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:rect.left+5,clientY:rect.top+5})); })()`)
    await new Promise(done => setTimeout(done, 30))
    assert.deepEqual(await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[data-scene-object-action]')).map(button=>button.textContent.trim())`), ['Скрыть'],
      'QR context menu must expose Hide')
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-scene-object-action="hide"]').className.includes('bg-red')`), true)
    await win.webContents.executeJavaScript(`document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`)
    await new Promise(done => setTimeout(done, 30))
    stage = 'show prepared QR from Scene without QR action button'
    await win.webContents.executeJavaScript(`(() => {
      window.testScene.backdropImage='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="960" height="540" fill="#7c3aed"/></svg>');
      window.testScene.setProgramScene({enabled:false});
      document.querySelector('[data-scene-panel="picture"]').click();
    })()`)
    await new Promise(done => setTimeout(done, 60))
    await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-picture-visible]').click()`)
    await new Promise(done => setTimeout(done, 300))
    assert.deepEqual(await win.webContents.executeJavaScript(`({scene:window.testScene.programScene.enabled,qr:window.testScene.qrOverlay.enabled,snapshot:window.testScene.programSnapshot?.qrOverlay?.enabled,nativeOutput:window.lastQrOverlay?.visible??false})`),
      {scene:true,qr:true,snapshot:true,nativeOutput:false}, 'Showing Scene must publish its prepared QR through the internal Program snapshot without a physical output display')
    await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-picture-visible]').click()`)
    await new Promise(done => setTimeout(done, 40))
    await win.webContents.executeJavaScript(`(() => {
      const object=document.querySelector('[data-scene-qr-object]'); const rect=object.getBoundingClientRect();
      object.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:31,button:0,buttons:1,clientX:rect.left+5,clientY:rect.top+5}));
      object.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:31,clientX:rect.left+5,clientY:rect.top+5}));
    })()`)
    await new Promise(done => setTimeout(done, 60))
    await win.webContents.executeJavaScript(`window.testScene.setQrOverlay({enabled:false})`)
    await new Promise(done => setTimeout(done, 80))
    stage = 'move and scale QR on shared Scene canvas'
    const qrDragResult = await win.webContents.executeJavaScript(`(() => {
      const object=document.querySelector('[data-scene-qr-object]');
      const before={x:window.testScene.qrOverlay.xPercent,y:window.testScene.qrOverlay.yPercent};
      const rect=object.getBoundingClientRect();
      object.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:12,clientX:rect.left+5,clientY:rect.top+5,buttons:1}));
      object.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:12,clientX:rect.left-45,clientY:rect.top-25,buttons:1}));
      object.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:12,clientX:rect.left-45,clientY:rect.top-25}));
      return {before,after:{x:window.testScene.qrOverlay.xPercent,y:window.testScene.qrOverlay.yPercent}};
    })()`)
    assert.ok(qrDragResult.after.x < qrDragResult.before.x && qrDragResult.after.y < qrDragResult.before.y,
      'QR must move directly on the shared Scene canvas')
    await new Promise(done => setTimeout(done, 40))
    const qrWheelResult = await win.webContents.executeJavaScript(`(() => {
      const object=document.querySelector('[data-scene-qr-object]');
      const before=window.testScene.qrOverlay.sizePercent;
      const wheel=new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:-120});
      object.dispatchEvent(wheel);
      return {before,after:window.testScene.qrOverlay.sizePercent,wheelCancelled:wheel.defaultPrevented};
    })()`)
    assert.ok(qrWheelResult.after > qrWheelResult.before && qrWheelResult.wheelCancelled,
      `Mouse wheel must scale QR without scrolling the Scene window: ${JSON.stringify(qrWheelResult)}`)
    await win.webContents.executeJavaScript(`document.querySelector('[data-qr-settings-panel="design"]').click()`)
    await new Promise(done => setTimeout(done, 50))
    const qrDesignLayout = await win.webContents.executeJavaScript(`(() => { const settings=document.querySelector('[data-qr-overlay-settings]'); const buttons=Array.from(settings.querySelectorAll('button')).filter(button => button.getClientRects().length); const url=settings.querySelector('input[placeholder="https://example.ru"]'); return {designSelected:settings.querySelector('[data-qr-settings-panel="design"]').getAttribute('aria-selected'),contentHidden:url.getClientRects().length===0,labelsFit:buttons.every(button=>button.scrollWidth<=button.clientWidth),fits:settings.scrollHeight<=settings.clientHeight}; })()`)
    assert.equal(qrDesignLayout.designSelected, 'true', 'QR design settings must open in their own tab')
    assert.equal(qrDesignLayout.contentHidden, true, 'Content controls must not crowd the Design tab')
    assert.equal(qrDesignLayout.labelsFit, true, 'All visible QR button labels must fit completely')
    assert.equal(qrDesignLayout.fits, true, 'QR Design tab must fit without its own scrollbar')
    stage = 'select transparent QR description'
    await win.webContents.executeJavaScript(`document.querySelector('[data-qr-description-background-transparent]').click()`)
    await new Promise(done => setTimeout(done, 350))
    stage = 'verify transparent QR description'
    assert.deepEqual(await win.webContents.executeJavaScript(`(() => { const label=document.querySelector('[data-qr-description-preview]'); if (!label) return null; const style=getComputedStyle(label); return {backgroundColor:style.backgroundColor,textShadow:style.textShadow}; })()`), {
      backgroundColor: 'rgba(0, 0, 0, 0)',
      textShadow: 'none'
    }, 'Transparent QR description must keep crisp text without a blurred shadow')
    win.setContentSize(1280, 600)
    await new Promise(done => setTimeout(done, 100))
    assert.equal(await win.webContents.executeJavaScript(`(() => { const modal=document.querySelector('[data-program-scene-modal]'); const settings=document.querySelector('[data-qr-overlay-settings]'); return modal.scrollHeight<=modal.clientHeight && settings.scrollHeight<=settings.clientHeight && document.documentElement.scrollHeight<=innerHeight; })()`), true,
      'QR Design tab must fit without scrolling at 1280×600')
    win.setContentSize(1280, 800)
    await new Promise(done => setTimeout(done, 100))
    writeFileSync(resolve('tmp/pip-video-ui/scene-qr-design-layout.png'), (await win.webContents.capturePage()).toPNG())
    await win.webContents.executeJavaScript(`document.querySelector('[data-qr-settings-panel="content"]').click()`)
    await new Promise(done => setTimeout(done, 50))
    const qrInitialControls = await win.webContents.executeJavaScript(`(() => {
      const editor = document.querySelector('[data-qr-overlay-editor]');
      return {
        livePresent: !!editor.querySelector('[data-qr-overlay-live-preview]'),
        visibilityControls: editor.querySelectorAll('[data-qr-overlay-visible]').length,
        visibilityTag: editor.querySelector('[data-qr-overlay-visible]')?.tagName,
        visibilityInputs: editor.querySelector('[data-qr-overlay-visible]')?.querySelectorAll('input').length,
        visibilityRed: editor.querySelector('[data-qr-overlay-visible]')?.className.includes('bg-red'),
        hasSave: Array.from(editor.querySelectorAll('button')).some(button => button.textContent.trim() === 'Сохранить'),
        hasCancel: Array.from(editor.querySelectorAll('button')).some(button => button.textContent.trim() === 'Отмена')
      };
    })()`)
    assert.equal(qrInitialControls.livePresent, false, 'QR editor must not expose a second live-editing checkbox')
    assert.equal(qrInitialControls.visibilityControls, 0, 'Embedded QR settings must not duplicate the master Scene output button')
    assert.equal(qrInitialControls.hasSave, false, 'QR editor must not have a Save button')
    assert.equal(qrInitialControls.hasCancel, false, 'QR editor must not have a Cancel button')
    stage = 'live QR must remain visible in shared preview';
    await win.webContents.executeJavaScript(`window.testScene.setQrOverlay({enabled:true,sceneVisible:false}); document.querySelector('[data-scene-panel="picture"]').click()`);
    await new Promise(done => setTimeout(done, 150));
    assert.equal(await win.webContents.executeJavaScript(`!!document.querySelector('[data-scene-qr-object]')`), true,
      'A QR visible on air must also be visible in Scene preview even for a legacy hidden draft');
    await win.webContents.executeJavaScript(`window.testScene.setQrOverlay({enabled:false,sceneVisible:true})`);
    await win.webContents.executeJavaScript(`new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))`)
    win.webContents.invalidate()
    await new Promise(done => setTimeout(done, 150))
    writeFileSync(resolve('tmp/pip-video-ui/scene-qr-layout.png'), (await win.webContents.capturePage()).toPNG())
    await win.webContents.executeJavaScript(`(() => {
      window.testScene.setProgramScene({enabled:true});
      window.testScene.publishProgramSnapshot(null);
      document.querySelector('[data-scene-panel="picture"]').click();
    })()`)
    await new Promise(done => setTimeout(done, 50))
    assert.deepEqual(await win.webContents.executeJavaScript(sceneFrameScript), resizedSceneModalFrame,
      'Returning from QR settings to the Scene must not move or resize the Scene window')
    await win.webContents.executeJavaScript(`(() => {
      const preview=document.querySelector('[data-program-scene-preview]'); const rect=preview.getBoundingClientRect();
      preview.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:rect.left+2,clientY:rect.top+2}));
    })()`)
    await new Promise(done => setTimeout(done, 30))
    await win.webContents.executeJavaScript(`document.querySelector('[data-scene-add="text"]').click()`)
    await new Promise(done => setTimeout(done, 50))
    await win.webContents.executeJavaScript(`document.querySelector('[data-add-program-scene-text]').click()`)
    await new Promise(done => setTimeout(done, 50))
    const textEditorResult = await win.webContents.executeJavaScript(`(() => {
      let stage = 'find textarea';
      try {
      const textarea = document.querySelector('[data-program-scene-text-input]');
      const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      stage = 'set textarea';
      setValue.call(textarea, 'Первая строка\\nВторая строка');
      textarea.dispatchEvent(new Event('input', {bubbles:true}));
      stage = 'font';
      const font = document.querySelector('[data-program-scene-text-font]');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(font, 'impact');
      font.dispatchEvent(new Event('change', {bubbles:true}));
      stage = 'width';
      const width = document.querySelector('[data-program-scene-text-width]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(width, '48');
      width.dispatchEvent(new Event('input', {bubbles:true}));
      stage = 'size';
      const size = document.querySelector('[data-program-scene-text-size]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(size, '9.5');
      size.dispatchEvent(new Event('input', {bubbles:true}));
      return true;
      } catch (error) { throw new Error(stage + ': ' + error.stack); }
    })()`)
    assert.equal(textEditorResult, true)
    await new Promise(done => setTimeout(done, 100))
    assert.equal(await win.webContents.executeJavaScript(`window.testScene.programScene.textOverlays.length`), 0,
      'Text edits in preview must stay out of program output')
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-text-live-preview]') === null`), true,
      'Text editor must not expose a second live-editing checkbox')
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-text-visible]') === null && document.querySelectorAll('[data-program-scene-picture-visible]').length === 1`), true,
      'Text editor must keep only the master Scene output button')
    assert.equal(await win.webContents.executeJavaScript(`document.body.innerText.includes('Предпросмотр')`), true)
    assert.equal(await win.webContents.executeJavaScript(`document.body.innerText.includes('Презентация и камера рядом, на общем фоне.')`), false)
    await win.webContents.executeJavaScript(`(() => {
      const text = Array.from(document.querySelectorAll('[data-program-scene-text-id]')).at(-1);
      const rect = text.getBoundingClientRect();
      text.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true,pointerId:7,button:0,clientX:rect.left+5,clientY:rect.top+5,buttons:1}));
      text.dispatchEvent(new PointerEvent('pointermove', {bubbles:true,pointerId:7,clientX:rect.left+105,clientY:rect.top+55,buttons:1}));
      text.dispatchEvent(new PointerEvent('pointerup', {bubbles:true,pointerId:7,clientX:rect.left+105,clientY:rect.top+55}));
    })()`)
    await new Promise(done => setTimeout(done, 100))
    assert.equal(await win.webContents.executeJavaScript(`window.testScene.programScene.textOverlays.length`), 0,
      'Moving text in preview must not broadcast the new position')
    const wheelCancelled = await win.webContents.executeJavaScript(`(() => {
      const event = new WheelEvent('wheel', {bubbles:true,cancelable:true,deltaY:-120});
      document.querySelectorAll('[data-program-scene-text-id]')[1].dispatchEvent(event);
      return event.defaultPrevented;
    })()`)
    assert.equal(wheelCancelled, true, 'Scaling text must cancel PiP window scrolling')
    await new Promise(done => setTimeout(done, 100))
    assert.equal(await win.webContents.executeJavaScript(`window.testScene.programScene.textOverlays.length`), 0,
      'Scaling text in preview must stay out of program output')
    await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-picture-visible]').click()`)
    await new Promise(done => setTimeout(done, 100))
    assert.equal(await win.webContents.executeJavaScript(`window.testScene.programScene.enabled`), false,
      'Master output button must exit the Scene')
    assert.equal(await win.webContents.executeJavaScript(`window.testScene.programSnapshot === null`), true,
      'Exiting Scene must clear the published snapshot')
    await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-picture-visible]').click()`)
    await new Promise(done => setTimeout(done, 100))
    const editedTexts = await win.webContents.executeJavaScript(`window.testScene.programScene.textOverlays`)
    assert.equal(editedTexts.length, 2, 'Showing text must publish all prepared text blocks')
    assert.equal(editedTexts[1].text, 'Первая строка\nВторая строка', 'PiP text must preserve Enter/new lines')
    assert.equal(editedTexts[1].fontFamily, 'impact')
    assert.equal(editedTexts[1].widthPercent, 48)
    assert.equal(editedTexts[1].fontSizePercent, 10, 'Mouse wheel must increase text scale up to 100%')
    assert.ok(editedTexts[1].xPercent > 10 && editedTexts[1].yPercent > 11,
      'Showing text must publish the prepared position')
    const modalLayout = await win.webContents.executeJavaScript(`(() => {
      const modal = document.querySelector('[data-program-scene-modal]');
      const action = modal.querySelector('[data-add-program-scene-text]');
      const modalRect = modal.getBoundingClientRect();
      const actionRect = action.getBoundingClientRect();
      return {
        clientHeight: modal.clientHeight,
        scrollHeight: modal.scrollHeight,
        overflowY: getComputedStyle(modal).overflowY,
        actionVisible: actionRect.top >= modalRect.top && actionRect.bottom <= modalRect.bottom,
        documentFits: document.documentElement.scrollHeight <= innerHeight
      };
    })()`)
    assert.equal(modalLayout.overflowY, 'hidden', 'PiP modal must never show a scrollbar')
    assert.ok(modalLayout.scrollHeight <= modalLayout.clientHeight, 'All PiP controls must fit without hidden overflow')
    assert.equal(modalLayout.actionVisible, true, 'PiP action button must remain visible without scrolling')
    assert.equal(modalLayout.documentFits, true, 'PiP window must not scroll the document')
    await win.webContents.executeJavaScript(`new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))`)
    win.webContents.invalidate()
    await new Promise(done => setTimeout(done, 150))
    writeFileSync(resolve('tmp/pip-video-ui/pip-text-layout.png'), (await win.webContents.capturePage()).toPNG())
    await win.webContents.executeJavaScript(`document.querySelector('[data-scene-panel="picture"]').click()`)
    await new Promise(done => setTimeout(done, 50))
    assert.deepEqual(await win.webContents.executeJavaScript(`(() => { const control=document.querySelector('[data-program-scene-picture-visible]'); return {tag:control?.tagName,inputCount:control?.querySelectorAll('input').length}; })()`),
      {tag:'BUTTON',inputCount:0}, 'Picture controls must remain a button without a checkbox')
    await win.webContents.executeJavaScript(`(() => {
      const text=Array.from(document.querySelectorAll('[data-program-scene-text-id]')).at(-1); const rect=text.getBoundingClientRect();
      text.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:32,button:0,buttons:1,clientX:rect.left+5,clientY:rect.top+5}));
      text.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:32,clientX:rect.left+5,clientY:rect.top+5}));
    })()`)
    await new Promise(done => setTimeout(done, 50))
    await win.webContents.executeJavaScript(`(() => {
      const size = document.querySelector('[data-program-scene-text-size]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(size, '1');
      size.dispatchEvent(new Event('input', {bubbles:true}));
    })()`)
    await new Promise(done => setTimeout(done, 100))
    await win.webContents.executeJavaScript(`document.querySelectorAll('[data-program-scene-text-id]')[1].dispatchEvent(new WheelEvent('wheel', {bubbles:true,deltaY:120}))`)
    await new Promise(done => setTimeout(done, 100))
    assert.equal(await win.webContents.executeJavaScript(`Number(document.querySelector('[data-program-scene-text-size]').value)`), 1,
      'Mouse wheel must not reduce the preview text scale below 10%')
    assert.equal(await win.webContents.executeJavaScript(`window.testScene.programScene.textOverlays[1].fontSizePercent`), 10,
      'Further preview changes must not alter the visible program text')
    await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-picture-visible]').click()`)
    await new Promise(done => setTimeout(done, 100))
    await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-picture-visible]').click()`)
    await new Promise(done => setTimeout(done, 100))
    const republishedTexts = await win.webContents.executeJavaScript(`window.testScene.programScene.textOverlays`)
    assert.equal(republishedTexts.length, 2,
      'Showing text again must keep every prepared text block')
    assert.equal(republishedTexts[1].text, 'Первая строка\nВторая строка')
    assert.equal(republishedTexts[1].fontSizePercent, 1,
      'Showing text again must publish the final prepared scale')
    await win.loadFile(resolve('tmp/pip-video-ui/index.html'), { search: 'output&device' })
    await win.webContents.executeJavaScript(`window.testScene.setProgramScene({textOverlays:[${JSON.stringify({
      id: 'output-text', text: 'Строка 1\nСтрока 2', xPercent: 12, yPercent: 18,
      widthPercent: 42, fontFamily: 'georgia', fontSizePercent: 6, color: '#12abef'
    })}]})`)
    await new Promise(done => setTimeout(done, 100))
    const outputText = await win.webContents.executeJavaScript(`(() => {
      const el = document.querySelector('[data-program-scene-text-id="output-text"]');
      const style = getComputedStyle(el); const rect = el.getBoundingClientRect();
      return {text:el.textContent,color:style.color,font:style.fontFamily,width:el.style.width,left:el.style.left,top:el.style.top,rectWidth:rect.width};
    })()`)
    assert.equal(outputText.text, 'Строка 1\nСтрока 2')
    assert.equal(outputText.color, 'rgb(18, 171, 239)')
    assert.match(outputText.font, /Georgia/i)
    assert.equal(outputText.width, '42%')
    assert.equal(outputText.left, '12%')
    assert.equal(outputText.top, '18%')
    assert.ok(outputText.rectWidth > 400, 'Output text field width must affect rendered layout')
    await win.webContents.executeJavaScript(`window.testScene.setProgramScene({textOverlaysVisible:false})`)
    await new Promise(done => setTimeout(done, 100))
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-text-id="output-text"]') === null`), true,
      'Unchecked Show on air must remove text from program output')
    assert.equal(await win.webContents.executeJavaScript(`window.testScene.programScene.textOverlays.length`), 1,
      'Hidden program text must stay saved')
    console.log('PASS: PiP text draft gate, on-air visibility, multiple multiline blocks, drag, typography, width, color and output rendering')
    for (const kind of ['pptx', 'pdf']) {
      for (const aspect of ['wide', 'four-three', 'portrait']) {
        await win.loadFile(resolve('tmp/pip-video-ui/index.html'), { search: `corners&${kind}&${aspect}` })
        await new Promise(done => setTimeout(done, 350))
        let bounds
        for (const rounded of [false, true, false]) {
          await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(button => button.textContent === ${JSON.stringify(rounded ? 'Скруглённые' : 'Острые')}).click()`)
          await new Promise(done => setTimeout(done, kind === 'pdf' ? 220 : 50))
          if (kind === 'pdf') {
            for (let attempt = 0; attempt < 30; attempt += 1) {
              const painted = await win.webContents.executeJavaScript(`(() => {
                const canvas=document.querySelector('.pdm-pip-content-preview canvas');
                if (!canvas?.width || !canvas?.height) return false;
                const pixel=canvas.getContext('2d').getImageData(Math.floor(canvas.width/2),Math.floor(canvas.height/2),1,1).data;
                return pixel[1] > 120 && pixel[2] < 80 && pixel[0] < 130;
              })()`)
              if (painted) break
              await new Promise(done => setTimeout(done, 50))
            }
          }
          await win.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
          const metrics = await win.webContents.executeJavaScript(`(() => {
            const media = document.querySelector('.pdm-pip-content-preview ${kind === 'pdf' ? 'canvas' : 'img'}');
            if (!media) throw new Error('Actual SlideRenderer must paint the test slide');
            const rect = media.getBoundingClientRect();
            const frame = media.closest('.pdm-pip-content-preview').getBoundingClientRect();
            const preview = document.querySelector('[data-program-scene-preview]').getBoundingClientRect();
            return {radius:parseFloat(getComputedStyle(media).borderTopLeftRadius), bounds:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},frame:{x:frame.x,y:frame.y,width:frame.width,height:frame.height},preview:{width:preview.width,height:preview.height},viewport:{width:innerWidth,height:innerHeight}};
          })()`)
          assert.equal(metrics.radius, rounded ? 12 : 0, `${kind} ${aspect}: radius must apply to the actual slide surface`)
          if (aspect === 'portrait') {
            assert.ok(Math.abs(metrics.frame.width - metrics.bounds.width) <= 2 && Math.abs(metrics.frame.height - metrics.bounds.height) <= 2,
              `${kind} portrait: transparent Scene frame must fit the visible portrait slide`)
            assert.ok(Math.abs(metrics.frame.width / metrics.frame.height - 2 / 3) < 0.02,
              `${kind} portrait: Scene frame must use the presentation aspect ratio`)
            assert.ok(metrics.frame.height >= metrics.preview.height * 0.84,
              `${kind} portrait: Scene preview must keep the vertical presentation large`)
          }
          if (!bounds) bounds = metrics.bounds
          for (const field of ['x', 'y', 'width', 'height']) {
            assert.ok(Math.abs(metrics.bounds[field] - bounds[field]) <= 0.05,
              `Changing corners must not resize or move the slide (${field})`)
          }
          const screenshot = await win.webContents.capturePage()
          const picture = screenshot.resize(metrics.viewport)
          const bytes = picture.toBitmap()
          const isSlidePixel = (x, y) => {
            const index = (Math.round(y) * picture.getSize().width + Math.round(x)) * 4
            return bytes[index + 1] > 120 && bytes[index + 2] < 80 && bytes[index] < 130
          }
          const {x,y,width,height} = metrics.bounds
          const cornerInset = rounded ? 1 : 3
          for (const [px, py] of [[x+cornerInset,y+cornerInset],[x+width-1-cornerInset,y+cornerInset],[x+cornerInset,y+height-1-cornerInset],[x+width-1-cornerInset,y+height-1-cornerInset]]) {
            assert.equal(isSlidePixel(px, py), !rounded, `${kind} ${aspect}: visible slide corners must match the selected style`)
          }
          assert.ok(isSlidePixel(x+width/2,y+height/2), 'Slide content must remain visible')
          if (rounded) writeFileSync(resolve(`tmp/pip-video-ui/corners-${kind}-${aspect}.png`), screenshot.toPNG())
        }
        await win.webContents.executeJavaScript(`window.testScene.currentSlide = 2; window.testScene.setProgramScene({cornerStyle:'rounded'})`)
        await new Promise(done => setTimeout(done, 150))
        assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.pdm-pip-content-preview ${kind === 'pdf' ? 'canvas' : 'img'}')).borderTopLeftRadius`), '12px', 'Next slide must retain rounding')
        const outsideRadius = await win.webContents.executeJavaScript(`(() => {
          const sample = document.querySelector('.pdm-pip-content-preview ${kind === 'pdf' ? 'canvas' : 'img'}').cloneNode();
          document.body.append(sample); const radius = getComputedStyle(sample).borderTopLeftRadius; sample.remove(); return radius;
        })()`)
        assert.equal(outsideRadius, '0px', 'PiP preview CSS must not change media outside the modal')
        console.log(`PASS: ${kind} ${aspect}: real SlideRenderer, four rounded/sharp corners, unchanged geometry, next slide and CSS isolation`)
      }
    }
    }
    for (const kind of ['pptx', 'pdf']) {
      stage = `verify painted ${kind} layer order`;
      await win.loadFile(resolve('tmp/pip-video-ui/index.html'), { search: `corners&${kind}&wide` });
      await new Promise(done => setTimeout(done, 350));
      await win.webContents.executeJavaScript(`(() => {
        const preview=document.querySelector('[data-program-scene-preview]'); const r=preview.getBoundingClientRect();
        preview.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:r.left+2,clientY:r.top+2}));
      })()`);
      await new Promise(done => setTimeout(done, 30));
      await win.webContents.executeJavaScript(`document.querySelector('[data-scene-add="layer"]').click()`);
      await new Promise(done => setTimeout(done, 100));
      await win.webContents.executeJavaScript(`(() => {
        Array.from(document.querySelectorAll('[data-program-scene-media-editor] button')).find(b=>b.textContent.trim()==='По центру').click();
      })()`);
      await new Promise(done => setTimeout(done, 30));
      await win.webContents.executeJavaScript(`(() => {
        const size=document.querySelector('[data-program-scene-media-editor] input[type="range"]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(size,'100');
        size.dispatchEvent(new Event('input',{bubbles:true}));
      })()`);
      for (const above of [true, false, true]) {
        await win.webContents.executeJavaScript(`window.retainedMediaElement ||= document.querySelector('[data-program-scene-media-id] img')`);
        if (!above || above === true && await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-media-editor]').innerText.includes('Под презентацией')`)) {
          await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[data-program-scene-media-editor] button')).find(b=>b.textContent.trim()===${JSON.stringify(above ? 'Выше' : 'Ниже')}).click()`);
        }
        await new Promise(done => setTimeout(done, 150));
        assert.equal(await win.webContents.executeJavaScript(`window.retainedMediaElement===document.querySelector('[data-program-scene-media-id] img')`), true,
          'Reordering must retain the same loaded image element before Refresh');
        await win.webContents.executeJavaScript(`new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))`);
        win.webContents.invalidate();
        await new Promise(done => setTimeout(done, 120));
        const p=await win.webContents.executeJavaScript(`(() => {const r=document.querySelector('[data-program-scene-preview]').getBoundingClientRect();return {x:r.left+r.width*.4,y:r.top+r.height*.5,w:innerWidth,h:innerHeight};})()`);
        const image=(await win.webContents.capturePage()).resize({width:p.w,height:p.h});
        const offset=(Math.round(p.y)*p.w+Math.round(p.x))*4; const bytes=image.toBitmap();
        const green=bytes[offset+1]>140 && bytes[offset+2]<100;
        const pink=bytes[offset+2]>160 && bytes[offset+1]<100;
        if (!(above ? pink : green)) {
          writeFileSync(resolve('tmp/pip-video-ui/layer-order-failure.png'), image.toPNG());
          console.error(await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[data-program-scene-media-id]')).map(e=>({style:e.style.cssText,surface:e.parentElement.dataset.programSceneMediaSurface,image:e.querySelector('img')?.getAttribute('src'),rect:JSON.stringify(e.getBoundingClientRect().toJSON())}))`));
        }
        assert.ok(above ? pink : green, `${kind}: a layer ${above ? 'above' : 'below'} must paint ${above ? 'over' : 'under'} the presentation, got BGRA ${Array.from(bytes.subarray(offset,offset+4))}`);
      }
      assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('[data-program-scene-picture-visible]').length===1 && !document.querySelector('[data-program-scene-media-visible]')`), true,
        'Layer settings must not duplicate the master Scene output button');
      await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-refresh]').click()`);
      await new Promise(done=>setTimeout(done,80));
      assert.equal(await win.webContents.executeJavaScript(`window.testScene.programSnapshot.scene.mediaLayersVisible && window.testScene.programSnapshot.scene.mediaLayers.length===1`), true,
        'Refresh must enable a newly added layer without a separate media output button');
      console.log(`PASS: ${kind} painted preview matches above/below layer order`);
    }
    stage = 'unified media picker detects image and video';
    await win.webContents.executeJavaScript(`window.nextSceneLayerFiles=['synthetic-image.PNG','synthetic-video.MP4','unsupported.txt'];document.querySelector('[data-add-program-scene-layer]').click()`);
    await new Promise(done=>setTimeout(done,100));
    await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-refresh]').click()`);
    await new Promise(done=>setTimeout(done,100));
    assert.deepEqual(await win.webContents.executeJavaScript(`window.testScene.programSnapshot.scene.mediaLayers.map(l=>l.kind)`), ['image','image','video'],
      'Unified picker must detect mixed image/video files case-insensitively and reject unsupported files');
    assert.equal(await win.webContents.executeJavaScript(`!document.querySelector('[data-add-program-scene-image-layer], [data-add-program-scene-video-layer]')`), true,
      'Separate image/video picker buttons must be removed');
    stage = 'QR preview with logo and hidden contextual editor';
    await win.loadFile(resolve('tmp/pip-video-ui/index.html'), {search:'preview&device'});
    await win.webContents.executeJavaScript(`window.testScene.setQrOverlay({url:'https://example.test/qr',sceneVisible:false,enabled:false,logoPath:'synthetic-logo.png'})`);
    await win.webContents.executeJavaScript(`(()=>{const e=document.querySelector('[data-program-scene-preview]');const r=e.getBoundingClientRect();e.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:r.left+2,clientY:r.top+2}));})()`);
    await new Promise(done=>setTimeout(done,30));
    await win.webContents.executeJavaScript(`document.querySelector('[data-scene-manage="qr"]').click()`);
    await new Promise(done=>setTimeout(done,250));
    assert.deepEqual(await win.webContents.executeJavaScript(`(()=>{const img=document.querySelector('[data-scene-qr-object] img');return {shown:!!img,width:img?.naturalWidth,enabled:window.testScene.qrOverlay.enabled,sceneVisible:window.testScene.qrOverlay.sceneVisible};})()`),
      {shown:true,width:1024,enabled:false,sceneVisible:true}, 'Opening QR settings must restore scene membership without publishing it');
    await win.webContents.executeJavaScript(`document.querySelector('[data-scene-panel="picture"]').click()`);
    await new Promise(done=>setTimeout(done,80));
    assert.equal(await win.webContents.executeJavaScript(`!!document.querySelector('[data-scene-qr-object] img')`), true,
      'QR must remain in the preview when another panel is selected');
    await win.webContents.executeJavaScript(`window.testScene.displays=[{id:2,isPrimary:false,bounds:{width:1920,height:1080}}];window.testScene.displayAssignments={'2':'program'};window.testScene.setProgramScene({enabled:false});`);
    await new Promise(done=>setTimeout(done,30));
    await win.webContents.executeJavaScript(`document.querySelector('[data-program-scene-picture-visible]').click()`);
    await new Promise(done=>setTimeout(done,350));
    assert.deepEqual(await win.webContents.executeJavaScript(`({snapshot:window.testScene.programSnapshot?.qrOverlay.enabled,native:window.lastQrOverlay?.visible})`),
      {snapshot:true,native:true}, 'The restored QR must reach the published snapshot and native output without a separate QR button');
    await win.webContents.executeJavaScript(`window.testScene.setQrOverlay({contentType:'file',imagePath:'synthetic-qr.png',logoPath:null})`);
    await new Promise(done=>setTimeout(done,250));
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('[data-scene-qr-object] img')?.naturalWidth`), 640,
      'A QR loaded from a file must decode in the contextual preview');
    console.log('PASS: retained preview layers, unified mixed media picker, hidden QR editor, logo and QR file');
    if (process.env.PDM_LAYER_ORDER_ONLY) {
      win.destroy(); clearTimeout(deadline); app.exit(0); return;
    }
    const cases = ['legacy', 'device', 'desktop'].flatMap(variant =>
      ['wide', 'four-three'].flatMap(aspect => ['preview', 'output'].map(mode => ({ variant, aspect, mode }))))
    for (const { variant, aspect, mode } of cases) {
      await win.loadFile(resolve('tmp/pip-video-ui/index.html'), { search: `${mode}&${variant}&${aspect}` })
      await new Promise(done => setTimeout(done, 500))
      let baseHeight = 0
      for (const scale of [1, 2.5, 1]) {
        await win.webContents.executeJavaScript(mode === 'preview' ? `(() => {
          const input = document.querySelector('[data-program-scene-participant-scale]');
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${scale * 100});
          input.dispatchEvent(new Event('input', {bubbles:true}));
          input.dispatchEvent(new PointerEvent('pointerup', {bubbles:true}));
        })()` : `window.testScene.setProgramScene({ participantScale: ${scale} })`)
        await new Promise(done => setTimeout(done, 150))
        const metrics = await win.webContents.executeJavaScript(`(() => {
          const media = document.querySelector(${JSON.stringify(mode === 'preview' ? 'img[alt^="Превью"]' : 'video')});
          if (!media) throw new Error('Synthetic camera not rendered');
          const rect = el => {const r = el.getBoundingClientRect(); return {width:r.width,height:r.height,x:r.x,y:r.y};};
          return {media:rect(media),pane:rect(${mode === 'preview' ? 'media.parentElement.parentElement.parentElement' : 'media.parentElement'}),fit:getComputedStyle(media).objectFit,opens:window.captureOpens};
        })()`)
        if (!baseHeight) baseHeight = metrics.pane.height
        assert.ok(Math.abs(metrics.media.height - metrics.pane.height) < 2, `${mode}: image must fill camera height at ${scale * 100}%`)
        assert.ok(Math.abs(metrics.pane.height - baseHeight * scale) < 2, 'Slider must resize the camera and reset to 100%')
        assert.equal(metrics.fit, variant === 'desktop' ? 'contain' : 'cover')
        assert.equal(metrics.opens, mode === 'output' ? 1 : 0, 'Resizing must not reopen the camera')
        const screenshot = await win.webContents.capturePage()
        if (scale === 2.5) {
          writeFileSync(resolve(`tmp/pip-video-ui/${variant}-${aspect}-${mode}.png`), screenshot.toPNG())
          if (variant !== 'desktop') {
            const picture = screenshot.resize({ width: 1266 })
            const viewport = await win.webContents.executeJavaScript('({width:innerWidth,height:innerHeight})')
            const ratio = picture.getSize().width / viewport.width
            const x = Math.round((metrics.pane.x + metrics.pane.width * .5) * ratio)
            const y = Math.round((metrics.pane.y + metrics.pane.height * .05) * ratio)
            const bytes = picture.toBitmap()
            const offset = (y * picture.getSize().width + x) * 4
            assert.ok(Math.max(bytes[offset], bytes[offset + 1], bytes[offset + 2]) > 120,
              `${variant} ${aspect} ${mode}: camera image, not a black bar, must fill the enlarged pane`)
          }
        }
      }
      if (mode === 'output') {
        const thumbnail = await win.webContents.executeJavaScript(`(async () => {
          const image = new Image(); image.src = window.lastPreview; await image.decode();
          return {width:image.naturalWidth,height:image.naturalHeight,aspect:window.sourceAspect};
        })()`)
        assert.ok(Math.abs(thumbnail.width / thumbnail.height - thumbnail.aspect) < .01, 'Thumbnail must keep source proportions, without baked-in black bars')
        assert.ok(thumbnail.width <= 640 && thumbnail.height <= 360, 'Thumbnail memory budget must not grow')
        for (const testDisplayMode of ['fullscreen', 'content', 'scene']) {
          await win.webContents.executeJavaScript(`window.testScene.setProgramScene({testDisplayMode:${JSON.stringify(testDisplayMode)},cornerStyle:'rounded'})`)
          await new Promise(done => setTimeout(done, 50))
          const fits = await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('video,img')).filter(el => !el.hasAttribute('data-program-scene-background')).map(el => getComputedStyle(el).objectFit)`)
          assert.deepEqual(fits, Array(2).fill(testDisplayMode === 'scene' && variant !== 'desktop' ? 'cover' : 'contain'))
        }
        if (variant === 'device' && aspect === 'wide') {
          stage = 'verify GPU chroma key output'
          await win.webContents.executeJavaScript(`window.testScene.setProgramScene({testDisplayMode:'scene',chromaKey:{enabled:true,color:'#20c060',tolerance:28,softness:8,spill:55}})`)
          await new Promise(done => setTimeout(done, 350))
          const chromaMetrics = await win.webContents.executeJavaScript(`(() => {
            const canvas=document.querySelector('[data-chroma-key-canvas="program"]');
            const rect=canvas.parentElement.getBoundingClientRect();
            return {opacity:getComputedStyle(canvas).opacity,rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}};
          })()`)
          assert.equal(chromaMetrics.opacity, '1', 'Program output must switch to the GPU chroma surface')
          win.webContents.invalidate()
          await new Promise(done => setTimeout(done, 150))
          const screenshot = await win.webContents.capturePage()
          const picture = screenshot.resize({width:1280,height:800})
          const bytes = picture.toBitmap()
          const sample = (x, y) => {
            const index = (Math.round(y) * picture.getSize().width + Math.round(x)) * 4
            return {blue:bytes[index],green:bytes[index+1],red:bytes[index+2],alpha:bytes[index+3]}
          }
          const keyed = sample(chromaMetrics.rect.x + chromaMetrics.rect.width * .25, chromaMetrics.rect.y + chromaMetrics.rect.height * .5)
          const subject = sample(chromaMetrics.rect.x + chromaMetrics.rect.width * .5, chromaMetrics.rect.y + chromaMetrics.rect.height * .5)
          const outside = sample(10, 10)
          assert.ok(keyed.red > 180 && keyed.green < 80 && keyed.blue > 180,
            `Keyed green background must reveal only the selected chroma fill, got ${JSON.stringify(keyed)}`)
          assert.ok(subject.red > 180 && subject.green > 180 && subject.blue > 180,
            `Non-keyed subject must remain visible, got ${JSON.stringify(subject)}`)
          assert.ok(outside.red > 95 && outside.green < 65 && outside.blue < 65,
            `Selected chroma fill must not cover the Scene outside the camera frame, got ${JSON.stringify(outside)}`)
          writeFileSync(resolve('tmp/pip-video-ui/chroma-key-output.png'), screenshot.toPNG())
          console.log('PASS: GPU chroma key removes the sampled background and preserves the subject')
        }
        await win.webContents.executeJavaScript('window.unmountTest()')
        assert.equal(await win.webContents.executeJavaScript('window.captureTracks.every(track => track.readyState === "ended")'), true, 'Unmount must release the camera')
      }
      console.log(`PASS: ${variant} ${aspect} ${mode}: height 100–250–100%, fitting, no capture restart${mode === 'output' ? ', thumbnail proportions, mode/corner changes and cleanup' : ''}`)
    }
    win.destroy(); clearTimeout(deadline); app.exit(0)
  } catch (error) {
    console.error(`UI test failed at stage: ${stage}`); console.error(error); win?.destroy(); clearTimeout(deadline); app.exit(1)
  }
})
