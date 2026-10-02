// AI 识图路线（第三条墙体识别路线）：把平面图整张送给多模态大模型，让它直接读图给出
// 墙 / 门 / 楼梯的像素坐标——不再靠 Sobel/矢量解析这些"看线"的启发式规则。用户实测前两条
// 路线对真实扫描件效果都不理想，才决定换这条路线试试。
//
// 这个文件是"纯逻辑"：提示词、返回 JSON 的解析与坐标换算、两家（Anthropic Claude / OpenAI
// ChatGPT）的调用封装，全部不碰 DOM——canvas 缩图那一步放在 aiVision.js（浏览器胶水层），
// 这里的所有函数都能在 Node 里用假的 fetch 单测（见 scripts/test-ai-vision.mjs）。
//
// 安全边界（用户明确的前提：密钥自己提供、只存在自己浏览器里）：
//   - API 密钥永远由用户在界面上输入，只存 localStorage（见 readAiSettings/writeAiSettings），
//     源码、构建产物、dist-single 单文件版里都不会出现任何密钥；
//   - 请求是浏览器直连各家官方接口（Anthropic 要显式声明 dangerouslyAllowBrowser 才允许这么做，
//     这是 SDK 防止开发者把密钥打进网页的保护——我们的场景恰恰是"用户自己的密钥、自己的浏览器"，
//     所以显式开启；OpenAI 用原生 fetch 直连）。
import Anthropic from "@anthropic-ai/sdk";
import { AI_PROVIDERS } from "./aiSettings.js";
import { t } from "../i18n.js";

export { AI_PROVIDERS, AI_SETTINGS_KEY, readAiSettings, writeAiSettings } from "./aiSettings.js";

// 送给模型的图最长边不超过这个像素数：Claude 官方建议图片长边 ≤1568px（更大只会被服务端缩回去，
// 白白多传字节、多算 token），OpenAI 的 high detail 也差不多这个量级。坐标换算靠 factor 还原回原图像素。
export const MAX_IMAGE_EDGE = 1568;

// 两家共用同一份 JSON Schema（结构化输出）：Anthropic 走 output_config.format，OpenAI 走
// response_format.json_schema。所有字段 required + additionalProperties:false 是 OpenAI strict 模式的硬性要求。
const SEG_SCHEMA = {
  type: "object",
  properties: { x1: { type: "number" }, y1: { type: "number" }, x2: { type: "number" }, y2: { type: "number" } },
  required: ["x1", "y1", "x2", "y2"],
  additionalProperties: false,
};
export const FLOOR_PLAN_SCHEMA = {
  type: "object",
  properties: {
    walls: {
      type: "array",
      items: {
        type: "object",
        properties: { ...SEG_SCHEMA.properties, thickness: { type: "number" } },
        required: ["x1", "y1", "x2", "y2", "thickness"],
        additionalProperties: false,
      },
    },
    doors: { type: "array", items: SEG_SCHEMA },
    stairs: { type: "array", items: SEG_SCHEMA },
  },
  required: ["walls", "doors", "stairs"],
  additionalProperties: false,
};

const SYSTEM_PROMPT =
  "You are an expert at reading architectural floor plans (CAD exports and scanned drawings). You extract geometry precisely, as pixel coordinates measured on the image you are given.";

/* 提示词用英文写：两家模型对英文指令的遵循度最稳定，坐标类任务尤其不想引入翻译歧义。
   关键点：明确坐标系（原图像素、左上角原点）、明确"什么算墙/什么不算"（尺寸线、网格轴线、文字、
   填充、家具、门弧都不要）、窗户按墙处理（窗户不打断墙）、共线合并。 */
export function buildPrompt(width, height) {
  return [
    `This image is an architectural floor plan, ${width} x ${height} pixels. Coordinate system: origin at the top-left corner, x increases to the right, y increases downward, units are pixels of THIS image exactly as given (do not normalise, do not rescale).`,
    "Extract:",
    "1. walls: every wall segment, exterior and interior, load-bearing and partition. For each give the CENTERLINE endpoints (x1,y1)-(x2,y2) and the wall thickness in pixels. Treat windows as part of the wall they sit in (a window does not interrupt the wall). Split walls at corners and T-junctions; merge collinear pieces of one wall into a single segment. Do NOT include dimension lines, grid/axis lines, text, hatching, furniture, fixtures, door swing arcs, leader lines, the title block, or the north arrow.",
    "2. doors: each door opening as the segment across the opening, from one jamb to the other jamb, lying on the wall centerline.",
    "3. stairs: each stair flight or stair core as its bounding box: (x1,y1) top-left, (x2,y2) bottom-right.",
    "Return only the JSON object. If a category has nothing, return an empty array for it.",
  ].join("\n");
}

