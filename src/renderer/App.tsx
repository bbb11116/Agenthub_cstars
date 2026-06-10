import { useEffect, useMemo, useState } from "react";
import type { Artifact } from "../shared/artifact";
import { ArtifactsTab } from "./features/artifacts/ArtifactsTab";
import { ChatWindow } from "./features/chat/ChatWindow";
import { ConversationSettingsDrawer } from "./features/chat/ConversationSettingsDrawer";
import { HistoryConversationsModal } from "./features/chat/HistoryConversationsModal";
import { AgentProfileView } from "./features/agents/AgentProfileView";
import { GroupProfileView } from "./features/groups/GroupProfileView";
import { DiffTab } from "./features/diff/DiffTab";
import { FilesTab } from "./features/files/FilesTab";
import { GitTab } from "./features/git/GitTab";
import { ArtifactOverlay, type ArtifactOverlayMode } from "./features/preview/ArtifactOverlay";
import { PreviewTab } from "./features/preview/PreviewTab";
import { RuntimeSettings } from "./features/settings/RuntimeSettings";
import { ModelProviderSettingsPage } from "./features/settings/ModelProviderSettingsPage";
import { OnboardingModelProviderPage } from "./features/settings/OnboardingModelProviderPage";
import { SkillLibraryView } from "./features/skills/SkillLibraryView";
import { AppIcon, type AppIconName } from "./components/ui/AppIcon";
import { Sidebar } from "./features/sidebar/Sidebar";
import { useWorkspaceStore } from "./state/workspaceStore";

type ApiState =
  | { status: "loading"; message: string }
  | { status: "empty"; message: string }
  | { status: "ready"; message: string }
  | { status: "error"; message: string };

const inspectorTabs = ["Files", "Artifacts", "Preview", "Diff", "Git", "Runtime"] as const;
type InspectorTab = (typeof inspectorTabs)[number];

const inspectorTabIcons: Record<InspectorTab, AppIconName> = {
  Files: "files",
  Artifacts: "artifacts",
  Preview: "preview",
  Diff: "diff",
  Git: "git",
  Runtime: "runtime"
};

