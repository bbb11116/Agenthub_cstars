# AgentHub 架构

本文档只记录当前代码中可直接验证的事实，不包含推测、规划或历史。所有声明都给出对应的源码位置以便核对。

> 适用范围：截至 2026-06-04 的工作树。任何后续重命名 / 重构都需要同步更新本文档。

## 1. 技术栈与运行形态

- 桌面应用，基于 **Electron 31** (`package.json:54`)，主进程与渲染进程均用 **TypeScript 5.5** (`package.json:60`)，ESM 模式 (`"type": "module"`, `package.json:3`)。
- 渲染层 **React 18** + 严格模式 (`src/renderer/main.tsx:6-10`)，由 Vite 5 驱动。
- 主进程持久化使用 **better-sqlite3 12** (`package.json:36`)，开启 WAL 与外键 (`src/main/db/index.ts:54-55`)。
- 启动后形成一个主窗口 (1440×900) (`electron/main.ts:154-168`)，窗口选项：`contextIsolation: true`, `nodeIntegration: false`, `sandbox: false`，预加载脚本 `dist-electron/preload.cjs`。
- 平台分支仅在 `app.on("window-all-closed")` 上判断 `darwin` 不退出 (`electron/main.ts:518-522`)；其它代码不做平台差异。

## 2. 顶层目录与构建产物

```
electron/          主进程入口 (TypeScript 源码)
  main.ts          Electron 入口、IPC 注册、窗口管理
  preload.ts       contextBridge 暴露 window.agenthub
src/
  main/            主进程业务代码 (services、db、config、demo)
  renderer/        React 渲染层
  shared/          主 / 渲染进程共享的类型与契约
scripts/           原生模块重编译脚本
tests/             e2e 测试 (vitest)
dist/renderer/     Vite 渲染层产物 (vite.config.ts:44)
dist-electron/     主进程 / 预加载产物 (vite.config.ts:18, 32)
```

构建链路见 `vite.config.ts:10-42`：`vite-plugin-electron/simple` 同时打包 `electron/main.ts → dist-electron/main.js` 与 `electron/preload.ts → dist-electron/preload.cjs`；`better-sqlite3` 显式声明为 `external` (`vite.config.ts:20`)，不参与 Rollup 打包，由 Node 运行时通过 `require` 加载原生模块。

`tsconfig.json` 是单项目配置 (`noEmit: true`)，只做类型检查 (`tsconfig.json:2-19`)，无 `references`，所有源文件在同一个编译图内 (`tsconfig.json:20-26`)。

## 3. 进程模型与启动顺序

`electron/main.ts`：

1. `augmentProcessPath()` (`electron/main.ts:6-22`)：在 `PATH` 前插入 `~/.npm-global/bin`、`~/.local/bin`、`/opt/homebrew/bin`、`/usr/local/bin`，确保在终端之外也能找到 `codex` / `claude` 等 CLI。
2. 顶层导入 `IPC_CHANNELS` 与各 service。
3. `app.whenReady().then(...)` (`electron/main.ts:501-516`)：
   - `initializeDatabase()` → 建表 / 跑迁移 (`src/main/db/index.ts:38-65`)。
   - `ensureDefaultMainAgent(db)`：保证每个工作区有 main Agent。
   - `createWindow()`：`new BrowserWindow(...)` → 加载 `VITE_DEV_SERVER_URL`（存在时）或 `dist/renderer/index.html`。
4. `app.on("window-all-closed")` 仅在非 macOS 退出 (`electron/main.ts:518-522`)。

预加载脚本导出唯一的全局对象 `agenthub` (`electron/preload.ts:289`)，类型契约见 `src/shared/types.ts:404-421` 的 `AgentHubApi`。

## 4. IPC 层

### 4.1 通道清单

`src/shared/ipcChannels.ts:1-72` 定义约 60 个通道字符串常量，按命名空间分组：

