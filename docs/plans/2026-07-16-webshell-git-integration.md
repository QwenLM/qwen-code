# Web Shell Git / GitHub 集成完整规划

> **Goal:** 把 Web Shell 从一个“只能看到分支名”的 git 盲区，建设成覆盖
> **状态感知 → diff review → 提交 → 分支 → GitHub 协作 → 远程同步** 的完整 git
> 工作台，并针对“这是一个 AI agent 工具”的特殊性，优先做好 **per-turn diff**
> （review agent 这一轮改了什么）。
>
> **Architecture:** daemon 是唯一的 git 权威入口（所有 git/gh 操作走 daemon
> REST，浏览器不直接碰仓库）；core 复用既有 `gitDiff.ts` / `gitDirect.ts` /
> `FileHistoryService` 等能力，不重写 git 解析；SDK 承载类型与向后兼容；
> Web Shell 只做展示与受控操作。
>
> **Tech Stack:** TypeScript、React、Node `child_process`（git/gh）、Vitest、
> Shiki（diff 高亮）、`virtual-viewport`（大 diff 虚拟化）。

第一层、第二层的接口与组件细节见设计文档
`docs/design/2026-07-16-webshell-git-status-diff.md`；本文档是全阶段路线图与
优化总览。

---

## 背景与现状

Web Shell 当前的 git 集成只有两处：

- 工具栏 branch chip（`GitBranchIndicator`），只显示分支名，数据来自 daemon
  `WorkspaceGitState`（只追踪 `branch`）。
- `/diff` 斜杠命令，ACP 透传，daemon 走非交互路径返回纯文本统计
  （`diffCommand.ts`）。

而 core 已有大量可复用能力：

- `gitDirect.ts`：`resolveBranchName`（直读 `.git/HEAD`）、`watchRepoBranch`
  （监听 reflog）、`readGitHead`（branch / detached）。
- `gitDiff.ts`：`fetchGitDiff`、`fetchGitDiffHunks`、`GitDiffResult` /
  `PerFileStats`、上限常量、`isInTransientGitState`。
- `gitUtils.ts`：`findGitRoot`、`getRecentGitStatus`。
- `fileHistoryService.ts`：per-turn 文件 checkpoint（turn diff 的基础）。
- CLI `DiffDialog.tsx`：`useTurnDiffs` / `useDiffData` / `TurnDiff`，已实现
  交互式 diff 查看。

---

## 设计原则

1. **只读优先，写操作受控**：状态感知 / diff 是只读；commit / push / 切分支等
   写操作必须带确认弹窗（与 AGENTS.md “Executing actions with care” 一致）。
2. **daemon 是唯一 git 权威**：浏览器不直接执行 git/gh，全部经 daemon REST，
   保证安全（path 校验、命令注入防护）与多 workspace 隔离。
3. **复用 core，不重写**：git 解析、上限、transient 检测、turn diff 全部复用
   既有实现。
4. **优雅降级与能力门控**：非 git 仓库隐藏 git UI；GitHub 功能仅在 `gh` 已认证
   时出现；transient state（merge/rebase）显式 surfaced 而非隐藏。
5. **Simplicity First**：每阶段只做必要功能，不为假想需求过度设计。

---

## 功能规划（分阶段）

### Phase 1 · 状态感知 + 进行中操作指示（进行中）

branch chip 从“分支名”升级为“实时状态条”。

- 字段：dirty（staged / unstaged / untracked）、ahead / behind、stashCount、
  detached、**operation**（merge / rebase / cherry-pick / revert / bisect）、
  **conflicted**（冲突文件数）。
- core：`getGitWorkingTreeStatus`（已实现 dirty/ahead-behind/stash/detached），
  本阶段再补 `detectGitOperation` + `conflicted`，并把“transient 返回 null”
  改为“返回带 `operation` 的状态”（git status 在 merge/rebase 期间仍可用）。
- daemon：`WorkspaceGitState.getStatus` 输出 enriched v2（已实现 dirty 部分）。
- SDK：`DaemonWorkspaceGitStatus` 加 v2 可选字段。
- Web Shell：chip 显示 dirty 点 / `↑N↓M` / stash 角标 / detached 变色 /
  **operation 徽标**（如 `REBASING`）/ 冲突数。
