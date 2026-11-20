# Managed 控制面 wake：seal 时写入的 wake 戳

[English](2026-11-19-managed-control-plane-wake-seal-stamp.md) | [简体中文](2026-11-19-managed-control-plane-wake-seal-stamp.zh-CN.md)

状态：已接受，实现中。日期：2026-11-19。本文是 [Phase 3 控制面 wake 设计](2026-11-19-managed-control-plane-wake.zh-CN.md)（#17805）的补充设计，基于 `main` 的 `adca3e7ddc` 核对。它把该设计的 3a wake 调度机制——提交路径维护的 head 到期提示、独立的到期分发器、以及控制面对未尝试证明的冷态重导——替换为挂起中的 writer 在 seal 时写入的一个戳。它不改变 3b、纯被动的 wake 动词、§4.3 的 seal 时未尝试证明，也不改变加载计数不变量。§5 列出它取代的全部父设计章节。

## 1. 问题

父设计的 3a 机制有三处缺陷，前两处已在 H2 上针对生产类 `JdbcWakeRecoveryStore` 复现（Java wake 相关文件在被测提交 `4ed278b37c` 与 `adca3e7ddc` 之间没有变化；H2 不能代表 MySQL 行为）：

1. **兜底在每个认领周期都重新证明每个已挂起的远期 head。** 一个只剩远期 loop wakeup 待处理的已挂起 head 会保持 `is_wake_pending = 1`（接受时 OR 写入，`JournalCommit.java:263`；只要还有 deferred 输入就从不清除，`JdbcWakeRecoveryStore.java:253-262`），因此一直留在 `findPending` 里（`:98`），每当 30 s 认领延迟过去就被重新认领（`:123`）。今天完整的 deferred 证明被缓存，重新认领不读任何 journal。父设计「完整的仅未来证明不入缓存」的规则（§4.1）让每次重新认领都变成一次完整重放。复现：一个已 seal 的远期 head，journal 10 笔事务，5 个认领周期——5/5 次被选中并认领，从未加载；用今天的缓存共读 journal 10 次，按父设计规则对这个 head 的含义、即每个周期都不带缓存证明开始时共读 50 次。3a 让这类 head 成为常态；成本随已挂起的 deferred Session 数乘以其 journal 长度增长，并且这些 head 会占用兜底每次 8 个候选的页。
2. **完整仅未来证明不入缓存，消除不了长 journal 的饿死。** 超过单次 32 笔事务证明预算的 journal 会留下部分证明，它仍然入缓存，并在其触发时间之前一直可续读（`canResume`，`:296`），所以缓存满分支（`:275-291`）仍然拒绝缓存到期 Session 的证明。复现：128 个远期 head、journal 各 40 笔事务，各扫描一次；随后一个 journal 为 40 笔事务的到期 Session 被 poll 5 次，共读 5 × 32 笔事务，每次都从 revision 0 重新开始，始终读不到第 40 笔。按父设计规则，占位者只有在下一次 poll 把它读完时才释放槽位，再下一次 poll 又重新占住；饿死变成了槽位反复占用和释放，而没有消失。
3. **冷态未尝试证明并不便宜。** 父设计 §4.6 让控制面按每个 pending 输入重导是否存在 transcript 尝试。尝试标记是每条消息正文里的 `daemonPromptId`；`message.committed` 的 payload 只有 `messageId`、`role`、`contentRef`、`modelAttemptId`、`parentMessageId` 和 `diagnosticsRef`（`managed-session-records.ts:965-975`），所以 Java 必须重放 journal 并读取每条消息正文，就像 `JdbcManagedToolDetailsStore.java:109` 为单个 prompt 所做的那样。恢复视图支撑每一次普通 Session 读取（[恢复视图补充设计](2026-11-18-managed-suspension-recovery-view.zh-CN.md) §1），所以这项成本落在读路径上。

## 2. 让更简单机制足够的事实

每次 journal 提交都要求 writer 在线（`JournalCommit.java:121`），输入经由 Harness authority 接受（`submitInput`）。因此无主 head 的 pending 集在再次获取 writer 之前不可能变化：正常挂起时的 pending 情况在下一次获取之前一直精确。

