import { t } from "../i18n.js";
// 平面图工程文件（.stairplan.json）的保存 / 打开。
// 用户诉求：上传平面图、画好线之后能保存成文件（自定义路径），之后随时用"打开"拉出来继续。
// 文件内容 = 整个 plan（含底图 dataURL、比例、边界、核心筒、墙、门、路径、候选）+ 一点元数据。
// 纯逻辑部分（序列化 / 解析校验 / 默认值合并）不碰 DOM，Node 里可单测（scripts/test-plan-file.mjs）；
// 文件选择器那部分在下面，优先用 Chrome/Edge 的 File System Access API（能选保存路径、能覆盖保存同一个
// 文件），不支持的浏览器退回"下载到默认下载目录 / 用文件选择框打开"。

export const PLAN_FILE_FORMAT = "stair-core-plan";
export const PLAN_FILE_VERSION = 1;
export const PLAN_FILE_EXT = ".stairplan.json";

/* 跟 PlanApp 的 DEFAULT_PLAN 保持一致（PlanApp 直接 import 这份）。打开旧文件时缺的字段用这里补。 */
export const PLAN_DEFAULTS = {
  bgSrc: null,
  naturalW: 20000,
  naturalH: 15000,
  mmPerPx: 1,
  mode: "view",
  boundary: [],
  cores: [],
  walls: [],
  doors: [],
  paths: [],
  wallCandidates: [],
  doorCandidates: [],
  stairCandidates: [],
  drawingPathId: null,
  hasCorridor: true,
  nextId: 1,
  rhinoFrame: null, // 从 Rhino 导入过东西后记下的坐标基准 {x0, y0, margin}，让之后导入的墙 / 地板和已有的对得上位置
};

const ARRAY_FIELDS = ["boundary", "cores", "walls", "doors", "paths", "wallCandidates", "doorCandidates", "stairCandidates"];

export function serializePlan(plan, { name = "" } = {}) {
  // 存的时候一律回到浏览模式，不把"正在画墙/正在标定"这种瞬时状态写进文件
  const data = { ...PLAN_DEFAULTS, ...plan, mode: "view", drawingPathId: null };
  return JSON.stringify({ format: PLAN_FILE_FORMAT, version: PLAN_FILE_VERSION, savedAt: new Date().toISOString(), name, plan: data });
}

/* 解析 + 校验。返回 { plan, name, savedAt }；格式不对就抛中文错误（调用方显示给用户，不替换当前平面图）。 */
export function parsePlanFile(text) {
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(t("这不是一个有效的 JSON 文件"));
  }
  if (!j || typeof j !== "object") throw new Error(t("文件内容不是平面图工程"));
  // 容忍两种形状：带 format 包装的（本工具存的），或直接就是一个 plan 对象（比如从 localStorage 导出的）
  const raw = j.format === PLAN_FILE_FORMAT ? j.plan : j.walls && j.cores ? j : null;
  if (!raw || typeof raw !== "object") throw new Error(t("文件不是本工具保存的平面图工程（缺少 plan 数据）"));
  if (j.format === PLAN_FILE_FORMAT && typeof j.version === "number" && j.version > PLAN_FILE_VERSION) throw new Error(t("文件是更新版本（v{0}）保存的，当前工具只认到 v{1}", [j.version, PLAN_FILE_VERSION]));
  const plan = { ...PLAN_DEFAULTS, ...raw, mode: "view", drawingPathId: null };
  for (const k of ARRAY_FIELDS) if (!Array.isArray(plan[k])) plan[k] = [];
  if (plan.bgSrc != null && typeof plan.bgSrc !== "string") plan.bgSrc = null;
  if (!(Number.isFinite(plan.naturalW) && plan.naturalW > 0)) plan.naturalW = PLAN_DEFAULTS.naturalW;
  if (!(Number.isFinite(plan.naturalH) && plan.naturalH > 0)) plan.naturalH = PLAN_DEFAULTS.naturalH;
  if (!(Number.isFinite(plan.mmPerPx) && plan.mmPerPx > 0)) plan.mmPerPx = 1;
  // nextId 必须比所有已用 id 大，不然新加的东西会撞 id
  let maxId = 0;
  for (const k of ["cores", "walls", "doors", "paths", "wallCandidates", "doorCandidates", "stairCandidates"]) for (const o of plan[k]) if (o && Number.isFinite(o.id)) maxId = Math.max(maxId, o.id);
  if (!(Number.isFinite(plan.nextId) && plan.nextId > maxId)) plan.nextId = maxId + 1;
  return { plan, name: typeof j.name === "string" ? j.name : "", savedAt: typeof j.savedAt === "string" ? j.savedAt : null };
}

