// 右上角固定的语言切换（EN / 中）。两个页面（计算器 / 平面图）都挂它；点击后存 localStorage 并整页刷新（见 i18n.js）。
import { useEffect } from "react";
import { LANGS, getLang, setLang, t } from "./i18n.js";

export default function LangToggle() {
  const cur = getLang();
  // 浏览器标签页标题也跟着语言走（index.html 里写死的是中文）
  useEffect(() => {
    const isPlan = /\/plan(\.html)?$/.test(window.location.pathname);
    document.title = isPlan ? `${t("平面图工具")} · ${t("核心筒疏散楼梯计算器")}` : t("核心筒疏散楼梯计算器");
  }, []);
  return (
    <div
      role="group"
      aria-label="Language / 语言"
      data-testid="lang-toggle"
      style={{ position: "fixed", top: 10, right: 12, zIndex: 50, display: "flex", border: "1px solid #D3DBE2", borderRadius: 999, background: "#fff", boxShadow: "0 1px 4px rgba(0,0,0,0.08)", overflow: "hidden", fontSize: 12, fontWeight: 600 }}
    >
      {LANGS.map((l) => (
        <button
          key={l.key}
          type="button"
          onClick={() => cur !== l.key && setLang(l.key)}
          title={l.title}
          aria-pressed={cur === l.key}
          data-testid={"lang-" + l.key}
          style={{ padding: "4px 10px", border: "none", cursor: cur === l.key ? "default" : "pointer", background: cur === l.key ? "#1F4E79" : "transparent", color: cur === l.key ? "#fff" : "#1F2A37" }}
        >
          {l.label}
        </button>
      ))}
    </div>
  );
}
