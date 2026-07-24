# Web Shell git chip 快速显示：branch 先行 + status 缓存/推送

日期：2026-07-24
状态：待确认

## 背景与问题

Web Shell 新建会话时，composer 工具条里的 git chip 出现得慢。根因（已逐行确认）：

1. **daemon 端 branch 被 `git status` 子进程拖住**——`WorkspaceGitState.getStatus()`
   （`packages/cli/src/serve/workspace-git-state.ts`）里 branch 有毫秒级快路径
   （`resolveBranchName` 读 `HEAD` 文件 + reflog watcher），但 HTTP 响应必须等
   `getGitWorkingTreeStatus()` 完成——每次请求同步 spawn
   `git status --porcelain=v1 --branch -z`（`gitDiff.ts` runGit，5s 超时，零缓存）。
2. **前端 chip 渲染被全量 status 门控**——新建会话时 chip 文本只认
   `selectedWorkspaceGitStatus?.branch`（App.tsx 7860–7871），它要等整个
   HTTP + git status 往返（App.tsx 1480–1520 的 effect）才 setState。
3. **同一路由并发打两次**——`DaemonSessionProvider` 的 metadata 拉取
   （`DaemonSessionProvider.tsx:1320`，只用 `.branch`）与 App.tsx 的 git-status
   effect 几乎同时发 `GET /workspaces/:ws/git`，daemon 端 spawn 两个相同子进程。
4. 串行门控：`activeWorkspaceCwd` 依赖 `GET /capabilities` 先完成。

## 目标与非目标

目标：

- 新建会话 / 首屏时 git chip 以 branch 文本**立即出现**（一个本地 HTTP RTT，毫秒级），
  dirty/ahead/behind/stash 等计数器在 daemon 算完即补齐（`wait: true` fresh 请求；
  有会话时另有 SSE 实时推送）。
- 消除重复 `git status` 子进程（并发去重 + stale-while-revalidate）。
- 不回归：侧栏 workspace chip（要计数器）、worktree 会话 chip、detached HEAD、
  非 git workspace、git 失败降级。

非目标：

- worktree `?cwd=` 路径不引入 watcher/缓存（维持现状：直接计算，避免每 worktree
  泄漏一个 fs watcher）。worktree chip 延迟不变。
- 不做 daemon 启动预热（capabilities 后前端立即就会来请求，预热收益小）。
- 不改 `git_branch_changed` 现有语义。

## 方案总览

三层改动：daemon 缓存 + 后台刷新 + SSE 推送（P0），响应两阶段化（P1），
前端消费 SSE 并保留慢路径给需要的调用方（P2 重评估后见下文）。

### P0+P1：daemon——`WorkspaceGitState` 缓存、去重、后台刷新、SSE 推送

`WorkspaceGitEntry` 扩展：

```ts
interface WorkspaceGitEntry {
  branch: string | undefined; // watcher 保持新鲜（现状）
  dispose: () => void; // 现状
  status?: GitWorkingTreeStatus; // 上次计算的原始 working-tree summary
  statusComputedAt?: number; // epoch ms
  statusPromise?: Promise<void>; // in-flight 去重
  disposed?: boolean; // dispose 后禁止 publish
}
```

`getStatus(cwd, bridge, opts?: { wait?: boolean })` 语义改为：

- **默认（fast path）**：确保 entry 存在（branch 秒回）；按
  stale-while-revalidate 踢一次后台刷新（见下）；**立即返回**上次缓存的
  status（materialize：overlay `entry.branch ?? status.branch`，v2 形状 +
  `computedAt`）；从未计算过时返回 branch-only `{ v, workspaceCwd, branch }`
  （无 `computedAt`，前端据此区分"未计算"与"clean"）。
- **`wait: true`**：等待（或发起并等待，in-flight 复用）一次新鲜计算，
  返回全量 status。计算失败降级 branch-only（现状语义）。

后台刷新 `refreshStatus(entry)`：