export function suggestFileName(name) {
  const base = (name || "").replace(/\.stairplan\.json$/i, "").replace(/\.json$/i, "").trim();
  const stamp = new Date().toISOString().slice(0, 10);
  return (base || t("平面图-{0}", [stamp])) + PLAN_FILE_EXT;
}

/* ---------- 浏览器部分 ---------- */
const PICKER_TYPES = [{ description: t("平面图工程"), accept: { "application/json": [".json"] } }];

/* 有些环境（Claude 桌面端的内置浏览器面板、受限的 webview、部分企业策略）暴露了 showSaveFilePicker
   却不允许 createWritable 真正写文件——用户实测报 "createWritable ... not allowed by the user agent"。
   遇到一次就在本次会话里记住，后面直接走下载回退，不再让用户白选一次路径。 */
const FS_BROKEN_KEY = "stair-core:fs-access-broken";
const fsAccessBroken = () => {
  try {
    return sessionStorage.getItem(FS_BROKEN_KEY) === "1";
  } catch {
    return false;
  }
};
const markFsAccessBroken = () => {
  try {
    sessionStorage.setItem(FS_BROKEN_KEY, "1");
  } catch {
    /* 记不住就算了，下次再回退一次 */
  }
};

export const supportsFilePicker = () => typeof window !== "undefined" && typeof window.showSaveFilePicker === "function" && typeof window.showOpenFilePicker === "function" && !fsAccessBroken();

