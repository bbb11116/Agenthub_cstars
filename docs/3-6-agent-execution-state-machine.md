# 3.6 Agent 执行状态机

> 本章对应代码目录：`src/shared/`、`src/main/services/`、`src/renderer/features/chat/`、`src/renderer/features/agents/`。
> 核心文件：`shared/agentExecution.ts`、`shared/agentRunEvent.ts`、`shared/groupChat.ts`、`shared/runtime.ts`、`shared/domain.ts`、`main/services/agentRunService.ts`、`main/services/agentRunWithConversationService.ts`、`main/services/streamingRunService.ts`、`main/services/dispatchService.ts`、`main/services/groupExecutionService.ts`、`main/services/conversationRunLock.ts`、`renderer/features/agents/AgentStatusBadge.tsx`、`renderer/features/chat/renderers/AgentStatusMessage.tsx`、`renderer/features/chat/AgentRunStepProcess.tsx`、`renderer/features/chat/GroupRunTimeline.tsx`、`renderer/features/chat/DispatchPlanCard.tsx`、`renderer/features/chat/renderers/AgentAssignmentMessage.tsx`、`renderer/features/chat/renderers/OrchestratorSummaryMessage.tsx`。

AgentHub 把"一次 Agent 执行"拆成五层独立的状态机：

1. **Agent 资源状态**（`AgentStatus`）：Agent 实体在系统里的"长期健康度"，跨多次 run 持久。
2. **Runtime 健康度**（`RuntimeStatus`）：底层 LLM Runtime（Codex / Claude Code / builtin OpenAI / builtin Anthropic …）是否能被调用，跨 Agent 共享。
3. **单聊 Run 状态**（`AgentRunResult.status` / `MessageStatus` / `ConversationRunStatus`）：单条对话上"一次 LLM 调用"的生命周期。
4. **群聊 Dispatch Run 状态**（`GroupRunStatus` / `DispatchRunStatus`）：一个用户消息触发的群聊协作整体进度。
5. **群聊 Dispatch Step 状态**（`SubAgentRunStatus` / `DispatchStepStatus`）：协作里每一个子 Agent 任务的进度。

五层状态机互相耦合但语义独立。本章先列出每层的"状态字典"和"用户可见文案"，再分别给出单聊、群聊的可视化卡片设计。

---

## 3.6.1 任务执行状态设计

### A. Agent 资源状态（`AgentStatus`，来自 `shared/domain.ts:63-75`）

`Agent` 记录上的 `status` 字段，代表这个 Agent 实体此刻能不能被分派、是不是正在被调用、历史上是否健康。该状态由 `agentRunService.runAgent` 在 run 前后写入（`updateAgentStatusSafely`），由群聊子 Agent 调用结束（`dispatchService.executeSubAgentStep` 内的 `updateStepStatus`）维护。

| 状态 | 用户可见文案 | 触发条件（写库时机） | 下一状态 | UI 表现 |
|------|--------------|----------------------|----------|---------|
| `draft` | Draft | Agent 刚被创建（`agentBootstrapService` / `CreateAgentInput` 默认值），尚未真正配置完成。 | `available` / `disabled` / `deleted` | 灰底徽章，灰点；侧边栏节点半透明；不允许被群聊选中。 |
| `available` | Available | `runAgent` 入口处 `getRuntimeAvailability` 探测通过；或上一次 run 正常结束（`recordAgentStatus(runningContext, "available", ...)`）。 | `running`（新 run 开始） / `error`（run 抛错） / `unavailable`（runtime 探测失败） / `disabled`（用户手动停用） | 绿点徽章，绿色 outline；侧边栏节点正常显示，可被分派。 |
| `running` | Running | `runAgent` 入口成功拿到 lock、把 Agent 切到 `running`（`updateAgentStatusOnly(context, "running", db)`）；或显式 mock runtime 走 `recordAgentStatus(... "running" ...)`。 | `available`（run 成功） / `error`（run 抛异常） / `unavailable`（runtime 不可用） / `cancelled`（用户取消 run） | 蓝/紫呼吸点，CSS 动画 `pulse`；侧边栏节点 + 单聊头 Avatar 加 spinning 边框；群聊协作卡片里 step 节点变 `running` 态。 |
| `error` | Error | `runAgent` 内部 `try/catch` 捕获到异常 → `recordAgentStatus(runningContext, "error", ...)`；或 `LocalRuntimeRunner` 拿到非 0 exit code + 非 unavailable 错误。 | `available`（下一次 run 成功恢复） / `unavailable`（runtime 消失） / `disabled` / `deleted` | 红点徽章，红色 outline；单聊卡片 `role="alert"`；Runtime Tab 自动跳转。 |
| `unavailable` | Unavailable | `getRuntimeAvailability` 返回 `available=false`（例如 CLI 不在 PATH / permission denied），且错误文本匹配 `/command not found|permission denied/i`；或 ProviderSession 校验失败。 | `available`（runtime 恢复后下次探测通过） / `error`（其它错误） | 橙点徽章，橙色 outline；单聊 Input 禁用，提示用户检查 Runtime。 |
| `disabled` | Disabled | 用户在 Agent 列表里手动停用（`updateAgentStatusInRepo(id, "disabled", db)`）。 | `available`（用户重新启用） / `deleted` | 灰点 + 删除线，节点不可点击；分派面板里自动隐藏。 |
| `deleted` | Deleted | `agentDeletionService.deleteAgent` 完成，物理删除前先标 `deleted`。 | （终态） | 不在侧边栏显示；历史消息里仍然出现 Agent 名字。 |

### B. Runtime 健康度（`RuntimeStatus`，来自 `shared/runtime.ts:12-18`）

由 `runtimeService.checkRuntimeProvider` 在 `runAgent` 入口同步调用，结果只对当下这次 run 起作用，不写库。

