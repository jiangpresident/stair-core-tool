// 主题注册表：浅色（原样）和深色（琥珀色 CRT，照 OpenVMS 监视器那种橙黄荧光屏）。
// 机制跟语言切换一样：存 localStorage 后整页刷新——配色常量 C 在各模块加载时就定下来了，热切换覆盖不到。
//
// 以后要加 / 改主题，只动这个文件：
//   1. 在 THEME_DEFS 里加一项：{ label, title, palette（C 的全部键）, vars（CSS 变量）, crt（按钮要不要 CRT 字体 + 发光 + 扫描线）, dark（表单控件用深色外观）}
//   2. 右上角的切换按钮会自动多一个；index.css 只读 CSS 变量和 data-crt / data-dark 属性，不用改。
//   3. 临时微调不改代码：localStorage 里放 stair-core:theme-overrides = {"dark": {"accent": "#00FF66"}}，会盖在对应主题的 palette 上。
export const THEME_KEY = "stair-core:theme";
export const THEME_OVERRIDES_KEY = "stair-core:theme-overrides";

/* 浅色：原来的配色，加了几个以前写死在代码里的底色；onAccent 是强调色按钮上的文字色 */
const LIGHT = {
  ink: "#1B2733",
  muted: "#5B6B7B",
  paper: "#F2F4F3",
  panel: "#FFFFFF",
  line: "#2B5C8A",
  lineSoft: "#93A8BD",
  wallFill: "#DDE4EA",
  hatch: "#7A8A99",
  flightFill: "#EEF2F5",
  accent: "#1F4E79",
  onAccent: "#FFFFFF",
  warn: "#B7791F",
  ok: "#2F855A",
  err: "#B83A3A",
  rule: "#D3DBE2",
  tag: "#EDF2F6",
  okBg: "#F0F8F3",
  errBg: "#FBEAEA",
  warnBg: "#FFF8E8",
  selBg: "#D6E6F7",
  canvas: "#F3F6F8",
  canvasBg: "#FBFCFD",
};

/* 琥珀色 CRT：近黑略带褐的底，文字 / 线框都是琥珀色，强调（按钮、选中）用"反显"——琥珀底黑字 */
const AMBER = {
  ink: "#FFB000",
  muted: "#B47A1C",
  paper: "#0A0805",
  panel: "#110D07",
  line: "#FFB000",
  lineSoft: "#8A6420",
  wallFill: "#2A1F0C",
  hatch: "#8A6420",
  flightFill: "#17110A",
  accent: "#FFB000",
  onAccent: "#0A0805",
  warn: "#FFC84A",
  ok: "#FFD166",
  err: "#FF5A3C",
  rule: "#5C4214",
  tag: "#1C150A",
  okBg: "#1A1407",
  errBg: "#2A0F08",
  warnBg: "#1F1708",
  selBg: "#3A2A08",
  canvas: "#0F0B07",
  canvasBg: "#0C0906",
};

/* 字体：浅色用原来的无衬线栈；CRT 用等宽终端字体（Share Tech Mono 只有拉丁字符，中文回退到系统字体） */
export const SANS_FONT = '"Avenir Next","Segoe UI","PingFang SC","Hiragino Sans GB","Noto Sans SC","Microsoft YaHei",sans-serif';
export const CRT_FONT = '"Share Tech Mono","Cascadia Mono",Consolas,"Courier New","PingFang SC","Noto Sans SC","Microsoft YaHei",monospace';

export const THEME_DEFS = {
  light: {
    label: "☀",
    title: "浅色模式",
    palette: LIGHT,
    font: SANS_FONT,
    vars: { "--page-bg": LIGHT.paper, "--row-hover": "#F1F5F9", "--crt-glow": "transparent", "--crt-frame": LIGHT.rule, "--panel": LIGHT.panel, "--crt-font": SANS_FONT },
    crt: false,
    dark: false,
  },
  dark: {
    label: "☾",
    title: "深色模式（琥珀色 CRT）",
    palette: AMBER,
    font: CRT_FONT,
    // --crt-frame：面板 / 输入框的线框色（比 rule 亮，像终端的线框）；--panel：标题"嵌"在框线上时垫在文字后面的底色
    vars: { "--page-bg": AMBER.paper, "--row-hover": "#1E1609", "--crt-glow": "rgba(255, 176, 0, 0.55)", "--crt-frame": "#C8891A", "--panel": AMBER.panel, "--crt-font": CRT_FONT },
    crt: true,
    dark: true,
  },
};
export const FONT_FOR_THEME = () => THEME_DEFS[getTheme()].font || SANS_FONT;
export const THEMES = Object.entries(THEME_DEFS).map(([key, d]) => ({ key, label: d.label, title: d.title }));

export function getTheme() {
  try {
    if (typeof localStorage === "undefined") return "light"; // Node（测试）
    const v = localStorage.getItem(THEME_KEY);
    return v && THEME_DEFS[v] ? v : "light";
  } catch {
    return "light";
  }
}
export const isDark = () => !!THEME_DEFS[getTheme()].dark;

export function setTheme(key) {
  try {
    localStorage.setItem(THEME_KEY, THEME_DEFS[key] ? key : "light");
  } catch {
    /* 隐私模式等 */
  }
  if (typeof window !== "undefined") window.location.reload();
}

function overridesFor(key) {
  try {
    if (typeof localStorage === "undefined") return {};
    const all = JSON.parse(localStorage.getItem(THEME_OVERRIDES_KEY) || "{}");
    const o = all && all[key];
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}

/* 当前主题的配色（含 localStorage 里的微调覆盖） */
export const C_FOR_THEME = () => {
  const key = getTheme();
  return { ...THEME_DEFS[key].palette, ...overridesFor(key) };
};

/* 把主题写到 <html>：data-theme / data-crt / data-dark + CSS 变量；index.css 只认这些 */
export function applyThemeToDocument() {
  if (typeof document === "undefined") return;
  const key = getTheme();
  const def = THEME_DEFS[key];
  const el = document.documentElement;
  el.dataset.theme = key;
  el.dataset.crt = def.crt ? "1" : "0";
  el.dataset.dark = def.dark ? "1" : "0";
  for (const [k, v] of Object.entries(def.vars)) el.style.setProperty(k, v);
  const pal = C_FOR_THEME();
  el.style.setProperty("--page-bg", pal.paper);
}

// 兼容旧引用
export const LIGHT_C = LIGHT;
export const DARK_C = AMBER;
