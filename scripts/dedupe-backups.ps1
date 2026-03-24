<#
.SYNOPSIS
  Remove duplicate files (same SHA256) across run_* and site_clean_* folders under BackupRoot.
  Keeps the copy in the newest backup folder (by folder LastWriteTime); deletes older duplicates.

.PARAMETER BackupRoot
  Default: Desktop\Backend BackUps

.PARAMETER Quiet
  Less console output
#>
param(
  [string]$BackupRoot = "",
  [switch]$Quiet
)

$ErrorActionPreference = "Stop"

if (-not $BackupRoot) {
  $BackupRoot = Join-Path $env:USERPROFILE "Desktop\Backend BackUps"
}
if (-not (Test-Path -LiteralPath $BackupRoot)) {
  if (-not $Quiet) { Write-Host "Backup root missing: $BackupRoot — nothing to dedupe." }
  exit 0
}

$logPath = Join-Path $BackupRoot "dedupe-log.txt"
function Log([string]$m) {
  $line = "$(Get-Date -Format o) $m"
  Add-Content -LiteralPath $logPath -Value $line
  if (-not $Quiet) { Write-Host $line }
}

function Get-BackupRootFolder([string]$filePath) {
  $d = Split-Path -Parent $filePath
  while ($d) {
    $leaf = Split-Path -Leaf $d
    if ($leaf -match '^(run_|site_clean_)') { return $d }
    $parent = Split-Path -Parent $d
    if ($parent -eq $d) { break }
    $d = $parent
  }
  return $null
}

$runs = @(Get-ChildItem -LiteralPath $BackupRoot -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match '^(run_|site_clean_)' })
if ($runs.Count -eq 0) {
  Log "No run_* or site_clean_* folders — skip dedupe."
  exit 0
}

Log "Dedupe scan: $($runs.Count) backup folder(s) under $BackupRoot"

$allFiles = @()
foreach ($r in $runs) {
  try {
    foreach ($f in (Get-ChildItem -LiteralPath $r.FullName -Recurse -File -ErrorAction SilentlyContinue)) {
      if ($f.Length -eq 0) { continue }
      $allFiles += $f
    }
  }
  catch {
    Log "WARN listing $($r.FullName): $_"
  }
}

if ($allFiles.Count -eq 0) {
  Log "No files to hash — done."
  exit 0
}

$byHash = @{}
foreach ($f in $allFiles) {
  try {
    $h = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash
  }
  catch {
    Log "WARN hash failed $($f.FullName): $_"
    continue
  }
  if (-not $byHash.ContainsKey($h)) {
    $byHash[$h] = @()
  }
  $byHash[$h] += $f
}

$removed = 0
foreach ($h in @($byHash.Keys)) {
  $list = @($byHash[$h])
  if ($list.Count -lt 2) { continue }

  $ranked = $list | ForEach-Object {
    $rootFolder = Get-BackupRootFolder $_.FullName
    $sortKey = if ($rootFolder) { (Get-Item -LiteralPath $rootFolder).LastWriteTime } else { $_.LastWriteTimeUtc }
    [pscustomobject]@{ File = $_; SortKey = $sortKey }
  } | Sort-Object SortKey -Descending

  $keep = $ranked[0].File
  foreach ($row in ($ranked | Select-Object -Skip 1)) {
    $dup = $row.File
    try {
      Remove-Item -LiteralPath $dup.FullName -Force
      $removed++
      Log "Removed duplicate (kept $($keep.FullName)): $($dup.FullName)"
    }
    catch {
      Log "WARN could not remove $($dup.FullName): $_"
    }
  }
}

Log "Dedupe finished. Removed $removed duplicate file(s)."
exit 0
