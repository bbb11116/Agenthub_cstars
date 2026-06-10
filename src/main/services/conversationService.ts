import type { Agent, Conversation, Message, Workspace } from "../../shared/domain";
import { RUNTIME_PROVIDER_LABELS } from "../../shared/runtime";
import { getDatabase, type AgentHubDatabase } from "../db";
import { getAgentById } from "../db/repositories/agentRepo";
import {
  createConversation,
  deleteConversation,
  getChats,
  getConversationById,
  getConversationsByAgent,
  getDirectConversationByAgent
} from "../db/repositories/conversationRepo";
import {
  createMessage as insertMessage,
  getMessageCountByConversation,
  getMessagesByConversation,
  updateMessageContent
} from "../db/repositories/messageRepo";

export const DEFAULT_MAIN_CONVERSATION_TITLE = "Default Chat";
export const MAIN_AGENT_CREATION_GUIDE_TEXT =
  "我是当前 Workspace 的主 Agent。请点击左上角加号手动创建子 Agent。";

export function buildMainAgentCreationGuideText(workspace: Workspace, agent: Agent): string {
  const runtimeLabel = RUNTIME_PROVIDER_LABELS[agent.runtimeProvider] ?? agent.runtimeProvider;

  return [
    `当前 Main Agent 已绑定 Runtime：${runtimeLabel} (${agent.runtimeProvider})。`,
    `当前 Workspace 路径：${workspace.rootPath}`,
    "创建子 Agent 请点击左上角加号，在 Add Sub Agent 表单中填写 Provider 和名称；描述可选。",
    "涉及代码修改时，Agent 必须生成 DiffProposal 或明确说明无需修改；用户确认后才会应用。"
  ].join("\n");
}

export function ensureMainAgentGuideMessage(
  workspace: Workspace,
  agent: Agent,
  conversation: Conversation,
  db: AgentHubDatabase = getDatabase()
): Message | null {
  if (agent.role !== "main") {
    return null;
  }

  const content = {
    text: buildMainAgentCreationGuideText(workspace, agent)
  };
  const existingGuide = getMessagesByConversation(conversation.id, db).find(
    (message) => message.senderType === "system" && message.senderId === "main-agent-guide"
  );

  if (existingGuide) {
    const existingText =
      typeof existingGuide.content === "object" &&
      existingGuide.content !== null &&
      "text" in existingGuide.content
        ? String(existingGuide.content.text)
        : "";

    if (existingText !== content.text) {
      updateMessageContent(existingGuide.id, content, db);
    }

    return {
      ...existingGuide,
      content
    };
  }

  if (getMessageCountByConversation(conversation.id, db) > 0) {
    return null;
  }

  return insertMessage(
    {
      workspaceId: workspace.id,
      conversationId: conversation.id,
      senderType: "system",
      senderId: "main-agent-guide",
      messageType: "text",
      content
    },
    db
  );
}

export function getDefaultConversationForAgent(
  agent: Agent,
  db: AgentHubDatabase = getDatabase()
): Conversation | null {
  return (
    getConversationsByAgent(agent.id, db).find(
      (conversation) => conversation.title === DEFAULT_MAIN_CONVERSATION_TITLE
    ) ?? null
  );
}

export function createDefaultConversationForAgent(
  agent: Agent,
  db: AgentHubDatabase = getDatabase()
): Conversation {
  const existingDefaultConversation = getDefaultConversationForAgent(agent, db);

  if (existingDefaultConversation) {
    return existingDefaultConversation;
  }

  return createConversation(
    {
      workspaceId: agent.workspaceId,
      workspaceContextId: agent.defaultWorkspaceContextId ?? null,
      agentId: agent.id,
      title: DEFAULT_MAIN_CONVERSATION_TITLE,
      mode: "single"
    },
    db
  );
}

export function listConversationsByAgent(
  agentId: string,
  db: AgentHubDatabase = getDatabase()
): Conversation[] {
  return getConversationsByAgent(agentId, db);
}

export function ensureDirectConversationForAgent(
  agent: Agent,
  db: AgentHubDatabase = getDatabase()
): Conversation {
  return getDirectConversationByAgent(agent.id, db) ?? createDefaultConversationForAgent(agent, db);
}

export function listChats(db: AgentHubDatabase = getDatabase()): Conversation[] {
  return getChats(db);
}

export function findOrCreateDirectConversationForAgent(
  agentId: string,
  db: AgentHubDatabase = getDatabase()
): Conversation {
  const agent = getAgentById(agentId, db);
  if (!agent) {
    throw new Error("Agent not found.");
  }
  return ensureDirectConversationForAgent(agent, db);
}

export function createDirectConversationForAgent(
  agentId: string,
  db: AgentHubDatabase = getDatabase()
): Conversation {
  const agent = getAgentById(agentId, db);
  if (!agent) {
    throw new Error("Agent not found.");
  }
  return createConversation(
    {
      workspaceId: agent.workspaceId,
      workspaceContextId: agent.defaultWorkspaceContextId ?? null,
      agentId: agent.id,
      title: "新对话",
      mode: "single"
    },
    db
  );
}

export function deleteDirectConversation(
  conversationId: string,
  db: AgentHubDatabase = getDatabase()
): boolean {
  const conversation = getConversationById(conversationId, db);
  if (!conversation || conversation.type !== "direct") {
    throw new Error("Direct conversation not found.");
  }
  return deleteConversation(conversationId, db);
}