| 命名空间 | 数量级 | 典型通道 |
| --- | --- | --- |
| `app` | 1 | `app:ping` |
| `workspace` | 5 | `workspace:create` / `workspace:list` / `workspace:delete` |
| `agent` | 10+ | `agent:run` / `agent:run-stream` / `agent:create-sub-agent-manually` / `agent:get-profile` |
| `runtime` | 2 | `runtime:check` / `runtime:check-all` |
| `conversation` | 4 | `conversation:list-by-agent` / `conversation:resolve-workspace-context` |
| `message` | 3 | `message:list` / `message:list-with-artifacts` / `message:create` |
| `navigation` / `file` / `artifact` / `diff` / `git` | 各 1–5 | `file:tree` / `diff:apply` / `git:status` 等 |
| `group-conversation` / `group-member` / `group-message` / `dispatch` / `group-agent` | 10+ | `group-message:send` / `dispatch:stream` / `dispatch-step:retry` |
| `model-provider` | 7 | `model-provider:save` / `model-provider:test` / `model-provider:context-usage` |

### 4.2 通信模式

- **请求 / 响应**：`ipcMain.handle(channel, fn)` ↔ `ipcRenderer.invoke(channel, args)`，主进程入口处逐条注册 (`electron/main.ts:188-499`)。例：`workspace:create` (`electron/main.ts:209-212`)。
- **流式响应**：主进程无法主动推送，所以采用“**带 streamId 的 invoke + 同名 `:${streamId}` 通道**”模式：
  - 调用方传入 `streamId`（渲染端由 `preload.ts:17-19` 的 `createStreamId()` 生成）。
  - 主进程在 handler 内构造一个 `sink = payload => event.sender.send(\`${channel}:${streamId}\`, payload)`，并把 sink 透传给 `runAgent` 等 (`electron/main.ts:243-251`)。
  - 渲染端 preload 监听 `:${streamId}` 通道 (`electron/preload.ts:36-46`)，通过 `streamHandlers.onTextDelta` 回调；`invoke` 返回的 Promise `.finally` 里 `removeListener`。
  - 受影响的通道至少包含：`agent:run` / `agent:run-with-conversation` / `agent:run-with-conversation-unified` / `group-message:send` / `group-task:dispatch` / `dispatch-step:retry`。

### 4.3 暴露面

`electron/preload.ts:49-287` 的 `agenthubApi` 是一个嵌套命名空间对象（`workspace.*` / `agent.*` / `runtime.*` / `conversation.*` / `message.*` / `navigation.*` / `file.*` / `artifact.*` / `diff.*` / `git.*` / `groupConversation.*` / `groupMember.*` / `groupMessage.*` / `dispatch.*` / `modelProvider.*` + `ping`），与 `src/shared/types.ts` 中的 `AgentHubApi` 接口一一对应。

## 5. 持久层

### 5.1 数据库

- 引擎：`better-sqlite3`（同步 API），`journal_mode = WAL`，`foreign_keys = ON` (`src/main/db/index.ts:54-55`)。
- 路径：`<electron userData>/agenthub.db` (`src/main/db/index.ts:34-36`)，由 `initializeDatabase()` 在 `app.whenReady` 中创建。
- 单例：`currentDatabase` (`src/main/db/index.ts:21`)，`getDatabase()` 优先返回已开连接 (`src/main/db/index.ts:67-69`)。
- 工具：`stringifyJsonField` / `parseJsonField` 用于 JSON 列读写 (`src/main/db/index.ts:79-90`)。

### 5.2 表结构（`src/main/db/schema.ts:392-738`）

`initializeSchema` 一次性建表（`CREATE TABLE IF NOT EXISTS` + 索引），随后调用 16 个 `ensureXxxColumn` / `ensureXxxTable` 函数做幂等的 `ALTER TABLE` 迁移。核心表：

