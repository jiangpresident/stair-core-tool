// 计算器三维模型区下方的 "Rhino" 面板（1.1）。两件事，按用户的实际需求排序：
//   1. 从 Rhino 读核心筒：用户在 Rhino 里自己画好核心筒的长方体（放在某个图层），这里读出它的长 × 宽（含转角、
//      位置、高度，毫米），和计算出来的各区段核心筒外包尺寸比，告诉用户够不够、差多少。
//   2. 发送到 Rhino：把当前梯井整栋高度的楼梯实体（跟上方三维模型同一份盒子数据）烘焙进 Rhino（次要功能，默认收起）。
//   0. 连到哪个文件：扫描 8790–8799 列出所有运行了桥接脚本的 Rhino 窗口让用户选；也能让当前窗口打开最近文件 / 浏览打开别的 .3dm。
// Rhino 那边跑的是 rhino/StairCoreBridge.py（127.0.0.1:8790，被占就顺延）。
import { useMemo, useState } from "react";
import { t } from "../i18n.js";
import LayerTreePicker from "./LayerTree.jsx";
import { loadPlan, savePlan, otherAppHref } from "../planBridge.js";
import { buildRhinoPayload, sendToRhino, listRhinoLayers, readRhinoCores, readRhinoWalls, wallsToPlan, readRhinoFloors, floorToPlan, matchCoreDoors, checkCoreBoxes, scanRhino, listRecentFiles, openRhinoFile, openRhinoFileDialog, RHINO_SCRIPT_PATH, RHINO_NOT_RUNNING_HINT, RHINO_PORTS } from "./rhinoBridge.js";

