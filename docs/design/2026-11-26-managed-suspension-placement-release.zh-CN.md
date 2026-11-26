# Managed 挂起 Placement 释放

[English](2026-11-26-managed-suspension-placement-release.md) | [简体中文](2026-11-26-managed-suspension-placement-release.zh-CN.md)

状态：实现设计，2026-11-26。现状结论对照 `main` 的 `6d0e2336a7` 核实。本补充设计取代[无状态 Harness 设计](2026-11-16-managed-stateless-harness.zh-CN.md)第一阶段“保留已挂起 Session 的 placement”这一非目标。

## 1. 问题与现状

干净的空闲挂起或 Action park 会释放 activation，并用 wake 戳 seal writer，但 Session 的 placement 仍为 `ACTIVE`。只要旧 Harness 仍然健康，池选择就继续把 Session 路由给原 owner。另一个成员必须等 writer lease 到期才能接管，因为 `JdbcHarnessPlacementStore.takeover` 只接受以下两种证明之一：

- placement 为 `RELEASED`、head 为 `SEALED`，并存在当前 placement epoch 的 release 记录；或
- writer lease 已到期，且 activation 状态允许恢复。

drain 路径已经通过 `quiesceOwnership` 和 `releaseOwnership` 写入所需回执，但不能由挂起直接调用：drain 排除了挂起需要 teardown 的存活 owner 和待处理工作，而且现有 Store release 分支要求 head 为 `ACTIVE`。挂起 seal head 后，`quiesceOwnership` 和现有 release 分支都会拒绝旧 writer。

因此当前行为安全但仍然粘滞：Harness 内存和续约工作已经释放，所有权却最长还要固定到 writer lease 到期。

## 2. 目标与范围

### 目标

- 让干净的空闲挂起或 Action park 在持久化 wake-stamped seal 后释放 placement。
- 让健康的池成员 B 能从仍然健康的成员 A 接管，无需等待 A 的 writer lease 到期。
- 保留 journal、wake 戳、Action-park 证书、writer fencing 和 Action 恰好一次结算。
- 复用现有 release receipt、takeover CAS 和恢复路径。
- 在 Harness 与控制面混版时保持当前行为。

### 非目标

- 回收离池成员遗留、或 seal 与 release 之间崩溃遗留的 placement。该 reaper 是后续独立切片。
- 在未公告 wake dispatch 时释放 bare-sealed Session。
- 放宽 takeover，使其接受没有 release receipt 的 sealed head。
- 任意运行中 Turn 的 owner 路由、用 Session 级 fencing 替代进程 boot fence、负载均衡部署或 pull 调度。
- 新的公开 API 路由、数据库 schema 变更或受支持的配置项。

## 3. 设计决策

| 决策             | 选择                                                              | 理由                                                                                     |
| ---------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 释放证明         | 复用 drain receipt 和 `RELEASED + SEALED + receipt` takeover 分支 | 不需要第二套所有权协议，也不需要放宽 takeover。                                          |
| 干净 seal 证据   | `wake_seal_revision == journal_revision`                          | 区分可恢复的挂起/park 与 bare seal，并保留现有恢复证明。                                 |
| 版本协商         | 增量 `suspensionPlacementRelease` writer-grant 能力位             | 新 Harness 不会对旧 Store 尝试 post-seal release。                                       |
| 能力门控         | 只与 `wakeDispatch` 一起公告新能力位                              | 干净释放依赖 wake-stamped seal，不需要独立设置。                                         |
| Harness 顺序     | activation release 和 seal 前 quiesce；seal 后释放 placement      | 旧 writer 只有在 active 时才能 quiesce，而后继只有拿到 release receipt 才能获取 writer。 |
| sealed-head 更新 | sealed release 分支不重写 head                                    | 保留 wake/park 证书以及 parked-MCP 保留期使用的 head 修改时间。                          |
| 失败恢复         | 精确重放 release；租约到期仍是兜底                                | 丢失响应或崩溃不会使 Session 悬置，也不会产生第二个 writer incarnation。                 |

## 4. 能力与兼容性

`ManagedSessionStoreModels.WriterGrant` 增加增量布尔字段 `suspensionPlacementRelease`。控制面只在 `qwen.managed-agent.wake-dispatch.enabled=true` 时公告它；它不是独立的发布开关。

TypeScript 的 grant 解析、续约合并和 `HttpManagedSessionStores` 暴露 `supportsSuspensionPlacementRelease()`。Harness 仅在以下两个条件同时成立时尝试新释放：