| 状态 | 用户可见文案 | 触发条件 | 下一状态 | UI 表现 |
|------|--------------|----------|----------|---------|
| `available: true` | Available | `runtimeService` 调用 `codex --version` / `claude --version` 等返回 0。 | `unavailable`（下次探测失败） | 绿点徽章；RuntimeBadge 显示 `${label} · Available` + 探测时间。 |
| `available: false` | Unavailable | CLI 退出码非 0 / spawn 失败 / 沙盒拒绝。 | `available`（下次探测成功） | 橙/红点；`title` 显示具体错误；Agent 卡片右上 RuntimeBadge 变橙。 |
| `error`（探测器自身抛错） | Check failed | RuntimeBadge 内部 `checkRuntime()` catch 异常（`runtimeService` 不可达）。 | `loading` → `ready`（重试） | RuntimeBadge 显示 `Check failed`，tooltip 透出错误文本。 |
| `loading` | Checking | RuntimeBadge 首次挂载、provider 切换、显式重新探测。 | `available` / `unavailable` / `error` | 灰点 + spinner，文字 `Checking`。 |

### C. 单聊 Run 状态（`AgentRunResult.status` + `MessageStatus` + `ConversationRunStatus`）

来自 `shared/agentExecution.ts:25-38`（`AgentRunResult`），`shared/agentRunEvent.ts:152-162`（`ConversationRunStatus` / `MessageStatus`）。这一层状态在三个地方被写：

- `streamingRunService.runStreamingAgent` 维护 assistant message 的 `MessageStatus`（`createAssistantPlaceholder` → `"streaming"`，`run.completed` → `"completed"`，`run.failed` → `"failed"`）。
- `agentRunWithConversationService.runAgentWithConversation` 通过 `event.type === "status"` 维护 `runResultStatus`。
- `agentRunService.runAgent` 顶层 try/catch 维护最终的 `AgentStatus` 与一条 `agent_status` 卡片消息。

| 状态 | 用户可见文案 | 触发条件 | 下一状态 | UI 表现 |
|------|--------------|----------|----------|---------|
| `idle`（隐式） | 准备中 | `streamingRunService` 已建好 `assistantMessage` 占位（`status="streaming"`），但 provider 还没产出第一个 delta。 | `preparing_context` | 消息气泡 + 三点 typing 动画。 |
| `preparing_context` | 准备上下文 | 收到 `run.started` 事件 → `AgentRunStepProcess` 写入 `context` step，title `准备上下文`。 | `generating` | Step 过程面板第 1 张卡 `运行中`，小节 "正在准备运行上下文"。 |
| `generating` | 生成回复 | 收到首个 `message.delta` 且非空白 → `message` step 进入 `streaming` 态。 | `tool_calling` / `finalizing` / `streaming_thinking` | 主气泡开始出现 Markdown 文本；Step 过程卡 `生成回复` 显示打字光标。 |
| `streaming_thinking` | 思考中 | 收到 `message.thinking_delta`，或经 `ThinkBlockParser` 剥离出 <think> 块。 | `generating`（块结束回到正文） / `finalizing` | 主气泡下挂一个折叠 `ThinkingBlock`；不计入正文。 |
| `tool_calling` | 调用工具 | 收到 `tool.call.started` → AgentRunStepProcess 写入 `tool-{toolCallId}` step；常见 name：`read_file` / `write_diff` / `apply_diff` / `run_command`。 | `tool_calling`（下一个 tool） / `generating`（tool.result 后回到正文） / `finalizing` | Step 过程卡 `调用工具: <name>` 持续 pulsing；命令类（`command.result`）单列 `执行命令` 卡。 |
| `waiting_for_permission` | 等待权限 | Adapter 发出 `status: "waiting_for_permission"`（例如 `apply_diff` 触发路径外写入、`git_push` 命中 deny 列表）；`runResultStatus` 同步置位。 | `running`（用户批准） / `failed`（用户拒绝） | 单聊卡片标题 `等待用户确认...`，按钮亮起；AgentRunStepProcess 把当前 step 标 `waiting_for_permission`。 |
| `cancelled` | 已取消 | 用户在 Input 旁的 `Cancel` 按钮触发 `abortSignal`，`run.completed` payload `status: "cancelled"`。 | （终态） | 红色 outline，title `已取消`；解锁会话，消息气泡标删除线。 |
| `finalizing` | 完成中 | `message.completed` 已收，但 provider 还在做 side-effect（持久化 `provider_sessions`、补 `agent_runs.iterations_used`）。 | `completed` / `failed` | 短暂显示 `正在落库...`；Step 过程卡 `message` → `completed`。 |
| `completed` | 已完成 | `run.completed` 事件 → `updateMessageStatus(id, "completed")` + `updateAgentStatusInRepo(id, "available")` + `recordAgentStatus(... "available" ...)`。 | （终态；新消息触发 `running`） | 绿点徽章；AgentRunStepProcess 折叠为 `已处理 12s / 5 个步骤`；如携带 DiffProposal，渲染 `DiffProposalCard`。 |
| `failed` | 失败 | adapter 抛异常被 `try/catch` 捕获 → 写 `run.failed` 事件 + `error` artifact；`runResultStatus = "failed"`，`agentStatus = "error"`。 | （终态） | 红点徽章 + `role="alert"`；错误消息以 `<p>{detail}</p>` 形态内联；Step 过程卡 `执行失败`。 |
| `iteration_limit_reached` | 达到上限 | adapter 迭代超 `maxIterations`（单聊默认 40，群聊子 Agent 默认 15，详见 `AGENT_EXECUTION_LIMITS`）→ `runResultStatus = "iteration_limit_reached"`。 | `failed`（被上层映射到 `error`） | 红色 outline，title `已达到最大迭代次数`；Step 过程卡显示最终一次 tool/stream 进度后切到 `failed`。 |
| `verification_failed` | 校验失败 | 单聊模式下，用户消息匹配 `requestsCodeChanges` 且 Provider 没返回 DiffProposal / 没显式 `no_changes_needed` → `runResultStatus = "verification_failed"`，`agentStatus = "error"`。 | `failed`（被上层映射到 `error`） | 红色 outline，detail `Provider finished without a valid DiffProposal or an explicit no_changes_needed result.` |
| `queued`（群聊专属，但 MessageStatus 仍可能短暂出现） | 等待接力 | 群聊 step 还没被 batch 选中。 | `running` | DispatchPlanCard 显示 `等待中` 蓝灰 chip。 |

