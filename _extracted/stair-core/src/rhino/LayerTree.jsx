// Rhino 图层选择器：按钮 + 下拉的多级树，样子照 Rhino 自己的图层面板——子图层缩进、▸/▾ 展开折叠、
// 左边颜色块、当前图层打勾、隐藏图层灰字、右边对象数（子孙图层的对象数单独用 "+n" 标出来，因为读核心筒时含子图层）。
// 纯展示组件：layers 是 /layers 的扁平列表，value/onChange 是选中的图层完整路径。
import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n.js";
import { buildLayerTree } from "./rhinoBridge.js";

function Swatch({ color }) {
  return <span style={{ width: 10, height: 10, borderRadius: 2, background: color || "#000", border: "1px solid rgba(0,0,0,.25)", flexShrink: 0, display: "inline-block" }} />;
}

const ancestorsOf = (path) => {
  const parts = String(path || "").split("::");
  const out = [];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("::"));
  return out;
};

export default function LayerTreePicker({ layers, value, onChange, C, disabled }) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(() => new Set(ancestorsOf(value)));
  const ref = useRef(null);
  const tree = useMemo(() => buildLayerTree(layers), [layers]);
  const selected = (layers || []).find((l) => l.path === value);

  // 选中项变了：把它的祖先展开，不然在树里看不见
  useEffect(() => {
    const anc = ancestorsOf(value);
    if (!anc.length) return;
    setExpanded((prev) => {
      if (anc.every((a) => prev.has(a))) return prev;
      const next = new Set(prev);
      anc.forEach((a) => next.add(a));
      return next;
    });
  }, [value]);

  // 点外面 / Esc 关闭
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggleNode = (path) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  // 展平成可见行（只展开 expanded 里的节点）
  const rows = [];
  const walk = (nodes, depth) => {
    for (const n of nodes) {
      rows.push({ node: n, depth });
      if (n.children.length && expanded.has(n.path)) walk(n.children, depth + 1);
    }
  };
  walk(tree, 0);

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }} data-testid="layer-tree">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="tree"
        aria-expanded={open}
        aria-label="Rhino layer"
        className="rounded px-2 py-0.5 flex items-center gap-2"
        style={{ border: `1px solid ${open ? C.accent : C.rule}`, background: C.panel, minWidth: 170, maxWidth: 320, textAlign: "left" }}
        data-testid="layer-tree-btn"
      >
        {selected && <Swatch color={selected.color} />}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={value}>
          {value || t("选择图层…")}
        </span>
        {selected && (selected.objects || 0) > 0 && <span style={{ color: C.muted, fontSize: 11 }}>({selected.objects})</span>}
        <span style={{ marginLeft: "auto", color: C.muted, fontSize: 10 }}>▾</span>
      </button>
      {open && (
        <div
          role="tree"
          className="rounded"
          style={{ position: "absolute", zIndex: 40, top: "calc(100% + 4px)", left: 0, minWidth: 300, maxHeight: 340, overflowY: "auto", background: C.panel, border: `1px solid ${C.rule}`, boxShadow: "0 6px 20px rgba(0,0,0,.14)", padding: "4px 0", fontSize: 12.5 }}
          data-testid="layer-tree-list"
        >
          <div className="flex items-center px-2" style={{ height: 24, color: C.muted, fontSize: 11, borderBottom: `1px solid ${C.rule}`, marginBottom: 2 }}>
            <span style={{ flex: 1 }}>{t("图层")}</span>
            <span>{t("对象")}</span>
          </div>
          {rows.map(({ node, depth }) => {
            const sel = node.path === value;
            const has = node.children.length > 0;
            const exp = expanded.has(node.path);
            return (
              <div
                key={node.path}
                role="treeitem"
                aria-selected={sel}
                aria-expanded={has ? exp : undefined}
                aria-level={depth + 1}
                className="flex items-center gap-1 pr-2 hover:bg-slate-100"
                style={{ height: 26, paddingLeft: 6 + depth * 16, background: sel ? "#D6E6F7" : undefined, cursor: "pointer", fontWeight: sel || node.current ? 600 : 400, color: node.visible === false ? C.muted : C.ink, userSelect: "none" }}
                onClick={() => {
                  onChange(node.path);
                  setOpen(false);
                }}
                title={node.path}
                data-testid="layer-row"
                data-path={node.path}
              >
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    if (has) toggleNode(node.path);
                  }}
                  style={{ width: 14, textAlign: "center", color: C.muted, fontSize: 10, visibility: has ? "visible" : "hidden", cursor: has ? "pointer" : "default" }}
                  data-testid="layer-caret"
                >
                  {exp ? "▾" : "▸"}
                </span>
                <Swatch color={node.color} />
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{node.name}</span>
                {node.current && (
                  <span title={t("Rhino 当前图层")} style={{ fontSize: 11 }}>
                    ✓
                  </span>
                )}
                {node.visible === false && <span style={{ fontSize: 10, color: C.muted }}>{t("隐藏")}</span>}
                <span style={{ color: C.muted, fontSize: 11, fontVariantNumeric: "tabular-nums", minWidth: 18, textAlign: "right" }}>{node.objects ? node.objects : ""}</span>
                {node.childObjects > 0 && (
                  <span title={t("子图层上的对象（读取时一并计入）")} style={{ color: C.muted, fontSize: 10, fontVariantNumeric: "tabular-nums" }}>
                    +{node.childObjects}
                  </span>
                )}
              </div>
            );
          })}
          {!rows.length && (
            <div className="px-3 py-1" style={{ color: C.muted }}>
              {t("没有图层")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
