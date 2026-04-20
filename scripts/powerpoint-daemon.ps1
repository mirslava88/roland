$ErrorActionPreference = 'Continue'
[Console]::InputEncoding  = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding           = [System.Text.Encoding]::UTF8

# Win32 SetWindowPos — used to drop WS_EX_TOPMOST from PowerPoint's slideshow
# window so the Electron "screen-saver" overlay reliably sits above it during
# channel switches (prevents the double-flash during PPTX → PPTX transitions).
if (-not ('PptDaemon.Native' -as [type])) {
    Add-Type -Name Native -Namespace PptDaemon -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
public static extern bool SetWindowPos(System.IntPtr hWnd, System.IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
'@
}

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
                $ppt.Visible = 1

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
                    $runResult = $null
                    Log "Run() BEGIN"
                    try { $runResult = $s.Run() } catch {
                        # Some PowerPoint versions require a document window
                        # to start a slideshow — give it one and retry.
                        try { $null = $pres.NewWindow() } catch {}
                        try { $runResult = $s.Run() } catch {}
                    }
                    Log "Run() END"
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
                # hidden behind the freeze-frame. Overlay fades out at the
                # end and the new slide is revealed in its painted state.
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

                # PowerPoint sometimes re-asserts WS_EX_TOPMOST on the
                # slideshow window a few milliseconds after activation
                # (e.g. when the editor window loses focus). Hammer NOTOPMOST
                # for a short window to outlive any such re-assertion.
                if ($newHwnd -ne 0) {
                    for ($t = 0; $t -lt 8; $t++) {
                        Start-Sleep -Milliseconds 15
                        Set-NotTopmost $newHwnd
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
                    $view = $ppt.SlideShowWindows(1).View
                    $view.Next()
                    Reply @{ id = $id; ok = $true; slide = [int]$view.Slide.SlideIndex }
                } else {
                    Reply @{ id = $id; ok = $false; error = 'no slideshow' }
                }
            }
            'prev' {
                $ppt = Get-PPT
                if ($ppt -and $ppt.SlideShowWindows.Count -gt 0) {
                    $view = $ppt.SlideShowWindows(1).View
                    $view.Previous()
                    Reply @{ id = $id; ok = $true; slide = [int]$view.Slide.SlideIndex }
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
