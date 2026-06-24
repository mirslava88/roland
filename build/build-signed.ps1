# Signed Windows build helper — TWO-PHASE.
#
# Works around an electron-builder 26 + Electron 42 bug: electron-builder enables
# the EnableEmbeddedAsarIntegrityValidation fuse and embeds a MISMATCHED asar
# integrity hash, causing a FATAL "Integrity check failed for asar archive" crash
# on launch of the packaged app. Neither electron-builder's `electronFuses` config
# nor a custom afterPack can disable that fuse in a single-pass build (it gets
# re-enabled during nsis/sign).
#
# So: (1) pack the app dir, (2) disable the asar fuses on the packed exe with
# @electron/fuses (this sticks once electron-builder is done), (3) build the signed
# NSIS installer from the already-fixed dir via --prepackaged.
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

Write-Host "[2/3] disabling broken asar-integrity fuses on packed exe + re-signing" -ForegroundColor Cyan
$exe = Join-Path $root 'dist\win-unpacked\Presentation Display Manager.exe'
npx --yes @electron/fuses write --app "$exe" EnableEmbeddedAsarIntegrityValidation=off OnlyLoadAppFromAsar=off
if ($LASTEXITCODE -ne 0) { throw "fuse flip failed" }
# The fuse flip rewrites the binary and invalidates its Authenticode signature,
# and --prepackaged (phase 3) does NOT re-sign the main exe — so re-sign it here.
$cert = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($pfx, $env:CSC_KEY_PASSWORD)
$sig = Set-AuthenticodeSignature -FilePath $exe -Certificate $cert -HashAlgorithm SHA256
Write-Host ("      main exe re-signed: " + $sig.Status)

Write-Host "[3/3] building signed NSIS installer from fixed dir (--prepackaged)" -ForegroundColor Cyan
npx --yes electron-builder --win --prepackaged "$root\dist\win-unpacked"
if ($LASTEXITCODE -ne 0) { throw "electron-builder --prepackaged failed" }

Write-Host "DONE" -ForegroundColor Green
