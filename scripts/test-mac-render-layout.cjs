const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict')
const {transformSync}=require('esbuild')
const moduleScope={exports:{}}
const screen={getAllDisplays:()=>[{id:123}]}
vm.runInNewContext(transformSync(fs.readFileSync('src/main/mac-render-display.ts','utf8'),{loader:'ts',format:'cjs'}).code,{
 module:moduleScope,exports:moduleScope.exports,console,process,
 require:name=>name==='electron'?{app:{},screen}:name==='./diagnostic-log'?{diagnosticLog(){}}:require(name)
})
const surface=moduleScope.exports.macRenderDisplay
const dimensions=[]
surface.ensureNow=async pixels=>{
 const width=pixels.width+256,height=pixels.height+256
 assert.ok(width<=16384&&height<=16384&&width*height<=80000000,'4K layout must fit the native surface limits')
 dimensions.push({width,height});return{id:123,bounds:{x:-1920,y:1080,width,height},scaleFactor:1}
}
const overlaps=(a,b)=>Math.min(a.x+a.width,b.x+b.width)>Math.max(a.x,b.x)&&Math.min(a.y+a.height,b.y+b.height)>Math.max(a.y,b.y)
;(async()=>{
 const hd={width:1920,height:1080},uhd={width:3840,height:2160}
 const first=await surface.player(hd,0),second=await surface.player(hd,1)
 let compositor
 const window={isDestroyed:()=>false,setContentBounds:b=>{compositor=b}}
 await surface.compositorWindow(hd,window)
 assert.deepEqual(dimensions[2],dimensions[0],'opening the compositor must not resize a display with live players')
 const a={...first,...hd},b={...second,...hd}
 assert.equal(overlaps(a,b),false);assert.equal(overlaps(a,compositor),false);assert.equal(overlaps(b,compositor),false)
 const enlarged=await surface.player(uhd,0)
 assert.equal(overlaps({...enlarged,...uhd},b),false,'HD standby must stay outside the enlarged 4K player')
 assert.equal(overlaps({...enlarged,...uhd},compositor),false,'compositor must move before the enlarged player starts')
 const enlargedSecond=await surface.player(uhd,1)
 assert.equal(enlargedSecond.x,second.x,'standby origin is stable across output mode changes')
 assert.equal(overlaps({...enlargedSecond,...uhd},compositor),false)
 const before={...compositor};surface.releaseCompositor();await surface.player(uhd,0)
 assert.equal(JSON.stringify(compositor),JSON.stringify(before),'physical Program output is no longer moved by render reservations')
 surface.surface={id:123,width:12000,height:5000}
 let attempts=0
 surface.ensureNow=async()=>{
  attempts++
  if(attempts===1){surface.unavailableUntil=Date.now()+60000;return null}
  assert.equal(surface.unavailableUntil,0,'an online mode-change retry must not inherit the failure cooldown')
  return{id:123,bounds:{x:-1920,y:1080,width:12000,height:5000},scaleFactor:1}
 }
 assert.ok(await surface.compositorWindow(uhd,window),'a transient mode change must recover the same compositor')
 assert.equal(attempts,2)
 attempts=0;surface.ensureNow=async()=>{attempts++;return null}
 assert.equal(await surface.compositorWindow(uhd,window),null)
 assert.equal(attempts,2,'an unavailable compositor has a bounded retry budget')
 console.log('PASS: two independent player regions, live compositor, HD→4K growth, physical output release')
 console.log('PASS: online compositor mode-change recovery, bounded retry without one-minute cooldown')
})().catch(error=>{console.error(error);process.exitCode=1})
