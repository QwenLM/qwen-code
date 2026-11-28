# Web Shell `/autofix-pr` 入口透出方案

[English](2026-11-28-web-shell-autofix-pr-entry-points.md) | [简体中文](2026-11-28-web-shell-autofix-pr-entry-points.zh-CN.md)

**状态：** 已实现（第一批 + 第二批）

## 问题背景

Web Shell 已经具备 `/autofix-pr` 的监视状态展示能力（`GET /autofix-pr/watches`、`AutofixPrWatchesDialog` 以及 `ScheduledTasksDialog` 内的监视摘要卡片），也在多处界面展示了 PR 信息（`SessionDetailsTooltip`、`GitHubPrsDialog`）。但当前所有 PR 入口都是只读的：用户必须记住 `/autofix-pr` 斜杠命令，手动切回会话并输入 `/autofix-pr <PR>` 或 `/autofix-pr resume <n>`；即便在「PR 监视」页面的空态和无宿主卡片上，也只给出了命令提示而没有可直接点击的操作按钮。

## 目标

1. 让用户可以直接从 Web Shell 现有的 PR 界面一键启动、恢复或跳转到 `/autofix-pr` 监视，无需手动输入命令。
2. 所有 PR 界面共享实时监视状态：已被监视的 PR 直接显示当前阶段（`监视中`、`修复中`、`将重试` 或 `待决定 (N)`），避免重复启动。
3. 复用 `/autofix-pr` 既有的安全确认、工作区信任和会话绑定约束，不新增 daemon 后端接口。

## 非目标

- 对话顶栏独立的 PR 监视状态胶囊（可选后续优化；目前对话顶栏标题 hover 已通过 `SessionDetailsTooltip` 透出 PR 操作）。
- 新建空白会话页的失败 PR 动态推荐卡片。

## 方案设计

### 1. 共享监视索引与上下文（`AutofixPrContext`）

当 `autofix_pr_watches` 与工作区项目能力均可用（且非 managed 模式）时，`App.tsx` 统一轮询一次各可操作工作区的 `useAutofixPrWatches`，通过 `indexAutofixPrWatches` 按规范化 PR URL 键（`host/owner/repo#number`，忽略大小写）建立索引，并通过 `AutofixPrContext` 暴露：

- `canStartInWorkspace(workspaceCwd)`：校验工作区信任状态与 `lockedWorkspaceCwd` 范围。
- `isWatchStateReady(workspaceCwd)`：仅在监视状态无错误加载完成（且目标工作区列表已落盘）后，才对未监视 PR 露出「自动修复」启动按钮。
- `startInNewSession({ prompt, workspaceCwd, sessionTitle })`：在目标工作区创建独立会话，待空草稿状态提交渲染后自动提交 `/autofix-pr` 指令，并在超时、被取代、中止或卸载路径上清除携带的 `pendingManualTitleRef`。
- `openWatch(entry)`：在各可操作工作区的定时任务中定位该监视的宿主会话并直接跳转；若该监视由外部 CLI 终端持有，则回退打开「PR 监视」页面。

`indexAutofixPrWatches` 对共享同一克隆 `root` 的多个关联 worktree 去重，同时跨同一仓库的独立克隆累计 `needsHumanCount` 与 `activeCloneCount`。`AutofixPrWatchesDialog` 处于 `AutofixPrContext` 内时复用共享状态（打开页面时立即触发一次 `reload()`），在独立渲染或单元测试场景下保留本地 `useAutofixPrWatches` 回退。

### 2. 状态感知 PR 行尾操作按钮（`AutofixPrActionButton`）

统一的轻量按钮组件按 PR 与监视状态渲染：

- `merged` / `closed` 状态的 PR（或实时监视已处于 `merged` / `closed` 终态的 PR）：不渲染按钮。
- 活跃监视中的 PR（`watching` / `fixing` / `abandonedFix`）：优先展示 `待决定 (N)`（存在 `entry.needsHumanCount > 0` 时），否则按阶段展示 `修复中`、`将重试` 或 `监视中`；点击直达宿主会话或「PR 监视」页。
- 空闲监视（`idle`）：展示 `恢复监视`，优先在监视自身克隆（`entry.workspaceCwd`）的新会话中运行 `/autofix-pr resume <n>`。
- 未监视、`ended` 或 `unscheduled` 的开放 PR：展示 `自动修复`，在目标工作区新会话中运行 `/autofix-pr <prUrl>`（重启已有 `inPlace: true` 监视时保留 `--in-place --watch`；未监视时受 `isWatchStateReady` 门控）。

### 3. 接入界面