/* 送图前的缩放尺寸：长边压到 MAX_IMAGE_EDGE 以内（只缩不放），factor = 原图像素 / 送出去的像素，
   模型返回的坐标乘 factor 就回到原图像素坐标系（跟矢量解析/图像识别的候选在同一个坐标系里）。 */
export function computeDownscale(naturalW, naturalH, maxEdge = MAX_IMAGE_EDGE) {
  const longEdge = Math.max(naturalW, naturalH);
  if (!(longEdge > maxEdge)) return { width: Math.round(naturalW), height: Math.round(naturalH), factor: 1 };
  const width = Math.max(1, Math.round((naturalW * maxEdge) / longEdge));
  const height = Math.max(1, Math.round((naturalH * maxEdge) / longEdge));
  return { width, height, factor: naturalW / width };
}

/* 模型偶尔会在 JSON 外面裹一层 ```json 代码块或加一句话（结构化输出模式下基本不会，但 OpenAI
   某些模型/降级路径下仍可能），所以解析时先剥掉围栏、只取第一个 { 到最后一个 } 之间的内容。 */
export function parseFloorPlanJson(text) {
  if (text == null) throw new Error(t("模型没有返回任何内容"));
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error(t("模型返回的不是 JSON：") + s.slice(0, 80));
  return JSON.parse(s.slice(a, b + 1));
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

/* 把模型返回的（缩图像素坐标）结果换算回原图像素，并整理成跟 detectWallCandidates 输出一致的形状
   （{id,x1,y1,x2,y2,w}），这样 UI 那边接受/丢弃/标定换算的整条链路都不用改。
   非法条目（缺坐标、NaN、零长度）直接丢弃，不让一条坏数据把整批结果拖垮。 */
export function normalizeFloorPlanResult(parsed, factor = 1) {
  const src = parsed && typeof parsed === "object" ? parsed : {};
  const seg = (o) => {
    if (!o || typeof o !== "object") return null;
    const x1 = num(o.x1), y1 = num(o.y1), x2 = num(o.x2), y2 = num(o.y2);
    if (x1 == null || y1 == null || x2 == null || y2 == null) return null;
    if (Math.hypot(x2 - x1, y2 - y1) < 0.5) return null;
    return { x1: x1 * factor, y1: y1 * factor, x2: x2 * factor, y2: y2 * factor };
  };
  let id = 1;
  const walls = [];
  for (const o of Array.isArray(src.walls) ? src.walls : []) {
    const s = seg(o);
    if (!s) continue;
    const t = num(o.thickness);
    walls.push({ id: id++, ...s, w: Math.max(1, (t == null || t <= 0 ? 4 : t) * factor) });
  }
  const doors = [];
  for (const o of Array.isArray(src.doors) ? src.doors : []) {
    const s = seg(o);
    if (s) doors.push({ id: id++, ...s });
  }
  const stairs = [];
  for (const o of Array.isArray(src.stairs) ? src.stairs : []) {
    const s = seg(o);
    if (!s) continue;
    // 楼梯是包围盒：规整成左上/右下，模型给反了也不影响画出来
    stairs.push({ id: id++, x1: Math.min(s.x1, s.x2), y1: Math.min(s.y1, s.y2), x2: Math.max(s.x1, s.x2), y2: Math.max(s.y1, s.y2) });
  }
  return { walls, doors, stairs };
}

/* ---------- Anthropic Claude ---------- */
async function callAnthropic({ apiKey, model, image, fetch: fetchImpl }) {
  const client = new Anthropic({
    apiKey,
    dangerouslyAllowBrowser: true, // 用户自己的密钥、自己的浏览器直连——见文件头的说明；SDK 会自动带上 anthropic-dangerous-direct-browser-access 头
    maxRetries: 1,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  let msg;
  try {
    // 用 create 而不是 SDK 的 parse 辅助：parse 会在拒答/截断（正文是空的或半截 JSON）时先抛
    // "解析失败"，把更有用的 stop_reason 判断挡在前面——我们先看 stop_reason 再自己解析。
    msg = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      // 服务端兜底：极少数情况下安全分类器会拒答（平面图基本不可能触发），开着 fallbacks 让 API 自动换
      // 一个模型重跑同一请求，而不是直接失败——Anthropic 推荐新代码默认带上。
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      thinking: { type: "adaptive" },
      output_config: { effort: "high", format: { type: "json_schema", schema: FLOOR_PLAN_SCHEMA } },
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } },
            { type: "text", text: buildPrompt(image.width, image.height) },
          ],
        },
      ],
    });
  } catch (err) {
    throw new Error(describeAnthropicError(err));
  }
  if (msg.stop_reason === "refusal") throw new Error(t("Claude 拒绝处理这张图") + (msg.stop_details && msg.stop_details.explanation ? t("：") + msg.stop_details.explanation : ""));
  if (msg.stop_reason === "max_tokens") throw new Error(t("Claude 的回复超出长度上限被截断了（图太复杂），试试把图裁小一点再传"));
  const text = (msg.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  return { parsed: parseFloorPlanJson(text), model: msg.model };
}

