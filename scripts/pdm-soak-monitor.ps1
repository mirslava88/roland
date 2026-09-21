param(
    [Parameter(Mandatory = $true)]
    [int]$RootProcessId,
    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory,
    [int]$DurationMinutes = 25,
    [int]$IntervalSeconds = 5,
    [string]$DiagnosticLog = ''
)

$ErrorActionPreference = 'Stop'

function Get-DescendantProcessIds {
    param([int]$RootId, [object[]]$ProcessRows)

    $children = @{}
    foreach ($row in $ProcessRows) {
        $parentId = [int]$row.ParentProcessId
        if (-not $children.ContainsKey($parentId)) {
            $children[$parentId] = [System.Collections.Generic.List[int]]::new()
        }
        $children[$parentId].Add([int]$row.ProcessId)
    }

    $result = [System.Collections.Generic.HashSet[int]]::new()
    $queue = [System.Collections.Generic.Queue[int]]::new()
    [void]$result.Add($RootId)
    $queue.Enqueue($RootId)
    while ($queue.Count -gt 0) {
        $parent = $queue.Dequeue()
        if (-not $children.ContainsKey($parent)) { continue }
        foreach ($child in $children[$parent]) {
            if ($result.Add($child)) { $queue.Enqueue($child) }
        }
    }
    return @($result)
}

function Get-ProcessKind {
    param([string]$Name, [string]$CommandLine)
    if ($Name -ieq 'powershell.exe' -or $Name -ieq 'pwsh.exe') { return 'powershell' }
    if ($Name -ieq 'conhost.exe') { return 'conhost' }
    if ($CommandLine -match '--type=gpu-process') { return 'gpu' }
    if ($CommandLine -match '--type=renderer') { return 'renderer' }
    if ($CommandLine -match '--type=utility') { return 'utility' }
    if ($CommandLine -match '--type=crashpad-handler') { return 'crashpad' }
    if ($CommandLine -notmatch '--type=') { return 'main' }
    return 'other'
}

function Get-LinearSlopePerHour {
    param([object[]]$Samples, [string]$Property)
    if ($Samples.Count -lt 3) { return 0 }
    $firstTime = [datetime]$Samples[0].Timestamp
    $points = foreach ($sample in $Samples) {
        [pscustomobject]@{
            X = (([datetime]$sample.Timestamp) - $firstTime).TotalHours
            Y = [double]$sample.$Property
        }
    }
    $meanX = ($points | Measure-Object X -Average).Average
    $meanY = ($points | Measure-Object Y -Average).Average
    $numerator = 0.0
    $denominator = 0.0
    foreach ($point in $points) {
        $dx = $point.X - $meanX
        $numerator += $dx * ($point.Y - $meanY)
        $denominator += $dx * $dx
    }
    if ($denominator -le 0) { return 0 }
    return [Math]::Round($numerator / $denominator, 2)
}

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$resolvedOutput = (Resolve-Path $OutputDirectory).Path
$csvPath = Join-Path $resolvedOutput 'memory-samples.csv'
$summaryPath = Join-Path $resolvedOutput 'summary.json'
$eventsPath = Join-Path $resolvedOutput 'diagnostic-events.txt'
$startedAt = Get-Date
$deadline = $startedAt.AddMinutes($DurationMinutes)
$diagnosticStartLine = if ($DiagnosticLog -and (Test-Path -LiteralPath $DiagnosticLog)) {
    @(Get-Content -LiteralPath $DiagnosticLog).Count
} else { 0 }
$samples = [System.Collections.Generic.List[object]]::new()
$rootDied = $false
$nonResponsiveSamples = 0
$consecutiveNonResponsive = 0
$longestNonResponsiveSamples = 0