- in-flight 复用：`statusPromise` 存在则直接返回它。
- 节流：距上次发起 < 2s 则跳过（防 focus 风暴串行排队 git 子进程）。
- 计算成功且与缓存的 enriched 字段有差异 → 更新缓存 + 通过
  `bridge.publishWorkspaceEvent({ type: 'git_status_changed', data })` 推送
  materialized 全量 status（data 即 `DaemonWorkspaceGitStatus`，含 workspaceCwd）。
  首次计算（缓存为空）视为有差异，必推送——这是冷启动 chip 补齐计数器的通道。
- 无差异 → 只更新缓存，不推送（避免 30s 轮询每次都引起前端 setState/re-render）。
- 计算失败/非 git 目录 → 保留旧缓存，不推送。
- entry 已 disposed → 不推送。

**无 TTL**。last-known + 每次 GET 触发后台刷新 + SSE 纠偏已足够；
节流 2s 承担" TTL 防爆"职责。`wait: true` 调用方总是拿到新鲜计算（in-flight 复用）。

路由（`packages/cli/src/serve/routes/workspace-git.ts`）：

- `/workspace/git` 与 `/workspaces/:workspace/git` 解析 `?wait=1`，透传给
  `getStatus`。默认 fast。
- worktree `?cwd=` 分支维持现状（直接 `getGitWorkingTreeStatus`，不进缓存）。

### SDK（`packages/sdk-typescript`）

- `events.ts`：`DAEMON_KNOWN_EVENT_TYPE_VALUES` 增加 `'git_status_changed'`
  （紧跟 `'git_branch_changed'`）。旧 SDK 经 `asKnownDaemonEvent` 静默丢弃——
  向后兼容，无需协议 bump（与 `followup_suggestion` 同模式）。
- `ui/normalizer.ts`：`case 'git_status_changed': return [];`（与
  `git_branch_changed` 一样由 session mappers 处理，不进 UI 归一化流）。
- `DaemonClient.workspaceGit` 签名改为 options 对象：
  `workspaceGit(opts?: { cwd?: string; wait?: boolean })`，拼 query
  （`cwd` 与 `wait=1` 可组合）。迁移全部 4 个调用点（App.tsx、WorkspaceSection、
  DaemonSessionProvider ×2 处）与 SDK 单测。

### webui（`packages/webui`）

- `session/types.ts`：`DaemonConnectionState` 增加
  `gitStatus?: DaemonWorkspaceGitStatus`（仅当前 workspace 的全量 status，
  由 SSE 维护）。
- `session/mappers.ts`：`updateConnectionFromDaemonEvent` 增加
  `case 'git_status_changed'`——`data.workspaceCwd` 与
  `current.workspaceCwd` 不匹配则忽略（镜像 `git_branch_changed` 的守卫），
  否则 `setConnection({ ...current, gitStatus: data })`。

### web-shell（`packages/web-shell`）

- `App.tsx` git-status effect：composer 用**客户端 stale-while-revalidate**——
  每次触发并发两个请求（worktree 会话除外，见下）：
  1. `workspaceGit({ cwd: sessionWorktree?.path })`（fast）：last-known 秒回，
     立即渲染（冷缓存 branch-only）；
  2. `workspaceGit({ wait: true })`（fresh）：daemon 后台算完即返回全量 status，
     补齐计数器。两个请求在 daemon 端共享同一次计算（in-flight 去重），
     不增加 git 子进程数。
- **为什么 fresh 请求必须存在（反向审计发现）**：SSE `git_status_changed` 走
  每会话事件流（`GET /session/:id/events`），**新建会话态（deferred connect，
  无 sessionId）没有 SSE 订阅**——只发 fast GET 时计数器要等 30s 轮询或
  focus 才补上。fresh 请求不依赖会话存在，保证"branch 立即、计数器算完即得"
  在所有会话态成立。（`git_branch_changed` 今天就有同样的无会话盲区，非回归。）
- `App.tsx` 另保留 SSE 同步 effect：`connection.gitStatus` 变化且
  `workspaceCwd` 匹配、无 `sessionWorktree` 时写入 `selectedWorkspaceGitStatus`——
  覆盖**有会话时**两次轮询之间的实时推送（另一客户端/CLI 触发的后台刷新
  推送过来）。
