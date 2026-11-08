# Web Shell worktree 隔离会话

## 背景

当前 Web Shell 的一个 workspace 同一时间只能有效地跑一个任务：所有 session
共享同一个 working tree，agent 的文件编辑、`git add`、`git checkout` 等操作
直接作用于主目录。如果用户想同时推进两个独立任务（比如"修 bug A"和"实现
feature B"），两个 session 会互相踩踏——一个改了 `foo.ts`，另一个也在改
`foo.ts`，结果不可预测。

CLI 侧已有 worktree 基础设施：

- `enter_worktree` / `exit_worktree` 工具：agent 可以在会话中手动创建和退出
  worktree，但这是 **tool 级别** 的——需要 agent 自己调用，且 worktree 内的
  cwd 切换靠 model 记住路径前缀，不是真正的进程级 cwd 切换。
- `GitWorktreeService`（`packages/core/src/services/gitWorktreeService.ts`）：
  成熟的 worktree 生命周期管理——创建（`createUserWorktree`）、slug 生成与
  校验、分支命名（`worktree-<slug>`）、session marker、symlink 目录、清理
  （`removeWorktree`）、启动时孤儿扫描（`cleanupStaleAgentWorktrees`）。
- agent 工具的 `isolation: "worktree"`：子 agent 可以在隔离 worktree 中运行，
  结果通过 branch 返回。

但这些都是 **会话内** 或 **子 agent** 级别的。用户想要的是：**创建 session
时自动隔离**——点"新建会话"，session 直接在自己的 worktree 里工作，主目录
干净，多个 session 可以真正并行。

## 目标

- 创建 session 时可选"worktree 隔离"：daemon 自动创建 git worktree，CLI
  子进程直接以 worktree 路径为 cwd 启动。
- 同一 workspace 的多个 worktree session 可以真正并行，互不干扰。
- 主目录保持干净——agent 的所有文件操作发生在 worktree 里。
- 复用 `GitWorktreeService` 已有能力，不重新实现 worktree 管理。
- session 列表和 git chip 能区分 worktree session 和普通 session。
- worktree 生命周期与 session 绑定：session 结束时提示清理或保留。
- 向后兼容：不传 worktree 参数时行为完全不变。

## 非目标

- 不做 merge-back UI（worktree 的改动合回主分支）。agent 可以在终端里做
  `git merge` / `git rebase`，UI 层面的合并工作流属于后续增量。
- 不做 worktree 之间的文件对比或冲突解决。
- 不改变 `enter_worktree` / `exit_worktree` 工具的行为——它们继续作为会话内
  的手动 worktree 管理工具。
- 不在非 git 仓库下提供 worktree 隔离（worktree 是 git 概念）。
- 不做 worktree 的远程同步（push/pull）。

## 现状链路

### session 创建

```text
Web Shell UI (createSession)
  → SDK DaemonClient.createSession({ workspaceCwd, ... })
  → POST /session  (routes/session.ts)
  → resolveRuntimeForSessionCreation(body)
      → workspaceRegistry 解析 workspace runtime
  → bridge.spawnOrAttach({ workspaceCwd, ... })
  → spawnChannel: spawn(cliEntry, { cwd: workspaceCwd })
      → CLI 子进程以 workspaceCwd 为 cwd 启动
```

关键约束：`workspaceCwd` 必须是 `workspaceRegistry` 中已注册的 workspace。
worktree 路径（如 `<repo>/.qwen/worktrees/my-task/`）不在注册表中，不能
直接作为 `workspaceCwd` 传入。

### worktree 基础设施

- `GitWorktreeService.createUserWorktree(slug, baseBranch?, opts?)`：
  创建 worktree + 分支 `worktree-<slug>`，返回 `{ success, worktree: { path, branch } }`。
- worktree 存放路径：`<repoRoot>/.qwen/worktrees/<slug>/`。
- `writeWorktreeSessionMarker(path, sessionId)`：写入 `.qwen-session` 标记。
- `GitWorktreeService.removeWorktree(slug)`：清理 worktree + 分支。
- `GitWorktreeService.cleanupStaleAgentWorktrees()`：启动时清理孤儿 worktree。
- `WorktreeSession` sidecar（`worktreeSessionService.ts`）：已有
  `{ slug, worktreePath, worktreeBranch, originalCwd, originalBranch,
originalHeadCommit }` 结构，存于 `<chatsDir>/<sessionId>.worktree.json`，
  用于 `--resume` 恢复上下文。可直接复用。
- `cleanupStaleAgentWorktrees`（`worktreeCleanup.ts`）：30 天孤儿扫描，
  但只清理 `agent-{7hex}` slug，用户命名的 worktree 不会被自动清理。
- `Config.relocateWorkingDirectory(newDir)`：运行时切换 cwd 的方法
  （ACP 模式跳过 `process.chdir`），可作为备选路径但不如 `initialCwd`
  直接。

