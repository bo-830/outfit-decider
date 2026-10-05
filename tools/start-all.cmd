@echo off
REM ============================================================
REM  Start BOTH services for outfit-decider:
REM    1) laya-service\start-laya.cmd   -> http://0.0.0.0:8000  (decision model)
REM    2) tools\start-laya-adapter.cmd -> http://0.0.0.0:8787  (App protocol adapter)
REM  ASCII-only comments: cmd renders UTF-8 as garbage.
REM  Close this window to stop the adapter; stop laya-serve separately.
REM ============================================================
setlocal
cd /d "%~dp0"

echo [1/2] starting laya-serve in a new window (loads in ~30-60s) ...
start "laya-serve :8000" cmd /k "C:\博830\vibecoding\laya-service\start-laya.cmd"

echo [2/2] waiting 20s before starting the adapter ...
timeout /t 20 /nobreak >nul

echo starting adapter on 0.0.0.0:8787 -> 127.0.0.1:8000 ...
echo (App settings page: engine mode "Laya local", baseUrl http://127.0.0.1:8787)
node tools\laya-adapter.mjs
