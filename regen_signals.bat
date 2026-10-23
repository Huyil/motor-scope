@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
echo Regenerating signals.json from MDK/Objects/DR2159.axf ...
python gen_signals.py
pause
