# AgentHub MVP 3 分钟 Demo 脚本

## 0:00-0:30 打开 Workspace

打开 AgentHub，选择一个本地 React 项目目录。项目需要包含 `src/App.tsx`，并且 `App.tsx` 中有一个 button。应用会创建 Workspace 和 Main Agent；如果目录不是 Git 仓库，Git Tab 会显示非 Git 仓库提示。

## 0:30-1:10 创建子 Agent

点击左侧 `Add Agent`，进入 Main Agent 默认会话。输入：

```text
创建一个 React 前端 Agent
```

Main Agent 返回配置确认卡。确认名称、能力、文件范围和工具权限后，点击 `Confirm Create`。左侧会出现 `React Frontend Agent`。

## 1:10-2:00 生成 Diff

进入 React Frontend Agent 的默认会话，输入：

```text
把首页按钮改成蓝色
```

Mock Agent Runner 会读取 `src/App.tsx`，生成固定 DiffProposal，并创建一个 HTML Preview artifact。这个过程不依赖真实 Codex 或 API Key。

## 2:00-2:35 用户确认 Apply

在聊天区 Diff 卡片中检查改动。确认后点击 `Apply Diff`。Apply 由用户触发，执行前会校验 Diff 创建时记录的文件 hash；如果文件已经被外部修改，状态会变成 `conflicted`，不会覆盖用户的新改动。

## 2:35-3:00 查看闭环

打开 Git Tab，刷新后应看到：

```text
src/App.tsx modified
```

Preview Tab 会显示按钮变蓝后的预览产物。到这里闭环完成：Workspace 创建、主 Agent、对话式创建子 Agent、文件读取、Diff 生成、用户 Apply、Git 状态刷新全部串通。
