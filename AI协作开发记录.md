# AI 协作开发记录 — AgentHub 项目

## 项目概述

**项目名称：** AgentHub — 多智能体协作平台
**技术栈：** Electron + React + TypeScript + Vite
**开发周期：** 2026-05-27 ~ 2026-06-10
**协作模式：** 人机结对编程（人类主导架构决策与需求定义，AI 辅助代码实现与方案验证）

---

## 一、协作分工模式

### 人类负责
- 产品需求定义与优先级排序
- 架构方向决策（如选择 DAG 调度模式）
- 比赛要求解读与展示策略设计
- 最终验收与质量把关

### AI 负责
- 代码库结构探索与理解
- 模块设计与代码实现
- 调度算法、评分公式等核心逻辑编写
- 前端组件（DAG 可视化、Artifact 预览）实现
- 测试用例编写与调试
- 文档与配置生成

---

## 二、开发阶段与协作记录

### 阶段 1：项目初始化与架构搭建（05-27）

**协作内容：**
- AI 探索项目目录结构，理解 Electron + React + Vite 的工程架构
- 人类确定核心功能模块：Agent 管理、会话管理、Artifact 系统
- AI 搭建基础服务层：`agentService`、`conversationService`、`artifactService`
- 去掉 demo 新手引导，转向真实功能开发

**关键产出：**
- `src/main/services/` 下的基础服务模块
- `src/shared/domain.ts` 核心类型定义（Agent、Conversation、Message、Workspace）
- `src/shared/runtime.ts` 运行时 Provider 定义

**协作特点：** 人类快速决策，AI 高速搭建脚手架，半天完成基础框架。

---

### 阶段 2：单聊模式开发（05-28）

**协作内容：**
- AI 实现 `agentRunService` — Agent 运行生命周期管理
- AI 实现 `streamingRunService` — 流式输出处理
- AI 构建 `orchestratorRuntimeService` — 编排器运行时
- AI 实现 `orchestratorSystemPrompt` — 系统提示词工程
- 人类验收单聊交互体验

**关键产出：**
- 单聊模式完整可用
- SSE 流式输出管线
- Agent 适配器模式（`agentAdapter.ts`）支持多种运行时

**协作特点：** AI 独立完成核心服务，人类聚焦体验验收。

---

### 阶段 3：群聊模式开发（05-29 ~ 05-30）

**协作内容：**
- 人类提出群聊需求：多 Agent 协作、任务分派、依赖管理
- AI 设计并实现 `groupChatService` — 群聊会话管理
- AI 实现 `dispatchService` — 核心调度引擎
  - 编排器决策解析（`mainAgentDecision.ts`）
  - 任务分派模式：`mention` / `auto_dispatch` / `main_direct`
  - 子 Agent 执行循环与输出截断处理
- AI 实现 `groupExecutionService` — 执行结果解析与验收标准审查
- AI 实现 `agentScoring` — Agent 评分与匹配算法
  - 能力匹配评分公式：`capabilityMatch * 0.4 + toolMatch * 0.2 + contextRelevance * 0.2 + historicalReliability * 0.2`
  - DAG 批次构建算法
- AI 实现 `GroupRunTimeline.tsx` — DAG 可视化组件
  - `buildDagLayout` 布局算法
  - `DagEdgeLayer` SVG 边渲染
  - `DagNodeCard` 任务节点卡片
- Bug 修复：调度并发控制、状态同步、重试去重

**关键产出：**
- 群聊模式完整可用
- DAG 调度引擎（串行 + 并行混合执行）
- 实时 DAG 可视化面板
- 验收标准自动审查与重新分派机制

**协作特点：** 需求复杂度高，人类反复澄清调度语义，AI 逐步实现并迭代修复。

---

### 阶段 4：真实 Agent 接入（05-31）

**协作内容：**
- 人类确定接入真实 LLM 的方案
- AI 实现 `llmRouter` — 多模型路由
- AI 实现 `modelProviderService` — 模型供应商管理
- AI 实现 `llmProviderAdapters` — OpenAI/Anthropic 适配
- AI 实现 `builtin_openai` / `builtin_anthropic` Provider
- 人类验证真实模型调用效果

**关键产出：**
- 从 Mock 模式切换到真实 LLM 调用
- 多模型供应商支持
- Provider 配置与密钥管理

**协作特点：** 关键转折点，从 demo 走向真实可用产品。

---

### 阶段 5：产物系统与预览（06-01 ~ 06-10）

**协作内容：**
- AI 实现 `artifactService` — 多格式产物管理（code / html / markdown / diff / document / presentation / pdf）
- AI 实现 `ArtifactViewer.tsx` — 多格式预览组件
- AI 实现 `HtmlPreview.tsx` — 沙箱 iframe 预览
- AI 实现 `ZoomablePreview.tsx` — 缩放预览
- AI 实现 PPT/PDF 生成管线（HTML → LibreOffice 转换）
- AI 实现子 Agent 长输出处理与 Manifest Repair 机制
- 人类设计群聊展示场景与提示词策略

**关键产出：**
- 多格式产物预览系统
- PPT/HTML 最终产物生成
- 群聊演示场景设计

---

## 三、核心技术决策记录

| 决策点 | 选项 | 最终选择 | 理由 |
|--------|------|----------|------|
| Agent 运行时 | CLI 工具 vs 内置 LLM | 两者并存 | CLI 适合开发调试，内置适合产品化 |
| 调度模式 | 顺序执行 vs DAG | DAG | 支持串并行混合，更高效 |
| 前端框架 | Vue vs React | React | 生态更丰富，组件化更强 |
| 桌面框架 | Electron vs Tauri | Electron | 成熟稳定，Node.js 生态兼容 |
| 产物格式 | 纯 Markdown vs 多格式 | 多格式 | 支持 PPT/PDF 满足比赛展示需求 |

---

## 四、协作效率总结

| 指标 | 数据 |
|------|------|
| 总开发周期 | ~15 天 |
| 核心服务模块数 | 30+ |
| 前端功能模块数 | 10+ |
| 共享类型定义文件 | 15+ |
| 测试文件数 | 20+ |
| 提交次数 | 6 |

**AI 协作价值：**
- 代码生成效率提升约 3-5 倍
- 架构探索与方案验证速度显著加快
- 复杂算法（DAG 布局、Agent 评分）实现周期大幅缩短
- 测试覆盖与文档生成自动化程度高

---

## 五、协作中积累的经验

1. **需求描述要具体**：模糊的"做个群聊"不如"3个子Agent，串并行混合，输出PPT+HTML"
2. **先探索后实现**：让 AI 先读懂代码库再动手，避免重复造轮子
3. **迭代验收**：每个阶段完成后立即验收，避免问题累积
4. **类型驱动开发**：先定义 `shared/` 下的类型契约，再实现服务
5. **渐进式复杂度**：单聊 → 群聊 → DAG → 真实 Agent，逐步增加复杂度
