<#
  Creates a Windows Scheduled Task to run backup-media-weekly.ps1 on the 1st of each month at 3:00 AM.
  Each run creates a new run_YYYY-MM-DD_... folder under Desktop\Backend BackUps (one log per month).
  Default script behavior: backup then MOVE files off the live site (frees space).

  Uses schtasks.exe so it works on Windows PowerShell 5.1 (no -Monthly on New-ScheduledTaskTrigger there).
#>
$ErrorActionPreference = "Stop"

$scriptDir = $PSScriptRoot
$ps1 = Join-Path $scriptDir "backup-media-weekly.ps1"
if (-not (Test-Path -LiteralPath $ps1)) {
  throw "Missing $ps1"
}

$newTaskName = "ManagementHub-MonthlyMediaBackup"
$legacyWeeklyName = "ManagementHub-WeeklyMediaBackup"
$backendRoot = Split-Path -Parent $scriptDir

# Single .cmd path avoids schtasks mangling PowerShell arguments
$launcher = Join-Path $scriptDir "run-scheduled-backup.cmd"
if (-not (Test-Path -LiteralPath $launcher)) {
  throw "Missing $launcher"
}

# Remove old tasks (ignore errors if task does not exist)
$prevEa = $ErrorActionPreference
$ErrorActionPreference = "SilentlyContinue"
foreach ($tn in @($legacyWeeklyName, $newTaskName)) {
  & schtasks.exe /Delete /TN $tn /F 2>&1 | Out-Null
}
$ErrorActionPreference = $prevEa

# Also remove via cmdlet if registered that way
Unregister-ScheduledTask -TaskName $legacyWeeklyName -Confirm:$false -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $newTaskName -Confirm:$false -ErrorAction SilentlyContinue

# /SC MONTHLY /D 1 = first day of every month; /ST 03:00 = 3:00 AM local
$p = Start-Process -FilePath "schtasks.exe" -ArgumentList @(
  "/Create",
  "/TN", $newTaskName,
  "/TR", $launcher,
  "/SC", "MONTHLY",
  "/D", "1",
  "/ST", "03:00",
  "/F"
) -Wait -PassThru -NoNewWindow

if ($p.ExitCode -ne 0) {
  throw "schtasks /Create failed with exit code $($p.ExitCode)"
}

Write-Host "Registered task: $newTaskName"
Write-Host "  When: 1st day of each month at 3:00 AM (local time)"
Write-Host "  Launcher: $launcher"
Write-Host "  Script: $ps1 (default: backup then remove from live site)"
Write-Host "  Backup folder: $env:USERPROFILE\Desktop\Backend BackUps"
Write-Host "  (Removed legacy task if present: $legacyWeeklyName)"
Write-Host ""
Write-Host "To keep files on the live PC (copy only), edit task Action and add:  -CopyOnly"
Write-Host "To remove: schtasks /Delete /TN $newTaskName /F"
Write-Host "  or Task Scheduler -> Task Scheduler Library -> $newTaskName -> Delete"
