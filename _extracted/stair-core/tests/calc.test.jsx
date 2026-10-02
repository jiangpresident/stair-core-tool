import assert from "node:assert/strict";
import { compute, buildSolids, defaultFloors } from "../src/calculator/StairCoreTool.jsx";

const baseAdv = { run: 280, maxRise: 180, maxRisers: 10, gap: 150, centerWall: 200, doorLeaf: 950, doorPos: "end", doorHinge: "wall", doorSide: "dn", waist: 180, roundStep: 50 };
const mk = (over = {}) => ({ nFloors: 5, wall: 300, maxStairW: 1500, stairType: "dogleg", includeL1: false, sprinklered: true, buildingArea: 800, floors: defaultFloors(5), adv: baseAdv, ...over });
const overlap = (a, b) => { const dx = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1), dy = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1), dz = Math.min(a.z2, b.z2) - Math.max(a.z1, b.z1); return dx > 1 && dy > 1 && dz > 1 ? dx * dy * dz : 0; };

let passed = 0;
const test = (name, fn) => { try { fn(); passed++; console.log("✓", name); } catch (e) { console.error("✗", name, "\n ", e.message); process.exitCode = 1; } };

test("默认例子：首层 9 m 分 5 跑各 10 级，无净高警告", () => {
  const r = compute(mk());
  assert.deepEqual(r.perFloor[0].flightRisers, [10, 10, 10, 10, 10]);
  assert.equal(r.warnings.filter((w) => w.includes("净高")).length, 0);
});

test("每层至少 2 部楼梯，出口层楼梯数 ≥ 上层", () => {
  const r = compute(mk());
  for (let L = r.lvl0; L < r.perFloor.length; L++) assert.ok(r.c[L] >= r.c[L + 1] && r.c[L] >= 2);
});

test("折返梯：梯段带连续交替，到达跑与起步跑不同带；楼板半边贴合到达点", () => {
  for (const X of [9, 10, 12, 18, 0]) {
    const r = compute(mk({ adv: { ...baseAdv, maxRisers: X } }));
    const st = r.stairs[0];
    let prev = null;
    for (const L of st.storeyLevels) {
      const g = st.storeyGeo[L];
      if (prev) {
        assert.notEqual(prev.band, g.flights[0].band, `X=${X} L${L} 同带`);
        assert.ok(Math.abs(g.floorEdge[prev.band] - prev.x) < 0.5, `X=${X} L${L} 楼板边缘`);
      }
      const last = g.flights[g.flights.length - 1];
      prev = { band: last.band, x: last.endX };
    }
  }
});

test("三维实体：踏步与楼板/平台/其他踏步互不重叠（折返 + 剪刀）", () => {
  for (const type of ["dogleg", "scissor"]) {
    const inp = mk({ stairType: type });
    const r = compute(inp);
    const m = buildSolids(r, inp, 0, 1, 999);
    const steps = m.boxes.filter((b) => b.kind === "step" && b.x2 - b.x1 > 100);
    const flat = m.boxes.filter((b) => b.kind === "landing" || b.kind === "slab");
    for (const s of steps) for (const f of flat) assert.equal(overlap(s, f), 0, `${type}: 踏步与楼板重叠`);
    for (let i = 0; i < steps.length; i++) for (let j = i + 1; j < steps.length; j++) assert.equal(overlap(steps[i], steps[j]), 0, `${type}: 踏步互相重叠`);
    assert.equal(m.figures.length, m.topL - m.from + 1);
  }
});

test("门贴侧墙时平台深度 = max(梯宽, 门扇+50+300)；居中时 = 门扇+750", () => {
  const a = compute(mk());
  assert.equal(a.stairs[0].geos[0].Lf, Math.max(a.stairs[0].W, 950 + 50 + 300));
  const b = compute(mk({ adv: { ...baseAdv, doorHinge: "center" } }));
  assert.equal(b.stairs[0].geos[0].Lf, 950 + 750);
});

test("单出口判定只在 ≤2 层且人数 ≤60 时成立", () => {
  const r = compute(mk({ nFloors: 2, floors: defaultFloors(2).map((f) => ({ ...f, area: 150, use: "office" })) }));
  assert.ok(r.perFloor[1].singleExitOK);
  const r2 = compute(mk({ nFloors: 3 }));
  assert.ok(r2.perFloor.every((p) => !p.singleExitOK));
});

console.log(`\n${passed} 项通过`);