### D. 群聊 Dispatch Run 状态（`GroupRunStatus` / `DispatchRunStatus`，来自 `shared/groupChat.ts:28-40`）

由 `dispatchService.executeStructuredGroupDispatch` 主循环写入；同时通过 `groupRunEventRepo` 发出 `plan_created` / `agent_started` / `agent_completed` / `agent_failed` / `summary_started` / `summary_completed` 事件。

| 状态 | 用户可见文案 | 触发条件 | 下一状态 | UI 表现 |
|------|--------------|----------|----------|---------|
| `planning` | 规划中 | 群聊进入 `runMainAgentAutoDispatch`，已创建 `dispatch_runs` 行（`status = "running"` 占位），主 Agent 正在调 `runGroupOrchestratorDecision`。 | `plan_created`（plan 合法） / `running_subagents`（旧 path 跳过 plan_created） / `completed`（decision = `direct_answer` / `ask_clarification`） / `failed`（Orchestrator 异常） | GroupRunPlanPanel 顶部 chip `规划中`；DispatchPlanCard 显示模式 chip + `当前轮次: 1`。 |
| `plan_created` | 已生成计划 | `executeStructuredGroupDispatch` 把 `assignments` 写进 `dispatch_steps` 后立即调用 `updateDispatchRunStatus(id, "plan_created")`，并 `emitGroupRunEvent("plan_created")`。 | `running_subagents` | GroupRunPlanPanel 显示完整卡片网格，title 切到 `已生成计划`；DispatchPlanMessage 卡片渲染。 |
| `running_subagents` | 子 Agent 执行中 | `updateDispatchRunStatus(id, "running_subagents")`（出现在 batch 开始前），同时每个 step 通过 `emitStepProgress(phase="runtime"/"model"/"stream"/"parse")` 持续广播。 | `reviewing`（本轮所有 step 走完，进入 reviewAcceptanceCriteria） / `partial_failed` / `failed`（runtime 抛错） | GroupRunTimeline 横向 flow 显示所有 step 的实时进度；`TypingDots` + 进度列表 `compact` 模式。 |
| `reviewing` | 汇总中 | `reviewAcceptanceCriteria` 已返回 `OrchestratorReview` 对象。 | `redispatching`（`decision === "redispatch"` 且未超 3 轮） / `summary_started`（其他决策） | GroupRunTimeline 末尾追加一张 `主 Agent 汇总中` 卡片（`group-agent-flow-summary`），`TypingDots` 持续。 |
| `redispatching` | 重新分派中 | `decision === "redispatch"` → `updateDispatchRunStatus(id, "redispatching")`，roundIndex++；`createRepairAssignments` 生成修复分派。 | `running_subagents`（下一轮） | GroupRunPlanPanel header chip 切到 `重新分派中`；轮次 +1。 |
| `summary_started` | 正在生成总结 | `emitGroupRunEvent("summary_started")`，准备 `runGroupOrchestratorSynthesis`（或 fallback `createFallbackUserFacingSummary`）。 | `summary_completed` | OrchestratorSummaryMessage 渲染占位气泡，`TypingDots` 持续。 |
| `completed` | 已完成 | `toFinalGroupRunStatus` 返回 `completed`（所有 step 成功或 `no_changes_needed`，且 review.decision = `complete`）→ `updateDispatchRunStatus(id, "completed")`。 | （终态） | 绿点 + `已完成`；OrchestratorSummaryMessage 渲染最终 Markdown。 |
| `partial` / `partial_failed` | 部分失败 | `decision ∈ { "partial", "partial_failed" }`；满足 required 验收项 0 个但有 subAgent 返回 `completed` / `no_changes_needed` → `partial_failed`；其他部分完成场景 → `partial`。 | （终态） | 黄/橙 chip；UI 提示用户哪些验收项未满足。 |
| `failed` | 失败 | Orchestrator 决策异常 / 全部 step 失败 / 阻断式 @ 解析（`runBlockedMentionDispatch`） / 达到最大重分派轮数且 required 验收项 0 个。 | （终态） | 红色 chip；DispatchPlanCard 给出 `重新执行` 按钮。 |
| `waiting_for_user` | 等待用户 | 仍有 required 验收项未满足但 `createRepairAssignments` 返回 0 项（无任何 subAgent 还能继续修）。 | `running_subagents`（用户补充信息后重新触发） / `failed` | GroupRunPlanPanel 显示 `等待用户输入` chip，提示用户回复。 |
| `cancelled` | 已取消 | 用户在群聊运行中按 `Cancel`，但当前代码路径不主动支持，事件流以 `run.failed` 呈现；UI 在 step 终态把它折叠显示为 `已取消`。 | （终态） | 灰色 chip。 |

### E. 群聊 Dispatch Step 状态（`SubAgentRunStatus` + `DispatchStepStatus`，来自 `shared/groupChat.ts:42-56`）

由 `dispatchStepRepo.updateStepStatus` 写入；同步发出 `dispatch_step_update` IPC 事件。

