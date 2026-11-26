# Managed 离池 Placement 回收器

[English](2026-11-26-managed-departed-placement-reaper.md) | [简体中文](2026-11-26-managed-departed-placement-reaper.zh-CN.md)

状态：实现设计，2026-11-26。本设计是[干净挂起 placement 释放设计](2026-11-26-managed-suspension-placement-release.zh-CN.md)在故障和历史遗留行上的配套工作。

## 1. 问题与现状

干净挂起只有在旧 Harness 存活到完成 release 请求时才能释放 placement。seal 与 release 之间崩溃、功能上线前已经消失的进程、或控制面以更小静态池重启，都会留下由缺席成员拥有的 `ACTIVE` 或 `QUIESCING` placement。

现有请求驱动的 takeover 可以在 writer lease 到期后恢复，但没有后台任务枚举这些行。因此，已离池 owner 的 placement/connector 元数据可能一直保留到某个后续请求恰好选择该 Session。静态配置移除成员并重启控制面后，旧 `Member` 对象已经不存在，只扫描 member map 会漏掉这个主要场景。

`readInstance()` 失败本身不授权回收；只有独立的 writer-lease 与干净 seal 证明已经足够执行现有 expired takeover 时，才可进入候选。因此，自动回收只覆盖从权威当前快照中消失的实例，或已协商 member 明确不可达的实例；健康状态未知、健康或正在 drain 的成员仍受保护。

## 2. 目标与范围

### 目标

- 回收 writer lease 已到期、带当前 wake 戳，且 owner 实例已从当前池配置移除，或明确不可达并满足完整到期证明的挂起 placement。
- 通过现有 takeover CAS 把 placement 转给健康且 accepting 的成员，不伪造 release receipt。
- 后继 Harness 在真实请求或 wake 到来前保持未挂载。
- 同时覆盖历史 `ACTIVE` placement 和 quiesce/seal 与 release 之间遗留的 `QUIESCING` placement。
- 保留 tenant 隔离、writer/activation fencing、wake/Action-park 证书和恰好一次恢复语义。

### 非目标

- 仅因成员不可达、正在 drain、处于 quiescing 或出现新 boot，就回收仍在配置中的成员。
- 缩短 writer lease、把 `SEALED` 单独当作证明、写入合成 release 记录或在没有 receipt 时把 placement 改成 `RELEASED`。
- 在 reaper 中打开 Harness attachment、驱动 Turn、投递决定或恢复 Runtime/Tool 状态。
- 改派任意运行中 Session、处理中的 close/archive/delete 生命周期操作，或没有当前 wake-stamped seal 的行。
- 新公开路由、配置项、调度器 bean、schema 字段或生产动态 discovery 实现。

## 3. 设计决策

| 决策       | 选择                                                                            | 理由                                                              |
| ---------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 离池信号   | 实例从 `current=true` 快照中消失，或已协商 member 明确不可达且满足完整到期证明  | 不可达本身永远不够；健康、drain 和状态未知成员被排除。            |
| 候选证明   | 到期 lease + `SEALED/READY` head + released/current activation + 当前 wake seal | 复用持久挂起证据，排除 bare/stale seal 和存活 writer。            |
| 所有权转换 | 通过现有 `takeover` 转给健康 accepting 后继                                     | expired 分支已经允许无 receipt 的安全 CAS，不需要第二套释放协议。 |
| 后继工作   | 只改 placement，不打开 attachment 或发起恢复 RPC                                | reaper 只改路由元数据，绝不执行 Session 工作。                    |
| 调度       | 在现有同步 pool refresh 末尾执行有界回收                                        | 复用现有 daemon 和 discovery 快照，不引入重叠调度器。             |
| 批大小     | 每次 refresh 最多 32 个候选                                                     | 限制单次工作；成功 takeover 会移除候选，后续批次继续推进。        |
| 数据库访问 | distinct owner 实例加 owner-scoped join                                         | 使用 `idx_ma_harness_owner`，避免无索引的全表 `NOT IN` 扫描。     |

## 4. Store 候选查找器

`HarnessPlacementStore` 新增 `findExpiredSuspensions(excludedInstanceIds, limit)`。

实现先读取 distinct placement owner 实例 ID。对每个不在 `excludedInstanceIds` 中的实例，执行 owner-scoped 的 `ma_session` 与 managed head join，直到凑满请求批次。查找器只返回现有 `Placement`，不执行任何写入。

候选必须同时满足：

- placement 状态为 `ACTIVE` 或 `QUIESCING`，且 epoch 低于计数上限；
- Session 状态为 `ACTIVE`，未 retired，且 resource GC 未完成；
- managed head 为 `SEALED`，recovery 状态为 `READY`；
- writer lease 非空且不晚于数据库当前时间；
- `activation_phase='released'`，且 `activation_head_revision=journal_revision`；
- `wake_seal_revision=journal_revision`。

查询按 tenant 和 Session ID 确定性排序。owner distinct 扫描和每个 owner-scoped 候选查询都使用现有 placement-owner 索引，不新增 head lease/wake 索引。

查找器有意不执行 Turn/Runtime 恢复谓词。sealed head 和到期 writer 已经围栏旧 incarnation，而 reaper 只改变 placement。真实恢复请求到来时，现有 recovery/readiness 和 load 路径仍会验证 parked Turn、后台义务和 cleanup。

