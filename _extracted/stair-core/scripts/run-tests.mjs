import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
mkdirSync("dist-tests", { recursive: true });
// pdfWalls.js 只在 StairCoreTool.jsx 里被动态 import()（用户真的上传 PDF 时才加载），且它自己有个
// Vite 专用的 `?url` worker 引入，esbuild 不认识这种语法——计算逻辑测试用不到这条分支，直接把它
// 排除在打包之外（保留成运行时才解析的 import()，测试全程不会真的执行到那一行，不影响测试）。
await build({ entryPoints: ["tests/calc.test.jsx"], bundle: true, platform: "node", format: "esm", jsx: "automatic", outfile: "dist-tests/calc.test.mjs", external: ["three", "../plan/pdfWalls.js", "../plan/aiVision.js", "../plan/marker.js"] });
execFileSync("node", ["dist-tests/calc.test.mjs"], { stdio: "inherit" });
