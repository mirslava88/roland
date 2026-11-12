// Real Electron capturePage -> isolated PCM worklet -> FFmpeg -> editor export.
// Records only a generated private window and silence; no hardware permissions.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { constants, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import electron from 'electron'

const root = process.cwd(), directory = mkdtempSync(resolve('tmp/mac-recording-live-'))
const ffmpeg = process.env.PDM_TEST_FFMPEG || resolve('tmp/macos-build/build/mac-ffmpeg')
for (const name of ['main', 'build', 'profile']) mkdirSync(join(directory, name))
for (const name of ['renderer', 'preload']) cpSync(resolve(`out/stream/${name}`), join(directory, name), { recursive: true, mode: constants.COPYFILE_FICLONE })
cpSync(ffmpeg, join(directory, 'build/mac-ffmpeg'), { mode: constants.COPYFILE_FICLONE })
writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'pdm-recording-test', version: '1.0.0', main: 'main/index.cjs' }))
writeFileSync(join(directory, 'renderer/program-pattern.html'), '<!doctype html><html><body style="margin:0;background:rgb(91,53,17);color:white"><h1>Тест записи PDM</h1><div id="counter"></div><script>let i=0;setInterval(()=>document.getElementById("counter").textContent=++i,40)</script></body></html>')
writeFileSync(join(directory, 'renderer/index.html'), '<!doctype html><html><body>Recording integration test<script src="record-driver.js"></script></body></html>')
writeFileSync(join(directory, 'renderer/record-driver.js'), `
(async()=>{const results=[];
try { for(const format of ['lossless-mkv','quality-mp4']) {
 await window.api.recording.start({format,fps:25,audio:'none',microphoneId:''},null);
 await new Promise(done=>setTimeout(done,1800)); const running=await window.api.recording.status();
 await window.api.recording.stop(); const final=await window.api.recording.status();
 if(final.phase!=='idle')throw new Error(final.error||'File did not finish');
 const source=await window.api.recording.editOpen(true);
 const frame=await window.api.recording.editFrame(0.1);
 const frames=await window.api.recording.editTimelineFrames([0.1,0.3]);
 await window.api.recording.editExport({mode:'fragment',start:0.1,end:Math.min(source.duration,0.8),format:'quality-mp4'});
 let exported; for(let i=0;i<100;i++){exported=await window.api.recording.editStatus();if(exported.phase!=='running')break;await new Promise(done=>setTimeout(done,50))}
 if(exported.phase!=='done')throw new Error(exported.message||'Editor did not finish');
 results.push({format,running,final,source,frameReady:frame.startsWith('data:image/'),timelineReady:frames.every(f=>f.startsWith('data:image/')),exported});
 } window.api.dbgLog('RECORD_TEST:'+JSON.stringify({results}));
}catch(error){window.api.dbgLog('RECORD_TEST:'+JSON.stringify({error:String(error),results}));}})();`)
await build({ stdin: { resolveDir: root, loader: 'ts', contents: `
import {app,BrowserWindow,dialog,ipcMain} from 'electron';
import {join} from 'node:path'; import {writeFileSync} from 'node:fs';
import {MacRecordingManager} from './src/main/mac-recording';
app.setPath('userData',${JSON.stringify(join(directory, 'profile'))});
app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
let manager;let n=0;const deadline=setTimeout(()=>app.exit(1),40000);
dialog.showSaveDialog=async(...args)=>{const options=args[args.length-1];return {canceled:false,filePath:join(${JSON.stringify(directory)},'result-'+(++n)+'.'+options.filters[0].extensions[0])}};
app.whenReady().then(async()=>{
 const program=new BrowserWindow({show:false,width:640,height:360,useContentSize:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 await program.loadFile(join(__dirname,'../renderer/program-pattern.html'));program.setOpacity(0);program.showInactive();
 const control=new BrowserWindow({show:false,webPreferences:{preload:join(__dirname,'../preload/index.js'),sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
 manager=new MacRecordingManager(()=>control,()=>null,()=>program);
 ipcMain.on('dbg-log',async(event,message)=>{if(event.sender!==control.webContents||!String(message).startsWith('RECORD_TEST:'))return;
   const bitmap=(await program.webContents.capturePage()).toBitmap();const sourceRGB=[bitmap[2],bitmap[1],bitmap[0]];
   writeFileSync(${JSON.stringify(join(directory, 'report.json'))},JSON.stringify({...JSON.parse(String(message).slice('RECORD_TEST:'.length)),sourceRGB}));
   await manager.shutdown();clearTimeout(deadline);app.exit(0);
 });
 await control.loadFile(join(__dirname,'../renderer/index.html'));
}).catch(error=>{console.error(error);app.exit(1)});
` }, bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: join(directory, 'main/index.cjs') })
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
const child = spawn(electron, [directory], { env, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log = (log + bytes.toString()).slice(-12000) })
const code = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done) })
try {
  assert.equal(code, 0, log)
  const report = JSON.parse(readFileSync(join(directory, 'report.json'), 'utf8'))
  assert.equal(report.error, undefined, JSON.stringify(report) + log)
  assert.equal(report.results.length, 2)
  for (const result of report.results) {
    assert.equal(result.running.phase, 'running'); assert.equal(result.final.phase, 'idle')
    assert.ok(result.final.sizeBytes > 1000 && result.frameReady && result.timelineReady)
    for (const file of [result.final.path, ...result.exported.outputs]) {
      execFileSync(ffmpeg, ['-v', 'error', '-i', file, '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] })
    }
    const first = execFileSync(ffmpeg, ['-v', 'error', '-i', result.final.path, '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { maxBuffer: 8 * 1024 * 1024 })
    assert.ok(first.some(value => value !== 0), 'captured frame must not be blank')
    if (result.format === 'lossless-mkv') assert.deepEqual([...first.subarray(0,3)], report.sourceRGB, 'captured RGB pixels changed during recording')
    console.log('PASS: real Mac Electron window + audio worklet records, decodes and edits ' + result.format)
  }
  writeFileSync(resolve('tmp/mac-recording-live-report.json'), JSON.stringify(report, null, 2))
} catch (error) { console.error('Live recording fixture:', directory); console.error(log); throw error }
finally { if (code === 0) rmSync(directory, { recursive: true, force: true }) }
