# Web Shell Worktree 会话：对齐 Codex

[English](2026-11-14-web-shell-codex-worktree-parity.md) | [简体中文](2026-11-14-web-shell-codex-worktree-parity.zh-CN.md)

## 状态与范围

P1–P5 已实现（本 PR）；P6–P7 计划后续。Web Shell 会话完整对齐 Codex 托管
worktree，按有序阶段（P1–P7）交付。每个阶段可独立发布；终态与下文 Codex
参考行为一致。P3 的 detached-HEAD
重构属于 maintainer 发起的核心改动，豁免外部 PR 两级门禁，但仍遵循通用设计
与自审流程。

参考基线：`.repro-runs/web-shell-default-worktree/codex-reference.md`
（本地、git 忽略）。开发机未安装 Codex，参考事实取自 Codex 官方文档
（https://learn.chatgpt.com/docs/environments/git-worktrees）的逐字引用，
而非本地 trace。后续可安装 Codex 补跑嵌套捕获做 trace 级对齐。

## 问题与现状

Web Shell 在受信任的 Git workspace 中新建会话时缺省使用当前分支
（`gitModeIntent = { mode: 'current' }`，`packages/web-shell/client/App.tsx`）。
Worktree 隔离需要在 composer 的 Git 模式弹层里显式选择；首条消息随后向
`POST /session` 发送 `worktree: {}`，调用
`GitWorktreeService.createUserWorktree`，从当前分支 HEAD 创建
`<repo>/.qwen/worktrees/<slug>`，落在**命名分支** `worktree-<slug>` 上。

与 Codex 的差距：

| Codex 行为                                                  | 当前 Web Shell                                                                   | 差距                                        |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------- |
| Git 仓库中新 chat 缺省使用托管 worktree                     | 缺省当前分支；worktree 需显式选择                                                | 翻转缺省值；加 settings 开关                |
| 未提交的本地改动一并应用到 worktree                         | 会话 worktree 仅从 HEAD 起步；dirty 状态留在源检出                               | 会话 worktree 创建时携带 dirty 状态         |
| worktree 为 detached HEAD，不污染分支                       | 每会话一个命名分支 `worktree-<slug>`                                             | 贯穿 worktree 生命周期的 detached-HEAD 重构 |
| chat 头部「Create branch here」                             | 无专用入口（分支选择器可在 worktree 内 checkout）                                | 新路由 + UI                                 |
| 「Hand off」在 worktree 与本地检出之间移动 chat             | `worktree-reset` 是会话间检出所有权转移（channel restore），不是 worktree↔local | 新 handoff 能力                             |
| 保留最近 15 个托管 worktree；归档时先快照再删除；重开可恢复 | 无按数量保留；显式删除时清理，另有孤儿/机龄清扫                                  | 保留策略 + 快照/恢复                        |
| worktree 根目录可在设置中配置                               | 硬编码 `<repo>/.qwen/worktrees`（含身份校验）                                    | 新设置 + 包含性校验改造                     |
| composer 可手动选 Local / Worktree                          | Git 模式弹层已提供 current / branch / worktree                                   | 复用                                        |

非 Git workspace 在所有阶段均不受影响（Codex：「In non-version-controlled
projects, scheduled tasks run directly in the project directory」）。

## Codex 参考行为（逐字事实）

1. 「By default, chats use a Codex-managed worktree.」
2. 「Codex creates worktrees in `$CODEX_HOME/worktrees`.」根目录可在
   Settings > Worktrees 配置。
3. 「The starting commit is the `HEAD` commit of the branch selected when you
   start your chat. If you chose a branch with local changes, Codex applies
   the uncommitted changes to the worktree as well.」
4. 「The worktree isn't checked out as a branch. It's in a detached HEAD state.
   This lets Codex create several worktrees without polluting your branches.」
5. 「…turn your worktree into a branch using the Create branch here button in
   the chat header.」随后可 commit / push / 开 PR。
6. 「…select Hand off in the chat header and move it to Local. Codex handles
   the Git steps required to move the chat safely between the worktree and
   your local checkout.」
7. 「By default, Codex keeps your most recent 15 Codex-managed worktrees.」
   自动删除跳过置顶 chat 与进行中 chat；归档 chat 会删除其 worktree；删除前
   保存快照，重开 chat 时提供恢复。