挂起中的 Harness 已经持有完整的已提交前缀，也已经算出控制面需要的两项事实：wake 泵的挑选逻辑（`hosted-harness-session.ts:7729-7817`）给出可投递的 wake 输入——wake 来源、排除已停止 run 的消息——中当前到期的输入和最早的 deferred `notBefore`；父设计 §4.3 的 seal 时检查证明每个 pending wake 输入都未被尝试（`wakeHasPriorAttempt`，即 `:4876-4893` 处的所有权释放谓词）。正如父设计 §1.1 所说，常驻的只有时钟。writer 可以在 seal 中把它持久化，控制面既不需要提交路径上的提示，也不需要重导。

## 3. 机制

### 3.1 一个 head 列，两次受 writer 围栏保护的写入

`ma_session_head` 新增一个可空列 `wake_seal_revision`：一次正常挂起 seal 该 head 并认证其 wake 投影时的 journal revision。

- **获取 writer。** 递增 generation 的 writer 获取（`JournalWriterLifecycle.java:288`）同时写入 `wake_seal_revision = NULL`，并把 `wake_retry_at` 上限压到「当前时间加一个认领延迟」（`LEAST(wake_retry_at, NOW + RETRY_MS)`）。任何新 writer——一次 wake、一次用户请求、一次随后拒载的加载——都会使之前的戳失效。这个上限去掉已写入的远期到期时间，因此一个 writer 接受了立即输入后崩溃时，兜底按今天的节奏恢复它；它从不降低认领刚设置的延迟，因此一次持续拒载的加载仍按认领节奏重试，而不是每次扫描都重试。
- **挂起 seal。** `/writers:seal`（`http-managed-session-store.ts:2947`；`SealWriterRequest`，`ManagedSessionStoreModels.java:164`）新增可选的 `wake` 对象 `{revision, pending, dueAt}`，只有挂起 teardown 发送（`hosted-harness-session.ts:5124`）。Harness 在 seal 之前立即在已提交前缀上重新计算泵会挑选的内容：`pending` 表示是否还有可投递的 wake 输入；有当前到期的输入时 `dueAt` 为 `0`，否则为最早的 deferred `notBefore`。seal 的 UPDATE（`JournalWriterLifecycle.java:399`）已经受 writer token 与 generation 围栏保护，另外要求 `journal_revision = revision`，并写入 `wake_seal_revision = revision`、`is_wake_pending = pending`、`wake_head_revision = revision`，有 pending 时再写入 `wake_retry_at = dueAt`。`revision` 由 Harness 的 store 客户端从它的 writer grant 中填入。revision 不一致时 seal 被拒绝（`409 managed_session_wake_stamp_stale`）；teardown 把它当作失败的步骤，每次精确重试都重新计算戳，并在现有上限处升级。
- 其他所有 seal——拒载时的 `managed.close()`、裸 `writers:seal`、所有权释放——都不发送戳，而它们之前的 writer 获取已经清掉了任何更早的戳。

这个戳是权威的：它由写 journal 的同一个 authority、基于完整前缀、在 head 锁下、于精确的 revision 写入；它不会过时，因为在下一次获取清掉它之前没有任何提交。

### 3.2 到期分发就是现有的兜底

兜底已经在无主 head 上选择 `is_wake_scan_pending AND wake_retry_at <= NOW`，按 `wake_retry_at` 排序，由 `idx_ma_head_wake (is_wake_scan_pending, wake_retry_at, …)` 支撑（`V1__managed_schema.sql:224,1474`）。写入戳之后，没有 pending 的 head 离开扫描集合；最早输入为 deferred 的 head 在 `dueAt` 之前不可见；有排队输入的 head 在下一次扫描时被选中。

`WakeRecovery.scan`（`WakeRecovery.java:39-70`）增加一个分支：认领成功后，`wake_seal_revision` 等于其 journal revision 的候选跳过 `hasPendingInput`——戳已经证明该 revision 上有一个到期的可投递输入——直接进入现有的父 run 检查和被动 `recoverForWake`。没有戳的 head（writer 崩溃、拒载）保持现有证明路径不变。

