# Web Shell git 状态感知与可视化 diff

## 背景

当 workspace 是一个 git 仓库时，Web Shell 目前的 git 集成非常薄，只有两处：

- 工具栏里的 branch chip（`GitBranchIndicator`），只显示当前分支名。数据来自
  daemon 的 `WorkspaceGitState`，它只追踪 `branch` 一个字段。
- `/diff` 斜杠命令。在 Web Shell 中它是 ACP 透传，daemon 走非交互路径返回一段
  纯文本统计（`diffCommand.ts` 的 `renderDiffModelText`）。

这意味着用户想确认“工作区干不干净”“有没有 commit 没推”“agent 到底改了哪些行”
时，要么只能看到一个分支名，要么只能读一段终端文本——而 Web Shell 是图形界面，
本应做得比终端更好。

core 里其实已经有完整的 git 能力可以复用：

- `gitDirect.ts`：`resolveBranchName`（直读 `.git/HEAD`，微秒级）、
  `watchRepoBranch`（监听 `<gitDir>/logs/HEAD` reflog）、`readGitHead`
  （区分 branch / detached）。
- `gitDiff.ts`：`fetchGitDiff`（工作区 vs HEAD 的 per-file 统计）、
  `fetchGitDiffHunks`（`Map<string, Hunk[]>` 行级 hunk）、`GitDiffResult` /
  `PerFileStats` / `GitDiffStats` 类型，以及一组成熟的上限
  （`MAX_FILES=50`、`MAX_DIFF_SIZE_BYTES=1MB`、`MAX_LINES_PER_FILE=400`）和
  transient state（merge/rebase/cherry-pick/revert）检测。
- `gitUtils.ts`：`getRecentGitStatus` 已经用 `git status --short --branch`
  一次拿到 branch + short status + 最近 5 条 commit，并解析了 branch header。

本期目标是在不改变 agent 行为的前提下，把这些已有能力接到 Web Shell UI 上，
分两层落地：第一层增强状态感知（branch chip 旁边显示 dirty / ahead-behind /
stash / detached），第二层提供一个浏览器里的可视化 diff 查看器。

## 目标

- branch chip 在不打开任何弹窗的情况下，能一眼看出工作区是否干净、相对
  upstream 的 ahead/behind、是否有 stash、是否处于 detached HEAD。
- 提供一个图形化 diff 查看器：变更文件列表 + 点击展开的单文件行级 diff，复用
  Shiki 做语法高亮。
- 复用 core 已有的 `fetchGitDiff` / `fetchGitDiffHunks` / `resolveBranchName`
  等能力，不在 Web Shell 里重新实现 git 解析。
- 兼容旧 daemon、旧 client、非 git 仓库、transient state、detached HEAD 等
  边界状态，缺失数据时优雅降级而不是报错或空白。
- 只读优先：所有展示能力都是只读的，不引入任何会改变仓库状态的写操作。

## 非目标

- 不做提交工作流（stage / commit / 生成 commit message）。属于后续增量。
- 不做分支管理（切换 / 新建 / 删除分支）。
- 不做 GitHub 集成（PR / issue / CI checks）。属于后续增量。
- 不做远程同步（fetch / pull / push）。
- 不监听整个工作区文件树来实时刷新 dirty 状态。dirty 状态在用户编辑文件后
  不会逐键实时更新（见“刷新策略”），这是有意的成本取舍。
- 不改变 `/diff` 在非 Web Shell 客户端（管道、日志、远程 transport）的纯文本
  输出；那些路径继续走 daemon 的 `renderDiffModelText`。
- 不为 untracked 文件合成行级 hunk（本期 untracked 只显示“新文件 + 行数”，
  与 CLI `DiffDialog` 行为一致）。

## 现状链路

### 数据来源（core）

- `resolveBranchName(cwd)`：直读 `.git/HEAD`，返回分支名或 detached 时的短
  SHA；非仓库返回 `undefined`。微秒级，可放在渲染热路径。
- `watchRepoBranch(cwd, onChange)`：多个订阅者共享一个对
  `<gitDir>/logs/HEAD` 的 `fs.watch`，在 branch 切换 / commit / reset 时触发。
  它**不会**因为编辑工作区文件而触发（编辑不写 reflog）。
- `readGitHead(gitDir)`：返回 `{ type: 'branch' | 'detached', name }`，可用于
  判断 detached。
- `fetchGitDiff(cwd)`：返回 `GitDiffResult { stats, perFileStats }`，比较工作区
  与 HEAD；transient state 或非仓库返回 `null`。
- `fetchGitDiffHunks(cwd)`：返回 `Map<string, Hunk[]>`，内部执行
  `git diff HEAD`。注意 untracked 文件不会出现在 `git diff HEAD` 输出里。

### daemon

- `WorkspaceGitState`（`packages/cli/src/serve/workspace-git-state.ts`）：
  每个 workspace 一个 entry，缓存 `branch`，用 `watchRepoBranch` 监听变化，
  变化时通过 `bridge.publishWorkspaceEvent({ type: 'git_branch_changed', ... })`
  推送。`getStatus()` 当前返回 `{ v: 1, workspaceCwd, branch }`。
- 路由（`packages/cli/src/serve/routes/workspace-git.ts`）：
  `GET /workspace/git`（绑定 workspace）和
  `GET /workspaces/:workspace/git`（带 qualified workspace 参数，需 trusted
  runtime）。
- `/diff` 命令（`packages/cli/src/ui/commands/diffCommand.ts`）：交互模式打开
  Ink 的 `DiffDialog`；非交互 / ACP 返回 `fetchGitDiff` + `buildDiffRenderModel`
  - `renderDiffModelText` 的纯文本。

### SDK / webui

- `DaemonWorkspaceGitStatus` 类型 + `DaemonClient.workspaceGit()`
  （`GET /workspace/git`）。
- 事件 `git_branch_changed` 在 `sdk-typescript/src/daemon/events.ts` 注册。
- `webui/src/daemon/session/mappers.ts` 把 `git_branch_changed` 映射到
  `connection.gitBranch`（并用 `workspaceCwd` 做了归属校验）。

### Web Shell

- `GitBranchIndicator.tsx`：纯展示 chip（branch 名 + tooltip）。
- `ChatEditor.tsx`：把 `gitBranch` 作为一个 toolbar action 渲染
  （`gitBranchVisible`、compact / expanded 两种形态）。
- `App.tsx`：
  - `connection.gitBranch`（来自 SSE `git_branch_changed`）驱动会话内的 chip。
  - `selectedWorkspaceGitBranch`：在选择 workspace 但**尚未连接 session** 时，
    通过 `workspace.client.workspaceByCwd(cwd).workspaceGit()` 拉取一次分支做
    预览。
  - `activePanel` 机制统一管理各类弹窗（settings / status / sessions /
    extensions / plugins 等），`components/dialogs/*.tsx` + 同名
    `.module.css` 是标准弹窗形态。
- `customization.tsx`：markdown 代码块用 Shiki 高亮
  （`WebShellCodeBlockRenderInfo.resolvedLanguage` 是规范化后的 Shiki language
  id），可作为 diff 行内语法高亮的复用基础。
- `constants/localCommands.ts`：`getLocalCommands(t)` 定义本地斜杠命令补全。

## 方案概述

整体数据流沿用现有 branch chip 的形态，向下扩展 core / daemon / SDK，向上扩展
Web Shell 组件：

