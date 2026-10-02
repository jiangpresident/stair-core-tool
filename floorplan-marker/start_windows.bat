@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if errorlevel 1 (
  set "PY_CMD=python"
) else (
  set "PY_CMD=py -3"
)
if not exist ".venv\Scripts\python.exe" (
  %PY_CMD% -m venv .venv
  if errorlevel 1 goto :error
)
.venv\Scripts\python.exe -c "import numpy, PIL, cv2" >nul 2>nul
if errorlevel 1 (
  .venv\Scripts\python.exe -m pip install -r requirements.txt
  if errorlevel 1 goto :error
)
.venv\Scripts\python.exe server.py --open
if errorlevel 1 goto :error
exit /b 0
:error
echo.
echo Startup failed. Install Python 3.10-3.12 and check the message above.
pause
exit /b 1
