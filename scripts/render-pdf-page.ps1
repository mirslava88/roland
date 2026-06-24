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
    Write-Output "OK $($bytes.Length) $($page.Size.Width)x$($page.Size.Height)"
    exit 0
} catch {
    [Console]::Error.WriteLine("ERR: $($_.Exception.Message)")
    exit 1
}
