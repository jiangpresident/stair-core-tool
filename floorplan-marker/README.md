# Floorplan Marker · 平面图标注助手

本地运行的平面图识别与人工校正原型。上传 PNG / JPEG / WebP / BMP，通过图像处理生成墙线、门洞和楼梯区域候选，然后在原图上编辑，导出 PNG、SVG 和可重新打开的 JSON 工程。

**不需要 AI API key，不上传图片到云端。首版使用传统图像处理规则，没有附带训练好的 AI 模型，不能视为全自动准确识别系统。** 适合清晰、横平竖直、建筑符号规范的平面图。自动结果需要检查，尤其是小门、双开门、窗边墙线和楼梯平台边界。

## 最快启动（Windows）

1. 安装 **Python 3.10–3.12**，安装时勾选 **Add Python to PATH**。
2. 完整解压项目 ZIP，不能在压缩包里直接运行。
3. 双击 `start_windows.bat`。第一次会建立项目自己的 `.venv` 并安装依赖，需要联网。
4. 浏览器会打开 `http://127.0.0.1:8765`。保持终端窗口打开；关闭终端或按 Ctrl+C 停止程序。

后续运行识别无需联网。若自动打开浏览器失败，手动访问终端显示的网址。

## macOS / Linux

安装 Python 3.10–3.12，在本文件所在文件夹打开终端：

```sh
sh start_mac_linux.sh
```

Linux 如缺少 `venv`，需先安装相应的 Python venv 系统包。首次安装失败时查看终端提示；不要把 API 密钥填入此程序。

## 手动启动 / 给 Claude Code 调试

```sh
python -m venv .venv
```

Windows：

```bat
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe server.py --open
```

macOS / Linux：

```sh
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python server.py --open
```

端口占用时添加 `--port 8766`。服务器只监听本机 `127.0.0.1`，这不是公共网站服务器。

## 使用流程

1. 点击载入示例，或上传自己的原始平面图。
2. 点击自动识别，查看候选结果。调整参数后可以重跑；保留的人工标注不代表自动算法已学会该修正。
3. 校正墙线、门洞和楼梯间范围。选择对象后拖动端点/顶点，或拖动整个对象；Delete 删除，Ctrl/Cmd+Z 撤销。
4. 手工补画：墙和门各点两下形成线段；楼梯逐点形成多边形，按 Enter 完成。Esc 取消当前绘制。
5. 导出 PNG 用于展示；导出 SVG 用于矢量编辑；保存 JSON 工程以便之后继续修改。

快捷键：`V` 选择，`W` 墙，`D` 门，`S` 楼梯，`Esc` 取消，`Delete` 删除，`Ctrl/Cmd+Z` 撤销。其余操作以界面提示为准。

## 标注含义

- **红线：墙体中心线。** 窗所在位置应继续连接红线，真正的门洞应断开。
- **黄线：门洞关闭位置的线段。** 不是开门圆弧，也不是开启状态的门扇。
- **绿色：楼梯间区域，填充透明度固定为 50%。** 应包含相应平台，边界需要检查。
- 窗在本版没有独立导出类别；规则尝试延续穿过窗的墙线，结果不保证完整。
- 所有坐标采用导入后的原图像素坐标，左上角为原点，向右为 x 正方向、向下为 y 正方向。手机照片会按 EXIF 朝向规范化。
- PNG/SVG 由程序叠加标注，背景不通过生成式模型重画。单个绿色区域的 alpha 为 0.5；不同楼梯多边形相互重叠时，普通叠加会使重叠处颜色更深，应避免重叠标注。

## 实际限制

- 当前检测器是启发式原型，不是 CubiCasa5K 或其他预训练模型的推理包装。没有训练权重，也没有数值化准确率承诺。
- 自动候选可能包含家具线、门扇或栏杆；也可能漏掉小门、斜墙、曲墙、复杂楼梯或墙体转角。
- 支持的主要对象是水平/垂直墙。文字密集、倾斜扫描、彩色填充、低清图片会降低效果。
- 楼梯重复踏步较容易发现，但“整个楼梯间”的边界比踏步范围难，需人工确认平台和出口。
- 建议先以中等分辨率清晰图测试。输入限制为 20 MB / 2400 万像素；检测器可能缩小分析图，返回原始像素坐标。
- 分数如出现在数据中，是规则强度分数，不是经过校准的正确概率。
- 本版不计算真实尺寸、面积、疏散距离或法规符合性；像素不能直接当作米。
- 工程应主动导出保存，关闭或刷新页面可能失去未保存修改。

## 项目结构

```text
floorplan-marker/
  server.py               本机 HTTP 服务与输入校验
  detector.py             独立的自动检测函数
  requirements.txt        Python 依赖
  start_windows.bat       Windows 启动入口
  start_mac_linux.sh      macOS / Linux 启动入口
  static/                 无构建步骤的原生 HTML/CSS/JavaScript 编辑器
  examples/example.png    本次用户提供的原始平面图
  tests/                  Python unittest 测试
  CLAUDE.md               Claude Code 交接约束与接口
  HANDOFF_PROMPT.txt       可直接发送给 Claude 的说明
  VALIDATION.md           实际验证记录和剩余限制
```

## 自动检测接口

前端向本机 `POST /api/detect` 发送 JSON：`image` 为图片 data URL；`options` 包含 `threshold`、`min_wall_length`、`bridge_gap`、`sensitivity`。输出 `width`、`height`、`walls`、`doors`、`stairs`、`meta`。

`walls` / `doors` 每项包含 `id, x1, y1, x2, y2, source, confidence`；`stairs` 每项包含 `id, points, source, confidence`。原图坐标和此接口应在未来模型升级时保持一致。前端保存工程的外层格式以 `static/app.js` 为准。

## 测试

激活虚拟环境或使用其 Python 运行：

```sh
python -m unittest discover -s tests -v
```

测试通过只证明相关行为在这些样例上成立，不等于对任意平面图的识别精度验证。当前测试情况见 `VALIDATION.md`。

## 后续接入本地 AI 模型

让 Claude 阅读 `CLAUDE.md`，在保持 `detect(image, options)` 返回结构的前提下替换或扩展检测器。需要另外选择合法可用的模型、确认类别含义、取得权重、处理坐标缩放并测试。不要直接使用通用物体检测权重，假定它已学会建筑符号。

参考资料：

- OpenCV 线检测官方文档：https://docs.opencv.org/4.x/d9/db0/tutorial_hough_lines.html
- CubiCasa5K 官方研究代码（本项目未包含其代码或权重）：https://github.com/CubiCasa/CubiCasa5k
- Python 本地 HTTP 服务：https://docs.python.org/3/library/http.server.html

示例图来自用户提供的文件，仅用于这次项目演示；公开发布前请自行确认图纸的使用权限。
