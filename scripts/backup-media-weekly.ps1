# backup-media-weekly.ps1 - see repo docs / backup-site-and-cleanup.ps1
param(
  [string]$BackendRoot = "",
  [string]$BackupRoot = "",
  [switch]$CopyOnly,
  [switch]$NoDatabase,
  [switch]$ShellLiveSite,
  [switch]$SkipDedupe
)

$ErrorActionPreference = "Stop"
$Move = -not $CopyOnly

if ($ShellLiveSite -and $CopyOnly) {
  Write-Host "ERROR: ShellLiveSite cannot be used with CopyOnly."
  exit 1
}
if ($ShellLiveSite -and $NoDatabase) {
  Write-Host "ERROR: ShellLiveSite requires database backup (do not use NoDatabase)."
  exit 1
}

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
$dest = Join-Path $BackupRoot "run_$stamp"
New-Item -ItemType Directory -Path $dest -Force | Out-Null

$logPath = Join-Path $dest "backup-log.txt"
function Write-Log([string]$msg) {
  $line = "$(Get-Date -Format o) $msg"
  Add-Content -LiteralPath $logPath -Value $line
  Write-Host $line
}

Write-Log "Backend root: $BackendRoot"
Write-Log "Backup destination: $dest"
Write-Log "Move mode: $Move | ShellLiveSite: $ShellLiveSite"

$invSrc = Join-Path $BackendRoot "Invoices"
$expSrc = Join-Path $BackendRoot "apps\api\uploads\expenses"
$legacyInv = Join-Path $BackendRoot "apps\api\uploads\invoices"
$dbSrc = Join-Path $BackendRoot "apps\api\prisma\dev.db"

$destInv = Join-Path $dest "Invoices"
$destExp = Join-Path $dest "expenses"
$destLegacyInv = Join-Path $dest "uploads_invoices"
$destDb = Join-Path $dest "database"

function Test-RobocopyOk([int]$exitCode) {
  return $exitCode -ge 0 -and $exitCode -lt 8
}

$ok = $true

function Copy-DatabaseSnapshot {
  param([string]$Src, [string]$DestDir)
  New-Item -ItemType Directory -Path $DestDir -Force | Out-Null
  if (-not (Test-Path -LiteralPath $Src)) {
    Write-Log "WARN dev.db not found at $Src"
    return $false
  }
  Copy-Item -LiteralPath $Src -Destination (Join-Path $DestDir "dev.db") -Force
  foreach ($suffix in @("-wal", "-shm")) {
    $sidecar = "$Src$suffix"
    if (Test-Path -LiteralPath $sidecar) {
      Copy-Item -LiteralPath $sidecar -Destination (Join-Path $DestDir "dev.db$suffix") -Force
    }
  }
  Write-Log ('Copied database snapshot to {0}; includes dev.db and wal/shm sidecars when present' -f $DestDir)
  return $true
}

function Move-AllInvoicePdfs {
  param([bool]$DoMove)
  $verb = if ($DoMove) { "move" } else { "copy" }
  $count = 0
  if (-not (Test-Path -LiteralPath $invSrc)) {
    Write-Log "WARN Skip Invoices folder missing: $invSrc"
    return 0
  }
  New-Item -ItemType Directory -Path $destInv -Force | Out-Null
  foreach ($f in (Get-ChildItem -LiteralPath $invSrc -File -Filter "*.pdf" -ErrorAction SilentlyContinue)) {
    $target = Join-Path $destInv $f.Name
    if ($DoMove) { Move-Item -LiteralPath $f.FullName -Destination $target -Force }
    else { Copy-Item -LiteralPath $f.FullName -Destination $target -Force }
    $count++
  }
  $arch = Join-Path $invSrc "archive"
  if (Test-Path -LiteralPath $arch) {
    $destArch = Join-Path $destInv "archive"
    New-Item -ItemType Directory -Path $destArch -Force | Out-Null
    foreach ($f in (Get-ChildItem -LiteralPath $arch -File -Filter "*.pdf" -ErrorAction SilentlyContinue)) {
      $target = Join-Path $destArch $f.Name
      if ($DoMove) { Move-Item -LiteralPath $f.FullName -Destination $target -Force }
      else { Copy-Item -LiteralPath $f.FullName -Destination $target -Force }
      $count++
    }
  }
  if (Test-Path -LiteralPath $legacyInv) {
    New-Item -ItemType Directory -Path $destLegacyInv -Force | Out-Null
    foreach ($f in (Get-ChildItem -LiteralPath $legacyInv -File -Filter "*.pdf" -ErrorAction SilentlyContinue)) {
      $target = Join-Path $destLegacyInv $f.Name
      if ($DoMove) { Move-Item -LiteralPath $f.FullName -Destination $target -Force }
      else { Copy-Item -LiteralPath $f.FullName -Destination $target -Force }
      $count++
    }
  }
  Write-Log ('Invoices all PDFs: {0} {1} files from Invoices and legacy uploads' -f $verb, $count)
  return $count
}

