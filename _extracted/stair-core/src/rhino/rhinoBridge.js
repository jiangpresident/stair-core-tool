// 网页 ↔ Rhino 的客户端（纯逻辑，不碰 DOM，Node 里可单测：scripts/test-rhino-bridge.mjs）。
// Rhino 那边跑的是 rhino/StairCoreBridge.py（项目根目录），在本机 127.0.0.1:8790 监听（被占就 8791…8799，
// 每个 Rhino 窗口一个端口，scanRhino 把在线的都列出来让用户选连哪个文件）：
//   GET /health → Rhino 版本 / 当前文档(名、路径) / 单位 / 端口；GET /layers、/cores?layer=、/recent；
//   POST /open {path}、POST /open-dialog → 在那个 Rhino 窗口里换文件；POST /bake → 把盒子列表烘焙成 Brep。
// 几何不在这里算：调用方把 buildSolids() 的结果（毫米、z 朝上的盒子列表，跟网页三维模型同一份数据）传进来，
// 这里只负责整理成 payload 和收发。
import { t } from "../i18n.js";
import { PLAN_DEFAULTS } from "../plan/planFile.js";

export const RHINO_URL = "http://127.0.0.1:8790";
export const RHINO_SCRIPT_PATH = "rhino/StairCoreBridge.py";
export const RHINO_NOT_RUNNING_HINT = t("连不上 Rhino（127.0.0.1:8790）——先在 Rhino 里运行项目根目录的 {0}（Rhino 8：ScriptEditor 打开并运行；Rhino 7：EditPythonScript），再点一次「连接 Rhino」", [RHINO_SCRIPT_PATH]);

/* 把 buildSolids() 的输出整理成发给 Rhino 的 payload。
   kinds：要发的盒子类别（默认全部：step / landing / slab / wall / centerWall / door）；
   origin：整体平移（毫米），把核心筒放到 Rhino 模型里想要的位置；replace：先删掉 Rhino 里同名的上一批。 */
export function buildRhinoPayload(model, { name = "StairCore", kinds = null, origin = { x: 0, y: 0, z: 0 }, replace = true } = {}) {
  const all = Array.isArray(model && model.boxes) ? model.boxes : [];
  const want = kinds ? new Set(kinds) : null;
  const boxes = all
    .filter((b) => (want ? want.has(b.kind) : true))
    .map((b) => ({ x1: b.x1, y1: b.y1, z1: b.z1, x2: b.x2, y2: b.y2, z2: b.z2, kind: b.kind, stair: b.stair || 0 }));
  const counts = {};
  for (const b of boxes) counts[b.kind] = (counts[b.kind] || 0) + 1;
  return {
    name,
    units: "mm",
    replace,
    origin: { x: Number(origin.x) || 0, y: Number(origin.y) || 0, z: Number(origin.z) || 0 },
    boxes,
    meta: { innerL: model && model.innerL, innerW: model && model.innerW, from: model && model.from, to: model && model.to, counts },
  };
}

/* ---------- 多个 Rhino 窗口：扫描 8790–8799，每个在线的桥就是一个可选的实例（各自对应一个打开的文件） ---------- */
export const RHINO_PORTS = Array.from({ length: 10 }, (_, i) => 8790 + i);
export const rhinoUrl = (port) => "http://127.0.0.1:" + port;

async function fetchWithTimeout(f, url, init, ms) {
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = setTimeout(() => ctl && ctl.abort(), ms);
  try {
    return await f(url, ctl ? { ...init, signal: ctl.signal } : init);
  } finally {
    clearTimeout(timer);
  }
}

/* 返回在线实例列表 [{port, baseUrl, rhino, doc, docPath, units, pid, features, ...}]，按端口升序；没有就是 []。 */
export async function scanRhino({ fetch: fetchImpl, ports = RHINO_PORTS, timeoutMs = 1500 } = {}) {
  const f = fetchImpl || globalThis.fetch;
  const found = await Promise.all(
    ports.map(async (port) => {
      try {
        const res = await fetchWithTimeout(f, rhinoUrl(port) + "/health", { cache: "no-store" }, timeoutMs);
        if (!res.ok) return null;
        const j = await res.json();
        return j && j.ok ? { ...j, port, baseUrl: rhinoUrl(port) } : null;
      } catch {
        return null;
      }
    }),
  );
  return found.filter(Boolean);
}

