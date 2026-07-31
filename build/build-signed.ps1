# Signed Windows build helper.
#
# The application is packed first so afterPack can harden Electron fuses before
# electron-builder signs the executable. The NSIS installer is then created from
# that verified prepackaged directory.
#
# PRODUCTION: point CSC_LINK at the corporate-CA .pfx instead of the dev placeholder.

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
npm run build
if ($LASTEXITCODE -ne 0) { throw "electron-vite build failed" }
npx --yes electron-builder --win --dir
if ($LASTEXITCODE -ne 0) { throw "electron-builder --dir failed" }

Write-Host "[2/3] verifying hardened Electron fuses" -ForegroundColor Cyan
$exe = Join-Path $root 'dist\win-unpacked\Presentation Display Manager.exe'
$fuseState = npx --yes @electron/fuses read --app "$exe" | Out-String
if ($LASTEXITCODE -ne 0) { throw "fuse verification failed" }
Write-Host $fuseState
if (
  $fuseState -notmatch 'EnableEmbeddedAsarIntegrityValidation is Enabled' -or
  $fuseState -notmatch 'OnlyLoadAppFromAsar is Enabled'
) {
  throw "Required ASAR security fuses are not enabled"
}

Write-Host "[3/3] building signed NSIS installer from verified app (--prepackaged)" -ForegroundColor Cyan
npx --yes electron-builder --win --prepackaged "$root\dist\win-unpacked"
if ($LASTEXITCODE -ne 0) { throw "electron-builder --prepackaged failed" }

Write-Host "DONE" -ForegroundColor Green
