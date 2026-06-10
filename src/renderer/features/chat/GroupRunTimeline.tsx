import { useEffect, useMemo, useState } from "react";
import type {
  DispatchMode,
  DispatchRunStatus,
  DispatchStepStatus,
  GroupRunEvent
} from "../../../shared/groupChat";

type StepView = {
  stepId: string;
  assignmentId: string | null;
  stepIndex: number;
  roundIndex: number;
  agentId: string;
  agentName: string;
  instruction: string;
  status: DispatchStepStatus;
  summary: string | null;
  diffProposalId: string | null;
  detailAvailable: boolean;
  errorMessage: string | null;
  reason: string | null;
  targetCriteria: string[];
  dependsOn: string[];
  targetFiles: string[];
  taskTitle: string | null;
  taskType: string | null;
  expectedOutputType: string | null;
  riskLevel: string | null;
  progress: StepProgressView[];
  startedAt: string | null;
  finishedAt: string | null;
  lastEventAt: string | null;
};

type StepProgressView = {
  id: string;
  title: string;
  body: string | null;
  level: "info" | "warning" | "error";
  phase: string;
  createdAt: string;
  seq: number;
};

type RunView = {
  groupRunId: string;
  mode: DispatchMode | null;
  status: DispatchRunStatus | "unknown";
  createdAt: string;
  roundIndex: number;
  steps: StepView[];
  summary: string | null;
  summaryMessageId: string | null;
  lastEventAt: string | null;
};

type BuildRunsOptions = {
  collapseRetries?: boolean;
};

type DagNodeView = StepView & {
  nodeId: string;
  column: number;
  row: number;
  x: number;
  y: number;
  dependencyIds: string[];
  missingDependencyIds: string[];
};

type DagEdgeView = {
  id: string;
  from: string;
  to: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  active: boolean;
  failed: boolean;
};

type DagLayoutView = {
  nodes: DagNodeView[];
  edges: DagEdgeView[];
  width: number;
  height: number;
  columns: number;
};

const DAG_NODE_WIDTH = 220;
const DAG_NODE_HEIGHT = 108;
const DAG_COLUMN_GAP = 72;
const DAG_ROW_GAP = 22;

const STEP_STATUS_LABELS: Record<string, string> = {
  pending: "等待",
  queued: "等待",
  running: "运行中",
  streaming: "运行中",
  completed: "完成",
  partial: "部分完成",
  failed: "失败",
  iteration_limit_reached: "达到上限",
  waiting_for_permission: "等待权限",
  cancelled: "已取消",
  skipped: "已跳过"
};

const RUN_STATUS_LABELS: Record<string, string> = {
  planning: "规划中",
  plan_created: "已生成计划",
  running: "运行中",
  running_subagents: "子 Agent 运行中",
  reviewing: "汇总中",
  redispatching: "重新分派中",
  completed: "已完成",
  partial: "部分失败",
  partial_failed: "部分失败",
  failed: "失败",
  waiting_for_user: "等待用户",
  cancelled: "已取消",
  unknown: "运行中"
};

const WORKING_STEP_STATUSES: DispatchStepStatus[] = [
  "pending",
  "queued",
  "running",
  "streaming",
  "waiting_for_permission"
];

const CURRENT_DAG_STEP_STATUSES: DispatchStepStatus[] = [
  "running",
  "streaming",
  "waiting_for_permission"
];

function sortEvents(events: GroupRunEvent[]): GroupRunEvent[] {
  return [...events].sort((left, right) => {
    if (left.groupRunId !== right.groupRunId) {
      return left.createdAt.localeCompare(right.createdAt);
    }
    return left.seq - right.seq;
  });
}

function getOrCreateRun(
  runs: Map<string, RunView>,
  event: GroupRunEvent
): RunView {
  const existing = runs.get(event.groupRunId);
  if (existing) {
    return existing;
  }

  const run: RunView = {
    groupRunId: event.groupRunId,
    mode: null,
    status: "unknown",
    createdAt: event.createdAt,
    roundIndex: 0,
    steps: [],
    summary: null,
    summaryMessageId: null,
    lastEventAt: null
  };
  runs.set(event.groupRunId, run);
  return run;
}

function mergeStep(current: StepView, nextStep: StepView, eventCreatedAt: string | null): StepView {
  return {
    ...current,
    ...nextStep,
    assignmentId: nextStep.assignmentId ?? current.assignmentId,
    dependsOn: nextStep.dependsOn.length > 0 ? nextStep.dependsOn : current.dependsOn,
    targetFiles: nextStep.targetFiles.length > 0 ? nextStep.targetFiles : current.targetFiles,
    taskTitle: nextStep.taskTitle ?? current.taskTitle,
    taskType: nextStep.taskType ?? current.taskType,
    expectedOutputType: nextStep.expectedOutputType ?? current.expectedOutputType,
    riskLevel: nextStep.riskLevel ?? current.riskLevel,
    progress: nextStep.progress.length > 0 ? nextStep.progress : current.progress,
    startedAt: current.startedAt ?? nextStep.startedAt,
    finishedAt: nextStep.finishedAt ?? current.finishedAt,
    lastEventAt: eventCreatedAt ?? current.lastEventAt
  };
}

function upsertStep(run: RunView, nextStep: StepView, eventCreatedAt: string | null = null): void {
  const index = run.steps.findIndex(
    (step) =>
      step.stepId === nextStep.stepId ||
      (step.stepIndex === nextStep.stepIndex &&
        step.roundIndex === nextStep.roundIndex &&
        step.agentId === nextStep.agentId)
  );
  if (index >= 0) {
    run.steps[index] = mergeStep(run.steps[index], nextStep, eventCreatedAt);
    return;
  }
  run.steps.push({ ...nextStep, lastEventAt: eventCreatedAt ?? nextStep.lastEventAt });
  run.steps.sort((left, right) => left.stepIndex - right.stepIndex);
}