| 状态 | 用户可见文案 | 触发条件 | 下一状态 | UI 表现 |
|------|--------------|----------|----------|---------|
| `pending` | 等待中 | `plan_created` 阶段为每个 assignment 创建一个 `dispatch_steps` 行，默认 `pending`；`group_run_event` 内 status 显示为 `pending`。 | `running`（batch 选中、executeSubAgentStep 入口） | DispatchPlanCard 灰 chip；GroupRunPlanCard `step-pending` 灰底。 |
| `queued` | 等待 | 历史别名；为兼容老 `SubAgentRunStatus` 保留。当前新建的 step 一律从 `pending` 起步。 | `running` | 与 `pending` 同视觉。 |
| `running` | 执行中 | `executeSubAgentStep` 第一步 `updateStepStatus(id, "running")` + `emit("agent_started")` + `stream dispatch_step_update`；Phase 顺序：`context` → `runtime` → `model`（可能） → `stream` → `parse`。 | `streaming`（收到第一个 text_delta） / `completed` / `failed` | GroupRunTimeline 主气泡 `运行中` + `TypingDots`；progress 列表实时追加。 |
| `streaming` | 回复中 | `streamSink` 首次收到 `text_delta` → `emitStepProgress(phase="stream", status="streaming")` + `dispatch_step_update status="streaming"`。 | `running`（继续迭代） / `completed` / `failed` | 同 `running` 视觉，但 progress 列表显示 `正在生成结果` 条目。 |
| `completed` | 已完成 | SubAgentResult 解析成功且 `toStepStatus` 把 `completed` / `no_changes_needed` 映射为 `completed`；`updateStepStatus(id, "completed", outputMessageId)` + `emit("agent_completed")`。 | （终态） | 绿 chip + `AgentAssignmentMessage` 卡片；显示 `summary`、DiffProposal 跳转、artifact 跳转。 |
| `partial` | 部分完成 | SubAgentResult.status 解析为 `partial`（如输出被截断但 JSON 仍可解析，或完成部分验收项）。 | （终态） | 黄色 chip；UI 提示 `部分完成`。 |
| `failed` | 失败 | SubAgentResult.status === `failed`；或 agent 不存在 / workspace 缺失 / `parseError` 持续 + `manifestRepairRequested` 已用完；或 `executeSubAgentStep` 顶层 catch 捕获到异常。 | （终态） | 红 chip + `重新执行` 按钮（`DispatchPlanCard` 暴露 `onRetryStep`）。 |
| `iteration_limit_reached` | 达到上限 | Adapter 在子 Agent 模式下发出 `status: "iteration_limit_reached"`，`runResultStatus` 同步置位，SubAgentResult.status 落 `iteration_limit_reached`。 | `failed`（step 级别映射） | 红色 chip，detail `已达到最大迭代次数 (15)`。 |
| `waiting_for_permission` | 等待权限 | Adapter 发出 `status: "waiting_for_permission"`；通常来自 `apply_diff` 跨目录或 git push 拒绝。 | `running`（用户批准） / `failed`（用户拒绝） | 黄 chip + "等待权限" 角标。 |
| `cancelled` | 已取消 | 群聊 run 终止时，正在 in-flight 的 step 会被 `updateStepStatus(id, "cancelled")`。 | （终态） | 灰 chip。 |
| `skipped` | 已跳过 | 显式标记为不需要执行的 step（目前由 `dispatch_step_status` 字段支持但代码尚未触发，保留扩展位）。 | （终态） | 灰 chip + 删除线。 |

### F. 跨层级映射

| 维度 | 单聊 | 群聊 |
|------|------|------|
| 用户发消息 | `ConversationRun`（status: `running`） | `DispatchRun`（status: `running` → `planning`） |
| Provider 跑通 | `AgentRunResult.status = "completed"`，assistant `MessageStatus = "completed"` | 每个 `DispatchStep` 独立 `completed` / `partial`；`GroupRunEvent.agent_completed` |
| Provider 抛错 | `AgentRunResult.status = "failed"`，`AgentStatus = "error"` | `DispatchStep.status = "failed"`，`GroupRunEvent.agent_failed`；DispatchRun 视情况升级到 `redispatching` |
| 用户取消 | `run.completed` payload `status: "cancelled"` → `ConversationRun.status = "cancelled"` | UI 暂未实现群聊取消；底层会走 `run.failed` 路径 |
| 需要重分派 | 不适用 | `reviewAcceptanceCriteria` 返回 `decision: "redispatch"` → DispatchRun 切到 `redispatching` |

---

## 3.6.2 单聊状态可视化卡片

单聊界面（`ChatWindow` → `MessageList` → `MessageRenderer` → `MessageType` 分支）一共渲染 4 类状态卡片：

### 1. `agent_status` 卡片（`renderers/AgentStatusMessage.tsx`）

由 `agentRunService.recordAgentStatus` 在 run 生命周期写库触发。

**结构（实际 JSX 形态）：**

```tsx
<article className={`agent-status-card agent-status-card-${status}`} role={role}>
  <AgentStatusBadge status={status} />     // 圆点 + 文字
  <div>
    <span>{title}</span>                    // e.g. "Codex Local 退出码 1"
    {detail ? <p>{detail}</p> : null}       // 错误详情
  </div>
</article>
```

**状态 → 卡片视觉映射：**

| `AgentRunResult.status` / `AgentStatus` | 卡片 class | 徽章 | 角色 |
|---|---|---|---|
| `running` | `agent-status-card-running` | 蓝/紫点 pulsing | `status` |
| `available` / `completed` | `agent-status-card-available` | 绿点 | `status` |
| `error` | `agent-status-card-error` | 红点 | `alert` |
| `unavailable` | `agent-status-card-unavailable` | 橙点 | `status` |
| `disabled` / `draft` | `agent-status-card-disabled` | 灰点 | `status` |

**触发位置：**

- `runAgent` mock 路径：先写 `running` 卡，再写 `available` 卡。
- `runAgent` 真实路径：默认只写 `available` / `error` 终态卡（`showCompletionStatusMessage = result?.showCompletionStatus !== false`），中间态由流式气泡 + `AgentRunStepProcess` 表达。
- 显式标 `unavailable`：runtime 探测失败。
- catch 异常：固定 title `${agent.name} hit an error.` + `toErrorMessage` 详情。

### 2. `AgentRunStepProcess` 面板（`features/chat/AgentRunStepProcess.tsx`）

由 `runStreamingAgent` 落库的 `agent_run_events` 实时回放驱动，按事件类型生成"step 卡"。

**整体结构：**

```tsx
<section className="agent-run-step-process agent-run-step-process-{collapsed|expanded}">
  <button className="agent-run-step-process-summary">
    已处理 12s / 5 个步骤        // 顶部 summary，可点击折叠
  </button>
  <div className="agent-run-step-process-list">
    {run.steps.map((step, i) => (
      <article className={`agent-run-step-process-card-${step.status}`}>
        <header>
          <strong>Step {i+1}: {step.title}</strong>
          <small>{STEP_STATUS_LABELS[step.status]}</small>
          {step.status === "running" ? <TypingDots /> : null}
        </header>
        <StepProgressList progress={step.progress} />
      </article>
    ))}
  </div>
</section>
```

