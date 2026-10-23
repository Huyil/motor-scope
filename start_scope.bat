@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "PY=python"
where python >nul 2>nul
if errorlevel 1 (
  set "PY=py"
  where py >nul 2>nul
  if errorlevel 1 (
    echo [MotorScope] Python 3 not found. Install Python 3.10+ and add it to PATH.
    pause
    exit /b 1
  )
)

echo Starting MotorScope...
%PY% scope_server.py --auto --open %*
if errorlevel 1 pause
