# 3. Orchestrator 调度设计

> 本章对应代码目录：`src/main/services/`
> 核心文件：`orchestratorRuntimeService.ts`、`orchestratorSystemPrompt.ts`、`mainAgentDecision.ts`、`dispatchService.ts`、`dispatch/agentScoring.ts`、`dispatch/mentionParser.ts`、`groupExecutionService.ts`、`mainAgentContextService.ts`、`conversationRunLock.ts`、`agentProjectExperienceService.ts`。
> 共享类型：`shared/groupChat.ts`、`shared/agentExecution.ts`。

AgentHub 的 Orchestrator（主 Agent）是群聊/单聊的"大脑 + 调度器"。它承担：

1. 接收用户消息、构造 LLM 输入上下文；
2. 让 LLM 产出 `MainAgentDecision`（`direct_answer` / `ask_clarification` / `dispatch_agents`）；
3. 把决策转成 `SubTask` 列表 + `AgentAssignment` 列表（带 DAG 依赖）；
4. 用能力 / 工具 / 上下文 / 历史可靠性四维评分挑选子 Agent；
5. 用 DAG 调度器分批执行子 Agent，并行无依赖任务、串行有依赖任务；
6. 收集每个子 Agent 的结构化 `SubAgentResult`，做冲突检测 + 重新分派；
7. 串行迭代重分派到 `groupMaxRedispatchRounds`，由主 Agent 出最终汇总回复。

整体数据流：

```
用户消息
  │
  ▼
acquireConversationRun （会话级锁）
  │
  ▼
handleGroupUserMessage
  │
  ├─ parseMentionNames  →  mention 模式
  │
  ▼
runMainAgentAutoDispatch
  │
  ├─ runGroupOrchestratorDecision （Router LLM 意图识别）
  │      │
  │      ▼
  │   parseMainAgentDecision
  │      │
  │      ▼
  │   MainAgentDecision  =  dispatch_agents
  │
  ▼
createScoredAssignmentsFromSubTasks   ← 能力 Judge + 工具/上下文/历史 评分
  │
  ▼
executeStructuredGroupDispatch
  │
  ├─ createDispatchStep × N
  ├─ buildExecutionBatches  ←  按 dependsOn 拓扑分层，冲突降级
  ├─ Promise.all(每批 executeSubAgentStep)
  ├─ reviewAcceptanceCriteria
  │     ├─ complete            → 出汇总
  │     ├─ redispatch          → 下一轮 createRepairAssignments
  │     ├─ need_user_input     → 停
  │     └─ partial / failed    → 停（达到上限）
  ▼
runGroupOrchestratorSynthesis  （最终汇总 LLM）
  │
  ▼
updateExperiencesAfterGroupDispatch   ←  Agent 经验沉淀
```

---

## 3.1 输入上下文构造

主 Agent 每次被触发，都会按以下顺序拼装 LLM 上下文。

### 3.1.1 会话级锁

文件：`src/main/services/conversationRunLock.ts`

- `activeConversationRuns: Map<conversationId, runId>` 是进程内 Map，热路径避免再走一次 DB。
- DB 真实表 `conversation_runs` 上有 `status = 'running'` 的部分 UNIQUE 索引，从存储层阻止两个并发 run 写入。
- `acquireConversationRun({ conversationId, agentId })` 成功后返回一个 `AcquiredRunLock`，调用方必须在 `finally` 里 `release("completed" | "cancelled")` 或 `fail(errorMessage)`。
- 一旦 `released = true` 被置位，后续 release/fail 都被短路，但 Map 条目和 DB 状态必须只被清理一次。

```ts
// 关键调用顺序（dispatchService.handleGroupUserMessage 之外，由 streaming run service 持有）
const lock = acquireConversationRun({ conversationId, agentId });
try { … } finally { lock.release("completed"); }
```

### 3.1.2 Workspace 解析

- 群聊下，`resolveExecutionWorkspaceForGroup(conversationId, db)` 用 conversation 绑定的 `workspaceContextId` 决定本次执行的工作区根目录（覆盖默认 workspace.rootPath），从而把代码改动落地到正确的子目录。
- 单聊下，直接使用 `workspace.rootPath`。

### 3.1.3 上下文构造

文件：`src/main/services/mainAgentContextService.ts`

主 Agent 输入由三段组成：

| 段 | 构造者 | 用途 |
|----|-------|------|
| System Prompt | `orchestratorSystemPrompt.buildGroupOrchestratorSystemPrompt(...)` | 角色、硬性约束、回复格式、Workspace 信息、可用子 Agent 列表、@候选池、最近对话 |
| 持久化压缩摘要 | `getConversationCompactSummaries` + `findSummaryCoverage` | 把已经超出最近 N 条的旧消息压缩成可重用 memory；只在摘要 `coveredMessageStartId / EndId` 仍能命中真实消息时使用 |
| 近期原始消息 | `getMessagesByConversation` 后取尾部 `RECENT_RAW_MESSAGE_LIMIT = 20` 条 | 给 LLM 看最近真实交互，避免摘要失真 |

压缩触发条件：

```ts
while (payload.usage.contextRatio >= COMPACT_TRIGGER_RATIO  // 0.95
       && compactAttempts < MAX_COMPACT_ATTEMPTS) {           // 2
  const summary = await compactEarlierHistory(...);
  payload = buildMainAgentContextPayload(input, db);
}
```

- 压缩提示词 `COMPACT_SYSTEM_PROMPT` 强约束输出 9 个固定段落（User Goal / Confirmed Decisions / Architecture Constraints / Implemented So Far / Pending Work / Bugs Risks / Important Files Symbols / DiffProposal State / Open Questions）。
- 二次压缩比一次压缩"更激进"（`buildCompactUserPrompt` 中 `compactStrength` 切换）。
- 如果压缩后仍 `contextRatio >= 1` → 抛 `LLMError`，提示用户清理文件 / 终端输出 / 启用 1M 上下文 / 新建会话。

### 3.1.4 System Prompt 拼装

文件：`src/main/services/orchestratorSystemPrompt.ts`

`buildGroupOrchestratorSystemPrompt(workspace, groupAgents, recentMessages, mentionAgentIds?)` 的关键段落：

