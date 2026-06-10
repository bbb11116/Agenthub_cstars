import { contextBridge, ipcRenderer } from "electron";
import { IPC_CHANNELS } from "../src/shared/ipcChannels";
import type { RunAgentStreamEvent } from "../src/shared/domain";
import type {
  AgentHubApi,
  DispatchStreamHandlers,
  RunAgentStreamHandlers
} from "../src/shared/types";
import type { DispatchGroupTasksInput } from "../src/shared/groupChat";
import type { DispatchRunStreamEvent } from "../src/shared/groupChat";
import type { AgentRunEvent } from "../src/shared/agentRunEvent";

export type RunAgentUnifiedStreamHandlers = {
  onEvent?: (event: AgentRunEvent) => void;
};

function createStreamId(): string {
  return `run-stream-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function runAgentWithOptionalStream(
  input: Parameters<AgentHubApi["agent"]["run"]>[0],
  streamHandlers?: RunAgentStreamHandlers
): ReturnType<AgentHubApi["agent"]["run"]> {
  if (!streamHandlers?.onTextDelta && !streamHandlers?.onThinkingDelta) {
    return ipcRenderer.invoke(IPC_CHANNELS.AGENT_RUN, input);
  }

  const streamId = createStreamId();
  const streamChannel = `${IPC_CHANNELS.AGENT_RUN_STREAM}:${streamId}`;
  const listener = (_event: Electron.IpcRendererEvent, payload: RunAgentStreamEvent) => {
    if (payload.type === "text_delta") {
      streamHandlers.onTextDelta?.(payload);
    } else if (payload.type === "thinking_delta") {
      streamHandlers.onThinkingDelta?.(payload);
    }
  };

  ipcRenderer.on(streamChannel, listener);

  return ipcRenderer
    .invoke(IPC_CHANNELS.AGENT_RUN, {
      ...input,
      streamId
    })
    .finally(() => {
      ipcRenderer.removeListener(streamChannel, listener);
    });
}

const agenthubApi: AgentHubApi = {
  ping: () => ipcRenderer.invoke(IPC_CHANNELS.PING),
  workspace: {
    selectFolder: () => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_SELECT_FOLDER),
    prepareCreate: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_PREPARE_CREATE, input),
    create: (input) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_CREATE, input),
    delete: (workspaceId) =>
      ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_DELETE, workspaceId),
    list: () => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_LIST)
  },
  agent: {
    listByWorkspace: (workspaceId) =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_LIST_BY_WORKSPACE, workspaceId),
    listContacts: () => ipcRenderer.invoke(IPC_CHANNELS.AGENT_LIST_CONTACTS),
    ensureDefaultMainAgent: () =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_ENSURE_DEFAULT_MAIN_AGENT),
    createSubAgentManually: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_CREATE_SUB_AGENT_MANUALLY, input),
    delete: (input) => ipcRenderer.invoke(IPC_CHANNELS.AGENT_DELETE, input),
    updateStatus: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_UPDATE_STATUS, input),
    updateProfile: (input) => ipcRenderer.invoke(IPC_CHANNELS.AGENT_UPDATE_PROFILE, input),
    updateDefaultWorkspace: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_UPDATE_DEFAULT_WORKSPACE, input),
    getStatus: (agentId) => ipcRenderer.invoke(IPC_CHANNELS.AGENT_GET_STATUS, agentId),
    getAgentProfile: (agentId) => ipcRenderer.invoke(IPC_CHANNELS.AGENT_GET_PROFILE, agentId),
    run: runAgentWithOptionalStream,
    runWithConversation: (
      input: Parameters<AgentHubApi["agent"]["runWithConversation"]>[0],
      streamHandlers?: RunAgentStreamHandlers
    ) => {
      if (!streamHandlers?.onTextDelta && !streamHandlers?.onThinkingDelta) {
        return ipcRenderer.invoke(IPC_CHANNELS.AGENT_RUN_WITH_CONVERSATION, input);
      }

      const streamId = createStreamId();
      const streamChannel = `${IPC_CHANNELS.AGENT_RUN_WITH_CONVERSATION_STREAM}:${streamId}`;
      const listener = (_event: Electron.IpcRendererEvent, payload: RunAgentStreamEvent) => {
        if (payload.type === "text_delta") {
          streamHandlers.onTextDelta?.(payload);
        } else if (payload.type === "thinking_delta") {
          streamHandlers.onThinkingDelta?.(payload);
        }
      };

      ipcRenderer.on(streamChannel, listener);

      return ipcRenderer
        .invoke(IPC_CHANNELS.AGENT_RUN_WITH_CONVERSATION, {
          ...input,
          streamId
        })
        .finally(() => {
          ipcRenderer.removeListener(streamChannel, listener);
        });
    },
    runWithConversationUnified: (
      input: Parameters<AgentHubApi["agent"]["runWithConversationUnified"]>[0],
      streamHandlers?: RunAgentUnifiedStreamHandlers
    ) => {
      if (!streamHandlers?.onEvent) {
        return ipcRenderer.invoke(
          IPC_CHANNELS.AGENT_RUN_WITH_CONVERSATION_UNIFIED,
          input
        );
      }

      const streamId = createStreamId();
      const streamChannel = `${IPC_CHANNELS.AGENT_RUN_WITH_CONVERSATION_UNIFIED_STREAM}:${streamId}`;
      const listener = (_event: Electron.IpcRendererEvent, payload: AgentRunEvent) => {
        streamHandlers.onEvent?.(payload);
      };

      ipcRenderer.on(streamChannel, listener);

      return ipcRenderer
        .invoke(IPC_CHANNELS.AGENT_RUN_WITH_CONVERSATION_UNIFIED, {
          ...input,
          streamId
        })
        .finally(() => {
          ipcRenderer.removeListener(streamChannel, listener);
      });
    }
  },
  skill: {
    listCatalog: () => ipcRenderer.invoke(IPC_CHANNELS.SKILL_LIST_CATALOG),
    get: (skillId) => ipcRenderer.invoke(IPC_CHANNELS.SKILL_GET, skillId)
  },
  agentRun: {
    listEvents: (conversationId) =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_RUN_EVENT_LIST, conversationId)
  },
  runtime: {
    checkAll: () => ipcRenderer.invoke(IPC_CHANNELS.RUNTIME_CHECK_ALL),
    check: (provider) => ipcRenderer.invoke(IPC_CHANNELS.RUNTIME_CHECK, provider)
  },
  conversation: {
    listByAgent: (agentId) =>
      ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_LIST_BY_AGENT, agentId),
    listChats: () => ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_LIST_CHATS),
    resolveWorkspaceContext: (conversationId) =>
      ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_RESOLVE_WORKSPACE_CONTEXT, conversationId),
    findOrCreateDirectConversationForAgent: (agentId) =>
      ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_FIND_OR_CREATE_DIRECT, agentId),
    createDirectConversationForAgent: (agentId) =>
      ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_CREATE_DIRECT, agentId),
    delete: (conversationId) =>
      ipcRenderer.invoke(IPC_CHANNELS.CONVERSATION_DELETE, conversationId)
  },
  message: {
    list: (conversationId) => ipcRenderer.invoke(IPC_CHANNELS.MESSAGE_LIST, conversationId),
    listWithArtifacts: (conversationId) =>
      ipcRenderer.invoke(IPC_CHANNELS.MESSAGE_LIST_WITH_ARTIFACTS, conversationId),
    create: (input) => ipcRenderer.invoke(IPC_CHANNELS.MESSAGE_CREATE, input)
  },
  navigation: {
    getTree: () => ipcRenderer.invoke(IPC_CHANNELS.NAVIGATION_GET_TREE)
  },
  file: {
    tree: (input) => ipcRenderer.invoke(IPC_CHANNELS.FILE_TREE, input),
    read: (input) => ipcRenderer.invoke(IPC_CHANNELS.FILE_READ, input)
  },
  artifact: {
    create: (input) => ipcRenderer.invoke(IPC_CHANNELS.ARTIFACT_CREATE, input),
    listByWorkspace: (workspaceId) =>
      ipcRenderer.invoke(IPC_CHANNELS.ARTIFACT_LIST_BY_WORKSPACE, workspaceId),
    get: (artifactId) => ipcRenderer.invoke(IPC_CHANNELS.ARTIFACT_GET, artifactId),
    render: (artifactId) => ipcRenderer.invoke(IPC_CHANNELS.ARTIFACT_RENDER, artifactId),
    updateContent: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.ARTIFACT_UPDATE_CONTENT, input),
    createDiff: (input) => ipcRenderer.invoke(IPC_CHANNELS.ARTIFACT_CREATE_DIFF, input),
    onRenderChanged: (handler) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof handler>[0]) => {
        handler(payload);
      };
      ipcRenderer.on(IPC_CHANNELS.ARTIFACT_RENDER_CHANGED, listener);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.ARTIFACT_RENDER_CHANGED, listener);
      };
    }
  },
  diff: {
    createProposal: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.DIFF_CREATE_PROPOSAL, input),
    get: (diffProposalId) => ipcRenderer.invoke(IPC_CHANNELS.DIFF_GET, diffProposalId),
    listByWorkspace: (workspaceId) =>
      ipcRenderer.invoke(IPC_CHANNELS.DIFF_LIST_BY_WORKSPACE, workspaceId),
    apply: (input) => ipcRenderer.invoke(IPC_CHANNELS.DIFF_APPLY, input),
    reject: (input) => ipcRenderer.invoke(IPC_CHANNELS.DIFF_REJECT, input)
  },
  git: {
    status: (input) => ipcRenderer.invoke(IPC_CHANNELS.GIT_STATUS, input),
    diff: (input) => ipcRenderer.invoke(IPC_CHANNELS.GIT_DIFF, input)
  },
  groupConversation: {
    create: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.GROUP_CONVERSATION_CREATE, input),
    listByWorkspace: (workspaceId) =>
      ipcRenderer.invoke(IPC_CHANNELS.GROUP_CONVERSATION_LIST, workspaceId),
    list: () => ipcRenderer.invoke(IPC_CHANNELS.GROUP_CONVERSATION_LIST_ALL),
    listGroupAgents: (conversationId) =>
      ipcRenderer.invoke(IPC_CHANNELS.GROUP_AGENT_LIST, conversationId),
    listAvailableAgents: (conversationId) =>
      ipcRenderer.invoke(IPC_CHANNELS.GROUP_AVAILABLE_AGENT_LIST, conversationId),
    updateProfile: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.GROUP_CONVERSATION_UPDATE_PROFILE, input),
    updateWorkspace: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.GROUP_CONVERSATION_UPDATE_WORKSPACE, input),
    getGroupProfile: (conversationId) =>
      ipcRenderer.invoke(IPC_CHANNELS.GROUP_CONVERSATION_GET_PROFILE, conversationId),
    delete: (conversationId) =>
      ipcRenderer.invoke(IPC_CHANNELS.GROUP_CONVERSATION_DELETE, conversationId)
  },
  groupMember: {
    add: (input) => ipcRenderer.invoke(IPC_CHANNELS.GROUP_MEMBER_ADD, input),
    addMany: (input) => ipcRenderer.invoke(IPC_CHANNELS.GROUP_MEMBER_ADD_MANY, input),
    remove: (input) => ipcRenderer.invoke(IPC_CHANNELS.GROUP_MEMBER_REMOVE, input),
    list: (conversationId) =>
      ipcRenderer.invoke(IPC_CHANNELS.GROUP_MEMBER_LIST, conversationId)
  },
  groupMessage: {
    send: (input, streamHandlers?: DispatchStreamHandlers) => {
      if (!streamHandlers?.onStepUpdate) {
        return ipcRenderer.invoke(IPC_CHANNELS.GROUP_MESSAGE_SEND, input);
      }

      const dispatchStreamId = createStreamId();
      const streamChannel = `${IPC_CHANNELS.DISPATCH_STREAM}:${dispatchStreamId}`;
      const listener = (_event: Electron.IpcRendererEvent, payload: DispatchRunStreamEvent) => {
        streamHandlers.onStepUpdate?.(payload);
      };

      ipcRenderer.on(streamChannel, listener);

      return ipcRenderer
        .invoke(IPC_CHANNELS.GROUP_MESSAGE_SEND, {
          ...input,
          dispatchStreamId
        })
        .finally(() => {
          ipcRenderer.removeListener(streamChannel, listener);
        });
    },
    dispatchGroupTasks: (input: DispatchGroupTasksInput, streamHandlers?: DispatchStreamHandlers) => {
      if (!streamHandlers?.onStepUpdate) {
        return ipcRenderer.invoke(IPC_CHANNELS.GROUP_TASK_DISPATCH, input);
      }

      const dispatchStreamId = createStreamId();
      const streamChannel = `${IPC_CHANNELS.DISPATCH_STREAM}:${dispatchStreamId}`;
      const listener = (_event: Electron.IpcRendererEvent, payload: DispatchRunStreamEvent) => {
        streamHandlers.onStepUpdate?.(payload);
      };

      ipcRenderer.on(streamChannel, listener);

      return ipcRenderer
        .invoke(IPC_CHANNELS.GROUP_TASK_DISPATCH, {
          ...input,
          dispatchStreamId
        })
        .finally(() => {
          ipcRenderer.removeListener(streamChannel, listener);
        });
    }
  },
  dispatch: {
    getRun: (runId) => ipcRenderer.invoke(IPC_CHANNELS.DISPATCH_RUN_GET, runId),
    listRuns: (conversationId) =>
      ipcRenderer.invoke(IPC_CHANNELS.DISPATCH_RUN_LIST, conversationId),
    listEvents: (conversationId) =>
      ipcRenderer.invoke(IPC_CHANNELS.DISPATCH_EVENT_LIST, conversationId),
    retryStep: (input, streamHandlers?: DispatchStreamHandlers) => {
      if (!streamHandlers?.onStepUpdate) {
        return ipcRenderer.invoke(IPC_CHANNELS.DISPATCH_STEP_RETRY, input);
      }

      const dispatchStreamId = createStreamId();
      const streamChannel = `${IPC_CHANNELS.DISPATCH_STREAM}:${dispatchStreamId}`;
      const listener = (_event: Electron.IpcRendererEvent, payload: DispatchRunStreamEvent) => {
        streamHandlers.onStepUpdate?.(payload);
      };

      ipcRenderer.on(streamChannel, listener);

      return ipcRenderer
        .invoke(IPC_CHANNELS.DISPATCH_STEP_RETRY, {
          ...input,
          dispatchStreamId
        })
        .finally(() => {
          ipcRenderer.removeListener(streamChannel, listener);
        });
    }
  },
  modelProvider: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.MODEL_PROVIDER_LIST),
    get: (id) => ipcRenderer.invoke(IPC_CHANNELS.MODEL_PROVIDER_GET, id),
    save: (input) => ipcRenderer.invoke(IPC_CHANNELS.MODEL_PROVIDER_SAVE, input),
    delete: (id) => ipcRenderer.invoke(IPC_CHANNELS.MODEL_PROVIDER_DELETE, id),
    testConnection: (input) => ipcRenderer.invoke(IPC_CHANNELS.MODEL_PROVIDER_TEST, input),
    hasAnyProvider: () => ipcRenderer.invoke(IPC_CHANNELS.MODEL_PROVIDER_HAS_ANY),
    getContextUsage: (input) =>
      ipcRenderer.invoke(IPC_CHANNELS.MODEL_PROVIDER_CONTEXT_USAGE, input)
  }
};

contextBridge.exposeInMainWorld("agenthub", agenthubApi);
