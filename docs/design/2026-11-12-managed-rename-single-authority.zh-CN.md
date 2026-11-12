# Managed Session 重命名：单一显示权威

[English](2026-11-12-managed-rename-single-authority.md)

状态：已实现；聚焦 H2 回归已本地验证，真实 MySQL 与 fault profile qualification 待 CI。日期：2026-11-12。

## 问题

手动 Session 重命名目前以跨存储 saga 的方式投递。Java 受理命令，在租约下认领投递，
附着 Hosted Harness，发送带 revision 的标题，等待 Harness 提交 `session_metadata`
journal 记录，然后才结算公共 SQL 回执。后台协调器重投未完成的标题，parked-operation
reconciler 依据 journal 证据裁决无应答的提交（D7-2），close/archive/delete/cwd/Workspace
迁移在标题投递未完成时都拒绝受理。revision watermark 被实现了三遍：Java store、Java SDK、
TypeScript journal authority。

这套机器买到的保证是"HTTP 200 意味着标题在公共 SQL 行与私有 journal 中都已持久化"。
这个保证是**自找的、且不对称的**：

- Harness 是标题的主动生产者。子会话
  （`packages/cli/src/serve/create-sub-session.ts`）与定时任务
  （`packages/cli/src/serve/scheduled-task-keepalive.ts`）向 journal 写入
  `titleSource: 'auto'` 元数据。
- **不存在 journal 到 SQL 的标题投影**。persistence 模块中仅有的两处
  `UPDATE ma_session SET title` 都在 rename saga 内部（`AgentSessionCommands` 结算与
  `AgentExecutionOperations` 中的 D7-2 reconciler）。因此 auto 标题永远不进公共 SQL 行；
  列表显示创建时的标题，transcript 显示 auto 标题，系统已经无限期容忍这种分叉。

也就是说，昂贵路径在保护一个廉价路径根本不提供的 consistency 属性，而对象只是一个纯显示
元数据字段。会话标题不被主模型上下文、子会话命名（使用子会话自己的 name/prompt）或自动化
执行所消费。这套 saga 是复杂度棘轮：它起源于 #13163 的 follow-up，每修一个竞态（晚到的旧写、
丢回复、无应答提交）就多加一道围栏——revision、claim/lease、重投、parked 证据——而单权威
设计根本不需要这些。

## 现状

已验证的流程（手动 rename）：

1. `ManagedAgentService.renameSession` 校验幂等键，回放已完成命令，施加 actor/role/可见性
   门禁，要求 Harness 声明 title protocol version 1（`supportsFencedTitles`），调用
   `store.beginSessionRename`。
2. 请求认领投递（`claimRename`），附着 Harness，`markRenameSubmitted`，调用
   `harness.rename(tenant, session, title, revision)`，然后 `completeSessionRename`。
3. SDK `HostedHarnessClient.updateSessionTitle` 以 `managedRenameRevision` POST
   `/session/:id/title`。
4. Harness 路由以 `commandId: hosted-title:${revision}` 提交 `session_metadata` 域记录；
   journal authority 在其串行事务内比对持久化 watermark
   （`packages/core/src/managed-runtime/managed-session-authority.ts`），以
   `ManagedSessionTitleSupersededError` 拒绝更旧的 revision。
5. 失败时请求 abandon 并重试投递；`SessionRenameCoordinator` 每秒扫描
   `deliverableRenames` 并在租约下重投；无应答的提交 park 为 `recovery_blocked`，
   `RenameEvidence` 让 `OperationReconciler` 从 journal 裁决。

Schema：`ma_session.title_revision`（单调计数器）与通用的
`ma_operation.delivery_state / claim_owner / claim_until` 列。`ma_delivery` 表无关
（CHANNEL / SESSION_MESSAGE / CHILD_RESULT）。

## 目标

- 让手动 rename 成为**同步的本地 SQL 变更**，沿用现成的 `changeSessionModel` 范式
  （`AgentSessionPolicies`）：锁行、施加门禁、revision CAS、更新 `ma_session`、插入
  COMPLETED 幂等回执、追加公共事件、同步返回确认标题。
