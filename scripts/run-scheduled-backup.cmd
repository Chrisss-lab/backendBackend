@echo off
rem Task Scheduler: full shell backup (run_*), site snapshot, dedupe, prune old invoice PDFs in backups.
cd /d "%~dp0.."
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0backup-site-and-cleanup.ps1" -BackendRoot "%CD%"
