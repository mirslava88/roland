param(
    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory,
    [int]$WideSlideCount = 48,
    [int]$PortraitSlideCount = 24
)

$ErrorActionPreference = 'Stop'

function Convert-ToOfficeRgb {
    param([int]$Red, [int]$Green, [int]$Blue)
    return $Red + ($Green * 256) + ($Blue * 65536)
}

function Add-TextBox {
    param(
        $Slide,
        [string]$Text,
        [double]$Left,
        [double]$Top,
        [double]$Width,
        [double]$Height,
        [double]$FontSize,
        [int]$Color,
        [bool]$Bold = $false
    )

    $shape = $Slide.Shapes.AddTextbox(1, $Left, $Top, $Width, $Height)
    $shape.TextFrame.TextRange.Text = $Text
    $shape.TextFrame.TextRange.Font.Name = 'Arial'
    $shape.TextFrame.TextRange.Font.Size = $FontSize
    $shape.TextFrame.TextRange.Font.Bold = if ($Bold) { -1 } else { 0 }
    $shape.TextFrame.TextRange.Font.Color.RGB = $Color
    $shape.TextFrame.MarginLeft = 0
    $shape.TextFrame.MarginRight = 0
    $shape.TextFrame.MarginTop = 0
    $shape.TextFrame.MarginBottom = 0
    return $shape
}

function Add-StressSlide {
    param(
        $Presentation,
        [int]$Index,
        [string]$DeckLabel,
        [int[]]$Palette,
        [bool]$Portrait
    )

    $slide = $Presentation.Slides.Add($Index, 12)
    $width = [double]$Presentation.PageSetup.SlideWidth
    $height = [double]$Presentation.PageSetup.SlideHeight
    $accent = $Palette[$Index % $Palette.Count]
    $accentTwo = $Palette[($Index + 2) % $Palette.Count]
    $dark = Convert-ToOfficeRgb 13 20 34
    $white = Convert-ToOfficeRgb 245 247 250
    $muted = Convert-ToOfficeRgb 166 178 198

    $slide.FollowMasterBackground = 0
    $slide.Background.Fill.Solid()
    $slide.Background.Fill.ForeColor.RGB = $dark

    $bar = $slide.Shapes.AddShape(1, 0, 0, $width, [Math]::Max(14, $height * 0.035))
    $bar.Fill.Solid()
    $bar.Fill.ForeColor.RGB = $accent
    $bar.Line.Visible = 0

    $titleSize = if ($Portrait) { 31 } else { 34 }
    $bodySize = if ($Portrait) { 17 } else { 19 }
    [void](Add-TextBox $slide "$DeckLabel - slide $Index" ($width * 0.065) ($height * 0.075) ($width * 0.86) ($height * 0.12) $titleSize $white $true)
    [void](Add-TextBox $slide 'Synthetic material for PDM memory, switching, and stability tests' ($width * 0.065) ($height * 0.19) ($width * 0.82) ($height * 0.08) $bodySize $muted $false)

    $columns = if ($Portrait) { 2 } else { 4 }
    $rows = if ($Portrait) { 6 } else { 3 }
    $gap = $width * 0.018
    $left = $width * 0.065
    $top = $height * 0.31
    $availableWidth = $width * 0.87
    $availableHeight = $height * 0.53
    $cellWidth = ($availableWidth - (($columns - 1) * $gap)) / $columns
    $cellHeight = ($availableHeight - (($rows - 1) * $gap)) / $rows

    for ($row = 0; $row -lt $rows; $row++) {
        for ($column = 0; $column -lt $columns; $column++) {
            $cellIndex = ($row * $columns) + $column + 1
            $x = $left + ($column * ($cellWidth + $gap))
            $y = $top + ($row * ($cellHeight + $gap))
            $shapeType = if ((($cellIndex + $Index) % 3) -eq 0) { 9 } else { 5 }
            $card = $slide.Shapes.AddShape($shapeType, $x, $y, $cellWidth, $cellHeight)
            $card.Fill.Solid()
            $card.Fill.ForeColor.RGB = if (($cellIndex % 2) -eq 0) { $accent } else { $accentTwo }
            $card.Fill.Transparency = 0.08 + (($cellIndex % 4) * 0.07)
            $card.Line.ForeColor.RGB = $white
            $card.Line.Transparency = 0.72
            $card.Line.Weight = 1.25

            $value = (($Index * 17) + ($cellIndex * 11)) % 101
            [void](Add-TextBox $slide "$value%" ($x + ($cellWidth * 0.09)) ($y + ($cellHeight * 0.18)) ($cellWidth * 0.82) ($cellHeight * 0.34) ([Math]::Max(15, $bodySize + 4)) $white $true)
            [void](Add-TextBox $slide "Block $cellIndex" ($x + ($cellWidth * 0.09)) ($y + ($cellHeight * 0.58)) ($cellWidth * 0.82) ($cellHeight * 0.2) ([Math]::Max(11, $bodySize - 4)) $white $false)
        }
    }

    [void](Add-TextBox $slide ("{0:D2} / {1:D2}" -f $Index, $Presentation.Slides.Count) ($width * 0.78) ($height * 0.92) ($width * 0.15) ($height * 0.035) 12 $muted $false)
}