1. `GROUP_ROLE_PROMPT`：身份（"你是 AgentHub 群聊中的主 Agent，负责任务拆解和调度"）+ 4 条职责。
2. `GROUP_CONSTRAINTS` 9 条硬约束，例如：
   - 主 Agent 不直接写文件，必须由子 Agent 生成 `DiffProposal` → 用户确认 → `apply_diff`。
   - 分派时只拆 `SubTask`，不在 subTasks 中选 `agentId`（由系统评分选）。
   - 用户 `@` 了 Agent 时，系统会把候选池锁定到这些 Agent；你仍然只拆任务。
   - DAG 由系统处理：依赖任务串行，无依赖任务并行，同文件写 Diff 串行。
3. `GROUP_OUTPUT_GUIDANCE` 直接给出一份 `DispatchPlan` JSON Schema，约束 subTask 字段（`requiredSkillQueries` / `requiredTools` / `taskType` / `targetFiles` / `dependsOn` / `riskLevel` / `expectedOutputType`）。
4. `buildWorkspaceSection`：当前 workspace 的 name / rootPath / gitEnabled。
5. `buildGroupAgentsSection`：列出每个子 Agent 的 id / name / provider / capabilities / 启用的 tools / 是否 `write_diff`。
6. `mentionAgentIds` 存在时追加 `## 用户 @ 的 Agent` 段，提示候选池硬约束。
7. `buildRecentMessagesSection`：最近 10 条消息的精简回显（>200 字截断）。

单聊版本（`buildOrchestratorSystemPrompt`）更轻量：要求直接 Markdown 回答，不产出 DispatchPlan。

### 3.1.5 消息角色映射

```ts
function getSubAgentMessageRole(message, conversation) {
  if (message.senderType === "user") return "user";
  if (message.senderType === "system") return "system";
  return message.senderId === conversation.mainAgentId ? "main_agent" : "sub_agent";
}
```

下游子 Agent 看到的对话里，"主 Agent"和"子 Agent"被显式区分，便于它理解上下文来自谁。

---

## 3.2 意图识别模块（Router LLM Prompt + 规则兜底）

文件：`src/main/services/orchestratorRuntimeService.ts`、`src/main/services/mainAgentDecision.ts`、`src/main/services/dispatchService.ts`、`src/main/services/dispatch/mentionParser.ts`。

意图识别是分层兜底的：

### 3.2.1 第一层：硬规则拦截（最快、最确定）

- `shouldRedirectManualSubAgentCreation(rawText)` 同时匹配"agent / 智能体 / 助手"和"创建 / 新增 / add / create"等关键词 → 直接回复 `MANUAL_SUB_AGENT_CREATION_GUIDANCE_TEXT`，不调用 LLM。
- `parseMentionNames(content)` 用正则 `@([\w一-鿿][\w一-鿿\s-]*?)(?=[\s,，]|$|@)` 抓 `@<名字>`，结果按出现顺序去重，最多 `MAX_DISPATCH_STEPS = 30` 个：
  - 若解析到的名字命中群内可用 sub Agent → 走 `mention` 模式，候选池锁定为这些 Agent。
  - 若 `@` 命中主 Agent / 非群成员 / 不可用 Agent → 走 `runBlockedMentionDispatch`，发一条原因消息并把 dispatch run 标记为 `failed`，**不会** fallback 到自动分派。

### 3.2.2 第二层：Router LLM 决策

调用 `runGroupOrchestratorDecision({ workspaceId, conversationId, userMessage, mentionAgentIds })`：

1. 读主 Agent 的 `MainAgentModelConfig`（`loadMainAgentConfig(rootPath)`，从 workspace 的 `agenthub.config.json` 读 `provider` / `model` / `limits`）。
2. 用 `buildGroupOrchestratorSystemPrompt(...)` 拼 system prompt。
3. 取最近 20 条消息 `formatMessageForLLM` 转为 `[{ role, content }]`。
4. 调 `callLLM(config, systemPrompt, llmMessages)` 拿到原始文本。
5. 调 `parseMainAgentDecision(rawOutput)` 解析为 `MainAgentDecision` 联合类型：
   - `direct_answer`
   - `ask_clarification`
   - `dispatch_agents`（带 `acceptanceCriteria` + `plan: { executionMode, steps, subTasks? }`）

### 3.2.3 第三层：解析兜底

`parseMainAgentDecision` 的容错链（见 `mainAgentDecision.ts`）：

1. **完全空字符串** → `{ ok: false, error: "LLM output is empty." }`，上层 fallback 为"主 Agent 没有返回内容"。
2. **尝试 strip markdown fence 后整段 `JSON.parse`**。
3. **首尾花括号截取**后再次 `JSON.parse`。
4. **任何路径上拿不到合法 JSON** → 把整段 raw text 包成 `{ intent: "direct_answer", responseText: trimmed }`。这是预期的默认路径——系统提示词里就要求普通回答用 Markdown，不应该包成 JSON。
5. **JSON 合法但 `intent` 缺失 / 非预期值** → 同样降级为 `direct_answer`。
6. **JSON 合法且 `intent === "dispatch_agents"`，但 `plan` 缺/校验失败** → 降级为 `direct_answer`，由 `dispatchService` 再按 `@` 解析决定是否分派。

`validateDispatchPlan` 的关键校验（`mainAgentDecision.ts`）：

- `subTasks` 数组必须非空；
- 每个 subTask 的 `id` 唯一；
- `riskLevel ∈ { low, medium, high }`，`expectedOutputType ∈ { analysis, design, diff_proposal, test_plan, summary }`；
- `dependsOn` 中的 id 必须都能在本批 subTasks 中找到（防止悬挂依赖）；
- 若执行 `dispatch_agents` 同时提供了旧的 `steps` 字段，仍能通过 `validateDispatchPlan` 校验为兼容路径。

### 3.2.4 决策分发

`runOrchestratorAutoDispatch`（`dispatchService.ts`）根据 `decision.intent` 分发：

| intent | 行为 |
|---|---|
| `dispatch_agents` + subTasks 非空 | 走 `createScoredAssignmentsFromSubTasks` 评分 → `executeStructuredGroupDispatch` |
| `dispatch_agents` + 仅有 `steps`（旧格式） | `validateOrchestratorDispatchPlan` 校验 → 包装成 `AgentAssignment` → 同样进 `executeStructuredGroupDispatch` |
| `direct_answer` / `ask_clarification` | **如果带 `mentionAgentIds`**（用户显式 `@`）→ 强制按用户指定 Agent 跑一个默认 subTask；否则直接写一条 `text` 消息并把 dispatch run 标记为 `completed`，**不**进入分派循环 |
| 异常 | 写一条 `Orchestrator 调度失败: ...` 消息，dispatch run → `failed` |

