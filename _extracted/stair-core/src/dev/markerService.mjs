// 开发服务器端：管理本机 Floorplan Marker 识图服务（floorplan-marker/server.py，127.0.0.1:8765）的进程。
// 两个入口：①开发服务器启动时自动拉起（vite.config.js 的 markerAutostart 插件）；②界面上的"启动服务"按钮
// （用户要求"启动 floorplan-marker/start_windows.bat 的服务我希望在平面图 UI 上有一个按钮"）→ POST /__marker/start。
// 纯 Node，spawn / 探活都可注入，方便单测（scripts/test-marker-service.mjs）。
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export const MARKER_HEALTH_URL = "http://127.0.0.1:8765/api/health";
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1)(:\d{1,5})?$/i;
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/i;

export async function defaultIsOnline() {
  try {
    const r = await fetch(MARKER_HEALTH_URL, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

export function createMarkerManager({ root, log = () => {}, spawn = nodeSpawn, isOnline = defaultIsOnline, startupTimeoutMs = 20000, pollMs = 300 } = {}) {
  const py = process.platform === "win32" ? path.join(root, ".venv", "Scripts", "python.exe") : path.join(root, ".venv", "bin", "python");
  const serverPy = path.join(root, "server.py");
  let child = null;
  let starting = null; // 正在启动的 Promise，重复点按钮时复用，不会起第二个进程

  const installHint = "没找到 floorplan-marker 的 Python 环境（.venv）——第一次要先双击项目根目录的“启动平面图工具.bat”或 floorplan-marker/start_windows.bat 安装依赖（需要联网，几分钟）";

  async function start() {
    if (await isOnline()) return { ok: true, already: true };
    if (!existsSync(py) || !existsSync(serverPy)) return { ok: false, error: installHint, needInstall: true };
    if (!starting) {
      starting = (async () => {
        child = spawn(py, [serverPy, "--port", "8765"], { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        let lastErr = "";
        child.stdout?.on("data", (d) => log(String(d).trim()));
        child.stderr?.on("data", (d) => {
          lastErr = String(d).trim();
          log(lastErr);
        });
        child.on("exit", (code) => {
          log(`服务已退出（code ${code}）`);
          child = null;
        });
        const deadline = Date.now() + startupTimeoutMs;
        while (Date.now() < deadline) {
          if (await isOnline()) return { ok: true, started: true };
          if (!child) return { ok: false, error: "Floorplan Marker 启动后立刻退出了" + (lastErr ? "：" + lastErr.slice(-300) : "，看开发服务器的终端输出") };
          await new Promise((r) => setTimeout(r, pollMs));
        }
        return { ok: false, error: `Floorplan Marker 在 ${Math.round(startupTimeoutMs / 1000)} 秒内没有上线，看开发服务器的终端输出` };
      })().finally(() => {
        starting = null;
      });
    }
    return starting;
  }

  function stop() {
    if (child && !child.killed) child.kill();
  }

  const send = (res, status, obj) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(obj));
  };
  async function middleware(req, res, next) {
    const url = (req.url || "").split("?")[0];
    if (!url.startsWith("/__marker/")) return next();
    if (!LOOPBACK_HOST.test(req.headers.host || "")) return send(res, 403, { error: "只接受本机请求" });
    const origin = req.headers.origin;
    if (origin && !LOOPBACK_ORIGIN.test(origin)) return send(res, 403, { error: "不接受跨源请求" });
    if (req.method === "GET" && url === "/__marker/status") return send(res, 200, { online: await isOnline(), installed: existsSync(py), running: !!child });
    if (req.method === "POST" && url === "/__marker/start") {
      try {
        const r = await start();
        return send(res, r.ok ? 200 : 500, r);
      } catch (err) {
        return send(res, 500, { ok: false, error: err && err.message ? err.message : String(err) });
      }
    }
    return send(res, 404, { error: "未知接口" });
  }

  return { start, stop, isOnline, middleware, get child() { return child; } };
}
