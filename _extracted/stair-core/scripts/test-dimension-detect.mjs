// 单测 src/plan/dimensionDetect.js：手造一批 OCR 文字（跟 tesseract.js 输出同样的
// {text, bbox} 形状）和线段，不需要真的跑 OCR，验证"数字解析"和"文字↔线段匹配"这两件事。
import { parseDimensionValueMm, matchDimensionCandidates } from "../src/plan/dimensionDetect.js";

function assert(cond, msg) {
  if (!cond) throw new Error("断言失败: " + msg);
  console.log("✓ " + msg);
}
function approx(a, b, tol, label) {
  assert(Math.abs(a - b) <= tol, `${label}: 期望≈${b}，实际${a}（容差${tol}）`);
}

// --- parseDimensionValueMm ---
approx(parseDimensionValueMm("2400"), 2400, 0, "裸数字按毫米算");
approx(parseDimensionValueMm("2400mm"), 2400, 0, "带 mm 单位");
approx(parseDimensionValueMm("2.4m"), 2400, 0, "带 m 单位换算成毫米");
approx(parseDimensionValueMm("240cm"), 2400, 0, "带 cm 单位换算成毫米");
approx(parseDimensionValueMm("1,200"), 1200, 0, "带千分位逗号");
assert(parseDimensionValueMm("12") === null, "太小的数字（比如门编号）应该被过滤掉");
assert(parseDimensionValueMm("209m²") === null, "带面积单位的不是长度标注，应该被过滤掉");
assert(parseDimensionValueMm("Lobby") === null, "非数字文字应该返回 null");
assert(parseDimensionValueMm("12'-6\"") === null, "英制格式暂不支持，应该返回 null（不是崩溃）");

// --- matchDimensionCandidates ---
// 场景：一条尺寸线从 (100,500) 到 (340,500)，长 240 px；文字"2400"写在线的正上方 (220,485)。
// 附近还有一条不相关的短线（模拟刻度/箭头），和一条离得较远的长线（不该被匹配到）。
const words = [
  { text: "2400", bbox: { x0: 205, y0: 478, x1: 235, y1: 492 } },
  { text: "Lobby", bbox: { x0: 50, y0: 50, x1: 100, y1: 65 } }, // 非数字，不该产生候选
  { text: "12", bbox: { x0: 400, y0: 400, x1: 415, y1: 415 } }, // 数字太小，不该产生候选
];
const segments = [
  { x1: 100, y1: 500, x2: 340, y2: 500, w: 1 }, // 真正的尺寸线
  { x1: 210, y1: 490, x2: 215, y2: 495, w: 1 }, // 旁边的小刻度/箭头，太短，不该被选中
  { x1: 600, y1: 600, x2: 900, y2: 600, w: 1 }, // 离得远的无关长线
];

const candidates = matchDimensionCandidates(words, segments);
console.log(JSON.stringify(candidates, null, 2));
assert(candidates.length === 1, `只有"2400"这一个词产生候选，实际 ${candidates.length} 个`);
const c = candidates[0];
assert(c.text === "2400", "候选对应的文字是 2400");
approx(c.valueMm, 2400, 0, "候选的毫米值");
approx(c.pixelLen, 240, 0.5, "匹配到的线段像素长度");
approx(c.ratio, 10, 0.1, "算出来的比例（10 mm/px）");
approx(c.segX1, 100, 0.5, "匹配到的是真正的尺寸线，不是旁边的小刻度或远处的无关线");

console.log("\n全部通过：标注数字识别 + 尺寸线匹配逻辑验证 OK。");