- `workspaces` / `workspace_contexts`：工作区与“工作区上下文”（一份目录绑定，可被 Agent、Group、Conversation 各自引用）。
- `agents`：Agent 实体；含 `role` (`main` | `sub`)、`type` (`orchestrator` | `specialist`，由 `ensureAgentTypeColumn` 迁自 `role=main`) 状态枚举（`draft` / `available` / `running` / `error` / `unavailable` / `disabled` / `deleted`）、`runtime_provider`、`system_prompt`、`capabilities`、`tools`、`file_scope`、`claude_code_config`、`model_provider_id`、`model`、`avatar`、`description`。
- `conversations`：单聊与群聊共用一张表，区分靠 `type` (`direct` | `group`)，并携带 `mode` (`single` | `main_agent_setup`)、`workspace_context_id`、`auto_dispatch_enabled` 等列。
- `messages` + `message_artifacts`：消息分两种存储结构，新版走 `message_artifacts` 表 (`src/main/db/schema.ts:272-292`)；`messages` 表上有 `status` / `mention_agent_ids` / `dispatch_run_id` / `dispatch_step_id` / `reply_to_message_id` / `updated_at` / `metadata` / `content_markdown` 多列追加迁移。
- `diff_proposals` + `artifacts`：diff 与产物主表。
- `conversation_compact_summaries`、`agent_drafts`（旧流程，列保留为兼容）。
- `conversation_members`：群成员（user/agent，UNIQUE `(conversation_id, member_type, member_id)`）。
- `dispatch_runs` + `dispatch_steps` + `group_run_events`：群聊调度。
- `conversation_provider_sessions`（v1，含 v1 `idx_prov_sessions_unique` 唯一索引补建，`src/main/db/schema.ts:318-331`）和 `conversation_provider_sessions_v2`（按 `agent_id` / `workspace_context_id` / `execution_scope` 区分）。
- `agent_runs`：单次 Agent 执行的元数据与快照（`mode` / `iterations_used` / `raw_output` / `used_fallback` 等列由 `ensureAgentRunExecutionColumns` 追加，`src/main/db/schema.ts:333-360`）。
- `agent_run_events` + `group_run_events`：统一事件流持久化。
- `agent_project_experiences`：Agent 在群聊中的经验沉淀，`UNIQUE(agent_id, group_conversation_id)` (`src/main/db/schema.ts:707-708`)。

### 5.3 仓储层

`src/main/db/repositories/` 下一个聚合一个文件（`agentRepo.ts` / `conversationRepo.ts` / `messageRepo.ts` / `dispatchRunRepo.ts` / `dispatchStepRepo.ts` / `groupRunEventRepo.ts` / `agentRunEventRepo.ts` / `providerSessionRepo.ts` / `workspaceRepo.ts` / `workspaceContextRepo.ts` / …），与 `services/` 中的业务逻辑解耦。

## 6. 业务服务

`src/main/services/` 下的模块大致可分为三类：单聊流、群聊 / 调度、配置 / 工具。

### 6.1 单聊 Agent 执行

`src/main/services/agentRunService.ts`：

- `runAgent(input, db?, checkRuntime?, runTask?, stream?)` (`src/main/services/agentRunService.ts:568-681`) 是顶层入口。
- 流程：参数校验 → `getRunContext` 取 Agent / Workspace / Conversation → `checkRuntimeProvider` 检查 runtimeProvider 可用 → 把 Agent 状态置 `running`（mock provider 还会写一条 `agent_status` 卡片消息）→ `defaultAgentTaskRunner` → 把 Agent 状态切到 `available` / `error` / `unavailable`，落回 `agent_status` 消息。
- `defaultAgentTaskRunner` (`src/main/services/agentRunService.ts:282-314`) 分两路：
  - `agent.runtimeProvider === "mock"` → `runMockAgentTask`（demo 模式，`src/main/demo/demoAgentRunner.ts`）。
  - 其余 → `runLocalAgentTask` (`src/main/services/agentRunService.ts:365-566`)：消费 `runLocalAgent` 的事件流，把 `stdout` 累计并通过 `stream` 回调 `text_delta`；退出后由 `createDiffProposalFromText`（`src/main/services/diffProposalTextService.ts`）尝试把 stdout 解析成 DiffProposal。
- `localRuntimeRunner.ts` (`src/main/services/localRuntimeRunner.ts`)：本地 CLI 适配层。`getProviderCommand` (`src/main/services/localRuntimeRunner.ts:51-64`) 把 runtimeProvider 映射到命令：`codex_local → codex`、`claude_code → claude`、`opencode → opencode`，`mock` / `builtin_*` 返回 `null`。`buildLocalRuntimeCommand` (`src/main/services/localRuntimeRunner.ts:158-204`) 构造 `LocalRuntimeCommand`，`assertWorkspaceRootPath` / `assertCommandSafe` 做基本防御（拒绝 `cwd` 离开 workspace 根目录、拒绝 `--danger-full-access` / `--yolo`）。`runLocalAgent` (`src/main/services/localRuntimeRunner.ts:254-420`) 是 `async function*`，按 `started` / `stdout` / `stderr` / `exited` / `error` / `artifact` / `diff_proposal` 投递事件。

