# Managed Broker 门面分解收尾

[English](2026-11-11-managed-broker-facade-decomposition.md) | [简体中文](2026-11-11-managed-broker-facade-decomposition.zh-CN.md)

## 状态与范围

- 状态：已实现；仅行为保持的抽取与命名。
- 日期：2026-11-11
- 范围：`packages/managed-agent-server` — `contracts`、`runtime-broker` 及 verification 棘轮 pin。
- 脉络：在[类尺寸棘轮](2026-11-04-managed-agent-class-size-ratchet.md)纪律下，完成[结构评审](2026-10-31-managed-agent-structure-review.md) P1 的 broker 半侧。沿用[绑定注册表](2026-10-31-runtime-binding-registry.md)与[执行工作流](2026-11-01-runtime-execution-workflows.md)的抽取风格：逐字搬移、显式构造器注入、不引入 service 回调。

## 问题

P1 抽取簇落地后，`RuntimeBrokerService` 仍是 2,894 行的门面，pin 在 2,895。剩余三处结构沉积：

1. drain/close 级联（约 566 行、20 个方法）与 session 释放机制（约 250 行）仍在门面里，但两者都是自洽关注点，各有自己的协议、错误码族和状态。
2. `BindingRenewal` 是门面的内部类，而已抽出的 `RuntimeBindingProvisioning` 却 import 它并接收 `BindingRenewal::new` 工厂。依赖图成环：service → provisioning → service 的内部类 → service 的字段和方法。
3. 两条字节级协议规则被反复手写：observation↔lease 的五字段身份比对（门面内三份逐字副本），以及 Tool v3 的两种互斥编码（`runtimeProtocol=3` 与 `dispatchMode=deferred_v3`，散布五个类共 15 处检查，没有命名谓词）。

## 设计

### 命名协议规则（contracts + support）

- `RuntimeObservation.matchesRuntime(handle, lease)` 命名五字段身份比对，沿用已有的 `RuntimeRecoveryEvidence.matches` 先例。它只做身份判断：调用方仍自行判定 outcome 并单独 attest。null 守卫与 evidence 先例一致；每个调用点本就保证 handle 与 lease 非空。
- `RuntimeBrokerSupport.isPublicationV3`、`isProtocolV3`、`isV3Family` 命名两种编码及其并集。编码的定义仍留在 `prepareExecutionReference`；所有检查点改用谓词。`startExecution` 里两处单编码检查刻意保持分离：它们覆盖互斥的 reference，合并成 family 谓词会扩大拒绝范围。

### Session 释放缝（`RuntimeSessionRelease`）

一个模块内部协作类持有 session 释放的 CAS 迁移（`transitionSessionToReleasing`、`finishSessionRelease`）与释放机制（`releaseSession`、`releaseSessionAfterSweep`、`completeSessionRelease`、`releaseUnusableSession`），逐字搬移。仓库、provisioner、transport、注册表、执行恢复与 clock 经构造器注入。门面的 `release` 路径与 drain 级联都消费它；`BindingRenewal.releaseStoppedSession` 使用其 CAS 迁移。

### `BindingRenewal` 提升

`BindingRenewal` 成为顶层包私有类，显式构造器依赖，打断 provisioning→门面 的环。`RuntimeBindingProvisioning` 去掉内部类 import（同包），保留 `Function<RuntimeBindingRecord, BindingRenewal>` 工厂参数。门面提供一个私有工厂方法，由 provisioning 与 drain 协调器共享。方法体、monitor 纪律、staged stopped-flag 注释原样搬移。

### Drain 缝（`RuntimeDrainCoordinator`）

drain/close 级联逐字搬入一个模块内部协作类：harness drain、resident close、storage 退役、stop 证明观察、receipt 持久化，以及分页的 session/tool 清扫。级联唯一的一次释放调用（`releaseSession(context, true)`）消费 `RuntimeSessionRelease`；操作截止时间与超时映射消费 provisioning 协作类；续期经工厂创建。门面保留公开 drain API 的薄委托，以及 `releasedSession` 的已存 session 释放委托。不引入新的 service 回调；协作类之间的依赖与既有抽取风格一致。

### 棘轮收紧

门面 pin 从 2895 降到 1930，provisioning pin 从 1310 降到 1309；新协作类均低于 800 行 pin 阈值。`GLOBAL_MAX_LINES` 从 2894 降到 2662，即剩余最大类（`JdbcRuntimeBindingRepository`）的尺寸。上限只降不升。pin 基线对齐上游——上游已分解 CSI application inventory；本地检出早于该分解，故下调后的全局上限由 CI 在上游基线树上验证。

## 考虑过但否决

- **本地 ack 复用已解析 context。** `acknowledgeExecution` 在本地路径上两次解析 ready session。把第一次的 context 传下去并非行为保持：`requireSession` 读内存注册表，若两次解析之间并发释放移除了条目，今天回答 404；传下去的 context 会走到锁内重校验而回答 409。双重解析是一次廉价的 map 查找，保留了新鲜的 404 检查。保持原样。
- **构造器参数 record。** 门面的四个望远镜构造器重复了 session 创建的重载病，但它们是 embedding 公开 API（server 装配加 35 个测试构造点）。那是风险类别不同的 API 形状变更，留作独立的首发前 slice。
- **共享分页 helper。** 八处游标分页循环的批源、页大小、错误语义各不相同。只有在 drain 搬移内部顺带统一才划算，而逐字搬移纪律为 review 保持它们原样。

## 不变量

- 无公开/WebShell 路由、OpenAPI、schema 变更。
- 错误码、可重试标志、租约/代际围栏、字节级协议规则不变；除命名谓词与共享释放缝外，每处搬移都是逐字的。
- `contracts` 模块保持 Spring-free、SQL-free、HTTP-client-free；ArchUnit 原样通过。

## 验证

- 本地焦点：`RuntimeBrokerServiceTest`、`RuntimeExecutionDispatcherTest`、`RuntimeExecutionReconcilerTest`、`RuntimeBrokerServiceBindingReadTest`、`ClassSizeRatchetTest`、Checkstyle。
- CI 持有完整 unit/H2 套件、SpotBugs 与 Hosted/fault-gate profile；drain 级联的物理停止与 receipt 语义由 fault gate 鉴定，而非仅靠单测。
- 在所需 CI 门关于接受修订上通过之前，接受状态为待定。

## 后续

- 沿新缝拆分镜像的门面测试文件（棘轮不覆盖测试尺寸）。
- 构造器参数 record 仍是独立的首发前 slice。
- 随剩余 persistence 巨类分解，继续下调 `GLOBAL_MAX_LINES`。
