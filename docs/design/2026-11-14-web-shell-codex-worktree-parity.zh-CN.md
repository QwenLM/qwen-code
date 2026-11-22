# Web Shell Worktree 会话：对齐 Codex

[English](2026-11-14-web-shell-codex-worktree-parity.md) | [简体中文](2026-11-14-web-shell-codex-worktree-parity.zh-CN.md)

## 状态与范围

P1–P5 已实现（PR #17228）；P6–P7 计划后续。Web Shell 会话完整对齐 Codex 托管
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
（受信任、存在 Git 分支或 detached HEAD、且 HEAD 已出生——`hasHead !== false`，
未出生 HEAD 没有 worktree base）且生效设置为 `true` 时，把 `gitModeIntent`
初始化为 `{ mode: 'worktree' }`。确定的 `hasHead: false` 还会清掉早先省略
该字段的快速状态所武装的意图。SDK、channel、managed-session 调用方保持对
请求的显式控制；`POST /session` 的 `worktree` 契约本身见「范围边界」。

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
`--full-name -z` 列出 untracked 文件（原始 NUL 分隔路径——不带 `-z` 时
git 会对非 ASCII、引号、换行文件名做 C 风格转义，携带会静默丢失它们）
并从仓库顶层复制，因此根在子目录的服务仍能把文件放到 worktree 的正确
偏移（抽取前的模式会放错位置）。仓库顶层无法解析时，跳过 untracked
overlay 并发告警，而非静默丢失每一次复制。

携带把符号链接保留为链接（`lstat` + `readlink` + `symlink`）：`copyFile`
会把文件链接物化成可提交进仓库的仓库外内容，目录链接则 EISDIR 丢失。
tracked 路径捕获用 `stash show --name-only --no-renames -z`，被识别的
重命名给出两侧——apply 后的 overlay 呈现 `A new` 加 ` D old`，回滚豁免
必须同时命名两侧。untracked 列表在仓库顶层（而非服务根）运行，使 overlay
两半即使会话根在子目录也覆盖同一仓库级集合。daemon 自己的簿记名（会话
marker 与其 staged `.tmp` 兄弟）从 untracked 列表过滤，绝不能作为用户
内容被携带。

冲突的三方 `stash apply`（捕获检出的 HEAD 与工作树 base 在同几行分叉）
会写入冲突标记与未合并索引条目；按索引状态检测——simple-git 的 raw 模式
即使非零退出也可能 resolve——并 fail-closed：工作树复位到已提交状态、
创建返回失败，绝不把会话迁进被污染的树。其他任何 apply 失败（如索引不可
写）同样 fail-closed：未落盘的携带绝不能按已携带记录。成文的 fail-open
只保留给干净拒绝——逐文件 untracked 复制跳过无法复制的文件，超 journal
界限的 overlay 整体跳过。untracked 复制绝不覆盖已存在的目标，且只记录
真正新建的路径，回滚只删除携带所添加的——干净门看不到的、预先存在的
git-ignored 文件在携带与其撤销中都存活。

携带界限按调用方而非全局。只有 branch-preparation 路由持久化
`carriedPaths`（journal 读取端拒绝超 64 KiB 的记录），故传入
`maxCarriedPathsBytes = CARRIED_PATHS_MAX_BYTES`（32 KiB）；超界跳过携带
（fail-open 到已提交状态）使 journal 可读回。handoff 与 POST /session 不
写 journal，携带任意大小——在那里静默丢弃大 overlay 会让会话失去用户
的工作。

provisioning 通过仓库的 `info/exclude` 忽略托管 worktrees 目录，而不是
写 `.qwen/.gitignore`：检出里的簿记文件本身就是 untracked 工作，曾让
handoff 的本地干净门拒绝每一个干净仓库、cleanup 的有工作门保留每一个
干净 worktree。`info/exclude` 不新增任何 status 条目；含斜杠的模式锚定
在仓库根，规则按仓库顶层相对计算，根在子目录的服务也能忽略自己的
`.qwen/worktrees`。早期构建写入的、逐字节等于 daemon 生成内容的
`.qwen/.gitignore` 会被移除，用户自行维护的文件原样保留。

