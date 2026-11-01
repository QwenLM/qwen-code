# Runtime 执行流程拆分

[English](2026-11-01-runtime-execution-workflows.md) | [简体中文](2026-11-01-runtime-execution-workflows.zh-CN.md)

- 状态：本地已实现，定向验证通过；完整 CI 验收仍待完成。
- 日期：2026-11-01
- 前置条件：基于 `cf7e77810efa776f29b52a3dc4bf24f17d5e80f8` 的本地 [Runtime Binding Registry](2026-10-31-runtime-binding-registry.zh-CN.md) 切片。

## 问题、目标与范围

Registry 明确了 Binding 与 Session 状态持有者，但执行对账、接管扫描与取消仍在 `RuntimeBrokerService` 中。它们共享执行读取、带 fencing 的结算和后台 hold 结算，不能安全地把私有 helper 复制三遍。用直接依赖的模块内部协作者拆出三个流程，并建立一个共享执行状态边界。保留当前可观察行为，包括失败时机、异步 continuation、writer fencing 和清理顺序。

不修改公共接口、HTTP 路由、schema、协议、依赖或 Runtime 启动策略。供应、Binding 恢复/排空、分发、续租调度和物理 Session 释放仍在服务中。这是结构调整；完整集成验收与实现完成分别记录。

## 归属与依赖

| 组件                           | 持有职责                                                                                               | 调用方                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| `RuntimeBindingRegistry`       | 已有本地 Binding/Session map 与 context；READY/历史 Session 校验                                       | 服务与全部三个执行流程                              |
| `RuntimeExecutionState`        | 已有 execution 归属读取、带 fencing 的分发结算/UNKNOWN 转换、过期 claim 隔离和后台行结算               | 分发、对账、恢复、取消及现有确认/control 路径       |
| `RuntimeExecutionReconciler`   | 按 execution ID 预留的查询槽位、`ExecutionObservationCooldown`、证据校验与对账 CAS                     | 服务观察入口与接管扫描                              |
| `RuntimeExecutionRecovery`     | 有界接管扫描与后台 hold 观察/清理流程                                                                  | acquire/接管、普通/排空 release、后台观察与任务停止 |
| `RuntimeExecutionCancellation` | 持久取消意图与物理取消/确认流程                                                                        | 服务取消入口                                        |
| `RuntimeBrokerSupport`         | 不变的无状态 future/错误映射、payload/reference 校验和 status 投影                                     | 抽出的协作者与服务                                  |
| 服务                           | 公共门面、`closed`、分发预留项/在途调用、scheduler、provisioner 生命周期、Binding/Session 生命周期编排 | 现有 adapter 与装配                                 |

全部类保留在现有 runtime-broker service package 内，采用 package-private，不新增接口或 Spring 装配。Repository 仍是唯一持久权威。context 的锁继续归 Registry，每个复合读取/准入/释放决策保留当前锁区域。support 类只共享多个真实调用方已有的规则，不引入可配置流程框架。

## 对账设计

将 `reconcileExecution`、自动 `observeExecution`、基于 context 的查询、按 execution ID 索引的 future map、cooldown 和结果吸收迁入 `RuntimeExecutionReconciler`。服务保留公共签名并委托。对账器接收 Registry、执行状态协作者、execution repository、provisioner、transport、publication verifier、clock、查询时限、共享关闭屏障和现有 cooldown 实例。不持有 executor，不调用服务。

保留以下顺序：校验调用方 ID；读取属于调用方的 execution；在要求活跃 Session 之前返回非 UNKNOWN/终态结果；若存在已完成的 v3 publication，则读取它；否则要求原持久代际与本地已核验路由，再执行有时限的 status 查询。只有合法的 settled 证据才能结算 UNKNOWN，并在 CAS 前重新读取并发取消。UNKNOWN 或不可达绝不构成 `not_started` 证明，不触发分发或 Runtime 供应。

显式对账继续读取新状态，自动观察先读 cooldown。并发请求加入已有 execution ID 预留项。完成时先 stamp cooldown，再移除准确的预留项，最后完成 future；JVM Error 不得缓存为 UNRESOLVED。这样可防止顺序调用方在移除与 stamp 之间发起第二次 worker 查询。服务关闭在原有关闭顺序的同一位置取消对账器待完成的预留项。

接管查询保留额外的关闭检查、原代际路由、普通失败/非法 status 的 unresolved 处理，以及不吞掉 Error 的规则。后台 `not_started` 结算经共享执行状态协作者执行，避免与扫描器形成依赖环。

## 恢复扫描与 hold 设计

把 `scanExecutions` 连同持久后台行分页、后台扫描观察、普通/排空清理、物理 hold control 和现有后台观察/任务停止入口迁入 `RuntimeExecutionRecovery`。依赖为 Registry、执行状态、execution/session repository、transport、对账器和共享关闭屏障。不回调服务，也不持有 scheduler。

扫描继续按已存 Session 与代际读取每页 100 行，观察前重读候选行，并通过 `thenComposeAsync` 在候选项/页面之间让出执行。它不 claim dispatch、不重发工具，也不因记录久远就隔离它。acquire 等待 execution 扫描，但不等待后台维护观察。后台扫描的列举/control 失败仍与 acquire 隔离。

