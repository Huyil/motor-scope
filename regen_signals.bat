@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem 优先使用工程自带的便携 Python; 没有则用系统 Python.
set "BUNDLED=%~dp0runtime\python\python.exe"
if exist "%BUNDLED%" goto :run_bundled

echo Rebuilding machine profiles (profiles\<ID>\signals.json) ...
python tools\build_profiles.py %*
goto :done

:run_bundled
echo Rebuilding machine profiles (profiles\<ID>\signals.json) ...
"%BUNDLED%" tools\build_profiles.py %*

:done
pause
