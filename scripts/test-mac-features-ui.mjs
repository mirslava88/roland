import { build } from 'esbuild'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import electron from 'electron'

const directory = resolve('tmp/mac-features-ui'); mkdirSync(directory, { recursive: true })
const assets = resolve('out/stream/renderer/assets')
const css = readdirSync(assets).find(name => /^index-.*\.css$/.test(name))
if (!css) throw new Error('Build Stream before the UI check')
for (const stream of [false, true]) {
  const edition = stream ? 'stream' : 'standard'
  await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {RecordControl} from './src/renderer/src/components/Controls/RecordControl';
import {InterfaceTour} from './src/renderer/src/components/Onboarding/InterfaceTour';
import {SpeakerSlideCanvas} from './src/renderer/src/components/AuxiliaryDisplays/SpeakerSlideCanvas';
import {DEFAULT_SPEAKER_SLIDE_LAYOUT} from './src/shared/speaker-layout';
window.testErrors=[];window.testCalls=[];window.fullscreenCalls=[];
window.addEventListener('error',e=>window.testErrors.push(String(e.error||e.message)));
window.addEventListener('unhandledrejection',e=>window.testErrors.push(String(e.reason)));
let status={phase:'idle',startedAt:null,frames:0,fps:0,droppedFrames:0,sizeBytes:0};
const pixel='data:image/svg+xml;base64,'+btoa('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="18"><rect width="32" height="18" fill="blue"/></svg>');
window.api={platform:'darwin',dbgLog(){},on(){return()=>{}},
 prepareInternalProgramOutput:async()=>{window.testCalls.push('prepare')},
 setControlPreviewFullscreen:async value=>{window.fullscreenCalls.push(value);return true},
 recording:{load:async()=>({format:'quality-mp4',fps:30,audio:'none',microphoneId:''}),save:async()=>{},devices:async()=>[],
 status:async()=>({...status}),start:async()=>{window.testCalls.push('start');status={...status,phase:'running',startedAt:Date.now()};return true},
 stop:async()=>{window.testCalls.push('stop');status={...status,phase:'idle',path:'training://recording.mp4'}},
 editOpen:async last=>{window.testCalls.push('editOpen:'+last);return {path:'training://recording.mp4',duration:8,hasAudio:true,format:'mp4',frameRate:25}},
 editFrame:async()=>pixel,editThumbnails:async()=>Array(12).fill(pixel),editTimelineFrames:async times=>times.map(()=>pixel),
 editWaveform:async()=>pixel,editWaveformWindows:async windows=>windows.map(()=>pixel),editTimelineCancel:async()=>{},
 editStatus:async()=>({phase:'idle',progress:0,outputs:[]}),editExport:async()=>({phase:'done',progress:1,outputs:['test.mp4']}),editCancel:async()=>{}}};
function Test(){const[tour,setTour]=React.useState(false);window.showTestTour=()=>setTour(true);
return <div style={{padding:20}}>{__PDM_STREAM_ENABLED__&&<RecordControl/>}
 <div style={{width:600,height:338,marginTop:20}}><SpeakerSlideCanvas layout={DEFAULT_SPEAKER_SLIDE_LAYOUT} isPdf={false} current={<div>Текущий слайд</div>} next={<div>Следующий слайд</div>} fileName="Тест суфлёра" currentSlide={1} totalSlides={3} notes="Заметки спикера"/></div>
 {tour&&<InterfaceTour initialStep={29}/>}</div>}
createRoot(document.getElementById('root')).render(<Test/>);
` }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', outfile: resolve(directory, edition + '.js'),
    define: { __PDM_STREAM_ENABLED__: String(stream) }, plugins: [{ name: 'training-video', setup(builder) {
      builder.onResolve({ filter: /\.mp4\?inline$/ }, args => ({ path: resolve(args.resolveDir, args.path.split('?')[0]), namespace: 'video' }))
      builder.onLoad({ filter: /.*/, namespace: 'video' }, args => ({ contents: `export default ${JSON.stringify('data:video/mp4;base64,' + readFileSync(args.path).toString('base64'))}`, loader: 'js' }))
    }}] })
  writeFileSync(resolve(directory, edition + '.html'), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(resolve(assets, css)).href}"></head><body class="dark bg-gray-900 text-white"><div id="root"></div><script>window.api={platform:"darwin"}</script><script src="${edition}.js"></script></body></html>`)
}
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
const child = spawn(electron, ['scripts/test-mac-features-ui.cjs'], { env, stdio: 'inherit' })
child.on('exit', code => { process.exitCode = code ?? 1 }); child.on('error', error => { console.error(error); process.exitCode = 1 })