与 `setupWorktrees` 不同，会话路径**不**创建 baseline commit：Codex 以
未提交状态应用改动，Changes 视图原样呈现用户已有的改动。这也让 detached
HEAD 停在冻结的 base commit 上，供清理与 handoff 逻辑依赖。

**与 cleanliness 门的交互（已核实）。** 以未提交状态携带 dirty 会让
`worktreeHasWork` 看到工作，因此显式删除会话时会保留 worktree 而非删除。
这是安全的中间态：只保留、不丢失，worktree 在 Worktrees 管理器中可见。
P6 以 Codex 的方式解决——对托管会话 worktree 用「先快照再删除」取代
cleanliness 拒绝，归档时先归档工作再删除检出。prepared worktree 的回滚
（`removePreparedUserWorktree`）则**不能**把 carry 本身当作工作保留：
`createUserWorktree` 返回携带的仓库相对路径，preparation journal 记录之
（`carriedPaths`），回滚的 cleanliness 门精确豁免这些路径——任何其他文件
（嵌套的类 marker 文件名、迟到的被忽略文件）仍拒绝删除。刻意不用 baseline commit：它会让 HEAD 越过冻结的 base
commit，破坏 P3 引入的 HEAD 等值门（正是普查指出的
`removePreparedUserWorktree` tip 检查的同一冲突）。

### D4 — detached HEAD 是托管 worktree 的形态；元数据携带 slug

`createUserWorktree` 增加可选 detached 模式：`git worktree add --detach
<path> <base>`，不建分支。只有 Web Shell 会话路由请求它；`enter_worktree`、
agent 隔离、workflow、`--worktree` 启动继续创建命名分支，因此**两种形态
永久共存**，每个消费方都必须容忍两者。

**detached 约定是 `branch: ''`（空字符串），不是 `undefined`。**
已核实的硬约束：sidecar 校验器（`worktreeSessionService.ts`）要求
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
bridge 元数据。锁内拒绝 superseded sidecar（reset 已把检出移交给替代会话）
并校验 marker 仍命名本会话；marker 本身无需变更，因为所有者不变。会话解析对持久化 id 经
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
所有权锁，并施加与 D5 相同的 superseded-sidecar 与 marker 所有权守卫
（作用于被离开的 worktree）。两个方向还在最前面拒绝繁忙会话
（`cd_while_prompt_active`，与 worktree-reset 同一道门）——门同时读
`hasActivePrompt` 与 `pendingPromptCount`，因为 prompt 在附件解析期间
已准入（计数同步翻转）但 `promptActive` 尚未置位，单靠屏障围不住这个
窗口——并在整个移交期间武装 bridge 的 reset-pending 准入屏障：快照/建分支/checkout 步骤不在
bridge 的 prompt 队列上执行，而队列尾部检查只在队列排空后运行，移交中途
准入的 prompt 否则会在复制之后继续写文件、丢失最后的编辑。屏障武装期间，
sendPrompt、cd、workflow 动作与 goal 控制均 fail-closed
（`worktree_reset_active`，可重试）；屏障在路由 finally 中解除。
worktree-branch 路由带繁忙门（`branch_while_prompt_active`）。能力标志：
`session_worktree_handoff_v1`。

