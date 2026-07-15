param(
    [Parameter(Mandatory=$true)]
    [ValidateSet("open", "close", "next", "prev", "goto", "slidecount", "current", "thumbnails", "renderslides")]
    [string]$Action,

    [string]$FilePath,

    [int]$SlideNumber = 0,

    [int]$Width = 0,

    [int]$Height = 0
)

$ErrorActionPreference = "Stop"

# UTF-8 stdout чтобы JSON с Cyrillic-путями не ломался при чтении в main.ts.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::Error.WriteLine(
    "PPTX_DIAG start action=$Action file='$FilePath' ps=$($PSVersionTable.PSVersion) process64=$([Environment]::Is64BitProcess) os64=$([Environment]::Is64BitOperatingSystem) user='$([Environment]::UserName)'"
)

# Win32 ShowWindow — используем чтобы СРАЗУ спрятать редактор PP после Visible=1.
# $ppt.WindowState=2 (ppWindowMinimized) — COM-свойство, обрабатывается PP асинхронно:
# между выполнением Visible=1 и фактическим сворачиванием проходит 100-300ms,
# и за это время окно PP успевает вспыхнуть на дисплее (пользователь видит:
# "powerpoint открывается и быстро сворачивается"). SW_HIDE через Win32 —
# синхронный: окно скрывается до следующего paint-тика, вспышка невозможна.
if (-not ('PptCtrl.Native' -as [type])) {
    Add-Type -Name Native -Namespace PptCtrl -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
'@
}

function Hide-PPEditorWindow {
    param([System.Object]$Ppt)
    # SW_HIDE = 0. `Application.Visible = $true` (COM-свойство) остаётся true —
    # Slide.Export рендерит через внутренний GDI+ пайплайн, экранная
    # видимость окна редактора ему не нужна.
    # On a cold Office start HWND can appear a little after Visible becomes
    # true. Poll briefly so a slow PC cannot leave the editor covering the
    # operator's monitor during preview export.
    for ($i = 0; $i -lt 20; $i++) {
        try {
            $hwnd = [long]$Ppt.HWND
            if ($hwnd -ne 0) {
                [PptCtrl.Native]::ShowWindow([System.IntPtr]$hwnd, 0) | Out-Null
                return
            }
        } catch {}
        Start-Sleep -Milliseconds 10
    }
}

function Get-PowerPointInstance {
    try {
        return [System.Runtime.InteropServices.Marshal]::GetActiveObject("PowerPoint.Application")
    } catch {
        return $null
    }
}

function Write-PowerPointDiagnostics {
    param([System.Object]$Ppt, [string]$Operation)
    try {
        $version = [string]$Ppt.Version
        $build = [string]$Ppt.Build
        $productCode = ''
        try { $productCode = [string]$Ppt.ProductCode } catch {}
        [Console]::Error.WriteLine(
            "PPTX_DIAG operation=$Operation officeVersion=$version officeBuild=$build productCode='$productCode' presentations=$($Ppt.Presentations.Count) slideshows=$($Ppt.SlideShowWindows.Count)"
        )
    } catch {
        [Console]::Error.WriteLine("PPTX_DIAG unable to query PowerPoint details: $($_.Exception.Message)")
    }
}

function Open-Presentation {
    param([string]$Path)

    $ppt = Get-PowerPointInstance
    if (-not $ppt) {
        $ppt = New-Object -ComObject PowerPoint.Application
    }
    $ppt.Visible = -1  # Microsoft.Office.Core.MsoTriState.msoTrue

    # If a slideshow is already running, exit it quickly
    try {
        if ($ppt.SlideShowWindows.Count -gt 0) {
            $ppt.SlideShowWindows(1).View.Exit()
            Start-Sleep -Milliseconds 200
        }
    } catch {}

    # Close existing presentations
    try {
        while ($ppt.Presentations.Count -gt 0) {
            $ppt.Presentations(1).Close()
            Start-Sleep -Milliseconds 100
        }
    } catch {}

    Start-Sleep -Milliseconds 200

    $presentation = $ppt.Presentations.Open($Path)

    $slideCount = $presentation.Slides.Count

    $settings = $presentation.SlideShowSettings
    $settings.ShowType = 1  # ppShowTypeSpeaker
    try { $settings.ShowPresenterView = $false } catch {}

    $null = $settings.Run()

    $result = @{
        Status = "ok"
        SlideCount = $slideCount
        CurrentSlide = 1
    }
    Write-Output ($result | ConvertTo-Json -Compress)
}

