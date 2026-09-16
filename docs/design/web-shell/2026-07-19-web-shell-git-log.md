# Web Shell Git 提交历史浏览器

## 背景

`2026-07-16-webshell-git-status-diff.md` 落地了 branch chip 增强（dirty /
ahead-behind / stash / detached / operation）和可视化 diff 查看器
（`GitDiffDialog`）。这两项解决了"工作区当前状态"的感知问题。

但用户还有另一个高频需求：**查看提交历史**。目前要看最近做了什么，只能在 chat
里让 agent 跑 `git log --oneline`，然后读一段纯文本。对于一个图形界面来说，
这是明显的体验缺口——提交历史是代码审查、回溯变更、理解项目演进的基础视图。

本期目标：新增一个只读的 Git Log 浏览器，以紧凑列表展示提交记录，点击展开
查看完整 message 和文件变更统计。复用现有 `DialogShell` / SDK / 路由模式，
不引入写操作。

## 目标

- 提供 `/log` 斜杠命令和 UI 入口，打开提交历史浏览器。
- 紧凑列表：短 SHA、subject、作者、相对时间、ref 标签（branch/tag）。
- 点击展开：完整 commit message body + 文件变更统计（numstat）。
- 分页加载（Load more），不一次性拉取全部历史。
- 复用现有架构模式：core git 工具 → daemon 路由 → SDK → Web Shell 组件。
- 只读，不引入任何写操作。

## 非目标

- 不做提交图谱（graph / DAG 可视化）。
- 不做分支筛选 / 搜索（留作后续增量）。
- 不做任意 commit 间的 diff 查看（留作后续增量，可复用 diff 基础设施）。
- 不做 commit 详情中的行级 diff（文件统计足够，行级 diff 是后续增量）。
- 不做 blame / annotate。
- 不改变 agent 侧的 git 行为。

## 方案概述

```text
core (gitDiff.ts 扩展)
  ├─ fetchGitLog(cwd, { limit, skip })     [新增] 提交列表
  └─ fetchGitCommitDetail(cwd, sha)        [新增] 单 commit 详情（message + numstat）
        │
        ▼
daemon (serve)
  ├─ GET /workspace/git/log?limit=&skip=   [新增]
  ├─ GET /workspace/git/log/commit?sha=    [新增]
  └─ qualified 版本 /workspaces/:workspace/git/log[/commit]
        │
        ▼
SDK (DaemonClient + types)
  ├─ DaemonGitLogEntry / DaemonGitLog      [新增]
  ├─ DaemonGitCommitDetail                 [新增]
  ├─ workspaceGitLog(limit?, skip?)        [新增]
  └─ workspaceGitCommitDetail(sha)         [新增]
        │
        ▼
Web Shell (client)
  ├─ GitDialog.tsx                         [新增] Changes / History 统一容器
  ├─ GitLogDialog.tsx (+ .module.css)      [新增] 提交列表 + 展开详情
  ├─ App.tsx                               [扩展] /log 命令拦截 + dialog view 状态
  └─ i18n.tsx                              [扩展] gitLog.* 文案
```

## UI 草图

`/log` 或 Git chip 打开统一的 `GitDialog`。使用
`DialogShell size="xl" allowFullscreen`，在同一个 dialog 内切换 Changes / History：

```text
┌─ History ───────────────────────── 50 commits ─ ✕ ┐
│                                                      │
│  a1b2c3d  feat(cli): add --json flag        2h ago  │
│           wenshao                                   │
│                                                      │
│  e4f5g6h  fix(core): handle null config     5h ago  │
│           dev · HEAD -> main, v1.2.0                │
│                                                      │
│ ▼ 789abcd  refactor: simplify parser        1d ago  │
│   ┌──────────────────────────────────────────────┐  │
│   │  Broke the monolithic parse() into smaller   │  │
│   │  functions for readability.                  │  │
│   │                                              │  │
│   │  3 files · +45 −12                           │  │
│   │   +30 −8   src/parser.ts                     │  │
│   │   +10 −2   src/utils.ts                      │  │
│   │   +5  −2   test/parser.test.ts               │  │
│   └──────────────────────────────────────────────┘  │
│                                                      │
│  c0ffee1  chore: bump deps                   3d ago  │
│           bot                                       │
│                                                      │
│              [ Load more ]                            │
└──────────────────────────────────────────────────────┘
```

