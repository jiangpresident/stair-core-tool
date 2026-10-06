// Rhino 桥客户端（src/rhino/rhinoBridge.js）的回归测试：不需要 Rhino，用假 fetch 冒充桥接脚本。
// 验证 payload 整理（类别过滤、原点平移字段、计数、毫米单位）、health 的在线/离线/异常返回、bake 的请求形状与错误翻译。
import assert from "node:assert/strict";
import { buildRhinoPayload, checkRhino, sendToRhino, listRhinoLayers, readRhinoCores, readRhinoWalls, wallsToPlan, readRhinoFloors, floorToPlan, shiftPlan, matchCoreDoors, coresToPlan, checkCoreBoxes, buildLayerTree, scanRhino, listRecentFiles, openRhinoFile, openRhinoFileDialog, rhinoUrl, RHINO_PORTS, RHINO_URL, RHINO_NOT_RUNNING_HINT, pageMayBeBlocked } from "../src/rhino/rhinoBridge.js";

let passed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log("  ✓ " + name);
  } catch (err) {
    console.error("  ✗ " + name);
    console.error(err);
    process.exitCode = 1;
  }
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

const model = {
  innerL: 6000, innerW: 3000, from: 1, to: 4,
  boxes: [
    { x1: 0, x2: 280, y1: 0, y2: 1350, z1: 0, z2: 180, kind: "step", stair: 1 },
    { x1: 280, x2: 560, y1: 0, y2: 1350, z1: 180, z2: 360, kind: "step", stair: 1 },
    { x1: 4650, x2: 6000, y1: 0, y2: 3000, z1: 1800, z2: 1980, kind: "landing", stair: 1 },
    { x1: -300, x2: 6300, y1: -300, y2: 0, z1: 0, z2: 3800, kind: "wall", stair: 0 },
    { x1: -300, x2: 0, y1: 500, y2: 1450, z1: 0, z2: 2100, kind: "door", stair: 0 },
  ],
};

console.log("rhinoBridge");

await test("buildRhinoPayload：默认带全部盒子、毫米单位、计数、meta；kinds 过滤；origin 规整为数字", () => {
  const p = buildRhinoPayload(model, { name: "Core A" });
  assert.equal(p.units, "mm");
  assert.equal(p.name, "Core A");
  assert.equal(p.replace, true);
  assert.equal(p.boxes.length, 5);
  assert.deepEqual(p.meta.counts, { step: 2, landing: 1, wall: 1, door: 1 });
  assert.deepEqual(p.meta.innerL, 6000);
  assert.deepEqual(p.boxes[0], { x1: 0, y1: 0, z1: 0, x2: 280, y2: 1350, z2: 180, kind: "step", stair: 1 });
  const q = buildRhinoPayload(model, { kinds: ["step", "landing"], origin: { x: "1000", y: null, z: 250 }, replace: false });
  assert.equal(q.boxes.length, 3);
  assert.ok(q.boxes.every((b) => b.kind !== "wall" && b.kind !== "door"));
  assert.deepEqual(q.origin, { x: 1000, y: 0, z: 250 });
  assert.equal(q.replace, false);
  assert.deepEqual(buildRhinoPayload(null).boxes, []);
});

await test("checkRhino：在线返回桥的信息；非 ok / 非 200 / 连不上 各自有中文说明", async () => {
  const ok = await checkRhino({ fetch: async (u) => { assert.equal(u, RHINO_URL + "/health"); return json({ ok: true, app: "rhino", rhino: "8.12", doc: "test.3dm", units: "Millimeters" }); } });
  assert.equal(ok.ok, true);
  assert.equal(ok.rhino, "8.12");
  const notOk = await checkRhino({ fetch: async () => json({ ok: false }) });
  assert.equal(notOk.ok, false);
  assert.match(notOk.error, /数据不对/);
  const bad = await checkRhino({ fetch: async () => json({}, 500) });
  assert.match(bad.error, /返回 500/);
  const off = await checkRhino({ fetch: async () => { throw new TypeError("Failed to fetch"); } });
  assert.equal(off.offline, true);
  assert.equal(off.error, RHINO_NOT_RUNNING_HINT);
  assert.match(off.error, /StairCoreBridge\.py/);
});

