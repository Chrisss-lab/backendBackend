<#
.SYNOPSIS
  Delete invoice PDFs under Desktop\Backend BackUps (run_* / site_clean_*) whose
  LastWriteTime falls in a specific past calendar year (default: previous year).

.PARAMETER BackupRoot
  Default: Desktop\Backend BackUps

.PARAMETER LastWriteYearToDelete
  Delete PDFs where LastWriteTime.Year equals this year (e.g. 2025 in 2026).
  Default: (Get-Date).Year - 1

.PARAMETER WhatIf
  List files that would be deleted without removing them.
#>
param(
  [string]$BackupRoot = "",
  [int]$LastWriteYearToDelete = 0,
  [switch]$WhatIf
)

$ErrorActionPreference = "Stop"

if (-not $BackupRoot) {
  $BackupRoot = Join-Path $env:USERPROFILE "Desktop\Backend BackUps"
}
if (-not (Test-Path -LiteralPath $BackupRoot)) { exit 0 }

if ($LastWriteYearToDelete -le 0) {
  $LastWriteYearToDelete = (Get-Date).Year - 1
}

$logPath = Join-Path $BackupRoot "prune-invoices-log.txt"
function Log([string]$m) {
  $line = "$(Get-Date -Format o) $m"
  Add-Content -LiteralPath $logPath -Value $line
  Write-Host $line
}

$roots = @(Get-ChildItem -LiteralPath $BackupRoot -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match '^(run_|site_clean_)' })

$removed = 0
foreach ($r in $roots) {
  $paths = @(
    (Join-Path $r.FullName "Invoices"),
    (Join-Path $r.FullName "uploads_invoices")
  )
  foreach ($dir in $paths) {
    if (-not (Test-Path -LiteralPath $dir)) { continue }
    $pdfs = Get-ChildItem -LiteralPath $dir -Recurse -File -Filter "*.pdf" -ErrorAction SilentlyContinue |
      Where-Object { $_.LastWriteTime.Year -eq $LastWriteYearToDelete }
    foreach ($f in $pdfs) {
      if ($WhatIf) {
        Log "WhatIf would delete: $($f.FullName)"
        continue
      }
      Remove-Item -LiteralPath $f.FullName -Force
      $removed++
      Log "Deleted (year $LastWriteYearToDelete): $($f.FullName)"
    }
  }
}

if (-not $WhatIf) {
  Log "Prune finished. Removed $removed PDF(s) with LastWriteTime year $LastWriteYearToDelete."
}
