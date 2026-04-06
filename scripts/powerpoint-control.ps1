param(
    [Parameter(Mandatory=$true)]
    [ValidateSet("open", "close", "next", "prev", "goto", "slidecount", "current", "thumbnails")]
    [string]$Action,

    [string]$FilePath,

    [int]$SlideNumber = 0
)

$ErrorActionPreference = "Stop"

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

    # Close all running slideshows and presentations first
    try {
        while ($ppt.SlideShowWindows.Count -gt 0) {
            $ppt.SlideShowWindows(1).View.Exit()
            Start-Sleep -Milliseconds 500
        }
    } catch {}

    try {
        while ($ppt.Presentations.Count -gt 0) {
            $ppt.Presentations(1).Close()
            Start-Sleep -Milliseconds 300
        }
    } catch {}

    Start-Sleep -Milliseconds 500

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

function Export-Thumbnails {
    param([string]$Path)

    $ppt = Get-PowerPointInstance
    if (-not $ppt) {
        $ppt = New-Object -ComObject PowerPoint.Application
    }
    $ppt.Visible = 1

    # Open without activating slideshow
    $presentation = $ppt.Presentations.Open($Path, $true, $false, $false)
    $slideCount = $presentation.Slides.Count

    $hash = [System.BitConverter]::ToString([System.Security.Cryptography.MD5]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Path))).Replace("-","").Substring(0,12)
    $tempDir = Join-Path $env:TEMP "pdm-thumbs-$hash"
    if (Test-Path $tempDir) { Remove-Item $tempDir -Recurse -Force }
    New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

    for ($i = 1; $i -le $slideCount; $i++) {
        $outPath = Join-Path $tempDir "slide_$i.png"
        $presentation.Slides.Item($i).Export($outPath, "PNG", 320, 240)
    }

    $presentation.Close()

    $result = @{
        Status = "ok"
        SlideCount = $slideCount
        ThumbnailDir = $tempDir
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
}
