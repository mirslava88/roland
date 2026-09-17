import { build } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import electron from 'electron'
const compiled = await build({entryPoints:['src/renderer/src/components/Onboarding/training-model.ts'],bundle:true,platform:'node',format:'esm',write:false})
const model = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)
assert.equal(model.readIntroduction({getItem(){throw Error('blocked')}}).status,'new')
for(const raw of ['null','{}','{bad','{"status":"paused","step":-2}','{"status":"paused","step":400}']){
 const p=model.readIntroduction({getItem:()=>raw});assert.ok(p.step>=0&&p.step<=30)
}
const runtime=readFileSync('src/renderer/src/components/Onboarding/training-runtime.ts','utf8')
assert.ok(!runtime.includes('window.parent.api') && !runtime.includes('ipcRenderer'))
assert.match(runtime,/Object.defineProperty\(window, 'localStorage'/)
assert.match(runtime,/if \(window.api\) throw/)
const appSource=readFileSync('src/renderer/src/App.tsx','utf8')
assert.match(appSource,/return training \? workspace : <Introduction>/,'Reuse the actual operator UI, never a lookalike')
const directory=resolve('tmp/onboarding-ui');mkdirSync(directory,{recursive:true})
const renderer=resolve(process.env.PDM_ONBOARDING_RENDERER || 'out/stream/renderer')
const trainingHtml=readFileSync(resolve(renderer,'training.html'),'utf8').replaceAll('./assets/',pathToFileURL(resolve(renderer,'assets')).href+'/')
writeFileSync(resolve(directory,'training.html'),trainingHtml)
await build({stdin:{contents:`
import React from 'react';import {createRoot} from 'react-dom/client';
import {Introduction} from './src/renderer/src/components/Onboarding/Introduction';
import {SettingsModal} from './src/renderer/src/components/Controls/SettingsModal';
import {useAppStore} from './src/renderer/src/stores/useAppStore';
import {openIntroduction,ONBOARDING_KEY} from './src/renderer/src/components/Onboarding/training-model';
window.testErrors=[];window.testCalls=[];
window.addEventListener('error',e=>window.testErrors.push(String(e.error||e.message)));
window.addEventListener('unhandledrejection',e=>window.testErrors.push(String(e.reason)));
window.api=new Proxy({}, {get:(_,name)=>(...args)=>{window.testCalls.push(String(name));if(name==='getAudioDevices')return Promise.resolve([]);if(name==='getAppVersion')return Promise.resolve('test');throw Error('Forbidden real IPC: '+String(name));}});
window.testStore=useAppStore;window.testKey=ONBOARDING_KEY;window.openIntroduction=openIntroduction;
function TestApp(){const [settings,setSettings]=React.useState(false);return <Introduction><main><button id="real-button" onClick={()=>setSettings(true)}>Настройки</button>{settings&&<SettingsModal onClose={()=>setSettings(false)}/>}</main></Introduction>}
createRoot(document.getElementById('root')).render(<TestApp/>);
`,loader:'tsx',resolveDir:process.cwd()},bundle:true,platform:'browser',format:'iife',jsx:'automatic',outfile:resolve(directory,'index.js'),define:{__PDM_STREAM_ENABLED__:'true'},plugins:[{name:'no-config',setup(build){
 build.onResolve({filter:new RegExp('app-config$')},()=>({path:'config',namespace:'fake'}));build.onLoad({filter:/.*/,namespace:'fake'},()=>({contents:'export const loadAppConfigFromFile=async()=>({});export const saveCurrentAppConfig=async()=>({});',loader:'js'}))
}}]})
writeFileSync(resolve(directory,'index.html'),'<!doctype html><html lang="ru"><head><meta charset="utf-8"><link rel="stylesheet" href="index.css"><style>html,body,#root{margin:0;height:100%;font-family:Segoe UI,Arial}*{box-sizing:border-box}</style></head><body><div id="root"></div><script src="index.js"></script></body></html>')
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_RENDERER_URL
const child=spawn(electron,['scripts/test-onboarding-ui.cjs'],{env,windowsHide:true,stdio:'inherit'})
child.on('exit',code=>{process.exitCode=code??1});child.on('error',error=>{console.error(error);process.exitCode=1})