### 3.2.5 子 Agent 侧二次意图识别（Capability Judge）

主 Agent 的决策用于"是否分派 / 拆什么任务"。**给每个 subTask 选谁**则由 `runGroupCapabilityMatchJudge` 完成（`orchestratorRuntimeService.ts` 末尾）：

- 输入：subTask + 候选 Agent 列表（取 fallback 评分 Top 8，避免 LLM 调用过宽）。
- 输出 `CapabilityMatchResult[]`：`capabilityMatch` / `confidence` / `matchedSkills` / `missingSkills` / `reason`。
- 这是**可选 LLM 增强**：若失败就只用 `fallbackCapabilityMatch` 的确定性 token 重叠打分（见 3.4.2），调度仍可继续。

---

## 3.3 任务拆解与依赖图构建（DAG 任务流、并行/串行调度）

文件：`src/main/services/dispatchService.ts`（`createScoredAssignmentsFromSubTasks` / `executeStructuredGroupDispatch`）、`src/main/services/dispatch/agentScoring.ts`（`buildExecutionBatches`）、`src/main/services/groupExecutionService.ts`（`createRepairAssignments`）。

### 3.3.1 SubTask 数据结构

`SubTask`（`shared/groupChat.ts`）字段：

| 字段 | 含义 |
|---|---|
| `id` | subTask 唯一 id，依赖图节点 |
| `title` / `objective` | 任务短名 + 可执行目标 |
| `acceptanceCriteria: string[]` | 引用外层 `AcceptanceCriterion.id` |
| `requiredSkillQueries: string[]` | 用于能力匹配的语义查询 |
| `requiredTools: string[]` | 必需工具，归一化后匹配 `readFile` / `writeDiff` 等 |
| `taskType` | `frontend` / `backend` / `test` / `design` / `analysis` / `docs` / `general` |
| `targetFiles?` | 写 Diff 时锁定的相对路径；冲突检测的关键 |
| `dependsOn: string[]` | 其他 subTask.id |
| `riskLevel: low / medium / high` | `high` 时下游会安排 reviewer Agent |
| `expectedOutputType` | `analysis` / `design` / `diff_proposal` / `test_plan` / `summary` |

### 3.3.2 SubTask 来源

1. **主 Agent LLM 拆解**（首选）：`decision.plan.subTasks` 已经在 Router LLM Prompt 中给出 Schema。
2. **兜底拆解（`buildDefaultSubTask`）**：当 `@` 模式但 LLM 给出 `direct_answer` 时，系统自己用关键词推断生成一个 subTask：
   - `inferExpectedOutputType` 用正则判 `diff_proposal` / `test_plan` / `design` / `summary` / `analysis`。
   - `extractTargetFiles` 用正则 `(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+` 抓文件路径，最多 8 个。
   - 风险等级默认 `low`，但如果 `expectedOutputType === "diff_proposal"` 则升级为 `medium`，并强制 `requiredTools` 含 `read_file` + `write_diff`。
3. **修复轮拆解（`createRepairAssignments`）**：审核未通过时，只对 `unresolvedCriteria` 生成新 assignment，复用同一 Agent，复用其 `nextSuggestedTask` 字段。

### 3.3.3 DAG 拓扑与并行 / 串行

`buildExecutionBatches(assignments)` 的核心循环（`agentScoring.ts`）：

```ts
while (pending.length > 0) {
  const ready = pending.filter(a =>
    (a.dependsOn ?? a.subTask?.dependsOn ?? [])
      .every(id => completedTaskIds.has(id))
  );
  if (ready.length === 0) {           // 防止死锁：仍弹一个出去单跑
    batches.push([pending.shift()!]);
    continue;
  }
  // 同一批内还要做写文件冲突检测
  const batch = ready.filter(a =>
    !batch.some(existing => hasFileWriteConflict(existing, a))
  );
  const selected = batch.length > 0 ? batch : [ready[0]];
  selected.forEach(a => {
    completedTaskIds.add(a.subTask?.id ?? a.id);
    pending.splice(...);
  });
  batches.push(selected);
}
```

- **并行层**：一个 batch 内的 assignment 在 `executeStructuredGroupDispatch` 中通过 `Promise.all(batchSteps.map(executeSubAgentStep))` 同时启动。
- **串行层**：batch 之间严格按拓扑顺序串行——前一层全部跑完才会进入下一层。
- **文件写冲突降级**：`hasFileWriteConflict` 只在两个 subTask 都是 `diff_proposal` 且 `targetFiles` 有交集时返回 `true`，冲突的那个 subTask 被留到下一批继续跑。`targetFiles` 为空时不视为冲突（因为没有锁定文件，调度无法静态判断）。

### 3.3.4 多轮（轮次内重分派）

`executeStructuredGroupDispatch` 的外层 `while (assignments.length > 0)`：

1. 当前 round `updateDispatchRunStatus("running_subagents")`；
2. `createDispatchStep` 给每个 assignment 落库；
3. `emitGroupRunEvent({ type: "plan_created", payload: { mode, roundIndex, assignments: GroupRunPlanAssignment[] } })`；
4. `createPlanMessage` 写入"第 N 轮分派计划"消息（含每条 assignment 的 score 摘要）；
5. 用 `buildExecutionBatches` 分批 `Promise.all` 执行；
6. `updateDispatchRunStatus("reviewing")`，调 `reviewAcceptanceCriteria`：
   - `decision === "complete"` → break，进入最终汇总；
   - `decision === "redispatch"` → `roundIndex += 1`，`assignments = review.nextAssignments`（已只针对未完成项），继续循环；
   - `decision === "need_user_input"` / `partial` / `failed` → break，进入汇总。
7. 汇总前一轮 dispatch run 的状态进入 `toFinalGroupRunStatus`，与所有 `SubAgentResult` 一起算最终 status（`completed` / `partial_failed` / `failed`）。

`groupMaxRedispatchRounds = 3` 是硬上限，达到后即使仍有未完成项也强制收尾。

---

## 3.4 任务分派策略 评分