function appendStepProgress(run: RunView, event: Extract<GroupRunEvent, { type: "agent_progress" }>): void {
  const payload = event.payload;
  const existing = run.steps.find((step) => step.stepId === payload.stepId);
  const progress: StepProgressView = {
    id: event.id,
    title: payload.title,
    body: payload.body ?? null,
    level: payload.level,
    phase: payload.phase,
    createdAt: event.createdAt,
    seq: event.seq
  };
  const nextProgress = [
    ...(existing?.progress ?? []).filter((item) => item.id !== event.id),
    progress
  ].sort((left, right) => left.seq - right.seq);

  upsertStep(run, {
    stepId: payload.stepId,
    assignmentId: existing?.assignmentId ?? null,
    stepIndex: payload.stepIndex,
    roundIndex: payload.roundIndex,
    agentId: payload.agentId,
    agentName: payload.agentName ?? existing?.agentName ?? payload.agentId,
    instruction: payload.instruction ?? existing?.instruction ?? "",
    status: payload.status ?? existing?.status ?? "running",
    summary: existing?.summary ?? null,
    diffProposalId: existing?.diffProposalId ?? null,
    detailAvailable: existing?.detailAvailable ?? false,
    errorMessage: payload.level === "error" ? payload.body ?? existing?.errorMessage ?? null : existing?.errorMessage ?? null,
    reason: existing?.reason ?? null,
    targetCriteria: existing?.targetCriteria ?? [],
    dependsOn: existing?.dependsOn ?? [],
    targetFiles: existing?.targetFiles ?? [],
    taskTitle: existing?.taskTitle ?? null,
    taskType: existing?.taskType ?? null,
    expectedOutputType: existing?.expectedOutputType ?? null,
    riskLevel: existing?.riskLevel ?? null,
    progress: nextProgress,
    startedAt: existing?.startedAt ?? null,
    finishedAt: existing?.finishedAt ?? null,
    lastEventAt: event.createdAt
  }, event.createdAt);
}

