const {app,BrowserWindow}=require('electron')
const {resolve}=require('node:path')
const {writeFileSync}=require('node:fs')
const assert=require('node:assert/strict')
app.setPath('userData',resolve('tmp/toolbar-ui/profile'))
const deadline=setTimeout(()=>app.exit(1),55000)
const pause=ms=>new Promise(done=>setTimeout(done,ms))
app.whenReady().then(async()=>{
  let win
  try {
    win=new BrowserWindow({show:false,frame:false,width:1280,height:800,useContentSize:true,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,backgroundThrottling:false}})
    const js=async code=>{
      try { return await win.webContents.executeJavaScript(code) }
      catch(error){ console.error('Failed test expression:',code);console.error(await win.webContents.executeJavaScript('window.testErrors'));throw error }
    }
    const screenshot=async(name)=>{
      await js('new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))')
      win.webContents.invalidate()
      await pause(150)
      writeFileSync(resolve(`tmp/toolbar-ui/${name}.png`),(await win.webContents.capturePage()).toPNG())
    }
    for(const edition of ['stream','standard']) {
      await win.loadFile(resolve(`tmp/toolbar-ui/${edition}.html`)); await pause(200)
      await js('window.testStore.getState().resetToolbarVisibility()')
      await js(`window.setTestBusy(false); (() => {
        const state=window.testStore.getState(),id=state.channelIds[0],file={id:'early-test',path:'early-test.pptx',name:'Cache test',type:'presentation',extension:'.pptx',size:0};
        window.testStore.setState({selectedChannel:id,channels:{...state.channels,[id]:{...state.channels[id],file,totalSlides:123}},pptxCacheStatuses:{[file.path]:'loading'},pptxSlidesMap:{[file.path]:Array.from({length:30},(_,i)=>'slide_'+i+'.png')}});
      })()`); await pause(80)
      assert.equal(await js(`document.querySelector('[data-toolbar-item="output"] button').disabled`),true,'30/123 is still below 25%')
      await js(`window.testStore.setState({pptxCacheStatuses:{'early-test.pptx':'partial'},pptxSlidesMap:{'early-test.pptx':Array.from({length:31},(_,i)=>'slide_'+i+'.png')}})`); await pause(80)
      assert.equal(await js(`document.querySelector('[data-toolbar-item="output"] button').disabled`),false,'31/123 enables the real operator TAKE button')
      await js(`(() => {const state=window.testStore.getState(),id=state.channelIds[0];window.testStore.setState({selectedChannel:null,channels:{...state.channels,[id]:{...state.channels[id],file:null,totalSlides:0}},pptxCacheStatuses:{},pptxSlidesMap:{}});})()`)
      console.log(`PASS: ${edition} real toolbar enables PPTX TAKE at 31/123, not 30/123`)
      if(process.env.PDM_PPTX_THRESHOLD_ONLY) continue
      for(const theme of ['classic','broadcast-pro']) {
        await js(`window.testStore.getState().setAppTheme(${JSON.stringify(theme)})`)
        for(const width of [1280,1024,900,880]) {
          win.setContentSize(width,800); await pause(80)
          for(const busy of [false,true]) {
            await js(`window.setTestBusy(${busy})`); await pause(80)
            const layout=await js(`(() => {
              const rows=Array.from(document.querySelectorAll('.pdm-toolbar-row'));
              return {width:innerWidth,rows:rows.map(row=>({height:row.getBoundingClientRect().height,gap:parseFloat(getComputedStyle(row).columnGap),padding:parseFloat(getComputedStyle(row).paddingLeft),items:Array.from(row.querySelectorAll('[data-toolbar-item]:not([hidden])')).map(item=>{const r=item.getBoundingClientRect();const controls=Array.from(item.querySelectorAll(':scope > button, :scope > div:not(.fixed):not(.absolute) > button')).map(button=>{const b=button.getBoundingClientRect();return{left:b.left,right:b.right,width:b.width,height:b.height,clientWidth:button.clientWidth,scrollWidth:button.scrollWidth,text:button.textContent.trim()}});return{id:item.dataset.toolbarItem,left:r.left,right:r.right,top:r.top,bottom:r.bottom,controls}})})),errors:window.testErrors};
            })()`)
            assert.deepEqual(layout.errors,[])
            assert.equal(layout.rows.length,2)
            assert.deepEqual(layout.rows[0].items.map(item=>item.id),['settings','video','music','backdrop','auto','clicker','output'])
            assert.deepEqual(layout.rows[1].items.map(item=>item.id),edition==='stream'
              ? ['displays','timer','eventTimer','pip','pipViews','stream']
              : ['displays','timer','eventTimer','pip','pipViews'])
            const primaryButtons=layout.rows.flatMap(row=>row.items.filter(item=>item.id!=='pipViews').map(item=>item.controls[0]))
            assert.ok(Math.max(...primaryButtons.map(b=>b.width))-Math.min(...primaryButtons.map(b=>b.width))<1, 'Primary buttons share one width across both rows')
            assert.ok(primaryButtons.every(b=>b.height===32), 'Primary buttons share one 32px height')
            for(const row of layout.rows) {
              assert.ok(row.height<=50, 'Toolbar row must remain compact')
              const expectedGap=row.items.length>1?row.items[1].left-row.items[0].right:row.gap
              for(let i=0;i<row.items.length;i++) {
                const item=row.items[i]
                if(item.right>layout.width || item.left<0) {
                  writeFileSync(resolve('tmp/toolbar-ui/overflow.png'),(await win.webContents.capturePage()).toPNG())
                }
                assert.ok(item.right<=layout.width && item.left>=0,`${edition} ${theme} ${width} busy=${busy}: ${JSON.stringify(item)} overflows ${layout.width}`)
                if(i) assert.ok(Math.abs(item.left-row.items[i-1].right-expectedGap)<1 && expectedGap>=row.gap-1, 'Every toolbar gap must be equal, without spacer holes')
                assert.ok(Math.abs(item.controls[0].left-item.left)<2, 'Control must fill the left edge of its slot')
                assert.ok(Math.abs(item.controls.at(-1).right-item.right)<2, 'Control must fill the right edge, without an empty reserved area')
                for(const control of item.controls) {
                  assert.ok(control.left>=item.left-1 && control.right<=item.right+1, 'Player buttons must stay inside their slot')
                  assert.ok(control.scrollWidth<=control.clientWidth+1,`${edition} ${theme} ${width} busy=${busy}: button text is clipped: ${JSON.stringify(control)}`)
                }
                if(item.id==='pipViews') assert.ok(Math.max(...item.controls.map(c=>c.width))-Math.min(...item.controls.map(c=>c.width))<1, 'Scene view buttons have equal widths')
              }
              assert.ok(Math.abs(row.items[0].left-row.padding)<1 && Math.abs(row.items.at(-1).right-(layout.width-row.padding))<1, 'Each complete row fills the available width')
            }
            assert.equal(layout.rows[1].items.some(item=>item.id==='stream'),edition==='stream')
          }
        }
        console.log(`PASS: ${edition} ${theme} two rows fit 1280/1024/900/880px with all player controls`)
      }
      win.setContentSize(1280,800); await pause(100)
      for(const hide of [['eventTimer','stream','timer','music'],['pip','backdrop','video','displays','auto','clicker']]) {
        await js(`window.testStore.getState().resetToolbarVisibility(); ${JSON.stringify(hide)}.forEach(id=>window.testStore.getState().setToolbarButtonVisible(id,false))`); await pause(80)
        const gaps=await js(`Array.from(document.querySelectorAll('.pdm-toolbar-row')).map(row=>{const items=Array.from(row.querySelectorAll('[data-toolbar-item]:not([hidden])'));return items.slice(1).map((item,i)=>item.getBoundingClientRect().left-items[i].getBoundingClientRect().right)})`)
        for(const row of gaps) for(const gap of row) assert.ok(Math.abs(gap-row[0])<1 && gap>=7,'Hiding optional buttons must redistribute remaining controls evenly')
        const sizes=await js(`Array.from(document.querySelectorAll('[data-toolbar-item]:not([hidden]):not([data-toolbar-item="pipViews"])')).map(item=>item.querySelector('button').getBoundingClientRect().width)`)
        assert.ok(Math.max(...sizes)-Math.min(...sizes)<1,'Custom visible selection keeps equal primary buttons')
      }
      await screenshot(`toolbar-custom-${edition}`)
      await js('window.testStore.getState().resetToolbarVisibility()'); await pause(80)
      await js('window.setTestBusy(false)'); await pause(100)
      await screenshot(`toolbar-idle-${edition}`)
      await js('window.testStore.getState().setProgramScene({enabled:true})'); await pause(80)
      assert.equal(await js(`document.querySelector('[data-toolbar-item="output"] button').textContent.includes('Выйти из эфира')`),true,
        'The main output button must become active when Scene is shown on air')
      await js('window.testStore.getState().setProgramScene({enabled:false})'); await pause(80)
      await js('window.setTestBusy(true)'); await pause(100)
      await screenshot(`toolbar-${edition}`)
      const before=await js(`Array.from(document.querySelectorAll('.pdm-toolbar-program [data-toolbar-item]')).map(el=>({id:el.dataset.toolbarItem,x:el.getBoundingClientRect().x}))`)
      await js('window.testStore.getState().setProgramScene({enabled:false})'); await pause(80)
      const after=await js(`Array.from(document.querySelectorAll('.pdm-toolbar-program [data-toolbar-item]')).map(el=>({id:el.dataset.toolbarItem,x:el.getBoundingClientRect().x}))`)
      assert.deepEqual(after,before,'Changing the picture layer must not move the other controls')
      assert.equal(await js(`Array.from(document.querySelectorAll('[data-toolbar-item="pipViews"] button')).every(button=>button.disabled)`),true)
      await js(`document.querySelector('[data-toolbar-item="settings"] button').click()`); await pause(100)
      assert.equal(await js(`(() => {const probe=document.querySelector('[data-layer-probe-zoom]');const modal=document.querySelector('[data-pdm-modal="settings"]');const stack=document.elementsFromPoint(640,400);const probeIndex=stack.indexOf(probe);const modalIndex=stack.findIndex(element=>element===modal||element.closest?.('[data-pdm-modal="settings"]'));return modalIndex>=0&&(probeIndex<0||modalIndex<probeIndex)})()`),true,'Settings modal must stay above the magnifier and active-channel stripe')
      await js(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()==='Вид').click()`); await pause(100)
      assert.equal(await js(`!!document.querySelector('[data-toolbar-option="stream"]')`),edition==='stream')
      assert.equal(await js(`!!document.querySelector('[data-toolbar-option="output"]')`),false)
      assert.equal(await js(`!!document.querySelector('[data-toolbar-option="pipViews"]')`),false)
      assert.equal(await js(`document.querySelector('[data-toolbar-locked="output"]')?.checked`),true)
      await js(`window.testStore.setState({timerRunning:true,eventTimer:{...window.testStore.getState().eventTimer,remaining:150,running:true}})`)
      const running=await js(`({timer:window.testStore.getState().timerRemaining,event:window.testStore.getState().eventTimer.remaining,music:window.testCalls.filter(c=>c==='music-status').length,stream:window.testCalls.filter(c=>c==='stream-status').length,video:window.testListenerCount('video-state')})`)
      await js(`document.querySelectorAll('[data-toolbar-option]').forEach(input=>{if(input.checked)input.click()})`); await pause(1300)
      assert.deepEqual(await js(`Array.from(document.querySelectorAll('[data-toolbar-item]:not([hidden])')).map(el=>el.dataset.toolbarItem)`),['settings','output'])
      const hidden=await js(`({timer:window.testStore.getState().timerRemaining,event:window.testStore.getState().eventTimer.remaining,music:window.testCalls.filter(c=>c==='music-status').length,stream:window.testCalls.filter(c=>c==='stream-status').length,video:window.testListenerCount('video-state')})`)
      assert.ok(hidden.timer<running.timer && hidden.event<running.event,'Hidden timers must keep ticking')
      assert.ok(hidden.music>running.music,'Hidden music control must retain polling')
      if(edition==='stream')assert.ok(hidden.stream>running.stream,'Hidden streaming control must retain polling')
      assert.equal(hidden.video,running.video,'Video must keep its subscriptions')
      assert.equal(await js(`window.testCalls.includes('stream-stop')||window.testCalls.includes('stream-start')`),false)
      await js(`window.testEmit('video-state',{playing:false,currentTime:42,duration:100})`)
      assert.equal(await js('window.testStore.getState().videoIsPlaying'),false)
      await win.reload(); await pause(300)
      assert.deepEqual(await js(`Array.from(document.querySelectorAll('[data-toolbar-item]:not([hidden])')).map(el=>el.dataset.toolbarItem)`),['settings','output'],'Hidden selection survives reload')
      await js(`document.querySelector('[data-toolbar-item="settings"] button').click()`); await pause(80)
      await js(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()==='Вид').click()`); await pause(80)
      await js(`Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='Показать все').click()`); await pause(80)
      assert.equal(await js(`Array.from(document.querySelectorAll('[data-toolbar-option]')).every(input=>input.checked)`),true)
      assert.equal(await js(`document.querySelectorAll('[data-toolbar-item]:not([hidden])').length`),edition==='stream'?13:12)
      await js(`document.querySelector('[aria-label="Кнопки верхней панели"]').scrollIntoView({block:'center'})`)
      await screenshot(`settings-${edition}`)
      assert.deepEqual(await js('window.testErrors'),[])
      console.log(`PASS: ${edition} checkboxes, settings access, reset, persistence, Scene stability and hidden playback/timer lifecycle`)
    }
    win.destroy();clearTimeout(deadline);app.exit(0)
  } catch(error){console.error(error);win?.destroy();clearTimeout(deadline);app.exit(1)}
})
