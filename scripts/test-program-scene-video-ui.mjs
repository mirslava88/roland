// Exercise the real PiP preview and output with a synthetic camera only.
import { build } from 'esbuild'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import electron from 'electron'

const directory = resolve('tmp/pip-video-ui')
mkdirSync(directory, { recursive: true })
const store = `
import { useSyncExternalStore } from 'react';
const listeners = new Set(); let revision = 0;
const capture = { sourceId: 'camera', captureKind: 'device', videoDeviceId: 'video', videoLabel: 'Synthetic camera', audioEnabled: false };
if (location.search.includes('legacy')) delete capture.captureKind;
if (location.search.includes('desktop')) Object.assign(capture, {captureKind: 'desktop', desktopSourceId: 'window:1:0', desktopSourceType: 'window'});
const state = { programScene: { enabled: true, captureSourceId: 'camera', placement: 'right-center', participantSize: 'medium', participantScale: 1, cornerStyle: 'sharp', transitionEffect: 'instant', viewMode: 'both', textOverlays: [], textOverlaysVisible: true, mediaLayers: [], mediaLayersVisible: false, background:{kind:'image',imagePath:null,videoPath:null,channelId:null,loop:true,muted:true}, chromaKey:{enabled:false,color:'#00b140',tolerance:32,softness:18,spill:55} }, qrOverlay: {enabled:false,sceneVisible:true,contentType:'url',url:'https://',wifiSsid:'',wifiPassword:'',wifiSecurity:'WPA',wifiHidden:false,imagePath:null,moduleStyle:'square',cornerStyle:'sharp',color:'#000000',logoPath:null,description:'',descriptionColor:'#ffffff',descriptionBackgroundColor:'#030712',descriptionBackgroundAuto:false,descriptionTextAutoContrast:true,descriptionBackgroundTransparent:false,descriptionFontScale:1,descriptionWidthPercent:65,descriptionSide:'right',sizePercent:24,xPercent:84,yPercent:80}, captureSources: [{ id: 'camera', capture }], backdropImage: 'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="960" height="540" fill="#7c3aed"/></svg>'), activeFile: null, selectedFile: null, selectedChannel: null, channelIds: [], channels: {}, currentSlide:1, pptxSlidesMap: {}, pptxThumbnailsMap: {}, pptxAspectRatios:{}, docPreviewsMap:{}, displays:[], selectedDisplayId:null, isPresentationWindowOpen:false, addCaptureSource() {}, setSelectedChannel(id) { state.selectedChannel=id; revision++; listeners.forEach(fn=>fn()); }, setProgramScene(update) { state.programScene = {...state.programScene, ...update}; if(update.enabled===false){state.programSnapshot=null;if(state.programOutputStatus)state.programOutputStatus.phase='idle';} revision++; listeners.forEach(fn => fn()); }, setQrOverlay(update) { state.qrOverlay = {...state.qrOverlay, ...update}; revision++; listeners.forEach(fn=>fn()); } };
state.setBackdropImage = path => { state.backdropImage=path; revision++; listeners.forEach(fn=>fn()); };
state.setPresentationWindowOpen = open => { state.isPresentationWindowOpen=open; revision++; listeners.forEach(fn=>fn()); };
const defaultTitleDraft = {speakers:[],selectedSpeakerId:null,eventLabel:'МЕРОПРИЯТИЕ',eventInfo:'',speakerEnterEffect:'slide-left',speakerExitEffect:'slide-left',speakerAutoHideSeconds:0,speakerStyle:'rounded',speakerTextColor:'#ffffff',speakerBackgroundStart:'#070d18',speakerBackgroundEnd:'#0f222e',speakerAccentStart:'#3ee59b',speakerAccentEnd:'#24b8d8',eventEnterEffect:'fade',eventExitEffect:'fade',eventAutoHideSeconds:0,eventPosition:'top-right',eventStyle:'rounded',eventTextColor:'#ffffff',eventBackgroundStart:'#070d18',eventBackgroundEnd:'#0d1b28',eventAccentStart:'#5be5b2',eventAccentEnd:'#24b8d8'};
const defaultTitleOutput = {...defaultTitleDraft,sourceIdentity:null,speakerRevision:0,eventRevision:0,speakerId:null,speakerName:'',speakerRole:'',speakerVisible:false,eventVisible:false};
Object.assign(state,{informationMedia:null,displayAssignments:{},programCaptureTitlesSourceIdentity:null,broadcastTitles:defaultTitleDraft,captureTitlesOutputs:{},timerDuration:900,timerRemaining:420,timerRunning:true,timerOutputVisible:true,timerOutputOwner:'toolbar',timerSoundEnd:null,timerSoundWarning:null,timerOverlayPosition:{x:90,y:90},timerOverlayScale:1,timerTextColor:'#ffffff',timerWarningTextColor:'#facc15',timerOvertimeTextColor:'#ef4444',timerTextOpacity:1,setTimerDuration(seconds){state.timerDuration=seconds;state.timerRemaining=seconds;revision++;listeners.forEach(fn=>fn());},setTimerRemaining(seconds){state.timerRemaining=seconds;revision++;listeners.forEach(fn=>fn());},setTimerRunning(running){state.timerRunning=running;revision++;listeners.forEach(fn=>fn());},setTimerOutputState(visible,owner){state.timerOutputVisible=visible;state.timerOutputOwner=visible?owner:null;revision++;listeners.forEach(fn=>fn());},addTimerMinutes(minutes){state.timerDuration=Math.max(0,state.timerDuration+minutes*60);state.timerRemaining+=minutes*60;revision++;listeners.forEach(fn=>fn());},resetTimer(){state.timerRemaining=state.timerDuration;state.timerRunning=false;revision++;listeners.forEach(fn=>fn());},setTimerSoundEnd(path){state.timerSoundEnd=path;revision++;listeners.forEach(fn=>fn());},setTimerSoundWarning(path){state.timerSoundWarning=path;revision++;listeners.forEach(fn=>fn());},setTimerOverlayPosition(position){state.timerOverlayPosition=position;revision++;listeners.forEach(fn=>fn());},setTimerOverlayScale(scale){state.timerOverlayScale=scale;revision++;listeners.forEach(fn=>fn());},setTimerTextColor(color){state.timerTextColor=color;revision++;listeners.forEach(fn=>fn());},setTimerWarningTextColor(color){state.timerWarningTextColor=color;revision++;listeners.forEach(fn=>fn());},setTimerOvertimeTextColor(color){state.timerOvertimeTextColor=color;revision++;listeners.forEach(fn=>fn());},setTimerTextOpacity(opacity){state.timerTextOpacity=opacity;revision++;listeners.forEach(fn=>fn());},setBroadcastTitles(update){state.broadcastTitles={...state.broadcastTitles,...update};revision++;listeners.forEach(fn=>fn());},setCaptureTitlesOutput(identity,update){state.captureTitlesOutputs={...state.captureTitlesOutputs,[identity]:{...defaultTitleOutput,...state.captureTitlesOutputs[identity],...update}};revision++;listeners.forEach(fn=>fn());}});
Object.assign(state,{programSnapshot:null,programOutputStatus:{desiredRevision:0,confirmedRevision:0,phase:'idle',error:null},internalProgramOutputActive:false,publishProgramSnapshot(channelId,overrides={}){const next=state.programOutputStatus.desiredRevision+1;state.programSnapshot={revision:next,publishedAt:Date.now(),contentChannelId:channelId??null,backdropImage:overrides.backdropImage??state.backdropImage,scene:overrides.scene??state.programScene,qrOverlay:overrides.qrOverlay??state.qrOverlay,timer:overrides.timer??{duration:state.timerDuration,remaining:state.timerRemaining,running:state.timerRunning,visible:state.timerOutputVisible,position:state.timerOverlayPosition,scale:state.timerOverlayScale,textColor:state.timerTextColor,warningTextColor:state.timerWarningTextColor,overtimeTextColor:state.timerOvertimeTextColor,textOpacity:state.timerTextOpacity}};if(overrides.qrOverlay)state.qrOverlay=overrides.qrOverlay;if(overrides.timer){state.timerDuration=overrides.timer.duration;state.timerRemaining=overrides.timer.remaining;state.timerRunning=overrides.timer.running;state.timerOutputVisible=overrides.timer.visible;state.timerOutputOwner=overrides.timer.visible?'scene':null;state.timerOverlayPosition=overrides.timer.position;state.timerOverlayScale=overrides.timer.scale;state.timerTextColor=overrides.timer.textColor;state.timerWarningTextColor=overrides.timer.warningTextColor;state.timerOvertimeTextColor=overrides.timer.overtimeTextColor;state.timerTextOpacity=overrides.timer.textOpacity;}state.programOutputStatus={desiredRevision:next,confirmedRevision:next,phase:'live',error:null};revision++;listeners.forEach(fn=>fn());return next;},confirmProgramSnapshot(){},failProgramSnapshot(){},clearProgramSnapshot(){state.programSnapshot=null;state.programOutputStatus.phase='idle';},setInternalProgramOutputActive(active){state.internalProgramOutputActive=active;}});
if (location.search.includes('timer-empty')) Object.assign(state,{timerDuration:0,timerRemaining:0,timerRunning:false,timerOutputVisible:false,timerOutputOwner:null,programScene:{...state.programScene,enabled:false}});
if (location.search.includes('no-participant')) Object.assign(state,{programScene:{...state.programScene,captureSourceId:null,background:{kind:'image',imagePath:state.backdropImage,videoPath:null,channelId:null,loop:true,muted:true}}});
if (!location.search.includes('timer-empty')) state.publishProgramSnapshot(null);
window.testSlideSize = location.search.includes('portrait') ? [600, 900] : location.search.includes('four-three') ? [800, 600] : [960, 540];
if (location.search.includes('corners')) {
  const [width, height] = window.testSlideSize;
  const thumb = (w, h) => 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'"><path fill="#20c060" d="M0 0H'+w+'V'+h+'H0Z"/></svg>');
  state.activeFile = {path:'test-slide',name:'Synthetic slide',type:location.search.includes('pdf') ? 'pdf' : 'presentation'};
  state.currentSlide = 1;
  state.pptxThumbnailsMap = {'test-slide': [thumb(width,height),thumb(height,width)]};
  if (state.activeFile.type === 'presentation') state.pptxAspectRatios = {'test-slide': width / height};
}
export const useAppStore = Object.assign((select = state => state) => { useSyncExternalStore(fn => { listeners.add(fn); return () => listeners.delete(fn); }, () => revision); return select(state); }, {getState: () => state});
export const captureSourceIdentity = capture => capture?.sourceId || '';
export const DEFAULT_BROADCAST_TITLES_OUTPUT = defaultTitleOutput;
export const resetPptxNavState = () => {};
export const awaitPptxGotoChainIdle = async () => {};
export const connectedProgramDisplayId = source => source.displays.find(display => !display.isPrimary && source.displayAssignments[String(display.id)] === 'program')?.id ?? null;
export const isSpeakerOnlyDisplayRouting = () => false;
export const isRendererOnlyPresentationRouting = () => false;
window.testScene = state;
`
const pdfStub = `
export const GlobalWorkerOptions = {};
export function getDocument() {
  return {destroy:async()=>{},promise:Promise.resolve({numPages:2, getPage:async(number)=>{
    const size = number === 1 ? window.testSlideSize : [...window.testSlideSize].reverse();
    return {getViewport:({scale})=>({width:size[0]*scale,height:size[1]*scale}),cleanup(){},render({canvas,canvasContext}) {
      if (location.search.includes('pdf-replace')) {
        if (number === 1) {
          canvasContext.fillStyle='#dc2020'; canvasContext.fillRect(0,0,canvas.width,canvas.height);
        } else {
          canvasContext.clearRect(0,0,canvas.width,canvas.height);
          canvasContext.fillStyle='#2060dc'; canvasContext.fillRect(canvas.width*.25,canvas.height*.25,canvas.width*.5,canvas.height*.5);
        }
      } else {
        canvasContext.fillStyle='#20c060'; canvasContext.fillRect(0,0,canvas.width,canvas.height);
      }
      return {promise:Promise.resolve(),cancel(){}};
    }};
  }})};
}
`
await build({ stdin: { contents: `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ProgramSceneModal } from './src/renderer/src/components/ProgramScene/ProgramSceneModal';
import { Timer } from './src/renderer/src/components/Controls/Timer';
import { PdfViewer } from './src/renderer/src/components/PresentationView/PdfViewer';
import { ProgramSceneTextOverlayLayer } from './src/renderer/src/components/ProgramScene/ProgramSceneTextOverlays';
import { CaptureHub } from './src/renderer/src/components/PresentationView/CaptureHub';
import { BroadcastTitlesBridge } from './src/renderer/src/components/BroadcastTitles/BroadcastTitlesBridge';
import { InformationTitlesLayer } from './src/renderer/src/components/AuxiliaryDisplays/InformationTitlesLayer';
import { getProgramSceneRects } from './src/shared/program-scene';
import { useAppStore } from './src/renderer/src/stores/useAppStore';
const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
if (location.search.includes('four-three')) canvas.height = 480;
window.sourceAspect = canvas.width / canvas.height;
const ctx = canvas.getContext('2d');
ctx.fillStyle = '#20c060'; ctx.fillRect(0, 0, canvas.width, canvas.height);
ctx.fillStyle = '#ffffff'; ctx.fillRect(300, canvas.height * .1, 40, canvas.height * .8);
ctx.fillStyle = '#4080f0'; ctx.fillRect(0, 0, 60, canvas.height); ctx.fillRect(580, 0, 60, canvas.height);
const frame = canvas.toDataURL(); const handlers = new Map();
// A static off-DOM canvas does not continuously emit captureStream frames.
const cameraTick = setInterval(() => { ctx.fillStyle = '#4080f0'; ctx.fillRect(0, 0, 2, 2); }, 50);
const emit = (event, ...args) => handlers.get(event)?.forEach(fn => fn(...args));
window.testEmit = emit;
window.sceneTakeChannels = [];
window.addEventListener('take-channel', event => { const id=event.detail; const scene=window.testScene; window.sceneTakeChannels.push(id); scene.liveChannel=id; scene.activeFile=scene.channels[id]?.file??null; scene.currentSlide=scene.channels[id]?.slide??1; scene.setProgramScene({}); setTimeout(()=>window.dispatchEvent(new CustomEvent('take-channel-completed',{detail:{channelId:id}})),0); });
window.backdropPickerOpens = 0;
window.timerOverlayShows = 0;
window.timerOverlayHides = 0;
window.addEventListener('close-program-output', () => window.testScene?.setProgramScene({enabled:false}));
window.pdfReadyCount = 0;
window.api = { dbgLog() {}, on(event, fn) { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(fn); return () => handlers.get(event).delete(fn); },
  async openPresentationWindow() { window.testScene.setPresentationWindowOpen(true); },
  setActiveContentType() {},
  sendToControl(event, ...args) { if (event === 'capture-preview-frame') window.lastPreview = args[0].dataUrl; if (event === 'presentation-content-ready') window.pdfReadyCount++; emit(event, ...args); },
  sendToPresentation(event, ...args) {
    if (event === 'capture-devices-request') queueMicrotask(() => emit('capture-devices-response', {requestId: args[0].requestId, devices: [{kind: 'videoinput', deviceId: 'video', label: 'Synthetic camera'}]}));
    if (event === 'capture-source-state-request') queueMicrotask(() => emit('capture-preview-frame', {sourceId: 'camera', dataUrl: frame, state: {sourceId: 'camera', status: 'ready'}}));
    emit(event, ...args);
  },
  updateQrOverlay(payload) { window.lastQrOverlay = payload; },
  async getTimerOverlayLayout() { return {x:.9,y:.9,scale:1}; },
  updateTimerOverlay() {},
  async showTimerOverlay() { window.timerOverlayShows++; },
  async hideTimerOverlay() { window.timerOverlayHides++; },
  async renderPdfPage(_filePath, pageIndex, width) {
    if (!location.search.includes('pdf-native-dpi')) return null;
    const size = pageIndex === 0 ? window.testSlideSize : [...window.testSlideSize].reverse();
    const height = Math.max(1, Math.round(width * size[1] / size[0]));
    const native = document.createElement('canvas');
    native.width = Math.round(width * 1.5); native.height = Math.round(height * 1.5);
    const nativeContext = native.getContext('2d');
    nativeContext.fillStyle = '#2060dc'; nativeContext.fillRect(0, 0, width, height);
    return native.toDataURL();
  },
  async getWindowDisplayScaleFactor() { return 1; },
  async selectBackdropImage() { window.backdropPickerOpens++; return 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#e11d48"/></svg>'); },
  async selectVideoFiles() { return []; },
  async selectSceneLayerFiles() { return window.nextSceneLayerFiles || ['synthetic-layer.png']; },
  async readFile(path) { return /^synthetic-(qr|logo)\./i.test(path) ? Uint8Array.from(atob(frame.split(',')[1]), c=>c.charCodeAt(0)).buffer : new Uint8Array(); },
  async updateProgramSceneMediaOverlay() { return {success:true}; }
};
window.captureOpens = 0; window.captureTracks = [];
Object.defineProperty(navigator, 'mediaDevices', {value: {
  async getUserMedia() { window.captureOpens++; const stream = canvas.captureStream(10); window.captureTracks.push(...stream.getTracks()); return stream; },
  async enumerateDevices() { return []; }, addEventListener() {}, removeEventListener() {}
}});
function Output() {
  const scene = useAppStore(s => s.programScene);
  const rect = getProgramSceneRects(innerWidth, innerHeight, scene).participant;
  const participantStyle = {left: rect.x, top: rect.y, width: rect.width, height: rect.height, borderRadius: scene.cornerStyle === 'rounded' ? 20 : 0};
  React.useEffect(() => { window.api.sendToPresentation('capture-source-register', window.testScene.captureSources[0].capture); }, []);
  return <div style={{position:'relative',width:'100vw',height:'100vh',background:'#7c1d1d'}}><div data-program-scene-key-fill style={{position:'absolute',...participantStyle,zIndex:3,background:'#ff00ff'}} /><CaptureHub activeSourceId={scene.testDisplayMode === 'fullscreen' || scene.testDisplayMode === 'content' ? 'camera' : null}
    audioSourceId={null} sceneSourceId="camera" sceneStyle={participantStyle} backgroundSceneStyle={participantStyle}
    sceneChromaKey={scene.chromaKey}
    activeSceneStyle={scene.testDisplayMode === 'content' ? {left: rect.x, top: rect.y, width: rect.width, height: rect.height} : undefined}
    takeRequest={null} onTakeReady={() => {}} onTakeError={() => {}} />{scene.textOverlaysVisible !== false && <ProgramSceneTextOverlayLayer overlays={scene.textOverlays || []} />}</div>;
}
const root = createRoot(document.getElementById('root'));
window.unmountTest = () => { clearInterval(cameraTick); root.unmount(); };
root.render(location.search.includes('pdf-replace') || location.search.includes('pdf-native-dpi')
  ? <div style={{width:'100vw',height:'100vh'}}><PdfViewer filePath="mixed-pages.pdf" startSlide={1} requestId={1} /></div>
  : location.search.includes('output')
    ? <Output />
    : <><Timer /><ProgramSceneModal onClose={() => {}} /><BroadcastTitlesBridge /><InformationTitlesLayer /></>);
`, loader: 'tsx', resolveDir: process.cwd() }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
  define: { 'import.meta.url': JSON.stringify(pathToFileURL(resolve(directory, 'index.html')).href) },
  outfile: resolve(directory, 'render.js'), plugins: [{ name: 'synthetic-input', setup(build) {
    build.onResolve({ filter: /(?:stores\/useAppStore|\/media|pdfjs-dist|\/pdf-live-cache|\/pdfium-renderer)$/ }, args => ({ path: args.path.split('/').pop(), namespace: 'fake' }))
    build.onLoad({ filter: /.*/, namespace: 'fake' }, args => ({ contents: args.path === 'useAppStore' ? store
      : args.path === 'pdfjs-dist' ? pdfStub
      : args.path === 'media' ? 'export const mediaUrl = path => /^synthetic-.*\\.(png|jpg|svg)$/i.test(path) ? "data:image/svg+xml,"+encodeURIComponent(\'<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#e11d48"/></svg>\') : path'
      : args.path === 'pdfium-renderer' ? 'export const warmPdfiumDocument=async()=>{}; export const releasePdfiumResources=()=>{}; export const renderPdfiumPageToCanvas=async()=>{throw new Error("force pdf.js")};'
      : 'export const getPdfLiveTargetSize = () => ({}); export const makePdfLiveCacheKey = () => "";',
      loader: 'js', resolveDir: process.cwd() }))
  } }] })
const assets = ['out/stream/renderer/assets', 'out/renderer/assets'].find(path => {
  try { return readdirSync(path).some(name => name.endsWith('.css')) } catch { return false }
})
if (!assets) throw new Error('Build PDM first.')
const css = readdirSync(assets).find(name => name.endsWith('.css'))
writeFileSync(resolve(directory, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(resolve(assets, css))}"></head><body><div id="root"></div><script src="render.js"></script></body></html>`)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
const child = spawn(electron, ['scripts/test-program-scene-video-ui.cjs'], { env, windowsHide: true, stdio: 'inherit' })
child.on('exit', code => { process.exitCode = code ?? 1 })
child.on('error', error => { console.error(error); process.exitCode = 1 })
