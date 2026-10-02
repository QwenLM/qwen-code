# Managed Agent 持久生命周期（阶段 D4）

[English](2026-09-28-managed-agent-durable-lifecycle.md) | [简体中文](2026-09-28-managed-agent-durable-lifecycle.zh-CN.md)

状态：已在本次变更中实现
日期：2026-09-28
Issue：[#12867](https://github.com/QwenLM/qwen-code/issues/12867)，属于 [#12380](https://github.com/QwenLM/qwen-code/issues/12380)
基于：[API 契约（D1）](2026-09-27-managed-agent-api-contract.zh-CN.md)、[Session 查询（D2）](2026-09-27-managed-agent-session-query.zh-CN.md) 与 [事件回放（D3）](2026-09-27-managed-agent-event-replay.zh-CN.md)

## 1. 问题

[公共 API 契约][contract]第 10 节把 close、archive、delete 定义为各自独立的持久操作：每个都以 `202` 返回命令 operation，客户端可通过 operation 路由读回；archive 只接受已关闭的 Session；delete 保留共享 Workspace 并留下墓碑；close 与 delete 仍经过 Hooks 与资源结算，因此 `202` 从不表示工具已停止。D3 之后服务端与此不符：

- `archive` 与 `DELETE` 在请求内完成清理：关闭 Hosted Harness Session、排空 Runtime，并以 `200` 返回 Session 或 `DeletedSession`。Harness 或 Runtime 失败时，请求返回 `503`，Session 停在 `archiving` 或 `deleting`，留下一条只有用同一幂等键重试才能完成的待定命令。
- archive 自己关闭 Harness，因此接受活动 Session。没有 close 路由，没有 operation 路由，`DeletedSession` 没有 schema。
- 契约测试把这三处差异列为最后几行已知差异。

#12867 的验收条件是：这三行差异消失，生命周期路由改为 `implemented`，重放的幂等键返回原 operation，同键不同载荷则冲突。

## 2. 目标

- 在两个入口上把 close、archive、delete 作为持久操作提供，以 `202` 返回 `PublicCommandOperation` 或 `WebShellCommandOperation`。
- 在两个入口上提供 operation 查询，已删除的 Session 也能查。
- 在后台投递 close 与 delete，直到 Harness 关闭与 Runtime 排空成功，能经受 Harness 调用持续失败、单次尝试失败与 worker 丢失。
- 保持契约的幂等域：租户、Session、操作类型、actor 与幂等键。
- 升级时完成那些正在等待重试的 archive 与 delete。

## 3. 非目标

- 输入与取消的持久准入（`java_durable`，D7）、Actions（D6）与 Turn（D5）。operation 表与路由按 D7 可以增加类型的方式编写。
- 第 10 节的 reader、operator、owner 角色——其来源仍是 #12867 的待决问题（Q4）；以及 Workspace 绑定 Session 的生命周期操作，它们等待该问题的答复（4.9）。
- `archived_at` 与列表的 `include_archived`，仍为 `planned`。
- 清除已删除 Session 的内容，以及重试窗口过后清理墓碑与 operation。两者都属于保留策略的工作。
- `failed`、`cancelled` 与 `recovery_blocked` 结果。D4 的操作会一直重试直到完成（4.5）。

## 4. 决策

### 4.1 契约 v1.18

- `closeSession`、`archiveSession`、`deleteSession`、`getSessionCwdOperation`，以及 WebShell 的 `closeWebShellSession`、`archiveWebShellSession`、`deleteWebShellSession`、`webShellQueryCwdOperation` 改为 `implemented`。operation 路由虽然服务所有操作类型，但保留原 `operationId`，以免改动已发布的名字。
- 删除 `DeletedSession`：delete 返回命令 operation。
- 这些路由用到的 schema 去掉 `planned` 标记：`PublicCommandOperation`、`WebShellCommandOperation`、`PublicOperation`、`WebShellOperation`、`WebShellLifecycleRequest`、`WebShellOperationRequest`。除了只有任务取消才携带的 `task_id` 之外，还有三处仍为 `planned`：两个 operation 联合类型中的 cwd 成员（W2）、`action_resolution`（D6），以及没有任何生命周期操作会设置的 `failure_code`。因此生成的 WebShell 类型中 `WebShellOperation` 即 `WebShellCommandOperation`。
- `SessionCapabilities.session_lifecycle` 改为已实现：未绑定 Workspace 的 Session 为 `true`，绑定的为 `false`（4.9）。本次变更中 WebShell 的 capability 对象仍为 `planned`；阶段 H0c 的工作正在把它改为已实现。
- close、archive、delete、unarchive 与 operation 路由的描述写明下文的行为。已知差异文件不再有任何条目，其头部注释改为指向 #12867。

### 4.2 Session 状态

| 状态        | 含义                                                  |
| ----------- | ----------------------------------------------------- |
| `active`    | 接受输入。                                            |
| `closing`   | close 已受理；输入已封闭，close 正在投递。            |
| `closed`    | 没有 Harness 持有该 Session，其 Runtime 绑定已排空。  |
| `archived`  | 已关闭且已归档。                                      |
| `deleting`  | delete 已受理；输入已封闭，delete 正在投递。          |
| `deleted`   | 墓碑：Session 读取返回 `404`，其 operation 仍可读取。 |
| `archiving` | 仅用于本次变更之前受理的 archive（4.10）。            |

close 让 `active` 经 `closing` 变为 `closed`。archive 把 `closed` 变为 `archived`，unarchive 再改回来。delete 接受 `active`、`closed` 与 `archived`，经 `deleting` 变为墓碑。

新操作的返回：

- `404 session_not_found`：未知 Session、其他租户的 Session、actor 无读权限的绑定 Session，以及已删除的 Session；
- `409 session_state_conflict`：Session 不处于该操作接受的状态；
- `409 turn_active`：活动 Session 有已接受、运行中或取消中的 Turn，与之前的 archive、delete 一致；
- `409 session_operation_active`：已有其他 operation 未完成，或有待定的 rename、unarchive 命令；
- `409 workspace_unavailable`：actor 可读的绑定 Session。

### 4.3 operation 及其幂等域

Flyway V17 新增 `managed_agent_operation`。每行保存 operation 所属的 Session、id（`op_` 加 32 位十六进制）、类型、actor 摘要、幂等键与请求摘要，它的状态、准入阶段与投递状态，受理时的 Session 状态，回执，以及投递用的租约、认领代次、尝试次数与 `available_at` 时间。

该表在租户、Session、类型、actor 摘要与幂等键上唯一，也就是契约第 3 节规定的幂等域。actor 摘要是可信 actor ID 的 SHA-256 摘要，没有可信 actor 的请求为空串，因此其他 actor 使用同一个键是另一个请求，永远不会拿到前一个 actor 的 operation。请求摘要覆盖 Session 与类型，并沿用 archive、delete 以前的命令名（`ARCHIVE_SESSION`、`DELETE_SESSION`，以及 `CLOSE_SESSION`），因此迁移过来的命令被重试时仍能匹配（4.10）。

生命周期请求除 Session 与类型之外不携带任何内容，而这两者都属于幂等域。因此"同键不同载荷"不会发生：同一个键会重放；同一个键用于其他 Session、其他类型或来自其他 actor，则是另一个请求。存储的摘要仍会比较，不一致时返回 `409 idempotency_conflict`；只有存储测试能构造出这种情况。

重放返回 `202`、operation 最新的持久状态以及 `replayed: true`，Session 被删除之后也是如此。

### 4.4 受理

一个事务先锁住 Session 行，然后查找幂等键、拒绝墓碑上的新键、检查是否有未完成的 operation、检查状态与 Turn、插入 operation、把 Session 封闭为 `closing` 或 `deleting`，并追加 `session.close.requested` 或 `session.delete.requested`。operation 的事件都携带其 `operationId`。

archive 只需要 Java 这一个权威，因此在同一个事务里完成：Session 变为 `archived`，operation 带回执完成，并追加 `session.archived`。archive 不再追加 `requested` 事件。

事务提交后，服务立即把 close 或 delete 交给 worker。worker 的扫描无论如何都会找到它，因此两步之间崩溃也不会丢失。

### 4.5 投递

`SessionLifecycleCoordinator` 投递 close 或 delete：

1. 以 `dispatch.lease-duration`（60 秒）的租约和新的认领代次认领 operation。它的扫描每隔 `dispatch.scan-delay` 运行一次，认领 `available_at` 已到的待定 operation，以及租约已过期的已认领 operation。
2. 如果 operation 是在活动 Session 上受理的，就在 Hosted Harness 中关闭该 Session。这就是 archive 与 delete 以前使用的结算：Harness 封存该 Session 的 journal writer 并停止其事件流。Hosted 配置目前不运行任何 Session Hooks，D4 也不新增。Harness 对它没有持有的 Session 返回 `404`。没有配置 Harness 的服务器会跳过从未被任何 Harness 持有的 Session 的关闭；对曾被 Harness 持有的 Session，则让本次尝试失败。随后，不得有任何 writer 以数据库时间尚未超过的租约持有该 Session 的 journal：持有 Session 的 Harness 会续约该租约，并在关闭 Session 时封存 writer。因此另一台服务器的 Harness 返回的 `404` 不会让 close 完成；在持有该 Session 的 Harness 所在的服务器认领该 operation 之前，或在该租约过期之前，每次尝试都会失败。
3. 排空该 Session 的 Runtime 绑定。内嵌的 Runtime Broker 只是不再预热该 Session，目前还没有 Harness 级别的回收。
4. 在一个锁住 Session 行的事务中，确认自己的认领仍然有效，完成 operation，把 Session 设为 `closed` 或墓碑，并追加 `session.closed` 或终态的 `session.deleted`。

失败的尝试让 operation 回到待定状态并计数，退避沿用 dispatch 设置：从 `dispatch.retry-initial-delay` 起翻倍，直到 `dispatch.retry-max-delay`。没有最后一次尝试：operation 只有在各步骤成功之后才会完成，因此 `202` 从不表示工具已停止；Harness 调用持续失败时，operation 保持 `running`。Hosted Harness 重启之后，Java 连接器仍沿用之前的 boot，因此它的调用会以 generation 错误失败，直到 Java 也重启为止，与 Turn 分发的情况相同；期间 operation 一直等待，之后还要等旧进程的 writer 租约过期。

停止写入该 Session journal 的 Harness 同样无法关闭它。任何一次 journal 提交失败之后（例如在 Java 或其数据库不可用时发生的提交），Harness 会拒绝该 Session 之后的所有提交；而它的关闭要先记录其 activation 已结束，因此它对每次尝试都返回 `503`。它的 writer 租约可能仍然有效，因为 writer 自己的续约还在继续，所以其他服务器也无法完成这个 close；operation 一直保持 `running`，直到该 Harness 重启，并且如上所述 Java 也要随之重启。只有该租约也过期后，另一台服务器的 Harness 才能完成它（第 2 步）。D4 不会在没有 Harness 的情况下完成这样的 close：[契约][contract]第 10 节让 close 与 delete 仍经过既有的 Hooks 与资源结算，而只有 Harness 能报告它的 Session 已结算。

两个步骤都是幂等的，因此重复的尝试是安全的。租约与 Turn 租约一样使用各服务器自己的时钟，而不是[契约收敛][closure]第 1 节要求的数据库时间，并且不续约。在默认租约（60 秒）与 Harness 请求超时（30 秒）下，同一服务器上的尝试只有在 worker 丢失后才会重叠；但时钟偏差、更短的租约或较慢的首次连接也可能让尝试重叠。认领代次让过期的尝试无法完成，重复的关闭也不会造成影响。

delete 不动共享 Workspace：worker 只关闭该 Session 并排空它自己的 Runtime 绑定。

### 4.6 operation 字段

| 字段              | 取值                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `status`          | 受理时为 `pending`，首次认领起为 `running`，结束时为 `completed`。                           |
| `admission_stage` | `java_durable`；完成时，如果持有该 Session 的 Harness 确认了关闭，则为 `harness_confirmed`。 |
| `delivery_state`  | 两次尝试之间为 `pending`，尝试期间为 `leased`，完成时为 `confirmed`。                        |
| `receipt_id`      | operation 完成时由 Java 签发的不透明回执 `rcpt_…`。                                          |

持有该 Session 的 Harness，是该 Session 所记录的 boot ID 对应的那个 Harness：Turn 分发会记录它挂接的 boot，而 rename 只在尚未记录任何 boot 时才记录，因此只经过 rename 之后，记录可能是较旧的 boot，这时 close 虽已封存，仍报告为 `java_durable`。新的 archive、删除已关闭或已归档的 Session，以及关闭或删除从未被任何 Harness 持有的 Session，完成时都保持 `java_durable`：没有任何 Harness 确认过该 Session 的任何事。Harness 因重启被替换的 Session 同样如此：新的 Harness 回答它没有持有该 Session，operation 要等旧进程的 writer 租约过期之后才完成，而那个 writer 没有被封存。V17 之前受理、迁移过来的 archive 是在活动 Session 上受理的，因此它会先关闭该 Session，可能以 `harness_confirmed` 完成（4.10）。不会产生 `failure_code`、`blocked`，以及 `failed`、`cancelled`、`recovery_blocked` 状态。

### 4.7 读取 operation

`GET operations/{operationId}` 与 WebShell `operations/query` 与其他读取一样检查租户与 Workspace 读权限，但它们也能找到已删除的 Session，因此墓碑的 operation 仍可读取。未知 operation 返回 `404 operation_not_found`。读取不是重放，因此返回 `replayed: false`。目前没有任何东西清理 operation 或墓碑，因此它们至少在契约的重试窗口（24 小时）内保持可读。

### 4.8 unarchive 与 rename

unarchive 仍是以 `200` 返回 Session 的同步变更，仍为 `partial`。它恢复为 `closed`，因为已归档的 Session 先被关闭过；契约中没有重新打开已关闭 Session 的操作。它不再解除 Runtime 排空，因此 `RuntimeWarmer.resume` 被删除。rename 不变，只接受活动 Session。待定的 rename 或 unarchive 命令与未完成的 operation 互相阻塞。

### 4.9 角色与绑定 Workspace 的 Session

角色矩阵等待 #12867 Q4 的答复。本次变更保留现有检查，并把 actor 加入幂等域：

- 未绑定 Workspace 的 Session 按租户划定范围，与它的其他路由相同。
- 绑定的 Session 需要 actor 的读权限，否则返回 `404`。在角色来源决定谁可以关闭或删除它之前，它的生命周期操作返回 `409 workspace_unavailable`，与它的 rename 和输入一致。它的 `session_lifecycle` 为 `false`。
- 唯一的 `403` 来自租户过滤器的 `actor_scope_mismatch`。

### 4.10 升级

V17 把每条待定的 `ARCHIVE_SESSION` 与 `DELETE_SESSION` 命令转换为待定 operation，沿用其幂等键与摘要，actor 摘要为空，受理状态取命令记录的 Session 状态，并把该命令标记为 `MIGRATED`。worker 会完成它们。在活动 Session 上受理的 archive 会像以前的 archive 一样先关闭该 Session，再把它设为 `archived`。迁移过来的 operation 没有 actor，因此只有不带可信 actor 用原幂等键重试才会重放它。带可信 actor 的重试是新请求，会遇到未完成的 operation（`409 session_operation_active`），或在其完成之后遇到新的状态。

已完成的命令不转换。重试它们会得到新的受理：重复的 archive 返回 `409 session_state_conflict`，重复的 delete 返回 `404`。升级前已归档的 Session 视为已关闭。

不支持新旧版本混跑的滚动升级：V17 运行之前必须停掉所有旧版本服务器。升级之后由旧服务器留下的待定 archive 或 delete 不会被转换，它的待定命令会让该 Session 之后的所有生命周期变更都返回 `409 session_operation_active`；旧服务器的 unarchive 还会重新打开被 D4 关闭的 Session。

W0e（#12839）先占用了 V16，因此本迁移为 V17，即 `main` 上下一个空闲版本号。使用 V17 或更高版本的未合并 PR 必须重新编号到它之后；如果改为留出空号，已经应用了更高版本的数据库会被 Flyway 拒绝启动。
本分支的 O2 publication 迁移接续使用 V18 和 V19。升级测试按此顺序应用迁移后再启动服务。两个迁移目录之间的版本号唯一性由 `scripts/check-flyway-migrations.js` 在不依赖数据库的情况下强制校验，它在 SDK Java workflow 的每个 pull request 与 push 上运行（#12940）。

## 5. 测试

- **契约测试。** 场景对活动 Session 做 archive（`409`），在 Harness 让每次关闭都失败时关闭一个 Session 并读到 `closing` 与 `running`，在该 close 期间试探 delete（`409`），等 close 完成后重放幂等键（同一个 operation、`replayed: true`、`harness_confirmed`），再 archive、unarchive 回 `closed` 并删除。WebShell 一侧对另一个 Session 做 close、查询、archive 与 delete。每个路由都覆盖 `400`、`403` 与 `404`，两个 operation 读取都以 `400` 拒绝过长的 operation id，读取已删除 Session 的 operation，墓碑上的新幂等键返回 `404`。场景覆盖了所有非 `planned` 的操作。
- **生命周期测试。** 十一个场景：Harness 让每次关闭都失败时一直等待的 close；一次失败的 Harness 关闭和多次失败的排空，完成前必须重试，期间拒绝输入；在配置与未配置 Harness 时分别关闭从未被任何 Harness 持有的 Session；因重启被替换的 Harness，其回答不构成确认；另一台服务器的 Harness 持有 journal writer 时一直等待、并在该 writer 被封存后以 `java_durable` 完成的 close，以及一直等到被遗弃的 writer 租约过期的 close；一个丢失的 worker，其租约过期后由另一个 worker 完成 operation；跨两个入口的重放，以及对其他 Session、类型或 actor 各自独立的 operation；与待定 rename 之间一次只允许一个生命周期变更；一次只排空自己 Session 的 delete，之后另一个 Session 运行它的第一个 Turn；以及绑定的 Session。
- **存储测试。** 使用由测试推进的时钟且没有 worker 扫描时：operation 只有在到期或租约过期时才能被认领；同一 worker 再次认领之后，它较早的认领既不能完成也不能重试；重试会等到 `available_at`。以另一个摘要重用的幂等键会冲突。
- **迁移测试。** 在 H2 上，V15 时写入的待定 archive 与 delete 命令变为 operation，重试 archive 的幂等键会重放，worker 会完成两者。
- **MySQL 测试。** 同样的升级在已有的升级测试中运行；新增的测试在真实数据库上受理、重放、认领、防护并完成 operation，并验证 journal writer 在被封存或按数据库时间租约过期之前都被视为仍持有。
- **Hosted 进程测试。** `HostedHarnessMySqlIT` 中新增的第二个测试以打包后的 Hosted Harness 与 MySQL 运行 Spring。Session 的第一个 Turn 通过公共 API 完成；close 只有在 Harness 封存该 Session 的 journal writer 之后才以 `harness_confirmed` 完成，随后 delete 完成并留下墓碑。
- 集成测试中的生命周期测试改为先 close 再 archive；WebShell 类型已重新生成。

## 6. 兼容性

- archive 与 delete 以 `202` 返回命令 operation，而不是以 `200` 返回 Session 或 `DeletedSession`；它们不再发送 `X-Qwen-Idempotent-Replay`，由响应体的 `replayed` 代替。
- archive 要求 Session 已关闭，因此客户端需要先 close。unarchive 恢复为 `closed` 而不是 `active`。
- 在其他 Session 上重用的幂等键是新请求，而不再返回 `409 idempotency_conflict`；其他 actor 重用的幂等键也是新请求，而不再重放前一个 actor 的结果。
- 新路由：两个入口上的 close 与 operation 查询，以及 WebShell 入口上的 archive 与 delete。
- 新事件：`session.close.requested` 与 `session.closed`。archive 不再追加 `session.archive.requested`，close、archive 与 delete 的事件携带各自的 `operationId`。
- 公共 Session 新增 `capabilities.session_lifecycle`。
- 生成的 WebShell 类型新增生命周期请求与 operation。
- Flyway V17 新增一张表并转换待定命令，不改动其他行。

## 7. 验证

- Managed Agent 服务的 `mvn test`（151 个测试）与 Checkstyle 通过。
- `ManagedAgentMySqlIT` 在 CI 使用的 `mariadb:10.11.18` 与 `mysql:8.4` 上通过，包括 V17 升级。`HostedHarnessMySqlIT` 在 `mysql:8.4` 上以打包后的 CLI 通过。
- 本分支版本顺延后，H2 定向迁移及 publication 测试 24/24 通过。在全新 MySQL 8.4 schema 上，`ManagedAgentMySqlIT` 11/11 通过，V16–V19 依序成功应用；组合顺序的 MariaDB 验证仍待 CI。
- Web Shell 的 managed 组件测试（73 个，含生成类型的新鲜度测试）与其类型检查通过。
- 27 个变异各自让某个测试失败：受理时不封闭 Session；跳过 Harness 关闭或 Runtime 排空；在没有 Harness 的服务器上跳过曾被持有的 Session 的关闭，或删除活动 Session 时跳过关闭；在仍有 journal writer 持有 Session 时完成，或把已过期的 writer 租约当作仍有效；完成时不检查认领代次；失败的尝试保留租约；扫描忽略已过期的租约；跨 actor 或跨类型重放；归档活动 Session；有活动 Turn 时关闭；在墓碑上受理；隐藏墓碑的 operation；公共路由接受过长的 operation id；忽略待定命令或未完成的 operation；绑定的 Session 声明生命周期能力；把每次完成、任何回答或被替换的 Harness 的回答都当作确认；unarchive 重新打开 Session；V17 让命令保持待定或转换已完成的命令；以及改用新的摘要名称。跳过 Harness 关闭同样会让 Hosted 进程测试失败。

## 8. 后续工作

- 角色（Q4），以及随之而来的绑定 Workspace 的 Session 的生命周期操作，和可读但不可操作时的 `403`。
- `archived_at` 与 `include_archived`。
- 重试窗口过后清理墓碑与 operation、清除已删除 Session 的内容，以及无法推进的 operation 的 `recovery_blocked` 结果。
- D7 把其输入与取消 operation 加入同一张表与路由。
- 不重启 Java 也能重新连接重启后的 Hosted Harness，Turn 分发同样需要这一点。
- 让 journal 写入因失败而停止的 Harness 仍能封存其 writer 并释放该 Session，使 close 能够完成结算（4.5）。
- 使用数据库时间并续约的租约，即契约收敛第 1 节对持久投递的要求。
- WebShell 的 capability 对象实现后提供 `sessionLifecycle`。

[contract]: https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-api-contract.md
[closure]: https://github.com/doudouOUC/code_agent/blob/689121646cc25ca08a34508a5f5555ae15308833/qwen-code/feature/managed-agents/managed-agent-contract-closure.md