function buildRuns(events: GroupRunEvent[], options: BuildRunsOptions = {}): RunView[] {
  const collapseRetries = options.collapseRetries ?? true;
  const runs = new Map<string, RunView>();

  for (const event of sortEvents(events)) {
    const run = getOrCreateRun(runs, event);
    if (!run.lastEventAt || event.createdAt > run.lastEventAt) {
      run.lastEventAt = event.createdAt;
    }

    switch (event.type) {
      case "plan_created":
        run.mode = event.payload.mode;
        run.status = "plan_created";
        run.roundIndex = event.payload.roundIndex;
        for (const assignment of event.payload.assignments) {
          upsertStep(run, {
            stepId: assignment.stepId,
            assignmentId: assignment.assignmentId,
            stepIndex: assignment.stepIndex,
            roundIndex: assignment.roundIndex,
            agentId: assignment.agentId,
            agentName: assignment.agentName,
            instruction: assignment.instruction,
            status: "pending",
            summary: null,
            diffProposalId: null,
            detailAvailable: false,
            errorMessage: null,
            reason: assignment.reason ?? null,
            targetCriteria: assignment.targetCriteria,
            dependsOn: assignment.dependsOn ?? [],
            targetFiles: assignment.targetFiles ?? [],
            taskTitle: assignment.taskTitle ?? null,
            taskType: assignment.taskType ?? null,
            expectedOutputType: assignment.expectedOutputType ?? null,
            riskLevel: assignment.riskLevel ?? null,
            progress: [],
            startedAt: null,
            finishedAt: null,
            lastEventAt: event.createdAt
          }, event.createdAt);
        }
        break;
      case "agent_started":
      case "agent_completed":
      case "agent_failed": {
        const payload = event.payload;
        const existing = run.steps.find((step) => step.stepId === payload.stepId);
        const isStart = event.type === "agent_started";
        const isFinish = event.type === "agent_completed" || event.type === "agent_failed";
        const nextStatus: DispatchStepStatus = isStart
          ? "running"
          : payload.status ?? (event.type === "agent_failed" ? "failed" : "completed");
        upsertStep(run, {
          stepId: payload.stepId,
          assignmentId: existing?.assignmentId ?? null,
          stepIndex: payload.stepIndex,
          roundIndex: payload.roundIndex,
          agentId: payload.agentId,
          agentName: payload.agentName ?? existing?.agentName ?? payload.agentId,
          instruction: payload.instruction ?? existing?.instruction ?? "",
          status: nextStatus,
          summary: payload.summary ?? existing?.summary ?? null,
          diffProposalId: payload.diffProposalId ?? existing?.diffProposalId ?? null,
          detailAvailable: payload.detailAvailable ?? existing?.detailAvailable ?? false,
          errorMessage: payload.errorMessage ?? existing?.errorMessage ?? null,
          reason: existing?.reason ?? null,
          targetCriteria: existing?.targetCriteria ?? [],
          dependsOn: existing?.dependsOn ?? [],
          targetFiles: existing?.targetFiles ?? [],
          taskTitle: existing?.taskTitle ?? null,
          taskType: existing?.taskType ?? null,
          expectedOutputType: existing?.expectedOutputType ?? null,
          riskLevel: existing?.riskLevel ?? null,
          progress: existing?.progress ?? [],
          startedAt: isStart ? event.createdAt : existing?.startedAt ?? null,
          finishedAt: isFinish ? event.createdAt : existing?.finishedAt ?? null,
          lastEventAt: event.createdAt
        }, event.createdAt);
        run.status = event.type === "agent_started" ? "running_subagents" : run.status;
        break;
      }
      case "agent_progress":
        appendStepProgress(run, event);
        run.status = "running_subagents";
        break;
      case "summary_started":
        run.status = event.payload.status;
        break;
      case "summary_completed":
        run.status = event.payload.status;
        run.summary = event.payload.summary;
        run.summaryMessageId = event.payload.summaryMessageId;
        break;
    }
  }

  // The orchestrator's redispatch loop creates a fresh DispatchStep (new id,
  // offset stepIndex, incremented roundIndex) for every retried agent, so the
  // raw upsertStep dedup key never matches. Collapse retries down to the latest
  // attempt per agent so the visible step count stops growing each round.
  if (collapseRetries) {
    for (const run of runs.values()) {
      run.steps = dedupeRetriedSteps(run.steps);
    }
  }

  return [...runs.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function dedupeRetriedSteps(steps: StepView[]): StepView[] {
  const latestByAgent = new Map<string, StepView>();
  for (const step of steps) {
    const existing = latestByAgent.get(step.agentId);
    if (!existing || step.roundIndex > existing.roundIndex) {
      latestByAgent.set(step.agentId, step);
    }
  }
  return steps.filter((step) => latestByAgent.get(step.agentId) === step);
}

function openInspector(tab: "Diff" | "Runtime"): void {
  window.dispatchEvent(
    new CustomEvent("agenthub:open-inspector", {
      detail: { tab }
    })
  );
}

function openDiff(workspaceId: string, diffProposalId: string): void {
  window.dispatchEvent(
    new CustomEvent("agenthub:open-diff", {
      detail: { workspaceId, diffProposalId }
    })
  );
}

function getModeLabel(mode: DispatchMode | null): string {
  if (mode === "mention") {
    return "@ 指定分派";
  }
  if (mode === "auto_dispatch") {
    return "自动分派";
  }
  if (mode === "main_direct") {
    return "主 Agent 直接处理";
  }
  return "群聊运行";
}

function compactText(value: string | null | undefined, maxLength = 180): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function getAgentInitial(agentName: string): string {
  return agentName.trim().slice(0, 1).toUpperCase() || "A";
}

function isWorkingStep(status: DispatchStepStatus): boolean {
  return WORKING_STEP_STATUSES.includes(status);
}

function isCurrentDagStep(status: DispatchStepStatus): boolean {
  return CURRENT_DAG_STEP_STATUSES.includes(status);
}

function getStepNarrative(step: StepView): string {
  if (step.status === "completed" || step.status === "partial") {
    return compactText(step.summary, 220) || "已完成，结果已保存到后台详情。";
  }

  if (
    step.status === "failed" ||
    step.status === "iteration_limit_reached" ||
    step.status === "cancelled"
  ) {
    return (
      compactText(step.summary ?? step.errorMessage, 220) ||
      "执行未完成，错误和日志已保存到后台。"
    );
  }

  if (step.status === "waiting_for_permission") {
    return compactText(step.instruction, 160) || "等待权限确认。";
  }

  if (step.status === "pending" || step.status === "queued") {
    return compactText(step.instruction, 160) || "等待接力处理。";
  }

  return compactText(step.instruction, 180) || "正在处理当前任务。";
}

function getStepNodeId(step: StepView): string {
  return step.assignmentId ?? step.stepId;
}

function isFailedStep(status: DispatchStepStatus): boolean {
  return (
    status === "failed" ||
    status === "iteration_limit_reached" ||
    status === "cancelled"
  );
}

function isCompletedStep(status: DispatchStepStatus): boolean {
  return status === "completed" || status === "partial";
}

function getDagNodeStatus(step: StepView): "active" | "done" | "failed" | "waiting" {
  if (isCurrentDagStep(step.status)) {
    return "active";
  }
  if (isFailedStep(step.status)) {
    return "failed";
  }
  if (isCompletedStep(step.status)) {
    return "done";
  }
  return "waiting";
}

function getDependencyIds(step: StepView, knownIds: Set<string>): {
  dependencyIds: string[];
  missingDependencyIds: string[];
} {
  const unique = [...new Set(step.dependsOn)];
  return {
    dependencyIds: unique.filter((id) => knownIds.has(id)),
    missingDependencyIds: unique.filter((id) => !knownIds.has(id))
  };
}

function buildDagLayout(steps: StepView[]): DagLayoutView {
  const sortedSteps = [...steps].sort((left, right) => {
    if (left.roundIndex !== right.roundIndex) {
      return left.roundIndex - right.roundIndex;
    }
    return left.stepIndex - right.stepIndex;
  });
  const knownIds = new Set(sortedSteps.map(getStepNodeId));
  const stepById = new Map(sortedSteps.map((step) => [getStepNodeId(step), step]));
  const columnCache = new Map<string, number>();

  const getColumn = (step: StepView, stack = new Set<string>()): number => {
    const nodeId = getStepNodeId(step);
    const cached = columnCache.get(nodeId);
    if (cached !== undefined) {
      return cached;
    }
    if (stack.has(nodeId)) {
      columnCache.set(nodeId, 0);
      return 0;
    }
    const { dependencyIds } = getDependencyIds(step, knownIds);
    if (dependencyIds.length === 0) {
      columnCache.set(nodeId, 0);
      return 0;
    }

    stack.add(nodeId);
    const column = Math.max(
      ...dependencyIds.map((dependencyId) => {
        const dependency = stepById.get(dependencyId);
        return dependency ? getColumn(dependency, stack) + 1 : 0;
      })
    );
    stack.delete(nodeId);
    columnCache.set(nodeId, column);
    return column;
  };

  const rowsByColumn = new Map<number, number>();
  const nodes = sortedSteps.map((step) => {
    const nodeId = getStepNodeId(step);
    const column = getColumn(step);
    const row = rowsByColumn.get(column) ?? 0;
    rowsByColumn.set(column, row + 1);
    const { dependencyIds, missingDependencyIds } = getDependencyIds(step, knownIds);

    return {
      ...step,
      nodeId,
      column,
      row,
      x: column * (DAG_NODE_WIDTH + DAG_COLUMN_GAP),
      y: row * (DAG_NODE_HEIGHT + DAG_ROW_GAP),
      dependencyIds,
      missingDependencyIds
    };
  });

  const nodeById = new Map(nodes.map((node) => [node.nodeId, node]));
  const edges: DagEdgeView[] = [];
  for (const node of nodes) {
    for (const dependencyId of node.dependencyIds) {
      const from = nodeById.get(dependencyId);
      if (!from) {
        continue;
      }
      edges.push({
        id: `${dependencyId}->${node.nodeId}`,
        from: dependencyId,
        to: node.nodeId,
        fromX: from.x + DAG_NODE_WIDTH,
        fromY: from.y + DAG_NODE_HEIGHT / 2,
        toX: node.x,
        toY: node.y + DAG_NODE_HEIGHT / 2,
        active: isCurrentDagStep(node.status),
        failed: isFailedStep(from.status) || isFailedStep(node.status)
      });
    }
  }

  const columns = nodes.length > 0 ? Math.max(...nodes.map((node) => node.column)) + 1 : 1;
  const maxRows = Math.max(1, ...Array.from(rowsByColumn.values()));

  return {
    nodes,
    edges,
    columns,
    width: columns * DAG_NODE_WIDTH + Math.max(0, columns - 1) * DAG_COLUMN_GAP,
    height: maxRows * DAG_NODE_HEIGHT + Math.max(0, maxRows - 1) * DAG_ROW_GAP
  };
}

function getActiveSteps(run: RunView): StepView[] {
  return run.steps.filter((step) => isCurrentDagStep(step.status));
}

function TypingDots() {
  return (
    <span className="group-agent-typing" aria-label="正在工作">
      <span />
      <span />
      <span />
    </span>
  );
}

function StepProgressList({
  compact = false,
  progress
}: {
  compact?: boolean;
  progress: StepProgressView[];
}) {
  const visibleProgress = compact ? progress.slice(-4) : progress;
  if (visibleProgress.length === 0) {
    return null;
  }

  return (
    <ol className={compact ? "group-step-progress group-step-progress-compact" : "group-step-progress"}>
      {visibleProgress.map((item) => (
        <li
          className={`group-step-progress-item group-step-progress-item-${item.level}`}
          key={item.id}
        >
          <span className="group-step-progress-marker" aria-hidden="true" />
          <div>
            <strong>{item.title}</strong>
            {item.body ? <small>{item.body}</small> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

function StepActions({
  onOpenDetails,
  step,
  workspaceId
}: {
  onOpenDetails: () => void;
  step: StepView;
  workspaceId: string | null;
}) {
  const showRuntime = step.detailAvailable || Boolean(step.errorMessage);

  return (
    <div className="group-run-step-actions">
      <button type="button" onClick={onOpenDetails}>
        查看详情
      </button>
      {step.diffProposalId && workspaceId ? (
        <button
          type="button"
          onClick={() => {
            openDiff(workspaceId, step.diffProposalId!);
            openInspector("Diff");
          }}
        >
          查看 Diff
        </button>
      ) : null}
      {showRuntime ? (
        <button type="button" onClick={() => openInspector("Runtime")}>
          查看日志
        </button>
      ) : null}
    </div>
  );
}

function GroupRunPlanDialog({
  onClose,
  run,
  workspaceId
}: {
  onClose: () => void;
  run: RunView;
  workspaceId: string | null;
}) {
  const [expandedStepIds, setExpandedStepIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  function toggleStep(stepId: string): void {
    setExpandedStepIds((current) => {
      const next = new Set(current);
      if (next.has(stepId)) {
        next.delete(stepId);
      } else {
        next.add(stepId);
      }
      return next;
    });
  }

  return (
    <div className="group-run-plan-layer" role="presentation">
      <button
        aria-label="收起分派计划"
        className="group-run-plan-scrim"
        onClick={onClose}
        type="button"
      />
      <section
        aria-label="详细分派计划"
        aria-modal="true"
        className="group-run-plan-popover"
        role="dialog"
      >
        <header className="group-run-plan-header">
          <div>
            <span>{getModeLabel(run.mode)}</span>
            <small>Run {run.groupRunId.slice(0, 8)}</small>
          </div>
          <strong>{RUN_STATUS_LABELS[run.status] ?? run.status}</strong>
          <button
            aria-label="关闭分派计划"
            className="group-run-plan-close"
            onClick={onClose}
            type="button"
          >
            x
          </button>
        </header>

        <p className="group-run-plan-copy">
          主 Agent 已分派 {run.steps.length} 个子 Agent，按事件状态驱动协作进度。
        </p>

        <div className="group-run-plan-steps">
          {run.steps.map((step) => {
            const expanded = expandedStepIds.has(step.stepId);

            return (
              <section className={`group-run-step group-run-step-${step.status}`} key={step.stepId}>
                <div className="group-run-step-header">
                  <div>
                    <strong>{step.agentName}</strong>
                    <small>第 {step.roundIndex + 1} 轮</small>
                  </div>
                  <span>{STEP_STATUS_LABELS[step.status] ?? step.status}</span>
                </div>
                <p className="group-run-step-instruction">{step.instruction}</p>
                {step.reason ? (
                  <p className="group-run-step-reason">{step.reason}</p>
                ) : null}
                {step.summary ? (
                  <p className="group-run-step-summary">{compactText(step.summary, 260)}</p>
                ) : null}
                <StepActions
                  onOpenDetails={() => toggleStep(step.stepId)}
                  step={step}
                  workspaceId={workspaceId}
                />
                {expanded ? (
                  <dl className="group-run-step-detail">
                    <div>
                      <dt>Step</dt>
                      <dd>{step.stepId}</dd>
                    </div>
                    <div>
                      <dt>Agent</dt>
                      <dd>{step.agentId}</dd>
                    </div>
                    {step.targetCriteria.length > 0 ? (
                      <div>
                        <dt>验收项</dt>
                        <dd>{step.targetCriteria.join(" / ")}</dd>
                      </div>
                    ) : null}
                    {step.errorMessage ? (
                      <div>
                        <dt>Error</dt>
                        <dd>{step.errorMessage}</dd>
                      </div>
                    ) : null}
                  </dl>
                ) : null}
              </section>
            );
          })}
        </div>
      </section>
    </div>
  );
}

export function GroupRunPlanTrigger({
  events,
  workspaceId
}: {
  events: GroupRunEvent[];
  workspaceId: string | null;
}) {
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const runs = useMemo(() => buildRuns(events), [events]);
  const latestRun = runs[0] ?? null;
  const openRun = openRunId ? runs.find((run) => run.groupRunId === openRunId) : null;

  if (!latestRun) {
    return null;
  }

  return (
    <>
      <button
        aria-expanded={Boolean(openRun)}
        aria-label="打开详细分派计划"
        className="group-run-plan-trigger"
        onClick={() => setOpenRunId(latestRun.groupRunId)}
        title="分派计划"
        type="button"
      >
        ...
      </button>
      {openRun ? (
        <GroupRunPlanDialog
          onClose={() => setOpenRunId(null)}
          run={openRun}
          workspaceId={workspaceId}
        />
      ) : null}
    </>
  );
}

export function GroupRunTimeline({
  events,
  workspaceId
}: {
  events: GroupRunEvent[];
  workspaceId: string | null;
}) {
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const runs = useMemo(() => [...buildRuns(events)].reverse(), [events]);
  const openRun = openRunId ? runs.find((run) => run.groupRunId === openRunId) : null;

  if (runs.length === 0) {
    return null;
  }

  return (
    <section className="group-run-inline-feed" aria-label="团队协作进度">
      {runs.map((run) => (
        <div className="group-run-flow" key={run.groupRunId}>
          <div className="group-run-flow-status">
            <span>团队协作</span>
            <strong>{RUN_STATUS_LABELS[run.status] ?? run.status}</strong>
          </div>

          {run.steps.map((step) => {
            const working = isWorkingStep(step.status);

            return (
              <article
                className={`group-agent-flow-message group-agent-flow-${step.status}`}
                key={step.stepId}
              >
                <div className="group-agent-flow-avatar" aria-hidden="true">
                  {getAgentInitial(step.agentName)}
                </div>
                <div className="group-agent-flow-bubble">
                  <header>
                    <strong>{step.agentName}</strong>
                    <span>{STEP_STATUS_LABELS[step.status] ?? step.status}</span>
                  </header>
                  <p>{getStepNarrative(step)}</p>
                  <StepProgressList compact progress={step.progress} />
                  {working ? (
                    <TypingDots />
                  ) : (
                    <StepActions
                      onOpenDetails={() => setOpenRunId(run.groupRunId)}
                      step={step}
                      workspaceId={workspaceId}
                    />
                  )}
                </div>
              </article>
            );
          })}

          {run.status === "reviewing" && !run.summaryMessageId ? (
            <article className="group-agent-flow-message group-agent-flow-summary">
              <div className="group-agent-flow-avatar" aria-hidden="true">
                总
              </div>
              <div className="group-agent-flow-bubble">
                <header>
                  <strong>主 Agent</strong>
                  <span>汇总中</span>
                </header>
                <p>正在汇总子 Agent 的结果，生成最终报告。</p>
                <TypingDots />
              </div>
            </article>
          ) : null}
        </div>
      ))}

      {openRun ? (
        <GroupRunPlanDialog
          onClose={() => setOpenRunId(null)}
          run={openRun}
          workspaceId={workspaceId}
        />
      ) : null}
    </section>
  );
}

const TERMINAL_RUN_STATUSES: Array<DispatchRunStatus | "unknown"> = [
  "completed",
  "partial",
  "partial_failed",
  "failed",
  "waiting_for_user",
  "cancelled"
];

function isTerminalRunStatus(status: DispatchRunStatus | "unknown"): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

function getRunEventTime(
  events: GroupRunEvent[],
  groupRunId: string,
  predicate: (event: GroupRunEvent) => boolean
): string | null {
  const matchingEvents = events
    .filter((event) => event.groupRunId === groupRunId && predicate(event))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  return matchingEvents[0]?.createdAt ?? null;
}

function formatElapsedDuration(startAt: string, endAt: string | null, nowMs: number): string {
  const startMs = new Date(startAt).getTime();
  const endMs = endAt ? new Date(endAt).getTime() : nowMs;

  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return "0s";
  }

  const totalSeconds = Math.max(0, Math.round((endMs - startMs) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) {
    return `${seconds}s`;
  }

  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export function GroupRunStepProcessPanel({
  events,
  groupRunId,
  workspaceId
}: {
  events: GroupRunEvent[];
  groupRunId: string;
  workspaceId: string | null;
}) {
  const run = useMemo(
    () => buildRuns(events).find((item) => item.groupRunId === groupRunId) ?? null,
    [events, groupRunId]
  );
  const runFinished = run ? isTerminalRunStatus(run.status) : false;
  const [collapsed, setCollapsed] = useState(runFinished);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    setCollapsed(runFinished);
  }, [groupRunId, runFinished]);

  useEffect(() => {
    if (runFinished) {
      return;
    }

    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [runFinished]);

  if (!run) {
    return null;
  }

  const completedAt = runFinished
    ? getRunEventTime(
        events,
        groupRunId,
        (event) =>
          event.type === "summary_completed" ||
          event.type === "agent_completed" ||
          event.type === "agent_failed"
      )
    : null;
  const elapsed = formatElapsedDuration(run.createdAt, completedAt, nowMs);
  const stepCount = run.steps.length;
  const summaryText = `已处理 ${elapsed} / ${stepCount} 个步骤`;
  const statusLabel = RUN_STATUS_LABELS[run.status] ?? run.status;

  return (
    <section
      className={`group-run-step-process group-run-step-process-${collapsed ? "collapsed" : "expanded"}`}
      aria-label="子 Agent step 过程"
    >
      <button
        aria-expanded={!collapsed}
        className="group-run-step-process-summary"
        onClick={() => setCollapsed((current) => !current)}
        type="button"
      >
        <span>{summaryText}</span>
        {!collapsed ? <small>{statusLabel}</small> : null}
      </button>

      {!collapsed ? (
        <div className="group-run-step-process-list">
          {run.steps.map((step) => {
            const working = isWorkingStep(step.status);

            return (
              <article
                className={`group-run-step-process-card group-run-step-process-card-${step.status}`}
                key={step.stepId}
              >
                <header>
                  <div>
                    <strong>
                      Step {step.stepIndex + 1}: {step.agentName}
                    </strong>
                    <small>{STEP_STATUS_LABELS[step.status] ?? step.status}</small>
                  </div>
                  {working ? <TypingDots /> : null}
                </header>
                <StepProgressList progress={step.progress} />
                {step.progress.length === 0 ? (
                  <p>{getStepNarrative(step)}</p>
                ) : null}
                {!working ? (
                  <StepActions
                    onOpenDetails={() => openInspector("Runtime")}
                    step={step}
                    workspaceId={workspaceId}
                  />
                ) : null}
              </article>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

function countSteps(run: RunView, predicate: (step: StepView) => boolean): number {
  return run.steps.filter(predicate).length;
}

function getRunProgressText(run: RunView): string {
  const total = run.steps.length;
  const completed = countSteps(
    run,
    (step) => step.status === "completed" || step.status === "partial"
  );
  const failed = countSteps(
    run,
    (step) =>
      step.status === "failed" ||
      step.status === "iteration_limit_reached" ||
      step.status === "cancelled"
  );

  if (total === 0) {
    return "等待生成分派计划";
  }

  if (run.status === "completed") {
    return `已完成 ${completed}/${total}`;
  }

  if (failed > 0) {
    return `已完成 ${completed}/${total}，失败 ${failed}`;
  }

  return `已完成 ${completed}/${total}`;
}

function formatRunCreatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return date.toLocaleString([], {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return "0s";
  }
  const totalSeconds = Math.round(milliseconds / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds > 0 ? `${minutes}分${seconds}s` : `${minutes}分`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0 ? `${hours}时${restMinutes}分` : `${hours}时`;
}

function getStepDurationMs(step: StepView, nowMs: number): number | null {
  if (!step.startedAt) {
    return null;
  }
  const startMs = new Date(step.startedAt).getTime();
  if (Number.isNaN(startMs)) {
    return null;
  }
  const endMs = step.finishedAt ? new Date(step.finishedAt).getTime() : nowMs;
  if (Number.isNaN(endMs) || endMs < startMs) {
    return null;
  }
  return endMs - startMs;
}

function formatStepTimer(step: StepView, nowMs: number): string {
  const ms = getStepDurationMs(step, nowMs);
  if (ms === null) {
    return "预计 --";
  }
  if (step.finishedAt) {
    return formatDuration(ms);
  }
  return `${formatDuration(ms)}`;
}

function isCompletedRun(run: RunView): boolean {
  return (
    run.status === "completed" ||
    run.status === "failed" ||
    run.status === "partial_failed" ||
    run.status === "partial" ||
    run.status === "cancelled"
  );
}

function estimateRemainingMs(run: RunView, nowMs: number): number {
  const finishedDurations: number[] = [];
  for (const step of run.steps) {
    if (step.status === "completed" || step.status === "partial") {
      const ms = getStepDurationMs(step, nowMs);
      if (ms !== null) {
        finishedDurations.push(ms);
      }
    }
  }
  const averageMs = finishedDurations.length > 0
    ? finishedDurations.reduce((sum, value) => sum + value, 0) / finishedDurations.length
    : 0;
  let remaining = 0;
  for (const step of run.steps) {
    if (step.status === "pending" || step.status === "queued") {
      remaining += averageMs > 0 ? averageMs : 0;
    } else if (
      step.status === "running" ||
      step.status === "streaming" ||
      step.status === "waiting_for_permission"
    ) {
      const elapsed = getStepDurationMs(step, nowMs) ?? 0;
      const estimate = averageMs > 0 ? Math.max(averageMs, elapsed) : elapsed;
      remaining += Math.max(0, estimate - elapsed);
    }
  }
  return remaining;
}

function formatLastUpdated(value: string | null): string {
  if (!value) {
    return "—";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
}

function getPanelStatusClass(run: RunView): string {
  if (run.status === "completed") {
    return "completed";
  }
  if (run.status === "failed" || run.status === "partial_failed" || run.status === "partial") {
    return "failed";
  }
  return "running";
}

function PanelSparkIcon() {
  return (
    <span className="group-run-plan-spark" aria-hidden="true">
      DAG
    </span>
  );
}

function getOutputTypeLabel(value: string | null): string {
  if (value === "diff_proposal") return "Diff";
  if (value === "test_plan") return "测试";
  if (value === "design") return "设计";
  if (value === "summary") return "总结";
  if (value === "analysis") return "分析";
  return "任务";
}

function getRiskLabel(value: string | null): string {
  if (value === "high") return "高风险";
  if (value === "medium") return "中风险";
  if (value === "low") return "低风险";
  return "未标记";
}

function DagEdgeLayer({ layout }: { layout: DagLayoutView }) {
  if (layout.edges.length === 0) {
    return null;
  }

  return (
    <svg
      aria-hidden="true"
      className="group-run-dag-edges"
      height={layout.height}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      width={layout.width}
    >
      <defs>
        <marker
          id="group-run-dag-arrow"
          markerHeight="8"
          markerUnits="userSpaceOnUse"
          markerWidth="8"
          orient="auto"
          refX="6"
          refY="4"
        >
          <path className="group-run-dag-arrow-head" d="M 0 0 L 8 4 L 0 8 z" />
        </marker>
        <marker
          id="group-run-dag-arrow-active"
          markerHeight="8"
          markerUnits="userSpaceOnUse"
          markerWidth="8"
          orient="auto"
          refX="6"
          refY="4"
        >
          <path className="group-run-dag-arrow-head group-run-dag-arrow-head-active" d="M 0 0 L 8 4 L 0 8 z" />
        </marker>
        <marker
          id="group-run-dag-arrow-failed"
          markerHeight="8"
          markerUnits="userSpaceOnUse"
          markerWidth="8"
          orient="auto"
          refX="6"
          refY="4"
        >
          <path className="group-run-dag-arrow-head group-run-dag-arrow-head-failed" d="M 0 0 L 8 4 L 0 8 z" />
        </marker>
      </defs>
      {layout.edges.map((edge) => {
        const dx = Math.max(36, Math.abs(edge.toX - edge.fromX) * 0.48);
        const d = [
          `M ${edge.fromX} ${edge.fromY}`,
          `C ${edge.fromX + dx} ${edge.fromY}`,
          `${edge.toX - dx} ${edge.toY}`,
          `${edge.toX} ${edge.toY}`
        ].join(" ");
        const marker = edge.failed
          ? "url(#group-run-dag-arrow-failed)"
          : edge.active
            ? "url(#group-run-dag-arrow-active)"
            : "url(#group-run-dag-arrow)";

        return (
          <path
            className={[
              "group-run-dag-edge",
              edge.active ? "group-run-dag-edge-active" : "",
              edge.failed ? "group-run-dag-edge-failed" : ""
            ].filter(Boolean).join(" ")}
            d={d}
            key={edge.id}
            markerEnd={marker}
          />
        );
      })}
    </svg>
  );
}

function DagNodeCard({
  node,
  nowMs
}: {
  node: DagNodeView;
  nowMs: number;
}) {
  const state = getDagNodeStatus(node);
  const title = node.taskTitle ?? node.agentName;
  const description = getOutputTypeLabel(node.expectedOutputType) || node.agentName;
  const status = STEP_STATUS_LABELS[node.status] ?? node.status;
  const timer = formatStepTimer(node, nowMs);
  const numberLabel = `${node.stepIndex + 1}.`;
  const tone = getNodeTone(node);

  return (
    <article
      aria-label={`${title}: ${status}`}
      className={[
        "group-run-dag-node",
        `group-run-dag-node-${state}`,
        `group-run-dag-node-tone-${tone}`,
        `group-run-dag-node-status-${node.status}`
      ].join(" ")}
      style={{
        height: DAG_NODE_HEIGHT,
        left: node.x,
        top: node.y,
        width: DAG_NODE_WIDTH
      }}
    >
      <span className="group-run-dag-node-icon" aria-hidden="true">
        {getAgentInitial(title)}
      </span>
      <div className="group-run-dag-node-body">
        <div className="group-run-dag-node-title">
          <strong>{numberLabel} {title}</strong>
          <small>{description}</small>
        </div>
        <div className="group-run-dag-node-meta">
          <span>第 {node.stepIndex + 1} 步</span>
          <span className="group-run-dag-node-meta-sep">|</span>
          <span>{timer}</span>
        </div>
        <div className={`group-run-dag-node-status group-run-dag-node-status-pill group-run-dag-node-status-${state}`}>
          <span className="group-run-dag-node-status-dot" />
          {status}
          {isWorkingStep(node.status) ? <TypingDots /> : null}
        </div>
      </div>
    </article>
  );
}

function getNodeTone(node: DagNodeView): "primary" | "blue" | "purple" | "amber" {
  if (isFailedStep(node.status)) {
    return "amber";
  }
  if (isCompletedStep(node.status)) {
    return "blue";
  }
  if (isCurrentDagStep(node.status)) {
    return "primary";
  }
  return "purple";
}

export function GroupRunPlanPanel({
  events
}: {
  events: GroupRunEvent[];
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const runs = useMemo(() => buildRuns(events, { collapseRetries: false }), [events]);
  const run = runs[0] ?? null;

  useEffect(() => {
    if (!run || isCompletedRun(run)) {
      return;
    }
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [run]);

  if (!run) {
    return null;
  }

  const statusClass = getPanelStatusClass(run);
  const statusLabel = RUN_STATUS_LABELS[run.status] ?? run.status;
  const createdAt = formatRunCreatedAt(run.createdAt);
  const activeSteps = getActiveSteps(run);
  const dagLayout = buildDagLayout(run.steps);
  const completedCount = countSteps(
    run,
    (step) => step.status === "completed" || step.status === "partial"
  );
  const totalCount = run.steps.length;
  const currentStepTitle = activeSteps[0]?.taskTitle ?? activeSteps[0]?.agentName ?? null;
  const currentLabel = activeSteps.length > 0
    ? activeSteps.map((step) => step.taskTitle ?? step.agentName).join(" / ")
    : run.status === "reviewing"
      ? "主 Agent 汇总"
      : run.status === "completed"
        ? "全部完成"
        : "等待调度";
  const remainingCount = Math.max(0, totalCount - completedCount);
  const remainingMs = estimateRemainingMs(run, nowMs);
  const queueCount = countSteps(
    run,
    (step) => step.status === "pending" || step.status === "queued"
  );
  const lastUpdatedLabel = formatLastUpdated(run.lastEventAt);
  const metaItems: { key: string; label: string; value: string }[] = [
    { key: "current", label: "当前节点", value: currentLabel },
    { key: "columns", label: "拓扑层", value: String(dagLayout.columns) },
    { key: "edges", label: "依赖边", value: String(dagLayout.edges.length) },
    { key: "progress", label: "进度", value: getRunProgressText(run) }
  ];

  if (collapsed) {
    return (
      <section className="group-run-plan-top group-run-plan-top-collapsed" aria-label="自动分派计划">
        <div className="group-run-plan-strip">
          <div className="group-run-plan-strip-main">
            <PanelSparkIcon />
            <strong>{getModeLabel(run.mode)}计划</strong>
            <span className={`group-run-plan-status group-run-plan-status-${statusClass}`}>
              {statusLabel}
            </span>
            <small>{getRunProgressText(run)}</small>
            <small>当前: {currentLabel}</small>
          </div>
          <button
            aria-label="展开分派计划"
            className="group-run-plan-edge-button group-run-plan-edge-button-down"
            onClick={() => setCollapsed(false)}
            type="button"
          >
            ˅
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="group-run-plan-top group-run-plan-top-expanded" aria-label="自动分派计划">
      <header className="group-run-plan-top-header">
        <div className="group-run-plan-title">
          <PanelSparkIcon />
          <div>
            <strong>{getModeLabel(run.mode)}计划</strong>
            <small>Run {run.groupRunId.slice(0, 8)}</small>
          </div>
        </div>
        <div className="group-run-plan-meta" aria-label="DAG 调度状态">
          {metaItems.map((item) => (
            <div key={item.key}>
              <span>{item.label}</span>
              <strong>{item.value}</strong>
            </div>
          ))}
        </div>
        <span className={`group-run-plan-status group-run-plan-status-${statusClass}`}>
          {statusLabel}
        </span>
      </header>

      <div className="group-run-plan-body">
        <div className="group-run-dag-scroller" aria-label="DAG 任务调度图">
          <div
            className="group-run-dag-canvas"
            style={{
              height: dagLayout.height,
              width: dagLayout.width
            }}
          >
            <DagEdgeLayer layout={dagLayout} />
            {dagLayout.nodes.map((node) => (
              <DagNodeCard key={node.nodeId} node={node} nowMs={nowMs} />
            ))}
          </div>
        </div>
        <aside className="group-run-plan-side" aria-label="DAG 实时信息">
          <div>
            <span>依赖关系</span>
            <strong>{dagLayout.edges.length} 条</strong>
          </div>
          <div>
            <span>运行队列</span>
            <strong>{queueCount}</strong>
          </div>
          <div>
            <span>最后更新</span>
            <strong>{lastUpdatedLabel}</strong>
          </div>
          <div>
            <span>当前步骤</span>
            <strong>{currentStepTitle ?? "—"}</strong>
          </div>
          <div>
            <span>预计剩余</span>
            <strong>{formatDuration(remainingMs)}</strong>
          </div>
          <div>
            <span>剩余节点</span>
            <strong>{remainingCount} 个</strong>
          </div>
          <div>
            <span>创建时间</span>
            <strong>{createdAt || "—"}</strong>
          </div>
        </aside>
      </div>

      <footer className="group-run-plan-top-footer">
        <div className="group-run-plan-legend" aria-label="DAG 状态图例">
          <span className="group-run-plan-legend-item">
            <span className="group-run-plan-legend-dot group-run-plan-legend-dot-done" />
            已完成
          </span>
          <span className="group-run-plan-legend-item">
            <span className="group-run-plan-legend-dot group-run-plan-legend-dot-active" />
            进行中
          </span>
          <span className="group-run-plan-legend-item">
            <span className="group-run-plan-legend-dot group-run-plan-legend-dot-waiting" />
            等待中
          </span>
          <span className="group-run-plan-legend-item">
            <span className="group-run-plan-legend-line group-run-plan-legend-line-done" />
            已完成依赖
          </span>
          <span className="group-run-plan-legend-item">
            <span className="group-run-plan-legend-line group-run-plan-legend-line-waiting" />
            等待依赖
          </span>
        </div>
        <span className="group-run-plan-footer-meta">{run.steps.length} 个节点</span>
      </footer>

      <button
        aria-label="收纳分派计划"
        className="group-run-plan-edge-button group-run-plan-edge-button-up"
        onClick={() => setCollapsed(true)}
        type="button"
      >
        ˆ
      </button>
    </section>
  );
}
