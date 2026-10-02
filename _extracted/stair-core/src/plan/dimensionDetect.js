// 把 OCR 识别出的文字（比如图纸上写的"2400"或"2400mm"）跟画面上检测到的直线段匹配起来，
// 猜出"这条线代表这个数字标注的真实距离"，从而算出像素→毫米的比例——不用再手动点两个点、
// 手动输入已知距离，直接把图纸上现成的标注数字读出来用。
// 纯数组运算（不依赖 DOM/OCR 引擎本身），可以在 Node 里用手造的 words/segments 直接单测，
// 真正跑 OCR（tesseract.js）和取像素数据的部分在 pdfWalls.js 里。

const MIN_DIM_MM = 200; // 比这个还小的数字大概率不是尺寸标注（门编号、轴线号之类的短数字）
const MAX_DIM_MM = 30000; // 比这个还大的数字大概率不是单段尺寸标注（可能是总长/面积之类的）

/* 解析类似 "2400"、"2400mm"、"2.4m"、"240cm" 这样的文字，返回换算成毫米后的数值；
   不认识的格式（比如英制的 12'-6" ，或者带汉字/其它符号的）返回 null。
   没写单位时按毫米算——常见于建筑图纸的公制标注习惯（数字本身已经是 mm）。 */
export function parseDimensionValueMm(text) {
  const m = String(text)
    .trim()
    .match(/^(\d[\d,]*(?:\.\d+)?)\s*(mm|cm|m)?$/i);
  if (!m) return null;
  const raw = parseFloat(m[1].replace(/,/g, ""));
  if (!isFinite(raw) || raw <= 0) return null;
  const unit = (m[2] || "mm").toLowerCase();
  const mmValue = unit === "m" ? raw * 1000 : unit === "cm" ? raw * 10 : raw;
  if (mmValue < MIN_DIM_MM || mmValue > MAX_DIM_MM) return null;
  return mmValue;
}

function pointToSegmentDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-9) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

/* words：OCR 识别出的文字，每个形如 {text, bbox:{x0,y0,x1,y1}}（跟 tesseract.js 的输出格式一致）。
   segments：画面上检测到的直线段（跟 rasterWallDetect.js/pdfWallDetect.js 输出的线段同一种形状，
   这里要的是"配对成墙之前"的原始线段，因为尺寸线本身往往比墙短、独立于墙线存在）。
   给每个"看起来像尺寸标注"的文字找一条最近的、长度明显比文字本身大的线段，当成它对应的尺寸线，
   算出"这个数字的毫米值 / 这条线的像素长度"作为候选比例——不保证找到的就是真的尺寸线（有可能文字
   旁边刚好有一条无关的线），所以这里只产出"候选"，最终由用户点选确认哪一个可信。 */
export function matchDimensionCandidates(words, segments, opts = {}) {
  const { maxSearchDist = 80, minLenRatio = 2 } = opts;
  const candidates = [];
  let id = 0;
  for (const w of words) {
    const valueMm = parseDimensionValueMm(w.text);
    if (valueMm == null) continue;
    const cx = (w.bbox.x0 + w.bbox.x1) / 2, cy = (w.bbox.y0 + w.bbox.y1) / 2;
    const textSize = Math.max(w.bbox.x1 - w.bbox.x0, w.bbox.y1 - w.bbox.y0);
    let best = null, bestDist = Infinity;
    for (const s of segments) {
      const segLen = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
      if (segLen < textSize * minLenRatio) continue;
      const dist = pointToSegmentDist(cx, cy, s.x1, s.y1, s.x2, s.y2);
      if (dist > maxSearchDist || dist >= bestDist) continue;
      bestDist = dist;
      best = s;
    }
    if (!best) continue;
    const pixelLen = Math.hypot(best.x2 - best.x1, best.y2 - best.y1);
    if (pixelLen < 1e-6) continue;
    candidates.push({
      id: id++,
      text: w.text,
      valueMm,
      x: cx,
      y: cy,
      segX1: best.x1,
      segY1: best.y1,
      segX2: best.x2,
      segY2: best.y2,
      pixelLen,
      ratio: valueMm / pixelLen,
      dist: bestDist,
    });
  }
  return candidates;
}
