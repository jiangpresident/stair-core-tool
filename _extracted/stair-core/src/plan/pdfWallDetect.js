// 纯几何逻辑：把 pdf.js 的 getOperatorList() 结果还原成设备像素坐标系下的线段，再用启发式规则
// 识别出墙体候选。不依赖 DOM/canvas，可以在 Node 里直接单测（见 scripts/test-pdf-walls.mjs）。
// 浏览器专用的入口（渲染背景图、加载 worker）在同目录的 pdfWalls.js。
import { OPS } from "pdfjs-dist";

const THICK_STROKE_PX = 6; // 单条描边线宽 ≥ 这个像素数，直接当一整面墙（线宽本身就是墙厚，常见于"画中心线+设置线宽=墙厚"的 CAD 习惯）
const THIN_MAX_PX = THICK_STROKE_PX; // 小于这个线宽的当"细线"，要靠"两条平行线"配对识别成墙
const PAIR_MIN_GAP_PX = 5; // 两条细线配对成一面墙时，允许的最小间距——真实扫描件量出来墙线本身
// 只有约 6px 粗（栅格识别里"两条细线"其实是同一面实心墙带的两条边），门槛定太高（比如原来的
// 8px）会把真实的窄墙挡在外面；但定太低（比如 3px）又会把"同一条粗一点的线自己的两条边"误配
// 成一面独立的墙（一条 2~3px 粗的线，本身两条边缘间距也有 2~3px）。5px 是在这两头之间找的平衡点。
const PAIR_MAX_GAP_PX = 400; // 配对允许的最大间距（超过这个，大概率是房间两侧独立的墙，不是同一面墙的两条边）
const ANGLE_TOL_RAD = (2 * Math.PI) / 180; // 两条线夹角在这个容差内算"平行"（2°）
const MIN_OVERLAP_RATIO = 0.5; // 两条线在共同方向上的投影重叠长度，至少要达到较短那条线长度的这个比例，才配对
const MERGE_OFFSET_TOL_PX = 4; // 合并共线线段时，允许的垂直方向误差
const MERGE_GAP_TOL_PX = 20; // 合并共线线段时，允许的首尾间隙（同一面墙被画成好几段拼起来的情况）

const DRAW = { moveTo: 0, lineTo: 1, curveTo: 2, quadraticCurveTo: 3, closePath: 4 };
const STROKE_TERMINATORS = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);

/* PDF 仿射矩阵 [a,b,c,d,e,f]：x'=a*x+c*y+e, y'=b*x+d*y+f。
   composeMatrix(outer, inner) 表示"先套 inner，再套 outer"——用于 CTM 遇到 cm / Form XObject 矩阵时的合成，
   跟 PDF 规范里"cm 操作数在原 CTM 左边前乘"的语义一致（已用代数逐项验证过：
   applyPt(composeMatrix(m1,m2), p) === applyPt(m1, applyPt(m2, p))）。 */
export function composeMatrix(outer, inner) {
  return [
    outer[0] * inner[0] + outer[2] * inner[1],
    outer[1] * inner[0] + outer[3] * inner[1],
    outer[0] * inner[2] + outer[2] * inner[3],
    outer[1] * inner[2] + outer[3] * inner[3],
    outer[0] * inner[4] + outer[2] * inner[5] + outer[4],
    outer[1] * inner[4] + outer[3] * inner[5] + outer[5],
  ];
}
function applyPt(m, x, y) {
  return { x: x * m[0] + y * m[2] + m[4], y: x * m[1] + y * m[3] + m[5] };
}

/* 走一遍 getOperatorList() 的指令流，自己维护一个 CTM 栈（save/restore/transform，以及 Form XObject
   的 paintFormXObjectBegin/End——CAD 导出的"图块"经常是 Form XObject，语义上跟 save+cm+...+restore
   等价），把每条描边路径（m/l/c 组成、以 S 类指令结束）的线段还原成设备像素坐标系下的线段。
   曲线（c，圆弧/门的开启轨迹常这样画）只记录端点用于连接路径，不当墙线段收集——门的识别留到下一步。 */
