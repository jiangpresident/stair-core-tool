// AI 识图路线（src/plan/aiVisionDetect.js）的回归测试：不真的调接口（用户还没有 API 密钥，而且
// 测试不该花钱/依赖网络），用假的 fetch 冒充两家的服务端，验证的是我们这边能控制的部分：
//   1. 发出去的请求长得对不对（地址、鉴权头、图片有没有带上、结构化输出的 schema 有没有带上）；
//   2. 返回的 JSON（含带 ```json 围栏的脏格式）能不能解析、非法条目能不能被丢掉；
//   3. 缩图 factor 的坐标换算是否精确还原回原图像素；
//   4. 接口报错（401/429、拒答、截断）能不能变成用户看得懂的中文提示，而不是一坨堆栈。
import assert from "node:assert/strict";
import {
  AI_PROVIDERS,
  OPENAI_ENDPOINT,
  FLOOR_PLAN_SCHEMA,
  computeDownscale,
  parseFloorPlanJson,
  normalizeFloorPlanResult,
  detectFloorPlanWithAi,
  readAiSettings,
  writeAiSettings,
  AI_SETTINGS_KEY,
} from "../src/plan/aiVisionDetect.js";

let passed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log("  ✓ " + name);
    })
    .catch((err) => {
      console.error("  ✗ " + name);
      console.error(err);
      process.exitCode = 1;
    });
}

const SAMPLE = { walls: [{ x1: 10, y1: 20, x2: 110, y2: 20, thickness: 3 }, { x1: 110, y1: 20, x2: 110, y2: 80, thickness: 2.5 }], doors: [{ x1: 40, y1: 20, x2: 60, y2: 20 }], stairs: [{ x1: 90, y1: 70, x2: 70, y2: 40 }] };
const IMAGE = { data: "AAAA", mediaType: "image/jpeg", width: 100, height: 80, factor: 4 };

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

const anthropicMessage = (text, extra = {}) =>
  json({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
    ...extra,
  });

const openAiCompletion = (content, extra = {}) =>
  json({ id: "chatcmpl_1", model: "gpt-5", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content, ...extra } }] });

console.log("aiVisionDetect");

await test("computeDownscale：长边压到 1568 以内，短边等比，factor 精确对应", () => {
  const d = computeDownscale(4000, 3000);
  assert.equal(d.width, 1568);
  assert.equal(d.height, 1176);
  assert.ok(Math.abs(d.factor - 4000 / 1568) < 1e-9);
  const small = computeDownscale(800, 600);
  assert.deepEqual(small, { width: 800, height: 600, factor: 1 });
});

await test("parseFloorPlanJson：剥掉 ```json 围栏和前后废话也能解析", () => {
  const r = parseFloorPlanJson("Here you go:\n```json\n" + JSON.stringify(SAMPLE) + "\n```\nDone.");
  assert.equal(r.walls.length, 2);
  assert.throws(() => parseFloorPlanJson("no json here"), /不是 JSON/);
});

await test("normalizeFloorPlanResult：坐标乘 factor、分配 id、楼梯包围盒规整、坏条目丢弃", () => {
  const r = normalizeFloorPlanResult(
    { walls: [...SAMPLE.walls, { x1: "a", y1: 0, x2: 1, y2: 1, thickness: 1 }, { x1: 5, y1: 5, x2: 5, y2: 5, thickness: 1 }], doors: SAMPLE.doors, stairs: SAMPLE.stairs },
    4
  );
  assert.equal(r.walls.length, 2, "非数字坐标和零长度墙应被丢弃");
  assert.deepEqual(r.walls[0], { id: 1, x1: 40, y1: 80, x2: 440, y2: 80, w: 12 });
  assert.equal(r.walls[1].w, 10);
  assert.deepEqual(r.doors[0], { id: 3, x1: 160, y1: 80, x2: 240, y2: 80 });
  assert.deepEqual(r.stairs[0], { id: 4, x1: 280, y1: 160, x2: 360, y2: 280 }, "楼梯给反了的左上/右下要被规整");
  assert.deepEqual(normalizeFloorPlanResult(null), { walls: [], doors: [], stairs: [] });
});

await test("Anthropic：请求打到官方接口、带密钥与浏览器直连头、图片和 JSON schema 都在；结果换算回原图像素", async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return anthropicMessage(JSON.stringify(SAMPLE));
  };
  const r = await detectFloorPlanWithAi({ provider: "anthropic", apiKey: "sk-ant-test", model: "", image: IMAGE, fetch });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/api\.anthropic\.com\/v1\/messages/);
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("x-api-key"), "sk-ant-test");
  assert.equal(headers.get("anthropic-dangerous-direct-browser-access"), "true");
  assert.match(headers.get("anthropic-beta") || "", /server-side-fallback-2026-07-01/);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, "claude-opus-5-5", "没填模型名时用服务商默认模型");
  assert.equal(body.fallbacks, "default");
  assert.deepEqual(body.thinking, { type: "adaptive" });
  assert.equal(body.output_config.format.type, "json_schema");
  assert.deepEqual(body.output_config.format.schema.required, FLOOR_PLAN_SCHEMA.required);
  const content = body.messages[0].content;
  assert.equal(content[0].type, "image");
  assert.equal(content[0].source.data, "AAAA");
  assert.equal(content[0].source.media_type, "image/jpeg");
  assert.match(content[1].text, /100 x 80 pixels/);
  assert.equal(r.model, "claude-opus-5-5");
  assert.equal(r.walls.length, 2);
  assert.deepEqual(r.walls[0], { id: 1, x1: 40, y1: 80, x2: 440, y2: 80, w: 12 });
  assert.equal(r.doors.length, 1);
  assert.equal(r.stairs.length, 1);
});