文件：`src/main/services/dispatchService.ts`（`createScoredAssignmentsFromSubTasks`）+ `src/main/services/dispatch/agentScoring.ts`。

### 3.4.1 硬过滤（淘汰）

`filterDispatchCandidates({ agents, groupMemberAgentIds, explicitAgentIds?, subTask })`：

| 拒绝原因 | 触发条件 |
|---|---|
| `not_available` | `role !== "sub"` 或 `type !== "specialist"` 或 `status !== "available"` |
| `not_group_member` | 不在当前群聊 `active members` 列表里 |
| `not_in_explicit_pool` | 用户显式 `@` 时，不在 `explicitAgentIds` 集合里 |
| `missing_required_tool` | subTask 声明了 `requiredTools`，Agent 没启用对应工具 |
| `missing_write_diff` | subTask 是 `diff_proposal` 但 Agent 没启用 `writeDiff`（细分于上一条，便于上层显示不同提示） |

若过滤后 `candidates.length === 0`：
- **非显式 @**：抛 `DispatchError`，上层 fallback 走 `runMainAgentDirectReply`。
- **显式 @**：抛 `DispatchError` 并保留被 @ Agent 的拒绝原因（`rejected`），系统不会 fallback（用户明确指定）。

### 3.4.2 能力匹配（双源：LLM Judge + 确定性兜底）

`getCapabilityMatches({ conversation, userMessage, subTask, candidates, db })`：

1. 先对全部 candidates 跑 `fallbackCapabilityMatch`（确定性 token 重叠，见 3.4.3）。
2. 选 fallback 分最高的 Top 8（`shortlist`），避免 LLM 跑长列表。
3. 调 `runGroupCapabilityMatchJudge(...)`（LLM）打分；解析失败时**静默保留 fallback**（注释里强调"可选 LLM 增强失败时调度不能停"）。
4. 输出对每个 candidate 的 `CapabilityMatchResult`：能力匹配、置信度、matched / missing skills。

LLM Judge Prompt（`orchestratorRuntimeService.ts`）的硬约束：

- "You judge only semantic capability fit ... Do not decide the final assignment. Do not score tools, permissions, history, recency, cost, or schedule."
- 评分刻度：0.90-1.00 highly matched / 0.75-0.89 strong / 0.60-0.74 moderate / 0.40-0.59 weak / 0.20-0.39 very weak / 0.00-0.19 no real match。
- 输出必须是 `{"results":[{...}]}` JSON。

### 3.4.3 能力确定性兜底

`fallbackCapabilityMatch(agent, subTask)`（`agentScoring.ts`）：

- 对 `subTask.title / objective / taskType / requiredSkillQueries` 拼出 queryTokens；
- 遍历 agent 的 effective capabilities，按 `overlap / min(|queryTokens|, |capabilityTokens|)` 算 relevance；
- 若 `relevance >= 0.2` 或 capability 文本包含 taskType → 加入 `matchedSkills`（relevance 至少 0.35）；
- 汇总 `capabilityMatch = 0.45 + min(0.4, bestOverlap*0.5) + min(0.15, matchedSkills.length*0.05)`，无任何 matched 技能时降为 0.25；
- `confidence = 0.45`，`reason` 明确说明 "LLM capability judge was unavailable"。

### 3.4.4 工具匹配分

`calculateToolMatch(agent, subTask)`：

- `usefulTools = { readFile } ∪ requiredTools`；若 subTask 是 `diff_proposal` 再加 `writeDiff` + `gitStatus`；若是 `analysis` / `design` 加 `previewArtifact`。
- `requiredTools.length === 0` 时 `base = 0.55`，否则 `base = 0.7`；
- 分数 = `base + (enabled/useful.length) * (1 - base)`，分越高代表"agent 拥有的有用工具越多"。

### 3.4.5 上下文相关分

`getContextRelevance(agentId, conversationId, subTask, db)`：

- 读 `agentProjectExperienceRepo.listByGroup` 拿该 Agent 在当前群聊里的经验记录；
- 基础分 0.2；命中 taskType 关键词 +0.3；命中 `filesTouched` +0.3；有非空 summary/responsibilities +0.2；
- 上限 1.0。

### 3.4.6 历史可靠性

`getHistoricalReliability(agentId, db)`（无经验时默认 0.6）：

- 读 `dispatch_steps` 全表，计算：
  - `successRate = completed / terminalRows`；
  - `failureRate = (failed + cancelled) / terminalRows`；
  - `avgScoreFromMainAgent = (completed * 1 + partial * 0.55 + others * 0.2) / terminalRows`；
  - `diffAcceptedRate = applied / decidedDiffRows`（无 Diff 历史默认 0.6）。
- `observed = 0.4*successRate + 0.3*avgScoreFromMainAgent + 0.2*diffAcceptedRate + 0.1*(1-failureRate)`；
- 按样本量 `confidence = min(1, terminalRows/10)` 做贝叶斯收缩：样本少时往 0.6 拉回。

### 3.4.7 总分

```ts
finalScore = clamp(
  0.4 * capabilityMatch +
  0.2 * toolMatch +
  0.2 * contextRelevance +
  0.2 * historicalReliability
);
```

### 3.4.8 选最佳 + 兜底

`selectBestScore(scores, candidates, explicitAgentIds?)`：

1. 按 `finalScore` 降序取第一个；
2. 若 `finalScore >= 0.55` → 直接选它；
3. 否则：
   - **自动模式**：找 `isGeneralFallbackAgent(agent)` 命中的通用 Agent（关键词 `general / 通用 / 全栈 / full.?stack / codex / coding / implementation`）作为兜底；若没匹配到通用 Agent，**仍然取最高分**但 reason 注明 "自动模式 fallback 到最高可用 Agent"；
   - **显式 @ 模式**：不切换 Agent，reason 改为 "显式 @ 候选池中最高分低于 0.55，系统不会 fallback 到其他 Agent"。

`isDispatchableGroupAgent` 守住一个口径：`role === "sub" && type === "specialist" && status ∈ {"available", "error"}` 才能被分派（`role: "main"` 永远不能成为子 Agent）。处于 `error` 状态的 Agent 也允许被 @ 和加入群聊，便于一次成功的运行把状态清回 `available`。

### 3.4.9 高风险任务的双 Agent 评审

