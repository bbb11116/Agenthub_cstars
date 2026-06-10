# AgentHub 项目基础信息汇总

> 截至 2026-06-09 工作树。所有声明均给出对应的源码位置以便核对。
> 与 `ARCHITECTURE.md`（聚焦技术栈与代码契约）互补，本文从「产品视角」梳理全局架构、功能模块、层级分布、记忆系统、页面布局与前后端契约。

---

## 0. 一句话定位

**AgentHub 是一款本地优先的桌面 AI 协作应用**：用户选定一个本地代码目录作为 Workspace，Workspace 内可创建多个 **Agent**（main / sub），支持单聊（与一个 Agent 对话）和群聊（Orchestrator 把任务分派给多个 sub-Agent 并行执行）。Agent 可以是内置 LLM，也可以把本地 CLI（codex / claude / opencode）包装成统一适配器。

---

## 1. 技术栈一览

| 维度 | 选型 | 来源 |
| --- | --- | --- |
| 桌面壳 | Electron 31，1440×900 主窗口，contextIsolation on | `package.json:54`、`electron/main.ts:154-168` |
| 语言 | TypeScript 5.5，ESM，`"type":"module"` | `package.json:3,60` |
| 渲染层 | React 18 + StrictMode + Vite 5 | `package.json:53`、`src/renderer/main.tsx:6-10` |
| 持久化 | better-sqlite3 12（WAL + 外键开） | `package.json:36`、`src/main/db/index.ts:54-55` |
| Markdown | react-markdown + remark-gfm + rehype-sanitize + lowlight(highlight.js) | `package.json:38-45` |
| 构建 | vite + vite-plugin-electron，better-sqlite3 显式 external | `vite.config.ts:10-42` |
| 测试 | vitest 4（单测随源文件、e2e 走 `tests/e2e/`） | `package.json:62` |

---

## 2. 全局架构（三进程三契约）

```
┌────────────────────────────── Renderer (React 18) ──────────────────────────────┐
│                                                                                  │
│  App.tsx ─┬─ Sidebar          ChatWindow ── MessageList ── MessageRenderer        │
│           │                  GroupChatWindow                                     │
│           │                  AgentProfileView / GroupProfileView / SkillLibrary   │
│           │                  Settings 路由:  onboarding / settings                │
│           │                                                                            │
│           └── Inspector Drawer ── Files / Artifacts / Preview / Diff / Git / Runtime│
│                                                                                  │
│   state:  workspaceStore (useSyncExternalStore)  ←  唯一全局 store                │
│                                                                                  │
│   ─────────── 走 window.agenthub.*  ───────────                                    │
└──────────────────────────────────────┬───────────────────────────────────────────┘
                                       │ contextBridge
┌──────────────────────────────────────┴───────────────────────────────────────────┐
│                       Preload (electron/preload.ts)                                │
│   把约 60 个 ipcRenderer.invoke / on 包装成命名空间对象 window.agenthub.*           │
└──────────────────────────────────────┬───────────────────────────────────────────┘
                                       │ IPC
┌──────────────────────────────────────┴───────────────────────────────────────────┐
│                            Electron Main Process                                    │
│                                                                                    │
│  IPC handlers  ─►  services/*  ─►  db/repositories/*  ─►  better-sqlite3            │
│                       │                                                                │
│                       ├─► adapters (builtin / claude_code / codex / opencode)        │
│                       ├─► llmRouter (OpenAI / Anthropic 协议)                          │
│                       ├─► streamingRunService (统一事件流)                              │
│                       └─► conversationContextService + memoryContextService (记忆)      │
│                                                                                        │
│  自定义协议:  agenthub-preview://artifact/<id>/<asset>   (artifacts 预览)               │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

**三条核心契约：**

1. **IPC 通道** — `src/shared/ipcChannels.ts` 单一来源，~60 个 `命名空间:动作` 字符串。
2. **API 类型** — `src/shared/types.ts:404-421` 的 `AgentHubApi` 接口；`preload.ts` 严格实现之。
3. **统一事件协议** — `src/shared/agentRunEvent.ts` 的 `AgentRunEvent` 是 Agent 执行的统一事件类型；`unifiedAgentProviderAdapter` 把任意 `AgentAdapter` 的输出翻成它，并持久化到 `agent_run_events`，前端可重放。

---

## 3. 顶层目录

```
electron/                    主进程入口 (TypeScript 源码，不参与 vite renderer 构建)
  main.ts                    Electron 入口、IPC 注册、窗口管理
  preload.ts                 contextBridge 暴露 window.agenthub

