// 开发服务器端"工程文件桥"（src/dev/planFileBridge.mjs）的回归测试：不弹真的系统对话框（注入假的 showDialog），
// 把中间件挂在一个临时 http 服务器上，验证：ping、保存对话框→写盘、按记住的路径覆盖写、没选过的路径拒绝写、
// 打开对话框→读盘、取消/不支持的返回、跨源与非本机 Host 拒绝、坏 JSON 400、并发对话框 429。
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPlanFileMiddleware } from "../src/dev/planFileBridge.mjs";

let passed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log("  ✓ " + name);
  } catch (err) {
    console.error("  ✗ " + name);
    console.error(err);
    process.exitCode = 1;
  }
};

const tmp = await mkdtemp(path.join(os.tmpdir(), "plan-bridge-"));
let dialogResult = null; // 假对话框下次返回什么：字符串=选中的路径，null=取消，undefined=平台不支持
let dialogCalls = [];
let dialogDelay = 0;
const fakeDialog = async (kind, opts) => {
  dialogCalls.push({ kind, opts });
  if (dialogDelay) await new Promise((r) => setTimeout(r, dialogDelay));
  return dialogResult;
};
const mw = createPlanFileMiddleware({ showDialog: fakeDialog });
const server = http.createServer((req, res) => mw(req, res, () => { res.statusCode = 404; res.end("next"); }));
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
const call = (url, { method = "POST", body, headers = {} } = {}) =>
  fetch(base + url, { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

console.log("planFileBridge");

await test("ping：本机 GET 返回 ok 与平台信息；不相干的路径交给下一个中间件", async () => {
  const r = await call("/__plan/ping", { method: "GET" });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(typeof r.json.nativeDialog, "boolean");
  const other = await fetch(base + "/something");
  assert.equal(other.status, 404);
});

await test("保存对话框：用户选了路径 → 文件写到那个路径，返回 path/name；传给对话框的建议文件名正确", async () => {
  const target = path.join(tmp, "一层.stairplan.json");
  dialogResult = target;
  dialogCalls = [];
  const r = await call("/__plan/save-dialog", { body: { suggestedName: "一层.stairplan.json", text: '{"format":"stair-core-plan"}' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.path, target);
  assert.equal(r.json.name, "一层.stairplan.json");
  assert.equal(await readFile(target, "utf8"), '{"format":"stair-core-plan"}');
  assert.equal(dialogCalls[0].kind, "save");
  assert.equal(dialogCalls[0].opts.suggestedName, "一层.stairplan.json");
});

await test("覆盖写：对话框里选过的路径可以直接写；没选过的路径 403", async () => {
  const target = path.join(tmp, "一层.stairplan.json");
  const ok = await call("/__plan/write", { body: { path: target, text: "v2" } });
  assert.equal(ok.status, 200);
  assert.equal(await readFile(target, "utf8"), "v2");
  const bad = await call("/__plan/write", { body: { path: path.join(tmp, "别处.json"), text: "x" } });
  assert.equal(bad.status, 403);
  assert.match(bad.json.error, /另存为/);
  const sys = await call("/__plan/write", { body: { path: "C:\\Windows\\evil.json", text: "x" } });
  assert.equal(sys.status, 403);
});

await test("打开对话框：读回文件内容；之后这个路径也允许覆盖写", async () => {
  const target = path.join(tmp, "旧的.stairplan.json");
  await writeFile(target, '{"hello":"old"}', "utf8");
  dialogResult = target;
  const r = await call("/__plan/open-dialog", { body: {} });
  assert.equal(r.status, 200);
  assert.equal(r.json.text, '{"hello":"old"}');
  assert.equal(r.json.name, "旧的.stairplan.json");
  const w = await call("/__plan/write", { body: { path: target, text: "new" } });
  assert.equal(w.status, 200);
});

await test("取消 → {cancelled:true}；平台不支持 → {unsupported:true}；都不写文件", async () => {
  dialogResult = null;
  const c = await call("/__plan/save-dialog", { body: { text: "x" } });
  assert.deepEqual(c.json, { cancelled: true });
  dialogResult = undefined;
  const u = await call("/__plan/save-dialog", { body: { text: "x" } });
  assert.deepEqual(u.json, { unsupported: true });
});

await test("安全：非本机 Host 403、外部 Origin 403、本机 Origin 放行、坏 JSON 400、GET 非 ping 405", async () => {
  // fetch 不允许改 Host 头（会被静默忽略），用原生 http.request 发一个伪造 Host 的请求
  const hostStatus = await new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/__plan/ping", method: "GET", headers: { Host: "evil.example" } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", reject);
    req.end();
  });
  assert.equal(hostStatus, 403);
  const o = await call("/__plan/ping", { method: "GET", headers: { Origin: "https://evil.example" } });
  assert.equal(o.status, 403);
  const ok = await call("/__plan/ping", { method: "GET", headers: { Origin: "http://localhost:5173" } });
  assert.equal(ok.status, 200);
  const bad = await fetch(base + "/__plan/write", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{nope" });
  assert.equal(bad.status, 400);
  const g = await call("/__plan/write", { method: "GET" });
  assert.equal(g.status, 405);
});

await test("并发：对话框开着时第二个请求 429", async () => {
  dialogResult = null;
  dialogDelay = 300;
  const p1 = call("/__plan/open-dialog", { body: {} });
  await new Promise((r) => setTimeout(r, 50));
  const p2 = await call("/__plan/open-dialog", { body: {} });
  assert.equal(p2.status, 429);
  const r1 = await p1;
  assert.deepEqual(r1.json, { cancelled: true });
  dialogDelay = 0;
});

await test("示例目录：列出 .json 文件（按名字自然排序，忽略子目录和其它后缀）；按名字打开；非法名字/不存在/没配置目录各自报错", async () => {
  const exDir = path.join(tmp, "Saved Plans");
  await mkdir(path.join(exDir, "sub"), { recursive: true });
  await writeFile(path.join(exDir, "Example 10.json"), '{"n":10}', "utf8");
  await writeFile(path.join(exDir, "Example 2.stairplan.json"), '{"n":2}', "utf8");
  await writeFile(path.join(exDir, "readme.txt"), "x", "utf8");
  const mw2 = createPlanFileMiddleware({ showDialog: fakeDialog, examplesDir: exDir });
  const srv2 = http.createServer((req, res) => mw2(req, res, () => { res.statusCode = 404; res.end("next"); }));
  await new Promise((r) => srv2.listen(0, "127.0.0.1", r));
  const b2 = `http://127.0.0.1:${srv2.address().port}`;
  const c2 = (url, init) => fetch(b2 + url, init).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  const ping = await c2("/__plan/ping");
  assert.equal(ping.json.examples, true);
  const list = await c2("/__plan/examples");
  assert.equal(list.status, 200);
  assert.deepEqual(list.json.files.map((f) => f.name), ["Example 2.stairplan.json", "Example 10.json"], "数字按自然顺序，子目录和 txt 不出现");
  assert.ok(list.json.files[0].size > 0 && list.json.files[0].mtime > 0);
  const open = await c2("/__plan/open-example", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Example 2.stairplan.json" }) });
  assert.equal(open.status, 200);
  assert.equal(open.json.text, '{"n":2}');
  assert.equal(open.json.path, path.resolve(exDir, "Example 2.stairplan.json"));
  // 打开过的示例允许直接覆盖写
  const w = await c2("/__plan/write", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: open.json.path, text: '{"n":22}' }) });
  assert.equal(w.status, 200);
  for (const bad of ["../secret.json", "sub/x.json", "C:\\Windows\\x.json", "readme.txt", "", 5]) {
    const r = await c2("/__plan/open-example", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: bad }) });
    assert.equal(r.status, 400, `非法名字应 400：${JSON.stringify(bad)}`);
  }
  const missing = await c2("/__plan/open-example", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "没有这个.json" }) });
  assert.equal(missing.status, 404);
  srv2.close();
  // 没配置示例目录的实例：列表为空、打开 404
  const none = await call("/__plan/examples", { method: "GET" });
  assert.deepEqual(none.json, { dir: null, files: [] });
  const noneOpen = await call("/__plan/open-example", { body: { name: "a.json" } });
  assert.equal(noneOpen.status, 404);
});

server.close();
await rm(tmp, { recursive: true, force: true });
console.log(process.exitCode ? "有测试失败" : `全部通过（${passed} 项）`);
