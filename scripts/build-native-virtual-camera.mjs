import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

if (process.platform !== 'win32') {
  console.log('Virtual camera native build skipped: Windows only.')
  process.exit(0)
}

const root = resolve(import.meta.dirname, '..')
const solution = resolve(root, 'native', 'virtual-camera', 'PDMVirtualCamera.sln')
const candidates = [
  process.env.MSBUILD_PATH,
  'C:\\PDMBuildTools\\MSBuild\\Current\\Bin\\MSBuild.exe',
  'C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\MSBuild\\Current\\Bin\\MSBuild.exe',
  'C:\\Program Files\\Microsoft Visual Studio\\2022\\Professional\\MSBuild\\Current\\Bin\\MSBuild.exe',
  'C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\MSBuild\\Current\\Bin\\MSBuild.exe',
  'C:\\Program Files (x86)\\Microsoft Visual Studio\\2022\\BuildTools\\MSBuild\\Current\\Bin\\MSBuild.exe'
].filter(Boolean)

let msbuild = candidates.find((candidate) => existsSync(candidate))
if (!msbuild) {
  const vswhereCandidates = [
    'C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe',
    'C:\\Program Files\\Microsoft Visual Studio\\Installer\\vswhere.exe'
  ]
  const vswhere = vswhereCandidates.find((candidate) => existsSync(candidate))
  if (vswhere) {
    const located = spawnSync(vswhere, [
      '-latest',
      '-products', '*',
      '-requires', 'Microsoft.Component.MSBuild',
      '-find', 'MSBuild\\**\\Bin\\MSBuild.exe'
    ], { encoding: 'utf8', windowsHide: true })
    msbuild = located.status === 0
      ? located.stdout.split(/\r?\n/).map((value) => value.trim()).find((value) => value && existsSync(value))
      : undefined
  }
}
if (!msbuild) {
  const where = spawnSync('where.exe', ['msbuild.exe'], { encoding: 'utf8', windowsHide: true })
  msbuild = where.status === 0 ? where.stdout.split(/\r?\n/).find(Boolean) : undefined
}
if (!msbuild) throw new Error('MSBuild with the Visual C++ tools is required to build the PDM virtual camera.')

const result = spawnSync(msbuild, [solution, '/restore', '/m', '/p:Configuration=Release', '/p:Platform=x64', '/v:minimal'], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true
})
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status || 1)
