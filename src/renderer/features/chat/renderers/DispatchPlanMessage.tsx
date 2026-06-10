import type { Message } from "../../../../shared/domain";
import { TextMessage } from "./TextMessage";

type AssignmentView = {
  agentId: string;
  agentName: string;
  instruction: string;
  status: string;
  targetCriteria: string[];
  finalScore?: number;
  capabilityMatch?: number;
  matchedSkills: string[];
  reason?: string;
  dependsOn: string[];
  targetFiles: string[];
  taskTitle?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getTextContent(content: unknown): string {
  return isRecord(content) && typeof content.text === "string" ? content.text : "";
}

function getAgentName(
  agentId: string,
  agentNames: Record<string, unknown> | undefined
): string {
  const name = agentNames?.[agentId];
  return typeof name === "string" && name.trim() ? name : agentId;
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readScore(value: unknown): {
  finalScore?: number;
  capabilityMatch?: number;
  matchedSkills: string[];
} {
  if (!isRecord(value)) {
    return { matchedSkills: [] };
  }
  const rawSkills = Array.isArray(value.matchedSkills) ? value.matchedSkills : [];
  return {
    finalScore: readNumber(value.finalScore),
    capabilityMatch: readNumber(value.capabilityMatch),
    matchedSkills: rawSkills
      .filter(isRecord)
      .map((skill) => (typeof skill.skillName === "string" ? skill.skillName : ""))
      .filter(Boolean)
  };
}

function getAssignments(metadata: Record<string, unknown> | null | undefined): AssignmentView[] {
  if (!metadata) {
    return [];
  }

  const agentNames = isRecord(metadata.agentNames) ? metadata.agentNames : undefined;
  const rawAssignments = Array.isArray(metadata.assignments) ? metadata.assignments : [];
  const assignments = rawAssignments
    .filter(isRecord)
    .map((assignment, index): AssignmentView | null => {
      const agentId = typeof assignment.agentId === "string" ? assignment.agentId : "";
      const instruction =
        typeof assignment.instruction === "string" ? assignment.instruction : "";
      if (!agentId || !instruction) {
        return null;
      }

      return {
        agentId,
        agentName: getAgentName(agentId, agentNames),
        instruction,
        status: typeof assignment.status === "string" ? assignment.status : "pending",
        targetCriteria: toStringArray(assignment.targetCriteria),
        ...readScore(assignment.score),
        reason: typeof assignment.reason === "string" ? assignment.reason : undefined,
        dependsOn: toStringArray(assignment.dependsOn),
        targetFiles: isRecord(assignment.subTask)
          ? toStringArray(assignment.subTask.targetFiles)
          : toStringArray(assignment.targetFiles),
        taskTitle: isRecord(assignment.subTask) && typeof assignment.subTask.title === "string"
          ? assignment.subTask.title
          : typeof assignment.taskTitle === "string"
            ? assignment.taskTitle
            : undefined
      };
    })
    .filter((assignment): assignment is AssignmentView => assignment !== null);

  if (assignments.length > 0) {
    return assignments;
  }

  const plan = isRecord(metadata.plan) ? metadata.plan : null;
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  return steps
    .filter(isRecord)
    .map((step): AssignmentView | null => {
      const agentId = typeof step.agent_id === "string" ? step.agent_id : "";
      const instruction = typeof step.instruction === "string" ? step.instruction : "";
      if (!agentId || !instruction) {
        return null;
      }

      return {
        agentId,
        agentName: getAgentName(agentId, agentNames),
        instruction,
        status: typeof step.status === "string" ? step.status : "pending",
        targetCriteria: toStringArray(step.targetCriteria),
        ...readScore(step.score),
        reason: typeof step.reason === "string" ? step.reason : undefined,
        dependsOn: toStringArray(step.dependsOn),
        targetFiles: toStringArray(step.targetFiles),
        taskTitle: typeof step.taskTitle === "string" ? step.taskTitle : undefined
      };
    })
    .filter((assignment): assignment is AssignmentView => assignment !== null);
}

export function DispatchPlanMessage({ message }: { message: Message }) {
  const assignments = getAssignments(message.metadata);
  const fallbackText = getTextContent(message.content);

  if (assignments.length === 0) {
    return <TextMessage content={{ text: fallbackText }} />;
  }

  const roundIndex =
    message.metadata && typeof message.metadata.roundIndex === "number"
      ? message.metadata.roundIndex + 1
      : null;

  return (
    <article className="structured-message-card dispatch-plan-message">
      <header className="structured-message-header">
        <div>
          <span>分派计划</span>
          {roundIndex ? <small>第 {roundIndex} 轮</small> : null}
        </div>
        <strong>{assignments.length} 步</strong>
      </header>
      <div className="structured-message-list">
        {assignments.map((assignment, index) => (
          <section
            className="structured-message-item"
            key={`${assignment.agentId}-${index}`}
          >
            <div className="structured-message-item-header">
              <strong>{assignment.taskTitle ?? assignment.agentName}</strong>
              <span>{assignment.status}</span>
            </div>
            {assignment.taskTitle ? <small>Agent: {assignment.agentName}</small> : null}
            <p>{assignment.instruction}</p>
            {assignment.finalScore !== undefined ? (
              <small>
                Score: {assignment.finalScore.toFixed(2)}
                {assignment.capabilityMatch !== undefined
                  ? ` · 能力匹配: ${assignment.capabilityMatch.toFixed(2)}`
                  : ""}
              </small>
            ) : null}
            {assignment.matchedSkills.length > 0 ? (
              <small>匹配 Skill: {assignment.matchedSkills.join(", ")}</small>
            ) : null}
            {assignment.reason ? <small>选择理由: {assignment.reason}</small> : null}
            {assignment.targetCriteria.length > 0 ? (
              <small>验收项: {assignment.targetCriteria.join(", ")}</small>
            ) : null}
            {assignment.dependsOn.length > 0 ? (
              <small>依赖: {assignment.dependsOn.join(", ")}</small>
            ) : null}
            {assignment.targetFiles.length > 0 ? (
              <small>目标文件: {assignment.targetFiles.join(", ")}</small>
            ) : null}
          </section>
        ))}
      </div>
    </article>
  );
}
