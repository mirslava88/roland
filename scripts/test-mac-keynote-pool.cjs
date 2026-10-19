const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const vm = require('node:vm')
const { transformSync } = require('esbuild')
const load = async (file, dependencies={}) => {
 const module={exports:{}}
 vm.runInNewContext(transformSync(await fs.readFile(file,'utf8'),{loader:'ts',format:'cjs'}).code,{
  module,exports:module.exports,console,process,Buffer,setTimeout,clearTimeout,
  require:name=>Object.hasOwn(dependencies,name)?dependencies[name]:require(name)
 })
 return module.exports
}
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{resolve,promise}}
;(async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'pdm-pool-test-'))
 const cache=await load('src/main/mac-keynote-cache.ts')
 const {MacKeynotePool}=await load('src/main/mac-keynote-pool.ts',{
  electron:{app:{getPath:()=>root}},fs:{...require('node:fs'),watchFile(){},unwatchFile(){}},
  './mac-office-files':{createOfficeWorkspace:async()=>fs.mkdtemp(path.join(root,'players-'))},'./mac-keynote-cache':cache,'./mac-pptx-animation':{},'./mac-native-office':{},'./diagnostic-log':{diagnosticLog(){}},
  './mac-keynote-launcher':await load('src/main/mac-keynote-launcher.ts')
 })
 let count=0
 const test=async(name,fn)=>{await fn();console.log('PASS '+name);count++}
 const fixture=async(name)=>{
  const dir=path.join(root,name);await fs.mkdir(dir)
  const paths=await Promise.all(['a','b','media','c'].map(async n=>{const p=path.join(dir,n+'.pptx');await fs.writeFile(p,n);return p}))
  const calls=[],statuses=[],warm=[],retired=[],gates=new Map(),docs=new Map();let serial=0,spawns=0,rebind=false,width=1920,height=1080
  const runtime={processes:async()=>[100,...(spawns?[101]:[])],spawn:async()=>{spawns++;return 101},configure:async()=>{},verify:async()=>{},
   command:async(pid,action,...args)=>{
    calls.push({pid,action,args})
    if(action==='import'){
     const gate=gates.get(path.basename(args[0]));if(gate){gate.enter.resolve();await gate.leave.promise}
     const documentId='d'+(++serial);docs.set(documentId,{slide:1});return{documentId,slideCount:2,slide:1}
    }
    if(action==='save'){await fs.writeFile(args[1],'native');if(rebind){const id='saved-'+args[0];docs.set(id,docs.get(args[0]));docs.delete(args[0]);return{documentId:id}}return{}}
    if(action==='exportpdf'){await fs.writeFile(args[1],'%PDF-test');return{}}
    if(action==='stage')return{windowId:++serial}
    if(action==='start'){docs.get(args[0]).slide=args[1];return{windowId:++serial}}
    if(action==='goto')docs.get(args[0]).slide=args[1]
    if(action==='next')docs.get(args[0]).slide=Math.min(2,docs.get(args[0]).slide+1)
    return{slide:docs.get(args[0])?.slide||1}
   }}
  const pool=new MacKeynotePool({runtime,cache:new cache.KeynoteDiskCache(path.join(dir,'cache')),
   inspect:async p=>({hasAnimations:true,clickBuildsBySlide:{2:2},blankBeforeBuildBySlide:{},safeToPreplay:!p.includes('media')}),
   plan:async id=>({profile:{width,height,frameRate:60,displayId:id},args:['0','0',String(width),String(height)],parking:['30000','0']}),
   status:(p,s,progress)=>statuses.push([p,s,progress]),warm:s=>warm.push(s.windowId),retire:id=>retired.push(id)})
  return{pool,paths,calls,statuses,warm,retired,gates,runtime,setSize(w,h){width=w;height=h},rebind(){rebind=true},get spawns(){return spawns}}
 }
 try{
 await test('all background channels finish automatically, retain readiness, and preserve live and selected players',async()=>{
  const s=await fixture('all-channels'),[a,b,media,c]=s.paths
  try{
   await s.pool.prewarm(a,7,true);await s.pool.take(a,1,7)
   const live=s.pool.current.windowId
   await s.pool.prewarm(b,7,true)
   await s.pool.prewarm(c,7)
   await s.pool.prewarm(media,7)
   for(const file of [a,b,c,media]){
    const last=s.statuses.filter(([p])=>p===file).at(-1)
    assert.equal(last[1],'ready',path.basename(file)+' must finish without selection')
    assert.equal(last[2],100)
   }
   assert.equal(s.pool.current.windowId,live,'background preparation must not restart the live player')
   const mediaId=[...s.pool.engines.flatMap(e=>[...e.documents.values()])].find(d=>d.source.path.endsWith('media.pptx')).documentId
   assert.equal(s.calls.some(call=>call.action==='start'&&call.args[0]===mediaId),false,'autoplay media must stay stopped off-air')
   const starts=s.calls.filter(call=>call.action==='start').length
   await s.pool.take(b,1,7)
   assert.equal(s.calls.filter(call=>call.action==='start').length,starts,'selected standby must be restored for the next TAKE')
   const before=s.calls.length;await s.pool.prewarm(c,7)
   assert.equal(s.calls.length,before,'completed background files need no repeated preflight on focus')
  }finally{await s.pool.shutdown()}
 })
 await test('progress reaches 100 only after capture registration and stays ready on repeated prewarm',async()=>{
  const s=await fixture('progress'),entered=deferred(),leave=deferred()
  s.pool.options.warm=async()=>{entered.resolve();await leave.promise}
  try{
   const prepared=s.pool.prewarm(s.paths[0],7,true);await entered.promise
   const pending=s.statuses.filter(([p])=>p===s.paths[0]).map(([,status,progress])=>({status,progress}))
   assert.ok(pending.some(v=>v.progress===75),'import completion must report partial progress')
   assert.equal(pending.at(-1).progress,95,'capture registration is not ready yet')
   assert.ok(pending.every((v,i)=>v.progress<100&&(i===0||v.progress>=pending[i-1].progress)))
   leave.resolve();await prepared
   assert.equal(s.statuses.at(-1)[1],'ready');assert.equal(s.statuses.at(-1)[2],100)
   const count=s.statuses.length;await s.pool.prewarm(s.paths[0],7,true)
   assert.ok(s.statuses.slice(count).every(([,status,progress])=>status==='ready'&&progress===100),'focus must not reset progress')
   await s.pool.take(s.paths[0],1,7)
   const live=s.statuses.length;await s.pool.exportPdf(s.paths[0],async()=>{})
   assert.ok(s.statuses.slice(live).every(([,status,progress])=>status==='ready'&&progress===100),'standby preview must not reset a live ready presentation')
  }finally{leave.resolve();await s.pool.shutdown()}
 })
 await test('TAKE awaits native capture registration and cleans up a rejected player',async()=>{
  const s=await fixture('capture-registration'),gate=deferred(),entered=deferred()
  s.pool.options.warm=async()=>{entered.resolve();await gate.promise;throw Error('window not registered')}
  let done=false
  const take=s.pool.take(s.paths[0],1,7).then(()=>{done=true;throw Error('unexpected success')},e=>{done=true;assert.match(e.message,/not registered/)})
  await entered.promise;assert.equal(done,false,'TAKE must not return before capture registration')
  gate.resolve();await take
  assert.equal(s.pool.engines.some(e=>e.show),false,'failed registration must not publish a ready player')
  assert.equal(s.calls.at(-1).action,'stop','failed registration must close its native player')
  await s.pool.shutdown()
 })
 await test('cold TAKE uses the idle engine instead of waiting for an unrelated import',async()=>{
  const s=await fixture('cold-take');const[a,b]=s.paths
  const gate={enter:deferred(),leave:deferred()};s.gates.set('b.pptx',gate)
  const prep=s.pool.prewarm(b,7);await gate.enter.promise
  try{
   const take=await Promise.race([s.pool.take(a,1,7),new Promise((_,reject)=>setTimeout(()=>reject(Error('TAKE queued behind unrelated import')),500))])
   assert.equal(take.path,a)
  }finally{gate.leave.resolve();await prep;await s.pool.shutdown()}
 })
 await test('standby import does not block live navigation; warm TAKE reuses the same player',async()=>{
  const s=await fixture('independent');const[a,b]=s.paths
  try{
   await s.pool.prewarm(a,7,true);await s.pool.take(a,1,7)
   const gate={enter:deferred(),leave:deferred()};s.gates.set('b.pptx',gate)
   const prep=s.pool.prewarm(b,7,true);await gate.enter.promise
   const next=await Promise.race([s.pool.command('next'),new Promise((_,reject)=>setTimeout(()=>reject(Error('live navigation blocked')),300))])
   assert.equal(next.CurrentSlide,2)
   gate.leave.resolve();await prep
   const starts=s.calls.filter(c=>c.action==='start').length
   const ready=s.warm.at(-1);const take=await s.pool.take(b,1,7)
   assert.equal(take.windowId,ready)
   assert.equal(s.calls.filter(c=>c.action==='start').length,starts,'TAKE must not restart a preplayed presentation')
   assert.equal(s.spawns,1,'existing player plus one worker only')
  }finally{await s.pool.shutdown()}
 })
 await test('off-air imports preserve the preferred ready player',async()=>{
  const s=await fixture('preferred');try{
   await s.pool.prewarm(s.paths[0],7,true)
   const player=s.warm.at(-1),retired=s.retired.length
   await s.pool.prewarm(s.paths[1],7)
   assert.equal(s.retired.length,retired,'preparing another channel must not tear down the selected player')
   assert.equal((await s.pool.take(s.paths[0],1,7)).windowId,player)
  }finally{await s.pool.shutdown()}
 })
 await test('PDF previews use only standby; live navigation stays available and exported files live through the consumer',async()=>{
  const s=await fixture('pdf-standby');const[a,b]=s.paths
  let destination;const entered=deferred(),leave=deferred()
  const playing=new Map();const command=s.runtime.command
  s.runtime.command=async(pid,action,...args)=>{
   if(action==='exportpdf')assert.notEqual(playing.get(pid),true,'PDF export must not stop or export a live player')
   const result=await command(pid,action,...args)
   if(action==='start')playing.set(pid,true)
   if(action==='stop')playing.set(pid,false)
   return result
  }
  try{
   await s.pool.take(a,1,7);await s.pool.prewarm(b,7,true)
   const livePid=s.calls.find(c=>c.action==='start').pid
   const preview=s.pool.exportPdf(b,async pdf=>{destination=pdf;assert.equal(await fs.readFile(pdf,'utf8'),'%PDF-test');entered.resolve();await leave.promise})
   await entered.promise
   try{
    const next=await Promise.race([s.pool.command('next'),new Promise((_,reject)=>setTimeout(()=>reject(Error('preview blocked live navigation')),300))])
    assert.equal(next.CurrentSlide,2)
    assert.notEqual(s.calls.find(c=>c.action==='exportpdf').pid,livePid)
   }finally{leave.resolve();await preview}
   await assert.rejects(fs.access(destination),'PDF retired after its consumer finishes')
  }finally{await s.pool.shutdown()}
 })
 await test('restart reuses an idle existing worker without adding a third process',async()=>{
  const s=await fixture('reuse-worker')
  s.runtime.processes=async()=>[100,101]
  const command=s.runtime.command
  s.runtime.command=async(pid,action,...args)=>action==='state'?{playing:false}:command(pid,action,...args)
  try{await s.pool.prewarm(s.paths[0],7,true);assert.equal(s.spawns,0)}finally{await s.pool.shutdown()}
  assert.equal(s.calls.some(c=>c.action==='quit'),false,'borrowed applications retain their original documents')
 })
 await test('concurrent duplicate preparation imports once',async()=>{
  const s=await fixture('dedupe');try{await Promise.all([s.pool.prewarm(s.paths[0],7,true),s.pool.prewarm(s.paths[0],7,true)])
   assert.equal(s.calls.filter(c=>c.action==='import').length,1)
  }finally{await s.pool.shutdown()}
 })
 await test('output mode changes replace the captured window; unchanged modes retain it',async()=>{
  const s=await fixture('mode-change');try{
   const first=await s.pool.take(s.paths[0],1,7)
   assert.equal((await s.pool.relocate(7)).windowId,first.windowId)
   s.setSize(3840,2160)
   const changed=await s.pool.relocate(7)
   assert.notEqual(changed.windowId,first.windowId,'old player can stay clamped to the former screen work area')
   assert.equal(changed.captureProfile.width,3840)
   assert.ok(s.retired.includes(`window:${first.windowId}:0`))
   s.setSize(2560,1080)
   assert.notEqual((await s.pool.take(s.paths[0],1,7)).windowId,changed.windowId)
  }finally{await s.pool.shutdown()}
 })
 await test('media never starts off-air; TAKE starts it and last-slide clicks cannot run to black',async()=>{
  const s=await fixture('media');try{
   await s.pool.prewarm(s.paths[2],7,true)
   assert.equal(s.calls.some(c=>c.action==='start'),false)
   await s.pool.take(s.paths[2],1,7);await s.pool.command('next')
   for(let i=0;i<5;i++)await s.pool.command('next')
   assert.equal(s.calls.filter(c=>c.action==='next').length,3)
  }finally{await s.pool.shutdown()}
 })
 await test('same-slide restart recreates the player and resets the build budget',async()=>{
  const s=await fixture('build-restart');try{
   await s.pool.take(s.paths[0],1,7)
   await s.pool.command('next');await s.pool.command('next');await s.pool.command('next')
   const before=s.pool.current.windowId
   await s.pool.command('goto',2)
   assert.notEqual(s.pool.current.windowId,before)
   assert.equal(s.calls.filter(c=>c.action==='prev').length,0,'Keynote previous jumps slides, not builds')
   await s.pool.command('next');await s.pool.command('next');await s.pool.command('next')
   assert.equal(s.calls.filter(c=>c.action==='next').length,5)
   const repeated=s.pool.current.windowId
   const taken=await s.pool.take(s.paths[0],2,7)
   assert.notEqual(taken.windowId,repeated,'same-slide TAKE must reset completed builds, not just the counter')
   assert.equal(taken.lastSlideClicks,0)
  }finally{await s.pool.shutdown()}
 })
 await test('native save keeps the live document file outside the atomic cache staging directory',async()=>{
  const s=await fixture('save-lifetime');let nativePath
  try {
   await s.pool.prewarm(s.paths[0],7,true)
   nativePath=s.calls.find(c=>c.action==='save').args[1]
   assert.equal(nativePath.includes('.preparing-'),false)
   assert.equal(await fs.readFile(nativePath,'utf8'),'native','Office must keep its own saved file after cache commit')
   const src=await cache.keynoteSource(s.paths[0])
   const immutable=await new cache.KeynoteDiskCache(path.join(path.dirname(s.paths[0]),'cache')).find(src)
   assert.notEqual(immutable,nativePath)
   assert.equal(await fs.readFile(immutable,'utf8'),'native')
  } finally {await s.pool.shutdown()}
  await assert.rejects(fs.access(nativePath),'working copy is retired only after managed documents close')
 })
 await test('native save can change document ID without losing playback or ownership',async()=>{
  const s=await fixture('save-id');s.rebind()
  try {
   await s.pool.prewarm(s.paths[0],7,true)
   const show=await s.pool.take(s.paths[0],1,7)
   assert.ok(show.documentId.startsWith('saved-'))
  }finally{await s.pool.shutdown()}
  assert.ok(s.calls.some(c=>c.action==='close'&&String(c.args[0]).startsWith('saved-')))
 })
 await test('failed document close preserves its working file',async()=>{
  const s=await fixture('close-failed');await s.pool.prewarm(s.paths[0],7,true)
  const nativePath=s.calls.find(c=>c.action==='save').args[1]
  const command=s.runtime.command;s.runtime.command=async(pid,action,...args)=>{
   if(action==='close')throw Error('Office busy');return command(pid,action,...args)
  }
  await s.pool.shutdown()
  assert.equal(await fs.readFile(nativePath,'utf8'),'native')
 })
 await test('source changed during import cannot publish ready',async()=>{
  const s=await fixture('changed');try{
   const gate={enter:deferred(),leave:deferred()};s.gates.set('a.pptx',gate)
   const job=s.pool.prewarm(s.paths[0],7,true);await gate.enter.promise
   await fs.writeFile(s.paths[0],'new source generation');gate.leave.resolve()
   await assert.rejects(job,/changed/)
   assert.equal(s.statuses.some(([,status])=>status==='ready'),false)
  }finally{await s.pool.shutdown()}
 })
 await test('TAKE reservation cannot deadlock behind standby work; shutdown preserves borrowed Keynote',async()=>{
  const s=await fixture('reservation');const[a,b,c]=[s.paths[0],s.paths[1],s.paths[3]]
  await s.pool.prewarm(a,7,true);await s.pool.take(a,1,7)
  const gate={enter:deferred(),leave:deferred()};s.gates.set('b.pptx',gate)
  const prep=s.pool.prewarm(b,7,true);await gate.enter.promise
  const take=s.pool.take(c,1,7);gate.leave.resolve()
  await Promise.race([Promise.all([prep,take]),new Promise((_,reject)=>setTimeout(()=>reject(Error('deadlock')),1500))])
  assert.equal(s.pool.current.path,c)
  await s.pool.shutdown()
  assert.deepEqual(s.calls.filter(c=>c.action==='quit').map(c=>c.pid),[101])
  assert.ok(s.calls.some(c=>c.pid===100&&c.action==='close'))
 })
 console.log(`${count} tests passed`)
 }finally{await fs.rm(root,{recursive:true,force:true})}
})().catch(error=>{console.error(error);process.exitCode=1})