```text
core (gitDirect + gitDiff)
  ├─ getGitWorkingTreeStatus(cwd)   [新增] dirty / ahead / behind / stash / detached
  ├─ fetchGitDiff(cwd)              [复用] 文件列表 + 统计
  └─ fetchGitDiffHunksForFile(cwd, path)  [新增] 单文件行级 hunk
        │
        ▼
daemon (serve)
  ├─ WorkspaceGitState.getStatus()  [扩展] 返回 enriched status
  ├─ GET /workspace/git             [扩展] 携带 enriched 字段
  ├─ GET /workspace/git/diff        [新增] 文件列表 + 统计
  └─ GET /workspace/git/diff/file   [新增] 单文件 hunk（按需）
        │
        ▼
SDK (DaemonClient + types + events)
  ├─ DaemonWorkspaceGitStatus       [扩展] 新字段（可选，向后兼容）
  ├─ DaemonWorkspaceGitDiff / ...File [新增]
  ├─ workspaceGitDiff() / workspaceGitDiffFile(path)  [新增]
  └─ git_status_changed             [新增事件，可选]
        │
        ▼
webui (mappers)
  └─ git_status_changed → connection.gitStatus  [新增]
        │
        ▼
Web Shell (client)
  ├─ GitBranchIndicator             [扩展] dirty 点 / ahead-behind / stash / detached
  └─ GitDiffDialog                  [新增] 文件列表 + 单文件行级 diff（Shiki 高亮）
```

两层共享同一组 daemon git 路由：第一层用 `GET /workspace/git`（enriched），
第二层用 `GET /workspace/git/diff` 与 `.../diff/file`。dirty 指示点可点击，
点击直接打开 `GitDiffDialog`，把两层串起来。

## UI 草图（Before / After）

落地后页面只变两处：输入框工具栏的 branch chip（第一层）和一个新的 Changes
弹窗（第二层）。

### 第一层：branch chip

chip 仍在输入框左下角工具栏（位置不变），信息更丰富，有 compact / expanded
两种形态（工具栏空间够时自动展开，沿用现有 toolbar 测量逻辑）。

现在（只有分支名）：

```text
┌─────────────────────────────────────────────┐
│  [⑂ main]                          [@ ⏎ 发送] │  ← 输入框工具栏
└─────────────────────────────────────────────┘
```

之后 · compact（空间不够时）：

```text
  [⑂ main •]
        └─ dirty 小圆点：有未提交改动时出现
```

之后 · expanded（空间够时，显示完整状态）：

```text
  [⑂ main • ↑2 ↓1  ⧉3]
     │   │  │   │   └─ stash 数量（3 个 stash）
     │   │  │   └───── behind：落后 upstream 1 个 commit
     │   │  └───────── ahead：领先 upstream 2 个 commit
     │   └──────────── dirty 点
     └──────────────── 分支名
```

几种特殊状态：

```text
  [⑂ main]            干净时没有 dirty 点
  [⑂ a1b2c3d ⚠]       detached HEAD：chip 变警告色，显示短 SHA
  [⑂ feature ↑2]      无 upstream 时不显示 ↓，只有 ahead
```

交互：

- 悬停 → tooltip 显示完整说明（如 `main · 3 个未提交改动 · 领先 2 / 落后 1`）。
- 点击 dirty 点 → 直接打开第二层的 Changes 弹窗。

### 第二层：Changes 弹窗

点 chip 或输入 `/diff` 打开。它是一个覆盖整个聊天区的浮层（与 `/status`、
`/settings` 同一种 `activePanel` 形态，约 70vh 可滚动）：

```text
┌─ Changes ───────────────────────────── vs HEAD ─ ✕ ┐
│                                                      │
│  4 files changed, +128 / -37                         │  ← 汇总 header
│                                                      │
│   +12  -3   src/services/foo.ts                      │  ← 文件行（点开前）
│   +88  -0   src/components/Bar.tsx        (new)      │
│     ~        assets/logo.png              (binary)   │
│   +28 -34   legacy/old.ts                 (deleted)  │
│                                                      │
│ ▼ src/services/foo.ts                                │  ← 点开后：行级 diff
│ ┌──────────────────────────────────────────────────┐ │
│ │  11   const config = load();                      │ │  ← 上下文行（灰）
│ │  12 - const timeout = 2000;                        │ │  ← 删除行（红底）
│ │  12 + const timeout = 5000;                        │ │  ← 新增行（绿底）
│ │  13 + const retries = 3;                           │ │
│ │  14   export { config, timeout };                  │ │
│ └──────────────────────────────────────────────────┘ │
│                                                      │
│   …and 2 more (showing first 50)                     │  ← 超上限时的截断提示
└──────────────────────────────────────────────────────┘
```

交互细节：

- 文件行默认折叠，只显示 `+A -R 路径` 和标记（`(new)` / `(binary)` /
  `(deleted)`）。
- 点文件行 → 按需拉该文件的 hunk 并展开（不一次性加载全部，省流量）。
- 行级 diff 用 Shiki 语法高亮（按扩展名识别语言），`+` / `-` 行分别绿 / 红底
  着色，与现有 markdown 代码块同一套高亮器。
- `(binary)` / `(new)` 文件不可展开（无 hunk），与 CLI `DiffDialog` 行为一致。
- 非 git 仓库 / merge 进行中 → 弹窗显示占位文案（如“当前不是 git 仓库，或正在
  merge / rebase”），不报错。

## 数据结构

### 第一层：enriched git status

扩展 `WorkspaceGitStatus`（daemon 端）与 `DaemonWorkspaceGitStatus`（SDK 端）。
新字段全部可选，`v` 升到 `2`，保证旧 daemon / 旧 client 互相兼容：

```ts
interface DaemonWorkspaceGitStatus {
  v: 1 | 2;
  workspaceCwd: string;
  branch: string | null;

  // —— v2 新增字段，全部可选 ——
  /** true 表示 detached HEAD（branch 此时为短 SHA）。 */
  detached?: boolean;
  /** 已暂存文件数（porcelain X 列非 '.'）。 */
  staged?: number;
  /** 已修改未暂存文件数（porcelain Y 列非 '.'）。 */
  unstaged?: number;
  /** 未跟踪文件数（'??'）。 */
  untracked?: number;
  /** 冲突（unmerged）文件数。 */
  conflicted?: number;
  /** 是否配置了 upstream。 */
  hasUpstream?: boolean;
  /** 领先 upstream 的 commit 数。 */
  ahead?: number;
  /** 落后 upstream 的 commit 数。 */
  behind?: number;
  /** stash 数量。 */
  stashCount?: number;
  /** 进行中的操作（merge/rebase/cherry-pick/revert/bisect）。 */
  operation?: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect';
  /** 重字段（dirty/ahead/behind/stash）的计算时间戳（epoch ms），用于新鲜度判断。 */
  computedAt?: number;
}
```

派生信号（前端计算，不进 wire format）：`dirty = staged + unstaged + untracked > 0`。

> **transient state 处理变更**：早期设计让 `getGitWorkingTreeStatus` 在
> merge/rebase 期间返回 `null`。Phase 1 决定把"进行中操作"显式 surfaced，因此
> 改为：transient 期间仍返回状态，并通过 `operation` 字段标记操作类型
> （`git status` 在这些状态下仍能正常输出）。返回 `null` 只保留给"非仓库 /
> git 失败"。`fetchGitDiff`（第二层）仍在 transient 时返回 null，二者语义不同。

