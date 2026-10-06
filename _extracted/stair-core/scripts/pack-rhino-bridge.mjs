// 把 Rhino 桥接脚本打成一个可下载的小包，放进静态站点：
//   public/rhino-bridge/StairCoreRhinoBridge.zip   （StairCoreBridge.py + Start Rhino with bridge.bat + README.txt）
//   public/rhino-bridge/StairCoreBridge.py         （单独的脚本，想直接拿脚本的人用）
// 这样打开 GitHub Pages 线上版的人（电脑上没有仓库）也能从"未连接"提示里一键下载，解压后双击 bat 或在 Rhino 里运行脚本。
// 源文件就是仓库里的 rhino/StairCoreBridge.py 和根目录的「启动 Rhino（带桥接）.bat」——这里只复制不改，避免两份源码。
//   node scripts/pack-rhino-bridge.mjs [仓库根目录] [目标目录]
// 默认：根 = ../../，目标 = public/rhino-bridge（已 gitignore；dev / build 前自动跑一遍，见 package.json 的 predev / prebuild）。
// zip 用 Node 自带的 zlib 手写（仓库没有 zip 依赖，也不想为这个加一个）：每个文件一个 local header + deflate-raw 数据，
// 最后 central directory + end record；文件名全是 ASCII，不碰编码位。
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { deflateRawSync } from "node:zlib";

const root = path.resolve(process.argv[2] || "../../");
const dest = path.resolve(process.argv[3] || "public/rhino-bridge");

const scriptPath = path.join(root, "rhino", "StairCoreBridge.py");
// 根目录的启动 bat 文件名是中文；按内容特征找（名字里有 Rhino 且后缀 .bat），别把文件名编码写死在这里
const batName = readdirSync(root).find((n) => /rhino/i.test(n) && /\.bat$/i.test(n) && !/平面图/.test(n));
if (!existsSync(scriptPath)) throw new Error(`找不到桥接脚本：${scriptPath}`);
if (!batName) throw new Error(`根目录里找不到 Rhino 启动 .bat：${root}`);
const script = readFileSync(scriptPath);
const bat = readFileSync(path.join(root, batName));

// 带 UTF-8 BOM：中文 Windows 上记事本以外的老编辑器默认按 GBK 读，没有 BOM 中文会乱码
const readme = "﻿" + [
  "StairCore Rhino bridge  /  StairCore Rhino 桥接包",
  "",
  "Lets the Stair-Core web tool (https://jiangpresident.github.io/stair-core-tool/ or a local dev server) read core boxes,",
  "walls and floors from your open Rhino document and bake stair solids back. Rhino 8 (CPython) or Rhino 7 (IronPython).",
  "",
  "Either:",
  "  1. Double-click \"Start Rhino with bridge.bat\" (starts Rhino 8, or Rhino 7, with the bridge already running), or",
  "  2. In an open Rhino: ScriptEditor (Rhino 8) / EditPythonScript (Rhino 7) -> open StairCoreBridge.py -> run.",
  "Then click \"Connect Rhino\" in the web tool. Rhino's command line shows",
  "  \"StairCore bridge listening on http://127.0.0.1:8790\".",
  "",
  "The bridge listens only on 127.0.0.1 (this computer), never on the network, and only answers the web tool's own origins.",
  "It lives inside the Rhino process: start it again each time you open Rhino (or use the .bat / add",
  "  _-RunPythonScript \"<this folder>\\StairCoreBridge.py\"",
  "to Rhino Options > General > \"Run these commands every time Rhino starts\").",
  "",
  "------------------------------------------------------------",
  "",
  "让核心筒计算器网页（线上版或本机开发服务器）读取你打开的 Rhino 文件里的核心筒长方体、墙体、地板，并把楼梯实体写回 Rhino。",
  "支持 Rhino 8（CPython）和 Rhino 7（IronPython）。",
  "",
  "二选一：",
  "  1. 双击「Start Rhino with bridge.bat」：启动 Rhino 8（没有就 Rhino 7），桥随 Rhino 自动起来；",
  "  2. 在已打开的 Rhino 里：ScriptEditor（Rhino 8）/ EditPythonScript（Rhino 7）→ 打开 StairCoreBridge.py → 运行。",
  "然后回网页点「连接 Rhino」。Rhino 命令行会出现 \"StairCore bridge listening on http://127.0.0.1:8790\"。",
  "",
  "桥只监听本机 127.0.0.1，不上网，只应答网页工具自己的来源。它在 Rhino 进程里，每次新开 Rhino 要重新运行一次",
  "（或者用 bat；或者把  _-RunPythonScript \"<本文件夹>\\StairCoreBridge.py\"  加到 Rhino 选项 → 常规 → “每次 Rhino 启动时运行这些命令”）。",
  "",
].join("\r\n");

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
// DOS 时间（zip 的时间字段），用当前时间就行
const now = new Date();
const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "ascii");
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    const packed = deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by
    central.writeUInt16LE(20, 6); // needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, packed);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + packed.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, end]);
}

const entries = [
  { name: "StairCoreBridge.py", data: script },
  { name: "Start Rhino with bridge.bat", data: bat },
  { name: "README.txt", data: readme },
];
mkdirSync(dest, { recursive: true });
const zipBuf = zip(entries);
writeFileSync(path.join(dest, "StairCoreRhinoBridge.zip"), zipBuf);
writeFileSync(path.join(dest, "StairCoreBridge.py"), script);
writeFileSync(
  path.join(dest, "index.json"),
  JSON.stringify({ zip: "StairCoreRhinoBridge.zip", script: "StairCoreBridge.py", files: entries.map((e) => e.name), scriptBytes: script.length, zipBytes: zipBuf.length, packedAt: now.toISOString() }, null, 1),
  "utf8",
);
console.log(`已打包 ${entries.length} 个文件 → ${path.join(dest, "StairCoreRhinoBridge.zip")}（${zipBuf.length} 字节；脚本 ${script.length} 字节，来自 ${batName}）`);