- Session 具有池 placement；且
- 当前 writer grant 公告 `suspensionPlacementRelease`。

否则挂起逐字沿用当前路径。特别是，新 Harness 配旧 Store 时看不到能力位并保留 placement；旧 Harness 配新 Store 时则不会使用新分支。

先部署控制面，再部署 Harness。回滚时先回滚 Harness，再回滚控制面。增量 grant 字段对旧读取方安全，现有 release 路由和 receipt 形状不变。

## 5. Harness 挂起流程

现有挂起闸门和资格检查不变。teardown 顺序变为：

1. 按现状关闭 wake 调度，并 drain Hooks、MCP、Runtime 所有权和 publisher。
2. 停止 writer 与 activation 续约。
3. 能力适用时，用仍然活跃的 writer grant quiesce 当前 placement。
4. 释放 activation，并确认 wake-stamped writer seal。
5. 用相同的 placement epoch、writer generation、journal revision 和 activation commit proof 释放 placement。
6. 停止本地 Store 访问和事件流，移除常驻并清除挂起闸门。

quiesce 和已确认 seal 是独立的 teardown 里程碑。确认 seal 后的重试跳过续约、quiesce、activation release 和 seal 本身，只重试剩余的 placement release。seal 结果不确定时保留现有对账行为，并且绝不重复已确认的 quiesce。

`session.ownershipRelease` 在重试间保存新生成的 operation ID 和 activation commit proof。release 客户端在 seal 后保留 grant，并只把它用于本次 release；所有普通 writer 操作仍被围栏。失败的 release promise 会被清除，下一次尝试重发完全相同的请求，绝不更换 operation ID 或 proof。

挂起闸门全程保持关闭。如果 release 未完成，常驻不会回到普通服务。

## 6. Store release 事务与围栏

`JournalWriterLifecycle.releaseOwnership` 保留现有 drain 分支，并增加 clean-sealed 分支。两者使用当前锁序和事务：

1. 在资源查找前验证 tenant/workspace/Session 凭证和 placement HMAC。
2. 按现有顺序锁定 tenant placement guard、tenant publication guard 和 Session root。
3. 在当前 owner 检查前重放完全相同的已存 receipt；同一 epoch 的冲突 receipt 被拒绝。
4. 要求当前 placement 为 `QUIESCING`，且不存在 lifecycle claim。
5. 锁定 head，并验证其 tenant/workspace/Session 作用域。

clean-sealed 分支要求以下全部条件：

- head 状态为 `SEALED`；
- 请求的 writer ID、writer generation 和 writer-token 哈希与 sealed incarnation 完全一致；
- 现有 journal revision、committed sequence 和 commit-prefix digest 证明完全匹配；
- `activation_phase='released'`，且 `activation_head_revision == journal_revision`；
- `wake_seal_revision == journal_revision`。

sealed 分支不要求 writer lease 尚未到期：sealed incarnation 和 generation 就是写围栏。它不更新 head。drain 分支保留当前对 `ACTIVE` head 和未过期 lease 的要求，并执行现有 `ACTIVE → SEALED` 更新。

两个分支都写入相同的 release resource、domain record 和 resource reference，然后在同一事务内把 placement 改为 `RELEASED`。所有 SQL 仍按 tenant 限定并参数化。过期 owner 不能释放更新的 epoch 或 generation，旧的精确重试也只能返回原 receipt。

`JdbcHarnessPlacementStore.takeover` 和 `HarnessPoolConnector.select` 无需修改。已释放 placement 本来就会触发重新选择，现有 receipt 加 sealed-head 证明已经允许在 lease 到期前完成 CAS。

## 7. 失败与竞态语义

| 窗口                                  | 要求的结果                                                                             |
| ------------------------------------- | -------------------------------------------------------------------------------------- |
| quiesce 成功、seal 未成功             | placement 保持 `QUIESCING`，不存在 receipt。后继等待 lease 到期，旧 writer 对账 seal。 |
| seal 请求结果不确定                   | 同一个 memoized seal 得到确认前，不尝试 release。                                      |
| seal 已提交、release 失败             | 只用相同 operation ID 和 proof 重试 release。之后若需要恢复，lease 到期仍然安全。      |
| release 已提交、响应丢失              | 精确重试返回已存 receipt，包括后继已接管之后。                                         |
| A 在 release 前重新 acquire           | acquire 改变 sealed incarnation 并清除 wake 戳，旧 release 被拒绝。                    |
| A release 前，B 已在 lease 到期后接管 | A 的旧 epoch/token 不能释放 B 的 placement。                                           |
| release 提交后 A 崩溃                 | A 的旧 placement 和 writer 已被围栏，B 可立即接管。                                    |
| 两个后继竞争                          | Session-root 锁和 epoch CAS 只接受一个后继 epoch。                                     |
| 决定与 Action park 竞争               | 现有 freeze 和 approval-revision 规则决定胜者；release 不增加新的执行路径。            |

