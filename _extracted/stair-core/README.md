# stair-core

温哥华（VBBL 2025 → BCBC 2024 → NBC 2020）核心筒疏散楼梯计算器，React + three.js。

界面语言：默认英文，右上角 EN / 中 切换（存在浏览器里，切换时整页刷新）。源码里的界面文字以中文写、作为词典的键，英文在 `src/i18n/en.js`；新加文字后跑 `node scripts/i18n-wrap.mjs` 自动包成 `t()`，再 `npm run i18n:keys -- --missing` 看缺哪些翻译补进词典。

最省事的打开方式：双击项目根目录（"Stair core Tool"）的 **`启动平面图工具.bat`**——第一次会自动装好前端依赖和本机识图服务的 Python 环境，之后每次双击就启动开发服务器（并自动拉起本机识图服务）、自动打开浏览器；关掉那个窗口即全部停止。

```bash
npm install
npm run dev          # 本地开发 http://localhost:5173（/ 计算器，/plan 平面图工具）；会自动启动 floorplan-marker 识图服务（见 vite.config.js，MARKER_AUTOSTART=0 可关）
npm run test:calc    # 计算与几何回归测试
npm run test:pdf     # 矢量 PDF 墙体识别回归测试（手写合成 PDF，见 scripts/test-pdf-walls.mjs）
npm run test:raster  # 扫描件图像边缘墙体识别回归测试（合成像素图，见 scripts/test-raster-walls.mjs）
npm run test:dimension # 标注数字自动标定比例回归测试（见 scripts/test-dimension-detect.mjs）
npm run test:room    # 图像识别"按房间分隔关系过滤噪点"回归测试（见 scripts/test-room-filter.mjs）
npm run test:ai      # AI 识图路线回归测试（假 fetch 冒充 Claude/OpenAI 接口，不联网不花钱，见 scripts/test-ai-vision.mjs）
npm run test:marker  # 本机 Floorplan Marker 路线回归测试（假 fetch 冒充本机服务，见 scripts/test-marker.mjs）
npm run test:plan-file # 平面图工程文件保存/打开的序列化与校验测试（见 scripts/test-plan-file.mjs）
npm run build        # 生产构建 → dist/
npm run build:single # 三个双击打开的 HTML → dist-single/：
                      #   stair-core-launcher.html    启动页（配色仿 Claude），点卡片分别打开另外两个
                      #   stair-core-calculator.html   核心筒计算器
                      #   stair-core-plan.html         平面图工具
```

核心筒计算器与平面图工具是两个可以各自单独打开的页面/文件，通过浏览器 `localStorage` 传递楼梯计算结果（同一浏览器打开即可自动同步，见 `src/planBridge.js`）。`npm run dev`/`npm run build` 下是 `/` 与 `/plan` 两个路径；`npm run build:single` 下是三个互相用同目录相对路径跳转的独立 HTML 文件——**发给别人时要把 `dist-single` 整个文件夹一起带上**，不能只发单个文件。这三个文件目前还不是真正的桌面 `.exe`（没有用 Electron/Tauri 打包），只是普通的静态 HTML，双击就能用浏览器打开。

平面图工具的"上传平面图"支持图片和 PDF；PDF 会先渲成一张背景图。上传后工具栏上有一个**识图菜单**（下拉选路线 + 一个识别按钮，默认"本机 Marker 识图"；Marker 的黑白阈值直接显示，滑块和数字框都能改；矢量/图像两条路线点"参数"展开线宽范围等），四条路线互相独立、可以来回切换重新识别。右侧的核心筒 / 走廊墙体 / 门 / 疏散路径面板都可以点标题折叠，墙和门的列表默认收起（标题上仍显示数量）；右栏顶部的"收起面板 ▶"能把整栏一起收到右边缘的一条竖条上，让平面图占满整行，点竖条再展开：
- **按矢量解析**（`src/plan/pdfWallDetect.js`）：解析 PDF 内容流里的矢量线段，用启发式规则（线宽本身够粗的单线直接当墙；细线两两配对当墙的两条边）识别墙体——只对矢量 CAD 导出的 PDF 有效，扫描件/纯图片 PDF 没有矢量数据可读，会正常跑完但识别到 0 段。配对前会先把柱子（闭合小矩形 / 短胖的平行对，边长 ≤120px、长宽比 ≤2.5）整个剔除（`findColumnBoxes`），不然柱子的四条边会被配成两面互相垂直的短墙；最终候选还要求长度 ≥1.5 倍厚度。斜墙的角度全程保持不变。
- **按图像识别**（`src/plan/rasterWallDetect.js`）：对渲染出来的背景图做 Sobel 边缘检测+方向分桶，配对出墙体候选后套用户设的线宽范围。可选勾上"按房间分隔关系过滤噪点"（`labelOpenRegions`+`filterWallsByRoomAdjacency`，默认关闭——墙上有门洞时相邻房间会连成一块，中间的隔墙会被误删）。用于扫描件/栅格图 PDF，准确率不如矢量解析。
- **本机识别（Floorplan Marker）**（`src/plan/markerDetect.js` + `marker.js`；PDF 和图片底图都可用）：调用项目根目录 `floorplan-marker/` 里的本机 Python + OpenCV 服务（`127.0.0.1:8765`，不联网、不用密钥）。用 `npm run dev` 或 `启动平面图工具.bat` 打开工具时它会自动启动；万一它没在线，识图菜单旁会出现"启动服务"按钮，点一下由开发服务器把它拉起来（`src/dev/markerService.mjs`）。只有双击 `dist-single/` 里的静态 HTML 用时需要先手动双击 `floorplan-marker/start_windows.bat`（静态页面没法自己起 Python 进程）。底图按墨迹范围裁剪、缩到 1400px 以内后送过去，返回的墙中心线 / 门洞 / 楼梯间坐标映射回原图。只识别横平竖直的墙，但柱子不会被当成墙、门和楼梯间也能标出来，在干净的正交图纸上效果最好。黑白阈值默认 230（pdf.js 渲染的抗锯齿细线用 Marker 自己默认的 180 会丢门弧和踏步）。
- **AI 识图**（`src/plan/aiSettings.js` + `aiVisionDetect.js` + `aiVision.js`；PDF 和图片底图都可用）：把整张图缩到 1568px 以内送给多模态大模型，让它直接读出墙（中心线+厚度）、门（洞口两端）、楼梯（包围盒）的像素坐标。可在界面上切换 **Claude（Anthropic，官方 SDK）** 或 **ChatGPT（OpenAI）**，模型名可改。**需要联网 + 自己的 API 密钥**：密钥在界面上填，只存这台电脑浏览器的 `localStorage`，不进源码/打包文件，请求由浏览器直连各家官方接口。墙走下面同一套蓝色虚线候选流程；门（绿色）和楼梯（橙色框）目前只作参考显示、不能转正。

