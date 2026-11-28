# Web Shell 工作区概览与管理入口

**语言：** [English](./web-shell-workspace-overview.md) | 简体中文

关联 Issue：https://github.com/QwenLM/qwen-code/issues/10399

## 目标

让工作区成为 Web Shell 侧栏中的一等对象：无需打开会话即可查看其内容与健康状态，并将所有工作区级操作与管理入口直接归拢到对应工作区下。

## 行为设计

### 目录标题行

- 标题行保留工作区名称与徽章，并在右侧展示会话统计：等待用户确认的会话（告警色）、正在执行的会话（成功色）以及总数（目录分页截断时显示为 `N+`）。折叠工作区行时停止其目录轮询，保留上次计算好的计数并在下次展开时刷新；会话来源切换且分页尚未就绪时不展示旧计数。
- 工作区名称悬停时提示完整路径；展开时在标题下方展示路径。
- 当注册工作区多于一个时，“项目（Projects）”标题显示工作区总数。

### 概览状态项与悬停详情浮层

已信任工作区的悬停详情浮层汇总 MCP 服务（`已连接/已启用`）、Skills（已启用数）、Extensions（激活数，或存在差异时为 `激活/总数`）、Channels（`已连接/已配置`）与 Context 文件数，Hooks 默认关闭但可按需启用。状态项仅在悬停浮层或工作区 `⋮` 菜单打开时拉取，两者都关闭时保留最近一次快照。

浮层中的分支行支持直接交互：点击打开该工作区的 Git 选择器（切换分支、拉取/推送、查看变更、提交），并在分支名旁用圆点标记脏工作树或冲突态；未接入 Git 能力的工作区保留纯文本摘要。

- MCP、Skills 和 Hooks 由工作区对应的 ACP 子进程发现；在返回 `initialized` 前显示 `—` 并提示运行时未初始化，不以 `0` 冒充占位。
- Context 文件由 daemon 直接读取磁盘，结果始终确定（没有 `QWEN.md` 时显示 `0`）。
- MCP 有服务失败或已启用服务未连接时显示告警色；Channels 存在错误实例时显示告警色。
- Extensions、Channels 和 Context 属于 daemon 侧状态项：首轮请求落地前不展示状态行；缺失路由或请求失败时提示“当前 daemon 不支持”。
- 当工作区为本地受信任且接入了管理回调时，可管理的状态行渲染为 `<button type="button">`（带右侧箭头），并使用包含工作区名称的独立 `aria-label`（例如 `管理 qwen-code 的MCP：已连接 1/3，失败 1，已禁用 1`），避免与侧栏顶层导航按钮的无障碍名称冲突。点击后立即关闭浮层且不将焦点抢回侧栏锚点，直接进入该工作区的管理视图（MCP / Skills / Extensions → `PluginManagerPage`，Channels → `ChannelsManagerPage`，Context → `MemoryMessage`，Hooks → `WorkspaceHooksDialog`）。当前 daemon 不支持的项或未接入回调的项保持只读 `<div>`。

### 工作区 `⋮` 菜单

工作区行的悬停 `⋮` 菜单提供以下能力：

- **信任工作区**（未受信任的本地非 SSH 工作区，且 daemon 声明 `workspace_trust_grant`、侧栏未锁定）：通过共享的 `useWorkspaceTrustGrant` hook 调用 `grantWorkspaceTrust()`，在运行时重建期间呈禁用态，直至 `capabilities` 返回 `trusted: true`。
- **常用操作**：重命名（仅动态注册且持久化落盘的非主工作区；空名称回退目录名并拒绝控制字符）、复制路径、打开文件夹 / 打开终端、新建会话、新建 worktree 会话（仅在 Git 轮询存在分支时显示）、新建分组、上移 / 下移。
- **管理工作区**：MCP、Skills、Extensions、Channels、Settings，前四项旁展示实时计数。菜单在工作区折叠时仍保留最近一次快照计数；菜单打开期间操作区保持可见以便 `Escape` 正确回焦触发器。
- **生命周期**：重新加载运行时（`POST /workspaces/:w/reload`）、移除工作区。

每个条目均按工作区状态严格门控：既不可信任也不可移除的未受信任行不显示菜单；锁定工作区的自定义渲染器隐藏整个操作区。