function downloadText(text, fileName) {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------- 开发服务器端的"工程文件桥"（src/dev/planFileBridge.mjs） ----------
   开发服务器跑在用户自己的电脑上，能替浏览器弹 Windows 原生的另存为/打开对话框并直接写盘——这是在 Claude
   内置浏览器面板这类不让网页写文件的环境里"自选保存位置"的唯一办法，所以有桥就优先走桥。
   探测结果缓存一次（ping 不通 = 不是开发服务器，比如 dist-single 静态版）。 */
let bridgeProbe = null;
const abortError = () => Object.assign(new Error("cancelled"), { name: "AbortError" });
export function bridgeAvailable() {
  if (!bridgeProbe) {
    bridgeProbe =
      typeof fetch === "function"
        ? fetch("/__plan/ping", { cache: "no-store" })
            .then((r) => (r.ok ? r.json() : null))
            .then((j) => !!(j && j.ok && j.nativeDialog))
            .catch(() => false)
        : Promise.resolve(false);
  }
  return bridgeProbe;
}
async function bridgePost(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let j = null;
  try {
    j = await res.json();
  } catch {
    /* 非 JSON */
  }
  if (!res.ok) throw new Error((j && j.error) || t("服务器返回 {0}", [res.status]));
  if (j && j.cancelled) throw abortError();
  if (j && j.unsupported) throw Object.assign(new Error("unsupported"), { name: "UnsupportedError" });
  return j;
}

/* example 面板：列出 / 打开开发服务器配置的示例目录（项目根目录 "Saved Plans"）里的工程文件。只在有桥时可用。 */
/* 没有开发服务器时（GitHub Pages / 静态构建）的退路：构建脚本 scripts/copy-examples.mjs 把 Saved Plans 里的
   .json 和一份清单 index.json 放到站点的 examples/ 下，这里按 BASE_URL 去取。这样打开的示例没有磁盘路径，
   不会被覆盖保存（保存会走浏览器自己的方式）。 */
const staticExamplesBase = () => {
  const base = (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.BASE_URL) || "/";
  return (base.endsWith("/") ? base : base + "/") + "examples/";
};
export async function listExamples() {
  if (await bridgeAvailable()) {
    const res = await fetch("/__plan/examples", { cache: "no-store" });
    const j = await res.json().catch(() => null);
    if (!res.ok) throw new Error((j && j.error) || t("服务器返回 {0}", [res.status]));
    return j;
  }
  try {
    const res = await fetch(staticExamplesBase() + "index.json", { cache: "no-store" });
    if (!res.ok) return { files: [], dir: null, unavailable: true };
    const j = await res.json();
    return { files: Array.isArray(j.files) ? j.files : [], dir: null, static: true };
  } catch {
    return { files: [], dir: null, unavailable: true };
  }
}
export async function openExample(name) {
  if (await bridgeAvailable()) {
    const r = await bridgePost("/__plan/open-example", { name });
    const parsed = parsePlanFile(r.text);
    // 显示/关联的名字用实际文件名：文件内部记录的 name 是上次"另存为"时的名字，文件被改名/复制成示例后就过时了
    return { ...parsed, name: r.name || parsed.name, handle: null, path: r.path, viaBridge: true };
  }
  const res = await fetch(staticExamplesBase() + encodeURIComponent(name), { cache: "no-store" });
  if (!res.ok) throw new Error(t("示例文件不存在：{0}", [name]));
  const parsed = parsePlanFile(await res.text());
  return { ...parsed, name, handle: null, path: null, static: true };
}

/* 保存。优先级：开发服务器桥（系统对话框 + 直接写盘；有 path 且不是另存为就直接覆盖）→ 浏览器 File System
   Access API（handle 同理）→ 下载。返回 { handle, path, name, downloaded?, fallbackReason? }。
   用户在对话框里点取消会抛 AbortError，调用方当作"没保存"处理。 */
export async function savePlanFile(plan, { handle = null, path = null, saveAs = false, name = "" } = {}) {
  const text = serializePlan(plan, { name });
  if (await bridgeAvailable()) {
    try {
      const r = !saveAs && path ? await bridgePost("/__plan/write", { path, text }) : await bridgePost("/__plan/save-dialog", { suggestedName: suggestFileName(name), text });
      return { handle: null, path: r.path, name: r.name, viaBridge: true };
    } catch (err) {
      if (err && (err.name === "AbortError" || err.name !== "UnsupportedError")) throw err;
      // 平台不支持系统对话框（非 Windows）：往下走浏览器自己的方式
    }
  }
  if (supportsFilePicker()) {
    let h = !saveAs && handle ? handle : null;
    if (!h) h = await window.showSaveFilePicker({ suggestedName: suggestFileName(name), types: PICKER_TYPES });
    try {
      const w = await h.createWritable();
      await w.write(text);
      await w.close();
      return { handle: h, name: h.name };
    } catch (err) {
      if (err && err.name === "AbortError") throw err;
      // 选到了路径但不让写：这个环境的文件接口是坏的，改走下载，并记住
      markFsAccessBroken();
      const fileName = h && h.name ? h.name : suggestFileName(name);
      downloadText(text, fileName);
      return { handle: null, name: fileName, downloaded: true, fallbackReason: err && err.message ? err.message : String(err) };
    }
  }
  // 回退：浏览器不支持选路径（或上面已判定不让写），只能下载到默认下载目录
  const fileName = suggestFileName(name);
  downloadText(text, fileName);
  return { handle: null, name: fileName, downloaded: true };
}

/* 打开。返回 { plan, name, handle, path }；取消抛 AbortError。优先级同保存：桥 → 浏览器选择器 → 文件选择框。 */
export async function openPlanFile() {
  if (await bridgeAvailable()) {
    try {
      const r = await bridgePost("/__plan/open-dialog", {});
      const parsed = parsePlanFile(r.text);
      return { ...parsed, name: r.name || parsed.name, handle: null, path: r.path, viaBridge: true };
    } catch (err) {
      if (err && err.name !== "UnsupportedError") throw err;
    }
  }
  if (supportsFilePicker()) {
    let picked = null;
    try {
      picked = await window.showOpenFilePicker({ types: PICKER_TYPES, multiple: false });
    } catch (err) {
      if (err && err.name === "AbortError") throw err;
      markFsAccessBroken(); // 连打开选择器都不让用：这个环境的文件接口是坏的，退回普通文件选择框
      picked = null;
    }
    if (picked) {
      const [h] = picked;
      const file = await h.getFile();
      const parsed = parsePlanFile(await file.text());
      return { ...parsed, name: file.name || parsed.name, handle: h };
    }
  }
  const file = await new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = () => (input.files && input.files[0] ? resolve(input.files[0]) : reject(Object.assign(new Error("cancelled"), { name: "AbortError" })));
    input.click();
  });
  const parsed = parsePlanFile(await file.text());
  return { ...parsed, name: file.name || parsed.name, handle: null };
}

/* 不经过选择器、直接从一个 File 对象打开（拖拽文件进来时用） */
export async function readPlanFile(file) {
  const parsed = parsePlanFile(await file.text());
  return { ...parsed, name: file.name || parsed.name, handle: null };
}
