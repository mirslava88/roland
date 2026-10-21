import assert from 'node:assert/strict'
import { readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { getCurrentFuseWire, FuseV1Options, FuseState } from '@electron/fuses'
import { extractFile, listPackage } from '@electron/asar'

const require = createRequire(import.meta.url)
const { verifyMacSigning } = require('./verify-mac-signing.cjs')
const { editionInfo } = require('../build/editions.cjs')
const info = editionInfo(process.argv[2], 'darwin')
const app = resolve(process.argv[3])
function verifyPortableLinks(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      const link = readlinkSync(path), target = resolve(dirname(path), link)
      assert.ok(!isAbsolute(link) && target.startsWith(app + sep), `Non-portable or escaping bundle link: ${path}`)
    } else if (entry.isDirectory()) verifyPortableLinks(path)
  }
}
verifyPortableLinks(app)
const archive = join(app, 'Contents/Resources/app.asar')
const expectedElectron = JSON.parse(readFileSync(new URL('../build/mac-runtime.json', import.meta.url))).electronVersion
const pkg = JSON.parse(extractFile(archive, 'package.json').toString())
assert.equal(pkg.name, info.name)
assert.equal(pkg.version, info.version)
const metadata = JSON.parse(execFileSync('/usr/bin/python3', ['-c', `
import plistlib,json,sys,subprocess
p=sys.argv[1]
with open(p+'/Contents/Info.plist','rb') as f: info=plistlib.load(f)
with open(p+'/Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist','rb') as f: framework=plistlib.load(f)
result=subprocess.run(['/usr/bin/codesign','-d','--entitlements',':-',p],capture_output=True,check=True)
entitlements=plistlib.loads(result.stdout)
print(json.dumps({'electron':framework.get('CFBundleVersion'),'integrity':info.get('ElectronAsarIntegrity'),'entitlements':entitlements}))
`, app], { encoding: 'utf8' }))
assert.equal(metadata.electron, expectedElectron)
assert.ok(metadata.integrity?.['Resources/app.asar']?.hash, 'Missing embedded ASAR hash')
assert.notEqual(metadata.entitlements['com.apple.security.cs.disable-library-validation'], true)
assert.notEqual(metadata.entitlements['com.apple.security.get-task-allow'], true)
assert.notEqual(metadata.entitlements['com.apple.security.cs.allow-dyld-environment-variables'], true)
const fuses = await getCurrentFuseWire(app)
for (const [key, enabled] of Object.entries({
  RunAsNode: false, EnableCookieEncryption: true,
  EnableNodeOptionsEnvironmentVariable: false, EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true, OnlyLoadAppFromAsar: true,
  LoadBrowserProcessSpecificV8Snapshot: false,
  GrantFileProtocolExtraPrivileges: true, WasmTrapHandlers: true
})) assert.equal(fuses[FuseV1Options[key]], enabled ? FuseState.ENABLE : FuseState.DISABLE, key)
const files = listPackage(archive)
assert.ok(!files.some(file => /\.(?:pdmconfig|log|enc|dmp)$/.test(file) || /^\/(?:tmp|outputs|\.git|\.env)(?:\/|$)/.test(file)), 'Operator data in package')
const signing = verifyMacSigning(app)
console.log(JSON.stringify({ edition: info.edition, app, electron: metadata.electron, signatureVerified: true,
  signingTeam: signing.team, signedBinaries: signing.binaries,
  fusesVerified: true, libraryValidation: true, asarIntegrity: true, privateDataExcluded: true, portableBundleLinks: true }))