- 刷新策略：branch 走 SSE `git_branch_changed`（实时）；重字段按需 + focus +
  `git_branch_changed` + 仅当前 workspace 低速轮询。

详见设计文档第一层。

### Phase 2 · 可视化 diff（工作区 vs HEAD）

- core：`fetchGitDiffHunksForFile(cwd, path)`（单文件按需 hunk）。
- daemon：`GET /workspace/git/diff`（文件列表 + 统计）、
  `GET /workspace/git/diff/file?path=`（单文件 hunk）。
- SDK：`DaemonWorkspaceGitDiff` / `DaemonWorkspaceGitDiffHunks` 类型 +
  `workspaceGitDiff()` / `workspaceGitDiffFile(path)`。
- Web Shell：`GitDiffDialog`（文件列表 → 点开按需加载行级 diff，Shiki 高亮，
  大 diff 虚拟滚动）；`/diff` 本地化打开该弹窗；dirty chip 点击联动。

详见设计文档第二层。

### Phase 3 · per-turn diff（agent 这一轮改了什么）★ 优先于 GitHub

对 AI agent 工具，**“agent 这一轮改了哪些行”比“工作区 vs HEAD”更精准**
（后者混入用户自己的改动）。CLI 已有完整基础设施。

- daemon：把 `FileHistoryService` 的 per-turn checkpoint 通过 REST 暴露
  （turn 列表 + 每个 turn 的文件 diff），复用 `TurnDiff` / `TurnFileDiff`。
- SDK：turn diff 类型 + client 方法。
- Web Shell：`GitDiffDialog` 增加视图切换——“工作区 vs HEAD” / “本 turn 改动”；
  或在每条 agent 消息旁提供“查看本次改动”入口。
- 复用 CLI `useTurnDiffs` / `useDiffData` 的数据形态，避免重造。

### Phase 4 · 提交工作流 + 丢弃改动（写操作，带确认）

- stage / unstage 文件勾选。
- **AI 生成 commit message**（agent 已擅长）→ 用户确认提交。
- 丢弃改动：回退到 checkpoint（复用 `FileHistoryService`），或 `git checkout`
  单文件 / `git restore`。
- 全部带确认弹窗；commit 前展示将要提交的内容。

### Phase 5 · 分支管理

- 分支列表、切换、新建、删除（删除带确认）。
- 当前分支高亮；upstream gone 提示清理。

### Phase 6 · GitHub 集成 ★ 后续重点

daemon 封装 `gh` CLI（需 workspace 内 `gh` 已认证），暴露 REST：

- **PR**：列表 / 详情 / diff / 创建（agent 写完代码一键开 PR，message 自动
  生成）/ review comments（inline 读取与回复）。
- **CI**：checks 状态、失败日志查看。
- **Issue**：列表 / 详情 / 关联。
- **通知**：review 请求、CI 失败、评论（inbox 式提醒）。
- 在浏览器直接打开 PR / commit / issue 的 web 链接。
- 能力门控：`gh auth status` 未认证时隐藏 GitHub UI 并引导认证。

### Phase 7 · 远程同步

- fetch / pull / push 按钮 + 确认；显示 remote 状态与最近同步时间。
- push 前展示本地领先 commit；pull 冲突时引导到 Phase 4 的冲突处理。

### 候选 / 扩展功能（按需排期）

- **冲突解决 UI**：conflicted > 0 时展示冲突标记、选择保留侧、或让 agent 解决。
- **stash 操作**：apply / pop / drop（不止计数）。
- **commit 历史 / blame**：浏览 log、行级作者。
- **任意 ref 比较**：两分支 / 两 commit 之间 diff。
- **多 workspace git 总览**：一次性看所有 workspace 的状态（Web Shell 是多
  workspace 的）。
- **git 身份配置**：展示 / 编辑 `user.name` / `user.email`。
- **tag / release**：打 tag、发布流程。

### agent 工具的专属能力（差异化重点，区别于普通 git GUI）

- **信任 / 权限门控**：daemon 服务不受信任 workspace（已有
  `requireTrustedWorkspaceRuntime` / untrusted workspace catalog）。读
  （status/diff）可放开；写（commit/push）与 `gh`（可能泄露仓库信息）需按
  workspace 信任级别门控。
