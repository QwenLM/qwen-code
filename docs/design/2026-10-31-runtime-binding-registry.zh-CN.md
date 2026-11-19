# Runtime Binding Registry

[English](2026-10-31-runtime-binding-registry.md) | [简体中文](2026-10-31-runtime-binding-registry.zh-CN.md)

- 状态：首个实现切片；验证结果单独记录。后续流程抽取见[执行流程设计](2026-11-01-runtime-execution-workflows.zh-CN.md)。
- 日期：2026-10-31
- 源码基线：`cf7e77810efa776f29b52a3dc4bf24f17d5e80f8`。
- 范围：`packages/managed-agent-server/runtime-broker` 模块内部抽取。

## 问题与当前状态

`RuntimeBrokerService` 在约 6,300 行中混合了放置、acquire、执行、对账、取消、恢复和关闭。单独抽取对账需要向新类传递可变 map 和大量生命周期回调。因此，[结构评审](2026-10-31-managed-agent-structure-review.zh-CN.md) 要求先明确状态持有者。

源码审计修正了原提案：`bindingOperations` 应与 Binding 状态归于同一持有者，因为供应、恢复、回收和排空都预留同一个 Binding ID。`reconciliations` 则属于执行对账，因为必须先写入 `ExecutionObservationCooldown`，再释放按 execution ID 预留的槽位。反向迁移这两张 map 会保留本次要解除的耦合。

## 目标与边界

为本地 Binding 和 Runtime Session 状态建立唯一的模块内部持有者，迁移全部生产调用方，并保持可观察行为。首片不改变公共接口、HTTP 路由、schema、依赖、认证规则或协议字节。不改变 `warm` 的调用时机；按需启动 Runtime 的独立提案不在本次范围内。

供应、身份核验、排空、Session 获取/释放、执行结算、恢复扫描和续租调度仍由服务编排。它们可以调用 Registry，但 Registry 不得回调服务。不为这一个持有者引入接口、通用操作运行器、事件总线或可配置生命周期框架。

## 状态归属

| 状态或职责                                                | 首片后的持有者           | 权威来源与调用方                                                                                                                                                                        |
| --------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `liveBindings`                                            | `RuntimeBindingRegistry` | 仅表示本地已核验的代际/租约；供应和接管登记；warm、恢复、对账和扩展控制读取；排空、丢失和失效处理移除。                                                                                 |
| `bindingOperations`                                       | Registry                 | 按 Binding ID 预留本地操作，由供应、Binding 对账、丢失代际回收、维护恢复和排空共享；不替代 repository 操作租约。                                                                        |
| `sessions` 与 `SessionContext`                            | Registry                 | 本地 Runtime Session 获取/接管 future，以及每个 context 的锁、mount claim、活跃 control、后台进程 ID 和 release future。acquire、执行/control、对账、取消、释放和排空使用这些 context。 |
| `reconciliations` 与 `ExecutionObservationCooldown`       | 当前服务，后续对账协作者 | 按 execution ID 去重，以及先 stamp 后移除预留槽位的顺序，在后续切片中一起迁移。                                                                                                         |
| `dispatches`、`invocations`、execution CAS 和后台进程结算 | 服务                     | 分发与物理调用跟踪不属于 Binding 状态归属。                                                                                                                                             |
| 操作/分发续租、scheduler、`closed`、provisioner 生命周期  | 服务                     | 保留同一关闭屏障与续租任务。                                                                                                                                                            |
| 持久化 Binding、Session、execution、准入和 writer fencing | Repository               | 跨 Broker 进程与重启的持久权威；Registry 成员资格绝不是授权或 writer 已停止的证明。                                                                                                     |

`BindingContext` 是编排步骤间传递的不可变 record 与 lease 对。`SessionContext` 保留 `ReentrantLock`：调用方的复合决策与 context 访问器使用同一把锁，包括 repository 调用在 JDK 21 虚拟线程上阻塞的场景。首片保持后台进程集合现有的加锁使用方式，不同时修改结算归属。

## Registry 操作

Registry 是现有 service package 中的 package-private 类。直接接收 Binding repository、provisioner、Broker owner ID、operation lease duration 和 clock。这些是现有校验/失效操作的具体依赖；它没有 scheduler 或 service 引用。

- 查找、预留并有条件地移除 Binding 操作 future。调用方保留自己安装的 future；清理只移除该预留项，旧操作完成不能删除替代项。
- 查找、登记和移除 Session future。acquire/接管失败时只移除自己的 future。成功释放保留持久化释放完成或读到已 `RELEASED` 后的现有移除位置。
- 登记或移除本地已核验的 Binding，匹配代际及完整租约身份，并在使用前要求这条本地路由存在。
- 验证 execution 的原持久化代际仍为 `READY` 或 `DRAINING`。该读取继续独立于本地租约校验，以及原位置的 tenant、Harness 与准入检查。
- 将不可用 Binding 标为失效，并按现有错误码拒绝不可用的 Session lease。
- 服务关闭时取消未完成的 Binding 与 Session future。服务继续取消分发与执行对账 future、停止两个 scheduler 并关闭 provisioner。

