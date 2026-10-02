import { useEffect, useMemo, useState } from "react";
import { compute, defaultFloors, PlanEditor, usePlanHistory, C, FONT, H2 } from "../calculator/StairCoreTool.jsx";
import { loadInp, savePlan, loadPlan, onExternalChange, INP_KEY, otherAppHref } from "../planBridge.js";
import { PLAN_DEFAULTS } from "./planFile.js";
import LangToggle from "../LangToggle.jsx";
import { t } from "../i18n.js";

/* 跟 StairCoreTool 里"确认并计算"按钮生效前的默认草稿完全一致——核心筒计算器从没打开过、
   localStorage 里还没有 inp 时，平面图工具用这份默认值先算一次，不会因为拿不到数据而空白/报错。 */
const DEFAULT_ADV = { run: 280, maxRise: 180, maxRisers: 10, gap: 150, centerWall: 200, doorLeaf: 950, doorPos: "end", doorHinge: "wall", doorSide: "dn", waist: 180, roundStep: 50 };
const DEFAULT_INP = { nFloors: 5, wall: 300, maxStairW: 1500, stairType: "dogleg", includeL1: false, sprinklered: true, buildingArea: 800, adv: DEFAULT_ADV, floors: defaultFloors(5) };
const DEFAULT_PLAN = PLAN_DEFAULTS; // 跟工程文件保存/打开共用同一份默认值（src/plan/planFile.js），避免两处漂移

export default function PlanApp() {
  const [inp, setInp] = useState(() => loadInp() || DEFAULT_INP);
  const [hasSavedInp] = useState(() => loadInp() != null);

  /* 核心筒计算器（/）跟这个页面是两个独立标签页；那边点"确认并计算"会把新的 inp 写进
     localStorage，这里用 storage 事件（只在"别的标签页"写入时触发）跟着更新，
     不需要手动刷新或导入导出。 */
  useEffect(
    () =>
      onExternalChange(INP_KEY, () => {
        const next = loadInp();
        if (next) setInp(next);
      }),
    []
  );

  const res = useMemo(() => compute(inp), [inp]);
  const scissorRelax = inp.stairType === "scissor" && res.allRes && inp.nFloors <= 6 && inp.buildingArea <= 600;

  /* 跟 DEFAULT_PLAN 合并而不是直接用 loadPlan() 的结果——旧版本存的 plan 可能没有后来才加的字段
     （比如这次新加的 wallCandidates），直接用会导致 .length / .map 在缺字段的旧数据上报错。 */
  const { plan, setPlan, undo, redo, canUndo, canRedo } = usePlanHistory({ ...DEFAULT_PLAN, ...(loadPlan() || {}) });
  useEffect(() => {
    savePlan(plan);
  }, [plan]);

  return (
    <div style={{ background: C.paper, minHeight: "100vh", fontFamily: FONT, color: C.ink }}>
      <LangToggle />
      <div className="mx-auto px-4 py-6" style={{ maxWidth: 1360 }}>
        <header className="mb-4 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, letterSpacing: "-0.01em" }}>{t("平面图工具")}</h1>
            <p style={{ color: C.muted, margin: "6px 0 0", fontSize: 13, maxWidth: 720 }}>
              {t("核心筒摆放、走廊墙体、门、楼层边界与疏散路径校核。楼梯计算结果来自核心筒计算器，两边通过浏览器本地存储自动同步。")}
            </p>
          </div>
          <a
            href={otherAppHref("calc")}
            target="_blank"
            rel="noopener"
            className="inline-flex items-center gap-2 rounded px-4 py-2"
            style={{ border: `1px solid ${C.rule}`, color: C.ink, textDecoration: "none", fontWeight: 600, fontSize: 13 }}
          >
            {t("← 在新标签页打开核心筒计算器")}
          </a>
        </header>
        {!hasSavedInp && (
          <div className="rounded p-3 mb-4" style={{ border: `1px solid ${C.warn}`, background: "#FFF8E8", fontSize: 12.5 }}>
            {t("还没有在核心筒计算器里\"确认并计算\"过，当前用的是默认参数（5 层、折返梯）。去核心筒计算器确认一次后，这里会自动换成你的实际计算结果。")}
          </div>
        )}
        <section className="rounded-lg p-5" style={{ background: C.panel, border: `1px solid ${C.rule}` }}>
          <H2 sub={t("上传平面图并标定比例，摆放核心筒、绘制楼层边界与疏散路径")}>{t("平面布置与疏散距离校核")}</H2>
          <PlanEditor res={res} inp={inp} plan={plan} setPlan={setPlan} scissorRelax={scissorRelax} undoPlan={undo} redoPlan={redo} canUndoPlan={canUndo} canRedoPlan={canRedo} />
        </section>
      </div>
    </div>
  );
}
