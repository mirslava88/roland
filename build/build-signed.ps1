# Signed Windows build helper.
#
# The application is packed first so afterPack can harden Electron fuses before
# electron-builder signs the executable. The NSIS installer is then created from
# that verified prepackaged directory.
#
# PRODUCTION: point CSC_LINK at the corporate-CA .pfx instead of the dev placeholder.

param([ValidateSet('standard', 'stream')][string]$Edition = 'stream')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot   # build\ -> project root

$pfx = Join-Path $root 'build\certs\code-sign-dev.pfx'
$pwFile = Join-Path $root 'build\certs\cert-password.txt'
if (-not (Test-Path $pfx)) { throw "PFX not found at $pfx. Set CSC_LINK to your corporate .pfx." }
if (-not (Test-Path $pwFile)) { throw "Password file not found at $pwFile." }

$env:CSC_LINK = $pfx
$env:CSC_KEY_PASSWORD = (Get-Content $pwFile -Raw).Trim()
Set-Location $root

Write-Host "[1/3] electron-vite build + pack app dir (--dir)" -ForegroundColor Cyan
$env:PDM_EDITION = $Edition
node scripts/build-edition.mjs $Edition dir win
if ($LASTEXITCODE -ne 0) { throw "electron-builder --dir failed" }

Write-Host "[2/3] verifying hardened Electron fuses" -ForegroundColor Cyan
$productName = if ($Edition -eq 'stream') { 'Presentation Display Manager Stream' } else { 'Presentation Display Manager' }
$exe = Join-Path $root "dist\$Edition\win-unpacked\$productName.exe"
$fuseState = npx --no-install @electron/fuses read --app "$exe" | Out-String
if ($LASTEXITCODE -ne 0) { throw "fuse verification failed" }
Write-Host $fuseState
$expectedFuses = @{
  RunAsNode = 'Disabled'
  EnableCookieEncryption = 'Enabled'
  EnableNodeOptionsEnvironmentVariable = 'Disabled'
  EnableNodeCliInspectArguments = 'Disabled'
  EnableEmbeddedAsarIntegrityValidation = 'Enabled'
  OnlyLoadAppFromAsar = 'Enabled'
  LoadBrowserProcessSpecificV8Snapshot = 'Disabled'
  GrantFileProtocolExtraPrivileges = 'Enabled'
  WasmTrapHandlers = 'Enabled'
}
foreach ($entry in $expectedFuses.GetEnumerator()) {
  $needle = "$($entry.Key) is $($entry.Value)"
  if ($fuseState -notmatch [regex]::Escape($needle)) {
    throw "Unexpected Electron fuse state: $needle"
  }
}

Write-Host "[3/3] building signed NSIS installer from verified app (--prepackaged)" -ForegroundColor Cyan
npx --no-install electron-builder --win --config build/edition-builder.cjs --prepackaged "$root\dist\$Edition\win-unpacked" --publish never
if ($LASTEXITCODE -ne 0) { throw "electron-builder --prepackaged failed" }

Write-Host "DONE" -ForegroundColor Green