`reviewerAgentId`：当 subTask `riskLevel === "high"` 时，记录 `scores[1]?.agentId`（次高分 Agent）作为下游 diff 复核 reviewer（目前是预留字段，落到 `AgentAssignment` 上，由后续审核逻辑消费）。

---

## 3.5 顺序执行与并行执行

文件：`src/main/services/dispatchService.ts`（`executeSubAgentStep`、`executeStructuredGroupDispatch`）、`src/main/services/agentRunWithConversationService.ts`、`src/main/services/agentRunService.ts`。

### 3.5.1 执行入口

`executeSubAgentStep(step, conversation, triggerMessage, previousOutputs, db, stream, criteria)`：

- 通过 `getAgentById` 校验 Agent 存在，并把 step 状态置为 `running`；
- 用 `resolveExecutionWorkspaceForGroup` 决定本次实际工作区根目录；
- 把 step 的输入上下文快照 `updateStepInputContextSnapshot(step.id, taskInput, db)` 落库，方便后续回溯与审核；
- 调 `buildGroupSubAgentMemoryContext(agent.id, conversation.id, { assignment, previousAgentOutputs, selectedGroupMessages })` 生成层级化 memory 摘要；
- 按 `agent.role` 走两条路径：
  - **`role === "main"`**：直接复用主 Agent 的 `runAgent`，回复写入主对话；
  - **`role === "sub"`**：调 `runAgentWithConversation`，单聊上下文隔离，但执行 scope = `group_subagent`。

### 3.5.2 子 Agent 执行的 ReAct 预算

`agentRunWithConversationService.ts` 中：

```ts
const maxIterations =
  executionMode === "group_subagent"
    ? AGENT_EXECUTION_LIMITS.groupSubagentMaxIterations   // 15
    : executionMode === "orchestrator_review"
      ? AGENT_EXECUTION_LIMITS.orchestratorReviewMaxIterations  // 5
      : AGENT_EXECUTION_LIMITS.singleChatMaxIterations;   // 40
```

- 子 Agent 系统提示词会被附加一行 `Execution mode: group_subagent. ReAct-like iteration budget: maxIterations=15.`，让模型自约束工具循环轮数。
- `groupSubagentMaxIterations` 同时被持久化到 `dispatch_steps.max_iterations` 列（schema 默认值），便于 UI 展示与硬中止。

### 3.5.3 串行迭代（轮次间）

见 3.3.4。所有子 Agent 跑完后才进入 `reviewAcceptanceCriteria` → 决定是否进下一轮 round；下一轮 round 内部仍然按 DAG 分批并行。

### 3.5.4 并行执行

`Promise.all(batchSteps.map(step => executeSubAgentStep(step, ...)))`：

- 同一 batch 内的 step 同时启动；
- 每个 step 拥有自己的 `streamSink` 回调：`executeSubAgentStep` 在内部将 LLM 的 stream 事件重新包装为 `dispatch_step_update` / `GroupRunEvent`，再投到顶层 `stream`；
- "首次 streaming 事件"会触发一次 `agent_progress`（`phase: "stream"`, `status: "streaming"`），后续事件仅做 step status 同步，避免刷屏。

### 3.5.5 触发"准备任务上下文" / "运行中" 事件

每个 step 在关键阶段写 `group_run_event`：

| 阶段 | phase | 用途 |
|---|---|---|
| `context` | "正在准备任务上下文" | memory + subTask 拼装完成 |
| `runtime` | "正在运行子 Agent" | provider 调用发起 |
| `stream` | "正在生成结果" | 首次拿到 LLM token |
| `parse` | "正在解析 SubAgentResult" / 解析失败 | 解析 JSON 时 |
| `model` | "模型输出被截断" / "正在继续补齐输出" | 截断 / 续写 |
| `parse` | "已保存长输出产物，正在修复结果清单" | 长输出转 artifact + manifest repair |
| `validation` | "DiffProposal 校验失败" / "缺少 DiffProposal" | 写 Diff 失败 |
| `complete` | "已完成" / "执行失败" | 终态 |

### 3.5.6 单步 SubAgent 续写 / Manifest Repair

`MAX_SUB_AGENT_OUTPUT_CONTINUATIONS = 3`，触发条件按优先级：

1. `outputTruncated`（匹配 `OUTPUT_TRUNCATION_PATTERN = /truncated|timed out|max_completion_tokens|max_tokens|length|stream idle/i`）→ 续写；
2. `timeoutTriggered` → 续写；
3. `isLikelyIncompleteStructuredOutput(rawText, parseError)`：原始内容以 `{` 开头且 parseError 含 `unexpected end | unterminated | not found | end of json | bad control character` → 续写。

续写 prompt 模板（`buildSubAgentContinuationPrompt`）会带上一轮的尾部 6000 字作为"已输出末尾"，要求从断点继续；若仍然 parse 失败，则走 manifest repair：

- 把整段输出存为 Markdown artifact（`createSubAgentMarkdownArtifact`，title 后缀 "Deliverable"）；
- 用 `buildSubAgentManifestRepairPrompt` 要求子 Agent 下一轮**只**返回一个短小的 `SubAgentResult` JSON，并参考 artifact 的 preview 来声明 completedCriteria。

### 3.5.7 长交付物转 Artifact

`maybeMoveLongDeliverableToArtifact`：当 `result.deliverable` 长度 > `LONG_DELIVERABLE_ARTIFACT_THRESHOLD = 1500`：

- 落库一个 markdown artifact；
- `result.deliverable` 退化为 `result.summary`，避免消息流过长；
- 通过 `attachArtifactsToSubAgentResult` 把 `artifactId` 注入到 `outputs[]`。

### 3.5.8 DiffProposal 强校验

子 Agent 跑完且声明产生 Diff 时，强制校验 `getDiffProposal(diffProposalId, db)` 的 `agentId / conversationId / dispatchRunId / dispatchStepId` 必须匹配当前 step；任何一个不匹配 → 把 subAgentResult 标 `failed` 并把原因写入 `risks`。

如果子 Agent `status !== "no_changes_needed"` 且 `filesChanged.length > 0` 但没返回 `diffProposalId` → 同样强制 `failed`，reason = "子 Agent 声明修改了文件，但没有返回合法 DiffProposal。"

### 3.5.9 终态映射

`toStepStatus(status: SubAgentResult["status"])`：