### git 状态绑定

- `WorkspaceGitState`（daemon）：每个 workspace 一个 entry，用
  `watchRepoBranch(workspaceCwd)` 监听 branch 变化。
- Web Shell 的 git chip / `/diff` 绑定的是 **workspace cwd**，不是 session
  的实际 cwd。agent cd 进 worktree 后，chip 仍显示主目录的状态。

## 方案

### 核心思路

在 `POST /session` 增加可选的 `worktree` 参数。daemon 在 spawn 子进程之前
创建 worktree，然后把子进程的 cwd 设为 worktree 路径（而非 workspace cwd）。
workspace 注册和 runtime 解析仍走主目录，worktree 只影响子进程的实际工作目录。

> **为什么不用 `--worktree` CLI 参数？** CLI 已有 `--worktree` 启动参数
> （`worktreeStartup.ts`），但它在 ACP 模式下被显式拒绝（`gemini.tsx:623`：
> "--worktree cannot be combined with --acp"），因为 ACP host 自己管理
> per-session cwd。错误信息建议"Pass the worktree path as the cwd of the
> ACP loadSession / newSession request instead"——正是本方案的做法。

```text
POST /session { cwd: "/repo", worktree: { slug?: "my-task" } }
  │
  ├─ resolveRuntimeForSessionCreation  (仍用 /repo 解析 runtime)
  │
  ├─ 创建 worktree
  │   GitWorktreeService("/repo").createUserWorktree("my-task", currentBranch)
  │   → /repo/.qwen/worktrees/my-task/  (branch: worktree-my-task)
  │
  ├─ bridge.spawnOrAttach({
  │     workspaceCwd: "/repo",          ← workspace 注册 / runtime 解析
  │     initialCwd: "/repo/.qwen/worktrees/my-task/",  ← 子进程实际 cwd
  │     worktree: { slug, path, branch }               ← session 元数据
  │   })
  │
  └─ CLI 子进程以 worktree 路径为 cwd 启动
      → 所有文件操作、git 命令自然发生在 worktree 里
```

### 数据流变更

```text
SDK CreateSessionRequest
  + worktree?: { slug?: string }     [新增]

BridgeSpawnRequest
  + initialCwd?: string              [新增] 子进程实际 cwd
  + worktree?: {                     [新增] worktree 元数据
      slug: string;
      path: string;
      branch: string;
    }

BridgeSession
  + worktree?: { slug, path, branch }  [新增] 返回给调用方

DaemonSessionSummary (SSE / REST)
  + worktree?: { slug, path, branch }  [新增] session 列表可展示

spawnChannel
  spawn(cliEntry, { cwd: initialCwd ?? workspaceCwd })  [改动]
```

### daemon 侧

#### `POST /session` 路由扩展

```ts
// routes/session.ts
app.post('/session', mutate(), async (req, res) => {
  const body = safeBody(req);
  const resolvedRuntime = resolveRuntimeForSessionCreation(body, res);
  if (!resolvedRuntime) return;
  const { runtime, workspaceCwd } = resolvedRuntime;

  // —— 新增：worktree 创建 ——
  let worktreeMeta: { slug: string; path: string; branch: string } | undefined;
  let initialCwd: string | undefined;

  if (body['worktree'] && typeof body['worktree'] === 'object') {
    const wtReq = body['worktree'] as { slug?: string };
    const service = new GitWorktreeService(workspaceCwd);

    // 前置检查：必须是 git 仓库
    if (!(await service.isGitRepository())) {
      res.status(400).json({
        error: 'Worktree isolation requires a git repository',
        code: 'worktree_not_git_repo',
      });
      return;
    }

    const slug = wtReq.slug ?? GitWorktreeService.generateAutoSlug();
    const validation = GitWorktreeService.validateUserWorktreeSlug(slug);
    if (validation) {
      res
        .status(400)
        .json({ error: validation, code: 'worktree_invalid_slug' });
      return;
    }

    const baseBranch = await service.getCurrentBranch().catch(() => undefined);
    const result = await service.createUserWorktree(slug, baseBranch);
    if (!result.success || !result.worktree) {
      res.status(500).json({
        error: result.error ?? 'Failed to create worktree',
        code: 'worktree_create_failed',
      });
      return;
    }

    worktreeMeta = {
      slug,
      path: result.worktree.path,
      branch: result.worktree.branch,
    };
    initialCwd = result.worktree.path;
  }

  const session = await runtime.bridge.spawnOrAttach({
    workspaceCwd,
    ...(initialCwd ? { initialCwd } : {}),
    ...(worktreeMeta ? { worktree: worktreeMeta } : {}),
    // ... 其余参数不变
  });

  // worktree session 写入 session marker
  if (worktreeMeta) {
    await writeWorktreeSessionMarker(
      worktreeMeta.path,
      session.sessionId,
    ).catch(() => {});
  }

  res.json({ ...session });
});
```