8. 文档未描述关闭缺省行为的开关；Qwen Code 按明确的产品要求在
   `settings.json` 中提供。

## 目标行为

- 受信任 Git workspace 中的新 Web Shell 会话缺省在托管 worktree 中启动。
  首条消息前 composer chip 显示 worktree 模式；用户可恢复当前分支（现有 ✕
  控件）或选择命名分支。首条消息发送前不创建任何东西。
- `settings.json` 可关闭缺省（`worktree.defaultForNewSessions`，缺省
  `true`）、设置保留上限（`worktree.maxRetained`，缺省 `15`，`0` 关闭按数量
  自动删除）、选择 worktree 根目录（`worktree.root`，缺省相对仓库顶层的
  `.qwen/worktrees`）。
- worktree 从源检出的 HEAD 起步，携带其未提交改动（tracked 的 staged +
  unstaged，以及 untracked 文件），处于 detached HEAD。
- chat 头部提供「Create branch here」（detached → 命名分支）与「Hand off」
  （worktree ↔ 本地检出）。
- 归档/删除会话时先快照其 worktree 的工作再删除；重开 chat 提供恢复。保留
  清扫保留最近 N 个 worktree，绝不触碰活跃或置顶会话。

## 关键设计决策

### D1 — 缺省值落在 Web Shell composer，而非 daemon API

不带 `worktree` 的 `POST /session` 保持现有语义（在 workspace 目录运行）。
缺省值施加在 Codex 施加它的地方：产品表面。客户端在 workspace 合格
（受信任 + 存在 Git 分支）且生效设置为 `true` 时，把 `gitModeIntent` 初始化
为 `{ mode: 'worktree' }`。SDK、channel、managed-session 调用方保持显式控制；
wire 语义不变。

设置经现有 workspace-settings 路由到达（`getAllowedKeys` →
`buildSettingsResponse`，消费形式为
`workspaceSettings.find(key)?.values.effective`）。由于设置异步加载，缺省值
在设置答案到达且意图未被触碰时施加；用户的显式选择始终优先，现有意图重置
守卫（切换 workspace、不受信任、非 Git）继续负责清除。

### D2 — 设置放在现有 `worktree` 段

`packages/cli/src/config/settingsSchema.ts` 已有顶层 `worktree` 段
（目前只有 `symlinkDirectories`）。新键：

| 键                               | 类型    | 缺省              | 阶段 | 含义                                                       |
| -------------------------------- | ------- | ----------------- | ---- | ---------------------------------------------------------- |
| `worktree.defaultForNewSessions` | boolean | `true`            | P1   | 受信任 Git workspace 的新 Web Shell 会话缺省 worktree 模式 |
| `worktree.maxRetained`           | number  | `15`              | P6   | 每仓库保留的最近托管 worktree 数；`0` 关闭按数量自动删除   |
| `worktree.root`                  | string  | `.qwen/worktrees` | P7   | worktree 根目录，相对仓库；拒绝绝对路径与 `..` 逃逸        |

三个键都向 Web Shell 暴露（`showInDialog: true` 或 `WEB_SHELL_SETTINGS`
允许列表），user 与 workspace 作用域均可写。段描述更新为涵盖 Web Shell
会话 worktree。

### D3 — dirty 携带复用已验证的 overlay，不做 baseline commit

`setupWorktrees` 已实现该 overlay：在源仓库 `git stash create`（只读）、
在 worktree 中 `git stash apply <snapshot>`、复制
`git ls-files --others --exclude-standard` 文件，每步 fail-open。
P2 将其抽为共享的 `captureDirtyState` / `applyDirtyState` helper，并通过
`createUserWorktree` 的可选参数（`carryDirtyState`）在会话 worktree 创建
路径调用，`enter_worktree` 与 agent 隔离调用方保持现有行为。捕获用
`--full-name` 列出 untracked 文件并从仓库顶层复制，因此根在子目录的服务
仍能把文件放到 worktree 的正确偏移（抽取前的模式会放错位置）。

与 `setupWorktrees` 不同，会话路径**不**创建 baseline commit：Codex 以
未提交状态应用改动，Changes 视图原样呈现用户已有的改动。这也让 detached
HEAD 停在冻结的 base commit 上，供清理与 handoff 逻辑依赖。