- worktree 会话只发 fast 请求：`?cwd=` 路径本就绕过缓存直接计算
  （fast 与 wait 等价），行为不变。
- `sidebar/WorkspaceSection.tsx`：`workspaceGit({ wait: true })`——侧栏 chip
  要计数器且没有 SSE/fresh 双发通道，保留阻塞语义（现状行为不变；非活跃
  workspace 没有 SSE 通道）。

### P2 重评估（按价值裁剪）

原 P2（前端去重：provider 首拉存全量 status 给 App 复用）**降格为不做**：
P0 的 daemon 端 in-flight 去重已消除重复 `git status` 子进程（原问题的实质），
剩下的只是一次毫秒级本地 HTTP 往返。把全量 status 存进 provider 再让 App
复用会引入跨层耦合（provider→App 初始值协议），收益约等于零。
provider 两处 `workspaceGit()` 调用只取 `.branch`，走默认 fast path 即可，零改动。

## 兼容性

- 路由响应形状不变（v2，enriched 字段本就 optional）；新增 `?wait=1` query 为可选。
- 默认 fast path 语义变化：调用方可能收到 last-known（旧缓存）而非新鲜计算。
  全部现存调用方逐一核对：
  - `DaemonSessionProvider`（×2）：只读 `.branch`——branch 始终新鲜（watcher），无影响。
  - App.tsx composer chip：正是本设计的服务对象。
  - WorkspaceSection：显式改 `wait: true`，语义不变。
- 新 SSE 事件旧客户端静默丢弃（SDK known-list 机制）。
- `git status_changed` 仅 publish 给该 workspace 的 session SSE bus
  （`publishWorkspaceEvent` 现有机制，含多 workspace 隔离）。

## 风险与缓解

| 风险                                            | 缓解                                                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| chip 先显示 branch 后出现计数器，工具条宽度抖动 | 已有隐藏测量副本（ChatEditor toolbar-measure）处理 re-measure；接受轻微 shift                    |
| branch-only 响应被误读为 "clean"                | branch-only 不携带 `computedAt`；GitBranchIndicator 现有逻辑在 `computedAt` 缺失时不显示 "clean" |
| 缓存 status 与 watcher branch 不一致            | materialize 时 overlay `entry.branch ?? status.branch`（现状逻辑保留）                           |
| 后台刷新泄漏（dispose 后 publish）              | `disposed` flag 守卫                                                                             |
| focus 风暴触发串行 git spawn                    | 2s 节流 + in-flight 复用                                                                         |

## 测试计划

单测：

- `workspace-git-state.test.ts`（扩展）：fast path 立即返回 last-known；
  冷缓存返回 branch-only 且无 `computedAt`；后台刷新有差异才 publish
  `git_status_changed`；首次计算必 publish；并发 getStatus 只触发一次
  `getGitWorkingTreeStatus`；2s 节流；`wait: true` 等待新鲜计算；
  计算失败保留旧缓存不 publish；dispose 后不 publish。
- `routes/workspace-git.test.ts`（扩展）：`?wait=1` 透传；worktree `?cwd=`
  路径不进缓存（维持直接计算）。
- SDK `DaemonClient.test.ts`：options 对象 query 拼接（cwd / wait / 组合）。
- webui `mappers.test.ts`：`git_status_changed` 匹配/不匹配 workspaceCwd
  两种分支。

E2E（`.qwen/e2e-tests/2026-07-24-git-chip-fast-branch.md`，验证阶段补）：
真 daemon + web shell，大工作区新建会话——chip（branch）在编辑器就绪后立刻出现，
计数器随后补齐；侧栏 chip 行为不变；focus/30s 轮询仍刷新；worktree 会话 chip 不变。

## 被否决的备选

- **TTL 缓存（无后台刷新/SSE）**：只能加速重复请求，冷启动仍需等 git status——
  不解决"新建会话 chip 慢"的主诉。
- **capabilities 后 daemon 预热**：首 GET 与预热几乎同时，in-flight 去重后收益≈0。
- **前端只做去重/合并请求**：不消除 git status 子进程等待，治标。