### 第二层：diff payload

文件列表与单文件 hunk 分两个路由，避免一次性把多文件 diff（最坏
`MAX_FILES × MAX_DIFF_SIZE_BYTES`）塞进单个响应：

```ts
interface DaemonWorkspaceGitDiffFile {
  /** 仓库根相对路径，未净化，渲染前必须 sanitize。 */
  path: string;
  /** 二进制文件为 undefined。 */
  added?: number;
  removed?: number;
  isBinary: boolean;
  isUntracked: boolean;
  isDeleted: boolean;
  /** untracked 文本文件超过读取上限时为 true（added 为下界）。 */
  truncated: boolean;
}

interface DaemonWorkspaceGitDiff {
  v: 1;
  workspaceCwd: string;
  /** false 表示非仓库 / HEAD 缺失 / transient state，前端显示占位。 */
  available: boolean;
  filesCount: number;
  linesAdded: number;
  linesRemoved: number;
  files: DaemonWorkspaceGitDiffFile[];
  /** filesCount - files.length，per-file 上限截断时的剩余数。 */
  hiddenCount: number;
}

/** 与 `diff` 库的 Hunk 字段对齐，序列化后传输。 */
interface DaemonDiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[]; // 带 ' ' / '+' / '-' 前缀
}

interface DaemonWorkspaceGitDiffHunks {
  v: 1;
  workspaceCwd: string;
  path: string;
  available: boolean; // false: 该文件无 hunk（untracked / 无变化 / 越界）
  hunks: DaemonDiffHunk[];
}
```

`DaemonDiffHunk` 直接对应 core 的 `GitDiffHunk`（即 `diff` 库的 `Hunk`），
daemon 端只需把 `Map` 里对应文件的 hunk 数组序列化即可，前端不需要依赖 `diff`
库。

## 关键修改点

### 1. core：新增工作区状态与单文件 hunk

两个函数都放在 `packages/core/src/utils/gitDiff.ts`，以便直接复用该文件内已有
的 `findGitRoot`、`isInTransientGitState`（当前未导出）、`parseGitDiff` 等私有
/ 公有构件，避免跨文件暴露内部函数：

- `getGitWorkingTreeStatus(cwd): Promise<GitWorkingTreeStatus | null>`
  - 复用 `findGitRoot` 判断是否仓库；非仓库 / git 失败返回 `null`。transient
    state（merge/rebase/cherry-pick/…）期间仍返回状态，并通过 `operation`
    字段标记操作类型（见上方"transient state 处理变更"），故不调用
    `isInTransientGitState`。
  - 一次 `git --no-optional-locks status --porcelain=v1 --branch -z` 调用，
    解析 branch header（branch / detached / `...upstream` / `[ahead N, behind
M]`）和 porcelain 行（统计 staged / unstaged / untracked）。解析逻辑可参考
    `getRecentGitStatus` 已有的 branch header 处理。
  - stash 数量：优先直读 `<gitDir>/logs/refs/stash` 行数（与 `gitDirect.ts`
    的直读哲学一致，避免第二个子进程）；读不到则记 0。
  - detached 由 `readGitHead` 或 branch header（`HEAD (no branch)` /
    `No commits yet`）判定。
  - 返回结构对齐 `DaemonWorkspaceGitStatus` 的 v2 字段。
- `fetchGitDiffHunksForFile(cwd, filePath): Promise<Hunk[] | null>`
  - 执行 `git --no-optional-locks diff --no-ext-diff --no-textconv HEAD --
<filePath>`，复用 `parseGitDiff` 取该文件的 hunk 数组。
  - 与 `fetchGitDiffHunks` 一样传 `--no-ext-diff` / `--no-textconv`，避免
    `GIT_EXTERNAL_DIFF` / textconv 在只读路径上执行用户命令。
  - 单文件调用，天然受 `MAX_DIFF_SIZE_BYTES` 约束，响应体积可控。

两个函数都需要对 `filePath` 做校验：拒绝绝对路径、拒绝以 `/` 开头、拒绝包含
`..` 越界段的 path，确保只把它当作仓库根相对路径传给 git。

### 2. daemon：扩展 status + 新增 diff 路由

- `WorkspaceGitState.getStatus()`：在原有 `branch` 基础上调用
  `getGitWorkingTreeStatus`，合并出 enriched `WorkspaceGitStatus`（v2）。
  `branch` 仍走 `resolveBranchName` 的缓存 + `watchRepoBranch`；重字段
  （dirty/ahead/behind/stash）每次 `getStatus` 现算（调用频率受“刷新策略”
  约束，见下文），不长期缓存以免 stale。
- `routes/workspace-git.ts`：
  - `GET /workspace/git` / `GET /workspaces/:workspace/git` 返回 enriched 结果
    （路由签名不变，只是 payload 字段增多）。
  - 新增 `GET /workspace/git/diff` 与 `GET /workspace/git/diff/file?path=...`，
    以及对应的 qualified 版本 `/workspaces/:workspace/git/diff[/file]`，复用
    `requireTrustedWorkspaceRuntime` / `resolveWorkspaceRuntimeFromParam` 的
    trusted 校验。
  - diff 路由内部调用 `fetchGitDiff` / `fetchGitDiffHunksForFile`，把结果映射成
    `DaemonWorkspaceGitDiff` / `DaemonWorkspaceGitDiffHunks`。`path` 查询参数
    必须经过第 1 步的校验后才能传给 git。

### 3. SDK：类型 + client 方法 + 事件

- `DaemonWorkspaceGitStatus` 增加 v2 可选字段（如上）。
- 新增 `DaemonWorkspaceGitDiff` / `DaemonWorkspaceGitDiffFile` /
  `DaemonWorkspaceGitDiffHunks` / `DaemonDiffHunk` 类型，从
  `sdk-typescript/src/index.ts` 与 `src/daemon/index.ts` 导出。
- `DaemonClient` 新增：
  - `workspaceGitDiff(): Promise<DaemonWorkspaceGitDiff>`
  - `workspaceGitDiffFile(path: string): Promise<DaemonWorkspaceGitDiffHunks>`
    （`path` 作为 query 参数需 `urlEncode`，对齐现有 `workspaceMcpTools` 等
    方法的写法）。
- 事件：可选新增 `git_status_changed`（携带 enriched status）。本期更倾向于
  **不新增推送事件**，而是复用现有 `git_branch_changed` 作为“需要重新拉取
  status”的信号——见“刷新策略”。是否新增 `git_status_changed` 留作实施时权衡，
  默认不加以缩小 PR 面积。

### 4. webui：connection 状态

- 若采用“复用 `git_branch_changed` 触发重拉”方案：`mappers.ts` 无需改动，
  Web Shell 在收到 `connection.gitBranch` 变化时重新调用 `workspaceGit()`。
- 若后续新增 `git_status_changed`：在 `mappers.ts` 增加一个 case，写入
  `connection.gitStatus`（新增可选字段），并做与 `git_branch_changed` 相同的
  `workspaceCwd` 归属校验。

### 5. Web Shell：增强 chip + 新增 diff 弹窗

