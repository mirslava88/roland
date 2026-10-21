// Real channel context menu and enlarged PPTX preview; no Office or on-air output.
import { build } from 'esbuild'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import electron from 'electron'

const directory = resolve('tmp/channel-large-preview-ui')
mkdirSync(directory, { recursive: true })
await build({
  stdin: {
    contents: `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ChannelPanel } from './src/renderer/src/components/Preview/PreviewPanel';
import { useAppStore } from './src/renderer/src/stores/useAppStore';
window.testErrors=[];
window.addEventListener('error', event=>window.testErrors.push(String(event.error||event.message)));
window.addEventListener('unhandledrejection', event=>window.testErrors.push(String(event.reason)));
window.api={};
window.testTakeCalls=0;
const frame = color => 'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><rect width="1280" height="720" fill="'+color+'"/></svg>');
window.testFrames=[frame('#ff0000'),frame('#00ff00'),frame('#0000ff')];
window.testThumbnails=[frame('#333333'),frame('#444444'),frame('#555555')];
const state=useAppStore.getState();
window.testChannelId=state.channelIds[0];
const file={id:'large-preview',path:'large-preview.pptx',name:'Большая презентация',type:'presentation',extension:'.pptx',size:1};
const channel={...state.channels[window.testChannelId],file,slide:2,totalSlides:3,caption:'Проверка предпросмотра'};
useAppStore.setState({channels:{...state.channels,[window.testChannelId]:channel},liveChannel:window.testChannelId,pptxSlidesMap:{[file.path]:window.testFrames},pptxThumbnailsMap:{[file.path]:window.testThumbnails}});
window.testStore=useAppStore;
createRoot(document.getElementById('root')).render(<ChannelPanel
  label={window.testChannelId} channel={channel} isLive={true} isSelected={true} isTaking={false}
  openingMessage={null} onDrop={()=>{}} onSlideChange={()=>{}} onSetTotalSlides={()=>{}}
  onVideoEndChannelChange={()=>{}} onCaptionChange={()=>{}} onSelect={()=>{}}
  onTake={()=>{window.testTakeCalls++}} onClear={()=>{}}
  pptxThumbnails={window.testThumbnails} cacheStatus="ready" videoEndChannelOptions={[]} compact={false}
/>);
`,
    loader: 'tsx',
    resolveDir: process.cwd()
  },
  bundle: true,
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
  define: { 'import.meta.url': JSON.stringify(pathToFileURL(resolve(directory, 'test.html')).href) },
  outfile: resolve(directory, 'test.js'),
  plugins: [{ name: 'pdf-worker-stub', setup(esbuild) {
    esbuild.onResolve({ filter: /^pdfjs-dist$/ }, () => ({ path: 'pdfjs-dist', namespace: 'stub' }))
    esbuild.onResolve({ filter: /\/pdfium-renderer$/ }, () => ({ path: 'pdfium-renderer', namespace: 'stub' }))
    esbuild.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
      contents: args.path === 'pdfjs-dist'
        ? 'export const GlobalWorkerOptions={}; export const getDocument=()=>{throw Error("PDF is not used in this preview test")}'
        : 'export const renderPdfiumPageToCanvas=()=>{throw Error("PDF is not used in this preview test")}; export const releasePdfiumResources=()=>{}; export const warmPdfiumDocument=()=>{}',
      loader: 'js'
    }))
  } }]
})
const assets = resolve('out/stream/renderer/assets')
const css = readdirSync(assets).find((name) => name.startsWith('index-') && name.endsWith('.css'))
if (!css) throw new Error('Build Stream edition before channel preview UI test')
writeFileSync(resolve(directory, 'test.html'), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(resolve(assets, css))}"></head><body><div id="root"></div><script src="test.js"></script></body></html>`)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
const child = spawn(electron, ['scripts/test-channel-large-preview.cjs'], { env, windowsHide: true, stdio: 'inherit' })
child.on('exit', (code) => { process.exitCode = code ?? 1 })
child.on('error', (error) => { console.error(error); process.exitCode = 1 })
