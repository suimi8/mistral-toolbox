@echo off
rem Mistral GUI launcher (ASCII only - Chinese text breaks cmd.exe parsing)
rem If startup fails (usually port in use) you get a menu:
rem   [1] kill the process on the port and restart   [2] exit   [3] open the running instance
chcp 65001 >nul <nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found in PATH. Install Node 22+ first.
  pause
  exit /b 1
)
set "PORT=8890"
if /i "%~1"=="--port" if not "%~2"=="" set "PORT=%~2"

node "%~dp0gui.mjs" --port %PORT% %*
set "RC=%ERRORLEVEL%"
if "%RC%"=="0" exit /b 0

rem ---- startup failed (usually EADDRINUSE) ----
echo.
echo [GUI] startup failed (code %RC%). Port %PORT% may be occupied by another process.
echo   [1] Kill the process on port %PORT% and restart GUI
echo   [2] Exit
echo   [3] Open the already-running service at http://127.0.0.1:%PORT%
choice /c 123 /n /m "Select: "
if errorlevel 3 goto open_running
if errorlevel 2 exit /b %RC%
if errorlevel 1 goto kill_restart
exit /b %RC%

:kill_restart
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":%PORT% " ^| findstr LISTENING') do (
  echo [GUI] killing PID %%P listening on %PORT%
  taskkill /PID %%P /T /F >nul 2>nul
)
timeout /t 1 /nobreak >nul
node "%~dp0gui.mjs" --port %PORT% %*
exit /b %ERRORLEVEL%

:open_running
start "" "http://127.0.0.1:%PORT%"
exit /b 0