- **多客户端一致性 & 并发**：同一 daemon/workspace 多客户端连接时，一个客户端
  commit 要广播给其他客户端（当前只有 branch 走 SSE）；并发写操作去重 / 序列化。
- **git 状态反哺 agent 上下文**：把“正在 rebase / 有 N 个冲突”注入 agent 启动
  上下文（已有 `getRecentGitStatus`），让 agent 知道当前处境。
- **diff 作为 agent 输入**：diff 查看器选中行 → “为什么改这里？”把 diff 从
  输出变成输入面。
- **host 应用暴露**：web-shell 是可嵌入组件（已有 `onSessionIdChange` /
  sidebar renderer 等 props），git 状态可通过 props/customization 暴露给宿主。
- **review → 测试闭环**：review diff 后从查看器直接跑本次改动相关的测试。

---

## 优化规划（横切，贯穿各阶段）

### 性能

- **status 轮询成本**：`git status` 是子进程，大仓库慢。
  - ahead / behind 要遍历历史，是大仓库主要开销 → 用
    `git status --no-ahead-behind`，ahead/behind 单独算并缓存（只在 commit /
    fetch 后变）。
  - 监听 `.git/index` mtime（廉价）感知 stage / commit，替代部分轮询。
  - 只对**当前活跃 workspace** 轮询，不对所有 workspace。
  - 子进程超时（已有 `GIT_TIMEOUT_MS=5000`）+ 可取消。
- **并发去重**：多个 `getStatus` / diff 请求（chip + 弹窗）合并为一次 git
  调用（in-flight coalescing）。
- **diff 缓存**：diff 只在文件变化时变 → 缓存 + 在 `git_branch_changed` /
  focus / index 变化时失效。
- **大 diff 虚拟化**：复用 `docs/design/virtual-viewport` 的虚拟滚动；单文件
  按需加载（Phase 2 已设计）；hunk 分页。
- **离屏解析**：diff 解析 / Shiki 高亮可放 web worker，避免阻塞主线程。
- **请求取消 / 背压**：切走 workspace / 关闭弹窗时 abort 在途 git/gh 子进程；
  高频刷新（focus、连续 SSE）做 debounce + 丢弃过期响应（last-write-wins，按
  `computedAt` 比较），避免旧响应覆盖新结果。
- **gh 结果缓存**：PR / CI / issue 列表按 workspace + 短 TTL 缓存，仅在
  操作后 / 手动刷新 / 轮询时失效，避免频繁打 `gh`（有限速）。

### 安全

- **path 防越界**：diff 的 `path` 查询参数在 core + daemon 两层校验（拒绝绝对
  路径 / `..` 越界段），最终由 git 限定在仓库内。
- **文件名 sanitize**：git 允许路径含控制字节 / 转义，渲染前统一 sanitize
  （参考 `sanitizeFilenameForDisplay` 语义）。
- **命令注入防护**：`gh` / `git` 一律用 `execFile` 数组参数，不拼字符串。
- **secret 防护**：commit / push 前不引入 secret 扫描责任，但避免在 UI 暴露
  token / 凭据。

### 体验与降级

- **能力门控**：非 git 仓库隐藏 git UI；GitHub 功能仅 `gh` 认证后出现。
- **transient 显式化**：merge / rebase 期间 chip 显示 operation，diff 视图给
  对应提示。
- **i18n**：所有新文案 en + zh-CN（`i18n.tsx`）。
- **a11y**：chip / 弹窗的 aria-label、键盘导航（复用现有 dialog listbox 模式）。
- **非颜色兜底**：dirty / conflicted / detached 等状态不能只靠颜色区分
  （色盲 / 低对比），必须有图标 / 文字 / 形状（如 dirty 点 + `↑↓` 数字、
  conflict 用 `!` 角标），符合 WCAG 对比度。

### 兼容性

- **git 版本兼容**：避免依赖高版本独有特性——`git init -b`（2.28+）、
  `--porcelain=v2`（2.11+）等；本阶段用 `--porcelain=v1`（已确认）；新特性先
  探测 `git --version` 或优雅回退。
- **跨平台**：Windows / macOS / Linux 的 git 路径分隔符、行尾、`gh` 可执行名
  差异；子进程用 `execFile` 数组参数避免 shell 差异。
