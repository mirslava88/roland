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
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
public static extern bool SetWindowPos(System.IntPtr hWnd, System.IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
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
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool GetWindowRect(System.IntPtr hWnd, out RECT lpRect);
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

function Hide-PPEditor($ppt) {
    # SW_HIDE = 0. Application.Visible COM property stays true — Run() /
    # Presentations.Open / Slide.Export all work via internal PP pipelines
    # that don't require the editor HWND to be on screen.
    try {
        $hwnd = [long]$ppt.HWND
        if ($hwnd -ne 0) {
            [PptDaemon.Native]::ShowWindow([System.IntPtr]$hwnd, 0) | Out-Null
        }
    } catch {}
}

function Get-PPT {
    try { return [System.Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application') }
    catch { return $null }
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
                $ppt = Get-PPT
                if (-not $ppt) { $ppt = New-Object -ComObject PowerPoint.Application }
                # Hint PP to create its editor window already minimized, BEFORE
                # making it visible. The pair `WindowState=2 → Visible=1` gives
                # PP the chance to skip the "show at normal size" stage.
                try { $ppt.WindowState = 2 } catch {}  # ppWindowMinimized
                $ppt.Visible = 1
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
                $oldPres = New-Object System.Collections.ArrayList
                try {
                    for ($i = 1; $i -le $ppt.Presentations.Count; $i++) {
                        $null = $oldPres.Add($ppt.Presentations($i))
                    }
                } catch {}

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

                $newSW = $null
                if ($existingSW) {
                    $newSW = $existingSW
                    try { if ([int]$newSW.View.Slide.SlideIndex -ne $startSlide) { $newSW.View.GotoSlide($startSlide) } } catch {}
                } else {
                    $s = $pres.SlideShowSettings
                    $s.ShowType = 1  # ppShowTypeSpeaker
                    # Force manual advance — some PPTX files have slides set
                    # to auto-advance on a timer (SlideShowTransition.AdvanceOnTime).
                    # Left as-is, PowerPoint would march through slides on its
                    # own while the Electron UI thinks nothing changed, so the
                    # external display ends up one or more slides ahead of the
                    # in-app slide number. ppSlideShowManualAdvance = 1.
                    try { $s.AdvanceMode = 1 } catch {}
                    if ($startSlide -gt 1) {
                        try {
                            $s.StartingSlide = $startSlide
                            $s.EndingSlide   = $count
                            $s.RangeType     = 2  # ppShowSlideRange
                        } catch {}
                    }
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
                            param($oldHwnds, $shared)
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
                                            # HWND_NOTOPMOST=-2;
                                            # SWP_NOSIZE|SWP_NOMOVE|SWP_NOACTIVATE=0x13
                                            [PptDaemon.Native]::SetWindowPos(
                                                [System.IntPtr]$h, [System.IntPtr]-2,
                                                0, 0, 0, 0, 0x13) | Out-Null
                                            $shared.foundHwnd = $h
                                            $shared.caughtTicks = [DateTime]::UtcNow.Ticks
                                            return
                                        }
                                    }
                                } catch { $shared.err = $_.Exception.Message }
                                Start-Sleep -Milliseconds 2
                            }
                        }).AddArgument($oldSlideHwnds).AddArgument($shared)
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
                if ($newHwnd -ne 0) { Log "Set-NotTopmost on new HWND=$newHwnd"; Set-NotTopmost $newHwnd }

                # Tear down the previous slideshow windows + presentations.
                # The overlay covers everything, so this is invisible.
                Log "teardown OLD: BEGIN"
                foreach ($sw in $oldSW) {
                    try { if ($sw.Presentation.FullName -ine $pres.FullName) { $sw.View.Exit() } } catch {}
                }
                foreach ($p in $oldPres) {
                    try { if ($p.FullName -ine $pres.FullName) { $p.Close() } } catch {}
                }
                Log "teardown OLD: END"

                # Teardown can re-activate the editor window (focus returns to
                # PP's main frame when the old slideshow exits). SW_HIDE again
                # so the editor stays invisible when the overlay fades.
                Hide-PPEditor $ppt

                # PP sometimes re-asserts WS_EX_TOPMOST on the slideshow a few
                # ms after activation (e.g. when editor loses focus). Hammer
                # NOTOPMOST for ~120ms to outlive any re-assertion. Also re-hide
                # the editor — teardown can re-activate it mid-loop.
                if ($newHwnd -ne 0) {
                    for ($t = 0; $t -lt 8; $t++) {
                        Start-Sleep -Milliseconds 15
                        Set-NotTopmost $newHwnd
                        Hide-PPEditor $ppt
                    }
                }

                Reply @{ id = $id; ok = $true; slideCount = $count; slide = $startSlide }
            }
            'close' {
                $ppt = Get-PPT
                if ($ppt) {
                    try { if ($ppt.SlideShowWindows.Count -gt 0) { $ppt.SlideShowWindows(1).View.Exit() } } catch {}
                    try { $ppt.ActivePresentation.Close() } catch {}
                    # Visible=1 был выставлен в 'open' для Run() слайдшоу. После
                    # закрытия презентации остаётся пустой PP editor-фрейм,
                    # который виден на доп. дисплее, когда сверху ничего не
                    # рендерится (например, юзер закрыл PDF в live-канале —
                    # Electron-окно уходит, и PP проглядывает снизу).
                    # Следующий 'open' сам восстановит Visible=1 для Run().
                    try { $ppt.Visible = 0 } catch {}
                }
                Reply @{ id = $id; ok = $true }
            }
            'next' {
                $ppt = Get-PPT
                if ($ppt -and $ppt.SlideShowWindows.Count -gt 0) {
                    $sw = $ppt.SlideShowWindows(1)
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
                    $view.Next()
                    $sMid = [int]$view.Slide.SlideIndex
                    $cMid = -1
                    try { $cMid = [int]$view.GetClickIndex() } catch {}
                    $retried = 0
                    if ($sMid -eq $sBefore -and $cMid -eq $cBefore -and $sBefore -lt $total) {
                        $view.Next()
                        $retried = 1
                    }
                    $t1 = [DateTime]::UtcNow.Ticks
                    $sAfter = [int]$view.Slide.SlideIndex
                    $cAfter = -1
                    try { $cAfter = [int]$view.GetClickIndex() } catch {}
                    Log ("next: slide {0}->{1} click {2}->{3} retry={4} dur={5}ms" -f `
                        $sBefore, $sAfter, $cBefore, $cAfter, $retried, [int](($t1-$t0)/10000))
                    Reply @{ id = $id; ok = $true; slide = $sAfter }
                } else {
                    Reply @{ id = $id; ok = $false; error = 'no slideshow' }
                }
            }
            'prev' {
                $ppt = Get-PPT
                if ($ppt -and $ppt.SlideShowWindows.Count -gt 0) {
                    $view = $ppt.SlideShowWindows(1).View
                    # См. комментарий к 'next'. Guard $sBefore > 1 — со слайда 1
                    # повтор не делаем.
                    $sBefore = [int]$view.Slide.SlideIndex
                    $cBefore = -1
                    try { $cBefore = [int]$view.GetClickIndex() } catch {}
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
                    Log ("prev: slide {0}->{1} click {2}->{3} retry={4} dur={5}ms" -f `
                        $sBefore, $sAfter, $cBefore, $cAfter, $retried, [int](($t1-$t0)/10000))
                    Reply @{ id = $id; ok = $true; slide = $sAfter }
                } else {
                    Reply @{ id = $id; ok = $false; error = 'no slideshow' }
                }
            }
            'goto' {
                $ppt = Get-PPT
                if ($ppt -and $ppt.SlideShowWindows.Count -gt 0) {
                    $view = $ppt.SlideShowWindows(1).View
                    $n = [int]$req.slide
                    $view.GotoSlide($n)
                    Reply @{ id = $id; ok = $true; slide = $n }
                } else {
                    Reply @{ id = $id; ok = $false; error = 'no slideshow' }
                }
            }
            'current' {
                $ppt = Get-PPT
                if ($ppt -and $ppt.SlideShowWindows.Count -gt 0) {
                    Reply @{ id = $id; ok = $true; slide = [int]$ppt.SlideShowWindows(1).View.Slide.SlideIndex }
                } else {
                    Reply @{ id = $id; ok = $false; error = 'no slideshow' }
                }
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
                    $attempts = 0
                    for ($t = 0; $t -lt 8; $t++) {
                        $attempts++
                        try { $ok = [PptDaemon.Native]::SnapshotWindowToPng([long]$hwnd, $outPath) } catch {
                            Log "snapshot threw: $($_.Exception.Message)"
                            $ok = $false
                        }
                        if ($ok -and (Test-Path $outPath)) {
                            $sz = (Get-Item $outPath).Length
                            if ($sz -gt 20480) { break }
                        }
                        Start-Sleep -Milliseconds 60
                    }
                    if ($ok -and (Test-Path $outPath)) {
                        Log ("snapshot ok attempts={0} size={1}" -f $attempts, (Get-Item $outPath).Length)
                        Reply @{ id = $id; ok = $true; path = $outPath }
                    } else {
                        Log "snapshot failed attempts=$attempts"
                        Reply @{ id = $id; ok = $false; error = 'PrintWindow failed' }
                    }
                }
            }
            'exit' {
                Reply @{ id = $id; ok = $true }
                exit 0
            }
            default {
                Reply @{ id = $id; ok = $false; error = "unknown cmd: $cmd" }
            }
        }
    } catch {
        Reply @{ id = $id; ok = $false; error = $_.Exception.Message }
    }
}
