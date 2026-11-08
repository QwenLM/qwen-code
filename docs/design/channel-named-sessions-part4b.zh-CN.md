# Channel 命名会话：Part 4B

[English](channel-named-sessions-part4b.md) | [简体中文](channel-named-sessions-part4b.zh-CN.md)

## 状态

提议中。Part 1、2、3A、3B 和 4A 均已合入。本设计是 issue #10103 计划中的最后一次
交付。它为 worktree 隔离的任务启用对话重置，并解决那些处置指向本 part 的评审发
现。每一条 Part 4A 遗留评审发现的处置——包括本 part **不**吸收的那些——都记录
在下文「Part 4A 遗留发现的处置」中；只有当这些处置也都得到满足时，issue #10103
才会关闭。

Part 4A 已在 #10643 中落地（合并提交 `37cb9ac161`）。它的设计把针对 worktree 任
务的选中任务 reset 推迟到了本 part。Part 4A 的退出标准以一道启动门槛开头——「只
有在 Part 4A 证明了精确创建与重启恢复之后，Part 4B 才可以开始」——随后要求：

> 其设计必须定义一个原子的或可补偿的 daemon 操作：它创建一个全新的对话，同时保留
> 选中任务那个经过验证的确切 worktree；安全地转移 marker/sidecar 的所有权；不删
> 除文件；并在活跃、陈旧、外来、有歧义或不完整的状态上 fail closed。

Part 4A 在人工批准下合入时，这道启动门槛被判定为已通过，依据是评审者在 #10643 上
运行的真实 daemon 验证（Reviewer Plan 15/15，篡改矩阵 17/17）。本设计逐项满足这
六条转移要求。它也不删除任何用户可见的状态：本设计评审期间识别出的唯一一个破坏性
候选项（orphan-reap worktree 清理）已移到后续 issue #11024，而转移自身的回滚只移
除 reset 创建的产物——替代会话的 sidecar 与记录——绝不移除 worktree、其中的文
件、它的分支、所有权 marker 或旧会话的状态。

## 决策

为选中的 worktree 任务启用 `/clear`、`/new` 和 `/reset`。reset 一个 worktree 任
务会保留它那个经 daemon attest 的确切 worktree——每一个文件，包括未提交的改
动——只把对话替换为一个全新的 daemon 会话。

其原语是一条新的 daemon 路由：

```text
POST /session/:id/worktree-reset
```

给定一个已有的、拥有 worktree 的会话（`S_old`），daemon 在一把按 worktree 键控的
串行化锁下校验它的所有权链；布设一道 reset-pending 屏障，使转移进行期间没有任何
prompt——也没有任何其他能写入 checkout 或移动会话 cwd 的操作——能在 `S_old` 上
启动；在同一个已注册的根工作区中启动一个全新会话（`S_new`）；把 `S_new` 迁移到同
一个 worktree 中；把旧 sidecar 标记为被替代；为 `S_new` 写入新的 sidecar；
再次确认静止状态（quiescence）；最后才把 worktree 内的所有权 marker 从 `S_old`
翻转为 `S_new`——使用原子的 compare-and-swap，绝不盲目覆盖。只有到这时，它才为
`S_new` attest `worktreeState: "persisted-v1"`。响应 payload 与 Part 4A
create/load 响应的形状相同，因此 Channel worker 通过现有的精确身份链来校验它。

reset 绝不删除旧会话。旧会话的 transcript 和持久化记录仍保留在 daemon 的会话目录
（catalog）中，而它那份已标记为被替代的 sidecar 会让之后对 `S_old` 的任何
restore 都以类型化的 `worktree_session_superseded` 信号 fail closed，该信号携带
替代会话的 ID；这样，如果崩溃中断了一次已提交的 reset，Channel 注册表可以自愈。

daemon 公布一个新的 capability `session_worktree_reset_v1`；worker 在发送 reset
请求之前检查它，与 Part 4A 以 `session_worktree_persistence_v1` 作为创建门槛的做
法完全一致。

本 part 解决 #10643 评审记录中的以下评审发现：

1. marker 缺失的恢复（yiliang114 在 `session.ts:4189` 上的意见；chiga0 F1；以及
   评审 bot 的 R3-2，即从第 1 轮延续至今的遗留 Critical）：restore 区分 marker
   缺失与 marker 被篡改，而 reset 是认可的恢复路径——只有当其余的链能证明所有权
   时，转移才会重建 marker。
2. 延后提问的 restore attestation（yiliang114 在 `session.ts:4201` 上的意见；
   chiga0 F2/R1-2）：移除 attest 不足的 `hasUnlocatedRestoredPrompt` 分支，使真
   正存在活跃 prompt 的形态通过现有的活跃会话检查 fail closed。为什么迁移不是修
   复方案，见「延后提问的 restore attestation」——本文档第一版曾提议在那里执行
   迁移，而评审表明这一前提恰好是反的。
3. 延后的 restore 提问的可见性（R8-2，`bridge.ts:8462`）：一个停驻（parked）的
   延后 restore 提问既不设置 `promptActive`，也不产生任何待处理交互，因此
   `hasActivePrompt` 和 `pendingInteractionCount` 都看不到它。这种不可见性同时影
   响合并 restore 的等待方（R8-2 所报告的）和本 part 的静止检查；bridge 会暴露这
   一延后状态，两个使用方在这里一并修复。

在本设计评审期间重新划定范围的项（原因记录在「Part 4A 遗留发现的处置」中）：

- orphan-reap worktree 清理（yiliang114 在 `session-archive.ts:656` 上的意见，
  在 #10643 上被推迟到 Part 4B）移到后续 issue #11024。它是整个系列中唯一会删
  除文件的路径；要把它放到正确的位置，就会牵涉到与 reset 本身的协议交互（一个刚
  完成转移的 `S_new`，恰恰在 superseded 重定向所要修复的那个窗口内，合法地满足
  每一项清理条件）；而且 `/clear` 完全不需要它。
- create 回滚遗留的孤儿（R8-1）、reattach 守卫的自愈（R8-3）、独占创建泄漏的空文
  件（R1-1），以及 `/session new --worktree` 解析器的瑕疵（F3），都是 `main` 中
  现存的缺陷，不依赖转移协议；它们直接在本 PR 中修复（代码与测试），而不是等待后
  续工作。

## 目标

1. 对选中的 worktree 任务执行 `/clear`、`/new` 和 `/reset`，会在同一个经过验证的
   worktree 中产生一个全新的对话，并且本 part 中的任何地方都不删除用户可见的或预
   先存在的状态。
2. 所有权转移是可补偿的：每一个崩溃窗口要么让旧会话保持权威，要么由一次幂等重试
   或一个类型化的 superseded 重定向来完成。没有任何窗口会让任务搁浅。
3. 缺失的所有权 marker 可以通过 reset 恢复；被篡改的 marker 绝不会被自动恢复。
4. reset 会拒绝正在运行、正在等待权限，或停驻在某个已恢复提问上的任务，并给出
   可据以采取行动的消息；daemon 以屏障的形式强制静止，而不是做某一时刻的采样。
5. 解决上述在范围内的评审发现，且不削弱任何 Part 4A 的 fail-closed 边界。
6. 共享任务、禁用 `multiSession` 的情形，以及所有 Part 2/3 行为保持不变。

## 非目标

- 删除任何用户可见的或预先存在的状态：worktree、它的分支、其中的文件、所有权
  marker，或者 `S_old` 的 sidecar、transcript 与记录。转移的回滚只可以移除 reset
  自身创建的产物——`S_new` 的 sidecar 与会话记录。orphan-reap 清理以及同级的
  `POST /sessions/delete` worktree 泄漏在后续 issue #11024 中跟踪。
- 删除任务或其注册表记录。任务清除（purge）是另一项独立功能；已关闭任务的名称仍
  被占用，与 Part 2 相同。
- worktree 分支的自动合回、push、rebase 或冲突解决。
- 把根 checkout 中未提交的改动复制到任何地方。
- 为独立 Channel、webhook、loop、群聊历史或非 `user` 的会话作用域提供命名
  worktree。
- reset 正在运行或正在等待权限的任务。用户需要先取消。
- 改变 Part 3 的标签、权限关联、取消、注册表 schema（保持版本 1）、transcript 或
  审计哈希。

与本节早先的草稿相反，以下内容在范围内：R8-1 create 回滚孤儿的修复、R8-3
reattach 守卫的自愈、R1-1 marker 创建泄漏的修复，以及 F3 解析器的修复，都与本设
计一起在本 PR 中落地（见处置表）。

## 已验证的基线（来自 Part 4A）

- 带 `worktree: {}` 的 `POST /session` 会在仓库的受管根目录之下创建一个用户
  worktree，在根目录启动一个会话，在服务端推导出的 `allowedRoots` 约束下用
  `changeSessionCwd` 迁移它，用 `createWorktreeSessionMarkerExclusive` 创建
  marker，持久化带 `workspaceCwd` 的 sidecar，并且只有在这三步都成功之后才
  attest `persisted-v1`（routes/session.ts 的创建分支）。
- restore 会严格地重新校验：sidecar 的 `workspaceCwd` 必须与路由的根目录
  realpath 匹配，`originalCwd` 必须是根目录或仓库顶层，worktree 路径必须被包含在
  某个受管根目录之下，且严格的 marker 读取结果必须为 `valid` 并指名被恢复的会话
  ID。失败是非破坏性的：刚 attach 的客户端会被 detach，或在零 attach 时被终
  止（zero-attach-kill）；transcript、sidecar、marker、分支和 worktree 都会保留。
- Channel manager 在 `reset()` 内部、在任何 `ChannelBase` 清理副作用发生之前拒绝
  worktree reset，消息为
  `Task "<name>" uses a worktree and cannot be cleared or reset yet. ...`。
- `SessionRouter.validateManagedSessionIdentity` 是 Channel 侧的门禁：它要求
  `worktreeState === 'persisted-v1'`、带有一个不同于根目录的绝对路径的 worktree
  元数据，并且在给出预期任务 cwd 时与之精确匹配。
- marker 是 worktree 根目录下的 `.qwen-session`，内容是拥有它的会话 ID，用
  `O_EXCL | O_NOFOLLOW` 加 inode 固定（pinning）创建，用严格的、不跟随符号链接的
  读取器（`readWorktreeSessionMarkerStrict`）读取，并通过仓库共用（common
  dir 下）的 `info/exclude` 被 git 忽略。
- sidecar 是 daemon 会话存储中每个会话一份的 JSON 文件
  （`sessionService.getWorktreeSessionPath(sessionId)`），包含 `slug`、
  `worktreePath`、`worktreeBranch`、`originalCwd`、可选的 `workspaceCwd`、
  `originalBranch`、`originalHeadCommit`；严格读取器返回
  `missing | valid | invalid`，不会把损坏归并为不存在。
- `deleteDaemonSessionIfOrphan` 在会话可被证明为孤儿时移除其持久化的会话记录，但
  从不触碰 worktree 或分支——这正是 yiliang114 指出的泄漏。它的同级函数
  `deleteDaemonSessions`（即 `POST /sessions/delete` 路径）共用
  `deletePersistedSessionWithLease`，存在同样的泄漏。
