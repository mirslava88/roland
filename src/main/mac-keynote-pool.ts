import { app } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { cp, mkdir, rm } from 'fs/promises'
import { watchFile, unwatchFile } from 'fs'
import { join, extname, basename } from 'path'
import { createOfficeWorkspace } from './mac-office-files'
import { KeynoteDiskCache, KeynoteQueue, keynoteSource, type KeynoteSource } from './mac-keynote-cache'
import { inspectMacPptxAnimations, type MacPptxAnimationInfo } from './mac-pptx-animation'
import { keynoteNative, macNativeOffice } from './mac-native-office'
import type { PresentationCaptureProfile } from '../shared/presentation-output'
import { diagnosticLog } from './diagnostic-log'
import { MacKeynoteLauncher } from './mac-keynote-launcher'

const execute = promisify(execFile)
type NativeResult = {documentId?:string;slideCount?:number;slide?:number;windowId?:number;notes?:string;playing?:boolean}
export type KeynoteStatus = 'loading' | 'loaded' | 'ready' | 'error'
export interface KeynotePlan { profile: PresentationCaptureProfile; args: string[]; parking: string[] }
interface Prepared {source:KeynoteSource;documentId:string;slideCount:number;info:MacPptxAnimationInfo}
interface Engine {pid:number;owned:boolean;queue:KeynoteQueue;documents:Map<string,Prepared>;show:KeynoteShow|null;reserved:boolean}
export interface KeynoteShow {
  path:string;sourceKey:string;documentId:string;windowId:number;slideCount:number;slide:number
  captureProfile:PresentationCaptureProfile;slideAspectRatio:number;lastSlideClicks:number;info:MacPptxAnimationInfo
}
interface Runtime {
  processes():Promise<number[]>
  spawn(claimed?:number[]):Promise<number>
  command(pid:number,action:string,...args:(string|number)[]):Promise<NativeResult>
  configure(windowId:number):Promise<void>
  verify(windowId:number):Promise<void>
}
interface Options {
  plan(displayId:number|undefined,aspect:number,slot:number):Promise<KeynotePlan>
  status(path:string,status:KeynoteStatus,progress:number):void
  warm(show:KeynoteShow):void|Promise<void>
  retire(sourceId:string):void
  runtime?:Runtime
  cache?:KeynoteDiskCache
  inspect?:(path:string)=>Promise<MacPptxAnimationInfo>
}
const delay = (ms:number):Promise<void> => new Promise(resolve=>setTimeout(resolve,ms))
const launcher = new MacKeynoteLauncher({
  processes:()=>nativeRuntime.processes(), delay,
  async launch() {
    const info=await keynoteNative<{path:string;bundleId:string;version:string}>(0,'application')
      .catch(error=>{throw Object.assign(new Error(String(error)),{launchNotStarted:true})})
    diagnosticLog('keynote-launch',`launch bundle=${info.bundleId} version=${info.version} path=${info.path}`)
    await execute('/usr/bin/open',['-ngj','-a',info.path,'--args','-KNMacPrefersWindowedPlayback','YES','-KNPlaybackPresentationWindowedPresenterDisplayEnabled','NO'],{timeout:8000})
  }
})
let lastProcessSnapshot=''
const nativeRuntime: Runtime = {
  async processes() {
    const processes=await keynoteNative<{pid:number;bundleId?:string;version?:string;path?:string}[]>(0,'processes')
    const snapshot=JSON.stringify(processes)
    if(snapshot!==lastProcessSnapshot) {lastProcessSnapshot=snapshot;diagnosticLog('keynote-launch',`processes=${snapshot}`)}
    return processes.map(item=>item.pid)
  },
  spawn:claimed=>launcher.spawn(claimed),
  command:(pid,action,...args)=>{
    if(['stop','close','quit'].includes(action))diagnosticLog('keynote-control',`request pid=${pid} action=${action}`)
    return keynoteNative<NativeResult>(pid,action,...args)
  },
  async configure(id) { await macNativeOffice('prepareKeynotePlayback',[id]) },
  async verify(id) { await macNativeOffice('verifyKeynotePlayback',[id]) }
}