- `GitBranchIndicator` 扩展：
  - 入参从 `branch` 扩展为接收 enriched status（dirty / ahead / behind /
    stashCount / detached）。
  - compact 形态：branch 名 + dirty 小圆点（有任一变更时显示）。
  - expanded 形态：追加 `↑N`（ahead）`↓M`（behind）、stash 角标；detached 时
    chip 变色并显示短 SHA。
  - chip 可点击：dirty 时点击打开 `GitDiffDialog`；其余情况可打开一个轻量
    status popover（或直接复用 diff 弹窗的 header）。复用现有
    `useWebShellPortalRoot()` 挂载 popover，保留 `data-web-shell-git-branch`
    属性。
- 新增 `components/dialogs/GitDiffDialog.tsx`（+ `.module.css`），对齐
  `DaemonStatusDialog` 的形态：
  - 打开时调用 `workspaceGitDiff()` 拉文件列表 + 统计；展示 header
    （`N files changed, +A / -R`）和文件行（`+A -R 文件名`，binary / untracked /
    deleted 标记，复用 `diffCommand.ts` 的列布局语义）。
  - 点击文件行按需调用 `workspaceGitDiffFile(path)` 拉 hunk，展开为统一 diff
    （`+`/`-`/` ` 行着色），行内语法高亮复用 Shiki（按文件扩展名解析 language）。
  - 文件名渲染前必须 sanitize（参考 `sanitizeFilenameForDisplay` 的语义），
    防止 git 允许的原始控制字节 / 转义注入。
  - `available === false` 时显示占位文案（非仓库 / HEAD 缺失 / transient
    state），对齐 `diffCommand.ts` 的提示语义。
  - 通过 `activePanel` 机制注册（新增一个 panel 值，如 `'diff'`），复用现有
    打开 / 关闭 / 焦点管理逻辑。
- `/diff` 命令本地化：在 Web Shell 中把 `/diff` 从 ACP 透传改为本地实现——
  打开 `GitDiffDialog`（对齐 CLI 交互模式打开 `DiffDialog` 的行为）。在
  `App.tsx` 的命令分发处识别 `/diff` 并 `setActivePanel('diff')`，不再发给
  daemon。`getLocalCommands` 中补 `diff` 的补全项与 `local.diff` 文案。

### 6. 刷新策略（第一层的新鲜度）

- branch：保持现状，`watchRepoBranch` 经 `git_branch_changed` 实时推送，热路径
  直读，零额外成本。
- 重字段（dirty / ahead / behind / stash）在以下时机重新拉取
  `workspaceGit()`：
  1. 用户打开 status popover 或 `GitDiffDialog` 时（按需，权威）。
  2. 收到 `git_branch_changed`（commit / reset / 切分支都会同时改变这些值）。
  3. 标签页 `visibilitychange` 重新可见时。
  4. 仅对**当前选中 / 可见的 workspace**做一次低速轮询（如 30s，可配置），
     保证 dirty 点在编辑后“足够新”。**不**对所有 workspace 轮询。
- 明确取舍：不对工作区文件树建立 watcher，dirty 不会逐键实时刷新。这是为了
  避免昂贵的全树监听；对“编辑后立刻想看 dirty”的场景，focus / 轮询 / 打开弹窗
  都能覆盖。

### 7. i18n

新增文案需同时提供 en 与 zh-CN（`i18n.tsx`）：chip 的 dirty / ahead / behind /
stash / detached 的 aria-label 与 tooltip、`GitDiffDialog` 的 header / 列标记 /
占位文案、`local.diff` 补全描述。复用 `git.currentBranch` 既有 key 的命名风格。

## 兼容性

- 旧 daemon（v1）只返回 `{ v, workspaceCwd, branch }`：新 client 把缺失的 v2
  字段当作“未知”，chip 退化为当前的纯 branch 显示，不显示 dirty/ahead 等。
- 旧 client 读到 v2 payload：只认 `branch`，忽略多余字段，行为不变。
- 非 git 仓库 / detached / transient state：`getGitWorkingTreeStatus` 与
  `fetchGitDiff` 返回 null，前端显示占位或隐藏重字段，不报错。
- `git_branch_changed` 仍保留，不破坏现有 branch chip 链路。
- `/diff` 在非 Web Shell 客户端的纯文本输出不变（daemon `renderDiffModelText`
  路径不动）。
- diff payload 受 core 既有上限约束（`MAX_FILES` / `MAX_DIFF_SIZE_BYTES` /
  `MAX_LINES_PER_FILE`），大 diff 通过 `hiddenCount` 与单文件按需加载控制体积。

## 测试计划

### Unit tests

- `getGitWorkingTreeStatus`：clean / dirty（staged、unstaged、untracked 混合）/
  detached / 有 upstream 的 ahead-behind / 无 upstream / transient state /
  非仓库各分支；branch header 解析正确。
- `fetchGitDiffHunksForFile`：单文件有变化 / 无变化 / untracked 返回空 /
  非法 path（绝对路径、`..` 越界）被拒绝；`--no-ext-diff` / `--no-textconv`
  被传入。
- `WorkspaceGitState.getStatus`：返回 enriched 结构，branch 仍来自缓存、
  重字段来自 `getGitWorkingTreeStatus`。
- diff 路由：`GET /workspace/git/diff` 把 `fetchGitDiff` 结果映射为
  `DaemonWorkspaceGitDiff`；`.../diff/file` 校验 `path` 并映射 hunk；
  qualified 路由复用 trusted 校验（参考 `workspace-git.test.ts` 现有用例）。
- `DaemonClient.workspaceGitDiff` / `workspaceGitDiffFile`：正确拼接 URL、
  `path` 经过 `urlEncode`。
- `GitBranchIndicator`：dirty 点显示 / 隐藏；ahead-behind 渲染；detached 文案；
  compact / expanded 形态；可点击 aria。
- `GitDiffDialog`：文件列表渲染（binary / untracked / deleted 标记）；点击展开
  按需拉 hunk；`available === false` 占位；文件名 sanitize；hunk 行着色。
- `/diff` 本地化：`App.tsx` 收到 `/diff` 时 `setActivePanel('diff')` 而非透传
  daemon（参考 `App.test.tsx` 现有 panel 分支用例）。

### Integration / browser verification

- 在干净仓库 / 有改动仓库 / detached / 无 upstream 仓库下，chip 显示符合预期。
- 编辑文件后，focus 或打开弹窗时 dirty 点出现；commit 后 `git_branch_changed`
  触发 chip 更新。
- 打开 `GitDiffDialog`：文件列表正确，点击文件展开行级 diff，Shiki 高亮正常，
  大文件 / 多文件被上限截断时有 `hiddenCount` 提示。
- 非 git 目录下打开 `/diff` 显示占位文案而非报错。

## 风险和控制

- 风险：重字段每次 `getStatus` 现算会在多 workspace 下放大 `git status` 子进程
  成本。控制：只对当前可见 workspace 低速轮询，其余按需（打开弹窗 / focus）才
  拉取；branch 始终走直读，不进子进程。
- 风险：dirty 不实时（编辑后不逐键刷新）可能让用户困惑。控制：在 chip tooltip
  或 popover 注明“点击刷新 / 数据为最近一次快照”，并保证打开弹窗时取权威值。
- 风险：`path` 查询参数来自前端，可能构造越界路径。控制：daemon 与 core 两层
  都校验（拒绝绝对路径 / `..` 越界段），且最终由 git 限定在仓库内。