- 延后的 restore 提问停驻在 `entry.deferredRestoreAskUserQuestionPrompts` 中，
  既不设置 `promptActive`/`goalTurnActive`，也不在 `pendingInteractions` 中产生
  任何条目，因此 `getSessionSummary` 的 `hasActivePrompt` 与
  `pendingInteractionCount` 都把它读作静止。合并 restore 的等待方分支（R8-2）中也
  存在同样的不可见性。
- restore _响应_ 中的 `hasActivePrompt` 与 summary 中的是分开计算的：
  `restorePromptAdmitted || promptActive || goalTurnActive`。restore 路由读取的
  是这个响应对象，而不是 `getSessionSummary`。这一区别对本 part 很重要，因为停驻
  的提问在那里必须继续读作 `false`——见「延后提问的可见性」。
- 因此，restore 路由的 `hasUnlocatedRestoredPrompt` 分支（存在活跃 prompt、没有
  attach、没有记录的 cwd）**并不是**延后提问的形态：停驻的提问读作
  `hasActivePrompt: false`，走的是 `else` 分支，而该分支本来就会迁移并 attest
  `persisted-v1`。只有当一个冷恢复的会话真的有一个进行中的 prompt 时才会进入该分
  支——此时 `changeSessionCwd` 会链在 prompt 队列之后并抛出
  `CdWhilePromptActiveError`。该分支设置了 worktree 元数据，但跳过了迁移，也从不
  赋值 `worktreeState`，因此 Channel 侧的身份检查会在下一次选中时失败——即
  chiga0 F2，其中该分支的实际形态已按评审意见更正。
- 不带名称的 `/session new --worktree` 会落入 `create('--worktree', 'shared')`，
  名称校验器以一条误导性的消息拒绝它——即 chiga0 F3。（所声称的静默创建共享任务
  并不会发生；`TASK_NAME_PATTERN` 会拒绝以连字符开头的名称。只有消息是错的。）
- `acquireWorktreeRestore`（本 part 将其重命名为 `acquireWorktreeOwnershipOp`）
  按 bridge 实例（一个 `WeakMap`）和会话 ID 键控，目前只覆盖延后提问的 restore
  形态；普通的 Part 4A worktree restore 不获取这样的锁。
- `packages/core/src/utils/atomicFileWrite.ts` 已经提供：带 `noFollow: true` 的
  `atomicWriteFile`（一种原子替换：无论该路径上原来是什么，都用一个普通文件替换
  它，绝不跟随被换入的符号链接）、`renameWithRetry`（针对 Windows 的
  EPERM/EACCES 退避重试）、`flush`，以及一个在 rename 提交之前立即调用的
  `assertCanCommit` 钩子。
- `atomicWriteFile` 有两条路径**不**经过那次 rename，而且两者对 marker 都有影
  响：一条是保留文件属主的快速路径，当目标的 `uid` 与进程的有效 uid 不同时，它就
  地写入已有的目标——非原子，且在写入时会跟随符号链接；另一条是 `EXDEV` 回退路
  径，它先 unlink，再独占创建。`assertCanCommit` 钩子是同步的（`() => void`），
  因此它无法 await 异步的严格 marker 读取。

## Part 4A 遗留发现的处置

Part 4A 是依据仓库的五轮规则、按 `land-with-residual-risk` 建议合入的，因此合入
时仍有评审发现遗留。它们的处置如下——没有任何一条被静默丢弃：

| 评审发现                                                                                                                           | 形态                                                                             | 处置                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| R3-2 / chiga0 F1 + yiliang114（marker 缺失使任务彻底无法使用）                                                                     | restore fail closed，且没有恢复路径                                              | **本 part**：类型化的 `worktree_marker_missing` restore 信号，加上通过 reset 重建 marker                                                      |
| chiga0 F2 / R1-2 + yiliang114（活跃 prompt 的 restore attest 不足）                                                                | 该分支从不 attest `persisted-v1`                                                 | **本 part**：在可以延后的情形下移除（该形态 fail closed）；对已触发的 restore 提问则保留，且不 attest（见「延后提问的 restore attestation」） |
| R8-2（延后提问对合并 restore 不可见）                                                                                              | 等待方挂起，或让一个健康的会话返回 500                                           | **本 part**：bridge 暴露延后的 restore 提问状态；coalescer 与本 part 的静止检查都使用它                                                       |
| R8-1（create 回滚的 `!spawnCompleted` 门控使 worktree 成为孤儿）                                                                   | 当 spawn 之后的清理结果不确定时，形成永久孤儿                                    | **本 PR**：spawn 之后的失败处理块无论孤儿删除的结果如何，都会移除无主的 checkout，并由代码注释说明该块为何与相邻的两个块不同（见下文）        |
| R8-3（reattach 守卫误读一个已合法退出的 worktree）                                                                                 | 在 `exit_worktree` + 重启之后陷入永久的 "lost durable worktree identity" 循环    | **本 PR**：当 resume 响应不携带 `worktree` 对象时 reattach 自愈，遇到自相矛盾的 attestation 时仍 fail closed，并附回归测试                    |
| R1-1（独占创建 marker 在写入失败时泄漏一个空文件）                                                                                 | 该路径因 `EEXIST` 而卡死                                                         | **本 PR**：独占创建在失败时 unlink 它自己的文件，并附回归测试                                                                                 |
| F3（不带名称的 `/session new --worktree`）                                                                                         | 误导性的名称校验消息                                                             | **本 PR**：解析器返回用法说明行，并附回归测试                                                                                                 |
| yiliang114 指出的回收路径泄漏（`session-archive.ts:656`）                                                                          | 删除孤儿会话时泄漏 worktree + 分支                                               | **后续 issue #11024**（见下文），不在本 part                                                                                                  |
| `SessionRouter.ts:487`（通用 load 路径把持久化的 worktree cwd 传给 daemon；冷启动的 `restoreSessions` 会丢弃 worktree 任务的路由） | 被延后的 Critical，fail closed，属于新增接口面；其全文在 #10643 评审记录中被截断 | **后续 issue #11024**，先在那里调查，因为必须先复现它被截断的记录，才能针对它做设计                                                           |

R8-1 这一行需要在本 PR 的代码注释中讲清一个区别，因为 create 路由在相隔两个块的
地方刻意做了相反的事：迁移失败时，「only when the session was
definitively removed」（只有在会话已被确定移除时）才移除 checkout（bridge 超时
是面向调用方的；迁移仍可能落地）；而迁移之后的持久化失败，在删除结
果不确定时会保留 checkout 并记录日志。本 PR 修改的那个块在性质上就不同，而不是对
该规则的放宽：它是 spawn 之后的 generation 守卫 catch，在尝试任何迁移之前运
行——会话在那里是存在的（并且会对它尝试经孤儿确认的移除），但还没有任何会话进入
该 worktree，所以无论那次清理的结果如何，都没有任何东西能拥有该 checkout。
`!spawnCompleted` 那条「no session exists」（不存在会话）的理由属于 spawn 失败
时的外层 catch，那是本 PR 不改动的另一个块。

issue #11024（最后两行的后续工作）还承载了本设计评审期间收集到的回收清理要求，使
它们在那里落到实现时依然有效，而不必重新推导：

- 像 create 路由那样，把删除放在回收的调用点，绝不放进共享的
  `deleteDaemonSessionIfOrphan` 原语内部——该原语的其他调用点（ACP dispatch 回
  滚、定时任务保活、本 part 自己的 reset 回滚）绝不能因此被连带赋予删除能力。
- 以 `kind === 'removed'`（等价于 `mutationApplied`）作为门控，而不是
  `!== 'error'`：`notFound` 形态意味着什么都没有被删除。
- 当 sidecar 带有 `supersedes`/`supersededBy`，或者任何其他会话的 sidecar 指向同
  一个 worktree 路径时，拒绝清理——一个刚完成转移的替代会话，恰恰在 superseded
  重定向所要修复的那个窗口内，满足朴素的所有权门槛。
- 把被替代的前任会话视为 reset 之后的预期状态，跳过它且不输出面向运维的日志行，
  从而让「保留并记录日志」这一信号保持其含义。
- 保持 `removeUserWorktree` 的安全删除默认行为：绝不传 `forceDeleteBranch`，并记
  录 `branchPreserved` 结果，以便区分「worktree 已移除、分支保留」与「worktree
  保留、所有权存疑」。
- 要求所有权链成立（对当前 runtime 严格有效的 sidecar、严格读取且恰好指名被移除
  会话的 marker、containment 校验），外加干净的 `git status --porcelain`；有任何
  疑问就保留并记录日志。
- 明确决定同级的 `POST /sessions/delete` 路径是否也应获得同样的清理；它目前以完
  全相同的方式泄漏。

## 用户可见的契约

### 重置 worktree 任务

选中一个 worktree 任务时：

```text
/clear   →  Task "feature-a" reset with a fresh conversation. Its worktree
            files were kept.
```

`/new` 与 `/reset` 的行为与之完全相同，这与它们在共享任务上的表现一致。任务保留
其名称、它在 `/sessions` 中的位置以及完全相同的 worktree；下一条消息会在该
worktree 中开始一段全新的对话。

对一个正在运行、正在等待权限，或停驻在某个已恢复提问上的 worktree 任务执行
reset，会在产生任何副作用之前失败：

```text
Task "feature-a" is still running or waiting for permission. Cancel it with
/session cancel, then clear it again.
```

这是与共享任务之间有意为之的差异：在共享任务上，`/clear` 会取消正在进行的回合。
在某个 prompt 可能仍在该目录中执行时转移 worktree 所有权是不安全的；先取消才是安
全的顺序。Part 4A 的拒绝消息被移除。

### 通过 reset 恢复

当某个 worktree 任务的所有权 marker 缺失时——即迁移与 marker 写入之间的崩溃窗
口，或任务本地的一次 `git clean -fdx`——选中该任务或向它发送消息仍会持续 fail
closed，但会给出一条可据以采取行动的消息：

```text
Task "feature-a" cannot verify its worktree because its ownership marker is
missing. Its files were not changed. Clear the task to restart it in the same
worktree, or close it.
```

随后 `/clear` 会为替代会话重新创建 marker。一个存在但无效的 marker（被篡改、
owner 不对、文件类型不安全）永远不会被任何命令重新创建；任务保持 fail-closed，留
待运维修复。

两条 worktree 恢复消息——这一条以及下文的中断转移消息——都依赖于状态，因为清除
总是作用于*选中的*任务：只有当失败的任务就是选中的任务时，才会给出清除的指引。若
指引针对的是其他任务，照做的清除就会对（选中的）健康任务执行完整的所有权转移并毁
掉那段对话；因此，未选中任务上的失败会点名该任务，并指向能作用到它的两个操作——先选中
它，或者使用 `/session close <name>`，后者在不加载目标的情况下关闭任务：

```text
Task "feature-a" cannot verify its worktree because its ownership marker is
missing. Its files were not changed. Clearing now would reset the selected
task instead, so select this task first or close it with
/session close feature-a.
```

