// electron-builder afterPack hook.
//
// Hardens Electron Fuses on the packed binary BEFORE electron-builder signs it.
// This runs at PACKAGE time only — it does not touch app runtime behavior. The
// flipped fuses disable capabilities this app never uses (running the binary as a
// generic Node interpreter, NODE_OPTIONS injection, --inspect debugger attach), so
// turning them off cannot break any feature.
//
// Intentionally LEFT ALONE for now (need a verified test build first, they can break
// startup if asar integrity isn't wired): OnlyLoadAppFromAsar,
// EnableEmbeddedAsarIntegrityValidation.

const path = require('path')

module.exports = async function afterPack(context) {
  // Fuses are a Windows/PE + mac/Mach-O concern; only handle win here for now.
  if (context.electronPlatformName !== 'win32') return

  // @electron/fuses v2 is ESM-only ("type":"module") — load it via dynamic
  // import() from this CommonJS hook (a top-level require() would throw).
  const { flipFuses, FuseVersion, FuseV1Options } = await import('@electron/fuses')

  const exeName = `${context.packager.appInfo.productFilename}.exe`
  const exePath = path.join(context.appOutDir, exeName)

  console.log(`[afterPack] hardening Electron fuses on: ${exePath}`)

  await flipFuses(exePath, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: false,
    // Kill the LOLBin / RunAsNode surface (the blocker-grade finding):
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    // Encrypt cookies at rest (transparent to the app):
    [FuseV1Options.EnableCookieEncryption]: true,
    // Force the asar fuses OFF. electron-builder 26 + Electron 42 inject a
    // MISMATCHED asar integrity hash → FATAL "Integrity check failed for asar
    // archive" on launch, and electron-builder's `electronFuses` config does NOT
    // let us disable it (it forces these two on). This afterPack runs AFTER
    // electron-builder's integrity step and BEFORE signtool, so explicitly
    // flipping them off here is the final word on the fuse wire.
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: false
  })

  console.log('[afterPack] fuses hardened: RunAsNode=off, NodeOptions=off, NodeCliInspect=off, CookieEncryption=on')
}