## 8. 受影响文件

### 控制面与契约

- `packages/managed-agent-server/contracts/.../ManagedSessionStoreModels.java`：增量 writer-grant 能力位。
- `packages/managed-agent-server/server/.../ManagedSessionStoreController.java`：与 wake dispatch 一起公告能力位。
- `packages/managed-agent-server/persistence/.../JournalStoreRows.java`：在加锁 head 行上暴露 `wake_seal_revision`。
- `packages/managed-agent-server/persistence/.../JournalWriterLifecycle.java`：clean-sealed release 分支。

### TypeScript Store 客户端与 Harness

- `packages/core/src/managed-runtime/http-managed-session-store.ts`：能力解析/暴露，以及用保留的 sealed grant release。
- `packages/cli/src/serve/hosted-harness-session/session-suspension.ts`：quiesce/seal/release 里程碑和精确重试。

### 测试

- `HarnessPlacementStoreTest` 及其 MySQL 子类：释放、重放、负向证明、证书/head 时间戳保留、回滚和后继围栏。
- `http-managed-session-store.test.ts`：能力、post-seal release 和丢失响应后的重放。
- `hosted-harness-session.suspension.test.ts` 与 Action-parking 测试：顺序、重试、能力关闭行为和证书保留。
- `HostedHarnessPoolMySqlIT`：真实进程 A 到 B 在 lease 到期前接管。

## 9. 验证计划

- 实现前证明 post-seal release 的基线拒绝和当前 placement 粘滞。
- 覆盖能力关闭行为、bare-seal 拒绝、陈旧 wake revision、错误 generation/token/proof、滞后 activation 和跨 tenant 凭证；这些都不得写 receipt 或改变 placement/head 状态。
- 在 H2 和选定的 MySQL 8.4 用例上证明精确重放、冲突操作拒绝、回滚原子性和过期 writer 围栏；保留现有 takeover-CAS 覆盖。
- 证明 release 保留 wake、background 和 parked-Turn 证书；后继 acquire 只按当前语义清除它们一次。
- 注入 release 响应丢失和 seal 后失败；验证以相同请求体重试，不重复 quiesce、activation release 或 seal。
- 使用真实 Harness 进程 A、B 和 MySQL 8.4 验收干净空闲挂起，保持 A 健康且旧 lease 未到期。Action park 通过新 epoch 冷恢复单测和覆盖所有结局的真实进程 replacement 场景验证。健康双成员 Action-parked soak 是后续工作，不作为本切片已获得的证据。
- 运行聚焦 TypeScript 与 Java 检查、仓库要求的根 build/typecheck/bundle，完整 Java/MySQL/Hosted profile 留 CI。

## 10. 验收标准

- 不支持或 bare-seal 的挂起行为与之前完全一致。
- 受支持的干净挂起写入一条持久 release receipt，留下 `RELEASED + SEALED` 状态，且不改变 wake/park 证书。
- A 健康且旧 writer lease 未到期时，B 能取得下一个 placement epoch。
- 状态转换后，A 不能 commit、renew、seal 或释放 B 的资源。
- 取消、Allow、Deny、模式切换和到期保持现有行为；Allow 恰好执行一次，Deny 零次。
- 已完成的 quiesce、activation release 或 seal 不会因 release 重试而重复。
- 不引入新配置、公开路由、schema migration 或 takeover 证明例外。

## 11. 成本与后续

每次受支持的挂起增加一次 quiesce 更新和 release receipt 写入。sealed release 分支有意避免第二次 head 更新。发布测量必须比较这些写入和额外冷启动抖动与节省的 Harness/续约资源，以及立即改派的价值。

[离池 placement 回收器](2026-11-26-managed-departed-placement-reaper.zh-CN.md)处理历史挂起行和 seal 与 release 之间的崩溃，且不会从 bare sealed head 推断 release receipt。另需一项真实进程 soak，在两个池成员都保持健康时完成 Action-parked Allow/Deny 接管；干净释放切片不声称已具备这项集成证据。
