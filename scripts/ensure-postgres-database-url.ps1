# Ensures apps/api/.env has a usable DATABASE_URL for Prisma.
# Default is embedded SQLite (file:./data/hub.db) — no Docker Postgres required.
# Skips when START_NO_FIX_DB_URL=1 or when DATABASE_URL is already set to postgres or file:.

param()

if ($env:START_NO_FIX_DB_URL -eq "1") {
  exit 0
}

$RepoRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $RepoRoot "apps\api\.env"
$defaultSqlite = "file:./data/hub.db"
$defaultLine = "DATABASE_URL=`"$defaultSqlite`""

function Test-ValidDatabaseUrl([string] $Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) {
    return $false
  }
  $t = $Value.Trim().Trim([char]0x22).Trim([char]0x27)
  if ($t -match "^(postgresql|postgres)://") { return $true }
  if ($t -match "^file:") { return $true }
  return $false
}

if (-not (Test-Path -LiteralPath $envFile)) {
  $utf8NoBom = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllLines($envFile, @($defaultLine), $utf8NoBom)
  Write-Host "[start] Created apps\api\.env with default DATABASE_URL (embedded SQLite)."
  exit 0
}

$lines = @(Get-Content -LiteralPath $envFile -ErrorAction SilentlyContinue)
$newLines = New-Object System.Collections.Generic.List[string]
$found = $false
$changed = $false

foreach ($line in $lines) {
  if ($line -match "^\s*DATABASE_URL\s*=") {
    $found = $true
    $rawVal = $line -replace "^\s*DATABASE_URL\s*=\s*", ""
    $val = $rawVal.Trim().Trim([char]0x22).Trim([char]0x27)
    if (Test-ValidDatabaseUrl $val) {
      [void]$newLines.Add($line)
    }
    else {
      [void]$newLines.Add($defaultLine)
      $changed = $true
      Write-Host "[start] Set DATABASE_URL to embedded SQLite (was empty or invalid)."
    }
  }
  else {
    [void]$newLines.Add($line)
  }
}

if (-not $found) {
  [void]$newLines.Add($defaultLine)
  $changed = $true
  Write-Host "[start] Added DATABASE_URL for embedded SQLite."
}

if ($changed) {
  $utf8NoBom = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllLines($envFile, $newLines.ToArray(), $utf8NoBom)
}

exit 0
