// Real PowerPoint/real Electron benchmark. Operates only on an explicitly
// supplied synthetic deck; no stream, camera or audio. 'early' tests native
// TAKE with explicitly offscreen bounds, not on a user's program display.
import { build } from 'esbuild'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import electron from 'electron'

const deck=resolve(process.argv[2] || 'outputs/pdm-cache-benchmark-123.pptx')
const mode=process.argv[3] || 'new'
if(!['old','new','early'].includes(mode)) throw Error('Expected old, new or early benchmark mode')
const daemon=resolve(mode==='old'
  ? 'outputs/pdm-restore-before-single-pass-pptx-20260915/scripts/powerpoint-daemon.ps1'
  : 'scripts/powerpoint-daemon.ps1')
const work=await mkdtemp(join(tmpdir(),'pdm-real-pptx-benchmark-'))
const report=resolve(`outputs/pdm-cache-benchmark-123-${mode}.json`)
await build({stdin:{contents:`
import { app } from 'electron';
import { performance } from 'node:perf_hooks';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { pptDaemon } from './src/main/powerpoint-daemon';
import { createPptxCache, readPptxCacheImages } from './src/main/pptx-cache';
import { resizePptxThumbnail } from './src/main/pptx-thumbnail';
import { exportPptxIncrementally } from './src/main/pptx-incremental-export';
const deck=${JSON.stringify(deck)},root=${JSON.stringify(work)},mode=${JSON.stringify(mode)};
const report=${JSON.stringify(report)};
const phases=[];
let exportCalls=0,prepareCalls=0,releaseCalls=0;
const timed=async(name,work)=>{const start=performance.now();console.log('BEGIN '+mode+' '+name);const result=await work();const ms=performance.now()-start;phases.push({name,ms});console.log('END '+mode+' '+name+' '+Math.round(ms)+' ms');return result};
const check=response=>{if(!response.ok)throw Error(response.error||'PowerPoint failed');return response};
const release=async()=>{releaseCalls++;check(await pptDaemon.send('sync-prepared',{paths:[]},60000));return {success:true}};
app.whenReady().then(async()=>{
 try {
  await mkdir(root,{recursive:true});
  const start=performance.now();let cold,warm,firstThumbnailMs=null;
  let earlyTake=null,earlyTakeMs=null,completed=false;
  if(mode==='old'){
   prepareCalls++;const metadata=check(await timed('prepare',()=>pptDaemon.send('prepare',{path:deck},120000)));
   const thumbnailsDirectory=join(root,'thumbnails');const slidesDirectory=join(root,'slides');
   exportCalls++;check(await timed('thumbnail-export',()=>pptDaemon.send('export',{path:deck,outputDir:thumbnailsDirectory,width:320,height:240},240000)));
   firstThumbnailMs=performance.now()-start;
   exportCalls++;check(await timed('full-slide-export',()=>pptDaemon.send('export',{path:deck,outputDir:slidesDirectory,width:1920,height:1080},240000)));
   const slides=await readPptxCacheImages(slidesDirectory),thumbnails=await readPptxCacheImages(thumbnailsDirectory);
   assert.equal(slides?.length,123);assert.equal(thumbnails?.length,123);
   await timed('cleanup',release);
   cold={ms:performance.now()-start,slideCount:slides.length,aspectRatio:metadata.slideWidth/metadata.slideHeight,slidesDirectory};
   const warmStart=performance.now();prepareCalls++;check(await timed('warm-prepare',()=>pptDaemon.send('prepare',{path:deck},120000)));
   assert.equal((await readPptxCacheImages(slidesDirectory))?.length,123);await timed('warm-cleanup',release);
   warm={ms:performance.now()-warmStart};
  }else{
   const cache=createPptxCache({directory:()=>join(root,'slides'),readCache:readPptxCacheImages,
    export:async(path,outputDir,width,height,onEvent)=>{exportCalls++;return timed('full-slide-export',()=>mode==='early'
      ? exportPptxIncrementally(pptDaemon.send.bind(pptDaemon),{path,outputDir,width,height},onEvent)
      : pptDaemon.send('export',{path,outputDir,width,height,progress:true},240000,onEvent))},
    prepare:async path=>{prepareCalls++;return pptDaemon.send('prepare',{path},120000)},
    resize:resizePptxThumbnail,enqueue:(_key,work)=>work(),release:()=>timed('cleanup',release),log:message=>console.log(message)});
   const result=await cache(deck,1920,1080,progress=>{
    if(firstThumbnailMs===null){firstThumbnailMs=performance.now()-start;console.log('FIRST thumbnail '+Math.round(firstThumbnailMs)+' ms')}
    if(progress.slide%30===0)console.log('Progress '+progress.slide+'/'+progress.slideCount);
    if(mode==='early' && !earlyTake && progress.slide>=Math.ceil(progress.slideCount*.25)){
     earlyTake=pptDaemon.runExclusive(async send=>{
      console.log('BEGIN early offscreen native TAKE');
      check(await send('open',{path:deck,slide:1,bounds:{x:-30000,y:-30000,width:640,height:360},deferPromotion:true},120000));
      check(await send('commit-open',{},20000));
      assert.equal(completed,false,'TAKE must finish before the full export');
      earlyTakeMs=performance.now()-start;
      console.log('EARLY TAKE ready '+Math.round(earlyTakeMs)+' ms');
      check(await send('goto',{slide:5},20000));
     });
     void earlyTake.catch(()=>{});
    }
   });
   completed=true;
   if(mode==='early'){
    assert.ok(earlyTake,'Expected native TAKE at 25%');await earlyTake;
    const live=check(await pptDaemon.send('current'));
    assert.equal(live.slide,5,'Background cleanup must retain the live slideshow and its current slide');
    const last=check(await pptDaemon.send('goto',{slide:123}));
    assert.equal(last.slide,123,'The last slide must remain accessible after background completion');
   }
   assert.equal(result.slides.length,123);assert.equal(result.thumbnails.length,123);assert.equal(exportCalls,1);assert.equal(prepareCalls,0);
   cold={ms:performance.now()-start,slideCount:result.slideCount,aspectRatio:result.aspectRatio,slidesDirectory:join(root,'slides')};
   const warmStart=performance.now();const before={exportCalls,prepareCalls,releaseCalls};
   const cached=await cache(deck);assert.equal(cached.slides.length,123);
   assert.deepEqual({exportCalls,prepareCalls,releaseCalls},before,'Warm cache must not touch PowerPoint');
   warm={ms:performance.now()-warmStart};
  }
  const source=await stat(deck);
  const metrics={mode,sourceBytes:source.size,cold,warm,firstThumbnailMs,earlyTakeMs,exportCalls,prepareCalls,releaseCalls,phases};
  await writeFile(report,JSON.stringify(metrics,null,2));console.log('RESULT '+JSON.stringify(metrics));
 }finally{await pptDaemon.shutdown()}
 app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});
`,loader:'ts',resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',external:['electron'],outfile:join(work,'benchmark.cjs'),
plugins:[{name:'isolated-benchmark-host',setup(build){
 build.onResolve({filter:/\/paths$/},()=>({path:'paths',namespace:'benchmark'}));
 build.onResolve({filter:/\/diagnostic-log$/},()=>({path:'diagnostic',namespace:'benchmark'}));
 build.onLoad({filter:/.*/,namespace:'benchmark'},args=>({contents:args.path==='paths'
  ? `export const scriptPath=name=>name==='powerpoint-daemon.ps1'?${JSON.stringify(daemon)}:${JSON.stringify(resolve('scripts'))}+'/'+name;`
  : 'export const diagnosticLog=()=>{}; export const formatDiagnosticError=error=>String(error);',loader:'js'}));
}}]})
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL
const child=spawn(electron,[join(work,'benchmark.cjs')],{env,windowsHide:true,stdio:'inherit'})
child.on('exit',code=>{process.exitCode=code??1})
child.on('error',error=>{console.error(error);process.exitCode=1})