function New-StressDeck {
    param(
        $PowerPoint,
        [string]$Path,
        [string]$DeckLabel,
        [int]$SlideCount,
        [bool]$Portrait,
        [int[]]$Palette
    )

    $presentation = $PowerPoint.Presentations.Add(-1)
    try {
        if ($Portrait) {
            $presentation.PageSetup.SlideWidth = 540
            $presentation.PageSetup.SlideHeight = 960
        } else {
            $presentation.PageSetup.SlideWidth = 960
            $presentation.PageSetup.SlideHeight = 540
        }

        for ($index = 1; $index -le $SlideCount; $index++) {
            Add-StressSlide $presentation $index $DeckLabel $Palette $Portrait
        }

        $presentation.SaveAs($Path, 24)
        return $presentation
    } catch {
        $presentation.Close()
        [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($presentation) | Out-Null
        throw
    }
}

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$resolvedOutput = (Resolve-Path $OutputDirectory).Path
$wideAPath = Join-Path $resolvedOutput 'PDM-Stress-Wide-A.pptx'
$wideBPath = Join-Path $resolvedOutput 'PDM-Stress-Wide-B.pptx'
$portraitPptxPath = Join-Path $resolvedOutput 'PDM-Stress-Portrait.pptx'
$portraitPdfPath = Join-Path $resolvedOutput 'PDM-Stress-Portrait.pdf'

$powerPoint = New-Object -ComObject PowerPoint.Application
$powerPoint.Visible = -1
$presentations = @()

try {
    $wideAPalette = @(
        (Convert-ToOfficeRgb 23 103 235)
        (Convert-ToOfficeRgb 0 188 212)
        (Convert-ToOfficeRgb 124 58 237)
        (Convert-ToOfficeRgb 37 211 102)
    )
    $wideBPalette = @(
        (Convert-ToOfficeRgb 239 68 68)
        (Convert-ToOfficeRgb 245 158 11)
        (Convert-ToOfficeRgb 236 72 153)
        (Convert-ToOfficeRgb 168 85 247)
    )
    $portraitPalette = @(
        (Convert-ToOfficeRgb 14 165 233)
        (Convert-ToOfficeRgb 20 184 166)
        (Convert-ToOfficeRgb 99 102 241)
        (Convert-ToOfficeRgb 234 179 8)
    )

    if (-not (Test-Path -LiteralPath $wideAPath)) {
        $presentations += New-StressDeck -PowerPoint $powerPoint -Path $wideAPath -DeckLabel 'TEST A' -SlideCount $WideSlideCount -Portrait $false -Palette $wideAPalette
    }
    if (-not (Test-Path -LiteralPath $wideBPath)) {
        $presentations += New-StressDeck -PowerPoint $powerPoint -Path $wideBPath -DeckLabel 'TEST B' -SlideCount $WideSlideCount -Portrait $false -Palette $wideBPalette
    }
    $portrait = if (Test-Path -LiteralPath $portraitPptxPath) {
        $powerPoint.Presentations.Open($portraitPptxPath, $true, $false, $false)
    } else {
        New-StressDeck -PowerPoint $powerPoint -Path $portraitPptxPath -DeckLabel 'PORTRAIT TEST' -SlideCount $PortraitSlideCount -Portrait $true -Palette $portraitPalette
    }
    $presentations += $portrait
    $portrait.SaveAs($portraitPdfPath, 32)
} finally {
    foreach ($presentation in $presentations) {
        try { $presentation.Close() } catch { }
        try { [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($presentation) | Out-Null } catch { }
    }
    try { $powerPoint.Quit() } catch { }
    try { [System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($powerPoint) | Out-Null } catch { }
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
}

Get-Item $wideAPath, $wideBPath, $portraitPptxPath, $portraitPdfPath |
    Select-Object FullName, Length, LastWriteTime
