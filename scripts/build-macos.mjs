import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { constants, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workspace = join(root, 'tmp/macos-build')
const toolchain = join(root, 'build/macos')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

export function workspacePackage(project, mac) {
  // Metadata and resources follow the project. Dependency resolution is owned
  // by the Mac manifest and lockfile; Windows continues to use the root lock.
  for (const group of ['dependencies', 'devDependencies']) {
    if (JSON.stringify(Object.keys(project[group]).sort()) !== JSON.stringify(Object.keys(mac[group]).sort())) {
      throw new Error(`Update build/macos/package.json: ${group} differs from the project`)
    }
  }
  return { ...project, dependencies: mac.dependencies, devDependencies: mac.devDependencies, overrides: mac.overrides }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: workspace, env: process.env, stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`)
  return result
}

export function requireCleanAudit(result) {
  if (result.error) throw result.error
  let report
  try { report = JSON.parse(result.stdout) } catch { throw new Error('Mac dependency audit did not return valid JSON') }
  if (result.status !== 0 || report.error || report.metadata?.vulnerabilities?.total !== 0) {
    throw new Error(`Mac dependency audit failed: ${JSON.stringify(report.error || report.metadata?.vulnerabilities)}`)
  }
  return report
}

export function acquireWorkspaceLock(directory) {
  mkdirSync(dirname(directory), { recursive: true })
  try { mkdirSync(directory) } catch (error) {
    if (error.code !== 'EEXIST') throw error
    throw new Error(`Another Mac build owns ${directory}. If an interrupted build left this lock, remove it only after that build has stopped.`)
  }
  try { writeFileSync(join(directory, 'owner.json'), JSON.stringify({ pid: process.pid }), { mode: 0o600 }) }
  catch (error) { rmSync(directory, { recursive: true, force: true }); throw error }
  return () => rmSync(directory, { recursive: true, force: true })
}

export function copyMacTree(source, destination, options = {}) {
  cpSync(source, destination, { recursive: true, mode: constants.COPYFILE_FICLONE, ...options, verbatimSymlinks: true })
}

function prepare() {
  mkdirSync(workspace, { recursive: true })
  for (const directory of ['src', 'scripts', 'build', 'native/mac-virtual-camera', '.github/workflows', 'docs/releases']) {
    const target = join(workspace, directory)
    // Clear copied sources so deleted files cannot survive in a release.
    rmSync(target, { recursive: true, force: true })
    copyMacTree(join(root, directory), target, {
      preserveTimestamps: true,
      filter: path => !relative(root, path).split('/').some(part => ['node_modules', '.swift-module-cache', 'certs', '.DS_Store'].includes(part))
    })
  }
  for (const name of ['electron.vite.config.ts', 'tsconfig.json', 'tsconfig.node.json', 'tsconfig.web.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    cpSync(join(root, name), join(workspace, name))
  }
  const project = readJson(join(root, 'package.json'))
  const mac = readJson(join(toolchain, 'package.json'))
  if (mac.devDependencies.electron !== readJson(join(root, 'build/mac-runtime.json')).electronVersion) {
    throw new Error('Mac dependency lock and runtime version must agree')
  }
  writeFileSync(join(workspace, 'package.json'), JSON.stringify(workspacePackage(project, mac), null, 2) + '\n')
  cpSync(join(toolchain, 'package-lock.json'), join(workspace, 'package-lock.json'))
  // No third-party lifecycle scripts. esbuild and node-hid ship prebuilt
  // binaries; Electron is downloaded and checksummed by electron-builder.
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'])
  const { satisfies } = createRequire(join(workspace, 'package.json'))('semver')
  for (const group of ['dependencies', 'devDependencies']) {
    for (const [name, version] of Object.entries(mac[group])) {
      if (!satisfies(version, project[group][name])) {
        throw new Error(`Update the Mac lockfile: ${name}@${version} does not satisfy ${project[group][name]}`)
      }
    }
  }
  const result = spawnSync('npm', ['audit', '--json'], { cwd: workspace, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  writeFileSync(join(workspace, 'mac-dependencies-audit.json'), result.stdout || '{}')
  requireCleanAudit(result)
  run(process.execPath, ['-e', "require('esbuild').transformSync('const value = 1'); require('node-hid'); console.log('Mac prebuilt modules loaded')"])
  console.log(`Mac dependencies audited: 0 vulnerabilities; workspace=${workspace}`)
}

export function publishMacArtifacts(edition, action) {
  // Mac outputs have their own directory, including app bundles. Never replace
  // a running installed application or any Windows output during a build.
  const destination = join(root, 'dist/macos', edition)
  if (action !== 'build') {
    rmSync(destination, { recursive: true, force: true })
    copyMacTree(join(workspace, 'dist', edition), destination)
    console.log(`Mac artifacts: ${destination}`)
  }
  const compiled = join(root, 'out/macos', edition)
  rmSync(compiled, { recursive: true, force: true })
  copyMacTree(join(workspace, 'out', edition), compiled)
  const report = join(root, 'audit/macos')
  mkdirSync(report, { recursive: true })
  cpSync(join(workspace, 'mac-dependencies-audit.json'), join(report, 'npm-audit.json'))
}

export function main(args = process.argv.slice(2)) {
  if (process.platform !== 'darwin') throw new Error('The isolated Mac toolchain requires macOS')
  const [edition, action = 'build'] = args
  if (edition !== 'prepare' && !['standard', 'stream'].includes(edition)) throw new Error('Expected standard, stream or prepare')
  if (!['build', 'dir', 'package'].includes(action)) throw new Error('Expected build, dir or package')
  const protectedFiles = ['package.json', 'package-lock.json']
  const digest = file => createHash('sha256').update(readFileSync(join(root, file))).digest('hex')
  const before = protectedFiles.map(digest)
  const release = acquireWorkspaceLock(join(root, 'tmp/macos-build.lock'))
  try {
    prepare()
    if (edition === 'prepare') return
    run(process.execPath, ['scripts/build-edition.mjs', edition, action, 'mac'], {
      env: { ...process.env, PDM_MAC_BUILD_ISOLATED: '1' }
    })
    publishMacArtifacts(edition, action)
    if (action !== 'build') {
      const product = `Presentation Display Manager${edition === 'stream' ? ' Stream' : ''}.app`
      for (const arch of ['mac', 'mac-arm64']) {
        run(process.execPath, ['scripts/verify-mac-security.mjs', edition, join(root, 'dist/macos', edition, arch, product)])
      }
    }
  } finally {
    release()
    if (protectedFiles.some((file, index) => digest(file) !== before[index])) {
      throw new Error('Shared dependency manifests changed during the Mac build')
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
