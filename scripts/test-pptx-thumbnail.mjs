import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import electron from 'electron'

const directory=resolve('tmp/pptx-thumbnail-test')
mkdirSync(directory,{recursive:true})
await build({stdin:{contents:`
import { app, nativeImage } from 'electron';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resizePptxThumbnail } from './src/main/pptx-thumbnail';
app.whenReady().then(async()=>{
 const root=await mkdtemp(join(tmpdir(),'pdm-thumbnail-native-test-'));
 try {
  for(const [width,height,expectedWidth,expectedHeight] of [[1920,1080,320,180],[540,960,135,240],[1024,768,320,240],[160,90,160,90]]){
   const frame=nativeImage.createFromBitmap(Buffer.alloc(width*height*4,255),{width,height});
   const path=join(root,'synthetic.png');await writeFile(path,frame.toPNG());
   const bytes=await resizePptxThumbnail(path);const resized=nativeImage.createFromBuffer(bytes);
   assert.deepEqual(resized.getSize(),{width:expectedWidth,height:expectedHeight});
   assert.deepEqual(Array.from(resized.toBitmap().subarray(0,4)),[255,255,255,255]);
  }
  const invalid=join(root,'invalid.png');await writeFile(invalid,'invalid');
  await assert.rejects(resizePptxThumbnail(invalid),/Invalid PowerPoint/);
  console.log('PASS: real Electron thumbnail resizing, bounded small images, portrait/landscape/4:3, no upscaling and invalid PNG');
 } finally { await rm(root,{recursive:true,force:true}); }
 app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});
`,loader:'ts',resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',external:['electron'],outfile:resolve(directory,'test.cjs')})
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL
const child=spawn(electron,[resolve(directory,'test.cjs')],{env,windowsHide:true,stdio:'inherit'})
child.on('exit',code=>{process.exitCode=code??1})
child.on('error',error=>{console.error(error);process.exitCode=1})
