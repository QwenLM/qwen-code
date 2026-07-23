# Web Shell 新建会话 Git 模式选择

## 背景

日常开发中，用户新建会话时有三种 Git 工作流：

1. **当前分支** — 直接在当前分支上开发（默认行为）
2. **Worktree 隔离** — 创建独立 worktree + 分支，主目录不受影响
3. **新建分支** — 在同一工作目录创建并切换到新分支

场景 1 和 2 已有完整支持（场景 2 见
[2026-07-19-webshell-worktree-sessions.md](./2026-07-19-webshell-worktree-sessions.md)
和
[2026-07-20-worktree-empty-state-toggle.md](./2026-07-20-worktree-empty-state-toggle.md)）。
场景 3 缺失——用户想"开个新分支做这个任务"时，只能先手动 `git checkout -b`
再建会话，或者被迫使用 worktree（引入不必要的目录隔离）。

## 目标

- 在聊天空状态提供统一的 **Git 模式选择器**，覆盖三种场景。
- "新建分支"模式：daemon 在 `POST /session` 时自动 `git checkout -b`，
  session 直接在新分支上启动。
- 复用现有 worktree 创建链路，不改变 worktree 行为。
- 向后兼容：不传新参数时行为完全不变。

## 非目标

- 不支持 checkout 已有分支（v1 只做新建；已有分支切换可后续增量）。
- 不做会话结束时自动切回原分支（避免丢失用户状态）。
- 不做 merge-back UI。
- 不改变 `enter_worktree` / `exit_worktree` 工具行为。

## 设计

### 空状态 UI：Composer 内的 Git Chip

模式选择器不做成独立区块，而是**内嵌到 composer 底部工具栏**——复用
现有 git chip 的位置（输入框下方、发送按钮左侧）。chip 默认显示当前
分支 `⎇ main`，点击弹出 popover 选择模式：

```text
┌─ composer ───────────────────────────────────────────┐
│  描述你的任务…                                        │
│                                                      │
│  📎  @  🎙              [⎇ main ▾]  [发送]           │
└──────────────────────────────────────────────────────┘
                              │ 点击
                              ▼
              ┌─ Git 模式 popover ─────────────┐
              │  ● 当前分支   直接在 main 上    │
              │  ○ 新建分支   从 main 创建      │
              │    [分支名输入框 — 选中时展开]   │
              │  ○ Worktree   独立副本，可并行   │
              │  ─────────────────────────────  │
              │  $ git checkout -b feat/x ← main│
              │                    [创建分支]    │
              └─────────────────────────────────┘
```

- **当前分支**（默认）：chip 显示 `⎇ main`（绿色），等同于现有行为。
  选中后 popover 自动关闭。
- **新建分支**：popover 内展开分支名输入框 + 并发提示，实时校验
  （合法 git 分支名、不与现有分支冲突）。确认后 chip 变为
  `⎇ → feat/xxx`（橙色），带 ✕ 可一键恢复默认。
- **Worktree 隔离**：显示自动生成的 slug 预览。确认后 chip 变为
  `⎇ worktree 隔离`（紫色），带 ✕ 可一键恢复默认。

popover 底部实时预览将执行的 git 命令（`git checkout -b …` /
`git worktree add …`），让用户明确知道会发生什么。

chip 方案的优势：不占用 welcome 区垂直空间；入口在用户注意力所在的
composer 内；非空状态（已有会话）下 chip 依然可见，语义一致。

可见性条件与现有 worktree toggle 一致：workspace 已信任 + 是 git 仓库。
不满足时 chip 退化为只读分支指示器（现有行为）。

#### 状态机

将 `pendingWorktreeRef` / `worktreePending` 扩展为统一的 pending 意图：

```typescript
type SessionGitIntent =
  | { mode: 'current' }
  | { mode: 'branch'; name: string }
  | { mode: 'worktree'; slug?: string };
```

- 选择"当前分支"→ `{ mode: 'current' }`（等同于 `undefined`，不传参）。
- 选择"新建分支"→ `{ mode: 'branch', name }`。
- 选择"Worktree"→ `{ mode: 'worktree', slug? }`（复用现有逻辑）。
- 发送首条消息 → `ensureSessionForPrompt` 根据 intent 携带对应参数。
- 创建成功后清除 intent；失败保留供重试。

### API 变化

#### `CreateSessionRequest`（SDK）

```typescript
export interface CreateSessionRequest {
  // ... existing fields ...
  worktree?: { slug?: string };
  /**
   * Create a new git branch and check it out before starting the
   * session. The session runs in the same working directory but on
   * the new branch. Mutually exclusive with `worktree`.
   */
  branch?: { name: string };
}
```

`branch` 与 `worktree` 互斥，同时传入返回 400。

#### `DaemonSession` / `DaemonSessionSummary` 响应

```typescript
export interface DaemonBranchInfo {
  name: string; // 新建的分支名
  baseBranch: string; // 创建时的基础分支
}

export interface DaemonSession {
  // ... existing fields ...
  worktree?: DaemonWorktreeInfo;
  branch?: DaemonBranchInfo;
}
```

#### `POST /session` 路由处理（`routes/session.ts`）

在现有 worktree 处理逻辑之前，增加 branch 处理：

