# Managed child worktree 准入（隔离切片 I2）

[English](2026-10-10-managed-child-worktree-admission.md) | [简体中文](2026-10-10-managed-child-worktree-admission.zh-CN.md)

状态：已在本变更中实现。已落地：hosted child agent 可以在自己的 child Workspace 中运行（`isolation: "worktree"`）。relay 在创建 child 之前准备这个 Workspace；child 完成时，在结果提交之前把它合并回来；child 失败或被取消时丢弃它；关闭级联同样丢弃它；回执把合并结果报告给父的模型。仍是设计：I3（`snapshot`，以及串行化的裁定）。这是 [#13753](https://github.com/QwenLM/qwen-code/issues/13753) 的 I2，建立在 I1（[child Workspace 能力](2026-10-09-managed-child-workspace.zh-CN.md)，#13781）、H4b（[child Session 运行时](2026-10-07-managed-child-session-runtime.zh-CN.md)）与 H4c（[workflow child kind](2026-10-09-managed-workflow-child-kind.zh-CN.md)）之上。

## 问题与范围

Issue #13753 对 I2 的要求是：“relay 在 child 自己的 Workspace 中创建 `worktree` child；关闭与 settle 路径执行合并策略；`MANAGED_CHILD_ADMITTED_WORKSPACE_MODES` 放行 `worktree`。”其退出检查是：“worktree child 的写入在其合并策略执行之前不出现在父的树中，被取消的 child 的 worktree 会被丢弃。”

I1 交付了能力，但没有调用方。本变更把唯一的生产方——hosted Agent 工具——接入 H4b 建成的 child agent 管线。`workflow` 仍然禁用（H4c 决策 5 与 6）：relay 与级联仍只处理 `child_agent` run，所以在 workflow 的运行时切片同时放宽两者之前，放行 `worktree` 对 workflow 没有任何影响。

## 现状

以下事实来自 `main` 的 `1136a51a68`。

- **准入。** `MANAGED_CHILD_ADMITTED_WORKSPACE_MODES` 为 `['shared']`。`childLaunchBody` 写入 `workspaceMode: 'shared'`，hosted tool turn 把 `shared` 传给 `childLaunchAdmission`。managed `agent` 工具接受 `description`、`prompt` 与 `run_in_background`，并把 `isolation` 作为仅属于旧版的参数拒绝（H4b 决策 11）。
- **Relay。** `ChildResultRelay.create` 读取 launch envelope 并调用非隔离的 `createChildSession`；从不读取记录的 `workspaceMode`。完成的 child 先提交（`commit_result`、`accept`），之后才关闭（`deliver`）。fail、配额与放弃分支在 `fail` 提交之前承认 child 的关闭。回执为 `{childSessionId, turnId, status, completedAt}`，由父作为不透明资源保存；两种语言中都没有校验器解析它。
- **级联。** `SessionLifecycleCoordinator.cascadeChildScopes` 对每个未 settle 的 `child_agent` run 请求停止，经由各 child Session 自己的生命周期关闭它，然后才提交 `close_scope`。任何欠下的步骤都会让父的关闭重新排期。
- **Child Workspace（I1）。** `ChildWorkspaceService.prepare`/`finish` 承认行并同步驱动 Git；扫描驱动剩下的部分。绑定的 child Session 未关闭时 `requestFinish` 拒绝（I1 决策 8），不同的收尾请求被拒绝，例外是在以 `conflicted` 或 `blocked` 结束的合并之后的丢弃。
- **前台等待（#13769）。** 前台 child 的等待可在重启后恢复：恢复的 Turn 从其 checkpoint 重新进入等待，恢复 gap fill 为已承认的孤儿调用作答。两者都通过 `fitChildResultInline` 折叠已接受的结果。
- **Hosted Session 的创建。** Java 用 `toolProfile`、store 连接以及（对 child）`lineage` 创建或加载 hosted Session。没有任何东西告诉 `qwen serve` 控制面能否提供 child Workspace。

## 决策

1. **由模型按每次 launch 选择。** managed `agent` 工具新增可选参数 `isolation`，唯一取值为 `"worktree"`，与旧版 Agent 工具的名称和取值相同。不带它时 child 为 `shared`，与今天完全一致；任何其他取值都是参数错误。launch 记录 `workspaceMode: "worktree"`（一个固定键），所以之后的每个修订与每次重放都携带它，而声明了另一种模式的重放 launch 会冲突。`MANAGED_CHILD_ADMITTED_WORKSPACE_MODES` 变为 `['shared', 'worktree']`；`snapshot` 仍被拒绝（I3）。只有在提供 child Workspace 的主机上（决策 2），模型看到的声明才包含 `isolation`；其他主机上它保持原样。Agent 工具的团队变体（H4e-b1，`name`）以同样方式获得 `isolation`，团队成员也可以像任何 child 一样隔离运行。
2. **准入时即知晓能力。** 启用 child Workspace 时，Java 在每个 hosted create 与 load 请求（attach、恢复、生命周期 settle）中加入 `childWorkspaces: true`。启动检查现在还要求它们运行在 durable local-process Broker 上，这是唯一能关闭 Workspace Session 的 Broker：合并需要 child 已关闭，所以不能关闭的主机也不能合并。`qwen serve` 把这个标志保存在常驻 Session 上，每次已证明 owner 的 create 或 load 都会刷新它（只认精确的 `true`；生命周期重答只有不带 Agent 工具的 files profile 才会走，它保持原值不变），且从不持久化，因为它描述的是主机而不是 Session。没有它时，`admitChildLaunch` 以现有的 `workspace_mode` 原因拒绝 `worktree` launch，发生在任何提交之前，也不消耗 launch 预算，工具结果会告诉模型去掉 isolation 再 launch。重放的 launch 从不重新准入，所以失去能力的主机仍能回答它已提交的 launch。
3. **relay 先准备再创建。** 对 `worktree` run，relay 先请求 child Workspace：行被承认，Git 由 child Workspace 扫描执行，从不在 relay 的单线程上执行。行处于 `preparing` 时，relay 按心跳再看一次，不消耗尝试次数。`ready` 的行以 `createChildSession(..., isolated = true)` 创建 child，所以 child 的目录进入创建摘要（I1 决策 13），从已提交 body 重放时也指向同一绑定。被拒绝的布局（`failed`）、以 `blocked` 结束的准备、已被请求收尾的 `ready` 行、因为读到 `ready` 后离开了父的绑定而被该行拒绝的创建，或无法承认该行的主机或父，都会让 run 以 `failed`/`creation_failed`、从未启动的方式 settle，并请求该行（如果之前的尝试承认过）丢弃。lineage 已经记录了 child 的情况（创建的应答丢失）不按此判定：由常规重试与放弃链将其作为已启动处理。
4. **收尾请求是持久的，在 child 关闭后执行（修订 I1 决策 8）。** 绑定的 child Session 未关闭时，`requestFinish` 不再拒绝。它记录请求；只有当绑定到该 run 的每个 child Session 都处于 `CLOSED`、`ARCHIVED` 或 `DELETED` 时，行才离开 `ready`，在此之前每 5 秒再看一次，不消耗尝试次数。I1 想要的安全性得以保留：没有任何收尾会在运行中的 Session 脚下移除目录，且一旦请求了收尾，创建仍会被拒绝。丢弃可以取代尚未开始的合并请求（行仍为 `ready`），离开 `ready` 的那一步会比对它读到的请求，所以被丢弃取代的合并永远不会执行；行一旦进入 `merging`，合并就会执行到底。
5. **完成的 worktree child 在结果提交之前合并。** child 的 Turn 完成时，relay 请求合并，承认 child 的关闭，并按心跳等待，直到行记录下结果：`merged`、`conflicted`，或被阻塞的合并的代码。之后它才提交结果（合并结果写入回执）、accept、标记已送达，并重放关闭。等待从不消耗尝试预算；等待期间的故障仍会消耗，和任何 run 一样。放弃的 run 保留 child 已完成的工作：已请求的合并保持其位置，在 Turn 已完成之后才放弃时会请求合并。工作照常落地（就像 `shared` child 的写入那样），run 则像放弃的 `shared` run 一样以 `failed` settle。失去关闭能力的主机按关闭欠账的节奏（5 分钟）等待，而不是提交一个其合并无法执行的结果。先被请求的丢弃（父正在关闭）保持其位置，此时回执报告 `discarded`。
6. **回执携带结果。** `worktree` run 的回执增加 `workspace`：`{ mode: "worktree", childWorkspaceId, outcome, code, conflictPaths?, resultRef? }`（见下表）。它由行的 `outcome_code`、`conflict_paths` 与 `result_commit` 构建，这些字段在之后的丢弃中保持不变，所以重放的 `commit_result` 逐字节相同。路径是 child 选定的名字，所以回执把它们控制在 16 KiB 的 JSON 以内，其余的数量记在 `omittedConflictPaths`：回执始终能放进父的 64 KiB 内联资源。为保证这一点，已经结束的合并在之后的丢弃以 `blocked` 结束时也保留其结果（I1 此前只对 `merged` 这样做）；丢弃的失败仍记为最后的错误。`shared` run 的回执不变。记录契约不变：回执是父的不透明资源。
7. **父的模型看到结果。** 前台工具结果在 child 的结果之后以一行结尾，过大结果被折叠时这一行仍会保留：
   - `[child workspace] merged into this Workspace as uncommitted changes.`
   - `[child workspace] merge conflicted at "src/a.ts", "b.md"; the child's changes did not land; the child's work is kept at refs/qwen/child-workspaces/<id>/result.`
   - `[child workspace] merge blocked (<code>); the child's changes did not land; the child's work is kept at <ref>.`（仅当有结果被 pin 时才带 ref）
   - `[child workspace] discarded; the child's changes did not land.`
   - `[child workspace] the merge outcome is unavailable; inspect this Workspace before relying on the child's changes.`：`worktree` run 的回执不符合结构时。

   恢复的等待与恢复 gap fill 以同一行结束其回答：折叠会在结果之后完整保留这一行。

   冲突路径是 child 选定的名字：每个先以 JSON 加引号（换行保持为转义，不会自成一行），再剥离显示控制字符，JSON 不转义的行分隔符与段分隔符也被转义，列表在 4 KiB 处截止并以 `and N more` 结尾（计入回执省略的路径）。后台通知在 `<status>` 旁的 `<workspace>` 元素中携带同一句话。两者都读取 acceptance 所指的回执；`shared` run 不增加任何内容。

8. **失败或被取消的 worktree child 被丢弃。** relay 的 fail 分支（失败或被取消的 Turn、没有已完成 Turn 的放弃，见决策 5）在其 `fail` 提交之前请求丢弃；记录按时 settle，丢弃在 child 关闭后执行（决策 4）。已请求的合并保持其位置，所以 child 之后失败的 Turn 不会取代它，relay 也从不在未 pin 的情况下丢弃已完成 child 的工作：超出上限的回答以 `quota_exceeded` settle，并请求合并。只有在该合并开始之前就关闭的父仍会丢弃它（决策 9）。relay 自身处理父已不再活跃的路径也会请求丢弃，所以在父开始关闭时、级联查看之后才被承认的行不会被遗留。表示行已 settle 的拒绝不算欠账；没有行的 run（所有 `shared` run）只做一次查询。relay 从不等待丢弃完成。
9. **关闭级联只丢弃，不等待。** 级联在停止请求之后请求丢弃 `worktree` run。表示行已 settle 的拒绝（`merged`、`discarded`、合并已在执行）不是失败：正在执行的合并会落地。请求的任何其他失败会像级联其他欠下的步骤一样让父的关闭重新排期，并保持该 run 的 scope 打开（不提交 `close_scope`），这样重新排期的关闭会再次找到这个 run 并再次请求。父的关闭从不等待丢弃执行，所以无法完成的丢弃不会卡住关闭；由行自身的重试与 `blocked` 终态（I1）承接。
10. **兄弟按完成顺序合并。** 每个 child 的合并在该 child 完成时执行，处于 storage 的维护 hold 之下（I1 决策 10），并以当时父的树为准计算，其中包括更早兄弟的合并。之后编辑了相同行的兄弟以 `conflicted` 结束，带上其路径，其工作被 pin 住；除此之外不对兄弟排序。
11. **lease 规则保持 H4b 的设定。** child Workspace 位于父的 storage 中，所以现有守卫原样适用：Turn 持有挂载时拒绝前台 child，只含 agent 的批次不占用挂载。准备与合并遇到被持有的 storage 时得到 `workspace_busy`，再看一次，不消耗尝试次数。

## 回执

| 字段                             | 含义                                                                                                                                                                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace.mode`                 | `"worktree"`。                                                                                                                                                                                                       |
| `workspace.childWorkspaceId`     | child Workspace 的 32 位十六进制 id（I1）。                                                                                                                                                                          |
| `workspace.outcome`              | `merged`、`conflicted`、`blocked` 或 `discarded`。                                                                                                                                                                   |
| `workspace.code`                 | 行的 `outcome_code`：`merged`、`conflicted`、`discarded`，或让合并以 `blocked` 结束的代码（某个 `child_workspace_*` 拒绝或 Broker 代码）。不符合 `[a-z][a-z0-9_]{0,63}` 的代码会让面向模型的文本把结果报告为不可用。 |
| `workspace.conflictPaths`        | 仅 `conflicted`：按合并顺序的冲突路径，至多 100 个，且 JSON 至多 16 KiB。                                                                                                                                            |
| `workspace.omittedConflictPaths` | 字节上限省略了已记录的路径时：省略的数量。                                                                                                                                                                           |
| `workspace.resultRef`            | 工作未落地且存在结果时：保存 child 结果提交的 pin ref。                                                                                                                                                              |

## 非目标

- `snapshot`，以及串行化的裁定（I3）。
- `workflow` child：该 kind 仍禁用；它的运行时切片会放宽 relay 与级联。
- continuation（H4d）的 hosted 生产方。continuation 沿用其前驱的模式，所以被续接的 `worktree` run 会以当时父的树准备一个自己的 Workspace。
- 按 launch 选择合并策略、自动解决冲突，或替父提交合并后的变更。
- 父与 child 之间的并发：同一个 storage lease 仍串行化它们的 tool turn（I1 决策 1）。
- 任何公开契约的变更：OpenAPI 契约、路由、记录 body 与迁移保持不变。

## 受影响的文件

- `packages/core/src/managed-runtime/managed-child-operations.ts`：放行的模式、launch body 的模式，以及能力拒绝。
- `packages/cli/src/serve/hosted-workspace-tool-turn.ts`：`isolation` 参数及其准入；前台结果的 workspace 行。`hosted-child-agent-session.ts`：launch 模式及其重放检查；通知的 `<workspace>` 元素。`hosted-harness-session.ts`：create 与 load 上的 `childWorkspaces` 标志。`hosted-runtime-recovery.ts`：gap fill 的 workspace 行。
- `packages/sdk-java/qwencode`：`CreateHarnessSession` 与 `LoadHarnessSession` 携带 `childWorkspaces`。
- `packages/sdk-java/managed-agent-server`：`ManagedAgentProperties`（durable Broker 要求）、`QwenHostedHarnessConnector`（标志）、`ChildResultRelay`（准备、提交前合并、失败时丢弃、回执）、`SessionLifecycleCoordinator`（级联的丢弃）、`ChildWorkspaceService` 与 `ChildWorkspaceStore`（只请求不执行的入口、延后的收尾、丢弃取代未开始的合并、保留已结束合并的结果）。
- 各自旁边的测试、本设计的两种语言版本，以及 I1 设计中的说明。

## 验证

- **准入**（`managed-child-operations.test.ts`）：只有具备主机能力时才放行 `worktree`，具备能力时 `snapshot` 仍被拒绝，launch body 记录传入的模式。
- **Agent 工具**（`hosted-workspace-tool-turn.child-agent.test.ts`，新增 8 个用例，以及 `hosted-workspace-tool-turn.team.test.ts`）：`isolation` 同时组合到普通与团队声明上，具备能力的主机声明团队的隔离变体，不具备能力的主机以 `workspace_mode` 拒绝成员且不产生花名册条目，隔离运行的成员被记录为 `worktree`；只有在具备能力的主机上声明才包含 `isolation`，否则就是 H4b 的那个对象本身；在不具备能力的主机上，`worktree` launch 以 `workspace_mode` 被拒绝且不产生记录；任何其他 `isolation` 都是参数错误；模式被记录，已提交的 launch 在能力消失后仍能重放；前台回答以其结果行结尾，不符合结构的回执回答 "unavailable"，过大回答被折叠时该行仍保留。
- **Child Session 漏斗**（`hosted-child-agent-session.test.ts`，新增 6 个用例）：回执解析器覆盖每种结果与每个不符合结构的成员；面向模型的句子给路径加引号、剥离显示控制字符、转义行分隔符与段分隔符、限制列表长度并计入回执的省略数；`worktree` run 的真实唤醒通知中有 `<workspace>` 元素，`shared` run 没有；声明另一种模式的重放 launch 被拒绝。
- **恢复后的回答**（`hosted-child-wait-recovery.test.ts`）：恢复 gap fill 为已承认的 `worktree` 孤儿作答时以其结果行结尾，`shared` 孤儿则没有。
- **主机标志**（`hosted-harness-session.test.ts`）：带标志的 create 之后、复述标志的常驻重答之后、复述标志的全新 load 之后都会声明 isolation，其他情况（缺少标志，或文本 `"true"`）都不会。
- **Relay**（`ChildResultRelayTest`，新增 16 个用例）：准备阶段按心跳等待且不消耗，`ready` 后以隔离方式创建 child；被拒绝、已阻塞、已请求收尾或不受支持的行，以及 `ready` 之后被拒绝的创建，都以从未启动 settle 并请求丢弃，除非 lineage 已记录了 child；在任何提交之前先请求合并并承认关闭，结果只在结果代码确定后才提交，每种结果的回执在之后的丢弃中逐字节不变，先请求的丢弃保持其位置，不能关闭的主机按空闲间隔等待；回执的路径上限；失败的 child 丢弃，已请求的合并不被之后失败的 Turn 取代，超出上限的已完成 child 合并，有已完成 Turn 的放弃合并、没有则丢弃，正在关闭的父的行被丢弃；`shared` run 从不请求任何东西。
- **Child Workspace 状态机**（`ChildWorkspaceServiceTest`，H2 上用真实仓库的 34 个用例）：绑定的 child 运行期间（包括 `CLOSING` 时）合并被记录，child 关闭后才执行，并清除等待留下的最后错误；丢弃取代尚未开始的合并，包括在合并开始的瞬间落地时（经由服务与经由 store 的比较并设置）；已开始的合并拒绝丢弃；已结束的合并在无法完成的丢弃中保留其结果、路径与结果提交。
- **级联**（`SessionLifecycleCoordinatorTest`）：请求丢弃但从不等待；正在执行的合并任其落地；失败的请求让父的关闭保持欠账、该 run 的 scope 保持打开，包括 child 已关闭且没有其他欠账时；没有行的 run 从不被请求。
- **控制面的管道**（`QwenHostedHarnessConnectorTest`、`HostedHarnessClientTest`、`ManagedAgentPropertiesTest`）：create、load、恢复与生命周期 settle 上都带标志，生命周期副本以任一顺序都会保留，禁用时不出现；没有 durable Broker 时启动拒绝 child Workspace。
- **流水线**：与 CI 一致的 MariaDB 流水线（`-Pmysql-integration clean verify checkstyle:check`）：1740 个单元测试与 130 个集成测试，Checkstyle 与 SpotBugs 均无问题，另有 `qwencode` 的 217 个测试。TypeScript：core 与 CLI 的 `tsc`，所有改动文件的 ESLint 与 Prettier，以及在干净的 `pnpm` worktree 中运行完整的 core `managed-runtime` 套件与 CLI `serve` 套件。其中仅有的失败在同一主机的 `main` 上同样失败。
- **变异检查**：86 个变异，每个禁用一个守卫（Java 53 个，TypeScript 33 个），全部变红。另有一个（比较并设置失败时原先的抛出）在该步骤改为直接返回后成为等价变异，不计入。

## 验收标准

- `worktree` child 的写入在其合并执行之前不出现在父的树中；完成的 child 的合并在父看到结果之前以未提交变更的形式落地，冲突连同其路径与保存 child 工作的 ref 一起送达父的模型。
- 失败或被取消的 `worktree` child 的 worktree 被丢弃，父的关闭从不等待这次丢弃。
- 不提供 child Workspace 的主机在任何提交之前拒绝 `isolation: "worktree"`。
- `shared` child 的行为与之前完全一致，`workflow` 仍禁用。

## 开放问题

1. **冲突 child 的结果 pin 的保留期**仍是 I1 的开放问题 2。以 `blocked` 结束的合并保留其 worktree（以及已生成的结果 pin）供运维处理：其 run settle 之后不会再有任何东西丢弃它（run 尚未 settle 时父关闭，则会丢弃它，见决策 9）。
2. **合并是否应当替父提交** child 的变更，而不是保留为未提交，留待之后的需求。
3. **合并等待的上限。** 合并等待 child 关闭，结果等待合并。永远无法完成的关闭会一直扣住结果：前台父 Turn 会等到被取消为止，此时已提交的 child 按 H4b 的约定继续运行。放弃等待要么丢弃未被 pin 的工作，要么报告一个行仍可能改变的结果，所以暂不设上限。

## 后续工作

| 切片 | 范围                                                                          |
| ---- | ----------------------------------------------------------------------------- |
| I3   | 通过拒绝写入的 profile 在被丢弃的 child Workspace 上实现 `snapshot`；串行化。 |
