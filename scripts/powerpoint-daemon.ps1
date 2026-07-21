$ErrorActionPreference = 'Continue'
[Console]::InputEncoding  = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding           = [System.Text.Encoding]::UTF8

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
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern System.IntPtr SetThreadDpiAwarenessContext(System.IntPtr dpiContext);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true, CharSet = System.Runtime.InteropServices.CharSet.Auto)]
public static extern int GetClassName(System.IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool IsWindowVisible(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
public static extern int GetWindowLong(System.IntPtr hWnd, int nIndex);
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
    $script:startedSlideVideos.Clear()
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

function Mark-ManagedPresentation($presentation) {
    $key = Get-PresentationKey $presentation
    if (-not [string]::IsNullOrEmpty($key)) {
        $script:managedPresentationKeys[$key] = $true
        Log "managed presentation registered '$key'"
    }
}

function Test-ManagedPresentation($presentation) {
    $key = Get-PresentationKey $presentation
    return (-not [string]::IsNullOrEmpty($key)) -and $script:managedPresentationKeys.ContainsKey($key)
}

function Unmark-ManagedPresentation($presentation) {
    $key = Get-PresentationKey $presentation
    if (-not [string]::IsNullOrEmpty($key)) {
        $script:managedPresentationKeys.Remove($key)
    }
}

function Close-ManagedPresentation($presentation) {
    if (-not $presentation) { return }
    $key = Get-PresentationKey $presentation
    try { $presentation.Saved = -1 } catch {}
    try { $presentation.Close() } catch { Log "managed presentation close failed: $($_.Exception.Message)" }
    if (-not [string]::IsNullOrEmpty($key)) { $script:managedPresentationKeys.Remove($key) }
}

function Reset-PowerPointSessionTracking {
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

function Get-PPT {
    if ($script:pptApplication) {
        try {
            $null = [int]$script:pptApplication.Presentations.Count
            return $script:pptApplication
        } catch {
            Log 'cached PowerPoint COM object is no longer valid'
            Restore-PowerPointRegistryWindowState
            Reset-PowerPointSessionTracking
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
    $ppt = New-Object -ComObject PowerPoint.Application
    Initialize-PowerPointSession $ppt $true
    return $ppt
}

function Restore-PowerPointSession {
    if (-not $script:pptSessionInitialized) { return }
    Log "PowerPoint session cleanup BEGIN owned=$($script:pptOwnedByRoland)"
    Reset-SlideVideoClickState
    $ppt = $script:pptApplication

    try {
        $sw = Resolve-ActiveSlideShowWindow $ppt
        if ($sw) { try { $sw.View.Exit() } catch {} }
    } catch {}
    $script:activeSlideShowHwnd = 0
    $script:activeSlideShowWindow = $null
    $script:activePresentation = $null
    $script:activePresentationPath = ''

    if ($ppt) {
        if ($script:pptOwnedByRoland) {
            try {
                for ($i = [int]$ppt.Presentations.Count; $i -ge 1; $i--) {
                    $presentation = $ppt.Presentations($i)
                    try { $presentation.Saved = -1 } catch {}
                    try { $presentation.Close() } catch {}
                }
            } catch {}
            # PowerPoint persists WindowState/placement during Quit(). Restore
            # the registry snapshot immediately afterwards so the next normal
            # user launch cannot inherit Roland's minimized/off-screen editor.
            try { $ppt.Quit() } catch { Log "PowerPoint Quit failed: $($_.Exception.Message)" }
            Start-Sleep -Milliseconds 150
            Log 'Roland-owned PowerPoint instance quit'
        } else {
            try {
                for ($i = [int]$ppt.Presentations.Count; $i -ge 1; $i--) {
                    $presentation = $ppt.Presentations($i)
                    if (Test-ManagedPresentation $presentation) {
                        Close-ManagedPresentation $presentation
                    }
                }
            } catch {}

            $shouldBeVisible = ($script:pptOriginalVisible -ne 0) -or $script:pptOriginalEditorWasVisible
            if ($shouldBeVisible) {
                try { $ppt.Visible = -1 } catch {}
                $hwnd = 0
                try { $hwnd = Get-PPEditorHwnd $ppt } catch {}
                if ($hwnd -eq 0) { $hwnd = [long]$script:pptOriginalEditorHwnd }
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
                if ($hwnd -ne 0) {
                    $showCommand = switch ([int]$script:pptOriginalWindowState) {
                        2 { 2 } # SW_SHOWMINIMIZED
                        3 { 3 } # SW_SHOWMAXIMIZED
                        default { 4 } # SW_SHOWNOACTIVATE
                    }
                    try { [PptDaemon.Native]::ShowWindow([System.IntPtr]$hwnd, $showCommand) | Out-Null } catch {}
                }
            } else {
                $hwnd = 0
                try { $hwnd = Get-PPEditorHwnd $ppt } catch {}
                if ($hwnd -ne 0) {
                    try { [PptDaemon.Native]::ShowWindow([System.IntPtr]$hwnd, 0) | Out-Null } catch {}
                }
                try { $ppt.Visible = 0 } catch {}
            }
            Log 'user-owned PowerPoint editor state restored'
        }
    }

    Restore-PowerPointRegistryWindowState
    try {
        if ($ppt) { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($ppt) }
    } catch {}
    Reset-PowerPointSessionTracking
    Log 'PowerPoint session cleanup END'
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
            $null = [int]$cached.View.Slide.SlideIndex
            if ([string]::IsNullOrEmpty($expectedPath) -or $cachedPath -ieq $expectedPath) {
                return $cached
            }
        } catch {
            $script:activeSlideShowWindow = $null
        }
    }

    if ($ppt) {
        try {
            for ($i = 1; $i -le $ppt.SlideShowWindows.Count; $i++) {
                $candidate = $ppt.SlideShowWindows($i)
                $candidatePath = [string]$candidate.Presentation.FullName
                if ([string]::IsNullOrEmpty($expectedPath) -or $candidatePath -ieq $expectedPath) {
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
    try {
        $req  = $line | ConvertFrom-Json
        if ($null -ne $req.id) { $id = [int]$req.id }
        $cmd  = [string]$req.cmd

        switch ($cmd) {
            'open' {
                Reset-SlideVideoClickState
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
                $underlayHwnd = 0
                try {
                    if ($null -ne $req.underlayHwnd) {
                        $underlayHwnd = [long]$req.underlayHwnd
                    }
                } catch {}
                if ($underlayHwnd -ne 0) { Log "open: persistent output HWND=$underlayHwnd" }

                $ppt = Get-OrCreatePPT
                # Hint PP to create its editor window already minimized, BEFORE
                # making it visible. The pair `WindowState=2 → Visible=1` gives
                # PP the chance to skip the "show at normal size" stage.
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
                        $null = $oldSW.Add($ppt.SlideShowWindows($i))
                    }
                } catch {}
                # The collection may be transiently empty after the previous
                # switch. The direct cached COM reference is still the real old
                # slideshow and must be included in teardown/reuse decisions.
                $cachedOldSW = Resolve-ActiveSlideShowWindow $ppt
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
                        $null = $oldPres.Add($ppt.Presentations($i))
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
                        $pres = $ppt.Presentations.Open($req.path, 0, 0, 0)
                    } catch {
                        $pres = $ppt.Presentations.Open($req.path)
                    }
                    Mark-ManagedPresentation $pres
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
                        $sw = $ppt.SlideShowWindows($i)
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
                        $tr = $pres.Slides($startSlide).SlideShowTransition
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
                                $sw = $ppt.SlideShowWindows($i)
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
                    if ($underlayHwnd -ne 0 -and $underlayHwnd -ne $newHwnd) {
                        Lower-Window $underlayHwnd
                        Log "lowered persistent output HWND=$underlayHwnd before slideshow promotion"
                    }
                    Raise-SlideShow $newHwnd $targetRect
                    try { [PptDaemon.Native]::DwmFlush() | Out-Null } catch {}
                    Log "promoted warmed slideshow HWND=$newHwnd"
                }

                # The new target now covers the real old output. Tear the old
                # PowerPoint objects down underneath it so their editor/refocus
                # events can no longer create a visible gap.
                Log "teardown OLD: BEGIN"
                foreach ($sw in $oldSW) {
                    try { if ($sw.Presentation.FullName -ine $pres.FullName) { $sw.View.Exit() } } catch {}
                }
                foreach ($p in $oldPres) {
                    try {
                        if ($p.FullName -ine $pres.FullName -and (Test-ManagedPresentation $p)) {
                            Close-ManagedPresentation $p
                        }
                    } catch {}
                }
                Hide-PPEditor $ppt
                Log "teardown OLD: END"

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
                                    if ($ppt.SlideShowWindows($i).Presentation.FullName -ieq $pres.FullName) {
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
                    try { $diagAnimCount = [int]$pres.Slides($diagSi).TimeLine.MainSequence.Count } catch {}
                    try { $diagShowType = [int]$pres.SlideShowSettings.ShowType } catch {}
                    try { $diagAdvMode = [int]$pres.SlideShowSettings.AdvanceMode } catch {}
                    Log ("open: post-Run state slide=$diagSi clickIndex=$diagCi viewState=$diagState animCount=$diagAnimCount showType=$diagShowType advMode=$diagAdvMode")
                } catch {}

                Reply @{ id = $id; ok = $true; slideCount = $count; slide = $startSlide }
            }
            'close' {
                Reset-SlideVideoClickState
                $ppt = Get-PPT
                if ($ppt) {
                    $sw = Resolve-ActiveSlideShowWindow $ppt
                    try { if ($sw) { $sw.View.Exit() } } catch {}
                    try {
                        if ($script:activePresentation) {
                            if (Test-ManagedPresentation $script:activePresentation) {
                                Close-ManagedPresentation $script:activePresentation
                            }
                        } elseif ($ppt.ActivePresentation -and (Test-ManagedPresentation $ppt.ActivePresentation)) {
                            Close-ManagedPresentation $ppt.ActivePresentation
                        }
                    } catch {}
                    # Visible=1 был выставлен в 'open' для Run() слайдшоу. После
                    # закрытия презентации остаётся пустой PP editor-фрейм,
                    # который виден на доп. дисплее, когда сверху ничего не
                    # рендерится (например, юзер закрыл PDF в live-канале —
                    # Electron-окно уходит, и PP проглядывает снизу).
                    # Следующий 'open' сам восстановит Visible=1 для Run().
                    try { $ppt.Visible = 0 } catch {}
                }
                $script:activeSlideShowHwnd = 0
                $script:activeSlideShowWindow = $null
                $script:activePresentation = $null
                $script:activePresentationPath = ''
                Reply @{ id = $id; ok = $true }
            }
            'next' {
                $ppt = Get-PPT
                $sw = Resolve-ActiveSlideShowWindow $ppt
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
                    $t0 = [DateTime]::UtcNow.Ticks
                    $mediaClick = Invoke-SlideVideoClick $view
                    if (-not $mediaClick.Handled) {
                        if ($mediaClick.ForceAdvance -and $sBefore -lt $total) {
                            $view.GotoSlide($sBefore + 1)
                        } else {
                            $view.Next()
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
                    Log ("next: slide {0}->{1} click {2}->{3} retry={4} media={5} dur={6}ms" -f `
                        $sBefore, $sAfter, $cBefore, $cAfter, $retried, $mediaClick.Detail, [int](($t1-$t0)/10000))
                    Reply @{ id = $id; ok = $true; slide = $sAfter }
                } else {
                    Reply @{ id = $id; ok = $false; error = 'no slideshow' }
                }
            }
            'prev' {
                $ppt = Get-PPT
                $sw = Resolve-ActiveSlideShowWindow $ppt
                if ($ppt -and $sw) {
                    $view = $sw.View
                    # См. комментарий к 'next'. Guard $sBefore > 1 — со слайда 1
                    # повтор не делаем.
                    $sBefore = [int]$view.Slide.SlideIndex
                    $cBefore = -1
                    try { $cBefore = [int]$view.GetClickIndex() } catch {}
                    $hasVideo = (@(Get-SlideVideoShapes $view).Count -gt 0)
                    $t0 = [DateTime]::UtcNow.Ticks
                    $view.Previous()
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
                    Log ("prev: slide {0}->{1} click {2}->{3} retry={4} media={5} dur={6}ms" -f `
                        $sBefore, $sAfter, $cBefore, $cAfter, $retried, $hasVideo, [int](($t1-$t0)/10000))
                    Reply @{ id = $id; ok = $true; slide = $sAfter }
                } else {
                    Reply @{ id = $id; ok = $false; error = 'no slideshow' }
                }
            }
            'goto' {
                $ppt = Get-PPT
                $sw = Resolve-ActiveSlideShowWindow $ppt
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
                $sw = Resolve-ActiveSlideShowWindow $ppt
                if ($ppt -and $sw) {
                    Reply @{ id = $id; ok = $true; slide = [int]$sw.View.Slide.SlideIndex }
                } else {
                    Reply @{ id = $id; ok = $false; error = 'no slideshow' }
                }
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
                if ([string]::IsNullOrWhiteSpace($exportPath) -or -not (Test-Path -LiteralPath $exportPath -PathType Leaf)) {
                    throw "PPTX export source does not exist: $exportPath"
                }
                if ([string]::IsNullOrWhiteSpace($outputDir)) { throw 'PPTX export output directory is empty' }
                if ($exportWidth -le 0 -or $exportHeight -le 0) { throw "Invalid PPTX export size: ${exportWidth}x${exportHeight}" }

                $exportStarted = [DateTime]::UtcNow
                Log "export: BEGIN file='$exportPath' size=${exportWidth}x${exportHeight} dir='$outputDir'"
                if (Test-Path -LiteralPath $outputDir) {
                    Remove-Item -LiteralPath $outputDir -Recurse -Force -ErrorAction Stop
                }
                New-Item -ItemType Directory -Path $outputDir -Force -ErrorAction Stop | Out-Null

                $ppt = Get-OrCreatePPT
                try { $ppt.WindowState = 2 } catch {}
                $ppt.Visible = -1
                Hide-PPEditor $ppt

                $exportPres = $null
                $openedForExport = $false
                try {
                    # Reuse a presentation already owned by the live slideshow.
                    # This avoids trying to open the same file twice in one
                    # PowerPoint instance and never closes an on-air deck.
                    for ($i = 1; $i -le $ppt.Presentations.Count; $i++) {
                        $candidate = $ppt.Presentations($i)
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
                            $exportPres = $ppt.Presentations.Open($exportPath, -1, 0, 0)
                        } catch {
                            Log "export: hidden open failed, retrying windowed: $($_.Exception.Message)"
                            $exportPres = $ppt.Presentations.Open($exportPath)
                            Hide-PPEditor $ppt
                        }
                        $openedForExport = $true
                    }

                    $exportCount = [int]$exportPres.Slides.Count
                    if ($exportCount -lt 1) { throw 'Presentation contains no slides' }
                    $individualError = ''
                    try {
                        for ($i = 1; $i -le $exportCount; $i++) {
                            $imagePath = Join-Path $outputDir "slide_$i.png"
                            $exportPres.Slides.Item($i).Export($imagePath, 'PNG', $exportWidth, $exportHeight)
                            if (-not (Test-Path -LiteralPath $imagePath -PathType Leaf)) {
                                throw "PowerPoint did not export slide $i"
                            }
                        }
                        Log "export: Slide.Export succeeded count=$exportCount"
                    } catch {
                        $individualError = $_.Exception.Message
                        Log "export: Slide.Export failed, trying Presentation.Export: $individualError"
                        for ($i = 1; $i -le $exportCount; $i++) {
                            $partial = Join-Path $outputDir "slide_$i.png"
                            if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
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
                    [System.IO.File]::WriteAllText((Join-Path $outputDir 'complete.txt'), [string]$exportCount)
                } finally {
                    if ($exportPres -and $openedForExport) {
                        try { $exportPres.Close() } catch {}
                    }
                    try {
                        # The collection can say zero during a live slideshow;
                        # hiding PowerPoint then makes a rapid channel switch
                        # appear black. Trust the cached direct window first.
                        if (-not (Resolve-ActiveSlideShowWindow $ppt)) { $ppt.Visible = 0 }
                    } catch {}
                }
                $exportMs = [int]([DateTime]::UtcNow - $exportStarted).TotalMilliseconds
                Log "export: END count=$exportCount dur=${exportMs}ms"
                Reply @{ id = $id; ok = $true; slideCount = $exportCount; path = $outputDir }
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
                try { Restore-PowerPointSession } catch { Log "PowerPoint exit cleanup failed: $($_.Exception.Message)" }
                Reply @{ id = $id; ok = $true }
                exit 0
            }
            default {
                Reply @{ id = $id; ok = $false; error = "unknown cmd: $cmd" }
            }
        }
    } catch {
        Log "cmd '$cmd' failed: $($_.Exception.Message)"
        Reply @{ id = $id; ok = $false; error = $_.Exception.Message }
    }
}

# stdin can close without an explicit exit command when the Electron main
# process is terminated during shutdown. Perform the same ownership-aware
# cleanup on EOF so a hidden PowerPoint process is never orphaned.
try { Restore-PowerPointSession } catch { Log "PowerPoint EOF cleanup failed: $($_.Exception.Message)" }
