$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path $PSScriptRoot 'powerpoint-daemon.ps1'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw "PowerPoint daemon does not parse: $($parseErrors[0])" }
$function = $ast.Find({ param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and
    $node.Name -eq 'Release-IdleOwnedPowerPointHost'
}, $true)
if (-not $function) { throw 'Idle host release function is missing' }
Invoke-Expression $function.Extent.Text

function Log([string]$message) {}
function Close-UnidentifiedManagedPresentations { return $true }
function Restore-PowerPointSession {
    $script:releaseCount++
    $script:lastPowerPointSessionCleanupOk = $true
}
$script:pptSessionInitialized = $true
$script:pptOwnedByRoland = $true
$script:pptApplication = [pscustomobject]@{
    Presentations = [pscustomobject]@{ Count = 0 }
    SlideShowWindows = [pscustomobject]@{ Count = 0 }
}
$script:pptOwnedProcessId = 1
$script:activePresentationPath = ''
$script:activePresentation = $null
$script:activeSlideShowWindow = $null
$script:activeSlideShowHwnd = 0
$script:openTransaction = $null
$script:releaseCount = 0
$script:idleHostHoldUntilUtc = [DateTime]::UtcNow.AddSeconds(20)

Release-IdleOwnedPowerPointHost 'close'
Release-IdleOwnedPowerPointHost 'sync-prepared'
if ($script:releaseCount -ne 0) { throw 'A short PDF return window retired the empty host early' }
Release-IdleOwnedPowerPointHost 'scheduled'
if ($script:releaseCount -ne 1) { throw 'Scheduled cleanup did not retire the empty host' }

$script:activePresentationPath = 'synthetic-active.pptx'
Release-IdleOwnedPowerPointHost 'scheduled'
if ($script:releaseCount -ne 1) { throw 'Scheduled cleanup retired a live presentation' }

$script:activePresentationPath = ''
$script:idleHostHoldUntilUtc = [DateTime]::UtcNow.AddSeconds(20)
Release-IdleOwnedPowerPointHost 'failed-open'
if ($script:releaseCount -ne 2) { throw 'Failed OPEN must bypass the warm lease' }
Write-Output 'PASS: warm empty host, scheduled release, live presentation protection, failure cleanup'
