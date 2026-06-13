import { useSyncExternalStore } from "react";
import type {
  Agent,
  Conversation,
  ConversationMember,
  CreateSubAgentManuallyInput,
  CreateSubAgentManuallyOutput,
  DeleteAgentInput,
  DeleteAgentResult,
  DispatchRun,
  DispatchStep,
  GroupMemberWithAgent,
  RuntimeProvider,
  RuntimeStatus,
  Workspace,
  WorkspaceContext
} from "../../shared/domain";
import type { AgentHubApi, WorkspaceTreeDTO } from "../../shared/types";
import type { AddGroupMembersResult } from "../../shared/groupChat";
import type { ChatMessage } from "../features/chat/MessageList";

export type WorkspaceStatus = "loading" | "empty" | "ready" | "error";

export type AppView = "loading" | "onboarding" | "settings" | "main";
export type HubNavigationSection = "chats" | "contacts" | "skills";

export type MainView =
  | { type: "chat"; conversationId: string }
  | { type: "agentProfile"; agentId: string }
  | { type: "groupProfile"; conversationId: string }
  | { type: "skillsLibrary" }
  | { type: "contactsHome" }
  | { type: "settings" };

export type WorkspaceCreateDraft = {
  rootPath: string;
  inferredWorkspaceName: string;
  gitEnabled: boolean;
  runtimeStatuses: RuntimeStatus[];
  selectedMainAgentRuntimeProvider: RuntimeProvider | null;
  existingWorkspace?: Workspace;
};

export type ActiveNavigationState = {
  activeWorkspaceId: string | null;
  activeAgentId: string | null;
  activeConversationId: string | null;
};

export type WorkspaceStoreState = ActiveNavigationState & {
  appView: AppView;
  workspaces: Workspace[];
  navigationTree: WorkspaceTreeDTO[];
  status: WorkspaceStatus;
  error: string | null;
  isOpening: boolean;
  isCreatingWorkspace: boolean;
  initialized: boolean;
  agentsByWorkspace: Record<string, Agent[]>;
  conversationsByAgent: Record<string, Conversation[]>;
  agentTreeStatus: WorkspaceStatus;
  agentTreeError: string | null;
  workspaceCreateDraft: WorkspaceCreateDraft | null;
  messagesByConversationId: Record<string, ChatMessage[]>;
  isSendingByConversationId: Record<string, boolean>;
  activeRunIdByConversationId: Record<string, string>;
  groupConversationsByWorkspace: Record<string, Conversation[]>;
  membersByGroupConversation: Record<string, GroupMemberWithAgent[]>;
  dispatchRunsByConversation: Record<string, DispatchRun[]>;
  dispatchStepsByRun: Record<string, DispatchStep[]>;
  activeDispatchRunId: string | null;
  contacts: Agent[];
  chats: Conversation[];
  groupChats: Conversation[];
  navigationSection: HubNavigationSection;
  activeWorkspaceContext: WorkspaceContext | null;
};

type WorkspaceStoreSnapshot = WorkspaceStoreState & {
  mainView: MainView;
  activeWorkspace: Workspace | null;
  activeWorkspaceAgents: Agent[];
  activeAgent: Agent | null;
  activeAgentConversations: Conversation[];
  activeConversation: Conversation | null;
  activeGroupConversations: Conversation[];
  isPlaceholderConversationId: (conversationId: string | null) => boolean;
  loadWorkspaces: () => Promise<void>;
  loadWorkspaceTree: (workspaceId: string) => Promise<void>;
  createSubAgentManually: (
    input: CreateSubAgentManuallyInput
  ) => Promise<CreateSubAgentManuallyOutput>;
  deleteSubAgent: (input: DeleteAgentInput) => Promise<DeleteAgentResult>;
  deleteWorkspace: (workspaceId: string) => Promise<boolean>;
  openLocalFolder: () => Promise<void>;
  updateWorkspaceCreateName: (name: string) => void;
  selectMainAgentRuntimeProvider: (provider: RuntimeProvider) => void;
  cancelWorkspaceCreate: () => void;
  createWorkspaceFromDraft: () => Promise<void>;
  openExistingWorkspace: (workspaceId: string) => Promise<void>;
  openMainAgentConversation: (workspaceId?: string) => Promise<void>;
  selectWorkspace: (workspaceId: string) => void;
  selectConversation: (agentId: string, conversationId: string) => void;
  selectGroupConversation: (conversationId: string) => void;
  deleteConversation: (conversationId: string) => Promise<boolean>;
  clearWorkspaceError: () => void;
  setConversationMessages: (conversationId: string, messages: ChatMessage[]) => void;
  setConversationSending: (conversationId: string, sending: boolean) => void;
  setConversationActiveRunId: (conversationId: string, runId: string | undefined) => void;
  loadGroupConversations: (workspaceId: string) => Promise<void>;
  createGroupConversation: (
    title: string,
    description?: string,
    memberAgentIds?: string[]
  ) => Promise<Conversation>;
  deleteGroupConversation: (conversationId: string) => Promise<boolean>;
  addGroupMember: (conversationId: string, agentId: string) => Promise<void>;
  addGroupMembers: (
    conversationId: string,
    agentIds: string[]
  ) => Promise<AddGroupMembersResult>;
  removeGroupMember: (conversationId: string, memberId: string) => Promise<void>;
  loadGroupMembers: (conversationId: string) => Promise<void>;
  setActiveDispatchRunId: (runId: string | null) => void;
  setAppView: (view: AppView) => void;
  loadHubCollections: () => Promise<void>;
  refreshActiveWorkspaceContext: () => Promise<void>;
  selectChat: (conversationId: string) => void;
  openAgentContact: (agentId: string) => void;
  openGroupContact: (conversationId: string) => void;
  openDirectChatForAgent: (agentId: string) => Promise<void>;
  setNavigationSection: (section: HubNavigationSection) => void;
  startNewConversation: () => Promise<void>;
};

