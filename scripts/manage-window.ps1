param(
    [string]$Action,       # open, minimize, restore, close
    [string]$FilePath = "",
    [string]$FileName = "",
    [long]$Hwnd = 0,
    [int]$ProcessId = 0,
    [int]$X = 0,
    [int]$Y = 0,
    [int]$Width = 1920,
    [int]$Height = 1080
)

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
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

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

    // Move window to target monitor and maximize (fills entire screen).
    public static void MoveToMonitorAndMaximize(IntPtr hWnd, int monX, int monY, int monW, int monH) {
        int cx = monX + (monW / 2) - 400;
        int cy = monY + (monH / 2) - 300;
        ShowWindow(hWnd, SW_SHOWNORMAL);
        MoveWindow(hWnd, cx, cy, 800, 600, true);
        System.Threading.Thread.Sleep(200);
        ShowWindow(hWnd, SW_SHOWMAXIMIZED);
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

Log "=== Action=$Action FilePath=$FilePath X=$X Y=$Y W=$Width H=$Height Hwnd=$Hwnd ==="

switch ($Action) {
    "open" {
        $searchName = [System.IO.Path]::GetFileNameWithoutExtension($FilePath)
        $existingWindows = [WinMgr]::FindWindowsByTitle($searchName)

        Start-Process -FilePath $FilePath

        # Wait for window (up to 20 seconds)
        $newWindow = [IntPtr]::Zero
        for ($i = 0; $i -lt 200; $i++) {
            Start-Sleep -Milliseconds 100
            $windows = [WinMgr]::FindWindowsByTitle($searchName)
            foreach ($w in $windows) {
                if (-not $existingWindows.Contains($w)) {
                    $newWindow = $w
                    break
                }
            }
            if ($newWindow -ne [IntPtr]::Zero) { break }
            if ($i -gt 30 -and $windows.Count -gt 0) {
                $newWindow = $windows[0]
                break
            }
        }

        if ($newWindow -ne [IntPtr]::Zero) {
            $procId = 0
            [WinMgr]::GetWindowThreadProcessId($newWindow, [ref]$procId) | Out-Null
            Log "Found window hwnd=$($newWindow.ToInt64()) pid=$procId"

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

            # Move to target monitor and maximize
            [WinMgr]::MoveToMonitorAndMaximize($newWindow, $X, $Y, $Width, $Height)
            [WinMgr]::SetForegroundWindow($newWindow) | Out-Null

            # Log final position
            $rect = New-Object WinMgr+RECT
            [WinMgr]::GetWindowRect($newWindow, [ref]$rect) | Out-Null
            Log "Final GetWindowRect: L=$($rect.Left) T=$($rect.Top) R=$($rect.Right) B=$($rect.Bottom)"
            Log "Target monitor: X=$X Y=$Y W=$Width H=$Height"

            Write-Output "{`"success`":true,`"hwnd`":$($newWindow.ToInt64()),`"pid`":$procId}"
        } else {
            Log "Window not found for '$searchName'"
            Write-Output '{"success":true,"hwnd":0,"pid":0}'
        }
    }
    "minimize" {
        if ($Hwnd -ne 0) {
            $handle = [IntPtr]::new($Hwnd)
            if ([WinMgr]::IsWindow($handle)) {
                [WinMgr]::ShowWindow($handle, [WinMgr]::SW_MINIMIZE) | Out-Null
            }
        }
        Write-Output '{"success":true}'
    }
    "restore" {
        if ($Hwnd -ne 0) {
            $handle = [IntPtr]::new($Hwnd)
            if ([WinMgr]::IsWindow($handle)) {
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

                [WinMgr]::MoveToMonitorAndMaximize($handle, $X, $Y, $Width, $Height)
                [WinMgr]::SetForegroundWindow($handle) | Out-Null
            }
        }
        Write-Output '{"success":true}'
    }
    "close" {
        if ($Hwnd -ne 0) {
            $handle = [IntPtr]::new($Hwnd)
            if ([WinMgr]::IsWindow($handle)) {
                [WinMgr]::PostMessage($handle, [WinMgr]::WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
            }
        }
        if ($ProcessId -ne 0) {
            Start-Sleep -Milliseconds 500
            try {
                $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
                if ($proc -and !$proc.HasExited) {
                    $proc.CloseMainWindow() | Out-Null
                }
            } catch {}
        }
        Write-Output '{"success":true}'
    }
    "hide-taskbar" {
        $taskbars = [WinMgr]::FindTaskbars()
        foreach ($tb in $taskbars) {
            $rect = New-Object WinMgr+RECT
            [WinMgr]::GetWindowRect($tb, [ref]$rect) | Out-Null
            if ($rect.Left -ge $X -and $rect.Left -lt ($X + $Width)) {
                [WinMgr]::ShowWindow($tb, [WinMgr]::SW_HIDE) | Out-Null
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