「管理工作区」分组对所有本地受信任的非 SSH 工作区（主工作区与次级工作区）开放。次级工作区上，`Skills` 受 `workspace_skills_config_runtime` 门控，`Channels` 受 `channel_management` 门控，避免老版本 daemon 将次级点击误路由至主工作区。

### Layer B1 — 按工作区作用域的管理页路由

- `onOpenWorkspaceManagement(target, workspaceCwd)` 将 `mcp`、`skills`、`extensions` 统一路由到 `PluginManagerPage`，透传 `initialTab`、`initialWorkspaceCwd` 和单调递增的 `navigationRequest`（同步修复原先 `mcp` 缺少斜杠命令 `mcpDialogMessage` 时误落回会话总览页的问题）。`ExtensionsManagerPage` 支持 `workspaceCwd` 和 `workspaceControl`，`PluginManagerPage` 在 Extensions Tab 同样展示工作区切换器。
- `channels` 路由到 `ChannelsManagerPage`，传入 `initialWorkspaceCwd` 与 `navigationRequest`，同步切换 `managementWorkspaceCwd` 并关闭残留的编辑或删除确认弹窗。
- `settings` 路由到由 `useDaemonSettings({ workspaceCwd })` 驱动的 `SettingsMessage`，通过 `/workspaces/:workspace/settings` 读写工作区作用域设置，将用户作用域写入保留在 `/workspace/settings`；在 `Workspace` 作用域栏展示工作区切换器，并将 `WorkspaceDirectoriesSection` 与项目级语言写入绑定到选定工作区，不干扰当前会话或全局界面状态。
- `context` 打开由 `useDaemonMemory({ workspaceCwd })` 驱动的 `MemoryMessage`，通过 `WorkspaceDaemonClient.workspaceMemory({ includeContent: true })`（`/workspaces/:workspace/memory?content=true`）读取并将工作区级写入路由到 `/workspaces/:workspace/memory`，全局写入保持 `/workspace/memory`。
- `hooks` 打开 `WorkspaceHooksDialog`，展示 `/workspaces/:workspace/hooks` 返回的 Hooks 列表并提供绑定哈希的项目 Hook 审批控制。
- 若目标次级工作区在管理面板或弹窗打开期间被移除或失去信任，管理面板自动回退到主工作区，工作区级弹窗自动关闭。

## 数据流

`useWorkspaceOverview(client, cwd, { enabled, items })` 通过 `client.workspaceByCwd(cwd)` 分别请求 `/mcp`、`/skills`、`/extensions`、`/channels`、`/memory` 与 `/hooks`，各状态项独立失败互不影响。单项在连续最多 3 轮未响应期间保留上次已知值，随后标记为不可用；计数预算绑定到单次会话纪元（切换 cwd 或折叠时递增纪元），避免过期结果污染新状态。

仅当工作区受信任、使用默认标题且存在打开中的消费者（悬停详情浮层或 `⋮` 菜单）时才发起请求，并在页面可见时按 30 秒周期轮询，同时响应窗口聚焦与侧栏重载信号。没有打开消费者的工作区零额外开销。

会话统计复用工作区行自身拉取的目录分页；主工作区由侧栏直接传入其统计值。

## 嵌入配置

- `sidebar.workspaceOverview: false` 关闭概览并保持简洁标题；`{ items: [...] }` 指定展示的状态子集。
- `onOpenWorkspaceManagement(target, workspaceCwd)` 与 `onNewWorktreeSession(workspaceCwd)` 供宿主或应用接入管理页导航与带 worktree 意图的新建会话。

## 后续事项（Issue 中的 Layer C）

- 在 daemon 新增 `GET /workspaces/:w/overview`（由 `workspace_overview` 能力声明），将多项扇出请求合并为单次请求。
- 在 daemon 支持主工作区注册元数据持久化后开放主工作区重命名；在跨 host 与托管工作区后端具备对应写接口后补充其管理入口。

## Layer B2 — 工作区总览面板

`WorkspacesOverviewPanel`（面板 id `'workspaces'`）以全页表格展示所有已注册工作区：包含名称、主/未信任徽章、路径、活跃会话统计、MCP 健康状态、Git 分支与脏文件统计以及最近活动时间。daemon 内部 `kind: 'live'` 运行时不作为普通行展示。每行提供新建任务、一键信任与移除操作，与侧栏复用同一套 `useWorkspaceRemoval` / `WorkspaceRemovalDialog` 和 `useWorkspaceTrustGrant` 逻辑。
