# Runs prisma migrate deploy; on P3009 (failed migration) resets public schema on LOCAL Postgres only, then redeploys.
param()

$ErrorActionPreference = "Continue"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$apiDir = Join-Path $RepoRoot "apps\api"
$envPath = Join-Path $apiDir ".env"

function Get-DatabaseUrlFromDotEnv {
  if (-not (Test-Path -LiteralPath $envPath)) {
    return ""
  }
  foreach ($line in Get-Content -LiteralPath $envPath) {
    if ($line -match "^\s*DATABASE_URL\s*=") {
      $v = $line.Substring($line.IndexOf("=") + 1).Trim()
      return $v.Trim([char]0x22).Trim([char]0x27)
    }
  }
  return ""
}

function Test-LocalPostgresUrl([string] $Url) {
  if ([string]::IsNullOrWhiteSpace($Url)) {
    return $false
  }
  return $Url -match "(?i)^(postgresql|postgres)://[^@]+@(localhost|127\.0\.0\.1)(:\d+)?/"
}

function Invoke-PrismaInApiDir {
  param([string] $PrismaArgs)
  $apiPath = (Resolve-Path -LiteralPath $apiDir).Path
  $inner = "cd /d `"$apiPath`" && npx prisma $PrismaArgs 2>&1"
  $combined = cmd.exe /c $inner
  $code = $LASTEXITCODE
  $text = if ($null -eq $combined) {
    ""
  }
  elseif ($combined -is [array]) {
    $combined -join [Environment]::NewLine
  }
  else {
    [string]$combined
  }
  return @{ Code = $code; Text = $text }
}

$dbUrl = Get-DatabaseUrlFromDotEnv

$r = Invoke-PrismaInApiDir -PrismaArgs "migrate deploy"
if ($r.Text) {
  Write-Host $r.Text
}

if ($r.Code -eq 0) {
  exit 0
}

if ($r.Text -notmatch "P3009") {
  exit $r.Code
}

# Embedded SQLite: delete the .db file and re-run migrations.
if ($dbUrl -match "(?i)^file:") {
  $rel = $dbUrl -replace "(?i)^file:", "" -replace "^\./", ""
  $dbPath = if ([System.IO.Path]::IsPathRooted($rel)) { $rel } else { Join-Path $apiDir $rel }
  Write-Host ""
  Write-Host "[start] P3009 on SQLite — removing $dbPath and re-applying migrations."
  if (Test-Path -LiteralPath $dbPath) {
    Remove-Item -LiteralPath $dbPath -Force -ErrorAction SilentlyContinue
  }
  $r2 = Invoke-PrismaInApiDir -PrismaArgs "migrate deploy"
  if ($r2.Text) {
    Write-Host $r2.Text
  }
  exit $r2.Code
}

if (-not (Test-LocalPostgresUrl $dbUrl)) {
  Write-Host ""
  Write-Host "P3009: failed migration in the database. Auto-reset only runs for localhost Postgres or SQLite file URLs."
  Write-Host "Fix: prisma migrate resolve (see deploy/DEPLOYMENT.md) or reset DB on your host."
  exit $r.Code
}

Write-Host ""
Write-Host "[start] P3009 on local Postgres - resetting schema public and re-applying migrations (local data cleared)."

$resetSql = @'
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO postgres;
GRANT ALL ON SCHEMA public TO public;
'@

$resetSqlPath = Join-Path $apiDir "_StartResetPublic.sql"
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($resetSqlPath, $resetSql, $utf8NoBom)

try {
  $ex = Invoke-PrismaInApiDir -PrismaArgs 'db execute --file _StartResetPublic.sql --schema prisma/schema.prisma'
  if ($ex.Text) {
    Write-Host $ex.Text
  }
  if ($ex.Code -ne 0) {
    exit $ex.Code
  }
}
finally {
  Remove-Item -LiteralPath $resetSqlPath -Force -ErrorAction SilentlyContinue
}

$r2 = Invoke-PrismaInApiDir -PrismaArgs "migrate deploy"
if ($r2.Text) {
  Write-Host $r2.Text
}
exit $r2.Code