await test("sendToRhino：POST /bake 带 JSON；成功返回桥的结果；桥报错 / 连不上 翻成中文", async () => {
  let got = null;
  const r = await sendToRhino(buildRhinoPayload(model), { fetch: async (u, init) => { got = { u, init }; return json({ ok: true, added: 5, layers: ["StairCore::StairCore::step #1"], units: "Millimeters" }); } });
  assert.equal(got.u, RHINO_URL + "/bake");
  assert.equal(got.init.method, "POST");
  assert.equal(got.init.headers["Content-Type"], "application/json");
  assert.equal(JSON.parse(got.init.body).boxes.length, 5);
  assert.equal(r.added, 5);
  await assert.rejects(sendToRhino(buildRhinoPayload(model), { fetch: async () => json({ ok: false, error: "units must be mm" }, 400) }), /烘焙失败：units must be mm/);
  await assert.rejects(sendToRhino(buildRhinoPayload(model), { fetch: async () => { throw new TypeError("x"); } }), (e) => e.message === RHINO_NOT_RUNNING_HINT);
});

await test("checkCoreBoxes：按'一个核心筒放 k 个梯井'算所需外包，报容量；横竖都算；老数据退化成整区段", () => {
  // 默认例子：折返梯，每个梯井内净 2850 × 5220，墙 300；L2 四部（totW 12900）、L3–L5 两部（totW 6600）
  const sh = { innerW: 2850, innerL: 5220, stairs: [{}] };
  const zones = [
    { from: 2, to: 2, count: 4, shafts: [sh, sh, sh, sh], totW: 12900, totL: 5820 },
    { from: 3, to: 5, count: 2, shafts: [sh, sh], totW: 6600, totL: 5820 },
  ];
  const boxes = [
    { id: "a", name: "big", length: 13000, width: 6000, angleDeg: 0 },
    { id: "b", name: "rotated-two", length: 7000, width: 6000, angleDeg: 30 }, // 放得下 2 个梯井（6600），放不下 3 个（9750）
    { id: "c", name: "swapped", length: 6000, width: 13000, angleDeg: 90 }, // length/width 反了也要认
    { id: "d", name: "tiny", length: 3000, width: 3000 },
  ];
  const r = checkCoreBoxes(boxes, zones); // 默认每个核心筒放 1 个梯井
  assert.deepEqual(r[0].perZone.map((z) => [z.capacity, z.n, z.fits]), [[4, 4, true], [2, 2, true]]);
  assert.deepEqual(r[0].perZone.map((z) => [z.reqWidth, z.reqLength]), [[3450, 5820], [3450, 5820]], "放 1 个梯井：2850 + 2×300");
  assert.equal(r[1].fitsAll, true, "7000×6000 放 1 个梯井当然够");
  assert.deepEqual(r[1].perZone.map((z) => z.capacity), [2, 2]);
  assert.equal(r[1].perZone[0].capacityStairs, 2);
  assert.equal(r[2].L, 13000, "长边取 max");
  assert.equal(r[2].perZone[0].capacity, 4);
  assert.equal(r[3].fitsAll, false);
  assert.deepEqual(r[3].perZone.map((z) => z.capacity), [0, 0]);
  // 目标改成每个核心筒放 2 个梯井：需 2×2850 + 3×300 = 6600 × 5820
  const r2 = checkCoreBoxes(boxes, zones, { perCore: 2 });
  assert.deepEqual(r2[1].perZone.map((z) => [z.reqWidth, z.reqLength, z.fits, z.dL, z.dW]), [[6600, 5820, true, 400, 180], [6600, 5820, true, 400, 180]]);
  // 目标 3：L2 需 3×2850 + 4×300 = 9750，7000 不够；L3–L5 只有 2 个梯井，目标被夹到 2 → 够
  const r3 = checkCoreBoxes(boxes, zones, { perCore: 3 });
  assert.deepEqual(r3[1].perZone.map((z) => [z.target, z.reqWidth, z.fits]), [[3, 9750, false], [2, 6600, true]]);
  assert.equal(r3[1].perZone[0].dL, 7000 - 9750);
  assert.equal(r3[1].fitsAll, false);
  // 剪刀梯：一个梯井两部楼梯，stairs 数按梯井累加
  const sc = { innerW: 3000, innerL: 7000, stairs: [{}, {}] };
  const rs = checkCoreBoxes([{ length: 7600, width: 3600 }], [{ from: 2, to: 5, count: 2, shafts: [sc], totW: 3600, totL: 7600 }]);
  assert.deepEqual([rs[0].perZone[0].capacity, rs[0].perZone[0].capacityStairs, rs[0].fitsAll], [1, 2, true]);
  // 没有 shafts 的老数据：整个区段当一个核心筒
  const old = checkCoreBoxes([{ length: 13000, width: 6000 }, { length: 7000, width: 6000 }], [{ from: 2, to: 4, count: 4, totW: 12900, totL: 5820 }]);
  assert.deepEqual(old.map((b) => b.fitsAll), [true, false]);
  assert.equal(checkCoreBoxes(boxes, []).every((b) => b.fitsAll === false), true, "没有区段时不算够");
  assert.equal(checkCoreBoxes([{ length: 3400, width: 5800 }], zones, { tolerance: 50 })[0].perZone[0].fits, true, "容差内算够");
});

