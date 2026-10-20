const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),{transformSync}=require('esbuild')
function fixture(retired=false, label='Keynote', platform='darwin') {
 const effects=[],refs=[],messages=[],timers=new Map(),listeners=new Map(),tracks=new Map(),errors=[],events=new Map()
 let next=0,draws=0,released=0,ready=0
 const video={videoWidth:1920,videoHeight:1080,readyState:4,srcObject:null,
  play:async()=>{},pause(){},addEventListener:(e,f)=>listeners.set(e,f),removeEventListener:e=>listeners.delete(e)}
 const track={stop(){},addEventListener:(e,f)=>tracks.set(e,f),removeEventListener:e=>tracks.delete(e)}
 const stream={getVideoTracks:()=>[track],getTracks:()=>[track]}
 const canvas={getContext:()=>({drawImage(source){assert.equal(source,video);draws++}})}
 const context={module:{exports:{}},exports:null,console,
  HTMLMediaElement:{HAVE_CURRENT_DATA:2},requestAnimationFrame:fn=>fn(),crypto:{randomUUID:()=> 'request-1'},
  ResizeObserver:class{observe(){}disconnect(){}},
  clearTimeout:id=>timers.delete(id),
  window:{setTimeout:(f,ms)=>{const id=++next;timers.set(id,{f,ms});return id},api:{platform,
   on:(name,fn)=>{events.set(name,fn);return()=>events.delete(name)},sendToControl:(...args)=>messages.push(args),dbgLog(){}}},
  require(name){
   if(name==='react')return{useRef:value=>{const ref={current:value};refs.push(ref);return ref},useState:value=>[value,()=>{}],useEffect:fn=>effects.push(fn)}
   if(name==='react/jsx-runtime')return{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})}
   if(name==='../../keynote-capture-pool')return{acquireKeynoteCapture:async()=>({stream,release(){released++},isRetired:()=>retired})}
   if(name.includes('presentation-output'))return{hasNativeSlideResolution:()=>true}
   throw Error(name)
  },navigator:{mediaDevices:{getUserMedia:async()=>stream}}
 }
 context.exports=context.module.exports
 vm.runInNewContext(transformSync(fs.readFileSync('src/renderer/src/components/PresentationView/KeynoteLiveViewer.tsx','utf8'),{loader:'tsx',jsx:'automatic',format:'cjs'}).code,context)
 context.module.exports.KeynoteLiveViewer({sourceId:'window:8:0',sourceLabel:label,onReady:()=>ready++,onError:e=>errors.push(e)})
 refs[0].current=video;refs[1].current=canvas;refs[3].current={clientWidth:1920,clientHeight:1080}
 const cleanup=effects.map(fn=>fn()).filter(Boolean)
 return{messages,errors,timers,tracks,listeners,
  refreshed(overrides={}){const request=messages.find(([name])=>name==='keynote-capture-started')?.[1];events.get('keynote-capture-refreshed')?.({...request,success:true,...overrides})},
  cleanup:()=>cleanup.forEach(fn=>fn()),get draws(){return draws},get released(){return released},get ready(){return ready}}
}
;(async()=>{
 for(const platform of ['darwin','win32']) {
  let api;const sent=[],received=[]
  vm.runInNewContext(transformSync(fs.readFileSync('src/preload/output.ts','utf8'),{loader:'ts',format:'cjs'}).code,{
   process:{platform},require:name=>{assert.equal(name,'electron');return{contextBridge:{exposeInMainWorld:(name,value)=>{api=value}},ipcRenderer:{send:(...args)=>sent.push(args),on:name=>received.push(name),removeListener(){}}}}
  })
  api.sendToControl('keynote-capture-lost',{sourceId:'window:8:0'})
  assert.equal(sent.length,platform==='darwin'?1:0,'only the Mac output preload may request Keynote recovery')
  api.on('keynote-capture-refreshed',()=>{})
  assert.equal(received.length,platform==='darwin'?1:0,'refresh completion is Mac-only')
 }
 const s=fixture();await new Promise(setImmediate)
 assert.equal(s.ready,0,'a cached/transient frame cannot complete TAKE while native refresh is still running')
 s.listeners.get('resize')();assert.equal(s.ready,0,'a resize frame cannot uncover the outgoing content')
 s.refreshed({requestId:'old-request'});s.refreshed({sourceId:'window:999:0'})
 assert.equal(s.ready,0,'completion must match this source and capture attempt')
 s.refreshed()
 assert.equal(s.ready,1)
 s.refreshed();assert.equal(s.ready,1,'duplicate native completion cannot recommit a slot')
 s.tracks.get('ended')()
 assert.equal(s.draws,1,'freeze the last native-resolution frame before reconnecting')
 assert.ok(s.messages.some(([name,data])=>name==='keynote-capture-lost'&&data.sourceId==='window:8:0'),'unexpected termination must request backend recovery, not just recapture a dead window ID')
 s.tracks.get('ended')();assert.equal(s.draws,1,'do not overwrite a held frame with an ended video')
 s.cleanup();assert.equal(s.released,1)
 const intentional=fixture(true);await new Promise(setImmediate)
 intentional.refreshed()
 intentional.tracks.get('ended')()
 assert.equal(intentional.messages.some(([name])=>name==='keynote-capture-lost'),false,'ordinary native handoff cannot resurrect a retired presentation')
 assert.equal(intentional.draws,0);intentional.cleanup()
 const cancelled=fixture();await new Promise(setImmediate);cancelled.cleanup();cancelled.refreshed()
 assert.equal(cancelled.ready,0,'late refresh completion cannot revive an unmounted TAKE')
 const failed=fixture();await new Promise(setImmediate);failed.refreshed({success:false,error:'native redraw failed'})
 assert.equal(failed.ready,0);assert.deepEqual(failed.errors,['native redraw failed']);failed.cleanup()
 for(const [label,platform]of [['Документ Office','darwin'],['Keynote','win32']]){
  const other=fixture(false,label,platform);await new Promise(setImmediate)
  assert.equal(other.ready,1,'other render paths retain existing first-frame readiness');other.cleanup()
 }
 console.log('PASS: first Keynote frame waits for matching native redraw, stale/failed/cancelled replies stay covered, recovery holds frames, Windows/Office remain unchanged')
})().catch(error=>{console.error(error);process.exitCode=1})
