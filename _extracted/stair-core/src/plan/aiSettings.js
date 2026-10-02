import { t } from "../i18n.js";
// AI 识图的服务商列表 + 用户设置（服务商 / 各家的 API 密钥 / 模型名）的本地存储。
// 单独拆成一个不依赖 @anthropic-ai/sdk 的小文件：StairCoreTool.jsx 一加载就要读设置来渲染输入框，
// 而 SDK 本体只在用户真的点"AI 识别"时才动态 import（见 aiVision.js），两者不能绑在一个模块里。
//
// 密钥只存在用户自己浏览器的 localStorage 里：源码、构建产物、dist-single 单文件版里都没有密钥。
export const AI_PROVIDERS = [
  { key: "anthropic", label: t("Claude（Anthropic）"), defaultModel: "claude-opus-5-5", keyPlaceholder: "sk-ant-…", keyUrl: "https://platform.claude.com/" },
  { key: "openai", label: t("ChatGPT（OpenAI）"), defaultModel: "gpt-5", keyPlaceholder: "sk-…", keyUrl: "https://platform.openai.com/api-keys" },
];

export const AI_SETTINGS_KEY = "stair-core:ai-vision";

const DEFAULT_SETTINGS = () => ({ provider: "anthropic", keys: { anthropic: "", openai: "" }, models: { anthropic: "", openai: "" } });

export function readAiSettings(storage) {
  const d = DEFAULT_SETTINGS();
  try {
    const raw = storage && storage.getItem(AI_SETTINGS_KEY);
    if (!raw) return d;
    const j = JSON.parse(raw);
    return {
      provider: AI_PROVIDERS.some((p) => p.key === j.provider) ? j.provider : d.provider,
      keys: { ...d.keys, ...(j.keys && typeof j.keys === "object" ? j.keys : {}) },
      models: { ...d.models, ...(j.models && typeof j.models === "object" ? j.models : {}) },
    };
  } catch {
    return d;
  }
}

export function writeAiSettings(storage, settings) {
  try {
    storage && storage.setItem(AI_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* 隐私模式/存储被禁用时静默失败：本次会话还能用，只是下次要重填 */
  }
}

const browserStorage = () => (typeof localStorage !== "undefined" ? localStorage : null);
export const readAiSettingsFromBrowser = () => readAiSettings(browserStorage());
export const writeAiSettingsToBrowser = (settings) => writeAiSettings(browserStorage(), settings);