await test("listRhinoLayers / readRhinoCores：请求地址（图层名 URL 编码）、返回解包、错误翻译", async () => {
  const calls = [];
  const fetch = async (u) => {
    calls.push(String(u));
    if (String(u).endsWith("/layers")) return json({ ok: true, layers: [{ path: "Core", objects: 2 }, { path: "Default", objects: 0 }] });
    return json({ ok: true, layer: "核心筒::A", units: "Meters", cores: [{ id: "x", name: "", length: 12900, width: 5820, angleDeg: 0, centerX: 0, centerY: 0, zBottom: 0, height: 20000, type: "Brep", layer: "核心筒::A" }] });
  };
  const layers = await listRhinoLayers({ fetch });
  assert.equal(layers.length, 2);
  const cores = await readRhinoCores("核心筒::A", { fetch });
  assert.equal(cores.length, 1);
  assert.equal(calls[1], RHINO_URL + "/cores?layer=" + encodeURIComponent("核心筒::A"));
  await assert.rejects(readRhinoCores("Nope", { fetch: async () => json({ ok: false, error: "layer not found: Nope" }, 404) }), /读取核心筒失败：layer not found/);
  await assert.rejects(listRhinoLayers({ fetch: async () => { throw new TypeError("x"); } }), (e) => e.message === RHINO_NOT_RUNNING_HINT);
});

await test("scanRhino：扫 8790–8799，连不上 / 非 ok / 超时的端口跳过，在线的带 port 与 baseUrl 按端口升序", async () => {
  assert.equal(RHINO_PORTS.length, 10);
  assert.equal(RHINO_PORTS[0], 8790);
  assert.equal(rhinoUrl(8793), "http://127.0.0.1:8793");
  const fetch = async (u, init) => {
    const port = Number(new URL(u).port);
    if (port === 8790) return json({ ok: true, rhino: "8.24", doc: "A.3dm", docPath: "C:\\x\\A.3dm", units: "Meters", features: ["open"] });
    if (port === 8792) return json({ ok: true, rhino: "8.24", doc: "B.3dm", docPath: "C:\\x\\B.3dm", units: "Millimeters" });
    if (port === 8795) return json({ ok: false });
    if (port === 8797) return new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")))); // 永不回应 → 靠超时
    throw new TypeError("Failed to fetch");
  };
  const found = await scanRhino({ fetch, timeoutMs: 50 });
  assert.deepEqual(found.map((i) => [i.port, i.doc, i.baseUrl]), [
    [8790, "A.3dm", "http://127.0.0.1:8790"],
    [8792, "B.3dm", "http://127.0.0.1:8792"],
  ]);
  assert.deepEqual(await scanRhino({ fetch: async () => { throw new TypeError("x"); } }), []);
});

await test("listRecentFiles / openRhinoFile / openRhinoFileDialog：走选中的实例地址；取消不抛错；失败翻成中文", async () => {
  const calls = [];
  const fetch = async (u, init) => {
    calls.push({ u: String(u), init });
    if (String(u).endsWith("/recent")) return json({ ok: true, files: [{ path: "C:\\x\\A.3dm", name: "A.3dm" }] });
    if (String(u).endsWith("/open")) {
      const body = JSON.parse(init.body);
      if (body.path === "C:\\x\\missing.3dm") return json({ ok: false, error: "file not found: C:\\x\\missing.3dm" }, 400);
      if (body.path === "C:\\x\\cancel.3dm") return json({ ok: false, cancelled: true, error: "Rhino did not open the file" }, 400);
      return json({ ok: true, doc: "A.3dm", docPath: body.path, units: "Meters" });
    }
    if (String(u).endsWith("/open-dialog")) return json({ ok: true, cancelled: true });
    throw new Error("unexpected " + u);
  };
  const base = "http://127.0.0.1:8792";
  const recent = await listRecentFiles({ fetch, baseUrl: base });
  assert.equal(recent.length, 1);
  assert.equal(calls[0].u, base + "/recent");
  const opened = await openRhinoFile("C:\\x\\A.3dm", { fetch, baseUrl: base });
  assert.equal(opened.ok, true);
  assert.equal(opened.docPath, "C:\\x\\A.3dm");
  assert.equal(calls[1].u, base + "/open");
  assert.equal(calls[1].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[1].init.body), { path: "C:\\x\\A.3dm" });
  const cancelled = await openRhinoFile("C:\\x\\cancel.3dm", { fetch, baseUrl: base });
  assert.equal(cancelled.cancelled, true, "用户在 Rhino 里取消保存询问：不抛错");
  await assert.rejects(openRhinoFile("C:\\x\\missing.3dm", { fetch, baseUrl: base }), /打开文件失败：file not found/);
  const dlg = await openRhinoFileDialog({ fetch, baseUrl: base });
  assert.equal(dlg.cancelled, true);
  assert.equal(calls.at(-1).u, base + "/open-dialog");
  await assert.rejects(openRhinoFileDialog({ fetch: async () => { throw new TypeError("x"); } }), (e) => e.message === RHINO_NOT_RUNNING_HINT);
});

