// electron-builder afterPack hook.
//
// Hardens Electron fuses on the packed binary before electron-builder signs it.
// This runs at package time only and does not change application features.

const path = require('path')

module.exports = async function afterPack(context) {
  // Fuses are a Windows/PE + macOS/Mach-O concern; only handle Windows here.
  if (context.electronPlatformName !== 'win32') return

  // @electron/fuses v2 is ESM-only, so load it dynamically from this CommonJS hook.
  const { flipFuses, FuseVersion, FuseV1Options } = await import('@electron/fuses')

  const exeName = `${context.packager.appInfo.productFilename}.exe`
  const exePath = path.join(context.appOutDir, exeName)

  console.log(`[afterPack] hardening Electron fuses on: ${exePath}`)

  await flipFuses(exePath, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: false,
    // Disable capabilities the application never uses.
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    // Encrypt cookies at rest.
    [FuseV1Options.EnableCookieEncryption]: true,
    // Electron 43.2.0 + electron-builder 26.15.3 produce a valid embedded ASAR
    // integrity hash. Keep both protections enabled; the packaged application is
    // smoke-tested with this exact state before release.
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true
  })

  console.log(
    '[afterPack] fuses hardened: RunAsNode=off, NodeOptions=off, ' +
      'NodeCliInspect=off, CookieEncryption=on, AsarIntegrity=on, OnlyLoadFromAsar=on'
  )
}