src/
  main/                      主进程业务代码
    config/                  settings.json / .agenthub/ 加载、合并、密钥解析
    db/                      better-sqlite3 schema + repositories/
    demo/                    mock runtime fixtures
    services/                业务服务（~50 个 *.ts）
      adapters/              builtin / claude_code / codex / opencode 适配器
      dispatch/              Agent 评分、@mention 解析
    utils/                   pathGuard、hash、commandRunner、unifiedDiff
  renderer/                  React 渲染层
    App.tsx                  顶层 shell
    main.tsx                 ReactDOM 入口
    components/ui/           AppIcon 等通用 UI
    features/                按功能域切分（agents / artifacts / chat / diff / files / git / groups / preview / settings / sidebar / skills / workspace）
    state/                   workspaceStore（useSyncExternalStore 单一 store）
    styles/global.css        全部样式集中在这一个文件
  shared/                    主 / 渲染共享的类型 + 小工具（~2.5k 行）

scripts/                     原生模块重编译（ABI 切换）
tests/e2e/                   e2e 测试

dist/renderer/               Vite 渲染产物
dist-electron/               主进程 + preload 产物
```

**两个容易踩坑的点：**

- `tsconfig.json` 是单项目配置，`noEmit: true`，只做类型检查；真正产出在 `vite build` 和 `vite-plugin-electron`。
- `better-sqlite3` 不进 Rollup，由 Node runtime 加载原生模块；Node 与 Electron 各有 ABI，dev/start/test 脚本都会先 `rebuild`。

---

## 4. 进程模型与启动顺序

`electron/main.ts:501-516` 启动时：

1. `augmentProcessPath()` 把 `~/.npm-global/bin`、`~/.local/bin`、`/opt/homebrew/bin`、`/usr/local/bin` 注入 `PATH`，让 codex/claude/opencode CLI 在 Finder 启动的 app 里也能被找到。
2. `app.whenReady()`：
   - `initializeDatabase()` → `initializeSchema()` → 16 个 `ensureXxxColumn` 幂等迁移。
   - `ensureDefaultMainAgent(db)`：保证每个 workspace 至少有一个 main Agent。
   - `createWindow()`：dev 模式读 `VITE_DEV_SERVER_URL`，否则 `loadFile(dist/renderer/index.html)`。
3. `app.on("window-all-closed")` 只在非 macOS 退出。

---

## 5. IPC 通信

### 5.1 通道清单（按命名空间）

| 命名空间 | 数量 | 典型通道 |
| --- | --- | --- |
| `app` | 1 | `app:ping` |
| `workspace` | 5 | `workspace:create` / `workspace:list` / `workspace:delete` |
| `agent` | 10+ | `agent:run` / `agent:run-stream` / `agent:create-sub-agent-manually` / `agent:get-profile` |
| `skill` | 2 | `skill:list-catalog` / `skill:get` |
| `runtime` | 2 | `runtime:check` / `runtime:check-all` |
| `conversation` | 4 | `conversation:list-by-agent` / `conversation:resolve-workspace-context` |
| `message` | 3 | `message:list` / `message:list-with-artifacts` / `message:create` |
| `navigation` / `file` / `artifact` / `diff` / `git` | 1–5 | `file:tree` / `diff:apply` / `git:status` |
| `group-conversation` / `group-member` / `group-message` / `dispatch` / `group-agent` | 10+ | `group-message:send` / `dispatch:stream` / `dispatch-step:retry` |
| `model-provider` | 7 | `model-provider:save` / `model-provider:test` / `model-provider:context-usage` |
| `agent-run-event` | 1 | `agent-run-event:list` |

### 5.2 通信模式

- **请求 / 响应**：`ipcMain.handle(channel, fn)` ↔ `ipcRenderer.invoke(channel, args)`，主进程入口 `electron/main.ts:188-499` 逐条注册。
- **流式响应**：主进程无法主动推送，约定为「**带 streamId 的 invoke + 同名 `:${streamId}` 通道**」：
  - 调用方传入 `streamId`（preload `createStreamId()` 生成）。
  - 主进程在 handler 内构造 `sink = payload => event.sender.send(\`${channel}:${streamId}\`, payload)`，并把 sink 透传到 service。
  - 渲染端 preload 监听 `:${streamId}` 通道，通过 `streamHandlers.onTextDelta` 回调；`invoke` 返回的 Promise `.finally` 里 `removeListener`。
  - 涉及的通道：`agent:run` / `agent:run-with-conversation` / `agent:run-with-conversation-unified` / `group-message:send` / `group-task:dispatch` / `dispatch-step:retry`。
- **主进程主动推**：唯一一条 `IPC_CHANNELS.ARTIFACT_RENDER_CHANGED`；preload 用 `ipcRenderer.on(...)` + 返回 disposer。

---

## 6. 持久化层（better-sqlite3）

### 6.1 数据库

- 引擎：`better-sqlite3`（同步 API）。
- 路径：`<electron userData>/agenthub.db`（`src/main/db/index.ts:34-36`）。
- 模式：`journal_mode = WAL` + `foreign_keys = ON`。
- 单例：`currentDatabase` + `getDatabase()`。
- 工具：`stringifyJsonField` / `parseJsonField` 用于 JSON 列。

### 6.2 核心表（`src/main/db/schema.ts:392-738`）

| 表 | 关键列 | 作用 |
| --- | --- | --- |
| `workspaces` | id, name, root_path, main_agent_id, git_enabled | 工作区（一个本地代码目录） |
| `workspace_contexts` | id, owner_type, owner_id, root_path, git_enabled | "工作区上下文"：一个目录绑定，可被 Agent / Group / Conversation 各自引用 |
| `agents` | role(main/sub), type(orchestrator/specialist), status, runtime_provider, system_prompt, capabilities, tools, file_scope, claude_code_config, model_provider_id, model, avatar, skill_ids | Agent 实体 |
| `conversations` | type(direct/group), mode, workspace_context_id, auto_dispatch_enabled, status, last_message_at, avatar | 单聊 / 群聊共用一张表 |
| `messages` | sender_type, message_type, content, status, mention_agent_ids, dispatch_run_id, dispatch_step_id, reply_to_message_id, metadata, content_markdown, thinking_markdown | 消息；新版内容存 `message_artifacts` |
| `message_artifacts` | id, message_id, conversation_id, type, payload_json | 工具调用、文件引用、diff 提案等结构化产物 |
| `diff_proposals` | id, agent_id, file_path, old/new_content_hash, diff_content, new_content, status, dispatch_run_id, dispatch_step_id, message_id | 改文件提案 |
| `artifacts` | id, name, artifact_type, file_path, content, metadata | 产物（如生成的脚本、HTML） |
| `conversation_compact_summaries` | conversation_id, covered_message_start/end_id, summary, summary_tokens, raw_tokens_before_compact | 上下文压缩的滚动摘要（记忆层 1） |
| `agent_project_experiences` | agent_id, group_conversation_id, summary, responsibilities, key_decisions, files_touched, diff_summaries, unresolved_issues | Agent 在群组上的项目经验（记忆层 2） |
| `conversation_members` | conversation_id, member_type(user/agent), member_id, role, status, UNIQUE(conv,member_type,member_id) | 群成员 |
| `dispatch_runs` / `dispatch_steps` | round_index, acceptance_criteria, orchestrator_review, status, target_criteria, subagent_result, max_iterations | 群聊调度 run / step |
| `group_run_events` | group_run_id, conversation_id, seq, type, payload_json | 群聊事件流（与 `dispatch_runs` 1:N） |
| `agent_runs` | mode, iterations_used, raw_output, used_fallback, workspace_context_id, execution_scope, dispatch_step_id, started_at, ended_at | 单次 Agent 执行的元数据与快照 |
| `agent_run_events` | run_id, conversation_id, seq, type, payload_json | 统一事件流持久化（可重放） |
| `conversation_provider_sessions` (v1) | provider, provider_session_id, root_path, status | 提供方原生会话句柄 v1 |
| `conversation_provider_sessions_v2` | + workspace_context_id, execution_scope, agent_id | v2：按 agent / scope 区分 |
| `agent_drafts` | status(pending/...), raw_user_request, raw_model_output | 旧「自动生成 Agent 草稿」流程（列保留兼容） |

### 6.3 仓储层

`src/main/db/repositories/` 下「一聚合一文件」：`agentRepo`、`conversationRepo`、`messageRepo`、`diffRepo`、`artifactRepo`、`dispatchRunRepo`、`dispatchStepRepo`、`groupRunEventRepo`、`agentRunEventRepo`、`providerSessionRepo`、`workspaceRepo`、`workspaceContextRepo`、`conversationMemberRepo`、`conversationCompactSummaryRepo`、`agentProjectExperienceRepo`。与 services 解耦，仅暴露纯函数。

---

## 7. 业务服务（功能模块）

`src/main/services/` 下 ~50 个模块，按职责分组：

### 7.1 单聊 Agent 执行

- **`agentRunService.ts`** — `runAgent` 顶层入口：参数校验 → `getRunContext` → `checkRuntimeProvider` → 状态置 `running` → 选 runner。
  - mock provider 走 `src/main/demo/demoAgentRunner.ts`。
  - 真实 provider 走 `runLocalAgentTask`（`localRuntimeRunner.ts` 的 `async function*`），事件：`started` / `stdout` / `stderr` / `exited` / `error` / `artifact` / `diff_proposal`。
- **`agentRunWithConversationService.ts`** — 暴露 `runAgentWithConversation` / `runAgentWithConversationUnified`，对应「带会话上下文的单聊」。是当前单聊 chat 的主路径：拼接 context → 适配器流式生成 → 持久化事件 → 重载消息历史。

### 7.2 群聊调度（Dispatch）

入口 `src/main/services/dispatchService.ts`：

- `handleGroupUserMessage` — 用户发群消息入口。
- `dispatchGroupTasks` — 显式触发调度。
- `retryDispatchStep` — 单步重试。

主 Agent 决策位于：

- `orchestratorRuntimeService.ts`、`mainAgentDecision.ts`、`orchestratorSystemPrompt.ts`、`mainAgentContextService.ts` —— LLM 解析出 `DispatchPlan`（步骤、Agent 分派、`AcceptanceCriterion`）。
- `agentScoring.ts`（`services/dispatch/`）—— Agent 与任务匹配打分。
- `mentionParser.ts`（`services/dispatch/`）—— @mention 解析。

执行与编排：

- 每个 `dispatch_step` 调用 `runAgent` 跑对应 sub-Agent，回填 `subagent_result`、`output_message_id`。
- `groupExecutionService.ts` 做接受度复核，diff 复核走 main agent 再决策，常量 `MAX_DISPATCH_STEPS`。
- 事件流：`DispatchRunStreamEvent` 推送到 `dispatch:stream:${dispatchStreamId}`，持久化到 `group_run_events`。

### 7.3 LLM 路由与适配器

- `llmRouter.ts` — 统一 LLM 调用入口；支持流式。
- `llmProviderAdapters.ts` — OpenAI / Anthropic 协议适配（`apiFormat: openai_chat_completions | anthropic_messages`）。
- `services/adapters/builtinAgentAdapter.ts` — 内置 LLM 路径。
- `services/adapters/claudeCodeAdapter.ts` / `codexAdapter.ts` / `openCodeAdapter.ts` — 把本地 CLI 包装为 `AgentAdapter`。
- `services/adapters/unifiedAgentProviderAdapter.ts` — 关键适配层：把任意 `AgentAdapter` 的 `AgentEvent` 翻译成统一的 `AgentRunEvent`（`run.started` / `message.delta` / `tool.*` / `command.*` / `file.*` / `diff.*` / `error` / `message.completed` / `run.completed|run.failed`），并把每条事件持久化到 `agent_run_events`。
- `streamingRunService.ts` — 统一事件流读取与去重。

### 7.4 Runtime 健康检查

`runtimeService.ts:181-216` `checkRuntimeProvider`：

- `mock` / `builtin_openai` / `builtin_anthropic` 立即返回 `available: true`。
- `codex_local` / `claude_code` / `opencode` 走 `runVersionCommand`：`spawn(command, ["--version"], { shell: false })` + 3 秒超时。
- Windows 平台若 `command not found`，回退到 `shell: true`。

### 7.5 配置 / 模型提供者 / 密钥

- 全局配置 `~/.agenthub/settings.json`（`GlobalSettings`：含 `modelProviders[]` 与 `defaults`），旧 `~/.agenthub/config.json` 兼容回退。
- `src/main/config/agenthub-config-schema.ts` — schema：`ModelProviderConfig` / `MainAgentConfig` / `GroupChatConfig` / `AgentDefaultsConfig` / `GlobalSettings` / `WorkspaceSettings` / `WorkspaceLocalSettings`。
- `secret-resolver.ts` — `env:` 前缀引用 + 平台 Keychain 落盘。
- `modelProviderService.ts` — Provider CRUD + `testConnection`；端点拼装 `resolveEndpoint`（OpenAI → `/v1/chat/completions`，Anthropic → `/v1/messages`）。
- 默认上下文窗口 256k，可开启 1M。
- `agent-file-loader.ts` / `agenthub-config-merge.ts` / `provider-env-resolver.ts` — 工作区级 `.agenthub/` 配置加载与合并。

### 7.6 文件 / Diff / Artifact

- `fileService.ts` — `readFileTree` / `readWorkspaceFile`，受 `pathGuard.ts` 限制在 workspace 根目录内。
- `diffService.ts` / `diffProposalTextService.ts` — 提案创建、解析、apply、reject。
- `gitService.ts` — 通过 `git` CLI 调 `status` / `diff`。
- `artifactService.ts` — 产物落盘。
- `artifactRenderService.ts` + 自定义协议 `agenthub-preview://artifact/<id>/<asset>` — 沙箱内安全预览。
- `artifactDiffService.ts` — 由 artifact 生成 diff 提案。

### 7.7 其它

- `agentService.ts` / `agentBootstrapService.ts` / `agentDeletionService.ts` — Agent CRUD、默认主 Agent 兜底、删除清理。
- `conversationService.ts` / `messageService.ts` — 会话与消息。
- `navigationService.ts` — 渲染侧边栏的 `WorkspaceTreeDTO`。
- `agentSkillCatalogService.ts` — 技能点（系统提示拼接）。
- `toolPermissionService.ts` — 工具权限拦截。
- `conversationRunLock.ts` — 同一 conversation 不允许并发 run。
- `workspaceContextResolver.ts` — 解析「这条会话用哪个目录」。

---

## 8. 记忆系统设计（三层）

AgentHub 的"记忆"是显式分层的，覆盖**会话**和**项目**两个时间尺度：

### 8.1 第一层：会话级滚动摘要（`conversation_compact_summaries`）

- 表 `conversation_compact_summaries` 字段：`covered_message_start_id` / `covered_message_end_id` / `summary` / `summary_tokens` / `raw_tokens_before_compact`。
- 触发：`memoryContextService.ts:ensureRecentLayer` 每次拼装上下文时检查，当「未压缩消息」超过 `recentLimit`（直接对话 20，群对话 30）时，**确定性**生成新摘要（不调 LLM）：
  - 拼出 `[Previous Summary]\n<旧摘要>\n\n[Incremental Persisted Messages]\n<新增消息格式化>`。
  - 写入表，更新 `covered_message_start/end_id`。
- 消费：`conversationContextService.ts:buildConversationContext` 总是先注入「Workspace context」+「Conversation compact summary」作为 system 消息，再倒序塞历史消息直到 token 预算用完。
- 意义：把长会话"卷起来"，控制 LLM 输入 token 上限（`DEFAULT_CONTEXT_SAFETY_MARGIN_TOKENS = 1024`）。

### 8.2 第二层：Agent × 项目经验（`agent_project_experiences`）

- 表 `agent_project_experiences` 字段：`agent_id` + `group_conversation_id` + `summary` / `responsibilities` / `key_decisions` / `files_touched` / `diff_summaries` / `unresolved_issues`，唯一索引 `(agent_id, group_conversation_id)`。
- 写入：在 `agentProjectExperienceService.ts` 中由群聊完成一次 run 后落库（按 Agent × 群组去重更新）。
- 消费：`memoryContextService.ts:formatExperiences` 把它格式化成 markdown 段注入到对应 Agent 的 system prompt / 用户消息前缀。
- 意义：让 sub-Agent 在**跨群组**复用同一段项目知识（"上次在这个仓库里你负责过 X，做过 Y 决策"）。

### 8.3 第三层：近期原始消息（recent messages）

- 直接读 `messages` 表，按 `coveredEndIndex + 1` 取尾部 N 条。
- 注入位置：在摘要之后、用户当前消息之前；按时间倒序贪心塞入，token 超限即停。
- 行为细节：会自动跳过与"当前用户消息"内容完全一致的那条持久化消息，避免重复（`conversationContextService.ts:175-188`）。

### 8.4 上下文装配流程（`buildConversationContextForAgentRun`）

```
[系统预算: context_window - reserved_output - safety_margin]
  │
  ├─ 1. system:  <agent system prompt>            ← estimateTokens 计入
  ├─ 2. system:  "Workspace context: …"            ← fitSystemContext（按预算截断）
  ├─ 3. system:  "Conversation compact summary:…"  ← fitSystemContext
  ├─ 4. history: 从 messages 尾部倒序拉，每条 estimateMessageTokens；超预算 break
  └─ 5. user:    当前用户消息
       ↓
   contextMessages → AgentAdapter
```

### 8.5 群聊分派记忆（`buildGroupAssignmentMemoryContext`）

- 群聊分派时为某个 step 注入的上下文包括：
  - 当前 assignment 的 instruction
  - `previousAgentOutputs`（同 run 内上游 Agent 的产出）
  - `selectedGroupMessages`（群聊近期消息窗口）
  - 可选：direct conversation 摘要 / 群对话摘要
- 预算：默认 `DEFAULT_MEMORY_CHARACTER_BUDGET = 18000` 字符。

---

## 9. 渲染层架构

### 9.1 状态管理

- **唯一全局 store**：`src/renderer/state/workspaceStore.ts`（基于 `useSyncExternalStore`）。
- 暴露 `WorkspaceStoreState`：workspaces、navigationTree、agents、conversations、groupChats、members、dispatchRuns、dispatchSteps、messages、activeRunId、contacts、chats、activeWorkspaceContext、appView、mainView 等。
- `conversationStore.ts` 与 `agentStore.ts` 是从 `workspaceStore` 派生的「子集 hook」，方便组件按需订阅。

### 9.2 顶层状态机

`App.tsx:19-24` `appView: "loading" | "onboarding" | "settings" | "main"`：

- `loading` — 启动期，未连接主进程或 workspace 树未加载。
- `onboarding` — 没有可用 model provider → 引导用户配置。
- `settings` — 全屏 Model Provider 设置页。
- `main` — 主三栏布局。

`mainView: "chat" | "agentProfile" | "groupProfile" | "contactsHome" | "settings" | "skillsLibrary"` —— 主视图切换。

### 9.3 功能目录（`src/renderer/features/`）

| 目录 | 内容 |
| --- | --- |
| `sidebar/` | WorkspaceTree、AgentNode、ConversationNode、GroupConversationNode、Sidebar |
| `chat/` | ChatWindow（单聊）、GroupChatWindow（群聊）、MessageList、MessageRenderer、MessageComposer、MentionInput、MessageMarkdown、MessageArtifacts、CodeBlock、DiffProposalCard、DispatchPlanCard、GroupMemberStrip/Panel、GroupRunTimeline、AgentRunStepProcess、CreateGroupChatEntry、ConversationSettingsDrawer、ThinkingIndicator |
| `chat/renderers/` | TextMessage、CodeMessage、ThinkingBlock、AgentAssignmentMessage、AgentStatusMessage、DispatchPlanMessage、DiffCardMessage、OrchestratorSummaryMessage |
| `agents/` | AgentPickerDialog、AddSubAgentDialog、AgentProfileView、SkillMultiSelect、AgentStatusBadge、RuntimeBadge |
| `groups/` | CreateGroupDialog、GroupProfileView |
| `artifacts/` | ArtifactsTab |
| `diff/` | DiffTab、DiffViewer |
| `files/` | FilesTab、FileTree、FileViewer |
| `git/` | GitTab、GitStatusList、GitDiffViewer |
| `preview/` | PreviewTab、ArtifactViewer、MarkdownPreview、HtmlPreview、ArtifactOverlay |
| `settings/` | ModelProviderList/Form/Page、OnboardingModelProviderPage、RuntimeSettings |
| `skills/` | SkillLibraryView |
| `workspace/` | WorkspaceLanding、AddWorkspaceButton、WorkspaceCreateConfirm |

### 9.4 组件复用

- 通用 UI 仅在 `src/renderer/components/ui/`（`AppIcon`）。
- 样式全部集中在 `src/renderer/styles/global.css`（一个文件 ~7600 行），按 CSS class 命名空间划分（`.message-*` / `.inspector-*` / `.sidebar-*` / `.app-shell` / 等）。

### 9.5 跨窗口事件总线

`App.tsx` 监听若干 `window.dispatchEvent(new CustomEvent(...))`：

- `agenthub:open-conversation-settings` → 打开 `ConversationSettingsDrawer`。
- `agenthub:open-artifact` → 跳到 Preview tab。
- `agenthub:open-artifact-overlay` → 弹出 `ArtifactOverlay`。
- `agenthub:open-inspector` → 打开指定 Inspector tab。
- `agenthub:open-diff` → 切到 Diff tab。
- `agenthub:diff-changed` / `agenthub:artifacts-changed`（在主进程 service 里 dispatch）。

---

## 10. 页面布局（App shell）

`App.tsx` 在 `appView === "main"` 时渲染三栏布局（`src/renderer/styles/global.css` `.app-shell`）：

```
┌──────────────────────────────────────────────────────────────────────────┐
│ .app-shell (grid)                                                        │
│ ┌────────────────┬──────────────────────────┬───────────────────────────┐ │
│ │ .sidebar       │ .chat-area                │ .inspector                │ │
│ │ (Workspaces /  │  ┌──────────────────────┐ │ (Tabs: Files / Artifacts/ │ │
│ │  Agents /      │  │ .chat-header         │ │  Preview / Diff / Git /   │ │
│ │  Chats /       │  │  eyebrow + h2        │ │  Runtime)                 │ │
│ │  Groups)       │  │  Inspector shortcuts │ │                           │ │
│ │                │  │  + api-status  + ⋯   │ │  默认显示，drawer 模式    │ │
│ │                │  └──────────────────────┘ │  可隐藏（按 Esc）          │ │
│ │                │  ┌──────────────────────┐ │                           │ │
│ │                │  │ main view:           │ │  + .inspector-scrim       │ │
│ │                │  │   ChatWindow         │ │    关闭时浮在 chat 上     │ │
│ │                │  │   GroupChatWindow    │ │                           │ │
│ │                │  │   AgentProfileView   │ │                           │ │
│ │                │  │   GroupProfileView   │ │                           │ │
│ │                │  │   SkillLibraryView   │ │                           │ │
│ │                │  └──────────────────────┘ │                           │ │
│ │                │  ┌──────────────────────┐ │                           │ │
│ │                │  │ MessageComposer /    │ │                           │ │
│ │                │  │ MentionInput         │ │                           │ │
│ │                │  └──────────────────────┘ │                           │ │
│ └────────────────┴──────────────────────────┴───────────────────────────┘ │
│                                                                            │
│ (浮层) ArtifactOverlay, ConversationSettingsDrawer                         │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Sidebar**：可折叠为 `list-pane-collapsed`；`compact` 模式（settings 页用）。
- **Chat area**：
  - header 含 `eyebrow`（"Agent Chat" / "Group Chat" / "Agent Profile" / "Group Profile" / "Skill Library"）+ `h2`（agent 名 / 群名 / 技能点）。
  - 右侧 6 个 inspector 快捷按钮 + API 状态徽标 + `⋯` 设置按钮。
- **Inspector**：默认 6 个 tab（`Files` / `Artifacts` / `Preview` / `Diff` / `Git` / `Runtime`），与 `.inspector-tabs` 一一对应；可通过 inspector 快捷按钮 / `agenthub:open-inspector` 事件切换。
- **路由缺失**：没有 react-router；"路由"由 `appView` + `mainView` + `activeWorkspace` + `activeConversation` + `activeAgent` 5 个状态字段组合而成。
- **新建会话占位**：当点击"+"新建但 agent 还没回第一条消息时，渲染 `CreatingChatPlaceholder`（`.chat-creating-placeholder`）。

### 10.1 Inspector 6 个 Tab 的内容

| Tab | 组件 | 数据源 |
| --- | --- | --- |
| Files | `FilesTab` | `window.agenthub.file.tree` / `file.read` |
| Artifacts | `ArtifactsTab` | `artifact.listByWorkspace` |
| Preview | `PreviewTab` + `ArtifactViewer` + `MarkdownPreview` + `HtmlPreview` | `artifact.get` / `artifact.render` |
| Diff | `DiffTab` + `DiffViewer` | `diff.listByWorkspace` / `diff.get` / `diff.apply` / `diff.reject` |
| Git | `GitTab` + `GitStatusList` + `GitDiffViewer` | `git.status` / `git.diff` |
| Runtime | `RuntimeSettings` | `runtime.checkAll` |

### 10.2 消息渲染（`MessageList` → `MessageRenderer` → `renderers/*`）

`MessageRenderer` 按 `messageType` 派发到 `renderers/TextMessage`、`CodeMessage`、`ThinkingBlock`、`AgentAssignmentMessage`、`AgentStatusMessage`、`DispatchPlanMessage`、`DiffCardMessage`、`OrchestratorSummaryMessage`；结构化产物由 `MessageArtifacts` 渲染（tool_call / tool_result / file_reference / command_result / error 等）。`ThinkingIndicator` 是 2026-06 新加的"agent 正在思考"动画。

### 10.3 API 状态角标

`App.tsx:71-107` 启动时 `window.agenthub.ping()` 探测主进程，结果用 `.api-status` 角标显示 `Loading` / `Ready` / `Empty` / `Error`。

---

## 11. 前后端契约

### 11.1 `AgentHubApi` 接口（`src/shared/types.ts:404-475`）

```ts
interface AgentHubApi {
  ping(): Promise<string>;
  workspace: WorkspaceApi;     // selectFolder / prepareCreate / create / delete / list
  agent: AgentApi;             // listByWorkspace / listContacts / ensureDefaultMainAgent /
                               // createSubAgentManually / delete / updateStatus / updateProfile /
                               // updateDefaultWorkspace / getStatus / getAgentProfile /
                               // run / runWithConversation / runWithConversationUnified
  skill: SkillApi;             // listCatalog / get
  agentRun: AgentRunApi;       // listEvents (统一事件回放)
  runtime: RuntimeApi;         // checkAll / check
  conversation: ConversationApi;
  message: MessageApi;
  navigation: NavigationApi;
  file: FileApi;
  artifact: ArtifactApi;       // create / listByWorkspace / get / render / updateContent /
                               // createDiff / onRenderChanged
  diff: DiffApi;               // createProposal / get / listByWorkspace / apply / reject
  git: GitApi;                 // status / diff
  groupConversation: GroupConversationApi;
  groupMember: GroupMemberApi;
  groupMessage: GroupMessageApi;   // send / dispatchGroupTasks
  dispatch: DispatchApi;           // getRun / listRuns / listEvents / retryStep
  modelProvider: ModelProviderApi; // list / get / save / delete / testConnection /
                                   // hasAnyProvider / getContextUsage
}
```

`preload.ts` 严格按这个接口包装 `ipcRenderer.invoke(...)`，流式接口按 `input.streamId` 自动建监听。

### 11.2 共享类型

`src/shared/` ~2.5k 行：

- `domain.ts` (485) — 核心领域模型：Agent / Conversation / Message / Workspace / RuntimeProvider / RunAgentInput。
- `agentRunEvent.ts` (204) — 统一事件协议 `AgentRunEvent`、`MessageArtifact`。
- `groupChat.ts` (578) — 群聊 / 调度：`DispatchPlan` / `DispatchStep` / `DispatchRun` / `DispatchRunStreamEvent` / `GroupRunEvent`。
- `artifact.ts` (123) / `diff.ts` (75) / `file.ts` (40) / `git.ts` (47) — 资源类型。
- `modelProvider.ts` (177) — Provider 配置、`ContextUsage`、`ProviderCapabilities`。
- `agentAdapter.ts` (94) / `agentExecution.ts` (39) / `agentRunPolicy.ts` (18) — 适配器与执行策略。
- `runtime.ts` (58) / `types.ts` (475) / `ipcChannels.ts` (82) — 运行时枚举、API 接口、IPC 通道常量。

---

## 12. 测试与构建

- **测试**：vitest 4；单测与源文件同目录 `*.test.ts`；e2e 在 `tests/e2e/mvpFlow.test.ts`（建临时目录 → 创建 mock 仓库 → 初始化 DB → 创建 workspace → 创建 sub-Agent → mock 跑 agent → apply diff → git status 校验）。
- **原生模块 ABI**：`scripts/rebuild-electron-native.cjs` 先用 `ELECTRON_RUN_AS_NODE=1` 自检 SQLite，失败则 `npm rebuild better-sqlite3` 并注入 electron headers 环境变量。
- **npm scripts**：
  - `dev` = `rebuild:electron` + `vite --host 127.0.0.1`。
  - `build` = `tsc --noEmit` + `vite build`。
  - `start` = `rebuild:electron` + `electron .`。
  - `test` = `rebuild:node` + `vitest run`。
  - `test:db` / `test:e2e` 同上但指定文件。
- **当前测试规模**：44 个测试文件 / 207 个用例（2026-06-09 跑通）。

---

## 13. 一次完整消息往返（示例）

以「单聊发送一条消息」为例，串起前后端：

```
[Renderer] 用户在 MessageComposer 点发送
   │  1. ChatWindow.handleSendText(text)
   │     ├─ 乐观追加 pending message (deliveryState="sending")
   │     └─ setConversationSending(cid, true)   ← 这条 isSending 触发 ThinkingIndicator
   │
   ▼
[IPC] window.agenthub.agent.runWithConversationUnified(input, { onEvent })
   │  preload 内部：生成 streamId + 监听 `agent:run-with-conversation-unified-stream:<id>`
   │  invoke IPC → electron/main.ts 的对应 handler
   │
   ▼
[Main] runAgentWithConversationUnified
   │  ├─ acquireConversationRun (锁)
   │  ├─ buildConversationContextForAgentRun  ← 注入记忆（摘要 + 项目经验 + 近期消息）
   │  ├─ getAdapter(runtimeProvider)            ← builtin / claude_code / codex / opencode
   │  ├─ unifiedAgentProviderAdapter 包装       ← 输出统一 AgentRunEvent 流
   │  ├─ 流式: 持久化到 agent_run_events  ←→ 通过 sink 推送 `<channel>:<streamId>`
   │  └─ 结束后:  落 agent_runs (mode/iterations/used_fallback)
   │               reload 消息历史 → setConversationMessages(cid, history)
   │
   ▼
[Renderer] onEvent 回调
   │  ├─ message.delta   → 追加/更新流式 message  ← 此时最后一条变 agent → ThinkingIndicator 消失
   │  ├─ message.thinking_delta → 追加 thinking
   │  ├─ artifact.created / .rendered → 走 MessageArtifacts
   │  └─ run.completed / run.failed
   │
   ▼
[Renderer] handler finally
   └─ setConversationSending(cid, false) + loadWorkspaceTree
```

---

## 14. 关键文件索引

| 关注点 | 入口文件 |
| --- | --- |
| Electron 启动 | `electron/main.ts` |
| Preload IPC 桥 | `electron/preload.ts` |
| Renderer 入口 | `src/renderer/main.tsx` |
| 顶层 Shell | `src/renderer/App.tsx` |
| 全局 Store | `src/renderer/state/workspaceStore.ts` |
| 单聊窗口 | `src/renderer/features/chat/ChatWindow.tsx` |
| 群聊窗口 | `src/renderer/features/chat/GroupChatWindow.tsx` |
| 消息列表 | `src/renderer/features/chat/MessageList.tsx` |
| DB schema + 迁移 | `src/main/db/schema.ts`、`src/main/db/index.ts` |
| Agent 执行 | `src/main/services/agentRunService.ts`、`agentRunWithConversationService.ts` |
| 群聊调度 | `src/main/services/dispatchService.ts`、`groupChatService.ts`、`groupExecutionService.ts` |
| 统一事件适配 | `src/main/services/adapters/unifiedAgentProviderAdapter.ts` |
| 上下文装配 | `src/main/services/conversationContextService.ts` |
| 记忆（摘要 + 经验） | `src/main/services/memoryContextService.ts`、`agentProjectExperienceService.ts` |
| Runtime 健康 | `src/main/services/runtimeService.ts` |
| Provider / 配置 | `src/main/services/modelProviderService.ts`、`src/main/config/*` |
| 适配器集合 | `src/main/services/adapters/{builtinAgentAdapter,claudeCodeAdapter,codexAdapter,openCodeAdapter,unifiedAgentProviderAdapter}.ts` |
| 共享契约 | `src/shared/types.ts`、`ipcChannels.ts`、`domain.ts`、`agentRunEvent.ts`、`groupChat.ts` |
| 文档 | `ARCHITECTURE.md`（技术契约视角）、`AGENTS.md` / `CLAUDE.md`（编码规范）、`docs/`（专题） |