交互：

- 列表按时间倒序（最新在前），默认加载 50 条。
- 每条显示：短 SHA（monospace）、subject（单行截断）、作者名、相对时间。
- 有 ref（branch/tag）时在 subject 行末或下方显示标签。
- merge commit 显示 `⎇` 图标区分。
- 点击展开 → 按需拉取 commit 详情（完整 body + numstat），再次点击折叠。
- "Load more" 按钮加载下一页（skip += limit），追加到列表末尾。
- 非 git 仓库 / 空仓库（无 commit）→ 占位文案。
- 加载失败 → 错误占位文案。

## 数据结构

### Core 层

```ts
// packages/core/src/utils/gitDiff.ts 新增

export interface GitLogEntry {
  sha: string; // 完整 40 字符 SHA
  shortSha: string; // 短 SHA（git 默认缩写）
  authorName: string;
  authorEmail: string;
  authorDate: number; // unix timestamp（秒）
  subject: string;
  refs: string; // %D 输出，如 "HEAD -> main, origin/main, v1.2.0"
  parents: string[]; // parent SHA 列表（length > 1 表示 merge commit）
}

export interface GitLogResult {
  entries: GitLogEntry[];
  hasMore: boolean; // 是否还有更多提交
}

export interface GitCommitFileStat {
  path: string;
  added: number; // 二进制文件为 0
  removed: number;
  isBinary: boolean;
}

export interface GitCommitDetail {
  sha: string;
  shortSha: string;
  authorName: string;
  authorEmail: string;
  authorDate: number;
  subject: string;
  body: string; // 完整 message body（可能为空）
  refs: string;
  parents: string[];
  files: GitCommitFileStat[];
  filesCount: number;
  linesAdded: number;
  linesRemoved: number;
  hiddenCount: number; // 超出 MAX_FILES 的文件数
}
```

### SDK 层（wire format）

```ts
// packages/sdk-typescript/src/daemon/types.ts 新增

export interface DaemonGitLogEntry {
  sha: string;
  shortSha: string;
  authorName: string;
  authorEmail: string;
  authorDate: number;
  subject: string;
  refs?: string;
  parents: string[];
}

export interface DaemonGitLog {
  v: 1;
  workspaceCwd: string;
  available: boolean;
  entries: DaemonGitLogEntry[];
  hasMore: boolean;
}

export interface DaemonGitCommitFileStat {
  path: string;
  added: number;
  removed: number;
  isBinary: boolean;
}

export interface DaemonGitCommitDetail {
  v: 1;
  workspaceCwd: string;
  available: boolean;
  sha: string;
  shortSha: string;
  authorName: string;
  authorEmail: string;
  authorDate: number;
  subject: string;
  body: string;
  refs?: string;
  parents: string[];
  files: DaemonGitCommitFileStat[];
  filesCount: number;
  linesAdded: number;
  linesRemoved: number;
  hiddenCount: number;
}
```

## 关键修改点

### 1. core：新增 `fetchGitLog` 和 `fetchGitCommitDetail`

放在 `packages/core/src/utils/gitDiff.ts`，复用已有的 `runGit` 内部函数和
上限常量。

#### `fetchGitLog(cwd, { limit = 50, skip = 0 }): Promise<GitLogResult | null>`

- 执行：
  ```
  git --no-optional-locks log -z
    --format='%H%x00%h%x00%an%x00%ae%x00%at%x00%s%x00%D%x00%P'
    -n <limit+1> --skip=<skip>
  ```
  - `\x00`（NUL）分隔字段，`-z` 用 NUL 终止每条记录。
  - Git commit message 不允许 NUL，因此 subject 中的其他控制字符不会与协议冲突。
  - 请求 `limit + 1` 条来判断 `hasMore`，返回时截断到 `limit`。
  - `--no-optional-locks` 避免写锁。