function describeAnthropicError(err) {
  if (err instanceof Anthropic.AuthenticationError) return t("Claude 接口：API 密钥无效或没有权限（401）");
  if (err instanceof Anthropic.PermissionDeniedError) return t("Claude 接口：这个密钥没有权限用这个模型（403）");
  if (err instanceof Anthropic.NotFoundError) return t("Claude 接口：模型名不存在（404），检查一下模型名");
  if (err instanceof Anthropic.RateLimitError) return t("Claude 接口：请求太频繁或额度用完（429），稍后再试");
  if (err instanceof Anthropic.BadRequestError) return t("Claude 接口：请求被拒绝（400）：") + err.message;
  if (err instanceof Anthropic.APIConnectionError) return t("连不上 Claude 接口：检查网络（这个功能需要能直连 api.anthropic.com）");
  if (err instanceof Anthropic.APIError) return t("Claude 接口错误 {0}：{1}", [err.status, err.message]);
  return t("Claude 接口调用失败：") + (err && err.message ? err.message : String(err));
}

/* ---------- OpenAI ChatGPT ---------- */
export const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";

async function callOpenAi({ apiKey, model, image, fetch: fetchImpl }) {
  const f = fetchImpl || globalThis.fetch;
  let res;
  try {
    res = await f(OPENAI_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: buildPrompt(image.width, image.height) },
              { type: "image_url", image_url: { url: `data:${image.mediaType};base64,${image.data}`, detail: "high" } },
            ],
          },
        ],
        response_format: { type: "json_schema", json_schema: { name: "floor_plan", strict: true, schema: FLOOR_PLAN_SCHEMA } },
        max_completion_tokens: 16000,
      }),
    });
  } catch (err) {
    throw new Error(t("连不上 OpenAI 接口：检查网络（这个功能需要能直连 api.openai.com）——") + (err && err.message ? err.message : String(err)));
  }
  if (!res.ok) {
    let detail = "";
    try {
      const j = await res.json();
      detail = j && j.error && j.error.message ? t("：") + j.error.message : "";
    } catch {
      /* 非 JSON 错误体，忽略 */
    }
    const hint = res.status === 401 ? t("API 密钥无效") : res.status === 404 ? t("模型名不存在") : res.status === 429 ? t("请求太频繁或额度用完") : t("请求失败");
    throw new Error(t("OpenAI 接口：{0}（{1}）{2}", [hint, res.status, detail]));
  }
  const j = await res.json();
  const choice = j && j.choices && j.choices[0];
  if (!choice || !choice.message) throw new Error(t("OpenAI 接口返回了空结果"));
  if (choice.message.refusal) throw new Error(t("ChatGPT 拒绝处理这张图：") + choice.message.refusal);
  if (choice.finish_reason === "length") throw new Error(t("ChatGPT 的回复超出长度上限被截断了（图太复杂），试试把图裁小一点再传"));
  return { parsed: parseFloorPlanJson(choice.message.content), model: j.model || model };
}

/* 统一入口。image = { data(base64, 不带 data: 前缀), mediaType, width, height, factor }（见 aiVision.js 的
   prepareImageForAi）。返回 { walls, doors, stairs, model }，坐标已换算回原图像素。
   fetch 参数只给测试注入假的 fetch 用，正常运行不传。 */
export async function detectFloorPlanWithAi({ provider, apiKey, model, image, fetch: fetchImpl }) {
  const p = AI_PROVIDERS.find((x) => x.key === provider);
  if (!p) throw new Error(t("未知的 AI 服务商：") + provider);
  const key = (apiKey || "").trim();
  if (!key) throw new Error(t("还没有填 {0} 的 API 密钥", [p.label]));
  const m = (model || "").trim() || p.defaultModel;
  const call = provider === "anthropic" ? callAnthropic : callOpenAi;
  const { parsed, model: usedModel } = await call({ apiKey: key, model: m, image, fetch: fetchImpl });
  return { ...normalizeFloorPlanResult(parsed, image.factor || 1), model: usedModel };
}

