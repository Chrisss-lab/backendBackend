<#
.SYNOPSIS
  Full backup to Desktop\Backend BackUps:
  1) Shell archive (default): copy full dev.db to run_*, move ALL invoice PDFs + expense uploads off live, then clear
     orders/invoices/payments/expenses in live prisma\dev.db (catalog stays). Stop the API first for a consistent SQLite copy.
     Use -LegacyArchivedInvoicesOnly for old behavior (only DB-listed archived invoice PDFs moved; live DB unchanged).
  2) Slim site snapshot (site_clean_*) — no node_modules / builds; skips *.pdf so invoice PDFs are not duplicated (they live under run_*)
  3) Dedupe identical files across backup folders (SHA256, keep newest backup run)
  4) Prune invoice PDFs in backups whose file LastWriteTime year equals -PruneInvoicePdfsYear (default: previous calendar year)
  5) Trim old prisma dev.backup-*.db on live + old backup folders

.PARAMETER SkipMediaMove
  Skip step 1 (do not move invoices/receipts / do not shell DB).

.PARAMETER CopyOnlyMedia
  Pass through to backup-media-weekly: copy only, do not remove from live (testing). Cannot be combined with shell mode.

.PARAMETER LegacyArchivedInvoicesOnly
  Do not use -ShellLiveSite: only move invoice PDFs tied to archived DB rows (legacy weekly behavior); live DB is not trimmed.

.PARAMETER KeepPrismaDbSnapshots
  How many dev.backup-*.db files to keep in apps\api\prisma (newest first). Default 1.

.PARAMETER KeepBackupRuns
  How many site_clean_* and run_* folders to keep under BackupRoot. Default 15.

.PARAMETER CleanBuildArtifacts
  Remove apps\web\.next and apps\api\dist after backup.

.PARAMETER BackupRoot
  Default: $env:USERPROFILE\Desktop\Backend BackUps

.PARAMETER PruneInvoicePdfsYear
  Year for LastWriteTime match when pruning old invoice PDFs under BackupRoot (0 = previous calendar year).

.PARAMETER SkipPruneOldInvoicePdfs
  Do not run prune-old-backup-invoice-pdfs.ps1 after dedupe.
#>
param(
  [string]$BackendRoot = "",
  [string]$BackupRoot = "",
  [switch]$SkipMediaMove,
  [switch]$CopyOnlyMedia,
  [switch]$LegacyArchivedInvoicesOnly,
  [int]$KeepPrismaDbSnapshots = 1,
  [int]$KeepBackupRuns = 15,
  [int]$PruneInvoicePdfsYear = 0,
  [switch]$SkipPruneOldInvoicePdfs,
  [switch]$CleanBuildArtifacts
)

$ErrorActionPreference = "Stop"

if (-not $BackendRoot) {
  $BackendRoot = Split-Path -Parent $PSScriptRoot
}
$BackendRoot = (Resolve-Path -LiteralPath $BackendRoot).Path

if (-not $BackupRoot) {
  $BackupRoot = Join-Path $env:USERPROFILE "Desktop\Backend BackUps"
}
if (-not (Test-Path -LiteralPath $BackupRoot)) {
  New-Item -ItemType Directory -Path $BackupRoot -Force | Out-Null
}

$stamp = Get-Date -Format "yyyy-MM-dd_HHmmss"
$dest = Join-Path $BackupRoot "site_clean_$stamp"
New-Item -ItemType Directory -Path $dest -Force | Out-Null

$logPath = Join-Path $dest "backup-log.txt"
function Write-Log([string]$msg) {
  $line = "$(Get-Date -Format o) $msg"
  Add-Content -LiteralPath $logPath -Value $line
  Write-Host $line
}

Write-Log "Backend root: $BackendRoot"
Write-Log "Backup root: $BackupRoot"
Write-Log "Site snapshot folder: $dest"

# --- 1) Shell archive: full DB + all PDFs + expenses to run_*, then trim transactional rows on live dev.db ---
$mediaScript = Join-Path $PSScriptRoot "backup-media-weekly.ps1"
if (-not $SkipMediaMove -and (Test-Path -LiteralPath $mediaScript)) {
  if ($CopyOnlyMedia -and -not $LegacyArchivedInvoicesOnly) {
    Write-Log "CopyOnlyMedia: using legacy archived-invoice mode only (ShellLiveSite requires move mode)."
    $LegacyArchivedInvoicesOnly = $true
  }
  $modeLabel = if ($LegacyArchivedInvoicesOnly) { "legacy archived PDFs + expenses (live DB unchanged)" } else { "SHELL: full DB snapshot, all invoice PDFs, expenses, then clear orders/invoices/payments/expenses on live" }
  Write-Log "Running backup-media-weekly.ps1 ($modeLabel)..."
  $mediaArgs = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", $mediaScript,
    "-BackendRoot", $BackendRoot,
    "-BackupRoot", $BackupRoot
  )
  if ($CopyOnlyMedia) {
    $mediaArgs += "-CopyOnly"
  }
  if (-not $LegacyArchivedInvoicesOnly) {
    $mediaArgs += "-ShellLiveSite"
  }
  $mediaArgs += "-SkipDedupe"
  & powershell.exe @mediaArgs
  $mc = $LASTEXITCODE
  if ($null -eq $mc) { $mc = 0 }
  if ($mc -ne 0) {
    throw "backup-media-weekly exited $mc — check latest run_* backup-log.txt; fix before continuing (live may be partially updated if shell mode ran)."
  }
  Write-Log "backup-media-weekly completed OK"
}
elseif ($SkipMediaMove) {
  Write-Log "Skip media move (-SkipMediaMove)"
}
else {
  Write-Log "WARN backup-media-weekly.ps1 missing — invoices not moved"
}