- 风险：git 允许的原始控制字节 / 转义进入文件名，造成渲染注入。控制：渲染前
  统一 sanitize，复用 `sanitizeFilenameForDisplay` 语义。
- 风险：跨包新增类型扩大 PR 面积。控制：diff hunk 用最小 `DaemonDiffHunk`
  结构，不让 SDK 反向依赖 `diff` 库或 Web Shell client 类型；默认不新增
  `git_status_changed` 事件以缩小改动面。
- 风险：Shiki 对部分语言 / 大文件高亮有性能成本。控制：仅对展开的单个文件做
  高亮，且受 `MAX_LINES_PER_FILE` 约束；流式无关，无需 debounce。

## Phase 1 详细实施计划（含进度）

**目标**：branch chip 从“只显示分支名”升级为实时状态条——显示 dirty /
ahead-behind / stash / detached / **operation**（merge/rebase/…）/ **conflicted**
（冲突数）。纯增量、只读、向后兼容；不动 branch 显示路径。

**数据流**：

```text
core getGitWorkingTreeStatus(cwd)
  → daemon WorkspaceGitState.getStatus()  (WorkspaceGitStatus v2)
  → GET /workspace/git  /  GET /workspaces/:workspace/git
  → SDK DaemonWorkspaceGitStatus  (DaemonClient.workspaceGit())
  → webui connection（git_branch_changed 仍驱动 branch；重字段走 REST）
  → Web Shell gitStatus 状态 → ChatEditor → GitBranchIndicator
```

**文件清单**：

| 操作 | 文件                                                                             | 说明                                                                                                                                                              |
| ---- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 修改 | `packages/core/src/utils/gitDiff.ts`                                             | `GitOperation` / `GitWorkingTreeStatus` / `getGitWorkingTreeStatus` / `parseStatusBranchLine` / `parseStatusEntries` / `detectGitOperation` / `countStashEntries` |
| 修改 | `packages/core/src/utils/gitDiff.test.ts`                                        | 解析单测 + 真实仓库集成测试                                                                                                                                       |
| 修改 | `packages/cli/src/serve/workspace-git-state.ts`                                  | `WorkspaceGitStatus` v2 + `getStatus` 合并 enriched                                                                                                               |
| 修改 | `packages/cli/src/serve/workspace-git-state.test.ts`                             | mock + v2 断言 + enriched/operation 用例                                                                                                                          |
| 修改 | `packages/sdk-typescript/src/daemon/...`（`DaemonWorkspaceGitStatus` 声明处）    | 加 v2 可选字段                                                                                                                                                    |
| 修改 | `packages/web-shell/client/components/GitBranchIndicator.tsx`（+ `.module.css`） | 渲染 dirty 点 / ↑N↓M / stash / detached / operation 徽标 / conflicted                                                                                             |
| 修改 | `packages/web-shell/client/components/ChatEditor.tsx`                            | 透传 enriched status                                                                                                                                              |
| 修改 | `packages/web-shell/client/App.tsx`                                              | `gitStatus` 状态 + 刷新策略                                                                                                                                       |
| 修改 | `packages/web-shell/client/i18n.tsx`                                             | en + zh-CN 文案                                                                                                                                                   |
| 修改 | `packages/web-shell/client/components/GitBranchIndicator.test.tsx`               | 各状态渲染用例                                                                                                                                                    |

### Task 1 · core ✅ 已完成

- [x] `GitOperation` 类型 + `GitWorkingTreeStatus`（含 `conflicted` / `operation`）
- [x] `getGitWorkingTreeStatus`：`git status --porcelain=v1 --branch -z` 一次调用
  - 直读 stash reflog + `detectGitOperation`；transient 不再返回 null
- [x] `parseStatusBranchLine` / `parseStatusEntries`（含 unmerged → conflicted）
- [x] 单测：解析 + clean/dirty/detached/stash/ahead-behind/非仓库/merge/rebase/
      cherry-pick（**79 个通过**）

### Task 2 · daemon ✅ 已完成

- [x] `WorkspaceGitStatus` 升级到 v2 + enriched 可选字段（dirty 部分）
- [x] `getStatus` 合并 `getGitWorkingTreeStatus`（branch 用 watcher 缓存，重字段
      每次现算）
- [x] 接口加 `operation?` / `conflicted?`；`getStatus` 透传这两个字段
- [x] 测试：enriched 输出用例补 `operation` / `conflicted`（**14 个通过**）

### Task 3 · SDK ✅ 已完成

- [x] `DaemonWorkspaceGitStatus` 加 v2 可选字段（`detached/staged/unstaged/
untracked/conflicted/hasUpstream/ahead/behind/stashCount/operation/
computedAt`），`v: 1 | 2`；新增 `DaemonGitOperation` 类型并从
      `src/index.ts` / `src/daemon/index.ts` 导出
- [x] `workspaceGit()` 无需改（返回更多字段即可）
- [x] SDK 类型单测（v1 mock）仍通过

### Task 4 · Web Shell ✅ 已完成

- [x] `GitBranchIndicator` 入参从 `branch` 扩展为接收 enriched status；渲染：
      dirty 点、`↑N`/`↓M`、stash 角标、detached 换图标、**operation 徽标**
      （`REBASING`/`MERGING`/…）、conflicted 数（**非颜色兜底**：形状+数字）
- [x] compact（图标角标）/ expanded 两种形态；保留 `data-web-shell-git-branch`
- [x] `App.tsx` 新增 `gitStatus` 状态，经 `workspaceGit()` 拉取；branch 仍用
      `connection.gitBranch`（SSE，实时）
- [x] 刷新策略（focus + branch 变化 + 仅当前 workspace 30s 可见性轮询）
- [x] `ChatEditor` 透传 enriched status 到 `GitBranchIndicator`
- [x] i18n（en + zh-CN）：aria-label / tooltip / operation 文案
- [x] `GitBranchIndicator.test.tsx` 补各状态用例（**8 个通过**）

**刷新策略**（第一层新鲜度）：

- branch：保持现状，`git_branch_changed`（reflog watch）实时推送。
- 重字段（dirty/ahead/behind/stash/operation/conflicted）在以下时机重拉
  `workspaceGit()`：① 打开 status popover / diff 弹窗；② 收到
  `git_branch_changed`；③ 标签页 `visibilitychange` 重新可见；④ 仅对**当前活跃
  workspace** 低速轮询（如 30s，可配置）。
- 不对工作区文件树建 watcher，dirty 不逐键实时（成本取舍）。

### Task 5 · 验证 ✅ 已完成

- [x] `npm run build && npm run typecheck`（全仓通过）
- [x] `npm run lint`（改动文件全过）
- [x] 单测：core 79 / cli 14 / sdk 1 / web-shell GitBranchIndicator 8 +
      ChatEditor&App 118
- [ ] 浏览器验收（留待 PR 前补）：干净 / dirty / detached / 无 upstream /
      rebase 中 各状态 chip 显示正确；focus / 打开弹窗后 dirty 点刷新

> Phase 1 已提交于分支 `feat/webshell-git-status-chip`。

---

## Phase 2 详细实施计划（含进度）

**目标**：新增只读的「Changes」弹窗——文件列表（工作区 vs HEAD）+ 点开按需
加载单文件行级 diff（Shiki 高亮）。`/diff` 从 ACP 透传改为本地打开该弹窗，
dirty chip 点击联动。纯增量、只读、向后兼容。

