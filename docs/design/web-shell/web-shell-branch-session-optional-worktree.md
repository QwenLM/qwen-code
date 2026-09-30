# Web Shell 会话分支可选 Worktree 隔离

## 文档状态

- 状态：目标态设计
- 对应 Issue：[QwenLM/qwen-code#8271](https://github.com/QwenLM/qwen-code/issues/8271) 的 Part 2
- 依赖：Part 1 已由 [#8817](https://github.com/QwenLM/qwen-code/pull/8817) 合入 `main`（`9f8f65dde0`）
- 相关设计：
  - [从已完成 Assistant 回复创建会话分支](./assistant-response-session-branching.md)
  - [Web Shell worktree 隔离会话](./2026-07-19-webshell-worktree-sessions.md)

## 1. 结论

采用一个方案：扩展现有 `POST /session/:id/branch`，让请求可选携带
`worktree: { slug?: string }`。Daemon 先按现有
`GitWorktreeService.createUserWorktree()` 语义准备 worktree、session ownership
marker 和 worktree sidecar，再调用现有 `SessionService.forkSession()` 原子发布
分支 transcript。发布成功后，Daemon 加载新会话并把它的执行 cwd 切换到
worktree；会话的 `workspaceCwd`、transcript、列表归属和持久化位置始终保持在
源会话所属 workspace。

这不是“把两条现有 API 在客户端串起来”。创建 worktree、发布 transcript 和
激活新会话必须由一个 daemon 事务协调，浏览器不能在 `POST /session` 与
`POST /session/:id/branch` 之间拼接，否则会暴露空会话、丢失历史分支的原子
发布保证，也无法可靠处理客户端断线。

## 2. 已确认的当前事实

以下结论来自 Issue、合入后的源代码和现有设计，而不是目标态假设：

1. Part 1 已支持从 durable branch checkpoint 分支；`atRecordId` 缺失时保留
   最新状态分支。历史分支先持久化，WebUI 再 load；过期 checkpoint 返回
   `branch_point_invalid`。
2. `SessionService.forkSession()` 只裁剪对话历史，不回退工作目录、Git 状态或
   文件。目标 transcript 通过同目录 hard-link，或不支持 hard-link 时通过
   同目录 rename 原子发布。
3. `POST /session` 已支持 `worktree: { slug?: string }`：使用
   `GitWorktreeService.createUserWorktree()` 创建 `worktree-<slug>`，spawn 后通过
   `changeSessionCwd()` 进入 worktree，并写入 `<sessionId>.worktree.json`。
4. Bridge 的 `workspaceCwd` 是不可变的 runtime ownership root；
   `effectiveCwd` 可以切到 worktree。会话列表按 `workspaceCwd` 查询。Web Shell
   把 `worktree.path` 和 owning session id 一起传给 Git read/mutation；daemon 通过
   session-bound resolver 授权 repo-top managed worktree，而不扩大 runtime 的
   workspace ownership。
5. Worktree session 的现有 UI 已能显示 worktree 图标、分支和 Git 状态；Part 2
   不需要再造一套标识组件。
6. 当前 `POST /session/:id/branch` 是 primary-workspace-only 路由。Part 2 不顺带
   扩大 Part 1 的 runtime ownership 范围。

## 3. 目标

- 用户点击符合 Part 1 条件的 Branch 后，在可用时选择：
  - Current workspace：保持现有分支行为；
  - New worktree：创建隔离 worktree，并让分支会话在其中执行。
- worktree 基于发起分支时源 workspace 的当前 Git HEAD 创建，不基于历史
  Assistant 回复的时间点创建。
- 分支会话仍归属源 `workspaceCwd`，因此列表、加载、归档、标题、transcript 和
  sidecar 都留在原 workspace 的 storage scope。
- 在 transcript 可见前完成全部持久隔离元数据，使 session picker 不会看到
  “有 transcript、没有 worktree 归属”的半成品。
- 已知失败安全回收自己创建且尚未发布、且仍能证明身份未变化的资源；源
  session、源 transcript、HEAD、tracked files 以及用户已有的 staged、unstaged、
  untracked 内容始终不变。沿用现有 worktree 语义时，允许幂等创建 daemon 管理的
  `<repoTop>/.qwen/` 目录和 `.qwen/.gitignore`；这些管理元数据不是用户工作内容，
  失败时不回滚。
- 新 client 与旧 daemon 组合时不显示新选项，也不静默降级成 Current
  workspace。

## 4. 非目标

- 不把仓库、文件或 Git HEAD 回退到 `atRecordId` 对应的历史时刻。
- 不把源 workspace 的未提交改动复制到 worktree。沿用现有 worktree 语义：
  新 worktree 从当前 Git ref/HEAD 创建。
- 不新增 worktree 名称输入；首版只用现有自动 slug。
- 不改变 worktree 的退出、合并、删除和长期清理产品策略。
- 不让 secondary workspace 绕过 Part 1 当前的 primary-only 路由。后续如果
  Part 1 改成 live-session-owner 路由，本方案必须绑定解析出的 owner runtime，
  不能 fallback 到 primary runtime。
- 不改变 `/branch` 文本命令的交互。该命令继续走 Current workspace；本次只
  覆盖 Web Shell 中用户点击 Branch 的流程。

## 5. 产品交互

### 5.1 可用性

Daemon 新增 additive capability：`session_branch_worktree`，并在 workspace Git
status 中增加 server 计算的 `worktreeSupported?: boolean`。该值是 read-only
preflight：检查 workspace trust、Git 可用、non-bare repository、可解析的 HEAD
commit、`git worktree` 子命令、canonical repo top 和 managed root 可写性；它不
创建 branch 或目录。该 preflight 不是只看 workspace root：daemon 用 source
session id 从 Bridge 的内部 execution snapshot 取得 live `effectiveCwd`，再调用第
8.2 节同一个 base-checkout resolver；浏览器不自报或决定 cwd。Web Shell 只有
同时满足以下条件才显示 New worktree 选择：

- capabilities 包含 `session_branch_worktree`；
- 当前 source session 属于 primary workspace；
- 该 workspace 的 capability 为 `trusted: true`；
- 当前执行 checkout 的 Git status 明确返回 `worktreeSupported: true`。

这允许 detached HEAD，只拒绝没有 commit 的 unborn HEAD。该信号仅用于避免
展示必然失败的选项；状态可能在 dialog 打开后变化，Server 仍必须在事务开始
时重新检查全部条件，不能信任 client 的判断。普通 `/cd` 进入另一个 repository
或未经当前 session sidecar/marker 授权的 linked worktree 时，preflight 返回
`worktreeSupported: false`；伪造 request 也由 branch route 明确拒绝。

### 5.2 Dialog

符合条件时，点击 Branch 打开 `BranchSessionDialog`：

- 默认选中 Current workspace，维持现有低成本路径；
- New worktree 描述为“从当前 Git HEAD 创建隔离 checkout；不会回退到这条
  回复时的文件状态”；
- Confirm 后锁定 source session id、`atRecordId` 和 isolation 选择；请求期间
  禁止重复提交；
- dialog 打开期间如果用户切换 session，关闭 dialog，不把旧 checkpoint 用到
  新 session。

不满足可用性条件时保持当前一键 Branch 行为，不显示无法执行的 worktree
选项。

### 5.3 成功和失败反馈

- Current workspace：沿用现有成功状态和 stale-checkpoint 恢复。
- New worktree：切换成功后复用现有 worktree chip、session list 标识和携带
  target `sessionId` 的 `worktree.path` Git 查询。
- worktree 准备或 branch publication 失败：留在源 session，显示错误，不新增
  session catalog 项。
- transcript 已完整发布、但首次 load/cd 失败：提示“分支已创建但无法自动
  打开，可从会话列表重试”，并刷新源 workspace 的 session catalog。这个
  session 已具备 transcript、worktree、marker 和 sidecar，不是半成品。

## 6. API 合约

### 6.1 Request

`POST /session/:id/branch` 增加可选字段：

```json
{
  "name": "optional display name",
  "atRecordId": "optional durable checkpoint uuid",
  "worktree": {}
}
```

首版 wire type 保留 `slug?: string`，以便复用现有类型和 server 验证，但 Web
Shell 不提供自定义 slug：

```ts
interface BranchSessionRequest {
  name?: string;
  atRecordId?: string;
  worktree?: { slug?: string };
}
```

所有用户可控的 worktree 创建入口（包括普通 session 创建和 branch session）都
必须拒绝精确的 ephemeral agent slug 形状 `agent-<7hex>`。这个命名空间只属于
内部 Agent worktree 生成器和 stale-agent sweep；用户路由不能创建随后会被该
sweep 当作临时资源删除的 worktree。内部 Agent 路径仍可复用同一个通用 slug
validator，因此这项保留规则由用户路由显式执行。

`worktree` 缺失时，现有 latest-state 和 historical 分支返回语义保持不变。
`worktree` 存在时，无论是否提供 `atRecordId`，成功响应都是已 load 的
`DaemonBranchedSession`，并带：

```ts
{
  workspaceCwd: string; // 原 workspace，保持不变
  currentCwd: string; // worktree path
  worktree: {
    slug: string;
    path: string;
    branch: string;
  }
}
```

### 6.2 Capability 和兼容性

- 新 daemon + 新 Web Shell：按 capability 展示并发送 `worktree`。
- 新 daemon + 旧 Web Shell：不发送字段，行为完全不变。
- 旧 daemon + 新 Web Shell：没有 `session_branch_worktree`，不展示选项；不能
  依赖旧 daemon 忽略未知 JSON 字段，因为那会把隔离请求静默降级。

### 6.3 Server 错误

沿用现有 worktree 错误 code，并补充 branch 激活错误：

| 场景                                                   | HTTP/code                                                        | 可见 session                             |
| ------------------------------------------------------ | ---------------------------------------------------------------- | ---------------------------------------- |
| `worktree` 不是 object / slug 非法或命中保留命名空间   | `400 invalid_worktree` / `worktree_invalid_slug`                 | 无                                       |
| source workspace 不可信                                | `403 untrusted_workspace`                                        | 无                                       |
| 非 Git repo、无 commit 或 cwd 不是允许的 base checkout | `409 worktree_base_checkout_unsupported`                         | 无                                       |
| worktree 创建失败                                      | `500 worktree_create_failed`                                     | 无                                       |
| target id 预留失败                                     | `409 session_id_conflict`                                        | 无                                       |
| checkpoint 失效                                        | `409 branch_point_invalid`                                       | 无；清理准备资源                         |
| fork 在 transcript commit 前失败                       | 保留现有 branch error                                            | 无；清理准备资源                         |
| fork 已派发但 outcome 不明确                           | `500 branch_worktree_outcome_unknown`，响应含 target `sessionId` | 可能稍后可见；保留全部资源并刷新 catalog |
| transcript 已 commit，首次 load/cd 失败                | `500 branch_worktree_activation_failed`，响应含 `sessionId`      | 有，且是完整可恢复 session               |

错误 body 不返回 Git stderr 或未经净化的绝对路径。

## 7. Ownership 与数据模型

该路由仍是 **legacy primary-runtime scoped**，不是 process-global 或任意
workspace fallback：

| 数据/操作                            | Owner                          | 目标位置                           |
| ------------------------------------ | ------------------------------ | ---------------------------------- |
| source/target transcript             | source primary runtime storage | 原 `workspaceCwd` 的 chats dir     |
| target session listing/archiving     | source primary runtime         | 原 workspace                       |
| worktree Git ref 和 checkout         | source workspace repo          | `<repoTop>/.qwen/worktrees/<slug>` |
| target live process routing          | source primary runtime bridge  | `workspaceCwd` 不变                |
| agent file/tool execution            | target session                 | `effectiveCwd = worktree.path`     |
| Git status/diff/log/branch/commit UI | source workspace route         | session-bound `cwd=worktree.path`  |

`worktree.path` 永远不能成为 runtime lookup key。加载 target session 时必须先用
原 `workspaceCwd` 找到 runtime，再在该 runtime 内验证 sidecar containment 并
切换 `effectiveCwd`。

### 7.1 Session-bound managed cwd 授权

不能把 Git 路由的 containment root 从 `workspaceCwd` 粗暴扩大到 canonical repo
top。SDK 的 workspace Git 请求在传 `cwd=worktree.path` 时同时传 target
`sessionId`；daemon 增加统一的 `resolveSessionManagedGitCwd()`：

1. 没有显式 cwd，或 cwd 的 canonical path 位于 `workspaceCwd` 内时，保持现有
   行为，不要求 session id；
2. 显式 cwd 位于 `workspaceCwd` 外时，必须提供 session id，且 session 的
   summary/transcript 必须归属当前 runtime 的 workspace storage；
3. 读取该 session 的 durable sidecar，要求 sidecar path 与请求 cwd
   canonical-equal，worktree 内 regular ownership marker 的内容等于 session id；
4. 从当前 runtime workspace 重新推导 canonical repo top，要求 cwd realpath
   containment 于 `<repoTop>/.qwen/worktrees`，不能使用 client 或 sidecar 自报的
   repo top 扩大边界；
5. 任一读取、identity 或 containment 校验失败时，read route 和 mutation route
   都明确拒绝；显式非法 cwd 不能静默 fallback 到 `workspaceCwd`。

所有 containment 判断统一复用 segment-aware 的 shared `isWithinRoot()` 语义：
只有 relative path 恰为 `..`、以 `..${path.sep}` 开头或仍是 absolute path 才是
逃逸。`...`、`..cache` 等合法目录段必须继续被视为 root 内路径，不能用
`relative.startsWith('..')` 粗略拒绝。

这条 helper 应用于所有接收 worktree cwd 的下游消费者：status、diff/file diff、
log/commit detail、branches、checkout/create branch、push、pull、commit，以及创建
GitHub PR 时接收 cwd 的 route。它只授权该 session 已持久化并持有 marker 的一个
managed worktree，不授权 repo top 的其他目录或另一个 session 的 worktree。

SDK/Web Shell 不仅在 checkout、commit 等 mutation 中携带 target `sessionId`；
branch listing 和后台 Git status refresh 只要发送 `cwd=worktree.path`，也必须同时
携带 owning session id。缺失或错误 id 的 worktree read 与 mutation 使用同一条
fail-closed resolver，不能因为请求是只读就放宽。

### 7.2 Sidecar 与 marker 的消费契约

Sidecar 只描述预期 worktree，不能单独证明当前 ownership。所有生产 load/resume
入口（TUI、headless、ACP）调用共享 restore helper 时必须提供目标 session id；
helper 只有在 worktree 存活、路径 containment 成立且 regular marker owner 仍等于
该 id 时才生成恢复提示。marker 缺失、不可读或已被另一个 session 合法接管时，
不得把 worktree 路径注入下一次模型请求，并应 best-effort 清理旧 session 的 stale
sidecar。

Daemon session list 的 durable sidecar enrichment 使用同一 owner 交叉检查。owner
不匹配时仍可列出 session 本身，但不能把 sidecar-derived worktree metadata 放入
catalog cache。该门禁只影响 durable sidecar enrichment；live bridge 已经验证的
当前 worktree metadata 仍按既有 merge 规则消费。

### 7.3 Git 子进程环境隔离

Branch base resolver、worktree capability preflight、session-managed cwd resolver
以及 marker exclude 的 common-dir 探测都必须通过 shared `gitEnv()` 启动 Git。
必须清除完整的 repository-shifting/config 注入集合，包括 `GIT_DIR`、
`GIT_WORK_TREE`、`GIT_COMMON_DIR`、`GIT_INDEX_FILE`、`GIT_CONFIG_*` 和 object-dir
重定向；为 simple-git 显式传入环境时，也要去除其安全插件会拒绝的
`EDITOR`/`GIT_EDITOR`/`GIT_SEQUENCE_EDITOR` 与 `PAGER`/`GIT_PAGER`，避免 spawn
在执行前被拒绝。

这些探测的 cwd 由 server 解析，但 cwd 本身不足以抵抗 inherited Git env。身份
探测失败时继续 fail closed；marker exclude 即使保持 best-effort，也只能向 owning
repository 的 `info/exclude` 写入 `/.qwen-session`，不能被环境变量重定向到其他
repository。

## 8. Daemon 事务

### 8.1 为什么先准备 worktree、最后发布 transcript

Session picker 以 `<sessionId>.jsonl` 是否存在作为 session 可见边界。只要在
link/rename 发布 target transcript 前完成 worktree、ownership marker 和 sidecar，
任何 client 看到 target transcript 时，隔离所需的持久状态已经齐全。

```mermaid
sequenceDiagram
  participant UI as Web Shell
  participant Route as Daemon branch route
  participant Git as GitWorktreeService
  participant Bridge as ACP bridge
  participant Agent as Source ACP agent
  participant Store as Original workspace storage

  UI->>Route: POST branch + atRecordId + worktree
  Route->>Route: validate capability/trust/source ownership
  Route->>Route: reserve targetSessionId
  Route->>Store: create+fsync planned journal (wx)
  Route->>Git: createUserWorktree(autoSlug, current HEAD SHA)
  Git-->>Route: path + worktree branch
  Route->>Git: safely write .qwen-session(targetSessionId)
  Route->>Store: exclusively write + fsync worktree sidecar
  Route->>Store: advance journal to sidecar-ready
  Route->>Bridge: branchSession(targetSessionId, persistOnly)
  Bridge->>Agent: session/branch(targetSessionId, atRecordId)
  Agent->>Store: forkSession(...), publish transcript last
  Store-->>Agent: committed
  Agent-->>Route: persisted branch result
  Route->>Store: clear preparation journal
  Route->>Bridge: loadSession(targetSessionId, original workspace)
  Route->>Bridge: changeSessionCwd(worktree.path)
  Route->>Bridge: setSessionWorktree(metadata)
  Route-->>UI: 201 restored session + worktree
  UI->>UI: switch session; show existing worktree indicators
```

### 8.2 Preparation

Route 在调用 branch mutation 前完成：

1. 捕获 runtime generation，并在每个外部副作用前 `assertOpen()`；先用 source
   summary 的 `hasActivePrompt` 做无副作用 preflight，Bridge 仍在 mutation
   admission 时权威复验。
2. 生成 target session UUID；该 UUID 只在 daemon 内部向下传递，不接受浏览器
   指定。复用 `RequestedSessionIdAdmission` 做 active/archive/live/in-flight 排他
   预留，并持有 reservation 到 activation 或最终清理结束。
3. Bridge 增加 daemon-internal `getSessionExecutionSnapshot(sessionId)`，在 bridge
   entry 的同步边界内一次返回 `{ workspaceCwd, effectiveCwd, worktree }`；不扩展
   public `BridgeSessionSummary` wire schema，也不接受
   client 提供 cwd。Branch route 在 runtime/source coordination 内取一次权威
   snapshot；runtime generation 由 route wrapper 捕获，并在准备阶段的外部副作用前
   复验。随后用 snapshot 和 durable worktree metadata
   调统一的 `resolveBranchWorktreeBaseCheckout()`。它解析 effective cwd 所属
   checkout root、Git common dir 和 repo top，只接受两类 base：原 workspace
   checkout 内的目录；或 canonical-equal 于 source sidecar path、regular marker
   owner 等于 source session id 的 session-managed worktree。`/cd` 到另一个 repo、
   另一个 linked worktree、仅伪造 sidecar/marker 或 identity 不明时都 fail
   closed。Preflight 和 confirm 后的权威检查调用同一 accessor/resolver；confirm
   snapshot 是与并发 `/cd` 的线性化点，snapshot 之后的 `/cd` 不改变本请求捕获的
   base，先完成的 `/cd` 则由新 cwd 决定允许或拒绝。Route 从 resolver 返回的
   checkout cwd 捕获当前 HEAD SHA/branch；managed worktree root 仍由原 workspace
   的 canonical repo top 推导。传给 `createUserWorktree()` 的 base 是捕获的
   immutable HEAD SHA，不读取 checkpoint 的 `cwd` 或 file-history backup。
4. **在第一个 Git 或文件系统写副作用前**，在原 workspace chats dir 以 `wx`
   创建并 fsync 隐藏 journal，同时 fsync 父目录。`planned` 记录 owner token、
   pid/hostname、target id、slug、预期 canonical path/branch、base SHA 和创建时间。
5. 调用现有 `createUserWorktree()`。若它返回 failure 且预期 worktree path 不存在，
   清除 planned journal；若 path 已出现但尚无 strict marker，无法证明该 path 不是
   并发外部创建的同名资源，因此保留 journal/path 并告警，不做推测性删除。该调用
   可能幂等创建 `<repoTop>/.qwen/.gitignore` 和 managed directories；journal 不
   删除这些 repo-scoped daemon 元数据，错误合约也不声称 checkout 字节级零变化。
6. 安全写入 worktree 内 `.qwen-session = targetSessionId`。写入前拒绝 HEAD 已跟踪
   的同名路径；创建时使用 no-follow、exclusive create、`0600`、handle-based
   regular-file 校验和 fsync。已存在文件、目录或 symlink 一律 fail closed。对
   Part 2，此 marker 是强制成功项。随后解析 common dir 并写入 marker exclude
   规则时遵循第 7.3 节的 Git 环境隔离，确保规则只落在 owning repository。
7. 在原 workspace chats dir 以 exclusive create 原子写入 target
   `<sessionId>.worktree.json`；不能覆盖任何既有 sidecar。直接使用现有完整
   `WorktreeSession` shape：

   ```ts
   {
     slug,
     worktreePath,
     worktreeBranch,
     originalCwd: canonicalRepoTop,
     originalBranch: currentBranch ?? 'HEAD',
     originalHeadCommit: immutableBaseSha,
   }
   ```

   Detached HEAD 的 `originalBranch` 沿用现有 sidecar 约定写 `'HEAD'`。文件和
   chats dir 都要 fsync。

8. 每完成 worktree、ownership marker、sidecar，就通过原子替换推进 journal
   phase；只有 `sidecar-ready` 已持久化后才允许 transcript publication。

Journal 不是 session transcript，也不参与 session listing。其存在时间覆盖从
第一个副作用到 transcript commit；因此任意 crash window 都有可恢复的 owner
记录。

### 8.3 Branch publication

`BridgeBranchSessionRequest` 增加 daemon-internal 字段：

```ts
{
  targetSessionId?: string;
  persistOnly?: boolean;
}
```

worktree 路径传 `targetSessionId` 和 `persistOnly: true`。Bridge 只把 target id
传给 source ACP agent，不把 worktree path 当作 source mutation 的 cwd。Agent
验证 UUID 后，用它替代当前内部 `randomUUID()`，继续在现有
`runExclusiveHistoryMutation()`、`beginHistoryMutation()` 和 recording write
barrier 内调用 `SessionService.forkSession()`。

不修改 `SessionService.forkSession()`：durable checkpoint 二次校验、历史裁剪、
file-history backup 和 transcript 原子发布继续只有一个事实来源。

Bridge 明确定义
`restoreBranch = !req.persistOnly && (isSideTask || req.atRecordId === undefined)`。
`persistOnly` 让 bridge 无论 latest-state 还是 historical 都先返回 persisted
result；route 因此能用同一条 worktree 激活路径，不需要在 bridge 内复制 daemon
的 sidecar/containment 逻辑。

Branch route 不能继续只依赖通用 wrapper 对 source id 的 shared lock。wrapper
持有 source lock 后，route 生成随机 target id，取得 target shared lock，再通过
`RequestedSessionIdAdmission.reserveCreate()` 预留 target，避免 target 在
publication/activation 窗口被归档或以相同 id 创建。target reservation 在 route
的单一 `finally` 释放，两个 shared lock 分别由嵌套 coordination scope 释放。

在调用 ACP mutation 前把 journal phase 持久化为 `mutation-dispatched`。只有
mutation 尚未派发，或 Agent 明确返回已结束的 commit 前 failure，request path
才允许回滚。transport close、daemon crash 或无法判定的异常都不等价于 mutation
结束。

### 8.4 Activation

publication 成功后：

1. route 用原 `workspaceCwd` 调用 `bridge.loadSession(targetSessionId)`；
2. 使用 prepare 阶段由 server 推导并创建的 canonical managed path 和 allowed root
   调用 `changeSessionCwd()`；后续 load/resume 仍从 sidecar 重新执行 containment、
   marker owner 和 canonical path 校验；
3. `setSessionWorktree()` 更新 live bridge entry，并在 response 填充
   `currentCwd`/`worktree`；
4. 返回后，WebUI 沿用 `startSessionSwitch()`。即使它再次 load，也只会 attach
   到同一个 live target session。

`reserveCreate()` 是 publication 到 activation 之间的 admission fence：普通
HTTP load/resume 会被现有 `reserveRestore()` 以 retryable
`session_id_conflict` 拒绝，不能抢先 attach。Route 作为 reservation owner 直接
调用同 runtime 的 `bridge.loadSession()`；cwd relocation 和 worktree metadata
安装完成后，在单一 `finally` 释放 reservation。随后 WebUI 的再次 load 才能
attach。

内部 activation 根据 `loadSession()` 返回值处理 client ledger：

- `attached: false`：本请求创建 cold live owner；失败/断线时仅可调用
  `killSession({ requireZeroAttaches: true })`，若已有其他 attach 则保留；
- `attached: true`：在 admission invariant 下不应出现，但作为 bridge 层防御性
  分支，只 detach 本次 client，绝不 kill 共享 entry；
- 无论哪种情况，transcript commit 后都不删除 worktree、sidecar 或 transcript。

### 8.5 已知失败、断线和 crash recovery

将 target transcript 的原子发布视为不可逆 commit point：

- mutation 尚未 dispatch，或 Agent 明确返回已结束的 commit 前 failure：先用
  target reservation 对应的原 workspace SessionService 检查 active/archive
  transcript。只有确认 transcript 不存在，并且 journal owner token、canonical
  path、branch、base tip 和 phase 都匹配时，才进入 recovery-only 删除路径。该
  路径不能复用 `removeUserWorktree()`：紧邻删除前再次校验 canonical path、regular
  marker、owner、完整 clean 状态和 ref tip，然后 fsync journal 的
  `cleanup-intent` phase。只运行不带 `--force` 的
  `git worktree remove <path>`；失败就保留 sidecar、journal 和 branch，不得用
  `fs.rm` fallback。
- worktree remove 成功后把 phase 持久化为 `worktree-removed`，再尝试 Git
  porcelain 的 `git branch -d <branch>`。不能用 `update-ref -d`，因为 expected tip
  CAS 不会检查该 branch 是否在检查后被另一个 worktree checkout；也不能用
  `branch -D`。删除前再次读 tip，已不等于 immutable base SHA 就直接保留；`-d`
  因未合并、已被 checkout、ref 移动或任何其他原因拒绝时，也把 branch 作为安全
  残留保留并告警，不重试更强的删除。结果原子记录成 `branch-deleted` 或
  `branch-preserved` terminal phase，只有 terminal phase durable 后才删除 sidecar，
  最后清 journal。因此从 source worktree 的 ahead HEAD 创建的空 branch 可能在
  rollback 后保留；这是显式的 fail-safe residue，不以数据安全换完整回收。
- mutation 已 dispatch 后 outcome 不明确：**即使此刻 target transcript 不存在，
  也绝不回滚**。ACP branch 派发后不可取消，旧 Agent 仍可能晚到执行
  link/rename。保留 journal、sidecar、ownership marker、worktree 和 branch，返回
  outcome unknown。后续 sweep 看到 transcript 出现时只清 journal；看不到时也
  保留资源并告警。除非未来另行引入能证明旧 Agent 已终止且不能再 publish 的
  跨进程 fence，否则不能用 deadline 或时间窗口代替该证明。
- commit 后立即清除 journal；删除失败由 recovery 幂等完成。随后任何失败都
  保留完整 target transcript、sidecar、ownership marker 和 worktree。根据
  activation 的 `attached` 状态只 detach 本次 client，或对本次 cold owner 尝试
  zero-attach kill。下次从 session list load 时复用 sidecar 恢复 cwd。
- client 在 response 前断线：detach/kill 本次 live attach，但保留已发布 target
  session 和 worktree；它们已经可恢复。
- daemon crash：primary runtime 每次 generation materialize 完成后，在该
  runtime storage 上取得进程内 recovery mutex 并执行一次幂等 sweep。对尚未
  dispatch 的 journal，只有超过正常请求期限、同 host owner pid 已终止且身份
  检查全部通过时才能回滚；异 host owner 状态未知或 generation 已关闭时跳过。
  对 `mutation-dispatched` journal，target transcript 存在时只清 journal，不存在
  时永远保留并告警。

Cleanup phases 也必须跨 crash 重入：`cleanup-intent` 下若 path 仍存在，就重新做
完整身份/clean/tip 检查；若 path 已不存在且 Git worktree registry 也没有 expected
entry，视为 remove 已完成并推进 `worktree-removed`，registry 状态不明则保留。
`worktree-removed` 下重新读取 branch tip：ref 已不存在记 `branch-deleted`；tip 仍
等于 immutable base 时再次尝试 non-force `git branch -d`；tip 已变化或 Git 拒绝
删除则记 `branch-preserved`。这样 crash 发生在 worktree remove 后或 branch delete
前后，都能安全推进到 terminal phase，又不会用强制删除丢失晚到 commit。

Terminal metadata cleanup 使用严格 durable 顺序，不能直接复用当前仅 `unlink` 的
`clearWorktreeSession()`：先原子写入并 fsync terminal phase 及 chats dir；再 unlink
sidecar 并 fsync chats dir；最后 unlink journal 并再次 fsync chats dir。任一
`ENOENT` 按幂等成功处理，其他错误停止在仍有 journal 可重入的状态。这样 sidecar
unlink 尚未 durable 时 journal 一定仍在；journal unlink 在最终目录 fsync 前若因
crash 回滚，也只会留下可幂等清除的 terminal journal，不会留下无 journal owner
的 stale sidecar。

Recovery 的 “clean” 比现有 ephemeral Agent sweep 更严格，不能复用
`--untracked-files=no`：必须同时确认无 staged、unstaged、conflicted、untracked
和 ignored 产物（仅排除身份已验证的 `.qwen-session`）。建议用 Git diff/index
检查加 `git clean -ndx -e .qwen-session` 的只读结果；任何 Git、lstat、realpath
或目录枚举错误都 fail closed。branch tip 还必须等于 journal 的 immutable base
SHA。实现提供故障注入点，验证第一次 clean/tip 检查后出现文件、ref 移动或另一
worktree checkout 同名 branch 时，最终复验、非 force worktree remove 或 Git
porcelain branch guard 至少一层会拒绝破坏性清理。

这个 sweep 不扩大现有 `cleanupStaleAgentWorktrees()` 的匹配范围，也不扫描或
删除普通用户命名 worktree。

## 9. Web Shell 与 WebUI 改动

### 9.1 SDK/WebUI

- `DaemonClient.branchSession()` 序列化可选 `worktree`。
- 增加显式 `WorktreeBranchSessionRequest { name?; atRecordId?; worktree }`
  overload，并放在 historical overload 前，返回 `DaemonBranchedSession`。
  Historical-without-worktree 仍返回 persisted result；latest-without-worktree 仍
  返回 restored result。通用 wire type 保留 `atRecordId?`。
- `DaemonSessionActions.branchSession()` 增加 options object，而不是继续增加位置
  参数：

```ts
branchSession(options?: {
  name?: string;
  atRecordId?: string;
  worktree?: { slug?: string };
}): Promise<BranchSessionActionResult>;
```

这里替换 WebUI 内部 action 签名，不增加第二套 branch action。SDK 的 wire
overload 仍兼容不传 worktree 的调用者。

WebUI 不能再只用 `atRecordId === undefined` 判断 restored result；应使用
`worktree !== undefined || atRecordId === undefined`，并沿用 latest-state branch
现有的 stable clientId、navigation guard 和 detach ledger。Historical + worktree
必须增加类型级 overload 测试和 client attach/detach 回归测试。

### 9.2 Web Shell

- `handleBranchCurrentSession(atRecordId)` 在符合条件时只打开 dialog；确认后调用
  统一的 `branchCurrentSession({ atRecordId, worktree })`。
- pending request key 加入 isolation mode，防止同一 checkpoint 的 Current 与
  Worktree 请求错误共用 Promise。
- 保留现有 owner/navigation guard 和 `branch_point_invalid` transcript reload。
- 收到 `branch_worktree_outcome_unknown` 或
  `branch_worktree_activation_failed` 时刷新 source workspace catalog；activation
  failure 不自动切换，也不把它表述成“未创建”。
- 成功后不新增专用 worktree banner；复用 `sessionWorktree`、Git chip、session
  catalog 和 Git dialog 的现有消费链。BranchPicker 打开后的后台 status refresh
  与 branch listing 一样，同时传 worktree path 和 target session id。

## 10. 实现范围

| 文件/区域                                                                                                                                                 | 修改                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `packages/cli/src/serve/capabilities.ts`                                                                                                                  | 增加 `session_branch_worktree`                                                                     |
| `packages/cli/src/serve/routes/session.ts`                                                                                                                | 扩展 branch route；编排 prepare/publish/activate/cleanup                                           |
| `packages/cli/src/serve/branch-worktree-preparation.ts`                                                                                                   | base-checkout resolver、小型事务 marker、严格 rollback 和 startup recovery                         |
| `packages/cli/src/serve/run-qwen-serve.ts` / runtime materialize 路径                                                                                     | 每个 primary generation 一次的 recovery 调用与 mutex                                               |
| `packages/cli/src/startup/worktreeStartup.ts`                                                                                                             | adoption 的 expected-owner CAS 必须成功后才能写新 sidecar                                          |
| `packages/cli/src/serve/workspace-route-runtime.ts`                                                                                                       | 增加 session-bound managed cwd resolver；复用 shared containment 与 Git 环境隔离                   |
| `packages/cli/src/serve/server/session-list.ts`                                                                                                           | sidecar-derived worktree metadata 仅在 marker owner 匹配时进入 session catalog                     |
| `packages/cli/src/serve/routes/workspace-git.ts`、`workspace-git-diff.ts`、`workspace-git-log.ts`、`workspace-git-branches.ts`、`workspace-github-prs.ts` | 计算 preflight；所有 cwd 消费者统一授权并拒绝非法显式 cwd                                          |
| `packages/cli/src/acp-integration/acpAgent.ts`                                                                                                            | 接受 daemon 指定的 target UUID，继续使用现有 fork transaction                                      |
| `packages/cli/src/nonInteractiveCli.ts` / `packages/cli/src/ui/AppContainer.tsx`                                                                          | load/resume 时把 expected session id 传入共享 worktree restore                                     |
| `packages/acp-bridge/src/bridgeTypes.ts` / `bridge.ts`                                                                                                    | internal `targetSessionId`、`persistOnly` 和 execution snapshot accessor，不复制 worktree 文件逻辑 |
| `packages/core/src/services/gitWorktreeService.ts`                                                                                                        | strict marker create/CAS；marker exclude common-dir 探测使用隔离 Git 环境                          |
| `packages/core/src/services/worktreeSessionService.ts`                                                                                                    | restore 时交叉检查 expected session id 与 marker owner，并清理 stale sidecar                       |
| `packages/core/src/utils/git-branches.ts`                                                                                                                 | 提供 resolver/preflight/simple-git 共用的 Git 子进程环境净化                                       |
| `packages/sdk-typescript/src/daemon`                                                                                                                      | branch request/response 类型，以及 Git 请求 `sessionId` 的 JSON 序列化                             |
| `packages/webui/src/daemon/session`                                                                                                                       | options-based branch action，保留切换/attach 语义                                                  |
| `packages/web-shell/client`                                                                                                                               | dialog、capability gate、错误反馈、请求去重，以及所有 worktree Git read/mutation 携带 target id    |

不修改 `packages/core/src/services/sessionService.ts`、branch checkpoint schema、
transcript replay schema 或 session catalog schema。Core 只拆分两种 marker API：

- Part 2 fresh worktree 调 `createWorktreeSessionMarker()`：exclusive、no-follow、
  已存在即失败；
- 现有 startup reattach/adoption 调 hardened compare-and-replace：调用方提供刚
  读取的 expected previous owner，只替换 regular file，拒绝 symlink 和 owner
  变化。`worktreeStartup.ts` 不能 catch 后继续；CAS 失败必须终止 adoption 并保留
  previous owner 的 marker 和 sidecar，只有 CAS 成功才写 target sidecar。

这保留 `--worktree` 把 stale owner 从 old session 迁移到 new session 的现有合法
行为，不新增第二套 fork 逻辑。

## 11. 测试计划

### 11.1 Daemon/Bridge/ACP 单元测试

- 不带 `worktree` 的 branch request 与当前 JSON、返回形状和 restore 行为一致。
- 新 capability 被广告；旧 capability fixture 不会误显示新选项。
- untrusted、非 Git、无 commit、非法 slug、branch/path 冲突均在 fork 前失败。
- 普通 session 与 branch session 的用户路由均拒绝 canonical `agent-<7hex>`；内部
  ephemeral Agent worktree 仍可创建同形 slug。
- source live cwd 位于原 checkout 子目录或其自有 managed worktree 时，从同一 resolver
  返回的 checkout HEAD 创建；`/cd` 到另一个 repo/linked worktree 时 preflight false，
  直接伪造 branch request 也返回 `worktree_base_checkout_unsupported`。
- Bridge execution snapshot 忠实反映普通 `/cd` 后的 `effectiveCwd` 和 worktree
  metadata，且不暴露到 public summary；runtime generation 由 route guard 独立复验。
  并发 `/cd` 与 Confirm 按 snapshot
  线性化：先于 snapshot 的 cd 决定 base/拒绝，后于 snapshot 的 cd 不改变已捕获
  immutable HEAD。
- target UUID 在任何副作用前排他预留；daemon 指定 UUID 被 Agent 使用；非法或
  冲突 UUID 被拒绝，reservation 在所有出口释放。
- historical 和 latest-state + worktree 都走 persist-only，再由 route load。
- stale `atRecordId` 会清理 worktree/sidecar/preparation marker，不产生 transcript。
- transcript commit 前的每个故障注入点都不产生可列出的 session。
- `mutation-dispatched` 后 transport close、target 暂不存在、随后晚到 transcript
  commit：recovery 不得删除 sidecar/worktree，最终 session 可正常 load。
- commit 后 load/cd/HTTP delivery 失败保留完整 session，并能在下一次 load 时从
  sidecar 恢复 worktree。
- sidecar 指向仍存活但 marker 已属于另一个 session 的 worktree 时，TUI、headless
  和 ACP 均不生成恢复提示并清理旧 sidecar；session catalog 仍列出 session，但不
  富集旧 worktree metadata。same-owner marker 继续恢复。
- 两个并发相同请求不能共用 target id/slug，也不能互删资源；reservation 期间
  外部 load/restore 被拒绝，释放后才能 attach。
- 防御性模拟 internal load 返回 `attached: true`，activation 只 detach 本次
  client，不 kill 共享 entry。
- source session 在分支前后 transcript、cwd、client count 和 prompt 状态不变。
- monorepo subdirectory workspace 中，target session id 能授权 status、diff/file
  diff、log/detail、branches、checkout/create、push/pull、commit 和 PR create；
  缺 session id、错 session id、错 marker、伪造 sidecar、repo top 其他路径和其他
  session 的 worktree 都被拒绝，显式非法 read cwd 不 fallback。

### 11.2 文件系统与安全测试

- worktree path 必须 realpath containment 于 server 推导的
  `<repoTop>/.qwen/worktrees`；sidecar symlink escape 被拒绝。
- containment 接受 `...`、`..cache` 等合法 root 内目录段，同时继续拒绝真正的
  `..`/absolute escape。
- 在 daemon 继承 `GIT_DIR`、`GIT_WORK_TREE`、`GIT_COMMON_DIR` 或 `GIT_CONFIG_*`
  指向 decoy repository 时，branch resolver、preflight 和 session-managed cwd
  仍只认证 owning repository；marker exclude 只写 owning repository，不触碰
  decoy 的 `info/exclude`。
- journal 在第一个副作用前 durable；每个 phase crash 都可幂等恢复。
- cleanup 只有 owner token、`.qwen-session`、branch tip 和 target transcript
  状态全部匹配才删除；任一读取异常都 fail closed。
- tracked `.qwen-session`、symlink/目录 marker、untracked-only、ignored-only、
  conflict、post-checkout hook 产物都必须阻止自动删除。
- monorepo subdirectory workspace 仍在 canonical repo top 下创建 worktree，
  transcript 仍归属原 workspace storage。
- worktree 内新增 commit/改动后，recovery sweep 不删除。
- source worktree branch ahead of primary HEAD 时，明确的 commit 前失败仍能在
  全部身份检查通过后 non-force 删除 worktree；若 `git branch -d` 因未合并拒绝，
  branch 作为已声明的安全残留保留。
- 在初次 clean 检查后注入 untracked/ignored 文件，以及在初次 tip 检查后新增
  commit、移动 ref，或在 worktree remove 后让另一个 worktree checkout 同名
  branch；recovery 不使用 `--force`/`fs.rm`/`branch -D`/`update-ref -d`，不得丢失
  注入的文件、commit 或破坏另一个 worktree 的 HEAD。
- 分别在 worktree remove 成功后、cleanup phase 更新前，以及 branch delete 成功
  后、metadata 清理前 crash；下一次 sweep 从 Git registry/ref 状态幂等推进到
  terminal phase，不重复 destructive action。
- terminal phase durable 后，在 sidecar unlink 后第一次 chats-dir fsync 的前后、
  journal unlink 后最终 chats-dir fsync 前分别注入 crash；恢复后不存在 orphan
  sidecar，最多留下可幂等清除的 terminal journal。验证 `ENOENT` 幂等、其他目录
  fsync/unlink 错误保留 journal。
- existing startup reattach 可通过 expected-owner compare-and-replace 合法迁移
  marker；fresh create 不能覆盖它。模拟 owner 在 read 与 replace 之间变化时，
  adoption 必须中止且不能覆盖 previous sidecar。
- success 和每个 create failure 注入点都断言：用户已有 tracked/staged/unstaged/
  untracked 内容不变；允许保留幂等 daemon-managed `.qwen/.gitignore` 和目录。
- 错误响应不泄露绝对路径或 Git stderr。

### 11.3 WebUI/Web Shell 测试

- 只有 capability + primary + trusted + server worktree preflight 四个条件都满足
  才出现两种选择；detached HEAD 可用，unborn HEAD 不可用。
- 默认 Current workspace；取消 dialog 不发请求。
- Worktree confirm 正确发送 `{ atRecordId, worktree: {} }`。
- dialog 期间切换 session 会取消旧 intent；双击 Confirm 只发一个请求。
- stale checkpoint 仍刷新 source transcript；prepare/activation 错误分别显示正确
  文案。
- 成功切换后 session list 和 Git chip 显示 `worktree-<slug>`，所有 worktree Git
  请求同时使用 worktree path 和 target session id。
- BranchPicker 打开后的 branch listing 与 status refresh 都携带 target session
  id；缺少该参数的回归会在 daemon 返回 `invalid_cwd` 前被参数断言捕获。

### 11.4 浏览器 E2E

1. 在 trusted Git workspace 完成两个 turn，从第一个 Assistant response 选择
   New worktree。
2. 验证新 session transcript 截止于所选 response，源 session 未变化。
3. 验证新 session 的 `workspaceCwd` 是原 workspace、`currentCwd` 是 worktree，
   session picker 只在原 workspace 下列出它。
4. 在新 session 修改文件，验证原 checkout 不变；Git diff/commit 只针对
   worktree。
5. 验证 worktree HEAD 来自分支请求时的当前 HEAD，而不是所选 response 的时间
   点。
6. `/cd` 到另一个 Git repo 后验证选项隐藏且伪造请求被拒绝。
7. 注入 worktree create、fork、load 和 cd 失败，核对第 8.5 节的 commit-point
   语义。

## 12. 被否决的方案

### Client 先创建 worktree session，再调用 branch

会先暴露空 session，且无法把 durable checkpoint fork 原子导入已存在 target
id；客户端断线时两个请求也没有共同事务 owner。

### 先发布 branch transcript，再创建 worktree

session picker 会看到缺失 worktree sidecar 的 target；如果 worktree 创建失败，
用户得到的 session 与所选隔离语义不一致。

### 把 worktree path 当作新 workspace 注册

这会把会话列表和持久化拆到 worktree scope，违反 Issue 要求，也把执行目录
错误提升为 runtime ownership root。

### 在 Core 中新增另一套 worktree-aware fork

Branch checkpoint、历史裁剪和原子 transcript publication 已由
`SessionService.forkSession()` 完整负责。Part 2 只需在它的 commit point 外围
准备和激活执行环境；复制 Core fork 会产生两套一致性规则。
