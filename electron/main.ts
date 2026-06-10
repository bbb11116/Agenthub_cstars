import { app, BrowserWindow, dialog, ipcMain, net, protocol, type OpenDialogOptions } from "electron";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function augmentProcessPath(): void {
  const homeDir = os.homedir();
  const extraPaths = [
    path.join(homeDir, ".npm-global", "bin"),
    path.join(homeDir, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin"
  ];
  const currentPath = process.env.PATH ?? "";
  const pathSeparator = process.platform === "win32" ? ";" : ":";
  const existing = new Set(currentPath.split(pathSeparator));
  const missing = extraPaths.filter((p) => !existing.has(p));

  if (missing.length > 0) {
    process.env.PATH = [...missing, currentPath].join(pathSeparator);
  }
}

augmentProcessPath();
import { IPC_CHANNELS } from "../src/shared/ipcChannels";
import { initializeDatabase } from "../src/main/db";
import { getAgentRunEventsByConversation } from "../src/main/db/repositories/agentRunEventRepo";
import type {
  ApplyDiffInput,
  CreateDiffProposalInput,
  CreateMessageInput,
  CreateSubAgentManuallyInput,
  CreateWorkspaceInput,
  DeleteAgentInput,
  PrepareCreateWorkspaceInput,
  RejectDiffInput,
  RunAgentInput,
  RunAgentStreamEvent,
  RuntimeProvider,
  UpdateAgentDefaultWorkspaceInput,
  UpdateAgentProfileInput,
  UpdateAgentStatusInput
} from "../src/shared/domain";
import type { AgentRunStreamSink } from "../src/main/services/agentRunService";
import type {
  AddGroupMemberInput,
  AddGroupMembersInput,
  CreateGroupConversationInput,
  DispatchGroupTasksInput,
  RemoveGroupMemberInput,
  SendGroupMessageInput,
  UpdateGroupProfileInput,
  UpdateGroupWorkspaceInput
} from "../src/shared/groupChat";
import type { DispatchStreamHandler } from "../src/main/services/dispatchService";
import type {
  CreateArtifactDiffInput,
  CreateArtifactInput,
  PreviewArtifactInput,
  UpdateArtifactContentInput
} from "../src/shared/artifact";
import type { ReadFileInput, ReadFileTreeInput } from "../src/shared/file";
import type { ReadGitDiffInput, ReadGitStatusInput } from "../src/shared/git";
import { isRuntimeProvider } from "../src/shared/runtime";
import {
  createSubAgentManually,
  getAgentProfile,
  getAgentStatus,
  listAgentContacts,
  listAgentsByWorkspace,
  updateAgentDefaultWorkspace,
  updateAgentProfile,
  updateAgentStatus
} from "../src/main/services/agentService";
import { runAgent } from "../src/main/services/agentRunService";
import { runAgentWithConversation, runAgentWithConversationUnified, type RunWithConversationInput, type RunWithConversationUnifiedInput } from "../src/main/services/agentRunWithConversationService";
import {
  createArtifact,
  getArtifact,
  listArtifactsByWorkspace,
  updateArtifactContent
} from "../src/main/services/artifactService";
import {
  getArtifactRenderAssetFilePath,
  renderArtifact,
  setArtifactRenderNotifier
} from "../src/main/services/artifactRenderService";
import { createDiffProposalFromArtifact } from "../src/main/services/artifactDiffService";
import { listChats, listConversationsByAgent, findOrCreateDirectConversationForAgent, createDirectConversationForAgent, deleteDirectConversation } from "../src/main/services/conversationService";
import { readGitDiff, readGitStatus } from "../src/main/services/gitService";
import {
  applyDiff,
  createDiffProposal,
  getDiffProposal,
  listDiffProposalsByWorkspace,
  rejectDiffProposal
} from "../src/main/services/diffService";
import {
  createMessage,
  listMessagesByConversation,
  listMessagesWithArtifactsByConversation
} from "../src/main/services/messageService";
import { getNavigationTree } from "../src/main/services/navigationService";
import {
  createWorkspaceFromFolder,
  deleteWorkspaceById,
  listWorkspaces,
  prepareCreateWorkspace,
  validateWorkspaceFolder
} from "../src/main/services/workspaceService";
import {
  checkAllRuntimeProviders,
  checkRuntimeProvider
} from "../src/main/services/runtimeService";
import { readFileTree, readWorkspaceFile } from "../src/main/services/fileService";
import {
  createGroupConversation,
  addAgentMember,
  addAgentMembers,
  removeAgentMember,
  listGroupMembers,
  listGroupConversationsByWorkspace,
  listGroupConversations,
  getAvailableAgentsForGroup,
  listGroupAgents,
  updateGroupProfile,
  updateGroupWorkspace,
  getGroupProfile,
  deleteGroupConversation
} from "../src/main/services/groupChatService";
import {
  handleGroupUserMessage,
  retryDispatchStep,
  dispatchGroupTasks
} from "../src/main/services/dispatchService";
import {
  getDispatchRunById,
  getDispatchRunsByConversation
} from "../src/main/db/repositories/dispatchRunRepo";
import { getGroupRunEventsByConversation } from "../src/main/db/repositories/groupRunEventRepo";
import {
  listProviders,
  getProvider,
  saveProvider,
  deleteProvider,
  testConnection,
  hasAnyProvider
} from "../src/main/services/modelProviderService";
import { getMainAgentContextUsage } from "../src/main/services/orchestratorRuntimeService";
import { resolveExecutionWorkspaceForConversation } from "../src/main/services/workspaceContextResolver";
import { ensureDefaultMainAgent } from "../src/main/services/agentBootstrapService";
import { deleteSubAgent } from "../src/main/services/agentDeletionService";
import {
  getAgentSkillDetail,
  listAgentSkillCatalog
} from "../src/main/services/agentSkillCatalogService";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;
let previewProtocolRegistered = false;

protocol.registerSchemesAsPrivileged([
  {
    scheme: "agenthub-preview",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true
    }
  }
]);

