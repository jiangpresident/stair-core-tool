// 计算器三维模型区下方的 "Rhino" 面板：连接本机 Rhino 里的桥接脚本（rhino/StairCoreBridge.py），
// 把当前梯井整栋高度的楼梯实体（跟上方三维模型同一份盒子数据）发到 Rhino 里烘焙成 Brep。
// 1.1 版第一步：只做"发送几何"；参数化 / 从 Rhino 读平面图留给后续。
import { useState } from "react";
import { t } from "../i18n.js";
import { buildRhinoPayload, checkRhino, sendToRhino, RHINO_SCRIPT_PATH } from "./rhinoBridge.js";

const KIND_OPTIONS = [
  { key: "step", label: "踏步" },
  { key: "landing", label: "平台" },
  { key: "slab", label: "楼板" },
  { key: "wall", label: "梯间墙" },
  { key: "centerWall", label: "剪刀梯中间隔墙" },
  { key: "door", label: "门" },
];

export default function RhinoPanel({ C, buildModel, shaftLabel }) {
  const [status, setStatus] = useState(null); // null | {checking} | {ok, rhino, doc, units} | {ok:false, error}
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null); // {text, error}
  const [kinds, setKinds] = useState(() => new Set(["step", "landing", "slab", "wall", "centerWall", "door"]));
  const [replace, setReplace] = useState(true);
  const [name, setName] = useState("StairCore");

  const connect = async () => {
    setStatus({ checking: true });
    setStatus(await checkRhino());
  };
  const send = async () => {
    setSending(true);
    setResult(null);
    try {
      const model = buildModel();
      const payload = buildRhinoPayload(model, { name: name.trim() || "StairCore", kinds: [...kinds], replace });
      if (!payload.boxes.length) throw new Error(t("没有可发送的几何（勾选至少一种构件）"));
      const r = await sendToRhino(payload);
      setResult({ text: t("已发送到 Rhino：{0} 个实体，图层 {1}（文档单位 {2}）", [r.added, (r.layers || []).length, r.units]) });
      setStatus(await checkRhino());
    } catch (err) {
      setResult({ text: err && err.message ? err.message : String(err), error: true });
    } finally {
      setSending(false);
    }
  };
  const online = !!(status && status.ok);
  const toggleKind = (k) =>
    setKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  return (
    <div className="rounded p-3 mt-3" style={{ border: `1px solid ${online ? C.ok : C.rule}`, fontSize: 12.5 }} data-testid="rhino-panel">
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
        {online && (
          <>
            <input value={name} onChange={(e) => setName(e.target.value)} className="rounded px-2 py-0.5" style={{ border: `1px solid ${C.rule}`, width: 120, fontFamily: "monospace" }} title={t("Rhino 里的图层名（StairCore::<名字>）")} aria-label="Rhino layer name" />
            <button type="button" onClick={send} disabled={sending} className="rounded px-3 py-1" style={{ background: sending ? C.rule : C.ok, color: sending ? C.muted : "#fff", fontWeight: 600 }} data-testid="rhino-send">
              {sending ? t("发送中…") : t("发送到 Rhino：{0}（整栋）", [shaftLabel])}
            </button>
          </>
        )}
      </div>
      {online && (
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
      )}
      {status && !status.checking && !online && (
        <div className="mt-2" style={{ color: C.muted, fontSize: 11.5 }}>
          {status.error}
          {status.offline && (
            <div className="mt-1">
              {t("脚本路径：项目根目录 {0}。它只监听本机 127.0.0.1:8790，不联网；运行一次后一直在后台监听，直到关闭 Rhino。", [RHINO_SCRIPT_PATH])}
            </div>
          )}
        </div>
      )}
      {!status && <div className="mt-1" style={{ color: C.muted, fontSize: 11.5 }}>{t("把上方三维模型的实体直接烘焙进本机 Rhino（毫米 → 文档单位自动换算，按楼梯编号上色、分图层）。需要先在 Rhino 里运行一次桥接脚本。")}</div>}
      {result && (
        <div className="mt-2" style={{ color: result.error ? C.err : C.ok, fontWeight: 600 }}>
          {result.text}
          <button type="button" onClick={() => setResult(null)} className="ml-1" style={{ textDecoration: "underline", fontWeight: 400 }}>
            {t("知道了")}
          </button>
        </div>
      )}
    </div>
  );
}
