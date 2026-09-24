$ErrorActionPreference = 'Continue'
[Console]::InputEncoding  = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding           = [System.Text.Encoding]::UTF8
. (Join-Path $PSScriptRoot 'powerpoint-linked-pictures.ps1')

# Win32 primitives:
#  - SetWindowPos — drop WS_EX_TOPMOST from PP's slideshow window via
#    HWND_NOTOPMOST, so the Electron screen-saver overlay (topmost) stays
#    above the slideshow during channel switches. Without this the two
#    HWND_TOPMOST windows race and PP's new slideshow flashes above the
#    overlay before the overlay fades.
#  - ShowWindow(SW_HIDE) — synchronously hides PP editor HWND. $ppt.Visible=1
#    is required for Run()/Export on some PP versions, and the editor window
#    would otherwise flash on the external display for the 200-700ms of
#    Presentations.Open + Run(). $ppt.WindowState=2 (ppWindowMinimized) is
#    async (100-300ms) — not fast enough. SW_HIDE hides synchronously before
#    the next paint tick.
if (-not ('PptDaemon.Native' -as [type])) {
    Add-Type -ReferencedAssemblies System.Drawing -Name Native -Namespace PptDaemon -UsingNamespace System.Text,System.Collections.Generic -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("winmm.dll", EntryPoint = "timeBeginPeriod")]
public static extern uint TimeBeginPeriod(uint uPeriod);
[System.Runtime.InteropServices.DllImport("dwmapi.dll")]
public static extern int DwmFlush();
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
public static extern bool SetWindowPos(System.IntPtr hWnd, System.IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
public static extern System.IntPtr BeginDeferWindowPos(int count);
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
public static extern System.IntPtr DeferWindowPos(System.IntPtr batch, System.IntPtr hwnd, System.IntPtr after, int x, int y, int width, int height, uint flags);
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
public static extern bool EndDeferWindowPos(System.IntPtr batch);
public static bool PromoteWarmedOutput(System.IntPtr next, System.IntPtr previous) {
    if (next == System.IntPtr.Zero || previous == System.IntPtr.Zero || next == previous ||
        !IsWindow(next) || !IsWindow(previous)) return false;
    System.IntPtr batch = BeginDeferWindowPos(2);
    if (batch == System.IntPtr.Zero) return false;
    // NOACTIVATE | NOMOVE | NOSIZE: change only prepared windows' Z-order,
    // together in one screen-refreshing cycle.
    batch = DeferWindowPos(batch, next, System.IntPtr.Zero, 0, 0, 0, 0, 0x13);
    if (batch == System.IntPtr.Zero) return false;
    batch = DeferWindowPos(batch, previous, new System.IntPtr(1), 0, 0, 0, 0, 0x13);
    return batch != System.IntPtr.Zero && EndDeferWindowPos(batch);
}
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
public static extern int SetWindowRgn(System.IntPtr hWnd, System.IntPtr hRgn, bool bRedraw);
[System.Runtime.InteropServices.DllImport("gdi32.dll", SetLastError = true)]
public static extern System.IntPtr CreateRectRgn(int left, int top, int right, int bottom);
[System.Runtime.InteropServices.DllImport("gdi32.dll", SetLastError = true)]
public static extern System.IntPtr CreateRoundRectRgn(int left, int top, int right, int bottom, int width, int height);
[System.Runtime.InteropServices.DllImport("gdi32.dll")]
public static extern bool DeleteObject(System.IntPtr hObject);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern System.IntPtr SetThreadDpiAwarenessContext(System.IntPtr dpiContext);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true, CharSet = System.Runtime.InteropServices.CharSet.Auto)]
public static extern int GetClassName(System.IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool IsWindowVisible(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint processId);
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
public static extern int GetWindowLong(System.IntPtr hWnd, int nIndex);
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
public static extern int SetWindowLong(System.IntPtr hWnd, int nIndex, int value);
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
public static extern bool SetLayeredWindowAttributes(System.IntPtr hwnd, uint key, byte alpha, uint flags);
private static readonly object _transparentEditorLock = new object();
private static long _transparentEditorHwnd;
private static long _transparentEditorPid;
private static int _transparentEditorStyle;
private static long _linkedPicturesScope;
private static long _linkedPicturesScopePid;
public static long BeginLinkedPicturesEditorScope(long processId) {
    lock (_transparentEditorLock) { _linkedPicturesScopePid = processId; return ++_linkedPicturesScope; }
}
public static bool ExposeEditorForLinkedPictures(long hwnd, long processId, long scope) {
    lock (_transparentEditorLock) {
        if (scope <= 0 || scope != _linkedPicturesScope || processId != _linkedPicturesScopePid) return false;
        var window = (System.IntPtr)hwnd;
        if (hwnd == 0 || processId <= 0 || !IsWindow(window) || GetWindowProcessId(hwnd) != processId) return false;
        var name = new System.Text.StringBuilder(64);
        GetClassName(window, name, name.Capacity);
        if (name.ToString() != "PPTFrameClass") return false;
        if (_transparentEditorHwnd == hwnd) {
            // Open/Run can hide the editor again after the scope was armed.
            // Keep its alpha=0 frame accessible until command completion.
            return SetWindowPos(window, new System.IntPtr(1), 0, 0, 0, 0, 0x53);
        }
        if (_transparentEditorHwnd != 0) return false;
        int style = GetWindowLong(window, -20);
        // Do not overwrite pre-existing transparency from Office/add-ins.
        if ((style & 0x80000) != 0) return false;
        ShowWindow(window, 0);
        SetWindowLong(window, -20, style | 0x80000);
        if (!SetLayeredWindowAttributes(window, 0, 0, 2)) {
            SetWindowLong(window, -20, style);
            return false;
        }
        _transparentEditorPid = processId;
        _transparentEditorStyle = style;
        System.Threading.Interlocked.Exchange(ref _transparentEditorHwnd, hwnd);
        // Visible to accessibility, alpha=0 to the operator/audience; bottom
        // Z-order, no activation, no geometry changes, no slideshow HWNDs.
        if (SetWindowPos(window, new System.IntPtr(1), 0, 0, 0, 0, 0x53)) return true;
        RestoreLinkedPicturesEditor();
        return false;
    }
}
public static void RestoreLinkedPicturesEditor() {
    lock (_transparentEditorLock) {
        _linkedPicturesScope++;
        _linkedPicturesScopePid = 0;
        long hwnd = System.Threading.Interlocked.Read(ref _transparentEditorHwnd);
        if (hwnd == 0) return;
        var window = (System.IntPtr)hwnd;
        if (IsWindow(window) && GetWindowProcessId(hwnd) == _transparentEditorPid) {
            ShowWindow(window, 0); // hide BEFORE removing alpha=0
            SetWindowLong(window, -20, _transparentEditorStyle);
        }
        System.Threading.Interlocked.Exchange(ref _transparentEditorHwnd, 0);
        _transparentEditorPid = 0;
    }
}
public delegate bool EnumWindowsProc(System.IntPtr hWnd, System.IntPtr lParam);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, System.IntPtr lParam);