当失败中没有可用的任务名时，主语退化为「The task」，补救建议也会去掉那条命令，而
不是冒着点名错误任务的风险。任务名是这些消息在包装层 sanitizer 之外插入的唯一文
本，因此它被限制在 32 个码点以内；有界消息规则保持不变——允许出现任务名，不允许出
现会话 ID、路径和 daemon 响应体。

### 中断的转移

如果上一次 reset 在两个 sidecar 已互相链接之后、marker 翻转之前崩溃，选中该任务
或向它发送消息时会报告这一中断状态，而不是一个通用失败：

```text
Task "feature-a" was interrupted while being reset. Its files were not
changed. Clear the task again to finish the reset.
```

同样的状态依赖也适用于此：只有当被中断的任务就是选中的任务时，才会输出这段文本。
未选中任务上的失败会点名该任务，并指向选中它或关闭它，而不是指向一次会转移另一个
健康任务的清除：

```text
Task "feature-a" was interrupted while being reset. Its files were not
changed. Clearing now would reset the selected task instead, so select this
task first or close it with /session close feature-a.
```

重试的 `/clear` 会续接这次转移并完成它。daemon 如何区分这一窗口，见「load/resume
时的 superseded 重定向」一节。只留下旧 sidecar 链接的崩溃——替代会话从未获得自
己的 sidecar——不属于这个窗口：这对链接不一致，因此重定向目标不带 worktree
attestation，选中时报告的是通用的加载失败，重试的 `/clear` 返回同样的类型化拒绝
而不会收敛。该状态保持原样，留待运维修复。

### 列表与状态

`/sessions`、`/sessions all`、`/session current` 与 `/session use` 的输出保持不
变；除了已有的 `lastSelectedAt` 更新之外，reset 不会改变名称、隔离标签或排序。

## Daemon 设计

### 新路由：`POST /session/:id/worktree-reset`

请求体（所有字段均可选）：`{ cwd?, modelServiceId?, approvalMode?,
sourceType?, sourceId? }`。`cwd` 是表示工作区根目录的线上协议字段——SDK 把它的
`workspaceCwd` 选项映射到这个字段上——路由通过与 load/resume 相同的解析器解析
它：显式给出的 `cwd` 选中对应的已注册工作区，省略时回退到 daemon 公布的主工作
区，而 worktree 路径本身永远不会被接受为路由输入。路径中的会话 ID 是要被替换的
worktree owner（`S_old`）。

成功时的响应与 create/load 的会话 payload 形状相同，携带 `S_new`、worktree 元数
据以及 `worktreeState: "persisted-v1"`。该路由从不读取 `X-Qwen-Client-Id`，因此
`S_new` 以未 attach 的状态启动——但响应体并非不含注册：全新转移的响应体中的
`clientId` 是 bridge 为这次启动签发的一个 owner 式注册（替代会话的 `attachCount`
保持为 0），而幂等续接的响应体则省略它。正是非空的客户端注册让 daemon 的空闲清理
暂不执行，因此不继续使用所签发 id 的调用方必须 detach 它，否则 `S_new` 永远不会
变得可被回收。调用方把该响应视为替代会话的身份，并通过其正常流程 attach 它；
Channel 接管返回的客户端并调用 `activateManagedSession`。SDK 与 bridge 的类型复
用现有的 `DaemonSession` 接口面；不引入新的响应类型。

类型化失败（4xx、有界、不含路径或堆栈）：

- `worktree_reset_unsupported`——目标会话没有 Part 4A sidecar，或者不是
  worktree 隔离的。
- `worktree_reset_active`——该会话有一个活跃的 prompt、一个待处理的交互，或一个
  停驻的延后 restore 提问。
- `worktree_reset_invalid_state`——陈旧、外来、被篡改、containment 校验失败，或
  所有权不明确。就本次请求自身发起的改动而言不具破坏性：部分完成的转移会在调用方
  看到之前被回滚，而已经存在的中断状态则保持原样，留待运维修复。

另有两个错误码属于 restore 接口面，而不属于本路由——本路由会自行处理这两种形
态，从不返回它们：

- `worktree_session_superseded`——翻转之后对 `S_old` 的 load/resume；见下文的重
  定向。
- `worktree_reset_interrupted`——对一个替代会话的 load/resume，其
  `supersedes`/`supersededBy` 链接一致，而 marker 从未移动。修复方式是针对被替代
  的会话重试 reset，这会回滚或完成被中断的转移；见「load/resume 时的 superseded
  重定向」一节。

### 延后提问的可见性（R8-2）

bridge 学会把停驻的延后 restore 提问暴露出来：非空的
`entry.deferredRestoreAskUserQuestionPrompts` 会被视为一个进行中的 prompt，但只
针对恰好两个使用方——合并 restore 的等待方分支（R8-2 所报告的问题）以及
`getSessionSummary` 的 `hasActivePrompt`，后者正是本 part 的静止状态前置条件与
Channel 的 `isBusy` 回退逻辑所读取的值。一处共享的可见性修复同时解决了所报告的等
待方挂起/`CdWhilePromptActiveError` 问题，以及本 part 的静止状态盲区。

这一修复刻意止步于此。它**不得**影响 restore *响应*中的 `hasActivePrompt`——该
值单独计算为 `restorePromptAdmitted || promptActive || goalTurnActive`，也是
restore 路由所读取的值。在那里扩大它的含义会与下文的分支移除相互作用：延后的
worktree restore 会开始报告存在活跃 prompt，在没有已记录 cwd 的情况下落入
`else if (session.hasActivePrompt)` 检查，并以
`Active session is outside its worktree` fail closed——从而破坏如今能正常工作、
且 #10643 的评审者已端到端验证过的延后 restore 路径。只有在响应值保持不变时，这
两处修复才能相容，因此「进行中的 prompt」刻意不在这两处计算之间统一。

### 前置条件（全部 fail closed）

该操作的串行化以规范化的 worktree 路径为键，而不是会话 ID——在任何一次完成或崩溃
的转移之后，都会有两个会话持有指向同一个 worktree 的 sidecar，按会话划分的锁无法
让它们的 reset 互斥。现有的 restore 串行化（按 bridge 实例划分）以同样的方式扩大
适用范围，并更名为 `acquireWorktreeOwnershipOp`：每一个由路由负责的 Part 4A
worktree restore 都会在预读 sidecar 之后获取这把按 worktree 键控的锁，而本路由在
整个操作期间持有它。restore 会记录它所锁定的键；此后凡是读取该会话自身的 sidecar、
且读到其中记录了工作区的读取——即 Channel restore 在持锁状态下的重读，以及 load
之后的 Part 4A 校验——读到的 sidecar 都必须指向那个 checkout：如果预读当时没有加
锁（当时 sidecar 缺失、是 legacy 或无效），或者锁定的是另一个 checkout，restore
就会以 `500` fail closed，而不是在未加锁的情况下校验那个 checkout。若后续读取发
现的是 legacy sidecar，则仍走无锁的 legacy 路径。因此，对 `S_old` 的 restore 永
远不可能在一个即将翻转 marker 的转移进行的同时通过 marker 校验，两个针对同一
worktree 的 reset 也永远不可能都到达翻转这一步。与 create/load 一样，运行时
generation 在第一个副作用之前被捕获，并在响应之前再次断言。

在锁内，并在持锁状态下重新读取、重新校验 sidecar 之后：

1. `S_old` 存在于该工作区运行时的持久化 catalog 中。
2. 对 `S_old` 的严格 sidecar 读取结果为 `valid`，其 `workspaceCwd` 与解析出的根
   目录 realpath 匹配，`originalCwd` 位于可接受的根目录之内，`worktreePath` 通过
   containment 校验——与 Part 4A restore 的检查相同。已经带有 `supersededBy` 的
   sidecar 不算全新转移的前置条件失败；它会进入下文所述的续接路径。
3. 静止状态（在延后提问可见性修复已就位的前提下）：`S_old` 在运行中 bridge 里的
   条目（如果有）报告没有活跃 prompt（停驻的延后提问现在也计入），且待处理交互数
   为零。运行中 bridge 不认识的会话处于休眠状态，因此是静止的。已 attach 的客户
   端不会阻止 reset：worker 自己的客户端会一直 attach 在打开的任务上，直到 reset
   成功，因此转移会切断 `S_old` 残留的 attach，而不是要求没有任何 attach（见第 6
   步）。在这一切之前，Channel 就会拒绝忙碌的任务（`isBusy` 涵盖排队中的回合、正
   在运行的 prompt 以及待处理的权限请求）。
4. marker 状态要么是指向 `S_old` 的 `valid`，要么是 `missing`。`missing` 是恢复
   通道：只有在同时具备有效 sidecar 和 catalog 记录时才接受它，即所有权链恰好
   只缺一环。`invalid`（被篡改、外来、不可读、文件类型不安全）则拒绝。
5. worktree 目录存在，且其 realpath 解析结果位于某个受管 worktree 根目录之内。

静止状态以屏障的方式强制执行，而不是一次采样。检查通过后，路由把 `S_old` 的
bridge 条目标记为 reset-pending；bridge 拒绝为处于 reset-pending 的会话准入新工
作，并返回与忙碌任务拒绝相同的类型化 `worktree_reset_active` 失败——含义相同，
fail-closed 形态也相同。这道拦截并不只针对 prompt：有八个写入方会查询它，每一个
都能触及 checkout 或移动会话 cwd——`sendPrompt`、`rewindSession`（其文件恢复以
会话 cwd 为基准，而且恰恰是在本路由所要求的空闲状态下被准入的）、
`changeSessionCwd`、`branchSession`、`launchSessionForkAgent`（其 fork 在该 cwd
中运行工具）、`executeShellCommand`（它在条目的有效 cwd 中运行——对已迁移到
worktree 的会话而言就是 checkout 本身，因此它是最强的途径，而不是一个作用于工
作区 cwd 的途径）、`controlSessionWorkflowTask`（其操作会通过会话自身的工具注册
表，在该 cwd 中运行一个已保存的 workflow，或重启一个正在进行的运行）以及
`controlSessionGoal`（其 `resume` 会提升一个排队中的用户回合并排入一次续跑，因此
它启动的工作从不经过已被拦截的 `sendPrompt` 准入）。每个写入方都会在接入会话的
prompt 队列或进行派发之前，查询路由所设置的同一个以 id 为键的标志，因此当路由清
除该标志时，被拒绝的写入方无法越过这次转移挤进来。`continueSession` 并不是第九道
关口：它通过 `sendPrompt` 驱动一个已被接受的续跑，并在那里被拒绝。这八个就是这道
拦截的全部，而这道拦截也并未覆盖所有能触及子进程的路径：释放与停止路径按设计在转
移过程中仍然可用（`cancelSessionTask`、`clearSessionGoal`、`detachClient`、
`killSession`），`enqueueBackgroundNotification` 同样不受拦截：它是 daemon 内部
的（子会话向其父会话发送的完成确认，没有任何 HTTP 路由调用它），并且只是排入一条
通知，而不是启动一个回合。这就关闭了这样一个窗口：一条恰好在 reset 之前完成解析
的消息——在 Channel 一侧，`resolve()` 在持有 owner 锁时返回，但回合在锁释放之后
才开始——可能在转移过程中开始在 worktree 中执行；对任何非 Channel 调用方也关闭
了同样的窗口（否则对它们而言，这项检查只是一次时间点采样）。Channel 用户永远观察
不到这道屏障：manager 在整个 reset 期间持有 owner 锁，因此并发消息的 `resolve()`
会阻塞，随后解析到替代会话——屏障没有对应的面向聊天的消息，这是有意的决定，而不
是遗漏。该标志在每一条失败或补偿路径上都会被清除，成功时则由转移接管——但有两个
例外，二者都从提交点开始。当切断步骤报告被替代的会话仍然存活时，屏障保持启用，
作为该条目上仅剩的拦截（见第 6 步）。而一旦 marker 翻转提交了所有权，释放屏
障就不再是本次请求的职责：路由在翻转时撤销自己的释放动作——在已提交的续接路径
上，以及在原语报告翻转已完成的提交后尾段失败时，也同样如此——因此翻转之后尾段中
的任何失败都会让被替代的条目保持被拦截，等待完成切断的那次重试，而不是把一个写入方
重新准入到 marker 已经交给 `S_new` 的 checkout 中。过了这一点，只有一次完成的切
断才会显式清除该标志。此外，紧接在 marker 翻转之前还会再次验证静止状态。

