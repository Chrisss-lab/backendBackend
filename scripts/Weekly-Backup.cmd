@echo off
rem Full backup: shell archive (DB+PDFs+expenses to run_*, live DB trimmed), slim site snapshot, dedupe, prune old PDFs, trim old runs
cd /d "%~dp0.."
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0backup-site-and-cleanup.ps1" -BackendRoot "%CD%"
if errorlevel 1 (
  echo Backup reported errors. See the latest site_clean_* and run_* under Desktop\Backend BackUps
  pause
  exit /b 1
)
echo Done. Desktop\Backend BackUps — run_* has full DB + PDFs + expenses; live project is a thin shell. site_clean_* is code snapshot without duplicate PDFs.
pause
