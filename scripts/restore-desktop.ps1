param(
    [string]$WallpaperPath = ""
)

# Restore wallpaper if path provided
if ($WallpaperPath -ne "") {
    Set-ItemProperty -Path 'HKCU:\Control Panel\Desktop' -Name Wallpaper -Value $WallpaperPath
    Set-ItemProperty -Path 'HKCU:\Control Panel\Desktop' -Name WallpaperStyle -Value '10'
    Set-ItemProperty -Path 'HKCU:\Control Panel\Desktop' -Name TileWallpaper -Value '0'

    Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public class WallpaperUtil {
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int SystemParametersInfo(int uAction, int uParam, string lpvParam, int fuWinIni);
}
'@
    [WallpaperUtil]::SystemParametersInfo(0x0014, 0, $WallpaperPath, 3)
}

Write-Output '{"Status":"ok"}'
