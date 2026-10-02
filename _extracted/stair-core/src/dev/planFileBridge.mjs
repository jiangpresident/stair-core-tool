// 开发服务器端的"工程文件桥"：替浏览器弹 Windows 原生的另存为 / 打开对话框，并直接读写磁盘文件。
// 为什么需要它：Claude 桌面端的内置浏览器面板（以及一些受限 webview）允许弹 showSaveFilePicker 却不让
// createWritable 写文件，用户想在面板里也能自选保存位置。开发服务器是 Node 进程，跑在用户自己的电脑上，
// 它可以：①用 PowerShell 弹系统对话框（System.Windows.Forms.SaveFileDialog / OpenFileDialog）让用户选路径；
// ②把浏览器 POST 过来的 JSON 写到那个路径；③"保存"时按记住的路径直接覆盖，不再弹窗。
// 只在 `vite`（开发服务器）下挂载（vite.config.js），`vite build` 和 dist-single 静态版没有这层。
//
// 安全边界：
//   - 只接受 Host / Origin 为本机（localhost / 127.0.0.1）的请求；
//   - 写文件只允许写"本次服务器会话里用户在对话框里亲自选过的路径"（allowed 集合），浏览器不能指定任意路径；
//   - 同一时间只弹一个对话框（busy → 429）。
// 纯 Node，不依赖 Vite 的 API：createPlanFileMiddleware 可以挂在任何 connect 风格的服务器上，showDialog
// 可注入假的实现做单测（scripts/test-plan-bridge.mjs）。
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const MAX_BODY = 60 * 1024 * 1024; // 工程文件里有底图 dataURL，放宽到 60MB
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1)(:\d{1,5})?$/i;
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/i;

const psQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'";

/* 用 PowerShell 弹系统对话框。kind = "save" | "open"。返回选中的完整路径，取消返回 null，
   非 Windows 平台返回 undefined（调用方回退）。-STA 是 WinForms 对话框的硬性要求；脚本用 -EncodedCommand
   传（UTF-16LE base64），避免引号/中文转义问题；对话框挂在一个置顶的隐形窗体上，避免弹在别的窗口后面。 */
