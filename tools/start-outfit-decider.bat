@echo off
setlocal EnableExtensions EnableDelayedExpansion
title Lay a + Adapter one-click start

REM ================================================================
REM  One-click start for outfit-decider
REM  ASCII-only on purpose: cmd renders UTF-8 comments as garbage.
REM
REM  What it does:
REM    1) opens firewall for 8000 / 8787 / 8081 (needs admin; elevates itself)
REM       - 8081 is Metro: Expo Go on the phone needs it too, otherwise the
REM         app shell loads but the JS bundle can never be fetched.
REM    2) starts laya-serve   (0.0.0.0:8000)  decision model
REM    3) waits for it to become ready (first load 30-60s)
REM    4) starts laya-adapter (0.0.0.0:8787)  protocol translation + vision
REM    4b) starts Expo/Metro  (0.0.0.0:8081)  what the phone scans
REM    5) detects the CURRENT LAN IP and prints exactly what to type
REM       into the phone, Expo Go, and the App settings page
REM    6) opens the health URL in the local browser for a sanity check
REM
REM  Why step 5 matters: the LAN IP is DHCP-assigned and DOES change.
REM  Already seen: 192.168.1.4 -> 192.168.73.231 -> 10.63.1.253
REM  (the last one is a different subnet entirely). A hardcoded IP in the
REM  phone will silently start failing. Always read it here.
REM
REM  Android emulator: it cannot use the LAN IP; use 10.0.2.2 (printed below).
REM  Native Android build (expo run:android) is NOT used: Gradle rejects this
REM  project because the path contains non-ASCII characters. Expo Go is fine,
REM  every native module this app needs ships with Expo Go.
REM ================================================================

REM  Lives in <project>\tools\ so it is version-controlled with the code.
REM  Layout it expects:
REM      <parent>\laya-service\start-laya.cmd     (decision model; sibling of the project)
REM      <parent>\outfit-decider\                 (this project)
REM  For the emulator step you also need the Expo Go APK for THIS project's SDK.
REM  It is searched for in a few places (see EXPO_GO_APK below) and is NOT
REM  committed: 200MB binaries do not belong in the repo.
REM ================================================================

set "TOOLS=%~dp0"
if "%TOOLS:~-1%"=="\" set "TOOLS=%TOOLS:~0,-1%"
for %%I in ("%TOOLS%\..") do set "PROJECT=%%~fI"
for %%I in ("%PROJECT%\..") do set "PARENT=%%~fI"
REM laya-service stays where it is (its own launcher uses paths relative to
REM itself, so moving or copying it would break the venv lookup).
set "LAYA_DIR=%PARENT%\laya-service"
set "ADAPTER_PORT=8787"
set "LAYA_PORT=8000"
REM Metro / Expo dev server. Expo Go on the phone also needs this port open,
REM otherwise the app itself loads but the JS bundle cannot be fetched.
set "EXPO_PORT=8081"
REM Android toolchain (used only for the emulator step / printed hints).
set "AVD=Pixel_7_API_37"
set "EMU=C:\Android\emulator\emulator.exe"
set "ADB=C:\Android\platform-tools\adb.exe"
REM This project is Expo SDK 57, so Expo Go must be 57.x too.
REM An AVD with Expo Go 58 shows "Project is incompatible with this version".
set "EXPO_GO_SDK=57.0.9"
set "EXPO_GO_APK=%PROJECT%\Expo-Go-57.0.9.apk"
if not exist "%EXPO_GO_APK%" set "EXPO_GO_APK=%PARENT%\Expo-Go-57.0.9.apk"

echo ================================================================
echo   outfit-decider : one-click start
echo ================================================================
echo   project : %PROJECT%
echo.

if not exist "%LAYA_DIR%\start-laya.cmd" (
  echo [FATAL] not found: %LAYA_DIR%\start-laya.cmd
  echo         expected it next to the project folder, i.e.
  echo             %PARENT%\laya-service\start-laya.cmd
  echo         Override by editing LAYA_DIR at the top of this script.
  pause
  exit /b 1
)
if not exist "%PROJECT%\tools\laya-adapter.mjs" (
  echo [FATAL] not found: %PROJECT%\tools\laya-adapter.mjs
  pause
  exit /b 1
)