**事件 → step 映射：**

| `AgentRunEvent.type` | step id | 标题 | status 变化 |
|----------------------|---------|------|-------------|
| `run.started` | `context` | 准备上下文 | `running` |
| `message.started` / `message.delta` | `message` | 生成回复 | `running` → `streaming` |
| `message.completed` | `message` | 生成回复 | `completed` |
| `tool.call.started` | `tool-{id}` | 调用工具: `{name}` | `running` |
| `tool.call.completed` | `tool-{id}` | 调用工具: `{name}` | `ok?` → `completed` / `failed` |
| `tool.result` | `tool-{id}` | 处理工具结果 | `ok?` → `completed` / `failed` |
| `command.result` | `command-{eventId}` | 执行命令 | `exitCode === 0` → `completed` / `failed` |
| `file.reference` | `file-{eventId}` | 引用文件 | `completed` |
| `diff.proposal` | `diff-{proposalId}` | 生成 Diff | `completed` |
| `run.completed` | — | — | 收尾所有 `running` step → 同终态 |
| `run.failed` | `failure` | 执行失败 | `failed` + 错误 message |

**交互细节：**

- run 一旦进入终态（`status !== "running"`），面板自动折叠（`useEffect` → `setCollapsed(true)`）。
- 未终态时，summary 旁显示 `${agentName} 运行中`；每秒钟一次 `setNowMs(Date.now())` 刷新已处理时长。
- 进度列表只显示 `info` / `warning` / `error` 三档；`body` 超过 160 字符会 `compactText` 省略。
- `TypingDots` 用纯 CSS 三个 span + animation 模拟；只在 step.status === "running" 时出现。

### 3. `agent_assignment` 卡片（`renderers/AgentAssignmentMessage.tsx`）

只在群聊里出现（单聊没有 `dispatch_step_id`），但 UI 复用 `structured-message-card` 体系，文档放在这里便于对照。

```tsx
<article className="structured-message-card agent-assignment-message">
  <header>
    <span>{agentName}</span>
    <small>子 Agent 执行结果</small>
  </header>
  <body>
    <p>{summary}</p>
    <actions>
      [查看详情] [查看 Diff] [查看产物] [查看日志]
    </actions>
  </body>
</article>
```

按钮触发的事件：

- `查看详情` → 派发 `agenthub:open-inspector` 切到 `Runtime`。
- `查看 Diff` → 派发 `agenthub:open-diff` 携带 `workspaceId + diffProposalId` + `agenthub:open-inspector` 切到 `Diff`。
- `查看产物` → 派发 `agenthub:open-artifact` 携带 artifactId，切到 `Preview`。
- `查看日志` → 同 `查看详情`。

### 4. `text` 流式气泡（`MessageRenderer` 默认分支）

单聊最常见形态：assistant 消息 `MessageStatus` 走 `streaming` → `completed` / `failed`：

- `streaming`：气泡下方挂 `TypingDots`；content_markdown 持续追加。
- `completed`：徽章 `available` 暗藏；`updatedAt` 标完成时间。
- `failed`：气泡变红 outline，错误以 `<p>` 内联。

### 单聊卡片完整状态流转图

```
用户发消息
   │
   ▼
streamingRunService 创建 assistant 占位（status=streaming）
   │
   ▼
agent_run_events: run.started
   │
   ▼  ┌── AgentRunStepProcess: step[context] = running
   │   │     "正在准备运行上下文"
   │   │
   │   ▼  provider.first delta
   │   ┌── step[message] = running → streaming
   │   │     "正在生成回复"
   │   │
   │   ├── message.thinking_delta ──► step[message] 显示折叠 ThinkingBlock
   │   │
   │   ▼
   │   tool.call.started → step[tool-{id}] = running
   │   │                       "调用工具: read_file"
   │   ▼
   │   tool.result / tool.call.completed → step[tool-{id}] = completed / failed
   │   │
   │   ▼
   │   diff.proposal → step[diff-{id}] = completed
   │                   "已生成 Diff (N 个文件)"
   │   │
   │   ▼  run.completed
   │       ├─ assistant message.status = "completed"
   │       ├─ AgentStatus = "available"
   │       └─ AgentRunStepProcess: 折叠所有 step → 显示 "已处理 12s / 5 个步骤"
   │
   ├── run.failed → 1 张 "执行失败" 红色 step
   │                assistant.status = "failed"
   │                AgentStatus = "error"
   │                AgentStatusMessage role="alert"
   │
   └── status: "iteration_limit_reached" / "verification_failed" / "waiting_for_permission"
                assistant.status = "failed"（UI 兼容）
                AgentStatusMessage 显示对应 detail
```

---

## 3.6.3 群聊协作状态可视化卡片

群聊界面（`GroupChatWindow` → `MessageList`）由 5 类结构化卡片叠加而成 + 1 个 PlanPanel 顶栏。

### 1. `GroupRunPlanPanel` 顶栏（`GroupRunTimeline.tsx` 末尾导出）

常驻在群聊消息流顶部，是协作态的"指挥台"。

**展开态：**