# ===================== SHELL MODE (weekly full archive) =====================
if ($ShellLiveSite) {
  Write-Log "SHELL ARCHIVE: stop the API for a clean DB copy. Backup has full history; live will keep catalog only."

  if (-not $NoDatabase) {
    if (-not (Copy-DatabaseSnapshot -Src $dbSrc -DestDir $destDb)) {
      $ok = $false
    }
  }

  if ($ok -and $Move) {
    try {
      Move-AllInvoicePdfs -DoMove $true | Out-Null
    }
    catch {
      Write-Log "ERROR moving invoice PDFs: $_"
      $ok = $false
    }
  }
  elseif ($ok) {
    Move-AllInvoicePdfs -DoMove $false | Out-Null
  }

  if (Test-Path -LiteralPath $expSrc) {
    New-Item -ItemType Directory -Path $destExp -Force | Out-Null
    $expLog = Join-Path $dest "robocopy-expenses.log"
    if ($Move) {
      & robocopy.exe $expSrc $destExp /E /MOV /COPY:DAT /R:2 /W:5 /NP /LOG:$expLog | Out-Null
    }
    else {
      & robocopy.exe $expSrc $destExp /E /COPY:DAT /R:2 /W:5 /NP /LOG:$expLog | Out-Null
    }
    $rc = $LASTEXITCODE
    if (-not (Test-RobocopyOk $rc)) {
      Write-Log ('ERROR robocopy expenses exit {0}; see log {1}' -f $rc, $expLog)
      $ok = $false
    }
    else {
      Write-Log "Expenses uploads: robocopy exit $rc"
    }
  }
  else {
    Write-Log "Skip expenses (missing): $expSrc"
  }

  if ($ok -and $Move -and (Test-Path -LiteralPath $dbSrc)) {
    $py = Join-Path $PSScriptRoot "shell_live_database.py"
    if (-not (Test-Path -LiteralPath $py)) {
      Write-Log "ERROR missing shell_live_database.py — live DB not cleared"
      $ok = $false
    }
    else {
      try {
        & python.exe $py $dbSrc
        if ($LASTEXITCODE -ne 0) {
          Write-Log "ERROR shell_live_database.py exit $LASTEXITCODE"
          $ok = $false
        }
        else {
          Write-Log 'Live database shelled: orders, invoices, payments, expenses removed.'
        }
      }
      catch {
        Write-Log "ERROR running shell_live_database.py: $_"
        $ok = $false
      }
    }
  }

  if (-not $ok) {
    Write-Log 'BACKUP FINISHED WITH ERRORS shell mode'
    exit 1
  }

  Write-Log 'SHELL BACKUP OK. Restore: copy database\dev.db from this folder to prisma\dev.db and restore Invoices\ and expenses\ on live.'
  if (-not $SkipDedupe) {
    $dedupeScript = Join-Path $PSScriptRoot "dedupe-backups.ps1"
    if (-not (Test-Path -LiteralPath $dedupeScript)) { $dedupeScript = Join-Path $BackupRoot "dedupe-backups.ps1" }
    if (Test-Path -LiteralPath $dedupeScript) {
      Write-Log "Running dedupe-backups.ps1..."
      try {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $dedupeScript -BackupRoot $BackupRoot -Quiet
      }
      catch {
        Write-Log "WARN dedupe: $_"
      }
    }
  }
  exit 0
}