**数据流**：

```text
core fetchGitDiff(cwd) / fetchGitDiffHunksForFile(cwd, path)
  → daemon GET /workspace/git/diff  (列表 + 统计)
           GET /workspace/git/diff/file?path=  (单文件 hunk)
           （+ qualified /workspaces/:workspace/git/diff[/file]）
  → SDK DaemonWorkspaceGitDiff / DaemonWorkspaceGitDiffHunks
        + DaemonClient.workspaceGitDiff() / workspaceGitDiffFile(path)
  → Web Shell GitDiffDialog（列表 → 懒加载单文件 hunk → Shiki 高亮）
```

**调研修正（与早期草案的差异，重要）**：

- **daemon 是 express，不用 zod**：query 参数用手写助手 `requireStringQuery` /
  `parseIntInRange`（参考 `routes/workspace-file-read.ts`），不要引入 zod schema。
- **路径安全（实施修正：单文件 diff 路由不走 fs factory）**：早期草案要求
  `?path=` 经 `factory.forRequest(...).resolve(path, 'read')` 沙箱化。实施时
  发现 `'read'` 意图会拒绝**工作区已删除的文件**（ENOENT），而这类文件仍在
  HEAD 中、必须能 diff，故单文件 diff 路由**不**经 fs factory。改由四层纵深
  约束：(1) qualified 路由要求 trusted workspace；(2) core
  `fetchGitDiffHunksForFile` 把 path 规范化为 repo-relative，拒绝绝对路径 /
  盘符 / `..` 越界；(3) git 只在仓库内 diff，untracked 合成读取用
  `O_NOFOLLOW`，且仅对 `ls-files --others` 确认为 untracked 的路径执行；(4)
  路由只读。详见 `routes/workspace-git-diff.ts` 顶部注释。
- **读路由头**：复用 `applyReadHeaders(res)`（`no-store` + `nosniff`）。
- **错误**：git 业务用 `sendBridgeError`，trust/解析失败用 runtime 助手
  （已自动发响应）；缺 `path` query 返回 `400 parse_error`。
- **Shiki 已有封装**：复用 `components/messages/codeHighlighter.ts`
  （`getCodeHighlighter` / `highlightToHtmlSync` / `isTooLargeToHighlight`），
  不新接 highlighter。
- **`virtual-viewport` 在代码库中不存在**（早期文档引用的概念未落地）。大 diff
  靠 core 既有上限（`MAX_FILES=50` / `MAX_LINES_PER_FILE=400` /
  `MAX_DIFF_SIZE_BYTES=1MB`）+ **单文件懒加载**控制 DOM 规模；本期不引入虚拟
  滚动（400 行内 DOM 可承受），如后续需要再单独立项。
- **弹窗形态**：用 `components/ui/dialog`（Radix Dialog + `useWebShellPortalRoot`，
  对齐 `McpManagerPage`），`DialogContent` 覆盖 className 加宽；经
  `showGitDiffDialog` 状态标志开关并纳入 `dialogOpen` 聚合（`App.tsx:2739`）。
- **`/diff` 本地化**：当前 `/diff` 是 ACP/agent 命令（serve 无对应路由）。本期
  在 `App.tsx` 命令分发处拦截 `/diff` → 打开弹窗（不发给 daemon），并在
  `getLocalCommands` 补 `diff` 补全项（`local.diff` 文案已存在）。

**文件清单**：

| 操作 | 文件                                                                                | 说明                                                                 |
| ---- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 修改 | `packages/core/src/utils/gitDiff.ts`                                                | 新增 `fetchGitDiffHunksForFile(cwd, path)`（单文件 hunk）            |
| 修改 | `packages/core/src/utils/gitDiff.test.ts`                                           | 单文件 hunk 真实仓库用例                                             |
| 新增 | `packages/cli/src/serve/routes/workspace-git-diff.ts`                               | 两个 GET 路由（bound + qualified）                                   |
| 修改 | `packages/cli/src/serve/server.ts`                                                  | 注册新路由（import + 两处 register 调用）                            |
| 新增 | `packages/cli/src/serve/routes/workspace-git-diff.test.ts`                          | 路由单测（含 path 越界拒绝）                                         |
| 修改 | `packages/sdk-typescript/src/daemon/types.ts`                                       | `DaemonWorkspaceGitDiff` / `...File` / `...Hunks` / `DaemonDiffHunk` |
| 修改 | `packages/sdk-typescript/src/daemon/index.ts` + `src/index.ts`                      | 导出新类型                                                           |
| 修改 | `packages/sdk-typescript/src/daemon/DaemonClient.ts`                                | `workspaceGitDiff()` / `workspaceGitDiffFile(path)`                  |
| 新增 | `packages/web-shell/client/components/dialogs/GitDiffDialog.tsx`（+ `.module.css`） | 文件列表 + 单文件 hunk 渲染 + Shiki 高亮                             |
| 修改 | `packages/web-shell/client/components/GitBranchIndicator.tsx`                       | dirty chip 可点击（`onOpenDiff` 回调）                               |
| 修改 | `packages/web-shell/client/components/ChatEditor.tsx`                               | 透传 `onOpenGitDiff` 回调                                            |
| 修改 | `packages/web-shell/client/App.tsx`                                                 | `showGitDiffDialog` 状态 + 渲染弹窗 + `/diff` 本地拦截               |
| 修改 | `packages/web-shell/client/constants/localCommands.ts`                              | `diff` 补全项                                                        |
| 修改 | `packages/web-shell/client/i18n.tsx`                                                | 弹窗文案（en + zh-CN）                                               |
| 新增 | `packages/web-shell/client/components/dialogs/GitDiffDialog.test.tsx`               | 列表 / hunk / 占位 / 越界用例                                        |

### Task 1 · core ✅ 已完成

- [x] `fetchGitDiffHunksForFile(cwd, filePath): Promise<Hunk[] | null>`
  - `git --no-optional-locks diff --no-ext-diff --no-textconv HEAD -- <filePath>`，
    复用 `parseGitDiff` 取该文件 hunk 数组。
  - 与 `fetchGitDiffHunks` 一致传 `--no-ext-diff` / `--no-textconv`。
  - repo-relative 校验（`toRepoRelativePath`）：拒绝绝对路径 / 盘符 / `..`
    越界段（纵深防御）。
  - **untracked 全新增**（`synthesizeUntrackedHunk`）：`git diff HEAD` 无输出
    且 `ls-files --others` 确为 untracked 时，`O_NOFOLLOW` 读取文件内容合成单个
    全新增 hunk（受 `MAX_LINES_PER_FILE` / `MAX_DIFF_SIZE_BYTES` 约束；二进制
    按既有语义）。
  - 非仓库 / transient / 该文件无变化（且非 untracked）→ 返回 `null`。
- [x] 单测：真实仓库改动单文件、未改文件、**untracked 文件全新增**、越界 path
      （`gitDiff.test.ts` 共 88 用例通过）。

### Task 2 · daemon ✅ 已完成

- [x] 新建 `routes/workspace-git-diff.ts`，导出
      `registerWorkspaceGitDiffRoutes` + `registerWorkspaceQualifiedGitDiffRoutes`。
- [x] `GET /workspace/git/diff`：调 `fetchGitDiff` → 映射 `DaemonWorkspaceGitDiff`
      （files 列表 + 统计 + `hiddenCount`）；`available` 反映 null（非仓库/
      transient）。