function Close-Presentation {
    $ppt = Get-PowerPointInstance
    if ($ppt) {
        try {
            if ($ppt.SlideShowWindows.Count -gt 0) {
                $ppt.SlideShowWindows(1).View.Exit()
            }
        } catch {}
        try {
            $ppt.ActivePresentation.Close()
        } catch {}
    }
    Write-Output '{"Status":"ok"}'
}

function Go-Next {
    $ppt = Get-PowerPointInstance
    if ($ppt -and $ppt.SlideShowWindows.Count -gt 0) {
        $view = $ppt.SlideShowWindows(1).View
        $view.Next()
        Start-Sleep -Milliseconds 100
        $current = $view.Slide.SlideIndex
        Write-Output "{`"Status`":`"ok`",`"CurrentSlide`":$current}"
    } else {
        Write-Output '{"Status":"error","Message":"No active slideshow"}'
    }
}

function Go-Prev {
    $ppt = Get-PowerPointInstance
    if ($ppt -and $ppt.SlideShowWindows.Count -gt 0) {
        $view = $ppt.SlideShowWindows(1).View
        $view.Previous()
        Start-Sleep -Milliseconds 100
        $current = $view.Slide.SlideIndex
        Write-Output "{`"Status`":`"ok`",`"CurrentSlide`":$current}"
    } else {
        Write-Output '{"Status":"error","Message":"No active slideshow"}'
    }
}

function Go-ToSlide {
    param([int]$Number)

    $ppt = Get-PowerPointInstance
    if ($ppt -and $ppt.SlideShowWindows.Count -gt 0) {
        $view = $ppt.SlideShowWindows(1).View
        $view.GotoSlide($Number)
        Write-Output "{`"Status`":`"ok`",`"CurrentSlide`":$Number}"
    } else {
        Write-Output '{"Status":"error","Message":"No active slideshow"}'
    }
}

function Get-SlideCount {
    $ppt = Get-PowerPointInstance
    if ($ppt -and $ppt.Presentations.Count -gt 0) {
        $count = $ppt.ActivePresentation.Slides.Count
        Write-Output "{`"Status`":`"ok`",`"SlideCount`":$count}"
    } else {
        Write-Output '{"Status":"error","Message":"No active presentation"}'
    }
}

function Get-CurrentSlide {
    $ppt = Get-PowerPointInstance
    if ($ppt -and $ppt.SlideShowWindows.Count -gt 0) {
        $current = $ppt.SlideShowWindows(1).View.Slide.SlideIndex
        Write-Output "{`"Status`":`"ok`",`"CurrentSlide`":$current}"
    } else {
        Write-Output '{"Status":"error","Message":"No active slideshow"}'
    }
}

function Get-OrOpenPresentation {
    param([System.Object]$Ppt, [string]$Path)

    # If this presentation is already open (e.g. daemon has it for slideshow),
    # return that instance and flag so caller doesn't close it.
    try {
        for ($i = 1; $i -le $Ppt.Presentations.Count; $i++) {
            $p = $Ppt.Presentations($i)
            if ($p.FullName -ieq $Path) {
                [Console]::Error.WriteLine("PPTX_DIAG reusing already-open presentation '$Path'")
                return @{ Presentation = $p; AlreadyOpen = $true }
            }
        }
    } catch {}
    # ReadOnly / Untitled / WithWindow are Microsoft.Office.Core.MsoTriState,
    # not Boolean. Some Office/PowerShell combinations coerce $true/$false,
    # while others throw InvalidCastException and produce no previews.
    try {
        $p = $Ppt.Presentations.Open($Path, -1, 0, 0)  # msoTrue, msoFalse, msoFalse
        [Console]::Error.WriteLine("PPTX_DIAG hidden Presentations.Open succeeded")
    } catch {
        [Console]::Error.WriteLine("Hidden Presentations.Open failed, retrying with a document window: $($_.Exception.Message)")
        $p = $Ppt.Presentations.Open($Path)
        Hide-PPEditorWindow -Ppt $Ppt
        [Console]::Error.WriteLine("PPTX_DIAG windowed Presentations.Open fallback succeeded")
    }
    return @{ Presentation = $p; AlreadyOpen = $false }
}

