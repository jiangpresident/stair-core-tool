import StairCoreTool from "./calculator/StairCoreTool.jsx";
import PlanApp from "./plan/PlanApp.jsx";

/* 核心筒计算器（/）与平面图工具（/plan）现在是两个独立页面，各自能单独打开/收藏，
   通过 localStorage 传递楼梯计算结果（见 src/planBridge.js）。按路径切换渲染哪一个；
   开发服务器（vite dev）默认对不认识的路径也会回退到 index.html，/plan 不用额外配置。 */
export default function App() {
  const path = window.location.pathname;
  if (path === "/plan" || path.endsWith("/plan.html")) return <PlanApp />;
  return <StairCoreTool />;
}
