import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import * as THREE from "three";
import { saveInp, otherAppHref } from "../planBridge.js";
import { C_FOR_THEME, FONT_FOR_THEME, applyThemeToDocument } from "../theme.js";
import { AI_PROVIDERS, readAiSettingsFromBrowser, writeAiSettingsToBrowser } from "../plan/aiSettings.js";
import { savePlanFile, openPlanFile, supportsFilePicker, bridgeAvailable, listExamples, openExample, PLAN_DEFAULTS } from "../plan/planFile.js";

/* 计算器页里"Rhino 平面图"面板用的平面图：按楼层存 {byLevel: {1: plan, 2: plan…}, selected}，由 Rhino 面板每层的「生成平面图」填入，
   跟 /plan 页的平面图互相独立。旧版只存一张（stair-core:rhino-plan）的话迁移成 L1。 */
const RHINO_PLANS_KEY = "stair-core:rhino-plans";
const readRhinoPlans = () => {
  try {
    const v = JSON.parse(localStorage.getItem(RHINO_PLANS_KEY) || "null");
    if (v && typeof v === "object" && v.byLevel && typeof v.byLevel === "object") {
      const byLevel = {};
      for (const [k, p] of Object.entries(v.byLevel)) byLevel[Number(k)] = { ...PLAN_DEFAULTS, ...(p || {}) };
      return { byLevel, selected: Number(v.selected) || Number(Object.keys(byLevel)[0]) || 1 };
    }
    const old = JSON.parse(localStorage.getItem("stair-core:rhino-plan") || "null");
    if (old && typeof old === "object" && ((old.walls && old.walls.length) || (old.cores && old.cores.length) || (old.boundary && old.boundary.length))) {
      return { byLevel: { 1: { ...PLAN_DEFAULTS, ...old } }, selected: 1 };
    }
  } catch {
    /* 坏数据就从空开始 */
  }
  return { byLevel: {}, selected: 1 };
};
import { t } from "../i18n.js";
import LangToggle from "../LangToggle.jsx";
import RhinoPanel from "../rhino/RhinoPanel.jsx";

/* ------------------------------------------------------------------ */
/*  规范层级：VBBL 2025 (温哥华) → BCBC 2024 (BC省) → NBC 2020 (国家)     */
/*  VBBL 2025 以 BCBC 2024 为基础；BCBC 2024 以 NBC 2020 为基础。          */
/*  2026-01-20 VBBL 修订：新增 3.4.2.3.(5)(6) 剪刀梯条款，删除 3.4.1.2.(3) */
/* ------------------------------------------------------------------ */

/* 配色：按当前主题（浅色 / 深色 CRT）在模块加载时取一套（见 src/theme.js；切换主题会整页刷新）。
   其它模块（RhinoPanel、LayerTree、PlanApp）从这里 import C，所以一处切换处处生效。 */
const C = C_FOR_THEME();
applyThemeToDocument();
const FONT = FONT_FOR_THEME(); // 浅色：无衬线；深色 CRT：等宽终端字体（见 theme.js）

/* Table 3.1.17.1 人员荷载（m²/人）。NBC 2020 = BCBC 2024 = VBBL 2025 */
const USES = [
  { id: "office", label: t("办公 Offices (D)"), group: "D", m2: 9.3 },
  { id: "personal", label: t("个人服务店铺 Personal service shops (D)"), group: "D", m2: 4.6 },
  { id: "merc1", label: t("商业—地下及首层 Mercantile, basements & first storeys (E)"), group: "E", m2: 3.7 },
  { id: "merc2", label: t("商业—其他楼层 Mercantile, other storeys (E)"), group: "E", m2: 5.6 },
  { id: "dining", label: t("餐饮 / 酒吧 / 食堂 Dining, beverage, cafeteria (A2)"), group: "A", m2: 1.2 },
  { id: "seats", label: t("集会—非固定座位 Assembly, non-fixed seats (A)"), group: "A", m2: 0.75 },
  { id: "tables", label: t("集会—非固定座位加桌 Assembly, seats & tables (A)"), group: "A", m2: 0.95 },
  { id: "standing", label: t("站立空间 Standing space (A)"), group: "A", m2: 0.4 },
  { id: "classroom", label: t("教室 Classrooms (A)"), group: "A", m2: 1.85 },
  { id: "lounge", label: t("阅览室 / 休息室 Reading rooms, lounges (A)"), group: "A", m2: 1.85 },
  { id: "exhibit", label: t("展厅 Exhibition halls (A)"), group: "A", m2: 3.0 },
  { id: "dwelling", label: t("住宅单元 / 酒店客房 Dwelling units & suites (C) — 2人/卧室"), group: "C", m2: null },
  { id: "dorm", label: t("宿舍 Dormitories (C)"), group: "C", m2: 4.6 },
  { id: "b2", label: t("医疗—治疗及病房 Treatment & sleeping rooms (B2)"), group: "B", m2: 10.0, mmpp: 18.4, minW: 1650, maxFlightRise: 2400 },
  { id: "mfg", label: t("制造 / 加工 Manufacturing (F)"), group: "F", m2: 4.6 },
  { id: "warehouse", label: t("仓储 Storage spaces, warehouse (F)"), group: "F", m2: 28.0 },
  { id: "garage", label: t("停车库 Storage garages (F3)"), group: "F", m2: 46.0 },
  { id: "kitchen", label: t("厨房 Kitchens"), group: "other", m2: 9.3 },
  { id: "service", label: t("机房 / 储藏 Storage & service"), group: "other", m2: 46.0 },
  { id: "custom", label: t("自定义人数（设计人数，需张贴标识）"), group: "custom", m2: null },
];
const useById = (id) => USES.find((u) => u.id === id) || USES[0];

/* Table 3.4.2.1.-A / -B 单出口最大面积（m²） */
const SINGLE_EXIT_AREA = {
  sprinklered: { A: 200, B: 100, C: 150, D: 300, E: 200, F: 300 },
  unsprinklered: { A: 150, B: 75, C: 100, D: 200, E: 150, F: 200 },
};

/* 条文库：level = 该数据最终由哪一级规范确立 */
const CODE = [
  { key: "OL", art: t("3.1.17.1.(1) 及 Table 3.1.17.1"), level: "NBC", title: t("人员荷载确定"), text: t("固定座位按座位数；住宅单元或套房按每个卧室（睡眠区）2 人；其他按 Table 3.1.17.1 的每人面积（m²/人）。设计人数不同于表值时须张贴人数标识 (3.1.17.1.(2))。"), use: t("每层人数 OL") },
  { key: "EXITS", art: "3.4.2.1.(1)(2)", level: "NBC", title: t("最少出口数量"), text: t("每个供使用的楼层区域至少设 2 个出口。仅当建筑不超过 2 层、出口服务人数 ≤60、面积与疏散距离不超过 Table 3.4.2.1.-A/-B（喷淋时疏散距离 ≤25 m）时允许 1 个出口。"), use: t("楼梯最少数量 = 2") },
  { key: "WBASE", art: "3.4.3.1.(1)(2)", level: "NBC", title: t("出口宽度基于人员荷载"), text: t("出口总宽度按 3.1.17 的人员荷载确定；两个或以上出口汇合时宽度累加（3.4.3.2.(4) 另有规定除外）。"), use: t("计算基础") },
  { key: "MMPP", art: "3.4.3.2.(1)(b)(c)", level: "NBC", title: t("出口宽度 — 每人毫米数"), text: t("楼梯：踢面 ≤180 mm 且踏面 ≥280 mm 时 8 mm/人；否则 9.2 mm/人。坡道 ≤1:8、门、走道 6.1 mm/人。"), use: t("需求宽度 = OL × 8 mm") },
  { key: "MMPPB", art: "3.4.3.2.(2)", level: "NBC", title: t("护理/治疗/拘留用途宽度"), text: t("Group B 楼层出口总宽度按 18.4 mm/人计算。"), use: t("B2 楼层 18.4 mm/人") },
  { key: "NOCUM", art: "3.4.3.2.(4)", level: "NBC", title: t("上下楼层不累加"), text: t("同一出口服务上下叠置的两个或以上楼层时，所需出口宽度不必累加——即楼梯宽度由所服务楼层中需求最大的一层决定。"), use: t("各楼梯按其服务楼层中最大需求取宽") },
  { key: "HALF", art: "3.4.3.2.(7)", level: "NBC", title: t("单个出口最多计入一半"), text: t("需要一个以上出口时，每个出口最多只能计入所需总宽度的一半。"), use: t("n 部楼梯每部 ≥ 需求宽度 / n") },
  { key: "MINW", art: "3.4.3.2.(8) Table 3.4.3.2.-A / -B", level: "NBC", title: t("出口最小宽度"), text: t("A/B1/C/D/E/F 用途：楼梯服务最低出口层以上 ≤2 层（或以下 ≤1 层）最小 900 mm；服务更多楼层最小 1 100 mm；走道 1 100 mm；门 800 mm。B2 服务病房的楼梯最小 1 650 mm。"), use: t("每部楼梯最小净宽") },
  { key: "DOORW", art: "3.4.3.2.(1)(a)(8) Table 3.4.3.2.-A", level: "NBC", title: t("出口门口宽度"), text: t("门口所需出口宽度按 6.1 mm/人计算；门口最小 800 mm。"), use: t("每部楼梯的出口门：该梯分担的最不利楼层人数 × 6.1，且 ≥800；门洞 = 净宽 + 门框约 50") },
  { key: "LEAF610", art: "3.4.6.11.(5)", level: "NBC", title: t("多扇出口门的门扇"), text: t("出口门有多扇时，任一扇不得小于 610 mm。"), use: t("门洞超过单扇上限自动分两扇时，每扇 ≥610") },
  { key: "MAXLEAF", art: t("设计设定"), level: "USER", title: t("单扇门最大宽度"), text: t("NBC / BCBC / VBBL 没有规定单扇出口门的最大宽度。这里按常见做法设上限（NFPA 101 与门五金惯例为 1 220 mm，约 48 in），可在参数里修改。"), use: t("单扇所需宽度超过上限时自动改为两扇门") },
  { key: "DOOR750", art: "3.4.3.3.(2)(3)(4)", level: "NBC", title: t("出口宽度不得被侵占"), text: t("平开门在摆动范围内不得使楼梯或平台的所需宽度小于 750 mm；门开启后不得削减或阻挡出口所需宽度；扶手及其支撑向所需宽度内的凸出不得超过 100 mm。"), use: t("门居中、开启后垂直端墙：平台深度 ≥ 门扇 + 750；门贴侧墙、开启后贴墙：门扇不占平台净深，平台深度按 3.4.6.4 与 3.4.6.11 控制") },
  { key: "HANDEXT", art: "3.4.6.5.(10)(11)(12)", level: "NBC", title: t("扶手的连续与延伸"), text: t("除被门洞打断处外至少一侧扶手在平台处连续；扶手端部不得阻碍行走；至少一侧扶手在梯段顶部和底部水平延伸不少于 300 mm。"), use: t("门扇贴墙开启时须避开该侧墙上扶手的 300 mm 延伸段：Lf − 300 ≥ 门扇 + 门框") },
  { key: "SIGN", art: "3.4.6.19.(1)", level: "NBC", title: t("楼层号牌"), text: t("楼层数字须固定在楼梯间一侧、门的门闩侧墙上，距门不超过 300 mm，高 1 500 mm。"), use: t("门闩侧应朝向梯间中央，保证门闩侧有墙面") },
  { key: "ACC", art: t("3.8.3.6.(2)(11)（VBBL 编号）"), level: "VBBL", title: t("无障碍通路上的门"), text: t("门洞净宽 ≥850 mm；门开向的一侧须有 1 500 mm 深、门闩侧 ≥600 mm 的净空，另一侧 1 200 mm 深、门闩侧 ≥300 mm。是否把楼梯间出口门视为无障碍通路上的门由项目与审图确定。"), use: t("门闩侧净空按梯间宽 − 门框 − 门扇计算并标注是否满足 600 mm") },
  { key: "HEAD", art: "3.4.3.4.(1)(4)", level: "NBC", title: t("净高"), text: t("出口净宽范围内净高不小于 2 050 mm（楼梯自踏步前缘连线量至上方最低构件）；门洞净高 ≥2 030 mm。"), use: t("净高检查：层高 − 上层板厚 ≥ 2 050") },
  { key: "FRR", art: "3.4.4.1.(1)(2)", level: "NBC", title: t("出口的防火分隔"), text: t("出口须以防火分隔与建筑其余部分隔开，耐火极限不低于 3.2.2 要求的楼板耐火极限，且不低于 45 min，不需超过 2 h。"), use: t("楼梯间墙体耐火极限（核心筒墙厚由用户输入）") },
  { key: "LOBBY", art: "3.4.4.2.(1)(2)", level: "NBC", title: t("出口穿越大堂"), text: t("首层以上楼层的出口不得经过大堂；仅允许一个出口经大堂，且大堂楼面距室外地面 ≤4.5 m、穿越大堂至室外路径 ≤15 m、相邻房间不含护理/住宅/工业用途、大堂按出口要求构造并保持防火分隔。"), use: t("首层出口层楼梯落地方式提示") },
  { key: "SCISSOR", art: "3.4.4.4.(2)(3)", level: "NBC", title: t("剪刀梯之间的分隔"), text: t("剪刀梯及其他相邻出口楼梯之间须以烟密封防火分隔隔开，耐火极限不低于所穿越楼板；分隔墙上不得开门洞、风管、管道等。"), use: t("剪刀梯中间隔墙") },
  { key: "MAXR", art: t("用户设定（非规范条文）"), level: "USER", title: t("每跑最多踢面数"), text: t("规范本身没有以级数计的上限，只规定每跑高差 ≤3.7 m (3.4.6.3.(1)) 且每跑 ≥3 级 (3.4.6.2.(1))；按 180 mm 踢面折算约 20 级。这里的 X 级为设计 / 事务所习惯设定，超过即增加一跑并设折返休息平台。"), use: t("跑数 = max(基本跑数, ceil(层高 / 3 700), ceil(踢面数 / X))，折返梯取偶数") },
  { key: "R3", art: "3.4.6.2.(1)", level: "NBC", title: t("最少踢面数"), text: t("每跑室内楼梯不少于 3 个踢面。"), use: t("每跑踢面 ≥3 检查") },
  { key: "RISE37", art: "3.4.6.3.(1)(2)", level: "NBC", title: t("每跑最大垂直高度与平台"), text: t("任何一跑楼梯在楼层或平台之间的垂直高度不得超过 3.7 m（B2 用途出口楼梯 2.4 m）；每跑上下端及门开向楼梯处须设平台。"), use: t("跑数 = max(2, ceil(层高 / 3 700))，中间平台数 = 跑数 − 1") },
  { key: "LAND", art: "3.4.6.4.(1)(2)", level: "NBC", title: t("平台尺寸"), text: t("平台的宽度和长度不小于所在楼梯宽度；直跑或转角小于 90° 的楼梯，平台长度不必超过楼梯所需宽度与 1 100 mm 二者中的较小值。"), use: t("折返（180°）中间平台深度 = 楼梯宽度；直跑平台深度 = min(宽度, 1 100)") },
  { key: "HAND", art: "3.4.6.5.(1)(2)(3)(7)", level: "NBC", title: t("扶手"), text: t("宽度 ≥1 100 mm 的楼梯两侧均设扶手；所需出口宽度内任一点距扶手不得超过 750 mm，否则加设中间扶手；扶手高度 865–1 070 mm。"), use: t("宽度 >1 500 mm 时提示中间扶手") },
  { key: "GUARD", art: "3.4.6.6.(2)", level: "NBC", title: t("护栏"), text: t("出口楼梯、坡道及其平台的护栏高度不小于 1 070 mm。"), use: t("剖面标注") },
  { key: "TREAD", art: "3.4.6.8.(1)(2)(4)(5)", level: "NBC", title: t("踏面与踢面"), text: t("踏面（run）≥280 mm；踢面（rise）125–180 mm；封闭踢面；同一跑内踢面高度均匀（相邻 ≤5 mm，最大最小差 ≤10 mm）。"), use: t("踢面数 = ceil(层高 / 180)，踢面高 = 层高 / 踢面数") },
  { key: "DOOR300", art: "3.4.6.11.(1)", level: "NBC", title: t("门与踢面的距离"), text: t("门在摆动过程中其前缘与楼梯踢面的距离不得小于 300 mm。"), use: t("楼层平台深度 ≥ 门扇宽 + 门框 + 300（摆动弧线最远处到首级踢面）") },
  { key: "SWING", art: "3.4.6.12.(1)", level: "NBC", title: t("门的开启方向"), text: t("出口门须沿疏散方向开启（开向楼梯间内）。"), use: t("平面图中门开向平台") },
  { key: "DIST", art: "3.4.2.3.(1)(4)", level: "NBC", title: t("出口之间的距离"), text: t("两个出口的最小距离为楼层区域最大对角线的一半，有公共走道的楼层不必超过 9 m，其他楼层不小于 9 m；两个楼梯的室外出口间距 ≥9 m（喷淋且距街道 ≤15 m 时 ≥6 m）。"), use: t("核心筒内楼梯间布置提示（本工具不计算平面对角线）") },
  { key: "DIST45", art: "3.4.2.3.(5)(6)", level: "VBBL", title: t("小型住宅剪刀梯出口间距放宽（温哥华独有，2026-01-20 生效）"), text: t("全楼为住宅、不超过 6 层且建筑面积 ≤600 m² 时，剪刀梯两出口门及其室外出口的最小间距不必超过 4.5 m；两梯道之间须设连续气密屏障。"), use: t("剪刀梯模式下符合条件时提示") },
  { key: "TRAVEL", art: "3.4.2.5.(1)", level: "NBC", title: t("疏散距离"), text: t("至少一个出口的疏散距离：高危工业 25 m；办公及个人服务 40 m；喷淋楼层（除高危工业）45 m；其他 30 m。"), use: t("布置提示") },
  { key: "SESBC", art: t("BCBC 3.2.10（Revision 3, 2024-08）"), level: "BCBC", title: t("BC 省单出口住宅楼梯（温哥华未采纳）"), text: t("住宅 ≤6 层、≤18 m、每层 ≤4 户且 ≤24 人、疏散距离 ≤25 m 时可设单个室内出口楼梯，楼梯宽 ≥1 500 mm、2 h 分隔、NFPA 13 喷淋、>4 层需防烟。温哥华 2025-12 议会明确不采纳此条，故本工具在温哥华项目中不适用。"), use: t("仅作说明") },
  { key: "SESVAN", art: t("VBBL 3.2.10（2026-01-20 生效）"), level: "VBBL", title: t("温哥华单个室外出口楼梯及外廊"), text: t("住宅 ≤6 层、≤18 m，1–3 层每层 ≤6 户、4 层以上每层 ≤4 户且 ≤24 人，可采用单个室外楼梯 + 至少 50% 开敞的室外走廊作为唯一出口。属室外楼梯，不属于核心筒内楼梯，本工具不计算。"), use: t("仅作说明") },
  { key: "WOOD", art: t("VBBL 2019 3.4.1.2.(3)（已删除）"), level: "VBBL", title: t("5–6 层木结构剪刀梯禁令已取消"), text: t("VBBL 2019 曾禁止 5–6 层木结构建筑使用剪刀梯；2026-01-20 修订已删除该句，现按 3.4.4.4.(2)(3) 及 3.4.2.3 执行。"), use: t("剪刀梯模式说明") },
];
const codeByKey = (k) => CODE.find((c) => c.key === k);
const LEVEL_LABEL = {
  NBC: t("NBC 2020 → BCBC 2024 → VBBL 2025 三级一致"),
  BCBC: t("BCBC 2024 省级条款"),
  VBBL: t("VBBL 2025 温哥华独有"),
  USER: t("设计设定（非规范要求）"),
};

/* ------------------------------------------------------------------ */
/*  工具函数                                                            */
/* ------------------------------------------------------------------ */
const roundUp = (v, step) => Math.ceil((v - 1e-9) / step) * step;
const fmt = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "—");
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ------------------------------------------------------------------ */
/*  平面布置 / 疏散距离校核 —— 几何与规范工具函数                          */
/*  所有坐标一律以 mm 存储；有底图时通过标定得到 mmPerPx，无底图时          */
/*  naturalW/H 直接代表假定的平面范围（mm），mmPerPx = 1。                 */
/* ------------------------------------------------------------------ */
function pointInPolygon(pt, poly) {
  if (poly.length < 3) return true; // 未绘制边界时不做越界判断
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    const hit = yi > pt.y !== yj > pt.y && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi + 1e-9) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}
/* 核心筒本地坐标系：原点在角点，x 沿长度 l，y 沿宽度 w；绕原点旋转 rot° 后平移到 (x,y) */
function coreLocalToWorld(core, lx, ly) {
  const rad = (core.rot * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  return { x: core.x + lx * cos - ly * sin, y: core.y + lx * sin + ly * cos };
}
function coreWorldToLocal(core, wx, wy) {
  const rad = (-core.rot * Math.PI) / 180;
  const dx = wx - core.x, dy = wy - core.y;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
}
/* 只转方向（不带平移），用于把核心筒本地坐标系里的方向/法线向量转到世界坐标 */
function coreLocalDirToWorld(core, lx, ly) {
  const rad = (core.rot * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  return { x: lx * cos - ly * sin, y: lx * sin + ly * cos };
}
/* 核心筒的门 (doorLocal) 离哪条边最近，返回该边的方向、法线（指向外侧）、
   门沿边的位置 at 与边长 len，用于把核心筒的门也画成带开合扇形的门符号 */
function coreDoorEdgeInfo(core) {
  const { x: dx, y: dy } = core.doorLocal;
  const l = core.l, w = core.w;
  const distL = dx, distR = l - dx, distT = dy, distB = w - dy;
  const min = Math.min(distL, distR, distT, distB);
  if (min === distL) return { lx0: 0, ly0: 0, dir: { x: 0, y: 1 }, normal: { x: -1, y: 0 }, len: w, at: clamp(dy, 0, w) };
  if (min === distR) return { lx0: l, ly0: 0, dir: { x: 0, y: 1 }, normal: { x: 1, y: 0 }, len: w, at: clamp(dy, 0, w) };
  if (min === distT) return { lx0: 0, ly0: 0, dir: { x: 1, y: 0 }, normal: { x: 0, y: -1 }, len: l, at: clamp(dx, 0, l) };
  return { lx0: 0, ly0: w, dir: { x: 1, y: 0 }, normal: { x: 0, y: 1 }, len: l, at: clamp(dx, 0, l) };
}
/* 把世界坐标点投影/夹到核心筒外框四条边上离它最近的一点（本地坐标），
   用于拖动核心筒的门标记时把它锁在核心筒四周的墙上，不让它跑进核心筒内部或跑到外面 */
function clampToCorePerimeter(core, worldPt) {
  const local = coreWorldToLocal(core, worldPt.x, worldPt.y);
  const l = core.l, w = core.w;
  const candidates = [
    { x: 0, y: clamp(local.y, 0, w) },
    { x: l, y: clamp(local.y, 0, w) },
    { x: clamp(local.x, 0, l), y: 0 },
    { x: clamp(local.x, 0, l), y: w },
  ];
  let best = candidates[0], bestD = Infinity;
  candidates.forEach((c) => {
    const d = Math.hypot(c.x - local.x, c.y - local.y);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  });
  return best;
}
/* 核心筒自己的门：铰链点（世界坐标）+ 关闭方向 + 开启方向，供 doorSymbolGeometry 画成同样的门符号 */
function coreDoorSymbolInfo(core, doorWidth) {
  const edge = coreDoorEdgeInfo(core);
  const hingeSign = core.doorHinge || 1, swingSign = core.doorSwing || 1;
  const hingeAt = clamp(hingeSign === 1 ? edge.at - doorWidth / 2 : edge.at + doorWidth / 2, 0, edge.len);
  const hingeLocal = { x: edge.lx0 + edge.dir.x * hingeAt, y: edge.ly0 + edge.dir.y * hingeAt };
  const hinge = coreLocalToWorld(core, hingeLocal.x, hingeLocal.y);
  const closedDir = coreLocalDirToWorld(core, edge.dir.x * hingeSign, edge.dir.y * hingeSign);
  const swingDir = coreLocalDirToWorld(core, edge.normal.x * swingSign, edge.normal.y * swingSign);
  return { hinge, closedDir, swingDir };
}
/* 门符号几何（平面图常见画法）：门扇画成开启状态的细长方形（带边框），配一段 90° 开合扇形弧线。
   hinge = 铰链点；closedDir = 关闭时门扇指向的方向（沿墙、单位向量）；
   swingDir = 开启后门扇指向的方向（垂直于墙、单位向量，两者互相垂直）；width = 门宽；leafT = 门扇厚度。
   走廊墙上的门和核心筒自己的门共用这一套几何。 */
function doorSymbolGeometry(hinge, closedDir, swingDir, width, leafT) {
  const openEnd = { x: hinge.x + swingDir.x * width, y: hinge.y + swingDir.y * width };
  const closedEnd = { x: hinge.x + closedDir.x * width, y: hinge.y + closedDir.y * width };
  const halfT = leafT / 2;
  const c1 = { x: hinge.x + closedDir.x * halfT, y: hinge.y + closedDir.y * halfT };
  const c2 = { x: hinge.x - closedDir.x * halfT, y: hinge.y - closedDir.y * halfT };
  const c3 = { x: openEnd.x - closedDir.x * halfT, y: openEnd.y - closedDir.y * halfT };
  const c4 = { x: openEnd.x + closedDir.x * halfT, y: openEnd.y + closedDir.y * halfT };
  const leafD = `M ${c1.x.toFixed(1)} ${c1.y.toFixed(1)} L ${c4.x.toFixed(1)} ${c4.y.toFixed(1)} L ${c3.x.toFixed(1)} ${c3.y.toFixed(1)} L ${c2.x.toFixed(1)} ${c2.y.toFixed(1)} Z`;
  const cross = closedDir.x * swingDir.y - closedDir.y * swingDir.x;
  const sweep = cross > 0 ? 0 : 1;
  const arcD = `M ${openEnd.x.toFixed(1)} ${openEnd.y.toFixed(1)} A ${width.toFixed(1)} ${width.toFixed(1)} 0 0 ${sweep} ${closedEnd.x.toFixed(1)} ${closedEnd.y.toFixed(1)}`;
  return { leafD, arcD, openEnd, closedEnd };
}
function coreCorners(core) {
  return [
    coreLocalToWorld(core, 0, 0),
    coreLocalToWorld(core, core.l, 0),
    coreLocalToWorld(core, core.l, core.w),
    coreLocalToWorld(core, 0, core.w),
  ];
}
function coreDoorWorld(core) {
  return coreLocalToWorld(core, core.doorLocal.x, core.doorLocal.y);
}
function polylineLength(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return d;
}
function polygonDiagonal(poly) {
  let max = 0;
  for (let i = 0; i < poly.length; i++) for (let j = i + 1; j < poly.length; j++) max = Math.max(max, Math.hypot(poly[i].x - poly[j].x, poly[i].y - poly[j].y));
  return max;
}
/* 分离轴定理：两个凸多边形（旋转矩形）是否重叠 */
function polysOverlap(a, b) {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p1 = poly[i], p2 = poly[(i + 1) % poly.length];
      const ax = -(p2.y - p1.y), ay = p2.x - p1.x;
      const len = Math.hypot(ax, ay) || 1;
      const ux = ax / len, uy = ay / len;
      const proj = (pt) => pt.x * ux + pt.y * uy;
      const ra = a.map(proj), rb = b.map(proj);
      if (Math.max(...ra) < Math.min(...rb) || Math.max(...rb) < Math.min(...ra)) return false;
    }
  }
  return true;
}
/* 3.4.2.5 疏散距离上限（mm），按用途简化分组 */
const TRAVEL_GROUPS = [
  { id: "f1", label: t("高危工业 High-hazard industrial (F1)"), limit: () => 25000 },
  { id: "office", label: t("办公 / 个人服务店铺 Office & personal service"), limit: () => 40000 },
  { id: "other", label: t("其他用途（按是否喷淋）"), limit: (sp) => (sp ? 45000 : 30000) },
];
const travelLimit = (groupId, sprinklered) => (TRAVEL_GROUPS.find((g) => g.id === groupId) || TRAVEL_GROUPS[2]).limit(sprinklered);
/* 3.4.2.3.(1)(4)(5)(6) 两出口最小间距（mm），relaxed 对应 VBBL 剪刀梯放宽至 4.5 m */
function requiredExitSeparation(diag, hasCorridor, relaxed) {
  if (relaxed) return 4500;
  const half = diag / 2;
  return hasCorridor ? Math.min(half, 9000) : Math.max(half, 9000);
}
/* 平面点击 → mm 坐标；vb 是当前可见的 viewBox（{x,y,w,h}，均为 mm），随缩放/平移变化 */
function clientToMm(evt, svgEl, vb) {
  const rect = svgEl.getBoundingClientRect();
  return { x: vb.x + (vb.w * (evt.clientX - rect.left)) / rect.width, y: vb.y + (vb.h * (evt.clientY - rect.top)) / rect.height };
}
/* 重新标定比例后，把已放置的边界 / 核心筒位置 / 墙体 / 门 / 路径按比例重新锚定到底图（核心筒自身尺寸与门的本地偏移不变） */
function rescalePositions(plan, ratio) {
  const scalePt = (p) => ({ x: p.x * ratio, y: p.y * ratio });
  return {
    ...plan,
    boundary: plan.boundary.map(scalePt),
    cores: plan.cores.map((c) => ({ ...c, x: c.x * ratio, y: c.y * ratio })),
    walls: plan.walls.map((w) => ({ ...w, x1: w.x1 * ratio, y1: w.y1 * ratio, x2: w.x2 * ratio, y2: w.y2 * ratio, t: w.t * ratio })),
    wallCandidates: (plan.wallCandidates || []).map((w) => ({ ...w, x1: w.x1 * ratio, y1: w.y1 * ratio, x2: w.x2 * ratio, y2: w.y2 * ratio, w: w.w * ratio })),
    // AI 识图给出的门/楼梯标记（目前只显示不转正），跟 wallCandidates 一样要跟着标定一起换算
    doorCandidates: (plan.doorCandidates || []).map((d) => ({ ...d, x1: d.x1 * ratio, y1: d.y1 * ratio, x2: d.x2 * ratio, y2: d.y2 * ratio })),
    stairCandidates: (plan.stairCandidates || []).map((s) => ({ ...s, x1: s.x1 * ratio, y1: s.y1 * ratio, x2: s.x2 * ratio, y2: s.y2 * ratio })),
    doors: plan.doors.map((d) => ({ ...d, at: d.at * ratio, width: d.width * ratio })),
    paths: plan.paths.map((p) => (p.kind === "auto" ? { ...p, src: scalePt(p.src) } : { ...p, pts: p.pts.map(scalePt) })),
  };
}

/* ------------------------------------------------------------------ */
/*  墙体 / 门 → 可行走区域的栅格 + 最短路径（Dijkstra，8 方向，避开墙体与核心筒） */
/* ------------------------------------------------------------------ */
const WALL_DEFAULT_T = 200; // 新绘制墙体的默认厚度 (mm)
const WALL_WIDTH_SLIDER_MAX = 150; // 墙体识别宽度过滤滑块的上限刻度（像素）；滑到底当"不限"，不是真卡死在 150px
const DOOR_DEFAULT_WIDTH = 1000; // 新添加门的默认宽度 (mm)
const MIN_ZOOM = 0.1; // 平面布置画布最小缩放（10%，可缩小看到比平面本身大 10 倍的视野）
const MAX_ZOOM = 20; // 平面布置画布最大缩放（2000%）
const VIEW_ASPECT = 16 / 9; // 平面布置画布固定的显示窗口宽高比
const GRID_SIZE = 100; // "网格吸附"开关打开后，拖动一律吸到的网格间距 (mm)，10 cm，两个轴无限延伸
const snapToGridValue = (v, size = GRID_SIZE) => Math.round(v / size) * size;
const snapToGridPoint = (pt, size = GRID_SIZE) => ({ x: snapToGridValue(pt.x, size), y: snapToGridValue(pt.y, size) });
function wallLength(w) {
  return Math.hypot(w.x2 - w.x1, w.y2 - w.y1) || 1;
}
/* 选中墙时的红色外框路径：比墙本身两头各长一点、两侧各宽一点的矩形轮廓 */
function wallHaloPath(w, margin) {
  const dx = w.x2 - w.x1, dy = w.y2 - w.y1;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
  const halfW = w.t / 2 + margin;
  const p1 = { x: w.x1 - ux * margin + nx * halfW, y: w.y1 - uy * margin + ny * halfW };
  const p2 = { x: w.x2 + ux * margin + nx * halfW, y: w.y2 + uy * margin + ny * halfW };
  const p3 = { x: w.x2 + ux * margin - nx * halfW, y: w.y2 + uy * margin - ny * halfW };
  const p4 = { x: w.x1 - ux * margin - nx * halfW, y: w.y1 - uy * margin - ny * halfW };
  return `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} L ${p2.x.toFixed(1)} ${p2.y.toFixed(1)} L ${p3.x.toFixed(1)} ${p3.y.toFixed(1)} L ${p4.x.toFixed(1)} ${p4.y.toFixed(1)} Z`;
}
/* 选中门时的红色外框路径：围住门宽范围内的那一段墙（借用 wallHaloPath，把门的宽度当成一段临时"子墙"） */
function doorHaloPath(wall, door, margin) {
  const len = wallLength(wall);
  const ux = (wall.x2 - wall.x1) / len, uy = (wall.y2 - wall.y1) / len;
  const a = clamp(door.at - door.width / 2, 0, len), b = clamp(door.at + door.width / 2, 0, len);
  const sub = { x1: wall.x1 + ux * a, y1: wall.y1 + uy * a, x2: wall.x1 + ux * b, y2: wall.y1 + uy * b, t: wall.t };
  return wallHaloPath(sub, margin);
}
function doorWorldOnWall(wall, door) {
  const len = wallLength(wall);
  const t = clamp(door.at, 0, len);
  return { x: wall.x1 + ((wall.x2 - wall.x1) * t) / len, y: wall.y1 + ((wall.y2 - wall.y1) * t) / len };
}
function nearestWallPoint(pt, walls) {
  let best = null;
  walls.forEach((w) => {
    const dx = w.x2 - w.x1, dy = w.y2 - w.y1;
    const len2 = dx * dx + dy * dy || 1;
    let t = ((pt.x - w.x1) * dx + (pt.y - w.y1) * dy) / len2;
    t = clamp(t, 0, 1);
    const px = w.x1 + t * dx, py = w.y1 + t * dy;
    const d = Math.hypot(pt.x - px, pt.y - py);
    if (!best || d < best.dist) best = { wall: w, at: t * Math.sqrt(len2), dist: d, point: { x: px, y: py } };
  });
  return best;
}
/* 吸附候选：其它墙的端点、以及沿墙身任意一点（可以吸到墙的中段做 T 形搭接，不只是两端）；
   加上核心筒外框的四个角点与四条边（cores 可选）。用于画墙 / 拖动墙端点时对齐，
   方便拼出严丝合缝的转角，也方便一段新墙直接搭接到另一段墙或核心筒墙身的中间。 */
function snapPoint(pt, walls, threshold, excludeWallId, cores) {
  let best = null;
  const consider = (x, y) => {
    const d = Math.hypot(pt.x - x, pt.y - y);
    if (d <= threshold && (!best || d < best.d)) best = { x, y, d };
  };
  walls.forEach((w) => {
    if (w.id === excludeWallId) return;
    const near = nearestWallPoint(pt, [w]);
    if (near) consider(near.point.x, near.point.y);
  });
  if (cores)
    cores.forEach((c) => {
      const corners = coreCorners(c);
      for (let i = 0; i < 4; i++) {
        const a = corners[i], b = corners[(i + 1) % 4];
        const dx = b.x - a.x, dy = b.y - a.y;
        const len2 = dx * dx + dy * dy || 1;
        const tt = clamp(((pt.x - a.x) * dx + (pt.y - a.y) * dy) / len2, 0, 1);
        consider(a.x + tt * dx, a.y + tt * dy);
      }
    });
  return best ? { x: best.x, y: best.y } : pt;
}
/* 智能对齐参考点：其它墙的两端点 + 核心筒四角 + （可选）楼层边界的其它顶点，
   可分别排除拖动中的墙 / 核心筒 / 边界顶点自身 */
function collectAlignPoints(walls, cores, excludeWallId, excludeCoreId, boundary, excludeBoundaryIndex) {
  const pts = [];
  walls.forEach((w) => {
    if (w.id === excludeWallId) return;
    pts.push({ x: w.x1, y: w.y1 });
    pts.push({ x: w.x2, y: w.y2 });
  });
  (cores || []).forEach((c) => {
    if (c.id === excludeCoreId) return;
    coreCorners(c).forEach((p) => pts.push(p));
  });
  (boundary || []).forEach((p, i) => {
    if (i === excludeBoundaryIndex) return;
    pts.push(p);
  });
  return pts;
}
/* X、Y 方向各自独立地找容差内最近的参考值（类似 Rhino smart track）：
   X 对上了就吸附 X、显示一条竖直参考线；Y 对上了就吸附 Y、显示一条水平参考线；两者可同时成立 */
function findAlignMatch(pt, points, tol) {
  let bestX = null, bestY = null;
  points.forEach((p) => {
    const dx = Math.abs(pt.x - p.x);
    if (dx <= tol && (!bestX || dx < bestX.d)) bestX = { v: p.x, d: dx };
    const dy = Math.abs(pt.y - p.y);
    if (dy <= tol && (!bestY || dy < bestY.d)) bestY = { v: p.y, d: dy };
  });
  return { x: bestX ? bestX.v : null, y: bestY ? bestY.v : null };
}
function buildObstacleGrid(mmW, mmH, boundary, walls, doors, cores, cell) {
  const cols = Math.max(1, Math.min(400, Math.ceil(mmW / cell)));
  const rows = Math.max(1, Math.min(400, Math.ceil(mmH / cell)));
  const blocked = new Uint8Array(cols * rows);
  const hasBoundary = boundary.length >= 3;
  if (hasBoundary) {
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) if (!pointInPolygon({ x: (c + 0.5) * cell, y: (r + 0.5) * cell }, boundary)) blocked[r * cols + c] = 1;
  }
  /* 用格心采样判断墙体是否挡住某格时，把判定半径按格子半对角线加宽，保证只要墙带与格子的
     实际方形区域有任何重叠就会被标记——否则较薄的墙（如 150–200mm）配上较粗的网格时，
     墙的中心线可能恰好落在相邻两列格心之间，导致一格都没标记上，路径就会从墙缝里穿过去 */
  const cellRadius = (cell * Math.SQRT2) / 2;
  const markSeg = (x1, y1, x2, y2, half, skipRanges) => {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
    const effHalf = half + cellRadius;
    const c0 = clamp(Math.floor((Math.min(x1, x2) - effHalf) / cell), 0, cols - 1), c1 = clamp(Math.floor((Math.max(x1, x2) + effHalf) / cell), 0, cols - 1);
    const r0 = clamp(Math.floor((Math.min(y1, y2) - effHalf) / cell), 0, rows - 1), r1 = clamp(Math.floor((Math.max(y1, y2) + effHalf) / cell), 0, rows - 1);
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        const px = (c + 0.5) * cell, py = (r + 0.5) * cell;
        const t = (px - x1) * ux + (py - y1) * uy;
        if (t < -effHalf || t > len + effHalf) continue;
        const perp = (px - x1) * nx + (py - y1) * ny;
        if (Math.abs(perp) > effHalf) continue;
        if (skipRanges && skipRanges.some(([a, b]) => t >= a && t <= b)) continue;
        blocked[r * cols + c] = 1;
      }
  };
  walls.forEach((w) => {
    const ranges = doors.filter((d) => d.wallId === w.id).map((d) => [d.at - d.width / 2, d.at + d.width / 2]);
    markSeg(w.x1, w.y1, w.x2, w.y2, w.t / 2, ranges);
  });
  cores.forEach((core) => {
    const corners = coreCorners(core);
    const xs = corners.map((p) => p.x), ys = corners.map((p) => p.y);
    const door = coreDoorWorld(core);
    const c0 = clamp(Math.floor(Math.min(...xs) / cell), 0, cols - 1), c1 = clamp(Math.floor(Math.max(...xs) / cell), 0, cols - 1);
    const r0 = clamp(Math.floor(Math.min(...ys) / cell), 0, rows - 1), r1 = clamp(Math.floor(Math.max(...ys) / cell), 0, rows - 1);
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        const px = (c + 0.5) * cell, py = (r + 0.5) * cell;
        if (Math.hypot(px - door.x, py - door.y) < cell * 1.5) continue; // 门口留出通行缺口
        if (pointInPolygon({ x: px, y: py }, corners)) blocked[r * cols + c] = 1;
      }
  });
  return { cols, rows, cell, blocked };
}
function dijkstraFromSource(grid, startCell) {
  return dijkstraMultiSource(grid, [startCell.r * grid.cols + startCell.c]);
}
/* 多源 Dijkstra：把若干个起点格同时放进堆（距离都是 0），一次扫完整张栅格，dist[i] 就是格 i 到"最近的
   那个起点"的最短路径长度。行走距离热力图用它：把所有核心筒的门当起点，跑一次就得到每个格子到最近
   门的距离——等价于"对每个格子各点一次自动最短路径"（无向栅格上最短路径是对称的），但只要跑一次
   而不是几千次，画布上能实时更新。 */
function dijkstraMultiSource(grid, startIdxs) {
  const { cols, rows, blocked, cell } = grid;
  const n = cols * rows;
  const dist = new Float64Array(n).fill(Infinity);
  const parent = new Int32Array(n).fill(-1);
  const visited = new Uint8Array(n);
  const heap = [];
  for (const startIdx of startIdxs) {
    if (startIdx < 0 || startIdx >= n || blocked[startIdx]) continue;
    dist[startIdx] = 0;
    heap.push([0, startIdx]);
  }
  if (!heap.length) return { dist, parent, cols, rows };
  const push = (item) => {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = 2 * i + 2;
        let sm = i;
        if (l < heap.length && heap[l][0] < heap[sm][0]) sm = l;
        if (r < heap.length && heap[r][0] < heap[sm][0]) sm = r;
        if (sm === i) break;
        [heap[sm], heap[i]] = [heap[i], heap[sm]];
        i = sm;
      }
    }
    return top;
  };
  const nbrs = [
    [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
    [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
  ];
  while (heap.length) {
    const [d, idx] = pop();
    if (visited[idx]) continue;
    visited[idx] = 1;
    if (d > dist[idx]) continue;
    const r = (idx / cols) | 0, c = idx % cols;
    for (const [dc, dr, wgt] of nbrs) {
      const nc = c + dc, nr = r + dr;
      if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
      const nidx = nr * cols + nc;
      if (blocked[nidx]) continue;
      if (dc !== 0 && dr !== 0 && (blocked[r * cols + nc] || blocked[nr * cols + c])) continue; // 不走对角穿墙
      const nd = d + wgt * cell;
      if (nd < dist[nidx]) {
        dist[nidx] = nd;
        parent[nidx] = idx;
        push([nd, nidx]);
      }
    }
  }
  return { dist, parent, cols, rows };
}
function simplifyCollinear(pts) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = out[out.length - 1], b = pts[i], c = pts[i + 1];
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (Math.abs(cross) > 1e-6) out.push(b);
  }
  out.push(pts[pts.length - 1]);
  return out;
}
/* 从平面上任意一点出发，沿可行走区域（避开墙体、核心筒）到指定/最近核心筒门的最短路径 */
function computeAutoPath(grid, srcMM, cores, targetCoreId) {
  const cellOf = (p) => ({ c: clamp(Math.floor(p.x / grid.cell), 0, grid.cols - 1), r: clamp(Math.floor(p.y / grid.cell), 0, grid.rows - 1) });
  const start = cellOf(srcMM);
  const result = dijkstraFromSource(grid, start);
  const candidates = targetCoreId ? cores.filter((c) => c.id === targetCoreId) : cores;
  let best = null;
  candidates.forEach((core) => {
    const door = coreDoorWorld(core);
    const dc = cellOf(door);
    const idx = dc.r * grid.cols + dc.c;
    if (Number.isFinite(result.dist[idx]) && (!best || result.dist[idx] < best.dist)) best = { dist: result.dist[idx], idx, coreId: core.id, door };
  });
  if (!best) return null;
  const cellPts = [];
  let cur = best.idx;
  while (cur !== -1) {
    const r = (cur / grid.cols) | 0, c = cur % grid.cols;
    cellPts.push({ x: (c + 0.5) * grid.cell, y: (r + 0.5) * grid.cell });
    cur = result.parent[cur];
  }
  cellPts.reverse();
  cellPts[0] = srcMM;
  cellPts[cellPts.length - 1] = best.door;
  const pts = simplifyCollinear(cellPts);
  return { pts, length: polylineLength(pts), coreId: best.coreId };
}

/* 行走距离热力图：整层按 cellMM（默认 1 m）打成粗格，每个粗格给出"格内最远的可行走点到最近核心筒门
   的最短路径长度"（避墙、穿门，跟"自动最短路径"用的是同一张障碍栅格和同一套 Dijkstra），再由调用方
   按规范限值判达标（绿）/超标（红）。
   实现不是对每个粗格各跑一次自动最短路径（1m 格在 50×50m 的楼面上有 2500 个，每个再跑一遍 Dijkstra
   太慢），而是反过来：把所有核心筒门当起点跑一次多源 Dijkstra（见 dijkstraMultiSource），细栅格上每一格
   到最近门的距离一次算完，粗格再取格内细格的最大值。取"最大值"而不是格心那一点：规范管的是楼面上
   任意一点，粗格里最不利的那个角落才是真正要校核的位置；格内没有任何可行走的细格（整格都是墙/核心筒/
   边界外）就跳过不画。 */
function computeTravelHeatmap(grid, cores, cellMM) {
  const { cols, rows, cell, blocked } = grid;
  const doorIdxs = cores.map((core) => {
    const d = coreDoorWorld(core);
    const c = clamp(Math.floor(d.x / cell), 0, cols - 1), r = clamp(Math.floor(d.y / cell), 0, rows - 1);
    return r * cols + c;
  });
  const { dist } = dijkstraMultiSource(grid, doorIdxs);
  const per = Math.max(1, Math.round(cellMM / cell)); // 一个粗格横/竖各包含多少个细格
  const hCols = Math.ceil(cols / per), hRows = Math.ceil(rows / per);
  const cells = [];
  let worst = 0, reachable = 0, unreachable = 0;
  for (let hr = 0; hr < hRows; hr++)
    for (let hc = 0; hc < hCols; hc++) {
      let maxD = -1, anyWalkable = false;
      for (let r = hr * per; r < Math.min(rows, (hr + 1) * per); r++)
        for (let c = hc * per; c < Math.min(cols, (hc + 1) * per); c++) {
          const i = r * cols + c;
          if (blocked[i]) continue;
          anyWalkable = true;
          const d = dist[i];
          if (Number.isFinite(d)) maxD = Math.max(maxD, d);
        }
      if (!anyWalkable) continue;
      const w = Math.min(per * cell, cols * cell - hc * per * cell), h = Math.min(per * cell, rows * cell - hr * per * cell);
      // 格内只要有任何一个细格能走到门就按最远的那个算；一个都走不到（被墙完全围死、漏开门）才算不可达
      const isUnreachable = maxD < 0;
      if (isUnreachable) unreachable++;
      else {
        reachable++;
        worst = Math.max(worst, maxD);
      }
      cells.push({ key: hr * hCols + hc, x: hc * per * cell, y: hr * per * cell, w, h, dist: isUnreachable ? Infinity : maxD });
    }
  return { cells, worst, reachable, unreachable, fineCell: cell, cellMM: per * cell };
}

function defaultFloors(n) {
  const arr = [];
  for (let i = 1; i <= n; i++) {
    if (i === 1) arr.push({ area: 800, use: "merc1", ffh: 9000, slab: 300, bedrooms: 0, ol: "" });
    else if (i === 2) arr.push({ area: 800, use: "dining", ffh: 4200, slab: 250, bedrooms: 0, ol: "" });
    else if (i <= 4) arr.push({ area: 800, use: "office", ffh: 3800, slab: 250, bedrooms: 0, ol: "" });
    else arr.push({ area: 700, use: "dwelling", ffh: 3000, slab: 200, bedrooms: 16, ol: "" });
  }
  return arr;
}

/* 沿 x 方向排布若干跑楼梯的踢面位置（用于平面与剖面） */
function layoutFlights(startX, dir, risersArr, run, Lmid, zStart, riser) {
  const flights = [];
  let cur = startX;
  let z = zStart;
  risersArr.forEach((r, j) => {
    const nosings = [];
    for (let k = 0; k < r; k++) nosings.push({ x: cur + dir * k * run, z: z + k * riser });
    const endX = cur + dir * (r - 1) * run;
    const endZ = z + r * riser;
    let landing = null;
    if (j < risersArr.length - 1) {
      landing = { x1: Math.min(endX, endX + dir * Lmid), x2: Math.max(endX, endX + dir * Lmid), z: endZ };
      cur = endX + dir * Lmid;
    } else cur = endX;
    flights.push({ nosings, dir, r, endX, endZ, landing, startZ: z });
    z = endZ;
  });
  return { flights, endX: cur, endZ: z };
}

/* ------------------------------------------------------------------ */
/*  核心计算                                                            */
/* ------------------------------------------------------------------ */
/* 折返梯逐层几何：每跑的起止 x、各平台按两个梯段带（band 0 = 首跑所在带，band 1 = 另一带）分半的边缘。
   规则：同一带内在同一平台相接的两跑共用边缘；对面（中间）平台默认取 xa，
   若上一层末跑落在与本层首跑同一带，则本层首跑从其到达位置起步，该带的对面平台随之加深。 */
function doglegGeometry(res, st, innerL, run) {
  const out = {};
  let prev = null; // 上一层末跑：{ band, x }
  let band0 = 0; // 本层首跑所在带：梯段带在整栋楼里连续交替，到达跑与起步跑必在不同带
  st.storeyLevels.forEach((L) => {
    const pf = res.perFloor[L - 1];
    const geo = st.geos.find((g) => g.L === L) || st.geos[st.geos.length - 1];
    const end = res.floorEnd[L] || 0;
    const fs = end === 0 ? -1 : 1;
    const xa = end === 0 ? innerL - geo.Lm : geo.Lf;
    const far = [xa, xa];
    const fr = pf.flightRisers;
    const n = fr.length;
    const flights = [];
    let zr = 0;
    fr.forEach((r, j) => {
      const band = (band0 + j) % 2;
      const toward = j % 2 === 0;
      const endX = toward ? far[band] : far[band] + fs * (r - 1) * run;
      const startX = toward ? far[band] + fs * (r - 1) * run : far[band];
      flights.push({ j, band, toward, startX, endX, r, dirT: toward ? -fs : fs, zr });
      zr += r;
    });
    // 楼层平台两半：起步跑所在带到起步踢面，另一带到上一层末跑到达踢面
    const floorEdge = [0, 0];
    floorEdge[band0] = flights[0].startX;
    floorEdge[1 - band0] = prev ? prev.x : flights[0].startX;
    const landings = [];
    let acc = 0;
    fr.forEach((r, j) => {
      acc += r;
      if (j >= n - 1) return;
      if (flights[j].toward) {
        landings.push({ side: "far", zr: acc, halves: far.map((x) => (end === 0 ? [x, innerL] : [0, x])), label: n > 2 ? t("休息平台") : t("中间平台") });
      } else {
        const e = [0, 0];
        e[flights[j].band] = flights[j].endX; // 到达跑所在带
        e[flights[j + 1].band] = flights[j + 1].startX; // 下一跑起步所在带
        landings.push({ side: "floor", zr: acc, halves: e.map((x) => (end === 0 ? [0, x] : [x, innerL])), label: t("休息平台") });
      }
    });
    prev = { band: flights[n - 1].band, x: flights[n - 1].endX };
    out[L] = { level: L, end, fs, xa, far, floorEdge, flights, landings, risers: acc, band0 };
    band0 = (band0 + n) % 2;
  });
  const topEnd = res.floorEnd[st.top] || 0;
  out.top = { level: st.top, end: topEnd, arrive: prev };
  return out;
}
const JAMB = 50; // 门框/铰链侧留缝（门扇贴侧墙时）
/* 端墙上门的位置：hinge = "wall" 时门扇贴 hingeAt 指定的侧墙、铰链在侧墙侧、开启后贴墙；"center" 时居中 */
/* 出口门尺寸（每部楼梯）：门口按 3.4.3.2.(1)(a) 6.1 mm/人算所需净宽，且 ≥ Table 3.4.3.2.-A 的 800 mm；门洞 = 净宽 + 门框约 JAMB。
   单扇门宽超过 adv.doorLeafMax（USER 设定，默认 1 220；NBC / BCBC / VBBL 本身没有单扇上限）就自动分成两扇，每扇 ≥610（3.4.6.11.(5)）。
   adv.doorLeaf 是设计门扇的下限（单扇时实际门扇 = max(所需, 下限)）。 */
const SWING_SPLIT_MIN_LEAF = 800; // 因摆动侵占通行范围而分扇时，每扇至少这么宽（比 3.4.6.11.(5) 的 610 更实用；Table 3.4.3.2.-A 门口最小也是 800）
function sizeExitDoor(persons, adv) {
  const leafMax = Number(adv.doorLeafMax) || 1220;
  const minLeaf = Number(adv.doorLeaf) || 0;
  const clearReq = Math.max(800, roundUp(Math.max(0, persons) * 6.1, 10));
  const openingReq = clearReq + JAMB;
  let leaves = 1;
  let leafW = roundUp(Math.max(openingReq, minLeaf), 10);
  if (leafW > leafMax) {
    leaves = 2;
    leafW = Math.max(610, roundUp(openingReq / 2, 10));
  }
  // 分成两扇后每扇仍超过上限：标记 overflow，校核表报 ✗（要另设门洞或放宽上限；这里不会再分到三扇以上）
  return { persons, clearReq, openingReq, leaves, leafW, opening: leaves * leafW, clear: leaves * leafW - JAMB, leafMax, minLeaf, overflow: leafW > leafMax };
}
function doorAlong(y1, y2, hingeAt, hinge, leaf) {
  if (hinge === "center") return { along: (y1 + y2 - leaf) / 2, hingeEnd: "low" };
  return hingeAt === "low" ? { along: y1 + JAMB, hingeEnd: "low" } : { along: y2 - JAMB - leaf, hingeEnd: "high" };
}
function distribute(total, n) {
  const per = Math.floor(total / n);
  const extra = total % n;
  return Array.from({ length: n }, (_, k) => per + (k < extra ? 1 : 0));
}
/* 调整各跑踢面数，使相邻两跑之和 ≥ need（末对用 needTop），每跑 3..cap 级；无解返回 null */
function fitLandingHeadroom(init, needMid, needTop, cap) {
  const n = init.length;
  const total = init.reduce((a, b) => a + b, 0);
  const need = (k) => (k === n - 2 ? needTop : needMid);
  if (n < 3) return init;
  if (total < 3 * n) return null;
  const a = init.slice();
  for (let iter = 0; iter < 200; iter++) {
    let bad = -1;
    for (let k = 0; k + 1 < n; k++) if (a[k] + a[k + 1] < need(k)) { bad = k; break; }
    if (bad < 0) return a;
    // 从不在该对中、且拿走一级后其相邻对仍满足要求的最大一跑挪一级过来
    let src = -1;
    for (let i = 0; i < n; i++) {
      if (i === bad || i === bad + 1 || a[i] <= 3) continue;
      const okL = i === 0 || a[i - 1] + a[i] - 1 >= need(i - 1);
      const okR = i === n - 1 || a[i] + a[i + 1] - 1 >= need(i);
      if (okL && okR && (src < 0 || a[i] > a[src])) src = i;
    }
    if (src < 0) return null;
    const dst = a[bad] <= a[bad + 1] ? bad : bad + 1;
    if (a[dst] + 1 > cap) return null;
    a[src] -= 1;
    a[dst] += 1;
  }
  return null;
}
function compute(inp) {
  const { nFloors: N, wall, maxStairW, stairType, includeL1, sprinklered, adv, floors } = inp;
  const { run, maxRise, gap, centerWall, doorLeaf, doorPos, waist, roundStep } = adv;
  const doorHinge = adv.doorHinge || "wall";
  const maxRPF = adv.maxRisers > 0 ? Math.max(3, adv.maxRisers) : Infinity; // 每跑最多踢面数（用户设定）
  const lvl0 = includeL1 ? 1 : 2;
  const mmppStair = run >= 280 && maxRise <= 180 ? 8 : 9.2;
  const warnings = [];

  const perFloor = [];
  for (let i = 0; i < N; i++) {
    const f = floors[i];
    const level = i + 1;
    const u = useById(f.use);
    let ol, olSrc;
    if (f.ol !== "" && f.ol != null && Number(f.ol) > 0) {
      ol = Math.ceil(Number(f.ol));
      olSrc = t("3.1.17.1.(1)(c)(i) 设计人数");
    } else if (u.id === "dwelling") {
      ol = 2 * (Number(f.bedrooms) || 0);
      olSrc = t("3.1.17.1.(1)(b) 2 人/卧室");
    } else if (u.m2) {
      ol = Math.ceil((Number(f.area) || 0) / u.m2);
      olSrc = t("Table 3.1.17.1 · {0} m²/人", [u.m2]);
    } else {
      ol = 0;
      olSrc = t("请填写人数");
    }
    const mmpp = u.mmpp || mmppStair;
    const wReq = ol * mmpp;
    const ffh = Number(f.ffh) || 0;
    const slab = Number(f.slab) || 0;
    const maxFlightRise = u.maxFlightRise || 3700;
    const risers = Math.max(1, Math.ceil(ffh / maxRise));
    const riser = risers ? ffh / risers : 0;
    const baseFlights = stairType === "dogleg" ? 2 : 1;
    const flightsBy37 = Math.ceil(ffh / maxFlightRise);
    const flightsByCap = maxRPF < Infinity ? Math.ceil(risers / maxRPF) : 1;
    const flights = Math.max(baseFlights, flightsBy37, flightsByCap); // 折返梯允许奇数跑：楼层平台交替落在两端
    const capGoverns = flightsByCap > Math.max(baseFlights, flightsBy37);
    const counted = level >= lvl0;
    const slabAbove = i + 1 < N ? Number(floors[i + 1].slab) || 0 : slab;
    /* 踢面分配：先均分；折返梯 >2 跑时同一端上下叠置的平台之间净高须 ≥2 050 (3.4.3.4.(1))，
       即相邻两跑踢面数之和 × 踢面高 ≥ 2 050 + 平台板厚（末两跑上方为楼板，用楼板厚）；不满足则挪动踢面 */
    let flightRisers = distribute(risers, flights);
    let headroomFix = null;
    if (stairType === "dogleg" && flights > 2 && riser > 0) {
      const needMid = Math.ceil((2050 + waist) / riser);
      const needTop = Math.ceil((2050 + slabAbove) / riser);
      const fixed = fitLandingHeadroom(flightRisers, needMid, needTop, maxRPF);
      if (fixed) {
        if (fixed.join() !== flightRisers.join()) headroomFix = "adjusted";
        flightRisers = fixed;
      } else headroomFix = "infeasible";
    }
    const maxR = Math.max(...flightRisers);
    const flightRun = (maxR - 1) * run;
    let headroom = ffh - slabAbove;
    if (stairType === "dogleg" && flights > 2) {
      for (let j = 0; j + 1 < flights; j++) {
        const h = (flightRisers[j] + flightRisers[j + 1]) * riser - (j + 2 === flights ? slabAbove : waist);
        headroom = Math.min(headroom, h);
      }
    }
    const headroomFlight = ffh - waist;
    const nReq = counted ? Math.max(2, Math.ceil(wReq / maxStairW)) : 0;
    const grp = u.group === "custom" ? "D" : u.group;
    const tbl = SINGLE_EXIT_AREA[sprinklered ? "sprinklered" : "unsprinklered"];
    const singleExitOK = counted && N <= 2 && ol <= 60 && (Number(f.area) || 0) <= (tbl[grp] || 0);
    if (counted || level < N) {
      if (riser < 125) warnings.push(t("L{0}: 踢面 {1} mm < 125 mm (3.4.6.8.(2))，层高过小", [level, riser.toFixed(0)]));
      if (Math.min(...flightRisers) < 3) warnings.push(t("L{0}: 每跑踢面数 < 3 (3.4.6.2.(1))", [level]));
      if (headroom < 2050) warnings.push(flights > 2 && stairType === "dogleg" ? t("L{0}: 同端叠置平台之间净高 {1} mm < 2 050 mm (3.4.3.4.(1))——{2} 跑 ({3}) 无论如何分配踢面都不够；请放宽每跑级数上限、加大层高或改剪刀梯", [level, fmt(headroom), flights, flightRisers.join("+")]) : t("L{0}: 楼层平台上方净高 {1} mm < 2 050 mm (3.4.3.4.(1))", [level, fmt(headroom)]));
      if (headroomFlight < 2050) warnings.push(t("L{0}: 梯段下净高 {1} mm < 2 050 mm (3.4.3.4.(1))", [level, fmt(headroomFlight)]));
      if (ol === 0 && counted) warnings.push(t("L{0}: 人数为 0，请填写卧室数或人数", [level]));
    }
    perFloor.push({ level, use: u, area: Number(f.area) || 0, ol, olSrc, mmpp, wReq, ffh, slab, slabAbove, risers, riser, flights, flightRisers, maxR, flightRun, capGoverns, flightsBy37, headroomFix, counted, headroom, headroomFlight, nReq, singleExitOK, bedrooms: Number(f.bedrooms) || 0 });
  }
  /* 折返梯楼层平台所在端：0 = 开口端（左），1 = 对面端（右）；奇数跑则上一层平台换端 */
  const floorEnd = { 1: 0 };
  for (let L = 1; L < N; L++) floorEnd[L + 1] = stairType === "dogleg" ? (floorEnd[L] + perFloor[L - 1].flights) % 2 : 0;
  perFloor.forEach((p) => (p.end = floorEnd[p.level]));

  /* 楼梯连续性：上层楼梯必须贯通至出口层 */
  const c = {};
  let running = 0;
  for (let L = N; L >= lvl0; L--) {
    running = Math.max(running, perFloor[L - 1].nReq);
    c[L] = running;
  }
  for (let L = 1; L < lvl0; L++) c[L] = running;
  const cBase = c[lvl0] || 2;
  const levels = [];
  for (let L = lvl0; L <= N; L++) levels.push(L);

  /* 门在端墙：贴侧墙开启后贴墙 → 门扇不占平台净深，仅需门扇前缘距踢面 ≥300 (3.4.6.11.(1))；
     居中开启后垂直端墙 → 平台剩余 ≥750 (3.4.3.3.(2))。门在侧墙 → 门洞 + 300。
     门的尺寸每部楼梯各自按人数算（sizeExitDoor），所以平台最小深度 doorMinK 也是每部楼梯一个。 */
  const doorMinFor = (door) => (doorPos === "end" ? (doorHinge === "wall" ? door.leafW + JAMB + 300 : door.leafW + 750) : door.opening + 300);

  const stairs = [];
  for (let k = 1; k <= cBase; k++) {
    let top = lvl0;
    for (let L = lvl0; L <= N; L++) if (c[L] >= k) top = L;
    const served = levels.filter((L) => L <= top);
    const wReqStair = Math.max(...served.map((L) => perFloor[L - 1].wReq / c[L]));
    const govW = served.reduce((best, L) => (perFloor[L - 1].wReq / c[L] > perFloor[best - 1].wReq / c[best] ? L : best), served[0]);
    let minW = top - 1 > 2 ? 1100 : 900;
    let minWSrc = top - 1 > 2 ? t("Table 3.4.3.2.-A（服务 >2 层）") : t("Table 3.4.3.2.-A（服务 ≤2 层）");
    served.forEach((L) => {
      const u = perFloor[L - 1].use;
      if (u.minW && u.minW > minW) {
        minW = u.minW;
        minWSrc = t("Table 3.4.3.2.-B（B2 病房）");
      }
    });
    const W = roundUp(Math.max(wReqStair, minW), roundStep);
    if (W > maxStairW) warnings.push(t("楼梯 {0}: 最小宽度 {1} mm 超过设定的单梯最大宽度 {2} mm", [k, fmt(W), fmt(maxStairW)]));
    /* 这部楼梯的出口门：按它分担的最不利楼层人数（和梯宽同一个分摊口径）× 6.1 mm/人 */
    const doorPersons = Math.max(...served.map((L) => (perFloor[L - 1].ol || 0) / c[L]));
    let door = sizeExitDoor(doorPersons, adv);
    let doorMinK = doorMinFor(door);
    /* 门的摆动侵占通行范围：楼梯本身只要平台深 Lf0（折返 = 梯宽；剪刀 = min(梯宽, 1100)），单扇门却要把平台顶到 doorMinK > Lf0 时，
       试着分成两扇（每扇 ≥ SWING_SPLIT_MIN_LEAF，太窄的两扇不实用就不分）；分完摆动半径减半、平台回到 Lf0 才算成功，否则保持单扇、平台加深。 */
    const Lf0 = stairType === "dogleg" ? W : Math.min(W, 1100);
    door.landingBase = Lf0;
    door.doorMinSingle = doorMinK;
    if (door.leaves === 1 && doorMinK > Lf0) {
      const leaf2 = Math.max(610, roundUp(door.openingReq / 2, 10));
      const door2 = { ...door, leaves: 2, leafW: leaf2, opening: 2 * leaf2, clear: 2 * leaf2 - JAMB, overflow: leaf2 > door.leafMax };
      const doorMin2 = doorMinFor(door2);
      door.swingTry = { leafW: leaf2, doorMin: doorMin2 };
      if (leaf2 >= SWING_SPLIT_MIN_LEAF && doorMin2 <= Lf0) {
        door = { ...door2, splitReason: "swing", landingBase: Lf0, doorMinSingle: doorMinK, swingTry: door.swingTry };
        doorMinK = doorMin2;
      }
    }
    if (door.leaves === 2 && !door.splitReason) door.splitReason = "leafMax";
    door.intrudes = doorMinK > Lf0; // 最终门仍把平台顶深了（没分或分了也不够）
    /* 楼梯实际穿越的各层（自出口层至其终止层下一层）的几何 */
    const storeyLevels = [];
    for (let L = 1; L < top; L++) storeyLevels.push(L);
    if (storeyLevels.length === 0) storeyLevels.push(1);
    let anyRight = false;
    for (let L = 1; L <= top; L++) if (floorEnd[L] === 1) anyRight = true;
    const geos = storeyLevels.map((L) => {
      const pf = perFloor[L - 1];
      let Lf, Lm, Lend, Lmid, Ltot, body;
      if (stairType === "dogleg") {
        Lf = Math.max(W, doorMinK);
        Lm = anyRight ? Lf : W; // 有楼层平台落在右端时，右端也要满足开门平台深度
        Ltot = Lf + pf.flightRun + Lm;
        return { L, Lf, Lm, flightRun: pf.flightRun, Ltot };
      }
      Lend = Math.max(Math.min(W, 1100), doorMinK);
      Lmid = Math.min(W, 1100);
      body = pf.flights * pf.flightRun + (pf.flights - 1) * Lmid;
      Ltot = 2 * Lend + body;
      return { L, Lend, Lmid, body, flightRun: pf.flightRun, Ltot };
    });
    const gov = geos.reduce((b, g) => (g.Ltot > b.Ltot ? g : b), geos[0]);
    stairs.push({ k, top, served, storeyLevels, wReqStair, govW, minW, minWSrc, W, geos, L: gov.Ltot, govLevel: gov.L, midHandrail: W > 1500, door, doorMin: doorMinK });
  }

  if (stairType === "dogleg") stairs.forEach((st) => (st.storeyGeo = doglegGeometry({ perFloor, floorEnd }, st, st.L, run)));
  const shaftsFor = (list) => {
    if (stairType === "dogleg") return list.map((st) => ({ stairs: [st], innerW: 2 * st.W + gap, innerL: st.L }));
    const out = [];
    for (let i = 0; i < list.length; i += 2) {
      const a = list[i], b = list[i + 1];
      if (b) out.push({ stairs: [a, b], innerW: a.W + centerWall + b.W, innerL: Math.max(a.L, b.L) });
      else out.push({ stairs: [a], innerW: a.W, innerL: a.L, single: true });
    }
    return out;
  };

  /* 分区 */
  const zones = [];
  let zs = lvl0;
  for (let L = lvl0; L <= N; L++) {
    if (L === N || c[L + 1] !== c[L]) {
      const count = c[L];
      const list = stairs.slice(0, count);
      const shafts = shaftsFor(list);
      const totW = shafts.reduce((s, sh) => s + sh.innerW, 0) + (shafts.length + 1) * wall;
      const totL = Math.max(...shafts.map((sh) => sh.innerL)) + 2 * wall;
      zones.push({ from: zs, to: L, count, stairs: list, shafts, totW, totL, area: (totW * totL) / 1e6 });
      zs = L + 1;
    }
  }

  const allRes = perFloor.filter((p) => p.counted).every((p) => p.use.group === "C");
  const doorMin = stairs.length ? Math.max(...stairs.map((s) => s.doorMin)) : 0; // 兼容：各梯里最大的那个
  return { perFloor, c, cBase, lvl0, levels, stairs, zones, warnings, mmppStair, doorMin, allRes, maxRPF, floorEnd };
}

/* ------------------------------------------------------------------ */
/*  小组件                                                              */
/* ------------------------------------------------------------------ */
function Ref({ k, art }) {
  const code = k ? codeByKey(k) : null;
  const label = art || (code ? code.art : "");
  const title = code ? `${code.title} — ${LEVEL_LABEL[code.level]}` : "";
  return (
    <span
      title={title}
      style={{ background: C.tag, color: C.accent, border: `1px solid ${C.rule}`, borderRadius: 3, padding: "0 5px", fontSize: 11, lineHeight: "18px", whiteSpace: "nowrap", verticalAlign: "middle" }}
    >
      {label}
    </span>
  );
}

function Num({ label, value, onChange, unit, step = 1, min, max, width = 110, hint, commitOnBlur = false }) {
  /* commitOnBlur：编辑过程中只改本地草稿，失焦或回车才真正提交给上层。门宽这类带"下限/默认值"规则的
     字段如果每敲一个字符就提交，用户刚把 600 删空，上层立刻把它改回默认值，根本没法重新输入——用户反馈
     "没法删除 600 这个数字并修改"就是这个问题。普通字段保持原来的即时提交行为。 */
  const [draft, setDraft] = useState(null);
  const shown = commitOnBlur && draft !== null ? draft : value;
  const commit = () => {
    if (draft === null) return;
    const v = draft === "" ? "" : Number(draft);
    setDraft(null);
    onChange(v);
  };
  return (
    <label className="flex items-center justify-between gap-3 py-1" style={{ fontSize: 13 }}>
      <span style={{ color: C.ink }}>
        {label}
        {hint && <span style={{ color: C.muted, marginLeft: 6, fontSize: 11 }}>{hint}</span>}
      </span>
      <span className="flex items-center gap-1">
        <input
          type="number"
          value={shown}
          step={step}
          min={min}
          max={max}
          onChange={(e) => (commitOnBlur ? setDraft(e.target.value) : onChange(e.target.value === "" ? "" : Number(e.target.value)))}
          onBlur={commitOnBlur ? commit : undefined}
          onKeyDown={commitOnBlur ? (e) => { if (e.key === "Enter") e.currentTarget.blur(); } : undefined}
          className="rounded px-2 py-1 text-right"
          style={{ width, border: `1px solid ${C.rule}`, fontVariantNumeric: "tabular-nums", color: C.ink, background: C.panel }}
        />
        {unit && <span style={{ color: C.muted, fontSize: 11, width: 24 }}>{unit}</span>}
      </span>
    </label>
  );
}

function Toggle({ label, checked, onChange, hint }) {
  return (
    <label className="flex items-center justify-between gap-3 py-1 cursor-pointer" style={{ fontSize: 13 }}>
      <span>
        {label}
        {hint && <span style={{ color: C.muted, marginLeft: 6, fontSize: 11 }}>{hint}</span>}
      </span>
      <span
        onClick={() => onChange(!checked)}
        role="switch"
        aria-checked={checked}
        style={{ width: 36, height: 20, borderRadius: 10, background: checked ? C.accent : C.rule, position: "relative", transition: "background .15s", flexShrink: 0 }}
      >
        <span style={{ position: "absolute", top: 2, left: checked ? 18 : 2, width: 16, height: 16, borderRadius: 8, background: C.panel, transition: "left .15s" }} />
      </span>
    </label>
  );
}

function Seg({ options, value, onChange }) {
  return (
    <div className="inline-flex rounded overflow-hidden" style={{ border: `1px solid ${C.rule}` }}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className="px-3 py-1"
          style={{ fontSize: 12, background: value === o.value ? C.accent : C.panel, color: value === o.value ? C.onAccent : C.ink, borderRight: `1px solid ${C.rule}` }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* 面板标题。传了 onToggle 就在右端画一个小的 ▾/▸ 折叠按钮（整行标题也可点）；收起时不画底线和下边距。 */
function H2({ children, sub, open = true, onToggle }) {
  const collapsible = typeof onToggle === "function";
  return (
    <div
      className={"flex items-baseline gap-3" + (open ? " mb-3 pb-2" : "")}
      style={{ borderBottom: open ? `1px solid ${C.rule}` : "none", cursor: collapsible ? "pointer" : undefined, userSelect: collapsible ? "none" : undefined }}
      onClick={collapsible ? onToggle : undefined}
    >
      <h2 style={{ fontSize: 17, fontWeight: 600, color: C.ink, margin: 0 }}>{children}</h2>
      {sub && (open || !collapsible) && <span style={{ color: C.muted, fontSize: 12 }}>{sub}</span>}
      {collapsible && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          aria-expanded={open}
          title={open ? t("收起本面板") : t("展开本面板")}
          className="rounded"
          style={{ marginLeft: "auto", width: 22, height: 22, lineHeight: "20px", fontSize: 12, color: C.muted, border: `1px solid ${C.rule}`, background: C.panel, flexShrink: 0, alignSelf: "center" }}
          data-testid="panel-toggle"
        >
          {open ? "▾" : "▸"}
        </button>
      )}
    </div>
  );
}

/* 计算器页的可折叠面板：每个面板右上角一个小按钮，收起只留标题行；状态记在 localStorage（按 id），刷新后保持。
   收起用 display:none 而不是卸载，三维视图的相机 / Rhino 连接 / 表格滚动位置都不会丢；三维视图自己有 ResizeObserver，重新展开时会按容器宽度重画。 */
const CALC_PANELS_KEY = "stair-core:calc-panels";
const readCalcPanels = () => {
  try {
    const v = JSON.parse(localStorage.getItem(CALC_PANELS_KEY) || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
};
function Panel({ id, title, sub, children, className = "rounded-lg p-5", style }) {
  const [open, setOpen] = useState(() => readCalcPanels()[id] !== false);
  const toggle = () =>
    setOpen((o) => {
      const next = !o;
      try {
        const all = readCalcPanels();
        all[id] = next;
        localStorage.setItem(CALC_PANELS_KEY, JSON.stringify(all));
      } catch {
        /* 隐私模式等：只在本次会话里生效 */
      }
      return next;
    });
  return (
    <section className={className} style={{ background: C.panel, border: `1px solid ${C.rule}`, ...style }} data-panel={id} data-open={open ? "1" : "0"}>
      <H2 sub={sub} open={open} onToggle={toggle}>
        {title}
      </H2>
      <div style={open ? undefined : { display: "none" }}>{children}</div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  尺寸线                                                              */
/* ------------------------------------------------------------------ */
function HDim({ x1, x2, y, label, above = true, color = C.line }) {
  if (Math.abs(x2 - x1) < 2) return null;
  const tight = Math.abs(x2 - x1) < 48; // 短尺寸：文字外移一层
  const ty = above ? (tight ? y - 16 : y - 4) : tight ? y + 24 : y + 12;
  return (
    <g stroke={color} strokeWidth="0.8" fill="none">
      <line x1={x1} y1={y} x2={x2} y2={y} />
      <line x1={x1 - 3} y1={y + 3} x2={x1 + 3} y2={y - 3} />
      <line x1={x2 - 3} y1={y + 3} x2={x2 + 3} y2={y - 3} />
      {tight && <line x1={(x1 + x2) / 2} y1={y} x2={(x1 + x2) / 2} y2={above ? y - 12 : y + 12} strokeDasharray="2 2" />}
      <text x={(x1 + x2) / 2} y={ty} textAnchor="middle" fill={color} stroke="none" fontSize="10.5">
        {label}
      </text>
    </g>
  );
}
function VDim({ y1, y2, x, label, left = true, color = C.line }) {
  if (Math.abs(y2 - y1) < 2) return null;
  const tight = Math.abs(y2 - y1) < 48;
  const tx = left ? (tight ? x - 18 : x - 4) : tight ? x + 18 : x + 4;
  return (
    <g stroke={color} strokeWidth="0.8" fill="none">
      <line x1={x} y1={y1} x2={x} y2={y2} />
      <line x1={x - 3} y1={y1 + 3} x2={x + 3} y2={y1 - 3} />
      <line x1={x - 3} y1={y2 + 3} x2={x + 3} y2={y2 - 3} />
      {tight && <line x1={x} y1={(y1 + y2) / 2} x2={left ? x - 12 : x + 12} y2={(y1 + y2) / 2} strokeDasharray="2 2" />}
      <text
        x={tx}
        y={(y1 + y2) / 2}
        textAnchor="middle"
        fill={color}
        stroke="none"
        fontSize="10.5"
        transform={`rotate(-90 ${tx} ${(y1 + y2) / 2})`}
        dy={left ? 0 : 8}
      >
        {label}
      </text>
    </g>
  );
}
function Hatch({ id }) {
  return (
    <pattern id={id} width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="7" height="7" fill={C.wallFill} />
      <line x1="0" y1="0" x2="0" y2="7" stroke={C.hatch} strokeWidth="0.9" />
    </pattern>
  );
}

/* ------------------------------------------------------------------ */
/*  平面图                                                              */
/* ------------------------------------------------------------------ */
function PlanSVG({ res, inp, shaftIdx, level }) {
  const { stairType, wall, adv } = inp;
  const { run, gap, centerWall, doorLeaf, doorPos } = adv;
  const doorOf = (st) => (st && st.door) || { opening: doorLeaf, leafW: doorLeaf, leaves: 1 }; // 每部楼梯自己算出来的门（兼容老结果）
  const doorHinge = adv.doorHinge || "wall";
  const doorSide = adv.doorSide || "dn";
  const zone = res.zones[0];
  const shaft = zone.shafts[clamp(shaftIdx, 0, zone.shafts.length - 1)];
  const pf = res.perFloor[level - 1];
  const innerW = shaft.innerW;
  const innerL = shaft.innerL;
  const outerW = innerW + 2 * wall;
  const outerL = innerL + 2 * wall;
  const M = 64;
  const maxPx = 640;
  const s = Math.min((maxPx - 2 * M) / outerL, (380 - 2 * M) / outerW);
  const X = (mm) => M + (mm + wall) * s; // mm 以内墙面为原点
  const Y = (mm) => M + (mm + wall) * s;
  const svgW = outerL * s + 2 * M;
  const svgH = outerW * s + 2 * M;

  const bands = [];
  const landings = [];
  const dividers = [];
  const doors = [];
  const walkBands = []; // 人行通行范围（门 → 梯段起步）{x1,x2,y1,y2,depth,remain,need,ok}
  // 门摆动之后通行范围还剩多少：跟计算器 doorMin 的口径一致——贴墙门看门边距踢面（≥300，3.4.6.11.(1)），居中门看门后剩余（≥750，3.4.3.3.(2)），侧墙门看门洞 + 300
  const walkRemain = (depth, dd) => {
    const remain = doorPos !== "end" ? depth - dd.opening : doorHinge === "wall" ? depth - (dd.leafW + JAMB) : depth - dd.leafW;
    const need = doorPos === "end" && doorHinge !== "wall" ? 750 : 300;
    return { depth, remain, need, ok: remain >= need };
  };
  const topDims = [];
  const leftDims = [];
  let title = "";

  if (stairType === "dogleg") {
    const st = shaft.stairs[0];
    const W = st.W;
    const g = st.storeyGeo[level] || st.storeyGeo[st.storeyLevels[st.storeyLevels.length - 1]];
    const { end, fs, far, floorEdge } = g;
    const half = innerW / 2;
    const f0 = g.flights[0]; // 本层起步（上行）跑
    const bUp = f0.band;
    const bDn = 1 - bUp;
    // 另一带显示从下一层到达本层楼层平台的那一跑（向下行走）；首层无下层时显示本层第 2 跑
    const gPrev = st.storeyGeo[level - 1];
    const dn = gPrev ? gPrev.flights[gPrev.flights.length - 1] : null;
    const f1 = dn || g.flights.find((f) => f.band === bDn) || null;
    const nosOf = (f) => Array.from({ length: f.r }, (_, k) => f.startX + f.dirT * k * run);
    const lab = (band) => g.flights.filter((f) => f.band === band).map((f) => f.r).join("/");
    const yOf = (band) => (band === 0 ? 0 : W + gap);
    bands.push({ y0: yOf(bUp), h: W, nosings: nosOf(f0), label: t("上 UP · {0} 步", [lab(bUp)]), arrow: [f0.startX + f0.dirT * run * 0.4, f0.endX - f0.dirT * run * 0.4], cut: true });
    if (f1) bands.push({ y0: yOf(bDn), h: W, nosings: nosOf(f1), label: dn ? t("下 DN · {0} 步（自 L{1}）", [dn.r, level - 1]) : t("上 UP 第 2 跑 · {0} 步", [lab(bDn)]), arrow: [f1.endX + f1.dirT * run * 0.4, f1.startX - f1.dirT * run * 0.4], cut: false });
    const farEdge = [0, 0];
    farEdge[bUp] = f0.endX;
    farEdge[bDn] = dn ? dn.startX : far[bDn];
    const floorRange = (x) => (end === 0 ? [0, x] : [x, innerL]);
    const farRange = (x) => (end === 0 ? [x, innerL] : [0, x]);
    const floorLabel = t("楼层平台 L{0}", [level]);
    const farLabel = g.flights.length > 2 ? t("休息平台") : t("中间平台");
    // 楼层平台与对面平台各分两半（band 0 上半 / band 1 下半），长度分别贴合各自带内的梯段
    [0, 1].forEach((b) => {
      const [fx1, fx2] = floorRange(floorEdge[b]);
      landings.push({ x1: fx1, x2: fx2, y1: b === 0 ? 0 : half, y2: b === 0 ? half : innerW, label: b === bUp ? floorLabel : floorEdge[0] !== floorEdge[1] ? fmt(Math.abs(fx2 - fx1)) : "" });
      const [ax1, ax2] = farRange(farEdge[b]);
      landings.push({ x1: ax1, x2: ax2, y1: b === 0 ? 0 : half, y2: b === 0 ? half : innerW, label: b === bUp ? farLabel : farEdge[0] !== farEdge[1] ? fmt(Math.abs(ax2 - ax1)) : "" });
    });
    const allX = [f0.startX, f0.endX, ...(f1 ? [f1.startX, f1.endX] : [])];
    dividers.push({ y: W, h: gap, hatched: false, x1: Math.min(...allX), x2: Math.max(...allX) });
    const depth0 = end === 0 ? Math.min(...floorEdge) : innerL - Math.max(...floorEdge);
    const hingeBand = doorSide === "dn" ? bDn : bUp; // 门贴哪一带的侧墙
    const dDoor = doorOf(shaft.stairs[0]);
    const da = doorAlong(0, innerW, hingeBand === 0 ? "low" : "high", doorHinge, dDoor.opening);
    if (end === 0) doors.push(doorPos === "end" ? { side: "left", along: da.along, hingeEnd: da.hingeEnd, door: dDoor } : { side: "bottom", along: Math.max(0, (depth0 - dDoor.opening - 300) / 2), door: dDoor });
    else doors.push(doorPos === "end" ? { side: "right", along: da.along, hingeEnd: da.hingeEnd, door: dDoor } : { side: "bottom", along: innerL - Math.max(0, (depth0 - dDoor.opening - 300) / 2) - dDoor.opening, door: dDoor });
    /* 人行通行范围：门所在那条梯段带上、从端墙到梯段起步处的整段楼层平台；标注门摆动之后还剩多少（贴墙门按门边距踢面 ≥300，居中门按 ≥750，侧墙门按门洞 + 300） */
    {
      const bandY = hingeBand === 0 ? [0, W] : [innerW - W, innerW];
      const edge = floorEdge[hingeBand];
      const [x1, x2] = end === 0 ? [0, edge] : [edge, innerL];
      walkBands.push({ x1, x2, y1: bandY[0], y2: bandY[1], ...walkRemain(x2 - x1, dDoor) });
    }
    const xs0 = [f0.startX, f0.endX].sort((a, b2) => a - b2);
    if (end === 0) topDims.push({ x1: 0, x2: xs0[0], label: t("楼层平台 {0}", [fmt(xs0[0])]) }, { x1: xs0[0], x2: xs0[1], label: `${f0.r - 1} × ${run} = ${fmt(xs0[1] - xs0[0])}` }, { x1: xs0[1], x2: innerL, label: t("平台 {0}", [fmt(innerL - xs0[1])]) });
    else topDims.push({ x1: 0, x2: xs0[0], label: t("平台 {0}", [fmt(xs0[0])]) }, { x1: xs0[0], x2: xs0[1], label: `${f0.r - 1} × ${run} = ${fmt(xs0[1] - xs0[0])}` }, { x1: xs0[1], x2: innerL, label: t("楼层平台 {0}", [fmt(innerL - xs0[1])]) });
    leftDims.push({ y1: 0, y2: W, label: t("净宽 {0}", [fmt(W)]) });
    if (gap > 0) leftDims.push({ y1: W, y2: W + gap, label: `${fmt(gap)}` });
    leftDims.push({ y1: W + gap, y2: innerW, label: t("净宽 {0}", [fmt(W)]) });
    title = t("楼梯 {0} · 折返梯 · L{1} 平面{2}", [st.k, level, pf.flights % 2 === 1 ? t("（{0} 跑，L{1} 平台换到{2}端）", [pf.flights, level + 1, end === 0 ? t("右") : t("左")]) : ""]);
  } else {
    const [a, b] = shaft.stairs;
    const geoA = a.geos.find((g) => g.L === level) || a.geos[a.geos.length - 1];
    const bodyLen = geoA.body;
    const LendEff = (innerL - bodyLen) / 2;
    const lay = layoutFlights(LendEff, +1, pf.flightRisers, run, geoA.Lmid, 0, 1);
    const nosA = lay.flights.flatMap((f) => f.nosings.map((n) => n.x));
    bands.push({ y0: 0, h: a.W, nosings: nosA, label: t("楼梯 {0} 上 UP · {1} 步", [a.k, pf.risers]), arrow: [LendEff + run * 0.4, innerL - LendEff - run * 0.4], cut: true });
    lay.flights.forEach((f) => f.landing && landings.push({ x1: f.landing.x1, x2: f.landing.x2, y1: 0, y2: a.W, label: t("中间平台") }));
    landings.push({ x1: 0, x2: LendEff, y1: 0, y2: a.W, label: t("L{0} 平台", [level]) });
    landings.push({ x1: innerL - LendEff, x2: innerL, y1: 0, y2: a.W, label: t("L{0} 平台", [level + 1]) });
    const dA = doorOf(a);
    const daA = doorAlong(0, a.W, "low", doorHinge, dA.opening);
    doors.push(doorPos === "end" ? { side: "left", along: daA.along, hingeEnd: daA.hingeEnd, door: dA } : { side: "top", along: Math.max(0, (LendEff - dA.opening - 300) / 2), door: dA });
    walkBands.push({ x1: 0, x2: LendEff, y1: 0, y2: a.W, ...walkRemain(LendEff, dA) });
    if (b) {
      const layB = layoutFlights(innerL - LendEff, -1, pf.flightRisers, run, geoA.Lmid, 0, 1);
      const yB = a.W + centerWall;
      bands.push({ y0: yB, h: b.W, nosings: layB.flights.flatMap((f) => f.nosings.map((n) => n.x)), label: t("楼梯 {0} 上 UP · {1} 步", [b.k, pf.risers]), arrow: [innerL - LendEff - run * 0.4, LendEff + run * 0.4], cut: true });
      layB.flights.forEach((f) => f.landing && landings.push({ x1: f.landing.x1, x2: f.landing.x2, y1: yB, y2: innerW, label: t("中间平台") }));
      landings.push({ x1: innerL - LendEff, x2: innerL, y1: yB, y2: innerW, label: t("L{0} 平台", [level]) });
      landings.push({ x1: 0, x2: LendEff, y1: yB, y2: innerW, label: t("L{0} 平台", [level + 1]) });
      dividers.push({ y: a.W, h: centerWall, hatched: true });
      const dB = doorOf(b);
      const daB = doorAlong(yB, innerW, "high", doorHinge, dB.opening);
      doors.push(doorPos === "end" ? { side: "right", along: daB.along, hingeEnd: daB.hingeEnd, door: dB } : { side: "bottom", along: innerL - Math.max(0, (LendEff - dB.opening - 300) / 2) - dB.opening, door: dB });
      walkBands.push({ x1: innerL - LendEff, x2: innerL, y1: yB, y2: innerW, ...walkRemain(LendEff, dB) });
      leftDims.push({ y1: 0, y2: a.W, label: t("净宽 {0}", [fmt(a.W)]) }, { y1: a.W, y2: yB, label: t("隔墙 {0}", [fmt(centerWall)]) }, { y1: yB, y2: innerW, label: t("净宽 {0}", [fmt(b.W)]) });
      title = t("剪刀梯（楼梯 {0} + {1}）· L{2} 平面", [a.k, b.k, level]);
    } else {
      leftDims.push({ y1: 0, y2: a.W, label: t("净宽 {0}", [fmt(a.W)]) });
      title = t("楼梯 {0} · 直跑梯 · L{1} 平面", [a.k, level]);
    }
    topDims.push({ x1: 0, x2: LendEff, label: t("平台 {0}", [fmt(LendEff)]) });
    lay.flights.forEach((f, j) => {
      const xs = f.nosings.map((n) => n.x);
      topDims.push({ x1: Math.min(...xs), x2: Math.max(...xs), label: `${f.r - 1} × ${run}` });
      if (f.landing) topDims.push({ x1: f.landing.x1, x2: f.landing.x2, label: t("平台 {0}", [fmt(geoA.Lmid)]) });
    });
    topDims.push({ x1: innerL - LendEff, x2: innerL, label: t("平台 {0}", [fmt(LendEff)]) });
  }

  /* 人行通行范围：虚线框 + "通行范围 深度（≥750）"，不够 750 标红。门摆动占掉的扇形另外画在门符号里。 */
  const walkElems = walkBands.map((wb, i) => {
    if (!(wb.x2 > wb.x1 + 1) || !(wb.y2 > wb.y1 + 1)) return null;
    const col = wb.ok ? C.ok : C.err;
    const cx = X((wb.x1 + wb.x2) / 2), cy = Y((wb.y1 + wb.y2) / 2);
    return (
      <g key={"walk" + i} pointerEvents="none">
        <rect x={X(wb.x1)} y={Y(wb.y1)} width={(wb.x2 - wb.x1) * s} height={(wb.y2 - wb.y1) * s} fill={col} fillOpacity={0.07} stroke={col} strokeWidth="1" strokeDasharray="5 3" />
        <text x={cx} y={cy - 3} fontSize="8.5" fill={col} textAnchor="middle" style={{ paintOrder: "stroke", stroke: C.panel, strokeWidth: 2.5 }}>
          {t("通行范围 {0}", [fmt(wb.depth)])}
        </text>
        <text x={cx} y={cy + 8} fontSize="8" fill={col} textAnchor="middle" style={{ paintOrder: "stroke", stroke: C.panel, strokeWidth: 2.5 }}>
          {t("门后余 {0}", [fmt(wb.remain)])}
          {wb.ok ? ` ≥${wb.need}` : ` <${wb.need}`}
        </text>
      </g>
    );
  });
  /* 门符号：单扇按铰链端画一扇；两扇门（门洞超过单扇上限时自动分的）在门洞两端各一扇，向中间合拢；摆动扇形淡色填充 */
  const doorElems = doors.map((d, i) => {
    const dd = d.door || { opening: doorLeaf, leafW: doorLeaf, leaves: 1 };
    const r = dd.leafW * s; // 一扇的摆动半径
    const span = dd.opening * s; // 门洞总宽
    if (d.side === "left" || d.side === "right") {
      const xw = d.side === "left" ? X(0) : X(innerL);
      const dirx = d.side === "left" ? 1 : -1;
      const leaves = dd.leaves === 2 ? [{ high: false }, { high: true }] : [{ high: d.hingeEnd === "high" }];
      return (
        <g key={i}>
          <rect x={d.side === "left" ? X(-wall) + 0.5 : X(innerL) - 0.5} y={Y(d.along)} width={wall * s} height={span} fill={C.panel} />
          {leaves.map((lf, j) => {
            const yh = lf.high ? Y(d.along + dd.opening) : Y(d.along); // 铰链
            const yc = lf.high ? yh - r : yh + r; // 关闭时门扇前缘
            const sweep = (d.side === "left") !== lf.high ? 0 : 1;
            return (
              <g key={j}>
                <path d={`M ${xw} ${yh} L ${xw} ${yc} A ${r} ${r} 0 0 ${sweep} ${xw + dirx * r} ${yh} Z`} fill={C.warn} fillOpacity={0.12} stroke="none" />
                <line x1={xw} y1={yh} x2={xw + dirx * r} y2={yh} stroke={C.ink} strokeWidth="1.4" />
                <circle cx={xw} cy={yh} r="2" fill={C.ink} />
                <path d={`M ${xw} ${yc} A ${r} ${r} 0 0 ${sweep} ${xw + dirx * r} ${yh}`} stroke={C.lineSoft} strokeWidth="0.8" fill="none" strokeDasharray="3 2" />
              </g>
            );
          })}
        </g>
      );
    }
    const yw = d.side === "top" ? Y(0) : Y(innerW);
    const diry = d.side === "top" ? 1 : -1;
    const leaves = dd.leaves === 2 ? [{ right: false }, { right: true }] : [{ right: false }];
    return (
      <g key={i}>
        <rect x={X(d.along)} y={d.side === "top" ? Y(-wall) + 0.5 : Y(innerW) - 0.5} width={span} height={wall * s} fill={C.panel} />
        {leaves.map((lf, j) => {
          const xh = lf.right ? X(d.along + dd.opening) : X(d.along); // 铰链
          const dx = lf.right ? -1 : 1;
          const sweep = (d.side === "top") !== lf.right ? 1 : 0;
          return (
            <g key={j}>
              <path d={`M ${xh} ${yw} L ${xh + dx * r} ${yw} A ${r} ${r} 0 0 ${sweep} ${xh} ${yw + diry * r} Z`} fill={C.warn} fillOpacity={0.12} stroke="none" />
              <line x1={xh} y1={yw} x2={xh} y2={yw + diry * r} stroke={C.ink} strokeWidth="1.4" />
              <path d={`M ${xh + dx * r} ${yw} A ${r} ${r} 0 0 ${sweep} ${xh} ${yw + diry * r}`} stroke={C.lineSoft} strokeWidth="0.8" fill="none" strokeDasharray="3 2" />
            </g>
          );
        })}
      </g>
    );
  });

  return (
    <svg viewBox={`0 0 ${svgW} ${svgH}`} width="100%" style={{ maxWidth: svgW, fontFamily: FONT, display: "block" }}>
      <defs>
        <Hatch id="hp" />
        <marker id="ah" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
          <path d="M0,0 L8,4 L0,8 z" fill={C.ink} />
        </marker>
      </defs>
      <text x={M} y={22} fontSize="12.5" fontWeight="600" fill={C.ink}>
        {title}
      </text>
      <text x={svgW - M} y={22} fontSize="10.5" fill={C.muted} textAnchor="end">
        {t("墙厚")} {fmt(wall)} {t("· 单位 mm")}
      </text>
      {/* 墙体 */}
      <rect x={X(-wall)} y={Y(-wall)} width={outerL * s} height={outerW * s} fill="url(#hp)" stroke={C.ink} strokeWidth="1.2" />
      <rect x={X(0)} y={Y(0)} width={innerL * s} height={innerW * s} fill={C.panel} stroke={C.ink} strokeWidth="1.2" />
      {/* 平台 */}
      {landings.map((l, i) => (
        <g key={i}>
          <rect x={X(l.x1)} y={Y(l.y1)} width={(l.x2 - l.x1) * s} height={(l.y2 - l.y1) * s} fill={C.canvasBg} />
          <text x={X((l.x1 + l.x2) / 2)} y={Y((l.y1 + l.y2) / 2)} fontSize="10" fill={C.muted} textAnchor="middle" dominantBaseline="middle">
            {l.label}
          </text>
        </g>
      ))}
      {/* 梯段 */}
      {bands.map((b, i) => {
        const y1 = Y(b.y0), y2 = Y(b.y0 + b.h);
        const ym = (y1 + y2) / 2;
        const xs = b.nosings;
        const xmin = Math.min(...xs), xmax = Math.max(...xs);
        return (
          <g key={i}>
            <rect x={X(xmin)} y={y1} width={(xmax - xmin) * s} height={y2 - y1} fill={C.flightFill} />
            {xs.map((x, k) => (
              <line key={k} x1={X(x)} y1={y1} x2={X(x)} y2={y2} stroke={C.line} strokeWidth="0.9" />
            ))}
            {b.cut && (
              <g>
                <line x1={X(xmin + (xmax - xmin) * 0.62)} y1={y1} x2={X(xmin + (xmax - xmin) * 0.62) + (y2 - y1) * 0.35} y2={y2} stroke={C.ink} strokeWidth="1.6" />
                <line x1={X(xmin + (xmax - xmin) * 0.62) + 6} y1={y1} x2={X(xmin + (xmax - xmin) * 0.62) + 6 + (y2 - y1) * 0.35} y2={y2} stroke={C.ink} strokeWidth="1.6" />
              </g>
            )}
            <line x1={X(b.arrow[0])} y1={ym} x2={X(b.arrow[1])} y2={ym} stroke={C.ink} strokeWidth="1.2" markerEnd="url(#ah)" />
            <text x={X((xmin + xmax) / 2)} y={ym - 6} fontSize="10" fill={C.ink} textAnchor="middle" style={{ paintOrder: "stroke", stroke: C.panel, strokeWidth: 3 }}>
              {b.label}
            </text>
          </g>
        );
      })}
      {/* 梯井 / 隔墙 */}
      {dividers.map((d, i) => {
        const xa = d.x1 != null ? d.x1 : 0, xb = d.x2 != null ? d.x2 : innerL;
        return (
          <g key={i}>
            {d.hatched ? (
              <rect x={X(xa)} y={Y(d.y)} width={(xb - xa) * s} height={d.h * s} fill="url(#hp)" stroke={C.ink} strokeWidth="1" />
            ) : d.h > 0 ? (
              <g>
                <rect x={X(xa)} y={Y(d.y)} width={(xb - xa) * s} height={d.h * s} fill={C.panel} stroke={C.ink} strokeWidth="0.9" />
                <text x={X((xa + xb) / 2)} y={Y(d.y + d.h / 2)} fontSize="8" fill={C.muted} textAnchor="middle" dominantBaseline="middle">
                  {t("梯井 / 栏板")}
                </text>
              </g>
            ) : (
              <line x1={X(xa)} y1={Y(d.y)} x2={X(xb)} y2={Y(d.y)} stroke={C.ink} strokeWidth="1.2" />
            )}
          </g>
        );
      })}
      {walkElems}
      {doorElems}
      {/* 尺寸 */}
      {topDims.map((d, i) => (
        <HDim key={i} x1={X(d.x1)} x2={X(d.x2)} y={Y(-wall) - 14} label={d.label} />
      ))}
      <HDim x1={X(-wall)} x2={X(innerL)} y={Y(innerW) + wall * s + 22} label={t("外包总长 {0}", [fmt(outerL)])} above={false} />
      <HDim x1={X(0)} x2={X(innerL)} y={Y(innerW) + wall * s + 8} label={t("内净长 {0}", [fmt(innerL)])} above={false} />
      {leftDims.map((d, i) => (
        <VDim key={i} y1={Y(d.y1)} y2={Y(d.y2)} x={X(-wall) - 14} label={d.label} />
      ))}
      <VDim y1={Y(-wall)} y2={Y(innerW) + wall * s} x={X(innerL) + wall * s + 22} label={t("外包总宽 {0}", [fmt(outerW)])} left={false} />
      <VDim y1={Y(0)} y2={Y(innerW)} x={X(innerL) + wall * s + 8} label={t("内净宽 {0}", [fmt(innerW)])} left={false} />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  剖面图                                                              */
/* ------------------------------------------------------------------ */
function SectionSVG({ res, inp, shaftIdx, secStart }) {
  const { stairType, wall, adv, nFloors: N } = inp;
  const { run, doorLeaf, waist } = adv;
  const zone = res.zones[0];
  const shaft = zone.shafts[clamp(shaftIdx, 0, zone.shafts.length - 1)];
  const innerL = shaft.innerL;
  const start = clamp(secStart, 1, Math.max(1, N - 2));
  const storeys = [];
  let z = 0;
  for (let L = start; L <= Math.min(N, start + 2); L++) {
    const pf = res.perFloor[L - 1];
    storeys.push({ pf, z0: z });
    z += pf.ffh;
  }
  const zTop = z;
  const topSlab = start + 3 <= N ? res.perFloor[start + 2].slab : storeys[storeys.length - 1].pf.slab;
  const ext = 700; // 楼板外伸示意
  const M = 40;
  const MR = 150; // 右侧标注区
  const maxSlab = Math.max(...storeys.map((t) => t.pf.slab));
  const totalMm = innerL + 2 * wall + 2 * ext;
  const totalZ = zTop + topSlab + maxSlab + 200;
  const s = Math.min((680 - M - MR) / totalMm, (560 - 2 * M) / totalZ);
  const X = (mm) => M + (mm + wall + ext) * s;
  const Zpx = (mm) => M + (zTop + topSlab + 100 - mm) * s;
  const svgW = totalMm * s + M + MR;
  const svgH = totalZ * s + M + 40;

  const flightsDraw = [];
  const landingsDraw = [];
  const doorsDraw = [];
  const slabsDraw = [];
  const notes = [];
  let lastEndX = null;

  storeys.forEach(({ pf, z0 }, si) => {
    const riser = pf.riser;
    const slabBelow = pf.slab;
    if (stairType === "dogleg") {
      const st = shaft.stairs[0];
      if (pf.level >= st.top) {
        slabsDraw.push({ x1: -wall - ext, x2: innerL + wall + ext, z: z0, t: slabBelow, label: t("L{0} · 楼梯 #{1} 至此终止", [pf.level, st.k]) });
        return;
      }
      const g = st.storeyGeo[pf.level];
      const { end, xa, floorEdge } = g;
      const sideLand = { floor: [{ z: z0, t: slabBelow, isFloor: true }], far: [] };
      g.flights.forEach((f) => {
        const nos = Array.from({ length: f.r }, (_, k) => ({ x: f.startX + f.dirT * k * run, z: z0 + (f.zr + k) * riser }));
        flightsDraw.push({ nos, riser, near: f.band === 0, endX: f.endX, endZ: z0 + (f.zr + f.r) * riser });
        lastEndX = f.endX;
      });
      g.landings.forEach((l) => {
        const z = z0 + l.zr * riser;
        // band 1 半边先画（虚线），band 0 半边实线在上
        landingsDraw.push({ x1: l.halves[1][0], x2: l.halves[1][1], z, t: waist, near: false, label: "" });
        landingsDraw.push({ x1: l.halves[0][0], x2: l.halves[0][1], z, t: waist, near: true, label: `${l.label} +${fmt(z - z0)}` });
        (l.side === "far" ? sideLand.far : sideLand.floor).push({ z, t: waist });
      });
      const firstX = floorEdge[0];
      slabsDraw.push({ x1: end === 0 ? -wall - ext : floorEdge[1], x2: end === 0 ? floorEdge[1] : innerL + wall + ext, z: z0, t: slabBelow, label: "", dashed: floorEdge[1] !== floorEdge[0] });
      slabsDraw.push({ x1: end === 0 ? -wall - ext : firstX, x2: end === 0 ? firstX : innerL + wall + ext, z: z0, t: slabBelow, label: `L${pf.level}` });
      doorsDraw.push({ side: end === 0 ? "left" : "right", z: z0 });
      if (si === 0) {
        // 同一端上下叠置平台之间的净高（含上一层楼板）
        (pf.flights % 2 === 0 ? sideLand.floor : sideLand.far).push({ z: z0 + pf.ffh, t: pf.slabAbove, isFloor: true });
        let best = null;
        [["floor", sideLand.floor], ["far", sideLand.far]].forEach(([side, arr]) => {
          arr.sort((p, q) => p.z - q.z);
          for (let k = 0; k + 1 < arr.length; k++) {
            const h = arr[k + 1].z - arr[k].z - arr[k + 1].t;
            if (!best || h < best.h) best = { h, side, z1: arr[k].z, z2: arr[k + 1].z };
          }
        });
        if (best) {
          const cx = best.side === "floor" ? (end === 0 ? firstX / 2 : (firstX + innerL) / 2) : end === 0 ? (xa + innerL) / 2 : xa / 2;
          notes.push({ x: cx, z1: best.z1, z2: best.z1 + best.h, text: t("净高 {0}", [fmt(best.h)]), ok: best.h >= 2050 });
        }
      }
    } else {
      const [a, b] = shaft.stairs;
      const geoA = a.geos.find((g) => g.L === pf.level) || a.geos[a.geos.length - 1];
      const LendEff = (innerL - geoA.body) / 2;
      if (pf.level >= a.top && (!b || pf.level >= b.top)) {
        slabsDraw.push({ x1: -wall - ext, x2: innerL + wall + ext, z: z0, t: slabBelow, label: t("L{0} · 梯井至此终止", [pf.level]) });
        return;
      }
      if (pf.level < a.top) {
        const lay = layoutFlights(LendEff, +1, pf.flightRisers, run, geoA.Lmid, z0, riser);
        lay.flights.forEach((f) => {
          flightsDraw.push({ nos: f.nosings, riser, dir: 1, near: true, endX: f.endX, endZ: f.endZ });
          if (f.landing) landingsDraw.push({ x1: f.landing.x1, x2: f.landing.x2, z: f.landing.z, t: waist, near: true, label: t("中间平台") });
        });
      }
      if (b && pf.level < b.top) {
        const layB = layoutFlights(innerL - LendEff, -1, pf.flightRisers, run, geoA.Lmid, z0, riser);
        layB.flights.forEach((f) => {
          flightsDraw.push({ nos: f.nosings, riser, dir: -1, near: false, endX: f.endX, endZ: f.endZ });
          if (f.landing) landingsDraw.push({ x1: f.landing.x1, x2: f.landing.x2, z: f.landing.z, t: waist, near: false, label: t("中间平台") });
        });
        doorsDraw.push({ side: "right", z: z0 });
      }
      slabsDraw.push({ x1: -wall - ext, x2: LendEff, z: z0, t: slabBelow, label: `L${pf.level}` });
      slabsDraw.push({ x1: innerL - LendEff, x2: innerL + wall + ext, z: z0, t: slabBelow, label: "" });
      doorsDraw.push({ side: "left", z: z0 });
      if (si === 0) notes.push({ x: LendEff / 2, z1: z0, z2: z0 + pf.headroom, text: t("净高 {0}", [fmt(pf.headroom)]), ok: pf.headroom >= 2050 });
    }
  });
  // 顶部楼板
  if (stairType === "dogleg") {
    const Lt = Math.min(N, start + 3);
    const endT = res.floorEnd[Lt] || 0;
    const st0 = shaft.stairs[0];
    const gNext = st0.storeyGeo[Lt];
    const geoT = st0.geos[st0.geos.length - 1];
    const xArr = lastEndX != null ? lastEndX : endT === 0 ? geoT.Lf : innerL - geoT.Lm;
    const e0 = gNext ? gNext.floorEdge[0] : xArr;
    const e1 = gNext ? gNext.floorEdge[1] : xArr;
    if (e0 !== e1) slabsDraw.push({ x1: endT === 0 ? -wall - ext : e1, x2: endT === 0 ? e1 : innerL + wall + ext, z: zTop, t: topSlab, label: "", dashed: true });
    slabsDraw.push({ x1: endT === 0 ? -wall - ext : e0, x2: endT === 0 ? e0 : innerL + wall + ext, z: zTop, t: topSlab, label: `L${Lt}` });
  } else {
    const pfTop = storeys[storeys.length - 1].pf;
    const geo = shaft.stairs[0].geos.find((g) => g.L === pfTop.level) || shaft.stairs[0].geos[shaft.stairs[0].geos.length - 1];
    const LendEff = (innerL - geo.body) / 2;
    slabsDraw.push({ x1: -wall - ext, x2: LendEff, z: zTop, t: topSlab, label: `L${Math.min(N, start + 3)}` });
    slabsDraw.push({ x1: innerL - LendEff, x2: innerL + wall + ext, z: zTop, t: topSlab, label: "" });
  }

  const stepPath = (f) => {
    const pts = [];
    f.nos.forEach((n, k) => {
      pts.push([X(n.x), Zpx(n.z)]);
      pts.push([X(n.x), Zpx(n.z + f.riser)]);
      if (k < f.nos.length - 1) pts.push([X(f.nos[k + 1].x), Zpx(n.z + f.riser)]);
    });
    return pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
  };
  const waistPoly = (f) => {
    const n0 = f.nos[0], nl = f.nos[f.nos.length - 1];
    const slope = Math.sqrt(run * run + f.riser * f.riser) / run;
    const wv = waist * slope;
    const top = [X(nl.x), Zpx(nl.z + f.riser)];
    const topU = [X(nl.x), Zpx(nl.z + f.riser - wv)];
    const botU = [X(n0.x), Zpx(n0.z + f.riser - wv)];
    const bot = [X(n0.x), Zpx(n0.z)];
    return `${stepPath(f)} L ${top[0].toFixed(1)} ${top[1].toFixed(1)} L ${topU[0].toFixed(1)} ${topU[1].toFixed(1)} L ${botU[0].toFixed(1)} ${botU[1].toFixed(1)} L ${bot[0].toFixed(1)} ${bot[1].toFixed(1)} Z`;
  };

  const title = stairType === "dogleg" ? t("楼梯 {0} · 折返梯 · L{1}–L{2} 纵剖面", [shaft.stairs[0].k, start, Math.min(N, start + 2)]) : t("剪刀梯 · L{0}–L{1} 纵剖面（实线：近侧梯道，虚线：隔墙后梯道）", [start, Math.min(N, start + 2)]);

  return (
    <svg viewBox={`0 0 ${svgW} ${svgH}`} width="100%" style={{ maxWidth: svgW, fontFamily: FONT, display: "block" }}>
      <defs>
        <Hatch id="hs" />
      </defs>
      <text x={M} y={20} fontSize="12.5" fontWeight="600" fill={C.ink}>
        {title}
      </text>
      {/* 端墙 */}
      <rect x={X(-wall)} y={Zpx(zTop + topSlab)} width={wall * s} height={(zTop + topSlab + maxSlab) * s} fill="url(#hs)" stroke={C.ink} strokeWidth="1" />
      <rect x={X(innerL)} y={Zpx(zTop + topSlab)} width={wall * s} height={(zTop + topSlab + maxSlab) * s} fill="url(#hs)" stroke={C.ink} strokeWidth="1" />
      {/* 门洞 */}
      {doorsDraw.map((d, i) => (
        <g key={i}>
          <rect x={d.side === "left" ? X(-wall) - 0.5 : X(innerL) - 0.5} y={Zpx(d.z + 2100)} width={wall * s + 1} height={2100 * s} fill={C.panel} />
          <line x1={d.side === "left" ? X(-wall) : X(innerL)} y1={Zpx(d.z + 2100)} x2={d.side === "left" ? X(0) : X(innerL + wall)} y2={Zpx(d.z + 2100)} stroke={C.ink} strokeWidth="1" />
          <line x1={d.side === "left" ? X(-wall / 2) : X(innerL + wall / 2)} y1={Zpx(d.z + 2100)} x2={d.side === "left" ? X(-wall / 2) : X(innerL + wall / 2)} y2={Zpx(d.z)} stroke={C.ink} strokeWidth="2.2" />
          <text x={d.side === "left" ? X(-wall / 2) : X(innerL + wall / 2)} y={Zpx(d.z + 1050)} fontSize="9" fill={C.muted} textAnchor="middle" transform={`rotate(-90 ${d.side === "left" ? X(-wall / 2) : X(innerL + wall / 2)} ${Zpx(d.z + 1050)})`}>
            {t("门 2100")}
          </text>
        </g>
      ))}
      {/* 远侧梯道（虚线） */}
      {flightsDraw.filter((f) => !f.near).map((f, i) => (
        <path key={"far" + i} d={stepPath(f)} fill="none" stroke={C.lineSoft} strokeWidth="0.9" strokeDasharray="4 3" />
      ))}
      {landingsDraw.filter((l) => !l.near).map((l, i) => (
        <rect key={"farl" + i} x={X(l.x1)} y={Zpx(l.z)} width={(l.x2 - l.x1) * s} height={l.t * s} fill="none" stroke={C.lineSoft} strokeWidth="0.9" strokeDasharray="4 3" />
      ))}
      {/* 近侧梯道 */}
      {flightsDraw.filter((f) => f.near).map((f, i) => (
        <path key={"near" + i} d={waistPoly(f)} fill={C.flightFill} stroke={C.ink} strokeWidth="1.1" />
      ))}
      {landingsDraw.filter((l) => l.near).map((l, i) => (
        <g key={"nl" + i}>
          <rect x={X(l.x1)} y={Zpx(l.z)} width={(l.x2 - l.x1) * s} height={l.t * s} fill="url(#hs)" stroke={C.ink} strokeWidth="1" />
          <text x={X(l.x2) - 2} y={Zpx(l.z) + l.t * s + 11} fontSize="9" fill={C.muted} textAnchor="end">
            {l.label}
          </text>
        </g>
      ))}
      {/* 楼板 */}
      {slabsDraw.map((sl, i) => (
        <g key={"s" + i}>
          {sl.dashed ? (
            <rect x={X(sl.x1)} y={Zpx(sl.z)} width={(sl.x2 - sl.x1) * s} height={sl.t * s} fill="none" stroke={C.lineSoft} strokeWidth="0.9" strokeDasharray="4 3" />
          ) : (
            <rect x={X(sl.x1)} y={Zpx(sl.z)} width={(sl.x2 - sl.x1) * s} height={sl.t * s} fill="url(#hs)" stroke={C.ink} strokeWidth="1" />
          )}
          {sl.label && (
            <text x={X(sl.x1) + 4} y={Zpx(sl.z) - 4} fontSize="10.5" fontWeight="600" fill={C.ink}>
              {sl.label} ▽
            </text>
          )}
        </g>
      ))}
      {/* 层高尺寸 */}
      {storeys.map(({ pf, z0 }, i) => (
        <g key={"d" + i}>
          <VDim y1={Zpx(z0 + pf.ffh)} y2={Zpx(z0)} x={X(innerL + wall + ext) + 18} label={t("层高 {0}", [fmt(pf.ffh)])} left={false} />
          <text x={X(innerL + wall + ext) + 34} y={(Zpx(z0) + Zpx(z0 + pf.ffh)) / 2 - 8} fontSize="9.5" fill={C.muted}>
            {pf.flightRisers.join("+")} {t("步")}
          </text>
          <text x={X(innerL + wall + ext) + 34} y={(Zpx(z0) + Zpx(z0 + pf.ffh)) / 2 + 5} fontSize="9.5" fill={C.muted}>
            {t("踢面")} {pf.riser.toFixed(0)}
          </text>
          <text x={X(innerL + wall + ext) + 34} y={(Zpx(z0) + Zpx(z0 + pf.ffh)) / 2 + 18} fontSize="9.5" fill={C.muted}>
            {t("板厚")} {fmt(pf.slab)}
          </text>
        </g>
      ))}
      {/* 净高标注 */}
      {notes.map((n, i) => (
        <g key={"n" + i}>
          <line x1={X(n.x)} y1={Zpx(n.z1)} x2={X(n.x)} y2={Zpx(n.z2)} stroke={n.ok ? C.ok : C.err} strokeWidth="1" strokeDasharray="3 2" />
          <line x1={X(n.x) - 4} y1={Zpx(n.z2)} x2={X(n.x) + 4} y2={Zpx(n.z2)} stroke={n.ok ? C.ok : C.err} strokeWidth="1" />
          <text x={X(n.x) + 5} y={(Zpx(n.z1) + Zpx(n.z2)) / 2} fontSize="9.5" fill={n.ok ? C.ok : C.err}>
            {n.text} {n.ok ? "≥ 2 050 ✓" : "< 2 050 ✗"}
          </text>
        </g>
      ))}
      <HDim x1={X(0)} x2={X(innerL)} y={svgH - 16} label={t("内净长 {0}", [fmt(innerL)])} above={false} />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  主组件                                                              */
/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* 三维实体：由计算结果生成盒体列表（mm；x 沿梯间长，y 沿梯间宽，z 竖向） */
function buildSolids(res, inp, shaftIdx, fromLevel, nLevels) {
  const { stairType, wall, adv, nFloors: N } = inp;
  const { run, centerWall, waist, doorLeaf, doorPos } = adv;
  const doorHinge = adv.doorHinge || "wall";
  const doorSide = adv.doorSide || "dn";
  const zone = res.zones[0];
  const shaft = zone.shafts[clamp(shaftIdx, 0, zone.shafts.length - 1)];
  const innerL = shaft.innerL;
  const innerW = shaft.innerW;
  const boxes = [];
  const figures = []; // 1.8 m 人体比例，站在各层楼层平台
  const add = (x1, x2, y1, y2, z1, z2, kind, stair = 0) => {
    if (Math.abs(x2 - x1) < 1 || Math.abs(y2 - y1) < 1 || Math.abs(z2 - z1) < 1) return;
    boxes.push({ x1: Math.min(x1, x2), x2: Math.max(x1, x2), y1: Math.min(y1, y2), y2: Math.max(y1, y2), z1: Math.min(z1, z2), z2: Math.max(z1, z2), kind, stair });
  };
  const from = clamp(fromLevel, 1, Math.max(1, N - 1));
  const to = Math.min(N - 1, from + nLevels - 1);
  let zBase = 0;
  for (let L = 1; L < from; L++) zBase += res.perFloor[L - 1].ffh;
  let z0 = zBase;
  let lastEndX = null;
  const doorW = (shaft.stairs[0] && shaft.stairs[0].door ? shaft.stairs[0].door.opening : doorLeaf); // 门洞总宽（两扇时含两扇）
  const doorAt = (L, z, end, W, hingeAt) => {
    // end: 0 左端 / 1 右端；W: 该门所在梯段宽（剪刀梯）或整个梯间宽；hingeAt: 贴 low(y 小) / high(y 大) 侧墙
    const y = doorAlong(W.y1, W.y2, hingeAt || "low", doorHinge, doorW).along;
    if (doorPos === "end") {
      if (end === 0) add(-wall, 0, y, y + doorW, z, z + 2100, "door");
      else add(innerL, innerL + wall, y, y + doorW, z, z + 2100, "door");
    } else {
      const x = end === 0 ? 300 : innerL - 300 - doorW;
      const side = W.y1 === 0 ? [-wall, 0] : [innerW, innerW + wall];
      add(x, x + doorW, side[0], side[1], z, z + 2100, "door");
    }
  };
  for (let L = from; L <= to; L++) {
    const pf = res.perFloor[L - 1];
    const riser = pf.riser;
    if (stairType === "dogleg") {
      const st = shaft.stairs[0];
      if (L >= st.top) {
        add(-wall, innerL + wall, -wall, innerW + wall, z0 - pf.slab, z0, "slab");
        z0 += pf.ffh;
        continue;
      }
      const g = st.storeyGeo[L];
      const { end, floorEdge } = g;
      const half = innerW / 2;
      const bandY = [
        [0, st.W],
        [innerW - st.W, innerW],
      ];
      const halfY = [
        [-wall, half],
        [half, innerW + wall],
      ];
      g.flights.forEach((f) => {
        const [y1, y2] = bandY[f.band];
        for (let k = 0; k < f.r - 1; k++) {
          const x = f.startX + f.dirT * k * run;
          const zt = z0 + (f.zr + k + 1) * riser;
          add(x, x + f.dirT * run, y1, y2, zt - riser - waist, zt, "step", st.k);
        }
        // 最后一级踢面（登上平台）
        add(f.endX, f.endX + f.dirT * 60, y1, y2, z0 + (f.zr + f.r - 1) * riser, z0 + (f.zr + f.r) * riser, "step", st.k);
        lastEndX = f.endX;
      });
      // 平台：两半各自贴合所在带的梯段边缘
      g.landings.forEach((l) => {
        const z = z0 + l.zr * riser;
        [0, 1].forEach((b) => add(l.halves[b][0], l.halves[b][1], b === 0 ? 0 : half, b === 0 ? half : innerW, z - waist, z, "landing", st.k));
      });
      // 楼板：两半长度分别到本带梯段起点 / 上一层末跑到达点
      [0, 1].forEach((b) => add(end === 0 ? -wall : floorEdge[b], end === 0 ? floorEdge[b] : innerL + wall, halfY[b][0], halfY[b][1], z0 - pf.slab, z0, "slab"));
      const bUp = g.band0;
      const hb = doorSide === "dn" ? 1 - bUp : bUp;
      doorAt(L, z0, end, { y1: 0, y2: innerW }, hb === 0 ? "low" : "high");
      figures.push({ x: end === 0 ? Math.min(...floorEdge) / 2 : (Math.max(...floorEdge) + innerL) / 2, y: innerW / 2, z: z0, level: L });
    } else {
      const [a, b] = shaft.stairs;
      const geoA = a.geos.find((g) => g.L === L) || a.geos[a.geos.length - 1];
      const LendEff = (innerL - geoA.body) / 2;
      if (L >= a.top && (!b || L >= b.top)) {
        add(-wall, innerL + wall, -wall, innerW + wall, z0 - pf.slab, z0, "slab");
        z0 += pf.ffh;
        continue;
      }
      const drawRun = (lay, y1, y2, k) => {
        lay.flights.forEach((f) => {
          f.nosings.forEach((n, i) => {
            if (i < f.nosings.length - 1) add(n.x, n.x + f.dir * run, y1, y2, n.z + riser - riser - waist, n.z + riser, "step", k);
          });
          const last = f.nosings[f.nosings.length - 1];
          add(last.x, last.x + f.dir * 60, y1, y2, last.z, last.z + riser, "step", k);
          if (f.landing) add(f.landing.x1, f.landing.x2, y1, y2, f.landing.z - waist, f.landing.z, "landing", k);
        });
      };
      if (L < a.top) drawRun(layoutFlights(LendEff, +1, pf.flightRisers, run, geoA.Lmid, z0, riser), 0, a.W, a.k);
      if (b && L < b.top) drawRun(layoutFlights(innerL - LendEff, -1, pf.flightRisers, run, geoA.Lmid, z0, riser), innerW - b.W, innerW, b.k);
      // 端部楼板分两半：A 带贴合本层 A 梯起点 / 上一层 A 梯到达点，B 带反之
      const geoP = L > 1 ? a.geos.find((gg) => gg.L === L - 1) || null : null;
      const LendP = geoP ? (innerL - geoP.body) / 2 : LendEff;
      const half = innerW / 2;
      add(-wall, LendEff, -wall, half, z0 - pf.slab, z0, "slab"); // 左端 A 带：本层 A 梯起步
      add(-wall, LendP, half, innerW + wall, z0 - pf.slab, z0, "slab"); // 左端 B 带：上一层 B 梯到达
      add(innerL - LendP, innerL + wall, -wall, half, z0 - pf.slab, z0, "slab"); // 右端 A 带：上一层 A 梯到达
      add(innerL - LendEff, innerL + wall, half, innerW + wall, z0 - pf.slab, z0, "slab"); // 右端 B 带：本层 B 梯起步
      doorAt(L, z0, 0, { y1: 0, y2: a.W }, "low");
      if (b) doorAt(L, z0, 1, { y1: innerW - b.W, y2: innerW }, "high");
      if (b) add(0, innerL, a.W, a.W + centerWall, z0 - pf.slab, z0 + pf.ffh, "centerWall");
      figures.push({ x: LendEff / 2, y: a.W / 2, z: z0, level: L });
    }
    z0 += pf.ffh;
  }
  const zTop = z0;
  const topL = Math.min(N, to + 1);
  const pfTop = res.perFloor[topL - 1];
  const topSlab = pfTop.slab;
  if (stairType === "dogleg") {
    const endT = res.floorEnd[topL] || 0;
    const st0 = shaft.stairs[0];
    const geoT = st0.geos[st0.geos.length - 1];
    const gNext = st0.storeyGeo[topL];
    const xArr = lastEndX != null ? lastEndX : endT === 0 ? geoT.Lf : innerL - geoT.Lm;
    const edges = gNext ? gNext.floorEdge : [xArr, xArr];
    const half = innerW / 2;
    [0, 1].forEach((b) => add(endT === 0 ? -wall : edges[b], endT === 0 ? edges[b] : innerL + wall, b === 0 ? -wall : half, b === 0 ? half : innerW + wall, zTop - topSlab, zTop, "slab"));
    const arrive = st0.storeyGeo.top && st0.storeyGeo.top.arrive;
    const bDnT = arrive ? arrive.band : 1; // 顶层：到达跑所在带即下行带
    const hbT = doorSide === "dn" ? bDnT : 1 - bDnT;
    doorAt(topL, zTop, endT, { y1: 0, y2: innerW }, hbT === 0 ? "low" : "high");
    figures.push({ x: endT === 0 ? Math.min(...edges) / 2 : (Math.max(...edges) + innerL) / 2, y: innerW / 2, z: zTop, level: topL });
  } else {
    const st0 = shaft.stairs[0];
    const geo = st0.geos.find((g) => g.L === pfTop.level) || null;
    const geoP = st0.geos.find((g) => g.L === pfTop.level - 1) || st0.geos[st0.geos.length - 1];
    const LendN = geo ? (innerL - geo.body) / 2 : (innerL - geoP.body) / 2;
    const LendP = (innerL - geoP.body) / 2;
    const half = innerW / 2;
    add(-wall, LendN, -wall, half, zTop - topSlab, zTop, "slab");
    add(-wall, LendP, half, innerW + wall, zTop - topSlab, zTop, "slab");
    figures.push({ x: LendN / 2, y: shaft.stairs[0].W / 2, z: zTop, level: topL });
    add(innerL - LendP, innerL + wall, -wall, half, zTop - topSlab, zTop, "slab");
    add(innerL - LendN, innerL + wall, half, innerW + wall, zTop - topSlab, zTop, "slab");
    doorAt(topL, zTop, 0, { y1: 0, y2: shaft.stairs[0].W }, "low");
    if (shaft.stairs[1]) doorAt(topL, zTop, 1, { y1: innerW - shaft.stairs[1].W, y2: innerW }, "high");
  }
  // 四面墙
  const zb = zBase - res.perFloor[from - 1].slab;
  const zt = zTop + 1200;
  add(-wall, 0, -wall, innerW + wall, zb, zt, "wall");
  add(innerL, innerL + wall, -wall, innerW + wall, zb, zt, "wall");
  add(0, innerL, -wall, 0, zb, zt, "wall");
  add(0, innerL, innerW, innerW + wall, zb, zt, "wall");
  return { boxes, figures, innerL, innerW, zBase: zb, zTop: zt, from, to, topL };
}

const STAIR_COLORS = [C.line, "#C0703A", "#3E8E6E", "#8A5CB0", "#B8862B", "#5C7F99"];

function Stair3D({ res, inp, shaftIdx, fromLevel, nLevels }) {
  const ref = useRef(null);
  const model = useMemo(() => buildSolids(res, inp, shaftIdx, fromLevel, nLevels), [res, inp, shaftIdx, fromLevel, nLevels]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const H = 500;
    let W = el.clientWidth || 640;
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch (err) {
      el.innerHTML = t('<div style="padding:16px;font-size:12.5px;color:#5B6B7B">当前浏览器无法创建 WebGL 上下文，三维模型不可用。</div>');
      return () => {
        el.innerHTML = "";
      };
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(W, H);
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(C.canvasBg);
    const camera = new THREE.PerspectiveCamera(38, W / H, 0.05, 1000);
    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const sun = new THREE.DirectionalLight(0xffffff, 0.75);
    sun.position.set(30, 60, 40);
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0xffffff, 0.3);
    fill.position.set(-40, 20, -30);
    scene.add(fill);

    const group = new THREE.Group();
    const geoms = [];
    const mats = [];
    const matCache = {};
    const matFor = (kind, stair) => {
      const key = `${kind}-${stair}`;
      if (matCache[key]) return matCache[key];
      let m;
      if (kind === "step") m = new THREE.MeshLambertMaterial({ color: STAIR_COLORS[(stair - 1) % STAIR_COLORS.length] });
      else if (kind === "landing") m = new THREE.MeshLambertMaterial({ color: new THREE.Color(STAIR_COLORS[(stair - 1) % STAIR_COLORS.length]).lerp(new THREE.Color(C.panel), 0.35) });
      else if (kind === "slab") m = new THREE.MeshLambertMaterial({ color: "#C3CCD4" });
      else if (kind === "door") m = new THREE.MeshLambertMaterial({ color: "#E2A33C", transparent: true, opacity: 0.9 });
      else if (kind === "centerWall") m = new THREE.MeshLambertMaterial({ color: "#8E9AA6", transparent: true, opacity: 0.35, depthWrite: false });
      else m = new THREE.MeshLambertMaterial({ color: "#9AA6B2", transparent: true, opacity: 0.14, depthWrite: false, side: THREE.DoubleSide });
      matCache[key] = m;
      mats.push(m);
      return m;
    };
    const edgeMat = new THREE.LineBasicMaterial({ color: C.ink, transparent: true, opacity: 0.55 });
    const wallEdgeMat = new THREE.LineBasicMaterial({ color: C.muted, transparent: true, opacity: 0.6 });
    mats.push(edgeMat, wallEdgeMat);
    const k = 1 / 1000;
    model.boxes.forEach((b) => {
      const g = new THREE.BoxGeometry((b.x2 - b.x1) * k, (b.z2 - b.z1) * k, (b.y2 - b.y1) * k);
      geoms.push(g);
      const mesh = new THREE.Mesh(g, matFor(b.kind, b.stair));
      mesh.position.set(((b.x1 + b.x2) / 2) * k, ((b.z1 + b.z2) / 2) * k, ((b.y1 + b.y2) / 2) * k);
      mesh.renderOrder = b.kind === "wall" || b.kind === "centerWall" ? 2 : 1;
      group.add(mesh);
      if (b.kind !== "door") {
        const eg = new THREE.EdgesGeometry(g);
        geoms.push(eg);
        const lines = new THREE.LineSegments(eg, b.kind === "wall" || b.kind === "centerWall" ? wallEdgeMat : edgeMat);
        lines.position.copy(mesh.position);
        group.add(lines);
      }
    });
    // 1.8 m low-poly 小人（绿色），各层楼层平台各一个
    const figMat = new THREE.MeshStandardMaterial({ color: "#3E9B5B", flatShading: true, roughness: 0.85, metalness: 0 });
    const figMat2 = new THREE.MeshStandardMaterial({ color: "#63B87D", flatShading: true, roughness: 0.85, metalness: 0 });
    mats.push(figMat, figMat2);
    const proto = new THREE.Group();
    const part = (w, h, d, x, y, z, mat) => {
      const g = new THREE.BoxGeometry(w, h, d);
      geoms.push(g);
      const m = new THREE.Mesh(g, mat);
      m.position.set(x, y, z);
      proto.add(m);
    };
    part(0.16, 0.85, 0.2, -0.11, 0.425, 0, figMat); // 腿
    part(0.16, 0.85, 0.2, 0.11, 0.425, 0, figMat);
    part(0.42, 0.62, 0.24, 0, 1.16, 0, figMat); // 躯干 0.85–1.47
    part(0.12, 0.6, 0.14, -0.29, 1.17, 0, figMat); // 臂
    part(0.12, 0.6, 0.14, 0.29, 1.17, 0, figMat);
    part(0.1, 0.07, 0.1, 0, 1.505, 0, figMat2); // 颈 1.47–1.54
    const headG = new THREE.IcosahedronGeometry(0.13, 0); // 头 1.54–1.80
    geoms.push(headG);
    const head = new THREE.Mesh(headG, figMat2);
    head.position.set(0, 1.67, 0);
    proto.add(head);
    model.figures.forEach((f) => {
      const fig = proto.clone();
      fig.position.set(f.x * k, f.z * k, f.y * k);
      fig.rotation.y = Math.PI / 2;
      group.add(fig);
    });
    scene.add(group);
    // 地面网格
    const gsize = Math.max(model.innerL, model.innerW) * k * 2.4;
    const grid = new THREE.GridHelper(gsize, Math.round(gsize / 0.5), 0xc9d2da, 0xe3e8ed);
    grid.position.set((model.innerL / 2) * k, model.zBase * k - 0.002, (model.innerW / 2) * k);
    scene.add(grid);

    const bbox = new THREE.Box3().setFromObject(group);
    const center = new THREE.Vector3();
    bbox.getCenter(center);
    const size = new THREE.Vector3();
    bbox.getSize(size);
    const radius = Math.max(0.5, size.length() / 2);
    const target = center.clone();
    let theta = -Math.PI / 4;
    let phi = Math.PI / 3.1;
    let dist = radius * 2.1;
    let raf = 0;
    const draw = () => {
      raf = 0;
      camera.position.set(target.x + dist * Math.sin(phi) * Math.cos(theta), target.y + dist * Math.cos(phi), target.z + dist * Math.sin(phi) * Math.sin(theta));
      camera.lookAt(target);
      renderer.render(scene, camera);
    };
    const request = () => {
      if (!raf) raf = requestAnimationFrame(draw);
    };
    draw();

    let drag = null;
    const onDown = (e) => {
      drag = { x: e.clientX, y: e.clientY, mode: e.button === 2 || e.shiftKey ? "pan" : "rotate" };
      el.setPointerCapture && el.setPointerCapture(e.pointerId);
    };
    const onMove = (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      if (drag.mode === "rotate") {
        theta -= dx * 0.008;
        phi = clamp(phi - dy * 0.008, 0.05, Math.PI - 0.05);
      } else {
        const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0);
        const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1);
        target.addScaledVector(right, -dx * dist * 0.0016).addScaledVector(up, dy * dist * 0.0016);
      }
      request();
    };
    const onUp = () => {
      drag = null;
    };
    const onWheel = (e) => {
      e.preventDefault();
      dist = clamp(dist * Math.exp(e.deltaY * 0.0012), radius * 0.3, radius * 8);
      request();
    };
    const onCtx = (e) => e.preventDefault();
    const canvas = renderer.domElement;
    canvas.style.display = "block";
    canvas.style.borderRadius = "6px";
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("contextmenu", onCtx);
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => {
      const w = el.clientWidth || W;
      if (w !== W) {
        W = w;
        renderer.setSize(W, H);
        camera.aspect = W / H;
        camera.updateProjectionMatrix();
        request();
      }
    }) : null;
    ro && ro.observe(el);

    return () => {
      ro && ro.disconnect();
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("contextmenu", onCtx);
      if (raf) cancelAnimationFrame(raf);
      geoms.forEach((g) => g.dispose());
      mats.forEach((m) => m.dispose());
      grid.geometry.dispose();
      renderer.dispose();
      if (canvas.parentNode === el) el.removeChild(canvas);
    };
  }, [model]);

  return (
    <div>
      <div ref={ref} style={{ width: "100%", height: 500, touchAction: "none", cursor: "grab", borderRadius: 6, overflow: "hidden", background: C.canvasBg }} />
      <div className="flex flex-wrap items-center gap-4 mt-2" style={{ fontSize: 11.5, color: C.muted }}>
        <span>{t("拖动旋转 · 滚轮缩放 · 右键 / Shift+拖动平移")}</span>
        <span>{t("显示 L")}{model.from}–L{model.topL}{t("，")}{model.boxes.filter((b) => b.kind === "step").length} {t("个踏步实体")}</span>
        {res.zones[0].shafts[clamp(shaftIdx, 0, res.zones[0].shafts.length - 1)].stairs.map((st) => (
          <span key={st.k} className="inline-flex items-center gap-1">
            <i style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: STAIR_COLORS[(st.k - 1) % STAIR_COLORS.length] }} />
            {t("楼梯 #")}{st.k}
          </span>
        ))}
        <span className="inline-flex items-center gap-1">
          <i style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: "#E2A33C" }} /> {t("出口门")}
        </span>
        <span className="inline-flex items-center gap-1">
          <i style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: "#3E9B5B" }} /> {t("1.8 m 人体比例")}
        </span>
      </div>
    </div>
  );
}

/* 从计算结果里取出核心筒代表某个梯井、某一层的平面几何（踏步锯齿线 + 平台矩形），
   坐标是梯井自己的本地 mm（原点 = 内墙角，x 沿梯间长，y 沿梯间宽）——用 storeyGeo/geos 里
   已经算好的数据，只是不做 PlanSVG 那样的像素缩放，方便直接喂给 coreLocalToWorld 画在核心筒里。
   跟 PlanSVG 是各自独立的"消费者"，都读同一份 compute() 算出的权威几何，互不影响（同 3D/剖面视图的关系）。 */
function resolveShaft(res, shaftKey) {
  if (!shaftKey) return null;
  const [ziStr, siStr] = shaftKey.split("-");
  const zone = res.zones[Number(ziStr)];
  return (zone && zone.shafts[Number(siStr)]) || null;
}
/* curInnerW/curInnerL：核心筒被用户拖拉出的四条边改过尺寸后，实际的净宽/净长（core.w/l 减两道墙厚）；
   不传或传 null 时按原始（规范算出的）innerW/innerL 画，行为等价于拖拉前。当核心筒被拉大（超过规范最小值）时，
   多出来的净宽由两条梯段带对半平分（中间的梯井净空/剪刀梯隔墙宽度不变，即"拉粗楼梯，不拉粗墙"）；
   多出来的净长由两端的休息/楼层平台对半平分（梯段本身踏步数量、跑长不变，即"拉长平台，不拉长楼梯"）。
   核心筒被拉得比规范最小值还小时（dW/dL 会是负数）一律按 0 处理，画法上仍按规范最小尺寸画——这样预览会
   画到超出（已经变红警示的）核心筒外框，直观地表示"这个尺寸放不下算出来的楼梯"，不是 bug。 */
function shaftPlanLocalGeometry(res, inp, shaft, level, curInnerW, curInnerL) {
  const { stairType, adv } = inp;
  const { run, gap, centerWall } = adv;
  const innerW = shaft.innerW, innerL = shaft.innerL;
  const curW = curInnerW != null ? curInnerW : innerW;
  const curL = curInnerL != null ? curInnerL : innerL;
  const dW = Math.max(0, curW - innerW);
  const dL = Math.max(0, curL - innerL);
  const xShift = dL / 2;
  const pf = res.perFloor[level - 1];
  const bands = [];
  const landings = [];
  const dividers = [];
  let title = "";
  if (stairType === "dogleg") {
    const st = shaft.stairs[0];
    const W = st.W;
    const g = st.storeyGeo[level] || st.storeyGeo[st.storeyLevels[st.storeyLevels.length - 1]];
    if (!g) return null;
    const { end, far, floorEdge } = g;
    const f0 = g.flights[0];
    const bUp = f0.band;
    const bDn = 1 - bUp;
    const gPrev = st.storeyGeo[level - 1];
    const dn = gPrev ? gPrev.flights[gPrev.flights.length - 1] : null;
    const f1 = dn || g.flights.find((f) => f.band === bDn) || null;
    const Wd = f1 ? W + dW / 2 : W + dW;
    const curHalf = curW / 2;
    const nosOf = (f) => Array.from({ length: f.r }, (_, k) => f.startX + f.dirT * k * run + xShift);
    const lab = (band) => g.flights.filter((f) => f.band === band).map((f) => f.r).join("/");
    const yOf = (band) => (band === 0 ? 0 : Wd + gap);
    bands.push({ y0: yOf(bUp), h: Wd, nosings: nosOf(f0), cut: true, arrow: [f0.startX + xShift + f0.dirT * run * 0.4, f0.endX + xShift - f0.dirT * run * 0.4], label: t("上 {0} 步", [lab(bUp)]) });
    if (f1) bands.push({ y0: yOf(bDn), h: Wd, nosings: nosOf(f1), cut: false, arrow: [f1.endX + xShift + f1.dirT * run * 0.4, f1.startX + xShift - f1.dirT * run * 0.4], label: dn ? t("下 {0} 步", [dn.r]) : t("上 {0} 步", [lab(bDn)]) });
    const farEdge = [0, 0];
    farEdge[bUp] = f0.endX + xShift;
    farEdge[bDn] = (dn ? dn.startX : far[bDn]) + xShift;
    const floorRange = (x) => (end === 0 ? [0, x] : [x, curL]);
    const farRange = (x) => (end === 0 ? [x, curL] : [0, x]);
    [0, 1].forEach((b) => {
      const [fx1, fx2] = floorRange(floorEdge[b] + xShift);
      landings.push({ x1: fx1, x2: fx2, y1: b === 0 ? 0 : curHalf, y2: b === 0 ? curHalf : curW, label: b === bUp ? `L${level}` : "" });
      const [ax1, ax2] = farRange(farEdge[b]);
      landings.push({ x1: ax1, x2: ax2, y1: b === 0 ? 0 : curHalf, y2: b === 0 ? curHalf : curW, label: b === bUp ? (g.flights.length > 2 ? t("休息") : t("中间")) : "" });
    });
    const allX = [f0.startX, f0.endX, ...(f1 ? [f1.startX, f1.endX] : [])].map((x) => x + xShift);
    if (gap > 0) dividers.push({ x1: Math.min(...allX), x2: Math.max(...allX), y: Wd, h: gap, hatched: false });
    title = t("楼梯 {0} · 折返梯 · L{1}", [st.k, level]);
  } else {
    const [a, b] = shaft.stairs;
    const geoA = a.geos.find((gg) => gg.L === level) || a.geos[a.geos.length - 1];
    if (!geoA) return null;
    const bodyLen = geoA.body;
    const LendCur = (innerL - bodyLen) / 2 + xShift;
    const WdA = b ? a.W + dW / 2 : a.W + dW;
    const lay = layoutFlights(LendCur, +1, pf.flightRisers, run, geoA.Lmid, 0, 1);
    const nosA = lay.flights.flatMap((f) => f.nosings.map((n) => n.x));
    bands.push({ y0: 0, h: WdA, nosings: nosA, cut: true, arrow: [LendCur + run * 0.4, curL - LendCur - run * 0.4], label: t("上 {0} 步", [pf.risers]) });
    lay.flights.forEach((f) => f.landing && landings.push({ x1: f.landing.x1, x2: f.landing.x2, y1: 0, y2: WdA, label: t("中间") }));
    landings.push({ x1: 0, x2: LendCur, y1: 0, y2: WdA, label: `L${level}` });
    landings.push({ x1: curL - LendCur, x2: curL, y1: 0, y2: WdA, label: `L${level + 1}` });
    if (b) {
      const WdB = b.W + dW / 2;
      const layB = layoutFlights(curL - LendCur, -1, pf.flightRisers, run, geoA.Lmid, 0, 1);
      const yB = WdA + centerWall;
      bands.push({ y0: yB, h: WdB, nosings: layB.flights.flatMap((f) => f.nosings.map((n) => n.x)), cut: true, arrow: [curL - LendCur - run * 0.4, LendCur + run * 0.4], label: t("上 {0} 步", [pf.risers]) });
      layB.flights.forEach((f) => f.landing && landings.push({ x1: f.landing.x1, x2: f.landing.x2, y1: yB, y2: yB + WdB, label: t("中间") }));
      landings.push({ x1: curL - LendCur, x2: curL, y1: yB, y2: yB + WdB, label: `L${level}` });
      landings.push({ x1: 0, x2: LendCur, y1: yB, y2: yB + WdB, label: `L${level + 1}` });
      dividers.push({ x1: 0, x2: curL, y: WdA, h: centerWall, hatched: true });
      title = t("剪刀梯（{0}+{1}）· L{2}", [a.k, b.k, level]);
    } else {
      title = t("楼梯 {0} · 直跑梯 · L{1}", [a.k, level]);
    }
  }
  return { innerW: curW, innerL: curL, bands, landings, dividers, title };
}
/* 把核心筒对应的梯井/楼层几何（shaftPlanLocalGeometry 的结果）画在核心筒内部，尽量还原
   "楼梯间平面与剖面"里那张平面图的内容（踏步锯齿线、上下行箭头、平台、梯井/隔墙），
   随核心筒一起旋转/缩放；纯装饰不接收指针事件，不挡 CoreShape 自己的拖动/选中。
   跟 PlanSVG 是各自独立的渲染，共用同一份 compute() 权威几何数据，不重新发明计算逻辑。 */
function CoreStairPreview({ core, wallT, geometry }) {
  if (!geometry) return null;
  const t = clamp(wallT, 1, Math.min(core.w, core.l) / 2 - 1);
  const toWorld = (lx, ly) => coreLocalToWorld(core, t + lx, t + ly);
  const arrowHead = (p1, p2, size) => {
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
    const back = { x: p2.x - ux * size, y: p2.y - uy * size };
    const s1 = { x: back.x + nx * size * 0.5, y: back.y + ny * size * 0.5 };
    const s2 = { x: back.x - nx * size * 0.5, y: back.y - ny * size * 0.5 };
    return `M ${p2.x.toFixed(1)} ${p2.y.toFixed(1)} L ${s1.x.toFixed(1)} ${s1.y.toFixed(1)} L ${s2.x.toFixed(1)} ${s2.y.toFixed(1)} Z`;
  };
  return (
    <g style={{ pointerEvents: "none" }}>
      {geometry.landings.map((L, i) => {
        const poly = [toWorld(L.x1, L.y1), toWorld(L.x2, L.y1), toWorld(L.x2, L.y2), toWorld(L.x1, L.y2)];
        const cx = (poly[0].x + poly[2].x) / 2, cy = (poly[0].y + poly[2].y) / 2;
        const font = Math.max(70, t * 0.8);
        return (
          <g key={"ld" + i}>
            <polygon
              points={poly.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}
              fill={core.color + "20"}
              stroke={core.color}
              strokeWidth={Math.max(6, t * 0.1)}
              strokeDasharray={`${t * 0.6} ${t * 0.4}`}
            />
            {L.label && (
              <text x={cx} y={cy} fontSize={font} fill={core.color} textAnchor="middle" dominantBaseline="middle" style={{ paintOrder: "stroke", stroke: C.panel, strokeWidth: font * 0.18 }}>
                {L.label}
              </text>
            )}
          </g>
        );
      })}
      {geometry.dividers.map((d, i) => {
        const poly = [toWorld(d.x1, d.y), toWorld(d.x2, d.y), toWorld(d.x2, d.y + d.h), toWorld(d.x1, d.y + d.h)];
        return (
          <polygon
            key={"dv" + i}
            points={poly.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}
            fill={d.hatched ? C.wallFill : C.panel}
            stroke={C.ink}
            strokeWidth={Math.max(4, t * 0.06)}
          />
        );
      })}
      {geometry.bands.map((band, bi) => {
        const xs = band.nosings;
        const xmin = Math.min(...xs), xmax = Math.max(...xs);
        const ym = band.y0 + band.h / 2;
        const a1 = toWorld(band.arrow[0], ym), a2 = toWorld(band.arrow[1], ym);
        const cutX = xmin + (xmax - xmin) * 0.62;
        const font = Math.max(65, t * 0.75);
        const labelPt = toWorld((xmin + xmax) / 2, ym);
        return (
          <g key={"bd" + bi}>
            {xs.map((x, ni) => {
              const p1 = toWorld(x, band.y0), p2 = toWorld(x, band.y0 + band.h);
              return <line key={ni} x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={C.ink} strokeWidth={Math.max(5, t * 0.07)} />;
            })}
            {band.cut && (
              <g>
                <line {...segAt(toWorld, cutX, band.y0, band.h, band.h * 0.35)} stroke={C.ink} strokeWidth={Math.max(8, t * 0.11)} />
                <line {...segAt(toWorld, cutX + (xmax - xmin) * 0.05, band.y0, band.h, band.h * 0.35)} stroke={C.ink} strokeWidth={Math.max(8, t * 0.11)} />
              </g>
            )}
            <line x1={a1.x} y1={a1.y} x2={a2.x} y2={a2.y} stroke={C.ink} strokeWidth={Math.max(6, t * 0.09)} />
            <path d={arrowHead(a1, a2, Math.max(40, t * 0.5))} fill={C.ink} />
            <text
              x={labelPt.x}
              y={labelPt.y}
              fontSize={font}
              fill={C.ink}
              textAnchor="middle"
              dominantBaseline="middle"
              style={{ paintOrder: "stroke", stroke: C.panel, strokeWidth: font * 0.22 }}
            >
              {band.label}
            </text>
          </g>
        );
      })}
    </g>
  );
}
/* 把梯段带里 x=cutX 这条竖线，两端各按核心筒本地坐标转换成世界坐标——用于画"续接"缺口双斜线的辅助函数 */
function segAt(toWorld, x, y0, h, skew) {
  const p1 = toWorld(x, y0);
  const p2 = toWorld(x + skew, y0 + h);
  return { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
}

/* ------------------------------------------------------------------ */
/*  平面布置 / 疏散距离校核                                              */
/*  用户上传/不上传底图，在其上摆放已算出的核心筒外框、绘制楼层边界与       */
/*  疏散路径折线，据此校核疏散距离 (3.4.2.5) 与两出口间距 (3.4.2.3)。      */
/* ------------------------------------------------------------------ */
function CoreShape({ core, mmW, wallT, vb, svgRef, selected, undersized, tooClose, panMode, gridSnap, onMove, onSelect }) {
  const dragRef = useRef(null);
  /* 核心筒的墙按真实厚度画：core.w/core.l 是含墙的外包尺寸(见 addCore)，
     沿外框往里画一圈厚度为 t 的墙带（贴外皮走中线描边），中间再填内部楼板色 */
  const t = clamp(wallT, 1, Math.min(core.w, core.l) / 2 - 1);
  const midD = [
    coreLocalToWorld(core, t / 2, t / 2),
    coreLocalToWorld(core, core.l - t / 2, t / 2),
    coreLocalToWorld(core, core.l - t / 2, core.w - t / 2),
    coreLocalToWorld(core, t / 2, core.w - t / 2),
  ]
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(" ") + " Z";
  const innerD = [
    coreLocalToWorld(core, t, t),
    coreLocalToWorld(core, core.l - t, t),
    coreLocalToWorld(core, core.l - t, core.w - t),
    coreLocalToWorld(core, t, core.w - t),
  ]
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(" ") + " Z";
  const center = coreLocalToWorld(core, core.l / 2, core.w / 2);
  const font = Math.max(120, mmW / 90);
  const haloM = t * 0.9; // 选中框整体外扩一圈，避免被核心筒自身的墙线盖住
  const haloD = [
    coreLocalToWorld(core, -haloM, -haloM),
    coreLocalToWorld(core, core.l + haloM, -haloM),
    coreLocalToWorld(core, core.l + haloM, core.w + haloM),
    coreLocalToWorld(core, -haloM, core.w + haloM),
  ]
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(" ") + " Z";
  const onDown = (e) => {
    if (e.button !== 0 || panMode) return; // 只认鼠标左键（button 0）；右键/中键一律不处理，不然右键也能拖动。平移模式下让事件冒泡给画布去平移，不拖动/选中核心筒
    e.stopPropagation();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch (err) {}
    onSelect(core.id);
    dragRef.current = { startMm: clientToMm(e, svgRef.current, vb), orig: { x: core.x, y: core.y } };
  };
  const onMoveH = (e) => {
    if (!dragRef.current) return;
    const cur = clientToMm(e, svgRef.current, vb);
    let x = dragRef.current.orig.x + (cur.x - dragRef.current.startMm.x);
    let y = dragRef.current.orig.y + (cur.y - dragRef.current.startMm.y);
    if (gridSnap) {
      const snapped = snapToGridPoint({ x, y });
      x = snapped.x;
      y = snapped.y;
    }
    onMove(core.id, { x, y });
  };
  const onUp = () => {
    dragRef.current = null;
  };
  return (
    <g onPointerDown={onDown} onPointerMove={onMoveH} onPointerUp={onUp} onPointerCancel={onUp} onClick={(e) => e.stopPropagation()} style={{ cursor: "grab" }}>
      {selected && <path d={haloD} fill="none" stroke={C.err} strokeWidth={Math.max(8, t * 0.35)} />}
      <path d={innerD} fill={core.color + "2A"} />
      <path d={midD} fill="none" stroke={core.color} strokeWidth={t} strokeLinejoin="miter" />
      {undersized && (
        <polygon
          points={coreCorners(core).map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}
          fill={C.err}
          fillOpacity={0.5}
          style={{ pointerEvents: "none" }}
        />
      )}
      {tooClose && (
        <polygon
          points={coreCorners(core).map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}
          fill="#F1C40F"
          fillOpacity={0.5}
          style={{ pointerEvents: "none" }}
        />
      )}
      <text x={center.x} y={center.y} fontSize={font} fill={core.color} textAnchor="middle" dominantBaseline="middle" style={{ pointerEvents: "none", paintOrder: "stroke", stroke: C.panel, strokeWidth: font * 0.18 }}>
        {core.label}
      </text>
    </g>
  );
}

/* 核心筒四条边各自可独立拖拉改尺寸：拖"right"只改 core.l，拖"left"改 core.l 的同时把 core.x/y
   往本地 x 方向挪，让对面那条边（right）在世界坐标里位置不变；"top"/"bottom" 同理改 core.w。
   拖动量按核心筒自身的旋转角度投影到本地 x/y 轴（跟核心筒一起转），下限 200 mm 只是防止拖成负数/退化，
   不是规范意义上的最小尺寸——是否小于规范算出来的最小尺寸由 CoreShape 的 undersized 红色填充另外判断。 */
/* 按一个屏幕方向向量（dx,dy，y 向下）选最接近的原生"改尺寸"光标：水平→ew-resize，
   竖直→ns-resize，两条对角线分别对应 nwse-resize（"\"，左上-右下）和 nesw-resize（"/"，右上-左下）。
   方向和它的反方向（转 180°）应该选同一个光标，所以先把角度收进 [0°,180°) 再按 45° 一段分四类。 */
function resizeCursorForDir(dx, dy) {
  let deg = (Math.atan2(dy, dx) * 180) / Math.PI;
  deg = ((deg % 180) + 180) % 180;
  if (deg < 22.5 || deg >= 157.5) return "ew-resize";
  if (deg < 67.5) return "nwse-resize";
  if (deg < 112.5) return "ns-resize";
  return "nesw-resize";
}
function CoreEdgeHandle({ core, edge, wallT, vb, svgRef, panMode, gridSnap, onMove }) {
  const dragRef = useRef(null);
  const rad = (core.rot * Math.PI) / 180;
  const ux = Math.cos(rad), uy = Math.sin(rad);
  const nx = -Math.sin(rad), ny = Math.cos(rad);
  const t = clamp(wallT, 1, Math.min(core.w, core.l) / 2 - 1);
  const hitW = Math.max(150, t * 1.4);
  const MIN = 200;
  const endpointsLocal = {
    left: [{ x: 0, y: 0 }, { x: 0, y: core.w }],
    right: [{ x: core.l, y: 0 }, { x: core.l, y: core.w }],
    top: [{ x: 0, y: 0 }, { x: core.l, y: 0 }],
    bottom: [{ x: 0, y: core.w }, { x: core.l, y: core.w }],
  }[edge];
  const p1 = coreLocalToWorld(core, endpointsLocal[0].x, endpointsLocal[0].y);
  const p2 = coreLocalToWorld(core, endpointsLocal[1].x, endpointsLocal[1].y);
  /* 光标要按"这条边实际能拖动的方向在屏幕上指向哪"来选，不能只看 left/right/top/bottom 这个
     名字——核心筒转了角度以后，比如 rot=90° 时"left"边（本来沿本地 Y 铺开、拖动方向是本地 X）
     在屏幕上会变成一条横着的边，但拖动方向变成了竖直的，这时候应该显示上下箭头而不是固定的左右箭头。
     left/right 的拖动方向是本地 X 轴（ux,uy），top/bottom 是本地 Y 轴（nx,ny），转成世界坐标后
     用 resizeCursorForDir 按屏幕上更接近水平/竖直/两条对角线里的哪一种来选对应的原生光标。 */
  const cursor = edge === "left" || edge === "right" ? resizeCursorForDir(ux, uy) : resizeCursorForDir(nx, ny);
  const onDown = (e) => {
    if (e.button !== 0 || panMode) return; // 只认鼠标左键，右键不触发拖动
    e.stopPropagation();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch (err) {}
    dragRef.current = { start: clientToMm(e, svgRef.current, vb), orig: { x: core.x, y: core.y, w: core.w, l: core.l } };
  };
  const onMoveH = (e) => {
    if (!dragRef.current) return;
    const cur = clientToMm(e, svgRef.current, vb);
    const { start, orig } = dragRef.current;
    const dx = cur.x - start.x, dy = cur.y - start.y;
    let dLocalX = dx * ux + dy * uy;
    let dLocalY = dx * nx + dy * ny;
    if (gridSnap) {
      dLocalX = snapToGridValue(orig.l + dLocalX) - orig.l;
      dLocalY = snapToGridValue(orig.w + dLocalY) - orig.w;
    }
    if (edge === "right") {
      onMove(core.id, { l: Math.max(MIN, orig.l + dLocalX) });
    } else if (edge === "left") {
      const newL = Math.max(MIN, orig.l - dLocalX);
      const shift = orig.l - newL;
      onMove(core.id, { l: newL, x: orig.x + shift * ux, y: orig.y + shift * uy });
    } else if (edge === "bottom") {
      onMove(core.id, { w: Math.max(MIN, orig.w + dLocalY) });
    } else {
      const newW = Math.max(MIN, orig.w - dLocalY);
      const shift = orig.w - newW;
      onMove(core.id, { w: newW, x: orig.x + shift * nx, y: orig.y + shift * ny });
    }
  };
  const onUp = () => {
    dragRef.current = null;
  };
  return (
    <line
      x1={p1.x}
      y1={p1.y}
      x2={p2.x}
      y2={p2.y}
      stroke="transparent"
      strokeWidth={hitW}
      onPointerDown={onDown}
      onPointerMove={onMoveH}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onClick={(e) => e.stopPropagation()}
      style={{ cursor }}
    />
  );
}

function DoorMarker({ core, mmW, vb, svgRef, walls, cores, panMode, gridSnap, onMove, onAlignChange }) {
  const dragRef = useRef(null);
  const world = coreDoorWorld(core);
  const r = Math.max(45, mmW / 260);
  const snapR = Math.max(300, mmW / 200);
  const alignTol = Math.max(150, mmW / 400);
  const onDown = (e) => {
    if (e.button !== 0 || panMode) return; // 只认鼠标左键，右键不触发拖动
    e.stopPropagation();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch (err) {}
    dragRef.current = true;
  };
  const onMoveH = (e) => {
    if (!dragRef.current) return;
    const raw = clientToMm(e, svgRef.current, vb);
    const otherCores = (cores || []).filter((c) => c.id !== core.id);
    let mm;
    if (gridSnap) {
      mm = snapToGridPoint(raw);
      if (onAlignChange) onAlignChange(null);
      onMove(core.id, { doorLocal: clampToCorePerimeter(core, mm) });
      return;
    }
    const snapped = snapPoint(raw, walls || [], snapR, null, otherCores);
    if (snapped.x !== raw.x || snapped.y !== raw.y) {
      mm = snapped;
      if (onAlignChange) onAlignChange(null);
    } else {
      const refs = collectAlignPoints(walls || [], otherCores, null, null);
      const match = findAlignMatch(raw, refs, alignTol);
      mm = { x: match.x != null ? match.x : raw.x, y: match.y != null ? match.y : raw.y };
      if (onAlignChange) onAlignChange(match.x != null || match.y != null ? match : null);
    }
    // 不管吸附/对齐算出来的点在哪，最终都夹回核心筒外框四条边上——门永远在核心筒四周的墙上，不会跑进内部或跑出去
    onMove(core.id, { doorLocal: clampToCorePerimeter(core, mm) });
  };
  const onUp = () => {
    dragRef.current = null;
    if (onAlignChange) onAlignChange(null);
  };
  return (
    <circle
      cx={world.x}
      cy={world.y}
      r={r}
      fill="#E2A33C"
      stroke="#8a5a12"
      strokeWidth={r / 5}
      onPointerDown={onDown}
      onPointerMove={onMoveH}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onClick={(e) => e.stopPropagation()}
      style={{ cursor: "grab" }}
    />
  );
}

function WallEndHandle({ wall, end, mmW, vb, svgRef, walls, cores, panMode, gridSnap, onMove, onAlignChange }) {
  const dragRef = useRef(null);
  const x = end === 1 ? wall.x1 : wall.x2;
  const y = end === 1 ? wall.y1 : wall.y2;
  // 半径按"当前视口宽度"（vb.w，随缩放变化）算，不是按整张图纸的宽度（mmW，缩放不变）——
  // 放大后 vb.w 变小，点跟着缩小，屏幕上看起来的大小才不会随便放大就变得很夸张；
  // 留一个 60mm 的下限，纯粹是缩得太狠之后还能点得中，不是真要跟着无限缩小。
  const r = Math.max(60, vb.w / 220);
  const snapR = Math.max(300, mmW / 200);
  const alignTol = Math.max(150, mmW / 400);
  const onDown = (e) => {
    if (e.button !== 0 || panMode) return; // 只认鼠标左键，右键不触发拖动
    e.stopPropagation();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch (err) {}
    dragRef.current = true;
  };
  const onMoveH = (e) => {
    if (!dragRef.current) return;
    const raw = clientToMm(e, svgRef.current, vb);
    let mm;
    if (gridSnap) {
      mm = snapToGridPoint(raw);
      if (onAlignChange) onAlignChange(null);
    } else if (e.shiftKey) {
      // 按住 Shift：把整段墙拉成正水平或正竖直——端点锁定在"与另一端同水平"或"与另一端同垂直"的世界坐标线上，另一端不动；
      // 没被 Shift 锁定的那根轴仍然可以对其它参考点做智能对齐、冒出参考线
      const fixed = end === 1 ? { x: wall.x2, y: wall.y2 } : { x: wall.x1, y: wall.y1 };
      const dx = Math.abs(raw.x - fixed.x), dy = Math.abs(raw.y - fixed.y);
      const lockY = dx >= dy;
      mm = lockY ? { x: raw.x, y: fixed.y } : { x: fixed.x, y: raw.y };
      const refs = collectAlignPoints(walls, cores, wall.id, null);
      const match = findAlignMatch(mm, refs, alignTol);
      if (lockY && match.x != null) {
        mm = { x: match.x, y: mm.y };
        if (onAlignChange) onAlignChange({ x: match.x, y: null });
      } else if (!lockY && match.y != null) {
        mm = { x: mm.x, y: match.y };
        if (onAlignChange) onAlignChange({ x: null, y: match.y });
      } else if (onAlignChange) {
        onAlignChange(null);
      }
    } else {
      const snapped = snapPoint(raw, walls, snapR, wall.id, cores);
      if (snapped.x !== raw.x || snapped.y !== raw.y) {
        mm = snapped;
        if (onAlignChange) onAlignChange(null);
      } else {
        // 智能对齐：跟其它墙端点 / 核心筒角点的 X 或 Y 对上时吸附该坐标，并冒出一条参考线（类似 Rhino smart track）
        const refs = collectAlignPoints(walls, cores, wall.id, null);
        const match = findAlignMatch(raw, refs, alignTol);
        mm = { x: match.x != null ? match.x : raw.x, y: match.y != null ? match.y : raw.y };
        if (onAlignChange) onAlignChange(match.x != null || match.y != null ? match : null);
      }
    }
    onMove(wall.id, end === 1 ? { x1: mm.x, y1: mm.y } : { x2: mm.x, y2: mm.y });
  };
  const onUp = () => {
    dragRef.current = null;
    if (onAlignChange) onAlignChange(null);
  };
  return (
    <rect
      x={x - r}
      y={y - r}
      width={r * 2}
      height={r * 2}
      fill={C.panel}
      stroke={C.ink}
      strokeWidth={r / 5}
      onPointerDown={onDown}
      onPointerMove={onMoveH}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onClick={(e) => e.stopPropagation()}
      style={{ cursor: "grab" }}
    />
  );
}

/* 楼层边界顶点拖动：按住 Shift 时，把移动方向锁死在纯水平或纯竖直——锁定基准是"这次拖动开始时
   该顶点自己的原始位置"（而不是相邻顶点），拖动幅度以水平为主就锁 Y（只能沿 X 移动），以竖直为主就
   锁 X（只能沿 Y 移动），松开重新拖一次可以换成另一根轴；没被锁的那根轴仍可智能对齐。平时（不按 Shift）
   先试硬吸附到墙 / 核心筒角点，吸不上再试跟墙端点、核心筒角点、边界其它顶点的 X/Y 智能对齐，冒出橙色虚线参考线。 */
function BoundaryPointHandle({ boundary, index, mmW, vb, svgRef, walls, cores, panMode, gridSnap, onMove, onAlignChange }) {
  const dragRef = useRef(null);
  const point = boundary[index];
  const r = Math.max(40, mmW / 400);
  const snapR = Math.max(300, mmW / 200);
  const alignTol = Math.max(150, mmW / 400);
  const onDown = (e) => {
    if (e.button !== 0 || panMode) return; // 只认鼠标左键，右键不触发拖动
    e.stopPropagation();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch (err) {}
    dragRef.current = { orig: { x: point.x, y: point.y } };
  };
  const onMoveH = (e) => {
    if (!dragRef.current) return;
    const raw = clientToMm(e, svgRef.current, vb);
    let mm;
    if (gridSnap) {
      mm = snapToGridPoint(raw);
      if (onAlignChange) onAlignChange(null);
    } else if (e.shiftKey) {
      const orig = dragRef.current.orig;
      const dx = Math.abs(raw.x - orig.x), dy = Math.abs(raw.y - orig.y);
      const lockY = dx >= dy; // 只沿 X 移动（Y 锁在原位）还是只沿 Y 移动（X 锁在原位）
      mm = lockY ? { x: raw.x, y: orig.y } : { x: orig.x, y: raw.y };
      const refs = collectAlignPoints(walls, cores, null, null, boundary, index);
      const match = findAlignMatch(mm, refs, alignTol);
      if (lockY && match.x != null) {
        mm = { x: match.x, y: mm.y };
        if (onAlignChange) onAlignChange({ x: match.x, y: null });
      } else if (!lockY && match.y != null) {
        mm = { x: mm.x, y: match.y };
        if (onAlignChange) onAlignChange({ x: null, y: match.y });
      } else if (onAlignChange) {
        onAlignChange(null);
      }
    } else {
      const snapped = snapPoint(raw, walls, snapR, null, cores);
      if (snapped.x !== raw.x || snapped.y !== raw.y) {
        mm = snapped;
        if (onAlignChange) onAlignChange(null);
      } else {
        const refs = collectAlignPoints(walls, cores, null, null, boundary, index);
        const match = findAlignMatch(raw, refs, alignTol);
        mm = { x: match.x != null ? match.x : raw.x, y: match.y != null ? match.y : raw.y };
        if (onAlignChange) onAlignChange(match.x != null || match.y != null ? match : null);
      }
    }
    onMove(index, mm);
  };
  const onUp = () => {
    dragRef.current = null;
    if (onAlignChange) onAlignChange(null);
  };
  return (
    <circle
      cx={point.x}
      cy={point.y}
      r={r}
      fill={C.accent}
      onPointerDown={onDown}
      onPointerMove={onMoveH}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onClick={(e) => e.stopPropagation()}
      style={{ cursor: "grab" }}
    />
  );
}

function WallBody({ wall, mmW, vb, svgRef, drawMode, panMode, gridSnap, onMove, onSelect }) {
  const dragRef = useRef(null);
  const active = !panMode && drawMode === "view";
  const onDown = (e) => {
    if (e.button !== 0 || !active) return; // 只认鼠标左键，右键不触发拖动
    e.stopPropagation();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch (err) {}
    onSelect(wall.id);
    dragRef.current = { start: clientToMm(e, svgRef.current, vb), orig: { x1: wall.x1, y1: wall.y1, x2: wall.x2, y2: wall.y2 } };
  };
  const onMoveH = (e) => {
    if (!dragRef.current) return;
    const cur = clientToMm(e, svgRef.current, vb);
    const { start, orig } = dragRef.current;
    let dx = cur.x - start.x, dy = cur.y - start.y;
    if (gridSnap) {
      // 把"起点"和"起点+位移"都各自吸到网格上，两者之差就是网格对齐后的位移——这样墙的两个端点
      // 会整体挪动同一个（网格对齐过的）距离，不是各自分别吸附（那样会改变墙的长度/角度）
      const snappedStart = snapToGridPoint(start);
      const snappedCur = snapToGridPoint({ x: start.x + dx, y: start.y + dy });
      dx = snappedCur.x - snappedStart.x;
      dy = snappedCur.y - snappedStart.y;
    } else if (e.shiftKey) {
      // 按住 Shift：整面墙只能沿 X 或 Y 方向平移，哪个方向移动得多就锁哪个
      if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
      else dx = 0;
    }
    onMove(wall.id, { x1: orig.x1 + dx, y1: orig.y1 + dy, x2: orig.x2 + dx, y2: orig.y2 + dy });
  };
  const onUp = () => {
    dragRef.current = null;
  };
  return (
    <line
      x1={wall.x1}
      y1={wall.y1}
      x2={wall.x2}
      y2={wall.y2}
      stroke={C.muted}
      strokeWidth={wall.t}
      strokeLinecap="square"
      onPointerDown={onDown}
      onPointerMove={onMoveH}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onClick={(e) => e.stopPropagation()}
      style={{ cursor: active ? "grab" : undefined }}
    />
  );
}

function DoorHandle({ wall, door, mmW, vb, svgRef, panMode, gridSnap, onMove, onSelect }) {
  const dragRef = useRef(null);
  const world = doorWorldOnWall(wall, door);
  const r = Math.max(40, mmW / 320);
  const onDown = (e) => {
    if (e.button !== 0 || panMode) return; // 只认鼠标左键，右键不触发拖动
    e.stopPropagation();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch (err) {}
    if (onSelect) onSelect(door.id);
    dragRef.current = true;
  };
  const onMoveH = (e) => {
    if (!dragRef.current) return;
    const mm = clientToMm(e, svgRef.current, vb);
    const len = wallLength(wall);
    const dx = wall.x2 - wall.x1, dy = wall.y2 - wall.y1;
    const t = clamp(((mm.x - wall.x1) * dx + (mm.y - wall.y1) * dy) / (len * len), 0, 1);
    const at = gridSnap ? snapToGridValue(t * len) : t * len;
    onMove(door.id, { at });
  };
  const onUp = () => {
    dragRef.current = null;
  };
  return (
    <circle
      cx={world.x}
      cy={world.y}
      r={r}
      fill={C.paper}
      stroke={C.accent}
      strokeWidth={r / 4}
      onPointerDown={onDown}
      onPointerMove={onMoveH}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onClick={(e) => e.stopPropagation()}
      style={{ cursor: "ew-resize" }}
    />
  );
}

function PlanEditor({ res, inp, plan, setPlan, scissorRelax, undoPlan, redoPlan, canUndoPlan, canRedoPlan, initialHeatmap = false }) {
  const svgRef = useRef(null);
  const fileRef = useRef(null);
  const clipboardRef = useRef(null);
  const pdfPageRef = useRef(null); // 上传 PDF 后渲染/解析出的原始数据（{mod, page}），供两条识别路线按需重新识别用；不进 plan/不持久化
  const [calibPts, setCalibPts] = useState([]);
  const [calibMM, setCalibMM] = useState("");
  const [addShaftKey, setAddShaftKey] = useState("");
  const [wallPts, setWallPts] = useState([]);
  const [presetConfirm, setPresetConfirm] = useState(false);
  const [selectedCoreId, setSelectedCoreId] = useState(null);
  const [alignGuide, setAlignGuide] = useState(null); // 拖动时的智能对齐参考线：{x, y}（各自可为 null）
  const [selectedWallId, setSelectedWallId] = useState(null);
  const [selectedDoorId, setSelectedDoorId] = useState(null);
  const [selectedWallCandidateId, setSelectedWallCandidateId] = useState(null); // 选中的墙体候选（蓝色虚线，识别出来还没接受成正式墙的那一段），选中后可以按 Delete/Backspace 单独丢弃这一段
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfError, setPdfError] = useState(null);
  const [hasPdfPage, setHasPdfPage] = useState(false); // 当前底图是不是刚上传的 PDF（决定要不要显示"按矢量解析/按图像识别"两个按钮）
  const [wallDetectMsg, setWallDetectMsg] = useState(null); // 上一次识别的提示文字（比如矢量解析找不到线段时提醒改试图像识别）
  const [dimBusy, setDimBusy] = useState(false);
  const [dimError, setDimError] = useState(null);
  const [dimensionCandidates, setDimensionCandidates] = useState([]); // 自动标定比例：OCR 识别出的标注数字+匹配到的尺寸线候选，不进 plan（只是标定用的临时数据，标定完就清空）
  const [wallWidthMin, setWallWidthMin] = useState(0); // 墙体识别的宽度过滤下限（像素，未标定比例前的原始像素——家具/文字/标注线通常比真正的墙线细）
  const [wallWidthMax, setWallWidthMax] = useState(WALL_WIDTH_SLIDER_MAX); // 上限；滑块拉到最大值时当"不限"处理（Infinity），不是真的卡死在这个数字
  const [roomFilterOn, setRoomFilterOn] = useState(false); // 图像识别的"按房间分隔关系过滤噪点"，默认关（有门洞的图纸开着会误删内墙，用户实测反馈更差）
  /* AI 识图（第三条识别路线）：服务商 / 各家的 API 密钥 / 模型名都由用户在界面上填，只存在浏览器
     localStorage（键 stair-core:ai-vision），源码和构建产物里没有任何密钥。设置的读写走
     aiVisionDetect.js 的 readAiSettings/writeAiSettings，这里只是把它们当普通 state 用。 */
  const [aiSettings, setAiSettings] = useState(() => readAiSettingsFromBrowser());
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState(null);
  const [aiShowKey, setAiShowKey] = useState(false); // 密钥输入框默认打码，点"显示"才明文
  /* 行走距离热力图：整层按 1 m（可选 0.5/1/2 m）打格，每格按"到最近核心筒门的最短路径"判达标绿/超标红，
     用途分组 + 是否喷淋决定限值（跟单条路径的校核用同一张 TRAVEL_GROUPS 表）。是组件内 state，不进
     plan（只是一种显示方式，不是设计数据；关掉再开重新算就行）。 */
  const [heatmapOn, setHeatmapOn] = useState(!!initialHeatmap);
  const [heatmapGroup, setHeatmapGroup] = useState("other");
  const [heatmapSprinklered, setHeatmapSprinklered] = useState(true);
  const [heatmapCellM, setHeatmapCellM] = useState(1);
  /* 第四条识别路线：本机 Floorplan Marker（项目里 floorplan-marker/ 的 Python + OpenCV 服务，127.0.0.1:8765，
     不联网不用密钥）。阈值默认 230（我们的底图是 pdf.js 渲染的抗锯齿细线，Marker 自己默认的 180 会丢门弧/踏步）。 */
  const [markerBusy, setMarkerBusy] = useState(false);
  const [markerError, setMarkerError] = useState(null);
  const [markerThreshold, setMarkerThreshold] = useState(230);
  /* 识图菜单：当前选的识别路线（默认 marker，记在 localStorage 里下次打开还是它）、参数区是否展开、
     Marker 服务在线状态（null=还没查，true/false）。 */
  const [detectMethod, setDetectMethodState] = useState(() => {
    try {
      const v = localStorage.getItem("stair-core:detect-method");
      return ["marker", "vector", "raster", "ai"].includes(v) ? v : "marker";
    } catch {
      return "marker";
    }
  });
  const setDetectMethod = (v) => {
    setDetectMethodState(v);
    try {
      localStorage.setItem("stair-core:detect-method", v);
    } catch {
      /* 存不了就算了 */
    }
  };
  const [detectSettingsOpen, setDetectSettingsOpen] = useState(false);
  /* 右侧整栏（核心筒/墙/门/路径四个面板）一键折叠到右边缘，让画布占满整行（记在 localStorage） */
  const [sidebarOpen, setSidebarOpenState] = useState(() => {
    try {
      return localStorage.getItem("stair-core:sidebar") !== "closed";
    } catch {
      return true;
    }
  });
  const setSidebarOpen = (open) => {
    setSidebarOpenState(open);
    try {
      localStorage.setItem("stair-core:sidebar", open ? "open" : "closed");
    } catch {
      /* 存不了就算了 */
    }
  };
  /* 右侧面板的折叠状态（记在 localStorage）：墙/门的编号列表默认收起（用户反馈太占地方），核心筒和疏散路径默认展开 */
  const [panelOpen, setPanelOpenState] = useState(() => {
    const d = { examples: true, cores: true, walls: false, doors: false, paths: true };
    try {
      const j = JSON.parse(localStorage.getItem("stair-core:panels") || "null");
      return j && typeof j === "object" ? { ...d, ...j } : d;
    } catch {
      return d;
    }
  });
  const setPanelOpen = (key, open) =>
    setPanelOpenState((prev) => {
      if (prev[key] === open) return prev;
      const next = { ...prev, [key]: open };
      try {
        localStorage.setItem("stair-core:panels", JSON.stringify(next));
      } catch {
        /* 存不了就算了 */
      }
      return next;
    });
  const [markerOnline, setMarkerOnline] = useState(null);
  const [markerStarting, setMarkerStarting] = useState(false);
  const [markerStartError, setMarkerStartError] = useState(null);
  const [markerTick, setMarkerTick] = useState(0); // 加一就重新探活（"启动服务"之后用）
  /* 界面上的"启动服务"按钮：让开发服务器把 floorplan-marker 拉起来（POST /__marker/start，见 src/dev/markerService.mjs），
     服务器那边会等到它上线才返回。dist-single 静态版没有开发服务器，按钮不显示（bridgeOk 为 false）。 */
  const startMarkerService = async () => {
    setMarkerStarting(true);
    setMarkerStartError(null);
    try {
      const res = await fetch("/__marker/start", { method: "POST" });
      const j = await res.json().catch(() => null);
      if (!j || !j.ok) throw new Error((j && j.error) || t("服务器返回 {0}", [res.status]));
    } catch (err) {
      setMarkerStartError(err && err.message ? err.message : String(err));
    } finally {
      setMarkerStarting(false);
      setMarkerTick((t) => t + 1);
    }
  };
  useEffect(() => {
    // 选中 Marker 路线时探一下本机服务在不在（GET /api/health），识别完也重探一次；不在就直接告诉用户怎么启动
    if (!plan.bgSrc || detectMethod !== "marker" || markerBusy) return;
    let cancelled = false;
    setMarkerOnline(null);
    import("../plan/marker.js")
      .then((mod) => mod.checkMarkerHealth())
      .then((ok) => {
        if (!cancelled) setMarkerOnline(ok);
      })
      .catch(() => {
        if (!cancelled) setMarkerOnline(false);
      });
    return () => {
      cancelled = true;
    };
  }, [plan.bgSrc, detectMethod, markerBusy, markerTick]);
  const updateAiSettings = (patch) => {
    setAiSettings((prev) => {
      const next = typeof patch === "function" ? patch(prev) : { ...prev, ...patch };
      writeAiSettingsToBrowser(next);
      return next;
    });
  };

  const mmW = plan.naturalW * plan.mmPerPx;
  const mmH = plan.naturalH * plan.mmPerPx;
  /* 显示窗口固定 16:9：viewBox 本身按 16:9 取（“取景框”），而不是跟着平面自身的长宽比走——
     zoom=1 时取景框刚好包住整个平面（较宽的一边贴边，另一边居中留出机位空间，不是留白 bug，
     是取景框比平面“方”或比平面“扁”时天然会看到平面以外的空白画布，可平移查看）。
     画布固定 16:9，不再依赖平面自身比例，也就不会再有拉伸变形或跟内容比例对不上的问题。 */
  const baseVBW = Math.max(mmW, mmH * VIEW_ASPECT);
  const baseVBH = baseVBW / VIEW_ASPECT;

  const [zoom, setZoom] = useState(1);
  const [panMM, setPanMM] = useState({ x: 0, y: 0 });
  const [panMode, setPanMode] = useState(false);
  const [gridSnap, setGridSnap] = useState(false); // 网格吸附：开启后拖动一律落在 10 cm 网格上（GRID_SIZE）
  useEffect(() => {
    setZoom(1);
    setPanMM({ x: 0, y: 0 });
  }, [mmW, mmH]);
  /* 视野比平面本身还大的方向：居中显示、该方向不再允许平移；否则按常规夹在 [0, extent-视野] 内 */
  /* 视野比平面小（放大过）时，仍允许再平移出去一段（各留一个平面自身尺寸那么宽的空白余量），
     而不是紧贴平面边缘就顶死——方便随意拖到平面以外的空白处 */
  const clampAxis = (pos, extent, vbExtent) => {
    if (vbExtent >= extent) return -(vbExtent - extent) / 2;
    const margin = extent;
    return clamp(pos, -margin, extent - vbExtent + margin);
  };
  const vbW = baseVBW / zoom, vbH = baseVBH / zoom;
  const vb = { x: clampAxis(panMM.x, mmW, vbW), y: clampAxis(panMM.y, mmH, vbH), w: vbW, h: vbH };
  const setZoomKeepCenter = (nz) => {
    nz = clamp(nz, MIN_ZOOM, MAX_ZOOM);
    const cx = vb.x + vb.w / 2, cy = vb.y + vb.h / 2;
    const nw = baseVBW / nz, nh = baseVBH / nz;
    setZoom(nz);
    setPanMM({ x: clampAxis(cx - nw / 2, mmW, nw), y: clampAxis(cy - nh / 2, mmH, nh) });
  };
  const zoomAt = (clientX, clientY, factor) => {
    const svgEl = svgRef.current;
    if (!svgEl) return;
    const rect = svgEl.getBoundingClientRect();
    const mx = vb.x + (vb.w * (clientX - rect.left)) / rect.width;
    const my = vb.y + (vb.h * (clientY - rect.top)) / rect.height;
    const nz = clamp(zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const nw = baseVBW / nz, nh = baseVBH / nz;
    const fx = (mx - vb.x) / vb.w, fy = (my - vb.y) / vb.h;
    setZoom(nz);
    setPanMM({ x: clampAxis(mx - fx * nw, mmW, nw), y: clampAxis(my - fy * nh, mmH, nh) });
  };
  const zoomAtRef = useRef(zoomAt);
  zoomAtRef.current = zoomAt;
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return undefined;
    const onWheelNative = (e) => {
      e.preventDefault();
      zoomAtRef.current(e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    };
    el.addEventListener("wheel", onWheelNative, { passive: false });
    return () => el.removeEventListener("wheel", onWheelNative);
  }, []);
  const dragState = useRef(null);
  const onCanvasPointerDown = (e) => {
    // 画布空白处：左右键都保留（右键专门用来平移画布，不会选中/拖动任何物体，因为物体自己的
    // onDown 已经各自挡掉了右键），只是不让中键之类的触发
    if (e.button !== 0 && e.button !== 2) return;
    dragState.current = { x: e.clientX, y: e.clientY, pan: { x: vb.x, y: vb.y }, moved: false };
  };
  const onCanvasPointerMove = (e) => {
    const ds = dragState.current;
    if (!ds) return;
    const dx = e.clientX - ds.x, dy = e.clientY - ds.y;
    if (Math.hypot(dx, dy) > 4) ds.moved = true;
    if (ds.moved) {
      const rect = svgRef.current.getBoundingClientRect();
      const nx = clampAxis(ds.pan.x - (dx * vb.w) / rect.width, mmW, vb.w);
      const ny = clampAxis(ds.pan.y - (dy * vb.h) / rect.height, mmH, vb.h);
      setPanMM({ x: nx, y: ny });
    }
  };
  const onCanvasPointerUp = (e) => {
    const ds = dragState.current;
    dragState.current = null;
    if (!ds || ds.moved) return;
    if (panMode) return; // 平移模式下单纯点击不触发画点 / 选中等操作
    handleCanvasClick(e);
  };
  const rawCell = clamp(Math.min(mmW, mmH) / 200, 100, 400);
  // 热力图开着时让细格正好整除粗格（1 m / 0.5 m / 2 m），否则粗格会变成 1.05 m 之类、跟 1 m 网格对不上
  const CELL = heatmapOn ? (heatmapCellM * 1000) / Math.ceil((heatmapCellM * 1000) / rawCell) : rawCell;
  const grid = useMemo(() => buildObstacleGrid(mmW, mmH, plan.boundary, plan.walls, plan.doors, plan.cores, CELL), [mmW, mmH, plan.boundary, plan.walls, plan.doors, plan.cores, CELL]);
  const autoResults = useMemo(() => {
    const map = {};
    plan.paths.forEach((p) => {
      if (p.kind === "auto") map[p.id] = computeAutoPath(grid, p.src, plan.cores, p.targetCore || null);
    });
    return map;
  }, [grid, plan.paths, plan.cores]);
  const heatmap = useMemo(() => (heatmapOn && plan.cores.length > 0 ? computeTravelHeatmap(grid, plan.cores, heatmapCellM * 1000) : null), [heatmapOn, grid, plan.cores, heatmapCellM]);
  const heatmapLimit = travelLimit(heatmapGroup, heatmapSprinklered);
  const heatmapStats = useMemo(() => {
    if (!heatmap) return null;
    let ok = 0, over = 0;
    for (const c of heatmap.cells) {
      if (!Number.isFinite(c.dist)) continue;
      if (c.dist <= heatmapLimit) ok++;
      else over++;
    }
    return { ok, over, unreachable: heatmap.unreachable, worst: heatmap.worst };
  }, [heatmap, heatmapLimit]);

  const shaftOptions = useMemo(
    () =>
      res.zones.flatMap((z, zi) =>
        z.shafts.map((sh, si) => ({
          key: `${zi}-${si}`,
          label:
            inp.stairType === "dogleg"
              ? t("楼梯 #{0}（L{1}–L{2}）", [sh.stairs[0].k, z.from, sh.stairs[0].top])
              : t("梯井 {0}：{1}（L{2}–L{3}）", [si + 1, sh.stairs.map((s) => "#" + s.k).join("+"), z.from, z.to]),
          shortLabel: inp.stairType === "dogleg" ? `#${sh.stairs[0].k}` : t("梯井{0}", [si + 1]),
          outerW: sh.innerW + 2 * inp.wall,
          outerL: sh.innerL + 2 * inp.wall,
        }))
      ),
    [res, inp.stairType, inp.wall]
  );
  useEffect(() => {
    if (!addShaftKey && shaftOptions[0]) setAddShaftKey(shaftOptions[0].key);
  }, [shaftOptions, addShaftKey]);

  const updateCore = (id, patch) => setPlan((prev) => ({ ...prev, cores: prev.cores.map((c) => (c.id === id ? { ...c, ...patch } : c)) }));
  /* 用函数式更新直接从 prev 里读当前角度再加，不依赖外层闭包里的 plan.cores——
     按 R 键这种"读当前值再改"的操作用函数式更新更稳妥，不会因为闭包过期而漏加/多加。
     core.x/core.y 是本地坐标原点（矩形角点）的世界坐标，只改 rot 会让核心筒绕这个角点摆动；
     要绕中心点转，就要在换新角度的同时反推出新的 x/y，让"角点 + 半个长/宽按新角度转出来的偏移"
     依然等于旋转前算好的中心点世界坐标——中心点本身在旋转前后当然不变，变的是角点该挪到哪。 */
  const rotateCoreBy = (id, deltaDeg) =>
    setPlan((prev) => ({
      ...prev,
      cores: prev.cores.map((c) => {
        if (c.id !== id) return c;
        const newRot = (((c.rot + deltaDeg) % 360) + 360) % 360;
        const center = coreLocalToWorld(c, c.l / 2, c.w / 2);
        const rad = (newRot * Math.PI) / 180;
        const hl = c.l / 2, hw = c.w / 2;
        const newX = center.x - (hl * Math.cos(rad) - hw * Math.sin(rad));
        const newY = center.y - (hl * Math.sin(rad) + hw * Math.cos(rad));
        return { ...c, rot: newRot, x: newX, y: newY };
      }),
    }));
  const removeCore = (id) => {
    setPlan((prev) => ({ ...prev, cores: prev.cores.filter((c) => c.id !== id) }));
    setSelectedCoreId((prev) => (prev === id ? null : prev));
  };
  const addCore = () => {
    const opt = shaftOptions.find((o) => o.key === addShaftKey) || shaftOptions[0];
    if (!opt) return;
    setPlan((prev) => {
      const id = prev.nextId;
      const color = STAIR_COLORS[prev.cores.length % STAIR_COLORS.length];
      return {
        ...prev,
        nextId: id + 1,
        cores: [
          ...prev.cores,
          {
            id,
            label: opt.shortLabel,
            shaftKey: opt.key,
            color,
            rot: 0,
            w: opt.outerW,
            l: opt.outerL,
            x: mmW / 2 - opt.outerL / 2,
            y: mmH / 2 - opt.outerW / 2,
            doorLocal: { x: 0, y: opt.outerW / 2 },
            doorSwing: 1,
            doorHinge: 1,
            doorWidth: DOOR_DEFAULT_WIDTH,
          },
        ],
      };
    });
  };
  const duplicateCore = (core) => {
    const id = plan.nextId;
    const base = core.label.replace(/ \(\d+\)$/, "");
    const used = new Set(plan.cores.map((c) => c.label));
    let n = 2;
    while (used.has(`${base} (${n})`)) n++;
    setPlan((prev) => ({
      ...prev,
      nextId: id + 1,
      cores: [...prev.cores, { ...core, id, label: `${base} (${n})`, x: core.x + 600, y: core.y + 600, doorLocal: { ...core.doorLocal } }],
    }));
    setSelectedCoreId(id);
  };
  /* 复制一面墙（连同挂在它上面的门）：新墙整体平移 600mm（跟核心筒复制一样，让人看得出是新的一份），
     门的 at/width 是沿墙的局部量，照抄即可。粘贴完自动选中新墙，方便马上拖到位。 */
  const duplicateWall = (wall, doors) => {
    const wallId = plan.nextId;
    let id = wallId + 1;
    const newDoors = (doors || []).map((d) => ({ ...d, id: id++, wallId }));
    setPlan((prev) => ({
      ...prev,
      nextId: id,
      walls: [...prev.walls, { ...wall, id: wallId, x1: wall.x1 + 600, y1: wall.y1 + 600, x2: wall.x2 + 600, y2: wall.y2 + 600 }],
      doors: [...prev.doors, ...newDoors],
    }));
    setSelectedCoreId(null);
    setSelectedDoorId(null);
    setSelectedWallCandidateId(null);
    setSelectedWallId(wallId);
  };

  /* 工程文件：保存（Ctrl+S，有文件句柄就覆盖写同一个文件）/ 另存为（弹路径选择器）/ 打开。
     Chrome/Edge 走 File System Access API 能真正选路径、覆盖保存；其它浏览器退回下载 + 文件选择框。
     打开后 pdfPageRef 清空（矢量/图像两条识别路线需要 pdf.js 的原始页面，文件里没有），Marker/AI 用底图照常。
     planRef 让键盘快捷键里拿到的永远是最新的 plan，不依赖 effect 的依赖数组。 */
  const planRef = useRef(plan);
  planRef.current = plan;
  const fileHandleRef = useRef(null); // 浏览器 File System Access API 的句柄（只有普通 Chrome/Edge 直接打开时才有）
  const filePathRef = useRef(null); // 开发服务器桥记住的磁盘路径（系统对话框里选的）；有它就能 Ctrl+S 直接覆盖
  const fileNameRef = useRef(""); // 跟 fileName state 同步的 ref：键盘快捷键那个 effect 只在挂载时建一次闭包，读 ref 才拿得到最新文件名
  const [fileName, setFileNameState] = useState("");
  const setFileName = (n) => {
    fileNameRef.current = n;
    setFileNameState(n);
  };
  const [fileMsg, setFileMsg] = useState(null); // {text, error}
  // 开发服务器桥在不在（决定"另存为"按钮显不显示、提示文案怎么写）；dist-single 静态版没有桥
  const [bridgeOk, setBridgeOk] = useState(false);
  useEffect(() => {
    let alive = true;
    bridgeAvailable().then((ok) => alive && setBridgeOk(ok));
    return () => {
      alive = false;
    };
  }, []);
  /* 示例保护：从 example 面板打开的（或路径落在 "Saved Plans" 目录里的）工程，点"保存"/Ctrl+S 不直接覆盖，
     先弹确认条（确定覆盖 / 另存为 / 取消）——用户要求"这三个 example 打开的时候就没法被覆盖保存，除非经过再次确认"。
     用 ref 而不是 state 是因为键盘快捷键的闭包只建一次，读 ref 才拿得到最新值。 */
  const fileProtectedRef = useRef(false);
  const [overwriteConfirm, setOverwriteConfirm] = useState(false);
  const examplesDirRef = useRef(null); // 示例目录的绝对路径（从 /__plan/examples 拿到），用来判断一个路径是不是示例
  const isExamplePath = (p) => !!p && !!examplesDirRef.current && String(p).toLowerCase().startsWith(String(examplesDirRef.current).toLowerCase());
  const doSavePlan = async (saveAs, force = false) => {
    if (!saveAs && !force && fileProtectedRef.current && (filePathRef.current || fileHandleRef.current)) {
      setOverwriteConfirm(true);
      return;
    }
    setOverwriteConfirm(false);
    try {
      const r = await savePlanFile(planRef.current, { handle: fileHandleRef.current, path: filePathRef.current, saveAs, name: fileNameRef.current });
      // 另存到别处之后就不再是示例了；确认覆盖示例本身则继续保护（下次保存还要确认）
      if (saveAs) fileProtectedRef.current = isExamplePath(r.path);
      fileHandleRef.current = r.handle || null;
      filePathRef.current = r.path || null;
      setFileName(r.name);
      setFileMsg({
        text: r.viaBridge
          ? t("已保存到 {0}（{1}）", [r.path, fileProtectedRef.current ? t("示例文件：下次保存仍会先确认") : t("再按 Ctrl+S 直接覆盖这个文件")])
          : r.downloaded
            ? r.fallbackReason
              ? t("这个浏览器环境不允许网页直接写文件，已改为下载到浏览器默认下载目录：{0}（之后的保存也会直接下载）", [r.name])
              : t("已下载到浏览器默认下载目录：{0}（这个浏览器不支持选路径）", [r.name])
            : t("已保存：{0}", [r.name]),
      });
    } catch (err) {
      if (err && err.name === "AbortError") return; // 用户点了取消
      setFileMsg({ text: t("保存失败：") + (err && err.message ? err.message : String(err)), error: true });
    }
  };
  /* 打开一份工程后的收尾：换 plan、清所有选中/识别状态、记住文件关联。"打开…"和 example 面板共用。 */
  const applyOpenedPlan = (r) => {
    filePathRef.current = r.path || null;
    pdfPageRef.current = null;
    setHasPdfPage(false);
    setWallDetectMsg(null);
    setDimensionCandidates([]);
    setCalibPts([]);
    setSelectedCoreId(null);
    setSelectedWallId(null);
    setSelectedDoorId(null);
    setSelectedWallCandidateId(null);
    setPlan(() => r.plan);
    fileHandleRef.current = r.handle || null;
    // 只有真有磁盘路径/文件句柄（会被覆盖写）的示例才需要保护；线上静态版打开的示例没有路径，保存走浏览器自己的方式，不会覆盖任何东西
    fileProtectedRef.current = !!(r.path || r.handle) && (!!r.protect || isExamplePath(r.path));
    setOverwriteConfirm(false);
    setFileName(r.name);
    setFileMsg({ text: t("已打开：{0}{1}{2}{3}", [r.name, r.savedAt ? t("（保存于 {0}）", [new Date(r.savedAt).toLocaleString()]) : "", r.plan.bgSrc ? "" : t("——这份工程没有底图"), fileProtectedRef.current ? t("。这是示例文件：保存时会先确认，避免误覆盖") : ""]) });
  };
  const doOpenPlan = async () => {
    try {
      applyOpenedPlan(await openPlanFile());
    } catch (err) {
      if (err && err.name === "AbortError") return;
      setFileMsg({ text: t("打开失败：") + (err && err.message ? err.message : String(err)), error: true });
    }
  };
  /* example 面板：列出项目根目录 "Saved Plans" 里的工程文件，点一下直接打开（用户要求"这三个文件能有个面板能直接打开"）。
     列表来自开发服务器（GET /__plan/examples），只在有桥时可用；打开后跟"打开…"一样建立文件关联，Ctrl+S 会存回那个示例。 */
  const [examples, setExamples] = useState({ files: [], dir: null, loading: false, error: null });
  const loadExamples = async () => {
    setExamples((e) => ({ ...e, loading: true, error: null }));
    try {
      const r = await listExamples();
      examplesDirRef.current = r.dir || null;
      setExamples({ files: r.files || [], dir: r.dir || null, missing: !!r.missing, unavailable: !!r.unavailable, loading: false, error: null });
    } catch (err) {
      setExamples((e) => ({ ...e, loading: false, error: err && err.message ? err.message : String(err) }));
    }
  };
  useEffect(() => {
    // 有桥走桥（Saved Plans 目录），没桥读静态清单（GitHub Pages 构建里的 examples/index.json）；桥的探测结果变了再读一次
    loadExamples();
  }, [bridgeOk]);
  const openExampleByName = async (name) => {
    try {
      applyOpenedPlan({ ...(await openExample(name)), protect: true });
    } catch (err) {
      setFileMsg({ text: t("打开示例 {0} 失败：", [name]) + (err && err.message ? err.message : String(err)), error: true });
    }
  };

  useEffect(() => {
    const onKeyDown = (e) => {
      const tag = (e.target && e.target.tagName) || "";
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        // Ctrl+S 保存工程（在输入框里也生效，优先于浏览器自己的"保存网页"）
        e.preventDefault();
        doSavePlan(false);
        return;
      }
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.ctrlKey || e.metaKey) {
        const key = e.key.toLowerCase();
        if (key === "z" && e.shiftKey) {
          e.preventDefault();
          redoPlan();
        } else if (key === "z") {
          e.preventDefault();
          undoPlan();
        } else if (key === "y") {
          e.preventDefault();
          redoPlan();
        } else if (key === "c") {
          // 选中的是核心筒就复制核心筒，选中的是墙就复制墙（连同墙上的门）；读 planRef 保证拿到最新数据
          const cur = planRef.current;
          const core = cur.cores.find((c) => c.id === selectedCoreId);
          const wall = selectedWallId != null ? cur.walls.find((w) => w.id === selectedWallId) : null;
          if (core) clipboardRef.current = { kind: "core", core };
          else if (wall) clipboardRef.current = { kind: "wall", wall, doors: cur.doors.filter((d) => d.wallId === wall.id) };
        } else if (key === "v" && clipboardRef.current) {
          e.preventDefault();
          const clip = clipboardRef.current;
          if (clip.kind === "wall") duplicateWall(clip.wall, clip.doors);
          else duplicateCore(clip.core || clip);
        }
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selectedCoreId != null) {
        e.preventDefault();
        removeCore(selectedCoreId);
      } else if ((e.key === "Delete" || e.key === "Backspace") && selectedWallId != null) {
        e.preventDefault();
        removeWall(selectedWallId);
      } else if ((e.key === "Delete" || e.key === "Backspace") && selectedDoorId != null) {
        e.preventDefault();
        removeDoor(selectedDoorId);
      } else if ((e.key === "Delete" || e.key === "Backspace") && selectedWallCandidateId != null) {
        e.preventDefault();
        rejectWallCandidate(selectedWallCandidateId); // 只丢弃选中的这一段候选，不影响其它还没处理的候选
      } else if (e.key.toLowerCase() === "r" && selectedCoreId != null) {
        e.preventDefault();
        rotateCoreBy(selectedCoreId, 45); // 顺时针 45°：core.rot 在这套坐标约定里增大就是顺时针（跟 coreLocalToWorld 的旋转方向一致）
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [plan.cores, plan.nextId, selectedCoreId, selectedWallId, selectedDoorId, selectedWallCandidateId, undoPlan, redoPlan]);

  const updateWall = (id, patch) =>
    setPlan((prev) => {
      const oldWall = prev.walls.find((w) => w.id === id);
      if (!oldWall) return prev;
      const newWall = { ...oldWall, ...patch };
      // 只拖动了墙的其中一个端点（改变长度/角度，另一端没动）时，把这面墙上的门重新投影到新墙线上，
      // 让门的世界坐标尽量保持不动；整面墙平移（两端一起变）或只改厚度时，门跟着墙走，不用重新投影
      const touchesX1 = patch.x1 !== undefined || patch.y1 !== undefined;
      const touchesX2 = patch.x2 !== undefined || patch.y2 !== undefined;
      let doors = prev.doors;
      if (touchesX1 !== touchesX2) {
        const newLen = wallLength(newWall);
        const oux = (newWall.x2 - newWall.x1) / newLen, ouy = (newWall.y2 - newWall.y1) / newLen;
        doors = prev.doors.map((d) => {
          if (d.wallId !== id) return d;
          const worldPt = doorWorldOnWall(oldWall, d);
          const t = (worldPt.x - newWall.x1) * oux + (worldPt.y - newWall.y1) * ouy;
          const half = d.width / 2;
          return { ...d, at: clamp(t, Math.min(half, newLen / 2), Math.max(newLen - half, newLen / 2)) };
        });
      }
      return { ...prev, walls: prev.walls.map((w) => (w.id === id ? newWall : w)), doors };
    });
  const removeWall = (id) => {
    setPlan((prev) => ({ ...prev, walls: prev.walls.filter((w) => w.id !== id), doors: prev.doors.filter((d) => d.wallId !== id) }));
    setSelectedWallId((prev) => (prev === id ? null : prev));
  };
  const finishWall = () => {
    setPlan((prev) => {
      if (wallPts.length < 2) return { ...prev, mode: "view" };
      let id = prev.nextId;
      const newWalls = [];
      for (let i = 0; i + 1 < wallPts.length; i++) newWalls.push({ id: id++, x1: wallPts[i].x, y1: wallPts[i].y, x2: wallPts[i + 1].x, y2: wallPts[i + 1].y, t: WALL_DEFAULT_T });
      return { ...prev, nextId: id, walls: [...prev.walls, ...newWalls], mode: "view" };
    });
    setWallPts([]);
  };
  const cancelWall = () => {
    setWallPts([]);
    setPlan((prev) => ({ ...prev, mode: "view" }));
  };
  const undoWallPoint = () => setWallPts((prev) => prev.slice(0, -1));

  /* PDF 矢量识别出的墙体候选（plan.wallCandidates）只是"建议"，用户确认（点一下 / 点"全部接受"）
     才会真正变成 plan.walls 里的墙——避免识别错的线段直接污染正式数据。候选的 x1/y1/x2/y2/w 在
     存进 plan.wallCandidates 的时候（见 runVectorDetect/runRasterDetect）就已经按当前的 mmPerPx
     换算成"当前世界坐标"了，这里可以直接拿来用，不用再判断"是不是标定过"——不管标定没标定，
     候选本来就已经跟画布上其它东西在同一个坐标系里。 */
  const acceptWallCandidate = (id) => {
    setPlan((prev) => {
      const c = (prev.wallCandidates || []).find((w) => w.id === id);
      if (!c) return prev;
      return {
        ...prev,
        nextId: prev.nextId + 1,
        walls: [...prev.walls, { id: prev.nextId, x1: c.x1, y1: c.y1, x2: c.x2, y2: c.y2, t: clamp(c.w, 40, 600) }],
        wallCandidates: (prev.wallCandidates || []).filter((w) => w.id !== id),
      };
    });
    setSelectedWallCandidateId((prev) => (prev === id ? null : prev));
  };
  const acceptAllWallCandidates = () => {
    setPlan((prev) => {
      if (!prev.wallCandidates || !prev.wallCandidates.length) return prev;
      let id = prev.nextId;
      const newWalls = prev.wallCandidates.map((c) => ({ id: id++, x1: c.x1, y1: c.y1, x2: c.x2, y2: c.y2, t: clamp(c.w, 40, 600) }));
      return { ...prev, nextId: id, walls: [...prev.walls, ...newWalls], wallCandidates: [] };
    });
    setSelectedWallCandidateId(null);
  };
  /* 一键把识别结果全部转正：墙候选 → 正式墙；楼梯框 → 核心筒（贴在框边上的门候选当它的门，没有就默认
     放在左侧短边中点）；其余门候选 → 挂到离它最近的墙上（门洞中点到墙中心线的距离在容差内才挂，挂不上的
     计数后丢弃，用户手动补）。顺序是先楼梯再门：门候选先被楼梯"认领"，剩下的才去找墙。
     注意核心筒的 w/l 不会跟着之后的标定比例缩放（rescalePositions 只挪位置不改尺寸），所以界面上在还没
     标定（mmPerPx===1）时会提示先标定再添加。 */
  const acceptAllCandidates = () => {
    const wallCands = plan.wallCandidates || [], doorCands = [...(plan.doorCandidates || [])], stairCands = plan.stairCandidates || [];
    if (!wallCands.length && !doorCands.length && !stairCands.length) return;
    let id = plan.nextId;
    const newWalls = wallCands.map((c) => ({ id: id++, x1: c.x1, y1: c.y1, x2: c.x2, y2: c.y2, t: clamp(c.w, 40, 600) }));
    const walls = [...plan.walls, ...newWalls];
    const cores = [...plan.cores];
    // 识别出的楼梯间做成跟"添加核心筒"放进来的核心筒一模一样：挂上当前下拉框里选中的那部楼梯（shaftKey），
    // 这样它会画出梯段/平台、参与"比规范最小尺寸小"的校核、标签也一致；只是外包尺寸取识别出的框而不是规范值。
    const shaftOpt = shaftOptions.find((o) => o.key === addShaftKey) || shaftOptions[0] || null;
    for (const s of stairCands) {
      const bw = s.x2 - s.x1, bh = s.y2 - s.y1;
      if (!(bw > 0) || !(bh > 0)) continue;
      // 核心筒的 l 是梯段方向（局部 x）、w 是垂直方向：框是竖长的就转 90°，让梯段沿长边跑。
      // rot=90 时局部 x 轴指向世界 +y、局部 y 轴指向世界 -x，局部原点要放在框的右上角才能盖住整个框。
      const portrait = bh > bw;
      const core = {
        id: id++,
        label: shaftOpt ? shaftOpt.shortLabel : t("识别楼梯{0}", [cores.length + 1]),
        shaftKey: shaftOpt ? shaftOpt.key : null,
        color: STAIR_COLORS[cores.length % STAIR_COLORS.length],
        rot: portrait ? 90 : 0,
        l: portrait ? bh : bw,
        w: portrait ? bw : bh,
        x: portrait ? s.x2 : s.x1,
        y: s.y1,
        doorLocal: null,
        doorSwing: 1,
        doorHinge: 1,
        doorWidth: DOOR_DEFAULT_WIDTH,
      };
      // 贴在框边上的门候选 → 这个核心筒的门：换到局部坐标后看离哪条边最近，投到那条边上
      const tol = Math.max(300, 0.05 * Math.max(core.l, core.w));
      let bestI = -1, bestD = Infinity, bestLocal = null, bestW = 0;
      doorCands.forEach((d, i) => {
        const p = coreWorldToLocal(core, (d.x1 + d.x2) / 2, (d.y1 + d.y2) / 2);
        if (p.x < -tol || p.x > core.l + tol || p.y < -tol || p.y > core.w + tol) return;
        const edges = [
          [Math.abs(p.x), { x: 0, y: clamp(p.y, 0, core.w) }],
          [Math.abs(p.x - core.l), { x: core.l, y: clamp(p.y, 0, core.w) }],
          [Math.abs(p.y), { x: clamp(p.x, 0, core.l), y: 0 }],
          [Math.abs(p.y - core.w), { x: clamp(p.x, 0, core.l), y: core.w }],
        ];
        for (const [dist, local] of edges)
          if (dist <= tol && dist < bestD) {
            bestD = dist;
            bestI = i;
            bestLocal = local;
            bestW = Math.hypot(d.x2 - d.x1, d.y2 - d.y1);
          }
      });
      if (bestI >= 0) doorCands.splice(bestI, 1);
      core.doorLocal = bestLocal || { x: 0, y: core.w / 2 };
      if (bestW > 0) core.doorWidth = bestW;
      cores.push(core);
    }
    const newDoors = [];
    let skippedDoors = 0;
    for (const d of doorCands) {
      const mid = { x: (d.x1 + d.x2) / 2, y: (d.y1 + d.y2) / 2 };
      const near = nearestWallPoint(mid, walls);
      const width = Math.max(1, Math.hypot(d.x2 - d.x1, d.y2 - d.y1));
      if (!near || near.dist > Math.max(300, near.wall.t * 1.5)) {
        skippedDoors++;
        continue;
      }
      const len = wallLength(near.wall), half = width / 2;
      newDoors.push({ id: id++, wallId: near.wall.id, at: clamp(near.at, Math.min(half, len / 2), Math.max(len - half, len / 2)), width, swing: 1, hinge: 1 });
    }
    setPlan((prev) => ({ ...prev, nextId: id, walls, doors: [...prev.doors, ...newDoors], cores, wallCandidates: [], doorCandidates: [], stairCandidates: [] }));
    setSelectedWallCandidateId(null);
    setWallDetectMsg(
      t("已添加 {0} 面墙、{1} 个门、{2} 个楼梯核心筒", [newWalls.length, newDoors.length, cores.length - plan.cores.length]) +
        (skippedDoors ? t("；{0} 个门候选附近没有墙，已跳过（可手动\"添加门\"）", [skippedDoors]) : "")
    );
  };
  const clearWallCandidates = () => {
    // 连 AI 识图给的门/楼梯标记一起清：它们跟墙体候选是同一批识别结果，"清除识别结果"就该一起清干净
    setPlan((prev) => ({ ...prev, wallCandidates: [], doorCandidates: [], stairCandidates: [] }));
    setSelectedWallCandidateId(null);
  };
  const rejectWallCandidate = (id) => {
    setPlan((prev) => ({ ...prev, wallCandidates: (prev.wallCandidates || []).filter((w) => w.id !== id) }));
    setSelectedWallCandidateId((prev) => (prev === id ? null : prev));
  };

  /* pdfPageRef 里存的是上传时那份原始 canvas/opList，坐标永远是"原始像素"，不会跟着后续的标定
     变化——但画布上其它东西（墙、核心筒、底图渲染用的 mmW）都是"当前世界坐标"，标定过一次
     mmPerPx 就不再是 1。矢量解析/图像识别/标注识别如果是在标定比例之后才点的，识别出来的候选
     必须先乘一次当前的 mmPerPx 换算成当前世界坐标，不然候选会按"未标定的原始像素"摆放，跟已经
     换算过的墙/底图对不上——这是用户发现"标定比例后新识别出的墙没有对齐"这个问题的根源。 */
  const scaleSegments = (segs, scale) => segs.map((s) => ({ ...s, x1: s.x1 * scale, y1: s.y1 * scale, x2: s.x2 * scale, y2: s.y2 * scale, w: s.w * scale }));

  /* 矢量解析 vs 图像识别是用户手动二选一，不自动判断——用户自己的图纸是矢量 CAD 导出还是扫描件
     只有他自己清楚。两条路线都基于上传时已经解析好的 pdfPageRef（不用重新读取/渲染文件），
     可以来回切换重新识别。矢量解析如果一段线段都没找到（真的是扫描件），不当报错处理，只是
     提示用户改试图像识别。 */
  // 过滤范围按"原始像素"（未标定比例前）来定，不是"当前世界坐标"——不然标定比例以后滑块的刻度
  // 含义会跟着比例尺变，用户拖同样的位置在不同标定状态下筛出来的结果就不一样了，体验很奇怪。
  // 上限滑到最大值当"不限"（Infinity），不然真的有特别粗的墙反而会被卡在这个上限之外。
  const wallWidthFilter = () => ({ minW: wallWidthMin, maxW: wallWidthMax >= WALL_WIDTH_SLIDER_MAX ? Infinity : wallWidthMax });
  const runVectorDetect = () => {
    if (!pdfPageRef.current) return;
    const { mod, page } = pdfPageRef.current;
    const wallCandidates = scaleSegments(mod.detectVectorWalls(page, wallWidthFilter()), plan.mmPerPx);
    setWallDetectMsg(wallCandidates.length === 0 ? t("矢量解析没有找到可用的线段——这页大概率是扫描件，试试下面的“按图像识别”") : t("矢量解析：识别到 {0} 段可能的墙", [wallCandidates.length]));
    setPlan((prev) => ({ ...prev, wallCandidates }));
  };
  const runRasterDetect = () => {
    if (!pdfPageRef.current) return;
    setPdfBusy(true);
    const scale = plan.mmPerPx;
    const widthFilter = wallWidthFilter();
    const roomFilter = roomFilterOn;
    // 图像边缘识别是同步的重计算（Sobel + 分桶），先让"识别中…"渲染出来再跑，避免看起来像卡死
    setTimeout(() => {
      try {
        const { mod, page } = pdfPageRef.current;
        const wallCandidates = scaleSegments(mod.detectRasterWalls(page, widthFilter, { roomFilter }), scale);
        setWallDetectMsg(t("图像识别：识别到 {0} 段可能的墙", [wallCandidates.length]));
        setPlan((prev) => ({ ...prev, wallCandidates }));
      } catch (err) {
        console.error(err);
        setPdfError(t("图像识别失败：") + (err && err.message ? err.message : String(err)));
      } finally {
        setPdfBusy(false);
      }
    }, 30);
  };

  /* 第三条路线：AI 识图。整张底图（PDF 渲染出的原始 canvas，或图片上传的 dataURL）缩到模型建议尺寸后
     送给用户选的服务商（Claude / ChatGPT），让模型直接读图给出墙/门/楼梯的像素坐标。跟前两条路线一样
     只产出"候选"（蓝色虚线墙 + 绿色门标记 + 橙色楼梯框），墙走原有的接受/丢弃流程；门和楼梯目前只
     显示、不能转正（先看识别质量值不值得往下做）。
     坐标链路：模型坐标 ×factor → 原图像素（aiVisionDetect.js 里已做） → ×plan.mmPerPx → 当前世界坐标
     （这里 scaleSegments，跟矢量/图像识别一样，标定过比例后也能对齐）。
     不同于矢量/图像识别只在 PDF 上可用，AI 识图对图片底图也能用（它只要一张图）。 */
  const runAiDetect = () => {
    if (!plan.bgSrc || aiBusy) return;
    const provider = AI_PROVIDERS.find((p) => p.key === aiSettings.provider) || AI_PROVIDERS[0];
    const apiKey = (aiSettings.keys[provider.key] || "").trim();
    if (!apiKey) {
      setAiError(t("还没有填 {0} 的 API 密钥——在下面的输入框里粘贴自己的密钥（只存在这台电脑的浏览器里）", [provider.label]));
      return;
    }
    setAiBusy(true);
    setAiError(null);
    setWallDetectMsg(null);
    const scale = plan.mmPerPx;
    // 标定后 plan.naturalW/H 仍是原图像素数（标定改的是 mmPerPx，不是 naturalW），正好作为 factor 的基准
    const source = pdfPageRef.current ? pdfPageRef.current.page.canvas : plan.bgSrc;
    const naturalW = plan.naturalW, naturalH = plan.naturalH;
    import("../plan/aiVision.js")
      .then(async (mod) => {
        const image = await mod.prepareImageForAi(source, naturalW, naturalH);
        return mod.detectFloorPlanWithAi({ provider: provider.key, apiKey, model: aiSettings.models[provider.key], image });
      })
      .then((res) => {
        const wallCandidates = scaleSegments(res.walls, scale);
        const scaleBox = (s) => ({ ...s, x1: s.x1 * scale, y1: s.y1 * scale, x2: s.x2 * scale, y2: s.y2 * scale });
        const doorCandidates = res.doors.map(scaleBox);
        const stairCandidates = res.stairs.map(scaleBox);
        setWallDetectMsg(t("AI 识图（{0}）：识别到 {1} 段可能的墙、{2} 个门、{3} 处楼梯", [res.model, wallCandidates.length, doorCandidates.length, stairCandidates.length]));
        setPlan((prev) => ({ ...prev, wallCandidates, doorCandidates, stairCandidates }));
        setSelectedWallCandidateId(null);
      })
      .catch((err) => {
        console.error(err);
        setAiError(err && err.message ? err.message : String(err));
      })
      .finally(() => setAiBusy(false));
  };

  /* 第四条路线：本机 Floorplan Marker。流程：底图按墨迹范围裁剪缩放 → POST 本机服务 → 结果坐标还原回
     原始像素（marker.js/markerDetect.js）→ ×plan.mmPerPx 进当前世界坐标（跟其它三条路线一样）。
     Marker 只给墙的中心线不给厚度，候选墙厚统一用默认墙厚 WALL_DEFAULT_T（毫米）：原始像素里先除以
     mmPerPx，scaleSegments 乘回来正好是 200mm，标定前后都成立。门/楼梯跟 AI 路线一样只作参考显示。 */
  const runMarkerDetect = () => {
    if (!plan.bgSrc || markerBusy) return;
    setMarkerBusy(true);
    setMarkerError(null);
    setWallDetectMsg(null);
    const scale = plan.mmPerPx;
    const source = pdfPageRef.current ? pdfPageRef.current.page.canvas : plan.bgSrc;
    const naturalW = plan.naturalW, naturalH = plan.naturalH, threshold = markerThreshold;
    import("../plan/marker.js")
      .then(async (mod) => {
        const { dataUrl, crop } = await mod.prepareMarkerImage(source, naturalW, naturalH, threshold);
        const raw = await mod.detectWithMarker({ dataUrl, threshold });
        return mod.mapMarkerResult(raw, crop, WALL_DEFAULT_T / scale);
      })
      .then((res) => {
        const wallCandidates = scaleSegments(res.walls, scale);
        const scaleBox = (s) => ({ ...s, x1: s.x1 * scale, y1: s.y1 * scale, x2: s.x2 * scale, y2: s.y2 * scale });
        const doorCandidates = res.doors.map(scaleBox);
        const stairCandidates = res.stairs.map(scaleBox);
        setWallDetectMsg(t("本机识别（Floorplan Marker，阈值 {0}）：识别到 {1} 段可能的墙、{2} 个门、{3} 处楼梯", [threshold, wallCandidates.length, doorCandidates.length, stairCandidates.length]));
        setPlan((prev) => ({ ...prev, wallCandidates, doorCandidates, stairCandidates }));
        setSelectedWallCandidateId(null);
      })
      .catch((err) => {
        console.error(err);
        setMarkerError(err && err.message ? err.message : String(err));
      })
      .finally(() => setMarkerBusy(false));
  };

  const updateDoor = (id, patch) => setPlan((prev) => ({ ...prev, doors: prev.doors.map((d) => (d.id === id ? { ...d, ...patch } : d)) }));
  const removeDoor = (id) => {
    setPlan((prev) => ({ ...prev, doors: prev.doors.filter((d) => d.id !== id) }));
    setSelectedDoorId((prev) => (prev === id ? null : prev));
  };
  const placeDoor = (mm) => {
    const near = nearestWallPoint(mm, plan.walls);
    if (!near || near.dist > Math.max(1500, mmW / 20)) return;
    const len = wallLength(near.wall);
    const half = DOOR_DEFAULT_WIDTH / 2;
    setPlan((prev) => ({
      ...prev,
      nextId: prev.nextId + 1,
      doors: [...prev.doors, { id: prev.nextId, wallId: near.wall.id, at: clamp(near.at, Math.min(half, len / 2), Math.max(len - half, len / 2)), width: DOOR_DEFAULT_WIDTH, swing: 1, hinge: 1 }],
    }));
  };

  const applyPreset = () => {
    const opt = shaftOptions.find((o) => o.key === addShaftKey) || shaftOptions[0];
    setPlan((prev) => {
      let id = prev.nextId;
      const cx = 25000, cy = 25000;
      const cores = [];
      /* 核心筒外包尺寸向上取整到 100 mm 网格（只能变大、不能比规范算出来的最小尺寸还小，
         不会一加进来就顶着"太小"的红色警示），角点位置也各自吸到最近的 100 mm——角点在网格上
         + 长/宽都是 100 的倍数，另一个角点自然也落在网格上，四条墙线因此整条都在网格上。 */
      const gridW = opt ? Math.ceil(opt.outerW / GRID_SIZE) * GRID_SIZE : 3500;
      const gridL = opt ? Math.ceil(opt.outerL / GRID_SIZE) * GRID_SIZE : 6000;
      const coreX = Math.round((cx - gridL / 2) / GRID_SIZE) * GRID_SIZE;
      const coreY = Math.round((cy - gridW / 2) / GRID_SIZE) * GRID_SIZE;
      if (opt)
        cores.push({
          id: id++,
          label: opt.shortLabel,
          shaftKey: opt.key,
          color: STAIR_COLORS[0],
          rot: 0,
          w: gridW,
          l: gridL,
          x: coreX,
          y: coreY,
          doorLocal: { x: 0, y: gridW / 2 },
          doorSwing: 1,
          doorHinge: 1,
          doorWidth: DOOR_DEFAULT_WIDTH,
        });
      /* 内环墙贴着核心筒留出净距、外环墙再往外加宽出来的走廊；innerHalf 圆整到 100 mm 网格，
         corridorWidth 本身也是 100 的倍数，两者相加的 outerHalf 自动还在网格上——环形走廊比原来
         的 1800 mm 加宽到 3000 mm。 */
      const clearance = 1500;
      const innerHalf = Math.round((Math.max(gridW, gridL) / 2 + clearance) / GRID_SIZE) * GRID_SIZE;
      const corridorWidth = 3000;
      const outerHalf = innerHalf + corridorWidth;
      const ring = (half) => {
        const p = [
          { x: cx - half, y: cy - half },
          { x: cx + half, y: cy - half },
          { x: cx + half, y: cy + half },
          { x: cx - half, y: cy + half },
        ];
        return [0, 1, 2, 3].map((i) => ({ x1: p[i].x, y1: p[i].y, x2: p[(i + 1) % 4].x, y2: p[(i + 1) % 4].y, t: WALL_DEFAULT_T }));
      };
      const innerWalls = ring(innerHalf).map((w) => ({ ...w, id: id++ }));
      const outerWalls = ring(outerHalf).map((w) => ({ ...w, id: id++ }));
      const doors = [];
      if (opt) doors.push({ id: id++, wallId: innerWalls[3].id, at: innerHalf, width: DOOR_DEFAULT_WIDTH, swing: 1, hinge: 1 });
      [0, 1, 2, 3].forEach((i) => doors.push({ id: id++, wallId: outerWalls[i].id, at: outerHalf, width: DOOR_DEFAULT_WIDTH, swing: 1, hinge: 1 }));
      return {
        ...prev,
        nextId: id,
        bgSrc: null,
        naturalW: 50000,
        naturalH: 50000,
        mmPerPx: 1,
        boundary: [
          { x: 0, y: 0 },
          { x: 50000, y: 0 },
          { x: 50000, y: 50000 },
          { x: 0, y: 50000 },
        ],
        cores,
        walls: [...innerWalls, ...outerWalls],
        doors,
        paths: [],
        wallCandidates: [],
        mode: "view",
        drawingPathId: null,
      };
    });
    setWallPts([]);
    setCalibPts([]);
    setPresetConfirm(false);
    setSelectedCoreId(null);
    setSelectedWallId(null);
    setSelectedDoorId(null);
    setSelectedWallCandidateId(null);
    pdfPageRef.current = null;
    setHasPdfPage(false);
    setWallDetectMsg(null);
    setDimensionCandidates([]);
  };

  const applyCalibration = () => {
    if (calibPts.length < 2 || !calibMM) return;
    const mmDist = Math.hypot(calibPts[1].x - calibPts[0].x, calibPts[1].y - calibPts[0].y);
    if (mmDist < 1e-6) return;
    const ratio = Number(calibMM) / mmDist;
    setPlan((prev) => ({ ...rescalePositions(prev, ratio), mmPerPx: prev.mmPerPx * ratio, mode: "view" }));
    setCalibPts([]);
    setCalibMM("");
  };

  /* 自动标定比例：找图纸上的尺寸标注数字（比如"2400"），配上离它最近的一条线当尺寸线，猜出
     像素→毫米的比例——只是"候选"，识别出来叠加显示成可点选的标记，用户点哪个就用哪个的比例，
     不会自动生效，跟墙体候选走的是同一套"候选+人工确认"逻辑。识别结果同样是原始像素坐标，
     要先乘当前 mmPerPx 换算成当前世界坐标（原因见 scaleSegments 那条注释）；pixelLen 换算后
     重新算一遍 ratio，这样不管之前有没有标定过、标定过几次，ratio 用于 rescalePositions 时
     "当前世界坐标 → 新世界坐标"这个语义才是对的。 */
  const runDimensionDetect = () => {
    if (!pdfPageRef.current) return;
    setDimBusy(true);
    setDimError(null);
    const { mod, page } = pdfPageRef.current;
    const scale = plan.mmPerPx;
    mod
      .detectDimensionCandidates(page)
      .then((raw) =>
        setDimensionCandidates(
          raw.map((c) => {
            const pixelLen = c.pixelLen * scale;
            return { ...c, x: c.x * scale, y: c.y * scale, segX1: c.segX1 * scale, segY1: c.segY1 * scale, segX2: c.segX2 * scale, segY2: c.segY2 * scale, pixelLen, ratio: c.valueMm / pixelLen };
          })
        )
      )
      .catch((err) => {
        console.error(err);
        setDimError(t("标注识别失败（需要联网下载 OCR 语言包）：") + (err && err.message ? err.message : String(err)));
      })
      .finally(() => setDimBusy(false));
  };
  const applyDimensionCandidate = (c) => {
    setPlan((prev) => ({ ...rescalePositions(prev, c.ratio), mmPerPx: prev.mmPerPx * c.ratio, mode: "view" }));
    setDimensionCandidates([]);
  };
  const clearDimensionCandidates = () => setDimensionCandidates([]);

  const onFile = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    e.target.value = "";
    setPdfError(null);
    if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
      setPdfBusy(true);
      setWallDetectMsg(null);
      setDimensionCandidates([]);
      // 动态 import：pdf.js 连带 worker 有一定体积，只有用户真的选了 PDF 才加载，不拖慢平时只用
      // 计算器/手动画图的场景；这个动态 import 顺带也让 pdfWalls.js 的 Vite 专用 `?url` worker
      // 引入不会污染 scripts/run-tests.mjs 用 esbuild 打包计算逻辑测试时的静态依赖图。
      // 只加载/渲染，不在这里自动识别——矢量解析和图像识别哪条路线管用，用户自己的图纸是矢量
      // CAD 导出还是扫描件只有他自己清楚，做成手动选，不猜。
      import("../plan/pdfWalls.js")
        .then((mod) => mod.loadPdfPage(file).then((page) => ({ mod, page })))
        .then(({ mod, page }) => {
          pdfPageRef.current = { mod, page };
          setHasPdfPage(true);
          setPlan((prev) => ({ ...prev, bgSrc: page.bgSrc, naturalW: page.naturalW, naturalH: page.naturalH, mmPerPx: 1, boundary: [], cores: [], walls: [], doors: [], paths: [], wallCandidates: [], doorCandidates: [], stairCandidates: [], mode: "view" }));
          setSelectedCoreId(null);
          setSelectedWallId(null);
          setSelectedDoorId(null);
          setSelectedWallCandidateId(null);
        })
        .catch((err) => {
          console.error(err);
          setPdfError(t("PDF 解析失败：") + (err && err.message ? err.message : String(err)));
        })
        .finally(() => setPdfBusy(false));
      return;
    }
    pdfPageRef.current = null;
    setHasPdfPage(false);
    setWallDetectMsg(null);
    setDimensionCandidates([]);
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        setPlan((prev) => ({ ...prev, bgSrc: reader.result, naturalW: img.naturalWidth, naturalH: img.naturalHeight, mmPerPx: 1, boundary: [], cores: [], walls: [], doors: [], paths: [], wallCandidates: [], doorCandidates: [], stairCandidates: [], mode: "view" }));
        setSelectedCoreId(null);
        setSelectedWallId(null);
        setSelectedDoorId(null);
        setSelectedWallCandidateId(null);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  };
  const clearBg = () => {
    setPlan((prev) => ({ ...prev, bgSrc: null, naturalW: 20000, naturalH: 15000, mmPerPx: 1, boundary: [], cores: [], walls: [], doors: [], paths: [], wallCandidates: [], doorCandidates: [], stairCandidates: [], mode: "view" }));
    setSelectedCoreId(null);
    setSelectedWallId(null);
    setSelectedDoorId(null);
    setSelectedWallCandidateId(null);
    pdfPageRef.current = null;
    setHasPdfPage(false);
    setWallDetectMsg(null);
    setDimensionCandidates([]);
  };

  /* "清空平面图"：底图、比例、边界、核心筒、墙、门、路径、识别候选全部回到初始状态（比"清除底图"多了
     重置比例和断开工程文件的关联——清空后再 Ctrl+S 不该把空图覆盖写进刚才那个文件）。
     两步确认：点按钮先弹黄色确认条，再点"确定清空"才真的清。 */
  const [clearConfirm, setClearConfirm] = useState(false);
  const clearPlanAll = () => {
    // 一次 setPlan 写完所有字段：历史里只记一步，Ctrl+Z 一下就能整个找回
    setPlan((prev) => ({ ...prev, bgSrc: null, naturalW: 20000, naturalH: 15000, mmPerPx: 1, boundary: [], cores: [], walls: [], doors: [], paths: [], wallCandidates: [], doorCandidates: [], stairCandidates: [], drawingPathId: null, mode: "view" }));
    setSelectedCoreId(null);
    setSelectedWallId(null);
    setSelectedDoorId(null);
    setSelectedWallCandidateId(null);
    pdfPageRef.current = null;
    setHasPdfPage(false);
    setDimensionCandidates([]);
    setCalibPts([]);
    fileHandleRef.current = null;
    filePathRef.current = null;
    fileProtectedRef.current = false;
    setOverwriteConfirm(false);
    setFileName("");
    setFileMsg(null);
    setClearConfirm(false);
    setWallDetectMsg(t("平面图已清空（如需找回，按 Ctrl+Z 撤销）"));
  };

  const handleCanvasClick = (e) => {
    const mm = clientToMm(e, svgRef.current, vb);
    if (plan.mode === "calibrate") {
      if (calibPts.length < 2) setCalibPts((p) => [...p, mm]);
      return;
    }
    if (plan.mode === "boundary") {
      setPlan((prev) => ({ ...prev, boundary: [...prev.boundary, mm] }));
      return;
    }
    if (plan.mode === "wall") {
      const snapR = Math.max(300, mmW / 200);
      let pt = snapPoint(mm, plan.walls, snapR, null, plan.cores);
      if (pt.x === mm.x && pt.y === mm.y) {
        let best = null;
        wallPts.forEach((p) => {
          const d = Math.hypot(mm.x - p.x, mm.y - p.y);
          if (d <= snapR && (!best || d < best.d)) best = p;
        });
        if (best) pt = best;
      }
      setWallPts((prev) => [...prev, pt]);
      return;
    }
    if (plan.mode === "door") {
      placeDoor(mm);
      return;
    }
    if (plan.mode === "autopath") {
      setPlan((prev) => ({
        ...prev,
        nextId: prev.nextId + 1,
        mode: "view",
        paths: [...prev.paths, { id: prev.nextId, label: t("自动路径 {0}", [prev.paths.length + 1]), kind: "auto", src: mm, targetCore: null, travelGroup: "other", sprinklered: inp.sprinklered }],
      }));
      return;
    }
    if (plan.mode === "path" && plan.drawingPathId) {
      setPlan((prev) => ({ ...prev, paths: prev.paths.map((p) => (p.id === prev.drawingPathId ? { ...p, pts: [...p.pts, mm] } : p)) }));
      return;
    }
    setSelectedCoreId(null); // 点击空白处取消选中
    setSelectedWallId(null);
    setSelectedDoorId(null);
    setSelectedWallCandidateId(null);
  };
  const undoBoundary = () => setPlan((prev) => ({ ...prev, boundary: prev.boundary.slice(0, -1) }));
  const clearBoundary = () => setPlan((prev) => ({ ...prev, boundary: [] }));
  const updateBoundaryPoint = (index, mm) => setPlan((prev) => ({ ...prev, boundary: prev.boundary.map((p, i) => (i === index ? mm : p)) }));

  const newPath = () =>
    setPlan((prev) => {
      const id = prev.nextId;
      return {
        ...prev,
        nextId: id + 1,
        mode: "path",
        drawingPathId: id,
        paths: [...prev.paths, { id, label: t("路径 {0}", [prev.paths.length + 1]), kind: "manual", pts: [], travelGroup: "other", sprinklered: inp.sprinklered }],
      };
    });
  const finishPath = () => setPlan((prev) => ({ ...prev, mode: "view", drawingPathId: null }));
  const undoPathPoint = () => setPlan((prev) => ({ ...prev, paths: prev.paths.map((p) => (p.id === prev.drawingPathId ? { ...p, pts: p.pts.slice(0, -1) } : p)) }));
  const removePath = (id) =>
    setPlan((prev) => ({ ...prev, paths: prev.paths.filter((p) => p.id !== id), drawingPathId: prev.drawingPathId === id ? null : prev.drawingPathId, mode: prev.drawingPathId === id ? "view" : prev.mode }));
  const updatePath = (id, patch) => setPlan((prev) => ({ ...prev, paths: prev.paths.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
  const snapPathToDoor = (pathId, coreId) => {
    const core = plan.cores.find((c) => c.id === coreId);
    if (!core) return;
    const doorPt = coreDoorWorld(core);
    setPlan((prev) => ({ ...prev, paths: prev.paths.map((p) => (p.id === pathId ? { ...p, pts: [...p.pts, doorPt] } : p)) }));
  };

  const diag = plan.boundary.length >= 3 ? polygonDiagonal(plan.boundary) : null;
  const sepRows = [];
  for (let i = 0; i < plan.cores.length; i++)
    for (let j = i + 1; j < plan.cores.length; j++) {
      const a = plan.cores[i], b = plan.cores[j];
      const da = coreDoorWorld(a), db = coreDoorWorld(b);
      const dist = Math.hypot(da.x - db.x, da.y - db.y);
      const relaxed = scissorRelax && inp.stairType === "scissor";
      const req = diag != null ? requiredExitSeparation(diag, plan.hasCorridor, relaxed) : null;
      sepRows.push({ a, b, dist, req, ok: req != null ? dist >= req : null, relaxed });
    }
  /* 哪些核心筒离别的核心筒太近（沿用"出口间距校核"同一份 sepRows.ok 判定，两边保持一致）——
     没画楼层边界时 diag 是 null、req/ok 都是 null，不会误报"太近"。 */
  const tooCloseCoreIds = new Set();
  sepRows.forEach((r) => {
    if (r.ok === false) {
      tooCloseCoreIds.add(r.a.id);
      tooCloseCoreIds.add(r.b.id);
    }
  });

  const planWarnings = [];
  plan.cores.forEach((c) => {
    if (plan.boundary.length >= 3 && coreCorners(c).some((pt) => !pointInPolygon(pt, plan.boundary))) planWarnings.push(t("{0}：有角点落在已绘制的楼层边界之外", [c.label]));
  });
  for (let i = 0; i < plan.cores.length; i++)
    for (let j = i + 1; j < plan.cores.length; j++)
      if (polysOverlap(coreCorners(plan.cores[i]), coreCorners(plan.cores[j]))) planWarnings.push(t("{0} 与 {1} 的外框重叠", [plan.cores[i].label, plan.cores[j].label]));

  const modeLabel = panMode
    ? t("平移模式：在画布任意位置拖动都会平移视野（不会误触核心筒/门/墙），再点一次“平移”退出")
    : {
        view: t("浏览 / 拖动核心筒、门标记、墙端点"),
        calibrate: t("标定比例：依次点击两个已知实际距离的点"),
        boundary: t("绘制楼层边界：依次点击轮廓顶点"),
        wall: t("绘制墙体：依次点击墙的折点，完成后点“完成墙体”"),
        door: t("添加门：在已画的墙上点击门的位置（会自动吸附到最近的墙）"),
        path: t("绘制疏散路径（手动折线）：依次点击路径转折点"),
        autopath: t("自动最短路径：在图上点击疏散起点，工具会沿走廊避开墙体自动算出到核心筒门的最短路径"),
      }[plan.mode];

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-3" style={{ fontSize: 12.5 }}>
        <button type="button" onClick={() => fileRef.current && fileRef.current.click()} className="rounded px-3 py-1.5" style={{ background: C.accent, color: C.onAccent, fontWeight: 600 }}>
          {t("上传平面图")}
        </button>
        <input ref={fileRef} type="file" accept="image/*,application/pdf" onChange={onFile} style={{ display: "none" }} />
        {/* 工程文件：保存 / 另存为 / 打开（见 doSavePlan / doOpenPlan）。文件名显示在旁边，Ctrl+S 也能保存 */}
        <span className="flex items-center gap-1" data-testid="file-bar">
          <button type="button" onClick={() => doSavePlan(false)} className="rounded px-3 py-1.5" style={{ border: `1px solid ${C.rule}`, fontWeight: 600 }} title={fileHandleRef.current || filePathRef.current ? t("覆盖保存到 {0}（Ctrl+S）", [filePathRef.current || fileName]) : t("保存平面图工程到文件（会弹系统对话框让你选位置；Ctrl+S）")} data-testid="file-save">
            {t("保存")}
          </button>
          {(bridgeOk || supportsFilePicker()) && (
            <button type="button" onClick={() => doSavePlan(true)} className="rounded px-3 py-1.5" style={{ border: `1px solid ${C.rule}` }} title={t("另存到别的位置 / 别的文件名")} data-testid="file-save-as">
              {t("另存为…")}
            </button>
          )}
          <button type="button" onClick={doOpenPlan} className="rounded px-3 py-1.5" style={{ border: `1px solid ${C.rule}` }} title={t("打开之前保存的平面图工程（.stairplan.json），会替换当前画布内容")} data-testid="file-open">
            {t("打开…")}
          </button>
          {fileName && <span style={{ color: C.muted, fontSize: 11.5 }} title={fileName}>{fileName}</span>}
        </span>
        {fileMsg && (
          <span style={{ color: fileMsg.error ? C.err : C.ok, fontSize: 12 }}>
            {fileMsg.text}
            <button type="button" onClick={() => setFileMsg(null)} className="ml-1" style={{ textDecoration: "underline" }}>
              {t("知道了")}
            </button>
          </span>
        )}
        {/* 示例文件的覆盖确认：保存 / Ctrl+S 打到受保护的示例时弹出，二次确认才真的覆盖 */}
        {overwriteConfirm && (
          <span className="flex flex-wrap items-center gap-2 rounded px-2 py-1" style={{ border: `1px solid ${C.warn}`, background: C.warnBg, fontSize: 12.5 }} data-testid="overwrite-confirm">
            <span>
              “{fileName}{t("” 是 Saved Plans 里的示例文件，确定要用当前画布覆盖它吗？")}
            </span>
            <button type="button" onClick={() => doSavePlan(false, true)} className="rounded px-3 py-1" style={{ background: C.err, color: C.onAccent, fontWeight: 600 }} data-testid="overwrite-yes">
              {t("确定覆盖示例")}
            </button>
            <button type="button" onClick={() => doSavePlan(true)} className="rounded px-3 py-1" style={{ background: C.accent, color: C.onAccent, fontWeight: 600 }} data-testid="overwrite-saveas">
              {t("另存为…")}
            </button>
            <button type="button" onClick={() => setOverwriteConfirm(false)} className="rounded px-3 py-1" style={{ border: `1px solid ${C.rule}` }} data-testid="overwrite-cancel">
              {t("取消")}
            </button>
          </span>
        )}
        {pdfBusy && <span style={{ color: C.muted }}>{t("正在解析 PDF…")}</span>}
        {pdfError && (
          <span style={{ color: C.err }}>
            {pdfError}
            <button type="button" onClick={() => setPdfError(null)} className="ml-1" style={{ textDecoration: "underline" }}>
              {t("知道了")}
            </button>
          </span>
        )}
        <button type="button" onClick={() => setPresetConfirm(true)} className="rounded px-3 py-1.5" style={{ border: `1px solid ${C.accent}`, color: C.accent, fontWeight: 600 }}>
          {t("载入示例：50×50m 环形走廊 + 核心筒")}
        </button>
        {plan.bgSrc && (
          <button type="button" onClick={clearBg} className="rounded px-3 py-1.5" style={{ border: `1px solid ${C.rule}` }}>
            {t("清除底图（改手动坐标）")}
          </button>
        )}
        {plan.bgSrc && (
          <button
            type="button"
            onClick={() => {
              setCalibPts([]);
              setPlan((p) => ({ ...p, mode: p.mode === "calibrate" ? "view" : "calibrate" }));
            }}
            className="rounded px-3 py-1.5"
            style={{ background: plan.mode === "calibrate" ? C.accent : C.panel, color: plan.mode === "calibrate" ? C.onAccent : C.ink, border: `1px solid ${C.rule}` }}
          >
            {t("标定比例")}
          </button>
        )}
        {/* 标定比例的输入放在按钮旁边（原来在右侧栏里，侧栏一收起就找不到了）：点够两个点才出现距离输入框 */}
        {plan.bgSrc && plan.mode === "calibrate" && (
          <span className="flex flex-wrap items-center gap-2 rounded px-2 py-1" style={{ border: `1px solid ${C.warn}`, background: C.warnBg, fontSize: 12.5 }} data-testid="calib-bar">
            {calibPts.length < 2 ? (
              <span>{t("在底图上点击第")} {calibPts.length + 1} {t("个点（选一段已知长度的线，比如一个尺寸标注的两端）")}</span>
            ) : (
              <>
                <span>{t("这两点在图上的实际距离：")}</span>
                <input
                  type="number"
                  value={calibMM}
                  onChange={(e) => setCalibMM(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") applyCalibration();
                  }}
                  autoFocus
                  className="rounded px-2 py-1"
                  style={{ width: 100, border: `1px solid ${C.rule}` }}
                  aria-label={t("两点实际距离（mm）")}
                />
                <span>mm</span>
                <button type="button" onClick={applyCalibration} className="rounded px-3 py-1" style={{ background: C.accent, color: C.onAccent, fontWeight: 600 }}>
                  {t("确定")}
                </button>
                <button type="button" onClick={() => setCalibPts([])} className="rounded px-2 py-1" style={{ border: `1px solid ${C.rule}` }}>
                  {t("重新选点")}
                </button>
              </>
            )}
          </span>
        )}
        {hasPdfPage && (
          <button type="button" onClick={runDimensionDetect} className="rounded px-3 py-1.5" style={{ border: `1px solid ${C.accent}`, color: C.accent, fontWeight: 600 }}>
            {t("按标注数字自动标定比例")}
          </button>
        )}
        {dimBusy && <span style={{ color: C.muted }}>{t("正在识别图纸上的标注数字（OCR，需要联网下载语言包，可能要几秒到几十秒）…")}</span>}
        {dimError && (
          <span style={{ color: C.err }}>
            {dimError}
            <button type="button" onClick={() => setDimError(null)} className="ml-1" style={{ textDecoration: "underline" }}>
              {t("知道了")}
            </button>
          </span>
        )}
        {dimensionCandidates.length > 0 && (
          <>
            <span style={{ color: C.accent, fontWeight: 600 }}>{t("识别到")} {dimensionCandidates.length} {t("个可能的尺寸标注（紫色标记，点选其一按它的比例标定）")}</span>
            <button type="button" onClick={clearDimensionCandidates} className="rounded px-3 py-1.5" style={{ border: `1px solid ${C.rule}` }}>
              {t("清除标注识别结果")}
            </button>
          </>
        )}
        {/* 识图菜单：四条识别路线收成一个下拉 + 一个识别按钮（用户要求"点开识图菜单，默认 Marker 识图，
            但给别的识图选项"）。默认本机 Marker；矢量解析/图像识别只对 PDF 可用，底图是图片时置灰；各路线
            自己的参数（阈值 / 线宽范围 / 房间过滤）点"参数"才展开，AI 的服务商/密钥/模型一直显示（没密钥没法用）。 */}
        {plan.bgSrc && (() => {
          const methods = [
            { key: "marker", label: t("本机 Marker 识图"), avail: true, walls: t("墙体 / 门 / 楼梯"), hint: t("本机 Python + OpenCV 服务（127.0.0.1:8765），不联网不用密钥；只识别横平竖直的墙，柱子不会被当成墙。需先双击 floorplan-marker/start_windows.bat 启动它。") },
            { key: "vector", label: t("矢量解析（矢量 CAD PDF）"), avail: hasPdfPage, walls: t("墙体"), hint: t("读 PDF 内容流里的矢量线段：粗线直接当墙，细线两两配对；扫描件没有矢量数据会识别到 0 段。") },
            { key: "raster", label: t("图像识别（扫描件 PDF）"), avail: hasPdfPage, walls: t("墙体"), hint: t("对渲染出的图做边缘检测再配对，适合扫描件；噪点较多，可用线宽范围过滤。") },
            { key: "ai", label: t("AI 识图（Claude / ChatGPT）"), avail: true, walls: t("墙体 / 门 / 楼梯"), hint: t("把整张图交给多模态模型读，需联网 + 自己的 API 密钥（只存本机浏览器，请求直连官方接口），一张图约几分到几毛钱。") },
          ];
          const method = methods.find((m) => m.key === detectMethod && m.avail) || methods[0];
          const busy = markerBusy || aiBusy || pdfBusy;
          const run = { marker: runMarkerDetect, vector: runVectorDetect, raster: runRasterDetect, ai: runAiDetect }[method.key];
          const err = method.key === "marker" ? markerError : method.key === "ai" ? aiError : null;
          const clearErr = method.key === "marker" ? () => setMarkerError(null) : () => setAiError(null);
          const inputStyle = { border: `1px solid ${C.rule}`, borderRadius: 4, padding: "3px 6px", fontSize: 12, background: C.panel, color: C.ink };
          const provider = AI_PROVIDERS.find((p) => p.key === aiSettings.provider) || AI_PROVIDERS[0];
          return (
            <span className="flex flex-wrap items-center gap-2" style={{ fontSize: 11.5, color: C.muted }} data-testid="detect-bar">
              <span style={{ fontWeight: 600, color: C.ink, fontSize: 12.5 }}>{t("识图：")}</span>
              <select value={method.key} onChange={(e) => setDetectMethod(e.target.value)} style={inputStyle} aria-label={t("识图方式")} title={method.hint}>
                {methods.map((m) => (
                  <option key={m.key} value={m.key} disabled={!m.avail}>
                    {m.label}
                    {m.key === "marker" ? t("（默认）") : ""}
                    {!m.avail ? t("（只支持 PDF）") : ""}
                  </option>
                ))}
              </select>
              <button type="button" onClick={run} disabled={busy} className="rounded px-3 py-1.5" style={{ background: busy ? C.rule : C.accent, color: busy ? C.muted : C.onAccent, fontWeight: 600, fontSize: 12.5 }} data-testid="detect-run">
                {busy ? t("识别中…") : t("识别{0}", [method.walls])}
              </button>
              {method.key === "marker" && (
                <span style={{ color: markerOnline === false ? C.err : markerOnline ? C.ok : C.muted }} title={method.hint} data-testid="marker-status">
                  {markerOnline === null ? t("● 检查服务…") : markerOnline ? t("● 服务在线") : bridgeOk ? t("● 服务未启动") : t("● 服务未启动：双击 floorplan-marker/start_windows.bat")}
                </span>
              )}
              {method.key === "marker" && markerOnline === false && bridgeOk && (
                <button type="button" onClick={startMarkerService} disabled={markerStarting} className="rounded px-3 py-1.5" style={{ border: `1px solid ${C.accent}`, color: markerStarting ? C.muted : C.accent, fontWeight: 600, fontSize: 12.5 }} title={t("让开发服务器把本机 Floorplan Marker 识图服务拉起来（等同双击 floorplan-marker/start_windows.bat）")} data-testid="marker-start">
                  {markerStarting ? t("启动中…（最多等 20 秒）") : t("启动服务")}
                </button>
              )}
              {method.key === "marker" && markerStartError && (
                <span style={{ color: C.err }}>
                  {markerStartError}
                  <button type="button" onClick={() => setMarkerStartError(null)} className="ml-1" style={{ textDecoration: "underline" }}>
                    {t("知道了")}
                  </button>
                </span>
              )}
              {(method.key === "vector" || method.key === "raster") && (
                <button type="button" onClick={() => setDetectSettingsOpen((v) => !v)} style={{ textDecoration: "underline" }}>
                  {detectSettingsOpen ? t("收起参数") : t("参数")}
                </button>
              )}
              {method.key === "marker" && (
                /* Marker 的阈值是它唯一也是最关键的参数，直接显示不藏在"参数"里；滑块 + 数字框都能改
                   （用户要求"有个窗口能调整"），范围 30~250 跟 Marker 服务端的校验一致 */
                <label className="flex items-center gap-1" title={t("二值化阈值：灰度 ≤ 这个值的像素算墨迹。pdf.js 渲染的细线是抗锯齿的，230 左右才能把门弧、踏步都保住；图太脏（阴影、底色）时调低。改完再点一次识别。")}>
                  {t("黑白阈值")}
                  <input type="range" min={30} max={250} value={markerThreshold} onChange={(e) => setMarkerThreshold(Number(e.target.value))} style={{ width: 90 }} aria-label={t("Marker 黑白阈值")} />
                  <input
                    key={markerThreshold} // 滑块改了就按新值重挂一次，让框里的数字跟滑块同步
                    type="number"
                    min={30}
                    max={250}
                    step={1}
                    defaultValue={markerThreshold}
                    onBlur={(e) => {
                      // 失焦/回车才提交（编辑中可以清空重输），非法或空值回到当前值
                      const v = Number(e.target.value);
                      if (e.target.value !== "" && Number.isFinite(v)) setMarkerThreshold(clamp(Math.round(v), 30, 250));
                      else e.target.value = String(markerThreshold);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                    }}
                    className="rounded px-1 py-0.5 text-right"
                    style={{ width: 56, border: `1px solid ${C.rule}`, background: C.panel, color: C.ink, fontSize: 12 }}
                    aria-label={t("Marker 黑白阈值数值")}
                  />
                </label>
              )}
              {detectSettingsOpen && (method.key === "vector" || method.key === "raster") && (
                <span className="flex items-center gap-1">
                  {t("只识别线宽在")}
                  <input type="range" min={0} max={WALL_WIDTH_SLIDER_MAX} value={wallWidthMin} onChange={(e) => setWallWidthMin(Math.min(Number(e.target.value), wallWidthMax))} style={{ width: 80 }} aria-label={t("线宽下限")} />
                  <b style={{ color: C.ink }}>{wallWidthMin}</b>
                  ~
                  <input type="range" min={0} max={WALL_WIDTH_SLIDER_MAX} value={wallWidthMax} onChange={(e) => setWallWidthMax(Math.max(Number(e.target.value), wallWidthMin))} style={{ width: 80 }} aria-label={t("线宽上限")} />
                  <b style={{ color: C.ink }}>{wallWidthMax >= WALL_WIDTH_SLIDER_MAX ? t("不限") : wallWidthMax}</b>
                  {t("像素之间的线条（原始像素；改完再点一次识别）")}
                </span>
              )}
              {detectSettingsOpen && method.key === "raster" && (
                <label className="flex items-center gap-1" style={{ cursor: "pointer" }} title={t("只保留真的把两块空间分隔开的墙。注意：墙上有门洞时相邻房间会连成一块，中间的隔墙会被误删——默认关闭")}>
                  <input type="checkbox" checked={roomFilterOn} onChange={(e) => setRoomFilterOn(e.target.checked)} />
                  {t("按房间分隔关系过滤噪点（实验性）")}
                </label>
              )}
              {method.key === "ai" && (
                <>
                  <select value={aiSettings.provider} onChange={(e) => updateAiSettings({ provider: e.target.value })} style={inputStyle} aria-label={t("AI 服务商")}>
                    {AI_PROVIDERS.map((p) => (
                      <option key={p.key} value={p.key}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                  <input
                    type={aiShowKey ? "text" : "password"}
                    value={aiSettings.keys[provider.key] || ""}
                    onChange={(e) => updateAiSettings((prev) => ({ ...prev, keys: { ...prev.keys, [provider.key]: e.target.value } }))}
                    placeholder={t("{0} API 密钥 {1}", [provider.label, provider.keyPlaceholder])}
                    autoComplete="off"
                    spellCheck={false}
                    style={{ ...inputStyle, width: 200, fontFamily: "monospace" }}
                    aria-label={t("API 密钥")}
                  />
                  <button type="button" onClick={() => setAiShowKey((v) => !v)} style={{ textDecoration: "underline" }}>
                    {aiShowKey ? t("隐藏") : t("显示")}
                  </button>
                  <input
                    type="text"
                    value={aiSettings.models[provider.key] || ""}
                    onChange={(e) => updateAiSettings((prev) => ({ ...prev, models: { ...prev.models, [provider.key]: e.target.value } }))}
                    placeholder={t("模型（默认 {0}）", [provider.defaultModel])}
                    spellCheck={false}
                    style={{ ...inputStyle, width: 160, fontFamily: "monospace" }}
                    aria-label={t("模型名")}
                  />
                  <span title={t("密钥只存在这台电脑的浏览器 localStorage 里，不会写进源码或打包文件；请求由浏览器直接发给 Anthropic / OpenAI 官方接口，不经过任何第三方服务器。")}>{t("密钥只存本机 ⓘ")}</span>
                  {aiBusy && <span>{t("正在上传图片并等模型读图（通常 10~60 秒）…")}</span>}
                </>
              )}
              {err && (
                <span style={{ color: C.err }}>
                  {err}
                  <button type="button" onClick={clearErr} className="ml-1" style={{ textDecoration: "underline" }}>
                    {t("知道了")}
                  </button>
                </span>
              )}
            </span>
          );
        })()}
        {wallDetectMsg && <span style={{ color: C.accent, fontWeight: 600 }}>{wallDetectMsg}</span>}
        {(plan.doorCandidates || []).length + (plan.stairCandidates || []).length > 0 && (
          <span className="flex flex-wrap items-center gap-2" style={{ fontSize: 11.5, color: C.muted }}>
            {t("识别出的门（绿色）/ 楼梯（橙色框）")}
            <button
              type="button"
              onClick={acceptAllCandidates}
              className="rounded px-3 py-1.5"
              style={{ background: C.ok, color: C.onAccent, fontWeight: 600, fontSize: 12.5 }}
              title={t("墙候选→正式墙；楼梯框→核心筒（贴在框边上的门当它的门）；其余门→挂到最近的墙上，附近没墙的跳过")}
              data-testid="accept-all-candidates"
            >
              {t("一键添加全部（墙 + 门 + 楼梯）")}
            </button>
            {plan.bgSrc && plan.mmPerPx === 1 && <span style={{ color: C.warn }}>{t("还没标定比例——核心筒的尺寸之后不会随标定缩放，建议先“标定比例”再添加")}</span>}
            {!(plan.wallCandidates || []).length && (
              <button type="button" onClick={clearWallCandidates} className="rounded px-3 py-1.5" style={{ border: `1px solid ${C.rule}`, color: C.ink }}>
                {t("清除门/楼梯标记")}
              </button>
            )}
          </span>
        )}
        {(plan.wallCandidates || []).length > 0 && (
          <>
            <span style={{ color: C.accent, fontWeight: 600 }}>{t("识别到")} {plan.wallCandidates.length} {t("段可能的墙（蓝色虚线，点选中后双击接受，或按 Delete/Backspace 单独丢弃）")}</span>
            {selectedWallCandidateId != null && (
              <button type="button" onClick={() => acceptWallCandidate(selectedWallCandidateId)} className="rounded px-3 py-1.5" style={{ background: C.accent, color: C.onAccent, fontWeight: 600 }}>
                {t("接受选中的这一段")}
              </button>
            )}
            <button type="button" onClick={acceptAllWallCandidates} className="rounded px-3 py-1.5" style={{ background: C.ok, color: C.onAccent, fontWeight: 600 }}>
              {t("全部接受为墙体")}
            </button>
            <button type="button" onClick={clearWallCandidates} className="rounded px-3 py-1.5" style={{ border: `1px solid ${C.rule}` }}>
              {t("清除识别结果")}
            </button>
          </>
        )}
        <button
          type="button"
          onClick={() => setPlan((p) => ({ ...p, mode: p.mode === "boundary" ? "view" : "boundary" }))}
          className="rounded px-3 py-1.5"
          style={{ background: plan.mode === "boundary" ? C.accent : C.panel, color: plan.mode === "boundary" ? C.onAccent : C.ink, border: `1px solid ${C.rule}` }}
        >
          {t("绘制楼层边界")}
        </button>
        {plan.mode === "boundary" && (
          <>
            <button type="button" onClick={undoBoundary} className="rounded px-2 py-1" style={{ border: `1px solid ${C.rule}` }}>
              {t("撤销上一点")}
            </button>
            <button type="button" onClick={clearBoundary} className="rounded px-2 py-1" style={{ border: `1px solid ${C.rule}` }}>
              {t("清空边界")}
            </button>
          </>
        )}
        <span style={{ color: C.muted }}>|</span>
        <select value={addShaftKey} onChange={(e) => setAddShaftKey(e.target.value)} className="rounded px-2 py-1" style={{ border: `1px solid ${C.rule}`, background: C.panel }}>
          {shaftOptions.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
        <button type="button" onClick={addCore} className="rounded px-3 py-1.5" style={{ background: C.ok, color: C.onAccent, fontWeight: 600 }}>
          {t("添加核心筒到平面图")}
        </button>
        <span style={{ color: C.muted }}>|</span>
        {plan.mode === "wall" ? (
          <>
            <button type="button" onClick={undoWallPoint} className="rounded px-2 py-1" style={{ border: `1px solid ${C.rule}` }}>
              {t("撤销上一点")}
            </button>
            <button type="button" onClick={finishWall} className="rounded px-3 py-1.5" style={{ background: C.accent, color: C.onAccent }}>
              {t("完成墙体")}
            </button>
            <button type="button" onClick={cancelWall} className="rounded px-2 py-1" style={{ border: `1px solid ${C.rule}` }}>
              {t("取消")}
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => {
              setWallPts([]);
              setPlan((p) => ({ ...p, mode: "wall" }));
            }}
            className="rounded px-3 py-1.5"
            style={{ border: `1px solid ${C.rule}` }}
          >
            {t("绘制走廊墙体")}
          </button>
        )}
        <button
          type="button"
          onClick={() => setPlan((p) => ({ ...p, mode: p.mode === "door" ? "view" : "door" }))}
          className="rounded px-3 py-1.5"
          style={{ background: plan.mode === "door" ? C.accent : C.panel, color: plan.mode === "door" ? C.onAccent : C.ink, border: `1px solid ${C.rule}` }}
          disabled={plan.walls.length === 0}
        >
          {t("添加门")}
        </button>
        <span style={{ color: C.muted }}>|</span>
        {plan.mode === "path" ? (
          <>
            <button type="button" onClick={undoPathPoint} className="rounded px-2 py-1" style={{ border: `1px solid ${C.rule}` }}>
              {t("撤销上一点")}
            </button>
            <button type="button" onClick={finishPath} className="rounded px-3 py-1.5" style={{ background: C.accent, color: C.onAccent }}>
              {t("完成路径")}
            </button>
          </>
        ) : (
          <>
            {/* "手动折线测距"按钮按用户要求去掉了（自动最短路径 + 热力图够用）；newPath 等手动折线的代码保留，没有入口 */}
            <button
              type="button"
              onClick={() => setPlan((p) => ({ ...p, mode: p.mode === "autopath" ? "view" : "autopath" }))}
              className="rounded px-3 py-1.5"
              style={{ background: plan.mode === "autopath" ? C.accent : C.panel, color: plan.mode === "autopath" ? C.onAccent : C.ink, border: `1px solid ${C.rule}` }}
              disabled={plan.cores.length === 0}
            >
              {t("自动最短路径（避开墙体）")}
            </button>
            <button
              type="button"
              onClick={() => setHeatmapOn((v) => !v)}
              className="rounded px-3 py-1.5"
              style={{ background: heatmapOn ? C.accent : C.panel, color: heatmapOn ? C.onAccent : C.ink, border: `1px solid ${C.rule}` }}
              disabled={plan.cores.length === 0}
              title={t("整层按格子算每格到最近核心筒门的最短路径（避墙、穿门），达标绿、超标红；限值在右侧“疏散路径 / 距离校核”面板里设")}
            >
              {t("行走距离热力图")}
            </button>
          </>
        )}
      </div>
      {presetConfirm && (
        <div className="flex flex-wrap items-center gap-2 mb-3 rounded p-3" style={{ border: `1px solid ${C.warn}`, background: C.warnBg, fontSize: 12.5 }}>
          <span>{t("载入示例平面会清空当前的边界、核心筒、墙体、门与路径，确定继续吗？")}</span>
          <button type="button" onClick={applyPreset} className="rounded px-3 py-1" style={{ background: C.accent, color: C.onAccent, fontWeight: 600 }}>
            {t("确定载入")}
          </button>
          <button type="button" onClick={() => setPresetConfirm(false)} className="rounded px-3 py-1" style={{ border: `1px solid ${C.rule}` }}>
            {t("取消")}
          </button>
        </div>
      )}
      <div style={{ fontSize: 12, color: C.accent, marginBottom: 6 }}>{modeLabel}</div>

      {/* 侧栏收起时右列只剩一条 36px 的竖条（放"展开"按钮），画布那列占满剩下的全部宽度 */}
      <div className="grid gap-4" style={{ gridTemplateColumns: sidebarOpen ? "minmax(320px, 2fr) minmax(260px, 1fr)" : "minmax(0, 1fr) 36px" }} data-testid="plan-grid">
        <div className="flex flex-col gap-2" style={{ minWidth: 0 }}>
          <div className="flex items-center gap-2" style={{ fontSize: 12 }}>
            <button type="button" onClick={() => setZoomKeepCenter(zoom / 1.3)} className="rounded px-2 py-0.5" style={{ border: `1px solid ${C.rule}`, fontWeight: 700 }}>
              −
            </button>
            <span style={{ color: C.muted, minWidth: 42, textAlign: "center" }}>{Math.round(zoom * 100)}%</span>
            <button type="button" onClick={() => setZoomKeepCenter(zoom * 1.3)} className="rounded px-2 py-0.5" style={{ border: `1px solid ${C.rule}`, fontWeight: 700 }}>
              {t("＋")}
            </button>
            <button
              type="button"
              onClick={() => {
                setZoom(1);
                setPanMM({ x: 0, y: 0 });
              }}
              className="rounded px-2 py-0.5"
              style={{ border: `1px solid ${C.rule}` }}
            >
              {t("适应窗口")}
            </button>
            <button
              type="button"
              onClick={() => setPanMode((v) => !v)}
              className="rounded px-2 py-0.5"
              style={{ background: panMode ? C.accent : C.panel, color: panMode ? C.onAccent : C.ink, border: `1px solid ${C.rule}` }}
            >
              {t("✋ 平移")}
            </button>
            <button
              type="button"
              onClick={() => setGridSnap((v) => !v)}
              title={t("开启后，拖动核心筒 / 墙 / 门 / 边界顶点都会吸附到 10 cm 网格上")}
              className="rounded px-2 py-0.5"
              style={{ background: gridSnap ? C.accent : C.panel, color: gridSnap ? C.onAccent : C.ink, border: `1px solid ${C.rule}` }}
            >
              {t("▦ 网格吸附")}
            </button>
            <button
              type="button"
              onClick={undoPlan}
              disabled={!canUndoPlan}
              title={t("撤销 (Ctrl+Z)")}
              className="rounded px-2 py-0.5"
              style={{ border: `1px solid ${C.rule}`, opacity: canUndoPlan ? 1 : 0.4, cursor: canUndoPlan ? "pointer" : "default" }}
            >
              {t("↶ 撤销")}
            </button>
            <button
              type="button"
              onClick={redoPlan}
              disabled={!canRedoPlan}
              title={t("重做 (Ctrl+Y / Ctrl+Shift+Z)")}
              className="rounded px-2 py-0.5"
              style={{ border: `1px solid ${C.rule}`, opacity: canRedoPlan ? 1 : 0.4, cursor: canRedoPlan ? "pointer" : "default" }}
            >
              {t("↷ 重做")}
            </button>
            <span style={{ color: C.muted }}>{t("滚轮缩放 · 空白处直接拖动平移；放大后核心筒等图形挡住空白处时，点\"平移\"再拖动 · Ctrl+Z 撤销 / Ctrl+Y 重做 · \"网格吸附\"开启后拖动一律落在 10 cm 网格上")}</span>
          </div>
          <div className="rounded" style={{ border: `1px solid ${C.rule}`, background: C.canvasBg }}>
          <svg
            ref={svgRef}
            viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
            style={{
              display: "block",
              width: "100%",
              height: "auto",
              aspectRatio: "16 / 9",
              background: plan.bgSrc ? "#fff" : C.canvas,
              touchAction: "none",
              cursor: panMode ? (dragState.current && dragState.current.moved ? "grabbing" : "grab") : dragState.current && dragState.current.moved ? "grabbing" : "default",
            }}
            onPointerDown={onCanvasPointerDown}
            onPointerMove={onCanvasPointerMove}
            onPointerUp={onCanvasPointerUp}
            onPointerCancel={onCanvasPointerUp}
          >
            {plan.bgSrc && <image href={plan.bgSrc} x={0} y={0} width={mmW} height={mmH} preserveAspectRatio="none" />}
            {/* 行走距离热力图：压在底图上、墙体/核心筒下面的半透明色块，达标绿、超标红、走不到门的灰。
                不接收鼠标事件，不挡住画布上的其它操作；每格带 <title>，鼠标悬停能看到这一格的距离。 */}
            {heatmap && (
              <g style={{ pointerEvents: "none" }} data-testid="travel-heatmap">
                {heatmap.cells.map((c) => {
                  const unreachable = !Number.isFinite(c.dist);
                  const fill = unreachable ? "#6B7280" : c.dist <= heatmapLimit ? C.ok : C.err;
                  return (
                    <rect key={c.key} x={c.x} y={c.y} width={c.w} height={c.h} fill={fill} fillOpacity={unreachable ? 0.45 : 0.32} stroke={C.panel} strokeOpacity={0.35} strokeWidth={Math.max(4, mmW / 2500)} style={{ pointerEvents: "auto" }}>
                      <title>{unreachable ? t("走不到任何核心筒的门（被墙围死或漏开门）") : t("到最近核心筒门 {0} m / 限值 {1} m {2}", [(c.dist / 1000).toFixed(1), (heatmapLimit / 1000).toFixed(0), c.dist <= heatmapLimit ? "✓" : "✗"])}</title>
                    </rect>
                  );
                })}
              </g>
            )}
            {!plan.bgSrc &&
              Array.from({ length: Math.ceil(mmW / 1000) + 1 }, (_, i) => <line key={"gx" + i} x1={i * 1000} y1={0} x2={i * 1000} y2={mmH} stroke={C.rule} strokeWidth={mmW / 2000} />)}
            {!plan.bgSrc &&
              Array.from({ length: Math.ceil(mmH / 1000) + 1 }, (_, i) => <line key={"gy" + i} x1={0} y1={i * 1000} x2={mmW} y2={i * 1000} stroke={C.rule} strokeWidth={mmW / 2000} />)}
            {plan.boundary.length > 0 && (
              <polygon points={plan.boundary.map((p) => `${p.x},${p.y}`).join(" ")} fill={C.accent + "10"} stroke={C.accent} strokeDasharray={`${mmW / 100} ${mmW / 200}`} strokeWidth={Math.max(15, mmW / 1200)} />
            )}
            {plan.boundary.map((p, i) => (
              <BoundaryPointHandle
                key={i}
                boundary={plan.boundary}
                index={i}
                mmW={mmW}
                vb={vb}
                svgRef={svgRef}
                walls={plan.walls}
                cores={plan.cores}
                panMode={panMode}
                gridSnap={gridSnap}
                onMove={updateBoundaryPoint}
                onAlignChange={setAlignGuide}
              />
            ))}
            {/* PDF 矢量识别出的墙体候选：蓝色虚线，只是"建议"。单击选中（红框高亮，选中后按 Delete/
                Backspace 单独丢弃这一段，或点下面的"接受选中"按钮转正）；双击直接接受，等价于点一下
                "接受选中"，图快的话不用先选中再点按钮。（见 acceptWallCandidate/rejectWallCandidate）；
                坐标系跟底图 <image> 一样，标定比例前 1 像素当 1 mm 画，标定后 rescalePositions 会把
                wallCandidates 一起换算，所以这里不用另外处理比例。 */}
            {(plan.wallCandidates || []).map((c) => (
              <g key={"wc" + c.id}>
                {selectedWallCandidateId === c.id && (
                  <line x1={c.x1} y1={c.y1} x2={c.x2} y2={c.y2} stroke={C.err} strokeWidth={Math.max(60, mmW / 130)} style={{ pointerEvents: "none" }} />
                )}
                <line
                  x1={c.x1}
                  y1={c.y1}
                  x2={c.x2}
                  y2={c.y2}
                  stroke="#2F6FED"
                  strokeWidth={Math.max(30, mmW / 250)}
                  strokeDasharray={`${mmW / 120} ${mmW / 240}`}
                  style={{ cursor: "pointer" }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedWallCandidateId(c.id);
                    setSelectedCoreId(null);
                    setSelectedWallId(null);
                    setSelectedDoorId(null);
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    acceptWallCandidate(c.id);
                  }}
                />
              </g>
            ))}
            {/* AI 识图给出的门（绿色短线）和楼梯（橙色虚线框）：只作参考显示、不可交互（pointerEvents none，
                不挡住下面的墙体候选和底图点击），跟 wallCandidates 一样在 rescalePositions 里跟着标定换算。 */}
            {(plan.doorCandidates || []).map((d) => (
              <line key={"dc" + d.id} x1={d.x1} y1={d.y1} x2={d.x2} y2={d.y2} stroke="#16A34A" strokeWidth={Math.max(40, mmW / 200)} strokeLinecap="round" style={{ pointerEvents: "none" }} />
            ))}
            {(plan.stairCandidates || []).map((s) => (
              <rect key={"sc" + s.id} x={s.x1} y={s.y1} width={Math.max(1, s.x2 - s.x1)} height={Math.max(1, s.y2 - s.y1)} fill="#F97316" fillOpacity={0.12} stroke="#F97316" strokeWidth={Math.max(20, mmW / 400)} strokeDasharray={`${mmW / 200} ${mmW / 400}`} style={{ pointerEvents: "none" }} />
            ))}
            {/* 自动标定比例的候选：紫色标出识别到的尺寸线+旁边写着识别出来的文字，点一下就用它的比例
                标定（见 applyDimensionCandidate）。不进 plan（dimensionCandidates 是组件内 state），
                坐标系跟底图一样，未标定时 1 像素当 1 mm 画。 */}
            {dimensionCandidates.map((c) => (
              <g key={"dim" + c.id} style={{ cursor: "pointer" }} onClick={(e) => { e.stopPropagation(); applyDimensionCandidate(c); }}>
                <line x1={c.segX1} y1={c.segY1} x2={c.segX2} y2={c.segY2} stroke="#8B5CF6" strokeWidth={Math.max(20, mmW / 400)} strokeDasharray={`${mmW / 200} ${mmW / 400}`} />
                <circle cx={c.x} cy={c.y} r={Math.max(60, mmW / 180)} fill="#8B5CF6" fillOpacity={0.25} stroke="#8B5CF6" strokeWidth={Math.max(6, mmW / 1800)} />
                <text x={c.x} y={c.y} fontSize={Math.max(90, mmW / 120)} fill="#6D28D9" textAnchor="middle" dominantBaseline="middle" style={{ paintOrder: "stroke", stroke: C.panel, strokeWidth: mmW / 700 }}>
                  {c.text}
                </text>
              </g>
            ))}
            {plan.walls.map((w) => (
              <g key={w.id}>
                {selectedWallId === w.id && <path d={wallHaloPath(w, Math.max(60, w.t * 0.35))} fill="none" stroke={C.err} strokeWidth={Math.max(8, w.t * 0.25)} />}
                <WallBody
                  wall={w}
                  mmW={mmW}
                  vb={vb}
                  svgRef={svgRef}
                  drawMode={plan.mode}
                  panMode={panMode}
                  gridSnap={gridSnap}
                  onMove={updateWall}
                  onSelect={(id) => {
                    setSelectedWallId(id);
                    setSelectedCoreId(null);
                    setSelectedDoorId(null);
                    setSelectedWallCandidateId(null);
                  }}
                />
              </g>
            ))}
            {plan.doors.map((d) => {
              const wall = plan.walls.find((w) => w.id === d.wallId);
              if (!wall) return null;
              const len = wallLength(wall);
              const ux = (wall.x2 - wall.x1) / len, uy = (wall.y2 - wall.y1) / len;
              const a = clamp(d.at - d.width / 2, 0, len), b = clamp(d.at + d.width / 2, 0, len);
              return (
                <line
                  key={"gap" + d.id}
                  x1={wall.x1 + ux * a}
                  y1={wall.y1 + uy * a}
                  x2={wall.x1 + ux * b}
                  y2={wall.y1 + uy * b}
                  stroke={plan.bgSrc ? "#fff" : C.canvas}
                  strokeWidth={wall.t + 30}
                />
              );
            })}
            {plan.doors.map((d) => {
              const wall = plan.walls.find((w) => w.id === d.wallId);
              if (!wall) return null;
              const len = wallLength(wall);
              const ux = (wall.x2 - wall.x1) / len, uy = (wall.y2 - wall.y1) / len;
              const hingeSign = d.hinge || 1, swingSign = d.swing || 1;
              const hingeAt = hingeSign === 1 ? d.at - d.width / 2 : d.at + d.width / 2;
              const hinge = { x: wall.x1 + ux * hingeAt, y: wall.y1 + uy * hingeAt };
              const closedDir = { x: ux * hingeSign, y: uy * hingeSign };
              const swingDir = { x: -uy * swingSign, y: ux * swingSign };
              const leafT = Math.max(24, wall.t * 0.4);
              const geo = doorSymbolGeometry(hinge, closedDir, swingDir, d.width, leafT);
              return (
                <g key={"sym" + d.id} style={{ pointerEvents: "none" }}>
                  <path d={geo.arcD} fill="none" stroke={C.ink} strokeWidth={Math.max(4, mmW / 2600)} />
                  <path d={geo.leafD} fill={C.panel} stroke={C.ink} strokeWidth={Math.max(6, mmW / 1800)} />
                </g>
              );
            })}
            {wallPts.length > 0 && (
              <g>
                <polyline
                  points={wallPts.map((p) => `${p.x},${p.y}`).join(" ")}
                  fill="none"
                  stroke={C.warn}
                  strokeWidth={Math.max(60, mmW / 300)}
                  strokeDasharray={`${mmW / 150} ${mmW / 300}`}
                />
                {wallPts.map((p, i) => (
                  <circle key={i} cx={p.x} cy={p.y} r={Math.max(50, mmW / 350)} fill={C.warn} />
                ))}
              </g>
            )}
            {plan.paths
              .filter((p) => p.kind !== "auto")
              .map((p) => {
                const limit = travelLimit(p.travelGroup, p.sprinklered);
                const ok = polylineLength(p.pts) <= limit;
                return (
                  <polyline
                    key={p.id}
                    points={p.pts.map((q) => `${q.x},${q.y}`).join(" ")}
                    fill="none"
                    stroke={p.id === plan.drawingPathId ? C.warn : ok ? C.ok : C.err}
                    strokeWidth={Math.max(20, mmW / 700)}
                    strokeDasharray={p.id === plan.drawingPathId ? `${mmW / 150} ${mmW / 300}` : undefined}
                  />
                );
              })}
            {plan.paths
              .filter((p) => p.kind === "auto")
              .map((p) => {
                const r = autoResults[p.id];
                if (!r) return null;
                const limit = travelLimit(p.travelGroup, p.sprinklered);
                const ok = r.length <= limit;
                return (
                  <g key={p.id}>
                    <polyline points={r.pts.map((q) => `${q.x},${q.y}`).join(" ")} fill="none" stroke={ok ? C.ok : C.err} strokeWidth={Math.max(20, mmW / 700)} strokeDasharray={`${mmW / 400} ${mmW / 1000}`} />
                    <circle cx={p.src.x} cy={p.src.y} r={Math.max(50, mmW / 350)} fill={ok ? C.ok : C.err} />
                  </g>
                );
              })}
            {calibPts.length > 0 && (
              <g>
                {calibPts.length === 2 && <line x1={calibPts[0].x} y1={calibPts[0].y} x2={calibPts[1].x} y2={calibPts[1].y} stroke={C.err} strokeWidth={Math.max(20, mmW / 700)} />}
                {/* 标定点只比连线稍粗一点（半径 = 线宽 × 0.75），太大的圆点会盖住要对准的墙角/标注线，看不清点在哪 */}
                {calibPts.map((p, i) => (
                  <circle key={i} cx={p.x} cy={p.y} r={Math.max(20, mmW / 700) * 0.75} fill={C.err} />
                ))}
              </g>
            )}
            {plan.cores.map((c) => {
              const shaft = resolveShaft(res, c.shaftKey);
              const undersized = !!shaft && (c.w < shaft.innerW + 2 * inp.wall || c.l < shaft.innerL + 2 * inp.wall);
              return (
                <CoreShape
                  key={c.id}
                  core={c}
                  mmW={mmW}
                  wallT={inp.wall}
                  vb={vb}
                  svgRef={svgRef}
                  selected={selectedCoreId === c.id}
                  undersized={undersized}
                  tooClose={tooCloseCoreIds.has(c.id)}
                  panMode={panMode}
                  gridSnap={gridSnap}
                  onMove={updateCore}
                  onSelect={(id) => {
                    setSelectedCoreId(id);
                    setSelectedWallId(null);
                    setSelectedDoorId(null);
                    setSelectedWallCandidateId(null);
                  }}
                />
              );
            })}
            {plan.cores.map((c) => {
              const shaft = resolveShaft(res, c.shaftKey);
              const level = shaft ? shaft.stairs[0].storeyLevels[0] : null;
              const t = clamp(inp.wall, 1, Math.min(c.w, c.l) / 2 - 1);
              let geometry = null;
              try {
                geometry = shaft && level != null ? shaftPlanLocalGeometry(res, inp, shaft, level, c.w - 2 * t, c.l - 2 * t) : null;
              } catch (err) {
                geometry = null;
              }
              return <CoreStairPreview key={"prev" + c.id} core={c} wallT={inp.wall} geometry={geometry} />;
            })}
            {plan.cores.map((c) => (
              <g key={"edge" + c.id}>
                {["left", "right", "top", "bottom"].map((edge) => (
                  <CoreEdgeHandle key={edge} core={c} edge={edge} wallT={inp.wall} vb={vb} svgRef={svgRef} panMode={panMode} gridSnap={gridSnap} onMove={updateCore} />
                ))}
              </g>
            ))}
            {plan.cores.map((c) => {
              const doorW = c.doorWidth || DOOR_DEFAULT_WIDTH;
              const edge = coreDoorEdgeInfo(c);
              const a = clamp(edge.at - doorW / 2, 0, edge.len), b = clamp(edge.at + doorW / 2, 0, edge.len);
              const g1 = coreLocalToWorld(c, edge.lx0 + edge.dir.x * a, edge.ly0 + edge.dir.y * a);
              const g2 = coreLocalToWorld(c, edge.lx0 + edge.dir.x * b, edge.ly0 + edge.dir.y * b);
              const info = coreDoorSymbolInfo(c, doorW);
              const geo = doorSymbolGeometry(info.hinge, info.closedDir, info.swingDir, doorW, Math.max(24, inp.wall * 0.4));
              return (
                <g key={"csym" + c.id} style={{ pointerEvents: "none" }}>
                  <line x1={g1.x} y1={g1.y} x2={g2.x} y2={g2.y} stroke={plan.bgSrc ? "#fff" : C.canvas} strokeWidth={inp.wall + 30} />
                  <path d={geo.arcD} fill="none" stroke={C.ink} strokeWidth={Math.max(4, mmW / 2600)} />
                  <path d={geo.leafD} fill={C.panel} stroke={C.ink} strokeWidth={Math.max(6, mmW / 1800)} />
                </g>
              );
            })}
            {plan.cores.map((c) => (
              <DoorMarker key={"d" + c.id} core={c} mmW={mmW} vb={vb} svgRef={svgRef} walls={plan.walls} cores={plan.cores} panMode={panMode} gridSnap={gridSnap} onMove={updateCore} onAlignChange={setAlignGuide} />
            ))}
            {alignGuide && (
              <g style={{ pointerEvents: "none" }}>
                {alignGuide.x != null && (
                  <line x1={alignGuide.x} y1={vb.y} x2={alignGuide.x} y2={vb.y + vb.h} stroke={C.warn} strokeWidth={Math.max(4, mmW / 2500)} strokeDasharray={`${mmW / 180} ${mmW / 260}`} />
                )}
                {alignGuide.y != null && (
                  <line x1={vb.x} y1={alignGuide.y} x2={vb.x + vb.w} y2={alignGuide.y} stroke={C.warn} strokeWidth={Math.max(4, mmW / 2500)} strokeDasharray={`${mmW / 180} ${mmW / 260}`} />
                )}
              </g>
            )}
            {plan.walls.map((w) => {
              if (selectedWallId !== w.id) return null; // 只有选中的那面墙才显示端点，没选中的墙不显示，画面不会一堆白点
              return (
                <g key={"wh" + w.id}>
                  <WallEndHandle wall={w} end={1} mmW={mmW} vb={vb} svgRef={svgRef} walls={plan.walls} cores={plan.cores} panMode={panMode} gridSnap={gridSnap} onMove={updateWall} onAlignChange={setAlignGuide} />
                  <WallEndHandle wall={w} end={2} mmW={mmW} vb={vb} svgRef={svgRef} walls={plan.walls} cores={plan.cores} panMode={panMode} gridSnap={gridSnap} onMove={updateWall} onAlignChange={setAlignGuide} />
                </g>
              );
            })}
            {plan.doors.map((d) => {
              const wall = plan.walls.find((w) => w.id === d.wallId);
              if (!wall) return null;
              return (
                <g key={"dh" + d.id}>
                  {selectedDoorId === d.id && (
                    <path d={doorHaloPath(wall, d, Math.max(60, wall.t * 0.35))} fill="none" stroke={C.err} strokeWidth={Math.max(8, wall.t * 0.25)} />
                  )}
                  <DoorHandle
                    wall={wall}
                    door={d}
                    mmW={mmW}
                    vb={vb}
                    svgRef={svgRef}
                    panMode={panMode}
                    gridSnap={gridSnap}
                    onMove={updateDoor}
                    onSelect={(id) => {
                      setSelectedDoorId(id);
                      setSelectedWallId(null);
                      setSelectedCoreId(null);
                      setSelectedWallCandidateId(null);
                    }}
                  />
                </g>
              );
            })}
          </svg>
          </div>
        </div>

        {!sidebarOpen ? (
          /* 收起态：一条竖条，竖排文字 + 数量，点一下展开 */
          <div className="flex flex-col items-stretch" style={{ minWidth: 0 }} data-testid="sidebar-collapsed">
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              title={t("展开右侧面板（核心筒 / 走廊墙体 / 门 / 疏散路径）")}
              className="rounded"
              style={{ writingMode: "vertical-rl", padding: "12px 6px", border: `1px solid ${C.rule}`, background: C.panel, color: C.ink, fontSize: 12, fontWeight: 600, letterSpacing: 2, cursor: "pointer", alignSelf: "stretch", minHeight: 220 }}
              data-testid="sidebar-expand"
            >
              {t("◀ 展开面板 · 核心筒")} {plan.cores.length} {t("· 墙")} {plan.walls.length} {t("· 门")} {plan.doors.length} {t("· 路径")} {plan.paths.length}
            </button>
          </div>
        ) : (
        <div className="flex flex-col gap-3" style={{ minWidth: 0 }} data-testid="sidebar">
          <button
            type="button"
            onClick={() => setSidebarOpen(false)}
            title={t("把右侧四个面板一起收到右边，让平面图占满整行")}
            className="rounded px-3 py-1 self-end"
            style={{ border: `1px solid ${C.rule}`, background: C.panel, color: C.ink, fontSize: 12 }}
            data-testid="sidebar-collapse"
          >
            {t("收起面板 ▶")}
          </button>
          {/* example 面板：项目根目录 "Saved Plans" 里的工程文件，点一下直接打开。只在有开发服务器桥时显示（dist-single 静态版没有）。 */}
          {(bridgeOk || examples.files.length > 0) && (
            <details className="rounded p-3" style={{ border: `1px solid ${C.rule}` }} open={panelOpen.examples} onToggle={(e) => setPanelOpen("examples", e.currentTarget.open)} data-testid="panel-examples">
              <summary style={{ fontWeight: 600, fontSize: 13, cursor: "pointer", listStyle: "none", userSelect: "none" }}>
                {panelOpen.examples ? "▾" : "▸"} {t("example（示例平面")} {examples.files.length}{t("）")}
              </summary>
              <div className="flex items-center justify-between gap-2" style={{ fontSize: 11, color: C.muted, marginTop: 2, marginBottom: 6 }}>
                <span title={examples.dir || ""}>{t("来自项目根目录的 \"Saved Plans\" 文件夹，点一下直接打开（会替换当前画布，可 Ctrl+Z 撤销）")}</span>
                <button type="button" onClick={loadExamples} className="rounded px-2" style={{ border: `1px solid ${C.rule}`, whiteSpace: "nowrap" }} title={t("重新读取文件夹")}>
                  {examples.loading ? t("读取中…") : t("刷新")}
                </button>
              </div>
              {examples.error && <div style={{ fontSize: 12, color: C.err }}>{examples.error}</div>}
              {!examples.error && examples.files.length === 0 && !examples.loading && (
                <div style={{ fontSize: 12, color: C.muted }}>{examples.missing ? t("“Saved Plans” 文件夹不存在") : t("文件夹里还没有 .json 工程文件——用“另存为…”把平面图存进去就会出现在这里")}</div>
              )}
              <div className="flex flex-col gap-1" style={{ maxHeight: 220, overflowY: "auto" }}>
                {examples.files.map((f) => (
                  <button
                    key={f.name}
                    type="button"
                    onClick={() => openExampleByName(f.name)}
                    className="flex items-center justify-between gap-2 rounded px-2 py-1 text-left"
                    style={{ border: `1px solid ${fileName === f.name ? C.accent : C.rule}`, background: fileName === f.name ? C.errBg : C.panel, fontSize: 12 }}
                    title={t("打开 {0}", [f.name])}
                    data-testid="example-item"
                  >
                    <span style={{ fontWeight: 600, color: C.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name.replace(/\.stairplan\.json$|\.json$/i, "")}</span>
                    <span style={{ color: C.muted, fontSize: 10.5, whiteSpace: "nowrap" }}>
                      {(f.size / 1024 / 1024).toFixed(1)} MB · {new Date(f.mtime).toLocaleDateString()}
                    </span>
                  </button>
                ))}
              </div>
            </details>
          )}
          {/* 右侧四个面板都做成可折叠（原生 <details>，状态记在 localStorage）：用户反馈墙/门的编号列表太占地方，
              要能收纳起来。标题行始终显示数量，收起时也知道有几面墙几个门。 */}
          <details className="rounded p-3" style={{ border: `1px solid ${C.rule}` }} open={panelOpen.cores} onToggle={(e) => setPanelOpen("cores", e.currentTarget.open)} data-testid="panel-cores">
            <summary style={{ fontWeight: 600, fontSize: 13, cursor: "pointer", listStyle: "none", userSelect: "none" }}>{panelOpen.cores ? "▾" : "▸"} {t("核心筒（")}{plan.cores.length}{t("）")}</summary>
            <div style={{ fontSize: 11, color: C.muted, marginBottom: 6, marginTop: 2 }}>{t("点选（画布或下方列表均可，红框为选中）后 Ctrl+C / Ctrl+V 复制粘贴，或用\"复制\"按钮")}</div>
            <div className="flex flex-col gap-2" style={{ maxHeight: 260, overflowY: "auto" }}>
              {plan.cores.map((c) => (
                <div
                  key={c.id}
                  onClick={() => setSelectedCoreId(c.id)}
                  className="rounded p-2"
                  style={{ border: `1px solid ${selectedCoreId === c.id ? C.err : C.rule}`, boxShadow: selectedCoreId === c.id ? `0 0 0 1px ${C.err}` : "none", cursor: "pointer" }}
                >
                  <div className="flex items-center justify-between">
                    <input
                      type="text"
                      value={c.label}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => updateCore(c.id, { label: e.target.value })}
                      className="rounded px-1.5 py-0.5"
                      style={{ fontWeight: 700, color: c.color, fontSize: 12.5, border: `1px solid transparent`, background: "transparent", width: 100 }}
                      onFocus={(e) => (e.target.style.border = `1px solid ${C.rule}`)}
                      onBlur={(e) => (e.target.style.border = `1px solid transparent`)}
                    />
                    <span className="flex items-center gap-1">
                      <button type="button" onClick={(e) => { e.stopPropagation(); duplicateCore(c); }} className="rounded px-2" style={{ fontSize: 11, border: `1px solid ${C.rule}` }}>
                        {t("复制")}
                      </button>
                      <button type="button" onClick={(e) => { e.stopPropagation(); removeCore(c.id); }} className="rounded px-2" style={{ fontSize: 11, color: C.err, border: `1px solid ${C.rule}` }}>
                        {t("删除")}
                      </button>
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-1 mt-1">
                    <Num label="X" value={Math.round(c.x)} onChange={(v) => updateCore(c.id, { x: Number(v) || 0 })} width={64} step={50} />
                    <Num label="Y" value={Math.round(c.y)} onChange={(v) => updateCore(c.id, { y: Number(v) || 0 })} width={64} step={50} />
                    <Num label={t("旋转")} value={c.rot} onChange={(v) => updateCore(c.id, { rot: Number(v) || 0 })} width={56} step={5} />
                  </div>
                  <div className="flex items-center gap-1 mt-1">
                    <Num label={t("门宽")} value={c.doorWidth || DOOR_DEFAULT_WIDTH} onChange={(v) => updateCore(c.id, { doorWidth: Math.max(600, Number(v) || DOOR_DEFAULT_WIDTH) })} width={64} step={50} commitOnBlur />
                    <button type="button" onClick={() => updateCore(c.id, { doorHinge: (c.doorHinge || 1) * -1 })} className="rounded px-1.5" style={{ fontSize: 11, border: `1px solid ${C.rule}` }} title={t("沿墙面方向翻转（换转轴在哪一端）")}>
                      {t("左右镜像")}
                    </button>
                    <button type="button" onClick={() => updateCore(c.id, { doorSwing: (c.doorSwing || 1) * -1 })} className="rounded px-1.5" style={{ fontSize: 11, border: `1px solid ${C.rule}` }} title={t("沿墙面翻转（换朝哪边开）")}>
                      {t("上下镜像")}
                    </button>
                  </div>
                  <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>
                    {t("外包")} {fmt(c.w)} × {fmt(c.l)} {t("mm · 拖动黄点调整出口门位置(可吸附)")}
                  </div>
                </div>
              ))}
              {plan.cores.length === 0 && <div style={{ fontSize: 12, color: C.muted }}>{t("从上方选择楼梯并\"添加到平面图\"")}</div>}
            </div>
          </details>

          <details className="rounded p-3" style={{ border: `1px solid ${C.rule}` }} open={panelOpen.walls} onToggle={(e) => setPanelOpen("walls", e.currentTarget.open)} data-testid="panel-walls">
            <summary style={{ fontWeight: 600, fontSize: 13, cursor: "pointer", listStyle: "none", userSelect: "none" }}>{panelOpen.walls ? "▾" : "▸"} {t("走廊墙体（")}{plan.walls.length}{t("）")}</summary>
            <div style={{ fontSize: 11, color: C.muted, marginBottom: 6 }}>{t("点画布上的墙身或下方列表可选中（红框），选中后 Delete / Backspace 删除，Ctrl+C / Ctrl+V 复制粘贴（连同墙上的门，粘贴后错开 600 mm 并自动选中新墙）")}</div>
            {plan.walls.length === 0 && <div style={{ fontSize: 12, color: C.muted }}>{t("点\"绘制走廊墙体\"画出走廊/房间隔墙，构成可行走的走廊通道")}</div>}
            <div className="flex flex-col gap-2" style={{ maxHeight: 200, overflowY: "auto" }}>
              {plan.walls.map((w, i) => (
                <div
                  key={w.id}
                  onClick={() => {
                    setSelectedWallId(w.id);
                    setSelectedCoreId(null);
                    setSelectedDoorId(null);
                    setSelectedWallCandidateId(null);
                  }}
                  className="flex items-center gap-2 rounded px-1"
                  style={{ fontSize: 11.5, border: `1px solid ${selectedWallId === w.id ? C.err : "transparent"}`, cursor: "pointer" }}
                >
                  <span style={{ color: C.muted, flex: 1 }}>
                    {t("墙#")}{i + 1} ({fmt(w.x1)},{fmt(w.y1)}) → ({fmt(w.x2)},{fmt(w.y2)}{t(")，")}{fmt(wallLength(w))} mm
                  </span>
                  <Num label={t("厚")} value={w.t} onChange={(v) => updateWall(w.id, { t: Math.max(50, Number(v) || 150) })} width={56} step={10} />
                  <button type="button" onClick={(e) => { e.stopPropagation(); removeWall(w.id); }} className="rounded px-2" style={{ color: C.err, border: `1px solid ${C.rule}` }}>
                    {t("删除")}
                  </button>
                </div>
              ))}
            </div>
          </details>

          <details className="rounded p-3" style={{ border: `1px solid ${C.rule}` }} open={panelOpen.doors} onToggle={(e) => setPanelOpen("doors", e.currentTarget.open)} data-testid="panel-doors">
            <summary style={{ fontWeight: 600, fontSize: 13, cursor: "pointer", listStyle: "none", userSelect: "none" }}>{panelOpen.doors ? "▾" : "▸"} {t("门（")}{plan.doors.length}{t("）")}</summary>
            {plan.doors.length === 0 && <div style={{ fontSize: 12, color: C.muted }}>{t("先画好墙，再点\"添加门\"，在墙上点击开门位置")}</div>}
            <div className="flex flex-col gap-2" style={{ maxHeight: 200, overflowY: "auto" }}>
              {plan.doors.map((d) => (
                <div
                  key={d.id}
                  onClick={() => {
                    setSelectedDoorId(d.id);
                    setSelectedWallId(null);
                    setSelectedCoreId(null);
                    setSelectedWallCandidateId(null);
                  }}
                  className="flex items-center gap-2 rounded px-1"
                  style={{ fontSize: 11.5, border: `1px solid ${selectedDoorId === d.id ? C.err : "transparent"}`, cursor: "pointer" }}
                >
                  <span style={{ color: C.accent, flex: 1 }}>{t("门 · 墙#")}{plan.walls.findIndex((w) => w.id === d.wallId) + 1}</span>
                  <Num label={t("宽")} value={d.width} onChange={(v) => updateDoor(d.id, { width: Math.max(600, Number(v) || DOOR_DEFAULT_WIDTH) })} width={64} step={50} commitOnBlur />
                  <button type="button" onClick={() => updateDoor(d.id, { hinge: (d.hinge || 1) * -1 })} className="rounded px-1.5" style={{ border: `1px solid ${C.rule}` }} title={t("沿墙面方向翻转（换转轴在哪一端）")}>
                    {t("左右镜像")}
                  </button>
                  <button type="button" onClick={() => updateDoor(d.id, { swing: (d.swing || 1) * -1 })} className="rounded px-1.5" style={{ border: `1px solid ${C.rule}` }} title={t("沿墙面翻转（换朝哪边开）")}>
                    {t("上下镜像")}
                  </button>
                  <button type="button" onClick={(e) => { e.stopPropagation(); removeDoor(d.id); }} className="rounded px-2" style={{ color: C.err, border: `1px solid ${C.rule}` }}>
                    {t("删除")}
                  </button>
                </div>
              ))}
            </div>
          </details>

          <details className="rounded p-3" style={{ border: `1px solid ${C.rule}` }} open={panelOpen.paths} onToggle={(e) => setPanelOpen("paths", e.currentTarget.open)} data-testid="panel-paths">
            <summary style={{ fontWeight: 600, fontSize: 13, cursor: "pointer", listStyle: "none", userSelect: "none" }}>{panelOpen.paths ? "▾" : "▸"} {t("疏散路径 / 距离校核")}</summary>
            {/* 行走距离热力图的设置 + 统计：开关在画布上方工具栏；这里设限值（用途分组/喷淋）和格子大小 */}
            <div className="rounded p-2 mb-2" style={{ border: `1px solid ${heatmapOn ? C.accent : C.rule}`, fontSize: 11.5 }} data-testid="heatmap-panel">
              <label className="flex items-center gap-2" style={{ fontWeight: 600, fontSize: 12, cursor: plan.cores.length ? "pointer" : "not-allowed" }}>
                <input type="checkbox" checked={heatmapOn} disabled={plan.cores.length === 0} onChange={(e) => setHeatmapOn(e.target.checked)} />
                {t("行走距离热力图（整层每格到最近核心筒门）")}
              </label>
              {plan.cores.length === 0 && <div style={{ color: C.muted, marginTop: 4 }}>{t("先添加至少一个核心筒")}</div>}
              <div className="flex flex-wrap items-center gap-2 mt-1">
                <select value={heatmapGroup} onChange={(e) => setHeatmapGroup(e.target.value)} className="rounded px-1 py-0.5" style={{ border: `1px solid ${C.rule}`, background: C.panel, fontSize: 11.5 }} aria-label={t("热力图用途分组")}>
                  {TRAVEL_GROUPS.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.label}
                    </option>
                  ))}
                </select>
                {heatmapGroup === "other" && (
                  <label className="flex items-center gap-1">
                    <input type="checkbox" checked={heatmapSprinklered} onChange={(e) => setHeatmapSprinklered(e.target.checked)} />
                    {t("喷淋")}
                  </label>
                )}
                <label className="flex items-center gap-1">
                  {t("格子")}
                  <select value={heatmapCellM} onChange={(e) => setHeatmapCellM(Number(e.target.value))} className="rounded px-1 py-0.5" style={{ border: `1px solid ${C.rule}`, background: C.panel, fontSize: 11.5 }} aria-label={t("热力图格子大小")}>
                    <option value={0.5}>0.5 m</option>
                    <option value={1}>1 m</option>
                    <option value={2}>2 m</option>
                  </select>
                </label>
                <span style={{ color: C.muted }}>{t("限值")} {fmt(heatmapLimit)} mm <Ref k="TRAVEL" /></span>
              </div>
              {heatmapOn && heatmapStats && (
                <div className="mt-1" style={{ fontSize: 12 }}>
                  <span style={{ color: C.ok, fontWeight: 600 }}>{t("达标")} {heatmapStats.ok} {t("格")}</span>
                  {" · "}
                  <span style={{ color: heatmapStats.over ? C.err : C.muted, fontWeight: 600 }}>{t("超标")} {heatmapStats.over} {t("格")}</span>
                  {heatmapStats.unreachable > 0 && <span style={{ color: C.muted }}> {t("· 走不到门")} {heatmapStats.unreachable} {t("格（灰色）")}</span>}
                  <div style={{ color: C.muted, marginTop: 2 }}>
                    {t("最远一格")} {(heatmapStats.worst / 1000).toFixed(1)} {t("m；每格取格内最不利点的距离；鼠标悬停在格子上可看具体数值。路径算法跟\"自动最短路径\"完全相同（同一张避墙栅格），只是把所有核心筒门当起点一次算完全图。")}
                  </div>
                </div>
              )}
            </div>
            {plan.paths.length === 0 && (
              <div style={{ fontSize: 12, color: C.muted }}>
                {t("\"自动最短路径\"：点一下起点，工具沿已画的墙体/门自动算出到核心筒门的最短路径；整层的达标情况看工具栏的\"行走距离热力图\"")}
              </div>
            )}
            <div className="flex flex-col gap-2">
              {plan.paths.map((p) => {
                const isAuto = p.kind === "auto";
                const autoR = isAuto ? autoResults[p.id] : null;
                const len = isAuto ? (autoR ? autoR.length : null) : polylineLength(p.pts);
                const limit = travelLimit(p.travelGroup, p.sprinklered);
                const ok = len != null ? len <= limit : null;
                return (
                  <div key={p.id} className="rounded p-2" style={{ border: `1px solid ${C.rule}` }}>
                    <div className="flex items-center justify-between gap-2">
                      <input value={p.label} onChange={(e) => updatePath(p.id, { label: e.target.value })} className="rounded px-1 py-0.5" style={{ border: `1px solid ${C.rule}`, fontSize: 12, width: 90 }} />
                      {isAuto && <span style={{ fontSize: 10.5, color: C.muted }}>{t("自动")}</span>}
                      <button type="button" onClick={() => removePath(p.id)} className="rounded px-2" style={{ fontSize: 11, color: C.err, border: `1px solid ${C.rule}` }}>
                        {t("删除")}
                      </button>
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <select
                        value={p.travelGroup}
                        onChange={(e) => updatePath(p.id, { travelGroup: e.target.value })}
                        className="rounded px-1 py-0.5"
                        style={{ border: `1px solid ${C.rule}`, fontSize: 11.5, background: C.panel }}
                      >
                        {TRAVEL_GROUPS.map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.label}
                          </option>
                        ))}
                      </select>
                      {p.travelGroup === "other" && (
                        <label className="flex items-center gap-1" style={{ fontSize: 11.5 }}>
                          <input type="checkbox" checked={p.sprinklered} onChange={(e) => updatePath(p.id, { sprinklered: e.target.checked })} />
                          {t("喷淋")}
                        </label>
                      )}
                    </div>
                    {isAuto && (
                      <label className="flex items-center gap-2 mt-1" style={{ fontSize: 11.5 }}>
                        {t("目标核心筒")}
                        <select
                          value={p.targetCore || ""}
                          onChange={(e) => updatePath(p.id, { targetCore: e.target.value ? Number(e.target.value) : null })}
                          className="rounded px-1 py-0.5"
                          style={{ border: `1px solid ${C.rule}`, background: C.panel }}
                        >
                          <option value="">{t("最近的核心筒")}</option>
                          {plan.cores.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    {!isAuto && plan.mode === "path" && plan.drawingPathId === p.id && plan.cores.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1 mt-1" style={{ fontSize: 11 }}>
                        <span>{t("吸附终点到：")}</span>
                        {plan.cores.map((c) => (
                          <button key={c.id} type="button" onClick={() => snapPathToDoor(p.id, c.id)} className="rounded px-1.5" style={{ border: `1px solid ${c.color}`, color: c.color }}>
                            {c.label}{t("门")}
                          </button>
                        ))}
                      </div>
                    )}
                    {isAuto && len == null ? (
                      <div className="mt-1" style={{ fontSize: 12, color: C.err }}>
                        {t("从起点走不到目标核心筒的门（被墙体挡住，检查沿途是否漏开门）")}
                      </div>
                    ) : (
                      <div className="mt-1" style={{ fontSize: 12.5, color: ok ? C.ok : C.err, fontWeight: 600 }}>
                        {fmt(len)} {t("mm / 限值")} {fmt(limit)} mm {ok ? "✓" : "✗"} <Ref k="TRAVEL" />
                        {isAuto && autoR && <span style={{ color: C.muted, fontWeight: 400 }}> · → {(plan.cores.find((c) => c.id === autoR.coreId) || {}).label}{t("门")}</span>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </details>

          {plan.cores.length >= 2 && (
            <div className="rounded p-3" style={{ border: `1px solid ${C.rule}` }}>
              <div className="flex items-center justify-between mb-1">
                <span style={{ fontWeight: 600, fontSize: 13 }}>{t("出口间距校核")}</span>
                <label className="flex items-center gap-1" style={{ fontSize: 11.5 }}>
                  <input type="checkbox" checked={plan.hasCorridor} onChange={(e) => setPlan((prev) => ({ ...prev, hasCorridor: e.target.checked }))} />
                  {t("本层有公共走道连接各出口")}
                </label>
              </div>
              {diag == null && (
                <div style={{ fontSize: 11.5, color: C.warn }}>
                  {t("先绘制楼层边界，才能按对角线一半计算最小间距")} <Ref k="DIST" />
                </div>
              )}
              {sepRows.map((r, i) => (
                <div key={i} style={{ fontSize: 12.5, padding: "3px 0", color: r.ok === false ? C.err : C.ink }}>
                  <span style={{ color: r.a.color, fontWeight: 700 }}>{r.a.label}</span> ↔ <span style={{ color: r.b.color, fontWeight: 700 }}>{r.b.label}</span>{t("：")}{fmt(r.dist)} mm
                  {r.req != null ? t(" / 最小 {0} mm {1}", [fmt(r.req), r.ok ? "✓" : "✗"]) : ""}
                  {r.relaxed ? <Ref k="DIST45" /> : r.req != null && <Ref k="DIST" />}
                </div>
              ))}
            </div>
          )}

          {planWarnings.length > 0 && (
            <div className="rounded p-3" style={{ background: C.errBg, border: `1px solid ${C.err}` }}>
              {planWarnings.map((w, i) => (
                <div key={i} style={{ fontSize: 12, color: C.err }}>
                  ✗ {w}
                </div>
              ))}
            </div>
          )}
        </div>
        )}
      </div>
      {/* "清空平面图"放在整个平面图区域的最下面（用户要求不要放在上面的工具栏里）：按钮靠右，点了在它上方出确认条 */}
      <div className="flex flex-col items-end gap-2" style={{ marginTop: 12 }} data-testid="clear-plan-area">
        {clearConfirm && (
          <div className="flex flex-wrap items-center gap-2 rounded p-3" style={{ border: `1px solid ${C.err}`, background: C.errBg, fontSize: 12.5, alignSelf: "stretch" }} data-testid="clear-confirm">
            <span style={{ flex: 1, minWidth: 240 }}>
              {t("确定清空整张平面图吗？底图、比例、边界、")}{plan.cores.length} {t("个核心筒、")}{plan.walls.length} {t("面墙、")}{plan.doors.length} {t("个门和所有路径都会被清掉")}
              {fileName ? t("，并与文件“{0}”断开关联（文件本身不会被改）", [fileName]) : ""}{t("。清空后可按 Ctrl+Z 撤销。")}
            </span>
            <button type="button" onClick={clearPlanAll} className="rounded px-3 py-1" style={{ background: C.err, color: C.onAccent, fontWeight: 600 }} data-testid="clear-confirm-yes">
              {t("确定清空")}
            </button>
            <button type="button" onClick={() => setClearConfirm(false)} className="rounded px-3 py-1" style={{ border: `1px solid ${C.rule}` }} data-testid="clear-confirm-no">
              {t("取消")}
            </button>
          </div>
        )}
        <button
          type="button"
          onClick={() => setClearConfirm((v) => !v)}
          className="rounded px-3 py-1.5"
          style={{ border: `1px solid ${C.err}`, color: C.err, fontWeight: 600, background: clearConfirm ? C.errBg : C.panel, fontSize: 12.5 }}
          title={t("把底图、比例、边界、核心筒、墙、门、路径全部清掉，回到空白画布（会先让你确认）")}
          data-testid="clear-plan"
        >
          {t("清空平面图")}
        </button>
      </div>
      <p style={{ fontSize: 11.5, color: C.muted, marginTop: 10 }}>
        {t("本节为示意性校核：底图比例、边界、墙体与手动路径均为绘制得到；\"自动最短路径\"把墙体/门/核心筒栅格化（格宽约")} {fmt(CELL)} {t("mm）后按最短路径算法（8 方向、避开对角穿墙）求距离，栅格分辨率与门宽处理是近似值，不是精确的可见光路径或规范意义上的\"实际行走路线\"；出口间距按已绘边界包络的对角线近似（非精确的楼层区域对角线）。核心筒或墙体较多时，拖动过程中自动路径会实时重算，可能略有卡顿。结果仅供方案阶段参考，不替代正式安全疏散图纸复核。")}
      </p>
    </div>
  );
}

/* 平面图 undo/redo：拖动（连续多次 setPlan）算一步，松手（pointerup）或停手 500 ms 后提交历史；
   Ctrl+Z 撤销、Ctrl+Y / Ctrl+Shift+Z 重做，与 Rhino 一致。历史栈上限 200 步。 */
function usePlanHistory(initialPlan) {
  const [present, setPresent] = useState(initialPlan);
  const pastRef = useRef([]);
  const futureRef = useRef([]);
  const pendingBeforeRef = useRef(null);
  const timerRef = useRef(null);
  const [, bump] = useState(0);

  const commitPending = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (pendingBeforeRef.current !== null) {
      pastRef.current.push(pendingBeforeRef.current);
      if (pastRef.current.length > 200) pastRef.current.shift();
      pendingBeforeRef.current = null;
      futureRef.current = [];
      bump((n) => n + 1);
    }
  }, []);

  const setPlan = useCallback(
    (updater) => {
      setPresent((prev) => {
        const next = typeof updater === "function" ? updater(prev) : updater;
        if (next === prev) return prev;
        if (pendingBeforeRef.current === null) pendingBeforeRef.current = prev;
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(commitPending, 500);
        return next;
      });
    },
    [commitPending]
  );

  useEffect(() => {
    window.addEventListener("pointerup", commitPending);
    return () => window.removeEventListener("pointerup", commitPending);
  }, [commitPending]);

  const undo = useCallback(() => {
    commitPending();
    if (pastRef.current.length === 0) return;
    const previous = pastRef.current.pop();
    setPresent((prev) => {
      futureRef.current.push(prev);
      return previous;
    });
    bump((n) => n + 1);
  }, [commitPending]);

  const redo = useCallback(() => {
    if (futureRef.current.length === 0) return;
    const next = futureRef.current.pop();
    setPresent((prev) => {
      pastRef.current.push(prev);
      return next;
    });
    bump((n) => n + 1);
  }, []);

  return { plan: present, setPlan, undo, redo, canUndo: pastRef.current.length > 0, canRedo: futureRef.current.length > 0 };
}

export default function StairCoreTool() {
  const [nFloors, setNFloorsRaw] = useState(5);
  const [wall, setWall] = useState(300);
  const [maxStairW, setMaxStairW] = useState(1500);
  const [stairType, setStairType] = useState("dogleg");
  const [includeL1, setIncludeL1] = useState(false);
  const [sprinklered, setSprinklered] = useState(true);
  const [buildingArea, setBuildingArea] = useState(800);
  const [adv, setAdv] = useState({ run: 280, maxRise: 180, maxRisers: 10, gap: 150, centerWall: 200, doorLeaf: 950, doorLeafMax: 1220, doorPos: "end", doorHinge: "wall", doorSide: "dn", waist: 180, roundStep: 50 });
  const [showAdv, setShowAdv] = useState(false);
  const [floors, setFloors] = useState(() => defaultFloors(5));
  const [batch, setBatch] = useState({ from: 2, to: 5, use: "", area: "", ffh: "", slab: "", bedrooms: "" });
  const [sel, setSel] = useState({ shaft: 0, level: null, secStart: null });
  const [v3, setV3] = useState({ from: 1, count: 6 });
  const setNFloors = (v) => {
    const n = clamp(Math.round(Number(v) || 2), 2, 80);
    setNFloorsRaw(n);
    setFloors((prev) => {
      if (n <= prev.length) return prev.slice(0, n);
      const last = prev[prev.length - 1];
      return [...prev, ...Array.from({ length: n - prev.length }, () => ({ ...last }))];
    });
    setBatch((b) => ({ ...b, from: clamp(b.from, 1, n), to: clamp(b.to, 1, n) }));
  };
  const setFloor = (i, patch) => setFloors((prev) => prev.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const applyBatch = () => {
    const a = clamp(Math.min(batch.from, batch.to), 1, nFloors), b = clamp(Math.max(batch.from, batch.to), 1, nFloors);
    setFloors((prev) =>
      prev.map((f, j) => {
        const L = j + 1;
        if (L < a || L > b) return f;
        const p = {};
        if (batch.use) p.use = batch.use;
        if (batch.area !== "") p.area = Number(batch.area);
        if (batch.ffh !== "") p.ffh = Number(batch.ffh);
        if (batch.slab !== "") p.slab = Number(batch.slab);
        if (batch.bedrooms !== "") p.bedrooms = Number(batch.bedrooms);
        return { ...f, ...p };
      })
    );
  };

  /* 左栏输入为草稿；点击“确认并计算”后才复制为 inp 参与计算与绘图 */
  const draft = useMemo(() => ({ nFloors, wall, maxStairW, stairType, includeL1, sprinklered, buildingArea, adv, floors }), [nFloors, wall, maxStairW, stairType, includeL1, sprinklered, buildingArea, adv, floors]);
  const [inp, setInp] = useState(draft);
  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(inp), [draft, inp]);
  const apply = () => setInp(draft);
  const res = useMemo(() => compute(inp), [inp]);

  const base = res.zones[0];
  const shaftIdx = clamp(sel.shaft, 0, base.shafts.length - 1);
  const shaft = base.shafts[shaftIdx];
  const defaultLevel = shaft.stairs[0].govLevel;
  const level = sel.level && shaft.stairs[0].storeyLevels.includes(sel.level) ? sel.level : defaultLevel;
  const secStart = sel.secStart != null ? clamp(sel.secStart, 1, Math.max(1, inp.nFloors - 2)) : clamp(level, 1, Math.max(1, inp.nFloors - 2));

  const scissorRelax = inp.stairType === "scissor" && res.allRes && inp.nFloors <= 6 && inp.buildingArea <= 600;

  /* Rhino 平面图（见 RHINO_PLANS_KEY）：按楼层一组 plan，共用一条撤销历史，每次变化存回 localStorage */
  const [rhinoPlansInit] = useState(readRhinoPlans);
  const rhinoHist = usePlanHistory(rhinoPlansInit);
  useEffect(() => {
    try {
      localStorage.setItem(RHINO_PLANS_KEY, JSON.stringify(rhinoHist.plan));
    } catch {
      /* 隐私模式等 */
    }
  }, [rhinoHist.plan]);
  const rhinoLevels = Object.keys(rhinoHist.plan.byLevel || {}).map(Number).sort((a, b) => a - b);
  const rhinoSelected = rhinoLevels.includes(rhinoHist.plan.selected) ? rhinoHist.plan.selected : rhinoLevels[0];
  const rhinoPlan = rhinoSelected != null ? rhinoHist.plan.byLevel[rhinoSelected] : null;
  // 给 PlanEditor 的 setPlan：只改当前选中楼层那张
  const setRhinoPlan = (updater) =>
    rhinoHist.setPlan((prev) => {
      const cur = prev.byLevel[rhinoSelected];
      const next = typeof updater === "function" ? updater(cur) : updater;
      return { ...prev, byLevel: { ...prev.byLevel, [rhinoSelected]: next } };
    });
  const selectRhinoLevel = (L) => rhinoHist.setPlan((prev) => ({ ...prev, selected: L }));
  const removeRhinoLevel = (L) =>
    rhinoHist.setPlan((prev) => {
      const byLevel = { ...prev.byLevel };
      delete byLevel[L];
      const rest = Object.keys(byLevel).map(Number).sort((a, b) => a - b);
      return { ...prev, byLevel, selected: rest.includes(prev.selected) ? prev.selected : rest[0] || 1 };
    });

  /* 平面图工具现在是独立页面（/plan），靠 localStorage 拿这里"确认并计算"后的 inp——
     每次 inp 变化（点确认并计算）就写一份，平面图页面（同一浏览器的另一个标签页）
     通过 storage 事件监听到变化后会自动重新计算 res，不需要手动导入导出。 */
  useEffect(() => {
    saveInp(inp);
  }, [inp]);

  return (
    <div style={{ background: C.paper, minHeight: "100vh", fontFamily: FONT, color: C.ink }}>
      <LangToggle />
      <div className="mx-auto px-4 py-6" style={{ maxWidth: 1360 }}>
        {/* 标题 */}
        <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0, letterSpacing: "-0.01em" }}>{t("核心筒疏散楼梯计算器")}</h1>
            <p style={{ color: C.muted, margin: "6px 0 0", fontSize: 13, maxWidth: 720 }}>
              {t("按每层面积、用途、层高确定楼梯数量、净宽、跑数与楼梯间尺寸。条文按温哥华 VBBL 2025（2026-01-20 修订）优先，其次 BCBC 2024，再次 NBC 2020；三者对本页所用条款绝大多数一致，标签会注明来源层级。")}
            </p>
          </div>
          <div className="flex items-center gap-2" style={{ fontSize: 12 }}>
            {[
              ["VBBL 2025", t("温哥华建筑条例 #14343")],
              ["BCBC 2024", t("BC 省建筑规范")],
              ["NBC 2020", t("国家建筑规范")],
            ].map(([a, b], i) => (
              <div key={a} className="flex items-center gap-2">
                <div className="px-3 py-1 rounded" style={{ background: i === 0 ? C.accent : C.panel, color: i === 0 ? C.onAccent : C.ink, border: `1px solid ${i === 0 ? C.accent : C.rule}` }}>
                  <div style={{ fontWeight: 600 }}>{a}</div>
                  <div style={{ fontSize: 10.5, opacity: 0.8 }}>{b}</div>
                </div>
                {i < 2 && <span style={{ color: C.muted }}>←</span>}
              </div>
            ))}
          </div>
        </header>

        <div className="grid gap-6 lg:grid-cols-3">
          {/* ================= 左：输入 ================= */}
          <aside className="flex flex-col gap-5 lg:col-span-1 lg:sticky lg:top-4 lg:self-start lg:max-h-screen lg:overflow-y-auto" style={{ paddingRight: 4 }}>
            <section className="rounded-lg p-4" style={{ background: dirty ? C.warnBg : C.panel, border: `1px solid ${dirty ? C.warn : C.rule}` }}>
              <button
                type="button"
                onClick={apply}
                className="w-full rounded px-4 py-2"
                style={{ background: dirty ? C.accent : C.tag, color: dirty ? C.onAccent : C.muted, fontSize: 14, fontWeight: 600, border: "none", cursor: dirty ? "pointer" : "default" }}
              >
                {dirty ? t("确认并计算") : t("结果已是最新")}
              </button>
              <div style={{ fontSize: 11.5, color: C.muted, marginTop: 6 }}>{dirty ? t("输入已修改，右侧结果、图纸与三维模型尚未更新，点击确认后重新计算。") : t("修改下方任何输入后需点击此按钮才会重新计算。")}</div>
            </section>
            <Panel id="global" className="rounded-lg p-4" title={t("整体参数")} sub={t("建筑与核心筒")}>
              <Num label={t("层数（含首层）")} value={nFloors} onChange={setNFloors} unit={t("层")} min={2} max={80} />
              <Num label={t("核心筒 / 楼梯间墙厚")} value={wall} onChange={(v) => setWall(Number(v) || 0)} unit="mm" step={10} />
              <Num label={t("单部楼梯最大净宽")} value={maxStairW} onChange={(v) => setMaxStairW(Math.max(900, Number(v) || 900))} unit="mm" step={50} hint={t("超过则增加楼梯数量")} />
              <div className="flex items-center justify-between py-1" style={{ fontSize: 13 }}>
                <span>{t("楼梯形式")}</span>
                <Seg
                  options={[
                    { value: "dogleg", label: t("折返梯（双跑）") },
                    { value: "scissor", label: t("剪刀梯（一井两梯）") },
                  ]}
                  value={stairType}
                  onChange={setStairType}
                />
              </div>
              <Num label={t("每跑最多踢面数（0 = 不限）")} value={adv.maxRisers} onChange={(v) => setAdv({ ...adv, maxRisers: Math.max(0, Math.floor(Number(v) || 0)) })} unit={t("级")} hint={t("超过即加折返休息平台；规范仅限每跑 ≤3.7 m")} />
              <Toggle label={t("首层人员经楼梯疏散")} checked={includeL1} onChange={setIncludeL1} hint={t("默认首层直接由外门出口")} />
              <Toggle label={t("全楼设自动喷淋")} checked={sprinklered} onChange={setSprinklered} />
              {stairType === "scissor" && <Num label={t("建筑面积（最大楼层外包面积）")} value={buildingArea} onChange={(v) => setBuildingArea(Number(v) || 0)} unit="m²" hint={t("用于 3.4.2.3.(5) 判断")} />}
              <button type="button" onClick={() => setShowAdv(!showAdv)} className="mt-2 text-left" style={{ fontSize: 12, color: C.accent }}>
                {showAdv ? t("收起") : t("展开")}{t("踏步与平台参数")}
              </button>
              {showAdv && (
                <div className="mt-1 pt-2" style={{ borderTop: `1px dashed ${C.rule}` }}>
                  <Num label={t("踏面 run")} value={adv.run} onChange={(v) => setAdv({ ...adv, run: Math.max(200, Number(v) || 280) })} unit="mm" step={5} hint="≥280 (3.4.6.8.(1))" />
                  <Num label={t("最大踢面 rise")} value={adv.maxRise} onChange={(v) => setAdv({ ...adv, maxRise: clamp(Number(v) || 180, 125, 220) })} unit="mm" hint="≤180 (3.4.6.8.(2))" />
                  {stairType === "dogleg" ? (
                    <Num label={t("两跑之间梯井 / 栏板宽")} value={adv.gap} onChange={(v) => setAdv({ ...adv, gap: Math.max(0, Number(v) || 0) })} unit="mm" step={10} />
                  ) : (
                    <Num label={t("剪刀梯中间隔墙厚")} value={adv.centerWall} onChange={(v) => setAdv({ ...adv, centerWall: Math.max(50, Number(v) || 200) })} unit="mm" step={10} hint="3.4.4.4.(2)" />
                  )}
                  <Num label={t("出口门扇宽（设计下限）")} value={adv.doorLeaf} onChange={(v) => setAdv({ ...adv, doorLeaf: Math.max(800, Number(v) || 950) })} unit="mm" step={10} hint={t("实际门宽按人数 × 6.1 mm 自动算，不小于此值")} />
                  <Num label={t("单扇门最大宽度")} value={adv.doorLeafMax || 1220} onChange={(v) => setAdv({ ...adv, doorLeafMax: Math.max(800, Number(v) || 1220) })} unit="mm" step={10} hint={t("USER：规范无单扇上限；超过则自动分两扇")} />
                  <div className="flex items-center justify-between py-1" style={{ fontSize: 13 }}>
                    <span>{t("门的位置")}</span>
                    <Seg options={[{ value: "end", label: t("平台端墙") }, { value: "side", label: t("平台侧墙") }]} value={adv.doorPos} onChange={(v) => setAdv({ ...adv, doorPos: v })} />
                  </div>
                  {adv.doorPos === "end" && (
                    <div className="flex items-center justify-between py-1" style={{ fontSize: 13 }}>
                      <span>{t("端墙上的做法")}</span>
                      <Seg options={[{ value: "wall", label: t("贴侧墙·开启后贴墙") }, { value: "center", label: t("居中·开启后垂直端墙") }]} value={adv.doorHinge || "wall"} onChange={(v) => setAdv({ ...adv, doorHinge: v })} />
                    </div>
                  )}
                  {adv.doorPos === "end" && (adv.doorHinge || "wall") === "wall" && stairType === "dogleg" && (
                    <div className="flex items-center justify-between py-1" style={{ fontSize: 13 }}>
                      <span>{t("贴哪一侧")}</span>
                      <Seg options={[{ value: "dn", label: t("下行梯段侧（推荐）") }, { value: "up", label: t("上行梯段侧") }]} value={adv.doorSide || "dn"} onChange={(v) => setAdv({ ...adv, doorSide: v })} />
                    </div>
                  )}
                  <Num label={t("梯段 / 平台板厚")} value={adv.waist} onChange={(v) => setAdv({ ...adv, waist: Math.max(100, Number(v) || 180) })} unit="mm" step={10} hint={t("净高检查用")} />
                  <Num label={t("宽度取整")} value={adv.roundStep} onChange={(v) => setAdv({ ...adv, roundStep: Math.max(1, Number(v) || 50) })} unit="mm" />
                </div>
              )}
            </Panel>

            <Panel id="batch" className="rounded-lg p-4" title={t("批量编辑")} sub={t("选择楼层范围后一次修改")}>
              <div className="grid grid-cols-2 gap-x-3" style={{ fontSize: 13 }}>
                <Num label={t("从 L")} value={batch.from} onChange={(v) => setBatch({ ...batch, from: clamp(Number(v) || 1, 1, nFloors) })} width={70} />
                <Num label={t("到 L")} value={batch.to} onChange={(v) => setBatch({ ...batch, to: clamp(Number(v) || 1, 1, nFloors) })} width={70} />
              </div>
              <label className="flex items-center justify-between gap-3 py-1" style={{ fontSize: 13 }}>
                <span>{t("用途")}</span>
                <select value={batch.use} onChange={(e) => setBatch({ ...batch, use: e.target.value })} className="rounded px-2 py-1" style={{ border: `1px solid ${C.rule}`, maxWidth: 230, fontSize: 12, background: C.panel }}>
                  <option value="">{t("（不变）")}</option>
                  {USES.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.label}
                    </option>
                  ))}
                </select>
              </label>
              <Num label={t("每层面积")} value={batch.area} onChange={(v) => setBatch({ ...batch, area: v })} unit="m²" hint={t("留空不变")} />
              <Num label={t("层高")} value={batch.ffh} onChange={(v) => setBatch({ ...batch, ffh: v })} unit="mm" step={50} />
              <Num label={t("楼板厚")} value={batch.slab} onChange={(v) => setBatch({ ...batch, slab: v })} unit="mm" step={10} />
              <Num label={t("卧室数（住宅用）")} value={batch.bedrooms} onChange={(v) => setBatch({ ...batch, bedrooms: v })} unit={t("间")} />
              <button type="button" onClick={applyBatch} className="mt-2 w-full rounded py-2" style={{ background: C.accent, color: C.onAccent, fontSize: 13, fontWeight: 600 }}>
                {t("应用到 L")}{Math.min(batch.from, batch.to)} – L{Math.max(batch.from, batch.to)}
              </button>
            </Panel>

            <Panel id="floors" className="rounded-lg p-4" title={t("逐层参数")} sub={t("自上而下排列")}>
              <div style={{ fontSize: 12 }}>
                <div className="grid gap-1 pb-1 mb-1" style={{ gridTemplateColumns: "34px 58px 1fr 58px 50px 56px", color: C.muted, borderBottom: `1px solid ${C.rule}` }}>
                  <span>{t("层")}</span>
                  <span>{t("面积 m²")}</span>
                  <span>{t("用途")}</span>
                  <span>{t("层高")}</span>
                  <span>{t("板厚")}</span>
                  <span>{t("人数")}</span>
                </div>
                {floors
                  .map((f, i) => ({ f, i }))
                  .reverse()
                  .map(({ f, i }) => {
                    const u = useById(f.use);
                    // 左栏是草稿：层数未确认前 res.perFloor 可能没有对应项
                    const pf = res.perFloor[i] || null;
                    const zoneStart = !dirty && res.zones.some((z) => z.from === i + 1) && i + 1 !== res.lvl0;
                    return (
                      <div key={i} className="grid gap-1 items-center py-1" style={{ gridTemplateColumns: "34px 58px 1fr 58px 50px 56px", borderTop: zoneStart ? `2px solid ${C.accent}` : "none" }}>
                        <span style={{ fontWeight: 600, color: pf && pf.counted ? C.ink : C.muted }}>L{i + 1}</span>
                        <input type="number" value={f.area} onChange={(e) => setFloor(i, { area: e.target.value === "" ? "" : Number(e.target.value) })} className="rounded px-1 py-0.5 text-right" style={{ border: `1px solid ${C.rule}`, width: "100%", fontVariantNumeric: "tabular-nums" }} />
                        <select value={f.use} onChange={(e) => setFloor(i, { use: e.target.value })} className="rounded px-1 py-0.5" style={{ border: `1px solid ${C.rule}`, width: "100%", fontSize: 11.5, background: C.panel }}>
                          {USES.map((x) => (
                            <option key={x.id} value={x.id}>
                              {x.label}
                            </option>
                          ))}
                        </select>
                        <input type="number" step={50} value={f.ffh} onChange={(e) => setFloor(i, { ffh: e.target.value === "" ? "" : Number(e.target.value) })} className="rounded px-1 py-0.5 text-right" style={{ border: `1px solid ${C.rule}`, width: "100%", fontVariantNumeric: "tabular-nums" }} />
                        <input type="number" step={10} value={f.slab} onChange={(e) => setFloor(i, { slab: e.target.value === "" ? "" : Number(e.target.value) })} className="rounded px-1 py-0.5 text-right" style={{ border: `1px solid ${C.rule}`, width: "100%", fontVariantNumeric: "tabular-nums" }} />
                        {u.id === "dwelling" ? (
                          <input type="number" title={t("卧室数 × 2 人")} value={f.bedrooms} onChange={(e) => setFloor(i, { bedrooms: e.target.value === "" ? "" : Number(e.target.value) })} className="rounded px-1 py-0.5 text-right" style={{ border: `1px solid ${C.accent}`, width: "100%", fontVariantNumeric: "tabular-nums" }} placeholder={t("卧室")} />
                        ) : (
                          <input type="number" title={t("留空按 Table 3.1.17.1 自动计算；填写则按设计人数")} value={f.ol} onChange={(e) => setFloor(i, { ol: e.target.value })} className="rounded px-1 py-0.5 text-right" style={{ border: `1px solid ${C.rule}`, width: "100%", fontVariantNumeric: "tabular-nums", color: f.ol ? C.accent : C.ink }} placeholder={pf ? String(pf.ol) : t("表值")} />
                        )}
                      </div>
                    );
                  })}
                <p style={{ color: C.muted, fontSize: 11, marginTop: 8 }}>{t("人数列：住宅填卧室数（×2 人，3.1.17.1.(1)(b)）；其他用途留空自动按表计算，填写则作为设计人数覆盖。蓝色横线为楼梯数量变化处。")}</p>
              </div>
            </Panel>
          </aside>

          {/* ================= 右：结果 ================= */}
          <main className="flex flex-col gap-6 lg:col-span-2" style={{ minWidth: 0 }}>
            {/* 概要 */}
            <Panel id="summary" className="rounded-lg p-5" title={t("结果概要")} sub={t("出口层 L1；计入楼梯疏散的楼层 L{0}–L{1}", [res.lvl0, inp.nFloors])}>
              {dirty && (
                <div className="mb-3 rounded px-3 py-2" style={{ background: C.warnBg, border: `1px solid ${C.warn}`, color: C.warn, fontSize: 12.5 }}>
                  {t("以下结果对应上一次确认的输入；左栏有未确认的修改。")}
                </div>
              )}
              <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))" }}>
                <div>
                  <div style={{ fontSize: 12, color: C.muted }}>{t("底部区段楼梯数量")}</div>
                  <div style={{ fontSize: 30, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                    {res.cBase} <span style={{ fontSize: 14, fontWeight: 500 }}>{t("部")}</span>
                  </div>
                  <div style={{ fontSize: 11.5, color: C.muted }}>
                    {t("最少 2 部")} <Ref k="EXITS" /> {t("· 超过单梯上限则增加")}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 12, color: C.muted }}>{t("楼梯净宽")}</div>
                  <div style={{ fontSize: 30, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                    {res.stairs.map((s) => fmt(s.W)).filter((v, i, a) => a.indexOf(v) === i).join(" / ")} <span style={{ fontSize: 14, fontWeight: 500 }}>mm</span>
                  </div>
                  <div style={{ fontSize: 11.5, color: C.muted }}>
                    {res.mmppStair} {t("mm/人")} <Ref k="MMPP" /> {t("· 不累加")} <Ref k="NOCUM" />
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 12, color: C.muted }}>{t("底部区段楼梯间核心筒外包")}</div>
                  <div style={{ fontSize: 30, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                    {(base.totW / 1000).toFixed(2)} × {(base.totL / 1000).toFixed(2)} <span style={{ fontSize: 14, fontWeight: 500 }}>m</span>
                  </div>
                  <div style={{ fontSize: 11.5, color: C.muted }}>
                    {base.shafts.length} {t("个梯间并列共墙，")}{base.area.toFixed(1)} m²
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 12, color: C.muted }}>{t("每层跑数 / 中间平台")}</div>
                  <div style={{ fontSize: 30, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                    {[...new Set(res.perFloor.filter((p) => p.counted).map((p) => t("{0}跑", [p.flights])))].join(" · ")}
                  </div>
                  <div style={{ fontSize: 11.5, color: C.muted }}>
                    {t("每跑 ≤3.7 m")} <Ref k="RISE37" />{res.maxRPF < Infinity ? t(" 且 ≤{0} 级 ", [res.maxRPF]) : " "}<Ref k="MAXR" /> {t("· 中间平台 = 跑数 − 1")}
                  </div>
                </div>
              </div>

              {/* 分区 */}
              <div className="mt-5 grid gap-2">
                {res.zones.map((z, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-3 rounded px-3 py-2" style={{ background: i === 0 ? C.tag : "transparent", border: `1px solid ${C.rule}` }}>
                    <span style={{ fontWeight: 700, minWidth: 92 }}>
                      L{z.from}
                      {z.to !== z.from ? `–L${z.to}` : ""}
                    </span>
                    <span style={{ fontVariantNumeric: "tabular-nums" }}>
                      <strong>{z.count}</strong> {t("部楼梯")}
                    </span>
                    <span style={{ color: C.muted }}>·</span>
                    <span style={{ fontVariantNumeric: "tabular-nums" }}>{z.stairs.map((s) => `#${s.k} ${fmt(s.W)}`).join(t("，"))} mm</span>
                    <span style={{ color: C.muted }}>·</span>
                    <span style={{ fontVariantNumeric: "tabular-nums" }}>
                      {inp.stairType === "dogleg" ? t("每间 {0} × {1}", [fmt(z.shafts[0].innerW + 2 * inp.wall), fmt(z.shafts[0].innerL + 2 * inp.wall)]) : t("{0} 个梯井", [z.shafts.length])} {t("→ 合计外包")} {fmt(z.totW)} × {fmt(z.totL)} {t("mm（")}{z.area.toFixed(1)} {t("m²）")}
                    </span>
                  </div>
                ))}
                <p style={{ fontSize: 12, color: C.muted, margin: 0 }}>
                  {inp.includeL1
                    ? t("首层人员计入楼梯疏散：假定楼梯继续向下通至出口层（如地下出口）。")
                    : t("L1 为出口层：{0} 部楼梯贯通至此并直接对外出口；仅允许其中 1 部经大堂出口 ", [res.cBase])}
                  {!inp.includeL1 && <Ref k="LOBBY" />}
                </p>
                {res.zones.length > 1 && (
                  <p style={{ fontSize: 12, color: C.muted, margin: 0 }}>
                    {t("上部区段的楼梯必须连续向下贯通至出口层，因此下部楼梯数量 ≥ 上部；只服务下部楼层的楼梯可在其最高服务层的顶板处终止（裙房梯）。楼梯净宽按其服务楼层中最大的（本层需求 ÷ 本层楼梯数）确定")} <Ref k="NOCUM" /> <Ref k="HALF" />{t("。")}
                  </p>
                )}
              </div>

              {res.warnings.length > 0 && (
                <div className="mt-4 rounded p-3" style={{ background: C.warnBg, border: `1px solid #EAD3A2` }}>
                  {res.warnings.map((w, i) => (
                    <div key={i} style={{ fontSize: 12.5, color: C.warn }}>
                      ⚠ {w}
                    </div>
                  ))}
                </div>
              )}
              {res.perFloor.some((p) => p.singleExitOK) && (
                <p style={{ fontSize: 12, color: C.muted, marginTop: 10 }}>
                  {t("提示：本建筑 ≤2 层且有楼层人数 ≤60、面积在 Table 3.4.2.1 限值内，若疏散距离 ≤25 m，该楼层理论上可只设 1 个出口")} <Ref k="EXITS" />{t("；本工具仍按 2 部楼梯计算。")}
                </p>
              )}
            </Panel>

            {/* 每部楼梯 */}
            <Panel id="stairs" className="rounded-lg p-5" title={t("每部楼梯")} sub={t("宽度取各服务楼层最大值，尺寸按最不利楼层")}>
              <div className="overflow-x-auto">
                <table className="w-full" style={{ fontSize: 12.5, borderCollapse: "collapse", fontVariantNumeric: "tabular-nums" }}>
                  <thead>
                    <tr style={{ color: C.muted, textAlign: "left" }}>
                      {[t("楼梯"), t("服务楼层"), t("控制楼层需求"), t("最小宽度"), t("设计净宽"), t("楼层平台深"), inp.stairType === "dogleg" ? t("中间平台深") : t("直跑平台深"), t("梯段长"), t("梯间内净 (宽×长)"), t("梯间外包")].map((h) => (
                        <th key={h} className="py-2 pr-3" style={{ borderBottom: `1px solid ${C.rule}`, fontWeight: 500 }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {res.stairs.map((st) => {
                      const g = st.geos.find((x) => x.L === st.govLevel);
                      const innerW = inp.stairType === "dogleg" ? 2 * st.W + inp.adv.gap : st.W;
                      return (
                        <tr key={st.k} style={{ borderBottom: `1px solid ${C.rule}` }}>
                          <td className="py-2 pr-3" style={{ fontWeight: 700 }}>#{st.k}</td>
                          <td className="py-2 pr-3">
                            L{res.lvl0}–L{st.top}
                            {st.top < inp.nFloors && <span style={{ color: C.muted }}>{t("（裙房梯）")}</span>}
                          </td>
                          <td className="py-2 pr-3">
                            L{st.govW}: {fmt(res.perFloor[st.govW - 1].wReq)} ÷ {res.c[st.govW]} = {fmt(st.wReqStair)} mm <Ref k="HALF" />
                          </td>
                          <td className="py-2 pr-3">
                            {fmt(st.minW)} <Ref art={st.minWSrc} k="MINW" />
                          </td>
                          <td className="py-2 pr-3" style={{ fontWeight: 700, color: C.accent }}>
                            {fmt(st.W)} {st.midHandrail && <Ref art={t("需中间扶手 3.4.6.5.(3)")} k="HAND" />}
                          </td>
                          <td className="py-2 pr-3">
                            {fmt(inp.stairType === "dogleg" ? g.Lf : g.Lend)} <Ref k={inp.adv.doorPos === "end" ? "DOOR750" : "DOOR300"} />
                          </td>
                          <td className="py-2 pr-3">
                            {fmt(inp.stairType === "dogleg" ? g.Lm : g.Lmid)} <Ref k="LAND" />
                          </td>
                          <td className="py-2 pr-3">
                            {fmt(g.flightRun)} <span style={{ color: C.muted }}>L{g.L}</span>
                          </td>
                          <td className="py-2 pr-3">
                            {inp.stairType === "dogleg" ? `${fmt(innerW)} × ${fmt(st.L)}` : t("{0}（单梯道）× {1}", [fmt(st.W), fmt(st.L)])}
                          </td>
                          <td className="py-2 pr-3">{inp.stairType === "dogleg" ? `${fmt(innerW + 2 * inp.wall)} × ${fmt(st.L + 2 * inp.wall)}` : t("见梯井")}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {inp.stairType === "scissor" && (
                <div className="mt-3" style={{ fontSize: 12.5 }}>
                  {base.shafts.map((sh, i) => (
                    <div key={i} className="py-1">
                      {t("梯井")} {i + 1}{t("：")}{sh.stairs.map((s) => `#${s.k}`).join(" + ")} {t("→ 内净")} {fmt(sh.innerW)} × {fmt(sh.innerL)}{t("，外包")} {fmt(sh.innerW + 2 * inp.wall)} × {fmt(sh.innerL + 2 * inp.wall)} mm
                      {sh.stairs.length === 2 && (
                        <span style={{ color: C.muted }}>
                          {" "}
                          {t("· 中间隔墙")} {fmt(inp.adv.centerWall)} {t("mm，烟密封、耐火极限 ≥ 楼板")} <Ref k="SCISSOR" />
                        </span>
                      )}
                    </div>
                  ))}
                  <p style={{ color: C.muted, marginTop: 6 }}>
                    {scissorRelax ? (
                      <>
                        {t("本项目为全住宅、≤6 层、建筑面积 ≤600 m²：两出口门间距不必超过 4.5 m，梯道间设连续气密屏障")} <Ref k="DIST45" />{t("（温哥华 2026-01-20 新增条款）。")}
                      </>
                    ) : (
                      <>
                        {t("出口门间距按 3.4.2.3.(1)：≥ 楼层最大对角线的 1/2（有公共走道时不必超过 9 m）")}<Ref k="DIST" />{t("；仅全住宅 ≤6 层且建筑面积 ≤600 m² 可放宽至 4.5 m")} <Ref k="DIST45" />{t("。")}
                      </>
                    )}
                    {" "}{t("VBBL 2019 对 5–6 层木结构剪刀梯的禁令已于 2026-01 删除")} <Ref k="WOOD" />{t("。")}
                  </p>
                </div>
              )}
            </Panel>

            {/* 逐层表 */}
            <Panel id="perFloor" className="rounded-lg p-5" title={t("逐层校核")} sub={t("需求宽度 = 人数 × 每人毫米数；提供宽度 = 本层楼梯净宽之和")}>
              <div className="overflow-x-auto">
                <table className="w-full" style={{ fontSize: 12.5, borderCollapse: "collapse", fontVariantNumeric: "tabular-nums" }}>
                  <thead>
                    <tr style={{ color: C.muted, textAlign: "left" }}>
                      {[t("层"), t("用途"), t("面积"), t("人数（依据）"), t("mm/人"), t("需求宽度"), t("楼梯"), t("提供宽度"), t("踢面"), t("跑 / 中间平台"), t("净高")].map((h) => (
                        <th key={h} className="py-2 pr-3" style={{ borderBottom: `1px solid ${C.rule}`, fontWeight: 500 }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[...res.perFloor].reverse().map((p) => {
                      const cnt = res.c[p.level] || 0;
                      const provided = p.counted ? res.stairs.slice(0, cnt).reduce((s, st) => s + st.W, 0) : 0;
                      const okW = provided >= p.wReq;
                      return (
                        <tr key={p.level} style={{ borderBottom: `1px solid ${C.rule}`, color: p.counted ? C.ink : C.muted }}>
                          <td className="py-1.5 pr-3" style={{ fontWeight: 700 }}>L{p.level}</td>
                          <td className="py-1.5 pr-3" style={{ maxWidth: 170, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={p.use.label}>
                            {p.use.label.split(" ")[0]}
                          </td>
                          <td className="py-1.5 pr-3">{fmt(p.area)} m²</td>
                          <td className="py-1.5 pr-3">
                            <strong>{p.ol}</strong> <span style={{ color: C.muted, fontSize: 11 }}>{p.olSrc}</span>
                          </td>
                          <td className="py-1.5 pr-3">{p.mmpp}</td>
                          <td className="py-1.5 pr-3">{p.counted ? `${fmt(p.wReq)} mm` : t("外门出口")}</td>
                          <td className="py-1.5 pr-3">{p.counted ? t("{0} 部", [cnt]) : t("{0} 部贯通", [cnt])}</td>
                          <td className="py-1.5 pr-3" style={{ color: p.counted ? (okW ? C.ok : C.err) : C.muted }}>
                            {p.counted ? `${fmt(provided)} mm ${okW ? "✓" : "✗"}` : "—"}
                          </td>
                          <td className="py-1.5 pr-3">
                            {p.risers} × {p.riser.toFixed(1)}
                          </td>
                          <td className="py-1.5 pr-3">
                            {p.flights} / {p.flights - 1}
                            <span style={{ color: C.muted, fontSize: 11 }}> ({p.flightRisers.join("+")})</span>
                            {p.capGoverns && <span style={{ color: C.warn, fontSize: 11 }}> {t("级数上限")}</span>}
                            {p.headroomFix === "adjusted" && <span style={{ color: C.accent, fontSize: 11 }}> {t("已按净高调整")}</span>}
                            {p.flights % 2 === 1 && <span style={{ color: C.muted, fontSize: 11 }}> {t("平台换端")}</span>}
                          </td>
                          <td className="py-1.5 pr-3" style={{ color: p.headroom >= 2050 && p.headroomFlight >= 2050 ? C.ok : C.err }}>
                            {fmt(Math.min(p.headroom, p.headroomFlight))}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="mt-3 flex flex-wrap gap-2" style={{ fontSize: 11.5, color: C.muted }}>
                <span>
                  {t("人数")} <Ref k="OL" />
                </span>
                <span>
                  {t("mm/人")} <Ref k="MMPP" /> <Ref k="MMPPB" />
                </span>
                <span>
                  {t("踢面")} <Ref k="TREAD" /> <Ref k="R3" />
                </span>
                <span>
                  {t("跑数")} <Ref k="RISE37" />
                </span>
                <span>
                  {t("净高")} <Ref k="HEAD" />
                </span>
              </div>
            </Panel>

            {/* 图纸 */}
            <Panel id="drawings" className="rounded-lg p-5" title={t("楼梯间平面与剖面")} sub={t("示意性布置，尺寸为内净 / 外包 mm")}>
              <div className="flex flex-wrap items-center gap-4 mb-4" style={{ fontSize: 12.5 }}>
                <label className="flex items-center gap-2">
                  {t("梯间")}
                  <select value={shaftIdx} onChange={(e) => setSel({ ...sel, shaft: Number(e.target.value), level: null, secStart: null })} className="rounded px-2 py-1" style={{ border: `1px solid ${C.rule}`, background: C.panel }}>
                    {base.shafts.map((sh, i) => (
                      <option key={i} value={i}>
                        {inp.stairType === "dogleg" ? t("楼梯 #{0}（L{1}–L{2}）", [sh.stairs[0].k, res.lvl0, sh.stairs[0].top]) : t("梯井 {0}：{1}", [i + 1, sh.stairs.map((s) => "#" + s.k).join("+")])}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-2">
                  {t("平面楼层")}
                  <select value={level} onChange={(e) => setSel({ ...sel, level: Number(e.target.value) })} className="rounded px-2 py-1" style={{ border: `1px solid ${C.rule}`, background: C.panel }}>
                    {shaft.stairs[0].storeyLevels.map((L) => (
                      <option key={L} value={L}>
                        L{L} → L{L + 1}
                        {L === defaultLevel ? t("（控制层）") : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-2">
                  {t("剖面起始层")}
                  <select value={secStart} onChange={(e) => setSel({ ...sel, secStart: Number(e.target.value) })} className="rounded px-2 py-1" style={{ border: `1px solid ${C.rule}`, background: C.panel }}>
                    {Array.from({ length: Math.max(1, inp.nFloors - 2) }, (_, i) => i + 1).map((L) => (
                      <option key={L} value={L}>
                        L{L} – L{Math.min(inp.nFloors, L + 2)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="grid gap-6" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))" }}>
                <div className="rounded p-3" style={{ border: `1px solid ${C.rule}`, background: C.canvasBg }}>
                  <PlanSVG res={res} inp={inp} shaftIdx={shaftIdx} level={level} />
                  <p style={{ fontSize: 11.5, color: C.muted, margin: "8px 0 0" }}>
                    {t("门开向楼梯间")} <Ref k="SWING" />{t("；门前缘距踢面 ≥300")} <Ref k="DOOR300" />{t("；门扇摆动后平台保留 ≥750")} <Ref k="DOOR750" />{t("；扶手凸出 ≤100 不计入净宽")} <Ref k="DOOR750" />{t("。")}
                  </p>
                </div>
                <div className="rounded p-3" style={{ border: `1px solid ${C.rule}`, background: C.canvasBg }}>
                  <SectionSVG res={res} inp={inp} shaftIdx={shaftIdx} secStart={secStart} />
                  <p style={{ fontSize: 11.5, color: C.muted, margin: "8px 0 0" }}>
                    {t("每跑垂直高度 ≤3 700")} <Ref k="RISE37" />{t("；踢面 125–180、踏面 ≥280")} <Ref k="TREAD" />{t("；扶手 865–1 070")} <Ref k="HAND" />{t("；护栏 ≥1 070")} <Ref k="GUARD" />{t("；楼梯间墙耐火极限 ≥ 楼板（45 min – 2 h）")}<Ref k="FRR" />{t("。")}
                  </p>
                </div>
              </div>
            </Panel>

            {/* 出口门 */}
            <Panel id="doors" className="rounded-lg p-5" title={t("出口门位置核查")} sub={t("门沿疏散方向开入楼梯间；铰链靠侧墙、门闩朝梯间中央")}>
              {(() => {
                const st = shaft.stairs[0];
                const a = inp.adv;
                const door = st.door || { persons: 0, clearReq: 800, openingReq: 850, leaves: 1, leafW: a.doorLeaf, opening: a.doorLeaf, clear: a.doorLeaf - JAMB, leafMax: a.doorLeafMax || 1220 };
                const leaf = door.leafW; // 一扇的宽度 = 摆动半径
                const opening = door.opening; // 门洞总宽（两扇时含两扇）
                const hinge = a.doorHinge || "wall";
                const isEnd = a.doorPos === "end";
                const isDog = inp.stairType === "dogleg";
                const Lf = isDog ? st.geos[0].Lf : st.geos[0].Lend;
                const bandW = isDog ? shaft.innerW : st.W;
                const reach = hinge === "wall" ? leaf + JAMB : leaf;
                const rows = [];
                rows.push({
                  k: "DOORW",
                  req: t("门口净宽 ≥ max(800, 人数 × 6.1 mm)"),
                  val: t("{0} 人 × 6.1 → 需净宽 {1}；本方案 {2} 扇 × {3} = 门洞 {4}，净宽约 {5}", [Math.ceil(door.persons), fmt(door.clearReq), door.leaves, fmt(leaf), fmt(opening), fmt(door.clear)]),
                  ok: door.clear >= door.clearReq,
                });
                rows.push({
                  k: "MAXLEAF",
                  req: t("单扇 ≤ {0}（设计上限，超过自动分两扇）", [fmt(door.leafMax)]),
                  val: door.leaves === 2 ? t("单扇需 {0} > {1}，已分为两扇各 {2}", [fmt(door.openingReq), fmt(door.leafMax), fmt(leaf)]) + (door.overflow ? t("，两扇仍超上限，需另设门洞或放宽上限") : "") : t("单扇 {0}", [fmt(leaf)]),
                  ok: !door.overflow,
                });
                if (door.leaves === 2) rows.push({ k: "LEAF610", req: t("多扇出口门任一扇 ≥610"), val: t("每扇 {0}", [fmt(leaf)]), ok: leaf >= 610 });
                if (door.landingBase != null) {
                  const base = door.landingBase;
                  rows.push({
                    k: "DOOR750",
                    req: t("门的摆动不侵占通行范围：楼梯只需平台 {0}，门不该把它顶得更深（否则分扇）", [fmt(base)]),
                    val:
                      door.splitReason === "swing"
                        ? t("单扇需平台 {0} > {1} → 已分两扇各 {2}，平台回到 {3}", [fmt(door.doorMinSingle), fmt(base), fmt(leaf), fmt(Lf)])
                        : door.intrudes
                          ? door.swingTry
                            ? t("门需平台 {0} > {1}；分两扇每扇只有 {2} < {3} 不实用，保持单扇、平台加深到 {4}", [fmt(door.doorMinSingle), fmt(base), fmt(door.swingTry.leafW), fmt(SWING_SPLIT_MIN_LEAF), fmt(Lf)])
                            : t("门需平台 {0} > {1}，平台加深到 {2}", [fmt(door.doorMinSingle), fmt(base), fmt(Lf)])
                          : t("平台 {0} 由楼梯决定，门不侵占", [fmt(Lf)]),
                    ok: !door.intrudes,
                    soft: door.intrudes,
                  });
                }
                rows.push({ k: "SWING", req: t("沿疏散方向开启、绕竖轴转动"), val: t("由楼层开入楼梯间平台"), ok: true });
                rows.push({ k: "LAND", req: t("门开向楼梯处须有平台，深度 ≥ 梯宽"), val: t("平台深 {0} ≥ {1}", [fmt(Lf), fmt(st.W)]), ok: Lf >= st.W });
                if (isEnd) {
                  rows.push({ k: "DOOR300", req: t("门扇摆动弧线最远处距首级踢面 ≥300"), val: `${fmt(Lf)} − ${fmt(reach)} = ${fmt(Lf - reach)}`, ok: Lf - reach >= 300 });
                  if (hinge === "wall") {
                    rows.push({ k: "DOOR750", req: t("门开启后不削减平台所需宽度、任意位置剩余 ≥750"), val: t("开启后贴侧墙，横向剩余 {0}", [fmt(bandW - JAMB - 50)]), ok: bandW - JAMB - 50 >= 750 });
                    rows.push({ k: "HANDEXT", req: t("贴墙门扇避开该侧扶手 300 mm 水平延伸段"), val: `${fmt(Lf)} − 300 − ${fmt(reach)} = ${fmt(Lf - 300 - reach)}`, ok: Lf - 300 - reach >= 0 });
                  } else {
                    rows.push({ k: "DOOR750", req: t("门扇 90° 开启后平台剩余深度 ≥750"), val: `${fmt(Lf)} − ${fmt(leaf)} = ${fmt(Lf - leaf)}`, ok: Lf - leaf >= 750 });
                  }
                  const latchWall = hinge === "wall" ? bandW - JAMB - opening : (bandW - opening) / 2;
                  rows.push({ k: "SIGN", req: t("门闩侧墙面可放楼层号牌（距门 ≤300）"), val: t("门闩侧墙面 {0}", [fmt(latchWall)]), ok: latchWall >= 300 });
                  rows.push({ k: "ACC", req: t("若为无障碍通路上的门：开向侧门闩旁净空 ≥600"), val: t("门闩侧 {0}", [fmt(latchWall)]), ok: latchWall >= 600, soft: true });
                } else {
                  rows.push({ k: "DOOR300", req: t("门在侧墙：门扇及摆动弧线距首级踢面 ≥300"), val: t("平台深 {0} ≥ 门洞 {1} + 300", [fmt(Lf), fmt(opening)]), ok: Lf >= opening + 300 });
                }
                const accClear = door.leaves === 1 ? door.clear : leaf - JAMB; // 两扇门按一扇的净宽算无障碍通行
                rows.push({ k: "ACC", req: t("若为无障碍通路上的门：门洞净宽 ≥850（两扇门按一扇）"), val: t("门扇 {0} − 门框约 50 ≈ {1}", [fmt(leaf), fmt(accClear)]), ok: accClear >= 850, soft: true });
                return (
                  <div>
                    <table className="w-full" style={{ fontSize: 12.5, borderCollapse: "collapse" }}>
                      <thead>
                        <tr style={{ color: C.muted, textAlign: "left" }}>
                          {[t("条文"), t("要求"), t("本方案"), t("结果")].map((h) => (
                            <th key={h} className="py-1.5 pr-3" style={{ fontWeight: 600, borderBottom: `1px solid ${C.rule}` }}>
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r, i) => (
                          <tr key={i} style={{ borderBottom: `1px solid ${C.rule}` }}>
                            <td className="py-1.5 pr-3">
                              <Ref k={r.k} />
                            </td>
                            <td className="py-1.5 pr-3">{r.req}</td>
                            <td className="py-1.5 pr-3" style={{ fontVariantNumeric: "tabular-nums" }}>{r.val}</td>
                            <td className="py-1.5 pr-3" style={{ color: r.ok ? C.ok : r.soft ? C.warn : C.err, fontWeight: 600 }}>
                              {r.ok ? "✓" : r.soft ? t("△ 视适用性") : "✗"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p style={{ fontSize: 11.5, color: C.muted, margin: "10px 0 0", lineHeight: 1.6 }}>
                      {t("位置建议：门贴下行梯段一侧的侧墙，铰链在侧墙侧、门闩朝梯间中央。进门后直行即到下行梯段顶部，不穿越在上行梯段底部转向的下楼人流；门扇开启后贴墙，不占用平台净深，因此平台深度只需满足 ≥ 梯宽")} <Ref k="LAND" /> {t("和门扇弧线距踢面 ≥300")} <Ref k="DOOR300" />
                      {isEnd && hinge === "wall" ? t("（本方案 {0}，若改为居中开启则需 ≥ {1}）", [fmt(Lf), fmt(leaf + 750)]) : ""}
                      {t("。门闩朝中央同时为楼层号牌")} <Ref k="SIGN" /> {t("和门闩侧净空")} <Ref k="ACC" /> {t("留出墙面；居中布置时两侧都只有")} {fmt((bandW - leaf) / 2)} {t("mm。规范只给出上述定量限制，没有规定门必须在端墙的哪个位置。")}
                    </p>
                  </div>
                );
              })()}
            </Panel>

            {/* 三维 */}
            <Panel id="model3d" className="rounded-lg p-5" title={t("楼梯三维模型")} sub={t("按上方计算结果自动生成的实体模型，颜色区分楼梯编号")}>
              <div className="flex flex-wrap items-center gap-4 mb-3" style={{ fontSize: 12.5 }}>
                <span style={{ color: C.muted }}>{t("梯间同上（")}{inp.stairType === "dogleg" ? t("楼梯 #{0}", [shaft.stairs[0].k]) : t("梯井 {0}", [shaftIdx + 1])}{t("）")}</span>
                <label className="flex items-center gap-2">
                  {t("起始层")}
                  <select value={clamp(v3.from, 1, Math.max(1, inp.nFloors - 1))} onChange={(e) => setV3({ ...v3, from: Number(e.target.value) })} className="rounded px-2 py-1" style={{ border: `1px solid ${C.rule}`, background: C.panel }}>
                    {Array.from({ length: Math.max(1, inp.nFloors - 1) }, (_, i) => i + 1).map((L) => (
                      <option key={L} value={L}>
                        L{L}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex items-center gap-2">
                  {t("显示层数")}
                  <Seg
                    options={[
                      { value: 3, label: t("3 层") },
                      { value: 6, label: t("6 层") },
                      { value: 999, label: t("全部") },
                    ]}
                    value={v3.count}
                    onChange={(v) => setV3({ ...v3, count: v })}
                  />
                </label>
              </div>
              <Stair3D res={res} inp={inp} shaftIdx={shaftIdx} fromLevel={clamp(v3.from, 1, Math.max(1, inp.nFloors - 1))} nLevels={v3.count} />
              {/* 1.1：Rhino 连接——把当前梯井整栋高度的实体（跟上面三维模型同一份 buildSolids 数据）发到本机 Rhino 里烘焙 */}
            </Panel>

            {/* Rhino 连接（1.1）：独立面板——读 Rhino 里画好的核心筒 / 墙体并校核，或把算出的楼梯实体发过去 */}
            <Panel id="rhino" title="Rhino" sub={t("读取 Rhino 图层上画好的核心筒长方体 / 墙体；也可把算出的楼梯实体发到 Rhino")}>
              <RhinoPanel
                C={C}
                buildModel={() => buildSolids(res, inp, shaftIdx, 1, 999)}
                shaftLabel={inp.stairType === "dogleg" ? t("楼梯 #{0}", [shaft.stairs[0].k]) : t("梯井 {0}", [shaftIdx + 1])}
                zones={res.zones}
                levels={inp.floors.reduce((acc, f, i) => {
                  acc.push({ level: i + 1, z: i === 0 ? 0 : acc[i - 1].z + (Number(inp.floors[i - 1].ffh) || 0) });
                  return acc;
                }, [])}
                floorEnd={res.floorEnd}
                stairType={inp.stairType}
                doorReq={{ width: shaft.stairs[0].door ? shaft.stairs[0].door.opening : inp.adv.doorLeaf, height: 2030 }}
                shaftKeys={res.zones.length ? res.zones[0].shafts.map((_, si) => `0-${si}`) : []}
                onPlanFromRhino={(level, p) => rhinoHist.setPlan((prev) => ({ ...prev, byLevel: { ...prev.byLevel, [level]: p }, selected: level }))}
              />
            </Panel>

            {/* Rhino 平面图：每层一张（地板 / 墙按层、核心筒全局），按楼层按钮切换，直接在这里开热力图（与 /plan 页互相独立） */}
            <Panel id="rhinoPlan" title={t("Rhino 平面图 · 疏散距离热力图")} sub={t("由上方 Rhino 面板各层的「生成平面图」填入；与平面图工具页的平面图互相独立")}>
              {rhinoLevels.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 mb-3" data-testid="rhino-plan-levels">
                  <span style={{ color: C.muted, fontSize: 12.5 }}>{t("楼层")}</span>
                  {rhinoLevels.map((L) => (
                    <button key={L} type="button" onClick={() => selectRhinoLevel(L)} className="rounded px-3 py-1" style={{ border: `1px solid ${L === rhinoSelected ? C.accent : C.rule}`, background: L === rhinoSelected ? C.accent : C.panel, color: L === rhinoSelected ? C.onAccent : C.ink, fontWeight: 600, fontSize: 12.5 }} data-testid="rhino-plan-level" data-level={L} data-selected={L === rhinoSelected ? "1" : "0"}>
                      L{L}
                    </button>
                  ))}
                  {rhinoSelected != null && (
                    <button type="button" onClick={() => removeRhinoLevel(rhinoSelected)} className="rounded px-2 py-1" style={{ border: `1px solid ${C.rule}`, color: C.muted, fontSize: 11.5 }} title={t("删掉当前这一层的平面图（Rhino 面板里重新生成即可恢复）")} data-testid="rhino-plan-remove">
                      {t("删掉 L{0} 的平面图", [rhinoSelected])}
                    </button>
                  )}
                </div>
              )}
              {rhinoPlan ? (
                <PlanEditor key={rhinoSelected} res={res} inp={inp} plan={rhinoPlan} setPlan={setRhinoPlan} scissorRelax={scissorRelax} undoPlan={rhinoHist.undo} redoPlan={rhinoHist.redo} canUndoPlan={rhinoHist.canUndo} canRedoPlan={rhinoHist.canRedo} initialHeatmap />
              ) : (
                <div style={{ color: C.muted, fontSize: 12.5 }} data-testid="rhino-plan-empty">
                  {t("还没有内容：先在上方 Rhino 面板连接 Rhino，选好核心筒 / 门的图层和每层的地板 / 墙图层，点该层的「生成平面图」。")}
                </div>
              )}
            </Panel>

            {/* 核心筒尺寸 */}
            <Panel id="coreSize" className="rounded-lg p-5" title={t("楼梯间核心筒尺寸")} sub={t("按各区段楼梯数量，梯间并列共用墙体")}>
              <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
                {res.zones.map((z, i) => (
                  <div key={i} className="rounded p-4" style={{ border: `1px solid ${C.rule}` }}>
                    <div style={{ fontWeight: 700, marginBottom: 6 }}>
                      L{z.from}
                      {z.to !== z.from ? `–L${z.to}` : ""} · {z.count} {t("部楼梯")}
                    </div>
                    <div style={{ fontSize: 24, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                      {(z.totW / 1000).toFixed(2)} × {(z.totL / 1000).toFixed(2)} m
                    </div>
                    <div style={{ fontSize: 12, color: C.muted, fontVariantNumeric: "tabular-nums" }}>
                      {t("宽向")} {fmt(z.totW)} × {t("梯段方向")} {fmt(z.totL)} {t("mm，")}{z.area.toFixed(1)} m²{t("（全部梯间排成一排）")}
                    </div>
                    {z.shafts.length > 1 && (
                      <div style={{ fontSize: 12, marginTop: 6, fontVariantNumeric: "tabular-nums" }} data-testid="core-combos">
                        <div style={{ color: C.muted }}>{t("分到几个核心筒时，每个核心筒放：")}</div>
                        {Array.from({ length: z.shafts.length - 1 }, (_, k) => k + 1).map((k) => {
                          const pick = [...z.shafts].sort((a, b) => b.innerW - a.innerW).slice(0, k);
                          const w = pick.reduce((s, sh) => s + sh.innerW, 0) + (k + 1) * inp.wall;
                          const l = Math.max(...z.shafts.map((sh) => sh.innerL)) + 2 * inp.wall;
                          return (
                            <div key={k}>
                              {k} {inp.stairType === "dogleg" ? t("部楼梯") : t("个梯井")}：{fmt(w)} × {fmt(l)}
                            </div>
                          );
                        })}
                      </div>
                    )}
                    <ul style={{ fontSize: 12, marginTop: 8, paddingLeft: 16, color: C.ink }}>
                      {z.shafts.map((sh, j) => (
                        <li key={j} style={{ fontVariantNumeric: "tabular-nums" }}>
                          {inp.stairType === "dogleg" ? t("楼梯 #{0}", [sh.stairs[0].k]) : t("梯井 {0}（{1}）", [j + 1, sh.stairs.map((s) => "#" + s.k).join("+")])}{t("：内净")} {fmt(sh.innerW)} × {fmt(sh.innerL)}
                        </li>
                      ))}
                      <li>{t("墙厚")} {fmt(inp.wall)} × {z.shafts.length + 1} {t("道（宽向）、× 2 道（长向）")}</li>
                    </ul>
                  </div>
                ))}
              </div>
              <p style={{ fontSize: 12, color: C.muted, marginTop: 10 }}>
                {t("宽向：Σ 梯间内净宽 + (梯间数 + 1) × 墙厚；梯段方向：最长梯间内净长 + 2 × 墙厚。大数字是全部梯间排成一排的外包；实际分到几个核心筒时按上面“每个核心筒放 k 部”的尺寸。两个出口的间距还需满足")} <Ref k="DIST" />{t("，疏散距离满足")} <Ref k="TRAVEL" />{t("。")}
              </p>
            </Panel>

            {/* 条文 */}
            <Panel id="code" className="rounded-lg p-5" title={t("引用条文")} sub={t("VBBL 2025 Book I Division B；条号与 BCBC 2024 / NBC 2020 相同者标为三级一致")}>
              <div className="grid gap-2">
                {CODE.map((c) => (
                  <div key={c.key} className="grid gap-3 py-2" style={{ gridTemplateColumns: "minmax(150px, 200px) minmax(220px, 1fr) minmax(130px, 190px)", borderBottom: `1px solid ${C.rule}`, fontSize: 12.5 }}>
                    <div>
                      <div style={{ fontWeight: 600, color: C.accent }}>{c.art}</div>
                      <div style={{ color: C.muted, fontSize: 11.5 }}>{c.title}</div>
                    </div>
                    <div>
                      <div>{c.text}</div>
                      <div style={{ color: C.muted, fontSize: 11.5, marginTop: 2 }}>{t("本工具用途：")}{c.use}</div>
                    </div>
                    <div style={{ fontSize: 11.5, color: c.level === "VBBL" ? C.accent : c.level === "BCBC" ? C.warn : c.level === "USER" ? C.err : C.muted }}>{LEVEL_LABEL[c.level]}</div>
                  </div>
                ))}
              </div>
              <p style={{ fontSize: 11.5, color: C.muted, marginTop: 12 }}>
                {t("本工具为方案阶段估算，不替代注册专业人员的规范审查。人员荷载、疏散距离、出口间距、防烟（3.2.6 高层）与无障碍要求需结合平面图复核；温哥华项目请以 VBBL 2025 最新合订本及 Chief Building Official 解释为准。")}
              </p>
            </Panel>
          </main>
        </div>
      </div>

      {/* 平面布置 / 疏散距离校核 —— 现在是独立页面（/plan），跟这里通过 localStorage 联动：
          在这边点"确认并计算"后，平面图页面里的核心筒预览会自动用最新结果重画 */}
      <div className="px-4 pb-8">
        <Panel id="planLink" className="rounded-lg p-5" title={t("平面布置与疏散距离校核")} sub={t("核心筒摆放、走廊墙体、门、楼层边界与疏散路径校核 —— 独立页面，可单独打开/收藏")}>
          <p style={{ fontSize: 12.5, color: C.muted, marginBottom: 10 }}>
            {t("这里确认过的楼梯计算结果会自动同步给平面图工具（同一浏览器打开即可，不需要手动导入）。")}
          </p>
          <a
            href={otherAppHref("plan")}
            target="_blank"
            rel="noopener"
            className="inline-flex items-center gap-2 rounded px-4 py-2"
            style={{ background: C.accent, color: C.onAccent, fontWeight: 600, textDecoration: "none" }}
          >
            {t("在新标签页打开平面图工具 →")}
          </a>
        </Panel>
      </div>
    </div>
  );
}

export { compute, buildSolids, defaultFloors, doglegGeometry, USES, PlanEditor, usePlanHistory, C, FONT, H2 };