function Export-SlideImages {
    param(
        [System.Object]$Presentation,
        [string]$Directory,
        [int]$SlideCount,
        [int]$W,
        [int]$H
    )

    # Preferred path: explicit stable filenames expected by the renderer.
    $individualError = $null
    try {
        for ($i = 1; $i -le $SlideCount; $i++) {
            $outPath = Join-Path $Directory "slide_$i.png"
            $Presentation.Slides.Item($i).Export($outPath, "PNG", $W, $H)
            if (-not (Test-Path -LiteralPath $outPath -PathType Leaf)) {
                throw "PowerPoint did not export slide $i"
            }
        }
        [Console]::Error.WriteLine("PPTX_DIAG Slide.Export succeeded count=$SlideCount size=${W}x${H}")
        return
    } catch {
        $individualError = $_.Exception.Message
        [Console]::Error.WriteLine("Slide.Export failed, trying Presentation.Export: $individualError")
    }

    # Compatibility fallback for Office builds where Slide.Export fails but
    # Presentation.Export succeeds. PowerPoint chooses localized filenames
    # (Slide1 / Слайд1 / ...), so normalize them back to slide_N.png.
    for ($i = 1; $i -le $SlideCount; $i++) {
        $partialPath = Join-Path $Directory "slide_$i.png"
        if (Test-Path -LiteralPath $partialPath) {
            Remove-Item -LiteralPath $partialPath -Force
        }
    }

    $bulkDir = Join-Path $Directory "bulk-export"
    if (Test-Path -LiteralPath $bulkDir) {
        Remove-Item -LiteralPath $bulkDir -Recurse -Force
    }
    New-Item -ItemType Directory -Path $bulkDir -Force | Out-Null

    try {
        $Presentation.Export($bulkDir, "PNG", $W, $H)
        $bulkFiles = @(Get-ChildItem -LiteralPath $bulkDir -File | Where-Object {
            $_.Extension -ieq '.png'
        } | Sort-Object {
            if ($_.BaseName -match '(\d+)$') { [int]$Matches[1] } else { [int]::MaxValue }
        })
        if ($bulkFiles.Count -ne $SlideCount) {
            throw "Presentation.Export returned $($bulkFiles.Count) PNG files; expected $SlideCount. Slide.Export error: $individualError"
        }
        for ($i = 1; $i -le $SlideCount; $i++) {
            Move-Item -LiteralPath $bulkFiles[$i - 1].FullName -Destination (Join-Path $Directory "slide_$i.png") -Force
        }
        [Console]::Error.WriteLine("PPTX_DIAG Presentation.Export fallback succeeded count=$SlideCount size=${W}x${H}")
    } finally {
        if (Test-Path -LiteralPath $bulkDir) {
            Remove-Item -LiteralPath $bulkDir -Recurse -Force
        }
    }
}

function Get-FileVersionHash {
    param([string]$Path)
    $item = Get-Item -LiteralPath $Path
    $identity = "$($item.FullName)|$($item.Length)|$($item.LastWriteTimeUtc.Ticks)"
    $md5 = [System.Security.Cryptography.MD5]::Create()
    try {
        return [System.BitConverter]::ToString(
            $md5.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($identity))
        ).Replace("-", "").Substring(0, 16)
    } finally {
        $md5.Dispose()
    }
}

function Get-CompleteCacheCount {
    param([string]$Directory)
    $marker = Join-Path $Directory "complete.txt"
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) { return 0 }
    try {
        $count = [int][System.IO.File]::ReadAllText($marker)
        if ($count -le 0) { return 0 }
        for ($i = 1; $i -le $count; $i++) {
            if (-not (Test-Path -LiteralPath (Join-Path $Directory "slide_$i.png") -PathType Leaf)) {
                return 0
            }
        }
        return $count
    } catch {
        return 0
    }
}

