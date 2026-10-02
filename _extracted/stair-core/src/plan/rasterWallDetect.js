// 扫描件/栅格图 PDF 的墙体识别：没有矢量路径可读，只能从像素本身找边缘、找直线。
// 纯数组运算（不依赖 DOM/canvas），只要能拿到一份 {data,width,height} 形状（跟浏览器 ImageData
// 一样）的像素数据就能跑，可以在 Node 里直接单测（见 scripts/test-raster-walls.mjs）。
// 找到的线段最后交给 pdfWallDetect.js 的 detectWallCandidates 处理——那套"细线两两配对成墙/
// 合并共线碎片"的逻辑不用重写，栅格这边只负责把像素变成线段。

function toGrayscale(data, width, height) {
  const gray = new Float32Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  return gray;
}

/* 3x3 Sobel 算子求梯度幅值（mag，边缘强度）和方向（dir，梯度方向——垂直于边缘/线条本身的方向）。 */
function sobel(gray, width, height) {
  const mag = new Float32Array(width * height);
  const dir = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i00 = (y - 1) * width + (x - 1), i01 = (y - 1) * width + x, i02 = (y - 1) * width + (x + 1);
      const i10 = y * width + (x - 1), i12 = y * width + (x + 1);
      const i20 = (y + 1) * width + (x - 1), i21 = (y + 1) * width + x, i22 = (y + 1) * width + (x + 1);
      const gx = -gray[i00] + gray[i02] - 2 * gray[i10] + 2 * gray[i12] - gray[i20] + gray[i22];
      const gy = -gray[i00] - 2 * gray[i01] - gray[i02] + gray[i20] + 2 * gray[i21] + gray[i22];
      const idx = y * width + x;
      mag[idx] = Math.hypot(gx, gy);
      dir[idx] = Math.atan2(gy, gx);
    }
  }
  return { mag, dir };
}

/* 大津法（Otsu）自动阈值——不同扫描件对比度/清晰度差很多，固定阈值不够稳，
   在梯度幅值的直方图上自动找一个能把"边缘/非边缘"分得最开的分界点。 */
function otsuThreshold(mag) {
  let maxV = 0;
  for (let i = 0; i < mag.length; i++) if (mag[i] > maxV) maxV = mag[i];
  if (maxV <= 0) return 1;
  const BINS = 256;
  const hist = new Array(BINS).fill(0);
  for (let i = 0; i < mag.length; i++) hist[Math.min(BINS - 1, Math.floor((mag[i] / maxV) * (BINS - 1)))]++;
  const total = mag.length;
  let sum = 0;
  for (let i = 0; i < BINS; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, maxVar = 0, threshBin = 0;
  for (let i = 0; i < BINS; i++) {
    wB += hist[i];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const varBetween = wB * wF * (mB - mF) * (mB - mF);
    if (varBetween > maxVar) {
      maxVar = varBetween;
      threshBin = i;
    }
  }
  return (threshBin / (BINS - 1)) * maxV;
}

/* 把一批(t, 点)按 t 排序后，合并成"连续跑一段"的区间（允许 gapTol 的小缝隙），
   跟 pdfWallDetect.js 里 mergeCollinear 用的是同一种区间合并思路。 */
function extractRuns(pointsWithT, gapTol, minLen) {
  pointsWithT.sort((a, b) => a.t - b.t);
  const runs = [];
  let start = pointsWithT[0];
  let prev = pointsWithT[0];
  for (let i = 1; i < pointsWithT.length; i++) {
    const cur = pointsWithT[i];
    if (cur.t - prev.t > gapTol) {
      if (prev.t - start.t >= minLen) runs.push({ x1: start.p.x, y1: start.p.y, x2: prev.p.x, y2: prev.p.y });
      start = cur;
    }
    prev = cur;
  }
  if (prev.t - start.t >= minLen) runs.push({ x1: start.p.x, y1: start.p.y, x2: prev.p.x, y2: prev.p.y });
  return runs;
}

/* 入口：{data,width,height} 像素 → 一批粗糙的直线段（没有"墙厚"概念，统一给个占位宽度，
   靠 pdfWallDetect.js 的 detectWallCandidates 去配对出真正的墙厚）。
   做法：Sobel 找边缘像素，每个边缘像素自带一个方向（梯度方向转 90° 就是线条自身的方向）——
   不用对每个像素测试所有角度（那是标准 Hough 变换的做法，像素多的时候很慢），直接把每个边缘
   像素按"自己测出来的方向 + 到原点的垂直距离"分到 (角度桶, 距离桶) 里，桶内的点再按"沿线方向
   投影排序、合并连续段"取出线段——本质是把霍夫变换的"投票"换成了"每个像素自己算出该投给哪一桶"，
   桶划分得不准也没关系，后续 detectWallCandidates 自己还有一轮容差合并能吸收掉这里的碎片。 */
export function detectRasterSegments(imageData, opts = {}) {
  const { data, width, height } = imageData;
  const { angleStepDeg = 2, rhoStep = 3, gapTol = 8, minSegLen = 24 } = opts;
  const gray = toGrayscale(data, width, height);
  const { mag, dir } = sobel(gray, width, height);
  const threshold = otsuThreshold(mag);

  const angleStepRad = (angleStepDeg * Math.PI) / 180;
  const groups = new Map();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (mag[idx] <= threshold) continue;
      let edgeAngle = dir[idx] + Math.PI / 2;
      edgeAngle = ((edgeAngle % Math.PI) + Math.PI) % Math.PI; // 归一化到 [0, π)：线条和它的反方向是同一条线
      const thetaBucket = Math.round(edgeAngle / angleStepRad);
      const theta = thetaBucket * angleStepRad;
      const ux = Math.cos(theta), uy = Math.sin(theta);
      const nx = -uy, ny = ux;
      const rho = x * nx + y * ny;
      const rhoBucket = Math.round(rho / rhoStep);
      const key = thetaBucket + "_" + rhoBucket;
      let g = groups.get(key);
      if (!g) {
        g = { ux, uy, points: [] };
        groups.set(key, g);
      }
      g.points.push({ x, y });
    }
  }

  const segments = [];
  for (const { ux, uy, points } of groups.values()) {
    if (points.length < 2) continue;
    const withT = points.map((p) => ({ t: p.x * ux + p.y * uy, p }));
    for (const r of extractRuns(withT, gapTol, minSegLen)) segments.push({ x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2, w: 1 });
  }
  return segments;
}