# ===================== LEGACY: archived invoices only =====================
function Sanitize-InvoiceArchiveFileName([string]$invoiceNumber) {
  $s = ($invoiceNumber -replace '[/\\?%*:|"<>]', '-').Trim()
  if ([string]::IsNullOrWhiteSpace($s)) { $s = "invoice" }
  if ($s.Length -gt 180) { $s = $s.Substring(0, 180) }
  return "$s.pdf"
}

$listScript = Join-Path $PSScriptRoot "list-archived-invoice-entries.ts"
$apiDir = Join-Path $BackendRoot "apps\api"
$archiveEntries = @()
$invoiceListOk = $false
if ((Test-Path -LiteralPath $listScript) -and (Test-Path -LiteralPath $apiDir)) {
  try {
    Push-Location -LiteralPath $apiDir
    try {
      $raw = (& npx --yes ts-node --transpile-only $listScript 2>$null | Out-String).Trim()
      $npxCode = $LASTEXITCODE
      if ($npxCode -ne 0) {
        $snippet = if ($raw.Length -gt 200) { $raw.Substring(0, 200) + "..." } else { $raw }
        throw ('npx ts-node exited with code {0}; output: {1}' -f $npxCode, $snippet)
      }
      if (-not [string]::IsNullOrWhiteSpace($raw)) {
        $parsed = $raw | ConvertFrom-Json
        $archiveEntries = @($parsed.entries)
      }
      else {
        $archiveEntries = @()
      }
      $invoiceListOk = $true
    }
    finally {
      Pop-Location
    }
  }
  catch {
    Write-Log "ERROR could not list archived invoices (Prisma / DB): $_"
    $invoiceListOk = $false
    $archiveEntries = @()
  }
}
else {
  Write-Log "WARN list-archived-invoice-entries.ts or apps\api missing — cannot select archived invoices"
}

$verbMoveCopy = if ($Move) { "move" } else { "copy" }
$movedNote = if ($Move) { "; moved off live" } else { "" }
$skippedPendingNote = ' — pending and other non-archived PDFs left on live project'

if (Test-Path -LiteralPath $invSrc) {
  New-Item -ItemType Directory -Path $destInv -Force | Out-Null
  $destInvArchive = Join-Path $destInv "archive"
  if (-not $invoiceListOk) {
    Write-Log "ERROR skipped Invoices\ backup — DB list failed. All invoice PDFs left untouched."
    $ok = $false
  }
  elseif ($archiveEntries.Count -eq 0) {
    Write-Log "Invoices: no archived-order rows in DB — nothing to $verbMoveCopy under Invoices folder$skippedPendingNote"
  }
  else {
    try {
      $archivedCount = 0
      foreach ($e in $archiveEntries) {
        $id = [string]$e.id
        $invNo = [string]$e.invoiceNumber
        if (-not $id) { continue }
        $primaryName = "$id.pdf"
        $srcPrimary = Join-Path $invSrc $primaryName
        if (Test-Path -LiteralPath $srcPrimary) {
          if ($Move) {
            Move-Item -LiteralPath $srcPrimary -Destination (Join-Path $destInv $primaryName) -Force
          }
          else {
            Copy-Item -LiteralPath $srcPrimary -Destination (Join-Path $destInv $primaryName) -Force
          }
          $archivedCount++
        }
        $archFile = Sanitize-InvoiceArchiveFileName $invNo
        $srcArch = Join-Path $invSrc (Join-Path "archive" $archFile)
        if (Test-Path -LiteralPath $srcArch) {
          if (-not (Test-Path -LiteralPath $destInvArchive)) {
            New-Item -ItemType Directory -Path $destInvArchive -Force | Out-Null
          }
          if ($Move) {
            Move-Item -LiteralPath $srcArch -Destination (Join-Path $destInvArchive $archFile) -Force
          }
          else {
            Copy-Item -LiteralPath $srcArch -Destination (Join-Path $destInvArchive $archFile) -Force
          }
        }
      }
      Write-Log ('Invoices: {0} {1} archived-order PDFs from Invoices main folder{2}{3}' -f $verbMoveCopy, $archivedCount, $movedNote, $skippedPendingNote)
    }
    catch {
      Write-Log "ERROR copying/moving invoice PDFs: $_"
      $ok = $false
    }
  }
}
else {
  Write-Log "Skip Invoices (missing): $invSrc"
}