## 5. Refresh 集成

在 `HarnessPoolConnector.refresh()` 发布 `accepting` 之后、成员裁剪之前：

1. discovery 不当前或没有健康 accepting 后继时立即返回。
2. 排除所有已配置实例，只有已协商 member 明确不可达时才解除排除；没有可靠健康证据的成员保持排除。
3. 对每个候选，用现有轮询计数器选择 accepting 后继。
4. 调用普通 `placements.takeover(tenant, session, expected, successorInstance, successorBoot)`。
5. 只忽略预期的单候选竞态：owner 重新活跃、placement 已变化、Session 已消失或生命周期准入已变化。其他 Store 故障保持现有 refresh 失败行为。
6. 成员裁剪仍交给 `hasUnreleasedOwnership`；成功 takeover 后 ownership 已离开旧实例。

reaper 不调用 `select`、`createOrLoad`、`recoverForWake`、`quiesce`、`releaseOwnership` 或任何 leaf RPC，也不引入新 executor。

CAS 成功后，placement 以 `epoch+1` 在后继上变为 `ACTIVE`。下一个请求找到健康后继并获取该 epoch 的凭证；只有该请求/load 才获取 writer 并恢复 Session。

## 6. 失败与竞态语义

| 竞态                            | 要求的结果                                                                                    |
| ------------------------------- | --------------------------------------------------------------------------------------------- |
| 已配置成员不可达                | 只有满足完整到期干净 seal 证明时才进入候选；没有该证明的暂时故障不改变任何状态。              |
| discovery 快照不当前            | 不调用 finder，不做 takeover。                                                                |
| 已配置成员正在 drain            | 不算离池，请求驱动的 drain 行为不变。                                                         |
| 旧 owner 在 reaper 前 release   | 真实 receipt 分支允许同一个 takeover CAS。                                                    |
| 旧 owner 在 CAS 前重新 acquire  | head 变为带活跃 lease 的 ACTIVE，takeover 拒绝，后续扫描排除。                                |
| reaper 与请求驱动 takeover 竞争 | expected owner/epoch 加 Session-root 锁只接受一个后继，败者得到 `harness_placement_changed`。 |
| 两个控制面 reaper 竞争          | 同一个 Store CAS 只接受一次 epoch 转换，不需要额外选主。                                      |
| 旧 owner 在 takeover 后返回     | 旧 placement 凭证和 writer generation 仍被围栏。                                              |
| 没有 accepting 后继             | 不写 finder、不改 ownership，保留 placement 等待后续批次。                                    |
| 后继在选择后 drain              | placement CAS 可以完成，但不打开 attachment；后续 load 遵循现有重选/fencing。                 |
| 生命周期操作处理中              | 普通 takeover 拒绝，继续由 lifecycle-claim-aware 路径负责。                                   |
| bare 或 stale seal              | finder 排除，不伪造 receipt 或强制释放。                                                      |

## 7. 受影响文件

- `contracts/.../repository/HarnessPlacementStore.java`：有界候选查找契约。
- `persistence/.../JdbcHarnessPlacementStore.java`：owner 发现和参数化合格行查询。
- `adapters/.../HarnessPoolConnector.java`：refresh 时只改 placement 的 reaper。
- `verification/.../HarnessPlacementStoreTest.java` 及其 MySQL 子类：finder 准入、排除和现有 takeover 组合。
- `verification/.../HarnessPoolConnectorTest.java`：权威离池、重启后无旧 member、快照不确定、已配置不可达、无容量和竞态。
- `verification/.../HostedHarnessPoolMySqlIT.java`：真实后继进程、到期 sealed 历史行、refresh CAS 不打开附件，随后显式 load。

## 8. 验证与验收

- 实现前，同一个到期 sealed fixture 在 refresh 后仍留在离池 owner 上；不存在 finder，也没有无附件 takeover。
- `ACTIVE` 和 `QUIESCING` 候选可被发现；活跃 lease、ACTIVE head、bare/stale wake seal、滞后或活跃 activation、非 READY recovery、终态/retired/GC 完成 Session 和耗尽 epoch 被排除。
- 已配置但不可达的 owner 只有满足完整到期证明时才被回收；健康、drain 和状态未知的 owner 不进入 takeover。discovery 不确定和零后继容量为 no-op。
- 控制面重启后 member map 只有后继 B，仍能从 SQL 找到旧 owner A。
- 成功 refresh 只改变 placement owner/epoch/state，不创建 release 记录、不打开 attachment，也不重写 head、Turn、Action 或 journal。
- 后续在 B 上显式 load 恢复 Session，并围栏 A 的旧凭证。
- 两个竞争 takeover 只有一个 epoch 胜者；迟到的旧 owner release 不能改变后继 epoch。
- H2 和选定的 MySQL 8.4 用例通过，现有 pool、drain、clean-release 和 Action-parking 回归也通过。

## 9. 成本与后续

每次 refresh 执行一次 distinct-owner 查询，每个离池 owner 至多一次有界候选查询，然后只执行必要的 takeover 事务。相比周期性全量 head 扫描，这更可控。增大批次前必须观察候选数量和查询计划。

仍在配置中的实例出现健康替换 boot 时按 boot 回收，以及真实注入 seal 与 release 之间的崩溃，留作后续。这些场景已有请求驱动的 lease-expiry 兜底，不能因此削弱本切片的证明要求。