**与 cleanliness 门的交互（已核实）。** 以未提交状态携带 dirty 会让
`worktreeHasWork` 与 `removePreparedUserWorktree` 的 `isClean` 门看到工作，
因此显式删除会话时会保留 worktree 而非删除。这是安全的中间态：只保留、
不丢失，worktree 在 Worktrees 管理器中可见。P6 以 Codex 的方式解决——
对托管会话 worktree 用「先快照再删除」取代 cleanliness 拒绝，归档时先归档
工作再删除检出。刻意不用 baseline commit：它会让 HEAD 越过冻结的 base
commit，破坏 P3 引入的 HEAD 等值门（正是普查指出的
`removePreparedUserWorktree` tip 检查的同一冲突）。

### D4 — detached HEAD 是托管 worktree 的形态；元数据携带 slug

`createUserWorktree` 增加可选 detached 模式：`git worktree add --detach
<path> <base>`，不建分支。只有 Web Shell 会话路由请求它；`enter_worktree`、
agent 隔离、workflow、`--worktree` 启动继续创建命名分支，因此**两种形态
永久共存**，每个消费方都必须容忍两者。

**detached 约定是 `branch: ''`（空字符串），不是 `undefined`。**
已核实的硬约束：sidecar 校验器（`worktreeSessionService.ts:100-118`）要求
`typeof worktreeBranch === 'string'`；branch 写 `undefined` 会让 sidecar
被判 corrupt，而 `restoreWorktreeContext` 会删除 corrupt sidecar——整条
恢复链都会断。`''` 通过校验，保持 SDK `DaemonWorktreeInfo.branch: string`
形状不变，流经 bridge（纯透传，无 git 语义）无需类型改动。展示面以 slug
配合现有 detached 指示器显示（`GitBranchIndicator` 已能渲染 git status 的
`detached`）；恢复上下文消息在空串时省略 `(branch: …)` 片段。「Create
branch here」就地填充真实分支名并更新 sidecar 与在线元数据。

完整消费方清单（所有读取 `worktreeBranchForSlug`、`WORKTREE_BRANCH_PREFIX`
或元数据 `branch` 字段的站点）列于下文 P3 节。清单中的每个消费方都在 P3
迁移——不允许半迁移的消费方发布。硬编码 `.qwen/worktrees` 根的站点在那里
列出供参考，但在 P7 迁移，不在 P3。

### D5 — 「Create branch here」是会话级 mutation

新路由 `POST /session/:id/worktree-branch`，携带 `{ name }`：用与 branch
会话相同的谓词校验分支名（共享 `isValidGitBranchName`），worktree 已有分支
（`worktree_already_branched`）或名字已存在（`branch_already_exists`）时
拒绝，经 `GitWorktreeService.createWorktreeBranch` 在 worktree 内执行
`git switch -c <name>`，在 worktree 键控所有权锁下更新 sidecar 与在线
bridge 元数据（marker 只存所有者 id，无需变更）。会话解析对持久化 id 经
transcript 存储归一化，对尚无 transcript 的新建会话回退到 bridge 在线
summary（用户可以在首条 prompt 前就建分支）。能力标志：
`session_worktree_branch_v1`。UI 入口是分支选择器弹层（worktree chip 的
菜单）中的「在此创建分支」项，带内联名称输入；仅当弹层服务于 detached
worktree 会话（`gitSessionId` + 拉取到的 `detached` 状态）且 daemon 声明
该能力时可见。

### D6 — Handoff 移动会话并携带工作

单路由 `POST /session/:id/worktree-handoff`，携带
`{ to: 'local' | 'worktree', name?: string }`，保持同一会话 id（Codex 移动
的是 chat，不是替代会话）。迁移用 bridge 的 `changeSessionCwd` 作用于在线
会话——它排在在途 prompt 之后、prompt 活跃时拒绝——全程持 worktree 键控
所有权锁。能力标志：`session_worktree_handoff_v1`。

- **Worktree → Local**（`to: 'local'`）：本地检出（`sidecar.originalCwd`）
  不干净时拒绝（`local_checkout_dirty`）。先携带工作：命名 worktree 分支在
  本地检出 checkout；detached 且有超出 base 的 commit 时先建分支（`name`，
  否则 `worktree-<slug>`）；detached 停在 base 且无工作则不携带。先 detach
  worktree 释放分支——git 禁止同一分支同时在两个 worktree 检出。worktree
  的未提交改动以 `git stash create` 快照在 checkout 后应用于本地检出。然后
  把会话 cwd 迁回本地检出，清除 sidecar 与 bridge worktree 关联，worktree
  目录（连同 marker）留给保留清理（P6）或手动删除。
