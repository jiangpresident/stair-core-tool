// 计算器三维模型区下方的 "Rhino" 面板（1.1）。两件事，按用户的实际需求排序：
//   1. 从 Rhino 读核心筒：用户在 Rhino 里自己画好核心筒的长方体（放在某个图层），这里读出它的长 × 宽（含转角、
//      位置、高度，毫米），和计算出来的各区段核心筒外包尺寸比，告诉用户够不够、差多少。
//   2. 发送到 Rhino：把当前梯井整栋高度的楼梯实体（跟上方三维模型同一份盒子数据）烘焙进 Rhino（次要功能，默认收起）。
//   0. 连到哪个文件：扫描 8790–8799 列出所有运行了桥接脚本的 Rhino 窗口让用户选；也能让当前窗口打开最近文件 / 浏览打开别的 .3dm。
// Rhino 那边跑的是 rhino/StairCoreBridge.py（127.0.0.1:8790，被占就顺延）。
import { useEffect, useMemo, useState } from "react";
import { t } from "../i18n.js";
import LayerTreePicker from "./LayerTree.jsx";
import { buildRhinoPayload, sendToRhino, listRhinoLayers, readRhinoCores, readRhinoWalls, wallsToPlan, readRhinoFloors, floorToPlan, matchCoreDoors, coresToPlan, checkCoreBoxes, scanRhino, listRecentFiles, openRhinoFile, openRhinoFileDialog, RHINO_SCRIPT_PATH, RHINO_NOT_RUNNING_HINT, RHINO_PORTS } from "./rhinoBridge.js";

const PORT_KEY = "stair-core:rhino-port"; // 上次选的 Rhino 窗口（端口），下次连接优先用它
const readSavedPort = () => {
  try {
    const v = Number(localStorage.getItem(PORT_KEY));
    return RHINO_PORTS.includes(v) ? v : null;
  } catch {
    return null;
  }
};
const LEVEL_CFG_KEY = "stair-core:rhino-levels"; // 每层选的地板 / 墙图层和折叠状态
const readLevelCfgs = () => {
  try {
    const v = JSON.parse(localStorage.getItem(LEVEL_CFG_KEY) || "null");
    if (Array.isArray(v) && v.length) return v.map((c, i) => ({ level: Number(c.level) || i + 1, wallLayer: c.wallLayer || "Walls", floorLayer: c.floorLayer || "Floors", open: c.open !== false }));
  } catch {
    /* 坏数据就用默认 */
  }
  return [{ level: 1, wallLayer: "Walls", floorLayer: "Floors", open: true }];
};
const savePort = (port) => {
  try {
    localStorage.setItem(PORT_KEY, String(port));
  } catch {
    /* 隐私模式等 */
  }
};

const KIND_OPTIONS = [
  { key: "step", label: "踏步" },
  { key: "landing", label: "平台" },
  { key: "slab", label: "楼板" },
  { key: "wall", label: "梯间墙" },
  { key: "centerWall", label: "剪刀梯中间隔墙" },
  { key: "door", label: "门" },
];
const fmtMm = (v) => Math.round(v).toLocaleString("en-US");
const fmtM = (v) => (v / 1000).toFixed(2);