export function extractStrokedSegments(opList, viewport) {
  const { fnArray, argsArray } = opList;
  const segments = [];
  let ctm = viewport.transform.slice();
  const stack = [];
  let lineWidth = 1;

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];
    if (fn === OPS.save) {
      stack.push(ctm);
    } else if (fn === OPS.restore) {
      ctm = stack.pop() || ctm;
    } else if (fn === OPS.transform) {
      ctm = composeMatrix(ctm, args);
    } else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      const matrix = args && args[0];
      if (matrix) ctm = composeMatrix(ctm, matrix);
    } else if (fn === OPS.paintFormXObjectEnd) {
      ctm = stack.pop() || ctm;
    } else if (fn === OPS.setLineWidth) {
      lineWidth = args[0];
    } else if (fn === OPS.constructPath) {
      const termOp = args[0];
      const buffer = args[1] && args[1][0];
      if (!buffer || !STROKE_TERMINATORS.has(termOp)) continue;
      const scale = Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]));
      const devW = Math.max(0.1, lineWidth * scale);
      let cur = null;
      let subStart = null;
      // 每条子路径（一个 m 开头到下一个 m 或结束）给一个 sub 编号，闭合（h 指令，或最后一个 l 回到起点）
      // 时把这条子路径上所有线段标 closed——柱子在 CAD 里通常是一个闭合的小矩形（re 指令被 pdf.js
      // 展开成 m/l/l/l/h），靠这个标记能在几何配对之前就把它认出来（见 findColumnBoxes）。
      let sub = -1;
      let subSegs = [];
      const markClosed = () => {
        for (const s of subSegs) s.closed = true;
      };
      for (let k = 0; k < buffer.length; ) {
        const code = buffer[k++];
        if (code === DRAW.moveTo) {
          const p = applyPt(ctm, buffer[k], buffer[k + 1]);
          k += 2;
          cur = p;
          subStart = p;
          sub++;
          subSegs = [];
        } else if (code === DRAW.lineTo) {
          const p = applyPt(ctm, buffer[k], buffer[k + 1]);
          k += 2;
          if (cur) {
            const seg = { x1: cur.x, y1: cur.y, x2: p.x, y2: p.y, w: devW, pathId: i, sub, closed: false };
            segments.push(seg);
            subSegs.push(seg);
            // 没有 h 指令、但最后一个 l 又画回了起点，也算闭合
            if (subStart && subSegs.length >= 3 && Math.hypot(p.x - subStart.x, p.y - subStart.y) < 0.5) markClosed();
          }
          cur = p;
        } else if (code === DRAW.curveTo) {
          const p = applyPt(ctm, buffer[k + 4], buffer[k + 5]);
          k += 6;
          cur = p; // 曲线只跳到终点，不当墙线段
        } else if (code === DRAW.quadraticCurveTo) {
          const p = applyPt(ctm, buffer[k + 2], buffer[k + 3]);
          k += 4;
          cur = p;
        } else if (code === DRAW.closePath) {
          if (cur && subStart) {
            const seg = { x1: cur.x, y1: cur.y, x2: subStart.x, y2: subStart.y, w: devW, pathId: i, sub, closed: false };
            segments.push(seg);
            subSegs.push(seg);
          }
          markClosed();
          cur = subStart;
        } else {
          break; // 遇到读不懂的编码，放弃这条路径剩下的部分，不要死循环
        }
      }
    }
  }
  return segments.filter((s) => Math.hypot(s.x2 - s.x1, s.y2 - s.y1) > 0.5);
}

