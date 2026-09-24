import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import electron from 'electron'

const directory = resolve('tmp/virtual-camera-frame-test')
mkdirSync(directory, { recursive: true })
await build({
  stdin: { contents: `
import { app, nativeImage } from 'electron';
import assert from 'node:assert/strict';
import { fitNativeImageToVirtualCameraFrame, calculateContainRect, VIRTUAL_CAMERA_FRAME_BYTES } from './src/main/virtual-camera-frame';
app.whenReady().then(() => {
  const pixel = (frame, x, y) => Array.from(frame.subarray((y * 1920 + x) * 4, (y * 1920 + x) * 4 + 4));
  for (const [width, height] of [[1920,1080], [640,360], [540,960], [1024,768], [1920,800]]) {
    const bitmap = Buffer.alloc(width * height * 4);
    // Asymmetric colored halves catch accidental horizontal mirroring too.
    for (let y=0; y<height; y++) for (let x=0; x<width; x++) {
      const offset = (y * width + x) * 4;
      bitmap[offset + (x < width/2 ? 2 : 0)] = 255;
      bitmap[offset+3] = 255;
    }
    const image = nativeImage.createFromBitmap(bitmap, { width, height });
    const frame = fitNativeImageToVirtualCameraFrame(image);
    const r = calculateContainRect(width, height);
    assert.equal(frame.length, VIRTUAL_CAMERA_FRAME_BYTES);
    assert.deepEqual(pixel(frame, r.x+Math.floor(r.width/4), r.y+Math.floor(r.height/2)), [0,0,255,255]);
    assert.deepEqual(pixel(frame, r.x+Math.floor(3*r.width/4), r.y+Math.floor(r.height/2)), [255,0,0,255]);
    if (r.x > 0) assert.deepEqual(pixel(frame, r.x-1, 540), [0,0,0,255]);
    if (r.y > 0) assert.deepEqual(pixel(frame, 960, r.y-1), [0,0,0,255]);
    assert.ok(Math.abs(r.width/r.height-width/height) < 0.002, 'aspect ratio must be preserved');
  }
  assert.throws(() => fitNativeImageToVirtualCameraFrame(nativeImage.createEmpty()), /Пустой кадр/);
  assert.throws(() => calculateContainRect(0, 1080), /Некорректный размер/);
  console.log('PASS: real Electron BGRA frames, 1080p/upscaling/portrait/4:3/ultrawide, proportions, padding, orientation and empty-frame rejection');
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
`, loader: 'ts', resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'cjs', external: ['electron'], outfile: resolve(directory, 'test.cjs')
})
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
const child = spawn(electron, [resolve(directory, 'test.cjs')], { env, windowsHide: true, stdio: 'inherit' })
const timeout = setTimeout(() => { console.error('Frame test timed out'); child.kill(); process.exitCode = 1 }, 30000)
child.on('exit', code => { clearTimeout(timeout); process.exitCode ||= code ?? 1 })
child.on('error', error => { clearTimeout(timeout); console.error(error); process.exitCode = 1 })
