// 平面图工程文件（src/plan/planFile.js）纯逻辑部分的回归测试：序列化 → 解析往返、旧文件缺字段补默认、
// 坏文件报中文错误、nextId 修复、裸 plan 对象也能认。
import assert from "node:assert/strict";
import { serializePlan, parsePlanFile, suggestFileName, PLAN_DEFAULTS, PLAN_FILE_FORMAT, PLAN_FILE_VERSION, PLAN_FILE_EXT } from "../src/plan/planFile.js";

let passed = 0;
const test = (name, fn) => {
  try {
    fn();
    passed++;
    console.log("  ✓ " + name);
  } catch (err) {
    console.error("  ✗ " + name);
    console.error(err);
    process.exitCode = 1;
  }
};

console.log("planFile");

test("serializePlan → parsePlanFile 往返：数据不变，mode 回到 view，带格式/版本/时间/名字", () => {
  const plan = { ...PLAN_DEFAULTS, bgSrc: "data:image/png;base64,AAAA", naturalW: 800, naturalH: 600, mmPerPx: 18.75, mode: "wall", drawingPathId: 3, walls: [{ id: 2, x1: 0, y1: 0, x2: 100, y2: 0, t: 200 }], doors: [{ id: 4, wallId: 2, at: 50, width: 900, swing: 1, hinge: 1 }], nextId: 9 };
  const text = serializePlan(plan, { name: "一层" });
  const j = JSON.parse(text);
  assert.equal(j.format, PLAN_FILE_FORMAT);
  assert.equal(j.version, PLAN_FILE_VERSION);
  assert.equal(j.name, "一层");
  assert.ok(!Number.isNaN(Date.parse(j.savedAt)));
  const { plan: back, name } = parsePlanFile(text);
  assert.equal(name, "一层");
  assert.equal(back.mode, "view", "瞬时的绘制模式不该被保存");
  assert.equal(back.drawingPathId, null);
  assert.equal(back.mmPerPx, 18.75);
  assert.equal(back.bgSrc, plan.bgSrc);
  assert.deepEqual(back.walls, plan.walls);
  assert.deepEqual(back.doors, plan.doors);
  assert.equal(back.nextId, 9);
});

test("旧文件缺后加的字段 → 补默认值；数组字段不是数组 → 置空；坏的比例/尺寸 → 回默认", () => {
  const text = JSON.stringify({ format: PLAN_FILE_FORMAT, version: 1, plan: { walls: [], cores: [], doors: "oops", naturalW: -5, mmPerPx: 0 } });
  const { plan } = parsePlanFile(text);
  assert.deepEqual(plan.stairCandidates, []);
  assert.deepEqual(plan.doors, []);
  assert.equal(plan.naturalW, PLAN_DEFAULTS.naturalW);
  assert.equal(plan.mmPerPx, 1);
  assert.equal(plan.hasCorridor, true);
});

test("nextId 小于已用 id → 修成最大 id + 1（新加的东西不会撞 id）", () => {
  const text = JSON.stringify({ format: PLAN_FILE_FORMAT, version: 1, plan: { ...PLAN_DEFAULTS, cores: [{ id: 7 }], walls: [{ id: 12 }], nextId: 3 } });
  assert.equal(parsePlanFile(text).plan.nextId, 13);
});

test("裸 plan 对象（没有 format 包装）也能打开", () => {
  const { plan } = parsePlanFile(JSON.stringify({ ...PLAN_DEFAULTS, walls: [{ id: 1, x1: 0, y1: 0, x2: 1, y2: 0, t: 200 }] }));
  assert.equal(plan.walls.length, 1);
});

test("坏文件 → 中文错误，不静默", () => {
  assert.throws(() => parsePlanFile("{not json"), /有效的 JSON/);
  assert.throws(() => parsePlanFile(JSON.stringify({ hello: 1 })), /不是本工具保存的平面图工程/);
  assert.throws(() => parsePlanFile(JSON.stringify({ format: PLAN_FILE_FORMAT, version: 99, plan: PLAN_DEFAULTS })), /更新版本/);
  assert.throws(() => parsePlanFile("null"), /不是平面图工程/);
});

test("suggestFileName：去掉旧后缀、空名字用日期", () => {
  assert.equal(suggestFileName("一层.stairplan.json"), "一层" + PLAN_FILE_EXT);
  assert.equal(suggestFileName("x.json"), "x" + PLAN_FILE_EXT);
  assert.match(suggestFileName(""), /^平面图-\d{4}-\d{2}-\d{2}\.stairplan\.json$/);
});

console.log(process.exitCode ? "有测试失败" : `全部通过（${passed} 项）`);
