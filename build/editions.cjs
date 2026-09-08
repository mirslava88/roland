const { resolve } = require('node:path')
const pkg = require('../package.json')

function editionInfo(edition = process.env.PDM_EDITION || (pkg.version.endsWith('-stream') ? 'stream' : 'standard')) {
  if (!['standard', 'stream'].includes(edition)) throw new Error(`Unknown PDM edition: ${edition}`)
  const stream = edition === 'stream'
  const baseVersion = pkg.version.replace(/-stream$/, '')
  const version = `${baseVersion}${stream ? '-stream' : ''}`
  const name = `presentation-display-manager${stream ? '-stream' : ''}`
  const productName = `Presentation Display Manager${stream ? ' Stream' : ''}`
  return { edition, stream, version, name, productName,
    displayVersion: `${baseVersion}${stream ? ' stream' : ''}`,
    appId: `com.roland.presentation-display-manager${stream ? '.stream' : ''}` }
}

function builderConfig(edition) {
  const info = editionInfo(edition)
  return {
    ...pkg.build,
    extends: null,
    appId: info.appId,
    productName: info.productName,
    artifactName: `PDM${info.stream ? '-Stream' : ''}-Setup-${info.version}.\${ext}`,
    directories: { ...pkg.build.directories, output: `dist/${info.edition}` },
    extraMetadata: { name: info.name, version: info.version, main: './out/main/index.js' },
    files: ['package.json', { from: `out/${info.edition}`, to: 'out', filter: ['**/*', '!**/*.map', '!**/streaming-*.cjs'] }],
    extraResources: pkg.build.extraResources.filter((resource) => info.stream || resource.to !== 'ffmpeg'),
    nsis: { ...pkg.build.nsis, shortcutName: info.productName },
    afterPack: resolve(__dirname, 'afterPack.js')
  }
}

module.exports = { editionInfo, builderConfig }