- **Local → Worktree**（`to: 'worktree'`）：会话已有 worktree sidecar 时
  拒绝。从本地 HEAD 创建 detached 托管 worktree 并施加 dirty overlay（D3），
  写 sidecar + marker，把会话迁入，设置 bridge worktree 元数据。迁移失败时
  回滚新建的 worktree、sidecar、marker。本地检出保持原样。

v1 限制（成文而非静默）：以「本地干净」要求代替「无其他活跃会话占用本地
检出」（bridge 无会话列表探针可查占用）；handoff 不实现 `worktree-reset`
的崩溃窗口原子回滚——中途崩溃留下可恢复形态（sidecar/marker 仍命名该会话，
worktree 管理器可见该检出），而非自愈转移。

### D7 — 快照是工作归档，恢复重建 worktree

托管 worktree 被删除前（归档/删除触发或保留清扫），保存快照：worktree 树的
tar.gz，排除可再生目录（与 `worktreeHasWork` 相同的豁免集：`node_modules`、
构建输出），外加小型 JSON 头（base commit、HEAD commit、分支（如有）、
dirty 状态摘要、会话 id、时间戳）。快照存放在会话 chats 目录 sidecar 旁，
按会话 id 键控。

重开 worktree 已删除的 chat 时提供恢复：重建 worktree（detached 于记录的
HEAD，或在记录的分支上），把快照解压覆盖，翻回 sidecar。保留策略保护活跃
会话与置顶 chat 的 worktree；清扫按最近活动排序，超出
`worktree.maxRetained` 时从最旧开始删除，逐个先快照。

## 分阶段实现

### P1 — 缺省 worktree + settings 开关 — 已实现

- Schema：新增 `worktree.defaultForNewSessions`（D2）；向 Web Shell 暴露。
- 客户端：按 D1 初始化/施加缺省意图；发送前 chip 显示 worktree 模式；现有
  重置/分支控件不变。
- i18n：必要时更新 `gitMode.worktreeDesc`；不新增确认步骤。
- 测试：schema/校验、设置路由暴露、composer 缺省（开关开/关、异步到达、
  显式选择优先——含挺过 transient git-status 失败、重置后不再施加、切换
  workspace 重置、非 Git/不受信任不合格）。显式选择标记在 draft 边界
  （session id / 活跃 workspace 变化）清除，不在 transient 资格掉落时清除。
- 验收：无设置时，受信任 Git workspace 的新会话首条消息发送 `worktree: {}`；
  `worktree.defaultForNewSessions: false` 时不带 worktree 参数；显式选择
  行为与今天一致。

### P2 — 会话 worktree 的 dirty 携带 — 已实现

- Core：从 `setupWorktrees` 抽出 `captureDirtyState` / `applyDirtyState`
  helper（那里保留 capture-once 语义）；`createUserWorktree` 增加
  `carryDirtyState` 选项（D3）。会话路径不做 baseline commit。
- 路由：两个会话 worktree 创建点都传入该选项——`POST /session`
  （`session.ts:3388`）与 branch-worktree 准备路由（`session.ts:5172`）。
- 测试：`gitWorktreeService.dirty-carry.integ.test.ts`（真实 git 夹具，
  symlinks-integ 模式）——三态 dirty 携带、源检出与 index 不被触碰、HEAD
  停在 base、选项关闭 = 现状、悬空符号链接复制失败 fail-open。
- 验收：从 dirty 检出启动会话 worktree，agent 看到与用户磁盘上一致的文件。
- 已知限制（嵌套场景）：branch-worktree 路由从 `base.repoTop`（主检出）
  捕获 dirty。已处于 worktree 中的会话因此携带的是主检出的 dirty 而非自身
  的；两者 HEAD 不同时 stash apply fail-open 退化为已提交状态（不丢失）。
  P3 的 detached 重构重新审视该路由的捕获源。

### P3 — Detached HEAD（核心重构）— 已实现