- 保留 journal 作为**执行侧标题副本**，通过**尽力通知**更新，复用现成的幂等
  `hosted-title:${revision}` 命令身份与 watermark。不新增任何 TS 或 SDK 行为。
- 删除投递 saga：后台协调器、parked-rename 证据、rename 投递 store 操作、生命周期/迁移
  标题投递门。
- 保持公共 OpenAPI rename 路由与 WebShell rename 契约不变
  （`sessionId`、`title`、`idempotencyKey` → `sessionId`、`title`、`replayed`）。

## 非目标

- 不改动自动命名、journal 记录格式、冷加载标题投影
  （`projectManagedSessionTitleInfo`）。
- 不新增 journal 到 SQL 的标题投影。SQL 是公共显示权威；journal 副本仅服务
  transcript/冷加载显示。
- 不改动其他操作类型对共享 `ma_operation` delivery 列的使用。
- 不改动 TypeScript journal authority、SDK 标题 API、Harness `/session/:id/title` 路由。

## 方案

### 同步结算

`renameSession` 保留现有受理（幂等回放、actor/role、可见性、worktree 就绪、标题校验），
以单个 store 调用 `settleRenameSync` 替换投递认领，仿照 `changeSessionModel`：

1. `requireLegacySessionForUpdate`（与生命周期受理共享的行锁）。
2. 读取 `title_revision`，自增，拒绝溢出。
3. 以 revision CAS 执行
   `UPDATE ma_session SET title = ?, title_revision = ?, version = version + 1`。
4. 以请求摘要插入 `SESSION_COMMAND` / `RENAME_SESSION` 回执为 COMPLETED；重复键回放
   已记录结果。
5. 追加现有 rename 变更事件，供其他客户端刷新。
6. 同步返回确认标题。

SQL 事务是唯一的持久化边界。没有 PENDING 命令、没有投递行、没有 claim、没有租约。

### 尽力 journal 通知

SQL 事务提交后，请求调用一次 `harness.rename(tenant, session, title, revision)`。
revision 即刚提交的 `title_revision`，因此 journal watermark 对并发与晚到通知的排序与今天
完全一致。

- 成功：journal 副本一致；无后续动作。
- 失败（Harness 不可用、generation 不匹配、journal 已封口、传输错误）：debug 日志，
  仍返回确认的 SQL 标题。journal 副本滞后，直到更晚的 rename 携带更高 revision。这与系统
  已容忍的 auto 标题分叉相同，只是方向相反。

通知刻意不由后台 worker 重试，也不与回执耦合。晚到通知若到达已关闭 Session，会在已封口的
journal 上失败；公共 SQL 标题已正确，因此该失败无害。

### 能力门

rename 不再因 Harness 不可用或未声明 title protocol version 1 而拒绝受理。SQL 变更对
授权调用者总是成功；通知仅在 Harness 支持 fenced titles 时发送，否则跳过（记日志）。这移除
了一个仅为保护双存储保证而存在的可用性耦合。

### 删除项

- `control-plane/.../session/SessionRenameCoordinator.java`（整类）。
- `control-plane/.../session/RenameEvidence.java`（整类）及其在 operation reconciler
  证据集中的注册。
- `OperationReconciler` / parked-operation 处理的 RENAME 分支。
- store 操作：`beginSessionRename`、`claimRename`、`markRenameSubmitted`、
  `completeSessionRename`、`abandonSessionRename`、`retryRename`、`deliverableRenames`、
  `renameAcceptance`、`settleParkedRename`，以及 `RenameDelivery` 模型。由
  `settleRenameSync` 取代。
- 阻塞于 pending rename 命令的生命周期受理门，以及统计未完成标题投递的 Workspace 迁移
  idle 门。
- `renameSession` 中的 `supportsFencedTitles` 受理拒绝（仅保留为通知前置条件）。

`title_revision` 保留（journal 排序）。共享 `ma_operation` delivery 列保留（其他类型在用）。
`harness.rename`、SDK API、TS 路由/watermark 保留。

## 设计决策与理由

- **SQL 是显示权威，journal 是副本。** 公共 list/get 读 SQL；让 SQL 成为权威即移除双写
  回执耦合。journal 保留标题，是因为 Harness 生产 auto 标题且冷加载投影要恢复它们——该角色
  不变。