- 解析：按 NUL 切分后，每 8 个字段组成一条记录。
- 非仓库 / git 失败返回 `null`。
- 空仓库（无 commit）返回 `{ entries: [], hasMore: false }`。
- `limit` 上限 200，超出截断到 200。

#### `fetchGitCommitDetail(cwd, sha): Promise<GitCommitDetail | null>`

- 校验 `sha`：必须匹配 `/^[0-9a-f]{7,40}$/i`（防止注入）。
- 两次 git 调用：
  1. 元数据：
     ```
     git --no-optional-locks log -1 -z
       --format='%H%x00%h%x00%an%x00%ae%x00%at%x00%s%x00%D%x00%P%x00%b'
       <sha>
     ```
  2. 文件统计：
     ```
     git --no-optional-locks diff-tree --no-commit-id --numstat -r -z <sha>
     ```
     对 root commit（无 parent）使用 `--root`。
- numstat 解析复用 `parseGitNumstat` 的逻辑（或提取共享函数），受
  `MAX_FILES` 上限约束。
- 非仓库 / sha 不存在 / git 失败返回 `null`。

### 2. daemon：新增 log 路由

新增 `packages/cli/src/serve/routes/workspace-git-log.ts`，遵循
`workspace-git-diff.ts` 的双注册模式：

```ts
export function registerWorkspaceGitLogRoutes(app, deps: {
  boundWorkspace: string;
  sendBridgeError: SendBridgeError;
}): void {
  app.get('/workspace/git/log', ...);
  app.get('/workspace/git/log/commit', ...);
}

export function registerWorkspaceQualifiedGitLogRoutes(app, deps: {
  workspaceRegistry: WorkspaceRegistry;
  sendBridgeError: SendBridgeError;
}): void {
  app.get('/workspaces/:workspace/git/log', ...);
  app.get('/workspaces/:workspace/git/log/commit', ...);
}
```

- `GET /workspace/git/log?limit=50&skip=0`：
  - 解析 `limit`（默认 50，max 200）和 `skip`（默认 0）查询参数。
  - 调用 `fetchGitLog(workspaceCwd, { limit, skip })`。
  - 返回 `DaemonGitLog`（`v: 1`，`available` 标记）。
  - `applyReadHeaders(res)` + `sendBridgeError` 错误处理。

- `GET /workspace/git/log/commit?sha=<sha>`：
  - 校验 `sha` 格式。
  - 调用 `fetchGitCommitDetail(workspaceCwd, sha)`。
  - 返回 `DaemonGitCommitDetail`。

- qualified 路由复用 `resolveWorkspaceRuntimeFromParam` +
  `requireTrustedWorkspaceRuntime` 信任校验。

在 `server.ts` 中注册（参照 diff 路由的注册位置）。

### 3. SDK：类型 + client 方法

- `types.ts`：新增上述 `DaemonGitLogEntry` / `DaemonGitLog` /
  `DaemonGitCommitFileStat` / `DaemonGitCommitDetail` 类型，从
  `src/index.ts` 和 `src/daemon/index.ts` 导出。

- `DaemonClient`（主 client + workspace-qualified client）新增：

  ```ts
  async workspaceGitLog(limit?: number, skip?: number): Promise<DaemonGitLog> {
    const params = new URLSearchParams();
    if (limit != null) params.set('limit', String(limit));
    if (skip != null) params.set('skip', String(skip));
    const qs = params.toString();
    return await this.jsonRequest<DaemonGitLog>(
      `/workspace/git/log${qs ? `?${qs}` : ''}`,
      'GET /workspace/git/log',
      { mode: 'rest' },
    );
  }

  async workspaceGitCommitDetail(sha: string): Promise<DaemonGitCommitDetail> {
    return await this.jsonRequest<DaemonGitCommitDetail>(
      `/workspace/git/log/commit?sha=${urlEncode(sha)}`,
      'GET /workspace/git/log/commit',
      { mode: 'rest' },
    );
  }
  ```