```tsx
<section className="group-run-plan-top group-run-plan-top-expanded">
  <header className="group-run-plan-top-header">
    <div className="group-run-plan-title">
      <PanelSparkIcon />
      <div>
        <strong>${modeLabel} 计划</strong>   // @ 指定分派 / 自动分派 / 主 Agent 直接处理
        <small>Run {runId.slice(0,8)}</small>
      </div>
    </div>
    <span className={`group-run-plan-status group-run-plan-status-${statusClass}`}>
      {statusLabel}                          // 来自 RUN_STATUS_LABELS
    </span>
  </header>
  <div className="group-run-plan-card-grid">
    {run.steps.map(step => (
      <article className={`group-run-plan-agent-card-${step.status}`}>
        <div className="group-run-plan-agent-icon">{initial}</div>
        <body>
          <header>
            <strong>{agentName}</strong>
            <small>第 {roundIndex+1} 轮</small>
          </header>
          <p>{getStepNarrative(step)}</p>
          <footer>
            <span className={`group-run-plan-step-dot-${step.status}`} />
            <small>{STEP_STATUS_LABELS[step.status]}</small>
            {working ? <TypingDots /> : null}
          </footer>
          {!working ? <StepActions ... /> : null}
        </body>
      </article>
    ))}
  </div>
  <footer>
    <span>创建时间 {formatRunCreatedAt(run.createdAt)}</span>
    <span>{getRunProgressText(run)}</span>  // "已完成 2/3" / "已完成 2/3，失败 1"
  </footer>
  <button className="group-run-plan-edge-button-up">ˆ</button>
</section>
```

**折叠态：**

```tsx
<section className="group-run-plan-top group-run-plan-top-collapsed">
  <div className="group-run-plan-strip">
    <PanelSparkIcon />
    <strong>${modeLabel} 计划</strong>
    <span className={`group-run-plan-status-${statusClass}`}>{statusLabel}</span>
    <small>{getRunProgressText(run)}</small>
  </div>
  <button className="group-run-plan-edge-button-down">˅</button>
</section>
```

**状态 → 视觉映射：**

| `GroupRunStatus` | `statusClass` | chip 配色 | 卡片内点状态 |
|---|---|---|---|
| `planning` / `running` / `running_subagents` / `redispatching` | `running` | 蓝色 | 全部 step 蓝/灰 + pulsing |
| `reviewing` / `summary_started` | `running` | 蓝色 | 已完成 step 绿，正在 review 的无 step 卡片 |
| `completed` | `completed` | 绿色 | 全部 step 绿 |
| `partial` / `partial_failed` | `failed` | 黄色 | 绿/红混合 |
| `failed` | `failed` | 红色 | 全部 step 红 |
| `waiting_for_user` | `running` | 蓝色 + 角标 | step 混合，提示用户 |
| `cancelled` / `unknown` | `running` | 灰色 | 折叠态显示 |

**交互：**

- 卡片右上"˅/ˆ"按钮 → 切换折叠/展开（`useState<boolean>`）。
- Step 卡片点 `查看详情` → 打开 `GroupRunPlanDialog` 模态层（与顶栏共用 DOM）。
- Step 卡片点 `查看 Diff` / `查看日志` → 通过 `agenthub:open-diff` / `agenthub:open-inspector` 切到 Inspector 的 Diff / Runtime Tab。

### 2. `GroupRunPlanDialog` 模态层（`GroupRunTimeline.tsx` 内部组件）

用户点"打开详细分派计划"时全屏覆盖。

```tsx
<div className="group-run-plan-layer" role="presentation">
  <button className="group-run-plan-scrim" onClick={onClose} />        // 半透明遮罩
  <section className="group-run-plan-popover" role="dialog" aria-modal="true">
    <header>
      <div>
        <span>${modeLabel}</span>
        <small>Run {runId.slice(0,8)}</small>
      </div>
      <strong>{statusLabel}</strong>
      <button className="group-run-plan-close" onClick={onClose}>x</button>
    </header>
    <p>主 Agent 已分派 N 个子 Agent，按事件状态驱动协作进度。</p>
    <div className="group-run-plan-steps">
      {run.steps.map(step => (
        <section className={`group-run-step-${step.status}`}>
          <header>
            <strong>{agentName}</strong>
            <small>第 {roundIndex+1} 轮</small>
            <span>{statusLabel}</span>
          </header>
          <p className="group-run-step-instruction">{instruction}</p>
          {reason ? <p className="group-run-step-reason">{reason}</p> : null}
          {summary ? <p className="group-run-step-summary">{summary}</p> : null}
          <StepActions ... />
          {expanded ? (
            <dl>
              <dt>Step</dt><dd>{stepId}</dd>
              <dt>Agent</dt><dd>{agentId}</dd>
              <dt>验收项</dt><dd>{targetCriteria.join(" / ")}</dd>
              {errorMessage ? <><dt>Error</dt><dd>{errorMessage}</dd></> : null}
            </dl>
          ) : null}
        </section>
      ))}
    </div>
  </section>
</div>
```

每个 step 卡片可独立 `toggleStep(stepId)` 展开 dt/dd 详情；按 `Esc` 关闭模态（`window.addEventListener("keydown", ...)`）。

### 3. `GroupRunTimeline` 内联消息流（`GroupRunTimeline.tsx` 主体导出）

每个 group run 对应一个 `group-run-flow` 块，按事件流实时回放。

```tsx
<section className="group-run-inline-feed" aria-label="团队协作进度">
  {runs.map(run => (
    <div className="group-run-flow">
      <div className="group-run-flow-status">
        <span>团队协作</span>
        <strong>{RUN_STATUS_LABELS[run.status]}</strong>
      </div>
      {run.steps.map(step => (
        <article className={`group-agent-flow-message group-agent-flow-${step.status}`}>
          <div className="group-agent-flow-avatar">{initial}</div>
          <div className="group-agent-flow-bubble">
            <header>
              <strong>{agentName}</strong>
              <span>{statusLabel}</span>
            </header>
            <p>{getStepNarrative(step)}</p>
            <StepProgressList compact progress={step.progress} />  // 只显示最后 4 条
            {working ? <TypingDots /> : <StepActions ... />}
          </div>
        </article>
      ))}
      {run.status === "reviewing" && !run.summaryMessageId ? (
        <article className="group-agent-flow-message group-agent-flow-summary">
          <div className="group-agent-flow-avatar">总</div>
          <div className="group-agent-flow-bubble">
            <header><strong>主 Agent</strong><span>汇总中</span></header>
            <p>正在汇总子 Agent 的结果，生成最终报告。</p>
            <TypingDots />
          </div>
        </article>
      ) : null}
    </div>
  ))}
</section>
```

**关键交互细节：**

