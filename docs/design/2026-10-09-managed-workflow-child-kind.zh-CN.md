# Managed workflow child kind 与 child launch 预算(H4c)

[English](2026-10-09-managed-workflow-child-kind.md) | [简体中文](2026-10-09-managed-workflow-child-kind.zh-CN.md)

状态:已在本变更中实现。已落地:`managed-child_run` 的 `workflow` 记录体 kind,在两种语言中均已登记并校验,但不开放提交;以及累计 child launch 预算,超出时以 `budget_exhausted` 拒绝。workflow 运行时已由后续切片交付([设计](2026-10-10-managed-workflow-child-runtime.zh-CN.md));仍为设计的只剩 Workspace 隔离策略(见"后续工作")。这是 [#12827](https://github.com/QwenLM/qwen-code/issues/12827) 的 **H4c** 切片,即 Managed Agent 提案 [#12380](https://github.com/QwenLM/qwen-code/issues/12380) 的 H 阶段,由 [#13743](https://github.com/QwenLM/qwen-code/issues/13743) 跟踪。它承接 H4a([记录契约](2026-10-06-managed-child-agent-runtime.md),#13505)与 H4b([child Session 运行时](2026-10-07-managed-child-session-runtime.md),#13550)。更早的 [H4 问题框架](2026-10-04-managed-child-agents.md) 仍是背景;凡它与 H4a、H4b 或本文档冲突之处,以后者为准。

## 问题与范围

Issue #13743 在 H4c 名下提出三件事:`workflow` child kind(C1)、Workspace 隔离策略 `independent_worktree` 与 `shared_serialized`(C2),以及 child 的深度/并发/预算配额(C3)。它还记录了一处文档漂移:2026-10-04 的问题框架给 H4c 的范围,与 H4a 发布的六片式交付地图不同。维护者于 2026-10-09 裁定了范围:

- **C1 在这里落地**,形式是记录契约:记录体 kind、其校验器与固定字段规则、由 TypeScript 与 Java 共同重放的共享 fixture,以及挂在既有 kind 门禁之后、默认禁用的准入。
- **C3 在这里落地,收窄到真正缺失的部分。** H4b 已在 launch 时拒绝深度超过 1 和每个 scope 超过 4 个活跃 child。没有任何规则约束的是 launch 的累计次数:模型可以 launch 4 个 child、等待,再 launch 4 个,无休无止。预算补上了这个缺口。
- **C2 移到它自己的切片。** `managed-agent-server` 与 `runtime-broker` 中没有任何 Workspace provider 能为 child 创建 worktree 或把它合并回去。两种策略都要先有这项能力,任何记录层的改动才有意义(决策 11)。

### 2026-10-04 H4c 行各项的去向

| 2026-10-04 H4c 行中的项                                        | 落地位置                                                |
| -------------------------------------------------------------- | ------------------------------------------------------- |
| 后台 child 通知                                                | H4b(`"sent"` 完成方式:notification input 加生成的 wake) |
| 关闭级联:默认取消、orphaned 结果                               | H4b(关闭协调器中的级联;relay 账本的 `orphaned` 状态)    |
| 带持久 owner 的 detach                                         | H4a/H4b 的"Detach"后续工作                              |
| 经 planned 取消路由的 child 任务取消                           | H4f(公开任务取消)                                       |
| 深度与并发配额                                                 | H4b(launch 时的 `depth_limit`、`count_limit`)           |
| 预算配额                                                       | **本切片**(launch 时的 `budget_exhausted`)              |
| `workflow` kind(列在"Later H4 slices"下)                       | **本切片**,作为禁用的记录契约                           |
| `independent_worktree`、`shared_serialized`("Later H4 slices") | 隔离切片(决策 11)                                       |

## 现状

以下事实取自 `main` 的 `15c11bb898`。

- **记录体分发。** `parseChildRun`(`managed-child-run-record.ts`)恰好分发两个 kind:`shell` 与 `child_agent`。Java 中由 `ManagedExtensionRecords.requireChildRun` 镜像。共享 fixture 用 `kind: "workflow"` 作为未知 kind 的见证(`kind-unknown`、`agent-kind-workflow`)。
- **Kind 门禁。** `MANAGED_SESSION_ENABLED_CHILD_RUN_KINDS` 为 `['child_agent']`。两个生产位置会检查它:authority 的提交路径,以及 hosted tool turn 中 Agent 工具的准入。
- **隔离词汇。** `child_agent` 记录体携带 `workspaceMode`,封闭取值为 `shared`、`snapshot`、`worktree`(H4a)。`MANAGED_CHILD_ADMITTED_WORKSPACE_MODES` 只准入 `shared`,launch 准入以 `workspace_mode` 拒绝其余取值。问题框架中的 `read_only_snapshot`、`independent_worktree`、`shared_serialized` 在代码里一次都没有出现。
- **配额。** `admitChildLaunch` 在 launch 时、任何东西提交之前拒绝:`closing`、`workspace_mode`、`definition_scope`、`depth_limit`(深度超过 1)、`count_limit`(每个 owner scope 4 个活跃 child)与 `byte_limit`(32 KiB launch envelope)。实际运行中深度同样有界:child Session 自己的 turn 从不声明 Agent 工具(hosted tool turn 中的 `childDepth === 0`)。没有任何规则约束 launch 的总次数。
- **Java 运行时路径。** relay 的发现页(`ChildResultRelayStore.PENDING_SQL`)与关闭级联(`findLiveScopes`)选中所有带交付线的 `child_run` 行。目前只有 `child_agent` 行带交付线,relay 的注释也这么写着。
- **读取方。** hosted workspace restore 枚举显式跳过 `child_agent` 记录。child agent 漏斗(`HostedChildAgentSession`)只读取 `child_agent` 记录。

## 决策

1. **`workflow` 是 `managed-child_run` schema version 1 的第三个记录体 kind。** 由记录体自身的 `kind` 字段分发;envelope 与 `recordRef.schemaVersion` 不变(H4a 决策 1)。旧读取方会拒绝 `workflow` 记录体,这正是 H3 与 H4a 已采取的 fail-stop 立场。目前还没有 Session 能持有这种记录,因为 kind 门禁拒绝每一次提交,所以不存在混合版本窗口。
2. **两种 child Session kind 共用同一形状。** `workflow` 与 `child_agent` 共享封闭键集、固定键、停止原因,以及每一条 run、交付与 acceptance 规则。workflow child 是一个 child Session,它的 launch 输入运行一个 workflow,而不是一段提示词。流水线提交的每个事实对二者都相同:launch 身份、dispatch、attach、结果副本、acceptance、consumption 与级联取消。workflow launch 在提示词之外需要的东西(要运行的 workflow 及其参数)放在 `inputRef` 指向的 launch 输入里。该 envelope 由 workflow 运行时切片定义,正如 H4b 定义了 child agent 的 envelope。
3. **两种 kind 有三处不同。**
   - 任务 kind:`workflow` run 投影为任务 kind `workflow`。公开的 `TaskKind` 枚举已列出它(`partial`),因此 OpenAPI 契约不变。
   - 启用:kind 门禁准入 `child_agent`,不准入 `workflow`。
   - definition pin:`workflow` run 必须在每个修订上都携带 `run.definition`,包括第一个修订。pin 指名它运行的 workflow:`definitionId` 是 workflow 的稳定身份,`definitionRevision` 是其修订,`definitionDigest` 是所运行定义的摘要。workflow 是这次 launch 的主体,所以缺少它的 launch 会以 "Workflow run must pin its workflow definition from launch." 被拒绝。child agent 仍可在没有 pin 的情况下开启,但最迟在 dispatch 时必须带上(H4a)。
4. **跨记录规则按 child Session 适用,而不是按 kind。** TypeScript authority 与 Java store 对两种 kind 适用同样三条规则:
   - 第一层 run 的 `rootSessionId` 必须是持有该日志的 Session。
   - `child_acceptance` 可以指名任一 kind 的 run。拒绝文本改为 "Child acceptance must name a child Session run of this Session."
   - H4b 决策 7 的反向 acceptance 检查。

   这些规则,以及后继与起始规则、restore 跳过和 launch 配额,都通过同一个点名两种 kind 的分类函数判断,而不是写成"不是 Shell":`managed-child-run-record.ts` 中的 `isChildSessionRun`,以及 Java 的 `ManagedExtensionRecords.isChildSessionRun`。TypeScript 的分类函数与任务 kind 投影对 `AnyChildRun` 的每个 kind 穷举 switch,所以以后新增的 kind 在被分类之前无法通过编译。Java 中未列出的 kind 不算 child Session,`childRunTaskKind` 会拒绝它,而不是把它投影成 child agent。

5. **`workflow` 保持禁用。** `MANAGED_SESSION_ENABLED_CHILD_RUN_KINDS` 仍为 `['child_agent']`。authority 在发布任何内容之前,以 "domain child_run kind workflow is registered but not enabled for submission." 拒绝 `workflow` 提交。Java store 先于任何写入方校验并物化 `workflow` 记录体(H1–H4b 一直保持的 server-first 顺序),并投影其任务 kind。
6. **Java 运行时路径仍只处理 `child_agent`。** relay 的发现页与关闭级联的 live-scope 查询现在都额外要求 `task_kind = 'child_agent'`。relay 创建的是运行提示词的 child Session,级联则经由 child agent 漏斗取消。如果二者处理 `workflow` 行,relay 会从一次 workflow launch 创建出由提示词驱动的 child,级联会卡在一个漏斗拒绝的取消上,让关闭无法完成。放宽二者属于 workflow 运行时切片。因此启用 `workflow` 不只是加一条门禁条目:它需要 Workflow 工具的 Managed 准入、launch envelope 以及这两处放宽,全部在那个切片中完成。
7. **读取方容忍新 kind。** workspace restore 枚举跳过所有 child Session kind,因为二者都不拥有输出 manifest。child agent 漏斗仍只读取 `child_agent` 记录,所以它的记录查找永远不会把 `workflow` run 当作 child agent 返回。
8. **深度与并发保持 H4b 交付时的样子。** 深度 1,每个 owner scope 最多 4 个活跃 child,超出时分别在 launch 时以 `depth_limit` 或 `count_limit` 拒绝,且不提交任何东西。
9. **launch 预算。** 一个 owner scope 在 Session 生命周期内最多 launch `MANAGED_CHILD_LIMITS.maxLaunchesPerScope` = 64 个 child Session run。
   - 计入什么:该 scope 已提交的每个 child Session run,不论 kind、不论状态。失败与取消的 launch 也计入,因为每一次都消耗了一次创建尝试,并留下一条重建时要回放的链(H0c 未决问题 1)。
   - 拒绝方式:`admitChildLaunch` 回答 `budget_exhausted`(H0b 的配额原因之一),Agent 工具以工具错误 "Hosted child agent refused this launch (budget_exhausted)." 回答该调用。除该调用的工具结果外不提交任何东西。
   - 顺序:预算在深度之后、`count_limit` 之前检查。用尽的预算永远不会恢复,而并发上限在之后的 launch 时可能已经腾出,所以先报告永久性的原因。
   - 重放安全:两个计数都只读已提交的记录,所以重放会推导出同样的回答。记录已存在的重驱 launch 会跳过准入(H4b 的规则),所以 child 永远不会被计入它自己的重放。
   - 取值:64 相当于并发上限的 16 个整轮。在 64 KiB 的结果副本上限下,它还把每个 Session 的结果副本限制在约 4 MiB。
10. **配额按 child Session 计数,而不是按 kind。** 并发与预算都把 `child_agent` 与 `workflow` run 合在一起计数,所以以后启用 workflow 不会让一个 scope 的额度翻倍。
11. **隔离是它自己的切片,其词汇现在即确定。** 以 H4a 交付的词汇为准:`shared`、`snapshot`、`worktree`。问题框架中的 `read_only_snapshot` 与 `independent_worktree` 即 `snapshot` 与 `worktree`。`shared_serialized` 在这里不单独命名:`shared` child 已经经由 Workspace lease 纪律串行化(H4b 决策 3)。按 child 的 generation 与 barrier 是否需要独立取值,由隔离切片决定。那个切片从 Workspace 能力开始,因为没有 provider 能为 child 创建 worktree 或把它合并回去。记录层的改动要等这项能力存在之后。该切片由 [#13753](https://github.com/QwenLM/qwen-code/issues/13753) 跟踪。

## 记录

### `managed-child_run`,kind `workflow`

Schema version 1。链以 `childRunId` 为键,与 `child_agent` 相同。[`child_agent` 表](2026-10-06-managed-child-agent-runtime.zh-CN.md)中的每个键与规则原样适用,以下除外:

| 键               | 规则                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| `kind`           | `"workflow"`。链永远不改变 kind:`kind` 是固定键。                                                       |
| `run.definition` | 从第一个修订起,每个修订都必须携带:workflow 的身份、修订与摘要。共享 run 规则随后使它只设一次,永不改变。 |

任务投影把 `workflow` run 映射为任务 kind `workflow`。`child_acceptance` 不变:它现在除了 `child_agent` run,也可以指名 `workflow` run。

## 非目标

- **workflow 运行时**:Workflow 工具的 Managed 准入、launch envelope、执行 workflow 的 child Session、放宽 relay 与级联,以及启用该 kind。
- **Workspace 隔离策略**(决策 11)。
- **深度超过 1**,以及嵌套树的按根预算。
- **模型、token 与时长预算。** 这里的 `budget_exhausted` 约束的是 launch 次数,不是 token;`duration_limit` 仍未使用。
- **任何公开契约变更。** OpenAPI 契约、路由与 Flyway 迁移保持不变。

## 受影响文件

- `packages/core/src/managed-runtime/managed-child-run-record.ts`:`workflow` kind(`WorkflowRun`、`ChildSessionRun`)、共享的 child Session 解析器,以及 launch 时的 pin 规则。
- `packages/core/src/managed-runtime/managed-extension-projection.ts`:`workflow` 任务 kind。
- `packages/core/src/managed-runtime/managed-session-authority.ts`:root、acceptance 与反向检查适用于所有 child Session kind。
- `packages/core/src/managed-runtime/managed-child-operations.ts`:`maxLaunchesPerScope`、`launchedInScope` 与 `budget_exhausted` 拒绝。
- `packages/core/src/managed-runtime/contracts/managed-child-run-record-v1.fixtures.json`:`workflow` 模板、15 个用例与 9 个后继对,child agent 的对照用例 `agent-start-without-definition`,以及改指向 `kind: "unregistered"` 的未知 kind 见证。`managed-extension-projection-v1.fixtures.json`:`child_run.workflow → workflow`。
- `packages/cli/src/serve/hosted-child-agent-session.ts`(`launchedChildRunsOf`;`activeChildRunsOf` 计入两种 kind)、`hosted-workspace-tool-turn.ts`(传入 launch 计数)与 `hosted-harness-session.ts`(restore 跳过所有 child Session kind)。
- `packages/sdk-java/managed-agent-server`:`ManagedExtensionRecords`(分发、`requireChildSession`、pin 规则、任务 kind)、`ManagedExtensionRecordStore`(三条跨记录规则按 child Session 适用)、`ChildResultRelayStore`(relay 发现页与级联限定到 `child_agent`)。
- 两种语言中各文件旁的测试;本设计的两种语言版本,以及 H4 问题框架、H4a 与 H4b 设计中的范围说明。

## 验证

- **Fixture 一致性。** `workflow` 的用例与后继对在两种语言中经 `managed-child-run-record.test.ts` 与 `ManagedChildRunRecordContractTest` 重放。两个校验器都以 fixture 指名的子句拒绝每个非法用例,Java 还钉住了每个合法用例的任务 kind。
- **Authority。** 真实的 kind 门禁拒绝 `workflow` launch,且没有任何内容被发布。仅在植入时放开门禁的情况下,`workflow` 链经过 acceptance 与 consumption 提交,在没有门禁的情况下重新打开时重建(门禁拒绝的是提交,从不拒绝读取方),投影任务 kind `workflow` 并带上 pin 的 `definitionRevision`,并遵守 root、acceptance 与反向规则。
- **Java store 与 relay。** `workflow` 链在同样规则下提交并投影为 `workflow`。交付待处理的 `workflow` 行既不出现在 relay 的发现页上,也不出现在级联的 live scope 中。
- **预算。** 准入矩阵覆盖了边界与顺序。tool turn 测试 launch 了第 64 个 child,随后在没有活跃 child 的情况下两次以 `budget_exhausted` 拒绝第 65 个。两次拒绝都没有提交任何记录,第二次拒绝表明重放推导出了与第一次相同的回答。
- **读取方。** 在分离的 Shell lineage 旁边放一条 `child_agent` 或 `workflow` 记录时,workspace restore 都能成功。配额计数包含一条植入的 `workflow` run,而漏斗自己的记录查找不会返回它。
- **变异检查。** 每条新守卫都逐一禁用过,其见证均变红:TypeScript 11 个,Java 8 个。另有一个变异(把 restore 跳过收窄回 `child_agent`)与本变更行为相同,因为枚举的落空分支写入 `undefined`,而 lineage 检查本就把它视为不存在。这个变异改由 `tsc` 拒绝,因为 `workflow` run 没有 `outputRef`。

## 验收标准

- TypeScript 与 Java 从共享 fixture 产出并拒绝完全相同的 `workflow` 链,除两个改指向的未知 kind 见证外,所有 H3、H4a 与 H4b 用例原样重放。
- `MANAGED_SESSION_ENABLED_CHILD_RUN_KINDS` 为 `['child_agent']`,`workflow` 提交以 "registered but not enabled" 被拒绝。
- 超出预算的 launch 以 `budget_exhausted` 被拒绝且不提交任何 child,重放回答相同。
- 没有公开 API 或迁移变更,所有既有 child agent 测试保持通过。

## 未决问题

1. **workflow launch envelope**:它指名的是已保存 workflow、扩展 workflow 还是内联源码,以及参数如何约束。由 workflow 运行时切片决定。
2. **workflow 自己的 agent 在哪里运行**:作为嵌套的 child Session(需要深度 2 与真实的树深度;`childLaunchAdmission` 目前传入的是深度 1),还是在 workflow child 内部运行。由 workflow 运行时切片决定。
3. **预算取值**:64 是否需要调整,以及嵌套落地后的按根预算。

## 后续工作

| 切片            | 范围                                                                                                                                                                                                                                                                                                        |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflow 运行时 | 已由 [workflow 运行时设计](2026-10-10-managed-workflow-child-runtime.zh-CN.md) 交付:Workflow 工具的 Managed 准入(内联源码,见该设计决策 1 —— 了结了本文未决问题 1)、launch envelope、child Session 执行 workflow(其 agent 在进程内运行,了结了未决问题 2)、relay 与级联放宽到 `workflow`,以及 kind 门禁条目。 |
| 隔离            | [#13753](https://github.com/QwenLM/qwen-code/issues/13753):为 child worktree 及其合并回去提供 Workspace 能力;然后是 `worktree`(生命周期、合并策略)与 `snapshot`,并决定串行共享是否需要独立取值。                                                                                                            |
| H4d–H4f、Detach | 与 H4a/H4b 交付地图相同。                                                                                                                                                                                                                                                                                   |
