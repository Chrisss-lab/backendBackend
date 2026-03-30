@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem Optional: set START_NO_FIX_DB_URL=1 to skip rewriting DATABASE_URL in apps\api\.env

cd /d "%~dp0"
title Management Hub Starter

echo ==========================================
echo   Management Control Hub - START
echo ==========================================
echo.

rem Ensure Node/npm paths
if exist "%ProgramFiles%\nodejs" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if exist "%ProgramFiles(x86)%\nodejs" set "PATH=%ProgramFiles(x86)%\nodejs;%PATH%"
if exist "%LocalAppData%\Programs\node" set "PATH=%LocalAppData%\Programs\node;%PATH%"

where node >nul 2>&1 || goto :no_node
where npm >nul 2>&1 || goto :no_npm

if not exist "apps\api\.env" (
  if exist "apps\api\.env.example" copy /Y "apps\api\.env.example" "apps\api\.env" >nul
)
if not exist "apps\web\.env.local" (
  if exist "apps\web\.env.local.example" copy /Y "apps\web\.env.local.example" "apps\web\.env.local" >nul
)

rem If strict no-local storage is enabled but R2 is not configured, relax for local Start.cmd runs.
echo Checking storage mode...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p='apps\api\.env'; if(-not (Test-Path $p)){ exit 0 }; $raw=Get-Content $p -Raw; $m=[regex]::Match($raw,'(?im)^\s*STRICT_NO_LOCAL_STORAGE\s*=\s*(.+)\s*$'); if(-not $m.Success){ exit 0 }; $strict=$m.Groups[1].Value.Trim().ToLower(); if($strict -notin @('1','true','yes','on')){ exit 0 }; function val([string]$k,[string]$txt){ $mm=[regex]::Match($txt,'(?im)^\s*'+[regex]::Escape($k)+'\s*=\s*(.*)\s*$'); if($mm.Success){ return $mm.Groups[1].Value.Trim() }; return '' }; $need=@('R2_ACCOUNT_ID','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','R2_BUCKET','STORAGE_PUBLIC_BASE_URL'); $ok=$true; foreach($k in $need){ if([string]::IsNullOrWhiteSpace((val $k $raw))){ $ok=$false; break } }; if(-not $ok){ $new=[regex]::Replace($raw,'(?im)^\s*STRICT_NO_LOCAL_STORAGE\s*=.*$','STRICT_NO_LOCAL_STORAGE=false'); Set-Content $p $new -NoNewline; Write-Host '[start] STRICT_NO_LOCAL_STORAGE=true but R2 is incomplete; set to false for local startup.' }"

rem Ensure DATABASE_URL (default: embedded SQLite file:./data/hub.db)
echo Checking API DATABASE_URL...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\ensure-postgres-database-url.ps1"
if errorlevel 1 (
  echo ERROR: ensure-postgres-database-url.ps1 failed.
  goto :done
)

echo Installing dependencies...
call npm install || goto :install_fail

echo Clearing busy port (4000 — API + web UI)...
call :FreePort 4000

rem Local Postgres (docker compose.yml in repo root). Ignored if Docker is not installed.
where docker >nul 2>&1
if not errorlevel 1 if exist "%~dp0docker-compose.yml" (
  echo Starting Postgres (docker compose^)...
  docker compose -f "%~dp0docker-compose.yml" up -d 2>nul
  if errorlevel 1 (
    echo NOTE: docker compose failed or Docker is not running. Ensure Postgres is up and DATABASE_URL in apps\api\.env is correct.
  )
)

echo Generating Prisma client...
call npm run prisma:generate -w apps/api

echo Applying database migrations ^(deploy + local P3009 recovery if needed^)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\prisma-migrate-deploy-with-p3009-recovery.ps1"
if errorlevel 1 goto :db_fail

echo Loading demo data when the database is empty ^(catalog, customer, order, expenses, owner login^)...
call npm run prisma:seed-if-empty -w apps/api || goto :db_fail

echo Building web ^(static export into apps\web\out^) for the single-port server...
call npm run build:web || goto :build_fail

echo Starting hub on port 4000 ^(Nest API + static web from apps\web\out^)...
start "JR Hub :4000" /D "%~dp0" cmd /k "npm run dev:api"

echo Waiting for port 4000 — Nest can take 30–60s on first compile...
call :WaitPort 4000 180
if errorlevel 1 goto :ports_fail

echo Opening site...
start "" "http://localhost:4000"
echo.
echo Hub: http://localhost:4000  ^(UI + API on the same port^)
echo.
echo Started successfully. Keep the "JR Hub" window open.
echo UI changes: run ^"npm run build:web^" then refresh the browser ^(or restart dev:api^).
echo Split dev ^(hot reload web on :3001^): use npm run dev:web with NEXT_PUBLIC_API_URL in apps\web\.env.local
echo If the hub window shows errors, fix them there ^(DATABASE_URL, Docker, etc.^).
echo Demo owner when no users: owner@local.test / demo-owner-12
goto :done

:no_node
echo ERROR: Node.js not found.
echo Install Node.js LTS and try again.
goto :done

:no_npm
echo ERROR: npm not found.
echo Reinstall Node.js LTS and try again.
goto :done

:install_fail
echo ERROR: npm install failed.
echo See messages above for details.
goto :done

:db_fail
echo ERROR: database setup failed.
echo - Start Docker Desktop, then:  docker compose up -d
echo - For P3009 on a remote DB, fix manually ^(deploy/DEPLOYMENT.md^).
goto :done

:build_fail
echo ERROR: npm run build:web failed. Fix errors above.
goto :done

:ports_fail
echo ERROR: Port 4000 did not open in time.
echo Check the "JR Hub :4000" window for red errors.
goto :done

:FreePort
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\free-port.ps1" -Port %~1 >nul 2>&1
exit /b 0

:WaitPort
set "P=%~1"
set "S=%~2"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\wait-for-port.ps1" -Port %P% -TimeoutSeconds %S% >nul
exit /b %ERRORLEVEL%

:done
echo.
pause
exit /b 0