export default function RhinoPanel({ C, buildModel, shaftLabel, zones, levels = [], floorEnd = {}, stairType = "dogleg", doorReq = { width: 950, height: 2030 }, shaftKeys = [], onPlanFromRhino = null }) {
  const [status, setStatus] = useState(null); // null | {checking} | {ok, rhino, doc, docPath, units, port, baseUrl} | {ok:false, error}
  // 连到哪个 Rhino 窗口 / 哪个文件
  const [instances, setInstances] = useState([]); // scanRhino 的结果
  const [recent, setRecent] = useState([]); // 那个窗口的最近文件
  const [switching, setSwitching] = useState(false);
  const [fileMsg, setFileMsg] = useState(null);
  // 读核心筒
  const [layers, setLayers] = useState([]);
  const [layer, setLayer] = useState("Core");
  const [reading, setReading] = useState(false);
  const [rawBoxes, setRawBoxes] = useState(null); // /cores 读回来的长方体（毫米）
  const [perCore, setPerCore] = useState(1); // 校核目标：一个核心筒放几个梯井
  const [readError, setReadError] = useState(null);
  // 校核结果：目标变了不用重新读 Rhino
  const cores = useMemo(() => (rawBoxes ? checkCoreBoxes(rawBoxes, zones, { perCore }) : null), [rawBoxes, zones, perCore]);
  const maxShafts = Math.max(1, ...(zones || []).map((z) => (z.shafts ? z.shafts.length : 1)));
  const shaftUnit = (zones || []).some((z) => (z.shafts || []).some((s) => s.stairs && s.stairs.length > 1)) ? t("个梯井（剪刀梯一井两梯）") : t("部楼梯");
  // 核心筒的门
  const [doorLayer, setDoorLayer] = useState("Core Doors");
  const [doorsReading, setDoorsReading] = useState(false);
  const [rawDoors, setRawDoors] = useState(null);
  const [doorsError, setDoorsError] = useState(null);
  const doorCheck = useMemo(() => (rawBoxes && rawDoors ? matchCoreDoors(rawBoxes, rawDoors, { levels, floorEnd, stairType, reqWidth: doorReq.width, reqHeight: doorReq.height }) : null), [rawBoxes, rawDoors, levels, floorEnd, stairType, doorReq.width, doorReq.height]);
  // 按楼层读地板 / 墙（核心筒和门是全局的，不分层）：每层自己的图层选择（记在 localStorage）、读取结果和生成状态
  const [levelCfgs, setLevelCfgs] = useState(() => readLevelCfgs());
  const [levelData, setLevelData] = useState({}); // {level: {walls, floors, wallsError, floorsError, wallsReading, floorsReading, building, msg}}
  const maxLevel = Math.max(1, levels.length || 1);
  const updateLevel = (level, patch) => setLevelCfgs((prev) => prev.map((c) => (c.level === level ? { ...c, ...patch } : c)));
  const setLD = (level, patch) => setLevelData((prev) => ({ ...prev, [level]: { ...(prev[level] || {}), ...patch } }));
  const addLevel = () =>
    setLevelCfgs((prev) => {
      const next = (prev.length ? prev[prev.length - 1].level : 0) + 1;
      if (next > maxLevel) return prev;
      const last = prev[prev.length - 1];
      return [...prev, { level: next, wallLayer: last ? last.wallLayer : "Walls", floorLayer: last ? last.floorLayer : "Floors", open: true }];
    });
  const removeLevel = () => setLevelCfgs((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
  useEffect(() => {
    try {
      localStorage.setItem(LEVEL_CFG_KEY, JSON.stringify(levelCfgs.map(({ level, wallLayer, floorLayer, open }) => ({ level, wallLayer, floorLayer, open }))));
    } catch {
      /* 隐私模式等 */
    }
  }, [levelCfgs]);
  // 发送
  const [sendOpen, setSendOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null);
  const [kinds, setKinds] = useState(() => new Set(["step", "landing", "slab", "wall", "centerWall", "door"]));
  const [replace, setReplace] = useState(true);
  const [name, setName] = useState("StairCore");

  const online = !!(status && status.ok);
  const baseUrl = online ? status.baseUrl : undefined;
  const opts = baseUrl ? { baseUrl } : {};
  const canOpen = !!(online && Array.isArray(status.features) && status.features.includes("open"));

  /* 连上某个实例后：拉图层（默认选像核心筒的那层）和最近文件，清掉上一个文件的校核结果 */
  const loadDoc = async (inst) => {
    const o = { baseUrl: inst.baseUrl };
    setRawBoxes(null);
    setReadError(null);
    try {
      const ls = await listRhinoLayers(o);
      setLayers(ls);
      // 自动选图层：当前选的层不在列表里、或者当前层上没有对象而候选层上有，就换成候选（名字含关键词且有对象的优先）
      const keepOrPick = (cur, re, set, fallbackAny = false) => {
        const pick = ls.find((l) => re.test(l.path) && l.objects > 0) || ls.find((l) => re.test(l.path)) || (fallbackAny ? ls.find((l) => l.objects > 0) : null);
        const curL = ls.find((l) => l.path === cur);
        if (pick && (!curL || (curL.objects === 0 && pick.objects > 0))) set(pick.path);
      };
      keepOrPick(layer, /core|核心/i, setLayer, true);
      // 每层的地板 / 墙图层：当前选的层不在列表里或没对象时，换成名字匹配且有对象的层
      const pickFor = (cur, re) => {
        const pick = ls.find((l) => re.test(l.path) && l.objects > 0) || ls.find((l) => re.test(l.path));
        const curL = ls.find((l) => l.path === cur);
        return pick && (!curL || (curL.objects === 0 && pick.objects > 0)) ? pick.path : cur;
      };
      setLevelCfgs((prev) => prev.map((c) => ({ ...c, wallLayer: pickFor(c.wallLayer, /wall|墙/i), floorLayer: pickFor(c.floorLayer, /floor|slab|地板|楼板/i) })));
      keepOrPick(doorLayer, /door|门/i, setDoorLayer);
      setRawDoors(null);
      setDoorsError(null);
    } catch (err) {
      setReadError(err && err.message ? err.message : String(err));
    }
    setLevelData({});
    if (Array.isArray(inst.features) && inst.features.includes("recent")) {
      try {
        setRecent(await listRecentFiles(o));
      } catch {
        setRecent([]);
      }
    } else setRecent([]);
  };
  const useInstance = async (inst) => {
    setStatus(inst);
    savePort(inst.port);
    await loadDoc(inst);
  };
  const connect = async () => {
    setStatus({ checking: true });
    setFileMsg(null);
    const found = await scanRhino();
    setInstances(found);
    if (!found.length) {
      setStatus({ ok: false, error: RHINO_NOT_RUNNING_HINT, offline: true });
      return;
    }
    // 优先上次选过的窗口，否则端口最小的那个
    const saved = readSavedPort();
    const inst = found.find((i) => i.port === saved) || found[0];
    await useInstance(inst);
  };
  const selectInstance = (port) => {
    const inst = instances.find((i) => i.port === Number(port));
    if (inst) {
      setFileMsg(null);
      useInstance(inst);
    }
  };
  /* 换文件：result 是 /open 或 /open-dialog 的返回；成功就把状态里的文件信息换掉并重拉图层 */
  const afterOpen = async (r) => {
    if (r.cancelled) {
      setFileMsg({ text: t("已取消（文件没有变）"), muted: true });
      return;
    }
    const inst = { ...status, doc: r.doc, docPath: r.docPath, units: r.units };
    setStatus(inst);
    setInstances((prev) => prev.map((i) => (i.port === inst.port ? inst : i)));
    setFileMsg({ text: r.alreadyOpen ? t("这个文件本来就是当前文件") : t("已在 Rhino 里打开 {0}", [r.docPath || r.doc]) });
    await loadDoc(inst);
  };
  const openPath = async (path) => {
    if (!path) return;
    setSwitching(true);
    setFileMsg(null);
    try {
      await afterOpen(await openRhinoFile(path, opts));
    } catch (err) {
      setFileMsg({ text: err && err.message ? err.message : String(err), error: true });
    } finally {
      setSwitching(false);
    }
  };
  const browse = async () => {
    setSwitching(true);
    setFileMsg({ text: t("对话框已在 Rhino 窗口里弹出，请到 Rhino 里选文件…"), muted: true });
    try {
      await afterOpen(await openRhinoFileDialog(opts));
    } catch (err) {
      setFileMsg({ text: err && err.message ? err.message : String(err), error: true });
    } finally {
      setSwitching(false);
    }
  };
  const read = async () => {
    setReading(true);
    setReadError(null);
    try {
      setRawBoxes(await readRhinoCores(layer, opts));
    } catch (err) {
      setReadError(err && err.message ? err.message : String(err));
    } finally {
      setReading(false);
    }
  };
  /* 读门：门也是长方体，用 /cores 的最小外接矩形接口读；核心筒还没读过就顺便读一次 */
  const readDoors = async () => {
    setDoorsReading(true);
    setDoorsError(null);
    try {
      if (!rawBoxes) setRawBoxes(await readRhinoCores(layer, opts));
      setRawDoors(await readRhinoCores(doorLayer, opts));
    } catch (err) {
      setDoorsError(err && err.message ? err.message : String(err));
    } finally {
      setDoorsReading(false);
    }
  };
  const endName = (e) => (e === 0 ? "A" : "B");
  // "L2（9.00 m）"：楼层号 + 括号里该层楼面相对 L1 的标高
  const lvLabel = (L) => {
    const f = levels.find((x) => x.level === L);
    return f ? `L${L}（${fmtM(f.z)} m）` : `L${L}`;
  };
  const errText = (err) => (err && err.message ? err.message : String(err));
  const cfgOf = (level) => levelCfgs.find((c) => c.level === level);
  const readLevelWalls = async (level) => {
    const cfg = cfgOf(level);
    if (!cfg) return;
    setLD(level, { wallsReading: true, wallsError: null });
    try {
      setLD(level, { walls: await readRhinoWalls(cfg.wallLayer, opts) });
    } catch (err) {
      setLD(level, { wallsError: errText(err) });
    } finally {
      setLD(level, { wallsReading: false });
    }
  };
  const readLevelFloors = async (level) => {
    const cfg = cfgOf(level);
    if (!cfg) return;
    setLD(level, { floorsReading: true, floorsError: null });
    try {
      setLD(level, { floors: await readRhinoFloors(cfg.floorLayer, opts) });
    } catch (err) {
      setLD(level, { floorsError: errText(err) });
    } finally {
      setLD(level, { floorsReading: false });
    }
  };
  /* 生成某一层的平面图：这一层的地板（第一块封闭的当楼层边界）+ 这一层的墙 + 全局的核心筒（门用这一层的门），交给计算器页的「Rhino 平面图」面板 */
  const buildLevel = async (level) => {
    const cfg = cfgOf(level);
    if (!cfg || !onPlanFromRhino) return;
    setLD(level, { building: true, msg: null });
    try {
      // 每次都从 Rhino 重新读核心筒和门（不用缓存）：用户在 Rhino 里挪了核心筒，再点生成就要是新位置
      const [fl, wl, cs, ds] = await Promise.all([readRhinoFloors(cfg.floorLayer, opts), readRhinoWalls(cfg.wallLayer, opts), readRhinoCores(layer, opts), readRhinoCores(doorLayer, opts).catch(() => [])]);
      setLD(level, { floors: fl, walls: wl });
      setRawBoxes(cs);
      setRawDoors(ds);
      const dc = matchCoreDoors(cs, ds, { levels, floorEnd, stairType, reqWidth: doorReq.width, reqHeight: doorReq.height });
      const slab = fl.floors.find((f) => f.closed && f.outline && f.outline.length >= 3);
      let plan = null; // 每次从空白开始，不叠加
      if (slab) plan = floorToPlan(slab.outline, plan);
      plan = wallsToPlan(wl.walls, plan);
      plan = coresToPlan(cs, dc, plan, { shaftKeys, level });
      onPlanFromRhino(level, plan);
      const noDoor = plan.cores.filter((c) => c.doorLevel == null).length;
      setLD(level, {
        msg: {
          text: t("已生成 {0}：{1} 段墙、{2} 个核心筒{3}{4}{5}。到下方「Rhino 平面图」面板切到这一层查看。", [
            lvLabel(level),
            plan.walls.length,
            plan.cores.length,
            slab ? t("、楼层边界 {0} 个顶点", [plan.boundary.length]) : t("、没有封闭的地板（没有楼层边界，热力图会铺满画布）"),
            wl.skipped ? t("；跳过 {0} 个非直线对象", [wl.skipped]) : "",
            noDoor ? t("；{0} 个核心筒在这一层没有门，门位用了默认位置", [noDoor]) : "",
          ]),
        },
      });
    } catch (err) {
      setLD(level, { msg: { text: errText(err), error: true } });
    } finally {
      setLD(level, { building: false });
    }
  };
  const send = async () => {
    setSending(true);
    setResult(null);
    try {
      const model = buildModel();
      const payload = buildRhinoPayload(model, { name: name.trim() || "StairCore", kinds: [...kinds], replace });
      if (!payload.boxes.length) throw new Error(t("没有可发送的几何（勾选至少一种构件）"));
      const r = await sendToRhino(payload, opts);
      setResult({ text: t("已发送到 Rhino：{0} 个实体，图层 {1}（文档单位 {2}）", [r.added, (r.layers || []).length, r.units]) });
    } catch (err) {
      setResult({ text: err && err.message ? err.message : String(err), error: true });
    } finally {
      setSending(false);
    }
  };
  const toggleKind = (k) =>
    setKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  return (
    <div style={{ fontSize: 12.5 }} data-testid="rhino-panel">
      {/* 连接状态 */}
      <div className="flex flex-wrap items-center gap-2">
        <span style={{ fontWeight: 600 }}>Rhino</span>
        <button type="button" onClick={connect} disabled={!!(status && status.checking)} className="rounded px-3 py-1" style={{ border: `1px solid ${C.accent}`, color: C.accent, fontWeight: 600 }} data-testid="rhino-connect">
          {status && status.checking ? t("连接中…") : online ? t("重新检测") : t("连接 Rhino")}
        </button>
        {status && !status.checking && (
          <span style={{ color: online ? C.ok : C.err }} data-testid="rhino-status">
            {online ? t("● 已连接 Rhino {0} · 文档 {1} · 单位 {2}", [status.rhino, status.doc, status.units]) : t("● 未连接")}
          </span>
        )}
      </div>
      {!status && <div className="mt-1" style={{ color: C.muted, fontSize: 11.5 }}>{t("在 Rhino 里把核心筒画成长方体（放在一个图层上），这里读出它的长 × 宽，和计算出的核心筒外包尺寸比对够不够。需要先在 Rhino 里运行一次桥接脚本。")}</div>}
      {status && !status.checking && !online && (
        <div className="mt-2" style={{ color: C.muted, fontSize: 11.5 }}>
          {status.error}
          {status.offline && (
            <div className="mt-1 flex flex-col gap-1">
              <div>{t("脚本路径：项目根目录 {0}。它只监听本机 127.0.0.1:8790，不联网；运行一次后一直在后台监听，直到关闭 Rhino。", [RHINO_SCRIPT_PATH])}</div>
              <div style={{ fontWeight: 600, color: C.ink }}>{t("省事的办法（二选一）：")}</div>
              <div>{t("① 用项目根目录的「启动 Rhino（带桥接）.bat」打开 Rhino，桥会随 Rhino 自动启动；")}</div>
              <div>
                {t("② 在 Rhino 选项 → 常规 → “每次 Rhino 启动时运行这些命令” 里加一行（点右边复制）：")}
                <code className="ml-1 px-1" style={{ background: C.tag, fontSize: 11 }} data-testid="rhino-startup-cmd">
                  _-RunPythonScript "…\{RHINO_SCRIPT_PATH.replace(/\//g, "\\")}"
                </code>
                <button
                  type="button"
                  className="ml-1 rounded px-2"
                  style={{ border: `1px solid ${C.rule}`, fontSize: 11 }}
                  onClick={() => {
                    const cmd = `_-RunPythonScript "${t("<项目文件夹>")}\\${RHINO_SCRIPT_PATH.replace(/\//g, "\\")}"`;
                    try {
                      navigator.clipboard.writeText(cmd);
                    } catch {
                      /* 不支持剪贴板就算了 */
                    }
                  }}
                >
                  {t("复制命令")}
                </button>
                <span className="ml-1">{t("把 {0} 换成本机的完整路径。", [t("<项目文件夹>")])}</span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 0. 连到哪个 Rhino 窗口 / 哪个文件 */}
      {online && (
        <div className="mt-3" data-testid="rhino-file">
          <div className="flex flex-wrap items-center gap-2">
            <span style={{ fontWeight: 600 }}>{t("文件")}</span>
            {instances.length > 1 ? (
              <select value={status.port} onChange={(e) => selectInstance(e.target.value)} className="rounded px-2 py-0.5" style={{ border: `1px solid ${C.rule}`, background: C.panel, maxWidth: 320 }} aria-label="Rhino window" data-testid="rhino-instance">
                {instances.map((i) => (
                  <option key={i.port} value={i.port}>
                    {i.doc || "Untitled"} · Rhino {String(i.rhino || "").split(".").slice(0, 2).join(".")} · :{i.port}
                  </option>
                ))}
              </select>
            ) : (
              <span style={{ fontFamily: "monospace" }} title={status.docPath || ""} data-testid="rhino-doc">
                {status.docPath || status.doc || "Untitled"}
              </span>
            )}
            {canOpen && (
              <>
                {recent.length > 0 && (
                  <select value="" onChange={(e) => openPath(e.target.value)} disabled={switching} className="rounded px-2 py-0.5" style={{ border: `1px solid ${C.rule}`, background: C.panel, maxWidth: 260 }} aria-label="Recent Rhino files" data-testid="rhino-recent">
                    <option value="">{t("最近文件…")}</option>
                    {recent.map((f) => (
                      <option key={f.path} value={f.path} title={f.path}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                )}
                <button type="button" onClick={browse} disabled={switching} className="rounded px-3 py-1" style={{ border: `1px solid ${C.accent}`, color: C.accent, fontWeight: 600 }} data-testid="rhino-browse">
                  {switching ? t("切换中…") : t("浏览其它文件…")}
                </button>
              </>
            )}
            {!canOpen && <span style={{ color: C.muted, fontSize: 11.5 }}>{t("要在这里换文件，请在 Rhino 里重新运行最新的 {0}", [RHINO_SCRIPT_PATH])}</span>}
          </div>
          {instances.length > 1 && status.docPath && (
            <div className="mt-1" style={{ color: C.muted, fontSize: 11, fontFamily: "monospace" }} data-testid="rhino-doc">
              {status.docPath}
            </div>
          )}
          <div className="mt-1" style={{ color: C.muted, fontSize: 11.5 }}>
            {instances.length > 1
              ? t("检测到 {0} 个运行了桥接脚本的 Rhino 窗口，在上面选连哪个；也可以让当前窗口换到别的文件。", [instances.length])
              : t("只检测到 1 个 Rhino 窗口。要连别的文件：在上面选最近文件或浏览（当前窗口会换文件，有未保存改动时 Rhino 会先问是否保存）；或者在另一个 Rhino 窗口里也运行一次桥接脚本，再点「重新检测」。")}
          </div>
          {fileMsg && (
            <div className="mt-1" style={{ color: fileMsg.error ? C.err : fileMsg.muted ? C.muted : C.ok, fontWeight: fileMsg.error || fileMsg.muted ? 400 : 600 }} data-testid="rhino-file-msg">
              {fileMsg.text}
            </div>
          )}
        </div>
      )}

      {/* 1. 从 Rhino 读核心筒 */}
      {online && (
        <div className="mt-3" data-testid="rhino-read">
          <div className="flex flex-wrap items-center gap-2">
            <span style={{ fontWeight: 600 }}>{t("从 Rhino 读取核心筒长方体")}</span>
            {/* 不能用 <label> 包：点树里的 ▸ 会触发 label 的激活行为、顺带点一下按钮把菜单关掉 */}
            <span className="flex items-center gap-1">
              {t("图层")}
              <LayerTreePicker layers={layers} value={layer} onChange={setLayer} C={C} />
            </span>
            <button type="button" onClick={read} disabled={reading} className="rounded px-3 py-1" style={{ background: reading ? C.rule : C.accent, color: reading ? C.muted : C.onAccent, fontWeight: 600 }} data-testid="rhino-read-btn">
              {reading ? t("读取中…") : t("读取并校核")}
            </button>
            <label className="flex items-center gap-1" title={t("校核目标：Rhino 里这一个长方体要装下几个梯井。4 部疏散梯通常分在几个核心筒里，不必一个核心筒装全部。")}>
              {t("每个核心筒放")}
              <select value={perCore} onChange={(e) => setPerCore(Number(e.target.value))} className="rounded px-2 py-0.5" style={{ border: `1px solid ${C.rule}`, background: C.panel }} aria-label="Shafts per core" data-testid="rhino-per-core">
                {Array.from({ length: maxShafts }, (_, i) => i + 1).map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
              {shaftUnit}
            </label>
            <span style={{ color: C.muted, fontSize: 11.5 }}>{t("认 Brep / 挤出体 / 网格 / 封闭矩形曲线；斜放的按最小外接矩形算；只读这一层，不含子图层")}</span>
          </div>
          {readError && <div className="mt-1" style={{ color: C.err }}>{readError}</div>}
          {cores && cores.length === 0 && <div className="mt-1" style={{ color: C.muted }}>{t("这个图层上没有可识别的长方体")}</div>}
          {cores && cores.length > 0 && (
            <div className="mt-2 flex flex-col gap-2" data-testid="rhino-cores">
              {cores.map((c, i) => (
                <div key={c.id} className="rounded p-2" style={{ border: `1px solid ${c.fitsAll ? C.ok : C.err}`, background: c.fitsAll ? C.okBg : C.errBg }} data-testid="rhino-core-row">
                  <div className="flex flex-wrap items-center gap-3">
                    <span style={{ fontWeight: 700 }}>
                      {c.fitsAll ? "✓" : "✗"} {c.name || t("长方体 {0}", [i + 1])}
                    </span>
                    <span style={{ fontVariantNumeric: "tabular-nums" }}>
                      {fmtMm(c.L)} × {fmtMm(c.W)} mm（{fmtM(c.L)} × {fmtM(c.W)} m）
                    </span>
                    <span style={{ color: C.muted, fontSize: 11.5 }}>
                      {t("高 {0} mm · 转角 {1}° · 中心 ({2}, {3}) m · {4}", [fmtMm(c.height), c.angleDeg.toFixed(1), fmtM(c.centerX), fmtM(c.centerY), c.type])}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-col gap-0.5" style={{ fontSize: 11.5 }}>
                    {c.perZone.map((z) => (
                      <div key={z.from + "-" + z.to} style={{ color: z.fits ? C.ok : C.err }} data-testid="rhino-zone-check">
                        <span style={{ fontWeight: 600 }}>
                          L{z.from}
                          {z.to !== z.from ? `–L${z.to}` : ""}
                        </span>
                        （{t("区段共 {0} 部楼梯、{1} 个梯井", [z.count, z.n])}）：
                        {t("放 {0} 个需 {1} × {2}（宽向 × 梯段方向）", [z.target, fmtMm(z.reqWidth), fmtMm(z.reqLength)])}
                        {z.fits ? t("，够（长边余 {0}，短边余 {1}）", [fmtMm(z.dL), fmtMm(z.dW)]) : t("，不够（长边 {0}，短边 {1}）", [(z.dL >= 0 ? "+" : "") + fmtMm(z.dL), (z.dW >= 0 ? "+" : "") + fmtMm(z.dW)])}
                        <span style={{ color: C.muted }}>{t("；这个长方体最多放 {0} / {1} 个梯井（{2} 部楼梯）", [z.capacity, z.n, z.capacityStairs])}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              <div style={{ color: C.muted, fontSize: 11 }}>{t("比对规则：一个核心筒放 k 个梯井需要 宽向 = 最宽 k 个梯井内净宽之和 + (k+1) × 墙厚，梯段方向 = 最长梯井内净长 + 2 × 墙厚；长方体的长边对所需的长边、短边对短边（横放竖放都算）。各种组合的尺寸见下方“楼梯间核心筒尺寸”。")}</div>
            </div>
          )}
        </div>
      )}

      {/* 1a. 核心筒的门：贴在核心筒长方体表面的小长方体 → 哪层、哪端、宽高是否满足 */}
      {online && (
        <div className="mt-3" data-testid="rhino-doors">
          <div className="flex flex-wrap items-center gap-2">
            <span style={{ fontWeight: 600 }}>{t("核心筒的门")}</span>
            <span className="flex items-center gap-1">
              {t("图层")}
              <LayerTreePicker layers={layers} value={doorLayer} onChange={setDoorLayer} C={C} />
            </span>
            <button type="button" onClick={readDoors} disabled={doorsReading} className="rounded px-3 py-1" style={{ background: doorsReading ? C.rule : C.accent, color: doorsReading ? C.muted : C.onAccent, fontWeight: 600 }} data-testid="rhino-doors-btn">
              {doorsReading ? t("读取中…") : t("读取门并校核")}
            </button>
            <span style={{ color: C.muted, fontSize: 11.5 }}>{t("门画成紧贴核心筒长方体表面的小长方体（厚度不限）；按门底标高判断楼层（门底须落在楼面上，偏差 > 50 mm 报错）；以最低一层的门为参照，按各层楼层平台在哪一端判断门应在同侧还是对侧；宽 ≥ 设计门扇 {0}、高 ≥ 2 030（3.4.3.4.(4)）", [fmtMm(doorReq.width)])}</span>
          </div>
          {doorsError && <div className="mt-1" style={{ color: C.err }}>{doorsError}</div>}
          {doorCheck && (
            <div className="mt-2 flex flex-col gap-2" data-testid="rhino-doors-result">
              {doorCheck.cores.map((c, i) => (
                <div key={c.core.id || i} className="rounded p-2" style={{ border: `1px solid ${c.ok ? C.ok : C.err}`, background: c.ok ? C.okBg : C.errBg }} data-testid="rhino-doors-core">
                  <div style={{ fontWeight: 700 }}>
                    {c.ok ? "✓" : "✗"} {c.core.name || t("长方体 {0}", [i + 1])}
                    <span style={{ color: C.muted, fontWeight: 400, fontSize: 11.5 }}>
                      {" · "}
                      {c.doors.length ? t("{0} 个门；参照 {1} 的门在 {2} 端", [c.doors.length, lvLabel(c.refLevel), endName(c.refEnd)]) : t("没有贴在这个核心筒上的门")}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-col gap-0.5" style={{ fontSize: 11.5 }}>
                    {c.doors.map((d, j) => (
                      <div key={d.id || j} style={{ color: d.ok ? C.ok : C.err }} data-testid="rhino-door-row" data-ok={d.ok ? "1" : "0"}>
                        {d.ok ? "✓" : "✗"} {d.level != null ? lvLabel(d.level) : t("楼层不明（底标高 {0} m）", [fmtM(d.dz)])}
                        {d.name ? ` ${d.name}` : ""}：
                        {d.level != null && !d.zOk ? t("门底在 {0} m，比楼面{1} {2} mm ✗；", [fmtM(d.dz), d.zOffset > 0 ? t("高") : t("低"), fmtMm(Math.abs(d.zOffset))]) : ""}
                        {t("在 {0} 端", [endName(d.end)])}
                        {d.face === "side" ? t("（长边）") : t("（端墙）")}
                        {d.endOk === false ? t("，应在 {0} 端（L{1} 的楼层平台在另一端）✗", [endName(d.expectedEnd), d.level]) : d.endOk === true ? t("，端正确") : ""}
                        {t("；宽 {0}", [fmtMm(d.doorWidth)])}
                        {d.widthOk ? " ✓" : t(" < {0} ✗", [fmtMm(doorReq.width)])}
                        {t("，高 {0}", [fmtMm(d.doorHeight)])}
                        {d.heightOk ? " ✓" : t(" < {0} ✗", [fmtMm(doorReq.height)])}
                      </div>
                    ))}
                    {c.missingLevels.length > 0 && <div style={{ color: C.err }}>{t("✗ 缺门：{0}", [c.missingLevels.map(lvLabel).join("、")])}</div>}
                  </div>
                </div>
              ))}
              {doorCheck.unattached.length > 0 && (
                <div style={{ color: C.warn || C.err, fontSize: 11.5 }} data-testid="rhino-doors-unattached">
                  {t("⚠ {0} 个门没有贴在任何核心筒表面上（请把门长方体贴到核心筒长方体的面上）：{1}", [doorCheck.unattached.length, doorCheck.unattached.map((d) => d.name || "—").join("、")])}
                </div>
              )}
              <div style={{ color: C.muted, fontSize: 11 }}>{t("A / B 端只是核心筒长度方向的两头（按长方体的局部坐标），不是左右；楼层由门底标高相对核心筒底的高度和各层层高推出。剪刀梯暂不判断端。")}</div>
            </div>
          )}
        </div>
      )}

      {/* 1b. 按楼层：每层一个折叠块（地板图层 + 墙体图层 + 生成这一层的平面图）；核心筒和门用上面全局的 */}
      {online && (
        <div className="mt-3" data-testid="rhino-levels">
          <div className="flex flex-wrap items-center gap-2">
            <span style={{ fontWeight: 600 }}>{t("按楼层读取地板 / 墙体")}</span>
            <button type="button" onClick={removeLevel} disabled={levelCfgs.length <= 1} className="rounded" style={{ width: 26, height: 26, border: `1px solid ${C.rule}`, background: C.panel, color: levelCfgs.length <= 1 ? C.muted : C.ink, fontWeight: 700 }} title={t("去掉最后一层")} data-testid="rhino-level-minus">
              −
            </button>
            <span style={{ fontVariantNumeric: "tabular-nums" }} data-testid="rhino-level-count">
              {t("{0} 层", [levelCfgs.length])}
            </span>
            <button type="button" onClick={addLevel} disabled={levelCfgs.length >= maxLevel} className="rounded" style={{ width: 26, height: 26, border: `1px solid ${C.rule}`, background: C.panel, color: levelCfgs.length >= maxLevel ? C.muted : C.ink, fontWeight: 700 }} title={t("加一层")} data-testid="rhino-level-plus">
              +
            </button>
            <span style={{ color: C.muted, fontSize: 11.5 }}>{t("最多到计算器里的层数（{0} 层）；核心筒和门不分层，用上面的设置", [maxLevel])}</span>
          </div>
          {levelCfgs.map((cfg) => {
            const d = levelData[cfg.level] || {};
            return (
              <details key={cfg.level} open={cfg.open} onToggle={(e) => updateLevel(cfg.level, { open: e.currentTarget.open })} className="mt-2 rounded p-2" style={{ border: `1px solid ${C.rule}` }} data-testid="rhino-level" data-level={cfg.level}>
                <summary style={{ cursor: "pointer", fontWeight: 600 }}>{lvLabel(cfg.level)}</summary>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span>{t("地板图层")}</span>
                  <LayerTreePicker layers={layers} value={cfg.floorLayer} onChange={(v) => updateLevel(cfg.level, { floorLayer: v })} C={C} />
                  <button type="button" onClick={() => readLevelFloors(cfg.level)} disabled={d.floorsReading} className="rounded px-3 py-1" style={{ border: `1px solid ${C.accent}`, color: C.accent, fontWeight: 600 }} data-testid="rhino-level-floors-btn">
                    {d.floorsReading ? t("读取中…") : t("读取地板")}
                  </button>
                  <span style={{ color: C.muted, fontSize: 11.5 }}>{t("只认封闭多重曲面（closed polysurface）；第一块封闭的当这一层的楼层边界")}</span>
                </div>
                {d.floorsError && <div className="mt-1" style={{ color: C.err }}>{d.floorsError}</div>}
                {d.floors && d.floors.floors.length === 0 && <div className="mt-1" style={{ color: C.muted }}>{t("这个图层上没有对象")}</div>}
                {d.floors && d.floors.floors.length > 0 && (
                  <div className="mt-1 flex flex-col gap-1" style={{ fontSize: 11.5 }}>
                    {d.floors.floors.map((f, i) => (
                      <div key={f.id + "-" + i} style={{ color: f.closed ? C.ok : C.err }} data-testid="rhino-floor-row" data-closed={f.closed ? "1" : "0"}>
                        {f.closed ? "✓" : "✗"} {f.name || t("地板 {0}", [i + 1])} <span style={{ color: C.muted }}>· {f.type}</span>
                        {f.closed
                          ? t("，面积 {0} m²，{1} 个顶点{2}", [Number.isFinite(f.area) ? f.area.toFixed(1) : "—", Math.max(0, f.outline.length - 1), f.holes ? t("，{0} 个洞口", [f.holes]) : ""])
                          : t("，不是封闭多重曲面：{0}。请在 Rhino 里把地板做成封闭实体（Cap 封口，或把轮廓线 Extrude 成 Solid）", [f.reason || "—"])}
                      </div>
                    ))}
                  </div>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span>{t("墙体图层")}</span>
                  <LayerTreePicker layers={layers} value={cfg.wallLayer} onChange={(v) => updateLevel(cfg.level, { wallLayer: v })} C={C} />
                  <button type="button" onClick={() => readLevelWalls(cfg.level)} disabled={d.wallsReading} className="rounded px-3 py-1" style={{ border: `1px solid ${C.accent}`, color: C.accent, fontWeight: 600 }} data-testid="rhino-level-walls-btn">
                    {d.wallsReading ? t("读取中…") : t("读取墙体")}
                  </button>
                  <span style={{ color: C.muted, fontSize: 11.5 }}>{t("实体墙在墙底以上 500 mm 处剖切，门洞处自然断开；直线 / 多段线按段算；弧线跳过")}</span>
                </div>
                {d.wallsError && <div className="mt-1" style={{ color: C.err }}>{d.wallsError}</div>}
                {d.walls && (
                  <div className="mt-1" style={{ fontSize: 11.5 }}>
                    <span style={{ fontWeight: 600 }}>{t("读到 {0} 段墙", [d.walls.walls.length])}</span>
                    {d.walls.skipped ? <span style={{ color: C.muted }}>{t("（跳过 {0} 个非直线对象）", [d.walls.skipped])}</span> : null}
                    {d.walls.walls.length > 0 && (
                      <details className="mt-1">
                        <summary style={{ cursor: "pointer", color: C.muted }}>{t("明细")}</summary>
                        <div className="overflow-x-auto mt-1">
                          <table style={{ fontSize: 11.5, borderCollapse: "collapse", fontVariantNumeric: "tabular-nums" }}>
                            <thead>
                              <tr style={{ color: C.muted, textAlign: "left" }}>
                                <th className="pr-3 pb-1">#</th>
                                <th className="pr-3 pb-1">{t("名称 / 类型")}</th>
                                <th className="pr-3 pb-1">{t("长度 m")}</th>
                                <th className="pr-3 pb-1">{t("厚度 mm")}</th>
                                <th className="pr-3 pb-1">{t("起点 → 终点（m，Rhino 坐标）")}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {d.walls.walls.map((w, i) => (
                                <tr key={w.id + "-" + i} style={{ borderTop: `1px solid ${C.rule}` }} data-testid="rhino-wall-row">
                                  <td className="pr-3 py-1" style={{ color: C.muted }}>{i + 1}</td>
                                  <td className="pr-3 py-1">
                                    {w.name || "—"} <span style={{ color: C.muted }}>· {w.type}</span>
                                  </td>
                                  <td className="pr-3 py-1">{(Math.hypot(w.x2 - w.x1, w.y2 - w.y1) / 1000).toFixed(2)}</td>
                                  <td className="pr-3 py-1">{Number.isFinite(w.thickness) && w.thickness > 0 ? fmtMm(w.thickness) : <span style={{ color: C.muted }}>{t("默认")}</span>}</td>
                                  <td className="pr-3 py-1" style={{ color: C.muted }}>
                                    ({fmtM(w.x1)}, {fmtM(w.y1)}) → ({fmtM(w.x2)}, {fmtM(w.y2)})
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </details>
                    )}
                  </div>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button type="button" onClick={() => buildLevel(cfg.level)} disabled={d.building || !onPlanFromRhino} className="rounded px-3 py-1" style={{ background: d.building ? C.rule : C.accent, color: d.building ? C.muted : C.onAccent, fontWeight: 600 }} data-testid="rhino-level-build">
                    {d.building ? t("读取中…") : t("生成 {0} 的平面图（地板 + 墙 + 核心筒）", [`L${cfg.level}`])}
                  </button>
                  {d.msg && (
                    <span style={{ color: d.msg.error ? C.err : C.ok, fontWeight: 600, fontSize: 11.5 }} data-testid="rhino-level-msg">
                      {d.msg.text}
                    </span>
                  )}
                </div>
              </details>
            );
          })}
          <div className="mt-1" style={{ color: C.muted, fontSize: 11 }}>{t("每层的平面图放在下方「Rhino 平面图 · 疏散距离热力图」面板，用那里的楼层按钮切换；核心筒在每层都出现，门按该层识别到的门定位。")}</div>
        </div>
      )}

      {/* 2. 发送到 Rhino（次要，默认收起） */}
      {online && (
        <details className="mt-3" open={sendOpen} onToggle={(e) => setSendOpen(e.currentTarget.open)}>
          <summary style={{ cursor: "pointer", color: C.muted, fontSize: 12 }}>{t("反向：把计算出的楼梯实体发送到 Rhino（可选）")}</summary>
          <div className="flex flex-wrap items-center gap-2 mt-2">
            <input value={name} onChange={(e) => setName(e.target.value)} className="rounded px-2 py-0.5" style={{ border: `1px solid ${C.rule}`, width: 120, fontFamily: "monospace" }} title={t("Rhino 里的图层名（StairCore::<名字>）")} aria-label="Rhino layer name" />
            <button type="button" onClick={send} disabled={sending} className="rounded px-3 py-1" style={{ background: sending ? C.rule : C.ok, color: sending ? C.muted : C.onAccent, fontWeight: 600 }} data-testid="rhino-send">
              {sending ? t("发送中…") : t("发送到 Rhino：{0}（整栋）", [shaftLabel])}
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-3 mt-2" style={{ color: C.muted, fontSize: 11.5 }}>
            {KIND_OPTIONS.map((k) => (
              <label key={k.key} className="flex items-center gap-1" style={{ cursor: "pointer" }}>
                <input type="checkbox" checked={kinds.has(k.key)} onChange={() => toggleKind(k.key)} />
                {t(k.label)}
              </label>
            ))}
            <label className="flex items-center gap-1" style={{ cursor: "pointer" }} title={t("再次发送时先删掉 Rhino 里同名图层下的上一批实体")}>
              <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
              {t("替换上一批")}
            </label>
          </div>
          {result && (
            <div className="mt-2" style={{ color: result.error ? C.err : C.ok, fontWeight: 600 }}>
              {result.text}
              <button type="button" onClick={() => setResult(null)} className="ml-1" style={{ textDecoration: "underline", fontWeight: 400 }}>
                {t("知道了")}
              </button>
            </div>
          )}
        </details>
      )}
    </div>
  );
}
