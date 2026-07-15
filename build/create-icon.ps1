param(
    [Parameter(Mandatory = $true)]
    [string]$Source,
    [string]$PngOutput = (Join-Path $PSScriptRoot 'icon.png'),
    [string]$IcoOutput = (Join-Path $PSScriptRoot 'icon.ico')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function New-RoundedRectanglePath {
    param(
        [float]$Width,
        [float]$Height,
        [float]$Radius
    )

    $diameter = $Radius * 2
    $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $path.AddArc(0, 0, $diameter, $diameter, 180, 90)
    $path.AddArc($Width - $diameter, 0, $diameter, $diameter, 270, 90)
    $path.AddArc($Width - $diameter, $Height - $diameter, $diameter, $diameter, 0, 90)
    $path.AddArc(0, $Height - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    return $path
}

function Resize-IconBitmap {
    param(
        [System.Drawing.Bitmap]$Image,
        [int]$Size
    )

    $result = [System.Drawing.Bitmap]::new(
        $Size,
        $Size,
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
    )
    $graphics = [System.Drawing.Graphics]::FromImage($result)
    try {
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceOver
        $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.DrawImage($Image, 0, 0, $Size, $Size)
    } finally {
        $graphics.Dispose()
    }
    return $result
}

$sourcePath = (Resolve-Path -LiteralPath $Source).Path
$sourceImage = [System.Drawing.Image]::FromFile($sourcePath)
try {
    # Variant 1 occupies the top-left 363x363 cell of the 1536x1024 board.
    $cropX = 125
    $cropY = 87
    $cropSize = 363
    if ($sourceImage.Width -lt ($cropX + $cropSize) -or $sourceImage.Height -lt ($cropY + $cropSize)) {
        throw "Unexpected concept-board size: $($sourceImage.Width)x$($sourceImage.Height)"
    }

    $cropped = [System.Drawing.Bitmap]::new(
        $cropSize,
        $cropSize,
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
    )
    $cropGraphics = [System.Drawing.Graphics]::FromImage($cropped)
    try {
        $cropGraphics.DrawImage(
            $sourceImage,
            [System.Drawing.Rectangle]::new(0, 0, $cropSize, $cropSize),
            [System.Drawing.Rectangle]::new($cropX, $cropY, $cropSize, $cropSize),
            [System.Drawing.GraphicsUnit]::Pixel
        )
    } finally {
        $cropGraphics.Dispose()
    }

    $masked = [System.Drawing.Bitmap]::new(
        $cropSize,
        $cropSize,
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
    )
    $maskGraphics = [System.Drawing.Graphics]::FromImage($masked)
    $roundedPath = New-RoundedRectanglePath -Width $cropSize -Height $cropSize -Radius 61
    $texture = [System.Drawing.TextureBrush]::new($cropped)
    try {
        $maskGraphics.Clear([System.Drawing.Color]::Transparent)
        $maskGraphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $maskGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $maskGraphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $maskGraphics.FillPath($texture, $roundedPath)
    } finally {
        $texture.Dispose()
        $roundedPath.Dispose()
        $maskGraphics.Dispose()
        $cropped.Dispose()
    }

    try {
        $preview = Resize-IconBitmap -Image $masked -Size 512
        try {
            $pngDirectory = Split-Path -Parent $PngOutput
            if ($pngDirectory) { [System.IO.Directory]::CreateDirectory($pngDirectory) | Out-Null }
            $preview.Save($PngOutput, [System.Drawing.Imaging.ImageFormat]::Png)
        } finally {
            $preview.Dispose()
        }

        $sizes = @(256, 128, 64, 48, 32, 24, 16)
        $images = @()
        foreach ($size in $sizes) {
            $bitmap = Resize-IconBitmap -Image $masked -Size $size
            $stream = [System.IO.MemoryStream]::new()
            try {
                $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
                $images += ,([byte[]]$stream.ToArray())
            } finally {
                $stream.Dispose()
                $bitmap.Dispose()
            }
        }

        $icoDirectory = Split-Path -Parent $IcoOutput
        if ($icoDirectory) { [System.IO.Directory]::CreateDirectory($icoDirectory) | Out-Null }
        $fileStream = [System.IO.File]::Create($IcoOutput)
        $writer = [System.IO.BinaryWriter]::new($fileStream)
        try {
            $writer.Write([uint16]0)
            $writer.Write([uint16]1)
            $writer.Write([uint16]$sizes.Count)

            $offset = 6 + (16 * $sizes.Count)
            for ($i = 0; $i -lt $sizes.Count; $i++) {
                $dimension = if ($sizes[$i] -eq 256) { 0 } else { $sizes[$i] }
                $writer.Write([byte]$dimension)
                $writer.Write([byte]$dimension)
                $writer.Write([byte]0)
                $writer.Write([byte]0)
                $writer.Write([uint16]1)
                $writer.Write([uint16]32)
                $writer.Write([uint32]$images[$i].Length)
                $writer.Write([uint32]$offset)
                $offset += $images[$i].Length
            }

            foreach ($imageBytes in $images) {
                $writer.Write([byte[]]$imageBytes)
            }
        } finally {
            $writer.Dispose()
            $fileStream.Dispose()
        }
    } finally {
        $masked.Dispose()
    }
} finally {
    $sourceImage.Dispose()
}

Write-Output "PNG: $PngOutput"
Write-Output "ICO: $IcoOutput"
