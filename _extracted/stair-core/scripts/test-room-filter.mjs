// 单测 rasterWallDetect.js 的"按房间分隔关系筛墙体候选"逻辑：手画一张合成图——一个大房间被一条
// 内墙分成两半，其中一个房间里飘着一条不挨墙的"噪点线"（模拟尺寸标注/文字笔画）和一个不挨墙的
// 实心小方块（模拟柱子）。真正的墙应该被保留，飘在房间内部、没有真的分隔空间的噪点应该被丢弃。
import { detectRasterSegments, labelOpenRegions, filterWallsByRoomAdjacency } from "../src/plan/rasterWallDetect.js";
import { detectWallCandidates } from "../src/plan/pdfWallDetect.js";

function makeCanvas(width, height) {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  return { data, width, height };
}
function setPixel(img, x, y, val) {
  x = Math.round(x);
  y = Math.round(y);
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const idx = (y * img.width + x) * 4;
  img.data[idx] = val;
  img.data[idx + 1] = val;
  img.data[idx + 2] = val;
  img.data[idx + 3] = 255;
}
function fillRect(img, x0, y0, x1, y1, val = 0) {
  for (let y = Math.max(0, Math.floor(y0)); y <= Math.min(img.height - 1, Math.ceil(y1)); y++)
    for (let x = Math.max(0, Math.floor(x0)); x <= Math.min(img.width - 1, Math.ceil(x1)); x++) setPixel(img, x, y, val);
}

const W = 2000, H = 1500;
const img = makeCanvas(W, H);
// 外墙（整个大矩形的边框，单线，8px 粗——接近真实扫描件量出来的墙线粗细）
fillRect(img, 200, 200, 1800, 208, 0); // 上
fillRect(img, 200, 1200, 1800, 1208, 0); // 下
fillRect(img, 200, 200, 208, 1200, 0); // 左
fillRect(img, 1792, 200, 1800, 1200, 0); // 右
// 内墙：把大房间从中间分成左右两间（垂直，8px 粗，贯穿整个高度）
fillRect(img, 996, 200, 1004, 1200, 0);
// 左边房间里飘一条"尺寸标注线"（不挨任何墙，两端都在房间内部空白处）
fillRect(img, 400, 500, 700, 502, 0);
// 左边房间里再飘一个"柱子"实心小方块（不挨墙）
fillRect(img, 500, 800, 540, 840, 0);

function assert(cond, msg) {
  if (!cond) throw new Error("断言失败: " + msg);
  console.log("✓ " + msg);
}

const segments = detectRasterSegments(img);
console.log(`原始线段 ${segments.length} 条（未过滤，包含真墙和噪点）`);

const regions = labelOpenRegions(img);
const roomAreas = [...regions.areaByRoot.values()].filter((a) => a > 4000);
console.log(`识别到 ${roomAreas.length} 个"有效房间大小"的连通区域，面积分别是: ${roomAreas.join(", ")}`);
// 3 个：图纸最外圈的背景（也是"合法的开放区域"，外墙靠它才能被判定为"分隔了空间"）+ 左右两个房间
assert(roomAreas.length === 3, `应该识别出"外圈背景 + 左右两个房间"共 3 块连通区域，实际 ${roomAreas.length} 个`);

// 先正常配对出墙体候选（这一步才知道每面墙自己的厚度），再按房间分隔关系过滤——
// 跟 pdfWalls.js 的 detectRasterWalls 实际调用顺序一致
const rawCandidates = detectWallCandidates(segments);
console.log(`配对阶段（过滤前）产出 ${rawCandidates.length} 面候选墙（含真墙和噪点）`);

const candidates = filterWallsByRoomAdjacency(rawCandidates, regions);
console.log(JSON.stringify(candidates.map((c) => ({ x1: c.x1, y1: c.y1, x2: c.x2, y2: c.y2, w: c.w })), null, 2));

function wallLen(w) {
  return Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
}
// 期望：4 面外墙 + 1 面内墙 = 5 面真墙；飘在房间里的标注线和柱子都不应该出现在结果里
assert(candidates.length === 5, `应该识别出 5 面真墙（4 面外墙 + 1 面内墙），噪点被过滤掉，实际 ${candidates.length} 面`);
const longWalls = candidates.filter((c) => wallLen(c) > 300);
assert(longWalls.length === 5, "5 面墙长度都应该是真正的墙那么长（不是噪点的短线段）");
const noiseNearby = candidates.filter((c) => {
  // 飘在房间里那条标注线大概在 (400~700, 500)，柱子在 (500~540, 800~840) 附近；
  // 确认识别结果里没有任何一段墙落在这个区域内
  const midX = (c.x1 + c.x2) / 2, midY = (c.y1 + c.y2) / 2;
  return midX > 350 && midX < 750 && midY > 450 && midY < 900;
});
assert(noiseNearby.length === 0, "房间内部飘着的标注线/柱子噪点应该被完全过滤掉，不该出现在识别结果里");

console.log("\n全部通过：按房间分隔关系过滤噪点墙体候选的逻辑验证 OK。");
