// 右上角固定的两个切换：主题（☀ 浅色 / ☾ 深色 CRT）和语言（EN / 中）。两个页面（计算器 / 平面图）都挂它；
// 点击后存 localStorage 并整页刷新（见 i18n.js / theme.js）。
import { useEffect } from "react";
import { LANGS, getLang, setLang, t } from "./i18n.js";
import { THEMES, getTheme, setTheme, C_FOR_THEME } from "./theme.js";

export default function LangToggle() {
  const cur = getLang();
  const theme = getTheme();
  const C = C_FOR_THEME();
  // 浏览器标签页标题也跟着语言走（index.html 里写死的是中文）
  useEffect(() => {
    const isPlan = /\/plan(\.html)?$/.test(window.location.pathname);
    document.title = isPlan ? `${t("平面图工具")} · ${t("核心筒疏散楼梯计算器")}` : t("核心筒疏散楼梯计算器");
  }, []);
  const pill = { display: "flex", border: `1px solid ${C.rule}`, borderRadius: 999, background: C.panel, boxShadow: "0 1px 4px rgba(0,0,0,0.12)", overflow: "hidden", fontSize: 12, fontWeight: 600 };
  const btn = (active) => ({ padding: "4px 10px", border: "none", cursor: active ? "default" : "pointer", background: active ? C.accent : "transparent", color: active ? "#fff" : C.ink });
  return (
    <div style={{ position: "fixed", top: 10, right: 12, zIndex: 50, display: "flex", gap: 6 }} data-testid="top-toggles">
      <div role="group" aria-label="Theme / 主题" data-testid="theme-toggle" style={pill}>
        {THEMES.map((th) => (
          <button key={th.key} type="button" onClick={() => theme !== th.key && setTheme(th.key)} title={t(th.title)} aria-pressed={theme === th.key} data-testid={"theme-" + th.key} style={btn(theme === th.key)}>
            {th.label}
          </button>
        ))}
      </div>
      <div role="group" aria-label="Language / 语言" data-testid="lang-toggle" style={pill}>
        {LANGS.map((l) => (
          <button key={l.key} type="button" onClick={() => cur !== l.key && setLang(l.key)} title={l.title} aria-pressed={cur === l.key} data-testid={"lang-" + l.key} style={btn(cur === l.key)}>
            {l.label}
          </button>
        ))}
      </div>
    </div>
  );
}