const COLUMN_MAX_PX = 120; // 柱子的边长上限（像素）：再大的闭合矩形更可能是房间轮廓/家具/图框，不当柱子处理
const COLUMN_MAX_ASPECT = 2.5; // 柱子长宽比上限：真正的墙远比它的厚度长，长宽比 ≤2.5 的"短胖"矩形按柱子处理
const MIN_WALL_LEN_PER_W = 1.5; // 最终墙体候选的长度至少要是厚度的这个倍数，否则是柱子/配对碎片留下的假墙
const PERP_TOL = 0.15; // 判断两条线是否垂直时 |cos| 的容差

function segLen(s) {
  return Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
}
function unit(s) {
  const L = segLen(s) || 1;
  return { x: (s.x2 - s.x1) / L, y: (s.y2 - s.y1) / L };
}

/* 把"柱子"从线段里挑出来：用户实测发现小长方形/小正方形的柱子会被当成两面（互相垂直的）短墙——
   四条边两两平行、间距又在配对范围内，pairParallelSegments 天然会把它们配成两面墙。这里在配对之前
   先认出柱子并把它们的边整个拿掉，两种情况：
   1. 闭合的四边形（re 指令或 m/l/l/l/h 画的）：四条边、相邻垂直、对边平行、两个方向的边长都不超过
      COLUMN_MAX_PX、长宽比 ≤ COLUMN_MAX_ASPECT。
   2. 没闭合、四条边各自单独描的：两条平行线互相几乎完全重叠（≥80%）、各自长度都不超过间距的
      COLUMN_MAX_ASPECT 倍、也都不超过 COLUMN_MAX_PX——"短胖"到这个程度的平行对不可能是墙的两条边。
   代价是两个门洞之间很短的一截墙（长度 ≤2.5 倍厚度）也会被当柱子丢掉——这种极短的墙对疏散距离
   影响很小，用户手画补一笔更省事，比到处冒出来的假墙好处理得多。
   返回 { columns:[{cx,cy,w,h,angle}], remaining:[...没被认成柱子的线段] }。 */