await test("buildLayerTree：按 :: 分级成树、保持顺序、子孙对象数汇总、父层缺失的当根", () => {
  const tree = buildLayerTree([
    { path: "Default", objects: 0 },
    { path: "Core", objects: 1, color: "#2B5C8A" },
    { path: "Core::Core 1", objects: 2 },
    { path: "Core::Core 1::Deep", objects: 3 },
    { path: "Core::Core 2", objects: 0 },
    { path: "Columns", objects: 1 },
    { path: "Gone::Orphan", objects: 4 },
  ]);
  assert.deepEqual(tree.map((n) => n.name), ["Default", "Core", "Columns", "Orphan"]);
  const core = tree[1];
  assert.equal(core.color, "#2B5C8A");
  assert.deepEqual(core.children.map((c) => c.name), ["Core 1", "Core 2"]);
  assert.equal(core.children[0].children[0].path, "Core::Core 1::Deep");
  assert.equal(core.childObjects, 5, "Core 1(2) + Deep(3)");
  assert.equal(core.children[0].childObjects, 3);
  assert.equal(core.children[1].childObjects, 0);
  assert.equal(tree[3].path, "Gone::Orphan", "父层不在列表里：保留完整路径当根节点");
  assert.deepEqual(buildLayerTree([]), []);
  assert.deepEqual(buildLayerTree(null), []);
});

await test("readRhinoWalls / wallsToPlan：请求地址；追加进 plan 时平移到左上角、y 翻转、厚度默认与夹取、nextId 递增、画布撑大", async () => {
  const calls = [];
  const fetch = async (u) => {
    calls.push(String(u));
    return json({ ok: true, layer: "Walls", units: "Meters", skipped: 1, walls: [
      { id: "a", name: "north", type: "Curve", x1: 0, y1: 20000, x2: 30000, y2: 20000, thickness: null, zBottom: 0, height: 0 },
      { id: "b", name: "", type: "Brep", x1: 0, y1: 0, x2: 0, y2: 20000, thickness: 300, zBottom: 0, height: 3000 },
      { id: "c", name: "thin", type: "Brep", x1: 5000, y1: 5000, x2: 15000, y2: 5000, thickness: 10, zBottom: 0, height: 3000 },
      { id: "zero", type: "Curve", x1: 1, y1: 1, x2: 1, y2: 1 }, // 零长度：丢掉
    ] });
  };
  const r = await readRhinoWalls("Walls", { fetch, baseUrl: "http://127.0.0.1:8791" });
  assert.equal(calls[0], "http://127.0.0.1:8791/walls?layer=Walls");
  assert.equal(r.skipped, 1);
  assert.equal(r.walls.length, 4);
  const plan = { walls: [{ id: 7, x1: 0, y1: 0, x2: 100, y2: 0, t: 200 }], nextId: 8, naturalW: 20000, naturalH: 15000, bgSrc: null, mmPerPx: 1 };
  const out = wallsToPlan(r.walls, plan, { defaultT: 200 });
  assert.deepEqual(out.rhinoFrame, { x0: 0, y0: 20000, margin: 1000 }, "第一次导入记下基准");
  assert.equal(plan.walls.length, 1, "不改入参");
  assert.equal(out.walls.length, 4, "原 1 + 新 3（零长度丢掉）");
  assert.deepEqual(out.walls.slice(1).map((w) => w.id), [8, 9, 10]);
  assert.equal(out.nextId, 11);
  // Rhino (0,20000)-(30000,20000) 是最北的一条 → 翻转后贴着上边 margin
  assert.deepEqual([out.walls[1].x1, out.walls[1].y1, out.walls[1].x2, out.walls[1].y2, out.walls[1].t], [1000, 1000, 31000, 1000, 200]);
  assert.equal(out.walls[1].label, "north");
  // Rhino (0,0)-(0,20000) 竖墙 → 从下边(21000)到上边(1000)，厚 300
  assert.deepEqual([out.walls[2].x1, out.walls[2].y1, out.walls[2].x2, out.walls[2].y2, out.walls[2].t], [1000, 21000, 1000, 1000, 300]);
  assert.equal(out.walls[3].t, 40, "厚度夹到 40");
  assert.equal(out.naturalW, 32000, "30000 + 2×1000");
  assert.equal(out.naturalH, 22000, "20000 + 2×1000");
  const withBg = wallsToPlan(r.walls, { ...plan, bgSrc: "data:...", naturalW: 800, naturalH: 600, mmPerPx: 50 });
  assert.equal(withBg.naturalW, 800, "有底图时不动画布");
  const fromNothing = wallsToPlan(r.walls, null);
  assert.equal(fromNothing.walls.length, 3);
  assert.equal(fromNothing.cores.length, 0, "缺的字段用默认值补");
  assert.equal(wallsToPlan([], plan).walls.length, 1);
});

