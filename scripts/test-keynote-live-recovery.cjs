const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),{transformSync}=require('esbuild')
function fixture(retired=false, label='Keynote') {
 const effects=[],refs=[],messages=[],timers=new Map(),listeners=new Map(),tracks=new Map(),errors=[]
 let next=0,draws=0,released=0,ready=0
 const video={videoWidth:1920,videoHeight:1080,readyState:4,srcObject:null,
  play:async()=>{},pause(){},addEventListener:(e,f)=>listeners.set(e,f),removeEventListener:e=>listeners.delete(e)}
 const track={addEventListener:(e,f)=>tracks.set(e,f),removeEventListener:e=>tracks.delete(e)}
 const stream={getVideoTracks:()=>[track],getTracks:()=>[track]}
 const canvas={getContext:()=>({drawImage(source){assert.equal(source,video);draws++}})}
 const context={module:{exports:{}},exports:null,console,
  HTMLMediaElement:{HAVE_CURRENT_DATA:2},requestAnimationFrame:fn=>fn(),
  ResizeObserver:class{observe(){}disconnect(){}},
  clearTimeout:id=>timers.delete(id),
  window:{setTimeout:(f,ms)=>{const id=++next;timers.set(id,{f,ms});return id},api:{sendToControl:(...args)=>messages.push(args),dbgLog(){}}},
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
 return{messages,errors,timers,tracks,cleanup:()=>cleanup.forEach(fn=>fn()),get draws(){return draws},get released(){return released},get ready(){return ready}}
}
;(async()=>{
 for(const platform of ['darwin','win32']) {
  let api;const sent=[]
  vm.runInNewContext(transformSync(fs.readFileSync('src/preload/output.ts','utf8'),{loader:'ts',format:'cjs'}).code,{
   process:{platform},require:name=>{assert.equal(name,'electron');return{contextBridge:{exposeInMainWorld:(name,value)=>{api=value}},ipcRenderer:{send:(...args)=>sent.push(args)}}}
  })
  api.sendToControl('keynote-capture-lost',{sourceId:'window:8:0'})
  assert.equal(sent.length,platform==='darwin'?1:0,'only the Mac output preload may request Keynote recovery')
 }
 const s=fixture();await new Promise(setImmediate)
 assert.equal(s.ready,1)
 s.tracks.get('ended')()
 assert.equal(s.draws,1,'freeze the last native-resolution frame before reconnecting')
 assert.ok(s.messages.some(([name,data])=>name==='keynote-capture-lost'&&data.sourceId==='window:8:0'),'unexpected termination must request backend recovery, not just recapture a dead window ID')
 s.tracks.get('ended')();assert.equal(s.draws,1,'do not overwrite a held frame with an ended video')
 s.cleanup();assert.equal(s.released,1)
 const intentional=fixture(true);await new Promise(setImmediate)
 intentional.tracks.get('ended')()
 assert.equal(intentional.messages.some(([name])=>name==='keynote-capture-lost'),false,'ordinary native handoff cannot resurrect a retired presentation')
 assert.equal(intentional.draws,0);intentional.cleanup()
 console.log('PASS: live viewer holds last frame, requests native recovery after unexpected end, and ignores intentional retirement')
})().catch(error=>{console.error(error);process.exitCode=1})