- `createUserWorktree` 可选 detached 模式（D4）；会话路由使用它。
- 迁移下文清单中的每个消费方（sidecar、marker、reset、清理/分支终结、
  journal 身份校验、恢复提示词、Web Shell 展示、TUI footer 指示器）。
  SDK wire 类型不变（`branch: string`，`''` = detached）。
- 清理：分支终结变为 commit 终结——detached worktree 若无超出 base 的
  commit 且无工作则可删除；有独有 commit（按 HEAD 可达性判定，范本
  `workspace-git-worktrees.ts`）或工作则保留（P6 的快照路径）。detached
  删除时 `branchPreserved` 报告 `false`（没有分支可保留）。
- 测试：逐消费方迁移测试；detached 形态的 journal 恢复；detached 形态的
  reset/restore；命名分支 worktree 仍可用（两种形态处处容忍）。
- 验收：新会话 worktree 无分支（`git branch --list 'worktree-*'` 不变）；
  所有生命周期操作在其上可用；现有命名分支的工具/agent worktree 不受影响。

**消费方清单**（2026-11-14 代码普查，承重声明已逐条回源核实；每项必须在
P3 迁移或显式容忍）。约定：detached 会话 worktree 携带 `branch: ''`；
命名分支 worktree（工具、agent、启动）不变。

A. 创建与元数据生产者

| 站点                                                                                                                              | 现状                                                                     | P3 迁移                                                              |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `core/services/gitWorktreeService.ts:2487-2543` `createUserWorktree`                                                              | `-b worktree-<slug>`；同名分支拒绝；`WorktreeInfo.branch`                | 可选 detached 模式（`--detach`）；分支拒绝仅限命名模式；`branch: ''` |
| `cli/serve/routes/session.ts:3388-3400` POST /session                                                                             | 透传 `worktree.branch`                                                   | 请求 detached 模式；`worktreeMeta.branch = ''`                       |
| `cli/serve/routes/session.ts:5166-5215` branch-worktree 路由                                                                      | journal `worktreeBranch = worktreeBranchForSlug(slug)`；sidecar 取自结果 | journal + sidecar 携带 `''` 约定                                     |
| `cli/startup/worktreeStartup.ts:342,528`                                                                                          | 命名创建（保留）                                                         | 重附着 detached 检出时 sidecar 写入容忍 `''`                         |
| `core/tools/enter-worktree.ts:164,200-229`；`core/tools/agent/agent.ts:3569`；`core/agents/runtime/workflow-orchestrator.ts:1819` | 命名创建（保留）                                                         | 创建不变；`''` 时面向用户/模型的文案不得声称有分支                   |

B. 生命周期门（风险最高——漏掉即 fail-closed 泄漏）

| 站点                                                                           | 现状                                                                 | P3 迁移                                                                                                                     |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `gitWorktreeService.ts:3122-3131` `checkoutMatches`                            | `HEAD == base && branch == worktree-<slug>`                          | `HEAD == base`；分支等值仅限命名模式                                                                                        |
| `gitWorktreeService.ts:3193-3207` tip 检查（×2）                               | `for-each-ref refs/heads/worktree-<slug>` tip `== base`              | detached：由 HEAD 等值覆盖；命名：不变                                                                                      |
| `gitWorktreeService.ts:3262-3287` `finalizePreparedUserWorktreeBranch`         | tip null → no-op；否则 `branch -d`                                   | 已容忍（无分支 → no-op）；保留                                                                                              |
| `gitWorktreeService.ts:2990-3047` `removeUserWorktree`                         | `-d`/`-D worktree-<slug>`；`branchPreserved`                         | detached：跳过分支删除，`branchPreserved: false`（无分支可保留）；命名：不变                                                |
| `gitWorktreeService.ts:3296-3330` `hasUnmergedWorktreeCommits`                 | `rev-parse worktree-<slug>`，出错 fail-closed `true`                 | detached：按 HEAD 可达性判定——范本 `cli/serve/routes/workspace-git-worktrees.ts:714-725`（`commitIsReachable`）；命名：不变 |
| `cli/serve/server/worktree-orphan-cleanup.ts:427-469` `executeWorktreeCleanup` | `worktreeHasWork` 门 + `removeUserWorktree` + `branchPreserved` 日志 | P3 门不变（dirty 工作保留，见 D3）；日志容忍无分支；P6 快照解除该门                                                         |
| `cli/serve/branch-worktree-preparation.ts:436` journal 身份                    | `worktreeBranch === worktreeBranchForSlug(slug)`                     | 在命名形式之外接受 `''` detached 约定                                                                                       |
| `cli/startup/worktreeStartup.ts:250-282` 重附着                                | 期望分支；null → 「Worktree already exists」                         | `getRegisteredWorktreeBranch` 将 detached 报告为 `{branch: '', headCommit}`（保留身份校验）；重附着接受 `''`                |

