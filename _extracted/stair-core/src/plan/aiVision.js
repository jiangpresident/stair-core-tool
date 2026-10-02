// AI 识图的浏览器胶水层：把当前底图（PDF 渲染出来的 canvas，或图片上传的 dataURL）缩到模型建议的
// 尺寸、转成 base64 JPEG，再交给 aiVisionDetect.js 里的纯逻辑去调接口。跟 pdfWalls.js 一样只在用户
// 真的点了按钮时才被动态 import（@anthropic-ai/sdk 有一定体积，不拖累平时只手动画图的场景）。
import { computeDownscale } from "./aiVisionDetect.js";
import { t } from "../i18n.js";

export { detectFloorPlanWithAi, AI_PROVIDERS, readAiSettings, writeAiSettings } from "./aiVisionDetect.js";

const MAX_BASE64_BYTES = 4.5 * 1024 * 1024; // Anthropic 单张图上限 5MB（base64 后），留点余量

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(t("底图解码失败")));
    img.src = src;
  });
}

/* source：HTMLCanvasElement（PDF 路线，pdfPageRef 里那份原始 canvas）或图片 dataURL 字符串（图片上传路线）。
   naturalW/H 是原图像素尺寸（跟 plan.naturalW/H 在未标定时一致），factor 用它来算，保证模型返回的坐标
   乘 factor 后正好落回 plan 的"原始像素"坐标系。
   统一转成 JPEG（白底）：扫描件/CAD 图基本是黑白线稿，JPEG 0.85 质量下肉眼看不出差别，但体积比 PNG
   小得多，省上传时间也省 token；PNG 透明背景会先铺一层白，避免透明区在模型那边变黑。 */
export async function prepareImageForAi(source, naturalW, naturalH) {
  const img = typeof source === "string" ? await loadImage(source) : source;
  const { width, height, factor } = computeDownscale(naturalW, naturalH);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  let quality = 0.85;
  let dataUrl = canvas.toDataURL("image/jpeg", quality);
  while (dataUrl.length > MAX_BASE64_BYTES && quality > 0.4) {
    quality -= 0.15;
    dataUrl = canvas.toDataURL("image/jpeg", quality);
  }
  const data = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return { data, mediaType: "image/jpeg", width, height, factor };
}