- **尽力，而非至少一次。** 显示字段不配重试队列。现成 watermark 使任何更晚的通知收敛，
  丢失的通知只延迟 transcript 副本，绝不影响公共标题。
- **复用 `changeSessionModel`。** 它是本代码库已验证的同步幂等变更形状（行锁、revision
  CAS、COMPLETED 回执、公共事件）。与之对齐使 rename 与 model/approval 选择一致，新增代码
  最少。
- **保留 revision 与 journal 命令身份。** 它们已在执行侧提供排序与幂等；复用意味着 TS/SDK
  零改动、无新协议。

## 约束

- 模块政策：V1 schema 基线原地编辑；重建开发 catalog。本改动不删列也不加列，基线不变；
  仅 Java 行为变化。
- 公共 OpenAPI 文档、`SurfaceRegistry`、契约测试必须保持一致。rename 路由与响应形状不变，
  spec 不变；契约测试继续通过。
- SQL/事务改动需要 CI 的真实 MySQL 证据；H2 单测alone 不能确立事务行为。
- 改动 confined 于 `packages/managed-agent-server`（Java）。不触碰 `packages/core` 或其他
  core-gated TypeScript 路径。

## 风险

- **通知失败后的 journal 标题滞后。** transcript/冷加载副本显示旧标题，直到更晚的 rename。
  缓解：通知在请求内同步尝试，故滞后仅在 Harness 失败时发生；公共标题始终正确。鉴于系统已
  容忍 auto 标题分叉，此风险可接受。
- **升级时的在途投递。** 带有旧二进制 PENDING rename 投递的 catalog 不被本改动迁移。按当前
  fresh-schema alpha 政策，重建开发 catalog；携带活投递的部署须在切换前用旧二进制排空。
  发布说明中明示。
- **HTTP 200 双存储持久化保证的丧失。** 对显示字段明确降级；在此与 README rename 章节
  记录。
- **rename 不再建立 Harness boot 附着。** 旧 saga 为投递标题会附着 Harness
  （`createOrLoad`）并持久化 `harness_boot_id`；同步路径不会。因此一个被 rename 过的
  空输入 Session 经 `java_durable` 受理阶段关闭，而非 `harness_confirmed`，因为不存在
  可确认的持久 Harness 附着。close 仍会请求 Harness 关闭；仅受理阶段证据不同。这是应在
  PR 中明示的可见后果。

## 验证计划

- 聚焦 Java 单测（H2）：同步 rename 返回确认标题；同键回放返回原结果；同键不同内容冲突；
  并发 rename 自增 `title_revision` 且 journal 通知携带已提交 revision；通知失败仍返回 SQL
  标题且不创建投递或 parked operation；close/delete 不再被 rename 阻塞。
- 契约：`ManagedAgentApiContractTest` 与 `SurfaceRegistryGateTest`（路由不变）。
- 架构：删除协调器/证据类后的 ArchUnit 门。
- 真实 MySQL（CI `mysql-integration`）：并发下的结算事务与回执回放。
- TypeScript 回归：不变的 `/session/:id/title` 路由与 watermark
  （`hosted-harness-session` 测试）继续通过；预期无 TS 改动。
- 移除：rename 专属的投递/重投/parked-recovery 故障断言，它们不再描述该行为。

确切受影响的测试清单在实现计划中枚举。

## 验收标准

- 授权 rename 同步返回确认标题，无 PENDING operation、投递行、claim 或租约。
- 同键回放返回原结果；同键不同内容或不同 Session 冲突。
- 并发与晚到 journal 通知按已提交 revision 排序；更旧通知不能覆盖更新的 journal 标题。
- 失败或跳过的 journal 通知不使 rename 失败，也不调度后台重投。
- close、archive、delete、cwd 变更、Workspace 迁移不被 rename 阻塞。
- 不再存在后台 rename 协调器或 parked-rename 证据。
- 公共 OpenAPI 契约、WebShell 类型、SurfaceRegistry 不变。

## 开放问题

- 无阻塞项。执行侧消费者检查未发现模型上下文、子会话命名或自动化对父 journal 标题的依赖；
  若未来特性引入此类依赖，可将通知升级为有界至少一次重试，而无需恢复双存储回执 saga。