- [x] `GET /workspace/git/diff/file?path=`：校验 `req.query['path']`（缺则
      `400 parse_error`）→ `fetchGitDiffHunksForFile` → 映射
      `DaemonWorkspaceGitDiffHunks`；`applyReadHeaders`；错误 `sendBridgeError`。
      **不经 fs factory**（`'read'` 意图会拒绝已删除文件），改由 trust gate +
      core repo-relative 规范化 + git 仓库内含 + `O_NOFOLLOW` + `ls-files`
      gate 四层约束（见「调研修正」与路由顶部注释）。
- [x] qualified 版本：`resolveWorkspaceRuntimeFromParam` +
      `requireTrustedWorkspaceRuntime`（仿 `workspace-git.ts` 的
      `resolveTrustedRuntime`）。
- [x] `server.ts`：import + 两处注册调用（紧邻 `registerWorkspaceGitRoutes`）。
- [x] 路由单测：列表、单文件、越界 path 拒绝、非仓库占位（8 用例通过）。

### Task 3 · SDK ✅ 已完成

- [x] `types.ts`：`DaemonWorkspaceGitDiffFile` / `DaemonWorkspaceGitDiff` /
      `DaemonDiffHunk` / `DaemonWorkspaceGitDiffHunks`（结构见「第二层 diff
      payload」）。
- [x] `daemon/index.ts` + `src/index.ts` 导出新类型。
- [x] `DaemonClient`：`workspaceGitDiff()` / `workspaceGitDiffFile(path)`
      （path 作为 query，`urlEncode`，对齐 `workspaceMcpTools` 写法）；
      bound 与 workspace-qualified 两个 client 类各加一对方法。
- [x] 浏览器 bundle 上限 160KB→165KB（`scripts/build.js`，含说明注释）。
      未加 client 方法单测：SDK 现有 `workspaceGit()` 亦无对应单测，遵循既有
      约定不补一次性测试；契约由 cli 路由单测 + typecheck + web-shell 消费侧
      测试覆盖。

### Task 4 · Web Shell ✅ 已完成

- [x] `GitDiffDialog.tsx`（+ `.module.css`）：
  - 打开时 `workspaceGitDiff()` 拉列表 + 统计；header `N files · +A / -R`。
  - 文件行：`+A -R 文件名`，binary / untracked / deleted 标记；文件名渲染前
    `sanitizeControlChars`（git 允许奇异字节）。
  - 点击文件行 `workspaceGitDiffFile(path)` 懒加载 hunk，展开统一 diff
    （`+`/`-`/` ` 行背景着色）；Shiki **per-side 精确高亮**（`codeToTokens`，
    language 由 `languageForPath` + `resolveFenceLanguage` 解析；复用
    `codeHighlighter.ts` 的懒加载与 `isTooLargeToHighlight` 降级）。
  - `available === false` / 空 diff / 错误 → 占位文案。
  - 用 `DialogShell`（内部走 `ui/dialog` + `useWebShellPortalRoot`），`size="xl"`
    - `allowFullscreen`；`showGitDiffDialog` 状态纳入 `dialogOpen` 聚合。
- [x] `GitBranchIndicator`：提供 `onOpenDiff` 时 chip 渲染为 `<button>`
      （否则保持只读 `<output>`）；保留 `data-web-shell-git-branch`，加
      `data-clickable`；新增 `gitBranchChipButton` 重置样式。
- [x] `ChatEditor`：透传 `onOpenGitDiff` 回调到 chip。
- [x] `App.tsx`：`showGitDiffDialog` 状态 + 渲染 `GitDiffDialog` + 纳入
      `dialogOpen`；`/diff` 命令分发处本地拦截打开弹窗（不发给 daemon）；
      chip 回调连通（仅当存在 active workspace cwd 时提供）。
- [x] `localCommands.ts`：`diff` 补全项（`local.diff` 文案已存在）。
- [x] i18n（en + zh-CN）：`gitDiff.*` header / 列标记 / 占位 / aria。
- [x] `GitDiffDialog.test.tsx`：列表渲染、点开 hunk、占位、untracked/binary
      标记（5 用例通过）；`GitBranchIndicator.test.tsx` 补可点击用例（9 用例）。

**Shiki 高亮策略（Phase 2 首版即做 per-side 精确高亮）**：对每个 hunk，分别构造
new 侧（context + added，按序）与 old 侧（context + removed，按序）的纯代码文本，
各自用 Shiki 高亮（language 按扩展名解析）；再遍历 hunk `lines` 维护 new/old 两个
游标，按行类型从对应侧取已高亮行回填——`+` 取 new 侧、`-` 取 old 侧、` ` 两侧
同内容取 new 侧。这样多行注释 / 字符串跨越增删边界也能正确着色。实施用
`getCodeHighlighter`（`codeHighlighter.ts`，异步懒加载语言 + 去重）取得 highlighter
后调 `codeToTokens` 取结构化 token，按行渲染为带 token 颜色的 `<span>`（避免解析
`codeToHtml` 输出）；`isTooLargeToHighlight` 或高亮失败时降级为纯文本。

**Untracked 文件（展开为全新增 diff）**：`git diff HEAD -- <path>` 不含 untracked。
core `fetchGitDiffHunksForFile` 在判定文件 untracked（`git diff` 无输出且文件确为
untracked）时，读取文件内容合成一个全新增 hunk
（`{ oldStart: 0, oldLines: 0, newStart: 1, newLines: N, lines: ['+'+行…] }`），
受 `MAX_LINES_PER_FILE` / `MAX_DIFF_SIZE_BYTES` 约束；二进制 / 超上限按既有语义
处理。前端 thus 能把 untracked 文件像普通新增文件一样展开行级 diff。

### Task 5 · 验证 ✅ 已完成（自动化部分）

- [x] `npm run typecheck`（全 package 通过；先 `npm run build` core+sdk 刷新
      dist，避免跨包 import 解析到旧 dist）。
- [x] `npm run lint`（改动文件 ESLint 干净）+ Prettier 格式化。
- [x] 单测：core `gitDiff.test.ts` 88 通过、cli `workspace-git-diff.test.ts`
      8 通过、web-shell `GitDiffDialog.test.tsx` 5 + `GitBranchIndicator.test.tsx`
      9 通过。
- [ ] 浏览器验收（待人工）：dirty 仓库打开弹窗 → 文件列表正确 → 点开单文件
      hunk 高亮正确 → `/diff` 打开同一弹窗 → 非仓库 / 空 diff 占位 → 越界 path
      被拒。

## Phase 2.5 · 侧栏 workspace git 下放（已实现）

**目标**：左侧 `WebShellSidebar` 每个 workspace 文件夹行显示一个 git 图标 +
状态点（dirty/冲突/进行中），分支名 + ahead/behind 收于 hover tooltip；点击
直接打开**该 workspace** 的 Changes 弹窗（复用 Phase 2 的 `GitDiffDialog`）。
多仓库 git 状态无需逐个切换即可一览。纯增量、只读、向后兼容。

**数据流**：

```text
WorkspaceSection（已用 client.workspaceByCwd(cwd) 拉 session）
  + workspaceGit()  → 文件夹行渲染 GitBranchIndicator（兄弟节点，compact 图标态）
  点击 chip → onOpenGitDiff(cwd) → App.setDiffWorkspaceCwd(cwd) → GitDiffDialog
```