```text
1. 校验 branch / worktree 互斥
2. 校验 branch.name 是合法 git 分支名
3. 检查分支名不与现有分支冲突（git rev-parse --verify）
4. 检测 dirty tree（git status --porcelain），有改动则 409 branch_dirty_tree
5. 记录 baseBranch = 当前分支（git rev-parse --abbrev-ref HEAD）
6. git checkout -b <name>
7. branchMeta = { name, baseBranch }
8. 强制 sessionScope = 'thread'
9. 正常 spawnOrAttach（cwd 不变）
10. 失败回滚：git checkout <baseBranch> && git branch -D <name>
```

不需要 `changeSessionCwd`（工作目录不变），不需要 worktree marker。

#### 错误码

| 错误码                         | 含义                                       |
| ------------------------------ | ------------------------------------------ |
| `branch_and_worktree_conflict` | 同时传了 `branch` 和 `worktree`            |
| `branch_not_git_repo`          | workspace 不是 git 仓库                    |
| `branch_invalid_name`          | 分支名不合法                               |
| `branch_already_exists`        | 分支名已存在                               |
| `branch_dirty_tree`            | 工作目录有未提交改动，需先 commit 或 stash |
| `branch_checkout_failed`       | `git checkout -b` 失败（其他原因）         |

### 前端传参链路

```text
App.tsx (gitIntent state)
  → sessionPreparation.ts createAndAttachSessionForPrompt({ branch })
    → actions.ts createSession({ branch })
      → DaemonClient.createOrAttachSession({ branch })
        → POST /session { branch: { name } }
```

与 worktree 链路完全对称，每层增加 `branch` 透传。

### Sidebar 展示

- Worktree session：现有 `GitForkIcon` badge，不变。
- Branch session：显示 `GitBranchIcon` + 分支名 badge。
- 普通 session：无 badge，不变。

### 并发限制

同一 workspace 的"新建分支"session 会改变共享工作目录的 HEAD，多个
branch session 会互相冲突。限制策略：

- **服务端**：`POST /session` 带 `branch` 时，检查同一 workspace 是否已有
  活跃的 branch session（通过 bridge 的 session 列表 + `branchMeta`）。
  如有，返回 409 `branch_session_conflict`。
- **前端**：空状态选择"新建分支"时，如已有活跃 branch session，显示提示
  并禁用。

Worktree session 不受此限制（各自独立目录）。

### 文件改动

| 文件                                                               | 改动                                                                      |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `packages/sdk-typescript/src/daemon/DaemonClient.ts`               | `CreateSessionRequest` 增加 `branch` 字段                                 |
| `packages/sdk-typescript/src/daemon/types.ts`                      | `DaemonBranchInfo`、`DaemonSession.branch`、`DaemonSessionSummary.branch` |
| `packages/cli/src/serve/routes/session.ts`                         | `POST /session` branch 创建逻辑 + 回滚                                    |
| `packages/webui/src/daemon/session/actions.ts`                     | `createSession` 透传 `branch`                                             |
| `packages/webui/src/daemon/session/types.ts`                       | `createSession` 签名增加 `branch`                                         |
| `packages/web-shell/client/App.tsx`                                | `SessionGitIntent` 状态机、模式选择器 UI、并发检查                        |
| `packages/web-shell/client/App.module.css`                         | 选择器样式                                                                |
| `packages/web-shell/client/utils/sessionPreparation.ts`            | 透传 `branch`                                                             |
| `packages/web-shell/client/i18n.tsx`                               | 新增 i18n keys（en/zh）                                                   |
| `packages/web-shell/client/components/sidebar/WebShellSidebar.tsx` | branch session badge                                                      |

### i18n

| Key                              | EN                                                     | ZH                                       |
| -------------------------------- | ------------------------------------------------------ | ---------------------------------------- |
| `gitMode.current`                | `Current branch`                                       | `当前分支`                               |
| `gitMode.branch`                 | `New branch`                                           | `新建分支`                               |
| `gitMode.worktree`               | `Worktree`                                             | `Worktree 隔离`                          |
| `gitMode.branch.placeholder`     | `Branch name`                                          | `分支名`                                 |
| `gitMode.branch.hint`            | `Switches the working directory to a new branch`       | `在工作目录中切换到新分支`               |
| `gitMode.branch.conflictWarning` | `Only one branch session per workspace at a time`      | `同一 workspace 同时只能有一个分支会话`  |
| `gitMode.branch.invalidName`     | `Invalid branch name`                                  | `分支名不合法`                           |
| `gitMode.branch.exists`          | `Branch already exists`                                | `分支已存在`                             |
| `gitMode.branch.dirtyTree`       | `Uncommitted changes detected. Commit or stash first.` | `检测到未提交改动，请先 commit 或 stash` |

## 已决问题

1. **分支名默认值**：不自动生成，由用户输入。输入框留空 + placeholder
   提示（如 `feat/my-feature`），减少预设。
2. **dirty working tree**：服务端在 `git checkout -b` 前检测 dirty 状态
   （`git status --porcelain`）。如有未提交改动，返回 409
   `branch_dirty_tree`，前端提示用户先 commit 或 stash 后再创建分支会话。
   不在 UI 层预检测（避免与 git 实际行为脱节），统一由服务端判定。
3. **会话恢复（resume）**：不需要 sidecar。Worktree 需要 sidecar 是因为
   工作目录与主仓库分离，resume 时必须知道 worktree 路径。Branch 会话的
   工作目录就是原目录，`git branch` 即可知当前分支，无需额外记录。
   注意：`DaemonSessionSummary.branch` 目前仅保存在内存中（bridge 映射），
   daemon 重启后会丢失，因此 sidebar badge 与并发守卫不会跨重启保留；
   持久化属于后续工作。
