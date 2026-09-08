import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import electron from 'electron'
await build({ entryPoints: ['scripts/test-streaming-latency.cjs'], bundle: true, platform: 'node', format: 'cjs',
  external: ['electron'], outfile: 'out/main/streaming-latency.cjs' })
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
const child = spawn(electron, ['out/main/streaming-latency.cjs'], { env, windowsHide: true, stdio: 'inherit' })
child.on('exit', (code) => { process.exitCode = code ?? 1 })
child.on('error', (error) => { console.error(error.message); process.exitCode = 1 })
