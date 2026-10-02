// 打包为三个可双击打开的 HTML（内联 React / three / 样式）：
// 核心筒计算器、平面图工具、以及一个把两者链接起来的启动页（配色仿 Claude 界面）。
// 三个文件互相用同目录下的相对路径跳转（见 src/planBridge.js 的 otherAppHref），
// 发给别人时要把 dist-single/ 整个文件夹一起带上，不能只发单个 html。
import { build } from "esbuild";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

mkdirSync("dist-single", { recursive: true });
execSync("npx tailwindcss -i src/index.css -o dist-single/tw.css --minify", { stdio: "inherit" });
const css = readFileSync("dist-single/tw.css", "utf8");

/* src/plan/pdfWalls.js 里 `import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url"` 是 Vite
   专用语法（"给我这个文件的 URL"），esbuild 不认识 `?url` 后缀。单文件版本又没有服务器能各自发文件，
   所以这里不是简单模拟一下 Vite 的行为——直接把 worker 的源码读出来，在运行时用 Blob URL 冒充一个
   "文件"：功能上跟 Vite 打包出来的独立 worker 文件等价，都是给 `new Worker(url, {type:"module"})`
   用的一个可加载地址，只是这份地址是运行时现造的，不用真的落一个文件到磁盘上。 */
const pdfWorkerUrlPlugin = {
  name: "pdf-worker-url",
  setup(b) {
    b.onResolve({ filter: /\?url$/ }, (args) => {
      const clean = args.path.replace(/\?url$/, "");
      const resolved = require.resolve(clean, { paths: [args.resolveDir] });
      return { path: resolved, namespace: "pdf-worker-url-ns" };
    });
    b.onLoad({ filter: /.*/, namespace: "pdf-worker-url-ns" }, (args) => {
      const src = readFileSync(args.path, "utf8");
      return {
        contents: `const __src=${JSON.stringify(src)};export default URL.createObjectURL(new Blob([__src],{type:"text/javascript"}));`,
        loader: "js",
      };
    });
  },
};

async function buildPage({ entry, outJs, outHtml, title }) {
  await build({
    entryPoints: [entry],
    bundle: true,
    minify: true,
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    outfile: outJs,
    loader: { ".css": "empty" },
    plugins: [pdfWorkerUrlPlugin],
  });
  const js = readFileSync(outJs, "utf8").replace(/<\/script/g, "<\\/script");
  writeFileSync(
    outHtml,
    `<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>${css}</style></head><body><div id="root"></div><script>${js}</script></body></html>\n`
  );
  console.log("→ " + outHtml);
}

await buildPage({
  entry: "src/main.jsx",
  outJs: "dist-single/app.js",
  outHtml: "dist-single/stair-core-calculator.html",
  title: "温哥华核心筒疏散楼梯计算器",
});
await buildPage({
  entry: "src/mainPlan.jsx",
  outJs: "dist-single/app-plan.js",
  outHtml: "dist-single/stair-core-plan.html",
  title: "平面图工具 · 核心筒疏散楼梯",
});

/* 启动页是纯静态 HTML + 少量原生 JS，不需要 React；配色/圆角/字体照着 Claude 桌面端/网页版的
   暖白底 + 珊瑚橙强调色这套视觉语言来，不是从 Claude 自己的样式表里抠出来的精确数值，只是
   视觉上接近，用户如果发现哪里不像可以再告诉我调整。 */