- **按操作类型超时**：只读 status/diff 用短超时（已有 `GIT_TIMEOUT_MS`）；
  网络型 fetch/pull/push/gh 用更长且可配置超时，并区分“慢”与“挂死”。
- **PR 拆分与版本偏斜**：Phase 1 跨 core/daemon/SDK/web-shell 四包，PR 内
  类型需向后兼容（v2 字段全可选）；老 SDK + 新 daemon、或反向组合都不能崩。

---

## 架构与数据流

```text
core (gitDirect + gitDiff + FileHistoryService)
  → daemon (WorkspaceGitState / git routes / gh wrapper)   ← 唯一 git 权威
  → SDK (DaemonClient + types + events，向后兼容)
  → webui (mappers: 事件 → connection 状态)
  → Web Shell (chip / GitDiffDialog / 各 dialog)
```

- **状态**：branch 走 SSE `git_branch_changed`（实时、廉价）；重字段走 REST
  `workspaceGit()`（按需 + 触发式）。
- **diff**：REST 按需，单文件 hunk 懒加载。
- **写操作**：REST POST + 前端确认弹窗。
- **GitHub**：daemon `gh` wrapper + REST，能力门控。

---

## 依赖与排序

```text
Phase 1 状态感知 + operation 指示   ← 当前（core/daemon 已完成大半）
Phase 2 可视化 diff（工作区 vs HEAD）
Phase 3 per-turn diff               ★ 优先于 GitHub
Phase 4 提交工作流 + 丢弃改动
Phase 5 分支管理
Phase 6 GitHub 集成                 ★ 后续重点
Phase 7 远程同步
```

- Phase 2 依赖 Phase 1 的 daemon git 路由骨架。
- Phase 3 依赖 Phase 2 的 diff 查看器 UI（复用同一弹窗，加视图切换）。
- Phase 4/5 的写操作依赖 Phase 1-3 的只读基础与确认弹窗模式。
- Phase 6 相对独立（依赖 `gh` 认证），可在 Phase 3 之后并行推进。
- 横切优化按需在对应阶段落地（如虚拟滚动随 Phase 2、index watch 随 Phase 1）。
- **信任门控是写操作的安全网**：Phase 4（commit/丢弃）、Phase 6（gh，可能泄露
  仓库信息）、Phase 7（push）落地时必须接入 workspace 信任级别（复用
  `requireTrustedWorkspaceRuntime`）；读操作（status/diff）可放开。这应在对应
  阶段同步实现，而非事后补。

---

## 当前进度

### Phase 1 ✅ 已完成（分支 `feat/webshell-git-status-chip`）

- ✅ core：`getGitWorkingTreeStatus` + `parseStatusBranchLine` /
  `parseStatusEntries` + `detectGitOperation` + `conflicted`，transient surfaced
  - 单测（**79 个通过**）。
- ✅ daemon：`WorkspaceGitState.getStatus` 输出 enriched v2，透传
  `operation` / `conflicted` + 单测（**14 个通过**）。
- ✅ SDK：`DaemonWorkspaceGitStatus` v2 字段（`v: 1 | 2`）+ `DaemonGitOperation`。
- ✅ Web Shell：chip 增强（dirty 点 / `↑N↓M` / stash / detached 换图标 /
  operation 徽标 / 冲突数，**非颜色兜底**）+ 刷新策略（focus + branch 变化 +
  仅当前 workspace 30s 可见性轮询）+ i18n + 单测（GitBranchIndicator 8 +
  ChatEditor&App 118）。
- ✅ 验证：build / typecheck（全仓）/ lint / 单测全绿。

### Phase 2 ✅ 已完成（自动化验证；分支 `feat/webshell-git-status-chip`）

可视化 diff（工作区 vs HEAD）：「Changes」弹窗 = 文件列表 + 单文件 hunk 懒加载

- Shiki **per-side 精确高亮**；`/diff` 本地拦截打开弹窗；dirty chip 点击联动。

* ✅ core：`fetchGitDiffHunksForFile` + `toRepoRelativePath` +
  `synthesizeUntrackedHunk`（untracked 全新增、删除文件可 diff、`O_NOFOLLOW`、
  二进制/上限）+ 单测（`gitDiff.test.ts` **88 通过**）。