如果 `S_old` 的 sidecar 已经记录了 `supersededBy: S_new`，说明上一次 reset 在转
移中途崩溃了。路由在选择恢复形态之前先读取 marker，因为正是 marker 表明崩溃落在
提交点的哪一侧：

- **marker 指向 `S_new`——转移已提交。** `S_new` 是权威的 owner，永远不会被回
  滚。当它的 catalog 记录、sidecar 与 `supersedes` 链接重新校验通过且它处于静止
  状态时，路由为同一个 `S_new` 完成被中断的转移并返回它——rename 之后的崩溃会以
  空操作的形式续接（幂等续接）。当它忙碌时，路由以 `worktree_reset_active` fail
  closed：忙碌的替代会话是一个正在使用中的会话（例如经由 superseded 重定向到达、
  并被另一个客户端发送了 prompt 的会话），而不是无效的会话，待它空闲后，后续的重
  试就会收敛。任何其他重新校验失败（记录缺失、sidecar 损坏、链接不匹配、marker
  被篡改）都会 fail closed，留待运维修复。删除 marker 所指向的会话会让任务永久搁
  浅：marker 将指向一个已删除的会话，对 `S_old` 的 restore 会因 marker 不匹配而
  失败，而重试的 reset 会在前置条件 4 上失败——该条件要求 marker 是指向 `S_old`
  的 `valid`，或是 `missing`。
- **marker 指向 `S_old`，或在 `S_new` 处于休眠时缺失——尚未提交。** 可以证明
  `S_new` 不具权威性，因此在这里执行破坏性回滚是正确的：先以孤儿确认的方式移除
  `S_new`，再删除 `S_new` 的 sidecar，然后从 `S_old` 的 sidecar 中移除
  `supersededBy`——并且只有在对替代会话的移除得到确认之后，才继续创建一个全新的
  替代会话。移除返回 `false`（有客户端 attach，因此 `requireZeroAttaches` 放弃了
  移除）时，会以 `worktree_reset_invalid_state` fail closed，而不是继续去启动新
  会话：链接保持写入状态，因此只要移除仍未得到确认，重试就会重新进入同一条续接路
  径并再次拒绝，而不是在 checkout 中留下一个磁盘上没有任何东西指向它的存活替代会
  话，同时全新的转移又在它旁边启动第二个写入方。撤销链接时先去掉正向链接，原因与
  转移时先写反向链接相同：回滚中途崩溃只会留下反向链接——这是重试会拒绝并留待修复
  的形态——而不是留下一个没有任何东西会扫描的正向链接。这一证明受两个条件约束。
  仅凭 marker 缺失证明不了任何事：一次已提交的转移，如果其被 git 排除的 marker
  后来被清理掉了（任务本地的一次 `git clean -xdf`），读起来与提交前崩溃的形态完
  全一样，因此当 `S_new` 仍在本 daemon 上存活而 marker 缺失时，会在任何破坏性写
  入之前以 `worktree_reset_invalid_state` fail closed，而不是拆掉已提交的 owner
  并启动第二个 owner。此外，回滚要求这对链接一致——`S_new` 的 sidecar 存在并指向
  `S_old`——因为没有替代会话 sidecar 的反向链接（两次 sidecar 写入之间的崩溃窗口）
  授权不了任何操作；这种形态会被报告并留待运维修复，而不会被回滚。

在链接一致的情况下，重试的 `/clear` 会收敛到恰好一个 owner，而不会堆积出多个替代
会话。那些 fail-closed 形态——无效的 marker、不一致的链接对、指向第三个会话的
marker、没有 marker 的存活替代会话——都保持原样，重试会重新读到同样的状态并返回
同样的类型化 `409`，而不会收敛，因此它们需要运维修复，而不是循环重试。没有任何恢
复路径会删除 marker 所指向的会话。

### 转移协议

按顺序排列的各个步骤，以及每一步的崩溃行为：

0. 前置条件通过；在 `S_old` 上启用 reset-pending 屏障。
   在 marker 翻转之前，每一条非崩溃的失败路径或补偿路径都会显式清除该屏障；越过
   翻转之后，释放屏障就不再是本次请求的职责，只有完成的切断才会清除它（见第 6 步
   及上文关于屏障的段落）。崩溃不会清除任何东西——屏障是内存中的 bridge 状态，
   会随进程一同丢弃，刻意设计为非持久化：转移中途状态的持久性完全存放在 marker
   与 sidecar 对之中，由 resume 路径读取。
1. 在根工作区中生成 `S_new`，沿用与全新 worktree 创建相同的线程作用域和 source
   metadata 约定，只是不创建 worktree。不建分支、不建目录、不分配 slug。
   崩溃：`S_old` 完全具有权威性；`S_new` 是一个普通孤儿，没有 worktree 元数据，
   也没有 sidecar。
2. 通过 `changeSessionCwd`（使用服务端推导出的 `allowedRoots`）把 `S_new` 迁移到
   已校验的 worktree 路径，要求返回的规范路径等于已校验的真实路径。
   崩溃/失败：以孤儿确认方式移除 `S_new`（即现有的 create 路由回滚原语）；marker
   仍指向 `S_old`，它仍可 restore。reset 回滚绝不会移除 worktree。
3. 重写 `S_old` 的 sidecar，加入 `supersededBy: S_new`（原子写入）。先写反向链
   接，是为了让翻转之前的每个崩溃窗口都留下 resume 路径能够分类的状态：在此处崩
   溃得到的是一个不一致的链接对，它会可见地 fail closed，而不是一个没有任何东西
   读取的正向链接。
   崩溃：marker 仍指向 `S_old`；restore `S_old` 会报告 superseded 链接，并以
   `S_new` 作为重定向目标，而 `S_new`（此时还没有 sidecar）会作为普通的根工作区
   会话被 restore，不带 worktree attestation，因此感知隔离的调用方会拒绝该响应，
   并保留自己原有的登记信息。重试的 reset 会因链接对不一致而以
   `worktree_reset_invalid_state` fail closed，并让中断的状态保持原样，留待运维
   修复。受控失败：先以孤儿确认方式移除 `S_new`，再从 `S_old` 的 sidecar 中移除
   `supersededBy`。
4. 通过现有的原子写入器为 `S_new` 写入 sidecar，其中携带来自 `S_old` sidecar 的
   worktree 身份（`slug`、`worktreePath`、`worktreeBranch`、`originalCwd`、
   `originalBranch`、`originalHeadCommit`），加上本 daemon 的 `workspaceCwd`，以
   及一个 `supersedes: S_old` 链接。
   崩溃：此时链接对已经一致，但 marker 仍指向 `S_old`，所以重定向目标尚不具有权
   威性——restore `S_new` 会以中断转移信号 fail closed，而重试 reset 会走提交前
   的恢复形态：回滚这次不完整的尝试，再以一个全新的替代会话继续。这是唯一一个任
   务暂时无法 restore、而重试正是文档规定的修复手段的窗口；这也是为什么调用方在
   成功 load 它所拿到的重定向目标之前，不得持久化该目标——因为那次重试会回收
   它。受控失败：先以孤儿确认方式移除 `S_new`，再删除新的 sidecar，并从 `S_old`
   的 sidecar 中移除 `supersededBy`。
5. 重新校验静止状态——在从检查到启用屏障之间的窗口内被准入、且仍在收尾的 prompt
   会在此中止转移——然后把 marker 转移给 `S_new`（原语见下文）。这是不可回退
   点。
   提交前崩溃：marker 仍指向 `S_old`；重试 reset 走提交前的恢复形态（回滚，再加
   一个全新的替代会话）。提交后崩溃：marker、两份 sidecar 与 catalog 一致认定
   `S_new` 拥有该 worktree；`S_old` 作为被替代的会话 restore 并重定向，重试
   reset 走已提交的恢复形态（空操作的 resume，或在替代会话忙碌时 fail closed——
   绝不回滚）。
6. 重新断言运行时 generation。如果 `S_old` 在 bridge 中存活，就切断它残留的客
   户端注册，并清除它在内存中的 worktree 关联，使 runtime 视图与已转移的磁盘所有
   权一致；`S_old` 仍保持已持久化、被替代的状态，绝不会被删除。切断操作会报告
   `S_old` 是否真的已经消失，路由依据这份报告行事，而不是想当然：仍持有后台工作
   的子进程（例如在 checkout 内启动的 dev server）会拒绝由最后一次 detach 触发的
   空闲关闭，因此该条目可能存活下来——仍然活着，cwd 位于 marker 刚移交给
   `S_new` 的 checkout 内，并且在其 worktree 关联被清除后不再出现在 catalog 中。
   存活者会被如实暴露，而不是被掩盖：屏障在它身上保持启用，作为仅剩的一道拦截，
   daemon 会把这次滞留记入日志，`200` 响应体携带 `supersededSessionLive: true`，
   让调用方知道旧 id 仍然存活、可以重新 attach。该字段只是诊断用的暴露面：没有任
   何第一方调用方读取它，Channel worker 在两种情况下报告的都是同一条成功消息，因
   此这里没有任何东西依赖使用方去检查它——把存活者挡在 checkout 之外的，是已启
   用的屏障和磁盘上的 sidecar 链接。发布这个字段，是为了供需要区分「旧 id 已消
   失」与「仍存活但已被拦截」的外部调用方和运维人员使用。升级为 kill 不可
   行——关闭错误会演变为 channel kill，而 `S_new` 正是生成在同一个绑定工作区的
   bridge 上。在响应上设置 `persisted-v1` 并返回响应。