function Export-Thumbnails {
    param([string]$Path)

    $hash = Get-FileVersionHash -Path $Path
    $tempDir = Join-Path $env:TEMP "pdm-thumbs-$hash"
    $cachedCount = Get-CompleteCacheCount -Directory $tempDir
    if ($cachedCount -gt 0) {
        [Console]::Error.WriteLine("PPTX_DIAG thumbnail cache hit dir='$tempDir' count=$cachedCount")
        Write-Output (@{
            Status = "ok"
            SlideCount = $cachedCount
            ThumbnailDir = $tempDir
        } | ConvertTo-Json -Compress)
        return
    }

    if (Test-Path -LiteralPath $tempDir) { Remove-Item -LiteralPath $tempDir -Recurse -Force }
    New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

    # PP's Presentations.Open(..., WithWindow=False) + Slide.Export require
    # Application.Visible=True на многих версиях PP — без Visible=1 Export
    # падает молча и превью в каналах не генерятся.
    # Порядок: WindowState=2 ДО Visible=1 (подсказка PP создать окно сразу
    # свёрнутым) + Win32 SW_HIDE СРАЗУ после Visible=1 (окно исчезает
    # синхронно в том же paint-тике, вспышка невозможна).
    $ppt = Get-PowerPointInstance
    if (-not $ppt) {
        $ppt = New-Object -ComObject PowerPoint.Application
    }
    Write-PowerPointDiagnostics -Ppt $ppt -Operation 'thumbnails'
    try { $ppt.WindowState = 2 } catch {}  # ppWindowMinimized
    try { $ppt.Visible = -1 } catch {}  # msoTrue
    Hide-PPEditorWindow -Ppt $ppt

    $opened = $null
    $presentation = $null
    try {
        $opened = Get-OrOpenPresentation -Ppt $ppt -Path $Path
        $presentation = $opened.Presentation
        $slideCount = [int]$presentation.Slides.Count

        Export-SlideImages -Presentation $presentation -Directory $tempDir -SlideCount $slideCount -W 320 -H 240
        [System.IO.File]::WriteAllText((Join-Path $tempDir "complete.txt"), [string]$slideCount)
    } finally {
        if ($presentation -and $opened -and -not $opened.AlreadyOpen) {
            try { $presentation.Close() } catch {}
        }
        # Do not hide the application while the daemon owns a live slideshow.
        try { if ($ppt.SlideShowWindows.Count -eq 0) { $ppt.Visible = 0 } } catch {}  # msoFalse
    }

    $result = @{
        Status = "ok"
        SlideCount = $slideCount
        ThumbnailDir = $tempDir
    }
    Write-Output ($result | ConvertTo-Json -Compress)
}

function Export-Slides {
    param([string]$Path, [int]$W, [int]$H)

    if ($W -le 0) { $W = 1920 }
    if ($H -le 0) { $H = 1080 }

    $hash = Get-FileVersionHash -Path $Path
    $tempDir = Join-Path $env:TEMP "pdm-slides-$hash-${W}x${H}"
    $cachedCount = Get-CompleteCacheCount -Directory $tempDir
    if ($cachedCount -gt 0) {
        [Console]::Error.WriteLine("PPTX_DIAG full-slide cache hit dir='$tempDir' count=$cachedCount size=${W}x${H}")
        Write-Output (@{
            Status = "ok"
            SlideCount = $cachedCount
            SlidesDir = $tempDir
        } | ConvertTo-Json -Compress)
        return
    }

    if (Test-Path -LiteralPath $tempDir) { Remove-Item -LiteralPath $tempDir -Recurse -Force }
    New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

    # См. Export-Thumbnails: Visible=1 обязателен для Slide.Export.
    # WindowState=2 ДО Visible=1 + SW_HIDE сразу после — синхронно прячет
    # окно редактора, никакой вспышки на дисплее.
    $ppt = Get-PowerPointInstance
    if (-not $ppt) {
        $ppt = New-Object -ComObject PowerPoint.Application
    }
    Write-PowerPointDiagnostics -Ppt $ppt -Operation 'renderslides'
    try { $ppt.WindowState = 2 } catch {}  # ppWindowMinimized
    try { $ppt.Visible = -1 } catch {}  # msoTrue
    Hide-PPEditorWindow -Ppt $ppt

    $opened = $null
    $presentation = $null
    try {
        $opened = Get-OrOpenPresentation -Ppt $ppt -Path $Path
        $presentation = $opened.Presentation
        $slideCount = [int]$presentation.Slides.Count

        Export-SlideImages -Presentation $presentation -Directory $tempDir -SlideCount $slideCount -W $W -H $H
        [System.IO.File]::WriteAllText((Join-Path $tempDir "complete.txt"), [string]$slideCount)
    } finally {
        if ($presentation -and $opened -and -not $opened.AlreadyOpen) {
            try { $presentation.Close() } catch {}
        }
        try { if ($ppt.SlideShowWindows.Count -eq 0) { $ppt.Visible = 0 } } catch {}  # msoFalse
    }

    $result = @{
        Status = "ok"
        SlideCount = $slideCount
        SlidesDir = $tempDir
    }
    Write-Output ($result | ConvertTo-Json -Compress)
}

switch ($Action) {
    "open"       { Open-Presentation -Path $FilePath }
    "close"      { Close-Presentation }
    "next"       { Go-Next }
    "prev"       { Go-Prev }
    "goto"       { Go-ToSlide -Number $SlideNumber }
    "slidecount" { Get-SlideCount }
    "current"    { Get-CurrentSlide }
    "thumbnails" { Export-Thumbnails -Path $FilePath }
    "renderslides" { Export-Slides -Path $FilePath -W $Width -H $Height }
}
