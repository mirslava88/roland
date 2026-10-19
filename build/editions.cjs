const { resolve } = require('node:path')
const pkg = require('../package.json')

function editionInfo(edition = process.env.PDM_EDITION || (pkg.version.endsWith('-stream') ? 'stream' : 'standard'), platform = process.platform) {
  if (!['standard', 'stream'].includes(edition)) throw new Error(`Unknown PDM edition: ${edition}`)
  const stream = edition === 'stream'
  const baseVersion = platform === 'darwin'
    ? (require('./mac-runtime.json').appVersion || pkg.version.replace(/-stream$/, ''))
    : pkg.version.replace(/-stream$/, '')
  const version = `${baseVersion}${stream ? '-stream' : ''}`
  const name = `presentation-display-manager${stream ? '-stream' : ''}`
  const productName = `Presentation Display Manager${stream ? ' Stream' : ''}`
  return { edition, stream, version, name, productName,
    displayVersion: `${baseVersion}${stream ? ' stream' : ''}`,
    appId: `com.roland.presentation-display-manager${stream ? '.stream' : ''}` }
}

function builderConfig(edition, platform = process.platform) {
  const info = editionInfo(edition, platform)
  const windowsResource = new Set(['virtual-camera', 'pdm-launcher-v1.ico', 'licenses/Microsoft-Windows-Camera-LICENSE.txt'])
  return {
    ...pkg.build,
    ...(platform === 'darwin' ? { electronVersion: require('./mac-runtime.json').electronVersion } : {}),
    ...(platform === 'darwin' && process.env.PDM_MAC_ELECTRON_CACHE
      ? { electronDownload: { cache: resolve(process.env.PDM_MAC_ELECTRON_CACHE) } } : {}),
    extends: null,
    appId: info.appId,
    productName: info.productName,
    artifactName: platform === 'darwin'
      ? `PDM${info.stream ? '-Stream' : ''}-${info.version}-mac-\${arch}.\${ext}`
      : `PDM${info.stream ? '-Stream' : ''}-Setup-${info.version}.\${ext}`,
    directories: { ...pkg.build.directories, output: `dist/${info.edition}` },
    extraMetadata: { name: info.name, version: info.version, main: './out/main/index.js' },
    files: ['package.json', { from: `out/${info.edition}`, to: 'out', filter: ['**/*', '!**/*.map', '!**/streaming-*.cjs'] }],
    extraResources: [
      ...pkg.build.extraResources.filter((resource) =>
        (info.stream || resource.to !== 'ffmpeg') &&
        (platform === 'win32' || !windowsResource.has(resource.to)) &&
        (platform !== 'darwin' || resource.to !== 'ffmpeg')
      ),
      ...(platform === 'darwin' ? [
        { from: 'build/mac-pdf-pages', to: 'mac-pdf-pages' },
        { from: 'build/mac-keynote-backdrop', to: 'mac-keynote-backdrop' },
        { from: 'build/mac-audio-control', to: 'mac-audio-control' },
        { from: 'build/mac-display-control', to: 'mac-display-control' },
        { from: 'build/mac-doc-preview', to: 'mac-doc-preview' },
        { from: 'build/mac-office-accessibility.node', to: 'mac-office-accessibility.node' },
        { from: 'build/mac-render-display', to: 'mac-render-display' },
        { from: 'build/mac-stream-capture', to: 'mac-stream-capture' },
        { from: 'build/mac-virtual-camera/mac-camera-writer', to: 'mac-virtual-camera/mac-camera-writer' },
        { from: 'build/mac-virtual-camera/PDM Camera Installer.app', to: 'mac-virtual-camera/PDM Camera Installer.app' },
        ...(info.stream ? [
          { from: 'build/mac-ffmpeg', to: 'ffmpeg/ffmpeg' },
          { from: 'node_modules/ffmpeg-static/LICENSE', to: 'ffmpeg/ffmpeg.LICENSE' }
        ] : [])
      ] : [])
    ],
    mac: {
      ...pkg.build.mac,
      icon: 'build/icon.png',
      identity: process.env.PDM_MAC_SIGN_IDENTITY || '-',
      hardenedRuntime: true,
      entitlements: 'build/entitlements.mac.plist',
      entitlementsInherit: 'build/entitlements.mac.inherit.plist',
      signIgnore: ['mac-virtual-camera/PDM Camera Installer.app', '\\.pak$'],
      target: [{ target: 'dmg', arch: ['x64', 'arm64'] }],
      extendInfo: {
        NSAppleEventsUsageDescription: 'Presentation Display Manager управляет показом PowerPoint, Keynote и выбранных документов Word и Excel.',
        NSScreenCaptureDescription: 'Presentation Display Manager захватывает выбранные окна и экраны для эфира.',
        NSCameraUsageDescription: 'Presentation Display Manager показывает выбранную камеру в эфире.',
        NSMicrophoneUsageDescription: 'Presentation Display Manager воспроизводит звук выбранного источника.',
        NSAudioCaptureUsageDescription: 'Presentation Display Manager передаёт выбранный системный звук в трансляцию.',
        NSDocumentsFolderUsageDescription: 'Presentation Display Manager открывает выбранные презентации и медиафайлы из папки Документы.'
      }
    },
    nsis: { ...pkg.build.nsis, shortcutName: info.productName },
    afterPack: resolve(__dirname, platform === 'darwin' ? 'afterPack-mac.cjs' : 'afterPack.js')
  }
}

module.exports = { editionInfo, builderConfig }