第 3–5 步的受控失败（无崩溃）这样补偿：先移除 `S_new`，再按写入顺序的逆序撤销链
接——以孤儿确认方式移除 `S_new`，删除 `S_new` 的 sidecar，然后从 `S_old` 的
sidecar 中移除 `supersededBy`——精确恢复到 reset 之前的状态。移除必须先行，并且
必须得到确认：返回 `false`（有客户端 attach，因此 `requireZeroAttaches` 放弃了移
除）时，放弃撤销链接并重新抛出错误，把链接对留在磁盘上，使重试走上文的 resume 路
径并拒绝、留待修复，而不是让那个存活者在 checkout 内继续存活、却没有任何东西指向
它，同时又在它旁边生成第二个替代会话。撤销链接的顺序之所以重要，原因与写入顺序相
同：回滚中途崩溃时只会留下反向链接（重试会拒绝它，留待运维修复），而不是一个没有
任何东西会去扫描的正向链接。第 6 步的失败已越过不可回退点，不做补偿：marker 已指
向 `S_new`，磁盘上的状态是一致的，而 Channel（它从未看到成功）会在下一次选择时通
过 superseded 重定向修复自己的注册表。

第 3 步之前的崩溃可能留下一个已迁移、却从未获得 sidecar 的替代会话。这个孤儿不声
明任何 worktree：它作为普通的根工作区会话被 restore，最终会像任何孤儿一样被
回收——与崩溃的 Part 4A 创建本来就可能留下的形态相同。重试的 reset 会直接生成一
个全新的替代会话。

### Marker 转移原语

在 core worktree service 中新增一个仅供 daemon 使用的 helper：
`transferWorktreeSessionMarkerOwner(worktreePath, expectedOwner | null, newOwner)`。
该转移是针对当前 owner 的 compare-and-swap——绝不是盲目覆盖：

1. 严格读取 marker。要求结果为 `valid` 且 `sessionId === expectedOwner`，或者在
   `expectedOwner === null` 时为 `missing`（即恢复通道）。任何 `invalid` 状态或
   owner 不匹配都会 fail closed。
2. 拒绝属于其他用户的 marker——但仅限于所有权可观测的地方。该比较读取 marker 的
   `uid`（两个严格读取器，即异步的那个和新增的同步的那个，都会在三态结果之外一并
   给出它），与 daemon 的有效 uid 对比，并且只在平台提供有效 uid
   （`process.geteuid`）的地方运行。在平台不提供的地方（Windows），
   `atomicWriteFile` 的 `ownershipWouldChange()` 恒为 false，因此这项拒绝所防范
   的原地写入路径在构造上就不可达，也就不会拒绝任何东西。在它确实运行的地方，这
   项拒绝让 `atomicWriteFile` 停留在 rename 路径上：否则，保留文件属主的快速路径会
   原地写入 marker——非原子地写入，并且会跟随检查之后被换入的符号链接——而写到
   一半时崩溃会留下一个被截断的 marker，严格读取器会把它报告为 `invalid`，而
   `invalid` 的 marker 永远不会被自动恢复。对属于其他用户的 marker fail closed，
   与任何其他所有权不明确的情形是同一种 fail-closed 形态。
3. 按形态提交：
   - `valid` 且指向 `expectedOwner`：通过现有的 `atomicWriteFile` 以
     `noFollow: true` 重写；它的 rename 会原子地替换占据该路径的任何东西——包括
     校验之后被换入的符号链接——且从不跟随它，它的 `renameWithRetry` 则覆盖了
     Windows 上 EPERM/EACCES 的情形。`assertCanCommit` hook 会在 rename 提交前立
     即重新读取 marker，要求相同的 owner **以及**相同的文件身份
     （`dev`/`ino`/`uid`），与开头的严格读取一致，从而关闭开头读取与提交之间的窗
     口——一个携带相同 owner 内容、但属于其他用户的替换文件会在此处被捕获，而不
     是被原地写入。由于该 hook 是同步的（`() => void`），复查使用 core worktree
     service 中与异步读取器并列新增的同步 no-follow 严格读取器——检查相同，三态
     结果也相同。`atomicFileWrite.ts` 本身原样复用，不作修改。
   - `missing`：通过现有的 `createWorktreeSessionMarkerExclusive` 提交，它把
     owner 暂存到同级文件 `.qwen-session.<12-hex>.tmp` 中
     （`O_EXCL | O_NOFOLLOW`，inode 固定），在那里写入并 fsync，然后用 `link(2)`
     发布。用于发布的 link _正是_ 以「路径不存在」为前提的 compare-and-swap：
     marker 路径已被占用时它以 `EEXIST` 失败，因此并发转移中若有一方先到，另一方
     会落败而不是覆盖——这正是 `O_EXCL` 创建原本提供的保证，同时又从不让 marker
     路径在其内容完整写入并 fsync 之前存在。
4. `atomicWriteFile` 的临时文件是一个名为 `.qwen-session.<hex>.tmp` 的同级文件。
   转移会在 marker 已有的 `info/exclude` 行旁边加一条 `.qwen-session.*.tmp` 规
   则，使崩溃的转移遗留的临时文件（其中带有会话 ID）不会被任务内的 `git add -A`
   暂存。这个 glob 同样扩大了主 checkout 中仓库共享的 exclude；这种扩大是有意接
   受的（该模式只匹配 marker 的转移临时同级文件），正如 Part 4A 已经对 marker 规
   则本身所接受的那样。同级放置还让临时文件与 marker 位于同一个文件系统，因此
   `atomicWriteFile` 的 `EXDEV` 回退路径（它先 unlink 再创建，即下文所否决的无
   owner 窗口）在这里不可达。

两种提交形态留下的要么是完整无损的旧 marker，要么是完整的新内容，因此严格读取器
永远不会从这个原语看到被截断或为空的 marker。之所以成立，是因为对其他 uid 的拒绝
排除了原地写入路径，同级临时文件排除了 `EXDEV` 路径，而提交点的复查比对 owner
**和**文件身份——只剩下 rename 和 link 发布这两种提交方式。这里坦白说明一个残留
问题：保留 inode 与文件属主的原地重写，对任何文件级检查都无法区分，但只有同 uid 的
写入方才能做到——即 daemon 自身或本地用户——而对于 daemon 写入方，按 worktree
键控的锁排除了这种情况。针对同一个 worktree 的两次并发转移不可能都胜出：按
worktree 键控的锁会把它们串行化，而且无论如何，后完成者的 owner 复查（或发布
link 返回的 `EEXIST`）都会 fail closed。

因此，0 字节的 `.qwen-session` 不是 `missing` 恢复通道能够产生的状态。两个严格读
取器仍把它归类为 `{state:'invalid', reason:'invalid marker owner'}`，它也仍然永
远不会被自动恢复：事先已存在的空 marker——由修复前的代码、由
`writeWorktreeSessionMarker` 的普通 `fs.writeFile`，或由外部截断留下——保持现有
的非类型化 fail-closed 行为。

取代原先「先创建再填充」窗口的，是发布 link 与移除暂存同级文件之间的间隙：在此期
间 marker 持有正确的 owner，但 `nlink === 2`，两个严格读取器都会把它报告为
`{state:'invalid', reason:'unsafe marker file type'}`。同一次调用会通过 unlink
该同级文件来关闭这个间隙；这次 unlink 失败时，会表现为原语的提交后错误
`WorktreeMarkerCommittedError`，因此翻转依然成立，绝不会被反向补偿。在间隙内崩溃
会留下一个内容有效的 marker，外加一个与它共享 inode 的 `.qwen-session.<hex>.tmp`
同级文件。运维修复方法是移除遗留的同级文件——绝不是 marker——这样 marker 就恢
复为 `valid`。这种情形不会被自动恢复。

这种发布方式带来一个可移植性上的后果：恢复通道现在要求承载 worktree 的文件系统支
持硬链接，而先前普通的 `O_EXCL` 创建在任何地方都能工作。在不支持硬链接的地方，发
布会失败，暂存的同级文件被移除，也不会创建 marker，因此这种失败是 fail-closed 的
——reset 会在回滚它已开始的操作之后，以类型化的 `worktree_reset_invalid_state`
拒绝，而不是造成损坏。这是该原语有文档记载的边界，而不是缺陷；它既适用于恢复通
道，也适用于本来就通过同一独占创建提交的 worktree 创建路径。

### Sidecar schema 新增字段

`WorktreeSession` 新增两个可选字段：

```ts
supersededBy?: string; // on the old sidecar: the replacement that owns the worktree
supersedes?: string; // on the new sidecar: the session it replaced
```

`supersededBy` 链接是 restore 时读取的重定向信号——它被单独读取，先于任何 marker
读取或 `supersedes` 读取，因此重定向指向的是候选 owner，而不是已被证实的
owner（见下文「load/resume 时的 superseded 重定向」）。`supersedes` 链接让 reset
重试时的 resume 检查变成双向的，因此只有当 `supersededBy` 值所指的会话也声明自
己针对同一个 worktree 替代了 `S_old` 时，才会依据该值采取
行动。`isValidWorktreeSession` 把两者都作为可选字符串接受。不认识这些字段的读取
方会忽略它们。只有 daemon 路由写入它们；只有 restore/reset 路径读取它们。除此之
外，注册表、marker 格式以及 sidecar 不带版本号的结构都保持不变。

### Marker 缺失时的 restore 信号

当一次 Channel restore 走到所有权检查、且 marker 的严格读取结果恰好是 `missing`
——sidecar 有效、工作区与 containment 校验均已证实，只缺 marker——时，路由返回
`409`，错误码为 `worktree_marker_missing`，而不是通用的完整性失败。缺失并不是篡
改的证据（可能是崩溃窗口，也可能是任务内的 `git clean -fdx` 删除了这个被忽略的文
件）。Channel 把这个错误码映射为「用户可见的契约」中的恢复消息；reset 就是重新创
建 marker 的恢复路径。`invalid` 的 marker 保持现有的非类型化 fail-closed 行为，
且永远不会被自动恢复。这在不削弱防篡改边界的前提下，解决了任务被永久变砖的顾虑
（chiga0 F1，bot R3-2）。

### load/resume 时的 superseded 重定向

restore 路由在加载之前就已经会严格读取 sidecar，用来选择 worktree restore 的抑制
行为，并推导出所有权锁的键。superseded 判定刻意不基于这次预读做出：否则，一次并
发的、发生在提交点之前的回滚，会让路由把调用方重定向到同一个 daemon 即将删除的替
代会话。Channel restore 会在持有按 worktree 键控的锁之后重新读取一次 sidecar——此
时仍在 bridge 加载之前——如果这次锁内读取发现一个携带 `supersededBy` 的有效
Part 4A sidecar，就在此处停止，返回 `409`、错误码 `worktree_session_superseded`
以及替代会话的 ID。每个调用方收到的都是同一个类型化失败：非 Channel 的 restore
从 Part 4A 校验在加载之后重复执行的纵深防御检查中得到它，并直接据此
fail closed，就像它如今对待任何 restore 完整性错误一样。对 Channel 而言，这是一
条自愈途径，针对的是 daemon 侧已经完成、但注册表提交从未发生的 reset（worker 在
reset 响应与注册表写入之间崩溃）：manager 的加载捕获这个类型化信号，通过正常的
`loadManagedSession` 路径精确加载替代会话——要求相同的 root、相同的规范化
worktree 路径以及 `persisted-v1`——然后才在 owner 锁下提交注册表更新
`S_old → S_new`。如果替代会话校验失败，注册表保持不变，任务保持 fail-closed。成
功 reset 之后出现的同一种注册表写入失败窗口，也会在下一次选择或下一条消息时经由
这条路径自愈。如果 Part 4A 读取的结果指向一个 restore 并未加锁的 checkout，则会
在这两项检查之前以 `500` fail closed，之后的 restore 会依据锁内的读取结果进行分
类。

