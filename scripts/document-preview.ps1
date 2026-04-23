param(
    [Parameter(Mandatory=$true)]
    [string]$FilePath
)

$ErrorActionPreference = 'Stop'

# UTF-8 stdout чтобы JSON с Cyrillic-путями не ломался при чтении в main.ts.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$ext = [System.IO.Path]::GetExtension($FilePath).ToLower()
$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) 'roland-doc-previews'
if (-not (Test-Path $tempDir)) { New-Item -ItemType Directory -Path $tempDir -Force | Out-Null }

$bytes = [System.IO.File]::ReadAllBytes($FilePath)
$md5 = [System.Security.Cryptography.MD5]::Create()
$hashBytes = $md5.ComputeHash($bytes, 0, [Math]::Min(4096, $bytes.Length))
$hash = -join ($hashBytes | ForEach-Object { $_.ToString('x2') })
$hash = $hash.Substring(0, 8)
$baseName = [System.IO.Path]::GetFileNameWithoutExtension($FilePath)
$outputFile = Join-Path $tempDir "${baseName}_${hash}.pdf"

# Return cached
if (Test-Path $outputFile) {
    $escaped = $outputFile.Replace('\','\\')
    Write-Output "{`"Status`":`"ok`",`"Path`":`"$escaped`"}"
    exit 0
}

# Run COM export in a background job with timeout
$job = Start-Job -ArgumentList $FilePath, $outputFile, $ext -ScriptBlock {
    param($fp, $out, $extension)
    $ErrorActionPreference = 'Stop'
    try {
        if ($extension -in '.doc', '.docx', '.rtf', '.odt', '.txt') {
            $word = New-Object -ComObject Word.Application
            $word.Visible = $false
            $word.DisplayAlerts = 0
            $word.ScreenUpdating = $false
            try {
                $doc = $word.Documents.Open($fp, $false, $true, $false)
                $doc.ExportAsFixedFormat($out, 17, $false, 1, 2)  # wdExportFormatPDF=17, wdExportCurrentPage=2
                $doc.Close([ref]$false)
            } finally {
                try { $word.Quit([ref]$false) } catch {}
                try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null } catch {}
            }
        }
        elseif ($extension -in '.xls', '.xlsx', '.ods') {
            $excel = New-Object -ComObject Excel.Application
            $excel.Visible = $false
            $excel.DisplayAlerts = $false
            $excel.ScreenUpdating = $false
            try {
                $wb = $excel.Workbooks.Open($fp, 0, $true)
                $ws = $wb.Sheets.Item(1)
                $ws.ExportAsFixedFormat(0, $out)  # xlTypePDF=0
                [System.Runtime.InteropServices.Marshal]::ReleaseComObject($ws) | Out-Null
                $wb.Close($false)
            } finally {
                try { $excel.Quit() } catch {}
                try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($excel) | Out-Null } catch {}
            }
        }
        return "ok"
    } catch {
        return "error:$($_.Exception.Message)"
    }
}

# Wait up to 30 seconds
$completed = Wait-Job $job -Timeout 30
if ($completed) {
    $result = Receive-Job $job
    Remove-Job $job -Force

    if ($result -like "ok" -and (Test-Path $outputFile)) {
        $escaped = $outputFile.Replace('\','\\')
        Write-Output "{`"Status`":`"ok`",`"Path`":`"$escaped`"}"
    } else {
        $errMsg = ($result -replace '^error:', '') -replace '"', "'"
        Write-Output "{`"Status`":`"error`",`"Error`":`"$errMsg`"}"
    }
} else {
    # Timeout — kill job and any orphan Word/Excel
    Stop-Job $job -ErrorAction SilentlyContinue
    Remove-Job $job -Force -ErrorAction SilentlyContinue
    if (Test-Path $outputFile) { Remove-Item $outputFile -Force -ErrorAction SilentlyContinue }
    Write-Output '{"Status":"error","Error":"Timeout"}'
}
