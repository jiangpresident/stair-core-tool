# Stair Core Tool · 核心筒疏散楼梯工具

Vancouver (VBBL 2025 → BCBC 2024 → NBC 2020) exit-stair calculator and floor-plan egress checker, built with React + Vite + three.js, plus a local Python/OpenCV floor-plan recognition service.

温哥华建筑规范核心筒疏散楼梯计算器 + 平面图疏散校核工具（React + Vite + three.js），附一个本机 Python/OpenCV 平面图识别服务。

UI language: **English by default**, switch to 中文 with the toggle at the top-right.

## What it does / 功能

- **Stair-core calculator** — number of exit stairs, clear width, flights, landings and stair-enclosure size per storey from floor area, occupancy and storey height; plan / section / 3D views with code references.
  **核心筒计算器**：按每层面积、用途、层高算楼梯数量、净宽、跑数、平台与楼梯间尺寸，带平面 / 剖面 / 三维图和条文引用。
- **Floor plan tool** — upload a PDF or image, calibrate scale, recognise walls / doors / stairs (four routes: local OpenCV service, vector PDF parsing, image edge detection, or Claude / ChatGPT vision), place cores, draw corridor walls and doors, then check exit separation, shortest egress paths and a whole-floor travel-distance heatmap. Save / open projects as `.stairplan.json`.
  **平面图工具**：上传 PDF/图片、标定比例、识别墙/门/楼梯（四条路线：本机 OpenCV 服务、矢量 PDF 解析、图像边缘识别、Claude/ChatGPT 识图），摆核心筒、画走廊墙和门，校核出口间距、最短疏散路径和整层行走距离热力图。工程可保存为 `.stairplan.json`。

> Schematic-stage estimates only — not a substitute for a code review by a registered professional.
> 仅供方案阶段估算，不替代注册专业人员的规范审查。

## Quick start / 快速开始

Requirements: **Node.js** (with npm) and **Python 3.10+** (for the local recognition service).

**Windows, one click:** double-click `启动平面图工具.bat` — the first run installs the npm dependencies and the Python environment, then starts the dev server (which also starts the recognition service) and opens the browser.

**Manual:**

```bash
cd _extracted/stair-core
npm install
npm run dev          # http://localhost:5173  (/ calculator, /plan floor plan tool)
```

The floor-plan recognition service (`floorplan-marker/`) is started automatically by the dev server; the first time, create its Python environment with `floorplan-marker/start_windows.bat` (or `sh floorplan-marker/start_mac_linux.sh`).

## Repository layout / 目录

| Path | Contents |
|---|---|
| `_extracted/stair-core/` | The web app (React + Vite). See its own `README.md` and `CLAUDE.md` (development log). |
| `floorplan-marker/` | Local Python + OpenCV floor-plan recognition service (walls / doors / stairs), with its own README. |
| `Saved Plans/` | Example plan projects — open them from the **example** panel in the floor plan tool. |
| `Test Plans/` | Sample floor-plan PDFs used for testing recognition. |
| `启动平面图工具.bat` | One-click launcher for Windows. |

## Tests / 测试

```bash
cd _extracted/stair-core
npm run test:calc && npm run test:pdf && npm run test:raster && npm run test:dimension && npm run test:room
npm run test:ai && npm run test:marker && npm run test:plan-file && npm run test:plan-bridge && npm run test:marker-service
cd ../../floorplan-marker && .venv/Scripts/python.exe -m unittest discover -s tests   # Windows
```

## Privacy / 隐私

Everything runs locally. The optional AI recognition route uses **your own** Claude / OpenAI API key, stored only in your browser's localStorage and sent directly to the official API.

## License

[MIT](LICENSE)