| subAgentResult.status | dispatch_steps.status |
|---|---|
| `completed` / `no_changes_needed` | `completed` |
| 其它 | 原样（`partial` / `failed` / `iteration_limit_reached` / `cancelled`） |

`toFinalGroupRunStatus(review, results)`：

| 条件 | dispatch_runs.status |
|---|---|
| `results` 全部 completed / no_changes_needed | `completed` |
| 有失败但 `review.decision === "complete"` | `partial_failed` |
| 部分成功 | `partial_failed` |
| 全部失败 | `failed` |

---

## 3.6 并发控制与冲突检测降级

覆盖：限流、重试、Fallback Agent、人工介入 Hook。

### 3.6.1 并发限流

**会话级 run 锁**（`conversationRunLock.ts`）——见 3.1.1：

- 同一 conversation 在前一次 run 结束前不允许开启新的 run；
- 锁未释放时再调一次 `acquireConversationRun` → 抛 `ConversationAlreadyRunningError`；
- DB 层用 `WHERE status = 'running'` 的部分 UNIQUE 索引兜底，进程崩溃后即便内存 Map 清空，DB 仍能拒绝并发写入。

**Provider 层**：

- `llmRouter.callLLMWithContinuation` 默认最多 `DEFAULT_MAX_CONTINUATION_ATTEMPTS = 3` 续写；
- `REQUEST_TIMEOUT_MS = 300_000`（5 分钟），`STREAM_IDLE_TIMEOUT_MS = 120_000`（2 分钟无 token 则中止）；
- 子 Agent 侧 `groupSubagentMaxIterations = 15` 限定 ReAct 循环；
- 整轮重分派 `groupMaxRedispatchRounds = 3`；
- 一次 round 内最多 `groupMaxAgentsPerRound = 3` 个 Agent（`createRepairAssignments` 中用此限制；`validateOrchestratorDispatchPlan` 同样用此上限）。

### 3.6.2 任务级重试

- `retryDispatchStep(stepId, db, stream)`：仅允许 `status === "failed"` 的 step 重试，调用 `executeSubAgentStep` 覆盖原 step 状态；用于 UI 上一键重跑失败子任务。
- 子 Agent 内的 `parseSubAgentResult` parseError → 在 `executeSubAgentStep` 末尾记录 `parseError` 字段，但**不**直接 retry，而是依赖 manifest repair 路径由 Agent 下一轮自行补全。
- 截断 → `continuationAttempts` 字段计数；如最终修复成功则 `recoveredFromTruncation: true`，失败则 `status: "partial"`。

### 3.6.3 冲突检测 / 降级

`buildExecutionBatches` 的 `hasFileWriteConflict` 规则：

- 仅当两个 subTask 都是 `expectedOutputType === "diff_proposal"` 才检查；
- `targetFiles` 归一化（小写、剥下划线/冒号/连字符变空格、合并空白）后做交集；
- 冲突时把后到的 assignment 留到下一 batch；
- 若 batch 内全部冲突（极端情况）→ 仍保底取 `ready[0]` 单跑，避免死锁。

补充规则：subTask 没说 `targetFiles` 时不视为冲突，由下游写 Diff 时再去处理；此时 `validateOrchestratorDispatchPlan` 不会失败，但 `hasFileWriteConflict` 不会拦截。

### 3.6.4 Fallback Agent

`selectBestScore`（3.4.8）：

- 分数 >= 0.55 → 直接采用；
- 分数 < 0.55：
  - **自动模式** → 找 `isGeneralFallbackAgent` 命中的"通用 Agent"；找不到则采用最高分 Agent；reason 标记 fallback 路径；
  - **显式 @ 模式** → 不切换，reason 标记 "系统不会 fallback 到其他 Agent"。
- 候选池为空（filter 后 0 个） → 抛 `DispatchError`（在显式 @ 模式下保留每条 rejected 的原因）。

### 3.6.5 人工介入 Hook

- **@ 候选解析失败** → `runBlockedMentionDispatch` 发一条带原因的消息并把 dispatch run 标 `failed`，不再继续，避免静默走自动模式。
- **`reviewAcceptanceCriteria` 返回 `need_user_input`** → 调度循环 break，把 `unresolvedCriteria` / `evidence` 留给用户 / UI 决定下一步。
- **达到 `groupMaxRedispatchRounds`** → 强制把 review 决策降级为 `partial` / `failed`，reason 明确写出 "已达到最大重分派轮数 3"。
- **`runGroupOrchestratorSynthesis` 失败** → catch 住后改用 `createFallbackUserFacingSummary(review, results)` 拼出文本汇总，保证用户至少能拿到回复。
- **`runMainAgentAutoDispatch` 兜底** → 当 `workspace` / `mainAgent` 不存在时退到 `runMainAgentDirectReply`；当 orchestrator 的 LLM 调用失败时（catch in `runOrchestratorAutoDispatch`）发一条 `Orchestrator 调度失败: <msg>` 并把 dispatch run 标 `failed`，但**不**让进程崩溃。
- **校验失败** → `validateOrchestratorDispatchPlan` 失败时写一条 `分派计划校验失败: <error>` 消息，仍把 dispatch run 收尾为 `completed`（不重试，由用户改问法后重发）。

### 3.6.6 Diff 冲突的人工裁决

`runMainAgentDiffReview(conversationId, dispatchRunId, db)`（`dispatchService.ts`）：

- 拉取本次 dispatch run 的所有 `DiffProposal`；
- 拼一个审核 prompt（中文）让主 Agent 输 `accepted_diff_ids` / `rejected_diff_ids` / `conflicts[file, reason]` / `review_summary`；
- 根据返回值：
  - accepted → `updateDiffProposal(id, { status: "pending" })`，**不**自动 apply；
  - rejected → `{ status: "rejected" }`；
  - conflict（按 file 路径匹配所有该文件的 proposal） → `{ status: "conflicted" }`；
- 最终 apply 权始终在用户手里（`apply_diff` 必须由用户在前端确认）。

---

## 3.7 子 Agent 状态机

子 Agent 本身的状态机（`agentRunService.ts` / `agentRunWithConversationService.ts`）：