export function findColumnBoxes(segments, { columnMaxPx = COLUMN_MAX_PX, maxAspect = COLUMN_MAX_ASPECT } = {}) {
  const consumed = new Set();
  const columns = [];
  const boxFromSides = (a, b) => {
    // a、b 是一对平行对边；用 a 的方向做局部坐标，算出中心、沿边长度、间距
    const u = unit(a);
    const n = { x: -u.y, y: u.x };
    const cA = a.x1 * n.x + a.y1 * n.y, cB = b.x1 * n.x + b.y1 * n.y;
    const ts = [a.x1 * u.x + a.y1 * u.y, a.x2 * u.x + a.y2 * u.y, b.x1 * u.x + b.y1 * u.y, b.x2 * u.x + b.y2 * u.y];
    const lo = Math.min(...ts), hi = Math.max(...ts);
    const cMid = (cA + cB) / 2, tMid = (lo + hi) / 2;
    return { cx: u.x * tMid + n.x * cMid, cy: u.y * tMid + n.y * cMid, w: hi - lo, h: Math.abs(cA - cB), angle: Math.atan2(u.y, u.x) };
  };

  // 1. 闭合四边形
  const byPath = new Map();
  for (const s of segments) {
    if (!s.closed || s.pathId == null) continue;
    const key = s.pathId + ":" + s.sub;
    if (!byPath.has(key)) byPath.set(key, []);
    byPath.get(key).push(s);
  }
  for (const group of byPath.values()) {
    if (group.length !== 4) continue;
    const lens = group.map(segLen);
    if (Math.max(...lens) > columnMaxPx || Math.max(...lens) / Math.min(...lens) > maxAspect) continue;
    const us = group.map(unit);
    // 相邻边垂直（|cos| 小）、对边平行（|cos| 大）——按画的顺序 0-1-2-3 相邻，0-2、1-3 相对
    const dot = (p, q) => Math.abs(us[p].x * us[q].x + us[p].y * us[q].y);
    if (dot(0, 1) > PERP_TOL || dot(1, 2) > PERP_TOL || dot(2, 3) > PERP_TOL || dot(3, 0) > PERP_TOL) continue;
    if (dot(0, 2) < 1 - PERP_TOL || dot(1, 3) < 1 - PERP_TOL) continue;
    for (const s of group) consumed.add(s);
    columns.push(boxFromSides(group[0], group[2]));
  }

  // 2. 没闭合的"短胖"平行对
  const rest = segments.filter((s) => !consumed.has(s));
  const short = rest.filter((s) => segLen(s) <= columnMaxPx);
  const angle = short.map(segAngle);
  for (let i = 0; i < short.length; i++) {
    if (consumed.has(short[i])) continue;
    const s = short[i];
    const u = unit(s);
    const n = { x: -u.y, y: u.x };
    const c0 = s.x1 * n.x + s.y1 * n.y;
    const L0 = segLen(s);
    for (let j = i + 1; j < short.length; j++) {
      if (consumed.has(short[j])) continue;
      const da = Math.abs(angle[j] - angle[i]);
      if (Math.min(da, Math.PI - da) > ANGLE_TOL_RAD) continue;
      const o = short[j];
      const gap = Math.abs(o.x1 * n.x + o.y1 * n.y - c0);
      if (gap < PAIR_MIN_GAP_PX || gap > columnMaxPx) continue;
      const L1 = segLen(o);
      if (L0 > maxAspect * gap || L1 > maxAspect * gap) continue; // 有一条明显比间距长得多 → 是墙的边，不是柱子
      const t0a = 0, t0b = (s.x2 - s.x1) * u.x + (s.y2 - s.y1) * u.y;
      const t1a = (o.x1 - s.x1) * u.x + (o.y1 - s.y1) * u.y, t1b = (o.x2 - s.x1) * u.x + (o.y2 - s.y1) * u.y;
      const overlap = Math.min(Math.max(t0a, t0b), Math.max(t1a, t1b)) - Math.max(Math.min(t0a, t0b), Math.min(t1a, t1b));
      if (overlap < 0.8 * Math.max(L0, L1)) continue; // 两条边要几乎完全对齐，错开的不是同一个柱子
      consumed.add(s);
      consumed.add(o);
      columns.push(boxFromSides(s, o));
      break;
    }
  }
  // 同一个柱子的两组对边会各报一次（一横一竖），按中心去重
  const dedup = [];
  for (const c of columns) if (!dedup.some((d) => Math.hypot(d.cx - c.cx, d.cy - c.cy) < 2)) dedup.push(c);
  return { columns: dedup, remaining: segments.filter((s) => !consumed.has(s)) };
}

function segAngle(s) {
  let a = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
  if (a < 0) a += Math.PI;
  if (a >= Math.PI) a -= Math.PI;
  return a;
}

/* 把方向、垂距都足够接近的线段合并成一条更长的（同一面墙被画成好几段拼接、或者门洞打断了墙线的情况）。
   做法：按角度分桶，桶内按"沿共同方向的投影区间"做区间合并（区间有重叠或间隙够小就并成一段）。 */
