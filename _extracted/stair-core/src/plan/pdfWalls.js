// 浏览器专用入口：上传的 PDF → 平面图底图（渲染成图片）+ 两条可以手动切换的墙体识别路线。
// 识别逻辑本身（不依赖 DOM/canvas）在 pdfWallDetect.js（矢量路径解析）和 rasterWallDetect.js
// （栅格边缘识别），都可以在 Node 里单测；这里只负责加载 pdf.js worker、渲染 canvas、
// 把渲染结果交给两条识别路线中用户选定的那一条。
// 用户确认过：他手头大部分图纸其实是扫描件（没有矢量数据可读），矢量解析这条路线对这类文件
// 找不到线段是预期行为，不是 bug——所以两条路线做成手动切换，不做自动二选一：识别哪种、
// 用哪条路线，交给用户自己判断，而不是让代码去猜"这是不是扫描件"。
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import { extractStrokedSegments, detectWallCandidates } from "./pdfWallDetect.js";
import { detectRasterSegments, labelOpenRegions, filterWallsByRoomAdjacency } from "./rasterWallDetect.js";
import { matchDimensionCandidates } from "./dimensionDetect.js";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const RENDER_SCALE = 2; // PDF 用户空间 1pt → 2 像素背景图；两条识别路线和候选墙都用这同一个像素坐标系

/* 只加载/渲染，不在这里做识别——识别改成用户手动点按钮触发（见 detectVectorWalls/detectRasterWalls），
   两条路线可以来回切换重新跑，不需要重新上传文件。只处理第 1 页——多页 PDF 目前需要用户自己
   导出/截取想要的那一页。 */
export async function loadPdfPage(file) {
  const buf = await file.arrayBuffer();
  const pdf = await getDocument({ data: buf }).promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: RENDER_SCALE });

  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport }).promise;
  const bgSrc = canvas.toDataURL("image/png");

  const opList = await page.getOperatorList();

  return { bgSrc, naturalW: canvas.width, naturalH: canvas.height, opList, viewport, canvas };
}

/* 矢量解析：适合矢量 CAD 导出的 PDF。对扫描件/纯图片 PDF 会正常跑完但返回空数组
   （内容流里没有真正的线段可读），调用方看到空结果应该提示用户改试图像识别，而不是当报错处理。
   widthFilter（{minW,maxW}，像素，可选）：只保留识别出来的墙厚落在这个范围内的候选——用户拖界面上
   的滑块设定，不设的话就是不过滤（矢量线宽本身就有意义，不像栅格那样噪点多，默认不强制过滤）。 */
export function detectVectorWalls(pdfPage, widthFilter) {
  const segments = extractStrokedSegments(pdfPage.opList, pdfPage.viewport);
  return detectWallCandidates(segments, widthFilter);
}

/* 图像识别：适合扫描件/栅格图 PDF。直接对渲染出来的背景图做边缘检测，没有"这条线本来是矢量画的
   多粗"这种元数据可用，纯粹从像素猜——准确率天然不如矢量解析，只是矢量解析对扫描件完全没用，
   这是唯一能自动出候选结果的路线。widthFilter 同 detectVectorWalls。
   真实扫描件测下来发现墙线（约 6px 宽）跟文字笔画（约 3~5px 宽）粗细很接近，单靠线宽过滤不够，
   所以先让 detectWallCandidates 正常配对出墙体候选（这一步才知道每面墙自己的厚度），再按"是否
   真的分隔出两块封闭空间"筛一遍（见 rasterWallDetect.js 的 filterWallsByRoomAdjacency——房间
   内部的文字/尺寸标注/柱子不会真的分隔空间，能被筛掉），最后再套用户设的线宽过滤范围。 */
export function detectRasterWalls(pdfPage, widthFilter, opts = {}) {
  const { roomFilter = false } = opts;
  const ctx = pdfPage.canvas.getContext("2d");
  const imageData = ctx.getImageData(0, 0, pdfPage.canvas.width, pdfPage.canvas.height);
  const segments = detectRasterSegments(imageData);
  let candidates = detectWallCandidates(segments);
  // 房间分隔过滤默认关闭：真实图纸的墙上有门洞，连通区域会从门洞"漏"过去把相邻房间连成一块，
  // 于是它们之间的隔墙会被误判成"没有分隔作用"而丢掉——用户实测反馈开着反而比不开更差。
  // 保留成可选项是因为对没有门洞/门洞很小的图它确实能去掉大量噪点，用户可以自己试。
  if (roomFilter) candidates = filterWallsByRoomAdjacency(candidates, labelOpenRegions(imageData));
  if (!widthFilter) return candidates;
  const { minW = 0, maxW = Infinity } = widthFilter;
  return candidates.filter((w) => w.w >= minW && w.w <= maxW);
}

/* 自动标定比例：找图纸上写的尺寸标注数字（比如"2400"/"2400mm"），配上离它最近、长度说得通的
   一条线，猜出这条线代表的真实距离，从而算出像素→毫米的比例——不用再手动点两个点、手动输一遍
   已知距离。用的是 tesseract.js（浏览器里跑 OCR，纯前端，不用后端），动态 import：语言包有几 MB，
   需要联网从 tesseract.js 官方 CDN 下载，只有用户真的点了这个功能才会加载/下载，不影响其它场景。
   返回的是"候选"而不是直接生效——同一段文字附近可能有好几条线，猜的不一定是真正的尺寸线，
   由用户点选确认哪一个可信，跟墙体候选、门/楼梯识别这些地方的"候选+人工确认"是同一套设计。 */
export async function detectDimensionCandidates(pdfPage) {
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng");
  try {
    const { data } = await worker.recognize(pdfPage.canvas, {}, { blocks: true });
    const words = [];
    for (const block of data.blocks || [])
      for (const para of block.paragraphs || [])
        for (const line of para.lines || [])
          for (const w of line.words || []) words.push(w);
    const ctx = pdfPage.canvas.getContext("2d");
    const imageData = ctx.getImageData(0, 0, pdfPage.canvas.width, pdfPage.canvas.height);
    const segments = detectRasterSegments(imageData);
    return matchDimensionCandidates(words, segments);
  } finally {
    await worker.terminate();
  }
}