await test("Anthropic：401 / 拒答 / 截断都变成中文提示", async () => {
  await assert.rejects(
    detectFloorPlanWithAi({ provider: "anthropic", apiKey: "bad", image: IMAGE, fetch: async () => json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, 401) }),
    /密钥无效/
  );
  await assert.rejects(
    detectFloorPlanWithAi({ provider: "anthropic", apiKey: "k", image: IMAGE, fetch: async () => anthropicMessage("", { stop_reason: "refusal", stop_details: { type: "refusal", category: null, explanation: "nope" } }) }),
    /拒绝处理/
  );
  await assert.rejects(
    detectFloorPlanWithAi({ provider: "anthropic", apiKey: "k", image: IMAGE, fetch: async () => anthropicMessage("{\"walls\":[", { stop_reason: "max_tokens" }) }),
    /截断/
  );
});

await test("OpenAI：请求打到官方接口、Bearer 鉴权、data URL 图片、strict json_schema；结果换算回原图像素", async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return openAiCompletion(JSON.stringify(SAMPLE));
  };
  const r = await detectFloorPlanWithAi({ provider: "openai", apiKey: "sk-test", model: "gpt-5-mini", image: IMAGE, fetch });
  assert.equal(calls[0].url, OPENAI_ENDPOINT);
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, "gpt-5-mini", "填了模型名就用填的");
  assert.equal(body.response_format.type, "json_schema");
  assert.equal(body.response_format.json_schema.strict, true);
  assert.equal(body.max_completion_tokens, 16000);
  assert.equal(body.temperature, undefined, "gpt-5 系列不接受非默认 temperature，不能发");
  const user = body.messages.find((m) => m.role === "user");
  const img = user.content.find((c) => c.type === "image_url");
  assert.equal(img.image_url.url, "data:image/jpeg;base64,AAAA");
  assert.equal(r.model, "gpt-5");
  assert.deepEqual(r.walls[1], { id: 2, x1: 440, y1: 80, x2: 440, y2: 320, w: 10 });
});

await test("OpenAI：带围栏的内容也能解析；401/429/拒答/截断变成中文提示", async () => {
  const r = await detectFloorPlanWithAi({ provider: "openai", apiKey: "k", image: IMAGE, fetch: async () => openAiCompletion("```json\n" + JSON.stringify(SAMPLE) + "\n```") });
  assert.equal(r.walls.length, 2);
  await assert.rejects(detectFloorPlanWithAi({ provider: "openai", apiKey: "k", image: IMAGE, fetch: async () => json({ error: { message: "Incorrect API key provided" } }, 401) }), /密钥无效.*Incorrect API key/);
  await assert.rejects(detectFloorPlanWithAi({ provider: "openai", apiKey: "k", image: IMAGE, fetch: async () => json({ error: { message: "quota" } }, 429) }), /额度/);
  await assert.rejects(detectFloorPlanWithAi({ provider: "openai", apiKey: "k", image: IMAGE, fetch: async () => openAiCompletion(null, { refusal: "I can't" }) }), /拒绝处理/);
  await assert.rejects(
    detectFloorPlanWithAi({ provider: "openai", apiKey: "k", image: IMAGE, fetch: async () => json({ choices: [{ finish_reason: "length", message: { role: "assistant", content: "{" } }] }) }),
    /截断/
  );
});

await test("没填密钥 / 未知服务商：直接报中文错误，不发请求", async () => {
  let called = 0;
  const fetch = async () => {
    called++;
    return json({});
  };
  await assert.rejects(detectFloorPlanWithAi({ provider: "anthropic", apiKey: "   ", image: IMAGE, fetch }), /还没有填/);
  await assert.rejects(detectFloorPlanWithAi({ provider: "gemini", apiKey: "k", image: IMAGE, fetch }), /未知的 AI 服务商/);
  assert.equal(called, 0);
});

await test("readAiSettings/writeAiSettings：默认值、合并旧数据、坏 JSON 不炸", () => {
  const store = new Map();
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };
  const d = readAiSettings(storage);
  assert.equal(d.provider, "anthropic");
  assert.deepEqual(d.keys, { anthropic: "", openai: "" });
  writeAiSettings(storage, { provider: "openai", keys: { openai: "sk-x" }, models: {} });
  assert.ok(store.get(AI_SETTINGS_KEY).includes("sk-x"));
  const r = readAiSettings(storage);
  assert.equal(r.provider, "openai");
  assert.equal(r.keys.openai, "sk-x");
  assert.equal(r.keys.anthropic, "", "缺的字段补默认值");
  store.set(AI_SETTINGS_KEY, "{not json");
  assert.equal(readAiSettings(storage).provider, "anthropic");
  assert.equal(readAiSettings(null).provider, "anthropic");
  assert.equal(AI_PROVIDERS.length, 2);
});

console.log(process.exitCode ? "有测试失败" : `全部通过（${passed} 项）`);
