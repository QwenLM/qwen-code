# Managed child Workspace 能力（隔离切片，I1）

[English](2026-10-09-managed-child-workspace.md) | [简体中文](2026-10-09-managed-child-workspace.zh-CN.md)

状态：I1 已在本变更中实现。已落地：child Workspace（父 storage 内的一个 Git linked worktree）、它带 fencing 与恢复的持久命令、合并与丢弃两种收尾、storage lease 的维护 hold，以及把 child Session 绑定到已准备好的 child Workspace。仍是设计：I2（`worktree` 准入、relay 与级联接线）与 I3（`snapshot`，以及串行化的裁定），各有后续切片（见后续工作）。这是 [#12827](https://github.com/QwenLM/qwen-code/issues/12827)（Managed Agent 提案 [#12380](https://github.com/QwenLM/qwen-code/issues/12380) 的阶段 H）的隔离切片，由 [#13753](https://github.com/QwenLM/qwen-code/issues/13753) 跟踪。它拆分自 H4c（[#13743](https://github.com/QwenLM/qwen-code/issues/13743)，PR #13754），其[设计](2026-10-09-managed-workflow-child-kind.zh-CN.md)在决策 11 中确定了词汇。它承接 H4a（[记录契约](2026-10-06-managed-child-agent-runtime.zh-CN.md)）与 H4b（[child Session 运行时](2026-10-07-managed-child-session-runtime.zh-CN.md)）。

## 问题与范围

Issue #13753 要求三项：

- **I1，一项 Workspace 能力。** 一个 provider 操作：从父 Session 绑定的 Workspace、在记录下来的修订上创建 child worktree，把 child Session 绑定到它，之后把它合并回去或丢弃。它需要自己的持久命令、fencing 与恢复。
- **I2，`worktree` 准入。** relay 在 child 自己的 Workspace 中创建 `worktree` child，settle 与关闭路径执行合并策略，launch 准入放行 `worktree`。
- **I3，`snapshot` 与串行共享。** 一个只读的冻结视图，以及对是否需要在 Workspace lease 之外再加按 child 的 generation 或 barrier 的裁定。

本变更交付 I1，并记录 I2 与 I3 的方向。其中没有任何内容是模型可触达的：`MANAGED_CHILD_ADMITTED_WORKSPACE_MODES` 仍只放行 `shared`，relay 从不准备 child Workspace，且能力在运维显式开启前是关闭的。这与 H4a 的顺序相同：能力先落地、由自己的测试套件证明，然后才有生产方。

## 现状

以下事实取自 `main` 的 `f20ed558e3`，此时 H4c（#13754）已落地 `workflow` child kind。

- **Child 绑定。** `ManagedAgentStore.insertChildSessionCommand` 用一条 `INSERT ... SELECT` 把父的整套绑定复制进 child 行：Workspace、generation、storage、`cwd_relative`、context 与 policy 引用。记录中的 `workspaceMode` 与 `workingDirectory` 在两种语言里都会校验，但没有运行时读取它们。
- **Storage 与挂载。** storage 的根是管理员挂载（`runtime-broker.workspace-mounts`：tenant、storage、root）。挂载是静态的、规范化的，且不得重叠或嵌套。W1 §5.1 要求运维把 storage 根放在所有 Git worktree 之外，并把 Session 工作目录放在它的子目录中。
- **Storage lease。** `managed_workspace_execution_lease` 每个 storage 一行，同一时刻只有一个 holder。holder 是一个 Runtime Session（`binding_id`、`runtime_generation`、`runtime_session_id`）。遇到其他 holder 的 tool turn 会收到可重试的 `workspace_busy` 并轮询。W1a 的 fence 与注册要求 lease 空闲；W0e 的 `releaseLost` 清除丢失 binding 的 holder，并把其他任何 holder 形态当作损坏。
- **Worker 的边界。** worker 把 binding 解析为挂载根拼接 `cwd_relative`。工具可以触及挂载内任何位置，但不能进入另一个已安装 Session 的目录。W1 §5.1 说明这种布局减少意外，但不约束主机允许的工具访问。
- **Git。** 没有 Java 代码运行 Git。TypeScript 为 daemon 和旧版 Agent 工具提供了 worktree 原语（`createUserWorktree`、`removeUserWorktree`）。它唯一的回合并是 Arena 的 `applyWorktreeChanges`：应用补丁，并把冲突报告为 Git 的错误文本。

## 决策

1. **child Workspace 是父 storage 内的一个 Git linked worktree。** 它的目录是 `<storage 根>/.qwen-child-workspaces/<childWorkspaceId>`，其中 `childWorkspaceId` 是 `sha256(tenant NUL parentSessionId NUL childRunId)` 的前 32 个十六进制字符。child 绑定保留父的 tenant、Workspace、generation、storage、context 与 policy 引用；只有 `cwd_relative` 改为 worktree 目录加上父在其仓库内的偏移。之所以不给它单独的 storage，是因为挂载是静态的且不能嵌套，新 storage 需要动态挂载注册、新的 W1a 守卫，在 Kubernetes 下还需要新的 CSI 注册。同一个 storage 则保留挂载守卫、marker、lease，以及将来的同一个 PVC。
   - 结果：child 的 tool turn 仍经由同一个 storage lease 与父串行，与 `shared` child 完全一样。这里的隔离是工作目录树的隔离，既不是并发，也不是安全边界（W1 §5.1）。
   - 与所有 linked worktree 一样，它与父共享对象库与 refs。child 在其 detached worktree 中做的提交不会作为提交被合并：合并读取的是 worktree 的内容。
2. **布局要检查，从不假定。** 父的工作目录必须位于一个 Git 仓库中，该仓库的顶层严格位于 storage 根之内，其 Git 目录与 common 目录也在根之内。以下情形一律以 `child_workspace_layout` 拒绝：storage 根本身位于某个仓库内（W1 §5.1 排除的布局）、目录不在任何仓库中、裸仓库、位于预留目录内的仓库、指向根外的 Git 目录，快照不包含的父目录（空目录或被忽略的目录），或会违反每个 Session 目录都要满足的规则（最多 1024 个 code point）的 child 目录。预留的 `.qwen-child-workspaces` 目录必须是真实目录，绝不能是符号链接。
3. **base 修订是父工作区的快照提交。** 准备时，控制面把 `HEAD` 读入一个私有 index 文件，对它执行 `git add -A`，再把得到的树提交在 `HEAD` 之上。私有 index 从 `HEAD` 起步，而不是复制父的 index，因为副本会带上 `assume-unchanged` 与 `skip-worktree` 标记，使改动对 `git add` 不可见。因此该提交包含父已提交、已暂存、已修改以及未跟踪且未忽略的文件，而父自己的 index、`HEAD` 与工作区从不被触碰。被忽略的文件（构建产物、`node_modules`）不会带过去。提交使用固定身份与固定日期，所以对未变内容重算会得到同一个提交。它的 id 在创建 worktree 之前记录，worktree 以 detached 方式检出到它。
4. **行需要时，提交被 pin 住。** base 以 `refs/qwen/child-workspaces/<id>/base` pin 住，算出的结果以 `.../result` pin 住，所以 `git gc` 永远不会回收它们。合并会删除两个 pin。其他所有收尾在存在结果时都保留 result pin，所以丢弃永远不会删除 child 产出的工作，除非该工作已被合并。
5. **合并策略是对父工作区的三方合并，在树外计算。**
   - child 的结果 `C` 是 worktree 的快照（同样的私有 index 技术），位于 base `S` 之上。
   - 父的当前状态 `P` 是父工作区的快照。
   - `git merge-tree --write-tree --merge-base=S P C` 计算合并树 `M`，不触碰任何工作区或 index。
   - 冲突时，行以 `conflicted` 结束并带上冲突路径（最多记录 100 条），父中不写入任何内容。合并冲突是一个持久结果，绝不是静默覆盖。worktree 与 base pin 立即被移除，而 child 的结果仍被 pin 住（决策 4）；随后由丢弃让该行退役。
   - 干净合并时，只写入 `P` 与 `M` 之间有差异的路径，作为父工作区中的未提交改动。父的 index 与 `HEAD` 保持原样，所以 child 的工作到达时就像父自己做的编辑一样。
6. **写入可续做，并逐路径检查。** `P` 与 `M` 在写入任何内容之前记录。每次写入尝试都会对当前工作区 `W` 做快照，并要求每个变化路径要么是它的 `P` 版本，要么是它的 `M` 版本；仍处于 `P` 的路径用一次树到树补丁的 `git apply` 写成 `M`。因此在两个文件之间崩溃，会从停下的地方续做。任何其他内容都意味着 lease 之外有东西改了树；行以 `blocked` 结束，不覆盖任何内容。写入之后，先对照 `M` 校验树，然后行才成为 `merged`。合并与它的写入在同一个维护 hold 下运行（决策 10），所以在算出 `M` 与写入之间，没有 tool turn 能改动父的目录树。
7. **丢弃移除 worktree，保留产出的工作。** 丢弃用 `git worktree remove` 移除已注册的 worktree，然后在不跟随其中任何符号链接的前提下移除预留路径上剩下的一切，执行 prune，并删除 base pin。预留路径属于控制面，所以模型在那里替换或清空过的目录也会被移除，留在那里的符号链接只作为链接被移除，绝不跟随。记录的仓库已不存在时（其顶层没有 Git 目录），只移除目录。其他任何拒绝，例如不安全的配置（决策 11）、变化了的布局或瞬时故障，都会像其他步骤一样让丢弃失败，所以 prune 与 pin 的清理绝不会被跳过。丢弃是失败与取消 child 的收尾，也是走出 `conflicted` 与 `blocked` 的出口。
8. **每个 child run 一条持久行。** `qwen_managed_child_workspace`（V58）对每个（tenant、父 Session、child run）保存一行。状态如下：
   - `preparing` → `ready`，或在布局被拒绝时 → `failed`（什么都没创建）。
   - `ready` → `merging` → `applying` → `merged`，或 `merging` → `conflicted`。
   - `preparing`、`ready`、`conflicted`、`blocked` 或 `failed` → `discarding` → `discarded`。
   - 任何活动状态在证据无法对齐时 → `blocked`。

   无法完成的丢弃以 `blocked` 结束并清除其请求，所以行绝不会回到刚刚失败的丢弃中循环；新的丢弃请求会重试它。收尾请求（`merge` 或 `discard`）只记录一次。重复的请求直接回答这一行；不同的请求被拒绝，例外是 `discard` 可以跟在以 `conflicted` 或 `blocked` 结束的 `merge` 之后。只有 `ready` 的行才接受合并；绑定的 child Session 未关闭时不接受任何收尾，因为收尾会在一个运行中的 Session 脚下移除目录。

9. **claim 隔开写入方；scan 续做工作。** 行带有 `claimed_by`、`claimed_until` 与 `claim_generation`。每次迁移都是对状态与 claim generation 的比较并设置，所以 claim 已过期的 worker 无法提交步骤。定时 scan（`qwen.managed-agent.child-workspace.scan-delay`，2 秒）驱动每一条处于活动状态或欠着收尾的行，从服务调用的操作同步驱动相同的步骤。每个物理步骤都是幂等的，从磁盘与行中的内容对齐，绝不依赖内存。一次 claim 持续 2 分钟，步骤运行期间每隔其三分之一续期一次，所以缓慢的 Git 命令绝不会让第二个 worker 进入仍在进行的步骤；步骤结束即释放。存活的 claim 绝不会被认领两次，连它自己的 worker 也不行，所以同步调用与 scan 不会同时运行同一行。claim 已被他人接走、或在其大部分生命期内都未能续期的步骤会停止：不再启动新的 Git 命令，正在运行的那条会被终止，所以失去 claim 的 worker 绝不会与接管该行的 worker 同时写入。拿不到 storage lease 的步骤等待 1 秒且不消耗尝试次数。其他失败以从 1 秒翻倍到 60 秒的退避重试，16 次尝试后行以 `blocked` 结束并带上最后的错误。
10. **物理步骤在 storage lease 的维护 hold 下运行。** 每个步骤之前，worker 以维护 holder 的身份占用该 storage 的 `managed_workspace_execution_lease` 行：`holder_key = sha256("child-workspace" NUL id NUL claimGeneration)`，Runtime holder 各列为空，新增的 `maintenance_id` 列设为行 id。步骤结束时释放 hold。
    - 遇到该 hold 的 tool turn 收到既有的可重试 `workspace_busy` 并轮询，所以合并绝不会与写父工作区的 turn 竞争。
    - W1a 的 fence 与注册本就要求 lease 空闲，所以它们也会等待。
    - W0e 的 `releaseLost` 识别维护形态不属于丢失的 binding，会跳过它，而不是当作损坏拒绝。
    - 获取 hold 要求该行当前的 claim generation，在同一事务中加锁读取，所以 claim 已过期的 worker 既拿不到也保不住 storage。接管该行的 claimant 可以替换带有自己 `maintenance_id` 的 hold，而过期 worker 的释放带着它旧的 claim generation，所以永远释放不了新的 hold。
    - hold 与 Runtime claim 经过同样的 W1a storage 守卫检查。
    - hold 比它的步骤活得更久，但最多只到下一次 scan。scan 先续做到期的行，其新的 claimant 接管崩溃步骤的 hold，所以在崩溃与续做的步骤之间没有 tool turn 写入。随后它释放每一个没有步骤认领其 child Workspace 的 hold：即 worker 在最后一次提交之后死亡或未能释放的情形。
    - W1c storage 迁移把不处于 `merged`、`discarded`、`failed` 或 `conflicted` 的 child Workspace 计为未结束的工作，因为它的 worktree 记录了 storage 根的绝对路径。
    - 与 `shared` child 的 tool turn 一样，当父的 Hook catalog 或 MCP owner 在整个 Session 期间持有 storage 时，步骤会等待。Agent 工具在这种状态下已经拒绝 launch child（H4b），I2 保留这一拒绝。
11. **Git 以加固方式运行，因为模型可以写仓库。** 每条命令运行时：
    - 环境被清空：只保留 `PATH`（Windows 上还有 `SystemRoot`）。`HOME` 与 `XDG_CONFIG_HOME` 指向一个空的私有目录，系统与全局配置被禁用，提示、可选锁与 replace 对象都关闭。
    - 以 storage 根处的 `GIT_CEILING_DIRECTORIES` 限定仓库发现，所以 Git 绝不会找到根以上的仓库。
    - 禁用 hooks（`core.hooksPath` 被覆盖为一个空的私有目录）、`core.fsmonitor` 被覆盖为空、`log.showSignature` 关闭、自动 `gc` 与 maintenance 关闭、每次提交带 `--no-gpg-sign`、每次 diff 带 `--no-ext-diff --no-textconv`。
    - 配置检查：每个步骤之前，仓库自己的配置文件（common `config`，以及在 `extensions.worktreeConfig` 开启时的 `config.worktree`）在关闭 include 的情况下被当作数据读取。若这些命令可触达的某个键指名了程序或重定向了 Git，步骤以 `child_workspace_unsafe_config` 拒绝：`filter.*`、`merge.*.driver`、`diff.external`、`diff.*.command`、`diff.*.textconv`、`core.worktree`，或任何 `include.*`、`includeif.*`（检查看不到其所包含的键）。`.gitattributes` 只能经由这类键触达程序，所以这也封住了 clean/smudge 过滤器与合并驱动。promisor 远端（`extensions.partialClone`、`remote.*.promisor`）同样被拒绝：任何遇到缺失对象的命令都会懒抓取它并运行远端的传输程序。这些命令永远触达不到的键不会被拒绝，所以普通仓库可以通过：没有命令会打开编辑器或终端、或者签名，两个 hook 相关的键被覆盖而不是被读取。
    - 作为 promisor 拒绝之后的纵深防御：懒抓取被禁用（`GIT_NO_LAZY_FETCH`，Git 2.45 及以后），所有传输协议都被禁止（`GIT_ALLOW_PROTOCOL`），所以没有命令会与远端通信。
    - 稀疏检出以 `child_workspace_layout` 拒绝，因为私有 index 快照会把稀疏范围之外的每个文件读成已删除。
    - 每条命令有时间上限（`qwen.managed-agent.runtime-broker.child-workspace-git-timeout`，120 秒）；可执行文件为 `child-workspace-git`（默认是 `PATH` 上的 `git`）。

    检查在维护 hold 下运行，所以在检查与命令之间没有 tool turn 能修改配置。模型留在任何 turn 之外运行的进程不在覆盖范围内；这是 W1 §5.1 已经指出的残余风险。

12. **能力属于 Workspace provider，默认关闭。** `RuntimeWarmer.childWorkspaces()` 回答 provider 或 null。只有在 `qwen.managed-agent.runtime-broker.child-workspaces-enabled` 为 true、部署有 Workspace 挂载、且启动探测发现 Git 2.40 或更新版本（第一个带 `merge-tree --merge-base` 的版本）时，`EmbeddedRuntimeBroker` 才回答一个 provider。在没有 Workspace 挂载或 Git 版本过旧时开启它，启动会失败。没有 provider 时，`prepare` 以 `child_workspace_unsupported` 拒绝，什么都不提交。
13. **把 child Session 绑定到它的 Workspace。** `createChildSession` 增加 `isolated` 参数。设置时，store 在创建事务中锁住同一父与 run 的行，要求它处于 `ready`、没有收尾请求、准备自父当前的 Workspace、generation 与 storage、且指名所请求的目录，然后用该目录代替父的目录插入 child。收尾请求锁住同一行，所以创建与收尾不会互相越过。child 目录是请求摘要的一部分，所以指名不同绑定的重放是幂等冲突。不处于 `ready` 的行以 `child_workspace_not_ready` 拒绝创建。
14. **I2 的方向。** relay 在 `createChildSession` 之前为 `worktree` run 准备 child Workspace，然后创建绑定到它的 child。在 `completed` 时，它在 `commit_result` 之前以 `merge` 收尾，以便终态回执能报告 `merged` 或带路径的 `conflicted`。决策 8 在 child Session 未关闭时拒绝收尾，而今天的 relay 要到结果提交之后才关闭已结束的 child，所以 I2 对 `worktree` run 把这次关闭移到合并之前。在失败、取消、配额或放弃时，它以 `discard` 收尾，关闭级联丢弃它所取消的 child 的 Workspace。随后 `MANAGED_CHILD_ADMITTED_WORKSPACE_MODES` 对 `child_agent` 与 `workflow` 一并放行 `worktree`。合并结果需要一个记录键，还是随终态回执传递，由 I2 决定。I2 建立在 H4c（#13754，已合入）之上，二者共享文件。
15. **I3 的方向。**
    - 串行共享不需要单独的取值。storage lease 一次只接纳一个 holder，而 storage 的每个写入方（父、`shared` child、`worktree` child 或 child Workspace 维护）都在写入前获取它。因此它们中任何两个都不能同时持有 storage，lease 本身就是 2026-10-04 问题框架所要求的 generation barrier。
    - `snapshot` 可以复用本能力：一个总是被丢弃的 child Workspace，绑定到一个工具 profile 拒绝所有写入的 child。由 I3 决定 profile 级别的拒绝是否足以作为「不能写」的证据。

## 记录与表

### `qwen_managed_child_workspace`（V58）

| 列                                                                        | 含义                                                                                      |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `tenant_id`、`parent_session_id`、`child_run_id`                          | 键。每个 child run 一行。                                                                 |
| `child_workspace_id`                                                      | 命名目录与 pin 的 32 位十六进制 id。唯一。                                                |
| `workspace_id`、`workspace_generation`、`storage_id`                      | 准备 Workspace 时所依据的父绑定。只有父当前绑定仍指名它们时，child Session 才能绑定到它。 |
| `parent_cwd_relative`、`repository_relative`、`child_cwd_relative`        | 父的目录、其仓库的顶层，以及 child 的目录，均相对 storage 根。                            |
| `base_commit`、`result_commit`、`parent_tree`、`merged_tree`              | 决策 3 与 5 中的 `S`、`C`、`P` 与 `M`。                                                   |
| `state`、`finish_request`、`outcome_code`、`conflict_paths`、`last_error` | 决策 8 的状态机及其结果。`conflict_paths` 是一个 JSON 数组。                              |
| `claimed_by`、`claimed_until`、`claim_generation`                         | 决策 9 的 claim。                                                                         |
| `attempts`、`next_retry_at`、`created_at`、`updated_at`                   | 重试记账。                                                                                |

### `managed_workspace_execution_lease.maintenance_id`（V58）

一个可空列，指名以维护 holder 身份持有该 storage 的 child Workspace（决策 10）。对每个 Runtime holder 与空闲的 lease，它都为空。

## 非目标

- I2 与 I3，决策 14 与 15 所记录的方向之外的部分。
- 本地进程以外的 provider。Kubernetes 与 CSI provider 不回答 child Workspace provider，由它们自己的切片决定 Git 步骤在控制面还是在 Pod 中运行。
- 父与 child 并发写入。lease 仍让它们串行。
- 合并提交或分支。child 的工作以未提交改动的形式落地，由父决定提交什么。
- 子模块内容。子模块的 gitlink 作为一个条目被携带与合并；其工作区不会在 child 中实体化。
- 任何公开契约变更。OpenAPI 契约、路由与记录体保持不变。

## 受影响的文件

- `packages/sdk-java/managed-agent-server/src/main/resources/db/migration/V58__managed_child_workspace.sql`：新表与 lease 列。
- `service/ChildWorktreeGit.java`：加固的 Git 执行器与各物理步骤（布局检查、快照、创建、结果、合并、写入、丢弃）。`service/ChildWorkspaceException.java`：它们的失败码。
- `service/ChildWorkspaceProvider.java`：`RuntimeWarmer.childWorkspaces()` 回答的 provider 接口。`EmbeddedRuntimeBroker` 基于 `WorkspaceRuntimeResolver.storageRoot`（经校验的挂载根）实现它。
- `service/ChildWorkspaceService.java`：`prepare`、`finish`、`find`、定时 scan 与状态机。
- `store/ChildWorkspaceStore.java`：该行的 JDBC：准入、claim、比较并设置的迁移以及收尾请求。
- `store/WorkspaceExecutionStore.java`：`holdForMaintenance`、`releaseMaintenance`，以及 `releaseLost` 中的维护形态。
- `service/ManagedAgentService.java`、`store/ManagedAgentStore.java`、`store/AgentStateStore.java`：隔离的 child 绑定。
- `config/ManagedAgentProperties.java`、`config/ManagedArtifactConfiguration.java`：配置项、启动检查与 scan 的调度器。
- 各处旁边的测试，以及本设计的两种语言版本。

## 验证

- **Git 步骤**（`ChildWorktreeGitTest`，在临时目录中针对真实仓库的 21 个用例）：快照包含已修改、已暂存与未跟踪的内容而不含被忽略的文件，不触碰父的 index、`HEAD` 与 status，且是确定的；布局与偏移；决策 2 的每一种布局拒绝，包括位于仓库内的 storage 根与稀疏检出；不安全配置被拒绝且其过滤器程序从未运行，include 被拒绝，同样的检查也作用于 child 自己的 `config.worktree`；即使缺失的 tree 会被抓取，promisor 远端的传输程序也从未运行；拒绝键矩阵；仓库 `core.hooksPath` 的 hook 从未运行；干净合并以未提交改动落地且 `HEAD` 与 index 不变，child 的提交按内容合并，worktree 与两个 pin 被移除；冲突指出其路径且不写入任何内容；写入从写了一半的树续做，并拒绝覆盖在 lease 之外被修改的路径；被中断的检出被重建，未注册的目录被拒绝；预留路径上的链接被移除且不被跟随，被链接的容器目录被拒绝；丢弃保留 result pin、在仓库已移除时仍能完成，并在 Git 无法运行时保留 worktree；已不存在的仓库与变化了的仓库被区分开；失去 claim 的步骤不再启动 Git，并终止正在运行的那条。
- **状态机**（`ChildWorkspaceServiceTest`，在 MySQL 模式的 H2 上配合真实仓库的 20 个用例）：准备、绑定与合并端到端，并在绑定的 child Session 未关闭时拒绝收尾；冲突后丢弃仍保留 child 的工作；被拒绝的布局以 `failed` 结束且什么都没创建；没有能力时什么都不准入；收尾规则；隔离绑定的各项拒绝；繁忙的 storage 让行暂停且不消耗尝试次数；维护 hold 归属于一个 claim；过期的 claim 让给另一个 worker，且无法提交或持有 hold，在状态未变时亦然；存活的 claim 绝不被认领两次，连它自己的 worker 也不行；运行中的步骤续期它的 claim，claim 被接走的步骤停止其 Git；合并与写入在同一个 hold 下；在记录 base 与创建 worktree 之间、以及写入落地之后崩溃的续做；无法完成的丢弃以 `blocked` 结束直到再次被请求；scan 释放没有步骤拥有的 hold；超出 Session 规则的 child 目录被拒绝；有界重试以 `blocked` 结束；意外故障消耗一次尝试。
- **Lease 与迁移**（`WorkspaceRuntimeTest`；`WorkspaceRecoveryContract`，也由 `ManagedAgentMySqlIT` 在 MariaDB 上重放；`WorkspaceMigrationStoreTest`）：Runtime claim 与维护 hold 互斥，`releaseLost` 跳过维护 hold，存在未结束 child Workspace 的 storage 拒绝迁移。
- **绑定与配置**（`ManagedAgentServiceChildWorkspaceTest`、`ManagedAgentPropertiesTest`、`EmbeddedRuntimeBrokerTest`）：隔离 child 的目录进入其摘要，没有 child Workspace 的 run 拒绝创建；能力默认关闭，需要负责挂载的 Broker 与 Workspace 挂载，解析出经校验的挂载根，没有 Git 时启动失败。
- **变异检查**：39 个变异体，每个禁用决策 2 至 13 中的一条守卫：分歧拒绝、续做集合、私有 index 的 `add -A`、冲突分支、拒绝键（含 promisor 远端）、hooks 覆盖、child 配置检查、Git 目录、稀疏检出与 Session 目录的拒绝、区分已不存在与变化了的仓库、保留 result pin、未注册目录拒绝、四条收尾规则、被阻塞的丢弃清除其请求、迁移与 hold 中的 claim generation、唯一的存活 claim、claim 续期、失去 claim 时停止步骤、繁忙等待、`failed` 与 `blocked` 的区分、重试上限、繁忙的 hold、hold 的释放、陈旧 hold 的释放、`releaseLost`、迁移拒绝、绑定检查、摘要、合并与写入共用一个 hold，以及丢弃时的 Git 失败。39 个全部变红。禁用懒抓取与传输的两个环境变量是 promisor 拒绝之后的纵深防御：拒绝生效时，移除它们不会带来任何测试可观察的变化。

## 验收标准

- child Workspace 可以跨控制面重启被幂等地创建、绑定、合并与丢弃。
- 合并冲突以持久的 `conflicted` 结果呈现，绝不是静默覆盖。
- child Workspace 的写入在其合并运行之前不会出现在父的目录树中，被丢弃的 child 的 worktree 会被移除。
- 没有模型可触达的行为变化：`MANAGED_CHILD_ADMITTED_WORKSPACE_MODES` 为 `['shared']`，且能力默认关闭。

## 开放问题

1. **容器化 provider 的 Git 步骤在哪里运行**：在控制面针对已挂载的卷运行，还是经由 worker 操作在 Pod 内运行。
2. **`conflicted` 或 `blocked` 的行被丢弃后 result pin 的保留**：保留到运维移除为止，还是以 Session 归档为界。
3. **合并结果的契约**：一个记录键，还是终态回执（I2）。

## 后续工作

| 切片 | 范围                                                                                                                                |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------- |
| I2   | relay 负责准备、绑定、合并与丢弃；级联负责丢弃；launch 准入与 Agent 工具对两种 child Session kind 放行 `worktree`；合并结果送达父。 |
| I3   | 以一个拒绝写入的 profile 加一个被丢弃的 child Workspace 实现 `snapshot`；把决策 15 的串行化裁定记为最终结论。                       |