/* Rhino 自己记录的"最近打开的文件"：[{path, name}] */
export async function listRecentFiles({ fetch: fetchImpl, baseUrl = RHINO_URL } = {}) {
  const f = fetchImpl || globalThis.fetch;
  let res;
  try {
    res = await f(baseUrl + "/recent", { cache: "no-store" });
  } catch {
    throw new Error(RHINO_NOT_RUNNING_HINT);
  }
  const j = await res.json().catch(() => null);
  if (!res.ok || !j || !j.ok) throw new Error(t("读取 Rhino 最近文件失败：{0}", [(j && j.error) || `HTTP ${res.status}`]));
  return j.files || [];
}

/* 让那个 Rhino 窗口打开指定的 .3dm。成功返回 {ok:true, doc, docPath, units, alreadyOpen?}；
   用户在 Rhino 里取消了"是否保存改动"时返回 {ok:false, cancelled:true}（不抛错）；其它失败抛错。 */
export async function openRhinoFile(path, { fetch: fetchImpl, baseUrl = RHINO_URL } = {}) {
  return postOpen("/open", { path }, fetchImpl, baseUrl);
}

/* 在 Rhino 里弹出"打开文件"对话框。用户取消返回 {ok:true, cancelled:true}。 */
export async function openRhinoFileDialog({ fetch: fetchImpl, baseUrl = RHINO_URL } = {}) {
  return postOpen("/open-dialog", {}, fetchImpl, baseUrl);
}

