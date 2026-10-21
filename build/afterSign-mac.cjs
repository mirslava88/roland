const { join } = require('node:path')
const { verifyMacSigning } = require('../scripts/verify-mac-signing.cjs')

module.exports = async function verifySignedMacPackage(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const result = verifyMacSigning(app)
  console.log(`[mac security] Signing team ${result.team} verified for ${result.binaries} Mach-O binaries`)
}
