@echo off
setlocal EnableExtensions EnableDelayedExpansion

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

echo Installing dependencies...
call npm install || goto :install_fail

echo Clearing busy ports (3001, 4000)...
call :FreePort 3001
call :FreePort 4000

echo Preparing database...
rem prisma generate can fail on Windows when DLL is temporarily locked by another process; don't hard-fail.
call npm run prisma:generate -w apps/api
call npm run prisma:db:push -w apps/api -- --skip-generate || goto :db_fail
call npm run prisma:seed -w apps/api
call npm run prisma:import:recipes -w apps/api

echo Starting servers...
rem Use START /D so we avoid nested quotes (fixes "filename, directory name, or volume label syntax is incorrect")
start "Management Hub Servers" /D "%~dp0" cmd /k npm run start

echo Waiting for API (4000)...
call :WaitPort 4000 120
if errorlevel 1 goto :ports_fail

echo Waiting for Web (3001)...
call :WaitPort 3001 120
if errorlevel 1 goto :ports_fail

echo Opening site...
start "" "http://localhost:3001"
echo.
echo Web: http://localhost:3001
echo API: http://localhost:4000
echo.
echo Started successfully. Keep "Management Hub Servers" window open.
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
echo See messages above for details.
goto :done

:ports_fail
echo ERROR: Could not start both ports (4000, 3001).
echo Open "Management Hub Servers" window and check errors.
goto :done

:FreePort
set "TARGET_PORT=%~1"
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /R /C:":%TARGET_PORT% .*LISTENING"') do (
  taskkill /PID %%P /F >nul 2>&1
)
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