/* 真正的建筑图里，墙会围出一个个封闭的房间；文字、尺寸标注线、柱子这些噪点通常飘在某个房间的
   空白区域"内部"，不会真的把一块空间分隔成两块。labelOpenRegions + filterWallsByRoomAdjacency
   就是拿这个区别去筛掉噪点：
   1. 把图整体二值化（大津法自动找阈值，暗=墨迹——墙线/文字/家具/标注线，亮=空白纸面）。
   2. 对"空白纸面"做连通区域标号（并查集），面积落在 [minArea,maxArea] 的区域当"有效房间"
      （太小的是文字笔画间的小洞、家具缝隙；太大的通常是页面最外圈没画完的背景，不是真房间）。
   3. 对 pdfWallDetect.js 配对好的每一面墙候选（这时候已经知道它的中心线和厚度 w 了），沿中心线
      在两侧各探一个点（探测距离按这面墙自己的厚度 w 算，不是固定值——不然一面很厚的墙会探不穿
      墙体本身，一面很薄的墙又会探过头插进隔壁房间）：如果两侧分别落在两个不同的"有效房间"里
      （或者一侧是有效房间、另一侧是贴着图纸边缘的窄留白），就认为这面墙真的分隔了两块空间，留下；
      如果两侧探到同一个房间，说明这条线没有真的挡住什么，大概率是房间内部的文字/尺寸标注/柱子，
      丢掉。放在配对之后（而不是配对之前筛原始线段）是因为只有配对完才知道每面墙自己的厚度，
      探测距离才能按墙的实际粗细自适应，不用瞎猜一个固定像素数。 */
