// 主题（浅色 / 深色）：跟语言切换一样，存 localStorage 后整页刷新——配色常量 C 在各模块加载时就定下来了，热切换覆盖不到。
// 两套调色板都在这里；StairCoreTool.jsx 的 `C` 按当前主题取其中一套，其它模块从那里 import C。
export const THEME_KEY = "stair-core:theme";
export const THEMES = [
  { key: "light", label: "☀", title: "浅色模式" },
  { key: "dark", label: "☾", title: "深色模式（CRT）" },
];

export function getTheme() {
  try {
    if (typeof localStorage === "undefined") return "light"; // Node（测试）
    const v = localStorage.getItem(THEME_KEY);
    return v === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}
export const isDark = () => getTheme() === "dark";

export function setTheme(key) {
  try {
    localStorage.setItem(THEME_KEY, key === "dark" ? "dark" : "light");
  } catch {
    /* 隐私模式等 */
  }
  if (typeof window !== "undefined") window.location.reload();
}

/* 把主题写到 <html data-theme>，index.css 里按它切 body 背景、按钮 CRT 发光强度、悬停色 */
export function applyThemeToDocument() {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = getTheme();
}

/* 浅色：原来的配色，加了几个以前写死在代码里的底色 */
export const LIGHT_C = {
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
  warn: "#B7791F",
  ok: "#2F855A",
  err: "#B83A3A",
  rule: "#D3DBE2",
  tag: "#EDF2F6",
  okBg: "#F0F8F3", // 通过 / 够 的行底
  errBg: "#FBEAEA", // 不通过 的行底
  warnBg: "#FFF8E8", // 提醒条底
  selBg: "#D6E6F7", // 选中行底
  canvas: "#F3F6F8", // 平面图画布 / 图纸底
  canvasBg: "#FBFCFD", // 画布外框、表头等更浅的一层
};

/* 深色（CRT 风）：近黑的底、荧光绿的强调色，文字偏冷白 */
export const DARK_C = {
  ink: "#DCE7E0",
  muted: "#8A9BA3",
  paper: "#0E1317",
  panel: "#151C22",
  line: "#7FB3E6",
  lineSoft: "#4F6B84",
  wallFill: "#2A3844",
  hatch: "#6F8290",
  flightFill: "#1B252D",
  accent: "#31C86F",
  warn: "#E6B04F",
  ok: "#4FD182",
  err: "#FF6B6B",
  rule: "#2A3842",
  tag: "#1C262E",
  okBg: "#10261B",
  errBg: "#2C1518",
  warnBg: "#2A2213",
  selBg: "#174232",
  canvas: "#111820",
  canvasBg: "#0F151B",
};

export const C_FOR_THEME = () => (isDark() ? DARK_C : LIGHT_C);