function App() {
  const {
    activeAgent,
    activeConversation,
    activeWorkspace,
    appView,
    mainView,
    contacts,
    groupChats,
    initialized: workspaceInitialized,
    isPlaceholderConversationId,
    loadWorkspaces,
    selectChat,
    setAppView,
    startNewConversation
  } = useWorkspaceStore();

  const profileAgent = mainView.type === "agentProfile"
    ? contacts.find((a) => a.id === mainView.agentId) ?? null
    : null;
  const profileGroup = mainView.type === "groupProfile"
    ? groupChats.find((c) => c.id === mainView.conversationId) ?? null
    : null;
  const isSkillsView = mainView.type === "skillsLibrary";
  const isCreatingChat =
    mainView.type === "chat" && isPlaceholderConversationId(mainView.conversationId);
  const [apiState, setApiState] = useState<ApiState>({
    status: "loading",
    message: "Checking main process"
  });
  const [activeTab, setActiveTab] = useState<InspectorTab>("Files");
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [settingsDrawerOpen, setSettingsDrawerOpen] = useState(false);
  const [settingsDrawerAgentId, setSettingsDrawerAgentId] = useState<string | undefined>();
  const [historyModalOpen, setHistoryModalOpen] = useState(false);
  const [listPaneCollapsed, setListPaneCollapsed] = useState(false);
  const [artifactOverlay, setArtifactOverlay] = useState<{
    artifactId: string;
    mode: ArtifactOverlayMode;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function checkApi() {
      if (!window.agenthub) {
        setApiState({
          status: "error",
          message: "agenthub api unavailable"
        });
        return;
      }

      try {
        const result = await window.agenthub.ping();

        if (!cancelled) {
          setApiState({
            status: result === "pong" ? "ready" : "empty",
            message: result === "pong" ? "main process connected" : "unexpected ping response"
          });
        }
      } catch {
        if (!cancelled) {
          setApiState({
            status: "error",
            message: "main process ping failed"
          });
        }
      }
    }

    void checkApi();

    return () => {
      cancelled = true;
    };
  }, []);

  const statusLabel = useMemo(() => {
    switch (apiState.status) {
      case "loading":
        return "Loading";
      case "ready":
        return "Ready";
      case "empty":
        return "Empty";
      case "error":
        return "Error";
    }
  }, [apiState.status]);

  useEffect(() => {
    void loadWorkspaces();
  }, [loadWorkspaces]);

  useEffect(() => {
    setActiveArtifactId(null);
    setInspectorOpen(false);
    setSettingsDrawerOpen(false);
  }, [activeWorkspace?.id]);

  useEffect(() => {
    if (isSkillsView) {
      setInspectorOpen(false);
      setSettingsDrawerOpen(false);
    }
  }, [isSkillsView]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        if (artifactOverlay) {
          setArtifactOverlay(null);
          return;
        }
        setInspectorOpen(false);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [artifactOverlay]);

  useEffect(() => {
    function handleOpenConversationSettings(event: Event): void {
      const detail = (event as CustomEvent<{ agentId?: string; conversationId?: string }>).detail;
      if (detail?.conversationId) {
        selectChat(detail.conversationId);
      }
      setSettingsDrawerAgentId(detail?.agentId);
      setSettingsDrawerOpen(true);
    }

    window.addEventListener(
      "agenthub:open-conversation-settings",
      handleOpenConversationSettings
    );
    return () => {
      window.removeEventListener(
        "agenthub:open-conversation-settings",
        handleOpenConversationSettings
      );
    };
  }, [selectChat]);

  useEffect(() => {
    function handleOpenArtifact(event: Event): void {
      const detail = (event as CustomEvent<{ workspaceId?: string; artifactId?: string }>).detail;

      if (
        !detail?.artifactId ||
        !detail.workspaceId ||
        detail.workspaceId !== activeWorkspace?.id
      ) {
        return;
      }

      setActiveArtifactId(detail.artifactId);
      setActiveTab("Preview");
      setInspectorOpen(true);
    }

    window.addEventListener("agenthub:open-artifact", handleOpenArtifact);

    return () => {
      window.removeEventListener("agenthub:open-artifact", handleOpenArtifact);
    };
  }, [activeWorkspace?.id]);

  useEffect(() => {
    function handleOpenArtifactOverlay(event: Event): void {
      const detail = (
        event as CustomEvent<{ artifactId?: string; mode?: ArtifactOverlayMode }>
      ).detail;

      if (!detail?.artifactId) {
        return;
      }

      setArtifactOverlay({
        artifactId: detail.artifactId,
        mode: detail.mode === "editor" ? "editor" : "preview"
      });
    }

    function handleOpenInspectorEvent(event: Event): void {
      const detail = (event as CustomEvent<{ tab?: string }>).detail;
      const tab = detail?.tab;

      if (!tab || !inspectorTabs.includes(tab as InspectorTab)) {
        return;
      }

      setActiveTab(tab as InspectorTab);
      setInspectorOpen(true);
    }

    function handleOpenDiff(event: Event): void {
      const detail = (
        event as CustomEvent<{ workspaceId?: string; diffProposalId?: string }>
      ).detail;

      if (!detail?.diffProposalId || detail.workspaceId !== activeWorkspace?.id) {
        return;
      }

      setActiveTab("Diff");
      setInspectorOpen(true);
    }

    window.addEventListener("agenthub:open-artifact-overlay", handleOpenArtifactOverlay);
    window.addEventListener("agenthub:open-inspector", handleOpenInspectorEvent);
    window.addEventListener("agenthub:open-diff", handleOpenDiff);

    return () => {
      window.removeEventListener("agenthub:open-artifact-overlay", handleOpenArtifactOverlay);
      window.removeEventListener("agenthub:open-inspector", handleOpenInspectorEvent);
      window.removeEventListener("agenthub:open-diff", handleOpenDiff);
    };
  }, [activeWorkspace?.id]);

  function handleOpenArtifact(artifact: Artifact): void {
    setActiveArtifactId(artifact.id);
    setActiveTab(artifact.type === "diff" ? "Diff" : "Preview");
    setInspectorOpen(true);
  }

  function handleOpenInspector(tab: InspectorTab): void {
    setActiveTab(tab);
    setInspectorOpen(true);
  }

  if (appView === "loading" || !workspaceInitialized) {
    return (
      <main className="workspace-landing-shell">
        <span>Loading...</span>
      </main>
    );
  }

  if (appView === "onboarding") {
    return <OnboardingModelProviderPage />;
  }

  if (appView === "settings") {
    return (
      <main className="app-shell app-shell-settings">
        <Sidebar compact />
        <section className="settings-area" aria-label="Settings">
          <ModelProviderSettingsPage onBack={() => setAppView("main")} />
        </section>
      </main>
    );
  }

  return (
    <main className={listPaneCollapsed ? "app-shell list-pane-collapsed" : "app-shell"}>
      <Sidebar
        listPaneCollapsed={listPaneCollapsed}
        onListPaneChange={setListPaneCollapsed}
      />

      <section className="chat-area" aria-label="Chat area">
        <header className="chat-header">
          <div>
            <span className="eyebrow">
              {mainView.type === "agentProfile"
                ? "Agent Profile"
                : mainView.type === "groupProfile"
                  ? "Group Profile"
                  : mainView.type === "skillsLibrary"
                    ? "Skill Library"
                    : activeConversation?.type === "group"
                      ? "Group Chat"
                      : "Agent Chat"}
            </span>
            <h2>
              {mainView.type === "agentProfile"
                ? profileAgent?.name ?? "Agent"
                : mainView.type === "groupProfile"
                  ? profileGroup?.title ?? "群聊"
                  : mainView.type === "skillsLibrary"
                    ? "技能点"
                    : isCreatingChat
                      ? activeAgent?.name ?? "新对话"
                      : activeConversation?.type === "direct"
                        ? activeAgent?.name ?? activeConversation.title
                        : activeConversation?.title ?? "选择对话"}
            </h2>
          </div>
          <div className="chat-header-right">
            {isSkillsView ? null : (
              <div className="inspector-quick-actions" aria-label="Inspector shortcuts">
                {inspectorTabs.map((tab) => (
                  <button
                    key={tab}
                    className={inspectorOpen && activeTab === tab ? "active" : ""}
                    type="button"
                    title={tab}
                    aria-label={`打开 ${tab} Inspector`}
                    onClick={() => handleOpenInspector(tab)}
                  >
                    <AppIcon name={inspectorTabIcons[tab]} />
                  </button>
                ))}
              </div>
            )}
            <div className={`api-status api-status-${apiState.status}`} role="status">
              <span>{statusLabel}</span>
              <small>{apiState.message}</small>
            </div>
            <button
              className="new-conversation-button"
              type="button"
              disabled={
                !activeConversation ||
                isCreatingChat ||
                mainView.type === "agentProfile" ||
                mainView.type === "groupProfile" ||
                mainView.type === "skillsLibrary"
              }
              onClick={() => void startNewConversation()}
              aria-label="开启新对话"
              title="开启新对话"
            >
              <AppIcon name="sparkle" />
              <span>新对话</span>
            </button>
            <button
              className="history-conversation-button"
              type="button"
              disabled={
                !activeConversation ||
                mainView.type === "agentProfile" ||
                mainView.type === "groupProfile" ||
                mainView.type === "skillsLibrary"
              }
              onClick={() => setHistoryModalOpen(true)}
              aria-label="历史对话"
              title="历史对话"
            >
              <AppIcon name="chat" />
              <span>历史对话</span>
            </button>
            <button
              className="conversation-more-button"
              type="button"
              disabled={
                !activeConversation ||
                mainView.type === "agentProfile" ||
                mainView.type === "groupProfile" ||
                mainView.type === "skillsLibrary"
              }
              onClick={() => setSettingsDrawerOpen(true)}
              aria-label="Conversation settings"
            >
              ...
            </button>
          </div>
        </header>

        {mainView.type === "agentProfile" ? (
          <AgentProfileView agentId={mainView.agentId} />
        ) : mainView.type === "groupProfile" ? (
          <GroupProfileView conversationId={mainView.conversationId} />
        ) : mainView.type === "skillsLibrary" ? (
          <SkillLibraryView />
        ) : isCreatingChat ? (
          <CreatingChatPlaceholder agentId={activeAgent?.id ?? null} />
        ) : (
          <ChatWindow />
        )}
        <ConversationSettingsDrawer
          open={settingsDrawerOpen}
          onClose={() => setSettingsDrawerOpen(false)}
          agentId={settingsDrawerAgentId}
        />
        <HistoryConversationsModal
          open={historyModalOpen}
          onClose={() => setHistoryModalOpen(false)}
        />
      </section>

      {inspectorOpen ? (
        <button
          className="inspector-scrim"
          type="button"
          aria-label="关闭 Inspector"
          onClick={() => setInspectorOpen(false)}
        />
      ) : null}

      <aside
        className={inspectorOpen ? "inspector inspector-drawer open" : "inspector inspector-drawer"}
        aria-label="Inspector panel"
        aria-hidden={!inspectorOpen}
      >
        <div className="panel-header inspector-drawer-header">
          <div>
            <span className="eyebrow">Inspector</span>
            <h2>{activeTab}</h2>
          </div>
          <button
            className="inspector-close-button"
            type="button"
            aria-label="关闭 Inspector"
            onClick={() => setInspectorOpen(false)}
          >
            <AppIcon name="close" />
          </button>
        </div>

        <div className="inspector-tabs" role="tablist" aria-label="Inspector tabs">
          {inspectorTabs.map((tab) => (
            <button
              key={tab}
              className={tab === activeTab ? "active" : ""}
              type="button"
              role="tab"
              aria-label={`${tab} Inspector`}
              aria-selected={tab === activeTab}
              onClick={() => setActiveTab(tab)}
            >
              {tab}
            </button>
          ))}
        </div>

        <div className="inspector-content">
          {activeTab === "Files" ? (
            <FilesTab />
          ) : activeTab === "Artifacts" ? (
            <ArtifactsTab
              activeArtifactId={activeArtifactId}
              onOpenArtifact={handleOpenArtifact}
            />
          ) : activeTab === "Preview" ? (
            <PreviewTab
              artifactId={activeArtifactId}
              onOpenDiff={() => setActiveTab("Diff")}
            />
          ) : activeTab === "Diff" ? (
            <DiffTab />
          ) : activeTab === "Runtime" ? (
            <RuntimeSettings />
          ) : activeTab === "Git" ? (
            <GitTab />
          ) : null}
        </div>
      </aside>

      {artifactOverlay ? (
        <ArtifactOverlay
          artifactId={artifactOverlay.artifactId}
          initialMode={artifactOverlay.mode}
          onClose={() => setArtifactOverlay(null)}
        />
      ) : null}
    </main>
  );
}

function CreatingChatPlaceholder({ agentId }: { agentId: string | null }): JSX.Element {
  return (
    <div className="chat-creating-placeholder" role="status" aria-live="polite">
      <p>正在为 {agentId ? "该 Agent" : "你"} 创建对话…</p>
    </div>
  );
}

export default App;