type Listener = () => void;

const DEFAULT_MAIN_CONVERSATION_TITLE = "Default Chat";

const listeners = new Set<Listener>();

let state: WorkspaceStoreState = {
  appView: "loading",
  workspaces: [],
  navigationTree: [],
  activeWorkspaceId: null,
  status: "loading",
  error: null,
  isOpening: false,
  isCreatingWorkspace: false,
  initialized: false,
  agentsByWorkspace: {},
  conversationsByAgent: {},
  activeAgentId: null,
  activeConversationId: null,
  agentTreeStatus: "empty",
  agentTreeError: null,
  workspaceCreateDraft: null,
  groupConversationsByWorkspace: {},
  membersByGroupConversation: {},
  dispatchRunsByConversation: {},
  dispatchStepsByRun: {},
  activeDispatchRunId: null,
  messagesByConversationId: {},
  isSendingByConversationId: {},
  activeRunIdByConversationId: {},
  contacts: [],
  chats: [],
  groupChats: [],
  navigationSection: "chats",
  activeWorkspaceContext: null
};

let treeRequestId = 0;

function getApi(): AgentHubApi {
  if (!window.agenthub) {
    throw new Error("AgentHub API is unavailable.");
  }

  return window.agenthub;
}

function compareIsoAscending(left: string, right: string): number {
  return left.localeCompare(right);
}

function sortAgentsForTree(agents: Agent[]): Agent[] {
  return [...agents].sort((left, right) => {
    if (left.role !== right.role) {
      return left.role === "main" ? -1 : 1;
    }

    return compareIsoAscending(left.createdAt, right.createdAt);
  });
}

