@echo off
chcp 65001 >nul
setlocal

rem ============================================================
rem  AI session hub -- launch
rem
rem  No args  : run for real (needs config.json)
rem  With args: pass through to hub.py, e.g.
rem             run.cmd --print             local state, no Feishu
rem             run.cmd --bitable-preview   rows that would go to Base
rem             run.cmd --card-preview      card JSON + size
rem
rem  ASCII-only on purpose (see tools/banner.py): Chinese echo lines
rem  come out as mojibake on a CP936 box no matter how this file is
rem  encoded -- UTF-8 gets parsed as GBK, GBK breaks under chcp 65001.
rem ============================================================

set "HERE=%~dp0"
cd /d "%HERE%"
set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1

rem Pick the interpreter: the venv install.cmd built first, then system Python.
rem Must resolve to a REAL path (no "py -3" with a space) because we quote it.
rem Never hard-code a local absolute path -- this has to run on someone else's box.
set "PY="
if exist "%HERE%.venv\Scripts\python.exe" set "PY=%HERE%.venv\Scripts\python.exe"
if not defined PY for /f "delims=" %%i in ('where python 2^>nul') do if not defined PY set "PY=%%i"
if not defined PY for /f "delims=" %%i in ('py -3 -c "import sys;print(sys.executable)" 2^>nul') do if not defined PY set "PY=%%i"
if not defined PY (
  echo [x] Python not found.
  echo     Run install.cmd to build the venv, or install Python 3.10+ yourself.
  pause
  exit /b 2
)

if "%~1"=="" (
  if not exist "%HERE%config.json" (
    echo.
    echo [x] No config.json yet.
    echo.
    echo     First run: the setup wizard creates the Base table, grabs
    echo     your open_id and writes config.json:
    echo         install.cmd
    echo.
    echo     Just want a look, no Feishu:
    echo         run.cmd --print
    echo         run.cmd --bitable-preview
    echo.
    pause
    exit /b 2
  )
)

"%PY%" -m feishu_hub.hub %*
set "RC=%errorlevel%"

if not "%RC%"=="0" (
  echo.
  echo [x] exited with code %RC%
  pause
)
endlocal & exit /b %RC%