async function postOpen(route, body, fetchImpl, baseUrl) {
  const f = fetchImpl || globalThis.fetch;
  let res;
  try {
    res = await f(baseUrl + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new Error(RHINO_NOT_RUNNING_HINT);
  }
  const j = await res.json().catch(() => null);
  if (j && j.cancelled) return j;
  if (!res.ok || !j || !j.ok) throw new Error(t("在 Rhino 里打开文件失败：{0}", [(j && j.error) || `HTTP ${res.status}`]));
  return j;
}

export async function checkRhino({ fetch: fetchImpl, baseUrl = RHINO_URL } = {}) {
  const f = fetchImpl || globalThis.fetch;
  try {
    const res = await f(baseUrl + "/health", { cache: "no-store" });
    if (!res.ok) return { ok: false, error: t("Rhino 桥返回 {0}", [res.status]) };
    const j = await res.json();
    return j && j.ok ? j : { ok: false, error: t("Rhino 桥返回的数据不对") };
  } catch {
    return { ok: false, error: RHINO_NOT_RUNNING_HINT, offline: true };
  }
}

/* ---------- 反向：从 Rhino 读用户自己画的核心筒长方体 ---------- */
export async function listRhinoLayers({ fetch: fetchImpl, baseUrl = RHINO_URL } = {}) {
  const f = fetchImpl || globalThis.fetch;
  let res;
  try {
    res = await f(baseUrl + "/layers", { cache: "no-store" });
  } catch {
    throw new Error(RHINO_NOT_RUNNING_HINT);
  }
  const j = await res.json().catch(() => null);
  if (!res.ok || !j || !j.ok) throw new Error(t("读取 Rhino 图层失败：{0}", [(j && j.error) || `HTTP ${res.status}`]));
  return j.layers || [];
}

/* 把 /layers 的扁平列表（path 用 "::" 分级，Rhino 的 FullPath）整理成树，给图层选择器画成 Rhino 图层面板那样的多级菜单。
   每个节点：{...原字段, name: 最后一级名字, children: [], childObjects: 所有子孙图层上的对象数}（读核心筒时含子图层，所以这个数有用）。
   父图层不在列表里（被删了等）的子图层当作根节点，顺序保持 Rhino 给的顺序。 */
export function buildLayerTree(layers) {
  const byPath = new Map();
  for (const l of layers || []) {
    const path = String(l.path || "");
    const parts = path.split("::");
    byPath.set(path, { ...l, path, name: parts[parts.length - 1], children: [], childObjects: 0 });
  }
  const roots = [];
  for (const node of byPath.values()) {
    const parts = node.path.split("::");
    const parent = parts.length > 1 ? byPath.get(parts.slice(0, -1).join("::")) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const total = (n) => {
    n.childObjects = n.children.reduce((sum, c) => sum + total(c), 0);
    return n.childObjects + (Number(n.objects) || 0);
  };
  roots.forEach(total);
  return roots;
}

/* 读某个图层上的长方体：返回 [{id,name,layer,type,centerX,centerY,length,width,angleDeg,zBottom,height}]，全部毫米。 */
export async function readRhinoCores(layer, { fetch: fetchImpl, baseUrl = RHINO_URL } = {}) {
  const f = fetchImpl || globalThis.fetch;
  let res;
  try {
    res = await f(baseUrl + "/cores?layer=" + encodeURIComponent(layer), { cache: "no-store" });
  } catch {
    throw new Error(RHINO_NOT_RUNNING_HINT);
  }
  const j = await res.json().catch(() => null);
  if (!res.ok || !j || !j.ok) throw new Error(t("读取核心筒失败：{0}", [(j && j.error) || `HTTP ${res.status}`]));
  return j.cores || [];
}

/* 读某个图层上的墙体：返回 {walls:[{id,name,layer,type,x1,y1,x2,y2,thickness|null,zBottom,height}], skipped}，全部毫米。
   直线 / 多段线按线段拆（thickness 为 null，网页用默认厚度）；Brep / 挤出体 / 网格按最小外接矩形取中线和厚度；弧线等跳过计入 skipped。 */
export async function readRhinoWalls(layer, { fetch: fetchImpl, baseUrl = RHINO_URL } = {}) {
  const f = fetchImpl || globalThis.fetch;
  let res;
  try {
    res = await f(baseUrl + "/walls?layer=" + encodeURIComponent(layer), { cache: "no-store" });
  } catch {
    throw new Error(RHINO_NOT_RUNNING_HINT);
  }
  const j = await res.json().catch(() => null);
  if (!res.ok || !j || !j.ok) throw new Error(t("读取墙体失败：{0}", [(j && j.error) || `HTTP ${res.status}`]));
  return { walls: j.walls || [], skipped: Number(j.skipped) || 0 };
}

/* ---------- Rhino → 平面图的坐标基准 ----------
   Rhino 世界坐标（毫米，y 朝上）→ 平面图 plan 坐标（毫米，SVG y 朝下）：planX = x − x0 + margin，planY = y0 − y + margin。
   基准 {x0, y0, margin} 存在 plan.rhinoFrame 里：第一次导入按这批几何的范围定（最左 / 最北贴着 1 m 边距），
   之后导入的墙 / 地板都用同一个基准，所以在平面图里位置互相对得上。新几何超出左边或上边时，基准往外挪，
   plan 里已有的东西（墙、核心筒、边界、路径、识别候选）整体平移同样的量——有底图时不平移（底图没法跟着挪），让它超出去。 */
const RHINO_MARGIN = 1000;

export function shiftPlan(plan, dx, dy) {
  if (!dx && !dy) return plan;
  const mv = (p) => (p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { ...p, x: p.x + dx, y: p.y + dy } : p);
  const seg = (w) => ({ ...w, x1: w.x1 + dx, y1: w.y1 + dy, x2: w.x2 + dx, y2: w.y2 + dy });
  return {
    ...plan,
    boundary: (plan.boundary || []).map(mv),
    cores: (plan.cores || []).map(mv),
    walls: (plan.walls || []).map(seg),
    wallCandidates: (plan.wallCandidates || []).map(seg),
    doorCandidates: (plan.doorCandidates || []).map(seg),
    stairCandidates: (plan.stairCandidates || []).map(mv),
    paths: (plan.paths || []).map((p) => (p.kind === "auto" ? { ...p, src: mv(p.src) } : { ...p, pts: (p.pts || []).map(mv) })),
  };
}

/* 给一批 Rhino 几何（范围 bbox，毫米）准备基准：返回 {plan（可能已整体平移）, toPlan(x,y)}。 */
function rhinoFrameFor(base, bbox) {
  let frame = base.rhinoFrame && Number.isFinite(base.rhinoFrame.x0) && Number.isFinite(base.rhinoFrame.y0) ? { margin: RHINO_MARGIN, ...base.rhinoFrame } : null;
  let plan = base;
  if (!frame) frame = { x0: bbox.minX, y0: bbox.maxY, margin: RHINO_MARGIN };
  else {
    const dx = Math.max(0, frame.x0 - bbox.minX); // 新几何比基准更靠左 / 更靠北多少
    const dy = Math.max(0, bbox.maxY - frame.y0);
    if ((dx || dy) && !base.bgSrc) {
      frame = { ...frame, x0: frame.x0 - dx, y0: frame.y0 + dy };
      plan = shiftPlan(base, dx, dy);
    }
  }
  const toPlan = (x, y) => ({ x: Math.round(x - frame.x0 + frame.margin), y: Math.round(frame.y0 - y + frame.margin) });
  return { plan: { ...plan, rhinoFrame: frame }, toPlan, margin: frame.margin };
}

/* 没有底图时把画布撑大到装得下这些点（按 mmPerPx 换算成"像素"尺寸）；有底图时不动。 */
function growCanvas(plan, pts, margin) {
  if (plan.bgSrc || !pts.length) return plan;
  const scale = Number(plan.mmPerPx) || 1;
  const maxX = Math.max(...pts.map((p) => p.x)), maxY = Math.max(...pts.map((p) => p.y));
  return {
    ...plan,
    naturalW: Math.max(Number(plan.naturalW) || 0, Math.ceil((maxX + margin) / scale)),
    naturalH: Math.max(Number(plan.naturalH) || 0, Math.ceil((maxY + margin) / scale)),
  };
}

const bboxOf = (pts) => ({ minX: Math.min(...pts.map((p) => p.x)), maxX: Math.max(...pts.map((p) => p.x)), minY: Math.min(...pts.map((p) => p.y)), maxY: Math.max(...pts.map((p) => p.y)) });

/* 纯逻辑：把 Rhino 里读到的墙加进平面图工具的 plan（用上面的共用基准）。厚度用 Rhino 给的（没有就 defaultT），夹到 40–600。
   返回新的 plan 对象（不改入参）。plan 可以是 null / 不完整（平面图页从没打开过），缺的字段用 PLAN_DEFAULTS 补。 */
export function wallsToPlan(walls, plan, { defaultT = 200 } = {}) {
  const base = { ...PLAN_DEFAULTS, ...(plan || {}) };
  const list = (walls || []).filter((w) => [w.x1, w.y1, w.x2, w.y2].every(Number.isFinite) && Math.hypot(w.x2 - w.x1, w.y2 - w.y1) > 1);
  if (!list.length) return { ...base, walls: [...(base.walls || [])] };
  const ends = list.flatMap((w) => [{ x: w.x1, y: w.y1 }, { x: w.x2, y: w.y2 }]);
  const { plan: framed, toPlan, margin } = rhinoFrameFor(base, bboxOf(ends));
  let nextId = Number.isFinite(framed.nextId) ? framed.nextId : 1;
  const added = list.map((w) => {
    const tRaw = Number.isFinite(w.thickness) && w.thickness > 0 ? w.thickness : defaultT;
    const a = toPlan(w.x1, w.y1), b = toPlan(w.x2, w.y2);
    const wall = { id: nextId++, x1: a.x, y1: a.y, x2: b.x, y2: b.y, t: Math.round(Math.min(600, Math.max(40, tRaw))) };
    if (w.name) wall.label = w.name;
    return wall;
  });
  const out = { ...framed, walls: [...(framed.walls || []), ...added], nextId };
  return growCanvas(out, added.flatMap((w) => [{ x: w.x1, y: w.y1 }, { x: w.x2, y: w.y2 }]), margin);
}

/* 读某个图层上的地板：返回 {floors:[{id,name,layer,type,closed,reason,outline:[[x,y]…],area(m²),holes,zBottom,thickness}]}，毫米。
   closed 为 false 的（不是封闭多重曲面）也在列表里，带 reason，让界面标红提示。 */
export async function readRhinoFloors(layer, { fetch: fetchImpl, baseUrl = RHINO_URL } = {}) {
  const f = fetchImpl || globalThis.fetch;
  let res;
  try {
    res = await f(baseUrl + "/floors?layer=" + encodeURIComponent(layer), { cache: "no-store" });
  } catch {
    throw new Error(RHINO_NOT_RUNNING_HINT);
  }
  const j = await res.json().catch(() => null);
  if (!res.ok || !j || !j.ok) throw new Error(t("读取地板失败：{0}", [(j && j.error) || `HTTP ${res.status}`]));
  return { floors: j.floors || [] };
}

/* 纯逻辑：把一块地板的轮廓（Rhino 毫米，[[x,y],…] 或 [{x,y},…]）设为平面图的楼层边界（替换原有边界），用共用基准。
   首尾重合的点去掉一个；少于 3 个点返回原 plan。 */
export function floorToPlan(outline, plan) {
  const base = { ...PLAN_DEFAULTS, ...(plan || {}) };
  let pts = (outline || []).map((p) => (Array.isArray(p) ? { x: p[0], y: p[1] } : { x: p && p.x, y: p && p.y })).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (pts.length > 1 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < 1) pts = pts.slice(0, -1);
  if (pts.length < 3) return base;
  const { plan: framed, toPlan, margin } = rhinoFrameFor(base, bboxOf(pts));
  const boundary = pts.map((p) => toPlan(p.x, p.y));
  return growCanvas({ ...framed, boundary }, boundary, margin);
}

/* 纯逻辑：把 Rhino 里读到的长方体（length ≥ width，毫米）和计算结果里各区段需要的核心筒外包尺寸比。
   zones：res.zones（每项 {from,to,count,totL,totW}）。长方体横放竖放都算（长对长、宽对宽），
   返回每个长方体对每个区段的判定：fits / 长边差多少 / 短边差多少。 */
export function checkCoreBoxes(boxes, zones, { tolerance = 0, perCore = 1 } = {}) {
  /* 一个核心筒不必装下区段里的全部楼梯（4 部疏散梯本来就要分散到几个核心筒），所以按"这个核心筒放 k 个梯井"算需要的外包：
       宽向 = 最宽的 k 个梯井内净宽之和 + (k+1) × 墙厚；梯段方向 = 最长梯井内净长 + 2 × 墙厚
     墙厚从区段的 totL 反推（totL = 最长内净长 + 2 × 墙）。zones 里没有 shafts（老数据 / 测试）时退化成"整个区段一个核心筒"。 */
  const zs = (zones || []).map((z) => {
    const shafts = Array.isArray(z.shafts) ? z.shafts.map((s) => ({ innerW: s.innerW, innerL: s.innerL, stairs: (s.stairs && s.stairs.length) || 1 })) : null;
    if (!shafts || !shafts.length) {
      return { from: z.from, to: z.to, count: z.count, n: 1, target: 1, need: () => ({ width: z.totW, length: z.totL, stairs: z.count }) };
    }
    const maxInnerL = Math.max(...shafts.map((s) => s.innerL));
    const wall = Math.max(0, (z.totL - maxInnerL) / 2);
    const widest = [...shafts].sort((a, b) => b.innerW - a.innerW);
    const need = (k) => {
      const pick = widest.slice(0, Math.max(0, k));
      return { width: pick.reduce((s, x) => s + x.innerW, 0) + (pick.length + 1) * wall, length: maxInnerL + 2 * wall, stairs: pick.reduce((s, x) => s + x.stairs, 0) };
    };
    return { from: z.from, to: z.to, count: z.count, n: shafts.length, target: Math.max(1, Math.min(Math.round(perCore) || 1, shafts.length)), need };
  });
  return (boxes || []).map((b) => {
    const L = Math.max(b.length, b.width), W = Math.min(b.length, b.width);
    const fitsSize = (need) => L + tolerance >= Math.max(need.width, need.length) && W + tolerance >= Math.min(need.width, need.length);
    const perZone = zs.map((z) => {
      let capacity = 0; // 这个长方体最多能放几个梯井（长宽都够）
      for (let k = 1; k <= z.n; k++) {
        if (fitsSize(z.need(k))) capacity = k;
        else break;
      }
      const req = z.need(z.target);
      const reqL = Math.max(req.width, req.length), reqW = Math.min(req.width, req.length);
      return {
        from: z.from, to: z.to, count: z.count, n: z.n, target: z.target,
        capacity, capacityStairs: capacity ? z.need(capacity).stairs : 0,
        reqWidth: req.width, reqLength: req.length, reqStairs: req.stairs,
        reqL, reqW, dL: L - reqL, dW: W - reqW,
        fits: z.n > 0 && capacity >= z.target,
      };
    });
    return { ...b, L, W, perZone, fitsAll: perZone.length > 0 && perZone.every((p) => p.fits) };
  });
}

export async function sendToRhino(payload, { fetch: fetchImpl, baseUrl = RHINO_URL } = {}) {
  const f = fetchImpl || globalThis.fetch;
  let res;
  try {
    res = await f(baseUrl + "/bake", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  } catch {
    throw new Error(RHINO_NOT_RUNNING_HINT);
  }
  const j = await res.json().catch(() => null);
  if (!res.ok || !j || !j.ok) throw new Error(t("Rhino 烘焙失败：{0}", [(j && j.error) || `HTTP ${res.status}`]));
  return j;
}