### 6.2 内置 LLM 与统一事件流

群聊与带会话上下文的单聊会走另一条管线：

- `src/main/services/agentRunWithConversationService.ts` 暴露 `runAgentWithConversation` / `runAgentWithConversationUnified`，对应 `agent:run-with-conversation` / `agent:run-with-conversation-unified`。
- 它们通过 `src/main/services/streamingRunService.ts` 与 `src/main/services/adapters/` 中的适配器交互：
  - `builtinAgentAdapter.ts`：内置 LLM 路径，调用 `llmRouter.callLLM` / `callLLMStream` (`src/main/services/adapters/builtinAgentAdapter.ts:6`)，把 `contextMessages` 拼成 OpenAI / Anthropic 消息格式。支持的 `apiFormat`：`openai_chat_completions` / `anthropic_messages`（见 `src/shared/types.ts:362-374`）。
  - `claudeCodeAdapter.ts` / `codexAdapter.ts` / `openCodeAdapter.ts`：把 CLI runtime 也封装成 `AgentAdapter`，对外呈现统一的 `AsyncIterable<AgentEvent>`。
  - `unifiedAgentProviderAdapter.ts`：把任意 `AgentAdapter` 的 `AgentEvent` 流翻译成 `AgentRunEvent`（`run.started` / `message.delta` / `tool.*` / `command.*` / `file.*` / `diff.*` / `error` / `message.completed` / `run.completed|run.failed`），并把每条事件持久化到 `agent_run_events`，使得前端刷新后能从数据库回放整段助手响应 (`src/main/services/adapters/unifiedAgentProviderAdapter.ts:25-30`)。
- `src/main/services/llmRouter.ts`（已读前 60 行）是 LLM 调用路由器；模型清单、限速、流式解析都在这里。

### 6.3 Runtime 健康检查

`src/main/services/runtimeService.ts:181-216` 的 `checkRuntimeProvider`：

- `mock` / `builtin_openai` / `builtin_anthropic` 立即返回 `available: true` (`src/main/services/runtimeService.ts:186-192`)。
- 其余 (`codex_local` / `claude_code` / `opencode`) 走 `runVersionCommand`，`spawn(command, ["--version"], { shell: false })` + 3 秒超时 (`src/main/services/runtimeService.ts:114-179`)。
- Windows 平台若 `command not found`，回退到 `shell: true` (`src/main/services/runtimeService.ts:197-199`)。

### 6.4 群聊 / 调度

- 入口 `src/main/services/dispatchService.ts`：`handleGroupUserMessage`、`retryDispatchStep`、`dispatchGroupTasks`。
- 主 Agent 决策：`src/main/services/orchestratorRuntimeService.ts`、`mainAgentDecision.ts`、`orchestratorSystemPrompt.ts`、`mainAgentContextService.ts` —— 通过 LLM 解析出 `DispatchPlan`（步骤、Agent 分派、可选 `AgentAssignment`、验收标准 `AcceptanceCriterion`）。
- 步骤执行：每个 `dispatch_step` 调用 `runAgent` 跑对应 sub-Agent，回填 `subagent_result`、`output_message_id` 等 (`src/main/db/schema.ts:589-608`)。
- 编排：接受度复核（`groupExecutionService.ts`）、diff 复核（main agent 再走一轮决策）、`MAX_DISPATCH_STEPS`（`src/shared/groupChat.ts`）等常量。
- 事件流：`DispatchRunStreamEvent` 推送到 `dispatch:stream:${dispatchStreamId}`（`electron/main.ts:415-422`）；持久化到 `group_run_events` (`src/main/db/schema.ts:251-270`)。

### 6.5 配置 / 模型提供者