await test("共用基准：第二批几何沿用第一批的基准（位置对得上）；超出左/上边时基准外扩、已有内容整体平移；有底图不平移", () => {
  const first = wallsToPlan([{ x1: 0, y1: 0, x2: 10000, y2: 0 }], null);
  assert.deepEqual([first.walls[0].x1, first.walls[0].y1, first.walls[0].x2, first.walls[0].y2], [1000, 1000, 11000, 1000]);
  // 第二批在第一批右下方：同一基准，不平移
  const second = wallsToPlan([{ x1: 10000, y1: -5000, x2: 10000, y2: 0 }], first);
  assert.deepEqual(second.rhinoFrame, first.rhinoFrame);
  assert.deepEqual([second.walls[1].x1, second.walls[1].y1, second.walls[1].x2, second.walls[1].y2], [11000, 6000, 11000, 1000], "Rhino y=−5000 在南边 → 平面图 y 更大");
  assert.equal(second.naturalH, 15000, "画布只放大不缩小：需要 7000，默认 15000 已够");
  // 第三批更靠左（x=−3000）、更靠北（y=2000）：基准外扩，已有的墙整体平移 (+3000, +2000)
  const third = wallsToPlan([{ x1: -3000, y1: 2000, x2: 0, y2: 2000 }], second);
  assert.deepEqual(third.rhinoFrame, { x0: -3000, y0: 2000, margin: 1000 });
  assert.deepEqual([third.walls[0].x1, third.walls[0].y1], [4000, 3000], "第一面墙从 (1000,1000) 平移到 (4000,3000)");
  assert.deepEqual([third.walls[2].x1, third.walls[2].y1, third.walls[2].x2, third.walls[2].y2], [1000, 1000, 4000, 1000]);
  // shiftPlan 覆盖所有带坐标的东西
  const shifted = shiftPlan(
    { boundary: [{ x: 1, y: 2 }], cores: [{ x: 10, y: 20, l: 5, w: 3, doorLocal: { x: 0, y: 1 } }], walls: [{ x1: 0, y1: 0, x2: 1, y2: 1 }], wallCandidates: [{ x1: 0, y1: 0, x2: 1, y2: 1 }], doorCandidates: [], stairCandidates: [{ x: 5, y: 5, w: 1, h: 1 }], paths: [{ kind: "auto", src: { x: 1, y: 1 } }, { kind: "manual", pts: [{ x: 2, y: 2 }] }] },
    100,
    -50,
  );
  assert.deepEqual(shifted.boundary, [{ x: 101, y: -48 }]);
  assert.deepEqual([shifted.cores[0].x, shifted.cores[0].y, shifted.cores[0].doorLocal], [110, -30, { x: 0, y: 1 }], "核心筒门的局部坐标不动");
  assert.deepEqual(shifted.walls[0], { x1: 100, y1: -50, x2: 101, y2: -49 });
  assert.deepEqual(shifted.paths[0].src, { x: 101, y: -49 });
  assert.deepEqual(shifted.paths[1].pts, [{ x: 102, y: -48 }]);
  // 基准取整到 1 m：Rhino (1173, 40381) 的墙 → x0=1000, y0=41000 → 小数部分保留，1 m 网格对齐
  const snapped = wallsToPlan([{ x1: 1173, y1: 40381, x2: 40973, y2: 40381 }], null);
  assert.deepEqual(snapped.rhinoFrame, { x0: 1000, y0: 41000, margin: 1000 });
  assert.deepEqual([snapped.walls[0].x1, snapped.walls[0].y1], [1173, 1619]);
  // 有底图：基准不外扩、不平移，新墙允许落到负坐标
  const withBg = wallsToPlan([{ x1: -3000, y1: 0, x2: 0, y2: 0 }], { ...first, bgSrc: "data:..." });
  assert.deepEqual(withBg.rhinoFrame, first.rhinoFrame);
  assert.equal(withBg.walls[1].x1, -2000);
  assert.equal(withBg.walls[0].x1, 1000, "已有的墙没动");
});

