@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem 优先用工程自带的便携 Python (runtime\python, 免安装); 没有则退回系统 Python.
set "BUNDLED=%~dp0runtime\python\python.exe"

if exist "%BUNDLED%" goto :run_bundled
where python >nul 2>nul
if not errorlevel 1 goto :run_python
where py >nul 2>nul
if not errorlevel 1 goto :run_py

echo [MotorScope] 未找到 Python: runtime\python\python.exe 不存在, 系统里也没有 python/py.
echo [MotorScope] 请把 runtime\python 一起拷贝过来, 或安装 Python 3.10+ 并加入 PATH.
pause
exit /b 1

:run_bundled
echo Starting MotorScope...
echo Python: %BUNDLED%
"%BUNDLED%" scope_server.py --open %*
goto :done

:run_python
echo Starting MotorScope...
echo Python: python (系统 PATH)
python scope_server.py --open %*
goto :done

:run_py
echo Starting MotorScope...
echo Python: py (系统 PATH)
py scope_server.py --open %*
goto :done

:done
if errorlevel 1 pause
