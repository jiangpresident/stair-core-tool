import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planFileBridgePlugin } from "./src/dev/planFileBridge.mjs";
import { createMarkerManager } from "./src/dev/markerService.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

/* 开发服务器启动时顺手把本机 Floorplan Marker 识图服务（项目根目录 floorplan-marker/，Python + OpenCV，
   127.0.0.1:8765）一起拉起来——用户不想每次都单独双击它的 start_windows.bat 才能用识图菜单。
   同时挂上 /__marker/status 和 /__marker/start 两个接口，界面上的"启动服务"按钮靠它们把服务重新拉起来。
   规则：
   - 只在 `vite`（开发服务器）下生效，`vite build` 不管；
   - 已经在线（比如用户自己双击启动过）就不再起第二个，端口会冲突；
   - 找不到 .venv 就只打一行提示（第一次要先双击 floorplan-marker/start_windows.bat 或项目根目录的
     "启动平面图工具.bat" 装依赖），不报错不中断；
   - 开发服务器关掉（Ctrl+C / 进程退出）时把它一起关掉，不留孤儿进程；
   - 环境变量 MARKER_AUTOSTART=0 可关闭自动启动（接口仍在）；MARKER_DIR 可改目录。
   进程管理的实现在 src/dev/markerService.mjs（可单测）。 */
function markerAutostart() {
  return {
    name: "floorplan-marker-autostart",
    apply: "serve",
    configureServer(server) {
      const log = server.config.logger;
      const root = process.env.MARKER_DIR || path.resolve(here, "../../floorplan-marker");
      const manager = createMarkerManager({ root, log: (m) => log.info("[marker] " + m) });
      server.middlewares.use(manager.middleware);
      const stop = () => manager.stop();
      server.httpServer?.once("close", stop);
      process.once("exit", stop);
      for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(sig, () => { stop(); process.exit(); });
      if (process.env.MARKER_AUTOSTART === "0") return;
      manager
        .start()
        .then((r) => {
          if (r.ok && r.already) log.info("[marker] Floorplan Marker 已在 127.0.0.1:8765 在线，沿用");
          else if (r.ok) log.info("[marker] 已随开发服务器启动 Floorplan Marker（127.0.0.1:8765）");
          else log.warn("[marker] " + r.error + "——识图菜单里的“本机 Marker”暂时用不了，可在界面上点“启动服务”重试");
        })
        .catch((err) => log.warn("[marker] 启动失败：" + (err && err.message ? err.message : String(err))));
    },
  };
}

// 示例工程目录：项目根目录（"Stair core Tool"）下的 "Saved Plans"，界面上的 example 面板从这里列文件；PLAN_EXAMPLES_DIR 可改
const examplesDir = process.env.PLAN_EXAMPLES_DIR || path.resolve(here, "../../Saved Plans");

export default defineConfig({ plugins: [react(), markerAutostart(), planFileBridgePlugin({ examplesDir })] });
