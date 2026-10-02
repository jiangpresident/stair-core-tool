@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title 楼梯核心筒工具 - 启动中

rem ===== 第一次运行：给 Floorplan Marker（本机识图服务）装 Python 依赖 =====
if not exist "floorplan-marker\.venv\Scripts\python.exe" (
  echo [1/3] 第一次运行，正在为本机识图服务建立 Python 环境（需要联网，几分钟）...
  where py >nul 2>nul
  if errorlevel 1 (set "PY_CMD=python") else (set "PY_CMD=py -3")
  pushd floorplan-marker
  %PY_CMD% -m venv .venv || goto :pyerror
  .venv\Scripts\python.exe -m pip install -r requirements.txt || goto :pyerror
  popd
) else (
  echo [1/3] 本机识图服务的 Python 环境已就绪
)

rem ===== 第一次运行：装前端依赖 =====
if not exist "_extracted\stair-core\node_modules" (
  echo [2/3] 第一次运行，正在安装前端依赖（需要联网）...
  pushd _extracted\stair-core
  call npm install || goto :npmerror
  popd
) else (
  echo [2/3] 前端依赖已就绪
)

rem ===== 启动：开发服务器会自动把 Marker 识图服务一起拉起来（见 vite.config.js），几秒后打开浏览器 =====
echo [3/3] 正在启动工具（关掉这个窗口即停止；浏览器几秒后自动打开）...
start "" /b cmd /c "timeout /t 5 >nul & start "" http://localhost:5173/plan"
cd /d "%~dp0_extracted\stair-core"
call npm run dev
goto :eof

:pyerror
popd
echo.
echo 本机识图服务的 Python 环境安装失败：请确认已安装 Python 3.10 以上并勾选了 "Add Python to PATH"，然后重试。
pause
exit /b 1

:npmerror
popd
echo.
echo 前端依赖安装失败：请确认已安装 Node.js（含 npm），然后重试。
pause
exit /b 1
