import { useEffect, useMemo, useState } from "react";
import type { AgentRunEvent } from "../../../shared/agentRunEvent";

type AgentRunStepStatus = "running" | "completed" | "failed" | "cancelled";

type AgentRunProgressItem = {
  id: string;
  title: string;
  body: string | null;
  level: "info" | "warning" | "error";
  createdAt: string;
  seq: number;
};

type AgentRunStepView = {
  id: string;
  title: string;
  status: AgentRunStepStatus;
  progress: AgentRunProgressItem[];
};

type AgentRunView = {
  runId: string;
  status: AgentRunStepStatus;
  createdAt: string;
  completedAt: string | null;
  steps: AgentRunStepView[];
};

const STEP_STATUS_LABELS: Record<AgentRunStepStatus, string> = {
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消"
};

function compactText(value: string | null | undefined, maxLength = 160): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function sortEvents(events: AgentRunEvent[]): AgentRunEvent[] {
  return [...events].sort((left, right) => {
    if (left.runId !== right.runId) {
      return left.createdAt.localeCompare(right.createdAt);
    }
    return left.seq - right.seq;
  });
}

function getOrCreateStep(
  steps: Map<string, AgentRunStepView>,
  id: string,
  title: string,
  status: AgentRunStepStatus = "running"
): AgentRunStepView {
  const existing = steps.get(id);
  if (existing) {
    return existing;
  }

  const step: AgentRunStepView = {
    id,
    title,
    status,
    progress: []
  };
  steps.set(id, step);
  return step;
}

function appendProgress(
  step: AgentRunStepView,
  event: AgentRunEvent,
  title: string,
  body: string | null = null,
  level: AgentRunProgressItem["level"] = "info"
): void {
  if (step.progress.some((item) => item.id === event.id)) {
    return;
  }

  step.progress.push({
    id: event.id,
    title,
    body,
    level,
    createdAt: event.createdAt,
    seq: event.seq
  });
}

function finishRunningSteps(
  steps: Map<string, AgentRunStepView>,
  status: AgentRunStepStatus
): void {
  for (const step of steps.values()) {
    if (step.status === "running") {
      step.status = status;
    }
  }
}

