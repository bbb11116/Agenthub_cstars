---
name: multi-agent-app-dev
description: 多智能体协作应用开发技能。适用于需要构建多Agent调度、DAG任务编排、产物生成与预览等复杂系统的场景。基于AgentHub项目的实战协作经验提炼。
origin: custom
---

# Multi-Agent App Development

基于人机协作开发 AgentHub（多智能体协作平台）的实战经验，提炼出的多Agent应用开发方法论与技术模式。

## When to Use

- 需要构建多 Agent 调度与编排系统
- 需要实现 DAG（有向无环图）任务依赖管理
- 需要支持串行 + 并行混合执行模式
- 需要多格式产物生成（HTML / PPT / PDF / Markdown）
- 需要实时可视化任务执行状态
- 需要对接多种 LLM Provider

## When Not to Use

| 场景 | 推荐替代 |
|------|----------|
| 单一对话式 AI 应用 | 直接调用 LLM API |
| 简单的批处理任务 | 脚本 + 任务队列 |
| 纯前端展示项目 | 通用前端技能 |

## 核心架构模式

### 1. 分层架构

```
┌─────────────────────────────────────────┐
│              前端展示层                    │
│  (React + DAG可视化 + Artifact预览)       │
├─────────────────────────────────────────┤
│              服务编排层                    │
│  (调度引擎 + 编排器 + Agent评分)          │
├─────────────────────────────────────────┤
│              Agent运行时层                │
│  (适配器模式 + 多Provider支持)            │
├─────────────────────────────────────────┤
│              共享契约层                    │
│  (类型定义 + IPC通道 + 事件系统)          │
└─────────────────────────────────────────┘
```

### 2. Agent 适配器模式

定义统一接口，屏蔽不同运行时差异：

```typescript
interface AgentAdapter {
  run(input: AgentRunInput): AsyncIterable<AgentEvent>;
}
```

每个 Provider（Claude Code、Codex、OpenAI、Anthropic）实现自己的适配器。

### 3. DAG 调度引擎

任务调度的核心是将依赖关系解析为可执行批次：

```
Task A (无依赖) ──┐
                   ├──→ 并行执行批次 1
Task B (无依赖) ──┘
        │
        ▼
Task C (依赖 A,B) ──→ 执行批次 2
        │
        ▼
Task D (依赖 C)   ──→ 执行批次 3
```

关键算法：
- **依赖深度计算**：最长依赖链决定列位置
- **批次构建**：无未满足依赖的任务组成并行批次
- **文件冲突串行化**：共享目标文件的 diff_proposal 任务自动串行

### 4. Agent 评分匹配

多维度加权评分选择最佳 Agent：

```
finalScore = capabilityMatch × 0.4
           + toolMatch × 0.2
           + contextRelevance × 0.2
           + historicalReliability × 0.2
```

### 5. 验收标准驱动

每个子任务定义明确的验收标准（acceptance criteria），执行完成后自动审查：
- 全部满足 → 任务完成
- 部分未满足 → 生成修复分配（repair assignment），进入下一轮
- 最多重试 3 轮

## 开发工作流

### Step 1: 类型契约先行

在 `shared/` 下先定义所有核心类型：

```typescript
// Agent 类型
type AgentRole = "main" | "sub";
type AgentType = "orchestrator" | "specialist";

// 调度类型
type DispatchMode = "mention" | "auto_dispatch" | "main_direct";
type ExecutionMode = "sequential" | "dag";

// 产物类型
type ArtifactType = "code" | "html" | "markdown" | "diff"
  | "document" | "presentation" | "pdf";
```

**原则：** 类型是前后端的契约，先定类型再写实现。

### Step 2: 服务层实现

按依赖顺序实现：
1. 基础服务（Agent CRUD、会话管理）
2. 运行时服务（Agent 执行、流式输出）
3. 调度服务（编排器决策、任务分派）
4. 执行服务（子 Agent 执行、结果解析）
5. 产物服务（创建、渲染、预览）

### Step 3: 前端集成

- DAG 可视化：SVG 边 + CSS 节点卡片
- 实时更新：事件驱动（`plan_created` → `agent_started` → `agent_completed`）
- 多格式预览：iframe 沙箱（HTML）、缩放容器（PPT/PDF）

### Step 4: 迭代验收

每个阶段完成后立即验收：
- 单聊 → 群聊 → DAG → 真实 Agent → 产物预览
- 渐进式增加复杂度

## 关键实现要点

### 调度模式选择

用户消息进入群聊后，编排器决定如何处理：

| 模式 | 触发条件 | 行为 |
|------|----------|------|
| `mention` | 用户 @了特定 Agent | 只调度被 @ 的 Agent |
| `auto_dispatch` | 无 @ 提及 | 编排器自主决定分派 |
| `main_direct` | 任务简单 | 主 Agent 直接回答 |

### 子 Agent 执行循环

```
构建任务输入 JSON
    ↓
注入系统提示词 + 上下文
    ↓
调用 Agent 运行时
    ↓
解析输出（JSON / Markdown / 长文本）
    ↓
长输出 → 创建 Artifact + Manifest Repair
    ↓
验收标准审查 → 通过/重新分派
```

### DAG 可视化布局

- 节点尺寸：220 × 108 px
- 列间距：72 px
- 行间距：22 px
- 边：贝塞尔曲线 + 箭头标记
- 状态样式：done（绿）、active（蓝+脉冲）、waiting（灰）、failed（红）

## 常见陷阱

1. **不要跳过类型定义**：没有类型契约，前后端会各自为政
2. **不要忽略输出截断**：LLM 输出可能超长，必须有截断和续传机制
3. **不要假设 Agent 会返回 JSON**：做好 Markdown/纯文本的降级解析
4. **不要并发写同一文件**：DAG 批次构建时必须检查文件冲突
5. **不要跳过验收标准**：没有验收标准的调度等于盲跑

## 提示词设计模板

群聊演示场景的推荐提示词结构：

```
帮我制作一个[主题]：
1. 先[无依赖任务A]
2. 基于A的结果，[串行任务B]
3. 同时[并行任务C]
最后输出[产物类型1]和[产物类型2]
```

关键要素：
- 明确的依赖关系（"先"、"基于"、"同时"）
- 多种产物类型（触发不同渲染管线）
- 3 个子任务（匹配默认的 `groupMaxAgentsPerRound: 3`）

## Related Skills

- `council` — 多视角决策，适用于架构方向选择
- `literature-review` — 技术调研，适用于 Agent 能力评估