扫描与 release 共用持久后台行读取。扫描观察不持有 `activeControls`，普通 control/清理保持原 guard 计数。普通 release 清理仅观察，只有 drain 执行 status → stop → status。仅已证明退出或未启动的证据能结算 hold；未知证据与逐行错误保留 hold。context 后台索引的回填、快照和移除保留原锁区域。物理 Session 释放及其持久转换仍归服务，在已有 busy 检查前调用恢复协作者。

任务停止保留 tenant/Harness 归属校验和原 Session 路由，只能停止该 invocation 自己的 `:process` 行。任何恢复路径都不创建替代 Binding 或 Session。

## 取消设计

把取消准入、prepared provider 确认、物理取消与结果校验迁入 `RuntimeExecutionCancellation`。它使用 Registry、执行状态、execution repository、transport、现有 invocation 集合、协调 scheduler、取消时限和关闭屏障。服务门面为唯一的 DISPATCHING 分支传入现有双参数分发动作；这个逐调用传入的 `BiConsumer` 是抽出流程接收的唯一 service 动作。不保存 service 引用，不把 map/私有生命周期 helper 作为回调传递。

保留在要求活跃 Session 前读取终态回执归属的顺序。若原 worker 可能仍保留 preparation，prepared provider 的已取消回执仍需原 worker 确认。非终态取消先持久化意图，再发送 worker 请求。hold 行和已授权的私有 CSI 调用保留原拒绝规则。租约过期后，本进程仍运行的 invocation 可继续接收取消；本进程未运行的 invocation 先按 repository 时钟执行 dispatch fence。UNKNOWN 只在对账证据足够时才能结算。

未发送的 DISPATCHING 记录继续走已有 dispatcher，由它读取持久取消意图后决定是否执行；用新的直接结算算法替代该分支会改变行为。物理取消 status 按原 dispatch owner/generation 校验并结算。claim 过期后的迟到结果被隔离，活跃 claim 冲突继续报错。prepared provider 取消保留有时限的结果 future、25 ms 观察调度、control 计数，以及不把已遗忘状态当作确认的规则。

## 共享状态、文件与迁移顺序

`RuntimeExecutionState` 原样迁移 execution 归属检查、`settleExecution`、`markUnknown`、`fenceLapsedClaim`、准入关闭时保留 UNKNOWN 的映射和后台结算 CAS 循环，不改变算法。接收三个 repository、Broker owner、dispatch lease 和 clock。`RuntimeBindingRegistry` 额外接收现有 Session repository 与 resolver，以提供跨流程使用的 READY/历史检查；非 managed 历史读取继续重验解析的 scope，managed 历史使用已存父身份。不删除 resolver/准入检查，也不把它们改成仅依赖缓存的路径。

实现顺序：共享的不变 helper/状态与 Registry 查询；对账器；恢复与 hold 维护；取消；门面装配和关闭。受影响代码为上面的五个新实现文件、已有 service/Registry/cooldown 说明、测试构造器和定向对账回归。同时更新 Registry 与结构评审的两组双语设计，链接本设计并区分早期切片与本次实现。现有 contract/schema/adapter 不变。

## 验证与验收

增加确定性的对账器级先 stamp 后移除预留项回归：阻塞 cooldown stamp，在该窗口内再次观察，断言加入已有操作且不产生第二次 worker 查询。覆盖普通 status 与普通查询失败，再放开 stamp 并验证完成/cooldown。把预留项移除移到 stamp 前时，该测试必须失败。

复用 service 回归覆盖显式/自动查询、超时、非法 status、JVM Error、publication 结果、并发取消与关闭。恢复回归须覆盖多页接管、代际/Session 隔离、异步后台观察、仅持久存在的 hold 和普通/排空 release 差异。取消回归覆盖终态归属、prepared 确认、未发送分发、过期 claim、粘性取消意图、跨 Harness 拒绝和 hold/CSI 拒绝。迁移代码时保留这些断言及原顺序预期。

在模块共享的 10 分钟本地验证预算内，复用匹配源码的 SDK 和 JDK 21/Maven 环境，运行受影响 Java 测试、Checkstyle 和最小子进程路径，并检查真实选中的报告。完整 MySQL 8.4、打包 Hosted/fault 恢复和 SpotBugs 仍需 CI 验收；fixture/H2 或测试 worker 子进程通过不构成这些结果。本次无 TypeScript/共享契约变化，不需要 JavaScript 构建。

验收要求：三个公共入口族委托给对应协作者；查询预留项与 cooldown 归同一持有者；协作者不访问 service 内部；唯一的取消分发动作显式传入；SQL/schema/公共契约无 diff；迁移算法语义不变；顺序回归与定向测试通过；双语文档及两轮干净自审完成。在被验收版本运行所需门禁前，CI 验收仍待完成。

## 风险与待定问题

主要风险是同步异常映射、完成顺序、guard 计数和跨代际路由改变。通过机械迁移和保留调用点包络降低风险，现有集成测试继续经公共服务门面验证它们。共享的不可变依赖直接传递，不隐藏在通用 context 对象中。

回调例外刻意限于取消的未发送分发分支；抽取整个 dispatcher 会扩大本次范围。没有待定产品决策。后续 dispatcher 抽取可在不改变取消语义的前提下，把该动作替换为具体协作者。
