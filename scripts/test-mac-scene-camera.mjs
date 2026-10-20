// Real Zustand publication + real camera layers, with synthetic media only.
import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import electron from 'electron'

const directory = resolve('tmp/mac-scene-camera')
mkdirSync(directory, { recursive: true })
await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {useAppStore} from './src/renderer/src/stores/useAppStore';
import {ProgramSceneModal} from './src/renderer/src/components/ProgramScene/ProgramSceneModal';
import {ProgramSceneBridge} from './src/renderer/src/components/ProgramScene/ProgramSceneBridge';
import {CaptureHub} from './src/renderer/src/components/PresentationView/CaptureHub';
const handlers=new Map();
const emit=(name,...args)=>handlers.get(name)?.forEach(fn=>fn(...args));
window.messages=[];window.tracks=[];window.logs=[];
window.api={platform:'darwin',dbgLog(message){window.logs.push(message)},on(name,fn){if(!handlers.has(name))handlers.set(name,new Set());handlers.get(name).add(fn);return()=>handlers.get(name).delete(fn)},
 sendToPresentation(name,...args){window.messages.push({name,args});emit(name,...args);if(name==='program-scene-update'&&args[0].revision)queueMicrotask(()=>emit('program-scene-applied',{revision:args[0].revision}))},
 sendToControl(name,...args){emit(name,...args)},
 async updateProgramSceneMediaOverlay(){return {success:true}},
 async hideTimerOverlay(){},async showTimerOverlay(){},async updateTimerOverlay(){},
 async updateQrOverlay(){},async getTimerOverlayLayout(){return {x:.9,y:.9,scale:1}},
 async raisePresentationWindow(){},setActiveContentType(){},
 async ensureCameraAccess(){return 'granted'},
 async getWindowDisplayScaleFactor(){return 1},
};
window.alert=message=>{throw new Error(message)};
const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;
const ctx=canvas.getContext('2d');ctx.fillStyle='green';ctx.fillRect(0,0,640,360);
setInterval(()=>ctx.fillRect(0,0,2,2),50);
Object.defineProperty(navigator,'mediaDevices',{value:{
 async getUserMedia(){const stream=canvas.captureStream(10);window.tracks.push(...stream.getTracks());return stream},
 async enumerateDevices(){return [{kind:'videoinput',deviceId:'camera-device',label:'Synthetic camera',groupId:'camera-group',toJSON(){return this}}]},
 addEventListener(){},removeEventListener(){}
}});
const capture={sourceId:'camera',captureKind:'device',videoDeviceId:'camera-device',videoLabel:'Synthetic camera',audioEnabled:false};
const state=useAppStore.getState();
window.cameraEntry={id:'camera',type:'capture',name:'Camera',path:'capture://camera',extension:'',size:0,sceneOnly:true,capture};
useAppStore.setState({captureSources:[window.cameraEntry],
 programScene:{...state.programScene,enabled:true,captureSourceId:'camera'},
 timerDuration:0,timerRemaining:0,timerRunning:false,backdropImage:null,
 activeFile:null,selectedFile:null,selectedChannel:null,liveChannel:null,
 channels:{},channelIds:[],displays:[],displayAssignments:{},selectedDisplayId:null,
 programSnapshot:null,programOutputStatus:{desiredRevision:0,confirmedRevision:0,phase:'idle',error:null}});
useAppStore.getState().publishProgramSnapshot(null);
Object.defineProperty(window,'scene',{get:()=>useAppStore.getState()});
window.patch=patch=>useAppStore.setState(patch);
window.emit=emit;
function Output(){
 const snapshot=useAppStore(s=>s.programSnapshot);
 const source=snapshot?.scene.captureSourceId??null;
 return <CaptureHub activeSourceId={null} audioSourceId={null} sceneSourceId={source}
 sceneChromaKey={useAppStore.getState().programScene.chromaKey} takeRequest={null} onTakeReady={()=>{}} onTakeError={()=>{}}/>;
}
const root=createRoot(document.getElementById('root'));
root.render(<><ProgramSceneBridge/><Output/><ProgramSceneModal onClose={()=>{}}/></>);
window.unmount=()=>root.unmount();
` }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
 outfile: resolve(directory,'render.js'), plugins: [{name:'isolate-office',setup(build){
 build.onResolve({filter: /(?:\/PreviewPanel|\/QrOverlayModal|\/BroadcastTitles)$/},args=>({path:args.path,namespace:'stub'}));
 build.onLoad({filter:/.*/,namespace:'stub'},args=>({contents:args.path.endsWith('/PreviewPanel')?'export const SlideRenderer=()=>null':args.path.endsWith('/QrOverlayModal')?'export const QrOverlayModal=()=>null; export const publishQrOverlay=async()=>{}':'export const BroadcastTitlesModal=()=>null',loader:'js'}));
 }}] })
writeFileSync(resolve(directory,'index.html'),'<!doctype html><html><body><div id="root"></div><script src="render.js"></script></body></html>')
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL
const child=spawn(electron,['scripts/test-mac-scene-camera.cjs'],{env,stdio:'inherit'})
child.on('exit',code=>{process.exitCode=code??1})
child.on('error',error=>{console.error(error);process.exitCode=1})
