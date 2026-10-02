// 从源码里提取所有 t("…") 的键，和英文词典（src/i18n/en.js）对一下：
//   node scripts/i18n-keys.mjs            → 写 scripts/i18n-keys.json（键 → 出现位置），并打印缺翻译/多余的数量
//   node scripts/i18n-keys.mjs --missing  → 把缺翻译的键按 JSON 对象格式打印出来，方便直接粘进 en.js
// 用 Babel 解析而不是正则：模板改写出来的键里有引号、换行转义，正则容易漏。
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "@babel/parser";
import traverseModule from "@babel/traverse";

const traverse = traverseModule.default || traverseModule;
const FILES = ["src/calculator/StairCoreTool.jsx", "src/plan/PlanApp.jsx", "src/plan/planFile.js", "src/plan/markerDetect.js", "src/plan/aiVisionDetect.js", "src/plan/aiSettings.js", "src/plan/pdfWalls.js", "src/plan/marker.js", "src/plan/aiVision.js", "src/rhino/rhinoBridge.js", "src/rhino/RhinoPanel.jsx", "src/LangToggle.jsx", "src/App.jsx"];
const keys = new Map();
for (const file of FILES) {
  let code;
  try {
    code = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const ast = parse(code, { sourceType: "module", plugins: ["jsx"] });
  traverse(ast, {
    CallExpression(p) {
      const n = p.node;
      if (n.callee.type !== "Identifier" || n.callee.name !== "t") return;
      const a = n.arguments[0];
      if (!a || a.type !== "StringLiteral") return;
      const loc = `${path.basename(file)}:${n.loc.start.line}`;
      if (!keys.has(a.value)) keys.set(a.value, []);
      keys.get(a.value).push(loc);
    },
  });
}
const { EN } = await import(pathToFileURL(path.resolve("src/i18n/en.js")).href);
const sorted = [...keys.keys()].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
const missing = sorted.filter((k) => EN[k] == null);
const extra = Object.keys(EN).filter((k) => !keys.has(k));
if (process.argv.includes("--missing")) {
  for (const k of missing) console.log(`  ${JSON.stringify(k)}: ${JSON.stringify("")},`);
} else {
  writeFileSync("scripts/i18n-keys.json", JSON.stringify(Object.fromEntries(sorted.map((k) => [k, keys.get(k)])), null, 1), "utf8");
  console.log(`源码里 ${sorted.length} 个键；英文词典 ${Object.keys(EN).length} 条；缺翻译 ${missing.length}；词典里多余 ${extra.length}`);
  if (extra.length) console.log("多余：", extra.slice(0, 20));
}