相对父设计，这去掉了：`wake_due_at` 列；提交路径上的提示维护（null 安全的 `LEAST`、「pending 但到期时间未知」状态及其修复趟）；四种结果的证明；独立的 `WakeDispatchJob` 及其认领；以及对证明缓存的任何改动。带戳的 head 从不进入缓存，在到期前和到期时都不会被重放，所以父设计 §5.1 关于按输入索引的问题不再出现。从到期到加载的延迟以兜底扫描周期（`qwen.managed-agent.wake-recovery.scan-delay`，默认 2 s）加上加载本身为界；暂时性的加载拒绝在认领延迟（`RETRY_MS`，30 s）之后重试。§6 测量这两项。

崩溃路径不在范围内，保持不变：writer 崩溃留下的、只剩远期输入的无戳 head，继续以今天的方式每 30 s 针对已缓存的 deferred 证明重新认领，这类 head 原有的缓存压力维持 `main` 上的现状。父设计的不入缓存规则被撤回，因为在这条路径上它会把每次重新认领变成一次完整重放（§1 第 1 项）。

### 3.3 恢复视图

`ready` 分支在 `wakeProven`（`SessionRecoveryService.java:147`）之外新增接受 `wake_seal_revision == journal_revision`；其他守卫保持不变：writer 已 seal、activation 已释放、activation 投影为当前、无未结算工作。保留 `wakeProven` 是因为没有该能力的 Harness 不发送戳，否则它的正常挂起将不再报告 `ready`；对带 pending 输入的 head，`wakeProven` 仍不可能成立，所以带戳的 pending head 只能经由戳变为 `ready`。

戳这一分支没有 session 种类或压缩方面的守卫，因此它把 `ready` 扩展到了基于扫描的证明所不覆盖的范围（恢复视图补充设计 §3）：带戳的子 Session 与公开 Session 一样报告 `ready`。这一扩展是有意的，因为 writer 的认证不依赖扫描资格。压缩只在已删除的 head 上运行，所以对 `ACTIVE` Session 而言，压缩过的 journal 不会走到这一分支。

只有正常挂起会写入这个戳，并且是在按输入的未尝试证明之后；每次获取都会清掉它，所以拒载的 seal 永远无法继承更早的戳；任何提交都会改变 `journal_revision`。这正是恢复视图补充设计 §2 要求的正向证明，只读一个列，读路径上没有 journal 重放，也没有消息正文读取。附带效果：没有 pending 的挂起在 seal 之后立即报告 `ready`，而不必等兜底下一次证明。

### 3.4 transport 通知

父设计 §4.2 的到期复核保留，改为 wake 围栏中的一个 head 列条件（`TransportWakeActivator.java:125-139`）：满足 `wake_seal_revision = journal_revision AND (is_wake_pending = 0 OR wake_retry_at > NOW)` 的 head，要么没有可投递的输入，要么其下一次尝试已由兜底在 `wake_retry_at` 负责，所以丢弃该通知（`NOT_DUE`）。由于戳认证的是整个投影，`is_wake_pending = 0` 这一分支与未来到期分支同样安全，它覆盖的是延迟到 seal 之后才到达、而对应输入已经结算的通知。到期的带戳 head 收到通知时仍通过现有的 `activateForWake` 加载；把 transport 改为被动动词不属于这一批改动。

### 3.5 发布

只有当控制面公告 wake-dispatch 能力（`qwen.managed-agent.wake-dispatch.enabled`，默认关闭；沿用父设计的配置键）时，Harness 才放宽 `pendingInputs` 门（父设计 §4.3）并发送戳；控制面只在兜底运行的地方公告该能力。公告方式是在 `writers:acquire` 和 `writers:renew` 返回的 writer grant 中带上 `wakeDispatch: true`，与 `activationLeaseRenewal` 并列：签发 grant 的 Store 正是消费戳的 Store，兜底在该 Store 启用的地方都会运行，旧版 Harness 会忽略这个字段。放宽后的门只放行延后到期且未尝试过的 wake 输入：不归 wake 所有、或已有 transcript 尝试的输入保留其现有的恢复职责（与所有权释放使用的判断相同）；已到期的输入应由泵立即执行；已停止 run 的消息输入要等 relay 的停止来结算，而停止标记不是持久化的。因此 §7 中第 (c)、(d) 项那样的到期戳或停止消息戳，只会来自在门的最后一次检查与 seal 之间提交的输入。关闭它会停止新的放宽挂起；已带戳的 head 仍由兜底在到期时投递，没有 §3.2 分支的控制面则通过普通证明投递它们。因此 3a 不需要回滚排序；父设计的生产者/消费者排序只适用于 3b 的 staging。