- 全局配置文件：`~/.agenthub/settings.json`（`GlobalSettings`，含 `modelProviders[]` 与 `defaults`），旧文件 `~/.agenthub/config.json` 仍被识别做兼容回退 (`src/main/config/agenthub-config-loader.ts:19-22`)。
- `src/main/config/agenthub-config-schema.ts:1-54` 给出 schema：`ModelProviderConfig` / `MainAgentConfig` / `GroupChatConfig` / `AgentDefaultsConfig` / `GlobalSettings` / `WorkspaceSettings` / `WorkspaceLocalSettings`。
- 密钥管理：`src/main/config/secret-resolver.ts`（env: 前缀引用、平台 Keychain 落盘等）。`ModelProviderService` (`src/main/services/modelProviderService.ts`) 增删改查 + `testConnection`；API 端点拼装在 `resolveEndpoint` (`src/main/services/modelProviderService.ts:25-48`)：OpenAI → `/v1/chat/completions`，Anthropic → `/v1/messages`。
- 上下文窗口：默认 256k，开启 1M (`src/shared/modelProvider.ts:1-3`)。
- `agenthub-config-merge.ts` / `agent-file-loader.ts` / `provider-env-resolver.ts` 负责工作区级 `.agenthub/` 配置与 per-Agent 文件加载。

### 6.6 其它工具服务

- `fileService.ts`：`readFileTree` / `readWorkspaceFile`，受 `pathGuard.ts` 限制在 workspace 根目录内。
- `diffService.ts` / `diffProposalTextService.ts`：diff 提案的创建、解析、apply、reject。
- `gitService.ts`：通过 `git` CLI 调 `status` / `diff`。
- `artifactService.ts`：artifact 落盘与读取。
- `agentService.ts` / `agentBootstrapService.ts` / `agentDeletionService.ts`：Agent CRUD、默认主 Agent 兜底、删除清理。
- `conversationService.ts` / `messageService.ts`：会话与消息。
- `navigationService.ts`：渲染侧边栏的导航树 (`WorkspaceTreeDTO`)。
- `tokenEstimator.ts`、`sseParser.ts`、`skillRegistry.ts`、`toolPermissionService.ts`、`conversationRunLock.ts`、`workspaceContextResolver.ts`、`agentProjectExperienceService.ts` 等。

## 7. 渲染层

- 入口 `src/renderer/main.tsx`：`ReactDOM.createRoot(...).render(<StrictMode><App /></StrictMode>)`。
- `src/renderer/App.tsx` 是顶层壳：
  - 顶层状态机 `appView: "loading" | "onboarding" | "settings" | "main"` (`src/renderer/App.tsx:19-24`)。
  - 主视图 `mainView: "chat" | "agentProfile" | "groupProfile" | "contactsHome" | "settings"` (`src/renderer/state/workspaceStore.ts:27-32`)。
  - 侧栏 Inspector tabs：`Files` / `Artifacts` / `Preview` / `Diff` / `Git` / `Runtime` (`src/renderer/App.tsx:25-35`)。
  - 启动时 `window.agenthub.ping()` 探测主进程 (`src/renderer/App.tsx:71-107`)，结果用 `api-state` 角标显示。
  - 监听若干 `window.dispatchEvent(new CustomEvent(...))`：`agenthub:open-conversation-settings` / `agenthub:open-artifact` / `agenthub:open-inspector` / `agenthub:open-diff` (`src/renderer/App.tsx:145-224`)。
- 状态：`src/renderer/state/workspaceStore.ts` 用 `useSyncExternalStore` (从第 1 行可见) 暴露一整个 `WorkspaceStoreState`，包含 workspaces、navigationTree、agents、conversations、groupChats、members、dispatchRuns、dispatchSteps、messages、activeRunId、contacts、chats、activeWorkspaceContext 等。`conversationStore.ts` 与 `agentStore.ts` 都是从 `workspaceStore` 派生的子集。
- 目录划分：
  - `features/sidebar/`：工作区树 (`WorkspaceTree`)、Agent 节点、Conversation 节点、Group 节点。
  - `features/chat/`：`ChatWindow`（单聊）、`GroupChatWindow`（群聊）、`MessageList` / `MessageRenderer` / `MessageComposer` / `MentionInput` / `MessageMarkdown` / `MessageArtifacts` / `CodeBlock` / `CopyMenu` / `GroupMemberStrip` / `GroupMemberPanel` / `GroupRunTimeline` / `DispatchPlanCard` / `DiffProposalCard` / `CreateGroupChatEntry` / `ConversationSettingsDrawer`。
  - `features/workspace/`、`features/agents/`、`features/groups/`、`features/artifacts/`、`features/diff/`、`features/files/`、`features/git/`、`features/preview/`。
  - `features/settings/`：`RuntimeSettings`、`ModelProviderList` / `ModelProviderForm` / `ModelProviderSettingsPage` / `OnboardingModelProviderPage`。
