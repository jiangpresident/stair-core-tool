// 第四条识别路线：本机 Floorplan Marker（项目根目录 floorplan-marker/，Python + OpenCV 的启发式识别，
// 只监听 127.0.0.1:8765，不联网、不用 API 密钥）。它只做横平竖直的墙，但在用户这类干净的正交图纸上
// 柱子不会被当成墙、门洞和楼梯间也能标出来——实测比我们自己的 Sobel 图像识别好得多，所以接进来。
//
// 这个文件是纯逻辑（不碰 DOM），Node 里可单测（scripts/test-marker.mjs）：
//   - findInkBounds：找图纸墨迹的实际范围。实测发现整页送过去效果很差（页面大片空白，Marker 内部会把图
//     缩到 1400px 分析，图纸本身只剩几百像素宽），按墨迹范围裁剪后才正常。
//   - planCrop：裁剪 + 缩放方案，长边不超过 1400px（再大 Marker 也会缩回去，白传）。
//   - detectWithMarker：POST /api/detect，错误翻成中文（服务没启动是最常见的情况，要告诉用户怎么启动）。
//   - mapMarkerResult：把 Marker 返回的"送出去那张图"的像素坐标还原回我们底图的原始像素坐标，整理成
//     跟矢量/图像/AI 三条路线一致的候选形状。
import { normalizeFloorPlanResult } from "./aiVisionDetect.js";
import { t } from "../i18n.js";

export const MARKER_BASE_URL = "http://127.0.0.1:8765";
export const MARKER_MAX_EDGE = 1400;
// 黑白阈值默认 230 而不是 Marker 自己的默认 180：我们的底图是 pdf.js 渲染出来的抗锯齿细线，大量墨迹落在
// 150~250 的浅灰区，180 会把门弧、踏步、双线墙的另一条边全切掉（实测 L1-Vector.pdf：180 → 80 墙/10 门/0 楼梯，
// 230 → 44/19/2，后者跟 Marker 自带示例图的结果一致）。
export const MARKER_DEFAULT_THRESHOLD = 230;
export const MARKER_START_HINT = t("没检测到本机 Floorplan Marker 服务（127.0.0.1:8765）——双击项目里 floorplan-marker/start_windows.bat 启动它，保持那个终端窗口开着，再点一次");

/* 在 {data,width,height}（跟 ImageData 一样的形状）里找墨迹范围：灰度 ≤ threshold 的像素算墨迹。
   step 是采样步长（整张 2000×1500 的图逐像素扫也只要几十毫秒，但大图没必要全扫）。
   一个墨迹像素都没有就返回整张图。 */
export function findInkBounds(imageData, { threshold = MARKER_DEFAULT_THRESHOLD, margin = 12, step = 1 } = {}) {
  const { data, width, height } = imageData;
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      const a = data[i + 3];
      if (a === 0) continue; // 透明当白纸
      const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (gray > threshold) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return { x: 0, y: 0, w: width, h: height };
  const x0 = Math.max(0, minX - margin), y0 = Math.max(0, minY - margin);
  const x1 = Math.min(width, maxX + 1 + margin), y1 = Math.min(height, maxY + 1 + margin);
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

/* 裁剪+缩放方案：sx/sy/sw/sh 是从原图上裁的区域（原始像素），outW/outH 是送出去的图的尺寸，
   scale = 送出去的像素 / 原始像素（≤1，只缩不放）。 */
export function planCrop(bounds, maxEdge = MARKER_MAX_EDGE) {
  const scale = Math.min(1, maxEdge / Math.max(bounds.w, bounds.h));
  return { sx: bounds.x, sy: bounds.y, sw: bounds.w, sh: bounds.h, scale, outW: Math.max(1, Math.round(bounds.w * scale)), outH: Math.max(1, Math.round(bounds.h * scale)) };
}

/* Marker 返回：walls/doors 每项 {id,x1,y1,x2,y2,...}，stairs 每项 {id,points:[[x,y],...]}，坐标是送出去那张图的像素。
   还原：原始像素 = sx + x / scale。stairs 的多边形取包围盒（我们的 stairCandidates 就是包围盒）。
   wallW：墙厚（原始像素）——Marker 只给中心线不给厚度，由调用方按"默认墙厚 ÷ 当前 mmPerPx"算出来传进来，
   这样 scaleSegments 乘回 mmPerPx 后正好是默认墙厚（毫米）。 */
export function mapMarkerResult(result, crop, wallW) {
  const inv = 1 / (crop.scale || 1);
  const pt = (x, y) => ({ x: crop.sx + x * inv, y: crop.sy + y * inv });
  const seg = (s) => {
    const a = pt(s.x1, s.y1), b = pt(s.x2, s.y2);
    return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
  };
  const stairs = (Array.isArray(result.stairs) ? result.stairs : []).map((s) => {
    const pts = (s.points || []).map((p) => pt(p[0], p[1]));
    if (!pts.length) return null;
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
  }).filter(Boolean);
  // 复用 AI 路线的整理函数：分配 id、丢弃坏条目、楼梯包围盒规整；factor=1 因为上面已经换算完
  return normalizeFloorPlanResult(
    {
      walls: (Array.isArray(result.walls) ? result.walls : []).map((w) => ({ ...seg(w), thickness: wallW })),
      doors: (Array.isArray(result.doors) ? result.doors : []).map(seg),
      stairs,
    },
    1
  );
}

/* 调本机服务。dataUrl 是裁剪缩放后的 PNG data URL。fetch 参数只给测试注入假的 fetch 用。 */
export async function detectWithMarker({ dataUrl, threshold = MARKER_DEFAULT_THRESHOLD, options = {}, fetch: fetchImpl, baseUrl = MARKER_BASE_URL }) {
  const f = fetchImpl || globalThis.fetch;
  let res;
  try {
    res = await f(baseUrl + "/api/detect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: dataUrl, options: { threshold, ...options } }),
    });
  } catch {
    throw new Error(MARKER_START_HINT);
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* 非 JSON 响应，下面按状态码报 */
  }
  if (!res.ok) {
    const detail = json && json.error ? json.error : `HTTP ${res.status}`;
    if (res.status === 429) throw new Error(t("Floorplan Marker 正在处理上一张图，稍等几秒再点"));
    throw new Error(t("Floorplan Marker 识别失败：") + detail);
  }
  if (!json || !Array.isArray(json.walls)) throw new Error(t("Floorplan Marker 返回的数据格式不对"));
  return json;
}

export async function checkMarkerHealth({ fetch: fetchImpl, baseUrl = MARKER_BASE_URL } = {}) {
  const f = fetchImpl || globalThis.fetch;
  try {
    const res = await f(baseUrl + "/api/health");
    if (!res.ok) return false;
    const j = await res.json();
    return !!(j && j.ok);
  } catch {
    return false;
  }
}
