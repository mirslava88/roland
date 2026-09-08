import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const require = createRequire(import.meta.url)
const { editionInfo } = require('../build/editions.cjs')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [edition, action = 'build', platform = 'win'] = process.argv.slice(2)
const info = editionInfo(edition)
if (!['build', 'package', 'dir'].includes(action)) throw new Error(`Unknown action: ${action}`)
if (!['win', 'mac', 'linux'].includes(platform)) throw new Error(`Unknown platform: ${platform}`)
if (info.stream && platform !== 'win') throw new Error('Stream edition currently supports Windows only.')
const env = { ...process.env, PDM_EDITION: info.edition, PDM_EDITION_BUILD: '1' }
function run(script, args) {
  const result = spawnSync(process.execPath, [resolve(root, script), ...args], { cwd: root, env, stdio: 'inherit', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status || 1)
}
console.log(`Building ${info.productName} ${info.displayVersion}`)
run('node_modules/electron-vite/bin/electron-vite.js', ['build'])
run('scripts/verify-edition.mjs', [info.edition])
if (action !== 'build') {
  run('node_modules/electron-builder/cli.js', [`--${platform}`, ...(action === 'dir' ? ['--dir'] : []), '--config', 'build/edition-builder.cjs', '--publish', 'never'])
  if (platform === 'win') run('scripts/verify-packaged-edition.mjs', [info.edition])
}