REM ---------- step 0: admin check (firewall rules need it) ----------
net session >nul 2>&1
if errorlevel 1 (
  echo [0/6] administrator rights are required for the firewall rule.
  echo.
  echo   Two options:
  echo     A^) right-click this .bat  ^-^>  "Run as administrator"   ^(recommended^)
  echo     B^) approve the UAC prompt that will now appear
  echo.
  powershell -NoProfile -Command ^
    "Start-Process -FilePath $env:ComSpec -Verb RunAs -ArgumentList '/k',('cd /d ' + [char]34 + '%~dp0' + [char]34 + ' && ' + [char]34 + '%~f0' + [char]34)"
  echo   If nothing appeared, close this window and use option A.
  pause
  exit /b 0
)
echo [0/6] running with administrator rights - good.

REM ---------- step 1: firewall ----------
echo [1/6] opening firewall for TCP %LAYA_PORT%, %ADAPTER_PORT%, %EXPO_PORT% ...
for %%P in (%LAYA_PORT% %ADAPTER_PORT% %EXPO_PORT%) do (
  netsh advfirewall firewall show rule name="outfit-decider %%P" >nul 2>&1
  if errorlevel 1 (
    netsh advfirewall firewall add rule name="outfit-decider %%P" dir=in action=allow protocol=TCP localport=%%P >nul
    if errorlevel 1 (echo       [WARN] could not add rule for %%P) else (echo       added rule for %%P)
  ) else (
    echo       rule for %%P already present
  )
)

REM ---------- step 2: start laya-serve ----------
echo [2/6] starting laya-serve on 0.0.0.0:%LAYA_PORT% (new window) ...
powershell -NoProfile -Command ^
  "if (Get-NetTCPConnection -LocalPort %LAYA_PORT% -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>&1
if errorlevel 1 (
  start "laya-serve :%LAYA_PORT%" cmd /k "\"%LAYA_DIR%\start-laya.cmd\""
) else (
  echo       port %LAYA_PORT% already in use - assuming laya-serve is running
)

REM ---------- step 3: wait for ready ----------
echo [3/6] waiting for laya-serve to become ready (first load 30-60s) ...
set "READY=0"
for /l %%I in (1,1,60) do (
  if "!READY!"=="0" (
    powershell -NoProfile -Command ^
      "try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 'http://127.0.0.1:%LAYA_PORT%/health'; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
    if not errorlevel 1 (
      set "READY=1"
    ) else (
      <nul set /p "=."
      ping -n 2 127.0.0.1 >nul
    )
  )
)
echo.
if "!READY!"=="0" (
  echo       [WARN] laya-serve did not answer /health within ~2 min.
  echo              check the "laya-serve" window for errors; log:
  echo              %LAYA_DIR%\laya-serve.log
) else (
  echo       laya-serve is up.
)

REM ---------- step 4: start adapter ----------
echo [4/6] starting laya-adapter on 0.0.0.0:%ADAPTER_PORT% (new window) ...
powershell -NoProfile -Command ^
  "if (Get-NetTCPConnection -LocalPort %ADAPTER_PORT% -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>&1
if errorlevel 1 (
  start "laya-adapter :%ADAPTER_PORT%" cmd /k "cd /d \"%PROJECT%\" && node tools\laya-adapter.mjs"
) else (
  echo       port %ADAPTER_PORT% already in use - assuming adapter is running
)
ping -n 4 127.0.0.1 >nul

REM ---------- step 4b: start Expo / Metro ----------
echo [4b/6] starting Expo (Metro) on :%EXPO_PORT% (new window) ...
powershell -NoProfile -Command ^
  "if (Get-NetTCPConnection -LocalPort %EXPO_PORT% -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>&1
if errorlevel 1 (
  start "expo :%EXPO_PORT%" cmd /k "cd /d \"%PROJECT%\" && npx expo start --lan"
) else (
  echo       port %EXPO_PORT% already in use - assuming Expo is running
)
ping -n 6 127.0.0.1 >nul

REM ---------- step 5: detect LAN IP ----------
echo [5/6] detecting the current LAN IP ...
set "LANIP="
REM  Getting an IPv4 address without a pipe is fiddly in cmd: a caret-escaped
REM  pipe (^|) inside a for /f command is NOT reliable once the whole thing is
REM  re-parsed (measured: PowerShell received a literal '^|' and errored).
REM  So use PowerShell cmdlets that FILTER instead of piping, and write the
REM  result to a file that cmd can then read.
powershell -NoProfile -Command "$c = Get-NetIPAddress -AddressFamily IPv4 -EA SilentlyContinue;" ^
 "$c = $c | Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' };" ^
 "$c = $c | Sort-Object SkipAsSource, InterfaceMetric;" ^
 "if ($c) { $c[0].IPAddress } else { '' }" > "%TEMP%\od-lanip.txt" 2>nul
