@echo off
REM ================================================================
REM  Stop outfit-decider  -  just double-click this file
REM
REM  Thin wrapper around:  start-outfit-decider.bat stop
REM  It shuts down the services by PID (.run\*.pid) and then by port,
REM  so it will NOT kill unrelated Node processes you may be running.
REM
REM  ASCII-only on purpose: cmd renders UTF-8 comments as garbage.
REM ================================================================
setlocal
cd /d "%~dp0"

echo ================================================================
echo   outfit-decider : stopping services
echo ================================================================
echo.

if not exist "start-outfit-decider.bat" (
  echo [FATAL] start-outfit-decider.bat not found next to this file.
  echo         keep the two files in the same folder.
  pause
  exit /b 1
)

REM  Passing "stop" makes the main script run its stop path, which ends in its
REM  own pause, so the user can read the result. No extra pause needed here.
call "start-outfit-decider.bat" stop
exit /b %errorlevel%
