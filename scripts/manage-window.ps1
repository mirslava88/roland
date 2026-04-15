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
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

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

    public const int SW_MINIMIZE = 6;
    public const int SW_SHOWMAXIMIZED = 3;
    public const int SW_RESTORE = 9;
    public const uint SWP_NOZORDER = 0x0004;
    public const uint WM_CLOSE = 0x0010;

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
}
"@

switch ($Action) {
    "open" {
        # Get existing windows with this filename before opening
        $searchName = [System.IO.Path]::GetFileNameWithoutExtension($FilePath)
        $existingWindows = [WinMgr]::FindWindowsByTitle($searchName)

        Start-Process -FilePath $FilePath

        # Wait for a window with the filename in title (up to 20 seconds)
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

            # Also check if an existing window got reactivated (Word reuses window)
            if ($i -gt 30 -and $windows.Count -gt 0) {
                # Word may reuse the same window handle — pick the first visible one
                $newWindow = $windows[0]
                break
            }
        }

        if ($newWindow -ne [IntPtr]::Zero) {
            $procId = 0
            [WinMgr]::GetWindowThreadProcessId($newWindow, [ref]$procId) | Out-Null
            [WinMgr]::ShowWindow($newWindow, [WinMgr]::SW_RESTORE) | Out-Null
            Start-Sleep -Milliseconds 200
            [WinMgr]::SetWindowPos($newWindow, [IntPtr]::Zero, $X, $Y, $Width, $Height, [WinMgr]::SWP_NOZORDER) | Out-Null
            Start-Sleep -Milliseconds 200
            [WinMgr]::ShowWindow($newWindow, [WinMgr]::SW_SHOWMAXIMIZED) | Out-Null
            [WinMgr]::SetForegroundWindow($newWindow) | Out-Null

            # Switch Word to Print Layout (disable Read Mode)
            $fileExt = [System.IO.Path]::GetExtension($FilePath).ToLower()
            if ($fileExt -in '.doc', '.docx', '.rtf', '.odt') {
                Start-Sleep -Milliseconds 500
                try {
                    $wordApp = [System.Runtime.InteropServices.Marshal]::GetActiveObject("Word.Application")
                    $wordApp.ActiveWindow.View.ReadingLayout = $false
                    $wordApp.ActiveWindow.View.Type = 3  # wdPrintView (Разметка страницы)
                    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($wordApp) | Out-Null
                } catch {}
            }

            Write-Output "{`"success`":true,`"hwnd`":$($newWindow.ToInt64()),`"pid`":$procId}"
        } else {
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
                [WinMgr]::ShowWindow($handle, [WinMgr]::SW_RESTORE) | Out-Null
                Start-Sleep -Milliseconds 100
                [WinMgr]::SetWindowPos($handle, [IntPtr]::Zero, $X, $Y, $Width, $Height, [WinMgr]::SWP_NOZORDER) | Out-Null
                Start-Sleep -Milliseconds 100
                [WinMgr]::ShowWindow($handle, [WinMgr]::SW_SHOWMAXIMIZED) | Out-Null
                [WinMgr]::SetForegroundWindow($handle) | Out-Null

                # Switch Word to Print Layout on restore too
                $fileExt = [System.IO.Path]::GetExtension($FilePath).ToLower()
                if ($fileExt -in '.doc', '.docx', '.rtf', '.odt') {
                    Start-Sleep -Milliseconds 300
                    try {
                        $wordApp = [System.Runtime.InteropServices.Marshal]::GetActiveObject("Word.Application")
                        $wordApp.ActiveWindow.View.ReadingLayout = $false
                        $wordApp.ActiveWindow.View.Type = 3  # wdPrintView
                        [System.Runtime.InteropServices.Marshal]::ReleaseComObject($wordApp) | Out-Null
                    } catch {}
                }
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
}
