# Workspace 会话归档、取消归档与关闭后删除（L1–L2）

[English](workspace-session-archive-delete-l1-l2.md) | [简体中文](workspace-session-archive-delete-l1-l2.zh-CN.md)

本设计保留 L1/L2 与可靠 close 的原有协议。新接纳的 ACTIVE files 会话 close/delete 采用 [L3 设计](workspace-session-active-delete-l3.zh-CN.md)：close 仅运行 SessionEnd，delete 顺序运行 SessionEnd 与 SessionDelete，先提交 Hook 证据再永久停机。CLOSED/ARCHIVED 的 L2 删除仍不依赖 Harness；升级前接纳的 operation 按原版本恢复。

## 1. 状态与基线

实现完成并已同步 main，2026-10-02，分支 `codex/workspace-session-l1-l2`。本文覆盖
[#13164](https://github.com/QwenLM/qwen-code/issues/13164) 的 L1、L2。
验证结果与环境限制记录在第 8 节。

本次集成的基线：

- [Workspace 可靠关闭，#13135](https://github.com/QwenLM/qwen-code/pull/13135)，
  合入提交 `9478f28731f45ff6df66062e7e05d29e92906f19`。
- [O4-1 会话退役，#13084](https://github.com/QwenLM/qwen-code/pull/13084)，
  合入提交 `e1167c1f9ca3d54747c8c0145c1d805259ab0226`。
- 既有 [D4 生命周期设计](https://github.com/QwenLM/qwen-code/blob/63e840cedf87fa54cf80c826112b8cc77272cff4/docs/design/2026-09-28-managed-agent-durable-lifecycle.md)
  与 [Workspace 关闭设计](https://github.com/QwenLM/qwen-code/blob/9478f28731f45ff6df66062e7e05d29e92906f19/docs/design/workspace-session-reliable-close.md)。

两个前置 PR 均已合入 main，本分支保留其最终的锁顺序、close 恢复及退役实现。
L1、L2 以 main 为目标；L2 使用实际退役而非占位步骤。
main 的后续 [#13223](https://github.com/QwenLM/qwen-code/pull/13223) 已解决
close 迁移与 recovery bundle V31 的冲突，本分支保留该修复。

## 2. 问题与现有行为

#13135 让空闲的 files profile Workspace 会话可以可靠关闭：永久 Broker
围栏阻止新的 warm 与执行，原资源完成结算，已完成的 CLOSE operation
证明会话进入 `CLOSED`。archive、unarchive、delete 仍然拒绝 Workspace 绑定。

D4 已提供多数所需行为：

- archive 在准入事务内完成 operation、状态变化与事件，HTTP 仍返回 `202`。
- delete 持久接纳 `DELETING`，随后由 coordinator 提交墓碑与完成的 operation。
  会话读取隐藏墓碑；operation 读取保留墓碑可见性，并重新检查当前 Workspace 读权限。
- 公开 unarchive 是同步返回会话的 `200` mutation。它恢复为 `CLOSED`，
  但命令存储键仅包含 tenant/operation/key，没有 actor 与 Session；
  准入与完成分属两个事务。WebShell 没有 unarchive 路由。
- #13135 的 coordinator 对所有绑定生命周期操作都会尝试 Workspace close，
  包括从 `CLOSED` 接纳的操作。只放开 delete 准入会重复清理，并依赖当前 Runtime 部署。
- O4-1 可以在墓碑事务内退役私有恢复与 publication 访问，不执行物理擦除。

## 3. 决策与范围

1. **仅接受已经可靠关闭的绑定会话。** L1 archive 要求 `CLOSED`，
   unarchive 要求 `ARCHIVED`，L2 delete 接受两者。新请求还必须找到同一 tenant、
   Session 的已完成 CLOSE operation，且 receipt 非空。这直接复用 #13135
   的完成证据，不新增回执、profile 列或 Broker 协议。证据缺失返回
   `409 workspace_unavailable`，单独一个状态值不能代替证明。
2. **当前具有读权限的创建者。** 沿用 #13135 的创建记录与读权限。
   可读非创建者返回 `403 session_operation_forbidden`；不可读或跨 tenant
   返回 `404 session_not_found`。Workspace 管理员删除与完整角色矩阵不在本片范围。
3. **元数据操作不受执行配置变化影响。** close 已完成后，L1/L2 无需已配置的
   Harness/RuntimeWarmer、当前执行挂载或 files 开关。新请求仍要求当前读权限；
   已准入的 delete 即使随后被撤销该权限，也继续完成。
4. **复用现有 store 与 coordinator。** archive/delete 沿用 D4 operation。
   绑定会话 unarchive 使用原子同步事务与现有命令表。不新增 operation kind、
   后台 worker 或公开响应类型族。
5. **退役属于删除事务。** L2 在墓碑完成事务内调用 O4-1 的真实退役屏障，
   不在删除后另行排队退役。
6. **范围限于 #13135 可达的会话。** 该基线只能可靠关闭
   `hosted-workspace-files/1`。L1/L2 不开放 Shell/MCP close，不删除活跃会话，
   不运行 Hook，不修改 cwd、不重新打开会话、不增加 UI 按钮，
   也不物理擦除历史、备份、Workspace 文件或 publication。

准入与 capability 投影都使用 completed-close 查询。查询必须限制在同一
tenant/Session，不能从 writer 租约过期、Runtime 缺失或 Harness `404` 推断完成。
归档、取消归档与删除后都保留 CLOSE 记录与永久 Broker 围栏。
未来若清理回执，必须先保存等价证据，才能移除这些记录。

## 4. HTTP、状态与权限契约

### 4.1 路由与结果

| 操作      | 公开路由                                         | WebShell 路由                                                | 结果                                                       |
| --------- | ------------------------------------------------ | ------------------------------------------------------------ | ---------------------------------------------------------- |
| Archive   | `POST /v1/agents/sessions/{sessionId}/archive`   | `POST /api/agent/web-shell/v1/sessions/archive`              | `202`，已完成的 command operation                          |
| Unarchive | `POST /v1/agents/sessions/{sessionId}/unarchive` | **新增：** `POST /api/agent/web-shell/v1/sessions/unarchive` | `200`，公开或 WebShell Session；`X-Qwen-Idempotent-Replay` |
| Delete    | `DELETE /v1/agents/sessions/{sessionId}`         | `POST /api/agent/web-shell/v1/sessions/delete`               | `202`，持久 command operation                              |

公开请求继续使用 `Idempotency-Key` 请求头。新增 WebShell 路由复用
`WebShellLifecycleRequest`（`sessionId`、`idempotencyKey`），
把同一服务结果投影为 `WebShellSession`，不在 adapter 中复制 mutation 逻辑。
共享内部 Session record 与 replay 标记，再分别使用两个入口已有的投影；
不要把已序列化的 PublicSession 转成 WebShellSession。
该路由属于 persisted-workspace 范围：解析已存储的 Session 绑定及 tenant/actor
权限，不能退回某个 live Runtime 或 primary Runtime。

| 绑定会话的新请求 | 要求的状态                      | 提交的状态与事件                                                                 |
| ---------------- | ------------------------------- | -------------------------------------------------------------------------------- |
| Archive          | `CLOSED`                        | `ARCHIVED`；一条带 `operationId` 的 `session.archived`                           |
| Unarchive        | `ARCHIVED`                      | `CLOSED`；在一个事务内写入 `session.unarchive.requested` 与 `session.unarchived` |
| Delete 准入      | `CLOSED` 或 `ARCHIVED`          | `DELETING`；一条 `session.delete.requested`                                      |
| Delete 完成      | `DELETING`，有效 delivery claim | 一起提交 `DELETED`、O4 退役、已完成 operation 与终止事件 `session.deleted`       |

不使用新的 `ARCHIVING` 中间状态，保留既有 legacy 恢复行为。
unarchive 绝不恢复为 `ACTIVE`，不解除 close 围栏，不启动 warm、获取 writer
或重新安装 Runtime。

### 4.2 准入顺序与重放

绑定 mutation 先校验 key、锁定公开 Session 行，在事务内重新核对当前读权限
和创建者身份，再执行：

1. 查找 actor/Session 隔离的幂等键，校验请求 digest。
2. 如果是重放，不再次改变状态或写事件。archive/delete 返回原 operation
   最新的持久状态，即使 Session 已经成为墓碑。
3. 如果是新请求，墓碑返回 `404 session_not_found`，不符合要求的源状态返回
   `409 session_state_conflict`。特别地，L2 即使没有活跃 Turn 也拒绝 `ACTIVE`，
   不隐式执行 close。
4. 检查未完成 mutation command 或 operation，包括 `RECOVERY_BLOCKED`，
   存在时返回 `409 session_operation_active`。
5. 要求 completed-close 证据，然后提交本片的 mutation。

读权限和创建者检查早于重放；旧 key 不能绕过授权。另一个 actor 使用同样的 key
是独立请求，不能重放创建者的结果；非创建者仍然被拒绝。
key 按字节区分，不 trim、不归一化大小写。digest 不匹配继续返回
`409 idempotency_conflict`。两个入口共享同一身份域。
保留既有的 1–128 个可见 ASCII（`0x21`–`0x7e`）校验：
公开入口的空白、控制字符或超长 key 返回 `400 invalid_idempotency_key`。
WebShell 保留既有请求校验：超长 key 返回 `400 invalid_request`，
空白和控制字符返回 `400 invalid_idempotency_key`。两个入口均不归一化 key。

operation 查询沿用 D4 的读取规则，不套用 mutation 的创建者规则：
当前有读权限的 actor 都可以读取已知 operation，包括删除后。
未知 operation ID 返回 `404 operation_not_found`。
读权限丢失会隐藏 operation，但不会取消已准入的清理。

### 4.3 Capability

增加可选的 `session_archive`、`session_unarchive`、`session_delete`，
以及 WebShell 对应的 `sessionArchive`、`sessionUnarchive`、`sessionDelete`。
缺失字段视为 false。L1 交付前两项，L2 在真实退役集成就绪后增加 delete；
不提前宣称下一片已可用。

对绑定会话，新字段要求 completed-close 证据。它们表达对该已结算会话的
保留管理支持，不表示创建者授权，也不表示当前状态允许执行某个具体动作。
因此，closed 会话的 archive 与 unarchive 支持都可以为 true，
但 unarchive 仍要求 `ARCHIVED`。没有 close 证据的活跃绑定会话为 false。
读取 capability 不需要挂载或 warm Runtime。对未绑定会话，
这些字段反映现有操作支持。

保留 #13135 的 `session_close` 语义以及绑定会话的 `session_lifecycle: false`。
L2 仍不支持活跃删除和其他 profile，打开聚合能力会夸大支持范围。
WebShell 的 planned 聚合字段保持原样。每片同步更新 canonical OpenAPI
描述并重新生成 WebShell 类型；旧客户端容忍新增可选字段。不要求 UI 集成。

## 5. L1 实现设计

### 5.1 Archive

在 #13135 绑定 close 准入旁扩展入口，明确选择 CLOSE 或 ARCHIVE。
保持 legacy 准入独立，复用现有插入与事件逻辑。close 保留原检查；
archive 使用第 4 节的已结算状态规则，不依赖 Runtime 支持检查。

持有 Session 锁时，archive 原子插入带 receipt 的已完成 ARCHIVE operation，
将 `CLOSED` 改为 `ARCHIVED`，并发出 `session.archived`。
它不派发 coordinator，也不调用 O4 retirement。
历史、Artifact、publication、备份引用和共享文件保留原有读取与保留语义。

### 5.2 绑定 Unarchive 的原子事务

新增一个仅用于绑定会话的事务 store 入口，例如 `unarchiveWorkspaceSession`，
由两个 HTTP adapter 共用。保持 legacy 未绑定会话的命令 namespace
和两阶段行为兼容。

复用 `managed_agent_command`，operation namespace 为
`UNARCHIVE_WORKSPACE_SESSION`，长度适配 32 字符列。
存储的幂等键使用现有 canonical `RequestDigests.digest`，输入为
`sessionId`、`actorDigest` 和原样的客户端 `idempotencyKey`；
tenant 已在主键内。71 字符的 `sha256:` 值适配 128 字符 key 列。
请求身份另用 `UNARCHIVE_SESSION` 的 lifecycle request digest 校验。
独立 namespace 避免与 legacy 原始 key 冲突，也不改变 rename。

通过授权、重放、状态、冲突和证据检查后，事务写入 completed command
（源状态记录为 `ARCHIVED`），将 Session 更新为 `CLOSED`，
并追加两条既有 unarchive 事件。事件 source key 包含新 namespace 和隔离后的 key。
不会提交一个可能因崩溃而滞留的 `PENDING` 区间。
应答丢失时重放已提交命令；提交前崩溃则不留下命令、事件或状态变化。

**对 #13164“原结果”验收的明确解释：** unarchive 重用原 mutation 的结果，
指的是不重复产生效果；响应返回当前可见的 Session，与现有公开响应契约一致。
不存储不可变的 Session 响应快照。如果另一个 key 再次归档会话，
重放旧 unarchive key 返回当前 archived 视图和为 true 的 replay 响应头，
不会再次取消归档。删除后返回 `404`，因为该响应是 Session 读取，
不是 operation 读取；返回 unarchive 重放前要检查墓碑可见性。
archive/delete 在墓碑上仍可重放 operation。
两个入口的测试与 OpenAPI 必须明确这一区别。

## 6. L2 实现设计

### 6.1 准入与派发

在同一绑定 lifecycle 入口中，仅对 `CLOSED` 或 `ARCHIVED` 开放 DELETE。
准入事务持久保存原状态、actor 隔离的 key 和 operation，设置 `DELETING`，
并追加 requested 事件。沿用 D4 异步 `202`、operation 查询与恢复扫描。

coordinator 为绑定 DELETE 增加一个窄分支：其持久化
`sessionStatusBefore` 为 `CLOSED` 或 `ARCHIVED` 时，直接进入 store
完成事务，传入 `harnessConfirmed = false`。
它不能调用 Harness close/detach、`requestWorkspaceClose`、
`closeWorkspace`、通用 drain、provider release 或 provisioning。
已完成的 CLOSE 是清理完成的依据，因此挂载撤销也不妨碍完成。
其他 operation 路径保留原行为。

沿用 #13135 的数据库时间 claim 过期、续租和 generation 校验。
普通事务或退役失败使用现有 backoff 重试。
L2 没有不确定的远端执行，也不会创建 blocked DELETE。
但旧 coordinator 仍可能把已准入 DELETE 搁置为 `RECOVERY_BLOCKED`。
scanner 与 claim 查询在原有 backoff 到期后重新领取 BLOCKED CLOSE，以及
从 CLOSED/ARCHIVED 准入的 DELETE；ACTIVE DELETE 仍保持 blocked。
新 coordinator 不调用 Runtime 即可完成这些已准入的关闭后删除，保留租约/generation 校验。
残留的 live writer 使退役失败，Session 保持 `DELETING` 等待重试；
L2 不终止该 writer，也不伪造完成证据。

### 6.2 原子完成与保留数据

在一个数据库事务内：

1. 按第 6.3 节获取 retirement 锁，再锁 Session 与 operation。
   预查询只能用于确定不可变的 operation kind，不能授权退役。
2. 等待锁之后，重新检查 `LEASED`、owner、claim generation
   及按数据库时间尚未过期的租约；检查 `DELETING` 与持久化的 L2 源状态。
   旧 claim 直接返回，不修改退役或墓碑。
3. 在同一组锁内调用 O4-1 retirement。它按数据库时间重新检查 journal writer，
   写入永久 Session 退役，将私有 journal 标记为 `DELETED`，
   将 `PINNED` publication 改为 `RETIRING`，抑制未完成的 tool-result 投影。
   严格保留 O4-1 的 recovery protection 和未解决的物理 PUT 证据。
   私有恢复非 READY 时记录 `recovery_protected = true`，不阻止墓碑；
   受保护字节继续不具备回收资格。
4. 将公开墓碑及时间戳、已完成 operation 及 receipt、终止事件 `session.deleted`
   与退役一起提交。事件通知发生在提交后。
   因为本次 delete 没有联系 Harness，其 `admission_stage` 保持 `java_durable`。

任一失败都回滚所有退役与完成写入。崩溃恢复时，要么发现尚未完成并重试，
要么发现已提交 operation 并重放。退役必须绑定本 operation，
不能静默复用另一个 operation 的退役。

删除后，包括 Artifact 在内的公开 Session 内容读取沿用墓碑 `404` 行为；
operation 在当前读权限约束下仍可读。
O4-1 阻止新的私有恢复与 publication 访问，并保留其有界的在途 reader
及未知 PUT 规则。L2 不承诺立即撤回已交付给 reader 的字节。
保留数据库行、备份字节、永久围栏与 operation，
不修改共享 Workspace 文件和其他 Session 的 holder。
O4-2 随后决定回收资格；L2 不运行 collector，也不承诺物理擦除。

### 6.3 协调前置改动的锁顺序

保留 main 已协调的顺序。writer acquisition 先锁 retention tenant，再锁公开
Session，最后锁 journal head。O4-1 删除与 tool-result 投影完成采用：

`retention tenant → journal head → publication 行（删除时排序）→ 公开 Session → operation/projection claim`。

共同的 retention tenant guard 让 writer acquisition 与删除/投影串行，
即使后续 public/head 的加锁顺序不同。保留 writer 在插入或更新 head 前对
非 `ACTIVE` 与已退役状态的拒绝。head 不存在时也由同一 tenant guard 串行化。
不能将公开 Session 锁移到 guard 前，也不能以旧前置快照覆盖 main 的最终 writer 顺序。

L1 archive/unarchive 与 delete 准入只按公开 Session、command/operation
的顺序加锁，不能随后再获取 retention 或 journal 锁。
close 证据查询是对终态 operation 的非锁定读取。
等待准入完成的 writer 看到已提交的非 ACTIVE 状态后拒绝获取。
claim 续租和重试只操作 operation，不能随后再获取 Session/journal 锁。
在前置改动集成后的 head 上重新核对该顺序，并在启用 L2 前用真实 MySQL 证明竞争行为。

## 7. 改动映射与发布

下表路径相对于仓库，描述已实现的修改，包括前置功能集成。

| 区域                                                                                                      | L1                                            | L2                                             |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------- |
| `.../service/SessionLifecycleService.java`                                                                | 绑定 archive 准入                             | 绑定 closed/archived delete 准入               |
| `.../service/ManagedAgentService.java`                                                                    | 绑定 unarchive、Session 投影与 capability     | Delete capability                              |
| `.../store/AgentStateStore.java`、`ManagedAgentStore.java`                                                | 绑定准入、原子 unarchive 入口、close 证据查询 | 关闭后删除门禁与集成后的 claim/retirement 完成 |
| `.../api/WebShellAgentController.java`、`ApiModels.java`                                                  | Unarchive adapter 与可选能力字段              | 可选 delete 字段                               |
| `.../service/SessionLifecycleCoordinator.java`                                                            | Archive 不派发                                | 仅对已准入的 L2 路径跳过资源清理               |
| `.../store/ManagedSessionStore.java`、`ToolPublicationRetentionStore.java`、`ManagedToolResultStore.java` | 不改 retirement                               | 协调 writer 锁顺序、复用退役、验证投影顺序     |
| `packages/sdk-java/managed-agent-server/src/main/resources/openapi/managed-agent-public-api.openapi.json` | 路由、重放、授权与 capability                 | 状态限制、退役与墓碑行为                       |
| `packages/web-shell/client/components/managed/generated/managed-agent-api.ts`                             | 重新生成可选字段与 unarchive 路由类型         | 重新生成 delete capability                     |

上表 Java 路径中的 `...` 前缀为
`packages/sdk-java/managed-agent-server/src/main/java/com/alibaba/qwen/code/managedagent`。
定向测试扩展既有 lifecycle、operation-store、API、retention 和 Hosted/MySQL 测试。
核对所有新 capability 的读取点，以及 adapter/service/store 的每个调用方；
不能留下只有声明却没有赋值的 flag 或 option。

L1/L2 除前置功能外不新增表或列。main 的 O4-1 retention 为 Flyway `V30`，
recovery bundle 为 `V31`，close 为 `V32`；#13223 已解决此前编号冲突。
本分支保留该修复，包括不变的 close SQL 字节及此前迁移。
测试覆盖新建 schema 与从 `V31` 升级。若部署环境曾应用前置分支的旧 close 编号，
必须显式协调迁移历史，不能静默改写已应用的迁移。
集成保留 #13135 的数据库时间租约过期检查，并在 operation 加锁后使用当前锁定读取。
评审集成后的行为，不能只解决文本冲突。

开放绑定 L2 准入前，先让所有 Managed Agent writer 与 lifecycle worker
运行兼容二进制并完成迁移协调。旧 #13135 coordinator 会对 L2 尝试 Runtime 清理，
缺少 Runtime close 支持时可能使操作保持 BLOCKED。升级后的 coordinator
会重新领取从 CLOSED/ARCHIVED 准入的删除，不再调用 Runtime。
采用协调发布或既有部署流量控制，不为此新增推测性的 feature flag。
保留旧未绑定会话的 key、迁移恢复和响应形状。

L1、L2 在以 main 为基线的分支上保留独立评审范围，close 与 O4-1 前置均已合入。
#13135 与 H2（#13129）之间 close→SessionDelete 的耦合仍需独立责任人修复或安排发布顺序；
这两个元数据操作不能解决该既有耦合。
通过真实 Shell API delete 触发 Shell publication 回收仍是 L4 的出口检查，
不能用 files profile 宣称 L2 已证明它。

## 8. 验证与验收

可执行计划与结果记录在
`.qwen/e2e-tests/workspace-session-archive-delete-l1-l2.md`。
全局 `qwen` CLI 没有 Hosted archive/unarchive/delete 命令，基线 dry-run
确认需使用真实 HTTP/store 测试脚本替代。这是 Hosted API 覆盖，不是 CLI 命令覆盖。

定向 Java API/store/coordinator 与 OpenAPI 契约测试覆盖两个入口、legacy 回归、
权限、close 证据、重放、无效 key 与执行支持移除后的元数据操作。
真实 MySQL 测试覆盖 unarchive 并发、mutation/completion 写入回滚、等锁后 claim
过期与第二实例接管、recovery 保护、ACL/配置撤销、有/无 journal head 时排队的
writer/投影完成、残留 writer 续租与 retirement 竞争，以及前置 schema 升级。
真实 HTTP probe 通过两个入口，并确认没有额外 Runtime 执行或清理调用。
构建、类型检查、打包与生成 WebShell 契约/client 测试通过。

等锁测试暴露前置完成逻辑的 repeatable-read 快照问题。operation 锁之后的租约查询
现使用 `FOR UPDATE`，等待期间发生的过期不能授权提交墓碑。
修正也适用于 close 完成，其定向回归通过。

作者的主机为 macOS，元数据测试使用确定性的 close 证据。
独立评审者 [wenshao 的 Linux 验证](https://github.com/QwenLM/qwen-code/pull/13194#issuecomment-5955445033)
针对 `2486d3dad`，补充了两个 API 入口上的真实 packaged Hosted Harness、worker 停止、
共享文件、邻居隔离和崩溃/接管证据。
固定提交的[装置与结果](https://github.com/wenshao/qwen-code/tree/ff11be0a23ada2f1bdf955ebafd463779aefb670/pr13194)
使用确定性模型及测试认证 adapter。该证据归属于评审者及该提交，
不能称为作者对最终 head 的重新运行。Windows、Shell/MCP profile、真实 OSS 回收与
物理擦除仍未被该报告覆盖。保留关闭围栏的证据是带 ACTIVE 邻居阳性对照的 warm 拒绝，
不能仅凭输入被拒推断。

| 分组            | 必需证据                                                                                                                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 两个入口        | 经 #13135 close 后执行 archive、unarchive，以及从 CLOSED/ARCHIVED delete；状态码、响应头、operation ID 和 camel/snake-case 投影正确                                                      |
| 授权            | 创建者且可读时成功；不可读、跨 tenant 返回 404；可读非创建者返回 403；重放和 operation 读取重新检查权限                                                                                  |
| 状态与证据      | 按约定拒绝 ACTIVE、CLOSING、DELETING 上的新元数据请求；手工构造且缺少 completed-close 证据的 CLOSED/ARCHIVED 被拒绝；未完成操作冲突                                                      |
| 幂等            | 同 key 并发仅一次；跨入口同 key 仅一次；actor/Session/kind 隔离；大小写不同的有效 key 分离；空白、控制字符和超长 key 原样拒绝、不 trim；无重复事件；store 层验证 digest 冲突             |
| Unarchive 重放  | 提交前崩溃、提交后应答丢失；再次归档后重放返回当前 ARCHIVED 且不改变它；墓碑后重放 404；无滞留 PENDING command                                                                           |
| 永久关闭        | archive/unarchive 后 input、新 writer、warm 仍被拒绝，原 close receipt/围栏保留；无 model、Hook、provider 或 Runtime 调用                                                                |
| 数据保留        | 原历史、Artifact、publication 在 L1 全程可读；L2 按契约拒绝公开/私有读取，同时保留字节、备份与共享文件                                                                                   |
| 删除原子性      | 每个 retirement/tombstone/operation/event 写入后注入失败，全部回滚；无 head/publication 的 Session 仍有永久屏障；残留 live writer 阻止完成；非 READY recovery 允许墓碑，同时保留回收保护 |
| Claim 与恢复    | 准入后、完成中崩溃；第二台服务接管；过期或旧 claim 不能退役；应答丢失重放 receipt；已准入删除在 ACL/mount 撤销且无 Runtime 支持时仍完成                                                  |
| 真实 MySQL 竞争 | writer acquire 对 close/L1/delete 准入及 delete 完成，分别覆盖 head 存在和不存在；writer renewal 对 retirement；投影完成对删除；迟到回调与重复 key；有界进展且退役后无新准入             |
| 回归与升级      | legacy 未绑定生命周期/重放不变；#13135 close 仍设置围栏并 drain；O4 writer/reader/PUT 保护保留；两个前置迁移可从新建和既有 schema 正常应用                                               |

行为使用定向 Java API/store/coordinator 测试验证；锁、租约时间和事务竞争使用真实 MySQL。
增加 packaged Harness 与真实 files Session 的 Hosted close→L1→L2 测试，
验证另一个 Session 的共享文件/holder 保持完整。
用一旦被调用就失败的 spy 断言 L1/L2 没有 Harness/Runtime 交互，
避免绿色测试隐藏了多余 teardown。
复用 #13135 的 worker-stop 证据，元数据事务无需新增物理 Linux 崩溃/停机声明。
交付实现时必须通过 build/typecheck 及受影响的 Java、生成契约测试。

验收要求两个 API 入口、明确的 unarchive 重放语义、L1 单事务 mutation、
L2 退役/墓碑原子完成、保留 close 围栏、正确授权，以及上述真实 MySQL 竞争。
H2 Hook、活跃删除、Shell/MCP 结算与物理回收既不能替代这些验收，
也不是这两个切片的前置条件。

## 9. 建议结论与剩余协调

对 #13164 的问题，本提案选择：Shell/MCP 留给 L4；L2 依赖 O4-1；
使用按操作的 capability；暂以当前有读权限的创建者作为 mutation 权限来源。
同时选择新增 WebShell unarchive 路由，以及返回当前 Session 的重放语义，
不存储响应快照。这些是设计建议，不代表 issue maintainer 已经接受。

实现时需重新检查前置 head、实际迁移编号，并协调独立的 H2/close 发布交互。
在上述选定方案下，无需额外产品决策即可进入 L1/L2 实现。
