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

test("出口门按人数 × 6.1 mm 自动算：默认例子单扇 1 070；门贴侧墙时平台深度 = max(梯宽, 门扇+50+300)；居中时 = 门扇+750", () => {
  const a = compute(mk());
  const d = a.stairs[0].door;
  // L2 餐饮 800 m² / 1.2 = 667 人，4 部楼梯各 167 人 × 6.1 = 1 017 → 净宽取整 1 020，门洞 1 070（+门框 50），单扇 ≤ 1 220
  assert.equal(Math.round(d.persons), 167);
  assert.equal(d.clearReq, 1020);
  assert.deepEqual([d.leaves, d.leafW, d.opening], [1, 1070, 1070]);
  assert.equal(a.stairs[0].geos[0].Lf, Math.max(a.stairs[0].W, d.leafW + 50 + 300));
  const b = compute(mk({ adv: { ...baseAdv, doorHinge: "center" } }));
  assert.equal(b.stairs[0].geos[0].Lf, b.stairs[0].door.leafW + 750);
  // 设计下限大于所需时用下限：doorLeaf 1 200 → 单扇 1 200
  const c = compute(mk({ adv: { ...baseAdv, doorLeaf: 1200 } }));
  assert.deepEqual([c.stairs[0].door.leaves, c.stairs[0].door.leafW], [1, 1200]);
});

test("出口门太宽自动分两扇：每扇 ≥610，总门洞仍满足人数；单扇上限可改", () => {
  // L2 设计人数覆盖成 1 500 人、单梯最大宽 3 000（→ 4 部楼梯）→ 每梯 375 人 × 6.1 = 2 288 → 净宽 2 290、门洞 2 340 > 1 220 → 两扇各 1 170
  const floors = defaultFloors(5);
  floors[1] = { ...floors[1], ol: "1500" };
  const r = compute(mk({ floors, maxStairW: 3000 }));
  assert.equal(r.c[2], 4);
  const d = r.stairs[0].door;
  assert.equal(d.clearReq, 2290);
  assert.deepEqual([d.leaves, d.leafW, d.opening], [2, 1170, 2340]);
  assert.ok(d.leafW >= 610 && d.clear >= d.clearReq);
  // 单扇上限放宽到 2 400 → 又回到单扇
  const r2 = compute(mk({ floors, maxStairW: 3000, adv: { ...baseAdv, doorLeafMax: 2400 } }));
  assert.deepEqual([r2.stairs[0].door.leaves, r2.stairs[0].door.leafW, r2.stairs[0].door.overflow], [1, 2340, false]);
  // 平台深度用一扇的摆动半径：贴墙 = max(W, 1 170 + 50 + 300)
  assert.equal(r.stairs[0].geos[0].Lf, Math.max(r.stairs[0].W, 1170 + 350));
  // 两扇仍放不下（每梯 750 人）→ overflow 标记，交给校核表报 ✗
  const r3 = compute(mk({ floors, maxStairW: 6000 }));
  assert.equal(r3.c[2], 2);
  assert.deepEqual([r3.stairs[0].door.leaves, r3.stairs[0].door.overflow], [2, true]);
  // 默认例子：单扇 1 070 要平台 1 420 > 梯宽 1 350（侵占 70），分两扇每扇只有 540 < 800 → 不分，平台加深
  const d0 = compute(mk()).stairs[0].door;
  assert.deepEqual([d0.landingBase, d0.doorMinSingle, d0.intrudes, d0.splitReason, d0.swingTry && d0.swingTry.leafW], [1350, 1420, true, undefined, 610]);
  // 居中开门 + 单扇上限放到 3 000 + 每梯 300 人：单扇 1 880 要平台 2 630 > 梯宽 2 400 → 分两扇各 940（≥800），平台回到 2 400
  const floors2 = defaultFloors(5);
  floors2[1] = { ...floors2[1], ol: "1200" };
  const rs = compute(mk({ floors: floors2, maxStairW: 3000, adv: { ...baseAdv, doorHinge: "center", doorLeafMax: 3000 } }));
  const ds = rs.stairs[0].door;
  assert.equal(rs.c[2], 4);
  assert.deepEqual([ds.leaves, ds.leafW, ds.splitReason, ds.intrudes, ds.doorMinSingle], [2, 940, "swing", false, 1880 + 750]);
  assert.equal(rs.stairs[0].geos[0].Lf, rs.stairs[0].W);
  // 两扇门的三维门盒子宽 = 门洞总宽
  const solids = buildSolids(r, mk({ floors, maxStairW: 3000 }), 0, 1, 1);
  const doorBox = solids.boxes.find((bx) => bx.kind === "door");
  assert.ok(doorBox && Math.abs(doorBox.y2 - doorBox.y1 - 2340) < 1, "door box width 2340");
});

test("单出口判定只在 ≤2 层且人数 ≤60 时成立", () => {
  const r = compute(mk({ nFloors: 2, floors: defaultFloors(2).map((f) => ({ ...f, area: 150, use: "office" })) }));
  assert.ok(r.perFloor[1].singleExitOK);
  const r2 = compute(mk({ nFloors: 3 }));
  assert.ok(r2.perFloor.every((p) => !p.singleExitOK));
});

console.log(`\n${passed} 项通过`);
