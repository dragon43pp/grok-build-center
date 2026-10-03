@echo off
chcp 65001 >nul
setlocal

rem ============================================================
rem  AI session hub -- install
rem
rem  Three steps: build venv -> install deps -> run setup wizard.
rem  Safe to re-run; an existing venv is reused.
rem
rem  ASCII-only on purpose (see tools/banner.py): Chinese echo lines
rem  come out as mojibake on a CP936 box no matter how this file is
rem  encoded -- UTF-8 gets parsed as GBK, GBK breaks under chcp 65001.
rem ============================================================

set "HERE=%~dp0"
cd /d "%HERE%"
set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1

echo.
echo ==================================================================
echo   AI session hub  --  install
echo ==================================================================
echo.

rem ---------- 1. find Python ----------
set "PY="
where py >nul 2>&1 && set "PY=py -3"
if not defined PY (
  where python >nul 2>&1 && set "PY=python"
)
if not defined PY (
  echo [x] Python not found. Install 3.10+ and come back:
  echo     https://www.python.org/downloads/
  pause
  exit /b 2
)
for /f "delims=" %%v in ('%PY% -c "import sys;print(sys.version.split()[0])"') do set "PYVER=%%v"
echo [1/4] Python %PYVER%

rem ---------- 2. build venv ----------
set "VENV=%HERE%.venv"
if exist "%VENV%\Scripts\python.exe" (
  echo [2/4] reusing existing venv
) else (
  echo [2/4] creating venv .venv ...
  %PY% -m venv "%VENV%"
  if errorlevel 1 (
    echo [x] failed to create venv
    pause
    exit /b 1
  )
)

set "VPY=%VENV%\Scripts\python.exe"

rem ---------- 3. install deps ----------
rem Try the bundled offline wheels FIRST (--no-index = no network at all),
rem so this works offline / behind a proxy that blocks pip / on an intranet
rem box. Fall back to the network if the wheels don't match this machine.
echo [3/4] installing dependencies ...

if exist "%HERE%tools\wheels\*.whl" (
  echo       using bundled offline wheels (no network) ...
  "%VPY%" -m pip install --no-index --find-links "%HERE%tools\wheels" -r requirements.txt --quiet
) else (
  "%VPY%" -m pip install -r requirements.txt --quiet
)

if errorlevel 1 (
  echo       wheels did not apply, trying the network ...
  "%VPY%" -m pip install -r requirements.txt --quiet
)

if errorlevel 1 (
  echo.
  echo [!] dependencies did not install. Likely causes:
  echo       1. no network, and the wheels don't match this Python version
  echo       2. a proxy blocks pip's outbound traffic (curl still works)
  echo.
  echo     Try the bundled offline downloader (it bypasses pip, uses curl):
  echo         "%VPY%" tools\offline_pip.py lark-oapi psutil
  echo.
  pause
  exit /b 1
)

rem ---------- 4. setup wizard ----------
echo [4/4] running the setup wizard ...
echo.
"%VPY%" tools\setup.py

if errorlevel 1 (
  echo.
  echo [!] wizard did not finish. Resume the step you need:
  echo         "%VPY%" tools\setup.py --check             verify config
  echo         "%VPY%" tools\setup.py --bitable-only      create the Base table
  echo         "%VPY%" tools\setup.py --receive-id-only   grab the open_id
  echo.
  pause
  exit /b 1
)

echo.
echo ==================================================================
echo   done. Start it from the Start Menu, or:
echo       run.cmd
echo ==================================================================
echo.
pause
endlocal
