# AgentHub 协作规范

> 面向在 AgentHub 仓库协作的 AI agent（与新加入工程师）。把项目规格（Spec）、可用能力（Skill）、硬约束（Rules）汇总在一处。
>
> 与既有文档的关系：
> - `AGENTS.md` / `CLAUDE.md` —— 通用 AI 编码行为准则（思考-简洁-外科手术-目标驱动）。本文件不重复，照搬即可。
> - `ARCHITECTURE.md` —— 当前代码可验证事实，权威架构来源。本文件只做速查，详细以它为准。
> - `PROJECT-SUMMARY.md` —— 项目长篇叙事，留作背景。
> - `docs/` —— 设计期文档（状态机、调度、demo 脚本等），按需翻阅。
> - `AgentHub- 多Agent协作平台设计.pdf` —— 顶层产品设计稿。

---

## 0. 命名冲突（先看这条）

仓库里"skills"和"agents"两个词在两个层面同时出现，容易混：

| 名字 | 真实含义 |
| --- | --- |
| `AGENTS.md`（根） | AI 编码行为准则的副本 |
| `skills/<职业>/<agent名>/` | **AgentHub 产品自身挂载的领域 Agent 角色 prompt**（deep-research / feishu-doc / nutrient-document-processing / legal-advisor …） |
| Claude Code `Skill` 工具 | 当前 AI 环境中由系统注入的可执行 skill（`run` / `verify` / `code-review` / `simplify` / `claude-api` 等） |
| `src/main/services/*` 中的 service | 后端服务（如 `webToolService.ts`），与上面都不是一回事 |

协作时不要把 `skills/` 目录当成 Claude Code skill 配置；它属于 AgentHub 产品的运行时。

---

## 1. Spec —— 项目规格

### 1.1 身份卡

- **产品**：AgentHub，多 Agent 协作平台（桌面端）
- **包名**：`agenthub-desktop`，版本 0.1.0，私有
- **技术栈**：Electron 31 + TypeScript 5.5（ESM）+ React 18 + Vite 5 + better-sqlite3 12
- **窗口**：1440×900，`contextIsolation: true`、`nodeIntegration: false`、`sandbox: false`
- **平台分支**：仅 `window-all-closed` 区分 darwin（`electron/main.ts:518-522`），其余无平台差异
- **持久化**：better-sqlite3，开 WAL + 外键，迁移在启动期 `initializeDatabase()` 内做

### 1.2 目录地图

```
electron/
  main.ts          主进程入口、IPC 注册、窗口管理
  preload.ts       contextBridge 暴露 window.agenthub（命名空间对象）
src/
  main/            主进程业务：services / db / config / demo
  renderer/        React 渲染层（state 拆 workspaceStore / conversationStore / agentStore）
  shared/          主↔渲染共享契约（types / ipcChannels / agentRunPolicy / agentRunEvent / domain / groupChat / agentExecution / artifact / file / git / diff / modelProvider / agentAdapter / runtime）
scripts/           原生模块重编译
tests/             e2e（vitest）
docs/              设计期文档
skills/<职业>/     产品自带的领域 Agent 角色 prompt（见 §0）
dist/ / dist-electron/   构建产物（不进 git）
```

### 1.3 关键域概念

- **单聊模式**（已上线）：`workspace → agent → conversation → message`
- **群聊模式**（已上线）：`group-conversation → group-member → dispatch-step`，含 streamId 流式 dispatch
- **真实 Agent**：已接入大模型（最近一次提交 `1cc2dee`）
- **大模型 provider 抽象**：`src/shared/modelProvider.ts`，IPC 通道 `model-provider:*`
- **Web 工具**：`webToolService`，支持 Tavily / Brave / SerpAPI / SearXNG
- **流式 IPC 模式**：`invoke(channel, {streamId, ...})` + 同名 `${channel}:${streamId}` 推送，preload 监听后回调 `streamHandlers.onTextDelta`（`electron/main.ts:243-251`、`electron/preload.ts:36-46`）

### 1.4 启动顺序（主进程 `electron/main.ts`）