function buildAgentRunView(events: AgentRunEvent[], runId: string): AgentRunView | null {
  const runEvents = sortEvents(events).filter((event) => event.runId === runId);
  if (runEvents.length === 0) {
    return null;
  }

  const steps = new Map<string, AgentRunStepView>();
  let runStatus: AgentRunStepStatus = "running";
  let completedAt: string | null = null;
  let sawMessageDelta = false;

  for (const event of runEvents) {
    switch (event.type) {
      case "run.started": {
        const step = getOrCreateStep(steps, "context", "准备上下文");
        appendProgress(step, event, "正在准备运行上下文");
        break;
      }
      case "message.started": {
        const step = getOrCreateStep(steps, "message", "生成回复");
        appendProgress(step, event, "正在创建回复");
        break;
      }
      case "message.delta": {
        const step = getOrCreateStep(steps, "message", "生成回复");
        if (!sawMessageDelta && event.payload.delta.trim()) {
          appendProgress(step, event, "正在生成回复");
          sawMessageDelta = true;
        }
        break;
      }
      case "message.completed": {
        const step = getOrCreateStep(steps, "message", "生成回复");
        step.status = "completed";
        appendProgress(step, event, "回复生成完成");
        break;
      }
      case "tool.call.started": {
        const step = getOrCreateStep(
          steps,
          `tool-${event.payload.toolCallId}`,
          `调用工具: ${event.payload.name}`
        );
        appendProgress(step, event, "正在调用工具", compactText(event.payload.name));
        break;
      }
      case "tool.call.completed": {
        const step = getOrCreateStep(
          steps,
          `tool-${event.payload.toolCallId}`,
          `调用工具: ${event.payload.name}`
        );
        step.status = event.payload.ok ? "completed" : "failed";
        appendProgress(
          step,
          event,
          event.payload.ok ? "工具调用完成" : "工具调用失败",
          compactText(event.payload.name),
          event.payload.ok ? "info" : "error"
        );
        break;
      }
      case "tool.result": {
        const step = getOrCreateStep(
          steps,
          `tool-${event.payload.toolCallId}`,
          `处理工具结果: ${event.payload.name}`
        );
        step.status = event.payload.ok ? "completed" : "failed";
        appendProgress(
          step,
          event,
          event.payload.ok ? "收到工具结果" : "工具结果失败",
          compactText(event.payload.errorMessage ?? event.payload.name),
          event.payload.ok ? "info" : "error"
        );
        break;
      }
      case "command.result": {
        const step = getOrCreateStep(
          steps,
          `command-${event.id}`,
          "执行命令",
          event.payload.exitCode === 0 ? "completed" : "failed"
        );
        appendProgress(
          step,
          event,
          event.payload.exitCode === 0 ? "命令执行完成" : "命令执行失败",
          compactText(event.payload.command),
          event.payload.exitCode === 0 ? "info" : "error"
        );
        break;
      }
      case "file.reference": {
        const step = getOrCreateStep(steps, `file-${event.id}`, "引用文件", "completed");
        appendProgress(step, event, "已引用文件", compactText(event.payload.path));
        break;
      }
      case "diff.proposal": {
        const step = getOrCreateStep(steps, `diff-${event.payload.proposalId}`, "生成 Diff");
        step.status = "completed";
        appendProgress(
          step,
          event,
          "已生成 Diff",
          `${event.payload.files.length} 个文件`
        );
        break;
      }
      case "run.completed":
        runStatus = event.payload.status === "cancelled" ? "cancelled" : "completed";
        completedAt = event.createdAt;
        finishRunningSteps(steps, runStatus);
        break;
      case "run.failed": {
        runStatus = "failed";
        completedAt = event.createdAt;
        finishRunningSteps(steps, "failed");
        const step = getOrCreateStep(steps, "failure", "执行失败", "failed");
        appendProgress(step, event, "执行失败", compactText(event.payload.message), "error");
        break;
      }
    }
  }

  if (steps.size === 0) {
    const step = getOrCreateStep(steps, "run", "执行任务", runStatus);
    appendProgress(step, runEvents[0], "正在执行任务");
  }

  const contextStep = steps.get("context");
  if (contextStep?.status === "running" && steps.size > 1) {
    contextStep.status = "completed";
  }

  return {
    runId,
    status: runStatus,
    createdAt: runEvents[0].createdAt,
    completedAt,
    steps: [...steps.values()]
  };
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

function TypingDots() {
  return (
    <span className="agent-run-typing" aria-label="正在工作">
      <span />
      <span />
      <span />
    </span>
  );
}

function StepProgressList({ progress }: { progress: AgentRunProgressItem[] }) {
  if (progress.length === 0) {
    return null;
  }

  return (
    <ol className="agent-run-progress">
      {progress.map((item) => (
        <li className={`agent-run-progress-item agent-run-progress-item-${item.level}`} key={item.id}>
          <span className="agent-run-progress-marker" aria-hidden="true" />
          <div>
            <strong>{item.title}</strong>
            {item.body ? <small>{item.body}</small> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function AgentRunStepProcessPanel({
  agentName,
  events,
  runId
}: {
  agentName?: string;
  events: AgentRunEvent[];
  runId: string;
}) {
  const run = useMemo(() => buildAgentRunView(events, runId), [events, runId]);
  const runFinished = run ? run.status !== "running" : false;
  const [collapsed, setCollapsed] = useState(runFinished);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    setCollapsed(runFinished);
  }, [runId, runFinished]);

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

  const elapsed = formatElapsedDuration(run.createdAt, run.completedAt, nowMs);
  const summaryText = `已处理 ${elapsed} / ${run.steps.length} 个步骤`;
  const statusLabel = STEP_STATUS_LABELS[run.status];

  return (
    <section
      aria-label="Agent step 过程"
      className={`agent-run-step-process agent-run-step-process-${collapsed ? "collapsed" : "expanded"}`}
    >
      <button
        aria-expanded={!collapsed}
        className="agent-run-step-process-summary"
        onClick={() => setCollapsed((current) => !current)}
        type="button"
      >
        <span>{summaryText}</span>
        {!collapsed ? <small>{agentName ? `${agentName} ${statusLabel}` : statusLabel}</small> : null}
      </button>

      {!collapsed ? (
        <div className="agent-run-step-process-list">
          {run.steps.map((step, index) => (
            <article
              className={`agent-run-step-process-card agent-run-step-process-card-${step.status}`}
              key={step.id}
            >
              <header>
                <div>
                  <strong>
                    Step {index + 1}: {step.title}
                  </strong>
                  <small>{STEP_STATUS_LABELS[step.status]}</small>
                </div>
                {step.status === "running" ? <TypingDots /> : null}
              </header>
              <StepProgressList progress={step.progress} />
            </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}
