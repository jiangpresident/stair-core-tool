/* 核心筒计算器（/）与平面图工具（/plan）现在是两个独立页面，通过 localStorage 传递数据：
   计算器确认参数后把 inp 写进 localStorage；平面图页面启动时读一次，之后靠 `storage` 事件
   跟踪"另一个标签页"里 localStorage 的变化，实现跨标签页的准实时同步（不需要后端）。
   平面图自己的 plan（核心筒/墙/门/边界等摆放）只在平面图这一侧读写，计算器不需要它。 */
const INP_KEY = "stair-core:inp";
const PLAN_KEY = "stair-core:plan";

function safeSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {}
}
function safeGet(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    return null;
  }
}

export const saveInp = (inp) => safeSet(INP_KEY, inp);
export const loadInp = () => safeGet(INP_KEY);
export const savePlan = (plan) => safeSet(PLAN_KEY, plan);
export const loadPlan = () => safeGet(PLAN_KEY);

/* 订阅"另一个标签页"对某个 key 的写入（同一个标签页内改 localStorage 不会触发 storage 事件，
   这正是我们想要的——本页自己的写入不需要再通知自己）。返回取消订阅函数。 */
export function onExternalChange(key, cb) {
  const handler = (e) => {
    if (e.key === key) cb();
  };
  window.addEventListener("storage", handler);
  return () => window.removeEventListener("storage", handler);
}

/* 计算器页面跟平面图页面互相跳转的链接地址：`npm run dev` / 正常构建部署时用路径（"/"、"/plan"）；
   `npm run build:single` 产出的双击打开单文件版本没有服务器、location.protocol 是 "file:"，
   这时候只能跳到同一个文件夹里的另一个 html 文件（用相对路径），两种场景共用同一份组件代码，
   靠这个函数在运行时判断当前是哪种场景。 */
export function otherAppHref(target) {
  if (typeof location !== "undefined" && location.protocol === "file:") {
    return target === "plan" ? "stair-core-plan.html" : "stair-core-calculator.html";
  }
  // 部署在子路径下（GitHub Pages：vite build --base=/stair-core-tool/）时，Vite 把 BASE_URL 注入进来；
  // 那里没有 /plan 这种路由，用的是 plan.html（部署脚本从 index.html 复制一份）。本地开发 BASE_URL 是 "/"，行为不变。
  const base = (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.BASE_URL) || "/";
  if (base !== "/") return target === "plan" ? base + "plan.html" : base;
  return target === "plan" ? "/plan" : "/";
}

export { INP_KEY, PLAN_KEY };