[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
public struct POINT { public int X; public int Y; }
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
public struct WINDOWPLACEMENT {
    public int length;
    public int flags;
    public int showCmd;
    public POINT ptMinPosition;
    public POINT ptMaxPosition;
    public RECT rcNormalPosition;
}
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool GetWindowRect(System.IntPtr hWnd, out RECT lpRect);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool GetWindowPlacement(System.IntPtr hWnd, ref WINDOWPLACEMENT lpwndpl);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool GetClientRect(System.IntPtr hWnd, out RECT lpRect);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool ClientToScreen(System.IntPtr hWnd, ref POINT lpPoint);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool GetCursorPos(out POINT lpPoint);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool SetCursorPos(int X, int Y);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern System.IntPtr GetForegroundWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool SetForegroundWindow(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool IsWindow(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, System.UIntPtr dwExtraInfo);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool PrintWindow(System.IntPtr hWnd, System.IntPtr hdcBlt, uint nFlags);

// Find all visible "screenClass" (PP slideshow) top-level HWNDs. Used by
// parallel poller to catch the NEWLY-created slideshow window the instant
// PP spawns it during Run(), before the DWM compositor paints a frame with
// it topmost above our overlay.
public static System.Collections.Generic.List<long> FindSlideShowHwnds() {
    var result = new System.Collections.Generic.List<long>();
    EnumWindows((hWnd, lParam) => {
        var sb = new System.Text.StringBuilder(64);
        GetClassName(hWnd, sb, sb.Capacity);
        if (sb.ToString() == "screenClass" && IsWindowVisible(hWnd)) {
            result.Add(hWnd.ToInt64());
        }
        return true;
    }, System.IntPtr.Zero);
    return result;
}

// Application.HWND is 0 on some 32-bit Office builds when automated from a
// 64-bit PowerShell host. Enumerate the real editor frame as a fallback so its
// visibility and placement can still be captured/restored reliably.
public static System.Collections.Generic.List<long> FindPowerPointEditorHwnds() {
    var result = new System.Collections.Generic.List<long>();
    EnumWindows((hWnd, lParam) => {
        var sb = new System.Text.StringBuilder(64);
        GetClassName(hWnd, sb, sb.Capacity);
        if (sb.ToString() == "PPTFrameClass") result.Add(hWnd.ToInt64());
        return true;
    }, System.IntPtr.Zero);
    return result;
}

// Hide PDM's editor frames before DWM can paint them. New-Object -ComObject
// PowerPoint.Application can create and show PPTFrameClass before PowerShell
// gets the COM object back, so setting WindowState/Visible afterwards is too
// late on slower machines. During creation processId=0 and existingHwnds are
// protected; once the PDM PowerPoint PID is known the guard filters by PID and
// can safely stay active without touching a user's independent PowerPoint.
private static volatile bool _editorGuardStop = true;
private static System.Threading.Thread _editorGuardThread;
public static long EditorGuardFoundHwnd = 0;
public static int EditorGuardHideCount = 0;
public static string EditorGuardError = "";

public static long GetWindowProcessId(long hwnd) {
    uint pid;
    GetWindowThreadProcessId((System.IntPtr)hwnd, out pid);
    return pid;
}

public static void StartPowerPointEditorGuard(long processId, long[] existingHwnds) {
    StopPowerPointEditorGuard();
    var protectedWindows = new System.Collections.Generic.HashSet<long>(existingHwnds ?? new long[0]);
    EditorGuardFoundHwnd = 0;
    EditorGuardHideCount = 0;
    EditorGuardError = "";
    _editorGuardStop = false;
    _editorGuardThread = new System.Threading.Thread(() => {
        try { SetThreadDpiAwarenessContext((System.IntPtr)(-4)); } catch {}
        while (!_editorGuardStop) {
            try {
                foreach (var hwnd in FindPowerPointEditorHwnds()) {
                    if (processId > 0) {
                        if (GetWindowProcessId(hwnd) != processId) continue;
                    } else if (protectedWindows.Contains(hwnd)) {
                        continue;
                    }
                    if (hwnd == System.Threading.Interlocked.Read(ref _transparentEditorHwnd)) continue;
                    EditorGuardFoundHwnd = hwnd;
                    if (IsWindowVisible((System.IntPtr)hwnd)) {
                        ShowWindow((System.IntPtr)hwnd, 0);
                        EditorGuardHideCount++;
                    }
                }
            } catch (System.Exception ex) {
                EditorGuardError = ex.Message;
            }
            System.Threading.Thread.Sleep(1);
        }
    });
    _editorGuardThread.IsBackground = true;
    _editorGuardThread.Priority = System.Threading.ThreadPriority.Highest;
    _editorGuardThread.Start();
}

public static void StopPowerPointEditorGuard() {
    _editorGuardStop = true;
    var thread = _editorGuardThread;
    if (thread != null && thread != System.Threading.Thread.CurrentThread && thread.IsAlive) {
        try { thread.Join(100); } catch {}
    }
    _editorGuardThread = null;
}

// A dedicated CLR thread starts synchronously before the blocking COM Run().
// PowerShell runspaces can be scheduled too late (observed iterations=0),
// allowing PowerPoint's new topmost HWND to reach DWM for one frame. This
// guard is already running before Run(), hides the new screenClass immediately,
// then drops topmost and positions it. PowerShell reveals it only after setup.
private static volatile bool _slideGuardStop = true;
private static volatile bool _slideGuardStarted = false;
private static System.Threading.Thread _slideGuardThread;
public static long SlideGuardFoundHwnd = 0;
public static long SlideGuardCaughtTicks = 0;
public static int SlideGuardIterations = 0;
public static int SlideGuardExStyleBefore = 0;
public static string SlideGuardError = "";

public static void StartSlideShowGuard(long[] oldHwnds, int x, int y, int width, int height) {
    StopSlideShowGuard();
    var oldWindows = new System.Collections.Generic.HashSet<long>(oldHwnds ?? new long[0]);
    SlideGuardFoundHwnd = 0;
    SlideGuardCaughtTicks = 0;
    SlideGuardIterations = 0;
    SlideGuardExStyleBefore = 0;
    SlideGuardError = "";
    _slideGuardStop = false;
    _slideGuardStarted = false;
    _slideGuardThread = new System.Threading.Thread(() => {
        _slideGuardStarted = true;
        try { SetThreadDpiAwarenessContext((System.IntPtr)(-4)); } catch {}
        var deadline = System.DateTime.UtcNow.AddSeconds(10);
        while (!_slideGuardStop && System.DateTime.UtcNow < deadline) {
            try {
                SlideGuardIterations++;
                foreach (var hwnd in FindSlideShowHwnds()) {
                    if (oldWindows.Contains(hwnd)) continue;
                    var h = (System.IntPtr)hwnd;
                    try { SlideGuardExStyleBefore = GetWindowLong(h, -20); } catch {}
                    // SW_HIDE synchronously prevents the first slideshow frame.
                    ShowWindow(h, 0);
                    if (width > 0 && height > 0) {
                        SetWindowPos(h, (System.IntPtr)(-2), x, y, width, height, 0x10);
                    } else {
                        SetWindowPos(h, (System.IntPtr)(-2), 0, 0, 0, 0, 0x13);
                    }
                    SlideGuardFoundHwnd = hwnd;
                    SlideGuardCaughtTicks = System.DateTime.UtcNow.Ticks;
                    // PowerPoint may call ShowWindow again near the end of
                    // Run(). Keep suppressing that same HWND until PowerShell
                    // explicitly stops the guard and performs the final reveal.
                    while (!_slideGuardStop && System.DateTime.UtcNow < deadline) {
                        try {
                            if (IsWindowVisible(h)) ShowWindow(h, 0);
                            if (width > 0 && height > 0) {
                                SetWindowPos(h, (System.IntPtr)(-2), x, y, width, height, 0x10);
                            }
                        } catch {}
                        System.Threading.Thread.Sleep(1);
                    }
                    return;
                }
            } catch (System.Exception ex) {
                SlideGuardError = ex.Message;
            }
            System.Threading.Thread.Sleep(1);
        }
    });
    _slideGuardThread.IsBackground = true;
    _slideGuardThread.Priority = System.Threading.ThreadPriority.Highest;
    _slideGuardThread.Start();

    // Yield until the polling thread is definitely running before COM Run().
    var startWait = System.Diagnostics.Stopwatch.StartNew();
    while (!_slideGuardStarted && startWait.ElapsedMilliseconds < 250) {
        System.Threading.Thread.Sleep(0);
    }
}

public static void StopSlideShowGuard() {
    _slideGuardStop = true;
    var thread = _slideGuardThread;
    if (thread != null && thread != System.Threading.Thread.CurrentThread && thread.IsAlive) {
        try { thread.Join(100); } catch {}
    }
    _slideGuardThread = null;
}

// Capture a WINDOW's pixels directly via PrintWindow, bypassing the DWM
// screen composite. Works even when the target window is covered by other
// windows (our overlay). PW_RENDERFULLCONTENT=0x2 (Win8.1+) forces PP's
// DirectWrite/DirectX-accelerated slideshow content to render into the
// bitmap — without this flag PP returns a mostly-blank image.
// Saves PNG to outPath. Returns true on success.
public static bool SnapshotWindowToPng(long hwnd, string outPath) {
    System.IntPtr h = (System.IntPtr)hwnd;
    RECT r;
    if (!GetWindowRect(h, out r)) return false;
    int w = r.Right - r.Left;
    int hh = r.Bottom - r.Top;
    if (w <= 0 || hh <= 0) return false;
    using (var bmp = new System.Drawing.Bitmap(w, hh, System.Drawing.Imaging.PixelFormat.Format32bppArgb)) {
        using (var g = System.Drawing.Graphics.FromImage(bmp)) {
            System.IntPtr hdc = g.GetHdc();
            try { PrintWindow(h, hdc, 0x00000002); }
            finally { g.ReleaseHdc(hdc); }
        }
        bmp.Save(outPath, System.Drawing.Imaging.ImageFormat.Png);
    }
    return true;
}
'@
}

# SetWindowPos must consume the physical-pixel bounds sent by Electron without
# Windows applying another 125/150/175% DPI virtualization pass. PowerShell is
# otherwise commonly system-DPI-aware, which makes a slideshow larger than a
# scaled secondary monitor and clips its right/bottom edges.
try {
    # DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4
    [PptDaemon.Native]::SetThreadDpiAwarenessContext([System.IntPtr](-4)) | Out-Null
} catch {}

# Force 1ms system-timer resolution. Windows default is ~15.6ms, which makes
# Start-Sleep -Milliseconds 2 round up to a full tick — leaving a gap larger
# than a DWM frame (16.67ms) between poller iterations. With 1ms granularity
# our parallel poller inside Run() gets ~3ms per iteration, beating the race.
# Scope: per-process until daemon exits; harmless elsewhere.
[PptDaemon.Native]::TimeBeginPeriod(1) | Out-Null

function Set-NotTopmost([long]$hwnd) {
    if ($hwnd -eq 0) { return }
    # HWND_NOTOPMOST = -2; SWP_NOSIZE=1 | SWP_NOMOVE=2 | SWP_NOACTIVATE=16 = 0x13
    try {
        [PptDaemon.Native]::SetWindowPos(
            [System.IntPtr]$hwnd,
            [System.IntPtr]-2,
            0, 0, 0, 0, 0x13
        ) | Out-Null
    } catch {}
}

function Set-SlideShowBounds([long]$hwnd, $targetRect) {
    if ($hwnd -eq 0) { return }
    if ($null -eq $targetRect -or $targetRect.Count -ne 4) {
        Set-NotTopmost $hwnd
        return
    }

    # HWND_NOTOPMOST=-2; SWP_NOACTIVATE=0x10. Move and size the borderless
    # slideshow to the exact physical-pixel bounds supplied by Electron.
    try {
        [PptDaemon.Native]::SetWindowPos(
            [System.IntPtr]$hwnd,
            [System.IntPtr]-2,
            [int]$targetRect[0], [int]$targetRect[1],
            [int]$targetRect[2], [int]$targetRect[3],
            0x10
        ) | Out-Null
    } catch {}
}

function Set-SlideShowClip([long]$hwnd, $targetRect, $clipRect, [int]$cornerRadius) {
    if ($hwnd -eq 0) { return }
    if ($null -eq $clipRect -or $clipRect.Count -ne 4 -or
        $null -eq $targetRect -or $targetRect.Count -ne 4) {
        try { [PptDaemon.Native]::SetWindowRgn([System.IntPtr]$hwnd, [System.IntPtr]::Zero, $true) | Out-Null } catch {}
        return
    }
    $left = [int]$clipRect[0] - [int]$targetRect[0]
    $top = [int]$clipRect[1] - [int]$targetRect[1]
    $right = $left + [int]$clipRect[2]
    $bottom = $top + [int]$clipRect[3]
    $region = [System.IntPtr]::Zero
    try {
        if ($cornerRadius -gt 0) {
            $diameter = [Math]::Max(2, $cornerRadius * 2)
            $region = [PptDaemon.Native]::CreateRoundRectRgn($left, $top, $right + 1, $bottom + 1, $diameter, $diameter)
        } else {
            $region = [PptDaemon.Native]::CreateRectRgn($left, $top, $right, $bottom)
        }
        if ($region -ne [System.IntPtr]::Zero) {
            $accepted = [PptDaemon.Native]::SetWindowRgn([System.IntPtr]$hwnd, $region, $true)
            if ($accepted -ne 0) {
                # Windows owns the region after a successful SetWindowRgn.
                $region = [System.IntPtr]::Zero
            }
        }
    } catch {} finally {
        if ($region -ne [System.IntPtr]::Zero) {
            try { [PptDaemon.Native]::DeleteObject($region) | Out-Null } catch {}
        }
    }
}

function Get-SlideShowWindowRect([long]$hwnd) {
    if ($hwnd -eq 0) { return $null }
    try {
        $rect = New-Object PptDaemon.Native+RECT
        if ([PptDaemon.Native]::GetWindowRect([System.IntPtr]$hwnd, [ref]$rect)) {
            $width = [int]$rect.Right - [int]$rect.Left
            $height = [int]$rect.Bottom - [int]$rect.Top
            if ($width -gt 0 -and $height -gt 0) {
                return @([int]$rect.Left, [int]$rect.Top, $width, $height)
            }
        }
    } catch {}
    return $null
}

function Move-SlideShowBoundsAnimated([long]$hwnd, $targetRect, [int]$durationMs) {
    if ($hwnd -eq 0 -or $null -eq $targetRect -or $targetRect.Count -ne 4) { return }
    $startRect = Get-SlideShowWindowRect $hwnd
    $durationMs = [Math]::Max(0, [Math]::Min(5000, $durationMs))
    if ($durationMs -lt 50 -or $null -eq $startRect -or $startRect.Count -ne 4) {
        Set-SlideShowBounds $hwnd $targetRect
        return
    }

    $changed = $false
    for ($i = 0; $i -lt 4; $i++) {
        if ([Math]::Abs([int]$startRect[$i] - [int]$targetRect[$i]) -gt 1) {
            $changed = $true
            break
        }
    }
    if (-not $changed) {
        Set-SlideShowBounds $hwnd $targetRect
        return
    }

    # Match the renderer's gentle ease-in-out movement. DwmFlush keeps every
    # resize aligned to a compositor frame instead of producing a fast Win32
    # jump followed by the slower camera animation.
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    while ($watch.ElapsedMilliseconds -lt $durationMs) {
        $progress = [Math]::Min(1.0, [double]$watch.ElapsedMilliseconds / [double]$durationMs)
        $eased = 0.5 - ([Math]::Cos([Math]::PI * $progress) / 2.0)
        $frameRect = @(
            [int][Math]::Round([double]$startRect[0] + ([double]$targetRect[0] - [double]$startRect[0]) * $eased),
            [int][Math]::Round([double]$startRect[1] + ([double]$targetRect[1] - [double]$startRect[1]) * $eased),
            [Math]::Max(1, [int][Math]::Round([double]$startRect[2] + ([double]$targetRect[2] - [double]$startRect[2]) * $eased)),
            [Math]::Max(1, [int][Math]::Round([double]$startRect[3] + ([double]$targetRect[3] - [double]$startRect[3]) * $eased))
        )
        Set-SlideShowBounds $hwnd $frameRect
        try { [PptDaemon.Native]::DwmFlush() | Out-Null } catch { Start-Sleep -Milliseconds 8 }
    }
    $watch.Stop()
    Set-SlideShowBounds $hwnd $targetRect
}

function Test-SlideShowBounds([long]$hwnd, $targetRect) {
    if ($null -eq $targetRect -or $targetRect.Count -ne 4) { return $false }
    $actual = Get-SlideShowWindowRect $hwnd
    if ($null -eq $actual -or $actual.Count -ne 4) { return $false }

    $targetX = [int]$targetRect[0]; $targetY = [int]$targetRect[1]
    $targetW = [int]$targetRect[2]; $targetH = [int]$targetRect[3]
    $centerX = [int]$actual[0] + [int]($actual[2] / 2)
    $centerY = [int]$actual[1] + [int]($actual[3] / 2)
    $centerMatches = (
        $centerX -ge $targetX -and $centerX -lt ($targetX + $targetW) -and
        $centerY -ge $targetY -and $centerY -lt ($targetY + $targetH)
    )
    # Allow a small DWM/invisible-frame tolerance, but reject a slideshow that
    # merely overlaps the requested monitor or kept the previous monitor size.
    $sizeMatches = (
        [Math]::Abs([int]$actual[2] - $targetW) -le 32 -and
        [Math]::Abs([int]$actual[3] - $targetH) -le 32
    )
    return $centerMatches -and $sizeMatches
}

function Raise-SlideShow([long]$hwnd, $targetRect) {
    if ($hwnd -eq 0) { return }
    # HWND_TOP=0 keeps the slideshow non-topmost (the screen-saver overlay
    # still covers it) but places it above the warm fullscreen Electron PDF
    # window. Without this, PDF remained visible after a successful PP Run().
    try {
        if ($null -ne $targetRect -and $targetRect.Count -eq 4) {
            [PptDaemon.Native]::SetWindowPos(
                [System.IntPtr]$hwnd,
                [System.IntPtr]0,
                [int]$targetRect[0], [int]$targetRect[1],
                [int]$targetRect[2], [int]$targetRect[3],
                0x10
            ) | Out-Null
        } else {
            [PptDaemon.Native]::SetWindowPos(
                [System.IntPtr]$hwnd,
                [System.IntPtr]0,
                0, 0, 0, 0, 0x13
            ) | Out-Null
        }
    } catch {}
}

function Lower-Window([long]$hwnd) {
    if ($hwnd -eq 0) { return }
    # HWND_BOTTOM=1. The persistent Electron output must stay alive while the
    # PowerPoint surface warms up, but once the surface is ready it must sit
    # below that surface. Some GPU/Windows combinations keep Electron above a
    # later HWND_TOP promotion, so explicitly order both sides of the swap.
    try {
        [PptDaemon.Native]::SetWindowPos(
            [System.IntPtr]$hwnd,
            [System.IntPtr]1,
            0, 0, 0, 0, 0x13
        ) | Out-Null
    } catch {}
}

function Place-SlideShowBehind([long]$hwnd, [long]$coverHwnd, $targetRect) {
    if ($hwnd -eq 0 -or $coverHwnd -eq 0 -or $hwnd -eq $coverHwnd) { return }
    try {
        if ($null -ne $targetRect -and $targetRect.Count -eq 4) {
            [PptDaemon.Native]::SetWindowPos(
                [System.IntPtr]$hwnd,
                [System.IntPtr]$coverHwnd,
                [int]$targetRect[0], [int]$targetRect[1],
                [int]$targetRect[2], [int]$targetRect[3],
                0x10
            ) | Out-Null
        } else {
            [PptDaemon.Native]::SetWindowPos(
                [System.IntPtr]$hwnd,
                [System.IntPtr]$coverHwnd,
                0, 0, 0, 0, 0x13
            ) | Out-Null
        }
    } catch {}
}

function Get-PPEditorHwnd($ppt) {
    $hwnd = 0
    try { $hwnd = [long]$ppt.HWND } catch {}
    if ($hwnd -eq 0) {
        try { $hwnd = [long]$ppt.ActiveWindow.HWND } catch {}
    }
    if ($hwnd -eq 0) {
        try {
            $candidates = @([PptDaemon.Native]::FindPowerPointEditorHwnds())
            foreach ($candidate in $candidates) {
                if ([PptDaemon.Native]::IsWindowVisible([System.IntPtr]$candidate)) {
                    $hwnd = [long]$candidate
                }
            }
            if ($hwnd -eq 0 -and $candidates.Count -gt 0) {
                $hwnd = [long]$candidates[$candidates.Count - 1]
            }
        } catch {}
    }
    return $hwnd
}

function Hide-PPEditor($ppt) {
    # SW_HIDE = 0. Application.Visible COM property stays true — Run() /
    # Presentations.Open / Slide.Export all work via internal PP pipelines
    # that don't require the editor HWND to be on screen.
    try {
        $hwnd = Get-PPEditorHwnd $ppt
        if ($hwnd -ne 0) {
            [PptDaemon.Native]::ShowWindow([System.IntPtr]$hwnd, 0) | Out-Null
        }
    } catch {}
}

# PowerPoint treats a video configured as "When Clicked On" as an interactive
# shape trigger, not as the next item in the slide's normal click sequence.
# SlideShowView.Next() therefore skips straight to the next slide instead of
# activating that trigger. A hardware presenter only sends PageDown/Right, so
# bridge the first presenter click to a real click on the media shape. Calling
# SlideShowView.Player(shapeId).Play() is unsafe for some built-in PowerPoint
# templates: while State=ppNotReady the COM call can block for minutes and even
# crash POWERPNT.EXE. A real shape click follows PowerPoint's own interactive
# trigger path and returns immediately.
$script:startedSlideVideos = @{}
$script:activeSlideShowHwnd = 0
$script:activeSlideShowWindow = $null
$script:activePresentation = $null
$script:activePresentationPath = ''
$script:idleHostHoldUntilUtc = [DateTime]::MinValue
$script:mediaReturnForegroundHwnd = 0
$script:pptApplication = $null
$script:pptSessionInitialized = $false
$script:pptOwnedByRoland = $false
$script:pptOriginalVisible = 0
$script:pptOriginalWindowState = 1
$script:pptOriginalEditorHwnd = 0
$script:pptOriginalEditorWasVisible = $false
$script:pptOriginalEditorRect = $null
$script:pptRegistryWindowSnapshot = $null
$script:managedPresentationKeys = @{}
$script:managedPresentationIdentities = @{}
$script:unidentifiedManagedPresentations = New-Object System.Collections.ArrayList
$script:preparedPresentationKeys = @{}
$script:lastManagedPresentationCloseOk = $true
$script:openTransaction = $null
$script:lastOpenTransactionOk = $true
$script:lastPowerPointSessionCleanupOk = $true
$script:lastIdleOwnedPowerPointHostReleaseOk = $true
$script:pptOwnedProcessId = 0
$script:pptOwnedProcessStartTimeUtcTicks = 0L
$script:pptSessionUncertain = $false

function Restore-MediaForeground {
    $hwnd = [long]$script:mediaReturnForegroundHwnd
    $script:mediaReturnForegroundHwnd = 0
    if ($hwnd -eq 0) { return }
    try {
        if ([PptDaemon.Native]::IsWindow([System.IntPtr]$hwnd)) {
            [PptDaemon.Native]::SetForegroundWindow([System.IntPtr]$hwnd) | Out-Null
        }
    } catch {}
}

function Reset-SlideVideoClickState {
    $script:startedSlideVideos = @{}
    Restore-MediaForeground
}

function Get-SlideVideoShapes($view) {
    $items = @()
    try {
        $slide = $view.Slide
        for ($i = 1; $i -le $slide.Shapes.Count; $i++) {
            $shape = $slide.Shapes.Item($i)
            $shapeType = -1
            try { $shapeType = [int]$shape.Type } catch {}
            if ($shapeType -ne 16) { continue } # msoMedia

            # ppMediaTypeMovie=3. If an older Office build cannot expose
            # MediaType, keep the msoMedia shape as a candidate.
            $mediaType = -1
            try { $mediaType = [int]$shape.MediaType } catch {}
            if ($mediaType -ne -1 -and $mediaType -ne 3) { continue }

            $playOnEntry = $false
            try { $playOnEntry = [bool]$shape.AnimationSettings.PlaySettings.PlayOnEntry } catch {}

            $items += [PSCustomObject]@{
                ShapeId = [int]$shape.Id
                Name = [string]$shape.Name
                Left = [double]$shape.Left
                Top = [double]$shape.Top
                Width = [double]$shape.Width
                Height = [double]$shape.Height
                PlayOnEntry = $playOnEntry
            }
        }
    } catch {
        Log "video scan failed: $($_.Exception.Message)"
    }
    return @($items)
}

function Resolve-SlideShowHwnd {
    $hwnd = [long]$script:activeSlideShowHwnd
    try {
        if ($hwnd -ne 0 -and [PptDaemon.Native]::IsWindow([System.IntPtr]$hwnd)) {
            return $hwnd
        }
    } catch {}

    # SlideShowWindow.HWND is missing on some Office builds. The open poller
    # normally records the exact handle; this is a safe fallback for a single
    # visible slideshow.
    try {
        $handles = @([PptDaemon.Native]::FindSlideShowHwnds())
        if ($handles.Count -gt 0) {
            $hwnd = [long]$handles[$handles.Count - 1]
            $script:activeSlideShowHwnd = $hwnd
            return $hwnd
        }
    } catch {}
    return 0
}

function Invoke-SlideShowShapeClick($view, $video) {
    $hwnd = Resolve-SlideShowHwnd
    if ($hwnd -eq 0) {
        Log "video click: slideshow HWND unavailable shape=$($video.ShapeId)"
        return $false
    }

    try {
        $client = New-Object PptDaemon.Native+RECT
        if (-not [PptDaemon.Native]::GetClientRect([System.IntPtr]$hwnd, [ref]$client)) {
            throw 'GetClientRect failed'
        }
        $clientWidth = $client.Right - $client.Left
        $clientHeight = $client.Bottom - $client.Top
        $presentation = $view.Slide.Parent
        $slideWidth = [double]$presentation.PageSetup.SlideWidth
        $slideHeight = [double]$presentation.PageSetup.SlideHeight
        if ($clientWidth -le 0 -or $clientHeight -le 0 -or $slideWidth -le 0 -or $slideHeight -le 0) {
            throw "invalid geometry client=${clientWidth}x${clientHeight} slide=${slideWidth}x${slideHeight}"
        }

        # PowerPoint letterboxes the slide while preserving its aspect ratio.
        # Convert the media shape's point coordinates into physical client
        # pixels, then into the virtual desktop coordinates used by SetCursorPos.
        $scale = [Math]::Min($clientWidth / $slideWidth, $clientHeight / $slideHeight)
        $offsetX = ($clientWidth - $slideWidth * $scale) / 2
        $offsetY = ($clientHeight - $slideHeight * $scale) / 2
        $x = [int][Math]::Round($offsetX + ($video.Left + $video.Width / 2) * $scale)
        $y = [int][Math]::Round($offsetY + ($video.Top + $video.Height / 2) * $scale)
        $x = [Math]::Max(1, [Math]::Min($clientWidth - 2, $x))
        $y = [Math]::Max(1, [Math]::Min($clientHeight - 2, $y))

        $origin = New-Object PptDaemon.Native+POINT
        $origin.X = 0
        $origin.Y = 0
        if (-not [PptDaemon.Native]::ClientToScreen([System.IntPtr]$hwnd, [ref]$origin)) {
            throw 'ClientToScreen failed'
        }
        $oldCursor = New-Object PptDaemon.Native+POINT
        [PptDaemon.Native]::GetCursorPos([ref]$oldCursor) | Out-Null
        $oldForeground = [PptDaemon.Native]::GetForegroundWindow()

        try {
            [PptDaemon.Native]::SetCursorPos($origin.X + $x, $origin.Y + $y) | Out-Null
            [PptDaemon.Native]::SetForegroundWindow([System.IntPtr]$hwnd) | Out-Null
            Start-Sleep -Milliseconds 80
            # MOUSEEVENTF_LEFTDOWN / MOUSEEVENTF_LEFTUP. Unlike Player.Play(),
            # this follows the slide's native onClick/togglePause trigger and
            # cannot block the daemon on a ppNotReady COM call.
            [PptDaemon.Native]::mouse_event(0x0002, 0, 0, 0, [System.UIntPtr]::Zero)
            [PptDaemon.Native]::mouse_event(0x0004, 0, 0, 0, [System.UIntPtr]::Zero)
            Start-Sleep -Milliseconds 120
        } finally {
            [PptDaemon.Native]::SetCursorPos($oldCursor.X, $oldCursor.Y) | Out-Null
        }

        # PowerPoint pauses this class of interactive video as soon as its
        # slideshow loses focus. Keep it foreground while the movie plays; the
        # global presenter shortcuts still reach Electron. Restore the operator
        # window as soon as navigation leaves this slide.
        if ($oldForeground -ne [System.IntPtr]::Zero -and $oldForeground.ToInt64() -ne $hwnd) {
            $script:mediaReturnForegroundHwnd = $oldForeground.ToInt64()
        }
        Log "video click: native shape click hwnd=$hwnd shape=$($video.ShapeId) client=$x,$y"
        return $true
    } catch {
        Log "video click: native shape click failed shape=$($video.ShapeId): $($_.Exception.Message)"
        return $false
    }
}

function Invoke-SlideVideoClick($view) {
    $videos = @(Get-SlideVideoShapes $view)
    if ($videos.Count -eq 0) {
        return [PSCustomObject]@{ HasVideo = $false; Handled = $false; ForceAdvance = $false; Detail = 'none' }
    }

    $slideIndex = -1
    $presentationPath = ''
    try { $slideIndex = [int]$view.Slide.SlideIndex } catch {}
    try { $presentationPath = [string]$view.Slide.Parent.FullName } catch {}

    # Start each click-triggered movie at most once per visit to this slide.
    # Record even a failed native click: the following presenter click must
    # always fail open to navigation instead of trapping the show forever.
    $hasClickVideo = $false
    foreach ($video in $videos) {
        if ($video.PlayOnEntry) { continue }
        $hasClickVideo = $true
        $key = "$($presentationPath.ToLowerInvariant())|$slideIndex|$($video.ShapeId)"
        if ($script:startedSlideVideos.ContainsKey($key)) { continue }

        $clicked = Invoke-SlideShowShapeClick $view $video
        $script:startedSlideVideos[$key] = $true
        $detail = if ($clicked) { "clicked:$($video.ShapeId)" } else { "click-failed:$($video.ShapeId)" }
        return [PSCustomObject]@{ HasVideo = $true; Handled = $true; ForceAdvance = $false; Detail = $detail }
    }

    if ($hasClickVideo) {
        return [PSCustomObject]@{ HasVideo = $true; Handled = $false; ForceAdvance = $true; Detail = 'video-complete' }
    }
    return [PSCustomObject]@{ HasVideo = $true; Handled = $false; ForceAdvance = $false; Detail = 'auto-play' }
}

function Capture-PowerPointRegistryWindowState {
    if ($null -ne $script:pptRegistryWindowSnapshot) { return }
    $path = 'HKCU:\Software\Microsoft\Office\16.0\PowerPoint\Options'
    $snapshot = @{}
    try {
        $key = Get-Item -LiteralPath $path -ErrorAction SilentlyContinue
        foreach ($name in @('AppMaximized', 'Top', 'Left', 'Right', 'Bottom', 'UseMonMgr')) {
            $present = $false
            $value = $null
            $kind = 'DWord'
            if ($key) {
                $present = @($key.GetValueNames()) -contains $name
                if ($present) {
                    $value = $key.GetValue($name, $null, 'DoNotExpandEnvironmentNames')
                    $kind = [string]$key.GetValueKind($name)
                }
            }
            $snapshot[$name] = [PSCustomObject]@{
                Present = $present
                Value = $value
                Kind = $kind
            }
        }
    } catch {
        Log "PowerPoint registry snapshot failed: $($_.Exception.Message)"
    }
    $script:pptRegistryWindowSnapshot = $snapshot
}

function Restore-PowerPointRegistryWindowState {
    $snapshot = $script:pptRegistryWindowSnapshot
    if ($null -eq $snapshot) { return }
    $path = 'HKCU:\Software\Microsoft\Office\16.0\PowerPoint\Options'
    try {
        if (-not (Test-Path -LiteralPath $path)) {
            New-Item -Path $path -Force | Out-Null
        }
        foreach ($name in $snapshot.Keys) {
            $state = $snapshot[$name]
            if ($state.Present) {
                New-ItemProperty -LiteralPath $path -Name $name -Value $state.Value `
                    -PropertyType $state.Kind -Force | Out-Null
            } else {
                Remove-ItemProperty -LiteralPath $path -Name $name -ErrorAction SilentlyContinue
            }
        }
        Log 'PowerPoint registry window state restored'
    } catch {
        Log "PowerPoint registry restore failed: $($_.Exception.Message)"
    }
}

function Get-PresentationKey($presentation) {
    if (-not $presentation) { return '' }
    $key = ''
    try { $key = [string]$presentation.FullName } catch {}
    if ([string]::IsNullOrWhiteSpace($key)) {
        try { $key = [string]$presentation.Name } catch {}
    }
    if ([string]::IsNullOrWhiteSpace($key)) { return '' }
    return $key.ToLowerInvariant()
}

function Get-PresentationIdentity($presentation) {
    if (-not $presentation) { return '' }
    $unknown = [IntPtr]::Zero
    try {
        # FullName is not ownership: a user can reopen the same path after a
        # PDM-created Presentation was closed. IUnknown identity distinguishes
        # the exact COM object. Release the temporary AddRef immediately so
        # tracking never keeps a closed presentation alive by itself.
        $unknown = [System.Runtime.InteropServices.Marshal]::GetIUnknownForObject($presentation)
        if ($unknown -eq [IntPtr]::Zero) { return '' }
        return ([long]$unknown).ToString('X16')
    } catch {
        return ''
    } finally {
        if ($unknown -ne [IntPtr]::Zero) {
            try { [void][System.Runtime.InteropServices.Marshal]::Release($unknown) } catch {}
        }
    }
}

function Get-UnidentifiedManagedPresentationRecord($presentation) {
    if (-not $presentation) { return $null }
    foreach ($record in @($script:unidentifiedManagedPresentations)) {
        if ($record -and [object]::ReferenceEquals($record.presentation, $presentation)) {
            return $record
        }
    }
    return $null
}

function Remove-UnidentifiedManagedPresentation($presentation) {
    if (-not $presentation) { return }
    for ($i = $script:unidentifiedManagedPresentations.Count - 1; $i -ge 0; $i--) {
        $record = $script:unidentifiedManagedPresentations[$i]
        if ($record -and [object]::ReferenceEquals($record.presentation, $presentation)) {
            $script:unidentifiedManagedPresentations.RemoveAt($i)
        }
    }
}

function Mark-ManagedPresentation($presentation) {
    $key = Get-PresentationKey $presentation
    $identity = Get-PresentationIdentity $presentation
    if ([string]::IsNullOrEmpty($key) -or [string]::IsNullOrEmpty($identity)) {
        # The caller has just opened this exact RCW, so retaining that reference
        # is safe even though COM could not expose a durable IUnknown identity.
        # Never acknowledge PREPARE/OPEN/EXPORT/NOTES in this state: doing so
        # would later classify the PDM-created deck as user-owned and leak its
        # document/media graph. Close-ManagedPresentation can retire this
        # quarantined exact reference, and session cleanup keeps retrying it.
        if (-not (Get-UnidentifiedManagedPresentationRecord $presentation)) {
            [void]$script:unidentifiedManagedPresentations.Add(@{
                presentation = $presentation
                path = $key
            })
        }
        Log "managed presentation identity unavailable '$key'; command rejected and exact RCW quarantined"
        $script:lastManagedPresentationCloseOk = $false
        Close-ManagedPresentation $presentation
        $cleanupDetail = if ($script:lastManagedPresentationCloseOk) {
            'the exact PDM-opened deck was closed'
        } else {
            'the exact PDM-opened deck is retained for cleanup retry'
        }
        throw "PowerPoint could not establish exact ownership for '$key'; $cleanupDetail"
    }
    $script:managedPresentationKeys[$key] = $true
    $script:managedPresentationIdentities[$identity] = $key
    Log "managed presentation registered '$key' identity=$identity"
}

function Test-ManagedPresentation($presentation) {
    $identity = Get-PresentationIdentity $presentation
    if ([string]::IsNullOrEmpty($identity) -or
        -not $script:managedPresentationIdentities.ContainsKey($identity)) { return $false }
    $expectedKey = [string]$script:managedPresentationIdentities[$identity]
    $currentKey = Get-PresentationKey $presentation
    # After Windows removes a display, PowerPoint can destroy the slideshow
    # and invalidate FullName on the retained RCW before PDM gets a chance to
    # close it.  The exact IUnknown identity is still the ownership proof we
    # registered when opening the deck.  Do not reclassify that stale PDM RCW
    # as a user document merely because its path can no longer be queried.
    return [string]::IsNullOrEmpty($currentKey) -or $currentKey -eq $expectedKey
}

function Test-PdmOwnedPresentation($presentation) {
    if (-not $presentation) { return $false }
    if (Test-ManagedPresentation $presentation) { return $true }
    return $null -ne (Get-UnidentifiedManagedPresentationRecord $presentation)
}

function Test-PresentationProtectedByOpenTransaction($presentation) {
    $transaction = $script:openTransaction
    if (-not $transaction -or -not $presentation) { return $false }
    $candidateIdentity = Get-PresentationIdentity $presentation
    $protected = New-Object System.Collections.ArrayList
    [void]$protected.Add($transaction.targetPresentation)
    [void]$protected.Add($transaction.previousPresentation)
    foreach ($record in @($transaction.oldPresentationRecords)) {
        if ($record -and -not [bool]$record.retired) {
            [void]$protected.Add($record.presentation)
        }
    }
    foreach ($protectedPresentation in @($protected)) {
        if (-not $protectedPresentation) { continue }
        if ([object]::ReferenceEquals($protectedPresentation, $presentation)) { return $true }
        if (-not [string]::IsNullOrEmpty($candidateIdentity)) {
            $protectedIdentity = Get-PresentationIdentity $protectedPresentation
            if (-not [string]::IsNullOrEmpty($protectedIdentity) -and
                $protectedIdentity -eq $candidateIdentity) { return $true }
        }
    }
    return $false
}

function Close-UnidentifiedManagedPresentations {
    $allClosed = $true
    # Work from a snapshot because successful closes remove their records.
    foreach ($record in @($script:unidentifiedManagedPresentations)) {
        if (-not $record -or -not $record.presentation) { continue }
        if (Test-PresentationProtectedByOpenTransaction $record.presentation) {
            # The transaction owns its completion tombstones. Closing the RCW
            # here would remove quarantine tracking without setting
            # targetReleased/record.retired and make rollback unrecoverable.
            continue
        }
        $script:lastManagedPresentationCloseOk = $false
        Close-ManagedPresentation $record.presentation
        if (-not $script:lastManagedPresentationCloseOk) {
            $allClosed = $false
            Log "unidentified managed presentation cleanup pending path='$($record.path)'"
        }
    }
    return $allClosed
}

function Get-PowerPointPresentationOwnershipState($ppt) {
    $state = [PSCustomObject]@{
        verified = $false
        hasManaged = $false
        hasUnmanaged = $true
        error = ''
    }
    if (-not $ppt) {
        $state.error = 'PowerPoint COM application is unavailable'
        return $state
    }
    try {
        $hasManaged = $false
        $hasUnmanaged = $false
        for ($i = 1; $i -le [int]$ppt.Presentations.Count; $i++) {
            $candidate = $ppt.Presentations.Item($i)
            if (Test-PdmOwnedPresentation $candidate) {
                $hasManaged = $true
            } else {
                $hasUnmanaged = $true
            }
        }
        $state.verified = $true
        $state.hasManaged = $hasManaged
        $state.hasUnmanaged = $hasUnmanaged
    } catch {
        $state.error = $_.Exception.Message
    }
    return $state
}

function Unmark-ManagedPresentation($presentation) {
    $key = Get-PresentationKey $presentation
    $identity = Get-PresentationIdentity $presentation
    if (-not [string]::IsNullOrEmpty($key)) {
        $script:managedPresentationKeys.Remove($key)
    }
    if (-not [string]::IsNullOrEmpty($identity)) {
        $script:managedPresentationIdentities.Remove($identity)
    }
}

function Mark-PreparedPresentation($presentation) {
    $key = Get-PresentationKey $presentation
    if (-not [string]::IsNullOrEmpty($key)) {
        $script:preparedPresentationKeys[$key] = $true
        Log "prepared presentation registered '$key'"
    }
}

function Test-PreparedPresentation($presentation) {
    $key = Get-PresentationKey $presentation
    return (-not [string]::IsNullOrEmpty($key)) -and $script:preparedPresentationKeys.ContainsKey($key)
}

function Unmark-PreparedPresentation($presentation) {
    $key = Get-PresentationKey $presentation
    if (-not [string]::IsNullOrEmpty($key)) {
        $script:preparedPresentationKeys.Remove($key)
    }
}

function Close-ManagedPresentation($presentation) {
    if (-not $presentation) { return }
    $key = Get-PresentationKey $presentation
    $identity = Get-PresentationIdentity $presentation
    $unidentifiedRecord = Get-UnidentifiedManagedPresentationRecord $presentation
    $trackedKey = ''
    if (-not [string]::IsNullOrEmpty($identity) -and
        $script:managedPresentationIdentities.ContainsKey($identity)) {
        $trackedKey = [string]$script:managedPresentationIdentities[$identity]
    }
    $identityTracked = (-not [string]::IsNullOrEmpty($trackedKey)) -and
        ([string]::IsNullOrEmpty($key) -or $trackedKey -eq $key)
    if ([string]::IsNullOrEmpty($key) -and $identityTracked) {
        # Preserve the registration key for retiring all path-based tracking
        # after the underlying COM object has already disappeared.
        $key = $trackedKey
    }
    $closed = $false
    if (-not $identityTracked -and -not $unidentifiedRecord) {
        $script:lastManagedPresentationCloseOk = $false
        Log "managed presentation close refused: exact COM identity is not tracked key='$key'"
        return
    }

    # A previous Close may have succeeded even when its immediate COM
    # verification was rejected. Prove absence by exact identity before
    # invoking a stale RCW again. A user document reopened from the same path
    # has a different IUnknown and is never treated as the old managed object.
    try {
        $identityStillOpen = $false
        for ($i = 1; $i -le $script:pptApplication.Presentations.Count; $i++) {
            $candidate = $script:pptApplication.Presentations.Item($i)
            $candidateMatches = if (-not [string]::IsNullOrEmpty($identity)) {
                (Get-PresentationIdentity $candidate) -eq $identity
            } else {
                [object]::ReferenceEquals($candidate, $presentation)
            }
            if ($candidateMatches) {
                $identityStillOpen = $true
                break
            }
        }
        # An identity-bearing record can prove exact absence. For a quarantined
        # RCW whose IUnknown is still unavailable, always invoke Close on the
        # exact retained object instead of trusting wrapper reference equality.
        if (-not $identityStillOpen -and -not [string]::IsNullOrEmpty($identity)) {
            $closed = $true
        }
    } catch {
        Log "managed presentation pre-close verification failed identity=$identity key='$key': $($_.Exception.Message)"
    }
    try { $presentation.Saved = -1 } catch {}
    for ($attempt = 1; $attempt -le 2 -and -not $closed; $attempt++) {
        $closeReturned = $false
        try {
            $presentation.Close()
            $closeReturned = $true
        } catch {
            Log "managed presentation close failed attempt=$attempt key='$key': $($_.Exception.Message)"
        }

        # Verify after both a normal return and an exception: Office can close
        # the document and then reject the stale RCW call. IUnknown identity is
        # authoritative when available. For a quarantined identity-less RCW,
        # prove only that its path is absent from a complete enumeration (or
        # that the collection is completely empty). Never infer absence merely
        # because Presentations.Item returned another wrapper instance.
        if ($script:pptApplication) {
            $verifyDeadline = [DateTime]::UtcNow.AddMilliseconds(600)
            do {
                $stillOpen = $true
                try {
                    $presentationCount = [int]$script:pptApplication.Presentations.Count
                    $stillOpen = $false
                    if ([string]::IsNullOrEmpty($identity) -and
                        [string]::IsNullOrEmpty($key) -and $presentationCount -gt 0) {
                        # No durable identity or path means a non-empty
                        # collection is ambiguous. Retain the exact RCW.
                        $stillOpen = $true
                    } else {
                        for ($i = 1; $i -le $presentationCount; $i++) {
                            $candidate = $script:pptApplication.Presentations.Item($i)
                            $candidateMatches = if (-not [string]::IsNullOrEmpty($identity)) {
                                (Get-PresentationIdentity $candidate) -eq $identity
                            } else {
                                (Get-PresentationKey $candidate) -eq $key
                            }
                            if ($candidateMatches) {
                                $stillOpen = $true
                                break
                            }
                        }
                    }
                } catch {
                    # Collection access can be rejected while Office is busy
                    # (RPC_E_CALL_REJECTED). That is not proof of release.
                    $stillOpen = $true
                    Log "managed presentation verification failed key='$key': $($_.Exception.Message)"
                }
                if ($stillOpen) { Start-Sleep -Milliseconds 50 }
            } while ($stillOpen -and [DateTime]::UtcNow -lt $verifyDeadline)
            $closed = -not $stillOpen
        } elseif ($closeReturned -and $identityTracked) {
            $closed = $true
        }
        if (-not $closed) {
            Log "managed presentation still present or unverified after Close key='$key'"
            if ($attempt -lt 2) { Start-Sleep -Milliseconds 120 }
        }
    }
    $script:lastManagedPresentationCloseOk = $closed
    if ($closed -and -not [string]::IsNullOrEmpty($key)) {
        [void]$script:managedPresentationKeys.Remove($key)
        [void]$script:preparedPresentationKeys.Remove($key)
    }
    if ($closed -and -not [string]::IsNullOrEmpty($identity)) {
        [void]$script:managedPresentationIdentities.Remove($identity)
    }
    if ($closed -and $unidentifiedRecord) {
        Remove-UnidentifiedManagedPresentation $presentation
    }
}

function Reset-PowerPointSessionTracking {
    try { [PptDaemon.Native]::StopPowerPointEditorGuard() } catch {}
    $script:pptApplication = $null
    $script:pptSessionInitialized = $false
    $script:pptOwnedByRoland = $false
    $script:pptOriginalVisible = 0
    $script:pptOriginalWindowState = 1
    $script:pptOriginalEditorHwnd = 0
    $script:pptOriginalEditorWasVisible = $false
    $script:pptOriginalEditorRect = $null
    $script:pptRegistryWindowSnapshot = $null
    $script:managedPresentationKeys = @{}
    $script:managedPresentationIdentities = @{}
    $script:unidentifiedManagedPresentations = New-Object System.Collections.ArrayList
    $script:preparedPresentationKeys = @{}
    $script:lastManagedPresentationCloseOk = $true
    $script:openTransaction = $null
    $script:lastOpenTransactionOk = $true
    $script:pptOwnedProcessId = 0
    $script:pptOwnedProcessStartTimeUtcTicks = 0L
    $script:pptSessionUncertain = $false
}

function Test-FatalPowerPointComError($errorRecord) {
    $message = ''
    try { $message = [string]$errorRecord.Exception.ToString() } catch {
        try { $message = [string]$errorRecord } catch {}
    }
    if ([string]::IsNullOrWhiteSpace($message)) { return $false }

    # These HRESULTs mean that the cached Office COM proxy can no longer be
    # used. Retrying a command through the same proxy only repeats the failure:
    # 0x800706BA RPC_S_SERVER_UNAVAILABLE
    # 0x800706BE RPC_S_CALL_FAILED
    # 0x80010108 RPC_E_DISCONNECTED
    # 0x80010105 RPC_E_SERVERFAULT
    # HRESULT matching is locale-independent; keep the source ASCII here so
    # Windows PowerShell 5.1 can parse the script even when UTF-8 is read using
    # the machine's legacy code page.
    return $message -match '(?i)(0x800706BA|0x800706BE|0x80010108|0x80010105|RPC server is unavailable|RPC server.*failed)'
}

function Invalidate-PowerPointSession([string]$reason) {
    Log "PowerPoint COM session invalidated reason='$reason'"
    # A disconnected RCW is not proof that POWERPNT.EXE or a managed document
    # disappeared.  First run the same ownership-aware cleanup used by CLOSE and
    # shutdown.  Only that cleanup is allowed to discard COM identities/PID
    # ownership; otherwise a later GetActiveObject could silently reattach to an
    # orphaned deck as a borrowed user session.
    try {
        Restore-PowerPointSession
    } catch {
        $script:lastPowerPointSessionCleanupOk = $false
        Log "fatal PowerPoint session cleanup threw: $($_.Exception.Message)"
    }
    if ($script:lastPowerPointSessionCleanupOk) {
        $script:pptSessionUncertain = $false
        Log 'fatal PowerPoint session cleanup was verified; a fresh session may be created by a later command'
        return $true
    }

    # Keep every ownership marker and stale RCW for diagnostics/EOF retry.  The
    # command dispatcher will mark the response uncertain and leave its normal
    # loop; Electron must not transparently spawn another daemon in this state.
    $script:pptSessionUncertain = $true
    Log 'fatal PowerPoint session cleanup was not verified; ownership retained and session poisoned'
    return $false
}

function Initialize-PowerPointSession($ppt, [bool]$ownedByRoland) {
    if ($script:pptSessionInitialized) { return }
    Capture-PowerPointRegistryWindowState
    $script:pptApplication = $ppt
    $script:pptSessionInitialized = $true
    $script:pptOwnedByRoland = $ownedByRoland

    if (-not $ownedByRoland) {
        try { $script:pptOriginalVisible = [int]$ppt.Visible } catch {}
        try { $script:pptOriginalWindowState = [int]$ppt.WindowState } catch {}
        try { $script:pptOriginalEditorHwnd = Get-PPEditorHwnd $ppt } catch {}
        $hwnd = [long]$script:pptOriginalEditorHwnd
        if ($hwnd -ne 0) {
            try {
                $script:pptOriginalEditorWasVisible = [PptDaemon.Native]::IsWindowVisible([System.IntPtr]$hwnd)
                $placement = New-Object PptDaemon.Native+WINDOWPLACEMENT
                $placement.length = [System.Runtime.InteropServices.Marshal]::SizeOf($placement)
                if ([PptDaemon.Native]::GetWindowPlacement([System.IntPtr]$hwnd, [ref]$placement)) {
                    $r = $placement.rcNormalPosition
                    $left = [int]$r.Left; $top = [int]$r.Top
                    $right = [int]$r.Right; $bottom = [int]$r.Bottom
                    if ($right -gt $left -and $bottom -gt $top) {
                        $script:pptOriginalEditorRect = @($left, $top, ($right - $left), ($bottom - $top))
                    }
                }
                if ($null -eq $script:pptOriginalEditorRect) {
                    $r = New-Object PptDaemon.Native+RECT
                    if ([PptDaemon.Native]::GetWindowRect([System.IntPtr]$hwnd, [ref]$r) -and
                        [int]$r.Right -gt [int]$r.Left -and [int]$r.Bottom -gt [int]$r.Top) {
                        $left = [int]$r.Left; $top = [int]$r.Top
                        $script:pptOriginalEditorRect = @(
                            $left, $top, ([int]$r.Right - $left), ([int]$r.Bottom - $top)
                        )
                    }
                }
            } catch { Log "PowerPoint editor placement capture failed: $($_.Exception.Message)" }
        }
    }
    $rectText = if ($null -ne $script:pptOriginalEditorRect) { $script:pptOriginalEditorRect -join ',' } else { '-' }
    Log ("PowerPoint session initialized owned={0} visible={1} state={2} hwnd={3} rect={4}" -f `
        $ownedByRoland, $script:pptOriginalVisible, $script:pptOriginalWindowState,
        $script:pptOriginalEditorHwnd, $rectText)
}

function Restore-BorrowedPowerPointEditorState($ppt, [bool]$allowComHide = $false) {
    if (-not $ppt -or $script:pptOwnedByRoland) { return }

    $shouldBeVisible = ($script:pptOriginalVisible -ne 0) -or $script:pptOriginalEditorWasVisible
    $hwnd = 0
    try { $hwnd = Get-PPEditorHwnd $ppt } catch {}
    if ($hwnd -eq 0) { $hwnd = [long]$script:pptOriginalEditorHwnd }

    if ($shouldBeVisible) {
        try { $ppt.Visible = -1 } catch {}
    }
    # Restore the normal rect and state even when the editor was originally
    # hidden. Otherwise PDM's temporary ppWindowMinimized state leaks into the
    # next user-opened window from this borrowed PowerPoint process.
    if ($hwnd -ne 0 -and $null -ne $script:pptOriginalEditorRect) {
        try { $ppt.WindowState = 1 } catch {}
        $r = $script:pptOriginalEditorRect
        try {
            [PptDaemon.Native]::SetWindowPos(
                [System.IntPtr]$hwnd, [System.IntPtr]-2,
                [int]$r[0], [int]$r[1], [int]$r[2], [int]$r[3], 0x10
            ) | Out-Null
        } catch {}
    }
    try { $ppt.WindowState = [int]$script:pptOriginalWindowState } catch {}

    if ($shouldBeVisible) {
        if ($hwnd -ne 0) {
            $showCommand = switch ([int]$script:pptOriginalWindowState) {
                2 { 2 } # SW_SHOWMINIMIZED
                3 { 3 } # SW_SHOWMAXIMIZED
                default { 4 } # SW_SHOWNOACTIVATE
            }
            try { [PptDaemon.Native]::ShowWindow([System.IntPtr]$hwnd, $showCommand) | Out-Null } catch {}
        }
    } else {
        if ($hwnd -ne 0) {
            try { [PptDaemon.Native]::ShowWindow([System.IntPtr]$hwnd, 0) | Out-Null } catch {}
        }
        # Visible=0 can disconnect a borrowed Office automation server after
        # View.Exit(). Use it only while the daemon is releasing that session;
        # a normal CLOSE keeps the COM host usable for the next TAKE.
        if ($allowComHide) {
            try { $ppt.Visible = 0 } catch {}
        }
    }
    Log 'user-owned PowerPoint editor state restored'
}

function Get-PPT {
    if ($script:pptSessionUncertain) {
        throw 'PowerPoint session ownership is uncertain after a fatal COM failure'
    }
    if ($script:pptApplication) {
        try {
            $null = [int]$script:pptApplication.Presentations.Count
            return $script:pptApplication
        } catch {
            if (Test-FatalPowerPointComError $_) {
                Log "cached PowerPoint COM object is fatally disconnected: $($_.Exception.Message)"
                $null = Invalidate-PowerPointSession 'cached COM validation failed fatally'
                # Never reacquire/create inside the same command that observed a
                # fatal proxy. The dispatcher either permits a later clean retry
                # after verified cleanup or poisons the Electron session.
                throw
            } else {
                # RPC_E_CALL_REJECTED is common while PowerPoint is busy or a
                # modal dialog is open. Dropping ownership/managed keys here
                # turns a retryable command into an orphaned deck/process.
                Log "cached PowerPoint COM validation was transiently rejected: $($_.Exception.Message)"
                throw
            }
        }
    }
    try {
        $ppt = [System.Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application')
        Initialize-PowerPointSession $ppt $false
        return $ppt
    } catch { return $null }
}

function Get-OrCreatePPT {
    $ppt = Get-PPT
    if ($ppt) { return $ppt }
    $existingEditorHwnds = @([PptDaemon.Native]::FindPowerPointEditorHwnds())
    $existingPowerPointPids = @{}
    $processSnapshotReliable = $false
    try {
        foreach ($process in @(Get-Process -Name POWERPNT -ErrorAction SilentlyContinue)) {
            $existingPowerPointPids[[long]$process.Id] = $true
        }
        $processSnapshotReliable = $true
    } catch {
        Log "PowerPoint process snapshot failed; process ownership disabled: $($_.Exception.Message)"
    }
    [PptDaemon.Native]::StartPowerPointEditorGuard(0, [long[]]$existingEditorHwnds)
    try {
        $ppt = New-Object -ComObject PowerPoint.Application
        $editorHwnd = 0
        try { $editorHwnd = [long]$ppt.HWND } catch {}
        if ($editorHwnd -eq 0) {
            try { $editorHwnd = [long][PptDaemon.Native]::EditorGuardFoundHwnd } catch {}
        }
        $powerPointPid = 0
        if ($editorHwnd -ne 0) {
            try { $powerPointPid = [long][PptDaemon.Native]::GetWindowProcessId($editorHwnd) } catch {}
        }
        # Diffing process IDs is a fallback, not proof by itself. Collect the
        # complete post-CreateObject set and accept it only when exactly one new
        # POWERPNT PID exists (and, when available, it matches the COM HWND).
        $newPowerPointPids = @{}
        $pidDeadline = [DateTime]::UtcNow.AddMilliseconds(1000)
        do {
            try {
                foreach ($process in @(Get-Process -Name POWERPNT -ErrorAction SilentlyContinue)) {
                    $candidatePid = [long]$process.Id
                    if (-not $existingPowerPointPids.ContainsKey($candidatePid)) {
                        $newPowerPointPids[$candidatePid] = $true
                    }
                }
            } catch {
                $processSnapshotReliable = $false
                Log "PowerPoint post-create process scan failed; process ownership disabled: $($_.Exception.Message)"
            }
            if ($powerPointPid -eq 0 -and $editorHwnd -eq 0) {
                try {
                    $editorHwnd = [long][PptDaemon.Native]::EditorGuardFoundHwnd
                    if ($editorHwnd -ne 0) {
                        $powerPointPid = [long][PptDaemon.Native]::GetWindowProcessId($editorHwnd)
                    }
                } catch {}
            }
            if ($powerPointPid -gt 0 -and $existingPowerPointPids.ContainsKey($powerPointPid)) { break }
            if ($newPowerPointPids.Count -gt 1) { break }
            if ($powerPointPid -gt 0 -and $newPowerPointPids.ContainsKey($powerPointPid)) { break }
            Start-Sleep -Milliseconds 10
        } while ([DateTime]::UtcNow -lt $pidDeadline)
        if ($powerPointPid -eq 0 -and $newPowerPointPids.Count -eq 1) {
            $powerPointPid = [long]@($newPowerPointPids.Keys)[0]
        }

        # CreateObject normally starts a dedicated POWERPNT process, but Office
        # may attach the COM Application to an already-running process while
        # the ROT is unavailable (startup, a modal dialog, protected view).
        # Such a PID may contain user documents and must never be Quit/killed.
        $processWasAlreadyRunning = $powerPointPid -gt 0 -and
            $existingPowerPointPids.ContainsKey($powerPointPid)
        $processIsUniqueNew = $powerPointPid -gt 0 -and
            $newPowerPointPids.Count -eq 1 -and
            $newPowerPointPids.ContainsKey($powerPointPid)
        $powerPointStartTimeUtcTicks = 0L
        if ($processSnapshotReliable -and $processIsUniqueNew) {
            try {
                $ownedProcess = Get-Process -Id $powerPointPid -ErrorAction Stop
                if ($ownedProcess.ProcessName -ieq 'POWERPNT') {
                    $powerPointStartTimeUtcTicks = [long]$ownedProcess.StartTime.ToUniversalTime().Ticks
                }
            } catch {
                Log "PowerPoint process identity capture failed pid=$powerPointPid; ownership disabled: $($_.Exception.Message)"
            }
        }
        # Process ownership is granted only when the COM application's exact
        # PID was resolved and did not exist before CreateObject. An unresolved
        # PID is never proof of ownership, even when no POWERPNT process was
        # visible in the initial snapshot: never Quit/force an unverified host.
        $ownedByRoland = $processSnapshotReliable -and
            $processIsUniqueNew -and
            -not $processWasAlreadyRunning -and
            $powerPointStartTimeUtcTicks -gt 0
        Initialize-PowerPointSession $ppt $ownedByRoland

        if ($powerPointPid -gt 0 -and $ownedByRoland) {
            $script:pptOwnedProcessId = $powerPointPid
            $script:pptOwnedProcessStartTimeUtcTicks = $powerPointStartTimeUtcTicks
            [PptDaemon.Native]::StartPowerPointEditorGuard($powerPointPid, [long[]]@())
            Log "PowerPoint editor guard attached pid=$powerPointPid hwnd=$editorHwnd"
        } elseif ($powerPointPid -gt 0) {
            # A PID-scoped guard would hide every editor window in the user's
            # existing PowerPoint process, not just the PDM-created document.
            [PptDaemon.Native]::StopPowerPointEditorGuard()
            Log "PowerPoint host borrowed existing pid=$powerPointPid hwnd=$editorHwnd; Quit/force disabled"
        } else {
            # Do not leave an unscoped guard running: a user may open another
            # PowerPoint while PDM is idle and that window must stay visible.
            [PptDaemon.Native]::StopPowerPointEditorGuard()
            Log "PowerPoint PID unresolved; host treated as borrowed hwnd=$editorHwnd; Quit/force disabled"
        }
        Hide-PPEditor $ppt
        return $ppt
    } catch {
        try { [PptDaemon.Native]::StopPowerPointEditorGuard() } catch {}
        throw
    }
}

function Get-OwnedPowerPointProcessState([long]$processId, [long]$startTimeUtcTicks) {
    $state = @{ verified = $false; alive = $false; process = $null; detail = '' }
    if ($processId -le 0 -or $startTimeUtcTicks -le 0) {
        $state.detail = 'missing PID/start-time fingerprint'
        return $state
    }
    try {
        $candidate = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if (-not $candidate) {
            $state.verified = $true
            return $state
        }
        $candidateStart = [long]$candidate.StartTime.ToUniversalTime().Ticks
        if ($candidate.ProcessName -ine 'POWERPNT' -or $candidateStart -ne $startTimeUtcTicks) {
            # The numeric PID was reused. The original owned process is gone;
            # never act on the unrelated replacement.
            $state.verified = $true
            $state.detail = "PID reused by '$($candidate.ProcessName)' start=$candidateStart"
            return $state
        }
        $state.verified = $true
        $state.alive = $true
        $state.process = $candidate
        return $state
    } catch {
        $state.detail = $_.Exception.Message
        return $state
    }
}

function Restore-PowerPointSession {
    $script:lastPowerPointSessionCleanupOk = $true
    if (-not $script:pptSessionInitialized) { return }
    Log "PowerPoint session cleanup BEGIN owned=$($script:pptOwnedByRoland)"
    $cleanupOk = $true
    $ownedProcessId = [long]$script:pptOwnedProcessId
    $ownedProcessStartTimeUtcTicks = [long]$script:pptOwnedProcessStartTimeUtcTicks
    $sessionResourcesGone = $false
    Reset-SlideVideoClickState
    $ppt = $script:pptApplication

    # Shutdown/fatal recovery can arrive while COMMIT still retains the old
    # slideshow, or while an uncommitted OPEN still owns its staged target.
    # Reconcile that exact transaction before touching the current active
    # marker. Restore used to exit only the target and then discard the
    # transaction, which could orphan the previous borrowed slideshow.
    if ($script:openTransaction) {
        for ($transactionAttempt = 1; $transactionAttempt -le 3; $transactionAttempt++) {
            try {
                if ([bool]$script:openTransaction.commitAccepted) {
                    Commit-PowerPointOpenTransaction
                } else {
                    Abort-PowerPointOpenTransaction
                }
            } catch {
                $script:lastOpenTransactionOk = $false
                Log "PowerPoint session transaction cleanup failed attempt=${transactionAttempt}: $($_.Exception.Message)"
            }
            if ($script:lastOpenTransactionOk -and -not $script:openTransaction) { break }
            if ($transactionAttempt -lt 3) { Start-Sleep -Milliseconds (150 * $transactionAttempt) }
        }
        if ($script:openTransaction) {
            $cleanupOk = $false
            Log 'PowerPoint session transaction cleanup remains pending'
        }
    }

    try {
        # Never resolve an arbitrary slideshow from a shared PowerPoint host.
        # Only PDM's cached/path-qualified window is ours to stop.
        $sw = $script:activeSlideShowWindow
        if (-not $sw -and -not [string]::IsNullOrEmpty($script:activePresentationPath)) {
            $sw = Resolve-ActiveSlideShowWindow $ppt $script:activePresentationPath
        }
        $activeNativeWindowGone = $false
        $activeHwndForCleanup = [long]$script:activeSlideShowHwnd
        if ($activeHwndForCleanup -ne 0) {
            $activeNativeWindowGone = -not [PptDaemon.Native]::IsWindow(
                [System.IntPtr]$activeHwndForCleanup
            )
        }
        if ($sw -and -not $activeNativeWindowGone) {
            try { $sw.View.Exit() } catch {
                $cleanupOk = $false
                Log "PowerPoint slideshow cleanup failed: $($_.Exception.Message)"
            }
        } elseif ($activeNativeWindowGone) {
            Log "PowerPoint active slideshow HWND=$activeHwndForCleanup is already gone"
        }
    } catch {
        $cleanupOk = $false
        Log "PowerPoint slideshow cleanup inspection failed: $($_.Exception.Message)"
    }

    if ($ppt) {
        if (-not (Close-UnidentifiedManagedPresentations)) {
            $cleanupOk = $false
        }
        if ($script:pptOwnedByRoland) {
            # Process ownership does not imply ownership of every document in
            # that process. A user can open a deck after PDM starts POWERPNT;
            # never mark such a deck Saved, close it, Quit its host, or force
            # its PID. Only presentations explicitly registered by PDM may be
            # discarded automatically.
            try {
                for ($i = [int]$ppt.Presentations.Count; $i -ge 1; $i--) {
                    $presentation = $ppt.Presentations.Item($i)
                    if ((Test-PdmOwnedPresentation $presentation) -and
                        -not (Test-PresentationProtectedByOpenTransaction $presentation)) {
                        $script:lastManagedPresentationCloseOk = $false
                        Close-ManagedPresentation $presentation
                        if (-not $script:lastManagedPresentationCloseOk) {
                            $cleanupOk = $false
                        }
                    }
                }
            } catch {
                $cleanupOk = $false
                Log "PowerPoint managed presentation enumeration failed: $($_.Exception.Message)"
            }

            $ownershipState = Get-PowerPointPresentationOwnershipState $ppt
            $hasUnmanagedPresentation = [bool]$ownershipState.hasUnmanaged
            $hasManagedPresentation = [bool]$ownershipState.hasManaged
            $canTerminateOwnedHost = [bool]$ownershipState.verified -and
                -not $hasUnmanagedPresentation
            if (-not [bool]$ownershipState.verified) {
                $cleanupOk = $false
                Log "PowerPoint cleanup ownership verification failed: $($ownershipState.error)"
            }

            try {
                Log "PowerPoint editor guard hidden=$([PptDaemon.Native]::EditorGuardHideCount) error='$([PptDaemon.Native]::EditorGuardError)'"
                [PptDaemon.Native]::StopPowerPointEditorGuard()
            } catch {
                $cleanupOk = $false
                Log "PowerPoint shared-host managed presentation enumeration failed: $($_.Exception.Message)"
            }

            # Resolve the PID/start-time fingerprint before the final document
            # scan so no process lookup sits between that scan and Quit().
            $ownedProcessState = Get-OwnedPowerPointProcessState `
                $ownedProcessId $ownedProcessStartTimeUtcTicks

            if ($canTerminateOwnedHost -and
                [bool]$ownedProcessState.verified -and
                [bool]$ownedProcessState.alive) {
                # The editor guard has just been removed. A user may open a
                # document into this otherwise PDM-owned process at any time,
                # so the earlier scan is stale by definition. Re-enumerate at
                # the last possible point before Quit and fail closed on any
                # unmanaged document or COM verification error.
                $preQuitOwnership = Get-PowerPointPresentationOwnershipState $ppt
                $hasUnmanagedPresentation = [bool]$preQuitOwnership.hasUnmanaged
                $hasManagedPresentation = [bool]$preQuitOwnership.hasManaged
                if (-not [bool]$preQuitOwnership.verified -or $hasUnmanagedPresentation) {
                    $canTerminateOwnedHost = $false
                    if (-not [bool]$preQuitOwnership.verified) { $cleanupOk = $false }
                    Log ("PowerPoint Quit disabled by final ownership check verified={0} unmanaged={1} error='{2}'" -f `
                        $preQuitOwnership.verified, $preQuitOwnership.hasUnmanaged, $preQuitOwnership.error)
                }
            }

            if ($canTerminateOwnedHost) {
                # PowerPoint persists WindowState/placement during Quit(). The
                # registry snapshot is restored below immediately afterwards.
                $terminationOk = [bool]$ownedProcessState.verified -and
                    -not [bool]$ownedProcessState.alive
                if (-not [bool]$ownedProcessState.verified) {
                    Log "PowerPoint cleanup: owned process identity could not be verified; Quit/force disabled detail='$($ownedProcessState.detail)'"
                } elseif ([bool]$ownedProcessState.alive) {
                    try { $ppt.Quit() } catch {
                        $terminationOk = $false
                        Log "PowerPoint Quit failed: $($_.Exception.Message)"
                    }
                    Start-Sleep -Milliseconds 150
                    $deadline = [DateTime]::UtcNow.AddMilliseconds(2000)
                    while ([DateTime]::UtcNow -lt $deadline) {
                        $ownedProcessState = Get-OwnedPowerPointProcessState `
                            $ownedProcessId $ownedProcessStartTimeUtcTicks
                        if (-not [bool]$ownedProcessState.verified -or
                            -not [bool]$ownedProcessState.alive) { break }
                        Start-Sleep -Milliseconds 50
                    }
                    if ([bool]$ownedProcessState.verified -and [bool]$ownedProcessState.alive) {
                        # Quit can be delayed by add-ins or prompts, and during
                        # that delay a user document may enter the same process.
                        # Never turn the original ownership scan into authority
                        # for a later force-kill.
                        $preForceOwnership = Get-PowerPointPresentationOwnershipState $ppt
                        if ([bool]$preForceOwnership.verified -and
                            -not [bool]$preForceOwnership.hasUnmanaged) {
                            Log "PowerPoint cleanup: owned pid=$ownedProcessId survived Quit; forcing termination"
                            try { Stop-Process -Id $ownedProcessId -Force -ErrorAction Stop } catch {
                                Log "PowerPoint cleanup: force termination failed: $($_.Exception.Message)"
                            }
                            # Process termination is asynchronous. Verify the
                            # same PID/start-time until exit instead of treating
                            # a 150 ms delay as proof that cleanup has failed.
                            $forceDeadline = [DateTime]::UtcNow.AddMilliseconds(1500)
                            do {
                                $ownedProcessState = Get-OwnedPowerPointProcessState `
                                    $ownedProcessId $ownedProcessStartTimeUtcTicks
                                if (-not [bool]$ownedProcessState.verified -or
                                    -not [bool]$ownedProcessState.alive) { break }
                                Start-Sleep -Milliseconds 50
                            } while ([DateTime]::UtcNow -lt $forceDeadline)
                        } else {
                            Log ("PowerPoint force termination disabled by final ownership check verified={0} unmanaged={1} error='{2}'" -f `
                                $preForceOwnership.verified, $preForceOwnership.hasUnmanaged, $preForceOwnership.error)
                        }
                    }
                    $ownedProcessState = Get-OwnedPowerPointProcessState `
                        $ownedProcessId $ownedProcessStartTimeUtcTicks
                    $terminationOk = [bool]$ownedProcessState.verified -and
                        -not [bool]$ownedProcessState.alive
                }
                # A verified process exit supersedes an earlier per-document
                # Close failure: no managed document or media can remain.
                $cleanupOk = $terminationOk
                $sessionResourcesGone = $terminationOk
                Log "Roland-owned PowerPoint instance termination ok=$terminationOk"
            } else {
                if ($hasManagedPresentation) { $cleanupOk = $false }
                # Leave the process alive and expose its editor so a user's
                # untracked document is never stranded in PDM's hidden host.
                try { $ppt.Visible = -1 } catch {}
                $editorHwnd = 0
                try { $editorHwnd = Get-PPEditorHwnd $ppt } catch {}
                if ($editorHwnd -ne 0) {
                    try { [PptDaemon.Native]::ShowWindow([System.IntPtr]$editorHwnd, 4) | Out-Null } catch {}
                }
                Log "PowerPoint owned host retained: unmanaged presentation present; Quit/force disabled"
            }
        } else {
            try {
                for ($i = [int]$ppt.Presentations.Count; $i -ge 1; $i--) {
                    $presentation = $ppt.Presentations.Item($i)
                    if ((Test-PdmOwnedPresentation $presentation) -and
                        -not (Test-PresentationProtectedByOpenTransaction $presentation)) {
                        $script:lastManagedPresentationCloseOk = $false
                        Close-ManagedPresentation $presentation
                        if (-not $script:lastManagedPresentationCloseOk) { $cleanupOk = $false }
                    }
                }
            } catch {
                # A COM/RPC failure while enumerating the borrowed host is not
                # proof that PDM's managed decks disappeared. Retain tracking
                # and let the bounded cleanup retry instead of reporting a
                # false success and orphaning presentation/media memory.
                $cleanupOk = $false
                Log "PowerPoint borrowed-host managed presentation enumeration failed: $($_.Exception.Message)"
            }

            Restore-BorrowedPowerPointEditorState $ppt $true
        }
    }

    Restore-PowerPointRegistryWindowState
    if (-not $sessionResourcesGone -and $script:openTransaction) {
        $cleanupOk = $false
        Log 'PowerPoint session cleanup cannot reset tracking while an open transaction remains unresolved'
    }
    if (-not $sessionResourcesGone -and $script:unidentifiedManagedPresentations.Count -gt 0) {
        $cleanupOk = $false
        Log "PowerPoint session cleanup cannot reset tracking while $($script:unidentifiedManagedPresentations.Count) unidentified managed presentation(s) remain"
    }
    if ($cleanupOk) {
        $script:activeSlideShowHwnd = 0
        $script:activeSlideShowWindow = $null
        $script:activePresentation = $null
        $script:activePresentationPath = ''
        try {
            if ($ppt) { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($ppt) }
        } catch {}
        Reset-PowerPointSessionTracking
    } else {
        # Keep the live COM proxies, ownership map, transaction and managed keys
        # so CLOSE/cleanup can retry. Dropping them here turns a real failure
        # into a later false success and can orphan a loaded deck/media graph.
        Log 'PowerPoint session cleanup incomplete; tracking retained for retry'
    }
    $script:lastPowerPointSessionCleanupOk = $cleanupOk
    Log "PowerPoint session cleanup END ok=$cleanupOk"
}

function Release-IdleOwnedPowerPointHost([string]$reason) {
    $script:lastIdleOwnedPowerPointHostReleaseOk = $true
    if (-not $script:pptSessionInitialized -or -not $script:pptOwnedByRoland) { return }
    if ($reason -in @('close','sync-prepared','notes','export') -and
        [DateTime]::UtcNow -lt $script:idleHostHoldUntilUtc) {
        Log "PowerPoint empty host retained briefly reason='$reason'"
        return
    }
    if ($script:openTransaction) {
        Log "PowerPoint idle release deferred reason='$reason': open transaction"
        return
    }

    # These markers are the authoritative logical state of PDM's on-air
    # slideshow.  Office collection calls can transiently return zero or throw
    # RPC_E_CALL_REJECTED while a slideshow is still visible.  Never interpret
    # that transient COM state as proof that the host is idle: export/notes
    # cleanup runs in the same process and must not recycle the live program.
    if (-not [string]::IsNullOrEmpty([string]$script:activePresentationPath) -or
        $null -ne $script:activePresentation -or
        $null -ne $script:activeSlideShowWindow -or
        [long]$script:activeSlideShowHwnd -ne 0) {
        Log "PowerPoint idle release deferred reason='$reason': active slideshow markers present"
        return
    }

    $ppt = $script:pptApplication
    if (-not $ppt) { return }
    if (-not (Close-UnidentifiedManagedPresentations)) {
        $script:lastIdleOwnedPowerPointHostReleaseOk = $false
        Log "PowerPoint idle release verification failed reason='$reason': unidentified managed presentation remains"
        return
    }
    try {
        if ([int]$ppt.Presentations.Count -ne 0) { return }
        if ([int]$ppt.SlideShowWindows.Count -ne 0) { return }
        if ($script:activeSlideShowWindow) {
            try {
                $null = [int]$script:activeSlideShowWindow.View.Slide.SlideIndex
                return
            } catch {
                $script:activeSlideShowWindow = $null
                $script:activeSlideShowHwnd = 0
            }
        }
    } catch {
        $script:lastIdleOwnedPowerPointHostReleaseOk = $false
        Log "PowerPoint idle release verification failed reason='$reason': $($_.Exception.Message)"
        return
    }

    Log "PowerPoint idle release BEGIN reason='$reason' pid=$($script:pptOwnedProcessId)"
    Restore-PowerPointSession
    $script:lastIdleOwnedPowerPointHostReleaseOk = $script:lastPowerPointSessionCleanupOk
    Log "PowerPoint idle release END reason='$reason' ok=$($script:lastIdleOwnedPowerPointHostReleaseOk)"
}

function Resolve-ActiveSlideShowWindow($ppt, [string]$expectedPath = '') {
    # PowerPoint can temporarily report SlideShowWindows.Count = 0 for several
    # seconds after closing the previous presentation, even though the COM
    # SlideShowWindow returned by Run() is alive and fully navigable. Keep and
    # validate that direct object instead of making every command depend on the
    # eventually-consistent collection.
    $cached = $script:activeSlideShowWindow
    if ($cached) {
        try {
            $cachedPath = [string]$cached.Presentation.FullName
            $cachedView = $cached.View
            if ($cachedView -and [int]$cachedView.Slide.SlideIndex -gt 0 -and
                ([string]::IsNullOrEmpty($expectedPath) -or $cachedPath -ieq $expectedPath)) {
                return $cached
            }
        } catch {
            $script:activeSlideShowWindow = $null
        }
    }

    if ($ppt) {
        try {
            for ($i = 1; $i -le $ppt.SlideShowWindows.Count; $i++) {
                $candidate = $ppt.SlideShowWindows.Item($i)
                $candidatePath = [string]$candidate.Presentation.FullName
                $candidateView = $candidate.View
                if ($candidateView -and [int]$candidateView.Slide.SlideIndex -gt 0 -and
                    ([string]::IsNullOrEmpty($expectedPath) -or $candidatePath -ieq $expectedPath)) {
                    $script:activeSlideShowWindow = $candidate
                    $script:activePresentation = $candidate.Presentation
                    $script:activePresentationPath = $candidatePath
                    try { $script:activeSlideShowHwnd = [long]$candidate.HWND } catch {}
                    return $candidate
                }
            }
        } catch {}
    }
    return $null
}

function Resolve-PdmSlideShowWindow($ppt) {
    # Commands such as NEXT/CLOSE must never fall through to an arbitrary user
    # slideshow merely because PDM currently has no active path.
    $cached = $script:activeSlideShowWindow
    if ($cached) {
        try {
            $cachedView = $cached.View
            if ($cachedView -and [int]$cachedView.Slide.SlideIndex -gt 0) {
                return $cached
            }
            $script:activeSlideShowWindow = $null
            $script:activeSlideShowHwnd = 0
        } catch {
            $script:activeSlideShowWindow = $null
            $script:activeSlideShowHwnd = 0
        }
    }
    $expectedPath = [string]$script:activePresentationPath
    if ([string]::IsNullOrEmpty($expectedPath)) { return $null }
    return Resolve-ActiveSlideShowWindow $ppt $expectedPath
}

function Test-PowerPointHasAnySlideShow($ppt) {
    if (-not $ppt) { return $false }
    # Fail closed while PDM still has an authoritative active marker.  The
    # SlideShowWindows collection is eventually consistent and can report zero
    # during transitions or reject calls while Office is busy.
    if (-not [string]::IsNullOrEmpty([string]$script:activePresentationPath) -or
        $null -ne $script:activePresentation -or
        $null -ne $script:activeSlideShowWindow -or
        [long]$script:activeSlideShowHwnd -ne 0) {
        return $true
    }
    if ($script:activeSlideShowWindow) {
        try {
            $null = [int]$script:activeSlideShowWindow.View.Slide.SlideIndex
            return $true
        } catch {}
    }
    try { return ([int]$ppt.SlideShowWindows.Count -gt 0) } catch { return $true }
}

function Abort-PowerPointOpenTransaction {
    $transaction = $script:openTransaction
    $script:lastOpenTransactionOk = $true
    if (-not $transaction) { return }

    # Once Electron has received commit-open success, the verified target is
    # authoritative program output. It is no longer legal to roll that target
    # back merely because retirement of the previous/hidden deck was delayed.
    # Re-enter the idempotent retirement pass instead; CLOSE/next OPEN will
    # either finish it or leave the accepted target visibly intact for retry.
    if ([bool]$transaction.commitAccepted) {
        Commit-PowerPointOpenTransaction
        return
    }

    $targetPath = [string]$transaction.targetPath
    $previousPath = [string]$transaction.previousPath
    $samePresentation = (-not [string]::IsNullOrEmpty($previousPath)) -and
        ($targetPath -ieq $previousPath)

    if (-not [bool]$transaction.targetReleased) {
        if ($samePresentation) {
            # Same-file OPEN reuses the previous document and slideshow. There
            # is no separate target to release; rollback below restores its
            # original slide and z-order.
            $transaction.targetReleased = $true
        } else {
            $targetWindow = $transaction.targetWindow
            if (-not $targetWindow -and -not [string]::IsNullOrEmpty($targetPath)) {
                $targetWindow = Resolve-ActiveSlideShowWindow $script:pptApplication $targetPath
                if ($targetWindow) { $transaction.targetWindow = $targetWindow }
            }

            $targetHwnd = [long]$transaction.targetHwnd
            $targetWindowExited = ($targetHwnd -eq 0) -or
                (-not [PptDaemon.Native]::IsWindow([System.IntPtr]$targetHwnd)) -or
                (-not [PptDaemon.Native]::IsWindowVisible([System.IntPtr]$targetHwnd))
            if ($targetWindow) {
                try {
                    $targetWindow.View.Exit()
                    if ($targetHwnd -ne 0) {
                        $exitDeadline = [DateTime]::UtcNow.AddMilliseconds(1500)
                        do {
                            $targetWindowExited = (-not [PptDaemon.Native]::IsWindow([System.IntPtr]$targetHwnd)) -or
                                (-not [PptDaemon.Native]::IsWindowVisible([System.IntPtr]$targetHwnd))
                            if (-not $targetWindowExited) { Start-Sleep -Milliseconds 50 }
                        } while (-not $targetWindowExited -and [DateTime]::UtcNow -lt $exitDeadline)
                    } else {
                        $targetWindowExited = $true
                    }
                } catch {
                    $targetWindowExited = $false
                    Log "abort-open: target slideshow exit failed: $($_.Exception.Message)"
                }
            } elseif (-not $targetWindowExited) {
                Log "abort-open: target COM window missing but slideshow hwnd=$targetHwnd is still visible"
            }

            $targetPresentation = $transaction.targetPresentation
            if ($targetPresentation -and (Test-PdmOwnedPresentation $targetPresentation)) {
                # Presentation.Close is authoritative for a managed target and
                # also exits its slideshow. A failed View.Exit is harmless when
                # the document itself is verified gone.
                $script:lastManagedPresentationCloseOk = $false
                Close-ManagedPresentation $targetPresentation
                $transaction.targetReleased = $script:lastManagedPresentationCloseOk
            } else {
                # A user-owned document stays open; only PDM's slideshow must
                # have exited before the old program output is restored.
                $transaction.targetReleased = $targetWindowExited
            }
        }
    }

    if (-not [bool]$transaction.previousRestored) {
        $previousWindow = $transaction.previousWindow
        if (-not $previousWindow -and -not [string]::IsNullOrEmpty($previousPath)) {
            $previousWindow = Resolve-ActiveSlideShowWindow $script:pptApplication $previousPath
            if ($previousWindow) { $transaction.previousWindow = $previousWindow }
        }
        if ($previousWindow) {
            try {
                if ($samePresentation -and [int]$transaction.previousSlide -gt 0) {
                    $previousWindow.View.GotoSlide([int]$transaction.previousSlide)
                }
                $previousHwnd = [long]$previousWindow.HWND
                $previousPresentation = $previousWindow.Presentation
                $script:activeSlideShowWindow = $previousWindow
                $script:activeSlideShowHwnd = $previousHwnd
                $script:activePresentation = $previousPresentation
                $script:activePresentationPath = [string]$previousPresentation.FullName
                if ($previousHwnd -ne 0) {
                    Raise-SlideShow $previousHwnd $transaction.targetRect
                }
                $transaction.previousRestored = $true
                Log "abort-open: previous slideshow restored path='$($script:activePresentationPath)' hwnd=$previousHwnd"
            } catch {
                Log "abort-open: previous slideshow restore failed: $($_.Exception.Message)"
            }
        } elseif ([string]::IsNullOrEmpty($previousPath)) {
            $script:activeSlideShowWindow = $null
            $script:activeSlideShowHwnd = 0
            $script:activePresentation = $null
            $script:activePresentationPath = ''
            $transaction.previousRestored = $true
        } else {
            Log "abort-open: previous slideshow was not found path='$previousPath'"
        }
    }

    $script:lastOpenTransactionOk = [bool]$transaction.targetReleased -and
        [bool]$transaction.previousRestored
    if ($script:lastOpenTransactionOk) {
        $script:openTransaction = $null
    } else {
        # Retain every COM reference and completion bit for an idempotent retry.
        # Clearing an incomplete transaction made a later abort-open return a
        # false success while the failed target still consumed memory/on-air.
        Log "abort-open: incomplete targetReleased=$($transaction.targetReleased) previousRestored=$($transaction.previousRestored); retained for retry"
    }
}

function Commit-PowerPointOpenTransaction {
    $transaction = $script:openTransaction
    $script:lastOpenTransactionOk = $true
    if (-not $transaction) { return }
    if (-not $transaction.verified) {
        $script:lastOpenTransactionOk = $false
        Log 'commit-open: rejected because target was not verified'
        return
    }

    $targetPath = [string]$transaction.targetPath
    $previousPath = [string]$transaction.previousPath
    Log 'commit-open: teardown OLD BEGIN'

    # Before ACK, revalidate the exact target through COM. After the Win32 ACK
    # has made it authoritative, never turn a transient COM rejection into a
    # rollback decision; this function is then only an idempotent retirement
    # job for old/hidden resources.
    $targetWindow = $transaction.targetWindow
    if (-not $targetWindow -and -not [bool]$transaction.commitAccepted) {
        $targetWindow = Resolve-ActiveSlideShowWindow $script:pptApplication $targetPath
    }
    $targetStillReady = [bool]$transaction.commitAccepted
    if (-not $targetStillReady -and $targetWindow) {
        try {
            $targetWindowPath = [string]$targetWindow.Presentation.FullName
            $targetWindowHwnd = [long]$targetWindow.HWND
            $null = [int]$targetWindow.View.Slide.SlideIndex
            $targetStillReady = ($targetWindowPath -ieq $targetPath) -and
                ($targetWindowHwnd -ne 0) -and
                [PptDaemon.Native]::IsWindow([System.IntPtr]$targetWindowHwnd)
            if ($targetStillReady) {
                $transaction.targetWindow = $targetWindow
                $transaction.targetHwnd = $targetWindowHwnd
            }
        } catch {}
    }
    if (-not $targetStillReady) {
        $script:lastOpenTransactionOk = $false
        Log "commit-open: target revalidation failed path='$targetPath'; previous output retained"
        return
    }

    # First release unrelated hidden PDM decks. Each record has its own
    # completion tombstone so a retry never dereferences an RCW that was
    # already closed by an earlier partial pass.
    foreach ($record in @($transaction.oldPresentationRecords)) {
        if (-not $record -or [bool]$record.retired) { continue }
        $path = [string]$record.path
        if ($path -ieq $targetPath -or $path -ieq $previousPath -or -not [bool]$record.managed) {
            $record.retired = $true
            continue
        }
        $script:lastManagedPresentationCloseOk = $false
        Close-ManagedPresentation $record.presentation
        if ($script:lastManagedPresentationCloseOk) {
            $record.retired = $true
        } else {
            $script:lastOpenTransactionOk = $false
            Log "commit-open: prerequisite presentation cleanup pending path='$path' identity='$($record.identity)'"
        }
    }

    # Retire the previous program only after every unrelated managed deck is
    # settled. Managed documents use exact COM identity; borrowed/user decks
    # keep their document open and only exit the exact stored slideshow HWND.
    if ($script:lastOpenTransactionOk) {
        if ([string]::IsNullOrEmpty($previousPath) -or $previousPath -ieq $targetPath) {
            $transaction.previousReleased = $true
            $transaction.previousWindowExited = $true
        } elseif ([bool]$transaction.previousManaged) {
            if (-not [bool]$transaction.previousReleased) {
                $script:lastManagedPresentationCloseOk = $false
                Close-ManagedPresentation $transaction.previousPresentation
                $transaction.previousReleased = $script:lastManagedPresentationCloseOk
            }
            if (-not [bool]$transaction.previousReleased) {
                $script:lastOpenTransactionOk = $false
                Log "commit-open: previous managed presentation cleanup pending path='$previousPath'"
            }
        } else {
            if (-not [bool]$transaction.previousWindowExited) {
                $previousHwnd = [long]$transaction.previousHwnd
                $previousGone = $false
                if ($previousHwnd -ne 0) {
                    $previousGone = (-not [PptDaemon.Native]::IsWindow([System.IntPtr]$previousHwnd)) -or
                        (-not [PptDaemon.Native]::IsWindowVisible([System.IntPtr]$previousHwnd))
                }
                if (-not $previousGone -and $transaction.previousWindow) {
                    $exitAccepted = $false
                    try {
                        $transaction.previousWindow.View.Exit()
                        $exitAccepted = $true
                    } catch {
                        Log "commit-open: previous user slideshow exit failed: $($_.Exception.Message)"
                    }
                    if ($previousHwnd -eq 0) {
                        $previousGone = $exitAccepted
                    } else {
                        $exitDeadline = [DateTime]::UtcNow.AddMilliseconds(1500)
                        do {
                            $previousGone = (-not [PptDaemon.Native]::IsWindow([System.IntPtr]$previousHwnd)) -or
                                (-not [PptDaemon.Native]::IsWindowVisible([System.IntPtr]$previousHwnd))
                            if (-not $previousGone) { Start-Sleep -Milliseconds 50 }
                        } while (-not $previousGone -and [DateTime]::UtcNow -lt $exitDeadline)
                    }
                }
                $transaction.previousWindowExited = $previousGone
            }
            if (-not [bool]$transaction.previousWindowExited) {
                $script:lastOpenTransactionOk = $false
                Log "commit-open: previous user slideshow cleanup pending path='$previousPath'"
            }
        }
    }

    Hide-PPEditor $script:pptApplication
    if ($script:lastOpenTransactionOk) {
        $script:openTransaction = $null
        Log 'commit-open: teardown OLD END ok=True'
    } else {
        $retainedFor = if ([bool]$transaction.commitAccepted) { 'retirement retry' } else { 'abort' }
        Log "commit-open: teardown OLD END ok=False; transaction retained for $retainedFor"
    }
}

function Reply($h) {
    [Console]::Out.WriteLine(($h | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
}

function Log($msg) {
    $ts = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
    [Console]::Error.WriteLine("[DAEMON $ts] $msg")
    [Console]::Error.Flush()
}

# Signal ready — main process reads this line before sending commands
Log "host ready languageMode=$($ExecutionContext.SessionState.LanguageMode) ps=$($PSVersionTable.PSVersion) process64=$([Environment]::Is64BitProcess) os64=$([Environment]::Is64BitOperatingSystem)"
Reply @{ id = 0; ok = $true; event = 'ready' }

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim().Length -eq 0) { continue }

    $id = 0
    $script:commandLinkedPicturesGuard = $null
    try {
        $req  = $line | ConvertFrom-Json
        if ($null -ne $req.id) { $id = [int]$req.id }
        $cmd  = [string]$req.cmd

        # Start before any COM validation: the current editor warning can itself
        # be the reason Presentations.Count/Open/Run is blocked.
        if ($cmd -in @('prepare','open','notes','export') -and $req.path) {
            $guardProcessId = [long]$script:pptOwnedProcessId
            if ($guardProcessId -eq 0 -and $script:pptOriginalEditorHwnd -ne 0) {
                $guardProcessId = [long][PptDaemon.Native]::GetWindowProcessId([long]$script:pptOriginalEditorHwnd)
            }
            $script:commandLinkedPicturesGuard = Start-PdmLinkedPicturesGuard $guardProcessId ([string]$req.path) ([long]$script:pptOwnedProcessStartTimeUtcTicks)
        }

        switch ($cmd) {
            'prepare' {
                $prepareStarted = [DateTime]::UtcNow
                $preparePath = [string]$req.path
                if ([string]::IsNullOrWhiteSpace($preparePath) -or
                    -not (Test-Path -LiteralPath $preparePath -PathType Leaf)) {
                    throw "Presentation file not found: $preparePath"
                }

                Log "prepare: BEGIN file='$preparePath'"
                $ppt = Get-OrCreatePPT
                # A PDM-owned PowerPoint instance can remain completely hidden.
                # If the user already had PowerPoint open, never minimize or hide
                # their editor just because a channel is being prepared.
                if ($script:pptOwnedByRoland) {
                    try { $ppt.WindowState = 2 } catch {}
                    try { $ppt.Visible = -1 } catch {}
                    Hide-PPEditor $ppt
                }

                $pres = $null
                $openedByPdm = $false
                try {
                    try {
                        for ($i = 1; $i -le $ppt.Presentations.Count; $i++) {
                            $candidate = $ppt.Presentations.Item($i)
                            try {
                                if ($candidate.FullName -ieq $preparePath) {
                                    $pres = $candidate
                                    break
                                }
                            } catch {}
                        }
                    } catch {}

                    if (-not $pres) {
                        try {
                            # ReadOnly=true, Untitled=false, WithWindow=false.
                            $pres = Open-PdmPowerPointPresentation $ppt $preparePath -1 0
                        } catch {
                            if (-not $script:pptOwnedByRoland) {
                                throw "Hidden PowerPoint preparation failed without changing the user's editor: $($_.Exception.Message)"
                            }
                            Log "prepare: hidden open failed, retrying in hidden PDM instance: $($_.Exception.Message)"
                            $pres = Open-PdmPowerPointPresentation $ppt $preparePath 0 -1
                            Hide-PPEditor $ppt
                        }
                        $openedByPdm = $true
                        Mark-ManagedPresentation $pres
                    }

                    # Only PDM-owned documents participate in automatic release.
                    # A presentation that the user had already opened is reused for
                    # TAKE, but is never closed or otherwise owned by PDM.
                    if ($openedByPdm -or (Test-ManagedPresentation $pres)) {
                        Mark-PreparedPresentation $pres
                    }
                    $count = [int]$pres.Slides.Count
                    if ($count -lt 1) { throw 'Presentation contains no slides' }
                    $slideWidth = [double]$pres.PageSetup.SlideWidth
                    $slideHeight = [double]$pres.PageSetup.SlideHeight
                    if ($script:pptOwnedByRoland) { Hide-PPEditor $ppt }
                    $prepareMs = [int]([DateTime]::UtcNow - $prepareStarted).TotalMilliseconds
                    Log "prepare: READY file='$preparePath' slides=$count size=${slideWidth}x${slideHeight} dur=${prepareMs}ms managed=$(Test-ManagedPresentation $pres)"
                    Reply @{ id = $id; ok = $true; slideCount = $count; slideWidth = $slideWidth; slideHeight = $slideHeight }
                } catch {
                    $prepareError = [string]$_.Exception.Message
                    if ($pres -and $openedByPdm -and (Test-PdmOwnedPresentation $pres)) {
                        $script:lastManagedPresentationCloseOk = $false
                        Close-ManagedPresentation $pres
                        if (-not $script:lastManagedPresentationCloseOk) {
                            $prepareError = "$prepareError; failed preparation deck was not released"
                        }
                    }
                    Release-IdleOwnedPowerPointHost 'failed-prepare'
                    if (-not $script:lastIdleOwnedPowerPointHostReleaseOk) {
                        $prepareError = "$prepareError; idle PowerPoint host was not released"
                    }
                    throw $prepareError
                }
            }
            'sync-prepared' {
                $desired = @{}
                try {
                    foreach ($requestedPath in @($req.paths)) {
                        $key = ([string]$requestedPath).ToLowerInvariant()
                        if (-not [string]::IsNullOrWhiteSpace($key)) { $desired[$key] = $true }
                    }
                } catch {}
                # Defensive protocol guard: Electron serializes these commands,
                # but never let cache synchronization release either side of an
                # in-flight transactional TAKE if an older client interleaves it.
                if ($script:openTransaction) {
                    foreach ($transactionPath in @(
                        [string]$script:openTransaction.targetPath,
                        [string]$script:openTransaction.previousPath
                    )) {
                        $transactionKey = $transactionPath.ToLowerInvariant()
                        if (-not [string]::IsNullOrWhiteSpace($transactionKey)) {
                            $desired[$transactionKey] = $true
                        }
                    }
                }

                $ppt = Get-PPT
                $released = 0
                $releaseFailed = 0
                $releaseErrors = New-Object System.Collections.Generic.List[string]
                if ($ppt) {
                    if (-not (Close-UnidentifiedManagedPresentations)) {
                        $releaseFailed++
                        $null = $releaseErrors.Add('<unidentified managed presentation>')
                    }
                    $seenPresentationKeys = @{}
                    $seenPresentationIdentities = @{}
                    for ($i = [int]$ppt.Presentations.Count; $i -ge 1; $i--) {
                        $candidate = $ppt.Presentations.Item($i)
                        # A failed export/notes cleanup can leave a deck marked
                        # managed without ever marking it prepared. It is still
                        # PDM-owned memory and must participate in the same
                        # release pass. User-owned decks match neither set.
                        $isPrepared = Test-PreparedPresentation $candidate
                        $isManaged = Test-ManagedPresentation $candidate
                        $key = Get-PresentationKey $candidate
                        if (-not [string]::IsNullOrEmpty($key)) {
                            $seenPresentationKeys[$key] = $true
                        }
                        $candidateIdentity = Get-PresentationIdentity $candidate
                        if (-not [string]::IsNullOrEmpty($candidateIdentity)) {
                            $seenPresentationIdentities[$candidateIdentity] = $true
                        }
                        if (-not $isPrepared -and -not $isManaged) { continue }
                        if ($desired.ContainsKey($key)) { continue }

                        $isActive = $false
                        try {
                            $isActive = (-not [string]::IsNullOrEmpty($script:activePresentationPath)) -and
                                ([string]$candidate.FullName -ieq $script:activePresentationPath)
                        } catch {}
                        if ($isActive) {
                            Unmark-PreparedPresentation $candidate
                            Log "sync-prepared: deferred active release '$key'"
                        } elseif ($isManaged) {
                            $script:lastManagedPresentationCloseOk = $false
                            Close-ManagedPresentation $candidate
                            if ($script:lastManagedPresentationCloseOk) {
                                $released++
                                Log "sync-prepared: released '$key'"
                            } else {
                                $releaseFailed++
                                $null = $releaseErrors.Add($key)
                                Log "sync-prepared: release FAILED '$key'; tracking retained for retry"
                            }
                        } else {
                            # User-owned presentations are never closed by PDM,
                            # but they must not remain in the prepared set.
                            Unmark-PreparedPresentation $candidate
                        }
                    }

                    # A Close can succeed while its immediate verification hits
                    # a transient RPC error. In that case Close-ManagedPresentation
                    # deliberately keeps the path key for retry. Once a later,
                    # complete Presentations enumeration proves that path absent,
                    # discard the stale ownership marker. Otherwise a user who
                    # later opens the same file in their own PowerPoint session
                    # could be mistaken for the old PDM-owned COM object.
                    $protectedTrackingKeys = @{}
                    foreach ($protectedPath in @(
                        [string]$script:activePresentationPath,
                        $(if ($script:openTransaction) { [string]$script:openTransaction.targetPath } else { '' }),
                        $(if ($script:openTransaction) { [string]$script:openTransaction.previousPath } else { '' })
                    )) {
                        $protectedKey = $protectedPath.ToLowerInvariant()
                        if (-not [string]::IsNullOrWhiteSpace($protectedKey)) {
                            $protectedTrackingKeys[$protectedKey] = $true
                        }
                    }
                    try {
                        $activeObjectKey = Get-PresentationKey $script:activePresentation
                        if (-not [string]::IsNullOrWhiteSpace($activeObjectKey)) {
                            $protectedTrackingKeys[$activeObjectKey] = $true
                        }
                    } catch {}
                    $protectedTrackingIdentities = @{}
                    foreach ($protectedObject in @(
                        $script:activePresentation,
                        $(if ($script:openTransaction) { $script:openTransaction.targetPresentation } else { $null }),
                        $(if ($script:openTransaction) { $script:openTransaction.previousPresentation } else { $null })
                    )) {
                        $protectedIdentity = Get-PresentationIdentity $protectedObject
                        if (-not [string]::IsNullOrWhiteSpace($protectedIdentity)) {
                            $protectedTrackingIdentities[$protectedIdentity] = $true
                        }
                    }
                    foreach ($trackedIdentity in @($script:managedPresentationIdentities.Keys)) {
                        if ($seenPresentationIdentities.ContainsKey($trackedIdentity) -or
                            $protectedTrackingIdentities.ContainsKey($trackedIdentity)) { continue }
                        $script:managedPresentationIdentities.Remove($trackedIdentity)
                        Log "sync-prepared: removed absent stale managed identity '$trackedIdentity'"
                    }
                    foreach ($trackedKey in @($script:managedPresentationKeys.Keys)) {
                        if ($seenPresentationKeys.ContainsKey($trackedKey) -or
                            $protectedTrackingKeys.ContainsKey($trackedKey)) { continue }
                        $script:managedPresentationKeys.Remove($trackedKey)
                        $script:preparedPresentationKeys.Remove($trackedKey)
                        Log "sync-prepared: removed absent stale managed key '$trackedKey'"
                    }
                    foreach ($trackedKey in @($script:preparedPresentationKeys.Keys)) {
                        if ($seenPresentationKeys.ContainsKey($trackedKey) -or
                            $protectedTrackingKeys.ContainsKey($trackedKey)) { continue }
                        $script:preparedPresentationKeys.Remove($trackedKey)
                        Log "sync-prepared: removed absent stale prepared key '$trackedKey'"
                    }
                    if ($script:pptOwnedByRoland -and -not (Test-PowerPointHasAnySlideShow $ppt)) {
                        try { $ppt.Visible = 0 } catch {}
                    }
                }
                if ($releaseFailed -eq 0) {
                    Release-IdleOwnedPowerPointHost 'sync-prepared'
                    if (-not $script:lastIdleOwnedPowerPointHostReleaseOk) {
                        $releaseFailed++
                        $null = $releaseErrors.Add('<idle PowerPoint host>')
                    }
                } elseif ($script:pptOwnedByRoland -and
                    -not $script:openTransaction -and
                    -not (Test-PowerPointHasAnySlideShow $ppt)) {
                    # Presentation.Close can remain blocked by an idle COM host
                    # even after bounded retries. Only a process proven to have
                    # been created by PDM may be recycled, and Restore performs
                    # a second ownership scan so an untracked user document
                    # disables Quit/force automatically.
                    Log "sync-prepared: managed release failed; recycling verified idle PDM-owned host"
                    Restore-PowerPointSession
                    if ($script:lastPowerPointSessionCleanupOk) {
                        $released += $releaseFailed
                        $releaseFailed = 0
                        $releaseErrors.Clear()
                        $ppt = $null
                        Log 'sync-prepared: idle PDM-owned host recycle verified'
                    } else {
                        Log 'sync-prepared: idle PDM-owned host recycle FAILED; tracking retained'
                    }
                }
                if ($releaseFailed -gt 0) {
                    Reply @{
                        id = $id
                        ok = $false
                        released = $released
                        failed = $releaseFailed
                        error = "PowerPoint did not release managed presentation(s): $($releaseErrors -join '; ')"
                    }
                } else {
                    Reply @{ id = $id; ok = $true; released = $released; failed = 0 }
                }
            }
            'open' {
                if ($script:openTransaction) {
                    Log 'open: aborting an unfinished previous transaction'
                    Abort-PowerPointOpenTransaction
                    if (-not $script:lastOpenTransactionOk) {
                        throw 'Previous PowerPoint open transaction could not be rolled back safely'
                    }
                }
                Reset-SlideVideoClickState
                $previousActiveWindow = Resolve-PdmSlideShowWindow $script:pptApplication
                $previousActivePresentation = $script:activePresentation
                $previousActivePath = [string]$script:activePresentationPath
                $previousActiveSlide = 0
                try {
                    if ($previousActiveWindow) {
                        $previousActiveSlide = [int]$previousActiveWindow.View.Slide.SlideIndex
                    }
                } catch {}
                $script:activeSlideShowHwnd = 0
                $targetRect = $null
                try {
                    if ($null -ne $req.bounds) {
                        $bx = [int]$req.bounds.x
                        $by = [int]$req.bounds.y
                        $bw = [int]$req.bounds.width
                        $bh = [int]$req.bounds.height
                        if ($bw -gt 0 -and $bh -gt 0) {
                            $targetRect = @($bx, $by, $bw, $bh)
                            Log "open: target display bounds x=$bx y=$by w=$bw h=$bh"
                        }
                    }
                } catch { Log "open: invalid target bounds: $($_.Exception.Message)" }
                $clipRect = $null
                $cornerRadius = 0
                $transitionDurationMs = 0
                try {
                    if ($null -ne $req.clipBounds) {
                        $cx = [int]$req.clipBounds.x; $cy = [int]$req.clipBounds.y
                        $cw = [int]$req.clipBounds.width; $ch = [int]$req.clipBounds.height
                        if ($cw -gt 0 -and $ch -gt 0) { $clipRect = @($cx, $cy, $cw, $ch) }
                    }
                    if ($null -ne $req.cornerRadius) { $cornerRadius = [Math]::Max(0, [int]$req.cornerRadius) }
                    if ($null -ne $req.transitionDurationMs) {
                        $transitionDurationMs = [Math]::Max(0, [Math]::Min(5000, [int]$req.transitionDurationMs))
                    }
                } catch {}
                $underlayHwnd = 0
                try {
                    if ($null -ne $req.underlayHwnd) {
                        $underlayHwnd = [long]$req.underlayHwnd
                    }
                } catch {}
                if ($underlayHwnd -ne 0) { Log "open: persistent output HWND=$underlayHwnd" }
                $deferPromotion = $false
                try { $deferPromotion = [bool]$req.deferPromotion } catch {}

                $ppt = Get-OrCreatePPT
                # Hide an existing editor synchronously BEFORE changing its COM
                # WindowState. Otherwise Windows can visibly animate it from the
                # operator desktop into the taskbar on the first TAKE. A
                # user-owned editor is restored to its captured state on exit.
                Hide-PPEditor $ppt
                # Hint PP to keep/create its editor minimized before Visible=true.
                try { $ppt.WindowState = 2 } catch {}  # ppWindowMinimized
                $ppt.Visible = -1  # Microsoft.Office.Core.MsoTriState.msoTrue
                # IMMEDIATELY hide editor HWND via Win32 SW_HIDE. Without this,
                # the editor window stays visible on the external display for
                # the entire duration of Presentations.Open + Run() (200-700ms),
                # which is what the user sees as "flicker" — on some frames the
                # editor is fully visible on the external display before the
                # fullscreen slideshow takes over. See control script for the
                # same pattern in Export-Thumbnails / Export-Slides.
                Hide-PPEditor $ppt

                # Capture OPEN slideshow windows + presentations BEFORE loading
                # the new file. We keep the old slideshow running while we
                # start the new one, so the screen never drops to desktop or
                # editor between transitions — the new fullscreen slideshow
                # paints on top, then we tear down the old one under it.
                $oldSW = New-Object System.Collections.ArrayList
                try {
                    for ($i = 1; $i -le $ppt.SlideShowWindows.Count; $i++) {
                        $null = $oldSW.Add($ppt.SlideShowWindows.Item($i))
                    }
                } catch {}
                # The collection may be transiently empty after the previous
                # switch. The direct cached COM reference is still the real old
                # slideshow and must be included in teardown/reuse decisions.
                $cachedOldSW = Resolve-PdmSlideShowWindow $ppt
                if ($cachedOldSW) {
                    $cachedOldPath = ''
                    try { $cachedOldPath = [string]$cachedOldSW.Presentation.FullName } catch {}
                    $alreadyListed = $false
                    foreach ($candidateSW in $oldSW) {
                        try {
                            if ($candidateSW.Presentation.FullName -ieq $cachedOldPath) {
                                $alreadyListed = $true
                                break
                            }
                        } catch {}
                    }
                    if (-not $alreadyListed) { $null = $oldSW.Add($cachedOldSW) }
                }
                $oldPres = New-Object System.Collections.ArrayList
                try {
                    for ($i = 1; $i -le $ppt.Presentations.Count; $i++) {
                        $null = $oldPres.Add($ppt.Presentations.Item($i))
                    }
                } catch {}
                if ($script:activePresentation) {
                    $cachedPresPath = ''
                    try { $cachedPresPath = [string]$script:activePresentation.FullName } catch {}
                    $alreadyListed = $false
                    foreach ($candidatePres in $oldPres) {
                        try {
                            if ($candidatePres.FullName -ieq $cachedPresPath) {
                                $alreadyListed = $true
                                break
                            }
                        } catch {}
                    }
                    if (-not $alreadyListed -and -not [string]::IsNullOrEmpty($cachedPresPath)) {
                        $null = $oldPres.Add($script:activePresentation)
                    }
                }

                $oldPresentationRecords = New-Object System.Collections.ArrayList
                foreach ($candidatePres in $oldPres) {
                    $candidatePath = ''
                    try { $candidatePath = [string]$candidatePres.FullName } catch {}
                    $null = $oldPresentationRecords.Add(@{
                        presentation = $candidatePres
                        path = $candidatePath
                        identity = $(Get-PresentationIdentity $candidatePres)
                        managed = $(Test-ManagedPresentation $candidatePres)
                        retired = $false
                    })
                }
                $previousHwnd = 0
                try { if ($previousActiveWindow) { $previousHwnd = [long]$previousActiveWindow.HWND } } catch {}

                $script:openTransaction = @{
                    targetPath = [string]$req.path
                    targetRect = $targetRect
                    previousPath = $previousActivePath
                    previousWindow = $previousActiveWindow
                    previousPresentation = $previousActivePresentation
                    previousSlide = $previousActiveSlide
                    oldWindows = @($oldSW)
                    oldPresentations = @($oldPres)
                    oldPresentationRecords = @($oldPresentationRecords)
                    targetWindow = $null
                    targetPresentation = $null
                    targetManaged = $false
                    targetIsPrevious = $false
                    targetSharesPreviousPresentation = $false
                    presentationRelationshipKnown = $false
                    targetHwnd = 0
                    targetReleased = $false
                    previousRestored = $false
                    previousManaged = $(Test-ManagedPresentation $previousActivePresentation)
                    previousHwnd = $previousHwnd
                    previousReleased = $false
                    previousWindowExited = $false
                    verified = $false
                    commitAccepted = $false
                }

                # Same-file re-open: Presentations.Open returns the existing
                # Presentation object — don't try to close it afterward.
                $existingPres = $null
                foreach ($p in $oldPres) {
                    try { if ($p.FullName -ieq $req.path) { $existingPres = $p; break } } catch {}
                }

                if ($existingPres) {
                    $pres = $existingPres
                } else {
                    # WithWindow=msoFalse(0) — load without an editor document
                    # window so the PowerPoint editor never flashes on screen.
                    # Args: FileName, ReadOnly=0, Untitled=0, WithWindow=0.
                    try {
                        $pres = Open-PdmPowerPointPresentation $ppt ([string]$req.path) 0 0
                    } catch {
                        $pres = Open-PdmPowerPointPresentation $ppt ([string]$req.path) 0 -1
                    }
                    # Publish the exact RCW to rollback before ownership
                    # registration. Mark-ManagedPresentation deliberately
                    # throws when IUnknown identity is unavailable; Abort must
                    # still be able to close that quarantined PDM-opened deck.
                    $script:openTransaction.targetPresentation = $pres
                    Mark-ManagedPresentation $pres
                }
                $script:openTransaction.targetPresentation = $pres
                # Only an identity-backed PDM ownership record authorizes the
                # out-of-process emergency helper to close this presentation.
                # Quarantine/path-only tracking stays fail-closed.
                $script:openTransaction.targetManaged = $(Test-PdmOwnedPresentation $pres)
                $targetPresentationIdentity = Get-PresentationIdentity $pres
                $previousPresentationIdentity = Get-PresentationIdentity $previousActivePresentation
                if (-not [string]::IsNullOrEmpty($targetPresentationIdentity) -and
                    -not [string]::IsNullOrEmpty($previousPresentationIdentity)) {
                    $script:openTransaction.presentationRelationshipKnown = $true
                    $script:openTransaction.targetSharesPreviousPresentation =
                        $targetPresentationIdentity -eq $previousPresentationIdentity
                }

                $count = $pres.Slides.Count
                $startSlide = 1
                if ($null -ne $req.slide) {
                    $n = [int]$req.slide
                    if ($n -ge 1 -and $n -le $count) { $startSlide = $n }
                }

                # Is a slideshow already running for this exact presentation?
                $existingSW = $null
                try {
                    for ($i = 1; $i -le $ppt.SlideShowWindows.Count; $i++) {
                        $sw = $ppt.SlideShowWindows.Item($i)
                        if ($sw.Presentation.FullName -ieq $pres.FullName) { $existingSW = $sw; break }
                    }
                } catch {}
                if (-not $existingSW) {
                    $existingSW = Resolve-ActiveSlideShowWindow $ppt ([string]$pres.FullName)
                }

                $newSW = $null
                $createdNewSlideShow = $false
                if ($existingSW) {
                    $newSW = $existingSW
                    try { if ([int]$newSW.View.Slide.SlideIndex -ne $startSlide) { $newSW.View.GotoSlide($startSlide) } } catch {}
                } else {
                    $createdNewSlideShow = $true
                    $s = $pres.SlideShowSettings
                    $s.ShowType = 1  # ppShowTypeSpeaker
                    # Never let PowerPoint open Presenter View fullscreen on the
                    # operator's primary monitor. The control app must stay there.
                    try { $s.ShowPresenterView = $false } catch {}
                    # Force manual advance — some PPTX files have slides set
                    # to auto-advance on a timer (SlideShowTransition.AdvanceOnTime).
                    # Left as-is, PowerPoint would march through slides on its
                    # own while the Electron UI thinks nothing changed, so the
                    # external display ends up one or more slides ahead of the
                    # in-app slide number. ppSlideShowManualAdvance = 1.
                    try { $s.AdvanceMode = 1 } catch {}
                    # Loop: после последнего слайда View.Next() переходит на
                    # первый вместо Exit. Аналогично с Previous() с первого
                    # на последний. В Speaker mode работает как мягкий цикл,
                    # без авто-advance.
                    try { $s.LoopUntilStopped = $true } catch {}
                    # НЕ используем RangeType=2 (ppShowSlideRange) даже для
                    # startSlide > 1 — иначе slideshow создаётся с диапазоном
                    # [startSlide..count], и SlideShowView.Slides.Count = размер
                    # диапазона, не размер презы. GotoSlide(N) работает на индекс
                    # ВНУТРИ диапазона: GotoSlide(8) при startSlide=9 даёт
                    # "out of range 1 to 1" если файл 9 слайдов. Backward-
                    # навигация ломается полностью. Вместо этого запускаем
                    # slideshow на полный диапазон, post-Run GotoSlide($startSlide)
                    # ниже перепрыгнет на нужный слайд (под overlay невидимо).
                    # Zero out the entry transition on the starting slide.
                    # PPTX templates often apply a Fade/Wipe/Spotlight effect
                    # (500-1500ms) that fires on Run(). The overlay hides
                    # ~750ms after show — often BEFORE the animation finishes
                    # — and the user sees a flash of the mid-animation frame.
                    # Forcing EntryEffect=0 on just the start slide means the
                    # slideshow appears already-painted when the overlay lifts.
                    # Not persisted (we never call pres.Save()).
                    try {
                        $tr = $pres.Slides.Item($startSlide).SlideShowTransition
                        $tr.EntryEffect = 0   # ppEffectNone
                        $tr.Duration    = 0
                    } catch {}
                    # Snapshot existing screenClass windows BEFORE Run(). The
                    # parallel poller below diffs against this to find the
                    # newly-created slideshow HWND.
                    $oldSlideHwnds = [PptDaemon.Native]::FindSlideShowHwnds()

                    # Start a native polling thread synchronously. Unlike a
                    # PowerShell runspace it is guaranteed to be running before
                    # the blocking COM Run() begins.
                    try {
                        $guardX = 0; $guardY = 0; $guardW = 0; $guardH = 0
                        if ($null -ne $targetRect -and $targetRect.Count -eq 4) {
                            $guardX = [int]$targetRect[0]; $guardY = [int]$targetRect[1]
                            $guardW = [int]$targetRect[2]; $guardH = [int]$targetRect[3]
                        }
                        [PptDaemon.Native]::StartSlideShowGuard(
                            [long[]]$oldSlideHwnds, $guardX, $guardY, $guardW, $guardH
                        )
                    } catch { Log "native slideshow guard start failed: $($_.Exception.Message)" }

                    # PARALLEL POLLER — the core of the flicker fix.
                    # Problem: Run() is a blocking COM call (~92ms). Inside it,
                    # PP creates the slideshow window with WS_EX_TOPMOST. Our
                    # Electron overlay is screen-saver level = HWND_TOPMOST on
                    # Windows (NOT higher than WS_EX_TOPMOST — they're equal).
                    # The two topmost windows race in the DWM compositor each
                    # 16.67ms frame, and PP wins some frames → visible flash.
                    # All our previous mitigations (NOTOPMOST, SW_HIDE, etc.)
                    # ran AFTER Run() returned — too late, flash already shown.
                    # Fix: a background PowerShell runspace polls every 2ms
                    # during Run(). The moment PP creates screenClass, the
                    # runspace drops WS_EX_TOPMOST via SetWindowPos(HWND_NOTOPMOST).
                    # That happens within ~2ms of window creation — before DWM
                    # paints a frame with the new topmost active. No race, no
                    # flash.
                    # Safety: runspaces share the CLR AppDomain, so the static
                    # PptDaemon.Native type is accessible from the runspace.
                    # P/Invoke is thread-safe. COM is NOT touched from the
                    # runspace — only Win32 APIs.
                    $poller = $null
                    $pollerHandle = $null
                    $runStartTicks = [DateTime]::UtcNow.Ticks
                    $shared = [hashtable]::Synchronized(@{
                        stop = $false; foundHwnd = 0
                        iterations = 0; caughtTicks = 0L
                        exStyleBefore = 0; err = ''
                        runStartTicks = $runStartTicks
                    })
                    try {
                        $poller = [powershell]::Create()
                        $null = $poller.AddScript({
                            param($oldHwnds, $shared, $targetRect)
                            # Runspaces use another OS thread, so DPI awareness
                            # must be set here as well as on the daemon thread.
                            try {
                                [PptDaemon.Native]::SetThreadDpiAwarenessContext(
                                    [System.IntPtr](-4)
                                ) | Out-Null
                            } catch {}
                            $deadline = [DateTime]::UtcNow.AddMilliseconds(1500)
                            while (-not $shared.stop -and [DateTime]::UtcNow -lt $deadline) {
                                try {
                                    $shared.iterations++
                                    foreach ($h in [PptDaemon.Native]::FindSlideShowHwnds()) {
                                        if ($oldHwnds -notcontains $h) {
                                            # Read WS_EX_TOPMOST BEFORE we change it.
                                            # GWL_EXSTYLE = -20. WS_EX_TOPMOST = 0x8.
                                            try {
                                                $shared.exStyleBefore =
                                                    [PptDaemon.Native]::GetWindowLong([System.IntPtr]$h, -20)
                                            } catch {}
                                            if ($null -ne $targetRect -and $targetRect.Count -eq 4) {
                                                # HWND_NOTOPMOST=-2; SWP_NOACTIVATE=0x10.
                                                # Place the window before DWM paints its first frame.
                                                [PptDaemon.Native]::SetWindowPos(
                                                    [System.IntPtr]$h, [System.IntPtr]-2,
                                                    [int]$targetRect[0], [int]$targetRect[1],
                                                    [int]$targetRect[2], [int]$targetRect[3],
                                                    0x10) | Out-Null
                                            } else {
                                                # Fallback when no display bounds were supplied.
                                                [PptDaemon.Native]::SetWindowPos(
                                                    [System.IntPtr]$h, [System.IntPtr]-2,
                                                    0, 0, 0, 0, 0x13) | Out-Null
                                            }
                                            $shared.foundHwnd = $h
                                            $shared.caughtTicks = [DateTime]::UtcNow.Ticks
                                            return
                                        }
                                    }
                                } catch { $shared.err = $_.Exception.Message }
                                Start-Sleep -Milliseconds 2
                            }
                        }).AddArgument($oldSlideHwnds).AddArgument($shared).AddArgument($targetRect)
                        $pollerHandle = $poller.BeginInvoke()
                    } catch { Log "poller start failed: $($_.Exception.Message)" }

                    $runResult = $null
                    Log "Run() BEGIN"
                    try { $runResult = $s.Run() } catch {
                        Log "Run() threw: $($_.Exception.Message)"
                        # Some PowerPoint versions require a document window
                        # to start a slideshow — give it one and retry.
                        try { $null = $pres.NewWindow() } catch {}
                        try { $runResult = $s.Run() } catch { Log "Run() retry threw: $($_.Exception.Message)" }
                    }
                    $runEndTicks = [DateTime]::UtcNow.Ticks
                    Log "Run() END dur=$([int](($runEndTicks - $runStartTicks)/10000))ms"

                    # PowerPoint can publish the visible screenClass shortly
                    # after Run() returns. Keep the native guard alive through
                    # that asynchronous tail instead of stopping it too early.
                    $nativeGuardWait = [System.Diagnostics.Stopwatch]::StartNew()
                    while (
                        [PptDaemon.Native]::SlideGuardFoundHwnd -eq 0 -and
                        $nativeGuardWait.ElapsedMilliseconds -lt 750
                    ) {
                        Start-Sleep -Milliseconds 1
                    }
                    if ([PptDaemon.Native]::SlideGuardFoundHwnd -ne 0) {
                        Start-Sleep -Milliseconds 50
                    }
                    try { [PptDaemon.Native]::StopSlideShowGuard() } catch {}
                    $nativeCaughtRel = if ([PptDaemon.Native]::SlideGuardCaughtTicks -gt 0) {
                        [int](([PptDaemon.Native]::SlideGuardCaughtTicks - $runStartTicks)/10000)
                    } else { -1 }
                    Log ("native guard iter={0} foundHwnd={1} caughtAtMs={2} exStyle=0x{3:x8} err='{4}'" -f `
                        [PptDaemon.Native]::SlideGuardIterations,
                        [PptDaemon.Native]::SlideGuardFoundHwnd,
                        $nativeCaughtRel,
                        [PptDaemon.Native]::SlideGuardExStyleBefore,
                        [PptDaemon.Native]::SlideGuardError)

                    # Signal poller and clean up. If it already caught the
                    # window, BeginInvoke has completed and EndInvoke returns
                    # immediately. If it's still waiting, stop flag terminates
                    # it on next iteration (within 2ms).
                    $shared.stop = $true
                    if ($pollerHandle) {
                        try { $poller.EndInvoke($pollerHandle) | Out-Null } catch {}
                    }
                    if ($poller) { try { $poller.Dispose() } catch {} }
                    $caughtRel = if ($shared.caughtTicks -gt 0) {
                        [int](($shared.caughtTicks - $runStartTicks)/10000)
                    } else { -1 }
                    $exStyle = [int]$shared.exStyleBefore
                    $wasTopmost = if (($exStyle -band 0x8) -ne 0) { 'YES' } else { 'no' }
                    Log ("poller iter={0} foundHwnd={1} caughtAtMs={2} WS_EX_TOPMOST={3} exStyle=0x{4:x8} err='{5}'" -f `
                        $shared.iterations, [long]$shared.foundHwnd, $caughtRel, $wasTopmost, $exStyle, $shared.err)
                    if ($runResult) { $newSW = $runResult }
                    if (-not $newSW) { try { $newSW = $pres.SlideShowWindow } catch {} }
                    if (-not $newSW) {
                        try {
                            for ($i = 1; $i -le $ppt.SlideShowWindows.Count; $i++) {
                                $sw = $ppt.SlideShowWindows.Item($i)
                                if ($sw.Presentation.FullName -ieq $pres.FullName) { $newSW = $sw; break }
                            }
                        } catch {}
                    }
                    if ($newSW -and $startSlide -gt 1) {
                        try {
                            if ([int]$newSW.View.Slide.SlideIndex -ne $startSlide) {
                                $newSW.View.GotoSlide($startSlide)
                            }
                        } catch {}
                    }
                }

                # Drop WS_EX_TOPMOST on the new slideshow window IMMEDIATELY —
                # this keeps it UNDER the Electron overlay (which is at
                # screen-saver topmost) during the whole transition, so the
                # old-exit / new-activate / editor-refocus events all happen
                # hidden behind the freeze-frame overlay. Overlay fades out at
                # the end and the new slide is revealed in its painted state.
                $newHwnd = 0
                if ($newSW) { try { $newHwnd = [long]$newSW.HWND } catch {} }
                if ($newHwnd -eq 0) {
                    # A slideshow hidden by the native pre-paint guard can
                    # temporarily report HWND=0 through COM. The guard already
                    # owns the real native handle, so use it for the final show.
                    try { $newHwnd = [long][PptDaemon.Native]::SlideGuardFoundHwnd } catch {}
                }
                if ($newHwnd -eq 0) {
                    try { $newHwnd = [long]$shared.foundHwnd } catch {}
                }
                if ($newHwnd -eq 0) {
                    try {
                        $visibleSlideShows = @([PptDaemon.Native]::FindSlideShowHwnds())
                        if ($visibleSlideShows.Count -gt 0) {
                            $newHwnd = [long]$visibleSlideShows[$visibleSlideShows.Count - 1]
                        }
                    } catch {}
                }
                $script:activeSlideShowHwnd = $newHwnd
                $script:activeSlideShowWindow = $newSW
                $script:activePresentation = $pres
                $script:activePresentationPath = [string]$pres.FullName
                $script:openTransaction.targetWindow = $newSW
                $script:openTransaction.targetHwnd = $newHwnd
                # Same-file TAKE reuses the exact live slideshow. An
                # out-of-process rollback must restore its previous slide,
                # never close/exit what is also the last committed output.
                $script:openTransaction.targetIsPrevious =
                    $previousHwnd -ne 0 -and
                    $newHwnd -eq $previousHwnd -and
                    -not [string]::IsNullOrEmpty($previousActivePath) -and
                    ([string]$pres.FullName -ieq $previousActivePath)
                $stagingCoverHwnd = $underlayHwnd
                foreach ($candidateSW in $oldSW) {
                    try {
                        if ($candidateSW.Presentation.FullName -ine $pres.FullName) {
                            $candidateHwnd = [long]$candidateSW.HWND
                            if ($candidateHwnd -ne 0) { $stagingCoverHwnd = $candidateHwnd }
                        }
                    } catch {}
                }
                if ($newHwnd -ne 0) {
                    Log "place slideshow HWND=$newHwnd targetRect=$($targetRect -join ',')"
                    Set-SlideShowBounds $newHwnd $targetRect
                }

                # Warm the new slideshow while the actual old output remains
                # above it. A hidden HWND gets no stable DWM surface, so simply
                # ShowWindow + DwmFlush used to expose a blank/partial first
                # frame. Showing it behind the old PDF/PPTX lets PowerPoint paint
                # normally; only the already-composed HWND is then raised once.
                if ($newHwnd -ne 0) {
                    for ($t = 0; $t -lt 3; $t++) {
                        Start-Sleep -Milliseconds 15
                        Set-SlideShowBounds $newHwnd $targetRect
                        Hide-PPEditor $ppt
                    }
                    Set-SlideShowClip $newHwnd $targetRect $clipRect $cornerRadius
                    if ($createdNewSlideShow -and $stagingCoverHwnd -ne 0) {
                        Place-SlideShowBehind $newHwnd $stagingCoverHwnd $targetRect
                    }
                    [PptDaemon.Native]::ShowWindow([System.IntPtr]$newHwnd, 4) | Out-Null
                    if ($createdNewSlideShow -and $stagingCoverHwnd -ne 0) {
                        Place-SlideShowBehind $newHwnd $stagingCoverHwnd $targetRect
                    }
                    try { [PptDaemon.Native]::DwmFlush() | Out-Null } catch {}
                    Start-Sleep -Milliseconds 50
                    try { [PptDaemon.Native]::DwmFlush() | Out-Null } catch {}
                    Log "warmed slideshow behind HWND=$stagingCoverHwnd"
                    if ($deferPromotion) {
                        Log "staged warmed slideshow behind persistent output HWND=$underlayHwnd"
                    } else {
                        $atomicPromotion = [PptDaemon.Native]::PromoteWarmedOutput(
                            [System.IntPtr]$newHwnd, [System.IntPtr]$underlayHwnd)
                        if (-not $atomicPromotion) {
                            # On an unavailable batch, expose the prepared
                            # replacement FIRST; never drop the old cover first.
                            Raise-SlideShow $newHwnd $targetRect
                            try { [PptDaemon.Native]::DwmFlush() | Out-Null } catch {}
                            if ($underlayHwnd -ne 0 -and $underlayHwnd -ne $newHwnd) {
                                Lower-Window $underlayHwnd
                            }
                        }
                        Log "warmed output promotion atomic=$atomicPromotion"
                        try { [PptDaemon.Native]::DwmFlush() | Out-Null } catch {}
                        Log "promoted warmed slideshow HWND=$newHwnd"
                    }
                }

                # The Win32 slideshow is already created, positioned and stable.
                # Notify the control UI now; the COM collection verification below
                # may legitimately need several more seconds on some Office builds.
                # Every check is deliberate: a false negative merely keeps the
                # message a little longer, while a false positive would hide it
                # before the slide has actually appeared.
                $visibleSlide = 0
                try {
                    if (($null -ne $newSW) -and ($newHwnd -ne 0) -and
                        [PptDaemon.Native]::IsWindowVisible([System.IntPtr]$newHwnd) -and
                        ($newSW.Presentation.FullName -ieq [string]$req.path)) {
                        $visibleSlide = [int]$newSW.View.Slide.SlideIndex
                    }
                } catch {}
                if ($visibleSlide -gt 0) {
                    Log "open: slideshow-visible hwnd=$newHwnd slide=$visibleSlide"
                    Reply @{ id = $id; ok = $true; event = 'slideshow-visible'; slide = $visibleSlide }
                }

                # Wait for PP COM to reflect the new slideshow in
                # SlideShowWindows collection. After teardown OLD (closing
                # the previous file's Presentation), PP COM enters a transient
                # state where SlideShowWindows.Count returns 0 for several
                # seconds — even though the Win32 slideshow window exists
                # (snapshot via FindSlideShowHwnds works fine). Without this
                # wait, navigations immediately after take return 'no slideshow'
                # until COM auto-recovers ~3sec later.
                $verifyStart = [DateTime]::UtcNow
                $verifyOk = $false
                # Run() already gave us a validated direct SlideShowWindow.
                # That object works while SlideShowWindows.Count temporarily
                # lies about being zero, so do not stall every PPTX->PPTX take
                # for four seconds waiting for the collection to catch up.
                try {
                    if ($newSW -and
                        $newSW.Presentation.FullName -ieq $pres.FullName -and
                        [int]$newSW.View.Slide.SlideIndex -gt 0) {
                        $verifyOk = $true
                    }
                } catch {}
                while (-not $verifyOk -and (([DateTime]::UtcNow - $verifyStart).TotalMilliseconds) -lt 4000) {
                    try {
                        $cnt = [int]$ppt.SlideShowWindows.Count
                        if ($cnt -gt 0) {
                            for ($i = 1; $i -le $cnt; $i++) {
                                try {
                                    if ($ppt.SlideShowWindows.Item($i).Presentation.FullName -ieq $pres.FullName) {
                                        $verifyOk = $true
                                        break
                                    }
                                } catch {}
                            }
                            if ($verifyOk) { break }
                        }
                    } catch {}
                    Start-Sleep -Milliseconds 50
                }
                $verifyMs = [int]([DateTime]::UtcNow - $verifyStart).TotalMilliseconds
                Log ("open: SlideShowWindows verify ok={0} took={1}ms" -f $verifyOk, $verifyMs)

                # Keep the previous slideshow alive until Electron explicitly
                # acknowledges this response with commit-open. A timed-out or
                # rejected IPC can then enqueue abort-open and deterministically
                # restore the old deck after this serialized command finishes.
                $script:openTransaction.verified = ($verifyOk -and $newHwnd -ne 0)

                # Diagnostic: dump slideshow state to detect animation issues.
                # Click index = 0 means "before any click animation". If we see
                # finalised state (clickIndex == animCount), animations were
                # played somewhere during open.
                try {
                    $diagCi = -1
                    $diagSi = -1
                    $diagState = -1
                    $diagAnimCount = -1
                    $diagShowType = -1
                    $diagAdvMode = -1
                    try { $diagSi = [int]$newSW.View.Slide.SlideIndex } catch {}
                    try { $diagCi = [int]$newSW.View.GetClickIndex() } catch {}
                    try { $diagState = [int]$newSW.View.State } catch {}
                    try { $diagAnimCount = [int]$pres.Slides.Item($diagSi).TimeLine.MainSequence.Count } catch {}
                    try { $diagShowType = [int]$pres.SlideShowSettings.ShowType } catch {}
                    try { $diagAdvMode = [int]$pres.SlideShowSettings.AdvanceMode } catch {}
                    Log ("open: post-Run state slide=$diagSi clickIndex=$diagCi viewState=$diagState animCount=$diagAnimCount showType=$diagShowType advMode=$diagAdvMode")
                } catch {}

                if ($verifyOk -and $newHwnd -ne 0) {
                    $newPid = 0
                    try { $newPid = [long][PptDaemon.Native]::GetWindowProcessId($newHwnd) } catch {}
                    $previousPid = 0
                    try {
                        if ([long]$script:openTransaction.previousHwnd -ne 0) {
                            $previousPid = [long][PptDaemon.Native]::GetWindowProcessId(
                                [long]$script:openTransaction.previousHwnd
                            )
                        }
                    } catch {}
                    Reply @{
                        id = $id
                        ok = $true
                        slideCount = $count
                        slide = $startSlide
                        hwnd = $newHwnd
                        pid = $newPid
                        managed = [bool]$script:openTransaction.targetManaged
                        reusedPrevious = [bool]$script:openTransaction.targetIsPrevious
                        previousHwnd = [long]$script:openTransaction.previousHwnd
                        previousPid = $previousPid
                        previousPath = [string]$script:openTransaction.previousPath
                        previousSlide = [int]$script:openTransaction.previousSlide
                        sharesPreviousPresentation = [bool]$script:openTransaction.targetSharesPreviousPresentation
                        presentationRelationshipKnown = [bool]$script:openTransaction.presentationRelationshipKnown
                    }
                } else {
                    Abort-PowerPointOpenTransaction
                    $openFailure = "PowerPoint slideshow was not verifiably ready (hwnd=$newHwnd slide=$diagSi)"
                    if (-not $script:lastOpenTransactionOk) {
                        $openFailure = "$openFailure; rollback was incomplete"
                    } else {
                        Release-IdleOwnedPowerPointHost 'failed-open'
                        if (-not $script:lastIdleOwnedPowerPointHostReleaseOk) {
                            $openFailure = "$openFailure; idle PowerPoint host was not released"
                        }
                    }
                    Reply @{
                        id = $id
                        ok = $false
                        error = $openFailure
                        slideCount = $count
                        slide = $startSlide
                    }
                }
            }
            'commit-open' {
                $transaction = $script:openTransaction
                $targetHwnd = 0
                $targetAccepted = $false
                if ($transaction -and [bool]$transaction.verified) {
                    try { $targetHwnd = [long]$transaction.targetHwnd } catch {}
                    $targetAccepted = $targetHwnd -ne 0 -and
                        [PptDaemon.Native]::IsWindow([System.IntPtr]$targetHwnd) -and
                        [PptDaemon.Native]::IsWindowVisible([System.IntPtr]$targetHwnd)
                }
                if (-not $targetAccepted) {
                    Reply @{ id = $id; ok = $false; error = 'Verified PowerPoint target window is no longer visible' }
                } else {
                    # OPEN has already verified the exact file, slide and HWND.
                    # A second COM-heavy cleanup before this ACK allowed a busy
                    # Office process to hold Electron's global output lock for
                    # minutes.  Commit the visible target first; retirement of
                    # the old/hidden deck continues below in this same serial
                    # PowerShell command.  If it cannot finish, the retained
                    # transaction makes the next CLOSE/OPEN retry idempotently.
                    $transaction.commitAccepted = $true
                    Reply @{ id = $id; ok = $true; cleanupPending = $true }
                    for ($cleanupAttempt = 1; $cleanupAttempt -le 3; $cleanupAttempt++) {
                        try {
                            Commit-PowerPointOpenTransaction
                        } catch {
                            $script:lastOpenTransactionOk = $false
                            Log "commit-open: post-ACK retirement failed attempt=${cleanupAttempt}: $($_.Exception.Message)"
                        }
                        if ($script:lastOpenTransactionOk) { break }
                        if ($cleanupAttempt -lt 3) {
                            Log "commit-open: target accepted; retrying previous presentation cleanup attempt=$($cleanupAttempt + 1)"
                            Start-Sleep -Milliseconds (150 * $cleanupAttempt)
                        }
                    }
                    if (-not $script:lastOpenTransactionOk) {
                        Log 'commit-open: target accepted; previous presentation cleanup retained for later CLOSE recovery'
                    }
                    Reply @{
                        id = $id
                        ok = $script:lastOpenTransactionOk
                        event = 'command-complete'
                        error = if ($script:lastOpenTransactionOk) { $null } else { 'Previous PowerPoint cleanup remains pending' }
                    }
                }
            }
            'abort-open' {
                Abort-PowerPointOpenTransaction
                if ($script:lastOpenTransactionOk) {
                    Release-IdleOwnedPowerPointHost 'abort-open'
                    if ($script:lastIdleOwnedPowerPointHostReleaseOk) {
                        Reply @{ id = $id; ok = $true }
                    } else {
                        Reply @{ id = $id; ok = $false; error = 'PowerPoint rollback completed but its idle host was not released' }
                    }
                } else {
                    Reply @{ id = $id; ok = $false; error = 'PowerPoint open rollback was incomplete' }
                }
            }
            'open-status' {
                # A main-process timeout does not cancel a command already read
                # by this single-threaded host. This status command is queued
                # immediately behind commit-open and lets Electron reconcile a
                # late successful commit instead of blindly aborting a target
                # that is already physically on air.
                $transactionPending = $null -ne $script:openTransaction
                $targetPath = ''
                if ($transactionPending) {
                    try { $targetPath = [string]$script:openTransaction.targetPath } catch {}
                }
                $expectedPath = [string]$req.expectedPath
                $activePath = ''
                $liveWindowVerified = $false
                try {
                    $statusWindow = Resolve-ActiveSlideShowWindow $script:pptApplication $expectedPath
                    if ($statusWindow) {
                        $candidatePath = [string]$statusWindow.Presentation.FullName
                        $candidateHwnd = [long]$statusWindow.HWND
                        $candidateSlide = [int]$statusWindow.View.Slide.SlideIndex
                        $pathMatches = [string]::IsNullOrEmpty($expectedPath) -or
                            $candidatePath -ieq $expectedPath
                        if ($pathMatches -and $candidateHwnd -ne 0 -and $candidateSlide -gt 0 -and
                            [PptDaemon.Native]::IsWindow([System.IntPtr]$candidateHwnd) -and
                            [PptDaemon.Native]::IsWindowVisible([System.IntPtr]$candidateHwnd)) {
                            $activePath = $candidatePath
                            $liveWindowVerified = $true
                        }
                    }
                } catch {}
                Reply @{
                    id = $id
                    ok = $liveWindowVerified
                    path = $activePath
                    targetPath = $targetPath
                    transactionPending = $transactionPending
                    error = if ($liveWindowVerified) { $null } else { 'No verified live PowerPoint slideshow' }
                }
            }
            'relocate' {
                $ppt = Get-PPT
                $sw = Resolve-PdmSlideShowWindow $ppt
                $targetRect = $null
                try {
                    if ($null -ne $req.bounds) {
                        $bx = [int]$req.bounds.x
                        $by = [int]$req.bounds.y
                        $bw = [int]$req.bounds.width
                        $bh = [int]$req.bounds.height
                        if ($bw -gt 0 -and $bh -gt 0) { $targetRect = @($bx, $by, $bw, $bh) }
                    }
                } catch {}
                $clipRect = $null
                $cornerRadius = 0
                $transitionDurationMs = 0
                try {
                    if ($null -ne $req.clipBounds) {
                        $cx = [int]$req.clipBounds.x; $cy = [int]$req.clipBounds.y
                        $cw = [int]$req.clipBounds.width; $ch = [int]$req.clipBounds.height
                        if ($cw -gt 0 -and $ch -gt 0) { $clipRect = @($cx, $cy, $cw, $ch) }
                    }
                    if ($null -ne $req.cornerRadius) { $cornerRadius = [Math]::Max(0, [int]$req.cornerRadius) }
                    if ($null -ne $req.transitionDurationMs) {
                        $transitionDurationMs = [Math]::Max(0, [Math]::Min(5000, [int]$req.transitionDurationMs))
                    }
                } catch {}
                $hwnd = [long]$script:activeSlideShowHwnd
                $relocateUnderlayHwnd = 0
                try {
                    if ($null -ne $req.underlayHwnd) {
                        $relocateUnderlayHwnd = [long]$req.underlayHwnd
                    }
                } catch {}
                if ($hwnd -eq 0 -and $sw) { try { $hwnd = [long]$sw.HWND } catch {} }
                if ($hwnd -eq 0) {
                    try {
                        $visibleSlideShows = @([PptDaemon.Native]::FindSlideShowHwnds())
                        if ($visibleSlideShows.Count -gt 0) {
                            $hwnd = [long]$visibleSlideShows[$visibleSlideShows.Count - 1]
                        }
                    } catch {}
                }
                if (-not $sw -or $hwnd -eq 0 -or $null -eq $targetRect) {
                    Reply @{ id = $id; ok = $false; error = 'no slideshow or invalid target bounds' }
                } else {
                    $placed = $false
                    $actualRect = $null
                    for ($attempt = 1; $attempt -le 3; $attempt++) {
                        if ($attempt -eq 1 -and $transitionDurationMs -gt 0) {
                            # Remove the old crop while the outer HWND changes
                            # size. The exact final crop/radius is restored
                            # immediately after the last animation frame.
                            Set-SlideShowClip $hwnd $targetRect $null 0
                            Log "relocate: animate HWND=$hwnd durationMs=$transitionDurationMs from=$((Get-SlideShowWindowRect $hwnd) -join ',') to=$($targetRect -join ',')"
                            Move-SlideShowBoundsAnimated $hwnd $targetRect $transitionDurationMs
                        } else {
                            Set-SlideShowBounds $hwnd $targetRect
                        }
                        Set-SlideShowClip $hwnd $targetRect $clipRect $cornerRadius
                        $atomicPromotion = $false
                        if ($relocateUnderlayHwnd -ne 0 -and $relocateUnderlayHwnd -ne $hwnd) {
                            # Swap both HWNDs in one DWM transaction. Lowering
                            # Electron first briefly exposed the Scene backdrop;
                            # raising PowerPoint first could still leave the
                            # Chromium window above it on some GPU/Office pairs.
                            # A single deferred batch establishes the intended
                            # order without an intermediate presentation-less
                            # frame and is also reliable when both rectangles
                            # already match their target coordinates.
                            $atomicPromotion = [PptDaemon.Native]::PromoteWarmedOutput(
                                [System.IntPtr]$hwnd,
                                [System.IntPtr]$relocateUnderlayHwnd)
                            Log "relocate: atomic promotion=$atomicPromotion slideshow=$hwnd underlay=$relocateUnderlayHwnd"
                            if (-not $atomicPromotion) {
                                Raise-SlideShow $hwnd $targetRect
                                Lower-Window $relocateUnderlayHwnd
                            }
                        } else {
                            Raise-SlideShow $hwnd $targetRect
                        }
                        try { [PptDaemon.Native]::DwmFlush() | Out-Null } catch {}
                        Start-Sleep -Milliseconds 40
                        $actualRect = Get-SlideShowWindowRect $hwnd
                        $placed = Test-SlideShowBounds $hwnd $targetRect
                        $actualText = if ($null -ne $actualRect) { $actualRect -join ',' } else { '-' }
                        Log ("relocate: verify attempt={0} HWND={1} target={2} actual={3} ok={4}" -f `
                            $attempt, $hwnd, ($targetRect -join ','), $actualText, $placed)
                        if ($placed) { break }
                    }
                    if ($placed) {
                        $script:activeSlideShowHwnd = $hwnd
                        Reply @{ id = $id; ok = $true }
                    } else {
                        Reply @{
                            id = $id
                            ok = $false
                            error = "slideshow did not move to target bounds; actual=$actualText"
                        }
                    }
                }
            }
            'close' {
                # Only a PPTX -> PDF TAKE requests this short lease. The deck
                # itself is still closed below; normal STOP and shutdown use
                # immediate release. A later explicit cleanup retires the host.
                $script:idleHostHoldUntilUtc = if ($req.keepHostWarm -eq $true) {
                    [DateTime]::UtcNow.AddSeconds(20)
                } else { [DateTime]::MinValue }
                # Establish the user-visible postcondition with Win32 before
                # any COM cleanup. Once this exact slideshow HWND is hidden,
                # STOP is authoritative and can be acknowledged immediately;
                # document/host retirement continues under Electron's daemon
                # cleanup barrier and can no longer execute as a detached late
                # close after a JS timeout.
                $visualHwnd = [long]$script:activeSlideShowHwnd
                $hasActiveMarker = -not [string]::IsNullOrEmpty([string]$script:activePresentationPath) -or
                    $null -ne $script:activePresentation -or
                    $null -ne $script:activeSlideShowWindow
                $visualStopped = $false
                if ($visualHwnd -eq 0) {
                    $visualStopped = -not $hasActiveMarker
                } elseif (-not [PptDaemon.Native]::IsWindow([System.IntPtr]$visualHwnd) -or
                    -not [PptDaemon.Native]::IsWindowVisible([System.IntPtr]$visualHwnd)) {
                    $visualStopped = $true
                } else {
                    [PptDaemon.Native]::ShowWindow([System.IntPtr]$visualHwnd, 0) | Out-Null
                    try { [PptDaemon.Native]::DwmFlush() | Out-Null } catch {}
                    $hideDeadline = [DateTime]::UtcNow.AddMilliseconds(1000)
                    do {
                        $visualStopped = (-not [PptDaemon.Native]::IsWindow([System.IntPtr]$visualHwnd)) -or
                            (-not [PptDaemon.Native]::IsWindowVisible([System.IntPtr]$visualHwnd))
                        if (-not $visualStopped) { Start-Sleep -Milliseconds 25 }
                    } while (-not $visualStopped -and [DateTime]::UtcNow -lt $hideDeadline)
                }
                if (-not $visualStopped) {
                    Reply @{ id = $id; ok = $false; error = 'PowerPoint slideshow could not be hidden safely' }
                    continue
                }

                Reply @{ id = $id; ok = $true; cleanupPending = $true }
                $closeOk = $false
                $remaining = -1
                try {
                Reset-SlideVideoClickState
                $transactionCloseOk = $true
                if ($script:openTransaction) {
                    Abort-PowerPointOpenTransaction
                    $transactionCloseOk = $script:lastOpenTransactionOk
                }
                $ppt = Get-PPT
                $closeOk = $transactionCloseOk
                if ($ppt) {
                    if (-not (Close-UnidentifiedManagedPresentations)) {
                        $closeOk = $false
                    }
                    # An empty expected path makes Resolve pick an arbitrary
                    # slideshow from a shared Office process. Only PDM's cached
                    # or path-qualified window is eligible for STOP.
                    # Validate the cached slideshow before deciding whether it
                    # belongs to a user. A monitor disconnect can leave a
                    # truthy but dead RCW; calling View.Exit() on that object
                    # used to turn an already-stopped show into endless CLOSE
                    # failures and block every later PPTX TAKE.
                    $sw = Resolve-PdmSlideShowWindow $ppt
                    $active = $script:activePresentation
                    if (-not $active -and $sw) {
                        try { $active = $sw.Presentation } catch {}
                    }
                    $activePathForClose = ''
                    try { if ($active) { $activePathForClose = [string]$active.FullName } } catch {}

                    # Release hidden/prepared PDM decks first. If one of them
                    # refuses to close in a user-owned PowerPoint host, keep the
                    # actual on-air slideshow untouched so renderer rollback is
                    # still truthful and visible.
                    try {
                        for ($i = [int]$ppt.Presentations.Count; $i -ge 1; $i--) {
                            $candidate = $ppt.Presentations.Item($i)
                            if (-not (Test-PdmOwnedPresentation $candidate) -or
                                (Test-PresentationProtectedByOpenTransaction $candidate)) { continue }
                            $candidatePath = ''
                            try { $candidatePath = [string]$candidate.FullName } catch {}
                            if (-not [string]::IsNullOrEmpty($activePathForClose) -and
                                $candidatePath -ieq $activePathForClose) { continue }
                            $script:lastManagedPresentationCloseOk = $false
                            Close-ManagedPresentation $candidate
                            if (-not $script:lastManagedPresentationCloseOk) { $closeOk = $false }
                        }
                    } catch {
                        $closeOk = $false
                        Log "close: residual managed document cleanup failed: $($_.Exception.Message)"
                    }

                    $activeCloseOk = $true
                    try {
                        if ($active) {
                            if (Test-PdmOwnedPresentation $active) {
                                # A real STOP/CLOSE must release the loaded deck,
                                # even when it originally came from the channel
                                # preparation cache. Keep only the empty COM host
                                # warm; the next TAKE can reopen the file from the
                                # exported slide cache without retaining its media
                                # and document model in POWERPNT.EXE.
                                $script:lastManagedPresentationCloseOk = $false
                                # Presentation.Close() also exits its slideshow.
                                # Do not call View.Exit() first: if Close fails,
                                # the still-live previous picture is the safe
                                # rollback surface for the renderer.
                                Close-ManagedPresentation $active
                                $activeCloseOk = $script:lastManagedPresentationCloseOk
                            } elseif ($sw) {
                                # The user opened this document before PDM. End
                                # only PDM's slideshow; never close their deck.
                                try { $sw.View.Exit() } catch {
                                    $activeCloseOk = $false
                                    Log "close: user-owned slideshow exit failed: $($_.Exception.Message)"
                                }
                            }
                        }
                    } catch {
                        $activeCloseOk = $false
                        Log "close: managed document cleanup failed: $($_.Exception.Message)"
                    }
                    $closeOk = $closeOk -and $activeCloseOk
                    # Visible=1 был выставлен в 'open' для Run() слайдшоу. A
                    # PDM-owned instance can be returned to COM-invisible mode.
                    # Never do this to a user-owned PowerPoint instance: on some
                    # Office builds Visible=0 after View.Exit() disconnects the
                    # automation server (0x800706BA), so every following TAKE
                    # retries through a dead proxy and falls back to the PDF.
                    if ($script:pptOwnedByRoland) {
                        try { $ppt.Visible = 0 } catch {}
                    } elseif ($closeOk) {
                        # TAKE temporarily hides a borrowed editor. Once STOP
                        # has really released PDM's slideshow/deck, put the
                        # user's window back exactly where and how it was.
                        Restore-BorrowedPowerPointEditorState $ppt
                    } else {
                        # Keep the editor hidden while a failed CLOSE retains
                        # the slideshow as the rollback surface.
                        Hide-PPEditor $ppt
                    }
                }
                if (-not $closeOk -and $script:pptOwnedByRoland) {
                    # It is safe to tear down an instance created by PDM. This
                    # is the final bounded fallback when Office refuses an
                    # individual Presentation.Close(): no deck/media memory may
                    # survive a successful STOP acknowledgement.
                    Log 'close: managed Close failed; recycling PDM-owned PowerPoint host'
                    Restore-PowerPointSession
                    $closeOk = $script:lastPowerPointSessionCleanupOk
                    $ppt = if ($script:pptSessionInitialized) { $script:pptApplication } else { $null }
                }
                if ($closeOk -or $activeCloseOk) {
                    $script:activeSlideShowHwnd = 0
                    $script:activeSlideShowWindow = $null
                    $script:activePresentation = $null
                    $script:activePresentationPath = ''
                }
                if ($closeOk) {
                    Release-IdleOwnedPowerPointHost 'close'
                    if (-not $script:lastIdleOwnedPowerPointHostReleaseOk) {
                        $closeOk = $false
                    } elseif (-not $script:pptSessionInitialized) {
                        $ppt = $null
                    }
                } else {
                    Log "close: residual PowerPoint cleanup retained for retry path='$($script:activePresentationPath)'"
                }
                $remaining = 0
                if ($ppt) {
                    try { $remaining = [int]$ppt.Presentations.Count } catch { $remaining = -1 }
                }
                Log "close: END ok=$closeOk remainingPresentations=$remaining prepared=$($script:preparedPresentationKeys.Count) managed=$($script:managedPresentationKeys.Count)"
                } catch {
                    $closeOk = $false
                    Log "close: post-ACK cleanup failed: $($_.Exception.Message)"
                } finally {
                    Reply @{
                        id = $id
                        ok = $closeOk
                        event = 'command-complete'
                        remainingPresentations = $remaining
                        error = if ($closeOk) { $null } else { 'PowerPoint did not release the managed presentation' }
                    }
                }
            }
            'release-idle' {
                $script:idleHostHoldUntilUtc = [DateTime]::MinValue
                Release-IdleOwnedPowerPointHost 'scheduled'
                Reply @{ id = $id; ok = $script:lastIdleOwnedPowerPointHostReleaseOk }
            }
            'next' {
                $ppt = Get-PPT
                $sw = Resolve-PdmSlideShowWindow $ppt
                if ($ppt -and $sw) {
                    $view = $sw.View
                    $total = 0
                    try { $total = [int]$sw.Presentation.Slides.Count } catch {}
                    # Retry-on-stuck: если быстрый клик пришёл во время slide-to-slide
                    # transition, PP трактует Next() как "завершить текущий transition",
                    # не продвигая слайд (slide X->X, click 0->0, dur ~25-45ms).
                    # Повторный Next() сразу после этого реально перейдёт на след.
                    # слайд. Guard $sBefore < $total — на последнем слайде повтор
                    # не делаем, чтобы не дёргать exit slideshow. Retry НЕ срабатывает
                    # при click index != 0 (это build-анимация, которую юзер и хотел).
                    $sBefore = [int]$view.Slide.SlideIndex
                    $cBefore = -1
                    try { $cBefore = [int]$view.GetClickIndex() } catch {}
                    $cCount = -1
                    try { $cCount = [int]$view.GetClickCount() } catch {}
                    $t0 = [DateTime]::UtcNow.Ticks
                    $mediaClick = Invoke-SlideVideoClick $view
                    $boundary = $false
                    if (-not $mediaClick.Handled) {
                        # In channel-boundary mode do not let LoopUntilStopped
                        # wrap the final slide back to slide 1. GetClickCount
                        # preserves every click animation before this boundary.
                        $boundary = [bool]$req.stopAtBoundary -and `
                            $sBefore -eq $total -and `
                            $cBefore -ge 0 -and $cCount -ge 0 -and `
                            $cBefore -ge $cCount
                        if (-not $boundary) {
                            if ($mediaClick.ForceAdvance -and $sBefore -lt $total) {
                                $view.GotoSlide($sBefore + 1)
                            } else {
                                $view.Next()
                            }
                        }
                    }
                    $sMid = [int]$view.Slide.SlideIndex
                    $cMid = -1
                    try { $cMid = [int]$view.GetClickIndex() } catch {}
                    $retried = 0
                    if (-not $mediaClick.Handled -and `
                        $sMid -eq $sBefore -and $cMid -eq $cBefore -and $sBefore -lt $total) {
                        if ($mediaClick.ForceAdvance) {
                            $view.GotoSlide($sBefore + 1)
                        } else {
                            $view.Next()
                        }
                        $retried = 1
                    }
                    $t1 = [DateTime]::UtcNow.Ticks
                    $sAfter = [int]$view.Slide.SlideIndex
                    $cAfter = -1
                    try { $cAfter = [int]$view.GetClickIndex() } catch {}
                    if ($sAfter -ne $sBefore) { Reset-SlideVideoClickState }
                    Log ("next: slide {0}->{1} click {2}->{3}/{4} retry={5} media={6} boundary={7} dur={8}ms" -f `
                        $sBefore, $sAfter, $cBefore, $cAfter, $cCount, $retried, $mediaClick.Detail, $boundary, [int](($t1-$t0)/10000))
                    Reply @{ id = $id; ok = $true; slide = $sAfter; boundary = $boundary }
                } else {
                    Reply @{ id = $id; ok = $false; error = 'no slideshow' }
                }
            }
            'prev' {
                $ppt = Get-PPT
                $sw = Resolve-PdmSlideShowWindow $ppt
                if ($ppt -and $sw) {
                    $view = $sw.View
                    # См. комментарий к 'next'. Guard $sBefore > 1 — со слайда 1
                    # повтор не делаем.
                    $sBefore = [int]$view.Slide.SlideIndex
                    $cBefore = -1
                    try { $cBefore = [int]$view.GetClickIndex() } catch {}
                    $hasVideo = (@(Get-SlideVideoShapes $view).Count -gt 0)
                    $t0 = [DateTime]::UtcNow.Ticks
                    $boundary = [bool]$req.stopAtBoundary -and `
                        $sBefore -eq 1 -and $cBefore -le 0
                    if (-not $boundary) { $view.Previous() }
                    $sMid = [int]$view.Slide.SlideIndex
                    $cMid = -1
                    try { $cMid = [int]$view.GetClickIndex() } catch {}
                    $retried = 0
                    if ($sMid -eq $sBefore -and $cMid -eq $cBefore -and $sBefore -gt 1) {
                        $view.Previous()
                        $retried = 1
                    }
                    $t1 = [DateTime]::UtcNow.Ticks
                    $sAfter = [int]$view.Slide.SlideIndex
                    $cAfter = -1
                    try { $cAfter = [int]$view.GetClickIndex() } catch {}
                    if ($sAfter -ne $sBefore) { Reset-SlideVideoClickState }
                    Log ("prev: slide {0}->{1} click {2}->{3} retry={4} media={5} boundary={6} dur={7}ms" -f `
                        $sBefore, $sAfter, $cBefore, $cAfter, $retried, $hasVideo, $boundary, [int](($t1-$t0)/10000))
                    Reply @{ id = $id; ok = $true; slide = $sAfter; boundary = $boundary }
                } else {
                    Reply @{ id = $id; ok = $false; error = 'no slideshow' }
                }
            }
            'goto' {
                $ppt = Get-PPT
                $sw = Resolve-PdmSlideShowWindow $ppt
                if ($ppt -and $sw) {
                    $view = $sw.View
                    $n = [int]$req.slide
                    $threw = $false
                    try {
                        $view.GotoSlide($n)
                        Reset-SlideVideoClickState
                    } catch {
                        $threw = $true
                        Log "goto($n) threw: $($_.Exception.Message)"
                    }
                    # ALWAYS read actual slide PP ended up on. Even if GotoSlide
                    # threw (target out of bounds — e.g. slide=N+1 when file has
                    # only N slides), PP stays at previous slide. Returning
                    # actual lets renderer sync UI back to PP state — иначе
                    # optimistic UI уходит вперёд от PP, юзер видит «слайд
                    # пропустился» при следующем клике (UI догоняет).
                    $actual = -1
                    try { $actual = [int]$view.Slide.SlideIndex } catch {}
                    Reply @{ id = $id; ok = (-not $threw); slide = $actual }
                } else {
                    Reply @{ id = $id; ok = $false; error = 'no slideshow'; slide = -1 }
                }
            }
            'current' {
                $ppt = Get-PPT
                $sw = Resolve-PdmSlideShowWindow $ppt
                if ($ppt -and $sw) {
                    Reply @{ id = $id; ok = $true; slide = [int]$sw.View.Slide.SlideIndex }
                } else {
                    Reply @{ id = $id; ok = $false; error = 'no slideshow' }
                }
            }
            'notes' {
                $notesPath = [string]$req.path
                $slideNumber = [int]$req.slide
                if ([string]::IsNullOrWhiteSpace($notesPath) -or -not (Test-Path -LiteralPath $notesPath -PathType Leaf)) {
                    throw "PPTX notes source does not exist: $notesPath"
                }
                $ppt = Get-OrCreatePPT
                $notesPres = $null
                $openedForNotes = $false
                $notesResult = $null
                try {
                    for ($i = 1; $i -le $ppt.Presentations.Count; $i++) {
                        $candidate = $ppt.Presentations.Item($i)
                        try {
                            if ($candidate.FullName -ieq $notesPath) {
                                $notesPres = $candidate
                                break
                            }
                        } catch {}
                    }
                    if (-not $notesPres) {
                        try { $ppt.WindowState = 2 } catch {}
                        try { $ppt.Visible = -1 } catch {}
                        Hide-PPEditor $ppt
                        $notesPres = Open-PdmPowerPointPresentation $ppt $notesPath -1 0
                        $openedForNotes = $true
                        Mark-ManagedPresentation $notesPres
                    }
                    $slideCount = [int]$notesPres.Slides.Count
                    if ($slideNumber -lt 1 -or $slideNumber -gt $slideCount) {
                        throw "Slide $slideNumber is outside 1..$slideCount"
                    }
                    $parts = New-Object System.Collections.Generic.List[string]
                    $shapes = $notesPres.Slides.Item($slideNumber).NotesPage.Shapes
                    for ($shapeIndex = 1; $shapeIndex -le $shapes.Count; $shapeIndex++) {
                        $shape = $shapes.Item($shapeIndex)
                        $placeholderType = -1
                        try { $placeholderType = [int]$shape.PlaceholderFormat.Type } catch {}
                        # ppPlaceholderBody (2) is the speaker-notes body. Ignore
                        # slide image, slide number, date and footer placeholders.
                        if ($placeholderType -ne 2) { continue }
                        $text = ''
                        try {
                            if ($shape.HasTextFrame -and $shape.TextFrame.HasText) {
                                $text = [string]$shape.TextFrame.TextRange.Text
                            }
                        } catch {}
                        if (-not [string]::IsNullOrWhiteSpace($text)) {
                            $parts.Add($text.Trim())
                        }
                    }
                    $notesText = [string]::Join("`n", $parts)
                    $notesResult = @{ id = $id; ok = $true; slide = $slideNumber; notes = $notesText }
                } finally {
                    if ($notesPres -and $openedForNotes -and (Test-PdmOwnedPresentation $notesPres)) {
                        $script:lastManagedPresentationCloseOk = $false
                        Close-ManagedPresentation $notesPres
                        if (-not $script:lastManagedPresentationCloseOk) {
                            $notesResult = @{
                                id = $id
                                ok = $false
                                error = "PowerPoint did not release notes presentation: $notesPath"
                            }
                        }
                    }
                    try {
                        if ($script:pptOwnedByRoland -and -not (Test-PowerPointHasAnySlideShow $ppt)) {
                            $ppt.Visible = 0
                        }
                    } catch {}
                    Release-IdleOwnedPowerPointHost 'notes'
                    if (-not $script:lastIdleOwnedPowerPointHostReleaseOk) {
                        $notesResult = @{
                            id = $id
                            ok = $false
                            error = "PowerPoint notes were read but its idle host was not released: $notesPath"
                        }
                    }
                }
                Reply $notesResult
            }
            'export' {
                # Preview export intentionally runs through this already-running
                # daemon instead of launching powerpoint-control.ps1 with
                # `powershell.exe -File`. On WDAC/AppLocker-managed PCs a
                # trusted Program Files script can have a different language
                # mode from the PowerShell host; -File then fails before line 1
                # with DotSourceNotSupported. The daemon itself is known to run
                # on those PCs and already owns the PowerPoint COM apartment.
                $exportPath = [string]$req.path
                $outputDir = [string]$req.outputDir
                $exportWidth = [int]$req.width
                $exportHeight = [int]$req.height
                $incrementalExport = $req.incremental -eq $true
                $exportFirst = 1
                if ($incrementalExport) {
                    $exportFirst = [int]$req.startSlide
                    if ($exportFirst -lt 1 -or [int]$req.batchSize -lt 1 -or [int]$req.batchSize -gt 8) {
                        throw 'Invalid incremental PPTX export range'
                    }
                }
                if ([string]::IsNullOrWhiteSpace($exportPath) -or -not (Test-Path -LiteralPath $exportPath -PathType Leaf)) {
                    throw "PPTX export source does not exist: $exportPath"
                }
                if ([string]::IsNullOrWhiteSpace($outputDir)) { throw 'PPTX export output directory is empty' }
                if ($exportWidth -le 0 -or $exportHeight -le 0) { throw "Invalid PPTX export size: ${exportWidth}x${exportHeight}" }

                $exportStarted = [DateTime]::UtcNow
                Log "export: BEGIN file='$exportPath' size=${exportWidth}x${exportHeight} dir='$outputDir'"
                if ($exportFirst -eq 1 -and (Test-Path -LiteralPath $outputDir)) {
                    Remove-Item -LiteralPath $outputDir -Recurse -Force -ErrorAction Stop
                }
                New-Item -ItemType Directory -Path $outputDir -Force -ErrorAction Stop | Out-Null

                $ppt = Get-OrCreatePPT
                if ($script:pptOwnedByRoland -and -not (Test-PowerPointHasAnySlideShow $ppt)) {
                    try { $ppt.WindowState = 2 } catch {}
                    $ppt.Visible = -1
                    Hide-PPEditor $ppt
                }

                $exportPres = $null
                $openedForExport = $false
                $exportCleanupError = ''
                $exportPending = $false
                try {
                    # Reuse a presentation already owned by the live slideshow.
                    # This avoids trying to open the same file twice in one
                    # PowerPoint instance and never closes an on-air deck.
                    for ($i = 1; $i -le $ppt.Presentations.Count; $i++) {
                        $candidate = $ppt.Presentations.Item($i)
                        try {
                            if ($candidate.FullName -ieq $exportPath) {
                                $exportPres = $candidate
                                break
                            }
                        } catch {}
                    }
                    if (-not $exportPres) {
                        try {
                            # ReadOnly=true, Untitled=false, WithWindow=false.
                            $exportPres = Open-PdmPowerPointPresentation $ppt $exportPath -1 0
                        } catch {
                            if (-not $script:pptOwnedByRoland) {
                                throw "Hidden export failed without changing the user's PowerPoint window: $($_.Exception.Message)"
                            }
                            Log "export: hidden open failed, retrying windowed: $($_.Exception.Message)"
                            $exportPres = Open-PdmPowerPointPresentation $ppt $exportPath 0 -1
                            Hide-PPEditor $ppt
                        }
                        $openedForExport = $true
                        Mark-ManagedPresentation $exportPres
                    }

                    $exportCount = [int]$exportPres.Slides.Count
                    if ($exportCount -lt 1) { throw 'Presentation contains no slides' }
                    if ($exportFirst -gt $exportCount) { throw 'Incremental export starts beyond the presentation' }
                    $exportLast = $exportCount
                    if ($incrementalExport) { $exportLast = [Math]::Min($exportCount, $exportFirst + [int]$req.batchSize - 1) }
                    $exportSlideWidth = [double]$exportPres.PageSetup.SlideWidth
                    $exportSlideHeight = [double]$exportPres.PageSetup.SlideHeight
                    $bulkExportUsed = $false
                    $individualError = ''
                    try {
                        for ($i = $exportFirst; $i -le $exportLast; $i++) {
                            $imagePath = Join-Path $outputDir "slide_$i.png"
                            $exportPres.Slides.Item($i).Export($imagePath, 'PNG', $exportWidth, $exportHeight)
                            if (-not (Test-Path -LiteralPath $imagePath -PathType Leaf)) {
                                throw "PowerPoint did not export slide $i"
                            }
                            if ($req.progress) {
                                Reply @{ id = $id; event = 'slide-exported'; slide = $i; slideCount = $exportCount;
                                    slideWidth = $exportSlideWidth; slideHeight = $exportSlideHeight; path = $imagePath }
                            }
                        }
                        Log "export: Slide.Export succeeded count=$exportCount"
                    } catch {
                        $individualError = $_.Exception.Message
                        Log "export: Slide.Export failed, trying Presentation.Export: $individualError"
                        $bulkExportUsed = $true
                        for ($i = 1; $i -le $exportCount; $i++) {
                            $partial = Join-Path $outputDir "slide_$i.png"
                            # Never delete already-published frames during a
                            # background fallback. Replace them only after the
                            # complete bulk export has successfully finished.
                            if (-not $incrementalExport -and (Test-Path -LiteralPath $partial)) { Remove-Item -LiteralPath $partial -Force }
                        }
                        $bulkDir = Join-Path $outputDir 'bulk-export'
                        New-Item -ItemType Directory -Path $bulkDir -Force -ErrorAction Stop | Out-Null
                        try {
                            $exportPres.Export($bulkDir, 'PNG', $exportWidth, $exportHeight)
                            $bulkFiles = @(Get-ChildItem -LiteralPath $bulkDir -File | Where-Object {
                                $_.Extension -ieq '.png'
                            } | Sort-Object {
                                if ($_.BaseName -match '(\d+)$') { [int]$Matches[1] } else { [int]::MaxValue }
                            })
                            if ($bulkFiles.Count -ne $exportCount) {
                                throw "Presentation.Export returned $($bulkFiles.Count) PNG files; expected $exportCount. Slide.Export error: $individualError"
                            }
                            for ($i = 1; $i -le $exportCount; $i++) {
                                Move-Item -LiteralPath $bulkFiles[$i - 1].FullName -Destination (Join-Path $outputDir "slide_$i.png") -Force
                            }
                            Log "export: Presentation.Export succeeded count=$exportCount"
                        } finally {
                            if (Test-Path -LiteralPath $bulkDir) { Remove-Item -LiteralPath $bulkDir -Recurse -Force }
                        }
                    }
                    $exportPending = $incrementalExport -and -not $bulkExportUsed -and $exportLast -lt $exportCount
                    if ($exportPending) {
                        if (Test-PdmOwnedPresentation $exportPres) { Mark-PreparedPresentation $exportPres }
                    } else {
                        for ($i = 1; $i -le $exportCount; $i++) {
                            if (-not (Test-Path -LiteralPath (Join-Path $outputDir "slide_$i.png") -PathType Leaf)) {
                                throw "Incomplete incremental export: missing slide $i"
                            }
                        }
                        [System.IO.File]::WriteAllText((Join-Path $outputDir 'complete.txt'), [string]$exportCount)
                    }
                } finally {
                    if (-not $exportPending -and $exportPres -and $openedForExport -and (Test-PdmOwnedPresentation $exportPres)) {
                        $script:lastManagedPresentationCloseOk = $false
                        Close-ManagedPresentation $exportPres
                        if (-not $script:lastManagedPresentationCloseOk) {
                            $exportCleanupError = "PowerPoint did not release exported presentation: $exportPath"
                        }
                    }
                    try {
                        # The collection can say zero during a live slideshow;
                        # hiding PowerPoint then makes a rapid channel switch
                        # appear black. Trust the cached direct window first.
                        if ($script:pptOwnedByRoland -and -not (Test-PowerPointHasAnySlideShow $ppt)) {
                            $ppt.Visible = 0
                        }
                    } catch {}
                    if (-not $exportPending) { Release-IdleOwnedPowerPointHost 'export' }
                    if (-not $exportPending -and -not $script:lastIdleOwnedPowerPointHostReleaseOk -and
                        [string]::IsNullOrEmpty($exportCleanupError)) {
                        $exportCleanupError = "PowerPoint exported slides but its idle host was not released: $exportPath"
                    }
                    if (-not [string]::IsNullOrEmpty($exportCleanupError)) {
                        throw $exportCleanupError
                    }
                }
                $exportMs = [int]([DateTime]::UtcNow - $exportStarted).TotalMilliseconds
                Log "export: END count=$exportCount dur=${exportMs}ms"
                Reply @{ id = $id; ok = $true; slideCount = $exportCount; path = $outputDir;
                    slideWidth = $exportSlideWidth; slideHeight = $exportSlideHeight; bulkExport = $bulkExportUsed;
                    exportPending = $exportPending; nextSlide = ($exportLast + 1) }
            }
            'snapshot' {
                # Захватить пиксели активного screenClass-окна PP напрямую
                # через PrintWindow(PW_RENDERFULLCONTENT). Обходит DWM-композит,
                # работает когда окно перекрыто оверлеем. Возвращает путь к PNG.
                # Использовать сразу после Run() в hybrid-флоу, чтобы последний
                # кадр оверлея пиксель-в-пиксель совпал с первым кадром PP.
                $hwnds = [PptDaemon.Native]::FindSlideShowHwnds()
                if ($hwnds.Count -eq 0) {
                    Reply @{ id = $id; ok = $false; error = 'no slideshow' }
                } else {
                    $hwnd = $hwnds[$hwnds.Count - 1]  # newest = last created
                    $outPath = Join-Path $env:TEMP "pdm-slideshow-snap-$id.png"
                    # На холодном запуске PP (первый slideshow за сессию) DirectX
                    # surface может быть ещё не прорисован к моменту snapshot —
                    # PrintWindow возвращает валидный, но пустой/чёрный bitmap.
                    # PNG-сжатие одноцветного кадра 1920x1080 ≈ 2-5KB, реального
                    # слайда ≥ 40KB. Ретраим до 8x с 60ms паузой, пока файл не
                    # превысит 20KB — значит в bitmap есть содержимое.
                    $ok = $false
                    $hasContent = $false
                    $attempts = 0
                    for ($t = 0; $t -lt 8; $t++) {
                        $attempts++
                        try { $ok = [PptDaemon.Native]::SnapshotWindowToPng([long]$hwnd, $outPath) } catch {
                            Log "snapshot threw: $($_.Exception.Message)"
                            $ok = $false
                        }
                        if ($ok -and (Test-Path $outPath)) {
                            $sz = (Get-Item $outPath).Length
                            if ($sz -gt 20480) {
                                $hasContent = $true
                                break
                            }
                        }
                        Start-Sleep -Milliseconds 60
                    }
                    if ($ok -and $hasContent -and (Test-Path $outPath)) {
                        Log ("snapshot ok attempts={0} size={1}" -f $attempts, (Get-Item $outPath).Length)
                        Reply @{ id = $id; ok = $true; path = $outPath }
                    } else {
                        $lastSize = if (Test-Path $outPath) { (Get-Item $outPath).Length } else { 0 }
                        Log "snapshot failed/blank attempts=$attempts size=$lastSize"
                        Reply @{ id = $id; ok = $false; error = 'PrintWindow returned no painted frame' }
                    }
                }
            }
            'exit' {
                $exitCleanupOk = $false
                $exitCleanupError = ''
                for ($attempt = 1; $attempt -le 3 -and -not $exitCleanupOk; $attempt++) {
                    try {
                        Restore-PowerPointSession
                        $exitCleanupOk = $script:lastPowerPointSessionCleanupOk
                        if (-not $exitCleanupOk) {
                            $exitCleanupError = 'PowerPoint session cleanup postcondition was not met'
                        }
                    } catch {
                        $exitCleanupError = $_.Exception.Message
                        Log "PowerPoint exit cleanup failed attempt=${attempt}: $exitCleanupError"
                    }
                    if (-not $exitCleanupOk -and $attempt -lt 3) {
                        Start-Sleep -Milliseconds (150 * $attempt)
                    }
                }
                Reply @{
                    id = $id
                    ok = $exitCleanupOk
                    error = if ($exitCleanupOk) { $null } else { $exitCleanupError }
                }
                if ($exitCleanupOk) { exit 0 } else { exit 2 }
            }
            default {
                Reply @{ id = $id; ok = $false; error = "unknown cmd: $cmd" }
            }
        }
    } catch {
        $commandError = $_
        $commandErrorMessage = [string]$commandError.Exception.Message
        Log "cmd '$cmd' failed: $commandErrorMessage; location=$($commandError.InvocationInfo.ScriptLineNumber); stack=$($commandError.ScriptStackTrace)"
        if ($cmd -eq 'open' -and $script:openTransaction) {
            Abort-PowerPointOpenTransaction
            if (-not $script:lastOpenTransactionOk) {
                $commandErrorMessage = "$commandErrorMessage; PowerPoint rollback was incomplete"
            }
        }
        $fatalSessionUncertain = $false
        if (Test-FatalPowerPointComError $commandError) {
            $fatalCleanupVerified = Invalidate-PowerPointSession "cmd=$cmd error=$commandErrorMessage"
            $fatalSessionUncertain = -not $fatalCleanupVerified
            if ($fatalSessionUncertain) {
                $commandErrorMessage = "$commandErrorMessage; PowerPoint ownership cleanup was not verified"
            }
        }
        Reply @{
            id = $id
            ok = $false
            error = $commandErrorMessage
            sessionUncertain = $fatalSessionUncertain
        }
        if ($fatalSessionUncertain) {
            Log 'fatal uncertain session: leaving normal command loop for EOF cleanup retry'
            break
        }
    } finally {
        $linkedGuard = $script:commandLinkedPicturesGuard
        $script:commandLinkedPicturesGuard = $null
        if ($linkedGuard) {
            $linkedGuard.Dispose()
            if ($linkedGuard.Clicks -gt 0) { Log "linked-picture warning auto-enabled count=$($linkedGuard.Clicks)" }
            elseif ($linkedGuard.LastError) { Log "linked-picture automation error=$($linkedGuard.LastError)" }
        }
        [PptDaemon.Native]::RestoreLinkedPicturesEditor()
    }
}

# stdin can close without an explicit exit command when the Electron main
# process is terminated during shutdown. Perform the same ownership-aware
# cleanup on EOF so a hidden PowerPoint process is never orphaned.
$eofCleanupOk = $false
for ($attempt = 1; $attempt -le 3 -and -not $eofCleanupOk; $attempt++) {
    try {
        Restore-PowerPointSession
        $eofCleanupOk = $script:lastPowerPointSessionCleanupOk
    } catch { Log "PowerPoint EOF cleanup failed attempt=${attempt}: $($_.Exception.Message)" }
    if (-not $eofCleanupOk -and $attempt -lt 3) { Start-Sleep -Milliseconds (150 * $attempt) }
}
if (-not $eofCleanupOk) { Log 'PowerPoint EOF cleanup incomplete after 3 attempts' }
