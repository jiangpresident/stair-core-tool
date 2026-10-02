// 界面语言：英文（默认）/ 中文。
// 源码里的界面文字仍然以中文写（它是翻译词典的键），渲染时经 t() 查英文词典（src/i18n/en.js）；
// 词典里没有的键原样显示中文，并在开发模式下记到 window.__i18nMissing() 里，方便补齐。
// 这个模块不依赖 React、不在加载时碰 window（Node 单测会 import 到它）；切换语言用 setLang() 后整页刷新
// ——因为不少中文写在模块级常量里（用途分组、服务商列表等），只在加载时求值一次，热切换覆盖不到它们。
import { EN } from "./i18n/en.js";

export const LANG_KEY = "stair-core:lang";
export const LANGS = [
  { key: "en", label: "EN", title: "English" },
  { key: "zh", label: "中", title: "中文" },
];

export function getLang() {
  // 没有浏览器存储的环境（Node 单测、构建脚本）用源语言中文：测试断言的是源码里的中文文案；浏览器里默认英文
  if (typeof localStorage === "undefined") return "zh";
  try {
    const v = localStorage.getItem(LANG_KEY);
    return v === "zh" || v === "en" ? v : "en";
  } catch {
    return "en";
  }
}

export function setLang(lang) {
  try {
    localStorage.setItem(LANG_KEY, lang === "zh" ? "zh" : "en");
  } catch {
    /* 存不了就只在本次刷新后用默认值 */
  }
  if (typeof location !== "undefined") location.reload();
}

const currentLang = getLang();
export const lang = currentLang;
const missing = new Set();
if (typeof window !== "undefined") window.__i18nMissing = () => [...missing];

/* t(key, args?)：key 是中文原文；args 用来填 {0} {1}… 占位（模板字符串改写而来）。 */
export function t(key, args) {
  let s = key;
  if (currentLang === "en") {
    const en = EN[key];
    if (en != null) s = en;
    else missing.add(key);
  }
  if (args && args.length) s = s.replace(/\{(\d+)\}/g, (m, i) => (args[i] != null ? String(args[i]) : m));
  return s;
}
