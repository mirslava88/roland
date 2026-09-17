const { app, BrowserWindow } = require('electron')
const { resolve } = require('node:path')
const { writeFileSync } = require('node:fs')
const assert = require('node:assert/strict')
app.setPath('userData',resolve('tmp/onboarding-ui/profile'))
const deadline=setTimeout(()=>app.exit(1),150000)
const pause=ms=>new Promise(done=>setTimeout(done,ms))
app.whenReady().then(async()=>{
 let win
 try{
  win=new BrowserWindow({show:false,width:1280,height:800,useContentSize:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}})
  const js=code=>win.webContents.executeJavaScript(code)
  const frame=code=>js('(()=>{const w=document.querySelector("iframe")?.contentWindow,d=w?.document;return ('+code+')})()')
  const wait=async(check,label)=>{for(let i=0;i<160;i++){if(await check())return;await pause(80)}throw Error('Timed out: '+label)}
  const rawStep=async n=>wait(()=>frame('d.querySelector(".interface-tour-card header span")?.textContent.includes("Шаг '+(n+1)+' из 31")'),'tour step '+(n+1))
  const step=rawStep
  const screen=async name=>{await pause(120);writeFileSync(resolve('tmp/onboarding-ui/'+name+'.png'),(await win.webContents.capturePage()).toPNG())}
  const start=async()=>{await js('document.querySelector(".intro-primary").click()');await wait(()=>frame('!!w?.trainingStore && !!d.querySelector(".pdm-toolbar-row")'),'real operator frame');await step(0)}
  const click=async selector=>{await wait(()=>frame('!!d.querySelector('+JSON.stringify(selector)+')'),'control '+selector);await frame('d.querySelector('+JSON.stringify(selector)+').click()')}
  const rightClickFrame=async selector=>{
   await wait(()=>frame('!!d.querySelector('+JSON.stringify(selector)+')'),'right-click target '+selector)
   const point=await js('(()=>{const f=document.querySelector("iframe").getBoundingClientRect(),e=document.querySelector("iframe").contentWindow.document.querySelector('+JSON.stringify(selector)+'),r=e.getBoundingClientRect();return {x:Math.round(f.left+r.left+r.width/2),y:Math.round(f.top+r.top+r.height/2)}})()')
   win.webContents.sendInputEvent({type:'mouseDown',x:point.x,y:point.y,button:'right',clickCount:1});win.webContents.sendInputEvent({type:'mouseUp',x:point.x,y:point.y,button:'right',clickCount:1})
  }
  const dragFrame=async(selector,deltaX,deltaY)=>{
   await wait(()=>frame('!!d.querySelector('+JSON.stringify(selector)+')'),'drag target '+selector)
   const point=await js('(()=>{const f=document.querySelector("iframe").getBoundingClientRect(),e=document.querySelector("iframe").contentWindow.document.querySelector('+JSON.stringify(selector)+'),r=e.getBoundingClientRect();return {x:Math.round(f.left+r.left+r.width/2),y:Math.round(f.top+r.top+r.height/2)}})()')
   win.webContents.sendInputEvent({type:'mouseDown',x:point.x,y:point.y,button:'left',clickCount:1})
   for(let index=1;index<=4;index++){win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(point.x+deltaX*index/4),y:Math.round(point.y+deltaY*index/4),button:'left'});await pause(25)}
   win.webContents.sendInputEvent({type:'mouseUp',x:point.x+deltaX,y:point.y+deltaY,button:'left',clickCount:1})
  }
  const loadTrainingStep=async index=>{
   await js('(()=>{const e=document.querySelector("iframe"),u=new URL(e.src);u.searchParams.set("step",'+index+');e.src=u.href;return true})()')
   await rawStep(index)
   await wait(()=>frame('!!w.trainingStore'),'training store for step '+(index+1))
  }
  const restoredStateMatches=async index=>frame(`(()=>{const s=w.trainingStore.getState(),a=s.channelIds[0],b=s.channelIds[1];switch(${index}){
   case 0:return !s.channels[a]?.file;
   case 1:return !!s.channels[a]?.file&&!s.channels[b]?.file;
   case 2:return !!s.channels[a]?.file&&!!s.channels[b]?.file&&s.selectedChannel===null;
   case 3:return s.selectedChannel===a&&!s.activeFile;
   case 4:return s.liveChannel===a&&s.selectedChannel===a;
   case 5:return s.liveChannel===a&&s.selectedChannel===b;
   case 6:return s.liveChannel===b&&s.currentSlide===1;
   case 7:return !d.querySelector("[data-pdm-training-panel=video]");
   case 8:return !d.querySelector("[data-pdm-training-panel=music]");
   case 9:return s.backdropImage===null;
   case 10:return s.channelBoundaryNavigationEnabled===false;
   case 11:return s.globalHookEnabled===true;
   case 12:return !d.querySelector("[data-pdm-training-panel=timer]");
   case 13:return !d.querySelector("[data-pdm-training-panel=event-timer]");
   case 14:return !d.querySelector("[data-pdm-display-modal]");
   case 15:return !d.querySelector("[data-program-scene-modal]");
   case 16:return !!d.querySelector("[data-program-scene-modal]")&&!d.querySelector("[data-scene-add=text]");
   case 17:return !!d.querySelector("[data-program-scene-modal]")&&!!d.querySelector("[data-scene-add=text]");
   case 18:return !!d.querySelector("[data-program-scene-text-id]")&&!s.programScene.enabled;
   case 19:return s.programScene.enabled&&!!s.programSnapshot;
   case 20:return s.programScene.enabled&&!!s.programSnapshot&&JSON.stringify(s.programScene.textOverlays)!==JSON.stringify(s.programSnapshot.scene.textOverlays);
   case 21:return !s.programScene.captureSourceId;
   case 22:return !!s.programScene.captureSourceId&&!s.programScene.chromaKey.enabled;
   case 23:return s.programScene.chromaKey.enabled&&s.qrOverlay.url==="https://";
   case 24:return !!s.qrOverlay.url&&d.querySelector("[data-scene-panel=titles]")?.getAttribute("aria-selected")==="true"&&s.broadcastTitles.eventInfo==="";
   case 25:return s.broadcastTitles.eventInfo.length>=4&&d.querySelector("[data-scene-panel=titles]")?.getAttribute("aria-selected")==="true";
   case 26:return !!d.querySelector("[data-program-scene-modal]");
   case 27:return !d.querySelector("[data-program-scene-modal]")&&s.programScene.viewMode!=="content";
   case 28:return !d.querySelector("[data-pdm-training-panel=settings]");
   case 29:return !d.querySelector("[data-pdm-training-panel=stream]");
   case 30:return !!s.activeFile&&s.programScene.enabled;
   default:return false;
  }})()`)
  const verifyEveryBackRestoration=async()=>{
   for(let current=1;current<=30;current++){
    await loadTrainingStep(current)
    await click('.interface-tour-back')
    const previous=current-1
    await rawStep(previous)
    await wait(()=>restoredStateMatches(previous),'restored prerequisites for step '+(previous+1))
    const optionalStream=previous===29&&await frame('!d.querySelector("[data-toolbar-item=stream]")')
    if(!optionalStream) assert.equal(await frame('d.querySelector("[data-pdm-training-tour]")?.getAttribute("data-pdm-training-ready")'), 'false', 'Back must restore step '+(previous+1)+' before its action')
    assert.equal(await frame('d.querySelector(".interface-tour-card")?.textContent.includes("Вы уже проходили этот шаг")'),false,'Back must restore an actionable step, not passive review')
    if(previous===26){
     await click('[data-program-scene-modal] > div:first-child button:last-child')
     await wait(()=>frame('d.querySelector(".interface-tour-card h3")?.textContent.trim()==="Готово"'),'replayed Scene close after Back')
    }
   }
  }
  const fill=async(selector,value)=>{await wait(()=>frame('!!d.querySelector('+JSON.stringify(selector)+')'),'field '+selector);await frame('(()=>{const e=d.querySelector('+JSON.stringify(selector)+'),p=e.tagName==="TEXTAREA"?w.HTMLTextAreaElement.prototype:w.HTMLInputElement.prototype,s=Object.getOwnPropertyDescriptor(p,"value").set;s.call(e,'+JSON.stringify(value)+');e.dispatchEvent(new w.Event("input",{bubbles:true}));return e.value})()')}
  const nextAfterDone=async nextIndex=>{
   await wait(()=>frame('d.querySelector(".interface-tour-card h3")?.textContent.trim()==="Готово"&&!!d.querySelector(".interface-tour-next")'),'readable done result')
   await click('.interface-tour-next');await step(nextIndex)
  }
  const inspectPanel=async(index,button,panel)=>{
   await click(button);await wait(()=>frame('!!d.querySelector('+JSON.stringify(panel)+')'),'opened settings '+panel)
   await wait(()=>frame('!d.querySelector(".interface-tour-card")'),'tour card hidden for '+panel)
   assert.equal(await frame('!!d.querySelector(".interface-tour-card")'),false,'Tour card must not cover opened settings')
   assert.ok(await js('document.querySelector(".intro-interface-header span").textContent.includes("закройте окно крестиком")'),'Outer training header explains how to continue')
    if(index===7) await screen('actual-video-settings')
    if(index===12){
    await frame('Array.from(d.querySelectorAll("[data-pdm-training-panel=timer] button")).find(e=>e.textContent.includes("Выбрать")).click()');await pause(150)
    assert.equal(await frame('w.trainingStore.getState().timerSoundWarning'),null,'Sound selection is a no-op in training')
    assert.equal(await frame('!!d.querySelector("[data-pdm-training-panel=timer]")'),true,'Timer settings stay open after training sound click')
   }
   await click(panel+' [data-pdm-training-close]');await step(index+1)
  }
  await win.loadFile(resolve('tmp/onboarding-ui/index.html'));await pause(200)
  await js('localStorage.clear()');win.reload();await pause(300)
  const before=await js('JSON.stringify(window.testStore.getState())')
  const persisted=await js('JSON.stringify(Object.fromEntries(Object.entries(localStorage).filter(([k])=>k!==window.testKey)))')
  assert.ok(await js('document.querySelector(".intro-welcome").textContent.includes("второй экран")'))
  assert.equal(await js('document.querySelector(".intro-primary").textContent.trim()'),'Пройти обучение')
  assert.equal(await js('document.querySelector(".intro-real-workspace").inert'),true);await screen('welcome')
  await js('document.querySelector(".intro-welcome-actions button:nth-child(2)").click()');win.reload();await pause(300)
  assert.equal(await js('!!document.querySelector("[data-pdm-onboarding]")'),false)
  await js('window.openIntroduction()');await pause(80);await start()
  assert.equal(await frame('d.querySelectorAll(".pdm-toolbar-row").length'),2)
  assert.equal(await frame('!!d.querySelector(".pdm-channel-card") && !!d.querySelector(".pdm-main-workspace")'),true)
  await verifyEveryBackRestoration()
  await loadTrainingStep(0)
  await pause(1100);await step(0)
  await wait(()=>frame('!!d.querySelector(".interface-tour-drag-guide")'),'animated drag guide')
  assert.equal(await frame('w.getComputedStyle(d.querySelector(".interface-tour-drag-guide")).pointerEvents'),'none')
  assert.equal(await frame('(()=>{const e=d.querySelector("[data-pdm-file-id=pdm-training-deck]"),r=e.getBoundingClientRect();return d.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest("[data-pdm-file-item]")===e})()'),true,'Tour overlay must not block grabbing the first presentation')
  await screen('actual-channels')
   await frame('(()=>{const s=d.querySelector("[data-pdm-file-id=pdm-training-deck]"),t=d.querySelectorAll(".pdm-channel-card")[0],dt=new w.DataTransfer();s.dispatchEvent(new w.DragEvent("dragstart",{bubbles:true,cancelable:true,dataTransfer:dt}));t.dispatchEvent(new w.DragEvent("dragover",{bubbles:true,cancelable:true,dataTransfer:dt}));t.dispatchEvent(new w.DragEvent("drop",{bubbles:true,cancelable:true,dataTransfer:dt}));s.dispatchEvent(new w.DragEvent("dragend",{bubbles:true,dataTransfer:dt}));return dt.getData("application/json").includes("pdm-training-deck")})()');await step(1)
   assert.equal(await frame('(()=>{const e=d.querySelector("[data-pdm-file-id=pdm-training-deck-2]"),r=e.getBoundingClientRect();return d.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest("[data-pdm-file-item]")===e})()'),true,'Tour overlay must not block grabbing the second presentation')
   await frame('(()=>{const s=d.querySelector("[data-pdm-file-id=pdm-training-deck-2]"),t=d.querySelectorAll(".pdm-channel-card")[1],dt=new w.DataTransfer();s.dispatchEvent(new w.DragEvent("dragstart",{bubbles:true,cancelable:true,dataTransfer:dt}));t.dispatchEvent(new w.DragEvent("dragover",{bubbles:true,cancelable:true,dataTransfer:dt}));t.dispatchEvent(new w.DragEvent("drop",{bubbles:true,cancelable:true,dataTransfer:dt}));s.dispatchEvent(new w.DragEvent("dragend",{bubbles:true,dataTransfer:dt}));return dt.getData("application/json").includes("pdm-training-deck-2")})()')
   await wait(()=>frame('d.querySelector(".interface-tour-card p")?.textContent.includes("Обе презентации готовы")'),'second presentation result')
   await pause(1200)
   assert.ok(await frame('d.querySelector(".interface-tour-card header span")?.textContent.includes("Шаг 2 из 31")'),'Step 2 result must remain readable before step 3')
   await nextAfterDone(2)
   await click('.pdm-channel-card:nth-child(1)');await step(3)
   await click('[data-toolbar-item="output"] button');await step(4)
   await click('.pdm-channel-card:nth-child(2)');await step(5)
   assert.equal(await frame('d.querySelector("[data-toolbar-item=output] button")?.textContent.includes("Выйти из эфира")'),true,'Global output button must already mean exit before the seamless channel switch')
   await wait(()=>frame('!d.querySelectorAll(".pdm-channel-card")[1]?.querySelector("[data-pdm-channel-take]")?.disabled'),'second channel take button ready')
   assert.equal(await frame('(()=>{const c=d.querySelectorAll(".pdm-channel-card")[1],b=c?.querySelector("[data-pdm-channel-take]");return !!b&&d.querySelector(".interface-tour-outline").getBoundingClientRect().left<=b.getBoundingClientRect().left&&d.querySelector(".interface-tour-outline").getBoundingClientRect().right>=b.getBoundingClientRect().right})()'),true,'Step 6 must highlight the take button inside the second channel')
   assert.equal(await frame('(()=>{const b=d.querySelectorAll(".pdm-channel-card")[1]?.querySelector("[data-pdm-channel-take]"),r=b.getBoundingClientRect();return d.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest("[data-pdm-channel-take]")===b})()'),true,'Step 6 overlay must leave the second channel take button clickable')
   await click('.pdm-channel-card:nth-child(2) [data-pdm-channel-take]')
   await wait(()=>frame('d.querySelector(".interface-tour-card p")?.textContent.includes("Первый канал остаётся готовым")'),'seamless channel result')
   await nextAfterDone(6)
   await wait(()=>frame('d.querySelectorAll(".pdm-slide-thumb").length===3'),'real thumbnails')
   await frame('d.querySelectorAll(".pdm-slide-thumb")[1].click()');await step(7)
   await inspectPanel(7,'[data-toolbar-item="video"] button:first-child','[data-pdm-training-panel="video"]')
   await inspectPanel(8,'[data-toolbar-item="music"] button:first-child','[data-pdm-training-panel="music"]')
   for(const [index,selector] of [
    [9,'[data-toolbar-item="backdrop"] button'],[10,'[data-toolbar-item="auto"] button']
   ]){await click(selector);await nextAfterDone(index+1)}
  assert.equal(await frame('w.trainingStore.getState().globalHookEnabled'),true,'Clicker starts enabled')
  await click('[data-toolbar-item="clicker"] button')
  await wait(()=>frame('d.querySelector(".interface-tour-card p")?.textContent.includes("Кликер выключен")'),'clicker result follows actual state')
  await pause(2500)
  assert.ok(await frame('d.querySelector(".interface-tour-card p")?.textContent.includes("Кликер выключен")'),'Clicker result remains readable')
   await nextAfterDone(12)
   await inspectPanel(12,'[data-toolbar-item="timer"] button:first-child','[data-pdm-training-panel="timer"]')
   await inspectPanel(13,'[data-toolbar-item="eventTimer"] button:first-child','[data-pdm-training-panel="event-timer"]')
  assert.equal(await frame('!!d.querySelector(".event-timer-ui") || !!d.querySelector("[data-pdm-display-modal]")'),false,'Timer+ closes without opening Screens')
   await inspectPanel(14,'[data-toolbar-item="displays"] button','[data-pdm-display-modal]')
  assert.equal(await frame('!!d.querySelector("[data-pdm-display-modal]")'),false,'Screens overview closes before Scene')
   await click('[data-toolbar-item="pip"] button');await step(16)
   await rightClickFrame('[data-program-scene-preview]');await step(17)
  assert.equal(await frame('(()=>{const b=d.querySelector("[data-scene-add=text]")?.getBoundingClientRect(),o=d.querySelector(".interface-tour-outline")?.getBoundingClientRect();return !!b&&!!o&&Math.abs(b.left-o.left)<=7&&Math.abs(b.top-o.top)<=7&&Math.abs(b.width-o.width)<=12&&Math.abs(b.height-o.height)<=12})()'),true,'The Text command must be framed in blue before it is selected')
  await click('[data-scene-add="text"]')
  await wait(()=>frame('!!d.querySelector("[data-program-scene-inline-text]")'),'actual inline editor')
  await frame('(()=>{const e=d.querySelector("[data-program-scene-inline-text]");e.click();e.focus();const r=d.createRange();r.selectNodeContents(e);const s=w.getSelection();s.removeAllRanges();s.addRange(r);return true})()')
   win.webContents.insertText('Учебная надпись');await step(18)
   await click('[data-program-scene-picture-visible]');await step(19)
  const published=await frame('JSON.stringify(w.trainingStore.getState().programSnapshot.scene.textOverlays)')
  await screen('actual-scene-live')
   await frame('(()=>{const e=d.querySelector("[data-program-scene-text-id]"),r=e.getBoundingClientRect();e.dispatchEvent(new w.WheelEvent("wheel",{bubbles:true,cancelable:true,deltaY:-100,clientX:r.left+40,clientY:r.top+10}));return true})()');await step(20)
  assert.equal(await frame('JSON.stringify(w.trainingStore.getState().programSnapshot.scene.textOverlays)'),published,'Draft must not leak to program')
   await click('[data-program-scene-refresh]');await step(21)
   assert.notEqual(await frame('JSON.stringify(w.trainingStore.getState().programSnapshot.scene.textOverlays)'),published)
   await click('[data-program-scene-select-external-source]')
   await click('[data-scene-external-source="device:training-camera"]');await step(22)
   await frame('(()=>{const e=d.querySelector("[data-program-scene-participant-preview]"),r=e.getBoundingClientRect();e.dispatchEvent(new w.MouseEvent("contextmenu",{bubbles:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2}));return true})()')
   await click('[data-scene-object-action="chroma"]');await click('[data-program-scene-chroma-toggle]');await screen('actual-chroma-training')
   assert.equal(await frame('d.querySelector("[data-program-scene-chroma-toggle]")?.checked'),true,'Chroma key is visibly enabled in its real editor')
   await nextAfterDone(23)
   assert.equal(await frame('(()=>{const p=d.querySelector("[data-program-scene-preview]").getBoundingClientRect(),c=d.querySelector(".interface-tour-card").getBoundingClientRect();return c.right<=p.left||c.left>=p.right||c.bottom<=p.top||c.top>=p.bottom})()'),true,'Step 24 card must not cover the Scene preview before the context menu opens')
   await rightClickFrame('[data-program-scene-preview]');await wait(()=>frame('!!d.querySelector("[data-scene-add=qr]")'),'QR command in real context menu')
   await click('[data-scene-add="qr"]');await wait(()=>frame('!!d.querySelector("[data-pdm-training-qr-url]")'),'QR URL field')
   await wait(()=>frame('(()=>{const f=d.querySelector("[data-pdm-training-qr-url]").getBoundingClientRect(),c=d.querySelector(".interface-tour-card").getBoundingClientRect();return c.right<=f.left||c.left>=f.right||c.bottom<=f.top||c.top>=f.bottom})()'),'QR lesson card clear of URL field')
   assert.equal(await frame('(()=>{const c=d.querySelector(".interface-tour-card");return w.getComputedStyle(c).overflowY==="hidden"&&c.scrollHeight<=c.clientHeight+1})()'),true,'Step 24 hint must fit without a scrollbar or clipped content')
   await frame('d.querySelector("[data-pdm-training-qr-url]").focus()');await fill('[data-pdm-training-qr-url]','https://pdm.example');await pause(900)
   assert.ok(await frame('d.querySelector(".interface-tour-card header span")?.textContent.includes("Шаг 24 из 31")'),'QR lesson must not advance while the address field is still focused')
   assert.equal(await frame('(()=>{const p=d.querySelector("[data-program-scene-preview]").getBoundingClientRect(),c=d.querySelector(".interface-tour-card").getBoundingClientRect();return c.right<=p.left||c.left>=p.right||c.bottom<=p.top||c.top>=p.bottom})()'),true,'QR preview must not be covered by the lesson card')
   assert.equal(await frame('(()=>{const e=d.querySelector("[data-program-scene-preview]"),r=e.getBoundingClientRect();return d.elementFromPoint(r.left+12,r.top+12)?.closest("[data-program-scene-preview]")===e})()'),true,'QR preview must remain clickable during the form lesson')
   await wait(()=>frame('!!d.querySelector("[data-scene-qr-object]")'),'rendered QR in Scene preview')
   assert.ok(await frame('d.querySelector(".interface-tour-card p")?.textContent.includes("перетяните появившийся QR-код")'),'QR lesson must explicitly ask the user to move the QR code')
   assert.equal(await frame('(()=>{const q=d.querySelector("[data-scene-qr-object]").getBoundingClientRect(),o=d.querySelector(".interface-tour-outline").getBoundingClientRect();return Math.abs(q.left-o.left)<=7&&Math.abs(q.top-o.top)<=7&&Math.abs(q.width-o.width)<=12&&Math.abs(q.height-o.height)<=12})()'),true,'Ready QR must become the blue highlighted drag target')
   const qrBefore=await frame('JSON.stringify({x:w.trainingStore.getState().qrOverlay.xPercent,y:w.trainingStore.getState().qrOverlay.yPercent})')
   await dragFrame('[data-scene-qr-object]',45,24)
   await wait(async()=>await frame('JSON.stringify({x:w.trainingStore.getState().qrOverlay.xPercent,y:w.trainingStore.getState().qrOverlay.yPercent})')!==qrBefore,'QR position changed after a real pointer drag')
   await wait(()=>frame('d.querySelector(".interface-tour-card h3")?.textContent.trim()==="Готово"'),'QR result visible')
   assert.equal(await frame('(()=>{const c=d.querySelector(".interface-tour-card");return w.getComputedStyle(c).overflowY==="hidden"&&c.scrollHeight<=c.clientHeight+1})()'),true,'Completed Step 24 hint must still fit without a scrollbar')
   assert.equal(await frame('(()=>{const p=d.querySelector("[data-program-scene-preview]").getBoundingClientRect(),c=d.querySelector(".interface-tour-card").getBoundingClientRect();return c.right<=p.left||c.left>=p.right||c.bottom<=p.top||c.top>=p.bottom})()'),true,'Ready QR and its result card must both remain visible')
   assert.equal(await frame('d.querySelector(".interface-tour-back")?.disabled'),false,'Back remains available on completed QR step')
   await screen('actual-qr-training');await nextAfterDone(24)
   await click('[data-scene-panel="titles"]')
   await wait(()=>frame('d.querySelector("[data-scene-panel=titles]")?.getAttribute("aria-selected")==="true"&&!d.querySelector("[data-scene-editor=titles]").hidden'),'titles editor visible')
   await wait(()=>frame('d.querySelectorAll("[data-pdm-training-required-field-outline]").length===2'),'both required title fields outlined')
   assert.equal(await frame('(()=>{const c=d.querySelector(".interface-tour-card");return w.getComputedStyle(c).overflowY==="hidden"&&c.scrollHeight<=c.clientHeight+1})()'),true,'Step 25 hint must fit without a scrollbar or clipped content')
   await frame('d.querySelector("[data-pdm-training-speaker-name]").focus()');await fill('[data-pdm-training-speaker-name]','А');await pause(350)
   assert.ok(await frame('d.querySelector(".interface-tour-card header span")?.textContent.includes("Шаг 25 из 31")'),'Titles lesson must stay on the same step after the first name character')
   assert.equal(await frame('d.activeElement===d.querySelector("[data-pdm-training-speaker-name]")'),true,'Speaker field must keep focus after the first character')
   assert.equal(await frame('(()=>{const e=d.querySelector("[data-pdm-training-speaker-name]"),r=e.getBoundingClientRect();return d.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest("[data-pdm-training-speaker-name]")===e})()'),true,'Training overlay must not block continued speaker name input')
   await fill('[data-pdm-training-speaker-name]','Анна Петрова')
   await frame('d.querySelector("[data-pdm-training-event-info]").focus()');await fill('[data-pdm-training-event-info]','Учебная конференция 2026');await pause(900)
   assert.ok(await frame('d.querySelector(".interface-tour-card header span")?.textContent.includes("Шаг 25 из 31")'),'Titles lesson must not advance while the event field is still focused')
   assert.ok(await frame('d.querySelector(".interface-tour-card p")?.textContent.includes("нажмите на предпросмотр титров слева")'),'Titles lesson must explicitly explain how to continue')
   assert.equal(await frame('(()=>{const p=d.querySelector("[data-broadcast-titles-preview]").getBoundingClientRect(),o=d.querySelector(".interface-tour-outline").getBoundingClientRect();return Math.abs(p.left-o.left)<=7&&Math.abs(p.top-o.top)<=7&&Math.abs(p.width-o.width)<=12&&Math.abs(p.height-o.height)<=12})()'),true,'Completed title fields must move the blue frame to the title preview')
   await click('[data-broadcast-titles-preview]');await screen('actual-titles-training');await nextAfterDone(25)
   await click('[data-broadcast-titles-show-all]');await nextAfterDone(26)
   await click('[data-program-scene-modal] > div:first-child button:last-child');await nextAfterDone(27)
   await click('[data-toolbar-item="pipViews"] button:nth-child(2)');await step(28)
   await click('[data-toolbar-item="settings"] button');await wait(()=>frame('!!d.querySelector("[data-pdm-training-panel=settings]")'),'settings opened')
   await wait(()=>frame('!d.querySelector(".interface-tour-card")'),'settings lesson card hidden')
   await wait(()=>js('document.querySelector(".intro-interface-header span").textContent.includes("Проектор / HDMI")'),'audio instruction in outer header')
   assert.ok(await js('document.querySelector(".intro-interface-header span").textContent.includes("Проектор / HDMI")'),'Audio lesson names the device to choose')
   await click('[data-pdm-audio-device="training-hdmi"]');await wait(()=>frame('d.querySelector("[data-pdm-audio-device=training-hdmi]")?.getAttribute("aria-pressed")==="true"'),'training HDMI selected')
   await screen('actual-audio-training')
   await click('[data-pdm-training-panel="settings"] [data-pdm-training-close]');await step(29)
   if(await frame('!!d.querySelector("[data-toolbar-item=stream] button")')) await inspectPanel(29,'[data-toolbar-item="stream"] button','[data-pdm-training-panel="stream"]')
   else await step(30)
  await click('[data-toolbar-item="output"] button')
  await wait(()=>frame('d.querySelector(".interface-tour-card h3")?.textContent.includes("Теперь вы знаете")'),'automatic completion')
  assert.equal(await frame('d.querySelector(".interface-tour-card h3")?.textContent'),'Теперь вы знаете, как пользоваться PDM')
  assert.deepEqual(await frame('w.trainingErrors'),[])
  assert.equal(await frame('(async()=>{return (await w.api.streaming.start()).success})()'),false)
  assert.equal(await frame('(async()=>{const stream=await w.navigator.mediaDevices.getUserMedia({video:true});return stream instanceof w.MediaStream})()'),true,'Training camera is a local canvas stream, not real hardware')
  await frame('d.querySelector(".interface-tour-next").click()');await pause(100)
  assert.equal(await js('!!document.querySelector("iframe")'),false)
  assert.equal(await js('JSON.stringify(window.testStore.getState())'),before,'Real store unchanged')
  assert.equal(await js('JSON.stringify(Object.fromEntries(Object.entries(localStorage).filter(([k])=>k!==window.testKey)))'),persisted,'Real persistence unchanged')
  assert.deepEqual(await js('window.testCalls'),[]);assert.deepEqual(await js('window.testErrors'),[])
  await js('document.querySelector("#real-button").click()');await pause(100)
  await js('Array.from(document.querySelectorAll("button")).find(e=>e.textContent.trim()==="Помощь").click()');await pause(100)
  await js('document.querySelector("[data-pdm-open-introduction]").click()');await pause(100);await start()
   await js('document.querySelector("iframe").src=document.querySelector("iframe").src.replace("step=0","step=17")')
  await wait(()=>frame('!!d.querySelector("[data-program-scene-modal]")'),'resume scene')
  win.setContentSize(880,650);await pause(400);await screen('actual-scene-compact')
  assert.ok(await frame('(()=>{const r=d.querySelector(".interface-tour-card").getBoundingClientRect();return r.left>=0&&r.right<=w.innerWidth&&r.top>=0&&r.bottom<=w.innerHeight})()'),'Hint fits compact viewport')
  assert.ok(await frame('(()=>{const e=d.querySelector(".interface-tour-card"),r=e.getBoundingClientRect();return e.contains(d.elementFromPoint(r.left+20,r.top+20))})()'),'Hint remains above the real Scene dialog')
  await js('document.querySelector(".intro-interface-header button").click()');win.reload();await pause(300)
  assert.ok(await js('document.querySelector(".intro-primary").textContent.includes("Продолжить")'))
   console.log('PASS: 31-step real PDM tour teaches multiple channels, seamless TAKE, media, Scene, external camera, chroma key, QR, titles, audio output and stream; draft isolation, resume and real session/IPC safety hold')
  win.destroy();clearTimeout(deadline);app.exit(0)
 }catch(error){console.error(error);if(win){try{console.error(await win.webContents.executeJavaScript('(()=>{const f=document.querySelector("iframe")?.contentWindow,s=f?.trainingStore?.getState();return JSON.stringify({parent:window.testErrors,frame:f?.trainingErrors,state:s?{selectedChannel:s.selectedChannel,liveChannel:s.liveChannel,currentSlide:s.currentSlide,sceneOpen:!!f.document.querySelector("[data-program-scene-modal]"),chroma:s.programScene.chromaKey.enabled,qrUrl:s.qrOverlay.url,captureSourceId:s.programScene.captureSourceId}:null,html:f?.document.body.innerText?.slice(-2400)})})()'));writeFileSync(resolve('tmp/onboarding-ui/failure.png'),(await win.webContents.capturePage()).toPNG())}catch{}}clearTimeout(deadline);app.exit(1)}
})
