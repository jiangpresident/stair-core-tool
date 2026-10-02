// 网页 ↔ Rhino 的客户端（纯逻辑，不碰 DOM，Node 里可单测：scripts/test-rhino-bridge.mjs）。
// Rhino 那边跑的是 rhino/StairCoreBridge.py（项目根目录），在本机 127.0.0.1:8790 监听：
//   GET /health → Rhino 版本 / 当前文档 / 文档单位；POST /bake → 把盒子列表烘焙成 Brep。
// 几何不在这里算：调用方把 buildSolids() 的结果（毫米、z 朝上的盒子列表，跟网页三维模型同一份数据）传进来，
// 这里只负责整理成 payload 和收发。
import { t } from "../i18n.js";

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