await test("readRhinoFloors / floorToPlan：请求地址；封闭与否原样带回；轮廓按共用基准变成楼层边界，首尾重合点去掉；少于 3 点不动", async () => {
  const calls = [];
  const fetch = async (u) => {
    calls.push(String(u));
    return json({ ok: true, layer: "Floors", units: "Meters", floors: [
      { id: "s", name: "slab", type: "Extrusion", closed: true, reason: null, outline: [[0, 0], [30000, 0], [30000, 20000], [0, 20000], [0, 0]], area: 600, holes: 0, zBottom: -300, thickness: 300 },
      { id: "o", name: "open", type: "Brep", closed: false, reason: "open polysurface (5 faces, not closed)", outline: [[0, 0], [1, 0], [1, 1]], area: 0.5, holes: 0, zBottom: 0, thickness: 1 },
      { id: "m", name: "mesh", type: "Mesh", closed: false, reason: "not a polysurface (Mesh)", outline: [], area: null, holes: 0, zBottom: null, thickness: null },
    ] });
  };
  const r = await readRhinoFloors("Floors", { fetch, baseUrl: "http://127.0.0.1:8790" });
  assert.equal(calls[0], "http://127.0.0.1:8790/floors?layer=Floors");
  assert.deepEqual(r.floors.map((f) => f.closed), [true, false, false]);
  // 先导入墙（基准 x0=0, y0=20000），再把地板设为边界：角点和墙端点重合
  const withWalls = wallsToPlan([{ x1: 0, y1: 20000, x2: 30000, y2: 20000 }], null);
  const out = floorToPlan(r.floors[0].outline, withWalls);
  assert.equal(out.boundary.length, 4, "首尾重合的第 5 个点去掉");
  assert.deepEqual(out.boundary, [{ x: 1000, y: 21000 }, { x: 31000, y: 21000 }, { x: 31000, y: 1000 }, { x: 1000, y: 1000 }]);
  assert.deepEqual([out.walls[0].x1, out.walls[0].y1], [1000, 1000], "墙没动，且墙端点 = 边界角点");
  assert.deepEqual([out.naturalW, out.naturalH], [32000, 22000]);
  assert.deepEqual(floorToPlan([[0, 0], [1, 1]], withWalls).boundary, [], "少于 3 点：不改");
  assert.equal(floorToPlan(r.floors[0].outline, null).boundary.length, 4, "没有 plan 也能用");
});

