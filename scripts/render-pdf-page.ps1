# Render single page of PDF to PNG via Windows.Data.Pdf (native WinRT).
# Used instead of pdf.js when high quality is required — pdf.js has a known
# bug with TilingPattern at scale > 1 which truncates renders horizontally.
#
# Args:
#   -PdfPath: absolute path to source PDF
#   -PageIndex: 0-based page index
#   -OutPath: where to write the resulting PNG
#   -Width: desired output width in pixels (height is computed from aspect)
#
# Exit code 0 on success; on error writes error to stderr and exits 1.

param(
    [Parameter(Mandatory=$true)][string]$PdfPath,
    [Parameter(Mandatory=$true)][int]$PageIndex,
    [Parameter(Mandatory=$true)][string]$OutPath,
    [Parameter(Mandatory=$true)][int]$Width
)

$ErrorActionPreference = 'Stop'
$RejectedPath = "$OutPath.rejected"
try {
    [void][System.Reflection.Assembly]::LoadWithPartialName('System.Runtime.WindowsRuntime')
    $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
    $asTaskAction = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' })[0]

    function Await($WinRtTask, $ResultType) {
        $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
        $netTask = $asTask.Invoke($null, @($WinRtTask))
        $netTask.Wait(-1) | Out-Null
        $netTask.Result
    }
    function AwaitAction($WinRtTask) {
        $netTask = $asTaskAction.Invoke($null, @($WinRtTask))
        $netTask.Wait(-1) | Out-Null
    }

    [Windows.Data.Pdf.PdfDocument,Windows.Data.Pdf,ContentType=WindowsRuntime] | Out-Null
    [Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime] | Out-Null
    [Windows.Storage.Streams.InMemoryRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime] | Out-Null
    [Windows.Storage.Streams.DataReader,Windows.Storage.Streams,ContentType=WindowsRuntime] | Out-Null

    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($PdfPath)) ([Windows.Storage.StorageFile])
    $doc  = Await ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])
    if ($PageIndex -lt 0 -or $PageIndex -ge $doc.PageCount) { throw "Page index $PageIndex out of range (0..$($doc.PageCount-1))" }
    $page = $doc.GetPage($PageIndex)

    $stream = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
    $opts   = New-Object Windows.Data.Pdf.PdfPageRenderOptions
    $opts.DestinationWidth = [uint32]$Width
    AwaitAction ($page.RenderToStreamAsync($stream, $opts))

    $stream.Seek(0)
    $reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
    Await ($reader.LoadAsync([uint32]$stream.Size)) ([uint32]) | Out-Null
    $bytes = New-Object byte[] $stream.Size
    $reader.ReadBytes($bytes)
    [System.IO.File]::WriteAllBytes($OutPath, $bytes)

    # Windows.Data.Pdf can return S_OK and a valid PNG while silently painting
    # the whole page as one colour. This is reproducible with Figma PDFs that
    # combine full-page transparency groups, soft masks and shading patterns.
    # Treat a visually uniform native frame as untrustworthy: a genuinely
    # blank/solid PDF page is harmlessly rendered again by pdf.js, while a
    # broken native frame must never be announced as ready to the audience.
    $uniform = $false
    $spread = -1
    try {
        Add-Type -AssemblyName System.Drawing
        $bitmap = [System.Drawing.Bitmap]::FromFile($OutPath)
        try {
            $minR = 255; $minG = 255; $minB = 255; $minA = 255
            $maxR = 0;   $maxG = 0;   $maxB = 0;   $maxA = 0
            $sampleColumns = [Math]::Min(64, $bitmap.Width)
            $sampleRows = [Math]::Min(36, $bitmap.Height)

            for ($sampleY = 0; $sampleY -lt $sampleRows; $sampleY++) {
                $pixelY = if ($sampleRows -le 1) { 0 } else {
                    [Math]::Round($sampleY * ($bitmap.Height - 1) / ($sampleRows - 1))
                }
                for ($sampleX = 0; $sampleX -lt $sampleColumns; $sampleX++) {
                    $pixelX = if ($sampleColumns -le 1) { 0 } else {
                        [Math]::Round($sampleX * ($bitmap.Width - 1) / ($sampleColumns - 1))
                    }
                    $pixel = $bitmap.GetPixel([int]$pixelX, [int]$pixelY)
                    $minR = [Math]::Min($minR, $pixel.R); $maxR = [Math]::Max($maxR, $pixel.R)
                    $minG = [Math]::Min($minG, $pixel.G); $maxG = [Math]::Max($maxG, $pixel.G)
                    $minB = [Math]::Min($minB, $pixel.B); $maxB = [Math]::Max($maxB, $pixel.B)
                    $minA = [Math]::Min($minA, $pixel.A); $maxA = [Math]::Max($maxA, $pixel.A)
                }
            }

            $spread = [Math]::Max(
                [Math]::Max($maxR - $minR, $maxG - $minG),
                [Math]::Max($maxB - $minB, $maxA - $minA)
            )
            $uniform = $spread -le 3
        } finally {
            $bitmap.Dispose()
        }
    } catch {
        # Validation is an extra safety net. If GDI+ is unavailable on an
        # unusual Windows installation, keep the existing native result and
        # let the renderer continue rather than failing every PDF.
        Write-Output "VALIDATION_UNAVAILABLE $($_.Exception.Message)"
    }

    if ($uniform) {
        Remove-Item -LiteralPath $OutPath -Force -ErrorAction SilentlyContinue
        [System.IO.File]::WriteAllText(
            $RejectedPath,
            "uniform-v1 bytes=$($bytes.Length) spread=$spread"
        )
        Write-Output "FALLBACK_UNIFORM $($bytes.Length) spread=$spread $($page.Size.Width)x$($page.Size.Height)"
        exit 0
    }

    Remove-Item -LiteralPath $RejectedPath -Force -ErrorAction SilentlyContinue
    Write-Output "OK $($bytes.Length) spread=$spread $($page.Size.Width)x$($page.Size.Height)"
    exit 0
} catch {
    [Console]::Error.WriteLine("ERR: $($_.Exception.Message)")
    exit 1
}