for /f "delims=" %%A in ('findstr /r /c:"[0-9]" "%TEMP%\od-lanip.txt"') do set "LANIP=%%A"
set "LANIP=%LANIP: =%"

if "%LANIP%"=="" (
  echo       [WARN] could not detect a LAN IPv4 - phone access may not work.
  echo              ^(emulator users do not need a LAN IP; adb reverse is used^)
  set "LANIP=127.0.0.1"
) else (
  echo       LAN IP = %LANIP%
)

REM ---------- step 6: report + self test ----------
echo [6/6] self test ...
powershell -NoProfile -Command ^
  "try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 'http://%LANIP%:%ADAPTER_PORT%/health'; Write-Host ('      adapter on LAN: HTTP ' + $r.StatusCode + ' OK') } catch { Write-Host '      [WARN] adapter not reachable on the LAN IP yet' }"

REM ---------- step 7: optional Android emulator ----------
REM  Set OD_EMULATOR=1 (or pass "emulator" as the first argument) to also bring
REM  up the AVD, make sure Expo Go matches this project's SDK, wire adb reverse,
REM  and launch the app. Everything below was learned the hard way:
REM    * Expo Go in the AVD was SDK 58 while this project is SDK 57 -> the app
REM      refused to load with "Project is incompatible with this version".
REM      So we uninstall/reinstall the known-good SDK 57 APK when it mismatches.
REM    * The emulator cannot use the LAN IP and its own 127.0.0.1 is itself.
REM      adb reverse maps the emulator's localhost to this PC, which means the
REM      App's DEFAULT baseUrl (127.0.0.1:8787) just works with no edits.
set "WANT_EMU=%OD_EMULATOR%"
if /i "%~1"=="emulator" set "WANT_EMU=1"
if not "%WANT_EMU%"=="1" goto :no_emulator

echo.
echo [7] Android emulator setup ...
if not exist "%ADB%" (
  echo       [WARN] adb not found at %ADB% - skipping emulator setup.
  goto :no_emulator
)

REM 7a. boot the AVD if nothing is attached
"%ADB%" devices | findstr /r /c:"emulator-" >nul 2>&1
if errorlevel 1 (
  if not exist "%EMU%" (
    echo       [WARN] emulator.exe not found at %EMU% - skipping.
    goto :no_emulator
  )
  echo       booting AVD %AVD% ...
  start "android emulator" "%EMU%" -avd %AVD%
  echo       waiting for the device to boot ^(up to ~5 min^) ...
  "%ADB%" wait-for-device
  call :wait_boot 100
  if errorlevel 1 (
    echo.
    echo       [WARN] device did not report boot_completed. Continuing anyway;
    echo              Expo Go launch may fail until the AVD finishes booting.
  ) else (
    echo       device booted.
  )
) else (
  echo       an emulator is already attached.
)
goto :emu_expo_go

REM Wait for sys.boot_completed==1. %1 = max attempts (3s each). Returns 0 on success.
REM  Pipe inside for /f silently yields nothing in cmd, so dump to a file first.
:wait_boot
set /a OD_TRIES=0
:wait_boot_loop
set "OD_BOOT="
"%ADB%" shell getprop sys.boot_completed > "%TEMP%\od-boot.txt" 2>nul
for /f "delims=" %%B in ('findstr /r /c:"^1$" "%TEMP%\od-boot.txt"') do set "OD_BOOT=%%B"
set "OD_BOOT=%OD_BOOT: =%"
if "%OD_BOOT%"=="1" exit /b 0
set /a OD_TRIES+=1
if %OD_TRIES% geq %1 exit /b 1
<nul set /p "=."
ping -n 3 127.0.0.1 >nul
goto :wait_boot_loop

:emu_expo_go

REM 7b. Expo Go must match this project's SDK (57), not whatever is installed.
REM  NOTE: do NOT put a pipe inside for /f's command -- it silently returns
REM  nothing in cmd. Dump to a temp file first, then parse (measured).
set "OD_TMP=%TEMP%\od-emu.txt"
"%ADB%" shell dumpsys package host.exp.exponent > "%OD_TMP%" 2>nul
set "EXPO_GO_VER="
for /f "tokens=2 delims==" %%V in ('findstr /i "versionName" "%OD_TMP%"') do set "EXPO_GO_VER=%%V"
set "EXPO_GO_VER=%EXPO_GO_VER: =%"
if not "%EXPO_GO_VER%"=="%EXPO_GO_SDK%" (
  echo       Expo Go is "%EXPO_GO_VER%" but this project needs SDK %EXPO_GO_SDK% - reinstalling ...
  if not exist "%EXPO_GO_APK%" (
    echo       [WARN] %EXPO_GO_APK% not found.
    echo              download Expo Go for SDK %EXPO_GO_SDK% and put it at that path, or
    echo              upgrade the project to SDK 58. App launch will likely fail.
  ) else (
    "%ADB%" uninstall host.exp.exponent >nul 2>&1
    "%ADB%" install -r "%EXPO_GO_APK%"
  )
) else (
  echo       Expo Go %EXPO_GO_VER% matches SDK %EXPO_GO_SDK% - ok.
)

