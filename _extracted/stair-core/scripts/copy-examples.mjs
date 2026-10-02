// 把示例工程（项目根目录 "Saved Plans"/*.json）复制到静态站点里，并生成一份清单 index.json，
// 让没有开发服务器的部署（GitHub Pages / dist-single）也能在 example 面板里列出并打开它们。
//   node scripts/copy-examples.mjs [源目录] [目标目录]
// 默认：源 = ../../Saved Plans，目标 = public/examples（Vite 开发/构建时原样带进站点根目录的 examples/）。
import { readdirSync, statSync, mkdirSync, copyFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";

const src = process.argv[2] || path.resolve("../../Saved Plans");
const dest = process.argv[3] || path.resolve("public/examples");
if (!existsSync(src)) {
  console.log(`示例目录不存在：${src}，写一份空清单`);
  mkdirSync(dest, { recursive: true });
  writeFileSync(path.join(dest, "index.json"), JSON.stringify({ files: [] }), "utf8");
  process.exit(0);
}
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
const files = [];
for (const name of readdirSync(src).sort((a, b) => a.localeCompare(b, "zh-Hans-CN", { numeric: true }))) {
  if (!/\.json$/i.test(name)) continue;
  const st = statSync(path.join(src, name));
  if (!st.isFile()) continue;
  copyFileSync(path.join(src, name), path.join(dest, name));
  files.push({ name, size: st.size, mtime: st.mtimeMs });
}
writeFileSync(path.join(dest, "index.json"), JSON.stringify({ files }, null, 1), "utf8");
console.log(`已复制 ${files.length} 个示例到 ${dest}`);
