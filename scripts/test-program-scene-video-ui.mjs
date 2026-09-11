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
const state = { programScene: { enabled: true, captureSourceId: 'camera', placement: 'right-center', participantSize: 'medium', participantScale: 1, cornerStyle: 'sharp', transitionEffect: 'instant', viewMode: 'both', textOverlays: [], textOverlaysVisible: true, mediaLayers: [], mediaLayersVisible: false, chromaKey:{enabled:false,color:'#00b140',tolerance:32,softness:18,spill:55} }, qrOverlay: {enabled:false,sceneVisible:true,contentType:'url',url:'https://',wifiSsid:'',wifiPassword:'',wifiSecurity:'WPA',wifiHidden:false,imagePath:null,moduleStyle:'square',cornerStyle:'sharp',color:'#000000',logoPath:null,description:'',descriptionColor:'#ffffff',descriptionBackgroundColor:'#030712',descriptionBackgroundAuto:false,descriptionTextAutoContrast:true,descriptionBackgroundTransparent:false,descriptionFontScale:1,descriptionWidthPercent:65,descriptionSide:'right',sizePercent:24,xPercent:84,yPercent:80}, captureSources: [{ id: 'camera', capture }], backdropImage: 'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><rect width="960" height="540" fill="#7c3aed"/></svg>'), activeFile: null, selectedFile: null, selectedChannel: null, channelIds: [], channels: {}, currentSlide:1, pptxSlidesMap: {}, pptxThumbnailsMap: {}, pptxAspectRatios:{}, docPreviewsMap:{}, displays:[], selectedDisplayId:null, isPresentationWindowOpen:false, addCaptureSource() {}, setSelectedChannel(id) { state.selectedChannel=id; revision++; listeners.forEach(fn=>fn()); }, setProgramScene(update) { state.programScene = {...state.programScene, ...update}; revision++; listeners.forEach(fn => fn()); }, setQrOverlay(update) { state.qrOverlay = {...state.qrOverlay, ...update}; revision++; listeners.forEach(fn=>fn()); } };
state.setBackdropImage = path => { state.backdropImage=path; revision++; listeners.forEach(fn=>fn()); };
state.setPresentationWindowOpen = open => { state.isPresentationWindowOpen=open; revision++; listeners.forEach(fn=>fn()); };
const defaultTitleDraft = {speakers:[],selectedSpeakerId:null,eventLabel:'МЕРОПРИЯТИЕ',eventInfo:'',speakerEnterEffect:'slide-left',speakerExitEffect:'slide-left',speakerAutoHideSeconds:0,speakerStyle:'rounded',speakerTextColor:'#ffffff',speakerBackgroundStart:'#070d18',speakerBackgroundEnd:'#0f222e',speakerAccentStart:'#3ee59b',speakerAccentEnd:'#24b8d8',eventEnterEffect:'fade',eventExitEffect:'fade',eventAutoHideSeconds:0,eventPosition:'top-right',eventStyle:'rounded',eventTextColor:'#ffffff',eventBackgroundStart:'#070d18',eventBackgroundEnd:'#0d1b28',eventAccentStart:'#5be5b2',eventAccentEnd:'#24b8d8'};
const defaultTitleOutput = {...defaultTitleDraft,sourceIdentity:null,speakerRevision:0,eventRevision:0,speakerId:null,speakerName:'',speakerRole:'',speakerVisible:false,eventVisible:false};
Object.assign(state,{informationMedia:null,displayAssignments:{},programCaptureTitlesSourceIdentity:null,broadcastTitles:defaultTitleDraft,captureTitlesOutputs:{},setBroadcastTitles(update){state.broadcastTitles={...state.broadcastTitles,...update};revision++;listeners.forEach(fn=>fn());},setCaptureTitlesOutput(identity,update){state.captureTitlesOutputs={...state.captureTitlesOutputs,[identity]:{...defaultTitleOutput,...state.captureTitlesOutputs[identity],...update}};revision++;listeners.forEach(fn=>fn());}});
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
window.testScene = state;
`
const pdfStub = `
export const GlobalWorkerOptions = {};
export function getDocument() {
  return {destroy:async()=>{},promise:Promise.resolve({numPages:2, getPage:async(number)=>{
    const size = number === 1 ? window.testSlideSize : [...window.testSlideSize].reverse();
    return {getViewport:({scale})=>({width:size[0]*scale,height:size[1]*scale}),cleanup(){},render({canvas,canvasContext}) {
      canvasContext.fillStyle='#20c060'; canvasContext.fillRect(0,0,canvas.width,canvas.height);
      return {promise:Promise.resolve(),cancel(){}};
    }};
  }})};
}
`
await build({ stdin: { contents: `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ProgramSceneModal } from './src/renderer/src/components/ProgramScene/ProgramSceneModal';
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
window.addEventListener('take-channel', event => window.sceneTakeChannels.push(event.detail));
window.backdropPickerOpens = 0;
window.api = { dbgLog() {}, async readFile() { return new Uint8Array(); }, on(event, fn) { if (!handlers.has(event)) handlers.set(event, new Set()); handlers.get(event).add(fn); return () => handlers.get(event).delete(fn); },
  async openPresentationWindow() { window.testScene.setPresentationWindowOpen(true); },
  setActiveContentType() {},
  sendToControl(event, ...args) { if (event === 'capture-preview-frame') window.lastPreview = args[0].dataUrl; emit(event, ...args); },
  sendToPresentation(event, ...args) {
    if (event === 'capture-devices-request') queueMicrotask(() => emit('capture-devices-response', {requestId: args[0].requestId, devices: [{kind: 'videoinput', deviceId: 'video', label: 'Synthetic camera'}]}));
    if (event === 'capture-source-state-request') queueMicrotask(() => emit('capture-preview-frame', {sourceId: 'camera', dataUrl: frame, state: {sourceId: 'camera', status: 'ready'}}));
    emit(event, ...args);
  },
  updateQrOverlay(payload) { window.lastQrOverlay = payload; },
  async selectBackdropImage() { window.backdropPickerOpens++; return 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#e11d48"/></svg>'); },
  async selectVideoFiles() { return []; },
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
root.render(location.search.includes('output') ? <Output /> : <><ProgramSceneModal onClose={() => {}} /><BroadcastTitlesBridge /><InformationTitlesLayer /></>);
`, loader: 'tsx', resolveDir: process.cwd() }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
  define: { 'import.meta.url': JSON.stringify(pathToFileURL(resolve(directory, 'index.html')).href) },
  outfile: resolve(directory, 'render.js'), plugins: [{ name: 'synthetic-input', setup(build) {
    build.onResolve({ filter: /(?:stores\/useAppStore|\/media|pdfjs-dist|\/pdf-live-cache)$/ }, args => ({ path: args.path.split('/').pop(), namespace: 'fake' }))
    build.onLoad({ filter: /.*/, namespace: 'fake' }, args => ({ contents: args.path === 'useAppStore' ? store
      : args.path === 'pdfjs-dist' ? pdfStub
      : args.path === 'media' ? 'export const mediaUrl = path => path'
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
