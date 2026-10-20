// Exercise the real startup guide without changing any macOS privacy settings.
import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import electron from 'electron'

const directory = resolve('tmp/mac-setup-ui')
mkdirSync(directory, { recursive: true })
await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {MacSetupGate} from './src/renderer/src/components/Onboarding/MacSetupGate';
import {Introduction} from './src/renderer/src/components/Onboarding/Introduction';
import {useAppStore} from './src/renderer/src/stores/useAppStore';
import {requireMacPresentationSupport} from './src/renderer/src/mac-presentation-support';
const query=new URLSearchParams(location.search);
localStorage.setItem('pdm-introduction-v5',JSON.stringify({status:query.has('intro')?'new':'completed',step:0}));
window.fixture={screen:query.has('screen')?'denied':'granted',accessibility:!query.has('accessibility'),installed:!query.has('keynote'),opened:[],downloads:0,reveals:0,restarts:0,reads:0,errors:[]};
window.addEventListener('error',event=>window.fixture.errors.push(String(event.error||event.message)));
window.addEventListener('unhandledrejection',event=>window.fixture.errors.push(String(event.reason)));
window.api={platform:query.has('windows')?'win32':'darwin',macSetup:{
 async permissions(){window.fixture.reads++;if(window.fixture.failure)throw Error('Status unavailable');return {screen:window.fixture.screen,accessibility:window.fixture.accessibility}},
 async openPrivacy(permission){window.fixture.opened.push(permission)},
 async presentationSupport(){return {installed:window.fixture.installed}},
 async openKeynoteDownload(){window.fixture.downloads++},async showApplication(){window.fixture.reveals++},async restart(){window.fixture.restarts++}
}};
useAppStore.setState({selectedFile:null,selectedChannel:null,channels:{},channelIds:[]});
window.selectPptx=()=>useAppStore.setState({selectedFile:{id:'pptx',path:'test.pptx',name:'Test',type:'presentation',extension:'.pptx',size:1}});
window.tryPptx=requireMacPresentationSupport;
const root=createRoot(document.getElementById('root'));
root.render(<MacSetupGate><Introduction><main><button id="workspace">Рабочие каналы</button></main></Introduction></MacSetupGate>);
window.unmount=()=>root.unmount();
` }, bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
  define: { __PDM_PRODUCT_NAME__: JSON.stringify('Presentation Display Manager Stream') }, outfile: resolve(directory, 'render.js') })
writeFileSync(resolve(directory, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="render.css"><style>html,body,#root{margin:0;height:100%;font-family:system-ui}*{box-sizing:border-box}</style></head><body><div id="root"></div><script src="render.js"></script></body></html>')
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
const child = spawn(electron, ['scripts/test-mac-setup-ui.cjs'], { env, stdio: 'inherit' })
child.on('exit', code => { process.exitCode = code ?? 1 })
child.on('error', error => { console.error(error); process.exitCode = 1 })