const launcherHtml = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>楼梯核心筒工具</title>
<style>
  :root {
    --bg: #F5F4EE;
    --card: #FFFFFF;
    --ink: #3D3929;
    --muted: #87867F;
    --rule: #E5E4DF;
    --accent: #D97757;
    --accent-dark: #BF6248;
    --accent-tint: #FBEEE9;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    background: var(--bg);
    color: var(--ink);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", Helvetica, Arial, sans-serif;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 32px 16px;
  }
  .wrap { max-width: 860px; width: 100%; }
  .eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--accent-dark);
    background: var(--accent-tint);
    border-radius: 999px;
    padding: 4px 12px;
    margin-bottom: 16px;
  }
  h1 { font-size: 28px; font-weight: 700; margin: 0 0 8px; letter-spacing: -0.01em; }
  .sub { color: var(--muted); font-size: 14.5px; margin: 0 0 32px; max-width: 640px; line-height: 1.6; }
  .cards { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  @media (max-width: 640px) { .cards { grid-template-columns: 1fr; } }
  .card {
    background: var(--card);
    border: 1px solid var(--rule);
    border-radius: 20px;
    padding: 28px 24px;
    text-align: left;
    cursor: pointer;
    transition: box-shadow 0.15s ease, transform 0.15s ease, border-color 0.15s ease;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .card:hover { box-shadow: 0 8px 24px rgba(61, 57, 41, 0.08); border-color: var(--accent); transform: translateY(-2px); }
  .icon {
    width: 44px; height: 44px; border-radius: 12px;
    background: var(--accent-tint); color: var(--accent-dark);
    display: flex; align-items: center; justify-content: center;
    font-size: 22px;
  }
  .card h2 { font-size: 17px; margin: 0; font-weight: 700; }
  .card p { font-size: 13px; color: var(--muted); margin: 0; line-height: 1.6; flex: 1; }
  .btn {
    display: inline-flex; align-items: center; gap: 6px;
    background: var(--accent); color: #fff; font-weight: 600; font-size: 13.5px;
    border: none; border-radius: 10px; padding: 10px 16px; align-self: flex-start;
    transition: background 0.15s ease;
  }
  .card:hover .btn { background: var(--accent-dark); }
  .footnote { margin-top: 28px; font-size: 12px; color: var(--muted); line-height: 1.7; }
  .footnote code { background: var(--accent-tint); border-radius: 4px; padding: 1px 5px; font-size: 11.5px; }
</style>
</head>
<body>
  <div class="wrap">
    <span class="eyebrow">◆ 温哥华 VBBL 2025 / BCBC 2024 / NBC 2020</span>
    <h1>楼梯核心筒工具</h1>
    <p class="sub">点开下面任意一张卡片，会在新窗口里打开对应的工具；两边通过浏览器本地存储自动同步核心筒的计算结果，不需要手动导入导出。</p>
    <div class="cards">
      <div class="card" onclick="openApp('stair-core-calculator.html')" role="button" tabindex="0" onkeydown="if(event.key==='Enter')openApp('stair-core-calculator.html')">
        <div class="icon">🧮</div>
        <h2>核心筒计算器</h2>
        <p>按每层面积、用途、层高确定楼梯数量、净宽、跑数与楼梯间尺寸，附平面 / 剖面 / 3D 与规范条文核查。</p>
        <span class="btn">打开计算器 →</span>
      </div>
      <div class="card" onclick="openApp('stair-core-plan.html')" role="button" tabindex="0" onkeydown="if(event.key==='Enter')openApp('stair-core-plan.html')">
        <div class="icon">📐</div>
        <h2>平面图工具</h2>
        <p>摆放核心筒、绘制走廊墙体与门、标定楼层边界，校核出口间距与疏散距离。</p>
        <span class="btn">打开平面图工具 →</span>
      </div>
    </div>
    <p class="footnote">
      两个页面是独立的 HTML 文件，需要跟这个启动页放在同一个文件夹里才能互相跳转；把 <code>dist-single</code> 整个文件夹一起复制/发送即可。
      本工具为方案阶段估算，不替代注册专业人员的规范审查。
    </p>
  </div>
  <script>
    function openApp(file) {
      window.open(file, "_blank", "noopener");
    }
  </script>
</body>
</html>
`;
writeFileSync("dist-single/stair-core-launcher.html", launcherHtml);
console.log("→ dist-single/stair-core-launcher.html");
