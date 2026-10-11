# Managed child Workspace 能力（隔离切片，I1）

[English](2026-10-09-managed-child-workspace.md) | [简体中文](2026-10-09-managed-child-workspace.zh-CN.md)

状态：I1 已在本变更中实现。已落地：child Workspace（父 storage 内的一个 Git linked worktree）、它带 fencing 与恢复的持久命令、合并与丢弃两种收尾、storage lease 的维护 hold，以及把 child Session 绑定到已准备好的 child Workspace。I2（`worktree` 准入、relay 与级联接线）已由其单独的[设计](2026-10-10-managed-child-worktree-admission.zh-CN.md)实现。仍是设计：I3（`snapshot`，以及串行化的裁定），有其后续切片（见后续工作）。这是 [#12827](https://github.com/QwenLM/qwen-code/issues/12827)（Managed Agent 提案 [#12380](https://github.com/QwenLM/qwen-code/issues/12380) 的阶段 H）的隔离切片，由 [#13753](https://github.com/QwenLM/qwen-code/issues/13753) 跟踪。它拆分自 H4c（[#13743](https://github.com/QwenLM/qwen-code/issues/13743)，PR #13754），其[设计](2026-10-09-managed-workflow-child-kind.zh-CN.md)在决策 11 中确定了词汇。它承接 H4a（[记录契约](2026-10-06-managed-child-agent-runtime.zh-CN.md)）与 H4b（[child Session 运行时](2026-10-07-managed-child-session-runtime.zh-CN.md)）。

## 问题与范围

Issue #13753 要求三项：

- **I1，一项 Workspace 能力。** 一个 provider 操作：从父 Session 绑定的 Workspace、在记录下来的修订上创建 child worktree，把 child Session 绑定到它，之后把它合并回去或丢弃。它需要自己的持久命令、fencing 与恢复。
- **I2，`worktree` 准入。** relay 在 child 自己的 Workspace 中创建 `worktree` child，settle 与关闭路径执行合并策略，launch 准入放行 `worktree`。
- **I3，`snapshot` 与串行共享。** 一个只读的冻结视图，以及对是否需要在 Workspace lease 之外再加按 child 的 generation 或 barrier 的裁定。

本变更交付 I1，并记录 I2 与 I3 的方向。其中没有任何内容是模型可触达的：`MANAGED_CHILD_ADMITTED_WORKSPACE_MODES` 仍只放行 `shared`，relay 从不准备 child Workspace，且能力在运维显式开启前是关闭的。这与 H4a 的顺序相同：能力先落地、由自己的测试套件证明，然后才有生产方。

## 现状

以下事实取自 `main` 的 `9e9d1c037d`，此时 H4c（#13754）已落地 `workflow` child kind。

- **Child 绑定。** `ManagedAgentStore.insertChildSessionCommand` 用一条 `INSERT ... SELECT` 把父的整套绑定复制进 child 行：Workspace、generation、storage、`cwd_relative`、context 与 policy 引用。记录中的 `workspaceMode` 与 `workingDirectory` 在两种语言里都会校验，但没有运行时读取它们。
- **Storage 与挂载。** storage 的根是管理员挂载（`runtime-broker.workspace-mounts`：tenant、storage、root）。挂载是静态的、规范化的，且不得重叠或嵌套。W1 §5.1 要求运维把 storage 根放在所有 Git worktree 之外，并把 Session 工作目录放在它的子目录中。
- **Storage lease。** `managed_workspace_execution_lease` 每个 storage 一行，同一时刻只有一个 holder。holder 是一个 Runtime Session（`binding_id`、`runtime_generation`、`runtime_session_id`）。遇到其他 holder 的 tool turn 会收到可重试的 `workspace_busy` 并轮询。W1a 的 fence 与注册要求 lease 空闲；W0e 的 `releaseLost` 清除丢失 binding 的 holder，并把其他任何 holder 形态当作损坏。
- **Worker 的边界。** worker 把 binding 解析为挂载根拼接 `cwd_relative`。工具可以触及挂载内任何位置，但不能进入另一个已安装 Session 的目录。W1 §5.1 说明这种布局减少意外，但不约束主机允许的工具访问。
- **Git。** 没有 Java 代码运行 Git。TypeScript 为 daemon 和旧版 Agent 工具提供了 worktree 原语（`createUserWorktree`、`removeUserWorktree`）。它唯一的回合并是 Arena 的 `applyWorktreeChanges`：应用补丁，并把冲突报告为 Git 的错误文本。本能力不在它们之上构建：它们运行在 daemon 中而非持有 storage lease 的控制面，不保留与 child run 绑定的持久记录，冲突也只以错误文本呈现。

## 决策

1. **child Workspace 是父 storage 内的一个 Git linked worktree。** 它的目录是 `<storage 根>/.qwen-child-workspaces/<childWorkspaceId>`，其中 `childWorkspaceId` 是 `sha256(tenant NUL parentSessionId NUL childRunId)` 的前 32 个十六进制字符。child 绑定保留父的 tenant、Workspace、generation、storage、context 与 policy 引用；只有 `cwd_relative` 改为 worktree 目录加上父在其仓库内的偏移。之所以不给它单独的 storage，是因为挂载是静态的且不能嵌套，新 storage 需要动态挂载注册、新的 W1a 守卫，在 Kubernetes 下还需要新的 CSI 注册。同一个 storage 则保留挂载守卫、marker、lease，以及将来的同一个 PVC。
   - 结果：child 的 tool turn 仍经由同一个 storage lease 与父串行，与 `shared` child 完全一样。这里的隔离是工作目录树的隔离，既不是并发，也不是安全边界（W1 §5.1）。
   - 与所有 linked worktree 一样，它与父共享对象库与 refs。child 在其 detached worktree 中做的提交不会作为提交被合并：合并读取的是 worktree 的内容。
2. **布局要检查，从不假定。** 父的工作目录必须位于一个 Git 仓库中，该仓库的顶层严格位于 storage 根之内，其 Git 目录与 common 目录也在根之内。以下情形一律以 `child_workspace_layout` 拒绝：storage 根本身位于某个仓库内（W1 §5.1 排除的布局）、目录不在任何仓库中、裸仓库、位于预留目录内的仓库、指向根外的 Git 目录，这些命令会让 Git 写入或删除的位置上的链接（任意深度的 `refs`、`logs` 与 `worktrees`，`objects` 及其条目，以及 `packed-refs`：Git 会把它的锁文件放在链接所指文件的旁边），它会把写入或删除带出 storage，快照不包含的父目录（空目录或被忽略的目录），或会违反每个 Session 目录都要满足的规则（最多 1024 个 code point）的 child 目录。预留的 `.qwen-child-workspaces` 目录必须是真实目录，绝不能是符号链接。
3. **base 修订是父工作区的快照提交。** 准备时，控制面把 `HEAD` 读入一个私有 index 文件，对它执行 `git add -A`，再把得到的树提交在 `HEAD` 之上。私有 index 从 `HEAD` 起步，而不是复制父的 index，因为副本会带上 `assume-unchanged` 与 `skip-worktree` 标记，使改动对 `git add` 不可见。因此该提交包含父工作区里实际有的内容：已提交、已修改以及未跟踪且未忽略的文件；某个路径即使暂存了另一个版本，记录的也是工作区中的版本。父自己的 index、`HEAD` 与工作区从不被触碰。被忽略的文件（构建产物、`node_modules`）不会带过去。提交使用固定身份与固定日期，所以对未变内容重算会得到同一个提交；它的提交信息带有 child Workspace 的 id，所以从同一父状态准备的两个 child 仍各有自己的 base。它的 id 在创建 worktree 之前记录，worktree 以 detached 方式检出到它。
4. **行需要时，提交被 pin 住。** base 以 `refs/qwen/child-workspaces/<id>/base` pin 住，算出的结果以 `.../result` pin 住，所以 `git gc` 永远不会回收它们。合并会删除两个 pin。其他所有收尾在存在结果时都保留 result pin，所以丢弃永远不会删除 child 产出的工作，除非该工作已被合并。
5. **合并策略是对父工作区的三方合并，在树外计算。**
   - child 的结果 `C` 是 worktree 的快照（同样的私有 index 技术），位于 base `S` 之上。
   - 父的当前状态 `P` 是父工作区的快照。
   - `git merge-tree --write-tree --merge-base=S P C` 计算合并树 `M`，不触碰任何工作区或 index。
   - 冲突时，行以 `conflicted` 结束并带上冲突路径（最多记录 100 条），父中不写入任何内容。合并冲突是一个持久结果，绝不是静默覆盖。worktree 与 base pin 立即被移除，而 child 的结果仍被 pin 住（决策 4）；随后由丢弃让该行退役。
   - 干净合并时，只写入 `P` 与 `M` 之间有差异的路径，作为父工作区中的未提交改动。父的 index 与 `HEAD` 保持原样，所以 child 的工作到达时就像父自己做的编辑一样。
   - 干净合并中有两类路径无法写入，它们像冲突一样让行以 `conflicted` 结束：合并移动了的子模块指针，因为补丁无法移动它；以及合并新增、但父在该处持有被忽略的文件或目录，或在该路径某个上级目录的位置持有被忽略文件的路径，因为写入会覆盖 `P` 不包含的内容。名字不是 UTF-8 的路径也同样报告，因为写入无法逐字节写出它的名字。
6. **写入可续做，并逐路径检查。** `P` 与 `M` 在写入任何内容之前记录。每次写入尝试都会对当前工作区 `W` 做快照，并要求每个变化路径要么是它的 `P` 版本，要么是它的 `M` 版本；仍处于 `P` 的路径用一次树到树补丁的 `git apply` 写成 `M`。每个变化路径都按磁盘上的实际内容判断，无论是否被忽略，所以父忽略的合并路径（child 运行期间父开始忽略该目录，或 child 强制添加了该路径）既不会被校验拒绝，也不会被写两次。因此在两个文件之间崩溃，会从停下的地方续做。任何其他内容都意味着 lease 之外有东西改了树；行以 `blocked` 结束，不覆盖任何内容。补丁的格式是固定的（无颜色、三行上下文），否则仓库配置可能让它无法应用。写入之后，对照 `M` 校验树。合并与它的写入在同一个维护 hold 下运行（决策 10），所以在算出 `M` 与写入之间，没有 tool turn 能改动父的目录树。
   - 随后在同一个 hold 下，行先迁移到 `applied`，再移除 worktree 与 pin。续做的 `applied` 行只做这些移除，绝不再次判断父的目录树：此后 storage 已经空闲过，那里的编辑是父自己的。唯一剩下的窗口是写入落地与这条记录之间的失败；续做的 `applying` 行会重新检查目录树，若期间有 tool turn 编辑了某个合并路径，则以 `blocked` 结束。
7. **丢弃移除 worktree，保留产出的工作。** 丢弃用 `git worktree remove` 移除已注册的 worktree，然后在不跟随其中任何符号链接的前提下移除预留路径上剩下的一切，移除该 worktree 自己的管理目录（`<commonDir>/worktrees` 下 `gitdir` 指向它的那一项；绝不使用 `git worktree prune`，它会连父的 worktree 一起判断），移除 child 创建的 refs，并删除 base pin。预留路径属于控制面，所以模型在那里替换或清空过的目录也会被移除，留在那里的符号链接只作为链接被移除，绝不跟随。记录的仓库已不存在时（其顶层没有 Git 目录），只移除目录。其他任何拒绝，例如不安全的配置（决策 11）、变化了的布局或瞬时故障，都会像其他步骤一样让丢弃失败，所以注册与 pin 的清理绝不会被跳过。丢弃是失败与取消 child 的收尾，也是走出 `conflicted` 与 `blocked` 的出口。
   - child 创建的分支或 tag 落在仓库共享的 refs 中，移除 worktree 触及不到它们。worktree 创建之前，仓库的 ref 名称被记录在它旁边（`.qwen-child-workspaces/<id>.refs`）。存在结果时，移除 worktree 的那次丢弃会先读取 child 的 `HEAD`，然后删除每个不在该记录中、包含该 child 自己 base（见决策 3）、且位于该 `HEAD` 那条线上的 ref（这条线的最终内容由结果持有）；符号 ref 只删除其本身，绝不删除其目标。偏离这条线的侧分支保持不动，所以只被某个 ref 持有的提交不会丢失；没有结果，或 worktree 已不存在或无法安全读取时，什么都不删。一旦 base 进入了别人的历史，就什么都不删：父的 `HEAD`、父原有的 ref（即使被 child 移动过）、某个 worktree 检出着的 ref，或另一个 child 的 pin 包含了它，例如父合并了某个 child 的分支之后。`refs/stash`（它唯一的 reflog 也保存着父的 stash）永远不删，所以 child 的 stash 会留在 stash 列表中。不是常规文件或超过 16 MiB 的记录不会被读取，此时什么都不删；记录名字处的任何东西都随 worktree 一起移除。父自己在 child 运行期间指向 child 那条线、但没有并入它原有 ref 或 `HEAD` 的分支，仍适用这条规则，会与 child 自己的分支一起被删除；其中的提交仍留在结果中。
8. **每个 child run 一条持久行。** `qwen_managed_child_workspace`（V60）对每个（tenant、父 Session、child run）保存一行。状态如下：
   - `preparing` → `ready`，或在布局被拒绝时 → `failed`（没有 worktree、pin 或记录的 base；至多留下一个 `git gc` 会回收的不可达快照对象）。
   - `ready` → `merging` → `applying` → `applied` → `merged`，或 `merging` → `conflicted`。
   - `preparing`、`ready`、`conflicted`、`blocked` 或 `failed` → `discarding` → `discarded`。
   - 任何活动状态在证据无法对齐时 → `blocked`。以 `blocked` 结束的 `applied` 行保留 `merged` 作为结果，清理的失败记为最后的错误，之后失败的丢弃也不会改变它；它的丢弃会移除两个 pin。

   无法完成的丢弃以 `blocked` 结束并清除其请求，所以行绝不会回到刚刚失败的丢弃中循环；新的丢弃请求会重试它。收尾请求（`merge` 或 `discard`）只记录一次。重复的请求直接回答这一行；不同的请求被拒绝，例外是 `discard` 可以跟在以 `conflicted` 或 `blocked` 结束的 `merge` 之后。只有 `ready` 的行才接受合并；绑定的 child Session 未关闭时不接受任何收尾，因为收尾会在一个运行中的 Session 脚下移除目录。（I2 修订了这一点：child 运行期间请求即被记录，行在 child 关闭后才执行它；尚未开始的合并可以被丢弃取代。见 [I2 决策 4](2026-10-10-managed-child-worktree-admission.zh-CN.md#决策)。）

9. **claim 隔开写入方；scan 续做工作。** 行带有 `claimed_by`、`claimed_until` 与 `claim_generation`。每次迁移都是对状态与 claim generation 的比较并设置，所以 claim 已过期的 worker 无法提交步骤。定时 scan（`qwen.managed-agent.child-workspace.scan-delay`，2 秒）驱动每一条处于活动状态或欠着收尾的行，从服务调用的操作同步驱动相同的步骤。每个物理步骤都是幂等的，从磁盘与行中的内容对齐，绝不依赖内存。一次 claim 持续 2 分钟，步骤运行期间每隔其三分之一续期一次，所以缓慢的 Git 命令绝不会让第二个 worker 进入仍在进行的步骤；步骤结束即释放。存活的 claim 绝不会被认领两次，连它自己的 worker 也不行，所以同步调用与 scan 不会同时运行同一行。claim 已被他人接走、或在其大部分生命期内都未能续期的步骤会停止：不再启动新的 Git 命令，正在运行的那条会被终止，所以失去 claim 的 worker 绝不会与接管该行的 worker 同时写入。拿不到 storage lease 的步骤等待 1 秒且不消耗尝试次数。一次 scan 最多驱动 20 行，60 秒后不再开始新的行，其余留给下一次 scan。其他失败以从 1 秒翻倍到 60 秒的退避重试，16 次尝试后行以 `blocked` 结束并带上最后的错误。
10. **物理步骤在 storage lease 的维护 hold 下运行。** 每个步骤之前，worker 以维护 holder 的身份占用该 storage 的 `managed_workspace_execution_lease` 行：`holder_key = sha256("child-workspace" NUL id NUL claimGeneration)`，Runtime holder 各列为空，新增的 `maintenance_id` 列设为行 id。步骤结束时释放 hold。
    - 遇到该 hold 的 tool turn 收到既有的可重试 `workspace_busy` 并轮询，所以合并绝不会与写父工作区的 turn 竞争。
    - W1a 的 fence 与注册需要空闲的 lease，所以 hold 存在期间它们会以不可重试的方式拒绝；步骤结束后由运维重试。
    - W0e 的 `releaseLost` 识别维护形态不属于丢失的 binding，会跳过它，而不是当作损坏拒绝。
    - 获取 hold 要求该行当前的 claim generation，在同一事务中加锁读取：claim 已被其他 worker 接管的 worker 会被拒绝，新的 claimant 可以替换带有自己 `maintenance_id` 的 hold。过期 worker 的释放带着它旧的 claim generation，所以永远释放不了新的 hold。claim 已过期但仍是当前 generation 的 worker 可以拿到 hold；一旦没有人再续期该 claim，scan 就会释放它。
    - hold 与 Runtime claim 经过同样的 W1a storage 守卫检查。
    - hold 比它的步骤活得更久，但最多只到下一次 scan：scan 首先释放每一个其 child Workspace 已无存活 claim 的 hold，即 worker 在最后一个步骤之后死亡或未能释放的情形。无论能力开启与否，每台主机都会这样做，因为它不需要 Git，而且没有别的东西能释放那个 storage。在能力开启的主机上，其 child Workspace 仍处于步骤状态的 hold 会被保留：scan 会续做那一行，其新的 claimant 接管该 hold，因此不会有 tool turn 插入其间。能力关闭的主机要等该 claim 过期 4 分钟（claim 时长的两倍）之后才释放这种 hold，先留给能运行步骤的主机处理。主机按自己的时钟判断 claim 是否过期，所以各主机的时钟偏差必须小于 claim 的续期余量（约 80 秒）。
    - W1c storage 迁移把不处于 `merged`、`discarded`、`failed` 或 `conflicted` 的 child Workspace 计为未结束的工作，因为它的 worktree 记录了 storage 根的绝对路径。
    - 与 `shared` child 的 tool turn 一样，当父的 Hook catalog 或 MCP owner 在整个 Session 期间持有 storage 时，步骤会等待。Agent 工具在这种状态下已经拒绝 launch child（H4b），I2 保留这一拒绝。
11. **Git 以加固方式运行，因为模型可以写仓库。** 每条命令运行时：
    - 环境被清空：只保留 `PATH`。`HOME` 与 `XDG_CONFIG_HOME` 指向一个空的私有目录，系统与全局配置被禁用，提示、可选锁与 replace 对象都关闭。Windows 不支持 child Workspace；它还要求 JVM 的文件名编码为 UTF-8（`sun.jnu.encoding`，由 locale 决定）；否则开启会导致启动失败。
    - 以 storage 根处的 `GIT_CEILING_DIRECTORIES` 限定仓库发现，所以 Git 绝不会找到根以上的仓库。
    - 禁用 hooks（`core.hooksPath` 被覆盖为一个空的私有目录，也覆盖了默认 hooks 目录与 `reference-transaction`）、`core.fsmonitor` 被覆盖为空、`core.safecrlf` 关闭（否则换行检查会拒绝每次快照或刷屏）、`log.showSignature` 关闭、自动 `gc` 与 maintenance 关闭、每次提交带 `--no-gpg-sign`、每次 diff 带 `--no-ext-diff --no-textconv`。
    - 配置检查：每个步骤之前，仓库自己的配置文件（common `config`，以及在 `extensions.worktreeConfig` 开启时的 `config.worktree`）在关闭 include 的情况下被当作数据读取。若这些命令可触达的某个键指名了程序或重定向了 Git，步骤以 `child_workspace_unsafe_config` 拒绝：`filter.*`、`merge.*.driver`、`diff.external`、`diff.*.command`、`diff.*.textconv`、`core.worktree`，或任何 `include.*`、`includeif.*`（检查看不到其所包含的键）。`.gitattributes` 只能经由这类键触达程序，所以这也封住了 clean/smudge 过滤器与合并驱动。promisor 远端（`extensions.partialClone`、`remote.*.promisor`）同样被拒绝：任何遇到缺失对象的命令都会懒抓取它并运行远端的传输程序。这些命令永远触达不到的键不会被拒绝，所以普通仓库可以通过：没有命令会打开编辑器或终端、或者签名，两个 hook 相关的键被覆盖而不是被读取。布尔键（`extensions.worktreeConfig`、`core.sparseCheckout`、`core.bare`）只要 Git 读作开启就算开启：无值的键、任何非零整数，或 `true`、`yes`、`on`；Git 无法读取的值也算开启，即拒绝的一侧。
    - 作为 promisor 拒绝之后的纵深防御：懒抓取被禁用（`GIT_NO_LAZY_FETCH`，Git 2.45 及以后），所有传输协议都被禁止（`GIT_ALLOW_PROTOCOL`），所以没有命令会与远端通信。
    - 稀疏检出以 `child_workspace_layout` 拒绝，因为私有 index 快照会把稀疏范围之外的每个文件读成已删除。
    - 每条命令有时间上限（`qwen.managed-agent.runtime-broker.child-workspace-git-timeout`，120 秒，超出 1 秒到 1 小时的范围时启动即拒绝），每个输出流也有上限（256 MiB），在命令运行期间检查；错误输出只读取前 512 个字符。因超限或失去 claim 而停止的命令，会连同它启动的所有进程（例如 `worktree add` 运行的检出）一起被终止。可执行文件为 `child-workspace-git`（默认是 `PATH` 上的 `git`）。
    - pin 的写入与删除都带 `--no-deref`，位于 pin 名字处的符号 ref 不算 pin，所以被植入的符号 ref 永远不会把 pin 重定向到某个分支。

    检查在维护 hold 下运行，所以在检查与命令之间没有 tool turn 能修改配置。模型留在任何 turn 之外运行的进程不在覆盖范围内；这是 W1 §5.1 已经指出的残余风险。

12. **能力属于 Workspace provider，默认关闭。** `RuntimeWarmer.childWorkspaces()` 回答 provider 或 null。只有在 `qwen.managed-agent.runtime-broker.child-workspaces-enabled` 为 true、部署有 Workspace 挂载、且启动探测发现 Git 2.40 或更新版本（第一个带 `merge-tree --merge-base` 的版本；步骤用到的其他选项都更早，两个测试套件在 Git 2.40.0 上均通过）时，`EmbeddedRuntimeBroker` 才回答一个 provider。在没有 Workspace 挂载或 Git 版本过旧时开启它，启动会失败。没有 provider 时，`prepare` 以 `child_workspace_unsupported` 拒绝，什么都不提交。
13. **把 child Session 绑定到它的 Workspace。** `createChildSession` 增加 `isolated` 参数。设置时，store 在创建事务中锁住同一父与 run 的行，要求它处于 `ready`、没有收尾请求、准备自父当前的 Workspace、generation 与 storage、且指名所请求的目录，然后用该目录代替父的目录插入 child。收尾请求锁住同一行，所以创建与收尾不会互相越过。child 目录是请求摘要的一部分，所以指名不同绑定的重放是幂等冲突。不处于 `ready` 的行以 `child_workspace_not_ready` 拒绝创建。
14. **I2 的方向。** relay 在 `createChildSession` 之前为 `worktree` run 准备 child Workspace，然后创建绑定到它的 child。在 `completed` 时，它在 `commit_result` 之前以 `merge` 收尾，以便终态回执能报告 `merged` 或带路径的 `conflicted`。决策 8 在 child Session 未关闭时拒绝收尾，而今天的 relay 要到结果提交之后才关闭已结束的 child，所以 I2 对 `worktree` run 把这次关闭移到合并之前。在失败、取消、配额或放弃时，它以 `discard` 收尾，关闭级联丢弃它所取消的 child 的 Workspace。随后 `MANAGED_CHILD_ADMITTED_WORKSPACE_MODES` 对 `child_agent` 与 `workflow` 一并放行 `worktree`。合并结果需要一个记录键，还是随终态回执传递，由 I2 决定。I2 建立在 H4c（#13754，已合入）之上，二者共享文件。I2 的[设计](2026-10-10-managed-child-worktree-admission.zh-CN.md)对此作了裁定：合并结果随终态回执传递；relay 先请求合并，再承认 child 的关闭，行在该关闭完成后才执行合并。
15. **I3 的方向。**
    - 串行共享不需要单独的取值。storage lease 一次只接纳一个 holder，而 storage 的每个写入方（父、`shared` child、`worktree` child 或 child Workspace 维护）都在写入前获取它。因此它们中任何两个都不能同时持有 storage，lease 本身就是 2026-10-04 问题框架所要求的 generation barrier。
    - `snapshot` 可以复用本能力：一个总是被丢弃的 child Workspace，绑定到一个工具 profile 拒绝所有写入的 child。由 I3 决定 profile 级别的拒绝是否足以作为「不能写」的证据。

## 记录与表

### `qwen_managed_child_workspace`（V60）

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

行从不删除，所以每次读取都以它过滤的列为键：scan 用 `(state, finish_request, next_retry_at)`，其谓词的每个分支都是一个范围；迁移关卡用 `(tenant_id, storage_id, state)`。

### `managed_workspace_execution_lease.maintenance_id`（V60）

一个可空列，指名以维护 holder 身份持有该 storage 的 child Workspace（决策 10）。对每个 Runtime holder 与空闲的 lease，它都为空；它带索引，所以过期 hold 的释放只读取被持有的行。

## 非目标

- I2 与 I3，决策 14 与 15 所记录的方向之外的部分。
- 本地进程以外的 provider。Kubernetes 与 CSI provider 不回答 child Workspace provider，由它们自己的切片决定 Git 步骤在控制面还是在 Pod 中运行。
- 父与 child 并发写入。lease 仍让它们串行。
- 合并提交或分支。child 的工作以未提交改动的形式落地，由父决定提交什么。
- 子模块内容。子模块的 gitlink 作为一个条目被携带，其工作区不会在 child 中实体化；移动 gitlink 的合并以 `conflicted` 结束（决策 5）。
- 任何公开契约变更。OpenAPI 契约、路由与记录体保持不变。

## 受影响的文件

- `packages/sdk-java/managed-agent-server/src/main/resources/db/migration/V60__managed_child_workspace.sql`：新表与 lease 列。
- `service/ChildWorktreeGit.java`：加固的 Git 执行器与各物理步骤（布局检查、快照、创建、结果、合并、写入、丢弃）。`service/ChildWorkspaceException.java`：它们的失败码。
- `service/ChildWorkspaceProvider.java`：`RuntimeWarmer.childWorkspaces()` 回答的 provider 接口。`EmbeddedRuntimeBroker` 基于 `service/WorkspaceRuntimeResolver.java` 新增的 `storageRoot`（经校验的挂载根）实现它。
- `service/ChildWorkspaceService.java`：`prepare`、`finish`、`find`、定时 scan 与状态机。
- `store/ChildWorkspaceStore.java`：该行的 JDBC：准入、claim、比较并设置的迁移以及收尾请求。
- `store/WorkspaceExecutionStore.java`：`holdForMaintenance`、`releaseMaintenance`、`releaseStaleMaintenance`，以及 `releaseLost` 中的维护形态。`store/WorkspaceMigrationStore.java`：决策 10 中未结束 child Workspace 的检查。
- `service/ManagedAgentService.java`、`store/ManagedAgentStore.java`、`store/AgentStateStore.java`：隔离的 child 绑定。
- `config/ManagedAgentProperties.java`、`config/ManagedArtifactConfiguration.java`：配置项、启动检查与 scan 的调度器。
- 各处旁边的测试，以及本设计的两种语言版本。

## 验证

- **Git 步骤**（`ChildWorktreeGitTest`，48 个用例，在临时目录中针对真实仓库）：
  - 快照：无论父的 index 如何标记（`skip-worktree`、`assume-unchanged`、暂存了不同版本），都携带工作区内容而不携带被忽略的文件；不触碰父的 index、`HEAD` 与 status；结果确定；开启 `core.safecrlf` 的仓库既不会让它失败，也不会刷屏。
  - 布局：offset，以及决策 2 的每一种拒绝，包括位于仓库内的 storage 根，以及写成 `true`、`2` 或无值的稀疏检出（空值可以通过）。
  - 配置：不安全配置被拒绝且其过滤器程序从未运行；include 被拒绝；由 `2` 或无值键开启的 `config.worktree` 同样会被读取；对 child 自己的 `config.worktree` 做同样的检查；布尔值矩阵；被拒绝键的矩阵；promisor 远端以 `child_workspace_unsafe_config` 被拒绝，其传输程序从未运行。
  - 覆盖项：仓库的 `core.hooksPath` hook、默认 hooks 目录中的 `post-checkout` 与 `reference-transaction`，以及仓库的 `core.fsmonitor` 都从未运行；每条命令只看到执行器自己的环境。
  - 合并与写入：干净合并以未提交改动落地，`HEAD` 与 index 不被触碰；child 的提交按内容合并；worktree、两个 pin 以及 child 的分支和 tag 被移除，父的 refs 保留；清理只删除符号 ref 本身，保留 result pin 与父的 stash；清理只取 child 检出的那条线，没有结果或 worktree 已不存在时什么都不删；容器名字处是文件时丢弃仍能完成；一旦 base 进入别人的历史（父原有的分支、被检出的分支、父的分支或 detached `HEAD`、兄弟的 base），清理就不再删除任何东西；从同一父状态派生的兄弟各有自己的 base 与清理范围；过大而无法读取的 ref 记录让清理什么都不删，记录名字处的东西会被移除；pin 名字处的符号 ref 会被替换而不被跟随；非 ASCII 的名字能合并，不是 UTF-8 的名字算冲突；父忽略的合并路径能落地并可续做；合并把已跟踪文件变成目录时能落地；会覆盖被忽略文件、或在被忽略文件的位置放置目录的合并，以及移动了的子模块指针，都以冲突结束，写入本身也拒绝已记录的 gitlink 变化；带颜色和零上下文的 diff 配置不会破坏写入；冲突指出其路径且不写入任何内容；写入从写了一半的树续做，并拒绝覆盖在 lease 之外被修改的路径。
  - worktree 与丢弃：中断的检出被重建，未注册的目录被拒绝；链接形式的 `worktrees` 目录或其中的链接被拒绝，外部什么都不受影响，`refs`、`logs` 或 `objects` 中的链接同样被拒绝（否则删除 ref 时会 unlink 外部的日志），`packed-refs` 是链接时也一样；丢弃只移除自己 worktree 的注册；指向另一个仓库的 child gitfile 被拒绝；预留路径上的链接被移除而不被跟随，链接形式的容器被拒绝；丢弃会保留 result pin，在仓库被删除后仍能完成，在仓库变得不安全时保留一切，在 Git 无法运行时保留 worktree；已不存在的仓库与变化了的仓库能被区分。
  - 上限：失去 claim 的步骤不再启动 Git，并连同子进程一起终止正在运行的那条；超过时间上限的命令以同样方式被终止；任一输出流超过上限时在命令运行期间就被拒绝。
- **版本下限**（`ChildWorktreeGitVersionTest`，使用桩可执行文件）：2.40 及以后被接受，更早的被拒绝，无法报告版本的 Git 被拒绝并带上其退出码与 stderr。需要真实 Git 的套件在主机没有 Git 2.40 时跳过，但当主机有合格的 Git 而执行器拒绝它时会失败。两个套件也在从源码构建的 Git 2.40.0 上通过。
- **状态机**（`ChildWorkspaceServiceTest`，31 个用例，在 MySQL 模式的 H2 上使用真实仓库）：
  - 端到端：准备、绑定与合并；绑定的 child Session 未关闭时拒绝收尾；合并后移除两个 pin；从同一父状态派生的兄弟 run 各有自己的 base。
  - 冲突：冲突后丢弃并保留 child 的工作；冲突路径最多 100 条，按合并顺序。
  - 拒绝：父现在忽略的合并路径以 `merged` 结束；被拒绝的布局，以及快照不包含的父目录，都以 `failed` 结束且什么都没创建；没有能力时什么都不准入；收尾规则；隔离绑定的各项拒绝，包括 Workspace、generation 或 storage 发生变化的情形。
  - claim 与 hold：繁忙的 storage 让行暂停且不消耗尝试次数；维护 hold 归属于一个 claim；过期的 claim 让给另一个 worker，且无法提交或持有 hold，状态未变时也是如此；存活的 claim 绝不会被认领两次，连它自己的 worker 也不行；运行中的步骤续期它的 claim；claim 被接走的步骤停止并终止它的 Git，仍会释放 storage；合并与写入共用一个 hold。
  - 崩溃续做：记录 base 与创建 worktree 之间；写入已落地但尚未记录之后；已记录之后，父后来的编辑得以保留；实际的合并路径在清理失败之前就记录了已落地的写入；已落地的合并在清理无法完成时仍保持 `merged`，之后失败的丢弃也不改变它。
  - scan 与重试：无法完成的丢弃以 `blocked` 结束，直到再次请求；scan 释放没有步骤拥有的 hold，能力关闭时在宽限期后也是如此，而在每一种步骤状态下，崩溃步骤的 hold 都会无间隙地交给续做的步骤；scan 的时间预算；超出 Session 规则的 child 目录被拒绝；有界重试以 `blocked` 结束；未预料的故障消耗一次尝试；scan、迁移与过期 hold 所用的索引。
  - 该类是封闭的：桩 provider 拒绝其他测试的 storage，每个测试都会让自己遗留的待办行暂停，应用上下文自己的 scan 被静默，因为它按真实时钟判断 claim。
- **Lease 与迁移**（`WorkspaceRuntimeTest`；`WorkspaceRecoveryContract`，也由 `ManagedAgentMySqlIT` 在 MariaDB 上重放；`WorkspaceMigrationStoreTest`）：Runtime claim 与维护 hold 互斥；`releaseLost` 跳过维护 hold；存在未结束或处于 `applied` 的 child Workspace 的 storage 拒绝迁移。
- **绑定与配置**（`ManagedAgentServiceChildWorkspaceTest`、`ManagedAgentPropertiesTest`、`EmbeddedRuntimeBrokerTest`）：隔离 child 的目录计入其摘要，没有 child Workspace 的 run 会被拒绝。能力默认关闭，需要挂载 storage 的 Broker 与 Workspace 挂载，拒绝 Windows、非 UTF-8 的文件名编码以及超出 1 秒到 1 小时范围的 Git 超时，解析经校验的挂载根并拒绝启动后被替换的挂载根，没有 Git 时启动失败。
- **变异检查**：编写本切片时 39 个变异体，评审后又新增 96 个，每个禁用一条守卫。评审这一组覆盖：
  - 写入的两次快照中强制加入的待写路径、被忽略文件与 gitlink 的冲突，以及补丁的颜色与上下文参数；
  - 两个输出流在运行期间的上限、时间上限，以及两处终止进程；
  - ref 清理及其三条守卫，布尔值的读取（拼写、整数、无值键），fsmonitor、`safecrlf` 与系统配置的覆盖，被收窄的 hooks 覆盖，以及端到端的 promisor 拒绝；
  - common 目录检查，从 `HEAD` 起步的私有 index，丢弃对不安全仓库的拒绝，布局的目录检查，以及冲突路径上限；
  - `applied` 状态、其结果与其丢弃；过期 hold 的释放顺序与 scan 时间预算；合并对 pin 的移除；中止步骤的释放；
  - 版本下限，既通过它自己的类，也通过套件的探测；超时范围与 Windows 拒绝；`storageRoot` 的挂载检查；
  - 绑定的 Workspace 与 generation 检查，迁移关卡中的 `applied`，以及三个索引；
  - 评审修复自身的审计之后：每个 child 独有的 base（执行器与准备两处）；清理中对 stash、符号 ref 与记录大小的守卫；被忽略上级路径的检查及其对合并会删除的父文件的例外；失败的丢弃之后仍保留 `merged` 结果；过期 hold 释放只在能运行步骤的主机上保留可续做的 hold；实际合并路径对 `applied` 的记录；写入自身对 gitlink 的拒绝；以非零退出的版本探测；
  - 第二轮审计之后：终止命令的子进程；pin 在写入、删除与读取时都不跟随符号 ref；非 UTF-8 名字的冲突与 UTF-8 启动检查；清理停手的四种情形、stash 守卫与记录的移除；每一种保留 hold 的步骤状态；不运行步骤的主机上的宽限期；
  - 第三轮审计之后：对链接形式 `worktrees` 的拒绝（目录本身与其中的条目）；只移除 child 自己的注册而不是 prune，以及确实移除它；清理只限于 child 检出的那条线、需要结果、那条线上的 stash 守卫，以及只从真实容器中移除记录；
  - 第四轮审计之后：对 `refs`、`logs`（含深层）、`objects` 与 `worktrees` 及其条目中链接的拒绝；第五轮之后：链接形式的 `packed-refs`。对一个完整周期中执行器的 Git 写入或删除的每个文件做了跟踪，Git 目录下没有发现其他位置。

  全部 135 个都变红。有一个等价变异体不计在内：从“收尾进行中拒绝丢弃”的条件中去掉 `applied`，因为 `applied` 行记录的 `merge` 请求本就会触发该拒绝。禁用懒抓取与传输的两个环境变量是 promisor 拒绝之后的纵深防御：拒绝存在时，移除它们不会改变任何测试可观察的行为。

## 验收标准

- child Workspace 可以跨控制面重启被幂等地创建、绑定、合并与丢弃。
- 合并冲突以持久的 `conflicted` 结果呈现，绝不是静默覆盖。
- child Workspace 的写入在其合并运行之前不会出现在父的目录树中，被丢弃的 child 的 worktree 会被移除。
- 没有模型可触达的行为变化：`MANAGED_CHILD_ADMITTED_WORKSPACE_MODES` 为 `['shared']`，且能力默认关闭。

## 开放问题

1. **容器化 provider 的 Git 步骤在哪里运行**：在控制面针对已挂载的卷运行，还是经由 worker 操作在 Pod 内运行。
2. **`conflicted` 或 `blocked` 的行被丢弃后 result pin 的保留**：保留到运维移除为止，还是以 Session 归档为界。
3. **合并结果的契约**：一个记录键，还是终态回执（I2）。已由 I2 裁定：终态回执。

## 后续工作

| 切片 | 范围                                                                                                                                |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------- |
| I2   | relay 负责准备、绑定、合并与丢弃；级联负责丢弃；launch 准入与 Agent 工具对两种 child Session kind 放行 `worktree`；合并结果送达父。 |
| I3   | 以一个拒绝写入的 profile 加一个被丢弃的 child Workspace 实现 `snapshot`；把决策 15 的串行化裁定记为最终结论。                       |