**关键设计决策**：

- **数据获取在 `WorkspaceSection`**：复用 Phase 1 `workspaceGit()`；**仅 trusted**
  workspace 拉取（untrusted 走 qualified 路由 403，与现有语义一致）。刷新：
  mount + window focus + `reloadToken`（session 活动后）+ 仅可见时慢轮询（60s，
  比活跃 workspace 30s 更轻，属后台感知）。
  - **实现细化**：拉取还额外 gate 在 `onOpenGitDiff` 是否传入上（effect 与
    `loadGitStatus` 双重判断 `!onOpenGitDiff || !workspace.trusted`）。chip 是该
    状态的唯一消费者，未接入 diff handler 时（如未透传该 prop 的消费方）拉取纯属
    浪费，故直接跳过——既省一次请求，也避免给不完整的 mock 制造噪声。
- **复用 `GitBranchIndicator`，作为 header 按钮的「兄弟」**：文件夹行 `header`
  本身是 `<button>`，可点击 chip 也是 `<button>`，按钮不能嵌套（无效 HTML）。
  故 chip 放在 `headerRow` 内、`header` 按钮旁（与 `headerActions` 同级）。因是
  兄弟节点而非子节点，点 chip 不会冒泡到 `header` 按钮，无需 `stopPropagation`；
  点行其他处仍展开/折叠。复用 Phase 1 chip
  → 相同 tooltip / dirty 语义 / 点击行为，零重复逻辑。
  - **形态：compact 图标态（最终决策）**：经用户两轮调整定稿。最初用「非 compact
    显示分支名」，但窄侧栏（220–420px）下分支名既挤又常被截断；用户遂要求
    **只显示图标 + 状态点，分支名移到 hover**。`GitBranchIndicator` 的 `compact`
    形态恰为此而生（固定 28px、`gitBranchText` 由 CSS `display:none` 隐藏、
    右上角 `gitBranchBadgeDot` 按 tone 表达 dirty/冲突/进行中、tooltip 仍显示
    分支名 + ahead/behind），故直接传 `compact`，无需新增 prop。脏/干净仍一眼
    可见，分支名 hover 可得，活跃 workspace 的分支另由工具栏 chip 显示。
  - **左对齐挨着名称**：chip 默认会被 `header` 按钮（`flex-grow`）挤到行最右。
    改为「有 chip 时让 pill 占据余宽、`header` 不撑」——
    `.headerRow:has(.gitPill) .header { flex-grow: 0 }` + `.gitPill { flex: 1 1
auto }`，图标即紧贴名称、hover 操作仍贴右缘；无 chip 时 `header` 照旧撑满
    （操作按钮仍右对齐）。chip 自身是 28px 定宽，pill 仅用余宽把操作推到右缘，
    图标与操作间的空白透明、非交互，静止态视觉干净。
- **弹窗状态重构（统一两入口）**：App 由 `showGitDiffDialog: boolean` + 派生
  cwd 改为 `diffWorkspaceCwd: string | undefined`（有值 = 打开）。工具栏 chip
  → `openGitDiff(活跃 cwd)`；侧栏 chip → `openGitDiff(该 cwd)`。同一弹窗、
  同一 handler；`dialogOpen` 聚合改判 `diffWorkspaceCwd !== undefined`。
- **trust 兜底**：untrusted workspace 不显示 git pill。

**文件清单**：

| 操作 | 文件                                                                       | 说明                                                                                                     |
| ---- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 修改 | `packages/web-shell/client/components/sidebar/WorkspaceSection.tsx`        | 拉 git 状态 + header 行渲染 `GitBranchIndicator`（兄弟）+ `onOpenGitDiff` prop                           |
| 修改 | `packages/web-shell/client/components/sidebar/WorkspaceSection.module.css` | git pill 在 `headerRow` 的布局（间距 / 收缩）                                                            |
| 修改 | `packages/web-shell/client/components/sidebar/WebShellSidebar.tsx`         | 新增 `onOpenGitDiff` prop，透传给每个 `WorkspaceSection`                                                 |
| 修改 | `packages/web-shell/client/App.tsx`                                        | `showGitDiffDialog`→`diffWorkspaceCwd` 重构；传 `onOpenGitDiff` 给 sidebar；工具栏 chip 改用同一 handler |
| 未改 | `packages/web-shell/client/i18n.tsx`                                       | 复用既有 `git.*` 键，无需新增                                                                            |
| 新增 | `packages/web-shell/client/components/sidebar/WorkspaceSection.test.tsx`   | git pill 渲染 + 点击回调 + untrusted/非仓库/无 handler 不显示                                            |

**任务拆解**（全部完成 ✅）：

1. ✅ `WorkspaceSection`：trusted 时拉 `workspaceGit()`（mount/focus/reloadToken/
   慢轮询）+ header 行渲染 `GitBranchIndicator`（兄弟，`onOpenDiff` 回调）。
2. ✅ App 弹窗状态重构 `diffWorkspaceCwd` + 两入口统一（工具栏 + 侧栏）。
3. ✅ prop 透传 App → `WebShellSidebar` → `WorkspaceSection`。
4. ✅ i18n 复用 `git.*`（无需新键）+ 新增 `WorkspaceSection.test.tsx`（4 例：
   chip 渲染/点击、untrusted 不显示且不请求、非仓库 null branch 不显示、无
   handler 不显示）。
5. ✅ 验证：typecheck / lint / Prettier / 单测全绿。
   - 浏览器人工验收待补。

## 实施顺序

1. core：新增 `getGitWorkingTreeStatus` 与 `fetchGitDiffHunksForFile`，补单测。
2. daemon：扩展 `WorkspaceGitState.getStatus` 输出 enriched status；新增
   `GET /workspace/git/diff` 与 `.../diff/file`（+ qualified 版本）路由与单测。
3. SDK：扩展 `DaemonWorkspaceGitStatus`，新增 diff 类型与
   `workspaceGitDiff` / `workspaceGitDiffFile` 方法。
4. Web Shell 第一层：扩展 `GitBranchIndicator` 显示 dirty / ahead-behind /
   stash / detached，接入 `workspaceGit()` 与刷新策略。
5. Web Shell 第二层：新增 `GitDiffDialog`，`/diff` 本地化打开弹窗，dirty chip
   点击联动。
6. i18n 文案补齐（en + zh-CN）。
7. 浏览器验收 + 单测全绿。

## PR 描述要点

- 动机：Web Shell 当前 git 集成只有 branch chip + `/diff` 纯文本，图形界面
  应提供更好的状态感知与 diff review 体验；这对“review agent 改了什么”尤其关键。
- 范围：只做只读的状态感知（第一层）与可视化 diff（第二层）；提交 / 分支 /
  GitHub / 远程同步均为后续增量。
- 复用：完全基于 core 已有的 `fetchGitDiff` / `fetchGitDiffHunks` /
  `resolveBranchName` 等能力，不重写 git 解析。
- 兼容：v2 字段全部可选，旧 daemon / 旧 client 互相兼容；非仓库 / detached /
  transient state 优雅降级。
- 取舍：dirty 不逐键实时刷新，是有意的成本取舍（避免全树 watcher），通过
  focus / 打开弹窗 / 低速轮询保证“足够新”。
