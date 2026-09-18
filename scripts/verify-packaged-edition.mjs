import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { getCurrentFuseWire, FuseV1Options, FuseState } from '@electron/fuses'
import { extractFile, listPackage } from '@electron/asar'

const require = createRequire(import.meta.url)
const { editionInfo } = require('../build/editions.cjs')
const info = editionInfo(process.argv[2])
const root = resolve(`dist/${info.edition}/win-unpacked`)
const archive = join(root, 'resources/app.asar')
const pkg = JSON.parse(extractFile(archive, 'package.json').toString())
assert.equal(pkg.version, info.version)
assert.equal(pkg.name, info.name)
assert.equal(pkg.main, './out/main/index.js')
const main = extractFile(archive, join('out', 'main', 'index.js')).toString()
assert.equal(main.includes('stream-start'), info.stream)
assert.ok(main.includes(info.displayVersion))
assert.equal(existsSync(join(root, 'resources/ffmpeg/ffmpeg.exe')), info.stream)
for (const name of ['PDMVirtualCameraHost.exe', 'PDMVirtualCameraSource.dll']) {
  assert.ok(existsSync(join(root, 'resources/virtual-camera', name)), `Missing virtual camera resource: ${name}`)
}
assert.ok(existsSync(join(root, 'resources/licenses/Microsoft-Windows-Camera-LICENSE.txt')), 'Missing Microsoft Windows-Camera license')
const files = listPackage(archive).map((name) => name.replaceAll('\\', '/'))
assert.equal(files.includes('/out/renderer/streaming.html'), info.stream)
assert.ok(!files.some((name) => /\.(?:pdmconfig|log|enc)$/.test(name) || /^\/(?:tmp|outputs|\.git|\.env)(?:\/|$)/.test(name)), 'no local operator data in package')
if (info.stream) {
  for (const name of ['ffmpeg.exe.LICENSE', 'ffmpeg.exe.README', 'LICENSE']) {
    assert.ok(existsSync(join(root, 'resources/ffmpeg', name)), `Missing FFmpeg notice: ${name}`)
  }
}
const fuses = await getCurrentFuseWire(join(root, `${info.productName}.exe`))
for (const [key, enabled] of Object.entries({
  RunAsNode: false, EnableCookieEncryption: true,
  EnableNodeOptionsEnvironmentVariable: false, EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true, OnlyLoadAppFromAsar: true,
  LoadBrowserProcessSpecificV8Snapshot: false, GrantFileProtocolExtraPrivileges: true,
  WasmTrapHandlers: true
})) assert.equal(fuses[FuseV1Options[key]], enabled ? FuseState.ENABLE : FuseState.DISABLE, key)
console.log(`Packaged edition verified: ${info.displayVersion}; metadata, resources, privacy exclusions and all Electron fuses OK`)