- **Worktree → Local**（`to: 'local'`）：本地检出（`sidecar.originalCwd`）
  不干净时拒绝（`local_checkout_dirty`）。记录 base（`originalHeadCommit`）
  必须与 `originalCwd` 描述同一检出：本地 HEAD 可等于它或为其后代（用户在
  agent 工作期间于本地提交——这正是用 worktree 的常态），以快照叠加其上
  调和；分叉或不可读的本地 HEAD 以 `local_head_moved` 拒绝。后代仅对
  纯快照路径可接受：当要 checkout 分支时（记录的，或在 worktree HEAD 提升
  的），已前移的本地 HEAD 以 `local_head_moved` 拒绝——checkout 会把用户
  自己超出 base 的提交从工作树中删掉。与本地检出冲突
  的快照在还原本地检出后以 `handoff_snapshot_conflict` 拒绝——绝不留下冲突
  标记。无法从 worktree 捕获的快照，或非冲突的应用失败（如索引不可写），
  以 `handoff_carry_failed` 拒绝——这是未能落地的携带，区别于待解决的内容。
  先携带工作：命名 worktree 分支在本地检出 checkout；detached 且有
  超出 base 的 commit 时先建分支（`name`，否则 `worktree-<slug>`）；detached
  停在 base 且无工作则不携带。先 detach worktree 释放分支——git 禁止同一
  分支同时在两个 worktree 检出。worktree 的未提交改动以 `git stash create`
  快照在 checkout 后应用于本地检出。然后把会话 cwd 迁回本地检出，清除
  sidecar 与 bridge worktree 关联，worktree 目录（连同 marker）留给保留清理
  （P6）或手动删除。每条 worktree 创建路径都把 base 分支与 HEAD commit 记入
  sidecar（`originalBranch` / `originalHeadCommit`），并记录 worktree 自身
  创建于哪个 commit（`worktreeBase`；该字段出现前写入的 sidecar 回退读
  `originalHeadCommit`）。当 branch worktree 从住在兄弟托管 worktree 的会话
  创建时两者不同：`originalHeadCommit` 继续描述 `originalCwd` 的检出供
  `local_head_moved` 门使用，而超出 base 的提升判定、`exit_worktree` 与
  孤儿清扫读取 `worktreeBase`。晚期失败回滚：自动分支仅在删除成功时删（否则 sidecar
  继续命名它并重挂 worktree），使重试始终与检出匹配，而非卡死在
  `worktree_branch_mismatch`。worktree HEAD 或记录 base 无法核实时，移交以
  `worktree_handoff_base_unavailable` 拒绝，而不是在工作留在原处时报告成功。
- **Local → Worktree**（`to: 'worktree'`）：sidecar 判定（`valid` 拒绝、
  `invalid` 以 `worktree_reset_invalid_state` 拒绝、仅 `missing` 创建）在
  worktree 键所有权锁内做出，使并发请求不能孤儿化检出。创建 detached 托管
  worktree 并施加 dirty overlay（D3），写 sidecar + marker，把会话迁入，
  设置 bridge worktree 元数据。base 读 workspace 根——即 sidecar 记为
  `originalCwd` 的检出——使 base/cwd 对描述同一检出，回程不会误 409
  `local_head_moved`；cd 进兄弟检出的会话以 workspace HEAD 为其 worktree
  起点（兄弟自己的提交留在兄弟中），dirty 文件仍从会话检出携带。HEAD 不可读
  时以 `worktree_handoff_base_unavailable` 拒绝。迁移失败时回滚按观测状态
  决定：bridge 超时是 caller-facing，排队的 cd 仍可能把会话落入 worktree，
  故路由重读 effective cwd，会话已住在其中时保留检出 + sidecar（按规范
  realpath 路径比较——bridge 报告 realpath 而服务返回原始拼接，符号链接
  的 workspace 根绝不能回滚会话正住在其中的检出）；仅当 cwd
  仍是移交前检出时才删除新建 worktree、sidecar、marker。自动创建的分支名与
  显式名字一样获得类型化 `branch_already_exists` 拒绝；「移入 worktree」动作
  带提示：本地检出保留其 dirty 状态，移交回本地需要本地检出干净。

v1 限制（成文而非静默）：以「本地干净」要求代替「无其他活跃会话占用本地
检出」（bridge 无会话列表探针可查占用）；handoff 不实现 `worktree-reset` 的崩溃窗口原子回滚——中途崩溃
留下可恢复形态（sidecar/marker 仍命名该会话，worktree 管理器可见该检出），
而非自愈转移。绑定到子目录的 daemon 以 `handoff_workspace_occupied` 拒绝
handoff-to-local：`listWorkspaceSessions` 只对绑定的工作区作答，因此无法枚举
不同 `localCwd` 的占用者，路由失败关闭，而非移动一个它无法检查的共享检出。

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
- 漂移守卫：仓库级一致性检查随表面一起迁移——zh-CN 设置覆盖
  （`workspace-settings-i18n.test.ts`）、legacy telemetry 路由计数与目录
  （`telemetry.test.ts`、`telemetry-catalog.test.ts`）、集成 capabilities
  基线（`integration-tests/cli/qwen-serve-routes.test.ts`）。