* ✅ daemon：`GET /workspace/git/diff`（列表+统计）与 `.../diff/file?path=`
  （单文件 hunk）+ qualified 版本 + server 注册 + 单测（**8 通过**）。
  单文件路由不经 fs factory（`'read'` 拒绝已删除文件），改由 trust gate +
  core repo-relative 规范化 + git 仓库内含 + `O_NOFOLLOW` + `ls-files` gate。
* ✅ SDK：`DaemonWorkspaceGitDiff` / `...File` / `...Hunks` / `DaemonDiffHunk`
  - `workspaceGitDiff()` / `workspaceGitDiffFile(path)`（两类 client）+
    bundle 上限 160→165KB。
* ✅ Web Shell：`GitDiffDialog`（`DialogShell` + per-side `codeToTokens` 高亮 +
  懒加载 + 占位态）+ `GitBranchIndicator` 可点击 chip + `ChatEditor` 透传 +
  `App.tsx` 状态/渲染/`/diff` 拦截 + `localCommands` 补全 + i18n（en/zh-CN）
  - 单测（`GitDiffDialog` 5 + `GitBranchIndicator` 9）。
* ✅ 验证：typecheck（全仓）/ lint / Prettier / 单测全绿。
* ⬜ 浏览器人工验收待补。

详细 task 分解见 `docs/design/2026-07-16-webshell-git-status-diff.md` 的
「Phase 2 详细实施计划」。

### Phase 2.5 ✅ 已完成（自动化验证；分支 `feat/webshell-git-status-chip`）

侧栏 workspace git 下放：左侧每个 workspace 文件夹行显示一个 git 图标 + 状态点
（dirty/冲突/进行中），分支名 + ahead/behind 收于 hover tooltip；点击直接打开
**该 workspace** 的 Changes 弹窗（复用 Phase 2 的 `GitDiffDialog`）。多仓库 git
状态无需逐个切换即可一览。

- ✅ `WorkspaceSection`：trusted（且传入 `onOpenGitDiff`）时拉 `workspaceGit()`
  （mount/focus/reloadToken/可见时 60s 慢轮询）+ header 行渲染
  `GitBranchIndicator`（兄弟节点，规避按钮嵌套，传 `compact` 走图标态）+
  `.gitPill` 借 `:has()` 让图标紧贴名称、操作贴右缘。
- ✅ `App.tsx`：弹窗状态 `showGitDiffDialog: boolean` → `diffWorkspaceCwd:
string | undefined` 重构；工具栏 chip 与侧栏 chip 统一经 `setDiffWorkspaceCwd`
  打开同一弹窗、各指向自身仓库。
- ✅ prop 透传 App → `WebShellSidebar` → `WorkspaceSection`。
- ✅ i18n 复用 `git.*`（无新键）+ 新增 `WorkspaceSection.test.tsx`（4 通过）。
- ✅ 验证：typecheck / lint / Prettier / 相关单测全绿（43 通过）。
- ⬜ 浏览器人工验收待补。

详细决策见 `docs/design/2026-07-16-webshell-git-status-diff.md` 的
「Phase 2.5」节。

---

## 风险

- **大仓库 status 慢** → `--no-ahead-behind` + index watch + 仅活跃 workspace
  轮询 + 超时。
- **dirty 不逐键实时** → 明确为成本取舍，focus / 打开弹窗 / 低速轮询覆盖。
- **turn diff 数据通路** → 依赖 daemon 暴露 `FileHistoryService`，需确认
  daemon 侧能拿到 session 的 checkpoint 数据。
- **GitHub 认证** → `gh` 未认证时优雅降级并引导。
- **跨包类型扩张** → SDK 定义最小结构，不反向依赖 Web Shell client 类型。

---

## 决策记录

- **第一层范围**：纳入“进行中操作指示”（merge/rebase/cherry-pick/revert/
  bisect），把 transient 从“返回 null”改为 surfaced。
- **turn diff**：纳入整体规划，优先级高于 GitHub（Phase 3 在 Phase 6 之前）。
- **后续重点**：GitHub 集成（Phase 6）。
- **diff payload**：文件列表与单文件 hunk 分两个路由，避免单次响应过大。
- **刷新**：不监听整个工作区文件树（避免昂贵全树 watcher），dirty 不逐键实时。
