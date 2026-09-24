param([int]$Samples = 3)
$ErrorActionPreference = 'Stop'
# Read-only statistics: do not alter the camera mapping or persist frame content.
$pdmMap = [System.IO.MemoryMappedFiles.MemoryMappedFile]::OpenExisting(
    'Global\PDMVirtualCameraFrame_v1_BBEF2CB0',
    [System.IO.MemoryMappedFiles.MemoryMappedFileRights]::Read)
try {
    $pdmView = $pdmMap.CreateViewAccessor(0, 0, [System.IO.MemoryMappedFiles.MemoryMappedFileAccess]::Read)
    try {
        $results = @()
        for ($sample = 0; $sample -lt $Samples; $sample++) {
            $valid = $false
            for ($attempt = 0; $attempt -lt 40; $attempt++) {
                $sequence = $pdmView.ReadInt32(24)
                if (($sequence -band 1) -ne 0) { Start-Sleep -Milliseconds 5; continue }
                $active = $pdmView.ReadInt32(28)
                $writer = $pdmView.ReadInt32(32)
                $tick = $pdmView.ReadInt64(40)
                $bright = 0
                $maximum = 0
                for ($pos = 0; $pos -lt 8294400; $pos += 16384) {
                    $offset = 64 + ($active -band 1) * 8294400 + $pos
                    $value = [int]$pdmView.ReadByte($offset) + [int]$pdmView.ReadByte($offset + 1) + [int]$pdmView.ReadByte($offset + 2)
                    if ($value -gt 30) { $bright++ }
                    if ($value -gt $maximum) { $maximum = $value }
                }
                if ($sequence -eq $pdmView.ReadInt32(24)) { $valid = $true; break }
            }
            if (-not $valid) { throw 'Could not obtain a consistent virtual-camera frame' }
            $results += [pscustomobject]@{ sequence = $sequence; writer = $writer; lastWriteTick = $tick; brightSamples = $bright; maxRgbSum = $maximum }
            Start-Sleep -Milliseconds 300
        }
        ConvertTo-Json -InputObject $results -Compress
    } finally { $pdmView.Dispose() }
} finally { $pdmMap.Dispose() }