## 4. 决策

- **对带戳的 head，用 writer 在 seal 时的投影替代控制面的独立重放。** 恢复视图补充设计 §2 依赖 wake 扫描只在独立重放之后才清除提示；这种独立性防范的是 writer 丢失，而一次完成的 seal 排除了这种情况。Harness 中错误的 pending 计算在常驻期间同样会错投输入，因为这个戳复用的就是泵自己的挑选逻辑。无戳的 head 保留独立重放。
- **复用 `wake_retry_at` 作为到期时间，而不是新增 `wake_due_at`。** 兜底已经按它排序并建了索引，而且它是 `NOT NULL`，不需要任何 null 安全规则。认领延迟与到期时间共用该列而不冲突：认领只在到期时间过去之后发生，并把该值改为认领之后 30 s。
- **一个戳同时服务分发、恢复视图和 transport。** 父设计只把正常挂起证明用于 `ready`；同一个列还让兜底跳过重放，让 transport 跳过尚未到期的通知。

## 5. 被取代的父设计章节

| 父设计章节                                                                                                           | 状态                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| §1.2「缺口」段、§2 的 3a 范围、§3.2 的新增项                                                                         | 到期时间在 seal 时写入，由现有兜底提供服务（§3）。                                                                              |
| §4.1 head 到期提示、证明缓存规则                                                                                     | 由 §3.1 取代；不入缓存规则撤回（§3.2）。                                                                                        |
| §4.2 第 1、2、4 步                                                                                                   | 由 §3.2 取代。第 3 步（被动动词）、突发控制和接管路径不变；transport 复核见 §3.4。                                              |
| §4.3                                                                                                                 | seal 时未尝试证明不变，现在也是戳的前提条件；发布段落见 §3.5。                                                                  |
| §4.6 前两条                                                                                                          | 由 §3.3 取代。3b 各条及其余内容不变。                                                                                           |
| §5.1、§5.2                                                                                                           | 由本补充设计 §2–§4 取代。                                                                                                       |
| §7 第 2–3 项                                                                                                         | 由 §6 取代。                                                                                                                    |
| §8 风险：head 提示的 null 安全；证明结果须区分仅未来与未完成；证明缓存饿死；证明重放成本；快扫选择性；冷态未尝试证明 | 撤回；它们所防护的机制已不存在。纯被动分发、加载计数、transport 复核、seal 时已尝试输入证明、已取消输入的结算保留。             |
| §9 的 3a 条目：head 提示的 null 安全；head 提示未知态；证明刷新；证明缓存饱和；快扫选择性；冷态未尝试证明            | 由 §7 取代。其他 3a 条目保持不变。                                                                                              |
| §10 第 1–3 项                                                                                                        | 由 §8 取代。                                                                                                                    |
| §11 的 3a 条目与切片 (1)                                                                                             | 切片 (1) 改为：`wake_seal_revision` 列、获取时的上限、seal 戳、兜底分支、`ready` 守卫、transport 围栏和能力门，以及 §6 的测量。 |

3b（§4.4、§4.5 以及 §4.6–§11 中的 3b 部分）不变。

## 6. 测量

取代父设计 §7 第 2–3 项，沿用同一套测量 rig。

1. **到期延迟**：journal 为 1、40 和 200+ 笔事务的带戳 head 从触发到 turn 开始的延迟；它不应依赖 journal 长度。据此选定兜底扫描周期。
2. **同步到期批次**：N 个带戳 head 同时到期，对照 `HOSTED_COLD_OPEN_LIMIT`；据此选定扫描页大小和暂时性拒绝的重试延迟。
3. **到期前成本**：有 N 个带戳的远期 head 时，它们到期前的兜底认领次数和 journal 读取次数都应为 0。