# --- 2) Slim site copy: exclude bulky dirs + all PDFs (invoices already in run_*; avoids duplicate PDFs in site_clean) ---
$robCmd = "robocopy `"$BackendRoot`" `"$dest`" /E /XD node_modules .next dist coverage .git __pycache__ .turbo /XF *.pdf backend-start.log .DS_Store Thumbs.db *.tsbuildinfo /R:2 /W:2 /NFL /NDL /NJH /NJS /NC /NS /NP"
cmd.exe /c $robCmd | Out-Null
$rc = $LASTEXITCODE
if ($null -eq $rc) { $rc = 0 }
if ($rc -lt 0 -or $rc -ge 8) {
  throw "robocopy failed with exit code $rc"
}
Write-Log "robocopy site snapshot completed (exit $rc); PDFs excluded from site_clean to avoid duplicating run_* invoice files"

# --- 3) Dedupe identical files across run_* and site_clean_* ---
$dedupeScript = Join-Path $PSScriptRoot "dedupe-backups.ps1"
if (Test-Path -LiteralPath $dedupeScript) {
  Write-Log "Running dedupe-backups.ps1..."
  try {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $dedupeScript -BackupRoot $BackupRoot -Quiet
    Write-Log "Dedupe finished (see $BackupRoot\dedupe-log.txt)"
  }
  catch {
    Write-Log "WARN dedupe failed: $_"
  }
}

# --- 3b) Drop very old invoice PDFs from backup folders (by file LastWriteTime year, not invoice business date) ---
$pruneScript = Join-Path $PSScriptRoot "prune-old-backup-invoice-pdfs.ps1"
if (-not $SkipPruneOldInvoicePdfs -and (Test-Path -LiteralPath $pruneScript)) {
  Write-Log "Pruning old backup invoice PDFs (LastWriteTime year)..."
  try {
    $pruneArgs = @(
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", $pruneScript,
      "-BackupRoot", $BackupRoot
    )
    if ($PruneInvoicePdfsYear -gt 0) {
      $pruneArgs += "-LastWriteYearToDelete"
      $pruneArgs += "$PruneInvoicePdfsYear"
    }
    & powershell.exe @pruneArgs
    Write-Log "Prune step finished (log: $BackupRoot\prune-invoices-log.txt)"
  }
  catch {
    Write-Log "WARN prune-old-backup-invoice-pdfs failed: $_"
  }
}
elseif (-not $SkipPruneOldInvoicePdfs) {
  Write-Log "WARN prune-old-backup-invoice-pdfs.ps1 missing — skipped"
}

# --- 4) Prisma snapshot cleanup on live ---
$prismaDir = Join-Path $BackendRoot "apps\api\prisma"
if (Test-Path -LiteralPath $prismaDir) {
  $snaps = @(Get-ChildItem -LiteralPath $prismaDir -Filter "dev.backup-*.db" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending)
  if ($snaps.Count -gt $KeepPrismaDbSnapshots) {
    $remove = $snaps | Select-Object -Skip $KeepPrismaDbSnapshots
    foreach ($f in $remove) {
      Write-Log "Removing old prisma snapshot: $($f.Name)"
      Remove-Item -LiteralPath $f.FullName -Force
    }
  }
}

# --- 5) Trim oldest backup runs ---
$runs = @(Get-ChildItem -LiteralPath $BackupRoot -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match '^(site_clean_|run_)' } |
  Sort-Object LastWriteTime -Descending)
if ($runs.Count -gt $KeepBackupRuns) {
  foreach ($d in ($runs | Select-Object -Skip $KeepBackupRuns)) {
    Write-Log "Removing old backup folder: $($d.Name)"
    Remove-Item -LiteralPath $d.FullName -Recurse -Force
  }
}

if ($CleanBuildArtifacts) {
  foreach ($p in @(
    (Join-Path $BackendRoot "apps\web\.next"),
    (Join-Path $BackendRoot "apps\api\dist")
  )) {
    if (Test-Path -LiteralPath $p) {
      Write-Log "Removing build artifact: $p"
      Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

Write-Log "Full backup and cleanup finished successfully."
Write-Log "History: run_*\database\dev.db + Invoices\ + expenses\. Live site: thin DB (orders cleared after shell backup). Restore by copying those folders/files back and merging DB if needed."
