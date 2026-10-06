@echo off
rem Start Rhino and auto-run rhino\StairCoreBridge.py (the Rhino bridge used by the stair-core web tool),
rem so you do not have to open ScriptEditor and run the script by hand every time.
rem Prefers Rhino 8, falls back to Rhino 7. Edit the RHINO path below if Rhino is installed elsewhere.
rem (This file is kept ASCII-only on purpose: cmd.exe mis-parses UTF-8 batch files that contain CJK text.)
setlocal
set "HERE=%~dp0"
set "SCRIPT=%HERE%rhino\StairCoreBridge.py"
if not exist "%SCRIPT%" (
  echo Cannot find "%SCRIPT%"
  pause
  exit /b 1
)
set "RHINO=C:\Program Files\Rhino 8\System\Rhino.exe"
if not exist "%RHINO%" set "RHINO=C:\Program Files\Rhino 7\System\Rhino.exe"
if not exist "%RHINO%" (
  echo Rhino 8 / Rhino 7 not found at the default path C:\Program Files\Rhino 8\System\Rhino.exe
  echo Edit the RHINO path in this .bat file.
  pause
  exit /b 1
)
echo Starting %RHINO%
echo Running bridge script: %SCRIPT%
echo Rhino's command line should show "StairCore bridge listening on http://127.0.0.1:8790",
echo then click "Connect Rhino" in the web tool.
start "" "%RHINO%" /nosplash /runscript="-_RunPythonScript ""%SCRIPT%"""
endlocal