const PORT_KEY = "stair-core:rhino-port"; // 上次选的 Rhino 窗口（端口），下次连接优先用它
const readSavedPort = () => {
  try {
    const v = Number(localStorage.getItem(PORT_KEY));
    return RHINO_PORTS.includes(v) ? v : null;
  } catch {
    return null;
  }
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

export default function RhinoPanel({ C, buildModel, shaftLabel, zones, levels = [], floorEnd = {}, stairType = "dogleg", doorReq = { width: 950, height: 2030 } }) {
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
  // 读墙体
  const [wallLayer, setWallLayer] = useState("Walls");
  const [wallsReading, setWallsReading] = useState(false);
  const [walls, setWalls] = useState(null); // {walls, skipped}
  const [wallsError, setWallsError] = useState(null);
  const [wallsMsg, setWallsMsg] = useState(null);
  // 读地板
  const [floorLayer, setFloorLayer] = useState("Floors");
  const [floorsReading, setFloorsReading] = useState(false);
  const [floors, setFloors] = useState(null); // {floors}
  const [floorsError, setFloorsError] = useState(null);
  const [floorsMsg, setFloorsMsg] = useState(null);
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
      const pick = ls.find((l) => /core|核心/i.test(l.path) && l.objects > 0) || ls.find((l) => /core|核心/i.test(l.path)) || ls.find((l) => l.objects > 0);
      if (pick && !ls.some((l) => l.path === layer)) setLayer(pick.path);
      const pickW = ls.find((l) => /wall|墙/i.test(l.path) && l.objects > 0) || ls.find((l) => /wall|墙/i.test(l.path));
      if (pickW && !ls.some((l) => l.path === wallLayer)) setWallLayer(pickW.path);
      const pickF = ls.find((l) => /floor|slab|地板|楼板/i.test(l.path) && l.objects > 0) || ls.find((l) => /floor|slab|地板|楼板/i.test(l.path));
      if (pickF && !ls.some((l) => l.path === floorLayer)) setFloorLayer(pickF.path);
      const pickD = ls.find((l) => /door|门/i.test(l.path) && l.objects > 0) || ls.find((l) => /door|门/i.test(l.path));
      if (pickD && !ls.some((l) => l.path === doorLayer)) setDoorLayer(pickD.path);
      setRawDoors(null);
      setDoorsError(null);
    } catch (err) {
      setReadError(err && err.message ? err.message : String(err));
    }
    setWalls(null);
    setWallsError(null);
    setWallsMsg(null);
    setFloors(null);
    setFloorsError(null);
    setFloorsMsg(null);
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
  const readWalls = async () => {
    setWallsReading(true);
    setWallsError(null);
    setWallsMsg(null);
    try {
      setWalls(await readRhinoWalls(wallLayer, opts));
    } catch (err) {
      setWallsError(err && err.message ? err.message : String(err));
    } finally {
      setWallsReading(false);
    }
  };
  /* 把读到的墙追加进平面图工具的 plan（localStorage）。平面图页开着的话会收到 storage 事件自动刷新。 */
  const addWallsToPlan = () => {
    if (!walls || !walls.walls.length) return;
    const next = wallsToPlan(walls.walls, loadPlan());
    savePlan(next);
    setWallsMsg(t("已加入平面图：{0} 段墙（平面图里现在共 {1} 段）。平面图页开着会自动刷新；没开的话点右边的链接。", [walls.walls.length, next.walls.length]));
  };
  const readFloors = async () => {
    setFloorsReading(true);
    setFloorsError(null);
    setFloorsMsg(null);
    try {
      setFloors(await readRhinoFloors(floorLayer, opts));
    } catch (err) {
      setFloorsError(err && err.message ? err.message : String(err));
    } finally {
      setFloorsReading(false);
    }
  };
  /* 把一块（封闭的）地板的轮廓设为平面图的楼层边界（替换原来的边界），跟墙用同一个坐标基准。 */
  const setFloorAsBoundary = (f) => {
    if (!f || !f.closed || !f.outline || f.outline.length < 3) return;
    const next = floorToPlan(f.outline, loadPlan());
    savePlan(next);
    setFloorsMsg(t("已把「{0}」设为平面图的楼层边界（{1} 个顶点）。平面图页开着会自动刷新。", [f.name || f.type, next.boundary.length]));
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
          {status.offline && <div className="mt-1">{t("脚本路径：项目根目录 {0}。它只监听本机 127.0.0.1:8790，不联网；运行一次后一直在后台监听，直到关闭 Rhino。", [RHINO_SCRIPT_PATH])}</div>}
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
            <button type="button" onClick={read} disabled={reading} className="rounded px-3 py-1" style={{ background: reading ? C.rule : C.accent, color: reading ? C.muted : "#fff", fontWeight: 600 }} data-testid="rhino-read-btn">
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
            <span style={{ color: C.muted, fontSize: 11.5 }}>{t("认 Brep / 挤出体 / 网格 / 封闭矩形曲线；斜放的按最小外接矩形算；含子图层")}</span>
          </div>
          {readError && <div className="mt-1" style={{ color: C.err }}>{readError}</div>}
          {cores && cores.length === 0 && <div className="mt-1" style={{ color: C.muted }}>{t("这个图层上没有可识别的长方体")}</div>}
          {cores && cores.length > 0 && (
            <div className="mt-2 flex flex-col gap-2" data-testid="rhino-cores">
              {cores.map((c, i) => (
                <div key={c.id} className="rounded p-2" style={{ border: `1px solid ${c.fitsAll ? C.ok : C.err}`, background: c.fitsAll ? "#F0F8F3" : "#FBEAEA" }} data-testid="rhino-core-row">
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
            <button type="button" onClick={readDoors} disabled={doorsReading} className="rounded px-3 py-1" style={{ background: doorsReading ? C.rule : C.accent, color: doorsReading ? C.muted : "#fff", fontWeight: 600 }} data-testid="rhino-doors-btn">
              {doorsReading ? t("读取中…") : t("读取门并校核")}
            </button>
            <span style={{ color: C.muted, fontSize: 11.5 }}>{t("门画成紧贴核心筒长方体表面的小长方体（厚度不限）；按门底标高判断楼层；以最低一层的门为参照，按各层楼层平台在哪一端判断门应在同侧还是对侧；宽 ≥ 设计门扇 {0}、高 ≥ 2 030（3.4.3.4.(4)）", [fmtMm(doorReq.width)])}</span>
          </div>
          {doorsError && <div className="mt-1" style={{ color: C.err }}>{doorsError}</div>}
          {doorCheck && (
            <div className="mt-2 flex flex-col gap-2" data-testid="rhino-doors-result">
              {doorCheck.cores.map((c, i) => (
                <div key={c.core.id || i} className="rounded p-2" style={{ border: `1px solid ${c.ok ? C.ok : C.err}`, background: c.ok ? "#F0F8F3" : "#FBEAEA" }} data-testid="rhino-doors-core">
                  <div style={{ fontWeight: 700 }}>
                    {c.ok ? "✓" : "✗"} {c.core.name || t("长方体 {0}", [i + 1])}
                    <span style={{ color: C.muted, fontWeight: 400, fontSize: 11.5 }}>
                      {" · "}
                      {c.doors.length ? t("{0} 个门；参照 L{1} 的门在 {2} 端", [c.doors.length, c.refLevel, endName(c.refEnd)]) : t("没有贴在这个核心筒上的门")}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-col gap-0.5" style={{ fontSize: 11.5 }}>
                    {c.doors.map((d, j) => (
                      <div key={d.id || j} style={{ color: d.ok ? C.ok : C.err }} data-testid="rhino-door-row" data-ok={d.ok ? "1" : "0"}>
                        {d.ok ? "✓" : "✗"} {d.level != null ? `L${d.level}` : t("楼层不明（底标高 {0} m）", [fmtM(d.dz)])}
                        {d.name ? ` ${d.name}` : ""}：{t("在 {0} 端", [endName(d.end)])}
                        {d.face === "side" ? t("（长边）") : t("（端墙）")}
                        {d.endOk === false ? t("，应在 {0} 端（L{1} 的楼层平台在另一端）✗", [endName(d.expectedEnd), d.level]) : d.endOk === true ? t("，端正确") : ""}
                        {t("；宽 {0}", [fmtMm(d.doorWidth)])}
                        {d.widthOk ? " ✓" : t(" < {0} ✗", [fmtMm(doorReq.width)])}
                        {t("，高 {0}", [fmtMm(d.doorHeight)])}
                        {d.heightOk ? " ✓" : t(" < {0} ✗", [fmtMm(doorReq.height)])}
                      </div>
                    ))}
                    {c.missingLevels.length > 0 && <div style={{ color: C.err }}>{t("✗ 缺门：L{0}", [c.missingLevels.join("、L")])}</div>}
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

      {/* 1b. 从 Rhino 读墙体 → 加进平面图工具 */}
      {online && (
        <div className="mt-3" data-testid="rhino-walls">
          <div className="flex flex-wrap items-center gap-2">
            <span style={{ fontWeight: 600 }}>{t("从 Rhino 读取墙体")}</span>
            <span className="flex items-center gap-1">
              {t("图层")}
              <LayerTreePicker layers={layers} value={wallLayer} onChange={setWallLayer} C={C} />
            </span>
            <button type="button" onClick={readWalls} disabled={wallsReading} className="rounded px-3 py-1" style={{ background: wallsReading ? C.rule : C.accent, color: wallsReading ? C.muted : "#fff", fontWeight: 600 }} data-testid="rhino-walls-btn">
              {wallsReading ? t("读取中…") : t("读取墙体")}
            </button>
            <span style={{ color: C.muted, fontSize: 11.5 }}>{t("直线 / 多段线按线段算（厚度用平面图默认值）；Brep / 挤出体按最小外接矩形取中线和厚度；弧线跳过；含子图层")}</span>
          </div>
          {wallsError && <div className="mt-1" style={{ color: C.err }}>{wallsError}</div>}
          {walls && walls.walls.length === 0 && (
            <div className="mt-1" style={{ color: C.muted }}>
              {t("这个图层上没有可识别的墙体")}
              {walls.skipped ? t("（跳过 {0} 个非直线对象）", [walls.skipped]) : ""}
            </div>
          )}
          {walls && walls.walls.length > 0 && (
            <div className="mt-2" data-testid="rhino-walls-result">
              <div className="flex flex-wrap items-center gap-2">
                <span style={{ fontWeight: 600 }}>
                  {t("读到 {0} 段墙", [walls.walls.length])}
                  {walls.skipped ? <span style={{ color: C.muted, fontWeight: 400 }}>{t("（跳过 {0} 个非直线对象）", [walls.skipped])}</span> : null}
                </span>
                <button type="button" onClick={addWallsToPlan} className="rounded px-3 py-1" style={{ background: C.ok, color: "#fff", fontWeight: 600 }} data-testid="rhino-walls-add">
                  {t("添加到平面图（{0} 段）", [walls.walls.length])}
                </button>
                <a href={otherAppHref("plan")} target="_blank" rel="noopener" style={{ color: C.accent, textDecoration: "underline" }}>
                  {t("打开平面图工具 →")}
                </a>
              </div>
              <div className="overflow-x-auto mt-2">
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
                    {walls.walls.map((w, i) => (
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
              {wallsMsg && (
                <div className="mt-1" style={{ color: C.ok, fontWeight: 600 }} data-testid="rhino-walls-msg">
                  {wallsMsg}
                </div>
              )}
              <div className="mt-1" style={{ color: C.muted, fontSize: 11 }}>{t("加入平面图时整批放到画布左上角（留 1 m 边距），Rhino 的 Y 轴朝上会翻成平面图的朝下；平面图没有底图时画布会自动撑大，有底图时请自行拖到位。")}</div>
            </div>
          )}
        </div>
      )}

      {/* 1c. 从 Rhino 读地板 → 设为平面图的楼层边界（必须是封闭多重曲面） */}
      {online && (
        <div className="mt-3" data-testid="rhino-floors">
          <div className="flex flex-wrap items-center gap-2">
            <span style={{ fontWeight: 600 }}>{t("从 Rhino 读取地板")}</span>
            <span className="flex items-center gap-1">
              {t("图层")}
              <LayerTreePicker layers={layers} value={floorLayer} onChange={setFloorLayer} C={C} />
            </span>
            <button type="button" onClick={readFloors} disabled={floorsReading} className="rounded px-3 py-1" style={{ background: floorsReading ? C.rule : C.accent, color: floorsReading ? C.muted : "#fff", fontWeight: 600 }} data-testid="rhino-floors-btn">
              {floorsReading ? t("读取中…") : t("读取地板")}
            </button>
            <span style={{ color: C.muted, fontSize: 11.5 }}>{t("只认封闭多重曲面（closed polysurface）；轮廓取最大的水平面；含子图层")}</span>
          </div>
          {floorsError && <div className="mt-1" style={{ color: C.err }}>{floorsError}</div>}
          {floors && floors.floors.length === 0 && <div className="mt-1" style={{ color: C.muted }}>{t("这个图层上没有对象")}</div>}
          {floors && floors.floors.length > 0 && (
            <div className="mt-2 flex flex-col gap-2" data-testid="rhino-floors-result">
              {floors.floors.map((f, i) => (
                <div key={f.id + "-" + i} className="rounded p-2" style={{ border: `1px solid ${f.closed ? C.ok : C.err}`, background: f.closed ? "#F0F8F3" : "#FBEAEA" }} data-testid="rhino-floor-row" data-closed={f.closed ? "1" : "0"}>
                  <div className="flex flex-wrap items-center gap-3">
                    <span style={{ fontWeight: 700 }}>
                      {f.closed ? "✓" : "✗"} {f.name || t("地板 {0}", [i + 1])}
                    </span>
                    <span style={{ color: C.muted, fontSize: 11.5 }}>{f.type}</span>
                    {f.closed && (
                      <>
                        <span style={{ fontVariantNumeric: "tabular-nums" }}>{t("面积 {0} m²", [Number.isFinite(f.area) ? f.area.toFixed(1) : "—"])}</span>
                        <span style={{ color: C.muted, fontSize: 11.5 }}>
                          {t("轮廓 {0} 个顶点", [Math.max(0, f.outline.length - 1)])}
                          {f.holes ? t("，{0} 个洞口", [f.holes]) : ""}
                          {Number.isFinite(f.thickness) ? t("，厚 {0} mm，底标高 {1} m", [fmtMm(f.thickness), fmtM(f.zBottom)]) : ""}
                        </span>
                        <button type="button" onClick={() => setFloorAsBoundary(f)} className="rounded px-3 py-1" style={{ background: C.ok, color: "#fff", fontWeight: 600 }} data-testid="rhino-floor-use">
                          {t("设为楼层边界")}
                        </button>
                      </>
                    )}
                  </div>
                  {!f.closed && (
                    <div className="mt-1" style={{ color: C.err, fontSize: 11.5 }}>
                      {t("不是封闭多重曲面（closed polysurface）：{0}。请在 Rhino 里把地板做成封闭实体（例如 Cap 封口，或把轮廓线 Extrude 成 Solid）后再读。", [f.reason || "—"])}
                    </div>
                  )}
                </div>
              ))}
              {floorsMsg && (
                <div style={{ color: C.ok, fontWeight: 600 }} data-testid="rhino-floors-msg">
                  {floorsMsg}
                </div>
              )}
              <div style={{ color: C.muted, fontSize: 11 }}>{t("楼层边界会替换平面图里原有的边界，位置和之前从 Rhino 加进去的墙用同一个坐标基准，所以互相对得上。")}</div>
            </div>
          )}
        </div>
      )}

      {/* 2. 发送到 Rhino（次要，默认收起） */}
      {online && (
        <details className="mt-3" open={sendOpen} onToggle={(e) => setSendOpen(e.currentTarget.open)}>
          <summary style={{ cursor: "pointer", color: C.muted, fontSize: 12 }}>{t("反向：把计算出的楼梯实体发送到 Rhino（可选）")}</summary>
          <div className="flex flex-wrap items-center gap-2 mt-2">
            <input value={name} onChange={(e) => setName(e.target.value)} className="rounded px-2 py-0.5" style={{ border: `1px solid ${C.rule}`, width: 120, fontFamily: "monospace" }} title={t("Rhino 里的图层名（StairCore::<名字>）")} aria-label="Rhino layer name" />
            <button type="button" onClick={send} disabled={sending} className="rounded px-3 py-1" style={{ background: sending ? C.rule : C.ok, color: sending ? C.muted : "#fff", fontWeight: 600 }} data-testid="rhino-send">
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
