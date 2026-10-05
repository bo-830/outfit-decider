@echo off
REM ============================================================
REM  Start the App<->Laya protocol adapter.
REM  App (SPEC 1.3 shape, port 8787) -> laya-serve (port 8000).
REM  Start laya-service\start-laya.cmd FIRST, then this.
REM  ASCII-only comments: cmd renders UTF-8 as garbage.
REM ============================================================
setlocal
cd /d "%~dp0.."

set LAYA_UPSTREAM=http://127.0.0.1:8000
set LAYA_ADAPTER_PORT=8787

REM Optional image-to-text: uncomment and fill in to enable describe_* calls.
REM set VISION_BASE_URL=https://api.deepseek.com/v1
REM set VISION_API_KEY=
REM set VISION_MODEL=

echo [adapter] upstream=%LAYA_UPSTREAM% port=%LAYA_ADAPTER_PORT%
node tools\laya-adapter.mjs --upstream %LAYA_UPSTREAM% --port %LAYA_ADAPTER_PORT%
