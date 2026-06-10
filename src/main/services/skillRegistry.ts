import type { Agent, Message, Workspace } from "../../shared/domain";
import type { AgentHubDatabase } from "../db";
import { getAgentsByWorkspace } from "../db/repositories/agentRepo";

export type SkillContext = {
  workspace: Workspace;
  agent: Agent;
  conversationId: string;
  db: AgentHubDatabase;
};

export type SkillResult = {
  ok: boolean;
  data?: unknown;
  error?: string;
  messages?: Message[];
};

export type Skill = {
  name: string;
  description: string;
  execute: (context: SkillContext, args: Record<string, unknown>) => Promise<SkillResult>;
};

const listAgentsSkill: Skill = {
  name: "list_agents",
  description: "List all agents in the current workspace. Returns agent id, name, type, provider, and status.",
  execute: async (context) => {
    const agents = getAgentsByWorkspace(context.workspace.id, context.db);
    return {
      ok: true,
      data: agents.map((a) => ({
        id: a.id,
        name: a.name,
        type: a.type,
        provider: a.runtimeProvider,
        status: a.status
      }))
    };
  }
};

const SKILLS: Skill[] = [listAgentsSkill];

export function getSkill(name: string): Skill | undefined {
  return SKILLS.find((s) => s.name === name);
}

export function listSkills(): Array<{ name: string; description: string }> {
  return SKILLS.map((s) => ({ name: s.name, description: s.description }));
}