1. `augmentProcessPath()`：把 `~/.npm-global/bin`、`~/.local/bin`、`/opt/homebrew/bin`、`/usr/local/bin` 注入 `PATH` 前缀，让终端外也能找到 `codex` / `claude` 等 CLI。
2. 顶层导入 IPC 常量与各 service。
3. `app.whenReady()` → `initializeDatabase()` → `ensureDefaultMainAgent(db)` → `createWindow()`。
4. 预加载 `dist-electron/preload.cjs`，类型契约 `AgentHubApi` 见 `src/shared/types.ts:404-421`。

---

## 2. Skill —— 可用能力与触发场景

### 2.1 Claude Code 内置 Skill（当前环境注入）

| Skill | 何时用 | 备注 |
| --- | --- | --- |
| `run` | 启动本项目（Electron + Vite），或在真实 App 中验证改动 | 优先用，比手写 `npm run dev` 稳妥 |
| `verify` | 用户要求"验证 PR / 确认修复 / 跑一遍看效果" | 与 `run` 不同的是强调"用真实 App 跑过一遍" |
| `code-review` | 用户要求 review 当前 diff；可 `--comment` 留 PR 评论或 `--fix` 直接修 | 高 effort 可能包含不确定结论 |
| `simplify` | `code-review --fix` 的等价物，把审查结论直接落到工作区 | 改完一定要再用 `verify`/`run` 兜底 |
| `init` | 仓库还没有 `CLAUDE.md` / 项目说明时初始化 | 本项目已有 `CLAUDE.md` 与 `AGENTS.md`，通常跳过 |
| `review` | 评审一个 PR | |
| `security-review` | 当前分支有未提交改动且涉及安全面时 | |
| `fewer-permission-prompts` | 频繁遇到权限弹窗，整理只读 Bash / MCP 的白名单 | 改 `.claude/settings.json`，需用户授权 |
| `update-config` | 改 `settings.json`、env、hooks、权限白名单 | "以后每次 X" 类自动化只能用 hook，不能用 memory 替代 |
| `keybindings-help` | 用户想改快捷键 | 改 `~/.claude/keybindings.json` |
| `claude-api` | 本项目接 Claude API / Anthropic SDK 的代码（`src/shared/modelProvider.ts` 周边）出现构建、调优、迁移问题 | 与 OpenAI provider 的代码无关；本项目目前主要在 `modelProvider` 抽象层 |
| `loop` | 用户要"每 N 分钟"轮询某事 | 不要用于一次性任务 |

### 2.2 项目内"领域 Agent"角色（`skills/<职业>/<name>/`）

这些是 AgentHub 产品在 UI 里供用户选用的领域 Agent 角色 prompt，当前挂载的分类：

- 办公室与行政支持类（deep-research / feishu-doc / nutrient-document-processing / things-mac …）
- 法律类（legal-advisor / advogado-* / lex / employment-contract-templates …）
- 管理类（agent-hierarchical-coordinator / brand-guidelines-anthropic / council / gstack-openclaw-ceo-review …）
- 计算机与数学类
- 教育与图书馆类
- 商业与金融运营类
- 生命、物理与社会科学类
- 艺术、设计、娱乐、体育与媒体类

> 协作者不要修改 `skills/` 下的 prompt，除非用户明确要求新增/调整领域 Agent；改完要在 `PROJECT-SUMMARY.md` 或 `ARCHITECTURE.md` 同步登记。

---

## 3. Rules —— 硬约束

### 3.1 代码行为（与 `AGENTS.md` 一致，不重复原文）

- 写之前先想清楚：列假设、列替代方案、必要时问。
- 简洁优先：200 行能写成 50 行就重写；不写假设性扩展。
- 外科手术式改动：只动与请求相关的行；不"顺手优化"；保留原作者风格。
- 目标驱动：每一步带可验证条件；测试在改之前先存在。
- 多步任务先写 1/2/3 计划，每步给"verify"标准。

### 3.2 严禁清单

- **禁止把任何 API key、token、凭证写入仓库内的任何文件**（含 `.env`、`src/**`、`scripts/**`），即便文件在 `.gitignore` 里。理由与例外路径见 `feedback-no-secrets-in-repo`。
  - 改用 `~/.zshenv`（macOS 默认推荐）或启动时 inline env。
  - 用户在对话里贴出 key 时，提醒他们该 key 已落在 transcript，建议会后轮换。