有一个子情形拥有专属的信号。如果重定向目标的 restore 失败，原因是 marker 仍指向
`S_old`，而 sidecar 对彼此一致（旧会话上是 `supersededBy: S_new`，新会话上是
`supersedes: S_old`），就说明转移在第 4 步与第 5 步之间崩溃了。daemon 返回
`409`，错误码为 `worktree_reset_interrupted`，Channel 将其映射为用户可见契约中的
中断转移消息——唯一一个以重试作为文档化修复手段的窗口，得到的也正是一条这样说明的
消息。

注意重定向能证明什么、不能证明什么。分类只读取 `supersededBy` 链接，且发生在任何
marker 读取之前，而这个链接是在翻转之前（第 3 步）写入的，因此重定向指向的会话可
能还不是 owner：在上述中断窗口中，目标自身的 restore 会失败；在第 3 步的窗口中，
目标的 restore 会成功，但完全没有 worktree attestation。精确加载目标，并要求
`persisted-v1` 以及预期的规范化路径，正是这一点把这两种形态都挡在注册表之外——重
定向是一条「去校验」的指令，而不是产权凭证；仅凭这个 409 就持久化
`replacementSessionId` 的调用方，可能会采纳一个随后被重试的 reset 回收掉的 id。

### 延后提问的 restore attestation（F2/R1-2）

本节更正本文档的第一版。第一版基于「该分支中的提问已停驻（parked）」这一前提，
提议在 `hasUnlocatedRestoredPrompt` 分支中执行迁移（relocate）。对照 bridge 代码
进行的评审表明，这个前提恰好颠倒了：

- 延后（停驻）的 restore 提问既不设置 `promptActive`，也不设置
  `goalTurnActive`，因此读出的是 `hasActivePrompt: false`，并流经 `else` 分支——
  该分支本就会执行迁移、要求返回的路径匹配，并给出 `persisted-v1` attestation。
  延后形态从来没有坏过。（这也是 R8-2 可见性修复刻意止步于 restore 响应值之前的
  原因：在那里放宽，会把这个正常工作的形态推入下面那个 fail-closed 分支。）
- 只有当一个冷恢复的会话确实存在活跃的 prompt 时
  （`hasActivePrompt && !attached && currentCwd === undefined`），才会进入该分
  支。在那里迁移是不可能的：`changeSessionCwd` 会串接到 prompt 队列上，并在有活
  跃 prompt 时抛出 `CdWhilePromptActiveError`，因此所提议的流程会让加载一直挂起
  直到超时、然后失败，丢弃已恢复的会话——这相对于如今的行为是一种回归，如今的行
  为只是返回一个未经 attestation 的会话。

因此，Part 4A 拒绝迁移这种形态，在实质上是正确的，并继续维持。`main` 中仍然存在
的问题是 chiga0 实际指出的评审发现：该分支会静默地给出不足的 attestation（附带
worktree 元数据，却没有 `persisted-v1`），导致之后的 Channel 加载在身份检查上失
败，而且没有任何信号说明原因。

修复采用 chiga0 给出的第二种形态——fail closed，而不是为一个未迁移的会话给出
attestation：移除 `hasUnlocatedRestoredPrompt` 分支，使这种形态落入现有的
`else if (session.hasActivePrompt)` 检查；当 `currentCwd` 为 undefined 时，该检
查会抛出 `Active session is outside its worktree`，restore 于是像其他所有无法验
证的状态一样，在完整性路径上失败。

随这次移除一同提出的可达性前提过宽，第 4 轮对此做了更正。评审者在 #10643 上运行
的 E2E 确实发现，在它所覆盖的形态下该分支不可达，但「原始的非 Channel 加载具有已
知的 `currentCwd`」这一点对冷恢复并不成立：bridge 的冷恢复响应根本不报告
`currentCwd`，而它的 `hasActivePrompt` 会把它已准入的 restore
`ask_user_question` 提问计算在内（`restorePromptAdmitted ||
promptActive || goalTurnActive`）。决定形态的是该提问停驻还是被触发——Channel
restore 通过上述延后机制让它停驻，而没有请求延后的 restore 会触发它，并在没有记
录 cwd 的情况下返回 `hasActivePrompt: true`。因此，对一个 transcript 以未回答问
题结尾的 Part 4A 会话执行受支持的非 Channel 冷恢复——启用了 daemon 的可选开关
`restoreAskUserQuestion`（正是它让该问题重新挂起等待回答），并提供了 client id
（正是它让该提问得以触发）——会带着一个活跃的提问到达该检查，该提问位于子进
程为自己恢复的 worktree 之内；无条件抛出会把这变成一个 500，杀掉它刚刚恢复的会话。

因此，该不变量比笼统的「无法定位的活跃 prompt 一律 fail closed」更窄：提问被触发而非
停驻的 restore，不会被视为位于其 worktree 之外。正是停驻，才使无法定位的提问可
以被读作非活跃；被触发的提问是一个活跃的回合（turn），只是响应没有报告它的位置。
对于路由无法定位、且并非由 restore 触发的 prompt，fail-closed 抛出仍保有其用途。

最终交付的形态让抛出取决于延后机制当时是否可用，而不是为每一次 Part 4A worktree
restore 都让 restore 提问停驻：对任何本可以延后的 restore，attestation 不足的分支
保持移除，只有对无法延后的 restore，它才会重新出现
（`hasActivePrompt && !attached && currentCwd === undefined &&
!deferRestoreAskUserQuestionPrompt`）。请求了延后、却仍报告一个无法定位的活跃
prompt 的 restore，会经由现有的 `Active session is outside its worktree` 检查
fail closed；从未请求延后的 restore 则保留 4B 之前的结果——附带 worktree 元数据，
但没有路由无法取得的 `persisted-v1` attestation，不迁移，也不 kill。这是刻意为恰
好这一种形态保留 R1-2 的静默 attestation 不足：感知隔离的调用方会在自己的身份闸
门处拒绝未经 attestation 的响应，这是一种可恢复的拒绝；而让 restore
fail closed，则会销毁调用方刚刚恢复的会话，而该会话所在的 checkout，正是未被抑制
的 restore 允许子进程自行置身其中的那个。一个非 Channel 回归测试将此固定下来——没
有持久化的 source，加载响应带有活跃 prompt 且没有 `currentCwd`：`200`、附带
worktree、没有 `changeSessionCwd`、没有 kill——一旦无条件抛出卷土重来，该测试就会
变红。

### Capability

将 `session_worktree_reset_v1` 加入 serve 的 capability 注册表，仅当 reset 路由
与转移原语都存在时才对外通告。worker 在启动时与
`session_worktree_persistence_v1` 一同读取它，并把一个 `sessionWorktreeReset` 布
尔值传入 `DaemonChannelBridge`；当该标志缺失时，bridge 会在调用其会话工厂之前就
拒绝 worktree reset 请求。因此，新 worker 对接旧 daemon 时，会在产生任何 daemon
侧副作用之前失败；旧 worker 则从不发送该请求。

## Channel 设计

### Manager reset

`NamedSessionManager.reset()` 用以下流程取代 Part 4A 的拒绝：

1. 在 owner 锁下，按现有方式解析选中的打开任务。
2. 如果任务是共享的，完全保持当前流程。
3. 如果任务是 worktree 隔离的，要求 `!isBusy(task.sessionId)`，否则抛出可据以采
   取行动的忙碌消息。然后调用下文新的 router 操作，替换任务记录中的
   `sessionId`（名称、cwd、隔离方式、target 和创建时间戳保持不变；更新时间戳与
   选中时间戳像共享 reset 时一样被刷新），原子地提交注册表，用任务存储的 cwd 激活
   新会话，并遗忘旧会话——与共享 reset 成功后的步骤相同。

注册表 schema 保持版本 1：只有任务的 `sessionId` 值发生变化。

### Router

新增 `SessionRouter.replaceManagedWorktreeSession(target, workspaceCwd,
expectedCwd, oldSessionId)`：

- 调用新的 bridge 方法 `resetWorktreeSession(oldSessionId, workspaceCwd,
options, bindingToken)`；
- 通过现有的 `validateManagedSessionIdentity` 校验响应，并把 `expectedCwd` 设
  为任务存储的 cwd——迁移到其他任何位置、或缺少 `persisted-v1` 的采纳（adoption）
  会 detach 新客户端并失败，不发布 target/cwd/live-route 状态；
- 成功时记录新会话的 target 与规范 cwd，并返回新会话 ID。

load 路径在 router 内部（而不是 manager 内部）处理 superseded 重定向：当
daemon 抛出类型化的 `worktree_session_superseded` 错误时，
`loadManagedSession` 从中读出替代会话的 ID，对该 ID 精确加载一次（第二次
superseded 响应是真正的失败，而不是再跳一次），修复指向被替代会话的路由映射，
并把修复后的 ID 与 `loaded` 一起返回。manager 的 `loadTask` 在它进行的每一次注
册表写入中都使用该 ID——修复会被合并进已存储的 owner，而不是从修复前的快照重
建——因此 `use`、`close` 与锁解析都无法覆盖它。

类型化的 restore 失败会在共享的命名会话错误界面上映射为上文所示的有界消息，每
条选中、消息与 `/clear` 路径都已经通过这个界面报告错误：
`worktree_marker_missing` 映射为恢复消息，`worktree_reset_interrupted` 映射为
中断转移消息。这两个错误码只由 load/resume 路由产生，因此它们是包裹在 manager
的通用加载失败中到达该界面的，而不是经由 reset 调用——reset 路由会自行续做被中
断的转移。因会话忙碌而被拒绝的 reset 保留它自己的「先取消」措辞，其他所有
daemon 失败都保留现有的通用命名会话消息。

### Bridge、worker、SDK

- `ChannelAgentBridge` 新增可选的 `resetWorktreeSession`；daemon bridge 实现它
  时带有 capability 闸门（`options.sessionWorktreeReset`），并经由现有的会话工
  厂管道转发，请求中新增 `worktreeReset: { sessionId }` 字段。
- daemon worker 从 capabilities 信封中读取 `session_worktree_reset_v1`，并把该
  标志传入 `DaemonChannelBridge`，与 `sessionWorktreePersistence` 的做法一致。
- SDK 新增 `DaemonSessionClient.resetWorktree(...)` 入口，它 POST 新路由，并为
  返回的替代会话构造客户端；当存在 `worktreeReset` 时，worker 的会话工厂会分支
  到该入口。现有的 reattach 身份守卫原样适用于替代会话的客户端。

### 命令与消息界面

