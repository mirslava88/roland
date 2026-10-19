const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs')
const{transformSync}=require('esbuild')
const listeners=new Map(),pending=[],streams=[];let stopped=0
const moduleObject={exports:{}}
vm.runInNewContext(transformSync(fs.readFileSync('src/renderer/src/keynote-capture-pool.ts','utf8'),{loader:'ts',format:'cjs'}).code,{
 module:moduleObject,exports:moduleObject.exports,console,
 navigator:{mediaDevices:{getUserMedia:()=>new Promise(resolve=>pending.push(()=>resolve((()=>{const events=new Map(),track={readyState:'live',stop(){this.readyState='ended';stopped++},addEventListener(k,f){events.set(k,f)},end(){this.readyState='ended';events.get('ended')?.()}};const stream={getTracks:()=>[track]};streams.push(stream);return stream})())))}},
 window:{api:{on:(name,fn)=>{listeners.set(name,fn);return()=>listeners.delete(name)},dbgLog(){}}}
})
const{acquireKeynoteCapture,installKeynoteCapturePool,retireKeynoteCapture}=moduleObject.exports
;(async()=>{
 const cleanup=installKeynoteCapturePool()
 listeners.get('keynote-source-prewarm')({sourceId:'window:1:0'})
 const acquisition=acquireKeynoteCapture('window:1:0')
 assert.equal(pending.length,1,'prewarm and TAKE must share one getUserMedia call')
 pending.shift()();const lease=await acquisition
 retireKeynoteCapture('window:1:0');await Promise.resolve()
 assert.equal(lease.isRetired(),true,'intentional handoffs must not trigger capture recovery')
 assert.equal(stopped,0,'retiring must preserve an active frame until its slot releases')
 lease.release();await Promise.resolve();assert.equal(stopped,1)
 lease.release();await Promise.resolve();assert.equal(stopped,1,'double release must be harmless')
 listeners.get('keynote-source-prewarm')({sourceId:'window:2:0'})
 retireKeynoteCapture('window:2:0');pending.shift()();await Promise.resolve();await Promise.resolve()
 assert.equal(stopped,2,'late getUserMedia completion must not leak a retired stream')
 const first=acquireKeynoteCapture('window:3:0');pending.shift()();const old=await first
 streams.at(-1).getTracks()[0].end()
 assert.equal(old.isRetired(),false,'an unexpected end can be recovered')
 const again=acquireKeynoteCapture('window:3:0');assert.equal(pending.length,1,'an ended warm stream must never be leased again')
 pending.shift()();const fresh=await again;assert.notEqual(fresh.stream,old.stream)
 old.release();fresh.release();retireKeynoteCapture('window:3:0');await Promise.resolve()
 const racing=acquireKeynoteCapture('window:4:0');pending.shift()();const retiring=await racing
 streams.at(-1).getTracks()[0].end()
 retireKeynoteCapture('window:4:0')
 assert.equal(retiring.isRetired(),true,'native retirement after track end must cancel queued recovery')
 retiring.release();await Promise.resolve()
 cleanup();console.log('PASS: warm capture reuse, active leases, double release, late completion after retirement')
})().catch(e=>{console.error(e);process.exitCode=1})
