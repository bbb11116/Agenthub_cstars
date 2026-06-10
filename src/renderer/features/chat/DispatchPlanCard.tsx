import type { DispatchRun, DispatchStep } from "../../../shared/domain";
import type { Agent } from "../../../shared/domain";

type DispatchPlanCardProps = {
  dispatchRun: DispatchRun;
  steps: DispatchStep[];
  agents: Record<string, Agent>;
  onRetryStep?: (stepId: string) => void;
};

const STATUS_LABELS: Record<string, string> = {
  pending: "等待中",
  running: "执行中",
  streaming: "回复中",
  completed: "已完成",
  failed: "失败",
  skipped: "已跳过",
  partial: "部分完成",
  iteration_limit_reached: "达到迭代上限",
  waiting_for_permission: "等待权限",
  cancelled: "已取消"
};

const RUN_STATUS_LABELS: Record<string, string> = {
  planning: "规划中",
  plan_created: "已生成计划",
  running: "执行中",
  running_subagents: "子 Agent 执行中",
  reviewing: "审核中",
  redispatching: "重新分派中",
  completed: "已完成",
  partial: "部分完成",
  partial_failed: "部分失败",
  failed: "失败",
  waiting_for_user: "等待用户输入",
  cancelled: "已取消"
};

export function DispatchPlanCard({
  dispatchRun,
  steps,
  agents,
  onRetryStep
}: DispatchPlanCardProps) {
  return (
    <div className="dispatch-plan-card">
      <div className="dispatch-plan-header">
        <span className="dispatch-plan-mode">
          {dispatchRun.mode === "mention"
            ? "@ 指定执行"
            : dispatchRun.mode === "auto_dispatch"
            ? "自动分派"
            : "主 Agent 回复"}
        </span>
        <span className={`dispatch-run-status dispatch-run-status-${dispatchRun.status}`}>
          {RUN_STATUS_LABELS[dispatchRun.status] ?? dispatchRun.status}
        </span>
      </div>

      <div className="dispatch-plan-round">
        当前轮次: {dispatchRun.roundIndex + 1}
      </div>

      {dispatchRun.acceptanceCriteria.length > 0 ? (
        <div className="dispatch-plan-criteria">
          <strong>Acceptance Criteria</strong>
          {dispatchRun.acceptanceCriteria.map((criterion) => (
            <div key={criterion.id} className={`dispatch-criterion dispatch-criterion-${criterion.status}`}>
              [{criterion.status}] {criterion.description}
            </div>
          ))}
        </div>
      ) : null}

      <div className="dispatch-plan-steps">
        {steps.map((step) => {
          const agent = agents[step.agentId];

          return (
            <div
              key={step.id}
              className={`dispatch-step dispatch-step-${step.status}`}
            >
              <div className="dispatch-step-header">
                <span className="dispatch-step-agent">
                  {agent?.name ?? step.agentId}
                </span>
                <span className={`dispatch-step-status dispatch-step-status-${step.status}`}>
                  {STATUS_LABELS[step.status] ?? step.status}
                </span>
              </div>
              <div className="dispatch-step-instruction">{step.instruction}</div>
              <div className="dispatch-step-budget">
                round {step.roundIndex + 1}, maxIterations={step.maxIterations}
              </div>
              {step.subAgentResult ? (
                <div className="dispatch-step-result">
                  {step.subAgentResult.summary}
                </div>
              ) : null}
              {step.status === "failed" && step.errorMessage ? (
                <div className="dispatch-step-error">{step.errorMessage}</div>
              ) : null}
              {step.status === "failed" && onRetryStep ? (
                <button
                  className="dispatch-step-retry"
                  type="button"
                  onClick={() => onRetryStep(step.id)}
                >
                  重新执行
                </button>
              ) : null}
            </div>
          );
        })}
      </div>

      {dispatchRun.orchestratorReview ? (
        <div className="dispatch-plan-review">
          <strong>Orchestrator Review: {dispatchRun.orchestratorReview.decision}</strong>
          <div>{dispatchRun.orchestratorReview.reason}</div>
        </div>
      ) : null}
    </div>
  );
}