REM 7c. adb reverse: emulator-localhost -> this PC. This is what makes the
REM     App's default baseUrl (127.0.0.1:8787) work without any manual edit.
for %%P in (%EXPO_PORT% %ADAPTER_PORT% %LAYA_PORT%) do "%ADB%" reverse tcp:%%P tcp:%%P >nul 2>&1
echo       adb reverse:
"%ADB%" reverse --list | findstr /r /c:"tcp:" 

REM 7d. launch the project inside Expo Go
echo       launching exp://127.0.0.1:%EXPO_PORT% ...
"%ADB%" shell am force-stop host.exp.exponent >nul 2>&1
ping -n 2 127.0.0.1 >nul
"%ADB%" shell am start -a android.intent.action.VIEW -d "exp://127.0.0.1:%EXPO_PORT%" host.exp.exponent >nul 2>&1
echo       done. In the App settings page you can leave baseUrl as the default
echo       http://127.0.0.1:%ADAPTER_PORT% - adb reverse handles the rest.
echo       ^(first bundle takes ~30-60s; steer clear of Ctrl+M dev menu^)

:no_emulator

echo.
echo ================================================================
echo   READY  -  use the EXACT address below
echo ================================================================
echo.
echo   Phone browser test:
echo       http://%LANIP%:%ADAPTER_PORT%/health
echo.
echo   Expo Go (phone app): scan the QR in the "expo" window, or open
echo       exp://%LANIP%:%EXPO_PORT%
echo.
echo   App settings page:
echo       engine mode     : Laya + multimodal review
echo       decision baseUrl: http://%LANIP%:%ADAPTER_PORT%
echo       askPath         : /ask
echo       healthPath      : /health
echo       vision model    : leave EMPTY, and tick
echo                         "configured on the server" checkbox
echo.
echo   NOTE: 127.0.0.1 on the phone means the PHONE itself.
echo         Always use %LANIP% there.
echo.
echo   ---- ANDROID EMULATOR: use a DIFFERENT host ----
echo   Inside the emulator, 127.0.0.1 is the EMULATOR itself, and the LAN
echo   IP above is often not routable. The emulator reaches this PC via
echo   the special alias 10.0.2.2, so use:
echo.
echo       http://10.0.2.2:%ADAPTER_PORT%
echo.
echo   cleartext HTTP is already allowed (app.json usesCleartextTraffic).
echo   Start the emulator with:
echo       "%EMU%" -avd %AVD%
echo.
echo   CHECKLIST if the phone still cannot open it:
echo     1) Phone Wi-Fi must be on the SAME network as this PC.
echo        Phone on mobile data / another SSID / a guest network
echo        cannot reach %LANIP% no matter what the firewall says.
echo        Quick test: open http://%LANIP%:%ADAPTER_PORT%/health on
echo        ANOTHER computer in the same Wi-Fi.
echo     2) Windows may classify this Wi-Fi as "Public". The rule we
echo        added covers all profiles, so this normally is fine.
echo     3) If the router has AP isolation / client isolation enabled,
echo        devices cannot talk to each other - turn it off.
echo.
echo   NOTE: the LAN IP is DHCP-assigned and CHANGES over time.
echo         If the phone stops connecting, re-run this .bat and
echo         use the new address printed above.
echo ================================================================

REM Report connected Android devices so you know which host to use.
if exist "%ADB%" (
  echo.
  echo   Android devices currently attached:
  for /f "usebackq skip=1 tokens=1,2" %%D in (`"%ADB%" devices`) do (
    if not "%%D"=="" echo       %%D  %%E
  )
  echo   ^(emulator-5554 =^> use 10.0.2.2 ; a real phone =^> use %LANIP%^)
)
echo.

start "" "http://%LANIP%:%ADAPTER_PORT%/health"

echo This window can stay open, or close it - the two services
echo run in their own windows. To stop them, close those windows
echo or run:  taskkill /F /IM laya-serve.exe  and  taskkill /F /IM node.exe
echo.
pause
endlocal