await test("matchCoreDoors：门贴哪个核心筒的哪个面、在哪一层、哪一端；按参照层推应在的端；宽/高校核；缺门与游离的门", () => {
  // 核心筒 13000 × 6000，x 10000–23000，y 20000–26000，底 0 高 20000；楼面 L1 0 / L2 9000 / L3 13200 / L4 17000
  const core = { id: "core", name: "Core A", centerX: 16500, centerY: 23000, length: 13000, width: 6000, angleDeg: 0, zBottom: 0, height: 20000 };
  const levels = [{ level: 1, z: 0 }, { level: 2, z: 9000 }, { level: 3, z: 13200 }, { level: 4, z: 17000 }, { level: 5, z: 20800 }];
  const floorEnd = { 1: 0, 2: 1, 3: 0, 4: 1, 5: 0 };
  const door = (name, cx, cy, span, thick, z, h, angle = 90) => ({ id: name, name, centerX: cx, centerY: cy, length: span, width: thick, angleDeg: angle, zBottom: z, height: h });
  const doors = [
    door("L1 left", 9900, 21500, 1000, 200, 0, 2100), // 贴左端面（x=10000 外侧 200 厚），参照门
    door("L2 right", 23100, 21500, 1000, 200, 9000, 2100), // L2 平台换端 → 应在右端 ✓
    door("L3 wrong", 23100, 21500, 1000, 200, 13200, 2100), // L3 平台回到左端 → 应在左端 ✗
    door("L4 narrow low", 23100, 21500, 800, 200, 17000, 2000), // 端对，但宽 800 < 950、高 2000 < 2030
    door("side door", 16500, 19900, 1000, 200, 0, 2100, 0), // 贴长边（y=20000 外侧），u<0? 中心 u=0 → 端 1；楼层 L1（重复的门）
    door("far away", 40000, 40000, 1000, 200, 0, 2100), // 不贴任何核心筒
  ];
  const r = matchCoreDoors([core], doors, { levels, floorEnd, stairType: "dogleg", reqWidth: 950, reqHeight: 2030 });
  assert.equal(r.unattached.length, 1);
  assert.equal(r.unattached[0].name, "far away");
  const c = r.cores[0];
  assert.equal(c.doors.length, 5);
  assert.equal(c.refLevel, 1);
  assert.equal(c.refEnd, 0, "参照：L1 的门在 −x 端");
  const byName = Object.fromEntries(c.doors.map((d) => [d.name, d]));
  assert.deepEqual([byName["L1 left"].face, byName["L1 left"].level, byName["L1 left"].end, byName["L1 left"].ok], ["end", 1, 0, true]);
  assert.deepEqual([byName["L2 right"].level, byName["L2 right"].end, byName["L2 right"].expectedEnd, byName["L2 right"].endOk, byName["L2 right"].ok], [2, 1, 1, true, true]);
  assert.deepEqual([byName["L3 wrong"].level, byName["L3 wrong"].end, byName["L3 wrong"].expectedEnd, byName["L3 wrong"].endOk, byName["L3 wrong"].ok], [3, 1, 0, false, false]);
  assert.deepEqual([byName["L4 narrow low"].endOk, byName["L4 narrow low"].widthOk, byName["L4 narrow low"].heightOk, byName["L4 narrow low"].ok], [true, false, false, false]);
  assert.equal(byName["side door"].face, "side");
  assert.equal(byName["side door"].doorWidth, 1000, "门宽取水平长边");
  assert.deepEqual(c.missingLevels, [], "L1–L4 都有门；L5 楼面 20800 ≥ 核心筒顶 20000 不算");
  assert.equal(c.ok, false);
  // 少一层：去掉 L2 → missingLevels 含 2
  const r2 = matchCoreDoors([core], doors.filter((d) => d.name !== "L2 right"), { levels, floorEnd, reqWidth: 950, reqHeight: 2030 });
  assert.deepEqual(r2.cores[0].missingLevels, [2]);
  // 剪刀梯：不判断端
  const r3 = matchCoreDoors([core], doors, { levels, floorEnd, stairType: "scissor", reqWidth: 950, reqHeight: 2030 });
  assert.equal(r3.cores[0].doors.find((d) => d.name === "L3 wrong").endOk, null);
  // 核心筒转 30°：门也跟着转才算贴面
  const rot = { ...core, angleDeg: 30 };
  const rad = Math.PI / 6;
  const px = 16500 + (-6600) * Math.cos(rad), py = 23000 + (-6600) * Math.sin(rad); // 局部 (−6600, 0) → 贴 −x 端面外 100
  const r4 = matchCoreDoors([rot], [door("rot door", px, py, 1000, 200, 0, 2100, 120)], { levels, floorEnd });
  assert.equal(r4.unattached.length, 0);
  assert.deepEqual([r4.cores[0].doors[0].face, r4.cores[0].doors[0].end], ["end", 0]);
  // 楼层不明：门底在两层中间
  const r5 = matchCoreDoors([core], [door("mid", 9900, 21500, 1000, 200, 4500, 2100)], { levels, floorEnd });
  assert.equal(r5.cores[0].doors[0].level, null);
  assert.equal(r5.cores[0].doors[0].ok, false);
  // 门底 8000：能认出是 L2（9000）的门，但偏离楼面 −1000 → zOk=false、ok=false；偏 30 mm 在容差内算过
  const r6 = matchCoreDoors([core], [door("low door", 23100, 21500, 1000, 200, 8000, 2100), door("ok door", 9900, 21500, 1000, 200, 30, 2100)], { levels, floorEnd });
  const low = r6.cores[0].doors.find((d) => d.name === "low door"), okd = r6.cores[0].doors.find((d) => d.name === "ok door");
  assert.deepEqual([low.level, low.levelZ, low.zOffset, low.zOk, low.ok], [2, 9000, -1000, false, false]);
  assert.deepEqual([okd.level, okd.zOffset, okd.zOk], [1, 30, true]);
  assert.equal(byName["L1 left"].zOk, true);
});