while ((Get-Date) -lt $deadline) {
    $timestamp = Get-Date
    $root = Get-Process -Id $RootProcessId -ErrorAction SilentlyContinue
    if (-not $root) {
        $rootDied = $true
        break
    }

    $processRows = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine)
    $ids = Get-DescendantProcessIds -RootId $RootProcessId -ProcessRows $processRows
    $rowsById = @{}
    foreach ($row in $processRows) { $rowsById[[int]$row.ProcessId] = $row }

    $workingBytes = 0L
    $privateBytes = 0L
    $kindPrivate = @{}
    $kindCount = @{}
    foreach ($id in $ids) {
        $process = Get-Process -Id $id -ErrorAction SilentlyContinue
        if (-not $process) { continue }
        $workingBytes += [long]$process.WorkingSet64
        $privateBytes += [long]$process.PrivateMemorySize64
        $row = $rowsById[$id]
        $kind = Get-ProcessKind -Name ([string]$row.Name) -CommandLine ([string]$row.CommandLine)
        if (-not $kindPrivate.ContainsKey($kind)) { $kindPrivate[$kind] = 0L; $kindCount[$kind] = 0 }
        $kindPrivate[$kind] += [long]$process.PrivateMemorySize64
        $kindCount[$kind] += 1
    }

    $responding = [bool]$root.Responding
    if ($responding) {
        $consecutiveNonResponsive = 0
    } else {
        $nonResponsiveSamples++
        $consecutiveNonResponsive++
        $longestNonResponsiveSamples = [Math]::Max($longestNonResponsiveSamples, $consecutiveNonResponsive)
    }

    $os = Get-CimInstance Win32_OperatingSystem
    $sample = [pscustomobject]@{
        Timestamp = $timestamp.ToString('o')
        ElapsedSeconds = [Math]::Round(($timestamp - $startedAt).TotalSeconds, 1)
        RootResponding = $responding
        ProcessCount = $ids.Count
        WorkingSetMB = [Math]::Round($workingBytes / 1MB, 1)
        PrivateMB = [Math]::Round($privateBytes / 1MB, 1)
        MainPrivateMB = [Math]::Round(([long]$kindPrivate['main']) / 1MB, 1)
        RendererPrivateMB = [Math]::Round(([long]$kindPrivate['renderer']) / 1MB, 1)
        GpuPrivateMB = [Math]::Round(([long]$kindPrivate['gpu']) / 1MB, 1)
        UtilityPrivateMB = [Math]::Round(([long]$kindPrivate['utility']) / 1MB, 1)
        PowerShellPrivateMB = [Math]::Round(([long]$kindPrivate['powershell']) / 1MB, 1)
        AvailableSystemMB = [Math]::Round(([double]$os.FreePhysicalMemory / 1024), 1)
    }
    $samples.Add($sample)
    if (-not (Test-Path -LiteralPath $csvPath)) {
        $sample | Export-Csv -LiteralPath $csvPath -NoTypeInformation -Encoding UTF8
    } else {
        $sample | Export-Csv -LiteralPath $csvPath -NoTypeInformation -Encoding UTF8 -Append
    }
    Start-Sleep -Seconds ([Math]::Max(1, $IntervalSeconds))
}

$diagnosticEvents = @()
if ($DiagnosticLog -and (Test-Path -LiteralPath $DiagnosticLog)) {
    $newLines = @(Get-Content -LiteralPath $DiagnosticLog | Select-Object -Skip $diagnosticStartLine)
    $diagnosticEvents = @($newLines | Where-Object {
        $_ -match '\[(fatal|renderer-failure|process-failure)\]' -or
        $_ -match 'unresponsive|crashed'
    })
    $diagnosticEvents | Set-Content -LiteralPath $eventsPath -Encoding UTF8
}

$sampleArray = @($samples)
$windowSize = [Math]::Max(1, [Math]::Min(12, [Math]::Floor($sampleArray.Count / 5)))
$firstWindow = @($sampleArray | Select-Object -First $windowSize)
$lastWindow = @($sampleArray | Select-Object -Last $windowSize)
$firstPrivate = if ($firstWindow.Count) { [Math]::Round(($firstWindow | Measure-Object PrivateMB -Average).Average, 1) } else { 0 }
$lastPrivate = if ($lastWindow.Count) { [Math]::Round(($lastWindow | Measure-Object PrivateMB -Average).Average, 1) } else { 0 }
$peakPrivate = if ($sampleArray.Count) { [Math]::Round(($sampleArray | Measure-Object PrivateMB -Maximum).Maximum, 1) } else { 0 }
$minimumPrivate = if ($sampleArray.Count) { [Math]::Round(($sampleArray | Measure-Object PrivateMB -Minimum).Minimum, 1) } else { 0 }
$summary = [ordered]@{
    RootProcessId = $RootProcessId
    StartedAt = $startedAt.ToString('o')
    FinishedAt = (Get-Date).ToString('o')
    RequestedDurationMinutes = $DurationMinutes
    Samples = $sampleArray.Count
    RootDied = $rootDied
    NonResponsiveSamples = $nonResponsiveSamples
    LongestNonResponsiveSeconds = $longestNonResponsiveSamples * [Math]::Max(1, $IntervalSeconds)
    DiagnosticFailureEvents = $diagnosticEvents.Count
    FirstWindowPrivateMB = $firstPrivate
    LastWindowPrivateMB = $lastPrivate
    WindowGrowthMB = [Math]::Round($lastPrivate - $firstPrivate, 1)
    MinimumPrivateMB = $minimumPrivate
    PeakPrivateMB = $peakPrivate
    PrivateSlopeMBPerHour = Get-LinearSlopePerHour -Samples $sampleArray -Property 'PrivateMB'
    WorkingSetSlopeMBPerHour = Get-LinearSlopePerHour -Samples $sampleArray -Property 'WorkingSetMB'
    SampleCsv = $csvPath
    DiagnosticEventsFile = $eventsPath
}
$summary | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $summaryPath -Encoding UTF8
$summary | ConvertTo-Json -Depth 4

if ($rootDied -or $longestNonResponsiveSamples * $IntervalSeconds -ge 30 -or $diagnosticEvents.Count -gt 0) {
    exit 2
}