- **去重**：重分派产生的"同 agent 新 step"用 `dedupeRetriedSteps` 只保留 `roundIndex` 最大的那条，避免 step 列表线性膨胀。
- **进度列表**：`compact` 模式下仅显示最近 4 条 progress，未尽列表在 Dialog 完整版可看。
- **narrative 文案**：`getStepNarrative(step)` 根据状态返回不同叙事（`completed`/`partial` → summary；`failed`/`iteration_limit_reached`/`cancelled` → errorMessage；`pending`/`queued` → instruction）。
- **状态文案字典**（`STEP_STATUS_LABELS`）：`pending` / `queued` → "等待"；`running` / `streaming` → "运行中"；`completed` → "完成"；`partial` → "部分完成"；`failed` → "失败"；`iteration_limit_reached` → "达到上限"；`waiting_for_permission` → "等待权限"；`cancelled` → "已取消"；`skipped` → "已跳过"。

### 4. `dispatch_plan` 卡片（`renderers/DispatchPlanMessage.tsx` + `DispatchPlanCard.tsx`）

由 `dispatchService.createPlanMessage` 在 `plan_created` 时写入；元数据里带 `assignments[]` + `agentNames{}` + `score{}` + `reason`。

```tsx
<article className="structured-message-card dispatch-plan-message">
  <header>
    <div>
      <span>分派计划</span>
      {roundIndex ? <small>第 {roundIndex+1} 轮</small> : null}
    </div>
    <strong>{assignments.length} 步</strong>
  </header>
  <div className="structured-message-list">
    {assignments.map((a, i) => (
      <section className="structured-message-item">
        <header>
          <strong>{a.taskTitle ?? a.agentName}</strong>
          <span>{a.status}</span>
        </header>
        {a.taskTitle ? <small>Agent: {a.agentName}</small> : null}
        <p>{a.instruction}</p>
        {a.finalScore !== undefined ? <small>Score: {a.finalScore.toFixed(2)} · 能力匹配: ...</small> : null}
        {a.matchedSkills.length > 0 ? <small>匹配 Skill: {...}</small> : null}
        {a.reason ? <small>选择理由: {a.reason}</small> : null}
        {a.targetCriteria.length > 0 ? <small>验收项: {...}</small> : null}
        {a.dependsOn.length > 0 ? <small>依赖: {...}</small> : null}
        {a.targetFiles.length > 0 ? <small>目标文件: {...}</small> : null}
      </section>
    ))}
  </div>
</article>
```

旧 path（`runLegacyAutoDispatch`）的 metadata 是 `plan.steps[]`（无 `assignments`），`DispatchPlanMessage` 通过 `getAssignments` 兼容读取。

`DispatchPlanCard` 则是更全的版本（含 `orchestratorReview.decision` + Acceptance Criteria 列表 + `重新执行` 按钮）：

```tsx
<div className="dispatch-plan-card">
  <div className="dispatch-plan-header">
    <span className="dispatch-plan-mode">
      {mode === "mention" ? "@ 指定执行" : mode === "auto_dispatch" ? "自动分派" : "主 Agent 回复"}
    </span>
    <span className={`dispatch-run-status-${status}`}>{statusLabel}</span>
  </div>
  <div className="dispatch-plan-round">当前轮次: {roundIndex+1}</div>
  {acceptanceCriteria.length > 0 ? (
    <div className="dispatch-plan-criteria">
      <strong>Acceptance Criteria</strong>
      {acceptanceCriteria.map(c => (
        <div className={`dispatch-criterion-${c.status}`}>[{c.status}] {c.description}</div>
      ))}
    </div>
  ) : null}
  <div className="dispatch-plan-steps">
    {steps.map(step => (
      <div className={`dispatch-step-${step.status}`}>
        <div className="dispatch-step-header">
          <span className="dispatch-step-agent">{agentName}</span>
          <span className={`dispatch-step-status-${step.status}`}>{statusLabel}</span>
        </div>
        <div className="dispatch-step-instruction">{instruction}</div>
        <div className="dispatch-step-budget">round {round+1}, maxIterations={maxIter}</div>
        {subAgentResult ? <div className="dispatch-step-result">{summary}</div> : null}
        {status === "failed" && errorMessage ? <div className="dispatch-step-error">{errorMessage}</div> : null}
        {status === "failed" && onRetryStep ? (
          <button onClick={() => onRetryStep(step.id)}>重新执行</button>
        ) : null}
      </div>
    ))}
  </div>
  {orchestratorReview ? (
    <div className="dispatch-plan-review">
      <strong>Orchestrator Review: {decision}</strong>
      <div>{reason}</div>
    </div>
  ) : null}
</div>
```

**状态 → 视觉映射：**

| `DispatchStepStatus` | `dispatch-step-*` class | 颜色 |
|---|---|---|
| `pending` | `dispatch-step-pending` | 灰 |
| `running` / `streaming` | `dispatch-step-running` | 蓝 |
| `completed` | `dispatch-step-completed` | 绿 |
| `partial` | `dispatch-step-partial` | 黄 |
| `failed` | `dispatch-step-failed` | 红 + 错误条 + 重新执行按钮 |
| `iteration_limit_reached` | `dispatch-step-failed` | 红 + 提示达到上限 |
| `waiting_for_permission` | `dispatch-step-running` | 黄 + 等待权限角标 |
| `cancelled` | `dispatch-step-pending` | 灰 + 删除线 |
| `skipped` | `dispatch-step-pending` | 灰 + 删除线 |

**Acceptance Criterion 状态（`AcceptanceCriterion.status`）：**

- `pending` → `[pending]` 灰
- `satisfied` → `[satisfied]` 绿
- `failed` → `[failed]` 红
- `unknown` → `[unknown]` 黄（review 时无法判定是否完成）

### 5. `agent_assignment` 卡片（见 3.6.2 第 3 段）

群聊里每个 step 完成后由 `executeSubAgentStep` 内 `insertMessage` 写入。卡片 button 跳转与单聊对齐。

### 6. `orchestrator_summary` 卡片（`renderers/OrchestratorSummaryMessage.tsx`）