- `doClear` 不变：manager 的 reset 要么成功，由现有的按会话清理退役 `S_old`
  （非破坏性；从不向它传入任何 worktree 路径），要么在任何副作用之前抛出。
  manager reset 的返回值新增任务的隔离方式，以便确认消息能注明 worktree 文件已
  保留。
- worktree reset 的确认消息注明文件已保留。
- 忙碌的 worktree reset 返回上文的「先取消」消息。
- restore 时 marker 缺失的失败返回上文的恢复消息，被中断的转移返回上文的重试消
  息——各自采用选中任务或非选中任务的形态。daemon 错误不携带任务身份，因此
  manager 通过它抛出的错误把失败任务的名称传递给消息界面
  （`NamedSessionTaskError.taskName`）；没有这个名称，消息既无法点名该任务，也
  无法判断该任务是否为选中任务，于是退回到不点名、不含 clear 的措辞。

## 兼容性

- `multiSession` 缺失或为 false：没有任何变化。
- 共享任务：reset、create、load、close 均不变。
- 旧 daemon + 新 worker：缺少 `session_worktree_reset_v1` 会使 reset 请求在
  bridge 中、在任何 daemon 调用之前失败；restore 行为不变。
- 新 daemon + 旧 worker：worker 从不调用该路由；Part 4A 行为不变。
- Part 4A 注册表：没有 schema 变化；会话 ID 的替换只是值的变化。一次完成的
  reset 之后提交的注册表指向 `S_new`，其 sidecar 与 marker 在任何理解
  `isolation: "worktree"` 的二进制上都能正常校验通过。
- 在 reset 与重启之间降级：较旧的 worker 读取同一份注册表，并通过 Part 4A 路径
  恢复 `S_new`；早于 `supersededBy` 的读取方会忽略它。
- reset 之后的 `S_old`：它的 transcript 与 catalog 记录保留，restore 对每个调
  用方都以类型化的 `worktree_session_superseded` 重定向和替代会话 ID fail
  closed。发出该重定向的加载前停止点是 Channel 作用域的，但每次非 live restore 都
  会运行的 Part 4A 校验会在查阅 marker 之前重复这项检查，因此非 Channel 调用方
  收到的是同一个类型化错误码，而不是普通的、非类型化的 Part 4A 完整性 `500`——
  并且只是据此 fail closed。出于同样的原因，每次非 live 的 Part 4A restore 都会
  获取按 worktree 键控的所有权锁：reset 路由是公开的，因此在转移正在移动所有权
  时，不带 source 的 restore 不得 attest 独占所有权。若读取到的 Part 4A sidecar
  指向一个该 restore 并未加锁的 checkout，则会在这两项检查之前以 `500` 失败。
  `S_old` 永远不会重新占有该 worktree。

## 用户可见的错误类别

有界消息，不包含路径、会话 ID 或 daemon 响应体——允许包含任务名，下面两个恢复
类别会插入一个任务名：

- 忙碌的 worktree reset（「先取消」指引）；reset-pending 屏障复用同一个类型化
  的 `worktree_reset_active` 拒绝，并且按决策不为它提供面向聊天的消息——
  Channel owner 锁让用户进不了这个窗口，所以只有非 Channel 的 API 调用方会遇到
  它；
- 不具备 reset capability 的 daemon；
- reset 期间 worktree 状态无效或不可用（通用的命名会话失败，沿用现有的细分类
  别）；
- restore 时 marker 缺失（恢复指引：clear 以重建，或 close）——仅当失败的任务
  是选中任务时才提供，因为 clear 总是作用于选中项；否则消息会点名失败的任务，
  并指引先选中它，或用 `/session close` 关闭它，后者无需加载目标；
- 中断的转移（重试指引：再次 clear 以完成），适用同样的选中任务条件，也提供同样
  的非选中替代方案；
- 被替代任务的恢复在其他情况下静默修复，仅当替代会话校验失败时才以通用加载失败
  的形式暴露。

## 实现顺序

1. Bridge 延后提问的可见性（R8-2）：一个共享的「进行中的 prompt」定义，覆盖停驻
   提问所在的 map，由 coalescer 与 `getSessionSummary` 使用——并且明确不被
   restore 响应的 `hasActivePrompt` 使用；reset-pending 屏障原语（设置、拒绝准入、
   清除）；转移第 6 步所需的切断 attach 与清除 worktree 关联的接口，其中切断
   attach 会报告被替代的条目是否真的已经消失，以便第 6 步能暴露存活者。
2. Core marker 原语：在异步的严格 marker 读取器旁边新增一个同步、no-follow 的严
   格 marker 读取器（用于 `assertCanCommit` 复查），然后实现带有对其他 uid 的拒绝与
   compare-and-swap 提交形态的 `transferWorktreeSessionMarkerOwner`，并为每个崩
   溃窗口编写严格读取器测试。
3. Daemon 路由 `POST /session/:id/worktree-reset`：按 worktree 键控的串行化（把
   restore 锁扩展为 `acquireWorktreeOwnershipOp`）、前置条件、可续做的转移协
   议、回滚、capability 注册。
4. Restore 变更：superseded 重定向、中断转移信号、marker 缺失的类型化失败，以及
   把 attestation 不足的 `hasUnlocatedRestoredPrompt` 分支收窄到那些无法延后其
   提问的 restore——其他所有无法定位的活跃 prompt 都 fail closed。
5. SDK 路由方法与 worker 转发；bridge capability 闸门；router 替换操作与
   superseded 处理；manager reset；消息。
6. 文档更新（见下文）。
7. 每一层的针对性测试，然后是仓库 build/typecheck/lint、基于 daemon 的 Channel
   E2E 计划，以及要求的审计轮次。

## 预期的生产代码范围

- `packages/acp-bridge/src/bridge.ts`、`bridgeTypes.ts` 与
  `bridgeErrors.ts`（摘要与 coalescer 中的延后提问可见性、reset-pending 屏障及
  其类型化准入错误、切断 attach、清除 worktree 关联）
- `packages/core/src/services/gitWorktreeService.ts`（转移原语、同步的严格
  marker 读取器）
- `packages/core/src/services/worktreeSessionService.ts`（`supersededBy`、
  `supersedes`）
- `packages/core/src/utils/atomicFileWrite.ts`（仅复用；预计不改动）
- `packages/cli/src/serve/routes/session.ts`（新路由、restore 变更）
- `packages/cli/src/serve/capabilities.ts`（`session_worktree_reset_v1`）
- `packages/sdk-typescript/src/daemon/DaemonClient.ts` 与
  `DaemonSessionClient.ts`（路由方法、替代会话客户端）
- `packages/channels/base/src/ChannelAgentBridge.ts`、
  `DaemonChannelBridge.ts`、`SessionRouter.ts`、`named-session-manager.ts`、
  `ChannelBase.ts`（reset 管线、capability 闸门、消息）
- `packages/cli/src/commands/channel/daemon-worker.ts`（读取 capability）

文档更新：`docs/users/features/channels/overview.md` 删除「reset 已延后」这一限
制说明（这是唯一记载该限制的用户文档位置），并记录「先取消」的 reset、文件保留
与 marker 恢复；`docs/developers/qwen-serve-protocol.md` 与
`docs/developers/daemon/08-session-lifecycle.md` 定义新路由、capability 与类型化
错误。

测试仍与代码放在一起。E2E 计划在实现期间放入 `.qwen/e2e-tests/`，不提交。

## 验证计划

### Manager、router、命令

- 对选中的 worktree 任务执行 `/clear`、`/new`、`/reset`：在任务空闲时成功，保留
  name/cwd/isolation，且只替换会话 ID。
- 忙碌（运行中、排队中或等待权限）的 worktree reset 会在任何 `ChannelBase` 清理
  副作用发生之前被拒绝；共享任务忙碌时的 reset 行为不变。
- reset 响应缺少 `persisted-v1`、指向另一个 worktree 或指向根工作区时，会 detach
  新客户端，且不提交任何东西。
- 被替代会话的 restore 会自愈：只有在替代会话通过精确校验之后，注册表才切换到替
  代会话。
- 中断的转移会给出重试提示消息，重试的 `/clear` 会完成该转移。
- 恢复建议依状态而定：当选中的是第二个、健康的任务时，另一个（未选中的）任务上的
  marker 缺失或转移中断失败会点名那个任务、指向 `/session close <name>`，并且绝
  不让用户再次 clear——随后的 `/clear` 仍然作用于当前选中的任务，这正是建议不能推
  荐再 clear 一次的原因。针对选中任务的措辞由它自己的用例逐字锁定。
- 跨 owner 隔离、最多八个打开任务的上限，以及不区分大小写的名称唯一性，都不会因
  会话 ID 的替换而改变。

### Daemon 路由与转移

- 完整的前置条件矩阵：未知会话、共享会话、外来工作区、错误的 `originalCwd`、
  containment 校验失败、活跃的 prompt、待处理的交互、停驻的延后提问（借助可见
  性修复予以拒绝）、无效的 marker、marker 缺失但 sidecar 有效（接受）、marker 缺失
  且没有 catalog 记录（拒绝），以及残留的 attach 被转移切断、而不是阻塞转移。
- reset-pending 屏障会拒绝在静止检查之后才请求准入的 prompt，并会在翻转之前的每一
  条失败路径上被清除——翻转之后，释放屏障归一次已完成的切断负责，而不归失败的请求
  负责；翻转前的重新校验会中止 prompt 状态已发生变化的转移。同一个屏障也拒绝其他
  能触及 checkout 或移动会话 cwd 的写入方——在转移中途请求准入的 rewind、cwd 变更、
  branch、fork-agent 启动、shell 命令、workflow 任务操作或 goal 控制，都必须以同
  一个类型化失败被拒绝，并且删掉其中任何一个守卫都必须让它的测试变红。
- 针对共享同一个 worktree 的两个会话（转移完成后的形态）发起的两次并发 reset 不
  可能同时胜出：第二个会在锁、owner 复查或发布用 link 的 `EEXIST` 上失败。
- 在每个转移步骤注入崩溃，证明文档所述的结果：转移前的崩溃让 `S_old` 保持权威；
  转移后的崩溃会 restore `S_new`；重试的 reset 会把半完成的转移恰好完成一次，而
  marker 已经指向 `S_new` 时，resume 是一次空操作。仅存在反向链接的那个窗口（第 3
  步崩溃、没有替代会话的 sidecar）被锁定为 fail-closed 的
  `worktree_reset_invalid_state`，被中断的状态保持原样——正是写入顺序让重试能够观
  察到这个窗口，而不是对它视而不见。
- 替代会话忙碌时的翻转后 resume：在 marker 翻转之后崩溃，让 `S_new` 变为忙碌（某
  个客户端经由 superseded 重定向到达了它），再重试 `S_old` 的 reset——路由以
  `worktree_reset_active` fail closed，marker、`S_new` 的 sidecar 以及 `S_new`
  的记录全部保留；之后待 `S_new` 空闲时再次重试，则作为空操作的 resume 完成。破
  坏性回滚绝不能作用于 marker 所指向的会话。