### 4. Web Shell：GitLogDialog 组件

新增 `packages/web-shell/client/components/dialogs/GitLogDialog.tsx` +
`GitLogDialog.module.css`。

**Props**（与 GitDiffDialog 对齐）：

```tsx
export function GitLogDialog({
  workspaceCwd,
  onClose,
}: {
  workspaceCwd: string;
  onClose: () => void;
});
```

**数据获取**：

- 打开时调用 `client.workspaceByCwd(workspaceCwd).workspaceGitLog()` 拉首页。
- "Load more" 按钮使用独立的服务端消费 offset 调用
  `workspaceGitLog(50, nextSkip)`，追加时按 SHA 去重。
- 展开单条时调用 `workspaceGitCommitDetail(sha)` 按需拉详情。
- 取消模式与 GitDiffDialog 一致（effect 用 `let cancelled`，click 用
  `useRef`）。

**渲染**：

- `DialogShell title={t('gitLog.title')} size="xl" allowFullscreen`。
- subtitle 显示已加载条数。
- body 状态机：loading / error / unavailable / empty / data。
- 提交行：短 SHA（monospace，muted 色）、subject、作者名、相对时间。
- refs 解析：从 `refs` 字符串提取 `HEAD -> branch`、tag 等，渲染为小标签。
- merge commit：`parents.length > 1` 时显示 merge 图标。
- 展开详情：完整 body（`<pre>` 渲染，保留换行）+ 文件统计列表（复用
  GitDiffDialog 的文件行样式语义：`+N −M path`，binary 标记）。
- 相对时间：简单的 `timeAgo` 工具函数（秒/分/时/天/周/月/年），不引入
  外部库。

**CSS Module**：

- 复用 GitDiffDialog 的语义变量（`var(--border)`、`var(--muted-foreground)`
  等）。
- `.commitRow`、`.commitSha`、`.commitSubject`、`.commitMeta`、`.commitRefs`、
  `.commitDetail`、`.commitBody`、`.fileStat`、`.loadMore`、`.placeholder`。

### 5. App.tsx 集成

- 新增统一的 `gitDialog` 状态：
  ```ts
  { workspaceCwd: string; view: 'diff' | 'log' } | undefined
  ```
- `/log` 斜杠命令本地拦截（与 `/diff` 同模式），将 `view` 设为 `log`。
- Git chip 默认打开 `diff` view；`GitDialog` 内的 Changes / History tabs
  直接切换 view，不关闭或重新打开 Radix dialog。
- 条件渲染单个 `<GitDialog>`。
- `dialogOpen` 判断加入 `gitDialog !== undefined`。
- `getLocalCommands` 补 `log` 补全项。

### 6. i18n

新增 `gitLog.*` 命名空间（en + zh-CN）：

| Key                           | EN                                                           | zh-CN                                                         |
| ----------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------- |
| `gitLog.title`                | `History`                                                    | `提交历史`                                                    |
| `gitLog.subtitle`             | `(v) => \`${v?.count} commits\``                             | `(v) => \`${v?.count} 条提交\``                               |
| `gitLog.loading`              | `Loading history…`                                           | `加载历史中…`                                                 |
| `gitLog.empty`                | `No commits yet`                                             | `暂无提交`                                                    |
| `gitLog.unavailable`          | `Git is not available for this workspace`                    | `此工作区不可用 Git`                                          |
| `gitLog.error`                | `Failed to load history`                                     | `加载历史失败`                                                |
| `gitLog.loadMore`             | `Load more`                                                  | `加载更多`                                                    |
| `gitLog.loadingMore`          | `Loading…`                                                   | `加载中…`                                                     |
| `gitLog.files`                | `(v) => \`${v?.count} files · +${v?.added} −${v?.removed}\`` | `(v) => \`${v?.count} 个文件 · +${v?.added} −${v?.removed}\`` |
| `gitLog.detailError`          | `Failed to load commit details`                              | `加载提交详情失败`                                            |
| `gitLog.hidden`               | `(v) => \`${v?.count} more file(s) not shown\``              | `(v) => \`还有 ${v?.count} 个文件未显示\``                    |
| `gitLog.copySha`              | `(v) => \`Copy commit ${v?.sha}\``                           | `(v) => \`复制提交 ${v?.sha}\``                               |
| `localCommand.logNoWorkspace` | `No workspace is available yet to show history for.`         | `当前还没有可用于查看历史的工作区。`                          |

