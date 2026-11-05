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
      await js(`(() => {
        const store=window.testStore.getState();
        store.setFiles([
          {id:'song',path:'song.mp3',name:'Song',type:'other',extension:'.mp3',size:1,isAudio:true},
          {id:'doc',path:'doc.docx',name:'Doc',type:'other',extension:'.docx',size:1},
          {id:'clip',path:'clip.mp4',name:'Clip',type:'video',extension:'.mp4',size:1}
        ]);
        store.setFilter('music');
      })()`)
      assert.deepEqual(await js(`window.testStore.getState().filteredFiles.map(file=>file.id)`),['song'],'Music filter shows only audio files')
      await js(`window.testStore.getState().setFilter('other')`)
      assert.deepEqual(await js(`window.testStore.getState().filteredFiles.map(file=>file.id)`),['doc'],'Other filter does not duplicate music')
      await js(`window.testStore.getState().setFilter('all');window.testStore.getState().setFiles([])`)
      await js(`(() => {const state=window.testStore.getState(),id=state.channelIds[0];window.testStore.setState({selectedChannel:null,channels:{...state.channels,[id]:{...state.channels[id],file:null,totalSlides:0}},pptxCacheStatuses:{},pptxSlidesMap:{}});})()`)
      console.log(`PASS: ${edition} real toolbar enables PPTX TAKE at 31/123, not 30/123`)
      if(process.env.PDM_PPTX_THRESHOLD_ONLY) continue
      await js(`(() => {
        const state=window.testStore.getState(),id=state.channelIds[0];
        const file={id:'music-target',path:'music-target.pdf',name:'Music target',type:'pdf',extension:'.pdf',size:0};
        window.testStore.setState({musicPlaylist:['first.mp3','second.mp3','third.mp3'],musicNextActions:{},musicStopAfterTrack:false,
          channels:{...state.channels,[id]:{...state.channels[id],file}}});
        window.testMusicState={...window.testMusicState,currentIndex:1,playlistLength:3,loopTrack:false,loopPlaylist:true,stopAfterTrack:false};
      })()`); await pause(80)
      await js(`document.querySelector('[data-toolbar-item="music"] > div > button').click()`); await pause(80)
      await screenshot(`music-playlist-${edition}`)
      const musicStartsBefore=await js(`window.testCalls.filter(call=>call==='music-set-playlist').length`)
      await js(`document.querySelector('[data-music-playlist-row="2"]').click()`); await pause(80)
      assert.equal(await js(`window.testCalls.filter(call=>call==='music-set-playlist').length`),musicStartsBefore,'Single click only selects a music track')
      await js(`document.querySelector('[data-music-playlist-row="2"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`); await pause(80)
      assert.equal(await js(`window.testCalls.filter(call=>call==='music-set-playlist').length`),musicStartsBefore+1,'Double click starts the selected music track')
      assert.equal(await js(`document.querySelector('[data-music-stop-after-track]').getAttribute('aria-pressed')`),'false')
      await js(`document.querySelector('[data-music-stop-after-track]').click()`); await pause(80)
      assert.equal(await js(`window.testStore.getState().musicStopAfterTrack`),true)
      assert.deepEqual(await js(`({track:window.testMusicState.loopTrack,playlist:window.testMusicState.loopPlaylist})`),{track:false,playlist:false})
      await js(`document.querySelector('[data-music-stop-after-track]').parentElement.querySelector('[title="Зацикливание плейлиста"]').click()`); await pause(80)
      assert.equal(await js(`window.testStore.getState().musicStopAfterTrack`),false)
      await js(`(() => {const select=document.querySelector('[data-music-next-action="0"]');select.value='music:third.mp3';select.dispatchEvent(new Event('change',{bubbles:true}));})()`); await pause(80)
      assert.deepEqual(await js(`window.testStore.getState().musicNextActions['first.mp3']`),{kind:'music',path:'third.mp3'})
      assert.deepEqual(await js(`window.testMusicActions['first.mp3']`),{kind:'music',path:'third.mp3'})
      await js(`(() => {const id=window.testStore.getState().channelIds[0],select=document.querySelector('[data-music-next-action="0"]');select.value='channel:'+id;select.dispatchEvent(new Event('change',{bubbles:true}));})()`); await pause(80)
      assert.equal(await js(`window.testStore.getState().musicNextActions['first.mp3'].kind`),'channel')
      await js(`(() => {const transfer=new DataTransfer();document.querySelector('[data-music-drag-handle="0"]').dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:transfer}));const row=document.querySelector('[data-music-playlist-row="2"]');row.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:transfer}));row.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));})()`); await pause(80)
      assert.deepEqual(await js(`window.testStore.getState().musicPlaylist`),['second.mp3','third.mp3','first.mp3'])
      assert.deepEqual(await js(`window.testMusicReorder`),['second.mp3','third.mp3','first.mp3'])
      assert.equal(await js(`window.testMusicState.playing`),true,'Reorder must not stop playback')
      await js(`(() => {window.testMusicState.pendingChannel=window.testStore.getState().channelIds[0];window.testMusicState.transitionSerial++;})()`)
      await pause(1100)
      assert.deepEqual(await js(`window.testChannelTakeEvents`),[await js(`window.testStore.getState().channelIds[0]`)],'Music completion must take selected presentation channel once')
      await js(`document.querySelector('[data-toolbar-item="music"] > div > button').click()`); await pause(80)
      await js(`window.testStore.setState({musicPlaylist:[],musicNextActions:{},musicStopAfterTrack:false});window.testChannelTakeEvents=[]`)
      console.log(`PASS: ${edition} music one-track stop, next action, drag reorder and channel transition`)
      await js(`(() => {
        const state=window.testStore.getState(), id=state.channelIds[0];
        const before={id:'return-channel-file',path:'before.pdf',name:'Before video',type:'presentation',extension:'.pdf',size:0};
        window.testStore.setState({
          channels:{...state.channels,[id]:{...state.channels[id],file:before}},
          videoPlaylist:['first.mp4','selected.mp4'],videoCurrentIndex:1,
          activeFile:{id:'video-playlist-current',path:'selected.mp4',name:'Selected',type:'video',extension:'.mp4',size:0},
          liveChannel:null,videoIsPlaying:true,videoLoopTrack:true,videoLoopPlaylist:true,videoStopAfterTrack:false,channelVideoAutoplay:false
        });
      })()`); await pause(80)
      await js(`document.querySelector('[data-toolbar-item="video"] > div > button').click()`); await pause(80)
      assert.equal(await js(`document.querySelector('[data-channel-video-autoplay]').checked`),false,'Channel video autoplay must default off')
      await js(`document.querySelector('[data-channel-video-autoplay]').click()`); await pause(80)
      assert.equal(await js(`window.testStore.getState().channelVideoAutoplay`),true,'Operator can enable channel video autoplay')
      await js(`document.querySelector('[data-channel-video-autoplay]').click()`); await pause(80)
      assert.equal(await js(`window.testStore.getState().channelVideoAutoplay`),false,'Operator can disable channel video autoplay')
      assert.equal(await js(`document.querySelector('[data-video-stop-after-track]')?.getAttribute('aria-pressed')`),'false')
      await js(`document.querySelector('[data-video-stop-after-track]').click()`); await pause(80)
      await screenshot(`video-one-track-${edition}`)
      assert.deepEqual(await js(`({stop:window.testStore.getState().videoStopAfterTrack,track:window.testStore.getState().videoLoopTrack,playlist:window.testStore.getState().videoLoopPlaylist})`),{stop:true,track:false,playlist:false})
      assert.deepEqual(await js(`window.testPresentationMessages.at(-1)`),['set-loop',false],'One-track mode must turn off the active video loop immediately')
      await js(`(() => {const state=window.testStore.getState(),id=state.channelIds[0];window.testStore.setState({liveChannel:id,activeFile:state.channels[id].file});document.querySelector('[data-toolbar-item="video"] .cursor-pointer[title="selected.mp4"]').click()})()`); await pause(80)
      assert.equal(await js(`window.testPlaylistTakeEvents.length`),0,'Single click only selects a video')
      await js(`document.querySelector('[data-toolbar-item="video"] .cursor-pointer[title="selected.mp4"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`); await pause(80)
      assert.equal(await js(`window.testPlaylistTakeEvents.length`),1)
      assert.equal(await js(`window.testPlaylistTakeEvents[0].loop`),false,'The selected playlist video must start without looping')
      await js(`window.testStore.setState({liveChannel:null,activeFile:{id:'video-playlist-new',path:'selected.mp4',name:'Selected',type:'video',extension:'.mp4',size:0},videoIsPlaying:true})`); await pause(80)
      await js(`window.testEmit('video-ended',{path:'first.mp4'})`)
      assert.equal(await js(`window.testPresentationMessages.filter(message=>message[0]==='stop').length`),0,'Stale ended event must not stop another selected video')
      await js(`window.testEmit('video-ended',{path:'selected.mp4'})`); await pause(80)
      assert.equal(await js(`window.testPresentationMessages.filter(message=>message[0]==='stop').length`),1,'The selected video must stop after its end')
      await js(`window.testEmit('video-ended',{path:'selected.mp4'})`)
      assert.equal(await js(`window.testPresentationMessages.filter(message=>message[0]==='stop').length`),1,'Duplicate ended events must not stop twice')
      assert.equal(await js(`window.testPlaylistTakeEvents.length`),1,'One-track mode must not advance to the next playlist video')
      assert.deepEqual(await js(`window.testChannelTakeEvents`),[await js(`window.testStore.getState().channelIds[0]`)],'End-of-track stop returns to the prior on-air channel')
      assert.equal(await js(`window.testStore.getState().videoIsPlaying`),false)
      await js(`document.querySelector('[data-video-stop-after-track]').parentElement.querySelector('[title="Зацикливание плейлиста"]').click()`); await pause(80)
      assert.deepEqual(await js(`({stop:window.testStore.getState().videoStopAfterTrack,playlist:window.testStore.getState().videoLoopPlaylist})`),{stop:false,playlist:true})
      await js(`(() => {
        window.testPlaylistTakeEvents=[];window.testChannelTakeEvents=[];window.testPresentationMessages=[];
        window.testStore.setState({
          videoPlaylist:['first.mp4','selected.mp4','third.mp4'],videoCurrentIndex:0,videoNextActions:{},
          activeFile:{id:'video-playlist-choice',path:'first.mp4',name:'First',type:'video',extension:'.mp4',size:0},
          liveChannel:null,videoIsPlaying:true,videoLoopTrack:true,videoLoopPlaylist:true,videoStopAfterTrack:true
        });
      })()`); await pause(80)
      await js(`(() => {const select=document.querySelector('[data-video-next-action="0"]');select.value='video:third.mp4';select.dispatchEvent(new Event('change',{bubbles:true}));})()`); await pause(80)
      assert.deepEqual(await js(`({action:window.testStore.getState().videoNextActions['first.mp4'],one:window.testStore.getState().videoStopAfterTrack,loop:window.testStore.getState().videoLoopTrack})`),{action:{kind:'video',path:'third.mp4'},one:false,loop:false},'Choosing a specific next video disables conflicting modes')
      await js(`window.testEmit('video-ended',{path:'first.mp4'})`); await pause(80)
      assert.equal(await js(`window.testPlaylistTakeEvents.at(-1)?.file.path`),'third.mp4','Configured next video must replace playlist order')
      await js(`(() => {
        window.testPlaylistTakeEvents=[];window.testChannelTakeEvents=[];
        window.testStore.setState({videoCurrentIndex:0,videoNextActions:{},activeFile:{id:'video-playlist-channel-choice',path:'first.mp4',name:'First',type:'video',extension:'.mp4',size:0},videoIsPlaying:true});
      })()`); await pause(80)
      await js(`(() => {const id=window.testStore.getState().channelIds[0],select=document.querySelector('[data-video-next-action="0"]');select.value='channel:'+id;select.dispatchEvent(new Event('change',{bubbles:true}));})()`); await pause(80)
      await screenshot(`video-next-action-${edition}`)
      assert.equal(await js(`window.testStore.getState().videoNextActions['first.mp4'].kind`),'channel')
      await js(`window.testEmit('video-ended',{path:'first.mp4'})`); await pause(80)
      assert.deepEqual(await js(`window.testChannelTakeEvents`),[await js(`window.testStore.getState().channelIds[0]`)],'Configured presentation channel must take over after video')
      assert.equal(await js(`window.testPlaylistTakeEvents.length`),0,'Channel target must not start another video')
      await js(`(() => {
        window.testStore.setState({liveChannel:null,videoCurrentIndex:1,activeFile:{id:'video-playlist-drag',path:'selected.mp4',name:'Selected',type:'video',extension:'.mp4',size:0},videoIsPlaying:true});
        const transfer=new DataTransfer();
        document.querySelector('[data-video-drag-handle="0"]').dispatchEvent(new DragEvent('dragstart',{bubbles:true,cancelable:true,dataTransfer:transfer}));
        const row=document.querySelector('[data-video-playlist-row="2"]');
        row.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:transfer}));
        row.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));
      })()`); await pause(80)
      assert.deepEqual(await js(`({playlist:window.testStore.getState().videoPlaylist,index:window.testStore.getState().videoCurrentIndex,playing:window.testStore.getState().videoIsPlaying,action:window.testStore.getState().videoNextActions['first.mp4']})`),{playlist:['selected.mp4','third.mp4','first.mp4'],index:0,playing:true,action:{kind:'channel',channelId:await js(`window.testStore.getState().channelIds[0]`)}},'Drag reorder must preserve selected playing video and its end action')
      assert.equal(await js(`window.testPlaylistTakeEvents.length`),0,'Drag reorder must not restart playback')
      await js(`window.testStore.setState({liveChannel:null,activeFile:null,videoPlaylist:[],videoIsPlaying:false})`)
      await js(`document.querySelector('[data-toolbar-item="video"] > div > button').click()`); await pause(80)
      console.log(`PASS: ${edition} one-track stop, explicit next video/channel and drag reorder`)
      await js(`window.testStore.setState({musicPlaylist:[],videoPlaylist:[],musicFolderPath:'C:/music',videoFolderPath:'C:/video'});window.testMediaFiles={music:['C:/music/new.mp3'],video:['C:/video/new.mp4']}`)
      await pause(2200)
      assert.deepEqual(await js(`window.testStore.getState().musicPlaylist`),['C:/music/new.mp3'],'Music folder updates without reopening dialog')
      assert.deepEqual(await js(`window.testStore.getState().videoPlaylist`),['C:/video/new.mp4'],'Video folder updates without reopening dialog')
      await js(`window.testStore.setState({musicFolderPath:null,videoFolderPath:null,musicPlaylist:[],videoPlaylist:[]})`)
      console.log(`PASS: ${edition} music and video folders automatically gain new files`)
      for(const theme of ['classic','broadcast-pro']) {
        await js(`window.testStore.getState().setAppTheme(${JSON.stringify(theme)})`)
        for(const width of [1280,1024,900,880]) {
          win.setContentSize(width,800); await pause(80)
          for(const busy of [false,true]) {
            await js(`window.setTestBusy(${busy})`); await pause(80)
            const layout=await js(`(() => {
              const rows=Array.from(document.querySelectorAll('.pdm-toolbar-row'));
              const toolbar=document.querySelector('.pdm-toolbar'); return {width:innerWidth,buttonWidth:getComputedStyle(toolbar).getPropertyValue('--pdm-toolbar-button-width'),rows:rows.map(row=>({height:row.getBoundingClientRect().height,clientWidth:row.clientWidth,rectWidth:row.getBoundingClientRect().width,gap:parseFloat(getComputedStyle(row).columnGap),padding:parseFloat(getComputedStyle(row).paddingLeft),items:Array.from(row.querySelectorAll('[data-toolbar-item]:not([hidden])')).map(item=>{const r=item.getBoundingClientRect();const controls=Array.from(item.querySelectorAll(':scope > button, :scope > div:not(.fixed):not(.absolute) > button')).map(button=>{const b=button.getBoundingClientRect();return{left:b.left,right:b.right,width:b.width,height:b.height,clientWidth:button.clientWidth,scrollWidth:button.scrollWidth,text:button.textContent.trim()}});return{id:item.dataset.toolbarItem,left:r.left,right:r.right,top:r.top,bottom:r.bottom,controls}})})),errors:window.testErrors};
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
                assert.ok(item.right<=layout.width && item.left>=0,`${edition} ${theme} ${width} busy=${busy}: ${JSON.stringify(item)} overflows ${layout.width}; buttonWidth=${layout.buttonWidth}; row=${row.clientWidth}/${row.rectWidth}; items=${JSON.stringify(row.items)}`)
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
      await js(`document.querySelector('[data-pdm-settings-tab="virtual-camera"]').click()`); await pause(100)
      assert.equal(await js(`document.querySelector('[data-pdm-virtual-camera-settings]')?.textContent.includes('1920×1080 · 30 кадров/с')`),true,'Virtual camera settings must show fixed Full HD quality')
      assert.equal(await js(`document.querySelector('[data-pdm-virtual-camera-settings]')?.textContent.includes('Без растягивания')`),true,'Virtual camera settings must explain aspect preservation')
      assert.equal(await js(`document.querySelector('[data-pdm-virtual-camera-settings]')?.textContent.includes('Виртуальная камера не передаёт звук')`),true,'Virtual camera settings must state that audio is selected separately')
      assert.equal(await js(`document.querySelector('[data-pdm-virtual-camera-settings]')?.textContent.includes('VB-CABLE')`),false,'Virtual camera settings must not offer a third-party audio bridge')
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
      await js(`window.testStore.setState({activeFile:{id:'video-playlist-hidden',path:'selected.mp4',name:'Selected',type:'video',extension:'.mp4',size:0},liveChannel:null,videoPlaylist:['selected.mp4'],videoIsPlaying:true})`)
      await js(`window.testEmit('video-state',{playing:false,currentTime:42,duration:100})`)
      assert.equal(await js('window.testStore.getState().videoIsPlaying'),false,'Hidden video playlist still receives its own playback state')
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