// Two renderers only. Importing/staging in the standby process never holds
// the live player's navigation queue. Every native event targets its exact PID.
export class MacKeynotePool {
  private engines:Engine[]=[]
  private initializing:Promise<void>|null=null
  private active:Engine|null=null
  private closed=false
  private files=new Map<string,{key:string;displayId:number|undefined;status:KeynoteStatus;progress:number;prepared:boolean;watch:()=>void}>()
  private assigned:Set<string>|null=null
  private jobs=new Map<string,Promise<{slideCount?:number}>>()
  private preferred=''
  private root:Promise<string>|null=null
  private operator=new KeynoteQueue()
  private intent=0
  private recovery:{sourceId:string;engine:Engine;importing:boolean;promise:Promise<KeynoteShow|null>}|null=null
  private recoveryAttempts:number[]=[]
  private runtime:Runtime
  private cache:KeynoteDiskCache
  private inspect:(path:string)=>Promise<MacPptxAnimationInfo>
  constructor(private options:Options) {
    this.runtime=options.runtime||nativeRuntime
    this.cache=options.cache||new KeynoteDiskCache(join(app.getPath('userData'),'keynote-cache-v1'))
    this.inspect=options.inspect||(path=>extname(path).toLowerCase()==='.pptx'?inspectMacPptxAnimations(path):Promise.resolve({hasAnimations:false,clickBuildsBySlide:{},blankBeforeBuildBySlide:{},safeToPreplay:false}))
  }
  private async initialize():Promise<void> {
    if(this.closed) throw new Error('PDM is closing')
    if(!this.initializing) this.initializing=(async()=>{
      const existing=await this.runtime.processes()
      if (!this.engines.length) {
        const first=existing[0]||await this.runtime.spawn()
        this.engines.push({pid:first,owned:!existing.length,queue:new KeynoteQueue(),documents:new Map(),show:null,reserved:false})
      }
      if(this.engines.length<2) {
        // An earlier interrupted session may have left an idle worker open.
        // Borrow it without closing its existing documents or adding a new icon.
        let second=0
        for(const pid of existing) if(pid!==this.engines[0].pid) {
          const state=await this.runtime.command(pid,'state').catch(()=>null)
          if(state?.playing===false){second=pid;break}
        }
        const owned=!second
        if(!second)second=await this.runtime.spawn(this.engines.map(engine=>engine.pid))
        this.engines.push({pid:second,owned,queue:new KeynoteQueue(),documents:new Map(),show:null,reserved:false})
      }
    })()
    try { await this.initializing } catch (error) { this.initializing=null; throw error }
  }
  private publish(path:string,key:string,status:KeynoteStatus,progress?:number):void {
    const file=this.files.get(path)
    if(this.closed||!file||file.key!==key) return
    // Readiness belongs to the prepared document, not to the two replaceable
    // player windows. Warming another deck must not undo a completed check.
    if(status==='ready')file.prepared=true
    if(status==='error')file.prepared=false
    if(file.prepared&&(status==='loading'||status==='loaded'))status='ready'
    const percent=status==='ready'?100:status==='loaded'?75:status==='error'?file.progress:
      Math.min(99,Math.max(file.status==='ready'?0:file.progress,progress??0))
    file.status=status
    file.progress=percent
    this.options.status(path,status,percent)
  }
  private publishSource(source:KeynoteSource,status:KeynoteStatus,progress?:number):void {
    // Import uses canonical paths; channel paths can contain filesystem aliases.
    for(const [path,file] of this.files)if(file.key===source.key)this.publish(path,source.key,status,progress)
  }
  retain(paths:string[]):void {
    this.assigned=new Set(paths)
    for(const [path,file]of this.files) if(!this.assigned.has(path)) {
      unwatchFile(path,file.watch);this.files.delete(path)
    }
    for(const engine of this.engines) void engine.queue.run(async()=>{
      if(engine===this.active||engine.reserved||this.closed) return
      for(const [key,document]of engine.documents) {
        if([...this.files.values()].some(file=>file.key===key)) continue
        if(engine.show?.sourceKey===key) await this.stopEngine(engine)
        try {
          await this.runtime.command(engine.pid,'close',document.documentId)
          engine.documents.delete(key)
        } catch(error) { diagnosticLog('keynote-prepare',`document retained ${String(error)}`) }
      }
    },true)
  }
  private async source(path:string,displayId?:number):Promise<KeynoteSource> {
    const source=await keynoteSource(path)
    if(this.closed||(this.assigned&&!this.assigned.has(path))) throw new Error('Preparation cancelled')
    let file=this.files.get(path)
    if(!file) {
      const watch=():void=>{void this.prewarm(path,this.files.get(path)?.displayId).catch(()=>undefined)}
      file={key:source.key,displayId,status:'loading',progress:0,prepared:false,watch};this.files.set(path,file)
      watchFile(path,{persistent:false,interval:1500},watch)
    }
    file.displayId=displayId
    if(file.key!==source.key) { file.key=source.key;file.status='loading';file.progress=0;file.prepared=false }
    return source
  }
  async prewarm(path:string,displayId?:number,preferred=false):Promise<{slideCount?:number}> {
    const source=await this.source(path,displayId)
    if(preferred) this.preferred=path
    if(this.active?.show?.sourceKey===source.key) { this.publish(path,source.key,'ready');return {slideCount:this.active.show.slideCount} }
    const prepared=this.engines.find(engine=>engine.documents.has(source.key))?.documents.get(source.key)
    if(!preferred&&this.files.get(path)?.prepared&&prepared) {
      this.publish(path,source.key,'ready');return {slideCount:prepared.slideCount}
    }
    const key=`${source.key}:${displayId??'auto'}`
    const existing=this.jobs.get(key)
    if(existing) {
      if(preferred)for(const engine of this.engines)engine.queue.promote(source.key)
      return existing
    }
    const job=this.prepare(path,source,displayId,preferred)
    this.jobs.set(key,job)
    try { return await job }
    catch(error) { this.publishSource(source,'error');diagnosticLog('keynote-prepare',String(error));throw error }
    finally { if(this.jobs.get(key)===job)this.jobs.delete(key) }
  }
  private async prepare(path:string,source:KeynoteSource,displayId:number|undefined,priority:boolean):Promise<{slideCount:number}> {
    this.publish(path,source.key,'loading',5)
    await this.initialize()
    for(;;) {
      if(this.closed) throw new Error('PDM is closing')
      if(this.active?.show?.sourceKey===source.key) {
        this.publish(path,source.key,'ready');return {slideCount:this.active.show.slideCount}
      }
      const available=this.engines.filter(item=>item!==this.active&&!item.reserved)
      const engine=available.find(item=>item.show?.sourceKey===source.key)||
        available.filter(item=>!item.show||item.show.path!==this.preferred).sort((a,b)=>a.queue.workload-b.queue.workload)[0]||available[0]
      if(!engine) { await delay(10);continue }
      const result=await engine.queue.run(async()=>{
        if(engine===this.active||engine.reserved) return null
        if(this.closed||this.files.get(path)?.key!==source.key) throw new Error('Preparation cancelled')
        this.publish(path,source.key,'loading')
        const previous=engine.show
        const document=await this.load(engine,source)
        if(this.closed||this.files.get(path)?.key!==source.key)throw new Error('Preparation cancelled')
        const plan=await this.options.plan(displayId,document.info.slideAspectRatio||16/9,this.engines.indexOf(engine))
        if(document.info.safeToPreplay===true) {
          await this.stage(engine,path,document,1,plan)
        } else {
          // Validate playback configuration without starting media/autoplay
          // off-air. The actual player is started only by TAKE.
          await this.stopEngine(engine)
          const editor=await this.runtime.command(engine.pid,'stage',document.documentId,...plan.parking)
          if(!editor.windowId)throw new Error('Keynote did not create an editor window')
          this.publish(path,source.key,'loading',80)
          await this.runtime.configure(editor.windowId)
          this.publish(path,source.key,'loading',95)
          await this.runtime.command(engine.pid,'stop',document.documentId)
        }
        this.publishSource(source,'ready')
        // Keep the selected next deck warm after validating other channels.
        const original=previous&&engine.documents.get(previous.sourceKey)
        if(previous&&original&&previous.path!==path&&previous.path===this.preferred&&
          !priority&&!engine.reserved&&engine!==this.active) {
          const restorePlan=await this.options.plan(previous.captureProfile.displayId,previous.slideAspectRatio,this.engines.indexOf(engine))
          await this.stage(engine,previous.path,original,previous.slide,restorePlan)
            .catch(error=>diagnosticLog('keynote-prepare',`selected standby restore failed ${String(error)}`))
        }
        return {slideCount:document.slideCount}
      },!priority&&path!==this.preferred,source.key)
      if(result)return result
    }
  }
  private async load(engine:Engine,source:KeynoteSource):Promise<Prepared> {
    const processes=await this.runtime.processes()
    if(!processes.includes(engine.pid)) {
      engine.pid=await this.runtime.spawn(this.engines.filter(other=>other!==engine).map(other=>other.pid));engine.owned=true;engine.documents.clear();
      if(engine.show)this.options.retire(`window:${engine.show.windowId}:0`)
      engine.show=null
    }
    const previous=engine.documents.get(source.key)
    if(previous)return previous
    await this.stopEngine(engine)
    const started=Date.now()
    const phase=(name:string):void=>diagnosticLog('keynote-load',`pid=${engine.pid} source=${source.key.slice(0,12)} phase=${name} ms=${Date.now()-started}`)
    this.publishSource(source,'loading',10)
    phase('begin')
    let cached=await this.cache.find(source),metadata:NativeResult|undefined
    phase('cache-read')
    const info=await this.inspect(source.path)
    this.publishSource(source,'loading',20)
    phase('animation-inspected')
    if(cached) {
      if(!this.root)this.root=createOfficeWorkspace('keynote','players-')
      const directory=join(await this.root,String(engine.pid),source.key)
      await mkdir(directory,{recursive:true})
      const copy=join(directory,`${source.key}.key`)
      await cp(cached,copy,{recursive:true})
      phase('native-copy-ready')
      try { metadata=await this.runtime.command(engine.pid,'import',copy) }
      catch(error) { await this.cache.invalidate(source);cached=null;diagnosticLog('keynote-prepare',`native cache rejected ${String(error)}`) }
    }
    if(!metadata) {
      // Never commandeer an editor the user already opened from the original
      // path. Each player imports its own immutable copy, including on a miss.
      if(!this.root)this.root=createOfficeWorkspace('keynote','players-')
      const directory=join(await this.root,String(engine.pid),source.key)
      await mkdir(directory,{recursive:true})
      const copy=join(directory,basename(source.path))
      await cp(source.path,copy,{recursive:true})
      phase('source-copy-ready')
      metadata=await this.runtime.command(engine.pid,'import',copy)
    }
    phase('native-imported')
    this.publishSource(source,'loading',60)
    let documentId=metadata.documentId||''
    const slideCount=metadata.slideCount
    if(!documentId||!slideCount||slideCount<1)throw new Error('Keynote returned invalid presentation metadata')
    try {
      if(!cached) await this.cache.save(source,async destination=>{
        // Save in PDM's working directory and keep this live document's path
        // stable until it closes. The immutable disk cache gets a copy.
        if(!this.root)this.root=createOfficeWorkspace('keynote','players-')
        const directory=join(await this.root,String(engine.pid),source.key)
        await mkdir(directory,{recursive:true})
        const native=join(directory,'prepared.key')
        const saved=await this.runtime.command(engine.pid,'save',documentId,native)
        if(saved.documentId)documentId=saved.documentId
        await cp(native,destination,{recursive:true})
      })
        .catch(error=>diagnosticLog('keynote-prepare',`cache save failed ${String(error)}`))
      if(this.closed||(await keynoteSource(source.path)).key!==source.key)throw new Error('Presentation changed during preparation')
      const document={source,documentId,slideCount,info}
      engine.documents.set(source.key,document)
      this.publishSource(source,'loaded')
      diagnosticLog('keynote-prepare',`imported pid=${engine.pid} cache=${cached?'hit':'miss'} ms=${Date.now()-started} slides=${slideCount}`)
      return document
    } catch(error) { await this.runtime.command(engine.pid,'close',documentId).catch(()=>undefined);throw error }
  }
  private async stopEngine(engine:Engine):Promise<void> {
    const previous=engine.show
    if(!previous)return
    this.options.retire(`window:${previous.windowId}:0`)
    try { await this.runtime.command(engine.pid,'stop',previous.documentId,previous.windowId) }
    catch(error) {
      // A vanished player is already off-air. Do not reject a painted PDF or
      // video just because there is no longer a Keynote process to stop.
      if((await this.runtime.processes()).includes(engine.pid))throw error
      diagnosticLog('keynote-recovery',`stop already complete; process exited pid=${engine.pid}`)
      engine.documents.clear()
    }
    engine.show=null
    this.publish(previous.path,previous.sourceKey,'loaded')
  }
  private async stage(engine:Engine,path:string,document:Prepared,slide:number,plan:KeynotePlan):Promise<KeynoteShow> {
    if(engine.show?.sourceKey===document.source.key && engine.show.slide===slide && engine.show.lastSlideClicks===0 &&
      engine.show.captureProfile.width===plan.profile.width&&engine.show.captureProfile.height===plan.profile.height) {
      // A mode/layout change may have moved an otherwise ready standby.
      await this.runtime.command(engine.pid,'relocate',engine.show.windowId,...plan.parking,plan.args[2],plan.args[3])
      engine.show.captureProfile=plan.profile
      return engine.show
    }
    await this.stopEngine(engine)
    const start=Date.now()
    try {
    const editor=await this.runtime.command(engine.pid,'stage',document.documentId,...plan.parking)
    if(!editor.windowId)throw new Error('Keynote did not create an editor window')
    this.publish(path,document.source.key,'loading',80)
    await this.runtime.configure(editor.windowId)
    this.publish(path,document.source.key,'loading',85)
    const metadata=await this.runtime.command(engine.pid,'start',document.documentId,slide,...plan.parking,plan.args[2],plan.args[3])
    if(!metadata.windowId)throw new Error('Keynote did not create a player window')
    this.publish(path,document.source.key,'loading',90)
    await this.runtime.verify(metadata.windowId)
    this.publish(path,document.source.key,'loading',95)
    const show:KeynoteShow={path,sourceKey:document.source.key,documentId:document.documentId,windowId:metadata.windowId,
      slideCount:document.slideCount,slide,captureProfile:plan.profile,slideAspectRatio:document.info.slideAspectRatio||16/9,
      lastSlideClicks:0,info:document.info}
    await this.options.warm(show)
    engine.show=show
    diagnosticLog('keynote-prepare',`player ready pid=${engine.pid} ms=${Date.now()-start}`)
    return show
    } catch(error) {
      // A failed start/verification can leave an untracked player open.
      await this.runtime.command(engine.pid,'stop',document.documentId).catch(()=>undefined)
      throw error
    }
  }
  async take(path:string,slide:number,displayId:number):Promise<KeynoteShow> {
    ++this.intent
    return this.operator.run(async()=>{
      const source=await this.source(path,displayId)
      await this.initialize()
      this.preferred=path
      const current=this.active
      const hot=this.engines.find(engine=>engine.show?.sourceKey===source.key)
      const engine=hot||this.engines.filter(item=>item!==current).sort((a,b)=>a.queue.workload-b.queue.workload)[0]!
      engine.reserved=true
      try {
        return await engine.queue.run(async()=>{
          const document=await this.load(engine,source)
          const plan=await this.options.plan(displayId,document.info.slideAspectRatio||16/9,this.engines.indexOf(engine))
          let show=engine.show
          if(engine===current&&show?.sourceKey===source.key&&
            !(show.slide===slide&&show.lastSlideClicks>0)&&
            show.captureProfile.width===plan.profile.width&&show.captureProfile.height===plan.profile.height) {
            await this.runtime.command(engine.pid,'goto',document.documentId,slide)
            show.slide=slide;show.lastSlideClicks=0;show.path=path
            await this.runtime.command(engine.pid,'relocate',show.windowId,...plan.parking,plan.args[2],plan.args[3])
            show.captureProfile=plan.profile
          } else {
            if(current&&current!==engine&&document.info.safeToPreplay!==true)await current.queue.run(()=>this.stopEngine(current))
            show=await this.stage(engine,path,document,slide,plan)
          }
          if(current&&current!==engine)await current.queue.run(()=>this.stopEngine(current))
          this.active=engine
          this.publish(path,source.key,'ready')
          diagnosticLog('keynote-take',`committed pid=${engine.pid} preplayed=${hot===engine}`)
          return show
        })
      } finally {engine.reserved=false}
    })
  }
  async stop():Promise<void> {
    ++this.intent
    // Importing a replacement after a crash cannot have started playback yet.
    // Let a ready video/PDF take over immediately; the cancelled recovery may
    // finish its import but must never start or publish the old presentation.
    if(this.recovery?.importing&&this.active===this.recovery.engine) {
      this.active=null
      return
    }
    await this.operator.run(async()=>{
      const engine=this.active
      this.active=null
      if(engine)await engine.queue.run(()=>this.stopEngine(engine))
    })
  }
  async exportPdf(path:string,use:(pdf:string)=>Promise<void>):Promise<void> {
    const source=await keynoteSource(path)
    await this.initialize()
    // A channel prewarm already owns the cold import. Do not import the same
    // deck in the other process and occupy both players with preview work.
    const preparing=[...this.jobs].find(([key])=>key.startsWith(`${source.key}:`))?.[1]
    if(preparing)await preparing.catch(()=>undefined)
    for(;;) {
      if(this.closed)throw new Error('PDM is closing')
      const available=this.engines.filter(item=>item!==this.active&&!item.reserved)
      const engine=available.find(item=>item.documents.has(source.key)&&item.queue.workload===0)||
        available.sort((a,b)=>a.queue.workload-b.queue.workload)[0]
      if(!engine){await delay(10);continue}
      const finished=await engine.queue.run(async()=>{
        if(engine===this.active||engine.reserved)return false
        const previous=engine.show
        await this.stopEngine(engine)
        const document=await this.load(engine,source)
        const destination=join(await this.root!,String(engine.pid),source.key,'preview.pdf')
        try {
          await this.runtime.command(engine.pid,'exportpdf',document.documentId,destination)
          await use(destination)
        } finally {
          await rm(destination,{force:true}).catch(()=>undefined)
          const original=previous&&engine.documents.get(previous.sourceKey)
          if(original&&!this.closed&&!engine.reserved&&engine!==this.active&&original.info.safeToPreplay===true) {
            const plan=await this.options.plan(previous.captureProfile.displayId,previous.slideAspectRatio,this.engines.indexOf(engine))
            await this.stage(engine,previous.path,original,previous.slide,plan)
              .catch(error=>diagnosticLog('keynote-prepare',`preview standby restore failed ${String(error)}`))
          }
        }
        return true
      },true,source.key)
      if(finished)return
    }
  }
  async command(command:string,arg?:number|{stopAtBoundary?:boolean}):Promise<{Status:string;CurrentSlide?:number;Boundary?:boolean}> {
    if(command==='close'){await this.stop();return {Status:'ok'}}
    const engine=this.active
    if(!engine?.show)throw new Error('No active Keynote slideshow')
    return engine.queue.run(async()=>{
      if(engine!==this.active||!engine.show)throw new Error('Presentation changed')
      const show=engine.show
      const before=await this.runtime.command(engine.pid,'current',show.documentId)
      const current=before.slide||show.slide
      if(command==='current') { show.slide=current; return {Status:'ok',CurrentSlide:current} }
      const boundary=typeof arg==='object'&&arg.stopAtBoundary===true
      if(command==='next'&&current>=show.slideCount&&show.lastSlideClicks>=(show.info.clickBuildsBySlide[show.slideCount]||0))return {Status:'ok',CurrentSlide:current,Boundary:boundary}
      if(command==='prev'&&current<=1)return {Status:'ok',CurrentSlide:1,Boundary:boundary}
      if(command==='goto'&&Number(arg)===current&&show.lastSlideClicks>0) {
        // Keynote's "show previous" jumps slides, not builds. Restart this
        // player when explicitly returning to the beginning of its slide.
        const document=engine.documents.get(show.sourceKey)!
        const plan=await this.options.plan(show.captureProfile.displayId,show.slideAspectRatio,this.engines.indexOf(engine))
        await this.stage(engine,show.path,document,current,plan)
        return {Status:'ok',CurrentSlide:current,Boundary:false}
      }
      const result=await this.runtime.command(engine.pid,command,show.documentId,...(command==='goto'?[Number(arg)]:[]))
      const next=result.slide||current
      if(command==='goto')show.lastSlideClicks=0
      else if(next!==current)show.lastSlideClicks=command==='prev' ? show.info.clickBuildsBySlide[next]||0 : 0
      else if(command==='next')show.lastSlideClicks++
      else if(command==='prev')show.lastSlideClicks=Math.max(0,show.lastSlideClicks-1)
      show.slide=next
      return {Status:'ok',CurrentSlide:next,Boundary:false}
    })
  }
  get current():KeynoteShow|null {return this.active?.show||null}
  async relocate(displayId:number):Promise<KeynoteShow|null> {
    const engine=this.active
    if(!engine?.show)return null
    return engine.queue.run(async()=>{
      const show=engine.show!
      const plan=await this.options.plan(displayId,show.slideAspectRatio,this.engines.indexOf(engine))
      if(show.captureProfile.width!==plan.profile.width||show.captureProfile.height!==plan.profile.height) {
        const document=engine.documents.get(show.sourceKey)!
        return this.stage(engine,show.path,document,show.slide,plan)
      }
      await this.runtime.command(engine.pid,'relocate',show.windowId,...plan.parking,plan.args[2],plan.args[3])
      show.captureProfile=plan.profile
      return show
    })
  }
  async refresh(sourceId:string):Promise<void> {
    const engine=this.engines.find(item=>item.show&&`window:${item.show.windowId}:0`===sourceId)
    if(engine?.show)await engine.queue.run(()=>this.runtime.command(engine.pid,'refresh',engine.show!.windowId)).then(()=>undefined)
  }
  recover(sourceId:string):Promise<KeynoteShow|null> {
    if(this.closed)return Promise.resolve(null)
    if(this.recovery?.sourceId===sourceId)return this.recovery.promise
    const engine=this.active,previous=engine?.show
    if(!engine||!previous||`window:${previous.windowId}:0`!==sourceId)return Promise.resolve(null)
    const intent=this.intent
    const valid=():boolean=>!this.closed&&this.active===engine&&this.intent===intent
    const recovery={sourceId,engine,importing:false,promise:Promise.resolve(null) as Promise<KeynoteShow|null>}
    this.recovery=recovery
    const promise=this.operator.run(()=>engine.queue.run(async()=>{
      if(!valid()||engine.show!==previous)return null
      const processes=await this.runtime.processes()
      if(processes.includes(engine.pid)) {
        // A capturer can end while its native player stays alive. The viewer
        // retries that same source; rebuild only a verified missing window.
        try { await this.runtime.command(engine.pid,'refresh',previous.windowId);return null }
        catch(error) {
          if(!/Player window is no longer available|Keynote process has exited/.test(String(error)))throw error
        }
      }
      if(!valid())return null
      this.recoveryAttempts=this.recoveryAttempts.filter(time=>Date.now()-time<60_000)
      if(this.recoveryAttempts.length>=2)throw new Error('Keynote повторно завершился; автоматическое восстановление остановлено. Выберите другой материал или повторите показ вручную.')
      this.recoveryAttempts.push(Date.now())
      diagnosticLog('keynote-recovery',`begin pid=${engine.pid} source=${sourceId} slide=${previous.slide}`)
      if(processes.includes(engine.pid)) {
        await this.stopEngine(engine)
        if(!valid())return null
      }
      this.options.retire(sourceId)
      engine.show=null
      if(!processes.includes(engine.pid))engine.documents.clear()
      const source=await this.source(previous.path,previous.captureProfile.displayId)
      if(source.key!==previous.sourceKey)return null
      let document:Prepared
      recovery.importing=true
      try { document=await this.load(engine,source) }
      finally { recovery.importing=false }
      if(!valid())return null
      const plan=await this.options.plan(previous.captureProfile.displayId,previous.slideAspectRatio,this.engines.indexOf(engine))
      if(!valid())return null
      const show=await this.stage(engine,previous.path,document,Math.min(previous.slide,document.slideCount),plan)
      if(!valid()) { await this.stopEngine(engine);return null }
      // Restore click builds only for decks verified safe for muted off-air
      // preparation. Media/autoplay decks resume at the start of the slide.
      if(document.info.safeToPreplay===true)for(let i=0;i<previous.lastSlideClicks;i++) {
        if(!valid()) { await this.stopEngine(engine);return null }
        const next=await this.runtime.command(engine.pid,'next',show.documentId)
        if(next.slide&&next.slide!==show.slide) {show.slide=next.slide;show.lastSlideClicks=0;break}
        show.lastSlideClicks++
      }
      if(!valid()) { await this.stopEngine(engine);return null }
      this.publish(show.path,show.sourceKey,'ready')
      diagnosticLog('keynote-recovery',`restored pid=${engine.pid} source=window:${show.windowId}:0 slide=${show.slide}`)
      return show
    }))
    recovery.promise=promise.finally(()=>{if(this.recovery===recovery)this.recovery=null})
    return recovery.promise
  }
  async notes(path:string,slide:number):Promise<string> {
    const source=await keynoteSource(path)
    const engine=this.engines.find(item=>item.documents.has(source.key))
    if(!engine)return ''
    return engine.queue.run(async()=> (await this.runtime.command(engine.pid,'notes',engine.documents.get(source.key)!.documentId,slide)).notes||'')
  }
  async shutdown():Promise<void> {
    this.closed=true
    ++this.intent
    for(const [path,file]of this.files)unwatchFile(path,file.watch)
    this.files.clear()
    await this.initializing?.catch(()=>undefined)
    let resourcesReleased=true
    await Promise.allSettled(this.engines.map(engine=>engine.queue.run(async()=>{
      await this.stopEngine(engine).catch(()=>undefined)
      for(const document of engine.documents.values())await this.runtime.command(engine.pid,'close',document.documentId)
        .catch(error=>{resourcesReleased=false;diagnosticLog('keynote-prepare',`working copy retained ${String(error)}`)})
      if(engine.owned)await this.runtime.command(engine.pid,'quit').catch(error=>diagnosticLog('keynote-prepare',`worker retained ${String(error)}`))
    })))
    if(this.root&&resourcesReleased)await rm(await this.root,{recursive:true,force:true})
  }
}