#### spawnChannel 改动

```ts
// acp-bridge/src/spawnChannel.ts
// 现有：cwd: workspaceCwd
// 改为：cwd: initialCwd ?? workspaceCwd
const child = spawn(process.execPath, [...args], {
  cwd: initialCwd ?? workspaceCwd,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: childEnv,
});
```

#### worktree 清理

session 结束时（`session_ended` 事件或 bridge 的 `onExit` 回调），检查
session 是否有 worktree 元数据：

- 有未提交改动 → 保留 worktree，在 session 摘要中标记
  `worktree.cleanupNeeded: true`，Web Shell 提示用户。
- 无改动 → 自动清理（`removeWorktree`）。
- 用户也可以显式保留（后续 UI 支持）。

清理逻辑放在 bridge 的 session 退出回调中，不在路由层。

### SDK 侧

```ts
// DaemonClient.ts
export interface CreateSessionRequest {
  // ... 现有字段
  /** 创建 worktree 隔离会话。slug 可选，不传则自动生成。 */
  worktree?: { slug?: string };
}

// DaemonSessionSummary (session 列表 / SSE 事件)
export interface DaemonSessionSummary {
  // ... 现有字段
  worktree?: {
    slug: string;
    path: string;
    branch: string;
    /** true 表示 session 已结束但 worktree 有未提交改动，需用户处理。 */
    cleanupNeeded?: boolean;
  };
}
```

### Web Shell 侧

#### 新建会话 UI

Web Shell 的 session 创建是**懒加载**的：点"新建会话"只清前端状态
（`clearSession`），daemon session 在第一次提交 prompt 时才创建
（`ensureSessionForPrompt` → `createAndAttachSessionForPrompt` →
`sessionActions.createSession`）。worktree 参数需要穿透这条路径：
`createNewSession` 时记住"下一个 session 要 worktree 隔离"，
`ensureSessionForPrompt` 时把 `worktree` 参数传给 `createSession`。

在"新建会话"按钮旁增加 worktree 选项。两种形态：

**最小方案（推荐先做）**：新建会话时，如果当前 workspace 是 git 仓库，
在会话创建请求中自动带 `worktree: {}`（自动 slug）。用户无需额外操作，
每个新 session 天然隔离。

**可选方案**：在"新建会话"按钮旁加一个下拉/开关，让用户选择"普通会话"
或"worktree 隔离会话"。适合不想每次都隔离的用户。

先做最小方案，通过 settings 或 workspace 级开关控制是否默认启用。

#### session 列表

worktree session 在会话列表中显示分支标记：

```text
┌─────────────────────────────────────────┐
│ 💬 Fix login bug                        │  ← 普通 session
│    main                                 │
├─────────────────────────────────────────┤
│ 💬 Add dark mode  ⑂ worktree-dark-mode  │  ← worktree session
│    worktree-dark-mode                   │
└─────────────────────────────────────────┘
```

#### git chip

worktree session 的 git chip 显示 worktree 分支名，git status 跟随
session 的实际 cwd（worktree 路径）而非 workspace cwd。

实现：`App.tsx` 中 `workspaceGit()` 的调用改为使用 session 的
`worktree.path`（如果有）作为 cwd 参数。

> **已有基础**：daemon 已有 `POST /session/:id/cd` 路由和
> `session_cwd_changed` 事件（`bridge.changeSessionCwd`），但 Web Shell
> 的 mappers 未消费该事件。worktree session 不需要走 cd 路由（子进程直接
> 以 worktree 为 cwd 启动），但 git 状态刷新需要知道 session 的实际 cwd。
> 最简做法：session 创建响应中返回 `worktree.path`，Web Shell 用它替代
> `connection.workspaceCwd` 来拉取 git 状态。

#### `/diff`

worktree session 中 `/diff` 显示 worktree 内的 diff，不是主目录的。
`diffWorkspaceCwd` 改为从 session 的实际 cwd 取值。

### 刷新策略

worktree session 的 git 状态刷新与普通 session 一致（focus / branch 变化 /
30s 轮询），只是 cwd 指向 worktree 路径。`watchRepoBranch` 对 worktree
同样有效（worktree 共享 `.git` 目录，reflog 变化会触发 watch）。

## 兼容性

- **旧 daemon + 新 client**：client 传 `worktree` 参数，旧 daemon 忽略
  未知字段，创建普通 session。行为退化但不报错。
- **新 daemon + 旧 client**：不传 `worktree`，行为完全不变。
- **非 git 仓库**：传 `worktree` 时返回 `400 worktree_not_git_repo`，
  client 应捕获并提示用户。