1. **`SessionDetailsTooltip`**（一次覆盖侧边栏会话 hover、对话顶栏标题 hover 与会话总览详情）：在每条开放 PR 行尾展示紧凑型 `AutofixPrActionButton`，点击后关闭浮层且不抢回焦点，点击固定模式仍将初始焦点落在「复制会话 ID」按钮上，并对 `readOnly`（未信任工作区）行隐藏操作按钮。
2. **`GitHubPrsDialog`**（`GitDialog` 的 PR 列表页签）：将每行拆分为左侧原有 GitHub 链接（`<a>`）和右侧 `AutofixPrActionButton`，对 `checks === 'failing'` 或 `reviewDecision === 'changes_requested'` 的 PR 高亮展示，点击后关闭 `GitDialog`。
3. **`GitDialog` 创建 PR 后的即时接力**：PR 创建成功提示条右侧直接露出高亮的 `AutofixPrActionButton`，方便提交完 PR 后顺手一键开启 `/autofix-pr` 监视并关闭 `GitDialog`。
4. **`AutofixPrWatchesDialog` + `StartAutofixPrDialog`**：只要存在至少一个受信任可操作工作区，即在「PR 监视」页顶部与空态新增 **添加 PR 监视** 按钮，弹出提交期间锁定关闭（`dismissible={!submitting}`）的配置弹窗，支持工作区选择（切换工作区时清空 PR 输入）、工作区开放 PR 快捷点选（标注已在监视中的 PR）、PR 链接或 `#编号` 输入（兼容 `/files`、`/checks` 等 PR 子页面链接并规范化）、模式切换（`持续监视` / `--once`）、与 CLI 一致的检查间隔校验（`--every` 限定为 `1, 2, 5, 10, 15, 30, 60` 分钟）、是否回复评论（`--no-reply`）与附加指令；同时为卡片补齐 **恢复监视**、**重新开始**（保留 `inPlace: true` 的 `--in-place --watch`）、**清理监视** 一键按钮，单飞执行期间跨卡片禁用操作按钮，并保留外部 CLI 活跃监视的 `outsideDaemon` 提示。
5. **侧边栏导航角标、`SessionPrBadge` 状态指示与会话 `...` 菜单**：
   - 左侧「PR 监视」导航项在存在未结束监视的 `needsHuman` 待决定项时显示警告角标计数（折叠态与 rail 布局下在图标右上角显示提醒点），否则在存在活跃监视时显示活跃数量角标/圆点。
   - `SessionPrBadge` 对处于监视或待决定状态的开放 PR 显示紧凑状态圆点（绿色监视中、蓝色 `--status-running-fg` 脉冲修复中、琥珀色重试/待决定）并同步补充 `aria-label` / `title` 无障碍文案，不破坏 `#N (+M)` 紧凑宽度。
   - 会话 `...` 更多菜单为每条开放 PR 提供状态感知菜单项（`自动修复 PR #<n>`、`恢复监视 PR #<n>` 或 `查看 PR #<n> 监视（<状态>）`），兼顾移动端、触屏与键盘可达性。

## 关键设计决策与权衡

1. **默认新建专属会话启动**：每个 daemon 会话最多只能绑定 1 个持久定时任务（`session_already_bound`），且开发会话可能正忙或绑定了多个 PR。新建标题为 `自动修复 PR #<n>` 的专属会话可避免冲突、隔离监视上下文，并完整保留 skill 自身的 `ask_user_question` 安全确认流程。
2. **轻入口一键直发、管理页提供配置弹窗**：悬浮浮层（`SessionDetailsTooltip`）内嵌套带 Portal 的下拉菜单容易触发 hover 失焦关闭竞态，PR 列表也更适合一步直达；需要 `--once`、自定义 `--every`、`--no-reply` 或附加指令的用户可在「PR 监视」页的 `StartAutofixPrDialog` 中配置。
3. **新会话派发的渲染提交闩锁**：`clearSession()` 对 React 状态的清理是异步提交的；`pendingNewSessionRunRef` 会等待 `connection.sessionId === undefined && !sessionWriteBlocked`，并校验调用序号与目标工作区，确保快速清空不会把 `/autofix-pr` 误发进旧会话。

## 约束与风险

- 仅在 daemon 声明 `autofix_pr_watches` 且目标工作区受信任、处于 `lockedWorkspaceCwd` 范围内时启用；未信任或越界工作区在渲染期与派发期双层拒绝。
- 由外部 CLI 会话正在运行的活跃监视（无 Web Shell 定时任务但近期有检查或正在后台修复）不会在 UI 中被误抢占，仍显示外部会话提示，点击状态标签时打开「PR 监视」页面而非报错。

## 验证计划与验收标准

- 单元测试覆盖命令拼装、PR URL 规范化、监视索引与汇总（`autofixPrWatches.test.ts`）、按钮状态切换（`AutofixPrActionButton.test.tsx`）、添加监视弹窗校验与提交（`StartAutofixPrDialog.test.tsx`）、浮层集成（`SessionDetailsTooltip.test.tsx`）、GitHub PR 列表与创建后接力（`GitHubPrsDialog.test.tsx`、`GitDialog.test.tsx`）、PR 徽章监视指示（`SessionPrBadge.test.tsx`）、侧边栏导航角标与会话 `...` 菜单（`WebShellSidebar.bind-pr.test.tsx`）、PR 监视页操作（`AutofixPrWatchesDialog.test.tsx`），以及 `App` 层新会话派发与信任边界（`App.test.tsx`）。
- `packages/web-shell` 通过 `npm run typecheck`、`npm run lint`、`npm run format:check`、`npm run build` 以及受影响单元测试。
