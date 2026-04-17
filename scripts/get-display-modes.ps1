[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Windows.Forms

Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class DispQuery {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct DEVMODE {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string dmDeviceName;
        public short dmSpecVersion;
        public short dmDriverVersion;
        public short dmSize;
        public short dmDriverExtra;
        public int dmFields;
        public int dmPositionX;
        public int dmPositionY;
        public int dmDisplayOrientation;
        public int dmDisplayFixedOutput;
        public short dmColor;
        public short dmDuplex;
        public short dmYResolution;
        public short dmTTOption;
        public short dmCollate;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
        public string dmFormName;
        public short dmLogPixels;
        public int dmBitsPerPel;
        public int dmPelsWidth;
        public int dmPelsHeight;
        public int dmDisplayFlags;
        public int dmDisplayFrequency;
        public int dmICMMethod;
        public int dmICMIntent;
        public int dmMediaType;
        public int dmDitherType;
        public int dmReserved1;
        public int dmReserved2;
        public int dmPanningWidth;
        public int dmPanningHeight;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "EnumDisplaySettingsW", ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool EnumDisplaySettings(string deviceName, int modeNum, ref DEVMODE devMode);
}
'@

function Get-DevMode {
    $m = New-Object DispQuery+DEVMODE
    $m.dmSize = [int16][System.Runtime.InteropServices.Marshal]::SizeOf($m)
    return $m
}

$result = @()
foreach ($screen in [System.Windows.Forms.Screen]::AllScreens) {
    $current = Get-DevMode
    [void][DispQuery]::EnumDisplaySettings($screen.DeviceName, -1, [ref]$current)

    $modesMap = @{}
    $j = 0
    while ($true) {
        $mode = Get-DevMode
        if (-not [DispQuery]::EnumDisplaySettings($screen.DeviceName, $j, [ref]$mode)) { break }
        $j++
        if ($mode.dmBitsPerPel -lt 32) { continue }
        $key = "$($mode.dmPelsWidth)x$($mode.dmPelsHeight)x$($mode.dmDisplayFrequency)"
        if (-not $modesMap.ContainsKey($key)) {
            $modesMap[$key] = [PSCustomObject]@{
                width = [int]$mode.dmPelsWidth
                height = [int]$mode.dmPelsHeight
                frequency = [int]$mode.dmDisplayFrequency
            }
        }
    }

    $sortedModes = @($modesMap.Values | Sort-Object `
        -Property @{Expression = { $_.width * $_.height }; Descending = $true}, `
                  @{Expression = { $_.frequency }; Descending = $true})

    # Derive a friendlier name via WMI where possible
    $friendlyName = $screen.DeviceName
    try {
        $num = if ($screen.DeviceName -match '\\\\\.\\DISPLAY(\d+)') { [int]$Matches[1] } else { 0 }
        $monitors = @(Get-CimInstance -Namespace root\wmi -ClassName WmiMonitorID -ErrorAction SilentlyContinue)
        if ($monitors.Count -ge $num -and $num -gt 0) {
            $m = $monitors[$num - 1]
            if ($m.UserFriendlyName) {
                $name = -join ($m.UserFriendlyName | Where-Object { $_ -gt 0 } | ForEach-Object { [char]$_ })
                if ($name) { $friendlyName = $name }
            }
        }
    } catch { }

    $result += [PSCustomObject]@{
        deviceName = $screen.DeviceName
        friendlyName = $friendlyName
        isPrimary = [bool]$screen.Primary
        current = [PSCustomObject]@{
            width = [int]$current.dmPelsWidth
            height = [int]$current.dmPelsHeight
            frequency = [int]$current.dmDisplayFrequency
        }
        modes = $sortedModes
    }
}

# Always emit JSON array, even for a single item
$json = ConvertTo-Json -InputObject @($result) -Depth 6 -Compress
Write-Output $json