由 `dispatchService.createFinalSummary` 写库，summary 内容由 `runGroupOrchestratorSynthesis` LLM 产出（失败时降级到 `createFallbackUserFacingSummary`）。

```tsx
<article className="structured-message-card orchestrator-summary-message">
  <header>
    <div>
      <span>主 Agent 总结</span>
      {status ? <small>{status}</small> : null}     // 来自 metadata.status
    </div>
  </header>
  <div className="structured-message-body">
    <MessageMarkdown text={text} />
  </div>
</article>
```

`status` 字段（`completed` / `partial` / `partial_failed` / `failed`）写在 metadata，UI 透出但不强制改色。

### 群聊卡片完整状态流转图

```
用户发消息
   │
   ▼
GroupRunPlanPanel 顶栏出现
   │  chip = 规划中 (planning)
   │
   ▼  group_run_event: plan_created
   ├─ DispatchPlanMessage 卡片（带 assignments + 评分 + 选择理由）
   ├─ GroupRunPlanPanel 展开: chip = 已生成计划
   │  卡片网格中每个 step 灰底 (pending)
   │
   ▼  updateDispatchRunStatus(running_subagents)
   │  chip = 子 Agent 执行中
   │  每张 step 卡:
   │     running → streaming → 实时 progress 列表
   │     TypingDots 在每张 working step 旁闪烁
   │
   ▼  每个 step 落幕:
   │   ┌── 成功 → agent_assignment 卡片 (completed)
   │   │            绿色 chip + summary + [查看 Diff] [查看产物]
   │   ├── 部分完成 → agent_assignment 卡片 (partial)
   │   │            黄色 chip
   │   └── 失败 → agent_assignment 卡片 (failed)
   │              红色 chip + 错误条 + [重新执行] 按钮
   │
   ▼  reviewAcceptanceCriteria
   │   ┌── decision = complete → 跳出 review
   │   ├── decision = redispatch → chip = 重新分派中
   │   │                       轮次 +1
   │   │                       (UI: 每张 step 卡按 roundIndex 更新"第 N 轮")
   │   │                       回到 running_subagents
   │   ├── decision = need_user_input → chip = 等待用户
   │   └── decision = partial / failed → 跳出
   │
   ▼  summary_started
   │  额外插入一张 group-agent-flow-summary "主 Agent 汇总中" 卡片
   │  TypingDots 持续
   │
   ▼  runGroupOrchestratorSynthesis
   │  OrchestratorSummaryMessage 卡片出现 (最终 Markdown)
   │
   ▼  updateDispatchRunStatus(finalStatus)
      ├─ completed → 绿 chip "已完成"
      ├─ partial_failed → 黄 chip "部分失败"
      ├─ failed → 红 chip "失败"
      ├─ waiting_for_user → 蓝 chip "等待用户"
      └─ cancelled → 灰 chip "已取消"
```

### 群聊状态可视化"读图速查"

| 我看到... | 含义（来自代码） |
|---|---|
| 顶栏 chip = 规划中 + PlanPanel 没有 step 卡 | 主 Agent 还在做 `runGroupOrchestratorDecision`，还没有合法 plan。 |
| 顶栏出现 N 张 step 卡片，灰底 | `plan_created` 阶段，N = `assignments.length`。 |
| step 卡右侧 `TypingDots` | 该 step.status ∈ `pending` / `running` / `streaming` / `waiting_for_permission`（`WORKING_STEP_STATUSES`）。 |
| step 卡片下方 progress 列表 `phase: parse` + warning | SubAgentResult JSON 解析失败，正在触发 `manifestRepair` 或重试。 |
| 顶栏 chip = 重新分派中，step 卡片"第 N 轮" +1 | `decision = redispatch` 触发 `createRepairAssignments`，`roundIndex += 1`。 |
| 顶栏多出一张 "主 Agent 汇总中" 卡片 | DispatchRun 进入 `reviewing` 且 `summaryMessageId` 还没落库。 |
| 顶栏 chip = 已完成 + 末尾 `OrchestratorSummaryMessage` | `toFinalGroupRunStatus` = `completed`；所有 required 验收项 satisfied。 |
| 顶栏 chip = 失败 + step 卡片红色 + `重新执行` 按钮 | 单 step 失败且 `onRetryStep` 可用；点按钮会调 `dispatchService.retryDispatchStep`。 |
| DispatchPlanCard 下方 `Orchestrator Review: redispatch` | 上一轮 review 决策为 redispatch，进入下一轮。 |

---

## 附：状态机实现要点速查

- **写库原子性**：所有状态切换都包在 `db.transaction(() => …)()` 里（`agentRunService.updateStatusSafely` / `dispatchService` 内多处 `updateDispatchRunExecution` + `updateDispatchRunStatus` 在同一事务中完成）。
- **会话级锁**：`conversationRunLock.acquireConversationRun` 是进程内 Map + DB 唯一索引的双层保护；任何 run 进入 / 离开都对应 `ConversationRun.status` 的 `running` / `completed` / `failed` / `cancelled`。
- **事件流幂等**：`streamingRunService` 通过 `insertAgentRunEvent` 的 `(runId, seq)` 唯一约束保证重放幂等；`groupRunEventRepo.createGroupRunEvent` 同样带 seq 单调递增。
- **执行上限（`AGENT_EXECUTION_LIMITS`）**：
  - `singleChatMaxIterations: 40`
  - `groupSubagentMaxIterations: 15`
  - `groupMaxRedispatchRounds: 3`
  - `groupMaxAgentsPerRound: 3`
  - `orchestratorReviewMaxIterations: 5`
- **重分派轮次**：`reviewAcceptanceCriteria` 内部 `roundIndex >= groupMaxRedispatchRounds` 时直接降级为 `partial` / `failed`，不再生成修复 assignment。
- **进度事件 phase 字典**（来自 `GroupRunAgentProgressPayload.phase`）：`context` / `runtime` / `model` / `stream` / `parse` / `validation` / `complete`，分别对应 AgentHub 子 Agent 流水线里的不同阶段。