export async function showNativeDialog(kind, { suggestedName = "", initialDir = "", title = "" } = {}) {
  if (process.platform !== "win32") return undefined;
  const isSave = kind === "save";
  const dir = initialDir && path.isAbsolute(initialDir) ? initialDir : path.join(os.homedir(), "Documents");
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "$owner = New-Object System.Windows.Forms.Form",
    "$owner.TopMost = $true; $owner.ShowInTaskbar = $false; $owner.Opacity = 0; $owner.Size = New-Object System.Drawing.Size(1,1); $owner.StartPosition = 'CenterScreen'",
    `$d = New-Object System.Windows.Forms.${isSave ? "SaveFileDialog" : "OpenFileDialog"}`,
    `$d.Title = ${psQuote(title || (isSave ? "保存平面图工程" : "打开平面图工程"))}`,
    `$d.Filter = ${psQuote("平面图工程 (*.stairplan.json)|*.stairplan.json|JSON 文件 (*.json)|*.json|所有文件 (*.*)|*.*")}`,
    `$d.InitialDirectory = ${psQuote(dir)}`,
    isSave ? `$d.FileName = ${psQuote(suggestedName)}; $d.DefaultExt = 'json'; $d.AddExtension = $true; $d.OverwritePrompt = $true` : "$d.Multiselect = $false; $d.CheckFileExists = $true",
    "$r = $d.ShowDialog($owner)",
    "if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) }",
    "$owner.Dispose()",
  ].join("\n");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d.toString("utf8")));
    child.stderr.on("data", (d) => (err += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && !out) return reject(new Error("系统对话框启动失败：" + (err.trim() || `powershell 退出码 ${code}`)));
      const p = out.trim();
      resolve(p ? p : null);
    });
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("请求太大"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/* connect 风格中间件。showDialog 可注入（测试用假的）；allowed 是本会话里对话框选过的路径集合。
   examplesDir：示例工程目录（项目根目录的 "Saved Plans"），界面上的 example 面板靠 /__plan/examples 列出
   里面的 .json 文件、/__plan/open-example 按文件名打开——只认这个目录里的文件名（basename），不接受路径。 */
export function createPlanFileMiddleware({ showDialog = showNativeDialog, log = () => {}, examplesDir = null } = {}) {
  const allowed = new Set();
  let busy = false;
  const isPlainName = (n) => typeof n === "string" && n.length > 0 && n.length < 256 && !/[\\/]/.test(n) && n !== "." && n !== ".." && /\.json$/i.test(n);
  const send = (res, status, obj) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(obj));
  };
  return async function planFileMiddleware(req, res, next) {
    const url = (req.url || "").split("?")[0];
    if (!url.startsWith("/__plan/")) return next();
    if (!LOOPBACK_HOST.test(req.headers.host || "")) return send(res, 403, { error: "只接受本机请求" });
    const origin = req.headers.origin;
    if (origin && !LOOPBACK_ORIGIN.test(origin)) return send(res, 403, { error: "不接受跨源请求" });
    if (req.method === "GET" && url === "/__plan/ping") return send(res, 200, { ok: true, platform: process.platform, nativeDialog: process.platform === "win32", examples: !!examplesDir });
    if (req.method === "GET" && url === "/__plan/examples") {
      if (!examplesDir) return send(res, 200, { dir: null, files: [] });
      try {
        const names = (await readdir(examplesDir)).filter((n) => isPlainName(n));
        const files = [];
        for (const name of names) {
          const st = await stat(path.join(examplesDir, name));
          if (st.isFile()) files.push({ name, size: st.size, mtime: st.mtimeMs });
        }
        files.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true }));
        return send(res, 200, { dir: examplesDir, files });
      } catch (err) {
        if (err && err.code === "ENOENT") return send(res, 200, { dir: examplesDir, files: [], missing: true });
        return send(res, 500, { error: err && err.message ? err.message : String(err) });
      }
    }
    if (req.method !== "POST") return send(res, 405, { error: "只接受 POST" });
    let body;
    try {
      body = JSON.parse((await readBody(req)) || "{}");
    } catch (err) {
      return send(res, err && err.status === 413 ? 413 : 400, { error: err && err.status === 413 ? "工程文件太大（上限 60MB）" : "请求不是有效 JSON" });
    }
    try {
      if (url === "/__plan/save-dialog" || url === "/__plan/open-dialog") {
        if (busy) return send(res, 429, { error: "已经有一个系统对话框开着，先处理它" });
        busy = true;
        let picked;
        try {
          picked = await showDialog(url === "/__plan/save-dialog" ? "save" : "open", { suggestedName: body.suggestedName || "", initialDir: body.initialDir || "" });
        } finally {
          busy = false;
        }
        if (picked === undefined) return send(res, 200, { unsupported: true });
        if (!picked) return send(res, 200, { cancelled: true });
        const full = path.resolve(picked);
        allowed.add(full);
        if (url === "/__plan/save-dialog") {
          if (typeof body.text !== "string") return send(res, 400, { error: "缺少要保存的内容" });
          await mkdir(path.dirname(full), { recursive: true });
          await writeFile(full, body.text, "utf8");
          log(`已保存工程：${full}`);
          return send(res, 200, { path: full, name: path.basename(full) });
        }
        const text = await readFile(full, "utf8");
        log(`已打开工程：${full}`);
        return send(res, 200, { path: full, name: path.basename(full), text });
      }
      if (url === "/__plan/write") {
        const full = typeof body.path === "string" ? path.resolve(body.path) : "";
        if (!full || !allowed.has(full)) return send(res, 403, { error: "这个路径不是在对话框里选过的，不能直接写；请用“另存为”" });
        if (typeof body.text !== "string") return send(res, 400, { error: "缺少要保存的内容" });
        await writeFile(full, body.text, "utf8");
        log(`已覆盖保存工程：${full}`);
        return send(res, 200, { path: full, name: path.basename(full) });
      }
      if (url === "/__plan/open-example") {
        if (!examplesDir) return send(res, 404, { error: "没有配置示例目录" });
        if (!isPlainName(body.name)) return send(res, 400, { error: "示例文件名不合法" });
        const full = path.join(examplesDir, body.name);
        let text;
        try {
          text = await readFile(full, "utf8");
        } catch (err) {
          if (err && err.code === "ENOENT") return send(res, 404, { error: `示例文件不存在：${body.name}` });
          throw err;
        }
        allowed.add(path.resolve(full)); // 打开后允许 Ctrl+S 存回这个示例文件（跟"打开…"一致）
        log(`已打开示例：${full}`);
        return send(res, 200, { path: path.resolve(full), name: body.name, text });
      }
      return send(res, 404, { error: "未知接口" });
    } catch (err) {
      return send(res, 500, { error: err && err.message ? err.message : String(err) });
    }
  };
}

/* Vite 插件封装 */
export function planFileBridgePlugin({ examplesDir = null } = {}) {
  return {
    name: "plan-file-bridge",
    apply: "serve",
    configureServer(server) {
      const log = (m) => server.config.logger.info("[plan-file] " + m);
      server.middlewares.use(createPlanFileMiddleware({ log, examplesDir }));
      if (examplesDir) log(`示例工程目录：${examplesDir}`);
      log(process.platform === "win32" ? "工程文件桥已就绪（系统另存为/打开对话框 + 直接写盘）" : "工程文件桥已就绪（当前平台没有系统对话框，浏览器会走自己的保存方式）");
    },
  };
}
