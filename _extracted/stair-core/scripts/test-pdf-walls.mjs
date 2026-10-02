// 手写一份最小的矢量 PDF（不依赖任何 PDF 生成库，字节完全自己拼），用来单测
// src/plan/pdfWallDetect.js 的墙体识别逻辑——这是唯一能在没有用户真实 CAD 图纸的情况下
// 验证"CTM 追踪 / Form XObject 嵌套变换 / 粗线直接当墙 / 细线配对成墙 / 曲线正确跳过"这几件事
// 确实按预期工作的办法。真实 CAD 导出的 PDF 图层习惯千差万别，这里只保证"管线本身是通的"，
// 阈值等参数还是要等拿到用户的真实文件后再调。
// Node 环境用 legacy 构建（主构建依赖浏览器 crypto/DOM API，在纯 Node 里跑不起来）；
// 两个构建共享同一套 OPS 数字编码，pdfWallDetect.js 内部用哪个构建的 OPS 常量不影响这里的验证。
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { extractStrokedSegments, detectWallCandidates, findColumnBoxes } from "../src/plan/pdfWallDetect.js";

function buildTestPdf() {
  // 主内容：外框四面墙——左右两面用两条平行细线画（配对识别），顶面用一条粗线画（线宽=墙厚，
  // 直接识别），底面也用两条平行细线；再加一段圆弧（模拟门的开启轨迹，不该被当成墙线段）；
  // 最后用 q/cm 嵌一个 Form XObject（模拟 CAD 图块），里面画一条粗线，经过一次真正的旋转+平移
  // 变换，用来验证 CTM 在 Form XObject 里也能正确合成。
  const content = `2 w
100 100 m
100 300 l
S
110 100 m
110 300 l
S
400 100 m
400 300 l
S
410 100 m
410 300 l
S
15 w
100 300 m
400 300 l
S
2 w
100 100 m
400 100 l
S
100 90 m
400 90 l
S
1 w
250 100 m
250 130 260 140 280 140 c
S
q
0.6 0.8 -0.8 0.6 500 50 cm
/Fx Do
Q
2 w
30 30 15 15 re
S
200 200 m
215 200 l
S
200 215 m
215 215 l
S
200 200 m
200 215 l
S
215 200 m
215 215 l
S
450 150 m
536.6 200 l
S
445 158.66 m
531.6 208.66 l
S
`;
  const form = `10 w
0 0 m
0 100 l
S
`;

  const enc = new TextEncoder();
  const parts = [];
  let offset = 0;
  const push = (str) => {
    const bytes = typeof str === "string" ? enc.encode(str) : str;
    parts.push(bytes);
    offset += bytes.length;
  };
  const offsets = [];
  const startObj = (n) => {
    offsets[n] = offset;
    push(`${n} 0 obj\n`);
  };

  push("%PDF-1.7\n");
  startObj(1);
  push("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  startObj(2);
  push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  startObj(3);
  push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 400] /Resources << /XObject << /Fx 5 0 R >> >> /Contents 4 0 R >>\nendobj\n");
  startObj(4);
  push(`<< /Length ${enc.encode(content).length} >>\nstream\n${content}endstream\nendobj\n`);
  startObj(5);
  push(
    `<< /Type /XObject /Subtype /Form /FormType 1 /BBox [-10 -10 10 110] /Matrix [1 0 0 1 0 0] /Resources << >> /Length ${enc.encode(form).length} >>\nstream\n${form}endstream\nendobj\n`
  );
  const xrefStart = offset;
  const n = 6;
  push(`xref\n0 ${n}\n`);
  push("0000000000 65535 f \n");
  for (let i = 1; i < n; i++) push(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`);

  const total = parts.reduce((a, b) => a + b.length, 0);
  const buf = new Uint8Array(total);
  let p = 0;
  for (const part of parts) {
    buf.set(part, p);
    p += part.length;
  }
  return buf;
}

function assert(cond, msg) {
  if (!cond) throw new Error("断言失败: " + msg);
  console.log("✓ " + msg);
}
function approx(a, b, tol, label) {
  assert(Math.abs(a - b) <= tol, `${label}: 期望≈${b}，实际${a}（容差${tol}）`);
}

const pdfBytes = buildTestPdf();
// WRITE_TEST_PDF=某路径 时把这份合成 PDF 落盘，方便在浏览器里手动上传验证 UI 链路（平时不写）
if (process.env.WRITE_TEST_PDF) (await import("node:fs")).writeFileSync(process.env.WRITE_TEST_PDF, pdfBytes);
const pdf = await getDocument({ data: pdfBytes }).promise;
const page = await pdf.getPage(1);
const RENDER_SCALE = 2;
const viewport = page.getViewport({ scale: RENDER_SCALE });
const opList = await page.getOperatorList();

const segments = extractStrokedSegments(opList, viewport);
assert(segments.length > 0, `解析出了线段（共 ${segments.length} 条），说明 getOperatorList 跑通了`);

// 柱子：一个 re 画的闭合小方框（15×15pt → 30×30px）+ 一个四条边各自单独描的小方框，两个都不该变成墙
const { columns, remaining } = findColumnBoxes(segments);
assert(columns.length === 2, `找到 2 个柱子（1 个 re 闭合方框 + 1 个四条散边方框），实际 ${columns.length} 个`);
for (const c of columns) {
  approx(c.w, 15 * RENDER_SCALE, 2, "柱子边长");
  approx(c.h, 15 * RENDER_SCALE, 2, "柱子另一边长");
}
assert(segments.length - remaining.length === 8, `两个柱子共 8 条边全部从待配对线段里拿掉，实际拿掉 ${segments.length - remaining.length} 条`);
const closedSegs = segments.filter((s) => s.closed);
assert(closedSegs.length === 4, `re 指令展开的 4 条边都带 closed 标记，实际 ${closedSegs.length} 条`);

const candidates = detectWallCandidates(segments);
console.log(JSON.stringify(candidates, null, 2));
assert(candidates.length === 6, `识别出 6 面墙（2 面粗线直接识别 + 3 面横平竖直的细线配对 + 1 面 30° 斜的细线配对；两个柱子都没变成墙），实际 ${candidates.length} 面`);

function wallLen(w) {
  return Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
}
function wallAngleDeg(w) {
  let a = (Math.atan2(w.y2 - w.y1, w.x2 - w.x1) * 180) / Math.PI;
  if (a < 0) a += 180;
  if (a >= 180) a -= 180;
  return a;
}

const horizontalThick = candidates.filter((w) => Math.abs(wallAngleDeg(w)) < 1 && w.w > 20);
assert(horizontalThick.length === 1, "找到顶部那面粗线水平墙（线宽本身=墙厚）");
approx(wallLen(horizontalThick[0]), 300 * RENDER_SCALE, 5, "顶部粗线墙长度");
approx(horizontalThick[0].w, 15 * RENDER_SCALE, 3, "顶部粗线墙厚度（=设置的线宽）");

// Form XObject 里画的是竖线（90°），cm 矩阵再转 atan2(0.8,0.6)=53.13° → PDF 里 143.13°，视口翻转 y 后 ≈36.9°
const diagonalThick = candidates.filter((w) => Math.abs(wallAngleDeg(w) - 36.87) < 1);
assert(diagonalThick.length === 1, "找到 Form XObject 里那面经过旋转变换的粗线墙");
approx(wallLen(diagonalThick[0]), 100 * RENDER_SCALE, 5, "Form XObject 墙长度（旋转不改变长度）");
approx(diagonalThick[0].w, 10 * RENDER_SCALE, 3, "Form XObject 墙厚度");

// 用户反馈"倾斜的线条被画成横平竖直"——这里专门放一面 30° 的斜墙（两条平行细线配对），验证矢量路线
// 从解析到配对到合并全程保持角度不变（PDF 里 +30°，视口翻转 y 后应为 150°），既不吸附到 0°/90°，长度也不变
const slanted = candidates.filter((w) => Math.abs(wallAngleDeg(w) - 150) < 1);
assert(slanted.length === 1, `找到那面 30° 斜墙且角度保持 150°±1°（实际各墙角度：${candidates.map((w) => wallAngleDeg(w).toFixed(1)).join(", ")}）`);
approx(wallLen(slanted[0]), 100 * RENDER_SCALE, 5, "斜墙长度（两条线各 100pt 长）");
approx(slanted[0].w, 10 * RENDER_SCALE, 3, "斜墙厚度（两条线法向间距 10pt）");

const paired = candidates.filter((w) => !horizontalThick.includes(w) && !diagonalThick.includes(w) && !slanted.includes(w));
assert(paired.length === 3, `找到左右两面竖墙 + 底部一面横墙，共 3 面配对识别出的墙，实际 ${paired.length} 面`);
for (const w of paired) approx(w.w, 10 * RENDER_SCALE, 3, "配对墙厚度（=两条线间距）");
const vertical = paired.filter((w) => Math.abs(wallAngleDeg(w) - 90) < 1);
assert(vertical.length === 2, "其中 2 面是竖直方向（左右墙）");
for (const w of vertical) approx(wallLen(w), 200 * RENDER_SCALE, 5, "左右墙长度");
const horizontalPaired = paired.filter((w) => Math.abs(wallAngleDeg(w)) < 1);
assert(horizontalPaired.length === 1, "其中 1 面是水平方向（底墙）");
approx(wallLen(horizontalPaired[0]), 300 * RENDER_SCALE, 5, "底墙长度");

// 宽度过滤：只留 25~35px（正好卡住顶部那面粗线墙 w≈30，排除掉 w≈20 的其它几面）
const filtered = detectWallCandidates(segments, { minW: 25, maxW: 35 });
assert(filtered.length === 1, `宽度过滤 [25,35] 应该只剩顶部那面粗线墙，实际 ${filtered.length} 面`);
approx(filtered[0].w, 30, 3, "过滤后剩下那面墙的厚度");

console.log("\n全部通过：PDF 矢量墙体识别管线（CTM 追踪 / Form XObject 变换合成 / 粗线直接识别 / 细线配对 / 曲线正确跳过 / 宽度过滤）验证 OK。");
