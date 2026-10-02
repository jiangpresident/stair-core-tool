// 一次性代码改写：把源码里带中文的界面字符串包成 t()，并把所有键导出成 JSON 给人工翻译。
// 用 Babel 解析语法树定位，再按位置做"外科手术式"替换（不重新打印整个文件，格式一个字符都不动）。
// 处理四类节点：
//   1. JSX 文本（<span>识别到 </span>）→ {t("识别到")}，首尾空白原样保留（它们决定行内间距/换行布局）；
//   2. JSX 属性里的字符串（title="…" placeholder="…"）→ {t("…")}；
//   3. 普通字符串字面量（setMsg("…")、{ label: "…" }）→ t("…")；对象属性名、import 路径、已经在 t() 里的跳过；
//   4. 模板字符串（`已添加 ${n} 面墙`）→ t("已添加 {0} 面墙", [n])，表达式原文照抄。
// 用法：node scripts/i18n-wrap.mjs [--dry] 文件...   不传文件就处理默认列表。
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { parse } from "@babel/parser";
import traverseModule from "@babel/traverse";

const traverse = traverseModule.default || traverseModule;
const CJK = /[一-鿿　-〿＀-￯]/; // 汉字 + 中文标点 + 全角符号
const DEFAULT_FILES = [
  "src/calculator/StairCoreTool.jsx",
  "src/plan/PlanApp.jsx",
  "src/plan/planFile.js",
  "src/plan/markerDetect.js",
  "src/plan/aiVisionDetect.js",
  "src/plan/aiSettings.js",
  "src/plan/pdfWalls.js",
  "src/plan/marker.js",
  "src/plan/aiVision.js", "src/rhino/rhinoBridge.js", "src/rhino/RhinoPanel.jsx",
];
const args = process.argv.slice(2);
const dry = args.includes("--dry");
const files = args.filter((a) => !a.startsWith("--"));
const targets = files.length ? files : DEFAULT_FILES;

const allKeys = new Map(); // key -> [file:line, ...]
const warnings = [];

function normalizeJsxText(raw) {
  // JSX 语义：按行拆开、每行去首尾空白、去掉空行，再用单个空格连起来
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ");
}

function processFile(file) {
  const code = readFileSync(file, "utf8");
  const ast = parse(code, { sourceType: "module", plugins: ["jsx"], errorRecovery: false });
  const edits = []; // {start, end, text}
  const templateRanges = [];
  let lastImportEnd = 0;
  let hasTImport = false;

  const addKey = (key, node) => {
    const loc = `${path.basename(file)}:${node.loc ? node.loc.start.line : "?"}`;
    if (!allKeys.has(key)) allKeys.set(key, []);
    allKeys.get(key).push(loc);
  };
  const insideTemplate = (node) => templateRanges.some(([s, e]) => node.start >= s && node.end <= e);
  const isTCall = (p) => p.parentPath && p.parentPath.isCallExpression() && p.parentPath.node.callee.type === "Identifier" && p.parentPath.node.callee.name === "t" && p.parentPath.node.arguments[0] === p.node;

  traverse(ast, {
    ImportDeclaration(p) {
      lastImportEnd = Math.max(lastImportEnd, p.node.end);
      if (p.node.source.value.endsWith("i18n.js")) hasTImport = true;
    },
    // 先收集模板字符串的范围，表达式内部的字符串不再单独处理（会和模板的替换范围重叠）
    TemplateLiteral(p) {
      const node = p.node;
      if (!node.quasis.some((q) => CJK.test(q.value.cooked ?? q.value.raw))) return;
      if (p.parentPath.isTaggedTemplateExpression()) return;
      if (isTCall(p)) return;
      templateRanges.push([node.start, node.end]);
      let key = "";
      node.quasis.forEach((q, i) => {
        key += q.value.cooked ?? q.value.raw;
        if (i < node.expressions.length) key += `{${i}}`;
      });
      const exprs = node.expressions.map((e) => code.slice(e.start, e.end));
      for (const e of node.expressions) if (CJK.test(code.slice(e.start, e.end))) warnings.push(`${file}:${node.loc.start.line} 模板字符串的表达式里还有中文，需人工处理：${code.slice(e.start, e.end).slice(0, 60)}`);
      addKey(key, node);
      const text = exprs.length ? `t(${JSON.stringify(key)}, [${exprs.join(", ")}])` : `t(${JSON.stringify(key)})`;
      edits.push({ start: node.start, end: node.end, text });
    },
  });

  traverse(ast, {
    JSXText(p) {
      const node = p.node;
      if (!CJK.test(node.value)) return;
      const raw = code.slice(node.start, node.end);
      const lead = raw.match(/^\s*/)[0];
      const trail = raw.match(/\s*$/)[0];
      const key = normalizeJsxText(raw);
      if (!key) return;
      addKey(key, node);
      edits.push({ start: node.start, end: node.end, text: `${lead}{t(${JSON.stringify(key)})}${trail}` });
    },
    StringLiteral(p) {
      const node = p.node;
      if (!CJK.test(node.value)) return;
      if (insideTemplate(node)) return;
      const parent = p.parentPath;
      if (parent.isImportDeclaration() || parent.isExportNamedDeclaration() || parent.isExportAllDeclaration()) return;
      if (parent.isObjectProperty() && parent.node.key === node && !parent.node.computed) return; // 属性名
      if (parent.isJSXAttribute()) {
        if (parent.node.name.name === "data-testid" || parent.node.name.name === "key") return;
        addKey(node.value, node);
        edits.push({ start: node.start, end: node.end, text: `{t(${code.slice(node.start, node.end)})}` });
        return;
      }
      if (isTCall(p)) return;
      addKey(node.value, node);
      edits.push({ start: node.start, end: node.end, text: `t(${code.slice(node.start, node.end)})` });
    },
  });

  // 按位置从后往前替换，保证前面的偏移不受影响
  edits.sort((a, b) => b.start - a.start);
  let out = code;
  let prevStart = Infinity;
  for (const e of edits) {
    if (e.end > prevStart) {
      warnings.push(`${file}: 跳过与前一处重叠的替换 @${e.start}`);
      continue;
    }
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    prevStart = e.start;
  }
  if (edits.length && !hasTImport) {
    const rel = path.relative(path.dirname(file), "src/i18n.js").split(path.sep).join("/");
    const importLine = `import { t } from "${rel.startsWith(".") ? rel : "./" + rel}";\n`;
    out = lastImportEnd > 0 ? out.slice(0, lastImportEnd) + "\n" + importLine.trimEnd() + out.slice(lastImportEnd) : importLine + out;
  }
  if (!dry && edits.length) writeFileSync(file, out, "utf8");
  // 改完再解析一遍，确保还是合法代码
  if (edits.length) parse(out, { sourceType: "module", plugins: ["jsx"] });
  console.log(`${file}: ${edits.length} 处替换${dry ? "（dry run，未写入）" : ""}`);
}

for (const f of targets) {
  if (!existsSync(f)) {
    console.log(`跳过不存在的文件 ${f}`);
    continue;
  }
  processFile(f);
}
const keys = [...allKeys.keys()].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
if (!dry) writeFileSync("scripts/i18n-keys.json", JSON.stringify(Object.fromEntries(keys.map((k) => [k, allKeys.get(k)])), null, 1), "utf8");
console.log(`\n共 ${keys.length} 个不同的键${dry ? "" : "，已写入 scripts/i18n-keys.json"}`);
for (const w of warnings) console.log("⚠ " + w);
