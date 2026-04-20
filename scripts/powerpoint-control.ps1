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
    try {
        $hwnd = [long]$Ppt.HWND
        if ($hwnd -ne 0) {
            [PptCtrl.Native]::ShowWindow([System.IntPtr]$hwnd, 0) | Out-Null
        }
    } catch {}
}

function Get-PowerPointInstance {
    try {
        return [System.Runtime.InteropServices.Marshal]::GetActiveObject("PowerPoint.Application")
    } catch {
        return $null
    }
}

function Open-Presentation {
    param([string]$Path)

    $ppt = Get-PowerPointInstance
    if (-not $ppt) {
        $ppt = New-Object -ComObject PowerPoint.Application
    }
    $ppt.Visible = 1  # msoTrue

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
                return @{ Presentation = $p; AlreadyOpen = $true }
            }
        }
    } catch {}
    $p = $Ppt.Presentations.Open($Path, $true, $false, $false)
    return @{ Presentation = $p; AlreadyOpen = $false }
}

function Export-Thumbnails {
    param([string]$Path)

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
    try { $ppt.WindowState = 2 } catch {}  # ppWindowMinimized
    try { $ppt.Visible = 1 } catch {}
    Hide-PPEditorWindow -Ppt $ppt

    $opened = Get-OrOpenPresentation -Ppt $ppt -Path $Path
    $presentation = $opened.Presentation
    $slideCount = $presentation.Slides.Count

    $hash = [System.BitConverter]::ToString([System.Security.Cryptography.MD5]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Path))).Replace("-","").Substring(0,12)
    $tempDir = Join-Path $env:TEMP "pdm-thumbs-$hash"
    if (Test-Path $tempDir) { Remove-Item $tempDir -Recurse -Force }
    New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

    for ($i = 1; $i -le $slideCount; $i++) {
        $outPath = Join-Path $tempDir "slide_$i.png"
        $presentation.Slides.Item($i).Export($outPath, "PNG", 320, 240)
    }

    if (-not $opened.AlreadyOpen) { $presentation.Close() }

    # Гасим Visible только если нет активного слайдшоу — daemon держит
    # Visible=1 пока идёт презентация; снимем Visible ему — сломаем показ.
    try {
        if ($ppt.SlideShowWindows.Count -eq 0) { $ppt.Visible = 0 }
    } catch {}

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

    # См. Export-Thumbnails: Visible=1 обязателен для Slide.Export.
    # WindowState=2 ДО Visible=1 + SW_HIDE сразу после — синхронно прячет
    # окно редактора, никакой вспышки на дисплее.
    $ppt = Get-PowerPointInstance
    if (-not $ppt) {
        $ppt = New-Object -ComObject PowerPoint.Application
    }
    try { $ppt.WindowState = 2 } catch {}  # ppWindowMinimized
    try { $ppt.Visible = 1 } catch {}
    Hide-PPEditorWindow -Ppt $ppt

    $opened = Get-OrOpenPresentation -Ppt $ppt -Path $Path
    $presentation = $opened.Presentation
    $slideCount = $presentation.Slides.Count

    $hash = [System.BitConverter]::ToString([System.Security.Cryptography.MD5]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Path))).Replace("-","").Substring(0,12)
    $tempDir = Join-Path $env:TEMP "pdm-slides-$hash-${W}x${H}"
    if (-not (Test-Path $tempDir)) {
        New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
    }

    for ($i = 1; $i -le $slideCount; $i++) {
        $outPath = Join-Path $tempDir "slide_$i.png"
        if (-not (Test-Path $outPath)) {
            $presentation.Slides.Item($i).Export($outPath, "PNG", $W, $H)
        }
    }

    if (-not $opened.AlreadyOpen) { $presentation.Close() }

    try {
        if ($ppt.SlideShowWindows.Count -eq 0) { $ppt.Visible = 0 }
    } catch {}

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