```
                ┌─────────────┐
                │  queued     │
                └──────┬──────┘
                       │ dispatch step 创建
                       ▼
                ┌─────────────┐
                │  running    │ ←──┐
                └──────┬──────┘    │ ReAct 迭代
   ┌─────────┬────────┼────────┐  │
   ▼         ▼        ▼        ▼  │
finished  waiting  failed  cancelled │
            for                │  │
         permission            └──┘  (loop within maxIterations)
```

来源：`shared/groupChat.ts` 中 `SubAgentRunStatus`：

```
queued → running → { completed | partial | failed | iteration_limit_reached | waiting_for_permission | cancelled }
```

`AgentRunResult.status`（`shared/agentExecution.ts`）多 2 个：`verification_failed`、`completed`/`cancelled` 是终态。

### 3.7.1 状态写入

- `dispatch_steps.status` 由 `executeSubAgentStep` 在以下时机刷新：
  - 启动 → `running`；
  - streaming 中 → `streaming`（不持久化、仅 stream event）；
  - 终态 → `completed` / `partial` / `failed` / `iteration_limit_reached` / `cancelled`。
- 失败时 `errorMessage` 字段写入原因，`outputMessageId` 指向 subAgent 产物 message（`messageType: "agent_assignment"`，metadata 含 `dispatchRunId / stepId / status / diffProposalId / artifactIds / outputs / evidence`）。
- `agent_runs` 表同步记日志（`agentRunRepo`），便于跨 dispatch step 跟踪同一 sub-agent 私聊的执行历史。

### 3.7.2 与 dispatch run 状态机的关系

`DispatchRunStatus` (`GroupRunStatus` 联合)：

```
running → plan_created → running_subagents → reviewing
                                                  ├─ redispatching → (回到 running_subagents)
                                                  └─ { completed | partial | partial_failed | failed | waiting_for_user }
```

`dispatch_runs.status` 状态机在 `executeStructuredGroupDispatch` 内显式推进；任意时刻 UI 可通过 IPC 拿到最新状态（`streamingRunService` + `dispatchService` 的 stream 事件）。

### 3.7.3 cancelled

- `cancel` 路径：UI 通过 IPC 取消 → `streamingRunService` 调 `agentRunService` 取消正在跑的 provider 调用 → 子 Agent step status 写 `cancelled`；
- conversation run lock 释放走 `release("cancelled")` 通道。

### 3.7.4 waiting_for_permission

- 子 Agent 工具权限（`toolPermissionService`）需要用户确认时 → 子 Agent 状态写 `waiting_for_permission`；
- 此时 ReAct 循环暂停，等用户在前端点击"允许/拒绝"再恢复。

---

## 3.8 执行结果收集与汇总（多产出合并策略、冲突检测）

### 3.8.1 SubAgentResult 数据结构

`SubAgentResult`（`shared/groupChat.ts`）—— 每个子 Agent 必须返回：

| 字段 | 含义 |
|---|---|
| `agentId` | 跑这个 subTask 的 Agent |
| `status` | `completed` / `partial` / `failed` / `no_changes_needed` / `iteration_limit_reached` |
| `summary` | 短摘要，<= 200 字 |
| `deliverable?` | 可选的短预览（长正文转 artifact） |
| `outputs[]` | `{ type, artifactId?, diffProposalId?, filePath?, preview?, isComplete? }` |
| `evidence[]` | 每条 evidence 关联到具体 criterionId |
| `artifactIds?` | 引用 markdown / 文件型产物 |
| `completedCriteria` / `unresolvedCriteria` | 从 targetCriteria 过滤出 |
| `filesRead` / `filesChanged?` | 子 Agent 真实读 / 写的相对路径 |
| `diffProposalId?` | 写代码时必填，否则 → 强制 `failed` |
| `verification?` | 跑过的验证命令与结果 |
| `assumptions` / `risks` | 透传到 review |
| `nextSuggestedTask?` | 失败时建议的修复任务描述 |
| `parseError?` / `metadata?` / `runResult?` | 解析 / 元数据 / provider 原始结果 |

`parseSubAgentResult` 的关键容错：

