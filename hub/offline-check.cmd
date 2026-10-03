@echo off
chcp 65001 >nul
setlocal

rem ============================================================
rem  Offline check -- no Feishu, no config needed.
rem
rem  ASCII-only on purpose (see tools/banner.py): Chinese in a .cmd
rem  is broken either way on a CP936 box, so section titles are
rem  printed by banner.py instead of echo.
rem ============================================================

set "HERE=%~dp0"
cd /d "%HERE%"
set PYTHONIOENCODING=utf-8
set PYTHONUTF8=1

set "PY=%HERE%.venv\Scripts\python.exe"
if not exist "%PY%" set "PY=python"

"%PY%" tools\banner.py step 1
"%PY%" tools\sessions.py list -n 15
"%PY%" tools\banner.py note sessions
echo.

"%PY%" tools\banner.py step 2
"%PY%" -m feishu_hub.feed
echo.

"%PY%" tools\banner.py step 3
"%PY%" -m feishu_hub.hub --print
echo.

"%PY%" tools\banner.py step 4
"%PY%" tools\smoke_test.py
set "RC=%errorlevel%"

rem ---------- 5. the searchable history page ----------
rem This is where the PAST sessions actually live. The agent window
rem keeps its session list only in memory, so history never shows up
rem there -- this page is the answer to "where are my old sessions".
"%PY%" tools\banner.py step 5
"%PY%" -m feishu_hub.scan --out "%HERE%session-history.html" --open

echo.
if not "%RC%"=="0" echo [x] some checks failed - see [FAIL] above
pause
endlocal & exit /b %RC%