- 验收：无设置时，受信任 Git workspace 的新会话首条消息发送 `worktree: {}`；
  `worktree.defaultForNewSessions: false` 时不带 worktree 参数；显式选择
  行为与今天一致。

### P2 — 会话 worktree 的 dirty 携带 — 已实现

- Core：从 `setupWorktrees` 抽出 `captureDirtyState` / `applyDirtyState`
  helper（那里保留 capture-once 语义）；`createUserWorktree` 增加
  `carryDirtyState` 选项（D3）。会话路径不做 baseline commit。
- 路由：两个会话 worktree 创建点都传入该选项——`POST /session`
  （`session.ts`）与 branch-worktree 准备路由（`session.ts`）。
- 测试：`gitWorktreeService.dirty-carry.integ.test.ts`（真实 git 夹具，
  symlinks-integ 模式）——三态 dirty 携带、源检出与 index 不被触碰、HEAD
  停在 base、选项关闭 = 现状、悬空符号链接复制失败 fail-open。
- 验收：从 dirty 检出启动会话 worktree，agent 看到与用户磁盘上一致的文件。
- 捕获源（已实现）：branch-worktree 路由传入 `dirtyStateSource:
base.checkoutCwd`，已处于 worktree 中的会话携带自身检出的 dirty 而非主
  检出的；worktree 仍放置在 workspace 的托管根下。handoff `to:'worktree'`
  路径同样如此，并以会话检出记录的 HEAD SHA 作为新 worktree 的 base
  （分支名会在放置仓库中解析，可能落在错误的提交上）。

### P3 — Detached HEAD（核心重构）— 已实现

- `createUserWorktree` 可选 detached 模式（D4）；会话路由使用它。
- 迁移下文清单中的每个消费方（sidecar、marker、reset、清理/分支终结、
  journal 身份校验、恢复提示词、Web Shell 展示、TUI footer 指示器）。
  SDK wire 类型不变（`branch: string`，`''` = detached）。
- 清理：分支终结变为 commit 终结——detached worktree 若无超出 base 的
  commit 且无工作则可删除；有独有 commit（按 HEAD 可达性判定，范本
  `workspace-git-worktrees.ts`）或工作则保留（P6 的快照路径）。契约：
  detached 删除成功返回 `{ success: true }`，`branchPreserved` 不设置
  （没有分支可保留）；拒绝删除返回 `{ success: false, branchPreserved: true }`
  ——此时该标志表示检出本身被保留，而非分支。
  `removeUserWorktree` 另在 detached worktree 携带未合并 commit 时拒绝删除
  本身：命名分支路径的保护来自 `git branch -d` 的拒绝，无分支时它永远不会
  触发，故 detached 路径需要显式守卫（显式 force 删除可退出）。detached
  清理也绝不删除按 slug 推导的 `worktree-<slug>` 分支：检出以
  `worktree add --detach` 创建，该名字的既有 ref 属于用户而非会话。
  （prepared-worktree 的 finalization 已是所有权安全的：`worktree add -b`
  拒绝既有分支，故其随后删除的分支必是 preparation 自己创建的。）
  `--worktree` 启动重附着门继续拒绝外部占用者（含 detached 检出）——启动
  worktree 总是命名分支，会话重附着走 session-restore 而非该参数。
- 测试：逐消费方迁移测试；detached 形态的 journal 恢复；detached 形态的
  reset/restore；命名分支 worktree 仍可用（两种形态处处容忍）。
- 验收：新会话 worktree 无分支（`git branch --list 'worktree-*'` 不变）；
  所有生命周期操作在其上可用；现有命名分支的工具/agent worktree 不受影响。

**消费方清单**（2026-11-14 代码普查，承重声明已逐条回源核实；每项必须在
P3 迁移或显式容忍）。站点以符号名标识，不用行号——行号随每次合并漂移。
约定：detached 会话 worktree 携带 `branch: ''`；命名分支 worktree（工具、
agent、启动）不变。