await test("coresToPlan：核心筒按共用基准落到平面图（原点角、转角取负、门按最低层的门贴边并翻 y）；没门的默认左端中点；分配 shaftKey", () => {
  // 先导入墙定基准：x0=0, y0=30000
  const withWalls = wallsToPlan([{ x1: 0, y1: 30000, x2: 40000, y2: 30000 }], null);
  const coreA = { id: "A", name: "Core A", centerX: 16500, centerY: 23000, length: 13000, width: 6000, angleDeg: 0, zBottom: 0, height: 20000 };
  const coreB = { id: "B", name: "Core B", centerX: 40000, centerY: 10000, length: 7000, width: 6000, angleDeg: 30, zBottom: 0, height: 18000 };
  const levels = [{ level: 1, z: 0 }, { level: 2, z: 9000 }];
  const doors = [
    { id: "d2", name: "L2", centerX: 23100, centerY: 21500, length: 1000, width: 200, angleDeg: 90, zBottom: 9000, height: 2100 },
    { id: "d1", name: "L1", centerX: 9900, centerY: 21500, length: 1000, width: 200, angleDeg: 90, zBottom: 0, height: 2100 },
  ];
  const dc = matchCoreDoors([coreA, coreB], doors, { levels, floorEnd: { 1: 0, 2: 1 } });
  const out = coresToPlan([coreA, coreB], dc, withWalls, { shaftKeys: ["0-0", "0-1"] });
  assert.equal(out.cores.length, 2);
  const a = out.cores[0];
  // Rhino 左上角 (10000, 26000) → 平面图 (10000 − 0 + 1000, 30000 − 26000 + 1000) = (11000, 5000)
  assert.deepEqual([a.x, a.y, a.l, a.w, a.rot], [11000, 5000, 13000, 6000, 0]);
  assert.deepEqual([a.label, a.shaftKey, a.id], ["Core A", "0-0", withWalls.nextId]);
  // L1 的门贴左端面，Rhino 局部 (−6600, −1500)（y=21500 在中心 23000 以南）→ 平面图局部 (0, 3000 + 1500 = 4500)
  assert.deepEqual(a.doorLocal, { x: 0, y: 4500 });
  assert.equal(a.doorWidth, 1000);
  assert.equal(a.doorLevel, 1, "用的是最低一层（L1）的门，不是 L2");
  // 指定楼层：L2 用 L2 的门（贴右端面 → x = L）；L3 没有门 → 默认左端中点、doorLevel 空
  const out2 = coresToPlan([coreA], dc, withWalls, { level: 2 });
  assert.deepEqual([out2.cores[0].doorLocal.x, out2.cores[0].doorLevel], [13000, 2]);
  const out3 = coresToPlan([coreA], dc, withWalls, { level: 3 });
  assert.deepEqual([out3.cores[0].doorLocal, out3.cores[0].doorLevel], [{ x: 0, y: 3000 }, undefined]);
  const b = out.cores[1];
  assert.equal(b.rot, 330, "Rhino 逆时针 30° → 平面图（y 朝下）330°");
  assert.deepEqual(b.doorLocal, { x: 0, y: 3000 }, "没门：左端中点");
  assert.equal(b.shaftKey, "0-1");
  assert.equal(out.rhinoFrame.x0, 0, "基准沿用墙的");
  assert.equal(out.walls.length, 1, "墙还在");
  assert.equal(coresToPlan([], dc, withWalls).cores.length, 0);
});

await test("线上版访问本机：health 请求声明 targetAddressSpace=loopback；pageMayBeBlocked 只对 https 非本机页面为真", async () => {
  const inits = [];
  const fetch = async (url, init) => { inits.push(init); return json({ ok: true, rhino: "8" }); };
  await scanRhino({ fetch, ports: [8790], timeoutMs: 50 });
  await checkRhino({ fetch });
  assert.equal(inits.length, 2);
  for (const i of inits) assert.deepEqual([i.cache, i.targetAddressSpace], ["no-store", "loopback"]);
  assert.equal(pageMayBeBlocked({ protocol: "https:", hostname: "jiangpresident.github.io" }), true);
  assert.equal(pageMayBeBlocked({ protocol: "http:", hostname: "localhost" }), false);
  assert.equal(pageMayBeBlocked({ protocol: "https:", hostname: "localhost" }), false);
  assert.equal(pageMayBeBlocked({ protocol: "http:", hostname: "127.0.0.1" }), false);
  assert.equal(pageMayBeBlocked({ protocol: "https:", hostname: "app.localhost" }), false);
  assert.equal(pageMayBeBlocked(null), false);
});

console.log(process.exitCode ? "有测试失败" : `全部通过（${passed} 项）`);
