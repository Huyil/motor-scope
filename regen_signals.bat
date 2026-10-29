@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem 优先使用工程自带的便携 Python; 没有则用系统 Python.
set "BUNDLED=%~dp0runtime\python\python.exe"
if exist "%BUNDLED%" goto :run_bundled

echo Regenerating signals.json from MDK/Objects/DR2159.axf ...
python gen_signals.py %*
goto :done

:run_bundled
echo Regenerating signals.json from MDK/Objects/DR2159.axf ...
"%BUNDLED%" gen_signals.py %*

:done
pause
