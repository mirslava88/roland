import { build } from 'esbuild'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const work = await mkdtemp(join(tmpdir(), 'pdm-pptx-early-test-'))
const entry = join(work, 'test.cjs')
await build({ stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
import assert from 'node:assert/strict';
import { canStartPptx, cachedPptxPrefix } from './src/renderer/src/pptx-cache-readiness';
import { exportPptxIncrementally } from './src/main/pptx-incremental-export';
(async()=>{
 const frames=n=>Array.from({length:n},(_,i)=>'slide_'+(i+1)+'.png');
 assert.equal(canStartPptx('loading',frames(30),123),false);
 assert.equal(canStartPptx('loading',frames(31),123),true);
 assert.equal(canStartPptx('partial',frames(31),123),true);
 assert.equal(canStartPptx('loading',[],0),false);
 assert.equal(canStartPptx('loading',frames(1),1),true);
 assert.equal(canStartPptx('error',[],123),true);
 assert.equal(cachedPptxPrefix(['first',undefined,'third']),1);
 const calls=[];let terminal=false;
 const send=async(cmd,args)=>{
  calls.push(args.startSlide);
  const next=args.startSlide+args.batchSize;
  if(args.startSlide===1)setImmediate(()=>calls.push('navigation'));
  terminal=next>10;
  return {ok:true,slideCount:10,exportPending:!terminal,nextSlide:next};
 };
 await exportPptxIncrementally(send,{path:'fixture',outputDir:'cache',width:1920,height:1080});
 assert.deepEqual(calls,[1,'navigation',5,9]);assert.equal(terminal,true);
 await assert.rejects(exportPptxIncrementally(async()=>({ok:true,slideCount:10,exportPending:true,nextSlide:1}),{path:'f',outputDir:'c',width:1,height:1}),/continuation/);
 const failure=await exportPptxIncrementally(async()=>({ok:false,error:'export failed'}),{path:'f',outputDir:'c',width:1,height:1});
 assert.equal(failure.ok,false);
 console.log('PASS: exact 25% threshold, contiguous frames, short batches, interactive yield and failure handling');
})().catch(error=>{console.error(error);process.exitCode=1});
` }, bundle: true, platform: 'node', format: 'cjs', outfile: entry })
const result = spawnSync(process.execPath, [entry], { stdio: 'inherit', windowsHide: true })
process.exitCode = result.status ?? 1