- **禁止假设 `~/.zshrc` 改完就能被 Electron 看到**。macOS 上 `~/.zshrc` 只对交互 shell 生效，Electron 子进程（尤其 Dock / VS Code Run / 打包后的 `.app`）走 `launchd` env。详见 `project-macos-env-propagation`：
  - 默认推荐 `~/.zshenv`（所有 zsh 都会加载）。
  - 临时方案：`AGENTHUB_X=... npm run dev`。
  - GUI 启动的打包应用：`launchctl setenv AGENTHUB_X "..."`（重启失效）。
  - 改完一定让用户重启终端 / AgentHub（env 是启动期读取，不是运行时）。
- **不要修改 `dist/`、`dist-electron/`、`node_modules/`、`agenthub.db`、`.DS_Store`**——这些是构建产物或本地状态，已在 `.gitignore`。
- **不要把 Claude Code `Skill` 工具的概念套到 `skills/<职业>/` 目录上**。两者无关。

### 3.3 构建 / 测试 / 运行

| 动作 | 命令 | 注意 |
| --- | --- | --- |
| 启动开发 | `npm run dev` | 已自动 `rebuild:electron` + `vite --host 127.0.0.1` |
| 启动桌面 App | `npm run start` | 等价 `rebuild:electron` + `electron .` |
| 类型检查 + 打包 | `npm run build` | `tsc --noEmit` + `vite build` |
| 单元测试 | `npm test` | 自动 `rebuild:node`，跑 `vitest run` |
| DB smoke | `npm run test:db` | 仅 `src/main/db/dbSmoke.test.ts` |
| E2E | `npm run test:e2e` | `tests/e2e/mvpFlow.test.ts` |
| 原生模块重编 | `npm run rebuild:node` / `npm run rebuild:electron` | better-sqlite3 跨进程时必须重编 |

类型与构建前先确认 tsconfig（单项目 `noEmit: true`）和 `vite.config.ts`（`better-sqlite3` 显式 `external`）是否动过——这两处是构建链路的单点。

### 3.4 改动 `skills/<职业>/` 下的领域 Agent 提示

- 只动用户明确要求改的那一份。
- 改完在 `PROJECT-SUMMARY.md` 或对应 `docs/*.md` 登记一句话。
- 不要把领域 Agent 的输出格式约束成与产品 IPC 通道（`src/shared/ipcChannels.ts`）耦合的协议——它们是用户面 prompt，不是后端协议。

### 3.5 提交 / Git

- 提交前确认 `git status` 没有 `dist*/`、`node_modules/`、`agenthub.db`、`.DS_Store`、`package-lock.json` 的非预期变动。
- 提交粒度按"单一意图"切：一个提交一件事，message 写"为什么"而不是"做了什么"。
- 不要 `--no-verify`、不要 force-push main，不要 amend 别人/自己的已发布 commit（用户明确要求除外）。

---

## 4. 速查 / 故障排查

| 现象 | 优先怀疑 |
| --- | --- |
| `process.env.AGENTHUB_TAVILY_API_KEY` 是 `undefined` | 没改 `~/.zshenv`，或没重启 AgentHub |
| `executeSearch` 抛 "Web search is not configured" | 同上，或 provider 没在 `modelProvider` 注册 |
| `better-sqlite3` 找不到或 ABI 不匹配 | 跑 `npm run rebuild:electron`（或 `rebuild:node`） |
| 启动后窗口空白、且 dev server 没起 | 端口被占 / Vite 进程未干净退出，kill 残留后重跑 |
| 流式响应只收到首条 | `streamId` 没透传到 `runAgent` / preload 没注册 `:${streamId}` 监听 |
| 群聊 dispatch 卡住 | 看 `dispatch:*` 通道的 step 状态机，参考 `docs/3-6-agent-execution-state-machine.md` |
| 单测里 mock 了 DB | 改用 `src/main/db/dbSmoke.test.ts` 同款的真 DB 烟测；mock 会盖掉迁移问题 |

---

## 5. 维护

- 本文件改完请同步把变更点在最后一次 commit 描述里点出来，便于后续 agent 知道"协作规范在演进"。
- 当新增"严禁"类规则时（安全、秘钥、可逆性），优先考虑写成项目级 hook / pre-commit，而不是只放在文档里——文档是兜底，hook 是执行。
- 新增的硬约束最好在 `~/.claude/projects/.../memory/` 也存一条 feedback / project memory，跨会话保留。