- 在第 3–5 步注入受控失败时，补偿会精确恢复到 reset 之前的状态。
- marker 转移绝不跟随被换入的符号链接，绝不留下不完整或空的 marker，并且会在提交
  点重新读取 owner。
- 属主 uid 与 daemon 不同的 marker 会被拒绝，而不是被原地写入，因此
  `atomicWriteFile` 中那条非原子的、保留文件属主的路径永远不会被选用于 marker。
- worktree 目录、其中的文件（已跟踪、已修改、未跟踪）以及它的分支在 reset 前后逐
  字节一致；只有 marker 的内容发生变化。

### Restore 与 bridge

- marker 缺失 + sidecar 有效：restore 以类型化的 marker 缺失信号失败；reset 能够
  恢复；恢复提示消息会送达聊天。
- 无效的 marker：restore 与 reset 都 fail closed；不会重新创建任何东西。
- prompt 仍然活跃且无法定位的已恢复会话，会经由现有的活跃会话检查 fail
  closed（不会静默地给出不足的 attestation），并且被移除分支的形态由一个测试
  覆盖，一旦该分支回来，这个测试就会失败。与之对应的已触发提问情形也在旁边一并
  覆盖：对一个 transcript 以未回答问题结尾的 Part 4A 会话执行非 Channel 的冷
  restore，其 load 响应报告存在活跃 prompt 且没有 `currentCwd`，此时返回 200
  并附上 worktree，而不是返回 500 杀掉它刚刚恢复的会话。
- 延后提问的可见性：停驻的 restore 提问在 `getSessionSummary` 与 coalescer 中
  读作活跃；R8-2 的并发 restore 探针（等待方观察到延后状态，不出现
  `CdWhilePromptActiveError` 500）被复现为一个回归测试。
- 同一个可见性修复仍让延后的 worktree restore 经由执行迁移的分支拿到
  `persisted-v1`——对此直接断言，这样日后若扩大 restore 响应中 `hasActivePrompt`
  的范围，失败的会是测试，而不是让 restore 静默失败。
- 被替代会话的 restore 抢占 bridge load，并携带替代会话的 ID；中断的子情形携带
  `worktree_reset_interrupted`。
- capability 缺失：bridge 在 factory 运行之前就拒绝；旧 daemon 的响应无法通过
  Channel 校验，且不会创建任何状态。

### 并发 E2E

扩展 Part 4A 那份基于 daemon 的计划：创建共享任务 + worktree 任务，运行工作，在
计划中途 reset 一个 worktree 任务，验证全新的对话、完好的文件（包括未提交的改
动）、不变的任务列表以及 Part 3A 标签；在模拟删除 marker 之后通过 reset 恢复；在
reset 之前和之后分别重启 worker 与 daemon；任务运行时 reset 被拒绝，执行
`/session cancel` 之后再成功。

### 仓库检查

先跑针对性的包测试，然后 `npm run build`、`npm run typecheck`、`npm run lint`；
由 test-engineer 执行基于 daemon 的 E2E；交付前完成规定的自审轮次（连续两轮无问
题）。

## 风险与控制

### 转移崩溃窗口

风险：转移中途崩溃会让任务滞留在两个 owner 之间。

控制：转移的步骤经过排序，使 marker——唯一的所有权权威——最后翻转，被替代会话的
sidecar 让翻转可被发现，并且路由会在重试时续完半完成的转移。两次 sidecar 写入的
顺序也出于同样的理由：`S_old` 上的 `supersededBy` 先落盘，因此不会有任何窗口留下
一个无人读取、重试也看不到的正向链接。每个窗口及其结果都已在上文的协议中逐一列
出，包括哪些会被重试回滚（链接对相互一致），哪些会 fail closed 以待运维修复（链
接对不一致、无效的 marker、owner 不明确、存活却没有 marker 的替代会话）。

### 忙碌任务的 reset

风险：在 worktree 中有 prompt 正在执行时转移所有权，会与文件写入及 marker 翻转发
生竞争。

控制：静止状态以屏障加复查的方式强制执行，而不是一次采样——从前置条件闸门起直到翻
转，bridge 都会拒绝 reset-pending 会话上的新工作，覆盖 prompt 准入以及另外七个能
触及 checkout 或移动会话 cwd 的写入方（`sendPrompt`、`rewindSession`、
`changeSessionCwd`、`branchSession`、`launchSessionForkAgent`、
`executeShellCommand`、`controlSessionWorkflowTask`、`controlSessionGoal`），并
且在翻转之前立即重新校验静止状态。rewind 正是拦截不能止步于 prompt 的原因：它恰
恰在路由所要求的空闲状态下被准入，排到同一个队列上，并且不设置翻转前复查所读取的
任何标志——两个控制类写入方也是如此：一个是在该 cwd 中通过会话自身的工具注册表运
行的 workflow 操作，另一个是 goal `resume`，它启动的回合从不经过 `sendPrompt`。
shell 命令是这八个中最强的一个——它在条目的有效 cwd 中运行，对已迁移的
worktree 会话而言，这个 cwd 就是 checkout 本身——因此它同样被拦截。这八个就是拦截
的全部，而拦截并不覆盖所有能到达子进程的东西：按设计，释放与停止路径在转移中途保
持可用（`cancelSessionTask`、`clearSessionGoal`、`detachClient`、
`killSession`）；`continueSession` 本身不设闸门，而是在它用来驱动续接的
`sendPrompt` 准入处被间接拒绝；daemon 内部的 `enqueueBackgroundNotification` 不
设闸门，因为没有任何 HTTP 路由调用它，而且它只是把一条通知入队，并不启动回合。
Channel 会预先拒绝忙碌的任务（`isBusy` 覆盖排队中、运行中和等待权限的状态）；用
户需要先取消。可见性修复落地后，停驻的延后 restore 提问计为忙碌，因此停驻在某个
已恢复提问上的任务，无法在该提问仍待回答时被 reset 掉。

### 并发 reset 双胜

风险：在一次已完成或已崩溃的转移之后，两个会话持有指向同一个 worktree 的有效
sidecar；两次并发 reset 可能都去认领 marker。

控制：串行化以规范化的 worktree 路径为键，提交是一次 compare-and-swap（对
`valid` 形态，在 rename 提交时复查 owner；对 `missing` 形态，依靠发布用 link 返
回的 `EEXIST`），并且被替代会话的 sidecar 会被导向 resume 路径，而不是发起一次与
之竞争的转移。在所有形态下，后完成的一方都会 fail closed。

### 旧会话的静默降级

风险：reset 之后，对 `S_old` 的 restore 可能回落到共享的根工作区，并在错误的目录
中恢复一段陈旧的对话。

控制：`S_old` 的 sidecar 被保留并标记为已被替代；它与 marker 不再匹配，因此每条
restore 路径都会 fail closed。类型化的 superseded 信号是唯一的重定向，并且它要求
替代会话先通过完整的身份校验，Channel 注册表才会切换。

### 恢复通道被滥用

风险：marker 缺失的恢复通道可能在一个被刻意剥离的 worktree 上重新建立所有权。

控制：该通道要求严格有效的 Part 4A sidecar、匹配的 catalog 记录、containment 校
验与静止状态同时满足，而无效（而非缺失）的 marker 仍然 fail closed。恢复替换的是
对话；它从不修复或信任被篡改的 marker。

## 备选方案评估

### 扩展 `POST /session` 创建接口，增加 adopt 选项

否决。create 路由的不变量在 #10643 中经过九轮评审才得以加固；把 adopt 的前置条
件、一份不同的回滚契约（绝不移除 worktree）以及替代步骤穿插进去，恰恰会模糊评审
者已经认可的那些边界。专用路由让这个新的生命周期操作保持显式，共享实现层面的辅助
函数而不共享控制流，并且在旧 daemon 上因路由不存在而 fail closed。

### 对 worktree 任务复用现有的共享 reset

否决——这正是 Part 4A 设计本身已经否决过的方案。在 worktree 路径上创建替代会话，
会经由一个未注册的工作区进行路由；在根工作区中创建，则会把 worktree 的所有权滞留在
旧会话上。两者都无法保持精确恢复。

### 不带提交点检查、以盲目的临时文件 rename 转移所有权

在本设计的评审过程中被否决。单纯的 rename 并不是 compare-and-swap：marker 不存在
时，它退化为最后写入者胜出；即便 marker 存在，开头的严格读取与 rename 之间的窗口
也无人把守。提交必须复查 owner（`assertCanCommit`），或者以不存在为前提进行排他
（独占发布时的 `EEXIST`）。

### 以 unlink + 独占创建转移所有权

对 `valid` owner 形态予以否决。unlink 与重新创建之间的窗口会让 worktree 没有
owner；在那里崩溃，就会迫使一次例行操作依赖恢复通道。（对 `missing` 形态，独占创
建恰恰是正确的做法，也正是该原语所采用的方式——先在同级文件中暂存，再通过 link 发
布。）

### 把旧会话 ID 重新挂到新对话上

否决。复用会话 ID 会把两段对话混同于同一个 transcript 身份之下，并破坏 daemon 按
会话划分的存储寻址。使用全新的 ID，能让 reset 在语义上与系统其余部分已经建模的共
享任务 reset 完全一致。

### 在 daemon 路由内部先取消再 reset

否决。prompt 取消是 Channel 所拥有的语义，带有有时限的收尾过程和对卡住回合的处
理；把它推进 daemon 路由，就会在一个看不到聊天的地方重复这套策略。要求静止状态可
以只保留一种取消实现；reset-pending 屏障拒绝新的准入，而不取消任何东西。

### 在 reset 期间删除旧会话记录

否决。共享 reset 会在 daemon catalog 中保留之前的对话；worktree reset 也一样。阻
止旧会话重新占有 worktree 的，是被替代会话的 sidecar，而不是删除。

### 在本 part 落地 orphan-reap worktree 清理

在本设计的评审过程中被否决。它是整个系列中唯一会删除用户可见状态的路径，而评审表
明，它的正确形态（调用点位置、`kind === 'removed'` 门控、遇到替代链接时拒绝、安
全删除分支的不变量）需要一个专门的评审周期，而不是搭在一个契约为「不删除用户可见
状态」的 part 旁边一起落地。它已在后续 issue #11024 中完整规定。

## 退出标准

满足以下条件时，Part 4B 即告完成：worktree 任务在原地 reset 且文件完好；忙碌的任
务以及因延后提问而停驻的任务，其 reset 都会被干净地拒绝；marker 缺失只能通过
reset 恢复；被篡改的 marker 绝不会自动恢复；半完成的转移会由重试完成，并经由
superseded 重定向得到修复；attestation 不足的 restore 分支已被移除，且延后提问的
可见性修复关闭了 R8-2；并且没有任何路径会删除用户可见的或既有的状态——回滚只移除
替代会话自己的 sidecar 和记录。

Issue #10103 在上述条件成立，**并且**表中其余的处置均已满足时关闭：四项遗留修复
（R8-1、R8-3、R1-1、F3）已包含在本 PR 中；后续 issue #11024（reap 清理、同级删除
路径，以及对 `SessionRouter.ts:487` 的调查）已解决，或已由 maintainer 明确接受。
