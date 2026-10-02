// 计算器三维模型区下方的 "Rhino" 面板（1.1）。两件事，按用户的实际需求排序：
//   1. 从 Rhino 读核心筒：用户在 Rhino 里自己画好核心筒的长方体（放在某个图层），这里读出它的长 × 宽（含转角、
//      位置、高度，毫米），和计算出来的各区段核心筒外包尺寸比，告诉用户够不够、差多少。
//   2. 发送到 Rhino：把当前梯井整栋高度的楼梯实体（跟上方三维模型同一份盒子数据）烘焙进 Rhino（次要功能，默认收起）。
//   0. 连到哪个文件：扫描 8790–8799 列出所有运行了桥接脚本的 Rhino 窗口让用户选；也能让当前窗口打开最近文件 / 浏览打开别的 .3dm。
// Rhino 那边跑的是 rhino/StairCoreBridge.py（127.0.0.1:8790，被占就顺延）。
import { useState } from "react";
import { t } from "../i18n.js";
import { buildRhinoPayload, sendToRhino, listRhinoLayers, readRhinoCores, checkCoreBoxes, scanRhino, listRecentFiles, openRhinoFile, openRhinoFileDialog, RHINO_SCRIPT_PATH, RHINO_NOT_RUNNING_HINT, RHINO_PORTS } from "./rhinoBridge.js";

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

export default function RhinoPanel({ C, buildModel, shaftLabel, zones }) {
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
  const [cores, setCores] = useState(null); // checkCoreBoxes 的结果
  const [readError, setReadError] = useState(null);
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
    setCores(null);
    setReadError(null);
    try {
      const ls = await listRhinoLayers(o);
      setLayers(ls);
      const pick = ls.find((l) => /core|核心/i.test(l.path) && l.objects > 0) || ls.find((l) => /core|核心/i.test(l.path)) || ls.find((l) => l.objects > 0);
      if (pick && !ls.some((l) => l.path === layer)) setLayer(pick.path);
    } catch (err) {
      setReadError(err && err.message ? err.message : String(err));
    }
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
      const boxes = await readRhinoCores(layer, opts);
      setCores(checkCoreBoxes(boxes, zones));
    } catch (err) {
      setReadError(err && err.message ? err.message : String(err));
    } finally {
      setReading(false);
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
    <div className="rounded p-3 mt-3" style={{ border: `1px solid ${online ? C.ok : C.rule}`, fontSize: 12.5 }} data-testid="rhino-panel">
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
            <label className="flex items-center gap-1">
              {t("图层")}
              <select value={layer} onChange={(e) => setLayer(e.target.value)} className="rounded px-2 py-0.5" style={{ border: `1px solid ${C.rule}`, background: C.panel, maxWidth: 260 }} aria-label="Rhino layer">
                {!layers.some((l) => l.path === layer) && <option value={layer}>{layer}</option>}
                {layers.map((l) => (
                  <option key={l.path} value={l.path}>
                    {l.path}
                    {l.objects ? ` (${l.objects})` : ""}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" onClick={read} disabled={reading} className="rounded px-3 py-1" style={{ background: reading ? C.rule : C.accent, color: reading ? C.muted : "#fff", fontWeight: 600 }} data-testid="rhino-read-btn">
              {reading ? t("读取中…") : t("读取并校核")}
            </button>
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
                  <div className="mt-1 flex flex-wrap gap-3" style={{ fontSize: 11.5 }}>
                    {c.perZone.map((z) => (
                      <span key={z.from + "-" + z.to} style={{ color: z.fits ? C.ok : C.err }}>
                        L{z.from}
                        {z.to !== z.from ? `–L${z.to}` : ""}（{z.count} {t("部楼梯")}）{t("需 {0} × {1}", [fmtMm(z.reqL), fmtMm(z.reqW)])}：
                        {z.fits ? t("够（长余 {0}，宽余 {1}）", [fmtMm(z.dL), fmtMm(z.dW)]) : t("不够（长 {0}，宽 {1}）", [(z.dL >= 0 ? "+" : "") + fmtMm(z.dL), (z.dW >= 0 ? "+" : "") + fmtMm(z.dW)])}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
              <div style={{ color: C.muted, fontSize: 11 }}>{t("比对规则：长方体的长边对区段所需外包的长边、短边对短边（横放竖放都算）；所需外包尺寸见下方“楼梯间核心筒尺寸”。")}</div>
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