A. 创建与元数据生产者

| 站点                                                                                                        | 现状                                                                     | P3 迁移                                                              |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `core/services/gitWorktreeService.ts` `createUserWorktree`                                                  | `-b worktree-<slug>`；同名分支拒绝；`WorktreeInfo.branch`                | 可选 detached 模式（`--detach`）；分支拒绝仅限命名模式；`branch: ''` |
| `cli/serve/routes/session.ts` POST /session                                                                 | 透传 `worktree.branch`                                                   | 请求 detached 模式；`worktreeMeta.branch = ''`                       |
| `cli/serve/routes/session.ts` branch-worktree 路由                                                          | journal `worktreeBranch = worktreeBranchForSlug(slug)`；sidecar 取自结果 | journal + sidecar 携带 `''` 约定                                     |
| `cli/startup/worktreeStartup.ts` 命名创建                                                                   | 命名创建（保留）                                                         | 此处不创建 detached；启动 worktree 保持命名                          |
| `core/tools/enter-worktree.ts`；`core/tools/agent/agent.ts`；`core/agents/runtime/workflow-orchestrator.ts` | 命名创建（保留）                                                         | 创建不变；`''` 时面向用户/模型的文案不得声称有分支                   |

B. 生命周期门（风险最高——漏掉即 fail-closed 泄漏）