type RunAgentIpcInput = RunAgentInput & {
  streamId?: string;
};

function getRendererEntry(): string {
  return path.join(__dirname, "../dist/renderer/index.html");
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    title: "AgentHub Desktop",
    backgroundColor: "#f6f3ee",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;

  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl).catch((error) => {
      console.error("Failed to load Vite dev server:", error);
    });
    return;
  }

  void mainWindow.loadFile(getRendererEntry()).catch((error) => {
    console.error("Failed to load renderer build:", error);
  });
}

function registerArtifactPreviewProtocol(): void {
  if (previewProtocolRegistered) {
    return;
  }

  previewProtocolRegistered = true;
  protocol.handle("agenthub-preview", (request) => {
    try {
      const url = new URL(request.url);

      if (url.hostname !== "artifact") {
        return new Response("Not found", { status: 404 });
      }

      const [artifactId, assetId] = url.pathname
        .split("/")
        .filter((part) => part.length > 0)
        .map((part) => decodeURIComponent(part));

      if (!artifactId || !assetId) {
        return new Response("Not found", { status: 404 });
      }

      const filePath = getArtifactRenderAssetFilePath(artifactId, assetId);
      return net.fetch(pathToFileURL(filePath).toString());
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load preview.";
      return new Response(message, { status: 404 });
    }
  });
}