C. Sidecar、恢复与展示

| 站点                                                                                                                                                  | 现状                               | P3 迁移                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | --------------------------------------- |
| `core/services/worktreeSessionService.ts:100-118` 校验器                                                                                              | `worktreeBranch: string` 必填      | 形状不变；`''` 约定成文                 |
| `worktreeSessionService.ts:913` 恢复上下文消息                                                                                                        | `"(branch: …)"` 注入模型提示词     | `''` 时省略该片段（或写 detached HEAD） |
| `cli/serve/server/session-restore.ts:243,401`；`session-list.ts:501`                                                                                  | 透传至 `setSessionWorktree` / 响应 | 容忍 `''`                               |
| `cli/serve/routes/session.ts:4500,4550,4663` worktree-reset                                                                                           | 读 sidecar branch                  | 容忍 `''`                               |
| `cli/nonInteractiveCli.ts:1668`；`cli/ui/AppContainer.tsx:1124`；`cli/ui/opentui/opentui-app-shell.tsx:1097`；`cli/ui/hooks/useWorktreeSession.ts:53` | 分支展示                           | `''` 时显示 slug / detached 指示器      |

D. 已核实容忍（无需改动）

- `core/agents/worktree-pin.ts:127-131` — 已 detached 友好（范本）。
- `cli/serve/routes/session-pr-backfill.ts:81-97,576` — slug 优先的 PR
  解析；仅失去改名分支兜底。
- `sdk-typescript DaemonSessionClient.ts:898-928` — durable 身份只比
  `worktree.path`。
- `acp-bridge/session-control-plane.ts` — 纯透传，无 git 语义。
- `workspace-git-worktrees.ts:714-725` — 已 detached 感知。
- `branch-worktree-preparation.ts:709` `resolveBranchWorktreeBaseCheckout` —
  `getCurrentBranch().catch(() => 'HEAD')` 已容忍 detached 基座。
- 30 天 agent 清扫（`core/services/worktreeCleanup.ts`）只匹配
  `agent-<7hex>` slug，POST /session 拒绝该形状——会话 worktree 永远不会
  被它扫到。

E. 钉住分支契约的测试（P3 更新）

- `core/tools/enter-worktree.test.ts:108-115`（前缀契约）
- `core/tools/exit-worktree.test.ts:258,299,310,423,458`
- `core/services/git-worktree-marker.test.ts:431`
- `cli/serve/branch-worktree-preparation.test.ts`

硬编码 `.qwen/worktrees` 根站点（P7 迁移，此处供参考）：
`gitWorktreeService.ts:1936-1945,3069-3075`；`core/config.ts:5006`；
`worktreeSessionService.ts:647,832`；`core/utils/workspace-artifact-directory.ts:58`；
`core/utils/workspace-artifact-path.ts:12,30`；`core/tools/enter-worktree.ts:84`；
`core/tools/exit-worktree.ts:546-551`；`session.ts:3653,3665,5263,4173`；
`branch-worktree-preparation.ts:434,696,735-745`；
`workspace-route-runtime.ts:698`；`worktree-orphan-cleanup.ts:198,202`；
`session-restore.ts:192,327`。daemon shell 守卫
（`daemon-git-worktree-guard.ts:3288-3331`）今天无需根豁免，因为
`.qwen/worktrees` 在会话根内；P7 必须为自定义根重新推导该性质。

### P4 — Create branch here — 已实现

- 路由 `POST /session/:id/worktree-branch`（D5）；SDK
  `createWorktreeBranch`；分支选择器菜单项 + 内联名称输入。
- 测试：路由套件（成功 + 400/409 分类 + 404）、core
  `createWorktreeBranch` 用例、弹层可见性/提交/校验用例。
- 验收：detached worktree 会话 → 点击 → 命名分支，chip 更新，commit/push
  流程可用。

### P5 — Handoff — 已实现

