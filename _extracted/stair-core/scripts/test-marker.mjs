// Floorplan Marker 路线（src/plan/markerDetect.js）的回归测试：不启动 Python 服务，用假的 fetch 冒充它，
// 验证我们这边能控制的部分：墨迹范围裁剪、裁剪/缩放方案、请求形状（地址、JSON、阈值）、返回坐标还原回
// 原始像素（含裁剪偏移和缩放）、楼梯多边形→包围盒、各种错误的中文提示（服务没启动是最常见的）。
import assert from "node:assert/strict";
import { findInkBounds, planCrop, mapMarkerResult, detectWithMarker, checkMarkerHealth, MARKER_DEFAULT_THRESHOLD, MARKER_START_HINT } from "../src/plan/markerDetect.js";

let passed = 0;
const test = (name, fn) =>
  Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log("  ✓ " + name);
    })
    .catch((err) => {
      console.error("  ✗ " + name);
      console.error(err);
      process.exitCode = 1;
    });

function blankImage(w, h) {
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  return { data, width: w, height: h };
}
function ink(img, x, y, gray = 0) {
  const i = (y * img.width + x) * 4;
  img.data[i] = img.data[i + 1] = img.data[i + 2] = gray;
  img.data[i + 3] = 255;
}
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

console.log("markerDetect");

await test("findInkBounds：只框住墨迹范围 + 边距；浅灰（>阈值）不算墨迹；全白返回整图", () => {
  const img = blankImage(200, 100);
  ink(img, 50, 20);
  ink(img, 120, 70);
  ink(img, 190, 90, 240); // 浅灰，默认阈值 230 下不算
  const b = findInkBounds(img, { margin: 5 });
  assert.deepEqual(b, { x: 45, y: 15, w: 81, h: 61 });
  assert.deepEqual(findInkBounds(blankImage(30, 20)), { x: 0, y: 0, w: 30, h: 20 });
  // 透明像素当白纸
  const t = blankImage(10, 10);
  t.data[3] = 0; t.data[0] = 0; t.data[1] = 0; t.data[2] = 0;
  assert.deepEqual(findInkBounds(t), { x: 0, y: 0, w: 10, h: 10 });
  // 边距不超出图外
  const e = blankImage(20, 20);
  ink(e, 0, 0);
  assert.deepEqual(findInkBounds(e, { margin: 5 }), { x: 0, y: 0, w: 6, h: 6 });
});

await test("planCrop：长边压到 1400 以内，小图不放大", () => {
  const c = planCrop({ x: 10, y: 20, w: 2800, h: 1400 });
  assert.equal(c.scale, 0.5);
  assert.deepEqual([c.sx, c.sy, c.sw, c.sh, c.outW, c.outH], [10, 20, 2800, 1400, 1400, 700]);
  assert.equal(planCrop({ x: 0, y: 0, w: 900, h: 800 }).scale, 1);
});

await test("mapMarkerResult：裁剪偏移 + 缩放还原回原始像素；楼梯多边形→包围盒；墙厚按传入值", () => {
  const crop = { sx: 100, sy: 50, sw: 2000, sh: 1000, scale: 0.5, outW: 1000, outH: 500 };
  const r = mapMarkerResult(
    {
      walls: [{ id: "wall-1", x1: 10, y1: 20, x2: 110, y2: 20, source: "auto", confidence: 0.7 }],
      doors: [{ id: "door-1", x1: 40, y1: 20, x2: 60, y2: 20 }],
      stairs: [{ id: "stair-1", points: [[200, 100], [300, 100], [300, 180], [200, 180]] }],
    },
    crop,
    8
  );
  assert.deepEqual(r.walls[0], { id: 1, x1: 120, y1: 90, x2: 320, y2: 90, w: 8 });
  assert.deepEqual(r.doors[0], { id: 2, x1: 180, y1: 90, x2: 220, y2: 90 });
  assert.deepEqual(r.stairs[0], { id: 3, x1: 500, y1: 250, x2: 700, y2: 410 });
  assert.deepEqual(mapMarkerResult({}, crop, 8), { walls: [], doors: [], stairs: [] });
});

await test("detectWithMarker：请求打到本机 /api/detect，带 JSON 图片和阈值 230；返回原样交回", async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return json({ width: 10, height: 10, walls: [{ x1: 0, y1: 0, x2: 5, y2: 0 }], doors: [], stairs: [] });
  };
  const r = await detectWithMarker({ dataUrl: "data:image/png;base64,AAAA", fetch });
  assert.equal(calls[0].url, "http://127.0.0.1:8765/api/detect");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.image, "data:image/png;base64,AAAA");
  assert.equal(body.options.threshold, MARKER_DEFAULT_THRESHOLD);
  assert.equal(MARKER_DEFAULT_THRESHOLD, 230);
  assert.equal(r.walls.length, 1);
  const r2 = await detectWithMarker({ dataUrl: "x", threshold: 200, options: { min_wall_length: 50 }, fetch });
  assert.deepEqual(JSON.parse(calls[1].init.body).options, { threshold: 200, min_wall_length: 50 });
  assert.ok(r2);
});

await test("detectWithMarker：服务没启动 → 提示怎么启动；400/429/500 → 中文提示；格式不对也报错", async () => {
  await assert.rejects(detectWithMarker({ dataUrl: "x", fetch: async () => { throw new TypeError("Failed to fetch"); } }), (e) => e.message === MARKER_START_HINT);
  await assert.rejects(detectWithMarker({ dataUrl: "x", fetch: async () => json({ error: "Image exceeds 24 million pixels." }, 400) }), /识别失败：Image exceeds/);
  await assert.rejects(detectWithMarker({ dataUrl: "x", fetch: async () => json({ error: "busy" }, 429) }), /正在处理上一张图/);
  await assert.rejects(detectWithMarker({ dataUrl: "x", fetch: async () => new Response("boom", { status: 500 }) }), /识别失败：HTTP 500/);
  await assert.rejects(detectWithMarker({ dataUrl: "x", fetch: async () => json({ nope: true }) }), /格式不对/);
});

await test("checkMarkerHealth：在线 true，离线/非 ok false", async () => {
  assert.equal(await checkMarkerHealth({ fetch: async () => json({ ok: true }) }), true);
  assert.equal(await checkMarkerHealth({ fetch: async () => { throw new Error("x"); } }), false);
  assert.equal(await checkMarkerHealth({ fetch: async () => json({ ok: false }) }), false);
});

console.log(process.exitCode ? "有测试失败" : `全部通过（${passed} 项）`);