ipcMain.handle(IPC_CHANNELS.PING, () => "pong");
ipcMain.handle(IPC_CHANNELS.WORKSPACE_SELECT_FOLDER, async () => {
  const dialogWindow = BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined;
  const dialogOptions: OpenDialogOptions = {
    title: "Open Local Code Folder",
    properties: ["openDirectory"]
  };
  const result = dialogWindow
    ? await dialog.showOpenDialog(dialogWindow, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return validateWorkspaceFolder(result.filePaths[0]);
});
ipcMain.handle(
  IPC_CHANNELS.WORKSPACE_PREPARE_CREATE,
  (_event, input: PrepareCreateWorkspaceInput) => prepareCreateWorkspace(input)
);
ipcMain.handle(
  IPC_CHANNELS.WORKSPACE_CREATE,
  (_event, input: CreateWorkspaceInput) => createWorkspaceFromFolder(input)
);
ipcMain.handle(IPC_CHANNELS.WORKSPACE_DELETE, (_event, workspaceId: string) =>
  deleteWorkspaceById(workspaceId)
);
ipcMain.handle(IPC_CHANNELS.WORKSPACE_LIST, () => listWorkspaces());
ipcMain.handle(IPC_CHANNELS.AGENT_LIST_BY_WORKSPACE, (_event, workspaceId: string) =>
  listAgentsByWorkspace(workspaceId)
);
ipcMain.handle(IPC_CHANNELS.AGENT_LIST_CONTACTS, () => listAgentContacts());
ipcMain.handle(IPC_CHANNELS.AGENT_ENSURE_DEFAULT_MAIN_AGENT, () => ensureDefaultMainAgent());
ipcMain.handle(
  IPC_CHANNELS.AGENT_CREATE_SUB_AGENT_MANUALLY,
  (_event, input: CreateSubAgentManuallyInput) => createSubAgentManually(input)
);
ipcMain.handle(IPC_CHANNELS.AGENT_DELETE, (_event, input: DeleteAgentInput) =>
  deleteSubAgent(input)
);
ipcMain.handle(
  IPC_CHANNELS.AGENT_UPDATE_STATUS,
  (_event, input: UpdateAgentStatusInput) => updateAgentStatus(input)
);
ipcMain.handle(IPC_CHANNELS.AGENT_UPDATE_PROFILE, (_event, input: UpdateAgentProfileInput) =>
  updateAgentProfile(input)
);
ipcMain.handle(
  IPC_CHANNELS.AGENT_UPDATE_DEFAULT_WORKSPACE,
  (_event, input: UpdateAgentDefaultWorkspaceInput) => updateAgentDefaultWorkspace(input)
);
ipcMain.handle(IPC_CHANNELS.AGENT_GET_STATUS, (_event, agentId: string) =>
  getAgentStatus(agentId)
);
ipcMain.handle(IPC_CHANNELS.SKILL_LIST_CATALOG, () => listAgentSkillCatalog());
ipcMain.handle(IPC_CHANNELS.SKILL_GET, (_event, skillId: string) =>
  getAgentSkillDetail(skillId)
);
ipcMain.handle(IPC_CHANNELS.AGENT_RUN, (event, input: RunAgentIpcInput) => {
  const stream: AgentRunStreamSink | undefined = input.streamId
    ? (payload) => {
        event.sender.send(`${IPC_CHANNELS.AGENT_RUN_STREAM}:${input.streamId}`, payload);
      }
    : undefined;

  return runAgent(input, undefined, undefined, undefined, stream);
});

type RunWithConversationIpcInput = RunWithConversationInput & {
  streamId?: string;
};

ipcMain.handle(
  IPC_CHANNELS.AGENT_RUN_WITH_CONVERSATION,
  (event, input: RunWithConversationIpcInput) => {
    const stream = input.streamId
      ? (payload: RunAgentStreamEvent) => {
          event.sender.send(
            `${IPC_CHANNELS.AGENT_RUN_WITH_CONVERSATION_STREAM}:${input.streamId}`,
            payload
          );
        }
      : undefined;

    return runAgentWithConversation(input, undefined, stream);
  }
);

type RunWithConversationUnifiedIpcInput = RunWithConversationUnifiedInput & {
  streamId?: string;
};

ipcMain.handle(
  IPC_CHANNELS.AGENT_RUN_WITH_CONVERSATION_UNIFIED,
  (event, input: RunWithConversationUnifiedIpcInput) => {
    const stream = input.streamId
      ? (payload: unknown) => {
          event.sender.send(
            `${IPC_CHANNELS.AGENT_RUN_WITH_CONVERSATION_UNIFIED_STREAM}:${input.streamId}`,
            payload
          );
        }
      : undefined;

    return runAgentWithConversationUnified(input, undefined, stream);
  }
);

ipcMain.handle(IPC_CHANNELS.AGENT_RUN_EVENT_LIST, (_event, conversationId: string) =>
  getAgentRunEventsByConversation(conversationId)
);

ipcMain.handle(IPC_CHANNELS.RUNTIME_CHECK_ALL, () => checkAllRuntimeProviders());
ipcMain.handle(IPC_CHANNELS.RUNTIME_CHECK, (_event, provider: RuntimeProvider) => {
  if (!isRuntimeProvider(provider)) {
    throw new Error("Runtime provider is invalid.");
  }

  return checkRuntimeProvider(provider);
});
ipcMain.handle(IPC_CHANNELS.CONVERSATION_LIST_BY_AGENT, (_event, agentId: string) =>
  listConversationsByAgent(agentId)
);
ipcMain.handle(IPC_CHANNELS.CONVERSATION_LIST_CHATS, () => listChats());
ipcMain.handle(
  IPC_CHANNELS.CONVERSATION_RESOLVE_WORKSPACE_CONTEXT,
  (_event, conversationId: string) =>
    resolveExecutionWorkspaceForConversation(conversationId).workspaceContext
);
ipcMain.handle(IPC_CHANNELS.CONVERSATION_FIND_OR_CREATE_DIRECT,
  (_event, agentId: string) => findOrCreateDirectConversationForAgent(agentId)
);
ipcMain.handle(IPC_CHANNELS.CONVERSATION_CREATE_DIRECT,
  (_event, agentId: string) => createDirectConversationForAgent(agentId)
);
ipcMain.handle(IPC_CHANNELS.CONVERSATION_DELETE, (_event, conversationId: string) =>
  deleteDirectConversation(conversationId)
);
ipcMain.handle(IPC_CHANNELS.AGENT_GET_PROFILE,
  (_event, agentId: string) => getAgentProfile(agentId)
);
ipcMain.handle(IPC_CHANNELS.MESSAGE_LIST, (_event, conversationId: string) =>
  listMessagesByConversation(conversationId)
);
ipcMain.handle(
  IPC_CHANNELS.MESSAGE_LIST_WITH_ARTIFACTS,
  (_event, conversationId: string) => listMessagesWithArtifactsByConversation(conversationId)
);
ipcMain.handle(IPC_CHANNELS.MESSAGE_CREATE, (_event, input: CreateMessageInput) =>
  createMessage(input)
);
ipcMain.handle(IPC_CHANNELS.NAVIGATION_GET_TREE, () => getNavigationTree());
ipcMain.handle(IPC_CHANNELS.FILE_TREE, (_event, input: ReadFileTreeInput) =>
  readFileTree(input)
);
ipcMain.handle(IPC_CHANNELS.FILE_READ, (_event, input: ReadFileInput) =>
  readWorkspaceFile(input)
);
ipcMain.handle(IPC_CHANNELS.ARTIFACT_CREATE, (_event, input: CreateArtifactInput) =>
  createArtifact(input)
);
ipcMain.handle(IPC_CHANNELS.ARTIFACT_LIST_BY_WORKSPACE, (_event, workspaceId: string) =>
  listArtifactsByWorkspace(workspaceId)
);
ipcMain.handle(IPC_CHANNELS.ARTIFACT_GET, (_event, input: string | PreviewArtifactInput) =>
  getArtifact(input)
);
ipcMain.handle(IPC_CHANNELS.ARTIFACT_RENDER, (_event, artifactId: string) =>
  renderArtifact(artifactId)
);
ipcMain.handle(
  IPC_CHANNELS.ARTIFACT_UPDATE_CONTENT,
  (_event, input: UpdateArtifactContentInput) => updateArtifactContent(input)
);
ipcMain.handle(
  IPC_CHANNELS.ARTIFACT_CREATE_DIFF,
  (_event, input: CreateArtifactDiffInput) => createDiffProposalFromArtifact(input)
);
ipcMain.handle(
  IPC_CHANNELS.DIFF_CREATE_PROPOSAL,
  (_event, input: CreateDiffProposalInput) => createDiffProposal(input)
);
ipcMain.handle(IPC_CHANNELS.DIFF_GET, (_event, diffProposalId: string) =>
  getDiffProposal(diffProposalId)
);
ipcMain.handle(IPC_CHANNELS.DIFF_LIST_BY_WORKSPACE, (_event, workspaceId: string) =>
  listDiffProposalsByWorkspace(workspaceId)
);
ipcMain.handle(IPC_CHANNELS.DIFF_APPLY, (_event, input: ApplyDiffInput) =>
  applyDiff(input)
);
ipcMain.handle(IPC_CHANNELS.DIFF_REJECT, (_event, input: RejectDiffInput) =>
  rejectDiffProposal(input)
);
ipcMain.handle(IPC_CHANNELS.GIT_STATUS, (_event, input: ReadGitStatusInput) =>
  readGitStatus(input)
);
ipcMain.handle(IPC_CHANNELS.GIT_DIFF, (_event, input: ReadGitDiffInput) =>
  readGitDiff(input)
);
// Group Chat IPC handlers

ipcMain.handle(
  IPC_CHANNELS.GROUP_CONVERSATION_CREATE,
  (_event, input: CreateGroupConversationInput) => createGroupConversation(input)
);

ipcMain.handle(
  IPC_CHANNELS.GROUP_CONVERSATION_LIST,
  (_event, workspaceId: string) => listGroupConversationsByWorkspace(workspaceId)
);
ipcMain.handle(IPC_CHANNELS.GROUP_CONVERSATION_LIST_ALL, () => listGroupConversations());
ipcMain.handle(
  IPC_CHANNELS.GROUP_CONVERSATION_UPDATE_PROFILE,
  (_event, input: UpdateGroupProfileInput) => updateGroupProfile(input)
);
ipcMain.handle(
  IPC_CHANNELS.GROUP_CONVERSATION_UPDATE_WORKSPACE,
  (_event, input: UpdateGroupWorkspaceInput) => updateGroupWorkspace(input)
);
ipcMain.handle(IPC_CHANNELS.GROUP_AVAILABLE_AGENT_LIST, (_event, conversationId: string) =>
  getAvailableAgentsForGroup(conversationId)
);

ipcMain.handle(IPC_CHANNELS.GROUP_CONVERSATION_GET_PROFILE, (_event, conversationId: string) =>
  getGroupProfile(conversationId)
);

ipcMain.handle(IPC_CHANNELS.GROUP_CONVERSATION_DELETE, (_event, conversationId: string) =>
  deleteGroupConversation(conversationId)
);

ipcMain.handle(IPC_CHANNELS.GROUP_MEMBER_ADD, (_event, input: AddGroupMemberInput) =>
  addAgentMember(input)
);

ipcMain.handle(IPC_CHANNELS.GROUP_MEMBER_ADD_MANY, (_event, input: AddGroupMembersInput) =>
  addAgentMembers(input)
);

ipcMain.handle(IPC_CHANNELS.GROUP_MEMBER_REMOVE, (_event, input: RemoveGroupMemberInput) =>
  removeAgentMember(input)
);

ipcMain.handle(IPC_CHANNELS.GROUP_MEMBER_LIST, (_event, conversationId: string) =>
  listGroupMembers(conversationId)
);

type GroupMessageIpcInput = SendGroupMessageInput & {
  dispatchStreamId?: string;
};

ipcMain.handle(
  IPC_CHANNELS.GROUP_MESSAGE_SEND,
  (event, input: GroupMessageIpcInput) => {
    const dispatchStream: DispatchStreamHandler | undefined = input.dispatchStreamId
      ? (dispatchEvent) => {
          event.sender.send(
            `${IPC_CHANNELS.DISPATCH_STREAM}:${input.dispatchStreamId}`,
            dispatchEvent
          );
        }
      : undefined;

    return handleGroupUserMessage(
      input.conversationId,
      input.content,
      input.mentionAgentIds,
      undefined,
      dispatchStream
    );
  }
);

ipcMain.handle(IPC_CHANNELS.GROUP_AGENT_LIST, (_event, conversationId: string) =>
  listGroupAgents(conversationId)
);

type GroupTaskDispatchIpcInput = DispatchGroupTasksInput & {
  dispatchStreamId?: string;
};

ipcMain.handle(
  IPC_CHANNELS.GROUP_TASK_DISPATCH,
  (event, input: GroupTaskDispatchIpcInput) => {
    const dispatchStream: DispatchStreamHandler | undefined = input.dispatchStreamId
      ? (dispatchEvent) => {
          event.sender.send(
            `${IPC_CHANNELS.DISPATCH_STREAM}:${input.dispatchStreamId}`,
            dispatchEvent
          );
        }
      : undefined;

    return dispatchGroupTasks(input, undefined, dispatchStream);
  }
);

ipcMain.handle(IPC_CHANNELS.DISPATCH_RUN_GET, (_event, runId: string) =>
  getDispatchRunById(runId)
);

ipcMain.handle(IPC_CHANNELS.DISPATCH_RUN_LIST, (_event, conversationId: string) =>
  getDispatchRunsByConversation(conversationId)
);

ipcMain.handle(IPC_CHANNELS.DISPATCH_EVENT_LIST, (_event, conversationId: string) =>
  getGroupRunEventsByConversation(conversationId)
);

type DispatchStepRetryIpcInput = {
  stepId: string;
  dispatchStreamId?: string;
};

ipcMain.handle(
  IPC_CHANNELS.DISPATCH_STEP_RETRY,
  (event, input: DispatchStepRetryIpcInput) => {
    const dispatchStream: DispatchStreamHandler | undefined = input.dispatchStreamId
      ? (dispatchEvent) => {
          event.sender.send(
            `${IPC_CHANNELS.DISPATCH_STREAM}:${input.dispatchStreamId}`,
            dispatchEvent
          );
        }
      : undefined;

    return retryDispatchStep(input.stepId, undefined, dispatchStream);
  }
);

ipcMain.handle(IPC_CHANNELS.MODEL_PROVIDER_LIST, () => listProviders());
ipcMain.handle(IPC_CHANNELS.MODEL_PROVIDER_GET, (_event, id: string) => getProvider(id));
ipcMain.handle(IPC_CHANNELS.MODEL_PROVIDER_SAVE, (_event, input) => saveProvider(input));
ipcMain.handle(IPC_CHANNELS.MODEL_PROVIDER_DELETE, (_event, id: string) => deleteProvider(id));
ipcMain.handle(IPC_CHANNELS.MODEL_PROVIDER_TEST, (_event, input) => testConnection(input));
ipcMain.handle(IPC_CHANNELS.MODEL_PROVIDER_HAS_ANY, () => hasAnyProvider());
ipcMain.handle(IPC_CHANNELS.MODEL_PROVIDER_CONTEXT_USAGE, (_event, input) =>
  getMainAgentContextUsage(input)
);

void app.whenReady().then(async () => {
  registerArtifactPreviewProtocol();
  setArtifactRenderNotifier((payload) => {
    mainWindow?.webContents.send(IPC_CHANNELS.ARTIFACT_RENDER_CHANGED, payload);
  });

  try {
    const db = initializeDatabase();
    await ensureDefaultMainAgent(db);
  } catch (error) {
    console.error("Failed to initialize local database or default main Agent:", error);
  }

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