| 站点                                                                         | 现状                                                                 | P3 迁移                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gitWorktreeService.ts` `removePreparedUserWorktree` `checkoutMatches`       | `HEAD == base && branch == worktree-<slug>`                          | `HEAD == base`；分支等值仅限命名模式                                                                                                                                                                                                                                                                                                                                  |
| `gitWorktreeService.ts` `removePreparedUserWorktree` `atBase` tip 检查（×2） | `for-each-ref refs/heads/worktree-<slug>` tip `== base`              | detached：由 HEAD 等值覆盖；命名：不变                                                                                                                                                                                                                                                                                                                                |
| `gitWorktreeService.ts` `finalizePreparedUserWorktreeBranch`                 | tip null → no-op；否则 `branch -d`                                   | journal 推导 `branchOwned`：命名 preparation 拥有其分支（`worktree add -b` 拒绝既有名）；detached preparation 绝不删除按 slug 推导的 ref                                                                                                                                                                                                                              |
| `gitWorktreeService.ts` `removeUserWorktree`                                 | `-d`/`-D worktree-<slug>`；`branchPreserved`                         | detached：HEAD 携带自身未合并 commit 时拒绝删除（force 可退出）；给定创建 `baseCommit` 时，HEAD 停在/落后 base 即无 agent 工作，即使 base 不被任何分支可达。所有权显式（命名创建传 `branchOwned`，即使检出移走也证明拥有 slug ref）或按当前分支推断（detached/就地建分支从不拥有）。报告 `deletedBranch`/`keptBranch`，调用方陈述实际发生的事，绝不按 slug 名推断删除 |
| `gitWorktreeService.ts` `hasUnmergedWorktreeCommits`                         | `rev-parse worktree-<slug>`，出错 fail-closed `true`                 | 按检出自身 HEAD tip 与实际分支判定（`--abbrev-ref HEAD` → `ownRef`），从 `for-each-ref --contains <tip> refs/heads refs/remotes` 中排除该 ref；检出不可读时回退 slug ref。detached 与就地建分支的 worktree 同样覆盖                                                                                                                                                   |
| `cli/serve/server/worktree-orphan-cleanup.ts` `executeWorktreeCleanup`       | `worktreeHasWork` 门 + `removeUserWorktree` + `branchPreserved` 日志 | P3 门不变（dirty 工作保留，见 D3）；detached 删除被拒时重察文件系统并记录保留；P6 快照解除该门                                                                                                                                                                                                                                                                        |
| `cli/serve/branch-worktree-preparation.ts` journal 身份                      | `worktreeBranch === worktreeBranchForSlug(slug)`                     | 在命名形式之外接受 `''` detached 约定                                                                                                                                                                                                                                                                                                                                 |
| `cli/startup/worktreeStartup.ts` `setupStartupWorktree` 重附着门             | 期望分支；null → 「Worktree already exists」                         | `getRegisteredWorktreeBranch` 将 detached 报告为 `{branch: '', headCommit}`；门继续拒绝不在 `worktree-<slug>` 上的任何占用者（含 detached）——会话重附着走 session-restore 而非该参数                                                                                                                                                                                  |

C. Sidecar、恢复与展示

| 站点                                                                                                                                          | 现状                               | P3 迁移                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | --------------------------------------- |
| `core/services/worktreeSessionService.ts` 校验器                                                                                              | `worktreeBranch: string` 必填      | 形状不变；`''` 约定成文                 |
| `worktreeSessionService.ts` 恢复上下文消息                                                                                                    | `"(branch: …)"` 注入模型提示词     | `''` 时省略该片段（或写 detached HEAD） |
| `cli/serve/server/session-restore.ts`；`session-list.ts`                                                                                      | 透传至 `setSessionWorktree` / 响应 | 容忍 `''`                               |
| `cli/serve/routes/session.ts` worktree-reset                                                                                                  | 读 sidecar branch                  | 容忍 `''`                               |
| `cli/nonInteractiveCli.ts`；`cli/ui/AppContainer.tsx:1124`；`cli/ui/opentui/opentui-app-shell.tsx:1097`；`cli/ui/hooks/useWorktreeSession.ts` | 分支展示                           | `''` 时显示 slug / detached 指示器      |

D. 已核实容忍（无需改动）

- `core/agents/worktree-pin.ts` — 已 detached 友好（范本）。
- `cli/serve/routes/session-pr-backfill.ts` — slug 优先的 PR
  解析；仅失去改名分支兜底。
- `sdk-typescript DaemonSessionClient.ts` — durable 身份只比
  `worktree.path`。
- `acp-bridge/session-control-plane.ts` — 纯透传，无 git 语义。
- `workspace-git-worktrees.ts` — 已 detached 感知。
- `branch-worktree-preparation.ts` `resolveBranchWorktreeBaseCheckout` —
  `getCurrentBranch().catch(() => 'HEAD')` 已容忍 detached 基座。
- 30 天 agent 清扫（`core/services/worktreeCleanup.ts`）只匹配
  `agent-<7hex>` slug，POST /session 拒绝该形状——会话 worktree 永远不会
  被它扫到。

E. 钉住分支契约的测试（P3 更新）

- `core/tools/enter-worktree.test.ts`（前缀契约）
- `core/tools/exit-worktree.test.ts`
- `core/services/git-worktree-marker.test.ts`
- `cli/serve/branch-worktree-preparation.test.ts`

硬编码 `.qwen/worktrees` 根站点（P7 迁移，此处供参考）：
`gitWorktreeService.ts`；`core/config.ts`；
`worktreeSessionService.ts`；`core/utils/workspace-artifact-directory.ts`；
`core/utils/workspace-artifact-path.ts`；`core/tools/enter-worktree.ts`；
`core/tools/exit-worktree.ts`；`session.ts`；
`branch-worktree-preparation.ts`；
`workspace-route-runtime.ts`；`worktree-orphan-cleanup.ts`；
`session-restore.ts`。daemon shell 守卫
（`daemon-git-worktree-guard.ts`）今天无需根豁免，因为
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

- 不带 `worktree` 的 `POST /session` 不变。带 `worktree` 时，所有调用方
  （Web Shell、SDK、channel、managed-session）都得到 detached worktree：
  `worktree.branch` 为 `''`，不创建 `worktree-<slug>` ref。需要命名分支的
  调用方对会话 worktree 使用 `POST /session/:id/worktree-branch`，或使用
  保持命名分支的 `enter_worktree`。
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
  按未合并索引状态检测并 fail-closed（D3）：创建复位到已提交状态并拒绝；
  handoff 还原本地检出并以 `handoff_snapshot_conflict` 拒绝。非冲突的
  apply 失败（如索引不可写）同样 fail-closed——未落盘的携带绝不按已携带
  报告。
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