- 按 D6 的路由 + git 过程；SDK 方法；chat 头部入口。
- 测试：两个方向、dirty/commit 携带、干净检出拒绝、并发会话拒绝、锁串行、
  sidecar supersedes。
- 验收：chat 在 worktree↔local 之间移动且工作完整；git 步骤由系统处理，
  不留给用户。

### P6 — 保留策略 + 快照/恢复

- 按 D7 的快照/恢复；`worktree.maxRetained` 设置；归档/删除触发；保留清扫；
  重开时的恢复入口。
- 对托管会话 worktree，「先快照再删除」取代 cleanliness 拒绝
  （`worktreeHasWork` / `isClean` 门）：携带的 dirty 状态不再阻塞删除，因为
  快照已保留它（D3）。工具/agent worktree 保留现有拒绝语义。
- 测试：快照内容/排除项、恢复保真（commit + dirty + untracked）、活跃/置顶
  保护、数量排序、`0` 关闭、dirty worktree 快照后删除。
- 验收：归档 chat 先快照再删除其 worktree；重开提供恢复；清扫保留最近 15 个。

### P7 — 可配置 worktree 根目录

- `worktree.root` 设置；把硬编码 `.qwen/worktrees` 站点迁移到解析后的根；
  为自定义根重新推导包含性与 shell-guard 规则（安全敏感：daemon shell
  guard、journal 身份校验、reset 包含性都以托管根为键）。
- 测试：自定义根的创建/身份/恢复；逃逸拒绝；缺省根不变。
- 验收：worktree 位于配置的根下；所有守卫跟随。

## 范围边界

- 不改变未显式 opt-in 调用方的 `POST /session` wire 语义。
- 不改变 `enter_worktree` / `exit_worktree` 工具行为、agent 隔离 worktree、
  Arena worktree（它们保留命名分支；Codex 对齐的目标是 Web Shell 会话
  worktree）。
- 不改变 managed（服务端）会话自己的 worktree 设计
  （`2026-10-28-managed-session-worktrees.md`）；那里的对齐是后续工作。
- Branch 模式会话（`branch: { name }`）不变。
- 除 handoff 外不做 merge-back UI；PR 创建留在现有 git 流程。

## 风险与开放问题

- **P3 影响面**：普查已完成（上文清单）。风险最高的站点是 fail-closed 门，
  漏掉会静默泄漏或永久保留 detached worktree：`removePreparedUserWorktree`
  的分支/tip 双门、`hasUnmergedWorktreeCommits`（fail-closed `true`）、
  sidecar `worktreeBranch: string` 校验器、`--worktree` 重附着、journal
  身份门。漏掉的消费方是静默的生命周期失败，因此 P3 随附逐消费方迁移测试。
- **中间态分支污染**：P1–P2 先于 P3 发布，缺省开启的会话会临时创建
  `worktree-<slug>` 分支（会话清理时删除）。可接受的中间态；P3 消除它。
- **dirty 携带 × cleanliness 门**：从 P2 到 P6 之间，携带 dirty 的会话
  worktree 在显式删除会话时被保留（而非删除），因为 `worktreeHasWork`/
  `isClean` 看到工作。安全（不丢失）但 worktree 会留在 Worktrees 管理器里；
  P6 的「先快照再删除」解决它。见 D3。
- **dirty overlay 冲突**：`stash apply` 在 worktree base 与源 HEAD 不同
  时可能冲突（实际相同——同一 commit——但本地 index 状态仍可能不同）。
  按现有模式 fail-open；会话以已提交状态启动并暴露失败。
- **本地检出 dirty 时的 Handoff**：拒绝（D6）。Codex 此处行为未见文档；
  拒绝是安全解读。
- **快照体积**：排除可再生目录使归档保持小，但含大 tracked 二进制的仓库
  仍会产生大快照。v1 不设体积上限；必要时再议。
- **自定义根安全（P7）**：每个包含性校验必须跟随配置的根；workspace 信任
  边界之外的根被拒绝。

## 验证

- 逐阶段单测（collocated）加
  `.qwen/e2e-tests/web-shell-codex-worktree-parity.md` 的 E2E 计划。
- 实现前对已安装 `qwen` CLI 做基线 dry-run；实现后对 `node dist/cli.js`
  验证。
- Build + typecheck + bundle、聚焦包测试、按 AGENTS.md 自审。
