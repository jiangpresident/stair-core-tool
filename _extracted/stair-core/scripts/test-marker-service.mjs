// 开发服务器端 Marker 进程管理（src/dev/markerService.mjs）的回归测试：注入假的 spawn / 探活，不真起 Python。
// 验证：已在线 → 不再起进程；没装 .venv → 返回安装提示；正常启动 → 轮询到上线；启动后立刻退出 → 报错；
// 超时 → 报错；重复点"启动"复用同一个启动过程；中间件的 status/start/403。
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createMarkerManager } from "../src/dev/markerService.mjs";

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

// 假的 floorplan-marker 目录：有 .venv 的 python 和 server.py（内容无所谓，只看 existsSync）
const root = await mkdtemp(path.join(os.tmpdir(), "marker-svc-"));
const pyDir = process.platform === "win32" ? path.join(root, ".venv", "Scripts") : path.join(root, ".venv", "bin");
await mkdir(pyDir, { recursive: true });
await writeFile(path.join(pyDir, process.platform === "win32" ? "python.exe" : "python"), "");
await writeFile(path.join(root, "server.py"), "");
const emptyRoot = await mkdtemp(path.join(os.tmpdir(), "marker-empty-"));

function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.killed = false;
  c.kill = () => {
    c.killed = true;
    c.emit("exit", 0);
  };
  return c;
}

console.log("markerService");

await test("已经在线 → 直接返回 already，不 spawn", async () => {
  let spawned = 0;
  const m = createMarkerManager({ root, spawn: () => { spawned++; return fakeChild(); }, isOnline: async () => true });
  assert.deepEqual(await m.start(), { ok: true, already: true });
  assert.equal(spawned, 0);
});

await test("没装 .venv → 不 spawn，返回安装提示", async () => {
  let spawned = 0;
  const m = createMarkerManager({ root: emptyRoot, spawn: () => { spawned++; return fakeChild(); }, isOnline: async () => false });
  const r = await m.start();
  assert.equal(r.ok, false);
  assert.equal(r.needInstall, true);
  assert.match(r.error, /start_windows\.bat/);
  assert.equal(spawned, 0);
});

await test("正常启动：spawn 一次、轮询到上线；重复 start 复用同一个过程；stop 杀进程", async () => {
  let online = false, spawned = 0, spawnArgs = null;
  const child = fakeChild();
  const m = createMarkerManager({ root, spawn: (cmd, args) => { spawned++; spawnArgs = [cmd, args]; setTimeout(() => (online = true), 150); return child; }, isOnline: async () => online, pollMs: 30 });
  const [a, b] = await Promise.all([m.start(), m.start()]);
  assert.deepEqual(a, { ok: true, started: true });
  assert.deepEqual(b, { ok: true, started: true });
  assert.equal(spawned, 1, "两次 start 只能起一个进程");
  assert.ok(spawnArgs[0].includes(".venv"));
  assert.deepEqual(spawnArgs[1].slice(1), ["--port", "8765"]);
  m.stop();
  assert.equal(child.killed, true);
  assert.equal(m.child, null, "exit 之后 child 置空");
});

await test("启动后立刻退出 → 报错并带上 stderr 尾巴", async () => {
  const child = fakeChild();
  const m = createMarkerManager({ root, spawn: () => { setTimeout(() => { child.stderr.emit("data", "ModuleNotFoundError: cv2"); child.emit("exit", 1); }, 50); return child; }, isOnline: async () => false, pollMs: 20 });
  const r = await m.start();
  assert.equal(r.ok, false);
  assert.match(r.error, /退出/);
  assert.match(r.error, /cv2/);
});

await test("一直没上线 → 超时报错", async () => {
  const m = createMarkerManager({ root, spawn: () => fakeChild(), isOnline: async () => false, startupTimeoutMs: 200, pollMs: 30 });
  const r = await m.start();
  assert.equal(r.ok, false);
  assert.match(r.error, /没有上线/);
});

await test("中间件：status / start / 外部来源 403 / 未知接口 404", async () => {
  let online = false;
  const m = createMarkerManager({ root, spawn: () => { setTimeout(() => (online = true), 50); return fakeChild(); }, isOnline: async () => online, pollMs: 20 });
  const server = http.createServer((req, res) => m.middleware(req, res, () => { res.statusCode = 404; res.end("next"); }));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const j = async (url, init) => { const r = await fetch(base + url, init); return { status: r.status, json: await r.json().catch(() => null) }; };
  const s0 = await j("/__marker/status");
  assert.equal(s0.status, 200);
  assert.deepEqual(s0.json, { online: false, installed: true, running: false });
  const st = await j("/__marker/start", { method: "POST" });
  assert.equal(st.status, 200);
  assert.equal(st.json.ok, true);
  const s1 = await j("/__marker/status");
  assert.equal(s1.json.online, true);
  assert.equal(s1.json.running, true);
  assert.equal((await j("/__marker/status", { headers: { Origin: "https://evil.example" } })).status, 403);
  assert.equal((await j("/__marker/nope")).status, 404);
  assert.equal((await fetch(base + "/other")).status, 404);
  server.close();
});

await rm(root, { recursive: true, force: true });
await rm(emptyRoot, { recursive: true, force: true });
console.log(process.exitCode ? "有测试失败" : `全部通过（${passed} 项）`);
