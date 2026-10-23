@echo off
chcp 65001 >nul
rem 不连硬件, 用 30 秒循环的仿真电流/阈值演示 UI
call "%~dp0start_scope.bat" --sim %*
