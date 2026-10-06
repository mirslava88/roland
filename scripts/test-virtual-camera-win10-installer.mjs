import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const [installer, manager] = await Promise.all([
  readFile(new URL('../build/virtual-camera-installer.nsh', import.meta.url), 'utf8'),
  readFile(new URL('../src/main/virtual-camera.ts', import.meta.url), 'utf8')
])
const install = installer.split('!macro customInstall')[1]?.split('!macroend')[0]
const uninstall = installer.split('!macro customUnInstall')[1]?.split('!macroend')[0]
assert.ok(install && uninstall, 'both NSIS camera hooks must exist')

const buildRead = install.indexOf('CurrentBuildNumber')
const skip = install.indexOf('$R0 < 22000')
const supportedBranch = install.indexOf('  ' + '$' + '{Else}', skip)
const register = install.indexOf('--install-source')
assert.ok(buildRead >= 0 && skip > buildRead && supportedBranch > skip && register > supportedBranch,
  'Windows 10 must skip the camera helper before the Windows 11 registration branch')
assert.ok(install.indexOf('installing PDM without it') < supportedBranch,
  'the Windows 10 branch must continue installing PDM without the camera')
assert.match(install, /--install-source[\s\S]*?Abort .*registration failed/,
  'Windows 11 must still stop installation if camera registration fails')
assert.match(install, /--source-registered[\s\S]*?Abort .*verification failed/,
  'Windows 11 must still verify the camera registration')
assert.ok(uninstall.indexOf('CurrentBuildNumber') >= 0 &&
  uninstall.indexOf('$R0 >= 22000') < uninstall.indexOf('--uninstall-source'),
  'Windows 10 removal must not launch the incompatible camera helper')
assert.match(manager, /windowsBuild\(\) >= 22000/,
  'the app and installer must agree on the virtual-camera OS threshold')
assert.match(manager, /async isInstalled\(\)[\s\S]*?if \(!supported\(\)\) return false[\s\S]*?runHost/,
  'status checks on Windows 10 must not launch the unsupported camera host')

console.log('PASS: Windows 10 installs PDM without camera helper; Windows 11 registration remains strict')