- Markdown 渲染：`react-markdown` + `remark-gfm` + `rehype-sanitize` + `rehype-stringify` + `lowlight` (highlight.js) (`package.json:38-45`)。
- 与主进程通信：所有调用都走 `window.agenthub.<namespace>.<method>(...)`，例如 `window.agenthub.workspace.list()` (`src/renderer/state/workspaceStore.ts:51-66` 可见调用方式)。

## 8. 测试

- 框架：vitest 4 (`package.json:62`)。
- 单元测试与源文件同目录：`*.test.ts`，如 `src/main/db/dbSmoke.test.ts`、`src/main/services/agentRunService.test.ts`、`src/main/services/orchestratorSystemPrompt.test.ts`、`src/main/config/configSecurity.test.ts`。
- E2E：`tests/e2e/mvpFlow.test.ts` —— 跑完整链路：建临时目录 → `createDemoReactProject` + `initializeDemoGitRepository` → `initializeDatabase` → `createWorkspaceFromFolder` → `createSubAgentManually` → `runAgentTask` (mock runtime) → `applyDiff` → `readGitStatus` 校验。
- npm scripts：
  - `test` = `rebuild:node` + `vitest run` (`package.json:8`)。
  - `test:db` = `rebuild:node` + `vitest run src/main/db/dbSmoke.test.ts`。
  - `test:e2e` = `rebuild:node` + `vitest run tests/e2e/mvpFlow.test.ts`。
  - `dev` / `start` 同样先 `rebuild:electron`，再启动 (`package.json:6, 14`)。

## 9. 原生模块与多 ABI

- `better-sqlite3` 是原生模块，Node 与 Electron 各有 ABI。脚本 `scripts/rebuild-electron-native.cjs`：
  - 先用 `ELECTRON_RUN_AS_NODE=1` 启动一次 Electron 跑 `:memory:` SQLite 自检，OK 即返回 (`scripts/rebuild-electron-native.cjs:19-47`)。
  - 否则 `npm rebuild better-sqlite3` 并设 `npm_config_runtime=electron` / `npm_config_target=<electron 版本>` / `npm_config_disturl=https://electronjs.org/headers` (`scripts/rebuild-electron-native.cjs:53-63`)。
- `rebuild:node` 仅 `npm rebuild better-sqlite3`，无 env 注入 (`package.json:11`)。
- 同一份 `node_modules/better-sqlite3/build/Release/better_sqlite3.node` 只能匹配一个 ABI，切换 Node ↔ Electron 需要重新编译，dev / start / test 脚本里都已经把这一步串好。

## 10. 依赖一览

来自 `package.json` 现状：

- 运行时：`better-sqlite3@^12.10.0`、`react@^18.3.1`、`react-dom@^18.3.1`、`react-markdown@^10.1.0`、`unified@^11.0.5`、`remark-parse` / `remark-gfm` / `rehype-sanitize` / `rehype-stringify` / `lowlight@^3.3.0` / `highlight.js@^11.11.1`。
- 开发：`electron@^31.0.0`、`vite@^5.4.0`、`vite-plugin-electron@^0.29.0`、`@vitejs/plugin-react@^4.3.0`、`vitest@^4.1.7`、`typescript@^5.5.0`、`@types/node@^20.14.0`、`@types/better-sqlite3@^7.6.13`。
- `engines` 字段未声明在 `package.json`（已核对），由 `better-sqlite3@12.10.0` 自带 `engines.node: "20.x || 22.x || 23.x || 24.x || 25.x || 26.x"`。