## 兼容性

- 新路由、新 SDK 方法、新组件，全部是增量，不修改任何现有接口。
- 旧 daemon 没有 `/workspace/git/log` 路由：SDK 调用会 404，前端显示
  `Failed to load history` 错误占位。
- 旧 client 不受影响（不请求新路由）。
- 非 git 仓库 / 空仓库：`fetchGitLog` 返回 `null` 或空列表，前端显示占位。
- `/log` 在非 Web Shell 客户端不存在（不影响 CLI / ACP）。

## 测试计划

### Unit tests

- **core** `fetchGitLog`：
  - 正常仓库：返回正确条目数、字段解析正确（SHA/作者/时间/subject/refs/parents）。
  - 分页：`hasMore` 判断正确；`skip` 偏移正确。
  - 空仓库（无 commit）：返回空列表。
  - 非仓库：返回 `null`。
  - `limit` 上限截断（>200 → 200）。
- **core** `fetchGitCommitDetail`：
  - 正常 commit：body + numstat 正确。
  - root commit（无 parent）：`--root` 生效，文件统计正确。
  - merge commit：parents 列表正确。
  - 非法 sha（注入尝试）：被拒绝。
  - 不存在的 sha：返回 `null`。
- **daemon** 路由：
  - `GET /workspace/git/log`：正确映射 core 结果到 wire format。
  - `GET /workspace/git/log/commit?sha=`：sha 校验 + 映射。
  - qualified 路由：trusted 校验生效。
  - 参数校验：limit/skip 非法值处理。
- **SDK**：
  - `workspaceGitLog` URL 拼接（有/无参数）。
  - `workspaceGitCommitDetail` URL 拼接 + sha 编码。
- **Web Shell** `GitLogDialog`：
  - 列表渲染（SHA/subject/作者/时间/refs/merge 图标）。
  - 展开按需拉详情 + 折叠。
  - Load more 追加。
  - loading / error / unavailable / empty 占位。
  - 相对时间格式化。
- **App.tsx**：
  - `/log` 本地拦截（有/无 workspace）。

### Integration / browser verification

- 正常仓库打开 `/log`：列表正确，展开详情正确，Load more 正确。
- 空仓库 / 非 git 目录：占位文案。
- 大仓库（>200 commits）：分页正常，性能可接受。

## 风险和控制

- **风险**：`git log` 在超大仓库（100k+ commits）上 `--skip` 性能退化。
  **控制**：`--skip` 是 O(skip) 的，但 50 条一页、用户手动翻页的场景下，
  skip 值通常不会极大。如果后续需要深分页，可改为 `--before=<timestamp>`
  游标。本期不做。
- **风险**：`%D`（refs）在大量 tag/branch 时字符串很长。**控制**：UI 只显示
  前 2-3 个 ref，其余折叠。
- **风险**：sha 查询参数注入。**控制**：core 层正则校验 `/^[0-9a-f]{7,40}$/i`，
  daemon 层二次校验。
- **风险**：跨包新增类型扩大 PR 面积。**控制**：类型最小化，不引入额外依赖。

## 实施计划

| 步骤 | 内容                                                     | 涉及包         |
| ---- | -------------------------------------------------------- | -------------- |
| 1    | core：`fetchGitLog` + `fetchGitCommitDetail` + 单测      | core           |
| 2    | daemon：`workspace-git-log.ts` 路由 + 注册 + 单测        | cli            |
| 3    | SDK：类型 + client 方法 + 导出                           | sdk-typescript |
| 4    | Web Shell：`GitLogDialog` + CSS + i18n + App 集成 + 单测 | web-shell      |
| 5    | build + typecheck + lint + 全量单测验证                  | all            |
