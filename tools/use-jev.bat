@echo off
REM ================================================================
REM  Set the DECISION upstream to TypeSafe JEv (or back to local Laya)
REM  Usage:  use-jev.bat            -> switch to JEv
REM          use-jev.bat laya       -> switch back to local Laya
REM
REM  Why a script: the App should not need re-configuring when you swap the
REM  decision model. Everything protocol-related lives in the adapter, and the
REM  API key stays on this PC (.env.local), never on the phone.
REM
REM  What it does NOT do:
REM    * it will NOT invent or ask for an API key
REM    * it will NOT run a connectivity test (you asked for neither)
REM  It only writes the upstream settings and tells you what to put in the App.
REM
REM  ASCII-only on purpose: cmd renders UTF-8 comments as garbage.
REM ================================================================
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

set "ENVFILE=%~dp0..\.env.local"
if not exist "%ENVFILE%" (
  echo [FATAL] .env.local not found at %ENVFILE%
  pause
  exit /b 1
)

set "WANT=%~1"
if "%WANT%"=="" set "WANT=jev"
if /i not "%WANT%"=="jev" if /i not "%WANT%"=="laya" (
  echo [FATAL] unknown target "%WANT%" - use "jev" or "laya"
  pause
  exit /b 1
)

echo ================================================================
echo   decision upstream  -^>  %WANT%
echo ================================================================
echo   config file : %ENVFILE%
echo.

REM ---------- mark the requested mode ----------
if /i "%WANT%"=="jev" (
  set "JEV_PROTOCOL=jev"
  set "JEV_UPSTREAM=https://api.typesafe.ai"
  set "JEV_MODEL=jev-latest"
) else (
  set "JEV_PROTOCOL=laya"
  set "JEV_UPSTREAM=http://127.0.0.1:8000"
  set "JEV_MODEL=outfit-judge-v1"
)

REM ---------- rewrite only the three LAYA_* keys, keep everything else ----------
REM  Deliberately done with cmd line filtering, NOT PowerShell text round-tripping.
REM  A first attempt used Get-Content/Set-Content without -Encoding UTF8: it
REM  mangled the Chinese comments AND swallowed newlines (multi-line reads),
REM  which silently dropped VISION_BASE_URL. The file is UTF-8 with non-ASCII
REM  comments, so the safest editor is one that never decodes/re-encodes it.
REM  We also keep a .bak and verify the required keys survive.
copy /y "%ENVFILE%" "%ENVFILE%.bak" >nul 2>&1

REM  Drop existing lines for the three keys (findstr /v on a temp copy), then add.
findstr /v /b /i "LAYA_PROTOCOL=" "%ENVFILE%.bak" > "%ENVFILE%.tmp"
findstr /v /b /i "LAYA_UPSTREAM=" "%ENVFILE%.tmp" > "%ENVFILE%.tmp2"
findstr /v /b /i "LAYA_MODEL=" "%ENVFILE%.tmp2" > "%ENVFILE%.tmp"
move /y "%ENVFILE%.tmp" "%ENVFILE%" >nul
>> "%ENVFILE%" echo LAYA_PROTOCOL=%JEV_PROTOCOL%
>> "%ENVFILE%" echo LAYA_UPSTREAM=%JEV_UPSTREAM%
>> "%ENVFILE%" echo LAYA_MODEL=%JEV_MODEL%
del "%ENVFILE%.tmp" "%ENVFILE%.tmp2" >nul 2>&1

echo   wrote:
echo       LAYA_PROTOCOL=%JEV_PROTOCOL%
echo       LAYA_UPSTREAM=%JEV_UPSTREAM%
echo       LAYA_MODEL=%JEV_MODEL%
echo.

REM ---------- verify: every key the adapter needs must still be readable ----------
set "OK=1"
for %%K in (LAYA_PROTOCOL LAYA_UPSTREAM LAYA_MODEL) do (
  findstr /b /i "%%K=" "%ENVFILE%" >nul || set "OK=0"
)
findstr /b /i "VISION_BASE_URL=" "%ENVFILE%" >nul || set "OK=0"
if "%OK%"=="0" (
  echo   [FATAL] rewrite lost a required key - restoring the backup.
  echo          keys needed: LAYA_PROTOCOL LAYA_UPSTREAM LAYA_MODEL VISION_BASE_URL
  copy /y "%ENVFILE%.bak" "%ENVFILE%" >nul
  echo          restored from %ENVFILE%.bak
  pause
  exit /b 1
)
echo   verified: LAYA_* and VISION_BASE_URL are all present. backup = .env.local.bak
echo.

REM ---------- does it have a key? ----------
set "HASKEY=0"
for /f "usebackq tokens=1,* delims==" %%A in ("%ENVFILE%") do (
  if /i "%%A"=="LAYA_API_KEY" if not "%%B"=="" set "HASKEY=1"
)

if "%JEV_PROTOCOL%"=="jev" (
  if "%HASKEY%"=="1" (
    echo   LAYA_API_KEY is set - JEv will authenticate.
  ) else (
    echo   [NOTE] LAYA_API_KEY is NOT set.
    echo          JEv requires `Authorization: Bearer ^<key^>`, so upstream will
    echo          answer 401 and scoring will fail with an auth error.
    echo          That is expected, not a bug. To enable it, add one line to
    echo          .env.local and re-run this script:
    echo              LAYA_API_KEY=^<your TypeSafe key^>
    echo          Get a key at https://console.typesafe.ai/keys
  )
)

echo ================================================================
echo   App settings page - type these EXACTLY:
echo ================================================================
echo       decision baseUrl : http://^<PC LAN IP^>:8787
echo                          ^(emulator / adb reverse: http://127.0.0.1:8787^)
echo       askPath          : /ask
echo       healthPath       : /health
echo       model name       : %JEV_MODEL%
echo       API Key          : leave EMPTY
echo.
echo   The App NEVER talks to JEv directly - the adapter translates the request
echo   shape (App sends an array, JEv wants a map) and holds the key locally.
echo.
echo   Restart the adapter for this to take effect:
echo       stop-outfit-decider.bat   then   start-outfit-decider.bat
echo ================================================================
echo.
pause
endlocal
