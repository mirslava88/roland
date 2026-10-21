// Real React panel in an isolated Electron window; no PDM IPC or hardware.
import { build } from 'esbuild'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import electron from 'electron'

const directory = resolve('tmp/library-resize-ui')
mkdirSync(directory, { recursive: true })
await build({
  stdin: {
    contents: `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ResizableFileLibrary } from './src/renderer/src/components/Library/ResizableFileLibrary';
window.testErrors=[];
window.addEventListener('error', event=>window.testErrors.push(String(event.error||event.message)));
function TestApp(){return <div className="pdm-operator-shell theme-broadcast-pro dark h-screen flex flex-col"><div className="pdm-main-workspace flex flex-1 overflow-hidden"><ResizableFileLibrary><div className="pdm-library flex flex-col">Материалы</div></ResizableFileLibrary><div className="pdm-stage flex-1">Рабочая область</div></div></div>}
createRoot(document.getElementById('root')).render(<TestApp/>);
`,
    loader: 'tsx',
    resolveDir: process.cwd()
  },
  bundle: true,
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
  outfile: resolve(directory, 'test.js')
})
const assets = resolve('out/stream/renderer/assets')
const css = readdirSync(assets).find(name => name.startsWith('index-') && name.endsWith('.css'))
if (!css) throw new Error('Build Stream edition before library resize UI test')
writeFileSync(resolve(directory, 'test.html'), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(resolve(assets, css))}"></head><body><div id="root"></div><script src="test.js"></script></body></html>`)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
const child = spawn(electron, ['scripts/test-library-resize.cjs'], { env, windowsHide: true, stdio: 'inherit' })
child.on('exit', code => { process.exitCode = code ?? 1 })
child.on('error', error => { console.error(error); process.exitCode = 1 })