function sortConversationsForTree(conversations: Conversation[]): Conversation[] {
  return [...conversations].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

async function fetchNavigationTree(): Promise<WorkspaceTreeDTO[]> {
  const api = getApi();

  if (api.navigation?.getTree) {
    return api.navigation.getTree();
  }

  const workspaces = await api.workspace.list();
  return Promise.all(
    workspaces.map(async (workspace) => {
      const agents = sortAgentsForTree(await api.agent.listByWorkspace(workspace.id));
      const agentNodes = await Promise.all(
        agents.map(async (agent) => ({
          agent,
          conversations: sortConversationsForTree(
            await api.conversation.listByAgent(agent.id)
          )
        }))
      );

      return {
        workspace,
        agents: agentNodes
      };
    })
  );
}

async function fetchHubCollections(): Promise<
  Pick<WorkspaceStoreState, "contacts" | "chats" | "groupChats">
> {
  const api = getApi();
  const [contacts, chats, groupChats] = await Promise.all([
    api.agent.listContacts(),
    api.conversation.listChats(),
    api.groupConversation.list()
  ]);
  return { contacts, chats, groupChats };
}

async function loadHubCollections(): Promise<void> {
  try {
    setState(await fetchHubCollections());
  } catch (error) {
    setState({
      agentTreeError:
        error instanceof Error ? error.message : "Failed to load chats and contacts."
    });
  }
}

function getStatus(workspaces: Workspace[]): WorkspaceStatus {
  return workspaces.length > 0 ? "ready" : "empty";
}

function getTreeEntry(
  tree: WorkspaceTreeDTO[],
  workspaceId: string | null
): WorkspaceTreeDTO | null {
  if (!workspaceId) {
    return null;
  }

  return tree.find((entry) => entry.workspace.id === workspaceId) ?? null;
}

function getActiveWorkspaceId(
  tree: WorkspaceTreeDTO[],
  preferredWorkspaceId: string | null
): string | null {
  if (
    preferredWorkspaceId &&
    tree.some((entry) => entry.workspace.id === preferredWorkspaceId)
  ) {
    return preferredWorkspaceId;
  }

  return tree[0]?.workspace.id ?? null;
}

function getActiveAgentId(
  agents: Agent[],
  preferredAgentId: string | null,
  fallbackAgents: Agent[] = agents
): string | null {
  if (preferredAgentId && agents.some((agent) => agent.id === preferredAgentId)) {
    return preferredAgentId;
  }

  if (preferredAgentId && fallbackAgents.some((agent) => agent.id === preferredAgentId)) {
    return preferredAgentId;
  }

  return agents.find((agent) => agent.role === "main")?.id ?? agents[0]?.id ?? null;
}

function getActiveConversationId(
  conversations: Conversation[],
  preferredConversationId: string | null
): string | null {
  if (
    preferredConversationId &&
    conversations.some((conversation) => conversation.id === preferredConversationId)
  ) {
    return preferredConversationId;
  }

  return conversations[0]?.id ?? null;
}

function toRecordMaps(tree: WorkspaceTreeDTO[]): Pick<
  WorkspaceStoreState,
  "agentsByWorkspace" | "conversationsByAgent"
> {
  const agentsByWorkspace: Record<string, Agent[]> = {};
  const conversationsByAgent: Record<string, Conversation[]> = {};

  tree.forEach((entry) => {
    agentsByWorkspace[entry.workspace.id] = sortAgentsForTree(
      entry.agents.map((node) => node.agent)
    );

    entry.agents.forEach((node) => {
      conversationsByAgent[node.agent.id] = sortConversationsForTree(node.conversations);
    });
  });

  return {
    agentsByWorkspace,
    conversationsByAgent
  };
}

function getAgentTreeStatus(
  tree: WorkspaceTreeDTO[],
  activeWorkspaceId: string | null
): WorkspaceStatus {
  const entry = getTreeEntry(tree, activeWorkspaceId);

  if (!entry) {
    return "empty";
  }

  return entry.agents.length > 0 ? "ready" : "empty";
}

function buildStateFromTree(
  tree: WorkspaceTreeDTO[],
  preferredNavigation: Partial<ActiveNavigationState> = {}
): Pick<
  WorkspaceStoreState,
  | "workspaces"
  | "navigationTree"
  | "agentsByWorkspace"
  | "conversationsByAgent"
  | "activeWorkspaceId"
  | "activeAgentId"
  | "activeConversationId"
  | "status"
  | "agentTreeStatus"
  | "agentTreeError"
> {
  const workspaces = tree.map((entry) => entry.workspace);
  const { agentsByWorkspace, conversationsByAgent } = toRecordMaps(tree);
  const activeWorkspaceId = getActiveWorkspaceId(
    tree,
    preferredNavigation.activeWorkspaceId ?? state.activeWorkspaceId
  );
  const activeAgents = activeWorkspaceId ? agentsByWorkspace[activeWorkspaceId] ?? [] : [];
  const preferredAgentId = preferredNavigation.activeAgentId ?? state.activeAgentId;
  const activeAgentId = getActiveAgentId(
    activeAgents,
    preferredAgentId
  );
  const activeConversations = activeAgentId ? conversationsByAgent[activeAgentId] ?? [] : [];
  const preferredConversationId = preferredNavigation.activeConversationId ?? state.activeConversationId;
  // If the preferred conversation is a group conversation (not in any agent's list), preserve it
  const isGroupConversation = preferredConversationId && !activeConversations.some((c) => c.id === preferredConversationId);
  const activeConversationId = isGroupConversation
    ? preferredConversationId
    : getActiveConversationId(
    activeConversations,
    preferredNavigation.activeConversationId ?? state.activeConversationId
  );

  return {
    workspaces,
    navigationTree: tree,
    agentsByWorkspace,
    conversationsByAgent,
    activeWorkspaceId,
    activeAgentId,
    activeConversationId,
    status: getStatus(workspaces),
    agentTreeStatus: getAgentTreeStatus(tree, activeWorkspaceId),
    agentTreeError: null
  };
}

function getMainAgentConversation(
  workspaceId: string | null,
  agentsByWorkspace: Record<string, Agent[]>,
  conversationsByAgent: Record<string, Conversation[]>
): ActiveNavigationState | null {
  if (!workspaceId) {
    return null;
  }

  const agents = agentsByWorkspace[workspaceId] ?? [];
  const mainAgent = agents.find((agent) => agent.role === "main") ?? null;

  if (!mainAgent) {
    return null;
  }

  const conversations = conversationsByAgent[mainAgent.id] ?? [];
  const conversation =
    conversations.find((candidate) => candidate.title === DEFAULT_MAIN_CONVERSATION_TITLE) ??
    conversations[0] ??
    null;

  if (!conversation) {
    return null;
  }

  return {
    activeWorkspaceId: workspaceId,
    activeAgentId: mainAgent.id,
    activeConversationId: conversation.id
  };
}

function deriveMainView(
  navigationSection: HubNavigationSection,
  activeAgentId: string | null,
  activeConversationId: string | null,
  groupChats: Conversation[]
): MainView {
  if (navigationSection === "contacts") {
    if (activeAgentId) {
      return { type: "agentProfile", agentId: activeAgentId };
    }
    if (activeConversationId) {
      const isGroup = groupChats.some((candidate) => candidate.id === activeConversationId);
      if (isGroup) {
        return { type: "groupProfile", conversationId: activeConversationId };
      }
    }
    return { type: "contactsHome" };
  }
  if (navigationSection === "skills") {
    return { type: "skillsLibrary" };
  }
  if (activeConversationId) {
    return { type: "chat", conversationId: activeConversationId };
  }
  return { type: "contactsHome" };
}

function isRuntimeAvailable(
  runtimeStatuses: RuntimeStatus[],
  provider: RuntimeProvider
): boolean {
  return runtimeStatuses.some(
    (runtimeStatus) => runtimeStatus.provider === provider && runtimeStatus.available
  );
}

function emit(): void {
  listeners.forEach((listener) => listener());
}

function setState(nextState: Partial<WorkspaceStoreState>): void {
  state = {
    ...state,
    ...nextState
  };
  emit();
}

async function loadWorkspaces(): Promise<void> {
  setState({
    status: "loading",
    error: null,
    agentTreeError: null
  });

  try {
    await getApi().agent.ensureDefaultMainAgent();
    const [tree, collections] = await Promise.all([
      fetchNavigationTree(),
      fetchHubCollections()
    ]);
    const nextTreeState = buildStateFromTree(tree);

    setState({
      ...nextTreeState,
      ...collections,
      appView: "main",
      initialized: true
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load workspaces.";

    setState({
      status: "error",
      error: message,
      initialized: true,
      appView: "main",
      agentTreeStatus: "error",
      agentTreeError: message
    });
  }
}

async function loadWorkspaceTree(workspaceId: string): Promise<void> {
  const requestId = ++treeRequestId;

  setState({
    activeWorkspaceId: workspaceId,
    agentTreeStatus: "loading",
    agentTreeError: null
  });

  try {
    const [tree, collections] = await Promise.all([
      fetchNavigationTree(),
      fetchHubCollections()
    ]);

    if (requestId !== treeRequestId) {
      return;
    }

    setState(
      buildStateFromTree(tree, {
        activeWorkspaceId: workspaceId,
        activeAgentId: state.activeAgentId,
        activeConversationId: state.activeConversationId
      })
    );
    setState(collections);
  } catch (error) {
    if (requestId !== treeRequestId) {
      return;
    }

    setState({
      agentTreeStatus: "error",
      agentTreeError:
        error instanceof Error ? error.message : "Failed to load workspace navigation."
    });
  }
}

async function createSubAgentManually(
  input: CreateSubAgentManuallyInput
): Promise<CreateSubAgentManuallyOutput> {
  const requestId = ++treeRequestId;

  setState({
    agentTreeError: null
  });

  try {
    const result = await getApi().agent.createSubAgentManually(input);
    const [tree, collections] = await Promise.all([
      fetchNavigationTree(),
      fetchHubCollections()
    ]);

    if (requestId !== treeRequestId) {
      return result;
    }

    setState(
      buildStateFromTree(tree, {
        activeWorkspaceId: result.agent.workspaceId,
        activeAgentId: result.agent.id,
        activeConversationId: result.conversation.id
      })
    );
    setState(collections);

    return result;
  } catch (error) {
    if (requestId === treeRequestId) {
      setState({
        agentTreeError:
          error instanceof Error ? error.message : "Failed to create sub Agent."
      });
    }

    throw error;
  }
}

async function deleteSubAgent(input: DeleteAgentInput): Promise<DeleteAgentResult> {
  const requestId = ++treeRequestId;

  setState({
    agentTreeError: null
  });

  try {
    const result = await getApi().agent.delete(input);
    const [tree, collections] = await Promise.all([
      fetchNavigationTree(),
      fetchHubCollections()
    ]);
    const deletingActiveConversation =
      state.activeAgentId === input.agentId ||
      result.deletedConversationIds.includes(state.activeConversationId ?? "");
    const mainAgentIds = new Set(
      collections.contacts
        .filter((agent) => agent.role === "main" || agent.type === "orchestrator")
        .map((agent) => agent.id)
    );
    const fallbackConversation = deletingActiveConversation
      ? collections.chats.find(
          (conversation) =>
            conversation.type === "direct" && mainAgentIds.has(conversation.agentId)
        ) ??
        collections.chats[0] ??
        collections.groupChats[0] ??
        null
      : null;
    const nextMessagesByConversationId = { ...state.messagesByConversationId };
    for (const conversationId of result.deletedConversationIds) {
      delete nextMessagesByConversationId[conversationId];
    }
    const nextMembersByGroupConversation = Object.fromEntries(
      Object.entries(state.membersByGroupConversation).map(([conversationId, members]) => [
        conversationId,
        members.filter(
          (member) => member.memberType !== "agent" || member.memberId !== input.agentId
        )
      ])
    );

    if (requestId !== treeRequestId) {
      return result;
    }

    setState({
      ...buildStateFromTree(tree, {
        activeWorkspaceId: deletingActiveConversation
          ? fallbackConversation?.workspaceId ?? null
          : state.activeWorkspaceId,
        activeAgentId: deletingActiveConversation
          ? fallbackConversation?.type === "direct"
            ? fallbackConversation.agentId
            : null
          : state.activeAgentId,
        activeConversationId: deletingActiveConversation
          ? fallbackConversation?.id ?? null
          : state.activeConversationId
      }),
      ...collections,
      ...(deletingActiveConversation
        ? {
            activeWorkspaceId: fallbackConversation?.workspaceId ?? null,
            activeAgentId:
              fallbackConversation?.type === "direct" ? fallbackConversation.agentId : null,
            activeConversationId: fallbackConversation?.id ?? null,
            activeWorkspaceContext: null
          }
        : {}),
      messagesByConversationId: nextMessagesByConversationId,
      membersByGroupConversation: nextMembersByGroupConversation
    });

    if (deletingActiveConversation && fallbackConversation) {
      selectChat(fallbackConversation.id);
    }

    return result;
  } catch (error) {
    if (requestId === treeRequestId) {
      setState({
        agentTreeError:
          error instanceof Error ? error.message : "Failed to delete sub Agent."
      });
    }

    throw error;
  }
}

async function deleteWorkspace(workspaceId: string): Promise<boolean> {
  const requestId = ++treeRequestId;

  setState({
    error: null,
    agentTreeError: null
  });

  try {
    const deleted = await getApi().workspace.delete(workspaceId);
    const tree = await fetchNavigationTree();
    const deletingActiveWorkspace = state.activeWorkspaceId === workspaceId;

    if (requestId !== treeRequestId) {
      return deleted;
    }

    setState(
      buildStateFromTree(tree, {
        activeWorkspaceId: deletingActiveWorkspace ? null : state.activeWorkspaceId,
        activeAgentId: deletingActiveWorkspace ? null : state.activeAgentId,
        activeConversationId: deletingActiveWorkspace ? null : state.activeConversationId
      })
    );

    return deleted;
  } catch (error) {
    if (requestId === treeRequestId) {
      const message = error instanceof Error ? error.message : "Failed to delete workspace.";

      setState({
        error: message,
        agentTreeError: message
      });
    }

    throw error;
  }
}

async function openLocalFolder(): Promise<void> {
  setState({
    isOpening: true,
    error: null
  });

  try {
    const rootPath = await getApi().workspace.selectFolder();

    if (!rootPath) {
      setState({
        isOpening: false
      });
      return;
    }

    const preparedWorkspace = await getApi().workspace.prepareCreate({ rootPath });

    setState({
      workspaceCreateDraft: {
        rootPath: preparedWorkspace.rootPath,
        inferredWorkspaceName: preparedWorkspace.inferredName,
        gitEnabled: preparedWorkspace.gitEnabled,
        runtimeStatuses: preparedWorkspace.runtimeStatuses,
        selectedMainAgentRuntimeProvider: "builtin_openai",
        existingWorkspace: preparedWorkspace.existingWorkspace
      },
      error: null,
      isOpening: false,
      initialized: true
    });
  } catch (error) {
    setState({
      error: error instanceof Error ? error.message : "Failed to open workspace.",
      isOpening: false,
      initialized: true
    });
  }
}

function updateWorkspaceCreateName(name: string): void {
  if (!state.workspaceCreateDraft) {
    return;
  }

  setState({
    workspaceCreateDraft: {
      ...state.workspaceCreateDraft,
      inferredWorkspaceName: name
    }
  });
}

function selectMainAgentRuntimeProvider(provider: RuntimeProvider): void {
  const draft = state.workspaceCreateDraft;

  if (!draft || !isRuntimeAvailable(draft.runtimeStatuses, provider)) {
    return;
  }

  setState({
    workspaceCreateDraft: {
      ...draft,
      selectedMainAgentRuntimeProvider: provider
    }
  });
}

function cancelWorkspaceCreate(): void {
  setState({
    workspaceCreateDraft: null,
    isOpening: false,
    isCreatingWorkspace: false,
    error: null
  });
}

async function createWorkspaceFromDraft(): Promise<void> {
  const draft = state.workspaceCreateDraft;

  if (!draft) {
    return;
  }

  const selectedRuntimeProvider = draft.selectedMainAgentRuntimeProvider ?? "builtin_openai";

  setState({
    isCreatingWorkspace: true,
    error: null
  });

  try {
    const result = await getApi().workspace.create({
      rootPath: draft.rootPath,
      name: draft.inferredWorkspaceName,
      mainAgentRuntimeProvider: selectedRuntimeProvider
    });
    const tree = await fetchNavigationTree();

    setState({
      ...buildStateFromTree(tree, {
        activeWorkspaceId: result.workspace.id,
        activeAgentId: result.mainAgent.id,
        activeConversationId: result.mainConversation.id
      }),
      workspaceCreateDraft: null,
      error: null,
      isCreatingWorkspace: false,
      initialized: true
    });
  } catch (error) {
    setState({
      error: error instanceof Error ? error.message : "Failed to create workspace.",
      isCreatingWorkspace: false,
      initialized: true
    });
  }
}

async function openExistingWorkspace(workspaceId: string): Promise<void> {
  setState({
    isCreatingWorkspace: true,
    error: null
  });

  try {
    const tree = await fetchNavigationTree();

    setState({
      ...buildStateFromTree(tree, {
        activeWorkspaceId: workspaceId,
        activeAgentId: null,
        activeConversationId: null
      }),
      workspaceCreateDraft: null,
      isCreatingWorkspace: false,
      initialized: true
    });
  } catch (error) {
    setState({
      error: error instanceof Error ? error.message : "Failed to open workspace.",
      isCreatingWorkspace: false,
      initialized: true
    });
  }
}

async function openMainAgentConversation(workspaceId = state.activeWorkspaceId ?? ""): Promise<void> {
  if (!workspaceId) {
    return;
  }

  const currentNavigation = getMainAgentConversation(
    workspaceId,
    state.agentsByWorkspace,
    state.conversationsByAgent
  );

  if (currentNavigation) {
    setState(currentNavigation);
    return;
  }

  await loadWorkspaceTree(workspaceId);

  const refreshedNavigation = getMainAgentConversation(
    workspaceId,
    state.agentsByWorkspace,
    state.conversationsByAgent
  );

  if (refreshedNavigation) {
    setState(refreshedNavigation);
    return;
  }

  setState({
    agentTreeStatus: "error",
    agentTreeError: "Main Agent session unavailable."
  });
}

function selectWorkspace(workspaceId: string): void {
  setState(
    buildStateFromTree(state.navigationTree, {
      activeWorkspaceId: workspaceId,
      activeAgentId: null,
      activeConversationId: null
    })
  );

  void loadWorkspaceTree(workspaceId);
}

function selectConversation(agentId: string, conversationId: string): void {
  const workspaceAgents = state.activeWorkspaceId
    ? state.agentsByWorkspace[state.activeWorkspaceId] ?? []
    : [];
  const agent = workspaceAgents.find((candidate) => candidate.id === agentId);
  const conversation = state.conversationsByAgent[agentId]?.find(
    (candidate) => candidate.id === conversationId
  );

  if (!agent || !conversation) {
    return;
  }

  setState({
    activeAgentId: agent.id,
    activeConversationId: conversation.id
  });
}

function clearWorkspaceError(): void {
  setState({
    error: null
  });
}

function setConversationMessages(conversationId: string, messages: ChatMessage[]): void {
  setState({
    messagesByConversationId: {
      ...state.messagesByConversationId,
      [conversationId]: messages
    }
  });
}

function setConversationSending(conversationId: string, sending: boolean): void {
  setState({
    isSendingByConversationId: {
      ...state.isSendingByConversationId,
      [conversationId]: sending
    }
  });
}

function setConversationActiveRunId(
  conversationId: string,
  runId: string | undefined
): void {
  const next = { ...state.activeRunIdByConversationId };

  if (runId) {
    next[conversationId] = runId;
  } else {
    delete next[conversationId];
  }

  setState({ activeRunIdByConversationId: next });
}

async function loadGroupConversations(workspaceId: string): Promise<void> {
  try {
    const conversations = await getApi().groupConversation.listByWorkspace(workspaceId);
    setState({
      groupConversationsByWorkspace: {
        ...state.groupConversationsByWorkspace,
        [workspaceId]: conversations
      }
    });
  } catch {
    // silently fail
  }
}

async function createGroupConversationAction(
  title: string,
  description?: string,
  memberAgentIds?: string[]
): Promise<Conversation> {
  const result = await getApi().groupConversation.create({
    title,
    description,
    memberAgentIds
  });
  const [tree, collections] = await Promise.all([
    fetchNavigationTree(),
    fetchHubCollections()
  ]);
  setState({
    ...buildStateFromTree(tree, {
      activeWorkspaceId: result.conversation.workspaceId,
      activeAgentId: null,
      activeConversationId: result.conversation.id
    }),
    ...collections
  });
  selectChat(result.conversation.id);
  await loadGroupMembers(result.conversation.id);

  return result.conversation;
}

async function deleteConversationAction(conversationId: string): Promise<boolean> {
  const requestId = ++treeRequestId;

  setState({
    agentTreeError: null
  });

  try {
    const deleted = await getApi().conversation.delete(conversationId);
    const [tree, collections] = await Promise.all([
      fetchNavigationTree(),
      fetchHubCollections()
    ]);
    const deletingActiveConversation = state.activeConversationId === conversationId;
    const mainAgentIds = new Set(
      collections.contacts
        .filter((agent) => agent.role === "main" || agent.type === "orchestrator")
        .map((agent) => agent.id)
    );
    const fallbackConversation = deletingActiveConversation
      ? collections.chats.find(
          (conversation) =>
            conversation.type === "direct" && mainAgentIds.has(conversation.agentId)
        ) ??
        collections.chats[0] ??
        collections.groupChats[0] ??
        null
      : null;
    const nextMessagesByConversationId = { ...state.messagesByConversationId };
    delete nextMessagesByConversationId[conversationId];

    if (requestId !== treeRequestId) {
      return deleted;
    }

    setState({
      ...buildStateFromTree(tree, {
        activeWorkspaceId: deletingActiveConversation
          ? fallbackConversation?.workspaceId ?? null
          : state.activeWorkspaceId,
        activeAgentId: deletingActiveConversation
          ? fallbackConversation?.type === "direct"
            ? fallbackConversation.agentId
            : null
          : state.activeAgentId,
        activeConversationId: deletingActiveConversation
          ? fallbackConversation?.id ?? null
          : state.activeConversationId
      }),
      ...collections,
      messagesByConversationId: nextMessagesByConversationId
    });

    return deleted;
  } catch (error) {
    if (requestId === treeRequestId) {
      setState({
        agentTreeError:
          error instanceof Error ? error.message : "Failed to delete conversation."
      });
    }

    throw error;
  }
}

async function deleteGroupConversationAction(conversationId: string): Promise<boolean> {
  const requestId = ++treeRequestId;

  setState({
    agentTreeError: null
  });

  try {
    const deleted = await getApi().groupConversation.delete(conversationId);
    const [tree, collections] = await Promise.all([
      fetchNavigationTree(),
      fetchHubCollections()
    ]);
    const deletingActiveConversation = state.activeConversationId === conversationId;
    const mainAgentIds = new Set(
      collections.contacts
        .filter((agent) => agent.role === "main" || agent.type === "orchestrator")
        .map((agent) => agent.id)
    );
    const fallbackConversation = deletingActiveConversation
      ? collections.chats.find(
          (conversation) =>
            conversation.type === "direct" && mainAgentIds.has(conversation.agentId)
        ) ??
        collections.chats[0] ??
        collections.groupChats[0] ??
        null
      : null;
    const nextMessagesByConversationId = { ...state.messagesByConversationId };
    const nextMembersByGroupConversation = { ...state.membersByGroupConversation };
    const nextGroupConversationsByWorkspace = Object.fromEntries(
      Object.entries(state.groupConversationsByWorkspace).map(([workspaceId, conversations]) => [
        workspaceId,
        conversations.filter((conversation) => conversation.id !== conversationId)
      ])
    );
    const nextDispatchRunsByConversation = { ...state.dispatchRunsByConversation };
    const nextDispatchStepsByRun = { ...state.dispatchStepsByRun };
    const deletedDispatchRunIds = new Set(
      (state.dispatchRunsByConversation[conversationId] ?? []).map((run) => run.id)
    );

    delete nextMessagesByConversationId[conversationId];
    delete nextMembersByGroupConversation[conversationId];
    delete nextDispatchRunsByConversation[conversationId];
    for (const runId of deletedDispatchRunIds) {
      delete nextDispatchStepsByRun[runId];
    }

    if (requestId !== treeRequestId) {
      return deleted;
    }

    setState({
      ...buildStateFromTree(tree, {
        activeWorkspaceId: deletingActiveConversation
          ? fallbackConversation?.workspaceId ?? null
          : state.activeWorkspaceId,
        activeAgentId: deletingActiveConversation
          ? fallbackConversation?.type === "direct"
            ? fallbackConversation.agentId
            : null
          : state.activeAgentId,
        activeConversationId: deletingActiveConversation
          ? fallbackConversation?.id ?? null
          : state.activeConversationId
      }),
      ...collections,
      groupConversationsByWorkspace: nextGroupConversationsByWorkspace,
      messagesByConversationId: nextMessagesByConversationId,
      membersByGroupConversation: nextMembersByGroupConversation,
      dispatchRunsByConversation: nextDispatchRunsByConversation,
      dispatchStepsByRun: nextDispatchStepsByRun,
      activeDispatchRunId: deletedDispatchRunIds.has(state.activeDispatchRunId ?? "")
        ? null
        : state.activeDispatchRunId,
      ...(deletingActiveConversation ? { activeWorkspaceContext: null } : {})
    });

    return deleted;
  } catch (error) {
    if (requestId === treeRequestId) {
      setState({
        agentTreeError:
          error instanceof Error ? error.message : "Failed to dissolve group chat."
      });
    }

    throw error;
  }
}

async function addGroupMemberAction(conversationId: string, agentId: string): Promise<void> {
  await getApi().groupMember.add({ conversationId, agentId });
  void loadGroupMembers(conversationId);
}

async function addGroupMembersAction(
  conversationId: string,
  agentIds: string[]
): Promise<AddGroupMembersResult> {
  const result = await getApi().groupMember.addMany({
    groupConversationId: conversationId,
    agentIds
  });
  await Promise.all([loadGroupMembers(conversationId), loadHubCollections()]);
  return result;
}

async function removeGroupMemberAction(conversationId: string, memberId: string): Promise<void> {
  await getApi().groupMember.remove({ conversationId, memberId });
  void loadGroupMembers(conversationId);
}

async function loadGroupMembers(conversationId: string): Promise<void> {
  try {
    const members = await getApi().groupMember.list(conversationId);
    setState({
      membersByGroupConversation: {
        ...state.membersByGroupConversation,
        [conversationId]: members
      }
    });
  } catch {
    // silently fail
  }
}

function selectGroupConversation(conversationId: string): void {
  selectChat(conversationId);
}

function setActiveDispatchRunId(runId: string | null): void {
  setState({ activeDispatchRunId: runId });
}

function setAppView(view: AppView): void {
  setState({ appView: view });
}

async function refreshActiveWorkspaceContext(): Promise<void> {
  const conversationId = state.activeConversationId;
  if (!conversationId || isPlaceholderConversationId(conversationId)) {
    return;
  }
  try {
    const workspaceContext = await getApi().conversation.resolveWorkspaceContext(conversationId);
    if (state.activeConversationId === conversationId) {
      setState({ activeWorkspaceContext: workspaceContext });
    }
  } catch {
    // ignore stale refresh errors; the next selection will retry.
  }
}

function selectChat(conversationId: string): void {
  if (isPlaceholderConversationId(conversationId)) {
    return;
  }

  if (state.activeConversationId === conversationId) {
    setState({
      activeConversationId: null,
      activeAgentId: null
    });
    return;
  }

  const conversation =
    state.chats.find((candidate) => candidate.id === conversationId) ??
    state.groupChats.find((candidate) => candidate.id === conversationId) ??
    Object.values(state.conversationsByAgent)
      .flat()
      .find((candidate) => candidate.id === conversationId);
  if (!conversation) {
    return;
  }

  setState({
    activeWorkspaceId: conversation.workspaceId,
    activeAgentId: conversation.type === "direct" ? conversation.agentId : null,
    activeConversationId: conversation.id,
    activeWorkspaceContext: null
  });
  void getApi()
    .conversation.resolveWorkspaceContext(conversation.id)
    .then((workspaceContext) => {
      if (state.activeConversationId === conversation.id) {
        setState({ activeWorkspaceContext: workspaceContext });
      }
    })
    .catch(() => undefined);

  if (conversation.type === "group") {
    void loadGroupMembers(conversation.id);
  }
}

function openAgentContact(agentId: string): void {
  if (state.activeAgentId === agentId) {
    setState({
      activeAgentId: null,
      activeConversationId: null
    });
    return;
  }
  setState({
    activeAgentId: agentId,
    activeConversationId: null,
    activeWorkspaceContext: null
  });
}

function openGroupContact(conversationId: string): void {
  if (state.activeConversationId === conversationId && state.activeAgentId === null) {
    setState({
      activeConversationId: null
    });
    return;
  }
  const conversation =
    state.groupChats.find((candidate) => candidate.id === conversationId) ??
    state.chats.find((candidate) => candidate.id === conversationId) ??
    null;
  if (!conversation) {
    return;
  }
  setState({
    activeWorkspaceId: conversation.workspaceId,
    activeConversationId: conversation.id,
    activeAgentId: null,
    activeWorkspaceContext: null
  });
}

async function openDirectChatForAgent(agentId: string): Promise<void> {
  const agent =
    Object.values(state.agentsByWorkspace)
      .flat()
      .find((candidate) => candidate.id === agentId) ??
    state.contacts.find((candidate) => candidate.id === agentId) ??
    null;
  const workspaceId = agent?.workspaceId ?? state.activeWorkspaceId;

  if (state.activeAgentId !== agentId || state.activeWorkspaceId !== workspaceId) {
    setState({
      activeWorkspaceId: workspaceId,
      activeAgentId: agentId,
      activeConversationId: null
    });
  }
  setNavigationSection("chats");
  await ensureDirectConversationForActiveAgent();
}

const PLACEHOLDER_CONVERSATION_PREFIX = "__creating_";

function isPlaceholderConversationId(conversationId: string | null): boolean {
  return conversationId !== null && conversationId.startsWith(PLACEHOLDER_CONVERSATION_PREFIX);
}

async function ensureDirectConversationForActiveAgent(): Promise<void> {
  const agentId = state.activeAgentId;
  if (!agentId) {
    return;
  }
  const existingCurrent = state.activeConversationId
    ? state.chats.find((candidate) => candidate.id === state.activeConversationId)
    : null;
  if (existingCurrent && existingCurrent.type === "direct" && existingCurrent.agentId === agentId) {
    void refreshActiveWorkspaceContext();
    return;
  }
  const existingForAgent = state.chats.find(
    (candidate) => candidate.type === "direct" && candidate.agentId === agentId
  );
  if (existingForAgent) {
    setState({ activeConversationId: existingForAgent.id });
    void refreshActiveWorkspaceContext();
    return;
  }

  const placeholderId = `${PLACEHOLDER_CONVERSATION_PREFIX}${agentId}_${Date.now()}`;
  const placeholder: Conversation = {
    id: placeholderId,
    workspaceId: state.activeWorkspaceId ?? "",
    workspaceContextId: null,
    agentId,
    avatar: null,
    status: "active",
    lastMessageAt: null,
    provider: null,
    title: "新对话",
    mode: "single",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    type: "direct",
    description: "",
    ownerUserId: "",
    mainAgentId: null,
    autoDispatchEnabled: false
  };
  setState({
    activeConversationId: placeholderId,
    chats: [...state.chats, placeholder]
  });

  try {
    const real = await getApi().conversation.findOrCreateDirectConversationForAgent(agentId);
    setState({
      activeWorkspaceId: real.workspaceId,
      activeAgentId: real.agentId,
      chats: state.chats.map((candidate) => (candidate.id === placeholderId ? real : candidate)),
      activeConversationId:
        state.activeConversationId === placeholderId ? real.id : state.activeConversationId
    });
  } catch (error) {
    setState({
      chats: state.chats.filter((candidate) => candidate.id !== placeholderId),
      activeConversationId:
        state.activeConversationId === placeholderId ? null : state.activeConversationId
    });
    window.alert(error instanceof Error ? error.message : "Failed to open conversation.");
  }
}

function setNavigationSection(section: HubNavigationSection): void {
  if (state.navigationSection === section) {
    return;
  }
  setState({ navigationSection: section });
  if (section === "chats") {
    void ensureDirectConversationForActiveAgent();
  }
}

export const workspaceStore = {
  getState: () => state,
  setState,
  subscribe(listener: Listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  loadWorkspaces,
  loadWorkspaceTree,
  createSubAgentManually,
  deleteSubAgent,
  deleteWorkspace,
  openLocalFolder,
  updateWorkspaceCreateName,
  selectMainAgentRuntimeProvider,
  cancelWorkspaceCreate,
  createWorkspaceFromDraft,
  openExistingWorkspace,
  openMainAgentConversation,
  selectWorkspace,
  selectConversation,
  clearWorkspaceError,
  setAppView,
  loadHubCollections,
  refreshActiveWorkspaceContext,
  selectChat,
  openAgentContact,
  openGroupContact,
  openDirectChatForAgent,
  setNavigationSection,
  startNewConversation: startNewConversationAction
};

async function startNewConversationAction(): Promise<void> {
  const current = state;
  const activeWorkspaceId = current.activeWorkspaceId;
  const activeConversationId = current.activeConversationId;
  const activeConversation = activeConversationId
    ? current.chats.find((candidate) => candidate.id === activeConversationId) ??
      current.groupChats.find((candidate) => candidate.id === activeConversationId) ??
      Object.values(current.conversationsByAgent)
        .flat()
        .find((candidate) => candidate.id === activeConversationId) ??
      null
    : null;

  if (!activeWorkspaceId || !activeConversation) {
    return;
  }

  setState({
    agentTreeError: null
  });

  try {
    if (activeConversation.type === "group") {
      const members = current.membersByGroupConversation[activeConversation.id] ?? [];
      const memberAgentIds = members
        .filter((member) => member.memberType === "agent")
        .map((member) => member.memberId);
      const result = await getApi().groupConversation.create({
        workspaceId: activeConversation.workspaceId,
        title: activeConversation.title,
        description: activeConversation.description,
        memberAgentIds
      });
      const [tree, collections] = await Promise.all([
        fetchNavigationTree(),
        fetchHubCollections()
      ]);
      setState({
        ...buildStateFromTree(tree, {
          activeWorkspaceId: result.conversation.workspaceId,
          activeAgentId: null,
          activeConversationId: result.conversation.id
        }),
        ...collections
      });
      selectChat(result.conversation.id);
      await loadGroupMembers(result.conversation.id);
    } else {
      const agentId = activeConversation.agentId;
      const newConversation = await getApi().conversation.createDirectConversationForAgent(agentId);
      const [tree, collections] = await Promise.all([
        fetchNavigationTree(),
        fetchHubCollections()
      ]);
      setState({
        ...buildStateFromTree(tree, {
          activeWorkspaceId: newConversation.workspaceId,
          activeAgentId: newConversation.agentId,
          activeConversationId: newConversation.id
        }),
        ...collections
      });
    }
  } catch (error) {
    setState({
      agentTreeError:
        error instanceof Error ? error.message : "Failed to start a new conversation."
    });
    window.alert(error instanceof Error ? error.message : "Failed to start a new conversation.");
  }
}

function getSnapshot(): WorkspaceStoreState {
  return state;
}

export function useWorkspaceStore(): WorkspaceStoreSnapshot {
  const snapshot = useSyncExternalStore(workspaceStore.subscribe, getSnapshot, getSnapshot);
  const activeWorkspace =
    snapshot.workspaces.find((workspace) => workspace.id === snapshot.activeWorkspaceId) ??
    null;
  const activeWorkspaceAgents = activeWorkspace
    ? snapshot.agentsByWorkspace[activeWorkspace.id] ?? []
    : [];
  const activeAgent =
    activeWorkspaceAgents.find((agent) => agent.id === snapshot.activeAgentId) ??
    snapshot.contacts.find((agent) => agent.id === snapshot.activeAgentId) ??
    null;
  const activeAgentConversations = activeAgent
    ? snapshot.conversationsByAgent[activeAgent.id] ?? []
    : [];
  const activeGroupConversations = activeWorkspace
    ? snapshot.groupConversationsByWorkspace[activeWorkspace.id] ?? []
    : [];
  const activeConversationId = snapshot.activeConversationId;
  const isPlaceholder = isPlaceholderConversationId(activeConversationId);
  const activeConversation = isPlaceholder
    ? null
    : activeAgentConversations.find((conversation) => conversation.id === activeConversationId) ??
      activeGroupConversations.find((conversation) => conversation.id === activeConversationId) ??
      snapshot.chats.find((conversation) => conversation.id === activeConversationId) ??
      null;
  const mainView = deriveMainView(
    snapshot.navigationSection,
    snapshot.activeAgentId,
    activeConversationId,
    snapshot.groupChats
  );

  return {
    ...snapshot,
    mainView,
    activeWorkspace,
    activeWorkspaceAgents,
    activeAgent,
    activeAgentConversations,
    activeConversation,
    activeGroupConversations,
    isPlaceholderConversationId,
    loadWorkspaces,
    loadWorkspaceTree,
    createSubAgentManually,
    deleteSubAgent,
    deleteWorkspace,
    openLocalFolder,
    updateWorkspaceCreateName,
    selectMainAgentRuntimeProvider,
    cancelWorkspaceCreate,
    createWorkspaceFromDraft,
    openExistingWorkspace,
    openMainAgentConversation,
    selectWorkspace,
    selectConversation,
    selectGroupConversation,
    clearWorkspaceError,
    setConversationMessages,
    setConversationSending,
    setConversationActiveRunId,
    loadGroupConversations,
    createGroupConversation: createGroupConversationAction,
    deleteGroupConversation: deleteGroupConversationAction,
    deleteConversation: deleteConversationAction,
    addGroupMember: addGroupMemberAction,
    addGroupMembers: addGroupMembersAction,
    removeGroupMember: removeGroupMemberAction,
    loadGroupMembers,
    setActiveDispatchRunId,
    setAppView,
    loadHubCollections,
    refreshActiveWorkspaceContext,
    selectChat,
    openAgentContact,
    openGroupContact,
    openDirectChatForAgent,
    setNavigationSection,
    startNewConversation: startNewConversationAction
  };
}
