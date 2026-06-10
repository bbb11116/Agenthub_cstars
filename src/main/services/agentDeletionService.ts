import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  DeleteAgentInput,
  DeleteAgentResult
} from "../../shared/domain";
import { getDatabase, type AgentHubDatabase } from "../db";
import { getAgentById, updateAgent } from "../db/repositories/agentRepo";
import {
  deleteWorkspaceContext,
  getWorkspaceContextById
} from "../db/repositories/workspaceContextRepo";

export class AgentDeletionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentDeletionError";
  }
}

type WorkspaceTrashResult = Pick<
  DeleteAgentResult,
  "trashedWorkspaceDirectory" | "warning"
>;

function normalizeAgentId(agentId: unknown): string {
  if (typeof agentId !== "string" || agentId.trim().length === 0) {
    throw new AgentDeletionError("agentId is required.");
  }

  return agentId.trim();
}

function isInsideDirectory(parentPath: string, candidatePath: string): boolean {
  const relativePath = path.relative(parentPath, candidatePath);
  return (
    relativePath.length > 0 &&
    !relativePath.startsWith(`..${path.sep}`) &&
    relativePath !== ".." &&
    !path.isAbsolute(relativePath)
  );
}

export function moveDefaultAgentWorkspaceToTrash(
  agentId: string,
  rootPath: string
): WorkspaceTrashResult {
  const resolvedRootPath = path.resolve(rootPath);
  const agentsRoot = path.resolve(os.homedir(), "Documents", "AgentHub", "agents");

  if (
    !isInsideDirectory(agentsRoot, resolvedRootPath) ||
    !path.basename(resolvedRootPath).includes(agentId)
  ) {
    return {
      warning: `Agent 已删除，但默认目录未自动清理，因为它不是系统创建的安全目录：${rootPath}`
    };
  }

  if (!fs.existsSync(resolvedRootPath)) {
    return {};
  }

  const trashRoot = path.join(os.homedir(), "Documents", "AgentHub", ".trash", "agents");
  const trashPath = path.join(trashRoot, `${agentId}-${Date.now()}`);

  try {
    fs.mkdirSync(trashRoot, { recursive: true });
    fs.renameSync(resolvedRootPath, trashPath);
    return {
      trashedWorkspaceDirectory: trashPath
    };
  } catch {
    return {
      warning: `Agent 已删除，但默认目录删除失败，需要用户手动清理：${rootPath}`
    };
  }
}

export function deleteSubAgent(
  input: DeleteAgentInput,
  db: AgentHubDatabase = getDatabase()
): DeleteAgentResult {
  if (!input || typeof input !== "object") {
    throw new AgentDeletionError("Agent deletion input is required.");
  }

  if (input.preserveGroupHistory === false) {
    throw new AgentDeletionError("Group history must be preserved.");
  }

  const agentId = normalizeAgentId(input.agentId);
  const agent = getAgentById(agentId, db);
  if (!agent) {
    throw new AgentDeletionError("Agent not found.");
  }

  if (agent.role === "main" || agent.type === "orchestrator") {
    throw new AgentDeletionError("Main agent cannot be deleted.");
  }

  if (agent.role !== "sub" || agent.type !== "specialist") {
    throw new AgentDeletionError("Only sub agents can be deleted.");
  }

  if (agent.status === "running") {
    throw new AgentDeletionError("Agent is currently running. Wait for it to finish before deleting.");
  }

  if (agent.status === "deleted") {
    throw new AgentDeletionError("Agent has already been deleted.");
  }

  const workspaceContext = agent.defaultWorkspaceContextId
    ? getWorkspaceContextById(agent.defaultWorkspaceContextId, db)
    : null;
  const deleteAgentData = db.transaction(() => {
    const directConversations = db
      .prepare<[string], { id: string }>(
        "SELECT id FROM conversations WHERE agent_id = ? AND type = 'direct'"
      )
      .all(agentId);
    const deletedConversationIds = directConversations.map((conversation) => conversation.id);
    const finishedAt = new Date().toISOString();

    db.prepare("DELETE FROM conversation_provider_sessions WHERE agent_id = ?").run(agentId);
    db.prepare("DELETE FROM conversation_provider_sessions_v2 WHERE agent_id = ?").run(agentId);
    db.prepare("DELETE FROM agent_runs WHERE agent_id = ?").run(agentId);
    db.prepare("DELETE FROM agent_project_experiences WHERE agent_id = ?").run(agentId);
    db.prepare(
      "DELETE FROM conversation_members WHERE member_type = 'agent' AND member_id = ?"
    ).run(agentId);
    db.prepare(
      `UPDATE dispatch_steps
       SET status = 'cancelled',
           error_message = 'Agent deleted.',
           finished_at = COALESCE(finished_at, @finishedAt)
       WHERE agent_id = @agentId
         AND status IN ('queued', 'running', 'pending', 'streaming')`
    ).run({ agentId, finishedAt });
    db.prepare("DELETE FROM conversations WHERE agent_id = ? AND type = 'direct'").run(agentId);

    if (
      workspaceContext &&
      workspaceContext.ownerType === "agent" &&
      workspaceContext.ownerId === agentId
    ) {
      deleteWorkspaceContext(workspaceContext.id, db);
    }

    const tombstone = updateAgent(
      agentId,
      {
        defaultWorkspaceContextId: undefined,
        avatar: undefined,
        name: "已删除 Agent",
        description: "",
        systemPrompt: "",
        capabilities: [],
        tools: {
          readFile: false,
          writeDiff: false,
          applyDiff: false,
          previewArtifact: false,
          gitStatus: false
        },
        fileScope: [],
        claudeCodeConfig: undefined,
        modelProviderId: undefined,
        model: undefined,
        status: "deleted"
      },
      db
    );
    if (!tombstone) {
      throw new AgentDeletionError("Unable to preserve the deleted Agent tombstone.");
    }

    return {
      agentId,
      deletedConversationIds
    };
  });
  const result = deleteAgentData();

  if (input.deleteDefaultWorkspaceDirectory === false || !workspaceContext) {
    return result;
  }

  return {
    ...result,
    ...moveDefaultAgentWorkspaceToTrash(agentId, workspaceContext.rootPath)
  };
}
