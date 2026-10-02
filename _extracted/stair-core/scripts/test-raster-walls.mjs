// 手画一张最小的合成"扫描图"（纯像素数组，没有用任何图片/画布库），用来单测
// src/plan/rasterWallDetect.js 的边缘识别 + src/plan/pdfWallDetect.js 的配对/合并逻辑
// 拼起来能不能从纯像素数据里认出墙——这是在没有真实扫描件可用于自动化测试的情况下，
// 唯一能验证"Sobel 边缘 + 方向分桶 + 区间合并"这条管线本身是通的办法。
// 画布尺寸特意取得比较大（接近真实渲染出来的扫描件像素规模），不是随便选的——
// pdfWallDetect.js 的配对间距上限（PAIR_MAX_GAP_PX=400px）是按真实图纸的像素尺度定的，
// 画布太小的话对面两堵墙会被误配成一对（间距在阈值内、方向又平行），这是测试画布尺度
// 选得不对导致的假象，不是识别逻辑本身的 bug。
import { detectRasterSegments } from "../src/plan/rasterWallDetect.js";
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
function drawThickLine(img, x0, y0, x1, y1, thickness, val = 0) {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const steps = Math.ceil(len * 2);
  const ux = (x1 - x0) / len, uy = (y1 - y0) / len;
  const half = thickness / 2;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const cx = x0 + (x1 - x0) * t, cy = y0 + (y1 - y0) * t;
    for (let o = -half; o <= half; o += 0.5) setPixel(img, cx - uy * o, cy + ux * o, val);
  }
}

const W = 3000, H = 2400;
const img = makeCanvas(W, H);
// 左墙：两条竖直细带（画两条线代表墙的两个面），房间尺度刻意取得比 PAIR_MAX_GAP_PX 大得多，
// 避免对面墙被误配对
fillRect(img, 999, 300, 1001, 2100);
fillRect(img, 1009, 300, 1011, 2100);
// 右墙
fillRect(img, 2799, 300, 2801, 2100);
fillRect(img, 2809, 300, 2811, 2100);
// 顶墙：两条水平细带
fillRect(img, 1000, 299, 2810, 301);
fillRect(img, 1000, 309, 2810, 311);
// 底墙
fillRect(img, 1000, 2099, 2810, 2101);
fillRect(img, 1000, 2109, 2810, 2111);
// 斜墙（45°方向，短，只是验证非水平/竖直角度不会崩溃/不会被误当成上面四面墙的一部分）
drawThickLine(img, 100, 100, 260, 260, 2);
drawThickLine(img, 112, 88, 272, 248, 2);

function assert(cond, msg) {
  if (!cond) throw new Error("断言失败: " + msg);
  console.log("✓ " + msg);
}
function approx(a, b, tol, label) {
  assert(Math.abs(a - b) <= tol, `${label}: 期望≈${b}，实际${a.toFixed(2)}（容差${tol}）`);
}
function wallLen(w) {
  return Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
}
function wallAngleDeg(w) {
  let a = (Math.atan2(w.y2 - w.y1, w.x2 - w.x1) * 180) / Math.PI;
  if (a < 0) a += 180;
  if (a >= 180) a -= 180;
  return a;
}

const segments = detectRasterSegments(img);
console.log(`原始线段 ${segments.length} 条`);
assert(segments.length > 0, "Sobel + 方向分桶找到了原始线段");

const candidates = detectWallCandidates(segments);
console.log(JSON.stringify(candidates, null, 2));

const horizontal = candidates.filter((w) => Math.abs(wallAngleDeg(w)) < 5 && w.w < 30);
const vertical = candidates.filter((w) => Math.abs(wallAngleDeg(w) - 90) < 5 && w.w < 30);
const diagonal = candidates.filter((w) => Math.abs(wallAngleDeg(w) - 45) < 10);

assert(horizontal.length === 2, `找到顶墙+底墙共 2 面水平墙，实际 ${horizontal.length}`);
assert(vertical.length === 2, `找到左墙+右墙共 2 面竖直墙，实际 ${vertical.length}`);
assert(diagonal.length === 1, `找到那面 45° 斜墙（验证非水平/竖直角度也能被分桶识别配对），实际 ${diagonal.length}`);
assert(candidates.length === 5, `一共识别出 5 面墙（4 面直角墙 + 1 面斜墙，没有把对面墙误配对成一面），实际 ${candidates.length} 面`);

for (const w of [...horizontal, ...vertical]) approx(w.w, 10, 4, "配对墙厚度（两条细带间距≈10px，栅格分桶本身有量化误差，容差稍放宽）");
for (const w of horizontal) approx(wallLen(w), 1810, 30, "水平墙长度（细带范围 1000→2810）");
for (const w of vertical) approx(wallLen(w), 1800, 30, "竖直墙长度（细带范围 300→2100）");
approx(wallLen(diagonal[0]), 226, 20, "斜墙长度");

console.log("\n全部通过：栅格图边缘识别 + 墙体配对管线验证 OK。");
