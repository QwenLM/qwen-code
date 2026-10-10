# Managed workflow child 运行时（H4 workflow 切片）

[English](2026-10-10-managed-workflow-child-runtime.md) | [简体中文](2026-10-10-managed-workflow-child-runtime.zh-CN.md)

状态：已在本变更中实现。已落地：managed workflow 准入（仅内联脚本源码）、workflow launch envelope、带 digest 重验的 workflow 首个 Turn 执行、kind 参数化的 relay/cascade/funnel，以及把两个 child Session kind 都列入的 kind 门禁。仍为设计：saved 或 extension workflow 引用、脚本级 resume、嵌套 managed 孙代、workflow 定义目录，以及其余后续项。本切片是 [#12827](https://github.com/QwenLM/qwen-code/issues/12827) 的 **workflow child 运行时**切片，属于 Managed Agent 提案 [#12380](https://github.com/QwenLM/qwen-code/issues/12380) 的 H 阶段，由 [#13803](https://github.com/QwenLM/qwen-code/issues/13803) 跟踪。它承接 H4a（[记录契约](2026-10-06-managed-child-agent-runtime.md)，#13505）、H4b（[child Session 运行时](2026-10-07-managed-child-session-runtime.md)，#13550）与 H4c（[workflow kind 与 launch 预算](2026-10-09-managed-workflow-child-kind.md)，#13754）——本切片正是 H4c Follow-up work 表里的「Workflow runtime」一行。之前的文档与本文档冲突之处，以本文档为准。

## 问题与范围

H4c 把 `managed-child_run` 的 `workflow` body kind 作为**禁用的记录契约**落地，并指名启用真正需要的东西：Workflow 工具的 managed admission、launch envelope、一个执行 workflow 的 child Session、relay 与 cascade 放宽到 `workflow` 行，然后——且只有然后——kind 门禁条目。Issue #13803 把这一切片按 K1–K4 归档：

| 项                                       | 交付内容                                                                                                                                                                | 验收                                                                                                                                |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| K1 — workflow 驱动的 child 创建          | relay 发现待处理的 `workflow` launch，并从 workflow 引用（而非 prompt）创建 child Session，在父的精确 Workspace 绑定下幂等创建，lineage 在同一事务里固化。              | 重试下一个 launch 恰好产生一个 child Session（同一 `dispatchId`）；child 的 launch input 指名 workflow 及其已 pin 的定义 revision。 |
| K2 — relay 与 cascade 纳入 `workflow` 行 | relay 的 discovery page 与 close cascade 的 live-scope query 不再只选 `child_agent`；cascade 通过一个真正能作用于它的 funnel 取消 `workflow` child。                    | 关闭父会取消其未终态的 `workflow` children；一行 `workflow` 既不会对 relay 不可见，也不会被一个够不着它的 funnel 取消。             |
| K3 — 从第一个 revision 就 pin 定义       | `workflow` run 从 opening revision 起 pin 住定义。                                                                                                                      | 第一个 revision 缺少 pin 的链被拒绝；child agent 链不被拒绝。                                                                       |
| K4 — 放行 kind 门禁                      | 在 K1–K3 之后、并在一次与 [#13532](https://github.com/QwenLM/qwen-code/issues/13532) 同形的物理验收之后，把 `workflow` 加进 `MANAGED_SESSION_ENABLED_CHILD_RUN_KINDS`。 | 一个 `workflow` launch 在真实宿主上端到端跑通；「kind 未列入时提交被拒」的既有见证是被有意翻转的，不是静默失效的。                  |

本切片**不交付**：saved 或 extension workflow 引用（仅内联源码）、被中断 child 的脚本级 resume、嵌套 managed 孙代、tenant 级 workflow 定义目录、detach、持久 peer 消息、teams、公开取消——各自在 Follow-up work 里指名。

## 现状

以下事实取自 `main` = `ba8615f4c4`（Flyway V60、契约 v1.38.0），并复核了 #13803 携带的每一条核实说明。

- **两个 kind 的记录契约已完备。** `parseChildRun` 分发 `shell`、`child_agent` 与 `workflow`；两个 child Session kind 共享一套封闭键集、一套 successor 规则与一个分类器（`isChildSessionRun`）。`workflow` run 必须从 opening revision 起 pin 住 `run.definition`——K3 的拒绝今天已存在（`managed-child-run-record.ts:519-523`，Java 侧由 `ManagedExtensionRecords.requireChildSession` 镜像）。任务投影在两种语言里都把 `child_run.workflow` 映射到 `workflow` 任务 kind；OpenAPI 已把 `TaskKind.workflow` 作为 `partial` 发布。
- **kind 门禁及其检查点。** `MANAGED_SESSION_ENABLED_CHILD_RUN_KINDS` 为 `['child_agent']`（`managed-session-records.ts:182`）。authority 的提交路径在**每一条** `child_run` revision 上检查它，而不只是 opening revision（`managed-session-authority.ts:1515-1523`），所以今天 relay 或 cascade 的任何动词（`dispatch_started`、`attach`、`commit_result`、`accept`、`mark_accepted`、`fail`、`cancel`、`close_scope`）打在一行 `workflow` 上都会得到 409 `child_operation_record`。hosted 工具轮经由 `childAgentAdmissionsEnabled()` 检查门禁——一个硬编码为 `child_agent` 的读取器。
- **relay 与 cascade 刻意窄化。** `ChildResultRelayStore.PENDING_SQL`（`:97`）与 `findLiveScopes`（`:220`）携带 `task_kind = 'child_agent'`，注释点名本切片。#13753/I1（#13781）与 H4d-a（#13786）都没有放宽它们。
- **child-agent 运行时可干净扩展。** launch envelope `{description, prompt, definition}` 在 TS 编码（`managed-child-operations.ts:55-121`），由 Java relay 解码（`ChildResultRelay.create`，`ChildResultRelay.java:239-258`），经 `ManagedAgentService.createChildSession` 创建 child——一个事务复制父的 Workspace 绑定与 tool profile、固化 V54 lineage 列、插入第一个 Turn，以记录键派生的 creation key 幂等。funnel（`HostedChildAgentSession`）在四个具名处是 kind 特异的：`record()` 的 kind 过滤、`parseAgent` 拒绝、通知的 `<kind>` 标签与 `source`，以及工具轮准入字面量。配额（`launchedChildRunsOf`/`activeChildRunsOf`）、restore 跳过与跨记录检查已是 kind 通用。
- **普通路径的 workflow 引擎存在且可无头运行。** `WorkflowRunner.start`（`packages/core/src/agents/runtime/workflow-runner.ts`）在 `node:vm` 沙箱里执行确定性 JS 脚本，`agent()`/`parallel()`/`pipeline()` 分发到进程内 `AgentHeadless` 子代理（每 run 上限：1000 agents、30 分钟 wall clock、每个子代理 50 turns/10 分钟、token 预算），以 `{runId, result, phases, logs, meta}` 结算。Workflow 工具准入内联 `script`、saved `name`/`scriptPath`、`args`、`resumeFromRunId` 与 `sourceRef {id: string, revision: string}`；脚本为权限授予计算 16 位十六进制内容 digest。Hosted profiles 没有声明 `workflow` 工具，`prepareRequests` 拒绝之。
- **pin 在普通路径上没有来源。** `DefinitionPin.definitionRevision` 是 number，digest 是全小写 SHA-256 hex（`assertManagedSessionDigest`）；legacy workflow 词汇里既没有数字 revision 也没有定义存储，且 saved-workflow 名称按宿主解析、调用之间可变（「edits take effect on the next call」）。

## 决策

1. **v1 只准入内联脚本源码。** managed workflow admission 接受 `script`（普通路径 inline 模式运行的同种确定性 JS body）、有界的 `args` 与 `run_in_background`。`name`、`scriptPath`、`resumeFromRunId` 与 `sourceRef` 在准入处以一个指名后续范围的工具错误拒绝——与 H4b 对 `snapshot`/`worktree` 模式和自定义 `subagent_type` 采取的诚实姿态相同。理由：内联源码是唯一能让父在 launch 时以零查找绑定其内容的引用；saved 名称按宿主解析且可能在 launch 与 dispatch 之间变化，launch 时 pin 的 digest 将需要 dispatch 时重验以及一条新的诚实拒绝路径；tenant 级定义目录是真正的工作，而记录契约刻意从未要求过它（H4a 决策 10）。内联同时也是普通路径的规范创作流程（模型写出它启动的那个脚本），所以这个限制不损失任何主用例。
2. **pin 从脚本自身派生。** 在决策 1 下，`DefinitionPin` 在准入时从将要运行的确切字节计算：`definitionDigest` = 脚本源码的 SHA-256（全小写 hex，满足 `assertManagedSessionDigest`）；`definitionRevision` = `1`（内联源码的约定）——内容绑定的身份不需要计数器，H4b 的先例（`hosted-agent/<profile>`，revision 1）已以同样方式使用 revision 1；`definitionId` = `workflow/<meta name>`（当脚本的静态解析 `meta.name` 匹配普通 `WORKFLOW_NAME_PATTERN` 时），否则 `workflow/unnamed`。id+revision 负责分类，digest 负责绑定。child 轮次在执行前重验 `sha256(script) = pin.digest`，不匹配则诚实失败（决策 4），于是被损毁的拷贝永远不可能执行。K3 的验收留在 H4c 契约 fixtures；本切片的义务是每个产出的 launch 都携带这些值，由准入套件钉住。
3. **workflow launch envelope 是一个同侪封闭形状。** `workflow` launch 的 `inputRef` 资源承载 `{ definition, script, args }`，封闭键（`encodeWorkflowLaunchEnvelope`/`decodeWorkflowLaunchEnvelope`，与 child agent 的一对并列），受同一 32 KiB `maxEnvelopeBytes` 约束——envelope 承载源码加结构化参数，超出预算的 launch 以 `byte_limit` 拒绝。`child_agent` envelope `{description, prompt, definition}` 不动；消费方按**记录 kind** 分支，绝不靠 envelope 形状嗅探。envelope 按构造重复记录的 `run.definition` pin（TS 里一个计算点同时喂两者），正如 `child_agent` envelope 今天携带其 pin；Java 仅从 envelope 构建 child 的 launch。
4. **child Session 把 workflow 作为它的第一个 Turn 执行——确定性地，绝不经过模型中介。** `workflow` child 的创建（`createChildSession` 的一个同侪臂）插入的第一个 Turn 携带结构化的 `workflow_launch` 输入块 `{ definition, script, args }`，而不是 `"[description]\n\nprompt"` 文本块；hosted 轮次执行器读到该块时，在进程内驱动 `WorkflowRunner.start`：Turn 的 settled 内容是 run 结果的有界序列化（`{ runId, result, phases, logs, meta }`，与其他有界内容同样的 escape-then-truncate 纪律），其 receipt 指名结果分类、`wf_` run id 与脚本 digest。下游一切随即都是**不变的 H4b 机制**：relay 盯 Turn 线到终态、拷贝已发布的结果与 receipt、提交 settle/accept；cascade 通过 child 自己的生命周期关闭它；两条完成臂（`"tool"` 等待者、`"sent"` 通知）在 funnel 之下是 kind 盲的。轮次把 Session 的普通 abort 信号接到 `runner.abort()`，于是被取消或 harness 关闭的 child 经由既有终态分类及时结算轮次，而不是跑满脚本的 wall clock。脚本中途 daemon 死亡留下被中断的 Turn，由普通轮次恢复结算为 failed；relay 随之把 run 结算为 `child_failed`——诚实；脚本级 resume 是下面指名的后续。
5. **脚本的 `agent()` 调用在 workflow child 内部运行。** 它们分发到进程内 `AgentHeadless` 子代理，受普通每-run 上限约束（1000 agents、30 分钟 wall clock、每子代理 turn/时间上限、token 预算），与普通路径完全一致——它们**不是** managed 孙代 Session。本切片的 managed 持久边界是 child Session：脚本中途 Runtime 被回收时，run 可见地失败（决策 4），而不是把扇出静默迁走。嵌套 managed 孙代需要 depth 2、cascade（已递归）语义施加到 depth 1 之下，以及按子树的预算——那是每份 H4 文档都指名的「depth beyond 1」后续，不是本切片。child Session 的工具轮继续抑制 `agent` 工具（`childDepth`），并以同样方式抑制新的 `workflow` 工具，于是嵌套 launch 连准入都不可能。这按 H 阶段形状要求的方向了结了 H4c 开放问题 2：迁移既有能力，不发明新能力。
6. **managed workflow admission 镜像 Agent 工具的准入。** 一个 `HOSTED_WORKFLOW_TOOL` 声明（`{ script, args?, run_in_background? }`）恰好广告在 Agent 工具所在之处：在久经考验的 Shell lane 上拥有自己 child orchestrator 的 Session、`childDepth === 0`、并处在它自己的门禁读取器 `childWorkflowAdmissionsEnabled()` 之后（它为 `workflow` 读 kind 门禁，正如 `childAgentAdmissionsEnabled()` 为 `child_agent` 读）。非法参数得到同样的模型可见 validation-error 词汇；launch 准入跑不变的 `admitChildLaunch`（closing → workspace_mode → definition_scope → depth_limit → budget → count → byte），其配额计数已包含 `workflow` run，于是启用 workflow 不能让一个 scope 的配额翻倍（H4c 决策 10）。launch body 来自 `workflowLaunchBody`（`childLaunchBody` 的同侪：kind `workflow`、depth 1、`workspaceMode: shared`、决策 2 的 pin），经同一 `HostedChildAgentSession.admit` funnel 以同样的重放纪律提交 revision 1。审批：在私有 Hosted profile 下，被准入的 launch **就是**授予，镜像 Agent 工具——这条路径上没有对话框；child 继承父的 tool profile 与 approval mode，它们为脚本的子代理能做的一切划界。
7. **K2 与 K4 在同一改动里落地，这是构造决定的。** kind 门禁在每一条 `child_run` revision 提交时生效，所以在门禁未放行时放宽 relay 或 cascade，其第一个动词打在 `workflow` 行上就是 409；而只放行门禁不放宽查询，正是 issue 所禁止的「隔离失败」。因此这个单一改动把 `MANAGED_SESSION_ENABLED_CHILD_RUN_KINDS` 翻为 `['child_agent', 'workflow']`，把 `PENDING_SQL` 与 `findLiveScopes` 放宽为 `task_kind IN ('child_agent', 'workflow')`，退役 H4c 的窄化注释，并让 funnel 端到端 kind 参数化：`record()` 接纳两种 kind，`parseAgent` 拒绝消失（共享的 `ChildSessionRun` 解析服务两者），通知的 `<kind>` 标签携带记录自己的 kind，通知 `source` 指名记录 kind（`child_agent` / `workflow`），`isWakeInputSource`、`isWakeOwnedInput`、关闭时 pending-input 结算与 consumption 谓词同步放宽，`/children/operations` 的错误映射不变。每一个「未列入拒绝」的既有见证——门禁常量测试、H4c authority 的「registered but not enabled」见证、工具轮/funnel 对门禁读取器的桩——都在同一提交里改写为断言被准入的行为，于是没有任何拒绝见证静默死去。
8. **无 schema 变动、无公开契约变动。** 放宽不需要新列（relay 账本、discovery 索引与 lineage 列是 kind 盲的），所以 V60 之后没有 Flyway 迁移。`TaskKind.workflow` 已作为 `partial` 发布；OpenAPI 与 `contract-known-gaps.txt` 字节不变。启用姿态与 H4b 完全一致：仅私有 Hosted profiles；生产 AgentBundle 启用仍是单独门禁的后续。
9. **K4 的物理验收在合入前完成，按 #13532 的形状。** 一个行为表，在 PR head commit 上、于真实宿主对着打包栈（managed-agent-server 加其数据库加打包的 daemon）执行，每行记录命令与输出，受阻必记原因、绝不把跳过记为通过。行为：(1) 一个前台 workflow launch 端到端完成，重试下恰好一个 child Session；(2) 一个后台 launch 送达其通知并被消费；(3) 脚本运行中途关闭父，经完整记录线取消 workflow child（`stopRequested`、cancelled、child Session 关闭）；(4) 被篡改 pin 的轮次拒绝执行（决策 2 的重验）；(5) 翻转后的见证在打包栈上成立——门禁按发布形态时 workflow 提交成功，未列入拒绝在基线构建上可复现；(6) relay 在脚本中途被中断后重新 claim 不会铸造第二个 child，结果至多送达一次。验收文件与本计划同置于 `.qwen/e2e-tests/`。日后提议生产启用时，按 #13532 为 H3 记录的方式补一次 Linux 重跑。

## 流水线，逐 revision（workflow 臂）

与 H4b 的表一致，两处替换：revision 1 携带 `kind: "workflow"` 且其 opening revision 即带决策 2 的 pin；relay 驱动的「创建」编排一个 `workflow_launch` 首个 Turn 而非 prompt Turn。每个 relay/cascade 动词、每条配额、每条 successor 规则、两条完成臂与 close cascade 都是 H4b 表指名的共享机制；「重试下恰好一个 child Session」的验收骑在同样的记录键派生 creation key 上。

| 步骤                             | 提交                                                                          | workflow 臂特有点                                                             |
| -------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1 launch（rev 1）                | `admitted` / `intent` / `planned` + 决策 2 的 pin                             | `workflowLaunchBody`；envelope `{definition, script, args}` 发布为 `inputRef` |
| 2 dispatch（rev 2）              | `dispatch_started`、`dispatchId`、runtime 绑定                                | 不变                                                                          |
| 3 attach（rev 3）                | `childSessionId`、`running_attached`                                          | 不变                                                                          |
| 4 settle（rev）                  | `settled`/`completed`、`resultRef`+`terminalReceiptRef`、delivery `accepting` | 结果 = workflow Turn 的 run 结果有界序列化                                    |
| 4b failure ends                  | `creation_failed` / `child_failed` / `quota_exceeded` / `stop_requested`      | 新增：脚本被拒（确定性门禁）、digest 不匹配、runner abort                     |
| 5–7 accept → accepted → consumed | acceptance 记录、delivery 推进                                                | 不变，两臂皆然                                                                |

## 非目标

- **saved 或 extension workflow 引用、`sourceRef`、resume**（决策 1）——定义目录或已验证引用切片，后续。
- **嵌套 managed 孙代与 depth 2**（决策 5）。
- **跨 Runtime 回收的脚本级 resume**——v1 里 runner 的 journal 保持宿主本地；记录线是持久叙事。
- **带数字 revision 的 workflow 定义目录**——对内联源码已被决策 2 的 digest 绑定取代；只有引入 saved 引用时才重新考虑。
- **生产 AgentBundle 启用、detach、peer 消息、teams、公开取消、隔离模式**——各自指名的切片，不变。
- **任何 legacy 路径改动**——普通 Workflow 工具、其信任门与审批对话框不动；managed admission 是独立声明。

## 受影响文件（计划）

- `packages/core/src/managed-runtime/managed-child-operations.ts`：workflow envelope 编解码对、`workflowLaunchBody`、决策 2 的 pin 计算；`managed-session-records.ts`：门禁列表；各自旁边的测试，含被翻转的门禁见证。
- `packages/cli/src/serve/hosted-workspace-tool-turn.ts`：`HOSTED_WORKFLOW_TOOL`、`childWorkflowAdmissionsEnabled()`、准入臂与 `acceptChildWorkflow`；`hosted-child-agent-session.ts`：kind 参数化的 funnel（record、parse、通知 kind 与 source、workflow admit）；`hosted-harness-session.ts`（加同侪 `hosted-workflow-turn.ts`）：workflow Turn 执行、wake/close 谓词放宽；`hosted-monitor-wake-turn.ts`：consumption 谓词。各自旁边的测试。
- `packages/sdk-java/managed-agent-server`：`ChildResultRelayStore`（两处放宽的查询、退役注释）、`ChildResultRelay`（create 按记录 kind 分支；complete 时从 workflow envelope 取描述）、`ManagedAgentService` 与 `ManagedAgentStore`（workflow 创建臂及其首个 Turn 块、请求 digest 覆盖 pin），各自旁边的测试（`ChildResultRelayTest`、`SessionLifecycleCoordinatorTest`、store 套件）。无迁移；下一个空闲号 V61 不使用。
- `packages/core/src/managed-runtime/contracts/`：既有 H4c 记录 fixtures 原样重放。不新增共享 envelope fixture 文件：跨语言 pin 是 Java relay 测试喂给 `createWorkflowChildSession` 的手工键入 workflow launch envelope JSON，与 TypeScript 编码器的输出形状对放重放（封闭键 `{definition, script, args}`，两侧都携带决策 2 的 pin）。
- 双语言版本的本设计；`.qwen/e2e-tests/` 下的 E2E 计划与验收结果；H4c 与 H4b 设计的 follow-up 表加注指名本切片已交付。

## 验证计划

- **TypeScript**：envelope 往返与封闭键拒绝 fixtures；准入矩阵（每种拒绝理由、两种 kind、共享配额计数）；同一提交里断言的翻转门禁见证；对一条 `workflow` 链重放每个动词的 funnel 套件；覆盖 workflow child 的声明、准入、前台等待者与 consumed 提交的工具轮套件；workflow Turn 执行器的单元套件（确定性门禁、digest 重验、abort 接线、有界序列化），注入 dispatch，镜像 `workflow-runner.test.ts`。
- **Java**：relay discovery 返回两种 kind 并各自驱动创建；workflow 创建臂的幂等重放（同 key 同 digest → 同 Session；同 key 不同 digest → 冲突）；对一行 `workflow` 的 cascade live-scope 与取消；契约重放不变。
- **双语言**：envelope 形状与翻转后的门禁在双语读取处钉住（记录契约已重放；envelope 由 TS 编码、Java 解码——`ChildResultRelayTest` 里的手工键入重放 pin 携带编码器产出的同一份 envelope JSON，relay 测试从中断言所建块的 pin 字段）。
- **故障注入（authority/relay 层）**：launch 提交前崩溃；launch 与创建之间；创建与首个 Turn dispatch 之间；脚本中途 daemon 死亡；settle 与 accept 之间；每个 run 终结于恰好一个 child Session、至多一次结果送达，或一个可见的 `unknown` 分类。
- **变异检查**：每个新守卫——envelope 封闭键、pin 计算、digest 重验、放宽的查询、kind 参数化的 funnel 读取、门禁读取器——逐个禁用时其具名见证变红，双语言，按 H0b 纪律。
- **物理验收**：决策 9 的行为表，在 PR head 的打包栈上执行，输出附加到 E2E 计划文件。

## 验收标准

- **K1**：一个 `workflow` launch 在重试下恰好产生一个 child Session（同 creation key、同 `dispatchId`），child 的第一个 Turn 指名 workflow 及其已 pin 的 revision——store 层与物理双重证据。
- **K2**：关闭父经与 `child_agent` 相同的 funnel 取消其未终态 `workflow` children；relay discovery page 与 cascade live-scope query 返回两种 kind；一行 `workflow` 既不不可见，也不经一个会拒绝的 funnel 取消。
- **K3**：每个产出 launch 从 revision 1 起携带决策 2 的 pin；H4c 拒绝 fixtures 原样重放；child 轮次的 digest 重验拒绝被篡改的拷贝。
- **K4**：`MANAGED_SESSION_ENABLED_CHILD_RUN_KINDS` 列入两种 kind；每个先前的未列入拒绝见证在同一提交里被有意改写；物理验收表记录每项行为，要么受阻要么有证据。
- 全部既有套件保持绿色——每个 H1–H4e 契约重放、双语言的 authority、store、工具轮、funnel、relay 与生命周期套件；`npm run build && npm run typecheck`、`npm run bundle`，以及完整 `managed-agent-server` surefire 套件；零缺口契约文件字节不变。

## 开放问题

1. **workflow child 在 launch 时的 `workingDirectory` 与 Workspace 模式。** v1 与 Agent 工具一样固定（`.`、`shared`）；workflow 是否可指名子目录随 launch 准入选项的后续讨论，不属本切片。
2. **脚本级 resume 接入 child Turn 恢复**——runner 的 journal resume（`resumeFromRunId`）是诚实机制，但跨被替换 harness 映射 `wf_` run 身份是它自己的设计点。
3. **结果大小暂存。** 64 KiB 结果拷贝界限原样适用；更大的 workflow 结果等待 H4b 开放问题已指名的 Artifact 暂存后续。

## 后续工作

| 切片                      | 范围                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| saved/extension 引用      | 已验证引用的准入（launch 时 digest、dispatch 时重验）或 tenant 级定义目录；`sourceRef` 与 resume 词汇。 |
| depth 2 与嵌套孙代        | depth 运行时启用、按子树预算；脚本的 `agent()` 可选地成为 managed children。                            |
| H4d-b、H4e-b、H4f、Detach | 与 H4a 交付图一致，不变。                                                                               |
| 生产启用                  | AgentBundle 能力表步骤加按 F 阶段出口门的故障门禁轮；按 #13532 形状补 Linux 验收重跑。                  |