- 必须能从 raw text 里抽出一个 JSON object（先 strip ```json fence，再 fallback 取首尾 `{}`）；
- 解析失败时不抛异常，而是构造一个 `parseError` 不为空的 `failed` / `partial` `SubAgentResult`，保证下游能继续流转；
- 若 `parsedStatus === "completed"` 但 `outputTruncated` / `timeoutTriggered` / `runResult.status === "failed|verification_failed"` → 降级为 `partial`；
- 解析空字符串时构造一个"子 Agent 没有返回任何内容"的 `failed` 结果。

### 3.8.2 收集策略

`executeSubAgentStep` 完成时：

1. `updateStepSubAgentResult(step.id, subAgentResult, db)`；
2. 若 `subAgentResult.parseError` 为空，把 `deliverable` 转 artifact（>1500 字时）；
3. 校验 `diffProposalId`（3.5.8）；
4. 写一条 `agent_assignment` 消息到群聊（`messageType: "agent_assignment"`），metadata 包含 status / summary / diffProposalId / artifactIds / outputs / evidence / detailAvailable；
5. 写 `agent_completed` / `agent_failed` 事件到 `group_run_events`；
6. 同步把 subAgentResult 推入 results 数组（`executeStructuredGroupDispatch` 内 `results.push`）。

`formatSubAgentResultForContext` 把 SubAgentResult 提炼为 `PreviousTaskSummary`（summary + keyConstraints + diffSummary + failedItems + nextRequiredActions）用于下一轮同 dispatch run 内的子 Agent `previousAgentOutputs`。

### 3.8.3 审核 / 合并

`reviewAcceptanceCriteria`：

- 对每个 result 的 `completedCriteria`，检查 `criterion.id` 是否在 `criteria` 中（防止子 Agent 假报未声明的 criterion）；
- 把 satisfied 的 criterion 状态写为 `satisfied`，并把 evidence 合并（按 criterionId 串成多行文本）；
- 失败的 criterion 若被 `failed` 结果命中 → 标 `failed`，否则 → `unknown`；
- 计算 `unresolvedCriteria` = `required` && `status !== "satisfied"` 的 criterion id 列表；
- 决策树：
  - 无 unresolved → `complete`；
  - `roundIndex >= groupMaxRedispatchRounds` → `partial`（有任意成功） / `failed`（无成功）；
  - 其它 → 调 `createRepairAssignments`：
    - 每个有未完成项的 Agent 取**最近一次**的 `nextSuggestedTask`（若空则用上一轮 instruction），生成一条新 assignment 限定 `targetCriteria` = unresolved 子集；
    - 去重（同一 Agent 一条）；
    - 限制 `repairs.length < groupMaxAgentsPerRound`。
- 决策 = `nextAssignments.length > 0 ? "redispatch" : "need_user_input"`。

### 3.8.4 冲突检测

DAG 内写 Diff 冲突由 3.6.3 处理（`hasFileWriteConflict`）。结果合并阶段还会再过一遍：

- 每个 result 的 `unresolvedCriteria` 与其他 result 的 `completedCriteria` 取并集；
- 同名 criterionId 在多个 result 中同时声明时，**先到先得**（遍历 results 顺序，第一个有 evidence 的赢）；
- DiffProposal 状态由 `runMainAgentDiffReview` 处理（3.6.6），同文件被多个 Agent 改 → 标 `conflicted`，等用户在 UI 上手动裁决。

### 3.8.5 多产物合并策略 / 最终汇总

`createFinalSummary`：

1. 优先调 `runGroupOrchestratorSynthesis({ workspaceId, conversationId, userMessage, criteria, review, results })`，由主 Agent LLM 重新读所有子结果生成"用户视角"的最终答复；
2. prompt 强约束：只输出对用户直接可见的最终答案，不输出 JSON / 内部审核记录 / criterion id / dispatch 状态 / 迭代预算 / Agent 日志；同时显式要求 "Do NOT include any chain-of-thought ... Stream the answer in the user's language without preamble"；
3. 失败时 fallback `createFallbackUserFacingSummary(review, results)`：
   - 把所有 `completed` / `no_changes_needed` 的 result 拼接为 `summary` 或 `deliverable`（`deliverable.length <= 1500` 才内联展示），之间用 `\n\n---\n\n` 分隔；
   - `review.decision` 给出"当前信息不足 / 已部分完成 / 未能完成"的说明。
4. 汇总消息 `messageType: "orchestrator_summary"`，metadata 含 `dispatchRunId / roundIndex / status`，作为群聊最终呈现给用户。

### 3.8.6 Agent 经验沉淀

`updateExperiencesAfterGroupDispatch`（`agentProjectExperienceService.ts`）—— 在汇总后异步执行（`try { … } catch { /* 失败不阻塞回复 */ }`）：

- 对每个 result 调 `summarizeWithConfiguredLLM`，让主 Agent 的 LLM 从 `(userTask, assignment, result, review)` 中提炼 `summaryDelta` / `responsibilities` / `keyDecisions` / `filesTouched` / `diffSummaries` / `unresolvedIssues`；
- 解析失败时降级为 `deterministicDelta`：直接用 `assignment.instruction` / `result.summary` / `result.assumptions` / `result.filesChanged` / `result.unresolvedCriteria` 等已有字段；
- `mergeExperience` 把 delta 合并进 `agent_project_experiences` 表（同 group + 同 agent 维度），数组字段用 `uniqueRecent` 去重并截到最近 30 条，summary 截到最近 6000 字符；
- 后续 `getContextRelevance` 读取这份经验，作为"该 Agent 在本群聊积累的能力画像"。

### 3.8.7 Group Run 事件流

`group_run_events` 表是 UI 实时观察的"事件总线"，按时间顺序追加：

```
plan_created        →  UI 渲染"分派计划"卡片
agent_started       →  UI 在对应 step 上显示"运行中"
agent_progress      →  多 phase 的细粒度进度
agent_completed     →  step 卡片变绿，summary 显示
agent_failed        →  step 卡片变红，errorMessage 显示
summary_started     →  UI 显示"正在汇总"
summary_completed   →  UI 渲染最终消息
```

`groupRunEvent` 的 seq 字段单调递增（数据库自动保证），UI 端通过 `dispatchService` 的 stream 回调按 seq 顺序消费即可。

---

## 附：关键代码路径速查

| 关注点 | 文件 | 关键函数 |
|---|---|---|
| 会话锁 | `src/main/services/conversationRunLock.ts` | `acquireConversationRun`, `markRunFailed` |
| 上下文压缩 | `src/main/services/mainAgentContextService.ts` | `prepareMainAgentContext`, `compactEarlierHistory` |
| System Prompt | `src/main/services/orchestratorSystemPrompt.ts` | `buildGroupOrchestratorSystemPrompt` |
| 决策解析 | `src/main/services/mainAgentDecision.ts` | `parseMainAgentDecision`, `validateDispatchPlan` |
| @ 解析 | `src/main/services/dispatch/mentionParser.ts` | `parseMentionNames` |
| 评分 | `src/main/services/dispatch/agentScoring.ts` | `filterDispatchCandidates`, `fallbackCapabilityMatch`, `calculateToolMatch`, `calculateDispatchScore`, `buildExecutionBatches` |
| 群聊入口 | `src/main/services/dispatchService.ts` | `handleGroupUserMessage`, `runMainAgentAutoDispatch`, `runOrchestratorAutoDispatch` |
| 编排主循环 | `src/main/services/dispatchService.ts` | `executeStructuredGroupDispatch` |
| 单步执行 | `src/main/services/dispatchService.ts` | `executeSubAgentStep` |
| 审核合并 | `src/main/services/groupExecutionService.ts` | `reviewAcceptanceCriteria`, `createRepairAssignments`, `createFallbackUserFacingSummary`, `parseSubAgentResult` |
| 能力 LLM | `src/main/services/orchestratorRuntimeService.ts` | `runGroupCapabilityMatchJudge` |
| 决策 LLM | `src/main/services/orchestratorRuntimeService.ts` | `runGroupOrchestratorDecision`, `runGroupOrchestratorSynthesis` |
| 重试 | `src/main/services/dispatchService.ts` | `retryDispatchStep` |
| Diff 冲突 | `src/main/services/dispatchService.ts` | `runMainAgentDiffReview` |
| Agent 经验 | `src/main/services/agentProjectExperienceService.ts` | `updateExperiencesAfterGroupDispatch` |
| 执行限流常量 | `src/shared/agentExecution.ts` | `AGENT_EXECUTION_LIMITS` |
| 状态类型 | `src/shared/groupChat.ts` | `DispatchRunStatus`, `DispatchStepStatus`, `SubAgentResult`, `AgentAssignment`, `SubTask` |
