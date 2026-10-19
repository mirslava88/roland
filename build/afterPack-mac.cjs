const path = require('node:path')

module.exports = async function hardenMacPackage(context) {
  if (context.electronPlatformName !== 'darwin') return
  const { flipFuses, FuseVersion, FuseV1Options } = await import('@electron/fuses')
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  await flipFuses(app, {
    version: FuseVersion.V1,
    strictlyRequireAllFuses: true,
    resetAdHocDarwinSignature: true,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
    // Bundled file:// modules and PDFium still need this capability. Changing
    // it requires migrating the UI to a dedicated application protocol first.
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: true,
    [FuseV1Options.WasmTrapHandlers]: true
  })
  console.log('[mac security] Node entry points disabled; cookie encryption and ASAR integrity enabled')
}
