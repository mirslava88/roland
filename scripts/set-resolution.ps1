param(
    [Parameter(Mandatory = $true)][string]$DeviceName,
    [Parameter(Mandatory = $true)][int]$Width,
    [Parameter(Mandatory = $true)][int]$Height,
    [int]$Frequency = 0
)

Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class DispApply {
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

    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "ChangeDisplaySettingsExW", ExactSpelling = true)]
    public static extern int ChangeDisplaySettingsEx(string deviceName, ref DEVMODE devMode, IntPtr hwnd, int flags, IntPtr lParam);

    public const int ENUM_CURRENT_SETTINGS = -1;
    public const int CDS_UPDATEREGISTRY = 0x01;
    public const int CDS_GLOBAL         = 0x08;

    public const int DM_PELSWIDTH        = 0x00080000;
    public const int DM_PELSHEIGHT       = 0x00100000;
    public const int DM_DISPLAYFREQUENCY = 0x00400000;
}
'@

$mode = New-Object DispApply+DEVMODE
$mode.dmSize = [int16][System.Runtime.InteropServices.Marshal]::SizeOf($mode)
[void][DispApply]::EnumDisplaySettings($DeviceName, [DispApply]::ENUM_CURRENT_SETTINGS, [ref]$mode)

$mode.dmPelsWidth  = $Width
$mode.dmPelsHeight = $Height
$fields = [DispApply]::DM_PELSWIDTH -bor [DispApply]::DM_PELSHEIGHT
if ($Frequency -gt 0) {
    $mode.dmDisplayFrequency = $Frequency
    $fields = $fields -bor [DispApply]::DM_DISPLAYFREQUENCY
}
$mode.dmFields = $fields

$flags = [DispApply]::CDS_UPDATEREGISTRY -bor [DispApply]::CDS_GLOBAL
$rc = [DispApply]::ChangeDisplaySettingsEx($DeviceName, [ref]$mode, [IntPtr]::Zero, $flags, [IntPtr]::Zero)
exit $rc