## 7. 验收

取代 §5 所列的父设计 §9 条目。

- **戳内容**：(a) 没有 pending、(b) 只有一个在 `T` 触发的 loop wakeup、(c) 一个排队的立即 wake 输入、(d) 只有一个已停止 run 的消息输入，这四种挂起分别记录 `pending=0`；`pending=1` 且 `wake_retry_at=T`；`pending=1` 且 `wake_retry_at=0`；`pending=0`，并且都有 `wake_seal_revision = journal_revision`。
- **围栏**：戳的 revision 与 head 不一致的 seal 被拒绝，teardown 重试；一次获取会清掉戳；拒载的 seal、裸 `writers:seal` 和所有权释放都不留下戳。
- **获取上限**：获取一个带远期 `T` 戳的 head、接受一个立即输入然后崩溃，`wake_retry_at` 至多为获取之后一个认领延迟，因此兜底按今天的方式投递该输入；持续拒载的加载按认领延迟重试，而不是每次扫描都重试。
- **到期前无工作**：128 个带戳的远期 head 在 `T` 之前引起零次认领和零次 journal 读取，同时一个 journal 为 40 笔事务的到期 Session 在一个扫描周期内启动（与 §1 的复现相反）。
- **到期分发无需重放**：到 `T` 时带戳 head 经被动 `recoverForWake` 加载，journal 读取为零；无戳的崩溃 head 走现有证明路径。
- **子 Session 失效**：父 run 已终止或已请求停止的带戳子 Session，其提示被清除且不加载。
- **恢复视图**：(a) 带一个未尝试 deferred 输入的正常挂起在 seal 之后立即返回 `nextTurnAllowed=true`；(b) 带一个已尝试输入且拒载的不是 `ready`；(c) 正常挂起之后、一次未提交就拒载的加载不是 `ready`，因为该次获取清掉了戳。
- **transport**：延迟到达的通知，(a) 对一小时后到期的带戳 head，在 `T` 之前引起零次冷启动；(b) 对 `pending=0` 的带戳 head 不引起冷启动；(c) 对已到期、或戳的 revision 较旧的带戳 head，照现有方式加载。
- **子 Session 范围**：兜底扫描在到期时选中带戳的子 Session，恢复视图对正常带戳的子 Session 报告 `ready`。
- **回滚**：在带戳挂起之后关闭该能力，每个输入仍在到期时恰好投递一次。
- **MySQL**：戳、获取上限和兜底分支通过 MySQL 8.4 上选定的 `mysql-integration` 用例；仅有 H2 不构成验收。

## 8. 开放问题

取代父设计 §10 第 1–3 项。

1. 兜底扫描周期、页大小和暂时性拒绝的重试延迟，由 §6 选定。
2. 已解决：`writers:seal` 接受 `wake: {revision, pending, dueAt}`，能力随 writer grant 下发（§3.5）。
3. 崩溃路径是否也应在完整的仅 deferred 证明之后，把 `wake_retry_at` 设为最早的 deferred `notBefore`，以去掉其 30 s 重新认领。3a 不需要它。

## 9. 关闭的评审事项

- **父设计 §9 的 head 提示未知态验收测量的是一条不会执行的路径**（合并后提出）：未知态已不存在，该判据撤回。
- **不入缓存时兜底的稳态重放成本**（合并后针对父设计 §4.1 提出）：不入缓存规则撤回，带戳 head 在到期前从不被重放（§1 第 1 项、§7）。
- **transport 丢弃条件漏掉了 `pending=0` 的带戳 head**（合并后针对 §3.4 提出）：条件新增 `is_wake_pending = 0` 分支，§7 新增对应验收。
- **戳把 `ready` 扩展到基于扫描的证明所不覆盖的 head**（合并后针对 §3.3 提出）：§3.3 写明这一扩展，§7 新增子 Session 范围验收。
