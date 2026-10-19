import { spawnSync, execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, copyFileSync, existsSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'

if (process.platform !== 'darwin') process.exit(0)
const root = resolve('build/mac-virtual-camera')
const identity = process.env.PDM_MAC_SIGN_IDENTITY || '-'
let team = process.env.PDM_MAC_TEAM_ID || 'PDMLOCAL'
if (identity !== '-' && !process.env.PDM_MAC_TEAM_ID) {
  const certificate = execFileSync('security', ['find-certificate', '-c', identity, '-p'])
  const subject = execFileSync('openssl', ['x509', '-noout', '-subject', '-nameopt', 'RFC2253'], { input: certificate }).toString()
  team = /(?:^|,)OU=([A-Z0-9]+)/.exec(subject)?.[1] || team
}
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status || 1)
}
const xml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
function plist(value) {
  function entry(v) {
    if (typeof v === 'boolean') return v ? '<true/>' : '<false/>'
    if (Array.isArray(v)) return `<array>${v.map(entry).join('')}</array>`
    if (typeof v === 'object') return `<dict>${Object.entries(v).map(([k, v]) => `<key>${xml(k)}</key>${entry(v)}`).join('')}</dict>`
    return `<string>${xml(v)}</string>`
  }
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0">${entry(value)}</plist>`
}
mkdirSync(root, { recursive: true })
const installer = join(root, 'PDM Camera Installer.app')
const extension = join(installer, 'Contents/Library/SystemExtensions/com.roland.pdm.camera.extension.systemextension')
for (const name of ['CameraExtension', 'CameraWriter', 'CameraInstaller']) {
  const source = resolve(`native/mac-virtual-camera/${name}.swift`)
  const target = join(root, name)
  if (!existsSync(target) || statSync(target).mtimeMs < statSync(source).mtimeMs) {
    const pieces = []
    for (const arch of ['x86_64', 'arm64']) {
      const piece = `${target}-${arch}`
      run('xcrun', ['swiftc', '-O', '-parse-as-library', '-target', `${arch}-apple-macosx12.3`,
        '-module-cache-path', resolve('build/.swift-module-cache'), source, '-o', piece])
      pieces.push(piece)
    }
    run('xcrun', ['lipo', '-create', ...pieces, '-output', target])
  }
}
function bundle(directory, id, name, executable, extra) {
  mkdirSync(join(directory, 'Contents/MacOS'), { recursive: true })
  writeFileSync(join(directory, 'Contents/Info.plist'), plist({ CFBundleIdentifier: id,
    CFBundleName: name, CFBundleDisplayName: name, CFBundleExecutable: executable,
    CFBundleVersion: '1', CFBundleShortVersionString: '1.0', CFBundlePackageType: directory.endsWith('.app') ? 'APPL' : 'SYSX',
    LSMinimumSystemVersion: '12.3', NSSystemExtensionUsageDescription: 'PDM передаёт изображение эфира в программы видеосвязи как виртуальную камеру.', ...extra }))
}
bundle(extension, 'com.roland.pdm.camera.extension', 'PDM Virtual Camera', 'PDM Camera Extension',
  { CMIOExtension: { CMIOExtensionMachServiceName: `${team}.com.roland.pdm.camera.extension` } })
bundle(installer, 'com.roland.pdm.camera.installer', 'PDM Camera Installer', 'PDM Camera Installer', { LSUIElement: true })
copyFileSync(join(root, 'CameraExtension'), join(extension, 'Contents/MacOS/PDM Camera Extension'))
copyFileSync(join(root, 'CameraInstaller'), join(installer, 'Contents/MacOS/PDM Camera Installer'))
copyFileSync(join(root, 'CameraWriter'), join(root, 'mac-camera-writer'))
if (process.env.PDM_MAC_CAMERA_INSTALLER_PROFILE) copyFileSync(process.env.PDM_MAC_CAMERA_INSTALLER_PROFILE, join(installer, 'Contents/embedded.provisionprofile'))
if (process.env.PDM_MAC_CAMERA_EXTENSION_PROFILE) copyFileSync(process.env.PDM_MAC_CAMERA_EXTENSION_PROFILE, join(extension, 'Contents/embedded.provisionprofile'))
mkdirSync(join(installer, 'Contents/Resources'), { recursive: true })
writeFileSync(join(installer, 'Contents/Resources/pdm-camera-build.json'), JSON.stringify({ bundleId: 'com.roland.pdm.camera.installer', team }))
const extensionEntitlements = join(root, 'extension.entitlements')
const installerEntitlements = join(root, 'installer.entitlements')
writeFileSync(extensionEntitlements, plist({ 'com.apple.security.app-sandbox': true }))
writeFileSync(installerEntitlements, plist({ 'com.apple.developer.system-extension.install': true }))
run('codesign', ['--force', '--sign', identity, '--options', 'runtime', '--entitlements', extensionEntitlements, extension])
run('codesign', ['--force', '--sign', identity, '--options', 'runtime', '--entitlements', installerEntitlements, installer])
run('codesign', ['--force', '--sign', identity, '--options', 'runtime', join(root, 'mac-camera-writer')])
run('codesign', ['--verify', '--deep', '--strict', installer])
if (process.env.PDM_MAC_NOTARY_PROFILE) {
  const archive = join(root, 'PDM-Camera-Installer.zip')
  run('ditto', ['-c', '-k', '--keepParent', installer, archive])
  run('xcrun', ['notarytool', 'submit', archive, '--keychain-profile', process.env.PDM_MAC_NOTARY_PROFILE, '--wait'])
  run('xcrun', ['stapler', 'staple', installer])
}
console.log(`Mac camera extension built for Intel and Apple Silicon; signing identity=${identity}`)