if (Test-Path -LiteralPath $expSrc) {
  New-Item -ItemType Directory -Path $destExp -Force | Out-Null
  $expLog = Join-Path $dest "robocopy-expenses.log"
  if ($Move) {
    & robocopy.exe $expSrc $destExp /E /MOV /COPY:DAT /R:2 /W:5 /NP /LOG:$expLog | Out-Null
  }
  else {
    & robocopy.exe $expSrc $destExp /E /COPY:DAT /R:2 /W:5 /NP /LOG:$expLog | Out-Null
  }
  $rc = $LASTEXITCODE
  if (-not (Test-RobocopyOk $rc)) {
    Write-Log ('ERROR robocopy expenses exit {0}; see log {1}' -f $rc, $expLog)
    $ok = $false
  }
  else {
    Write-Log ('Expenses uploads: robocopy exit {0}; see log {1}' -f $rc, $expLog)
  }
}
else {
  Write-Log "Skip expenses (missing): $expSrc"
}

if (Test-Path -LiteralPath $legacyInv) {
  if (-not $invoiceListOk) {
    Write-Log "WARN skipped legacy uploads\invoices (same DB list failure as Invoices\)"
  }
  elseif ($archiveEntries.Count -eq 0) {
    Write-Log "Legacy uploads\invoices: no archived rows — nothing to $verbMoveCopy"
  }
  else {
    New-Item -ItemType Directory -Path $destLegacyInv -Force | Out-Null
    $legCount = 0
    foreach ($e in $archiveEntries) {
      $id = [string]$e.id
      if (-not $id) { continue }
      $name = "$id.pdf"
      $srcLeg = Join-Path $legacyInv $name
      if (Test-Path -LiteralPath $srcLeg) {
        if ($Move) {
          Move-Item -LiteralPath $srcLeg -Destination (Join-Path $destLegacyInv $name) -Force
        }
        else {
          Copy-Item -LiteralPath $srcLeg -Destination (Join-Path $destLegacyInv $name) -Force
        }
        $legCount++
      }
    }
    Write-Log ('Legacy uploads\invoices: {0} {1} files{2}{3}' -f $verbMoveCopy, $legCount, $movedNote, $skippedPendingNote)
  }
}

$includeDb = -not $NoDatabase
if ($includeDb -and (Test-Path -LiteralPath $dbSrc)) {
  Copy-DatabaseSnapshot -Src $dbSrc -DestDir $destDb | Out-Null
}
elseif ($includeDb) {
  Write-Log "WARN dev.db not found at $dbSrc"
}

if (-not $ok) {
  Write-Log "BACKUP FINISHED WITH ERRORS"
  exit 1
}

Write-Log "BACKUP OK"
if ($Move) {
  Write-Log "Move mode: PDFs/receipts removed from project copy locations. Restore from $dest to reopen files in the app."
}

if (-not $SkipDedupe) {
  $dedupeScript = Join-Path $PSScriptRoot "dedupe-backups.ps1"
  if (-not (Test-Path -LiteralPath $dedupeScript)) {
    $dedupeScript = Join-Path $BackupRoot "dedupe-backups.ps1"
  }
  if (Test-Path -LiteralPath $dedupeScript) {
    Write-Log "Running dedupe-backups.ps1..."
    try {
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $dedupeScript -BackupRoot $BackupRoot -Quiet
      Write-Log ('Dedupe finished; see dedupe-log.txt under {0}' -f $BackupRoot)
    }
    catch {
      Write-Log "WARN dedupe skipped or failed: $_"
    }
  }
}

exit 0