工具栏上还有两个滑块可以设定"只识别线宽在 X~Y 像素之间的线条"（对矢量解析和图像识别生效）。四条识别路线产出的墙体候选都叠加显示为蓝色虚线，选中后双击接受、或按 Delete/Backspace 单独丢弃，也可以点"全部接受为墙体"批量转正。识别出门（绿）/ 楼梯（橙框）时还有"一键添加全部（墙 + 门 + 楼梯）"：楼梯框变成核心筒——跟"添加核心筒"放进来的一模一样（挂上当前下拉框选中的那部楼梯，画梯段、参与尺寸校核；竖长的框自动转 90°），贴在框边的门当它的门；其余门挂到最近的墙上（附近没墙的跳过）。门宽输入框可以清空重输，失焦或回车才生效（下限 600 mm）。建议先标定比例再一键添加——核心筒尺寸不会随之后的标定缩放。

上传 PDF 后还多了一个"按标注数字自动标定比例"：用 OCR（`tesseract.js`，浏览器里跑，纯前端）识别图纸上写的尺寸标注（比如"2400"/"2400mm"），配上离它最近、长度说得通的一条线，猜出这条线代表的真实距离，从而自动算出比例——不用再手动点两个点、手动输一遍已知距离。识别出来的标注同样是"候选"（紫色标记），点选其一才会真正生效。这个功能需要联网（OCR 语言包从 tesseract.js 官方 CDN 下载）；除它和上面的"AI 识图"之外，其它功能都不需要联网。

工程文件：工具栏"保存 / 另存为… / 打开…"把整张平面图（底图、比例、边界、核心筒、墙、门、路径）存成 `.stairplan.json`。用 `npm run dev` / `启动平面图工具.bat` 打开时，开发服务器会替浏览器弹 **Windows 系统的另存为/打开对话框**并直接写盘（`src/dev/planFileBridge.mjs`，只允许写用户在对话框里选过的路径），所以在 Claude 内置浏览器面板这类不让网页写文件的环境里也能自选位置，之后 Ctrl+S 直接覆盖同一个文件；dist-single 静态版没有这层，Chrome/Edge 走浏览器自己的文件接口，其它浏览器退回下载到默认下载目录；"打开"可随时把之前保存的工程拉回来继续画（打开的工程没有 PDF 原始数据，矢量/图像两条识别路线对它不可用，Marker/AI 识图照常）。

右侧栏顶部的 **example 面板**列出项目根目录 "Saved Plans" 文件夹里的所有工程文件（`.json`），点一下直接打开；从这里打开的（以及路径在 Saved Plans 里的）工程受保护——保存 / Ctrl+S 会先弹确认（确定覆盖 / 另存为 / 取消），二次确认才真的覆盖示例；把自己的平面"另存为…"进那个文件夹就会出现在面板里（只在 `npm run dev` / `启动平面图工具.bat` 方式下有，dist-single 静态版没有）。

画布上选中的核心筒或墙都可以 Ctrl+C / Ctrl+V 复制粘贴（墙会连同它上面的门一起复制，粘贴后错开 600 mm 并自动选中新的那份），Delete / Backspace 删除，Ctrl+Z / Ctrl+Y 撤销重做。

"清空平面图"（平面图区域最下方，红色）会把底图、比例、边界、核心筒、墙、门、路径全部清掉回到空白画布，点了先出确认条、再点"确定清空"才生效，清空后可 Ctrl+Z 撤销；它同时断开与工程文件的关联，避免把空图覆盖写回刚才的文件。

标定比例：点"标定比例"后在底图上点两个点（选一段已知长度的线），按钮旁会出现距离输入框，输入毫米数确定即可（标定点很小，只比连线稍粗）。疏散距离校核除了逐条"自动最短路径"，还有**行走距离热力图**：整层按 1 m（可选 0.5/2 m）打格，每格取格内最不利点到最近核心筒门的最短路径（跟"自动最短路径"同一张避墙栅格、同一套 Dijkstra，只是把所有核心筒门当起点一次算完全图），按用途分组/喷淋的限值判达标绿、超标红、走不到门灰；鼠标悬停看具体数值。

项目上下文与下一阶段计划见 `CLAUDE.md`；在 Claude Code 中接手时先发送 `docs/START_PROMPT.md` 的内容。
