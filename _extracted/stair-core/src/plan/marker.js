// Floorplan Marker 路线的浏览器胶水层：把当前底图（PDF 路线是 pdfPageRef 里的原始 canvas，图片路线是
// dataURL）按墨迹范围裁剪、缩到 1400px 以内、转成 PNG data URL（PNG 保留细线不糊，这类线稿体积也不大），
// 交给 markerDetect.js 去调本机服务。跟 pdfWalls.js / aiVision.js 一样只在用户点按钮时动态 import。
import { findInkBounds, planCrop } from "./markerDetect.js";
import { t } from "../i18n.js";

export { detectWithMarker, mapMarkerResult, checkMarkerHealth, MARKER_DEFAULT_THRESHOLD, MARKER_START_HINT } from "./markerDetect.js";

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(t("底图解码失败")));
    img.src = src;
  });
}

/* 返回 { dataUrl, crop }：crop 给 mapMarkerResult 用来把结果坐标还原回原始像素。 */
export async function prepareMarkerImage(source, naturalW, naturalH, threshold) {
  const img = typeof source === "string" ? await loadImage(source) : source;
  // 先在原始分辨率上找墨迹范围（透明/白纸之外的部分）
  const full = document.createElement("canvas");
  full.width = naturalW;
  full.height = naturalH;
  const fctx = full.getContext("2d");
  fctx.fillStyle = "#fff";
  fctx.fillRect(0, 0, naturalW, naturalH);
  fctx.drawImage(img, 0, 0, naturalW, naturalH);
  const step = Math.max(1, Math.floor(Math.max(naturalW, naturalH) / 1500)); // 大图隔几个像素采样一次就够找范围了
  const bounds = findInkBounds(fctx.getImageData(0, 0, naturalW, naturalH), { threshold, step, margin: 12 + step });
  const crop = planCrop(bounds);
  const out = document.createElement("canvas");
  out.width = crop.outW;
  out.height = crop.outH;
  const octx = out.getContext("2d");
  octx.fillStyle = "#fff";
  octx.fillRect(0, 0, out.width, out.height);
  octx.drawImage(full, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.outW, crop.outH);
  return { dataUrl: out.toDataURL("image/png"), crop };
}