function mergeCollinear(segs, { angleTol = ANGLE_TOL_RAD, offsetTol = MERGE_OFFSET_TOL_PX, gapTol = MERGE_GAP_TOL_PX } = {}) {
  const bucketSize = angleTol;
  const buckets = new Map();
  for (const s of segs) {
    const a = segAngle(s);
    const key = Math.floor(a / bucketSize);
    for (const k of [key - 1, key, key + 1]) {
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(s);
    }
  }
  const merged = [];
  const consumed = new Set();
  let idCounter = 0;
  for (const s of segs) {
    if (consumed.has(s)) continue;
    const a = segAngle(s);
    const ux = Math.cos(a), uy = Math.sin(a);
    const nx = -uy, ny = ux;
    const c0 = s.x1 * nx + s.y1 * ny;
    const group = [s];
    consumed.add(s);
    const key = Math.floor(a / bucketSize);
    const candidates = new Set([...(buckets.get(key - 1) || []), ...(buckets.get(key) || []), ...(buckets.get(key + 1) || [])]);
    for (const other of candidates) {
      if (consumed.has(other)) continue;
      const da = Math.abs(segAngle(other) - a);
      if (Math.min(da, Math.PI - da) > angleTol) continue;
      const c1 = other.x1 * nx + other.y1 * ny;
      if (Math.abs(c1 - c0) > offsetTol) continue;
      group.push(other);
      consumed.add(other);
    }
    // 按"区间"（每条线段自己的两个端点投影出一个 [lo,hi]）合并，不是按"散点"合并——散点合并会把
    // 同一条线段自己的两个端点也当成"两个点之间的间隙"，在线段够长时把它错误地拆成两个退化的零长度点。
    const intervals = group.map((g) => {
      const t1 = (g.x1 - s.x1) * ux + (g.y1 - s.y1) * uy;
      const t2 = (g.x2 - s.x1) * ux + (g.y2 - s.y1) * uy;
      return t1 <= t2
        ? { lo: t1, hi: t2, pLo: { x: g.x1, y: g.y1 }, pHi: { x: g.x2, y: g.y2 } }
        : { lo: t2, hi: t1, pLo: { x: g.x2, y: g.y2 }, pHi: { x: g.x1, y: g.y1 } };
    });
    intervals.sort((p, q) => p.lo - q.lo);
    let run = intervals[0];
    const maxW = Math.max(...group.map((g) => g.w || 0));
    for (let i = 1; i < intervals.length; i++) {
      const nxt = intervals[i];
      if (nxt.lo - run.hi > gapTol) {
        merged.push({ id: idCounter++, x1: run.pLo.x, y1: run.pLo.y, x2: run.pHi.x, y2: run.pHi.y, w: maxW });
        run = nxt;
      } else if (nxt.hi > run.hi) {
        run = { lo: run.lo, hi: nxt.hi, pLo: run.pLo, pHi: nxt.pHi };
      }
    }
    merged.push({ id: idCounter++, x1: run.pLo.x, y1: run.pLo.y, x2: run.pHi.x, y2: run.pHi.y, w: maxW });
  }
  return merged;
}

/* 细线两两配对成墙：角度接近（平行）、垂直间距落在 [PAIR_MIN_GAP_PX, PAIR_MAX_GAP_PX]、且在共同方向上
   的投影有足够重叠，就认为是同一面墙的两条边线；中线 = 两条线各自的重叠投影区间沿法线方向居中，
   厚度 = 垂直间距。贪心：按重叠长度从大到小配对，每条线段最多只参与一次配对。 */
