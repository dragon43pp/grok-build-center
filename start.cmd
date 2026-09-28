@echo off
chcp 65001 >nul
setlocal

rem ============================================================
rem  AI session hub -- single entry point
rem
rem  This file is ASCII-only ON PURPOSE. See tools/banner.py for why:
rem  Chinese inside a .cmd is broken either way on a CP936 box
rem  (UTF-8 file -> cmd parses it as GBK; GBK file -> chcp 65001
rem  makes echo dump mojibake). So all Chinese is printed by Python.
rem
rem  Routes automatically:
rem    config.json not ready -> offline check (needs no config)
rem    config.json ready     -> start the Feishu panel
rem
rem  Force one:  start.cmd --check   /   start.cmd --panel
rem ============================================================

set "HERE=%~dp0"
cd /d "%HERE%"
set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1

set "PY=%HERE%.venv\Scripts\python.exe"
if not exist "%PY%" set "PY=python"

set "MODE="
if /i "%~1"=="--check" set "MODE=check"
if /i "%~1"=="--panel" set "MODE=panel"

if "%MODE%"=="" (
  "%PY%" tools\config_ready.py
  if errorlevel 1 (set "MODE=check") else (set "MODE=panel")
)

if "%MODE%"=="check" (
  "%PY%" tools\banner.py check
  call "%HERE%offline-check.cmd"
  endlocal & exit /b %errorlevel%
)

"%PY%" tools\banner.py panel
call "%HERE%run.cmd"
endlocal & exit /b %errorlevel%