- **worktree 创建失败**（磁盘满、权限、分支冲突）：返回 `500`，session
  不创建，client 提示错误。
- **session 异常退出**（daemon 崩溃、kill -9）：worktree 残留在
  `.qwen/worktrees/` 下。已有的 `cleanupStaleAgentWorktrees` 在 daemon 重启时
  清理无 session marker 的孤儿 worktree。

## 关键修改点

| 操作 | 文件                                                  | 说明                                                       |
| ---- | ----------------------------------------------------- | ---------------------------------------------------------- |
| 修改 | `packages/acp-bridge/src/bridgeTypes.ts`              | `BridgeSpawnRequest` 加 `initialCwd` / `worktree`          |
| 修改 | `packages/acp-bridge/src/spawnChannel.ts`             | spawn cwd 改为 `initialCwd ?? workspaceCwd`                |
| 修改 | `packages/cli/src/serve/routes/session.ts`            | `POST /session` 处理 worktree 创建                         |
| 修改 | `packages/sdk-typescript/src/daemon/DaemonClient.ts`  | `CreateSessionRequest` 加 `worktree`                       |
| 修改 | `packages/sdk-typescript/src/daemon/types.ts`         | `DaemonSessionSummary` 加 `worktree`                       |
| 修改 | `packages/web-shell/client/App.tsx`                   | `createSession` 传 worktree 参数；git 状态跟随 session cwd |
| 修改 | `packages/web-shell/client/components/ChatEditor.tsx` | git chip 使用 session 实际 cwd                             |
| 修改 | session 列表组件                                      | 显示 worktree 分支标记                                     |

## 测试计划

### Unit tests

- `POST /session` + `worktree`：创建成功返回 worktree 元数据；非 git 仓库
  返回 400；无效 slug 返回 400；创建失败返回 500。
- `spawnChannel`：`initialCwd` 传入时子进程 cwd 为 worktree 路径；不传时
  仍为 workspaceCwd。
- `GitWorktreeService.createUserWorktree`：已有充分测试，不需新增。
- SDK `createSession({ worktree })`：正确序列化参数。
- Web Shell `createSession`：worktree 参数透传。

### Integration / browser verification

- 创建 worktree session → agent 在 worktree 里工作 → 主目录无变化。
- 同时创建两个 worktree session → 各自独立，互不影响。
- session 结束 → 无改动时 worktree 自动清理；有改动时保留并提示。
- git chip 显示 worktree 分支名和状态。
- `/diff` 显示 worktree 内的 diff。
- 非 git 仓库下创建 worktree session → 友好错误提示。
- daemon 重启 → 孤儿 worktree 被 sweep 清理。

## 风险和控制

- **风险**：worktree 创建增加 session 启动延迟（~100-500ms，取决于仓库
  大小）。**控制**：`git worktree add` 是轻量操作（不复制文件，只创建
  目录和 `.git` 文件），对大仓库也很快。如果成为瓶颈，可以异步创建并
  让 session 先启动、后切换。

- **风险**：worktree 残留占用磁盘。**控制**：session 正常退出时自动清理；
  异常退出靠 `cleanupStaleAgentWorktrees` 兜底；Web Shell 可展示残留 worktree
  列表供手动清理（后续增量）。

- **风险**：worktree 内的 branch 与主目录 branch 冲突（同一 branch 不能
  同时被两个 worktree checkout）。**控制**：`createUserWorktree` 总是创建
  新分支 `worktree-<slug>`，不会 checkout 已有分支。

- **风险**：用户在 worktree session 里做的改动"找不到"（不知道在哪个
  worktree 里）。**控制**：session 列表显示 worktree 分支名和路径；
  session 摘要包含 worktree 元数据。

- **风险**：`sessionScope: 'single'` 下同一 workspace 的第二次
  `POST /session` 会 attach 到已有 session 而非创建新的，worktree 参数
  被忽略。**控制**：worktree session 强制 `sessionScope: 'thread'`，
  确保每次调用创建独立 session。

## 实施分步

### Phase 1：daemon + SDK（核心链路）

1. `BridgeSpawnRequest` 加 `initialCwd` / `worktree` 字段。
2. `spawnChannel` 支持 `initialCwd`。
3. `POST /session` 处理 worktree 创建。
4. SDK `CreateSessionRequest` 加 `worktree`。
5. session 摘要返回 worktree 元数据。
6. 单测。

### Phase 2：Web Shell UI

1. `createSession` 传 worktree 参数。
2. git chip / `/diff` 跟随 session 实际 cwd。
3. session 列表显示 worktree 标记。
4. 浏览器验收。

### Phase 3：生命周期管理（后续增量）

1. session 结束时 worktree 清理策略。
2. 残留 worktree 列表和手动清理 UI。
3. worktree session 的 merge-back 辅助（agent 侧）。
