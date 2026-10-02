// Rhino 桥客户端（src/rhino/rhinoBridge.js）的回归测试：不需要 Rhino，用假 fetch 冒充桥接脚本。
// 验证 payload 整理（类别过滤、原点平移字段、计数、毫米单位）、health 的在线/离线/异常返回、bake 的请求形状与错误翻译。
import assert from "node:assert/strict";
import { buildRhinoPayload, checkRhino, sendToRhino, RHINO_URL, RHINO_NOT_RUNNING_HINT } from "../src/rhino/rhinoBridge.js";

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

console.log(process.exitCode ? "有测试失败" : `全部通过（${passed} 项）`);