export function labelOpenRegions(imageData) {
  const { data, width, height } = imageData;
  const gray = toGrayscale(data, width, height);
  const threshold = otsuThreshold(gray);
  const dark = new Uint8Array(width * height);
  // 用 <=（不是 <）：otsuThreshold 在墨迹极少、灰度基本只有 0（墨迹）和 255（纸面）两极分布时
  // （干净的合成测试图就是这样，真实扫描件因为有抗锯齿一般不会撞上这个边界），算出来的最优阈值可能
  // 精确等于 0——用严格小于的话，灰度恰好是 0 的纯黑像素反而不会被判成"暗"，二值化整个失效。
  for (let i = 0; i < gray.length; i++) dark[i] = gray[i] <= threshold ? 1 : 0;

  const n = width * height;
  const label = new Int32Array(n).fill(-1);
  const parent = new Int32Array(n);
  let nextLabel = 0;
  function find(x) {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  }
  function union(a, b) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (dark[idx]) continue; // 只标记空白纸面，墨迹本身不参与连通区域
      const leftIdx = x > 0 && !dark[idx - 1] ? idx - 1 : -1;
      const upIdx = y > 0 && !dark[idx - width] ? idx - width : -1;
      const leftLabel = leftIdx >= 0 ? label[leftIdx] : -1;
      const upLabel = upIdx >= 0 ? label[upIdx] : -1;
      if (leftLabel < 0 && upLabel < 0) {
        label[idx] = nextLabel;
        parent[nextLabel] = nextLabel;
        nextLabel++;
      } else if (upLabel < 0) {
        label[idx] = leftLabel;
      } else if (leftLabel < 0) {
        label[idx] = upLabel;
      } else {
        label[idx] = leftLabel;
        if (leftLabel !== upLabel) union(leftLabel, upLabel);
      }
    }
  }
  const areaByRoot = new Map();
  for (let i = 0; i < n; i++) {
    if (label[i] < 0) continue;
    const root = find(label[i]);
    label[i] = root;
    areaByRoot.set(root, (areaByRoot.get(root) || 0) + 1);
  }
  return { label, areaByRoot, width, height };
}

/* walls：pdfWallDetect.js 的 detectWallCandidates 配对完的墙体候选（有中心线 x1/y1/x2/y2 和
   厚度 w）。extraMargin 是在墙的半厚度之外再多探一点，确保探测点确实落进墙外的空间，不会因为
   墙边缘的锯齿/抗锯齿正好卡在墙体本身上。 */
export function filterWallsByRoomAdjacency(walls, regions, opts = {}) {
  const { minRoomArea = 4000, maxRoomArea = Infinity, extraMargin = 4, sampleStep = 20 } = opts;
  const { label, areaByRoot, width, height } = regions;
  const isValidRoom = (lbl) => {
    if (lbl < 0) return false;
    const area = areaByRoot.get(lbl) || 0;
    return area >= minRoomArea && area <= maxRoomArea;
  };
  // 探到的另一侧要分两种"无效"：探到的是空白纸面、只是这块连通区域太小（比如贴着图纸最外圈的
  // 窄留白）——这种跟"有效房间"搭一侧也该算数；探到的直接是墨迹本身（比如探进了一个实心色块/
  // 家具图案内部，或者 extraMargin 不够、还没探出墙体本身）——这种不该算数，不然一个实心黑方块的
  // 边缘会被误判成"分隔了两块空间"（一侧是真房间，另一侧是色块内部的墨迹）。
  const isOpenButSmall = (lbl) => lbl >= 0 && !isValidRoom(lbl);
  return walls.filter((wall) => {
    const dx = wall.x2 - wall.x1, dy = wall.y2 - wall.y1;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return false;
    const ux = dx / len, uy = dy / len;
    const nx = -uy, ny = ux;
    const probeDist = wall.w / 2 + extraMargin; // 按这面墙自己的厚度算，不用固定值——薄墙探不过头，厚墙探得穿
    const samples = Math.max(3, Math.round(len / sampleStep));
    let votes = 0, total = 0;
    for (let i = 1; i < samples; i++) {
      const t = i / samples;
      const px = wall.x1 + dx * t, py = wall.y1 + dy * t;
      const ax = Math.round(px + nx * probeDist), ay = Math.round(py + ny * probeDist);
      const bx = Math.round(px - nx * probeDist), by = Math.round(py - ny * probeDist);
      if (ax < 0 || ay < 0 || ax >= width || ay >= height || bx < 0 || by < 0 || bx >= width || by >= height) continue;
      total++;
      const la = label[ay * width + ax], lb = label[by * width + bx];
      const validA = isValidRoom(la), validB = isValidRoom(lb);
      if (validA && validB && la !== lb) votes++; // 两侧是不同的有效房间——真的分隔了两块空间
      else if ((validA && isOpenButSmall(lb)) || (validB && isOpenButSmall(la))) votes++; // 一侧有效房间，另一侧是小块空白（贴图纸边缘的窄留白），仍然算
    }
    return total > 0 && votes / total >= 0.5; // 多数采样点都支持"这条线分隔了空间"才留下
  });
}
