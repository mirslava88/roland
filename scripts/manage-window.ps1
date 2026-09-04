param(
    [string]$Action,       # open, minimize, restore, close
    [string]$FilePath = "",
    [string]$FileName = "",
    [long]$Hwnd = 0,
    [int]$ProcessId = 0,
    [string]$ExpectedWindowTitle = "",
    [string]$ExpectedWindowClass = "",
    [int]$OwnershipKnown = 0,
    [int]$PdmManaged = 0,
    [int]$RestoreSlide = 0,
    [int]$X = 0,
    [int]$Y = 0,
    [int]$Width = 1920,
    [int]$Height = 1080,
    [int]$ProtectedX = 0,
    [int]$ProtectedY = 0,
    [int]$ProtectedWidth = 0,
    [int]$ProtectedHeight = 0,
    [int]$ZoomEnabled = 0,
    [int]$ZoomPercent = 100,
    [int]$OriginX = 5000,
    [int]$OriginY = 5000,
    [int]$Windowed = 0,
    [int]$CornerRadius = 0
)

# Windows PowerShell 5.1 otherwise writes native window titles using the
# active OEM code page. Node reads helper stdout as UTF-8, so a Cyrillic
# Word/Excel title was registered as "????" and every later fingerprint check
# rejected the very same HWND. Keep the JSON protocol explicitly UTF-8.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class WinMgr {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern int GetWindowTextLength(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern int SetWindowRgn(IntPtr hWnd, IntPtr hRgn, bool bRedraw);

    [DllImport("gdi32.dll")]
    public static extern IntPtr CreateRoundRectRgn(int left, int top, int right, int bottom, int widthEllipse, int heightEllipse);

    [DllImport("gdi32.dll")]
    public static extern bool DeleteObject(IntPtr hObject);

    [DllImport("dwmapi.dll")]
    public static extern int DwmSetWindowAttribute(IntPtr hWnd, int attribute, ref int value, int valueSize);

    [DllImport("user32.dll")]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left, Top, Right, Bottom;
    }

    public const int SW_HIDE = 0;
    public const int SW_SHOWNORMAL = 1;
    public const int SW_SHOWMAXIMIZED = 3;
    public const int SW_SHOW = 5;
    public const int SW_MINIMIZE = 6;
    public const int SW_RESTORE = 9;
    public const uint WM_CLOSE = 0x0010;

    public static void ClearWindowRegion(IntPtr hWnd) {
        SetWindowRgn(hWnd, IntPtr.Zero, true);
    }

    public static bool ApplyRoundedWindowRegion(IntPtr hWnd, int width, int height, int radius) {
        // On Windows 11 use the compositor's native corner preference. A GDI
        // region set by this PowerShell helper is DPI-virtualized against the
        // 150% control display even when the Office HWND lives on a 100%
        // output display (for example 1354x762 became a 903x509 visible
        // region). DWM rounds the real HWND without changing its dimensions.
        const int DWMWA_WINDOW_CORNER_PREFERENCE = 33;
        const int DWMWCP_DONOTROUND = 1;
        const int DWMWCP_ROUND = 2;
        int preference = radius > 0 ? DWMWCP_ROUND : DWMWCP_DONOTROUND;
        ClearWindowRegion(hWnd);
        int dwmResult = DwmSetWindowAttribute(
            hWnd,
            DWMWA_WINDOW_CORNER_PREFERENCE,
            ref preference,
            Marshal.SizeOf(typeof(int))
        );
        if (dwmResult >= 0) return true;

        // Windows 10 does not expose the DWM corner preference. Keep a GDI
        // fallback there; mixed-DPI correction can be added if that platform
        // is used for a program-scene output.
        if (radius <= 0) {
            return true;
        }
        int diameter = Math.Max(2, radius * 2);
        IntPtr region = CreateRoundRectRgn(0, 0, Math.Max(1, width) + 1, Math.Max(1, height) + 1, diameter, diameter);
        if (region == IntPtr.Zero) return false;
        int applied = SetWindowRgn(hWnd, region, true);
        // After a successful SetWindowRgn Windows owns the HRGN. Delete it
        // only when ownership was not transferred.
        if (applied == 0) DeleteObject(region);
        return applied != 0;
    }

    // Move window to target monitor and maximize (fills entire screen).
    public static void MoveToMonitorAndMaximize(IntPtr hWnd, int monX, int monY, int monW, int monH) {
        ClearWindowRegion(hWnd);
        int cx = monX + (monW / 2) - 400;
        int cy = monY + (monH / 2) - 300;
        bool wasIconic = IsIconic(hWnd);
        ShowWindow(hWnd, wasIconic ? SW_RESTORE : SW_SHOWNORMAL);
        // Word applies its saved normal placement asynchronously while
        // leaving the minimized state. Moving before that completes appears
        // to work, then Word overwrites the position back to the primary
        // monitor. Wait only on the minimized path before routing the HWND.
        if (wasIconic) System.Threading.Thread.Sleep(350);
        MoveWindow(hWnd, cx, cy, 800, 600, true);
        System.Threading.Thread.Sleep(250);
        ShowWindow(hWnd, SW_SHOWMAXIMIZED);
    }

    // Place a native Office document inside the independent content pane of
    // the program scene. It must remain a normal window: maximizing would make
    // Word/Excel cover the backdrop and participant again.
    public static bool MoveToRectAndShow(IntPtr hWnd, int x, int y, int width, int height, int cornerRadius) {
        bool wasIconic = IsIconic(hWnd);
        ShowWindow(hWnd, wasIconic ? SW_RESTORE : SW_SHOWNORMAL);
        if (wasIconic) System.Threading.Thread.Sleep(350);
        ClearWindowRegion(hWnd);
        bool moved = MoveWindow(hWnd, x, y, Math.Max(1, width), Math.Max(1, height), true);
        System.Threading.Thread.Sleep(200);
        bool clipped = ApplyRoundedWindowRegion(hWnd, width, height, cornerRadius);
        ShowWindow(hWnd, SW_SHOW);
        return moved && clipped;
    }

    // Move window to target monitor with margin so backdrop is visible behind.
    public static void MoveToMonitorWithMargin(IntPtr hWnd, int monX, int monY, int monW, int monH, int margin) {
        ShowWindow(hWnd, SW_SHOWNORMAL);
        // First move small window to target monitor center
        int cx = monX + (monW / 2) - 400;
        int cy = monY + (monH / 2) - 300;
        MoveWindow(hWnd, cx, cy, 800, 600, true);
        System.Threading.Thread.Sleep(200);
        // Now resize with margin on all sides
        MoveWindow(hWnd, monX + margin, monY + margin, monW - margin * 2, monH - margin * 2, true);
    }

    public static List<IntPtr> FindWindowsByTitle(string search) {
        var result = new List<IntPtr>();
        string lower = search.ToLower();
        EnumWindows((hWnd, lParam) => {
            if (!IsWindowVisible(hWnd)) return true;
            int len = GetWindowTextLength(hWnd);
            if (len == 0) return true;
            var sb = new StringBuilder(len + 1);
            GetWindowText(hWnd, sb, sb.Capacity);
            if (sb.ToString().ToLower().Contains(lower)) {
                result.Add(hWnd);
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }

    public static List<IntPtr> FindTaskbars() {
        var result = new List<IntPtr>();
        var main = FindWindow("Shell_TrayWnd", null);
        if (main != IntPtr.Zero) result.Add(main);
        EnumWindows((hWnd, lParam) => {
            var sb = new StringBuilder(256);
            GetClassName(hWnd, sb, sb.Capacity);
            if (sb.ToString() == "Shell_SecondaryTrayWnd") {
                result.Add(hWnd);
            }
            return true;
        }, IntPtr.Zero);
        return result;
    }
}
"@

# Diagnostic log
$logFile = Join-Path $env:TEMP "roland-manage-window.log"
function Log($msg) {
    $ts = Get-Date -Format "HH:mm:ss.fff"
    Add-Content -Path $logFile -Value "$ts $msg" -ErrorAction SilentlyContinue
}

function Get-WindowTitleSafe([IntPtr]$handle) {
    try {
        $titleLength = [WinMgr]::GetWindowTextLength($handle)
        if ($titleLength -le 0) { return '' }
        $title = New-Object System.Text.StringBuilder -ArgumentList ($titleLength + 1)
        [WinMgr]::GetWindowText($handle, $title, $title.Capacity) | Out-Null
        return $title.ToString()
    } catch { return '' }
}

function Get-WindowClassSafe([IntPtr]$handle) {
    try {
        $className = New-Object System.Text.StringBuilder -ArgumentList 256
        [WinMgr]::GetClassName($handle, $className, $className.Capacity) | Out-Null
        return $className.ToString()
    } catch { return '' }
}

function Get-WindowProcessIdSafe([IntPtr]$handle) {
    try {
        $actualProcessId = 0
        [WinMgr]::GetWindowThreadProcessId($handle, [ref]$actualProcessId) | Out-Null
        return [int]$actualProcessId
    } catch { return 0 }
}

function Get-NormalizedPathSafe([string]$path) {
    if ([string]::IsNullOrWhiteSpace($path)) { return '' }
    try { return [System.IO.Path]::GetFullPath($path).ToLowerInvariant() } catch {
        return $path.ToLowerInvariant()
    }
}

function Get-ComIdentitySafe($comObject) {
    if (-not $comObject) { return '' }
    $unknown = [IntPtr]::Zero
    try {
        $unknown = [System.Runtime.InteropServices.Marshal]::GetIUnknownForObject($comObject)
        if ($unknown -eq [IntPtr]::Zero) { return '' }
        return ([long]$unknown).ToString('X16')
    } catch { return '' } finally {
        if ($unknown -ne [IntPtr]::Zero) {
            try { [void][System.Runtime.InteropServices.Marshal]::Release($unknown) } catch {}
        }
    }
}

function Release-ComObjectSafe($comObject) {
    if (-not $comObject) { return }
    try {
        if ([System.Runtime.InteropServices.Marshal]::IsComObject($comObject)) {
            [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($comObject)
        }
    } catch {}
}

function Test-WindowTitleMatchesRequestedFile([IntPtr]$handle, [string]$path) {
    $title = Get-WindowTitleSafe $handle
    if ([string]::IsNullOrEmpty($title)) { return $false }
    $leaf = [System.IO.Path]::GetFileName($path)
    $base = [System.IO.Path]::GetFileNameWithoutExtension($path)
    foreach ($name in @($leaf, $base)) {
        if ([string]::IsNullOrWhiteSpace($name) -or
            -not $title.StartsWith($name, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
        $remainder = $title.Substring($name.Length)
        if ([string]::IsNullOrEmpty($remainder) -or
            $remainder.StartsWith(' - ') -or
            $remainder.StartsWith(' [') -or
            $remainder.StartsWith(' (')) {
            return $true
        }
    }
    return $false
}

function Test-WindowMatchesFingerprint(
    [IntPtr]$handle,
    [string]$path,
    [string]$expectedTitle,
    [string]$expectedClass
) {
    $actualTitle = Get-WindowTitleSafe $handle
    $actualClass = Get-WindowClassSafe $handle
    # Office can legitimately rewrite a title after opening (Protected View,
    # read-only state, compatibility mode). Exact title remains the fast path;
    # if it changed, accept it only when the current title still starts with
    # the exact requested leaf/base name. PID + HWND + class are checked by the
    # caller, so a different workbook/document in the same Office process is
    # still rejected.
    $titleMatchesRequestedFile = Test-WindowTitleMatchesRequestedFile $handle $path
    if (-not [string]::IsNullOrEmpty($expectedTitle) -and
        $actualTitle -cne $expectedTitle -and
        -not $titleMatchesRequestedFile) {
        Log "tracked HWND title mismatch expected='$expectedTitle' actual='$actualTitle'"
        return $false
    }
    if (-not [string]::IsNullOrEmpty($expectedClass) -and $actualClass -cne $expectedClass) {
        Log "tracked HWND class mismatch expected='$expectedClass' actual='$actualClass'"
        return $false
    }
    if ([string]::IsNullOrEmpty($expectedTitle) -and -not [string]::IsNullOrWhiteSpace($path)) {
        $expectedName = [System.IO.Path]::GetFileNameWithoutExtension($path)
        if (-not [string]::IsNullOrWhiteSpace($expectedName) -and
            $actualTitle.IndexOf($expectedName, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
            Log "tracked HWND fallback mismatch expected='$expectedName' actual='$actualTitle'"
            return $false
        }
    }
    return $true
}

Log "=== Action=$Action FilePath=$FilePath X=$X Y=$Y W=$Width H=$Height Windowed=$Windowed Corner=$CornerRadius Protected=$ProtectedX,$ProtectedY,$ProtectedWidth,$ProtectedHeight Hwnd=$Hwnd ==="

switch ($Action) {
    "hide-window" {
        $visualStopped = $false
        $windowGone = $false
        $hideError = ''
        if ($Hwnd -eq 0) {
            $hideError = 'Target HWND is missing'
        } else {
            $handle = [IntPtr]::new($Hwnd)
            if (-not [WinMgr]::IsWindow($handle)) {
                $visualStopped = $true
                $windowGone = $true
            } else {
                $actualClass = Get-WindowClassSafe $handle
                $actualProcessId = Get-WindowProcessIdSafe $handle
                if (-not [string]::IsNullOrEmpty($ExpectedWindowClass) -and
                    $actualClass -cne $ExpectedWindowClass) {
                    $hideError = "Target HWND class changed (expected '$ExpectedWindowClass', actual '$actualClass')"
                } elseif ($ProcessId -le 0) {
                    $hideError = 'Target PowerPoint process fingerprint is missing'
                } elseif ($actualProcessId -ne $ProcessId) {
                    $hideError = "Target HWND process changed (expected $ProcessId, actual $actualProcessId)"
                } else {
                    [WinMgr]::ShowWindow($handle, [WinMgr]::SW_HIDE) | Out-Null
                    $deadline = [DateTime]::UtcNow.AddMilliseconds(1200)
                    do {
                        $windowGone = -not [WinMgr]::IsWindow($handle)
                        $visualStopped = $windowGone -or -not [WinMgr]::IsWindowVisible($handle)
                        if (-not $visualStopped) { Start-Sleep -Milliseconds 25 }
                    } while (-not $visualStopped -and [DateTime]::UtcNow -lt $deadline)
                    if (-not $visualStopped) { $hideError = 'Target PowerPoint window remained visible' }
                }
            }
        }
        Log "hide-window verified stopped=$visualStopped gone=$windowGone hwnd=$Hwnd pid=$ProcessId error='$hideError'"
        [pscustomobject]@{
            success = $visualStopped
            visualStopped = $visualStopped
            windowGone = $windowGone
            cleanupVerified = $false
            error = if ($visualStopped) { $null } else { $hideError }
        } | ConvertTo-Json -Compress
    }
    "restore-powerpoint-slideshow" {
        $restored = $false
        $restoreError = ''
        $handle = if ($Hwnd -ne 0) { [IntPtr]::new($Hwnd) } else { [IntPtr]::Zero }
        $expectedPath = Get-NormalizedPathSafe $FilePath

        # This is the same-file abort path. The target and the last committed
        # program are the exact same HWND, so closing/exiting it would destroy
        # the previous output. Restore only its prior slide and visibility.
        if ($handle -eq [IntPtr]::Zero) {
            $restoreError = 'Previous slideshow HWND is missing'
        } elseif (-not [WinMgr]::IsWindow($handle)) {
            $restoreError = 'Previous slideshow HWND no longer exists'
        } elseif ((Get-WindowClassSafe $handle) -cne 'screenClass') {
            $restoreError = 'Previous HWND is no longer a PowerPoint slideshow'
        } elseif ($ProcessId -le 0) {
            $restoreError = 'Previous PowerPoint process fingerprint is missing'
        } elseif ((Get-WindowProcessIdSafe $handle) -ne $ProcessId) {
            $restoreError = 'Previous slideshow HWND process changed'
        } elseif ([string]::IsNullOrEmpty($expectedPath) -or $RestoreSlide -le 0) {
            $restoreError = 'Previous slideshow path/slide is missing'
        } else {
            try {
                $ppt = [System.Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application')
                $targetWindow = $null
                $findDeadline = [DateTime]::UtcNow.AddMilliseconds(5000)
                do {
                    try {
                        for ($i = 1; $i -le [int]$ppt.SlideShowWindows.Count; $i++) {
                            $candidateWindow = $ppt.SlideShowWindows.Item($i)
                            $candidateHwnd = 0
                            $candidatePath = ''
                            try { $candidateHwnd = [long]$candidateWindow.HWND } catch {}
                            try { $candidatePath = Get-NormalizedPathSafe ([string]$candidateWindow.Presentation.FullName) } catch {}
                            if ($candidateHwnd -eq $Hwnd -and $candidatePath -eq $expectedPath) {
                                $targetWindow = $candidateWindow
                                break
                            }
                        }
                    } catch {
                        $restoreError = "PowerPoint slideshow enumeration failed: $($_.Exception.Message)"
                    }
                    if ($targetWindow) { break }
                    Start-Sleep -Milliseconds 100
                } while ([DateTime]::UtcNow -lt $findDeadline)

                if (-not $targetWindow) {
                    $restoreError = 'Exact previous PowerPoint slideshow HWND/path could not be matched'
                } else {
                    try {
                        if ([int]$targetWindow.View.Slide.SlideIndex -ne $RestoreSlide) {
                            $targetWindow.View.GotoSlide($RestoreSlide)
                        }
                        [WinMgr]::ShowWindow($handle, [WinMgr]::SW_SHOW) | Out-Null
                    } catch {
                        $restoreError = "Previous PowerPoint slide restore failed: $($_.Exception.Message)"
                    }

                    $verifyDeadline = [DateTime]::UtcNow.AddMilliseconds(5000)
                    do {
                        try {
                            $verifiedPath = Get-NormalizedPathSafe ([string]$targetWindow.Presentation.FullName)
                            $verifiedSlide = [int]$targetWindow.View.Slide.SlideIndex
                            $restored = [WinMgr]::IsWindow($handle) -and
                                (Get-WindowClassSafe $handle) -ceq 'screenClass' -and
                                (Get-WindowProcessIdSafe $handle) -eq $ProcessId -and
                                [WinMgr]::IsWindowVisible($handle) -and
                                $verifiedPath -eq $expectedPath -and
                                $verifiedSlide -eq $RestoreSlide
                        } catch { $restored = $false }
                        if (-not $restored) { Start-Sleep -Milliseconds 100 }
                    } while (-not $restored -and [DateTime]::UtcNow -lt $verifyDeadline)
                    if (-not $restored -and [string]::IsNullOrEmpty($restoreError)) {
                        $restoreError = 'Previous PowerPoint slideshow restore was not verified'
                    }
                }
            } catch {
                $restoreError = "PowerPoint previous slideshow restore failed: $($_.Exception.Message)"
            }
        }

        Log "restore-powerpoint-slideshow restored=$restored hwnd=$Hwnd pid=$ProcessId slide=$RestoreSlide error='$restoreError'"
        [pscustomobject]@{
            success = $restored
            previousRestored = $restored
            visualStopped = $false
            cleanupVerified = $restored
            windowGone = $handle -ne [IntPtr]::Zero -and -not [WinMgr]::IsWindow($handle)
            error = if ($restored) { $null } else { $restoreError }
        } | ConvertTo-Json -Compress
    }
    "rollback-powerpoint-target" {
        $visualStopped = $false
        $windowGone = $false
        $cleanupVerified = $false
        $rollbackError = ''
        $handle = if ($Hwnd -ne 0) { [IntPtr]::new($Hwnd) } else { [IntPtr]::Zero }

        # The caller hides through a separate short-lived helper first. Repeat
        # the exact class/PID check here so this COM phase is independently
        # safe even if the numeric HWND was reused between processes.
        if ($handle -eq [IntPtr]::Zero) {
            $rollbackError = 'Target HWND is missing'
        } elseif (-not [WinMgr]::IsWindow($handle)) {
            $visualStopped = $true
            $windowGone = $true
        } else {
            $actualClass = Get-WindowClassSafe $handle
            $actualProcessId = Get-WindowProcessIdSafe $handle
            if ($actualClass -cne 'screenClass') {
                $rollbackError = "Target HWND is no longer a PowerPoint slideshow (class '$actualClass')"
            } elseif ($ProcessId -le 0) {
                $visualStopped = -not [WinMgr]::IsWindowVisible($handle)
                $rollbackError = 'Target PowerPoint process fingerprint is missing'
            } elseif ($actualProcessId -ne $ProcessId) {
                $rollbackError = "Target HWND process changed (expected $ProcessId, actual $actualProcessId)"
            } else {
                if ([WinMgr]::IsWindowVisible($handle)) {
                    [WinMgr]::ShowWindow($handle, [WinMgr]::SW_HIDE) | Out-Null
                }
                $visualStopped = -not [WinMgr]::IsWindowVisible($handle)
                if (-not $visualStopped) { $rollbackError = 'Target PowerPoint window could not be hidden' }
            }
        }

        if ($visualStopped) {
            if ($windowGone) {
                if ($OwnershipKnown -ne 0 -and $PdmManaged -eq 0) {
                    # A user-owned presentation must remain open; disappearance
                    # of its exact slideshow HWND is the required postcondition.
                    $cleanupVerified = $true
                } else {
                    $rollbackError = 'Target window is gone, but managed presentation cleanup cannot be proven'
                }
            } else {
                $ppt = $null
                $targetWindow = $null
                $targetPresentation = $null
                $expectedPath = Get-NormalizedPathSafe $FilePath
                try {
                    $ppt = [System.Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application')
                    $findDeadline = [DateTime]::UtcNow.AddMilliseconds(5000)
                    do {
                        try {
                            for ($i = 1; $i -le [int]$ppt.SlideShowWindows.Count; $i++) {
                                $candidateWindow = $ppt.SlideShowWindows.Item($i)
                                $candidateHwnd = 0
                                $candidatePath = ''
                                try { $candidateHwnd = [long]$candidateWindow.HWND } catch {}
                                try { $candidatePath = Get-NormalizedPathSafe ([string]$candidateWindow.Presentation.FullName) } catch {}
                                if ($candidateHwnd -eq $Hwnd -and
                                    -not [string]::IsNullOrEmpty($expectedPath) -and
                                    $candidatePath -eq $expectedPath) {
                                    $targetWindow = $candidateWindow
                                    $targetPresentation = $candidateWindow.Presentation
                                    break
                                }
                            }
                        } catch {
                            $rollbackError = "PowerPoint slideshow enumeration failed: $($_.Exception.Message)"
                        }
                        if ($targetWindow) { break }
                        Start-Sleep -Milliseconds 100
                    } while ([DateTime]::UtcNow -lt $findDeadline)

                    if (-not $targetWindow -or -not $targetPresentation) {
                        $windowGone = -not [WinMgr]::IsWindow($handle)
                        if ($windowGone -and $OwnershipKnown -ne 0 -and $PdmManaged -eq 0) {
                            $cleanupVerified = $true
                        } else {
                            $rollbackError = 'Exact PowerPoint slideshow HWND/path could not be matched for COM rollback'
                        }
                    } elseif ($OwnershipKnown -eq 0) {
                        # Unknown ownership can safely stop only the slideshow;
                        # it must never close the underlying user document.
                        try { $targetWindow.View.Exit() } catch {
                            $rollbackError = "PowerPoint slideshow exit failed: $($_.Exception.Message)"
                        }
                        $rollbackError = if ([string]::IsNullOrEmpty($rollbackError)) {
                            'Presentation ownership is unknown; document cleanup cannot be proven'
                        } else { $rollbackError }
                    } elseif ($PdmManaged -ne 0) {
                        $targetIdentity = Get-ComIdentitySafe $targetPresentation
                        $targetPath = Get-NormalizedPathSafe ([string]$targetPresentation.FullName)
                        try { $targetPresentation.Saved = -1 } catch {}
                        try { $targetPresentation.Close() } catch {
                            $rollbackError = "Managed PowerPoint presentation close failed: $($_.Exception.Message)"
                        }

                        $verifyDeadline = [DateTime]::UtcNow.AddMilliseconds(5000)
                        do {
                            $stillOpen = $true
                            try {
                                $stillOpen = $false
                                for ($i = 1; $i -le [int]$ppt.Presentations.Count; $i++) {
                                    $candidate = $ppt.Presentations.Item($i)
                                    $candidateMatches = if (-not [string]::IsNullOrEmpty($targetIdentity)) {
                                        (Get-ComIdentitySafe $candidate) -eq $targetIdentity
                                    } else {
                                        (Get-NormalizedPathSafe ([string]$candidate.FullName)) -eq $targetPath
                                    }
                                    if ($candidateMatches) {
                                        $stillOpen = $true
                                        break
                                    }
                                }
                            } catch {
                                $stillOpen = $true
                                $rollbackError = "Managed PowerPoint close verification failed: $($_.Exception.Message)"
                            }
                            if ($stillOpen) { Start-Sleep -Milliseconds 100 }
                        } while ($stillOpen -and [DateTime]::UtcNow -lt $verifyDeadline)
                        $cleanupVerified = -not $stillOpen
                        if (-not $cleanupVerified -and [string]::IsNullOrEmpty($rollbackError)) {
                            $rollbackError = 'Managed PowerPoint presentation remains loaded or unverified'
                        }
                    } else {
                        try { $targetWindow.View.Exit() } catch {
                            $rollbackError = "User-owned PowerPoint slideshow exit failed: $($_.Exception.Message)"
                        }
                        $exitDeadline = [DateTime]::UtcNow.AddMilliseconds(5000)
                        do {
                            $windowGone = -not [WinMgr]::IsWindow($handle)
                            if (-not $windowGone) { Start-Sleep -Milliseconds 100 }
                        } while (-not $windowGone -and [DateTime]::UtcNow -lt $exitDeadline)
                        $cleanupVerified = $windowGone
                        if (-not $cleanupVerified -and [string]::IsNullOrEmpty($rollbackError)) {
                            $rollbackError = 'User-owned PowerPoint slideshow exit was not verified'
                        }
                    }
                } catch {
                    $rollbackError = "PowerPoint COM rollback failed: $($_.Exception.Message)"
                }
            }
        }

        $windowGone = $windowGone -or ($handle -ne [IntPtr]::Zero -and -not [WinMgr]::IsWindow($handle))
        $visualStopped = $visualStopped -or $windowGone -or
            ($handle -ne [IntPtr]::Zero -and -not [WinMgr]::IsWindowVisible($handle))
        Log "rollback-powerpoint-target stopped=$visualStopped cleanup=$cleanupVerified gone=$windowGone hwnd=$Hwnd pid=$ProcessId managed=$PdmManaged known=$OwnershipKnown error='$rollbackError'"
        [pscustomobject]@{
            success = $visualStopped
            visualStopped = $visualStopped
            cleanupVerified = $cleanupVerified
            windowGone = $windowGone
            error = if ($cleanupVerified) { $null } else { $rollbackError }
        } | ConvertTo-Json -Compress
    }
    "verify-hidden-window" {
        $exists = $Hwnd -ne 0 -and [WinMgr]::IsWindow([IntPtr]::new($Hwnd))
        $windowGone = $Hwnd -ne 0 -and -not $exists
        $fingerprintMatches = $false
        $visible = $false
        $verifyError = ''
        if ($Hwnd -eq 0) {
            $verifyError = 'Target HWND is missing'
        } elseif ($windowGone) {
            $fingerprintMatches = $true
        } else {
            $handle = [IntPtr]::new($Hwnd)
            $actualClass = Get-WindowClassSafe $handle
            $actualProcessId = Get-WindowProcessIdSafe $handle
            if ([string]::IsNullOrEmpty($ExpectedWindowClass)) {
                $verifyError = 'Expected window class is missing'
            } elseif ($ProcessId -le 0) {
                $verifyError = 'Expected process fingerprint is missing'
            } elseif ($actualClass -cne $ExpectedWindowClass) {
                $verifyError = "Target HWND class changed (expected '$ExpectedWindowClass', actual '$actualClass')"
            } elseif ($actualProcessId -ne $ProcessId) {
                $verifyError = "Target HWND process changed (expected $ProcessId, actual $actualProcessId)"
            } else {
                $fingerprintMatches = $true
                $visible = [WinMgr]::IsWindowVisible($handle)
                if ($visible) { $verifyError = 'Exact target PowerPoint window is visible again' }
            }
        }
        $stopped = $fingerprintMatches -and ($windowGone -or -not $visible)
        [pscustomobject]@{
            success = $stopped
            visualStopped = $stopped
            windowGone = $windowGone
            visible = $visible
            error = if ($stopped) { $null } else { $verifyError }
        } | ConvertTo-Json -Compress
    }
    "verify-window" {
        $exists = $Hwnd -ne 0 -and [WinMgr]::IsWindow([IntPtr]::new($Hwnd))
        $visible = $exists -and [WinMgr]::IsWindowVisible([IntPtr]::new($Hwnd))
        $classMatches = $true
        if ($exists -and -not [string]::IsNullOrEmpty($ExpectedWindowClass)) {
            $classMatches = (Get-WindowClassSafe ([IntPtr]::new($Hwnd))) -ceq $ExpectedWindowClass
        }
        $processMatches = $ProcessId -gt 0 -and $exists -and
            (Get-WindowProcessIdSafe ([IntPtr]::new($Hwnd))) -eq $ProcessId
        [pscustomobject]@{
            success = $exists -and $visible -and $classMatches -and $processMatches
            windowGone = -not $exists
            visible = $visible
            error = if ($exists -and $visible -and $classMatches -and $processMatches) { $null } else { 'Window is not verifiably visible with the expected fingerprint' }
        } | ConvertTo-Json -Compress
    }
    "open" {
        $searchName = [System.IO.Path]::GetFileNameWithoutExtension($FilePath)
        $existingWindows = [WinMgr]::FindWindowsByTitle($searchName)

        Start-Process -FilePath $FilePath

        # Office may spend tens of seconds in add-ins/Protected View before it
        # creates the document HWND. Keep this helper alive long enough to own
        # and fingerprint that late window; returning early would leave an
        # untracked Word/Excel window that can appear after TAKE rollback.
        $newWindow = [IntPtr]::Zero
        $windowOwnedByPdm = $false
        for ($i = 0; $i -lt 600; $i++) {
            Start-Sleep -Milliseconds 100
            $windows = [WinMgr]::FindWindowsByTitle($searchName)
            foreach ($w in $windows) {
                if (-not $existingWindows.Contains($w)) {
                    $newWindow = $w
                    $windowOwnedByPdm = $true
                    break
                }
            }
            if ($newWindow -ne [IntPtr]::Zero) { break }
            if ($i -gt 30 -and $windows.Count -gt 0) {
                $exactWindows = @($windows | Where-Object {
                    Test-WindowTitleMatchesRequestedFile $_ $FilePath
                })
                if ($exactWindows.Count -gt 0) {
                    $newWindow = $exactWindows[0]
                    # Start-Process reused a document window that was already
                    # open before PDM requested it. It may be routed/minimized,
                    # but PDM must never close the user's document.
                    $windowOwnedByPdm = $false
                }
            }
            if ($newWindow -ne [IntPtr]::Zero) {
                break
            }
        }

        if ($newWindow -ne [IntPtr]::Zero) {
            $procId = 0
            [WinMgr]::GetWindowThreadProcessId($newWindow, [ref]$procId) | Out-Null
            Log "Found window hwnd=$($newWindow.ToInt64()) pid=$procId owned=$windowOwnedByPdm"

            $fileExt = [System.IO.Path]::GetExtension($FilePath).ToLower()
            $isWord = $fileExt -in '.doc', '.docx', '.rtf', '.odt'

            if ($isWord) {
                Start-Sleep -Milliseconds 1500
                # Disable Read Mode via COM before maximizing
                try {
                    $wordApp = [System.Runtime.InteropServices.Marshal]::GetActiveObject("Word.Application")
                    $wordApp.ActiveWindow.View.ReadingLayout = $false
                    $wordApp.ActiveWindow.View.Type = 3  # wdPrintView
                    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($wordApp) | Out-Null
                    Log "Word COM: disabled ReadingLayout"
                } catch { Log "Word COM view error: $_" }
                Start-Sleep -Milliseconds 300
            } else {
                Start-Sleep -Milliseconds 500
            }

            # Fullscreen is the normal Word/Excel output. In the program scene
            # keep the native window inside the calculated content pane so the
            # independent participant and backdrop remain visible.
            $placementApplied = $true
            if ($Windowed -ne 0) {
                $placementApplied = [WinMgr]::MoveToRectAndShow($newWindow, $X, $Y, $Width, $Height, $CornerRadius)
            } else {
                [WinMgr]::MoveToMonitorAndMaximize($newWindow, $X, $Y, $Width, $Height)
            }
            [WinMgr]::SetForegroundWindow($newWindow) | Out-Null

            # Verify the window by its centre, not by any tiny frame overlap.
            # Maximized windows can extend several invisible border pixels onto
            # an adjacent monitor and used to produce false routing success.
            $rect = New-Object WinMgr+RECT
            $positionRead = [WinMgr]::GetWindowRect($newWindow, [ref]$rect)
            Log "Final GetWindowRect: L=$($rect.Left) T=$($rect.Top) R=$($rect.Right) B=$($rect.Bottom)"
            Log "Target monitor: X=$X Y=$Y W=$Width H=$Height"
            $windowCenterX = [int](($rect.Left + $rect.Right) / 2)
            $windowCenterY = [int](($rect.Top + $rect.Bottom) / 2)
            $positionVerified = $placementApplied -and $positionRead -and (
                $windowCenterX -ge $X -and
                $windowCenterX -lt ($X + $Width) -and
                $windowCenterY -ge $Y -and
                $windowCenterY -lt ($Y + $Height)
            )
            if ($positionVerified -and $Windowed -ne 0) {
                $tolerance = 40
                $positionVerified = (
                    [Math]::Abs($rect.Left - $X) -le $tolerance -and
                    [Math]::Abs($rect.Top - $Y) -le $tolerance -and
                    [Math]::Abs(($rect.Right - $rect.Left) - $Width) -le ($tolerance * 2) -and
                    [Math]::Abs(($rect.Bottom - $rect.Top) - $Height) -le ($tolerance * 2)
                )
            }
            if (-not $positionVerified) {
                [WinMgr]::ShowWindow($newWindow, [WinMgr]::SW_MINIMIZE) | Out-Null
            }
            [pscustomobject]@{
                success = $positionVerified
                hwnd = $newWindow.ToInt64()
                pid = $procId
                windowTitle = Get-WindowTitleSafe $newWindow
                windowClass = Get-WindowClassSafe $newWindow
                owned = $windowOwnedByPdm
                error = if ($positionVerified) { $null } else { "Window did not move to the target monitor" }
            } | ConvertTo-Json -Compress
        } else {
            Log "Window not found for '$searchName'"
            Write-Output '{"success":false,"hwnd":0,"pid":0,"owned":false,"error":"Window was not found after opening"}'
        }
    }
    "minimize" {
        $minimizeSuccess = $false
        $windowGone = $false
        $minimizeError = ""
        if ($Hwnd -eq 0) {
            $windowGone = $true
            $minimizeSuccess = $true
        } else {
            $handle = [IntPtr]::new($Hwnd)
            if (-not [WinMgr]::IsWindow($handle)) {
                # The tracked window has already gone away. From the output
                # lifecycle point of view this is a successful release.
                $windowGone = $true
                $minimizeSuccess = $true
            } else {
                $actualProcessId = 0
                [WinMgr]::GetWindowThreadProcessId($handle, [ref]$actualProcessId) | Out-Null
                if ($ProcessId -ne 0 -and $actualProcessId -ne $ProcessId) {
                    # HWNDs can be reused. Never minimize an unrelated window.
                    $windowGone = $true
                    $minimizeSuccess = $true
                } elseif (-not (Test-WindowMatchesFingerprint $handle $FilePath $ExpectedWindowTitle $ExpectedWindowClass)) {
                    # Word/Excel host several documents in one process, so PID
                    # equality alone does not protect against same-process HWND
                    # reuse. A different title/class is ambiguous (reuse or a
                    # legitimate title change), so fail closed and let the
                    # operator retry without touching that window.
                    $minimizeError = "The tracked document window fingerprint changed; no window was touched"
                } else {
                    [WinMgr]::ShowWindow($handle, [WinMgr]::SW_MINIMIZE) | Out-Null
                    for ($i = 0; $i -lt 20; $i++) {
                        if (-not [WinMgr]::IsWindow($handle)) {
                            $windowGone = $true
                            $minimizeSuccess = $true
                            break
                        }
                        if ([WinMgr]::IsIconic($handle)) {
                            $minimizeSuccess = $true
                            break
                        }
                        Start-Sleep -Milliseconds 100
                    }
                    if (-not $minimizeSuccess) {
                        $minimizeError = "Window did not enter the minimized state"
                    }
                }
            }
        }
        Log "minimize verified success=$minimizeSuccess gone=$windowGone hwnd=$Hwnd"
        [pscustomobject]@{
            success = $minimizeSuccess
            windowGone = $windowGone
            error = if ($minimizeSuccess) { $null } else { $minimizeError }
        } | ConvertTo-Json -Compress
    }
    "zoom-office" {
        $zoomSuccess = $false
        $zoomError = ''
        $actualZoom = 100
        $handle = if ($Hwnd -ne 0) { [IntPtr]::new($Hwnd) } else { [IntPtr]::Zero }
        if ($handle -eq [IntPtr]::Zero -or -not [WinMgr]::IsWindow($handle)) {
            $zoomError = 'The tracked Office window is no longer available'
        } else {
            $actualProcessId = Get-WindowProcessIdSafe $handle
            if ($ProcessId -le 0 -or $actualProcessId -ne $ProcessId) {
                $zoomError = 'The tracked Office window process fingerprint changed'
            } elseif (-not (Test-WindowMatchesFingerprint $handle $FilePath $ExpectedWindowTitle $ExpectedWindowClass)) {
                $zoomError = 'The tracked Office document fingerprint changed; zoom was not applied'
            } else {
                $requestedZoom = [Math]::Max(100, [Math]::Min(300, $ZoomPercent))
                $originXNormalized = [Math]::Max(0.0, [Math]::Min(1.0, $OriginX / 10000.0))
                $originYNormalized = [Math]::Max(0.0, [Math]::Min(1.0, $OriginY / 10000.0))
                $normalizedPath = Get-NormalizedPathSafe $FilePath
                $fileExt = [System.IO.Path]::GetExtension($FilePath).ToLowerInvariant()
                $officeApp = $null
                $officeDocument = $null
                $officeWindow = $null
                $officeSheet = $null
                $usedRange = $null
                $visibleRange = $null
                try {
                    if ($fileExt -in '.doc', '.docx', '.rtf', '.odt') {
                        $officeApp = [System.Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application')
                        for ($i = 1; $i -le [int]$officeApp.Documents.Count -and -not $officeDocument; $i++) {
                            $candidateDocument = $officeApp.Documents.Item($i)
                            try {
                                if ((Get-NormalizedPathSafe ([string]$candidateDocument.FullName)) -eq $normalizedPath) {
                                    for ($j = 1; $j -le [int]$candidateDocument.Windows.Count; $j++) {
                                        $candidateWindow = $candidateDocument.Windows.Item($j)
                                        $candidateHwnd = 0
                                        try { $candidateHwnd = [long]$candidateWindow.Hwnd } catch {}
                                        if ($candidateHwnd -eq $Hwnd) {
                                            $officeDocument = $candidateDocument
                                            $officeWindow = $candidateWindow
                                            break
                                        }
                                        Release-ComObjectSafe $candidateWindow
                                    }
                                }
                            } catch {}
                            if (-not $officeDocument) { Release-ComObjectSafe $candidateDocument }
                        }
                        if (-not $officeDocument -or -not $officeWindow) {
                            throw 'The exact Word document window could not be matched'
                        }
                        $officeWindow.View.ReadingLayout = $false
                        $officeWindow.View.Type = 3
                        $officeWindow.View.Zoom.Percentage = $requestedZoom
                        if ($ZoomEnabled -ne 0 -and $requestedZoom -gt 100) {
                            try { $officeWindow.HorizontalPercentScrolled = [int][Math]::Round($originXNormalized * 100) } catch {}
                            try { $officeWindow.VerticalPercentScrolled = [int][Math]::Round($originYNormalized * 100) } catch {}
                        }
                        $actualZoom = [int]$officeWindow.View.Zoom.Percentage
                        $zoomSuccess = $true
                    } elseif ($fileExt -in '.xls', '.xlsx', '.ods') {
                        $officeApp = [System.Runtime.InteropServices.Marshal]::GetActiveObject('Excel.Application')
                        for ($i = 1; $i -le [int]$officeApp.Workbooks.Count -and -not $officeDocument; $i++) {
                            $candidateDocument = $officeApp.Workbooks.Item($i)
                            try {
                                if ((Get-NormalizedPathSafe ([string]$candidateDocument.FullName)) -eq $normalizedPath) {
                                    for ($j = 1; $j -le [int]$candidateDocument.Windows.Count; $j++) {
                                        $candidateWindow = $candidateDocument.Windows.Item($j)
                                        $candidateHwnd = 0
                                        try { $candidateHwnd = [long]$candidateWindow.Hwnd } catch {}
                                        if ($candidateHwnd -eq $Hwnd) {
                                            $officeDocument = $candidateDocument
                                            $officeWindow = $candidateWindow
                                            break
                                        }
                                        Release-ComObjectSafe $candidateWindow
                                    }
                                }
                            } catch {}
                            if (-not $officeDocument) { Release-ComObjectSafe $candidateDocument }
                        }
                        if (-not $officeDocument -or -not $officeWindow) {
                            throw 'The exact Excel workbook window could not be matched'
                        }
                        $officeWindow.Zoom = $requestedZoom
                        if ($ZoomEnabled -ne 0 -and $requestedZoom -gt 100) {
                            Start-Sleep -Milliseconds 20
                            $officeSheet = $officeDocument.ActiveSheet
                            $usedRange = $officeSheet.UsedRange
                            $visibleRange = $officeWindow.VisibleRange
                            $firstRow = [int]$usedRange.Row
                            $firstColumn = [int]$usedRange.Column
                            $lastRow = $firstRow + [int]$usedRange.Rows.Count - 1
                            $lastColumn = $firstColumn + [int]$usedRange.Columns.Count - 1
                            $visibleRows = [Math]::Max(1, [int]$visibleRange.Rows.Count)
                            $visibleColumns = [Math]::Max(1, [int]$visibleRange.Columns.Count)
                            $maxScrollRow = [Math]::Max($firstRow, $lastRow - $visibleRows + 1)
                            $maxScrollColumn = [Math]::Max($firstColumn, $lastColumn - $visibleColumns + 1)
                            $officeWindow.ScrollRow = [int][Math]::Round($firstRow + ($maxScrollRow - $firstRow) * $originYNormalized)
                            $officeWindow.ScrollColumn = [int][Math]::Round($firstColumn + ($maxScrollColumn - $firstColumn) * $originXNormalized)
                        }
                        $actualZoom = [int]$officeWindow.Zoom
                        $zoomSuccess = $true
                    } else {
                        $zoomError = 'Only Word and Excel documents support Office zoom'
                    }
                } catch {
                    $zoomError = $_.Exception.Message
                } finally {
                    Release-ComObjectSafe $visibleRange
                    Release-ComObjectSafe $usedRange
                    Release-ComObjectSafe $officeSheet
                    Release-ComObjectSafe $officeWindow
                    Release-ComObjectSafe $officeDocument
                    Release-ComObjectSafe $officeApp
                }
            }
        }
        Log "zoom-office success=$zoomSuccess zoom=$actualZoom enabled=$ZoomEnabled origin=$OriginX,$OriginY hwnd=$Hwnd error='$zoomError'"
        [pscustomobject]@{
            success = $zoomSuccess
            zoomPercent = $actualZoom
            error = if ($zoomSuccess) { $null } else { $zoomError }
        } | ConvertTo-Json -Compress
    }
    "restore" {
        $restoreSuccess = $false
        $restoreError = ""
        if ($Hwnd -eq 0) {
            $restoreError = "Window handle is missing"
        } else {
            $handle = [IntPtr]::new($Hwnd)
            if (-not [WinMgr]::IsWindow($handle)) {
                $restoreError = "Window handle is no longer valid"
            } else {
                $actualProcessId = 0
                [WinMgr]::GetWindowThreadProcessId($handle, [ref]$actualProcessId) | Out-Null
                if ($ProcessId -ne 0 -and $actualProcessId -ne $ProcessId) {
                    $restoreError = "Window now belongs to another process"
                } elseif (-not (Test-WindowMatchesFingerprint $handle $FilePath $ExpectedWindowTitle $ExpectedWindowClass)) {
                    $restoreError = "The tracked document window is no longer available"
                } else {
                $fileExt = [System.IO.Path]::GetExtension($FilePath).ToLower()
                $isWord = $fileExt -in '.doc', '.docx', '.rtf', '.odt'

                if ($isWord) {
                    try {
                        $wordApp = [System.Runtime.InteropServices.Marshal]::GetActiveObject("Word.Application")
                        $wordApp.ActiveWindow.View.ReadingLayout = $false
                        $wordApp.ActiveWindow.View.Type = 3
                        [System.Runtime.InteropServices.Marshal]::ReleaseComObject($wordApp) | Out-Null
                    } catch {}
                }

                $placementApplied = $true
                if ($Windowed -ne 0) {
                    $placementApplied = [WinMgr]::MoveToRectAndShow($handle, $X, $Y, $Width, $Height, $CornerRadius)
                } else {
                    [WinMgr]::MoveToMonitorAndMaximize($handle, $X, $Y, $Width, $Height)
                }
                [WinMgr]::SetForegroundWindow($handle) | Out-Null
                    # Word restores from an iconic state asynchronously and
                    # can still report its minimized/off-screen rectangle on
                    # the first GetWindowRect immediately after SW_MAXIMIZE.
                    # Verify the final centre for a bounded interval instead
                    # of turning that harmless delay into a failed TAKE.
                    $lastRestoreRect = $null
                    for ($i = 0; $i -lt 20 -and -not $restoreSuccess; $i++) {
                        $rect = New-Object WinMgr+RECT
                        if ([WinMgr]::GetWindowRect($handle, [ref]$rect)) {
                            $lastRestoreRect = "$($rect.Left),$($rect.Top),$($rect.Right),$($rect.Bottom)"
                            $windowCenterX = [int](($rect.Left + $rect.Right) / 2)
                            $windowCenterY = [int](($rect.Top + $rect.Bottom) / 2)
                            $restoreSuccess = $placementApplied -and (
                                $windowCenterX -ge $X -and
                                $windowCenterX -lt ($X + $Width) -and
                                $windowCenterY -ge $Y -and
                                $windowCenterY -lt ($Y + $Height)
                            )
                            if ($restoreSuccess -and $Windowed -ne 0) {
                                $tolerance = 40
                                $restoreSuccess = (
                                    [Math]::Abs($rect.Left - $X) -le $tolerance -and
                                    [Math]::Abs($rect.Top - $Y) -le $tolerance -and
                                    [Math]::Abs(($rect.Right - $rect.Left) - $Width) -le ($tolerance * 2) -and
                                    [Math]::Abs(($rect.Bottom - $rect.Top) - $Height) -le ($tolerance * 2)
                                )
                            }
                        }
                        if (-not $restoreSuccess) { Start-Sleep -Milliseconds 100 }
                    }
                    if (-not $restoreSuccess) {
                        $restoreError = "Window did not move to the target monitor"
                        Log "restore position verify failed rect=$lastRestoreRect target=$X,$Y,$Width,$Height hwnd=$Hwnd"
                    }
                }
            }
        }
        [pscustomobject]@{
            success = $restoreSuccess
            error = if ($restoreSuccess) { $null } else { $restoreError }
        } | ConvertTo-Json -Compress
    }
    "close" {
        $closeSuccess = $false
        $windowGone = $false
        $closeError = ""
        if ($Hwnd -eq 0) {
            $windowGone = $true
            $closeSuccess = $true
        } else {
            $handle = [IntPtr]::new($Hwnd)
            if (-not [WinMgr]::IsWindow($handle)) {
                $windowGone = $true
                $closeSuccess = $true
            } else {
                $actualProcessId = 0
                [WinMgr]::GetWindowThreadProcessId($handle, [ref]$actualProcessId) | Out-Null
                if ($ProcessId -ne 0 -and $actualProcessId -ne $ProcessId) {
                    # The original window is already gone and its numeric HWND
                    # now belongs to somebody else. Do not touch the new owner.
                    $windowGone = $true
                    $closeSuccess = $true
                } elseif (-not (Test-WindowMatchesFingerprint $handle $FilePath $ExpectedWindowTitle $ExpectedWindowClass)) {
                    $closeError = "The tracked document window fingerprint changed; no window was touched"
                } else {
                    $posted = [WinMgr]::PostMessage(
                        $handle,
                        [WinMgr]::WM_CLOSE,
                        [IntPtr]::Zero,
                        [IntPtr]::Zero
                    )
                    if ($posted) {
                        for ($i = 0; $i -lt 50; $i++) {
                            if (-not [WinMgr]::IsWindow($handle)) {
                                $windowGone = $true
                                $closeSuccess = $true
                                break
                            }
                            Start-Sleep -Milliseconds 100
                        }
                    }
                    if (-not $closeSuccess) {
                        # Never terminate the process here: Word/Excel can be a
                        # user-owned host with unsaved documents. A save prompt
                        # or an ignored WM_CLOSE is reported honestly instead.
                        $closeError = if ($posted) {
                            "Window did not close (it may be waiting for user confirmation)"
                        } else {
                            "Windows rejected the close request"
                        }
                    }
                }
            }
        }
        Log "close verified success=$closeSuccess gone=$windowGone hwnd=$Hwnd"
        [pscustomobject]@{
            success = $closeSuccess
            windowGone = $windowGone
            error = if ($closeSuccess) { $null } else { $closeError }
        } | ConvertTo-Json -Compress
    }
    "hide-taskbar" {
        $taskbars = [WinMgr]::FindTaskbars()
        foreach ($tb in $taskbars) {
            $rect = New-Object WinMgr+RECT
            [WinMgr]::GetWindowRect($tb, [ref]$rect) | Out-Null
            $className = New-Object System.Text.StringBuilder -ArgumentList 256
            [WinMgr]::GetClassName($tb, $className, $className.Capacity) | Out-Null
            $isMainTaskbar = $className.ToString() -eq "Shell_TrayWnd"
            $intersectsProtectedDisplay = (
                $ProtectedWidth -gt 0 -and
                $ProtectedHeight -gt 0 -and
                $rect.Right -gt $ProtectedX -and
                $rect.Left -lt ($ProtectedX + $ProtectedWidth) -and
                $rect.Bottom -gt $ProtectedY -and
                $rect.Top -lt ($ProtectedY + $ProtectedHeight)
            )
            # The Windows-primary taskbar and the taskbar on the PDM control
            # display are operator UI. A transient topology snapshot must never
            # hide either of them. ShowWindow also repairs an earlier bad hide.
            if ($isMainTaskbar -or $intersectsProtectedDisplay) {
                [WinMgr]::ShowWindow($tb, [WinMgr]::SW_SHOW) | Out-Null
                Log "taskbar protected class=$($className.ToString()) rect=$($rect.Left),$($rect.Top),$($rect.Right),$($rect.Bottom)"
                continue
            }
            $intersectsDisplay = (
                $rect.Right -gt $X -and
                $rect.Left -lt ($X + $Width) -and
                $rect.Bottom -gt $Y -and
                $rect.Top -lt ($Y + $Height)
            )
            if ($intersectsDisplay) {
                [WinMgr]::ShowWindow($tb, [WinMgr]::SW_HIDE) | Out-Null
                Log "taskbar hidden class=$($className.ToString()) rect=$($rect.Left),$($rect.Top),$($rect.Right),$($rect.Bottom)"
            }
        }
        Write-Output '{"success":true}'
    }
    "show-taskbar-on-display" {
        $taskbars = [WinMgr]::FindTaskbars()
        foreach ($tb in $taskbars) {
            $rect = New-Object WinMgr+RECT
            [WinMgr]::GetWindowRect($tb, [ref]$rect) | Out-Null
            $intersectsDisplay = (
                $rect.Right -gt $X -and
                $rect.Left -lt ($X + $Width) -and
                $rect.Bottom -gt $Y -and
                $rect.Top -lt ($Y + $Height)
            )
            if ($intersectsDisplay) {
                [WinMgr]::ShowWindow($tb, [WinMgr]::SW_SHOW) | Out-Null
                Log "taskbar restored on display rect=$($rect.Left),$($rect.Top),$($rect.Right),$($rect.Bottom)"
            }
        }
        Write-Output '{"success":true}'
    }
    "show-taskbar" {
        $taskbars = [WinMgr]::FindTaskbars()
        foreach ($tb in $taskbars) {
            [WinMgr]::ShowWindow($tb, [WinMgr]::SW_SHOW) | Out-Null
        }
        Write-Output '{"success":true}'
    }
}