不暴露原始 map。future 和 context 是操作句柄，不是新的持久状态。Registry 不启动工作、不刷新授权、不获取替代代际，也不在读取路径上制造 Session。

## 并发、租约与清理

保留下列源码顺序契约：

1. 供应/接管在 repository claim 下持久化就绪后，才在本地登记核验后的 lease。缓存就绪必须匹配代际、Runtime instance ID、endpoint、token、lease ID 和 epoch；过期 endpoint 不能成为回退路由。
2. 用 `putIfAbsent` 预留 Binding ID 后才启动相应本地操作。现有调用方继续 join 或收到原有的操作特定拒绝。有条件移除预留项先于完成其持有的 future，保持同步 continuation 行为。
3. acquire 前先预留 Session future。失败时先移除该 future，再异常完成。现有 Session 身份/准入检查、mount claim 替换、control 计数和 release guard 保留原位置与锁边界。
4. 失效处理先撤销本地路由，再尝试 repository 操作 claim 与现有 `READY` 到 `LOST` 的 CAS。claim 或写入失败不得恢复路由。在 `finally` 中以准确的 Broker owner 和 operation generation 释放 claim；尽力释放失败时由租约自然过期。失效本身不构成丢失证据或 writer 停止证明，也不释放 Session 或物理资源。
5. 物理 Session 释放仍按持久化 `RELEASING` 准入、worker 确认、持久化释放完成的顺序执行。失败/否定回复重置现有 latch 以便重试。本地缓存迁移不得绕过活跃 execution 或后台 hold 检查。
6. 服务 close 先设置现有原子屏障，再取消 Registry future，随后取消其他操作 future、关闭 scheduler 和 provisioner。Registry 取消操作不引入独立 closed 标志、拆除顺序或物理清理策略。

Binding ID 标识持久的物理代际；repository operation generation 独立隔离同一 claim 的历次 owner。抽取保留两种身份和全部 repository 检查。进程内 future 仅合并同一 Broker 中的工作，不能建立跨进程互斥。

## 实现与后续顺序

首片新增 `RuntimeBindingRegistry`，迁移其 map、本地 context 类型及 Binding 校验/失效 helper，并迁移全部 service 调用点。测试通过 `BrokerServiceTestAccess` 按新持有者安装 context；生产代码不新增测试入口。同时更新两个语言版本的结构评审，引用修正后的归属边界。

[后续流程设计与实现](2026-11-01-runtime-execution-workflows.zh-CN.md) 遵循以下顺序：

1. 执行对账，同时迁移按 execution ID 预留的槽位和 cooldown 顺序。在该边界固定先 stamp 后移除预留项的测试；Registry 首片不宣称补齐现有覆盖缺口；后续抽取增加阻塞 stamp 的回归。
2. 对账边界具备之后，再拆恢复扫描及其后台进程结算依赖。
3. 取消执行及其原代际路由和持久取消意图处理。

每项后续工作独立提供 diff 和验收证据。把所有流程搬进 Registry，只会换一个名字重新形成大服务。

## 验证与验收

本次是内部重构，复用现有 Java service 与 HTTP 回归，不构造全局 CLI 基线或新的行为 E2E 计划。定向 Registry 测试覆盖完整 lease 匹配、持久代际资格、失效顺序与 claim 清理、预留项替换和关闭。现有 service 测试覆盖并发 warm/acquire/release、租约变化、过期供应完成、claim 续租、对账路由和关闭屏障。在模块共享本地验证预算内，包括 context 夹具迁移所影响的 HTTP 测试、持久恢复测试、虚拟线程 guard 回归和模块架构检查。

预检 JDK 21、Maven >= 3.8.9，以及任务隔离 Maven 仓库中匹配源码的 SDK。按模块要求运行定向 Maven test/Checkstyle，记录准确的测试类、源码状态、结果和遗漏。完整 Java/SpotBugs、MySQL 和 Hosted/fault 门禁交由 CI。选定的内存或 H2 用例不构成 MySQL、真实进程恢复或生产验收。相关真实进程路径若无法在本地预算内运行，记录为待验证，不以 fixture 结果替代。

验收要求：service 不再持有 Registry 的原始 map 或 context 定义；Registry 不依赖 service 或注入回调；外部契约和 repository 算法保持不变；具备有意义的定向回归证据；完成两轮干净自审；双语文档同步；被验收版本通过必要 CI 门禁。本地抽取完成不表示 CI 已验收。

## 风险与已决问题

主要风险是完成顺序变化、本地 lease 校验被意外削弱、异常分类改变，以及丢失共享 context guard。通过机械迁移、逐调用方对比和上述定向测试控制风险。保留现有无条件移除 Session 和退役 Binding 的位置；更改该策略属于独立行为变更。

已决：Registry 持有 Binding 操作预留项，不持有执行对账预留项。续租与关闭归服务。持久准入保留在原 repository 调用位置。首片没有待定产品决策；后续协作者 API 和验证已在所链接的流程设计中明确。
