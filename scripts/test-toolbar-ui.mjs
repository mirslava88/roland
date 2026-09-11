// Real operator controls + real Zustand store; fake IPC, separate Electron
// profile, no cameras, Office, audio playback or network connections.
import { build } from 'esbuild'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import electron from 'electron'

const compiled = await build({entryPoints:['src/shared/toolbar.ts'],bundle:true,platform:'node',format:'esm',write:false})
const { normalizeToolbarVisibility, readToolbarVisibility, TOOLBAR_ITEMS } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`)
for (const invalid of [null, [], 'bad', {video:0, timer:'false', settings:false}]) {
  assert.ok(Object.values(normalizeToolbarVisibility(invalid)).every(Boolean))
}
assert.equal(normalizeToolbarVisibility({video:false}).video, false)
assert.equal(normalizeToolbarVisibility({video:false}).timer, true)
assert.equal(normalizeToolbarVisibility({output:false}).output, true)
assert.equal(normalizeToolbarVisibility({pip:false,pipViews:true}).pipViews, false)
assert.equal(normalizeToolbarVisibility({pip:true,pipViews:false}).pipViews, true)
assert.equal('settings' in normalizeToolbarVisibility({settings:false}), false)
assert.deepEqual(readToolbarVisibility({getItem(){throw Error('blocked')}}), normalizeToolbarVisibility())
assert.deepEqual(readToolbarVisibility({getItem(){return '{invalid'}}), normalizeToolbarVisibility())
assert.equal(TOOLBAR_ITEMS.length, new Set(TOOLBAR_ITEMS.map(item=>item.id)).size)

const operatorCss = readFileSync('src/renderer/src/assets/index.css', 'utf8')
for (const label of ['PROGRAM', 'TOOLS', 'ON AIR', '  // MEDIA POOL', '  // MULTIVIEW', '  // RUNDOWN', 'IN', 'PGM', 'PVW', 'TRANSPORT']) {
  assert.ok(!operatorCss.includes(`content: '${label}'`), `Broadcast Pro decoration ${label} must not be shown`)
}
assert.match(operatorCss, /\.pdm-channel-card\s*\{[^}]*isolation:\s*isolate;/s)
assert.ok(!readFileSync('src/renderer/src/components/BroadcastTitles/BroadcastTitles.tsx', 'utf8').includes('>LIVE</div>'))

const directory = resolve('tmp/toolbar-ui')
mkdirSync(directory, {recursive:true})
for (const stream of [true,false]) {
  const edition = stream ? 'stream' : 'standard'
  await build({stdin:{contents:`
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Toolbar } from './src/renderer/src/components/Controls/Toolbar';
import { useAppStore } from './src/renderer/src/stores/useAppStore';
import { DEFAULT_STREAM_SETTINGS } from './src/shared/streaming';
window.testStore = useAppStore;
window.testCalls = [];
window.testErrors = [];
window.addEventListener('error', event => window.testErrors.push(String(event.error || event.message)));
window.addEventListener('unhandledrejection', event => window.testErrors.push(String(event.reason)));
const listeners = new Map();
window.testEmit = (event, data) => listeners.get(event)?.forEach(fn => fn(data));
window.testListenerCount = event => listeners.get(event)?.size || 0;
const call = (name, result) => (...args) => { window.testCalls.push(name); return Promise.resolve(result); };
window.api = {
  dbgLog() {}, on(event,fn) {if (!listeners.has(event)) listeners.set(event,new Set()); listeners.get(event).add(fn); return () => listeners.get(event).delete(fn);},
  updateTimerOverlay:call('timer-update'), showTimerOverlay:call('timer-show'), hideTimerOverlay:call('timer-hide'),
  sendToPresentation:call('presentation-message'),
  musicGetState:call('music-status',{playing:true,currentIndex:0,currentTime:10,duration:100,volume:1,trackName:'Test music',loopTrack:false}),
  getAudioDevices:call('audio-devices',[]), getAppVersion:call('version','1.1.5 test'),
  streaming:{load:call('stream-load',{settings:DEFAULT_STREAM_SETTINGS,available:true,canSave:true}),status:call('stream-status',{phase:'running',destinations:[]}),start:call('stream-start'),stop:call('stream-stop')}
};
window.setTestBusy = busy => {
  const state = useAppStore.getState();
  useAppStore.setState({
    musicPlaylist:busy?['test.mp3']:[],videoPlaylist:busy?['test.mp4']:[],videoCurrentIndex:0,
    activeFile:busy?{id:'test',path:'test.mp4',name:'Test video',type:'video',extension:'.mp4',size:0}:null,
    videoIsPlaying:busy,isPresentationWindowOpen:busy,
    backdropImage:busy?'test-background':null,
    programScene:{...state.programScene,enabled:busy,viewMode:'both'},
    qrOverlay:{...state.qrOverlay,enabled:busy},
    timerDuration:busy?150:0,timerRemaining:150,timerRunning:false
  });
};
function TestApp(){const theme=useAppStore(s=>s.appTheme);return <div className={'pdm-operator-shell dark h-screen flex flex-col theme-'+theme}><Toolbar/><main className="relative flex-1 p-6 text-gray-400">Тест панели PDM — без подключения устройств и эфира<div data-layer-probe className="pdm-channel-card is-live" style={{position:'fixed',left:420,top:240,width:440,height:260}}><button data-layer-probe-zoom type="button" style={{position:'absolute',inset:0,zIndex:20}}>🔍 Лупа</button></div></main></div>}
createRoot(document.getElementById('root')).render(<TestApp/>);
`,loader:'tsx',resolveDir:process.cwd()},bundle:true,platform:'browser',format:'iife',jsx:'automatic',
    define:{__PDM_STREAM_ENABLED__:String(stream),'import.meta.url':JSON.stringify(pathToFileURL(resolve(directory,'index.html')).href)},
    outfile:resolve(directory,edition+'.js'),plugins:[{name:'no-output',setup(build){
      build.onResolve({filter:/(?:\/app-config|\/ProgramSceneModal|\/QrOverlayModal|\/AuxiliaryDisplaysModal)$/}, args=>({path:args.path.split('/').pop(),namespace:'fake'}))
      build.onLoad({filter:/.*/,namespace:'fake'},args=>({contents:args.path==='app-config'?'export const loadAppConfigFromFile = async () => ({}); export const saveCurrentAppConfig = async () => ({});':`export const ${args.path} = () => null`,loader:'js'}))
    }}]})
  const assets = resolve('out/stream/renderer/assets')
  const css = readdirSync(assets).find(name=>name.endsWith('.css'))
  if (!css) throw Error('Build stream edition first')
  writeFileSync(resolve(directory,edition+'.html'),`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(resolve(assets,css))}"></head><body><div id="root"></div><script src="${edition}.js"></script></body></html>`)
}
const env={...process.env}; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
const child=spawn(electron,['scripts/test-toolbar-ui.cjs'],{env,windowsHide:true,stdio:'inherit'})
child.on('exit',code=>{process.exitCode=code??1}); child.on('error',error=>{console.error(error);process.exitCode=1})
