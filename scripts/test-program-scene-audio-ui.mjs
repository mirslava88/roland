// Render only the PiP settings component with fake sources. No real camera,
// microphone, PDM session or Office process is opened by this test.
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { writeFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import electron from 'electron'

const require = createRequire(import.meta.url)
const stubStore = `
const capture = { sourceId: 'camera', captureKind: 'device', videoDeviceId: 'video', videoLabel: 'Test camera', audioEnabled: false };
const state = { programScene: { enabled: false, captureSourceId: 'camera', placement: 'right-center', participantSize: 'medium', participantScale: 1, cornerStyle: 'sharp', transitionEffect: 'smooth', viewMode: 'both', audio: { enabled: true, deviceId: 'input', groupId: 'group', label: 'Camera audio input' } }, qrOverlay: {enabled:false,contentType:'url',url:'',wifiSsid:'',wifiPassword:'',wifiSecurity:'WPA',wifiHidden:false,imagePath:null,moduleStyle:'square',cornerStyle:'sharp',color:'#000000',logoPath:null,description:'',descriptionColor:'#ffffff',descriptionBackgroundColor:'#030712',descriptionBackgroundAuto:false,descriptionTextAutoContrast:true,descriptionBackgroundTransparent:false,descriptionFontScale:1,descriptionWidthPercent:65,descriptionSide:'right',sizePercent:24,xPercent:84,yPercent:80}, captureSources: [{ id: 'camera', capture }], backdropImage: null, activeFile: null, selectedFile: null, selectedChannel: null, selectedDisplayId:null, displays:[], channels: {}, channelIds:[], pptxSlidesMap:{}, pptxThumbnailsMap: {}, setProgramScene() {}, setQrOverlay() {}, addCaptureSource() {} };
export const useAppStore = Object.assign((select) => select(state), {getState: () => state});
`
await build({ stdin: { contents: `
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProgramSceneModal } from './src/renderer/src/components/ProgramScene/ProgramSceneModal';
export const markup = renderToStaticMarkup(React.createElement(ProgramSceneModal, {onClose() {}}));
`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic',
  external: ['react', 'react-dom/server'], outfile: 'tmp/pip-audio-ui/render.cjs', plugins: [{ name: 'fake-preview', setup(build) {
    build.onResolve({ filter: /(?:stores\/useAppStore|CaptureThumbnail|PreviewPanel|QrOverlayModal|BroadcastTitles)$/ }, (args) => ({ path: args.path, namespace: 'fake' }))
    build.onLoad({ filter: /.*/, namespace: 'fake' }, (args) => ({ contents: args.path.includes('useAppStore') ? stubStore
      : args.path.includes('CaptureThumbnail') ? 'export const CaptureThumbnail = () => null'
      : args.path.includes('QrOverlayModal') ? 'export const QrOverlayModal = () => null; export const publishQrOverlay = async () => {}'
      : args.path.includes('BroadcastTitles') ? 'export const BroadcastTitlesModal = () => null'
      : 'export const SlideRenderer = () => null', loader: 'js' }))
  } }] })
const { markup } = require(resolve('tmp/pip-audio-ui/render.cjs'))
const css = readdirSync('out/stream/renderer/assets').find((name) => name.endsWith('.css'))
if (!css) throw new Error('Run npm run build:stream first.')
writeFileSync('tmp/pip-audio-ui/index.html', `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(resolve('out/stream/renderer/assets', css))}"></head><body>${markup}</body></html>`)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
const child = spawn(electron, ['scripts/test-program-scene-audio-ui.cjs'], { env, windowsHide: true, stdio: 'inherit' })
child.on('exit', (code) => { process.exitCode = code ?? 1 })
child.on('error', (error) => { console.error(error.message); process.exitCode = 1 })