function pairParallelSegments(segs) {
  const n = segs.length;
  const angle = segs.map(segAngle);
  const pairs = [];
  for (let i = 0; i < n; i++) {
    const ai = angle[i];
    const ux = Math.cos(ai), uy = Math.sin(ai);
    const nx = -uy, ny = ux;
    for (let j = i + 1; j < n; j++) {
      const da = Math.abs(angle[j] - ai);
      if (Math.min(da, Math.PI - da) > ANGLE_TOL_RAD) continue;
      const s = segs[i], o = segs[j];
      const c0 = s.x1 * nx + s.y1 * ny;
      const c1 = o.x1 * nx + o.y1 * ny;
      const gap = Math.abs(c1 - c0);
      if (gap < PAIR_MIN_GAP_PX || gap > PAIR_MAX_GAP_PX) continue;
      const t0a = 0, t0b = (s.x2 - s.x1) * ux + (s.y2 - s.y1) * uy;
      const t1a = (o.x1 - s.x1) * ux + (o.y1 - s.y1) * uy, t1b = (o.x2 - s.x1) * ux + (o.y2 - s.y1) * uy;
      const lo0 = Math.min(t0a, t0b), hi0 = Math.max(t0a, t0b);
      const lo1 = Math.min(t1a, t1b), hi1 = Math.max(t1a, t1b);
      const overlap = Math.min(hi0, hi1) - Math.max(lo0, lo1);
      if (overlap <= 0) continue;
      const shorter = Math.min(hi0 - lo0, hi1 - lo1);
      if (shorter <= 0 || overlap / shorter < MIN_OVERLAP_RATIO) continue;
      pairs.push({ i, j, overlap, gap, ux, uy, nx, ny, lo: Math.max(lo0, lo1), hi: Math.min(hi0, hi1), base: s });
    }
  }
  pairs.sort((a, b) => b.overlap - a.overlap);
  const used = new Set();
  const walls = [];
  let idCounter = 0;
  for (const p of pairs) {
    if (used.has(p.i) || used.has(p.j)) continue;
    used.add(p.i);
    used.add(p.j);
    const s = segs[p.i], o = segs[p.j];
    const p1x = p.base.x1 + p.ux * p.lo, p1y = p.base.y1 + p.uy * p.lo;
    const p2x = p.base.x1 + p.ux * p.hi, p2y = p.base.y1 + p.uy * p.hi;
    // 中线要落在两条线正中间，不是直接沿用 base 那条线自己的位置
    const cS = s.x1 * p.nx + s.y1 * p.ny, cO = o.x1 * p.nx + o.y1 * p.ny;
    const cMid = (cS + cO) / 2;
    const shift = cMid - (p.base.x1 * p.nx + p.base.y1 * p.ny);
    walls.push({ id: idCounter++, x1: p1x + p.nx * shift, y1: p1y + p.ny * shift, x2: p2x + p.nx * shift, y2: p2y + p.ny * shift, w: p.gap });
  }
  return walls;
}

/* 入口：原始描边线段 → 墙体候选。分两条路：线宽本身够粗的单线直接当墙；细线走"两条平行线配对"。
   两边分别先做一次共线合并（同一面墙被断成好几段的情况），配对完的结果再合并一次（去掉配对产生的碎片重复）。
   可选的 minW/maxW（像素）在最后按识别出来的墙厚过滤一遍——家具、文字、尺寸标注线这些噪点通常比真正的
   墙线细很多，用户在界面上拖滑块限定一个宽度范围，就能把这些噪点筛掉，不用改动上面的识别算法本身。 */
export function detectWallCandidates(segments, opts = {}) {
  const { minW = 0, maxW = Infinity, excludeColumns = true } = opts;
  // 先把柱子（小闭合矩形 / 短胖平行对）整个拿掉，不然它们的对边会被下面的配对当成两面互相垂直的短墙
  const base = excludeColumns ? findColumnBoxes(segments).remaining : segments;
  const thick = base.filter((s) => s.w >= THICK_STROKE_PX);
  const thin = base.filter((s) => s.w < THIN_MAX_PX);
  const thickWalls = mergeCollinear(thick);
  const thinMerged = mergeCollinear(thin, { offsetTol: 1.5 }); // 细线合并容差更紧，避免把本该配对的两条边线揉成一条
  const pairedWalls = pairParallelSegments(thinMerged);
  const pairedMerged = mergeCollinear(pairedWalls);
  let id = 0;
  return [...thickWalls, ...pairedMerged]
    // 比自己厚度还短（或差不多短）的"墙"不是墙：贴着墙的柱子外边跟墙的另一面配对、配对碎片等都会留下这种东西
    .filter((w) => segLen(w) >= MIN_WALL_LEN_PER_W * w.w)
    .filter((w) => w.w >= minW && w.w <= maxW)
    .map((w) => ({ id: id++, x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2, w: w.w }));
}
