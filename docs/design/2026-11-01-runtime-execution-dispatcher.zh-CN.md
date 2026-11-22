# Runtime 执行分发器状态归属

[English](2026-11-01-runtime-execution-dispatcher.md) | [简体中文](2026-11-01-runtime-execution-dispatcher.zh-CN.md)

- 状态：本地已实现，定向验证通过；完整 CI 验收待完成。
- 日期：2026-11-01
- 基线：`2aa908dc70785e38299a43964e064dbafaf7b878`，位于 #16029 之后。

## 问题与当前状态

执行流程已有明确持有者，但 `RuntimeBrokerService` 仍持有分发预留项、实际在途调用、分发租约续期及完成处理。取消流程接收在途集合和逐调用传入的 service 回调。如果只搬运 transport 调用，状态和清理决策仍会分散在多个持有者中。

本增量在现有 runtime-broker 模块内抽取一个 package-private 的 `RuntimeExecutionDispatcher`。保留当前算法、准入边界、同步异常、异步完成及关闭顺序，不修改公共 API、HTTP 路由、SQL/schema、配置、依赖或产品行为。

#16029 的早期完整门禁中，`WorkspaceCsiHostedFilesTest` 冷恢复用例在该任务进入 MySQL 集成阶段前失败，尚未完成根因定位。单独保留这份证据。开发本次抽取不代表已修复基线失败，也不代表已合并重构完成了完整集成验收。

## 归属与消费方

| 持有者                         | 职责                                                                                                                  | 直接消费方                                         |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `RuntimeExecutionDispatcher`   | 分发预留项、实际 invocation 集合、claim 到 EXECUTING 的转换、分发续租、transport 调用、v3 结果等待和持久 SSH 回执确认 | service 的 execution/start 与 drain 路径；取消流程 |
| `RuntimeExecutionState`        | 已有持久执行归属、带 fencing 的结算、UNKNOWN 转换和后台同胞行结算                                                     | 分发器及现有执行流程                               |
| `RuntimeExecutionCancellation` | 持久取消意图、物理取消和 prepared provider 确认                                                                       | service 取消门面                                   |
| `RuntimeBindingRegistry`       | 已有本地 Session context、路由身份和 Binding 失效                                                                     | service 与执行协作者                               |
| `RuntimeBrokerSupport`         | 已有共享规则，以及不变的 detached/no-start 回执投影和续租间隔计算                                                     | service 与分发器                                   |
| `RuntimeBrokerService`         | 公共准入及 payload/grant 校验、供应、Session/drain/stop 编排、共享关闭屏障、两个 executor 及 provisioner 生命周期     | 现有 adapter 与装配                                |

分发器借用现有 repository、Registry、执行状态、provisioner、transport、publication verifier、clock、租约/窗口参数、executor 和关闭屏障。依赖保持为显式构造参数，不增加通用 context 容器、接口或 Spring bean。

完整直接消费方清单为：service 的创建与两个 start 入口族、drain 确认扫描和关闭顺序；取消流程的两次 invocation 检查与未发送分发分支；测试辅助入口 `BrokerServiceTestAccess.pollDelay`。service 的其他回执路径通过 Support 继续使用共享的 `sshNoStartReceipt` 与 `isDetachedCapture` 投影。Repository 与 transport 契约保持不变。

## 分发准入与执行

将三个 `beginDispatch` 重载、`dispatch`、`enterExecuting`、reference/capture 投影及 `DispatchRenewal` 一起迁移。私有 CSI 限制、Harness 准入和 deferred payload 拒绝保留原先顺序，均在取得预留项之前执行。现有 Session context 锁区域继续位于调用方；分发器不为准入或分发新增锁。

预留 map 使用 `putIfAbsent`，同步失败和异步完成时使用 `remove(executionId, exactFuture)` 条件移除。它覆盖 claim/fencing，也覆盖实际调用。独立 invocation 集合只在续租开始后、调用 transport 前登记。取消通过 `isInvoking(executionId)` 观察该集合，不再接收可变集合。

保留 claim、带 fencing 的 EXECUTING 转换、owner/代际校验、可用租约校验、启动续租和 transport 调用的顺序。已取消但尚未发送的执行继续经原分发路径结算，不使用新的取消结算算法，也不重放 UNKNOWN 工作。

完成时先移除实际 invocation 标记，再持久化终态结果或 UNKNOWN。保留后台同胞行结算，以及持久写入之后 best-effort 的 SSH 确认。transport 失败、空结果或普通结算异常继续映射为 UNKNOWN。同步 `RuntimeBrokerException` 原样保留；其他同步运行时/JVM 失败保留 `runtime_execution_dispatch_failed` 包装及预留项清理。

## V3 结果与 SSH 确认

v3 结果等待属于分发调用闭包，原样迁移。保留 publication 证据优先读取、dispatch/Binding 身份校验、租约/截止时间拒绝、显式 `not_started`、detached 结果、不可重试错误处理，以及从 100 ms 翻倍、上限 2 s 的退避。仅供测试的退避访问器改为引用新持有者。

将 `acknowledgePersistedTools` 迁入分发器，因为分发完成和 service 的 drain 扫描都消费它。drain 与物理 Runtime stop 仍由 service 编排。共享且无状态的 `sshNoStartReceipt`、`isDetachedCapture` 和 `renewalDelayMillis` 迁入已有 Support，不复制规则，也不新增协作者。

## 取消与关闭

取消接收具体分发器，将直接读取 invocation 集合改为 `isInvoking`，将 `BiConsumer` 回调改为 `beginDispatch(context, requested)`。归属读取、持久意图、准入拒绝、control guard 和物理取消顺序保持不变。

service 继续是 `closed` 的唯一写入方，并持有两个 executor 和 provisioner。关闭顺序保持为：设置关闭屏障；取消 Registry 操作；取消分发预留 future；取消对账操作；关闭协调与续租 executor；关闭 provisioner。

`cancelPendingOperations` 只取消已有预留包装 future，不取消底层 transport stage，不清空实际 invocation 标记，也不关闭借用资源。不给 `beginDispatch` 增加新的关闭检查；改变已准入操作的处理方式超出本次抽取范围。

## 文件与迁移

新增 `RuntimeExecutionDispatcher`；更新 service 构造与委托、取消流程、共享 Support，以及仅供测试的退避访问器。新增分发器定向测试，保留现有 service、HTTP、SSH 和协议回归。为执行流程文档的两种语言加入本设计链接，同步更新当前状态归属说明。

基线 dry-run 后开始实现：迁移状态与完整分发闭包；在取消流程之前装配分发器；替换全部直接消费方；更新测试及双语设计。保持机械迁移，审阅完整 diff，检查是否意外改变算法或异常边界。

## 验证与验收

遵循 `packages/managed-agent-server/AGENTS.md`，包括共享的 10 分钟本地验证预算、JDK 21、匹配源码构建的 SDK 和隔离 Maven 仓库。内部 Java 抽取没有有效的全局 CLI 行为探针：只记录已安装 `qwen --version` 作为环境证据，通过现有 Java fixture 建立基线。所选 fixture 不需要模型调用或 JavaScript 构建。

定向计划记录在 `.qwen/e2e-tests/runtime-execution-dispatcher.md`。固定预留去重、同步失败清理、在结算/UNKNOWN 之前移除 invocation，以及关闭时保留底层调用与借用资源。复用 `RuntimeBrokerServiceTest`、`RuntimeSshAcknowledgementTest`、`Issue13183RegressionTest` 和 `RuntimeBrokerHttpServerTest` 覆盖取消/fencing、v3/私有 CSI、回执及 HTTP 集成行为。执行编译、两组 Checkstyle 和选定测试，检查实际报告数量及跳过情况。

基线选定的 280 个测试通过。抽取后，同一批测试加上五个分发器用例，共 285 个测试通过，无失败、错误或跳过；两组 Checkstyle 均通过。验证在 macOS 上使用 JDK 21、匹配源码的 SDK 和隔离 Maven 仓库。环境准备、首次无用 import 的 Checkstyle 失败及修正后验证共使用本地共享预算 252.587 秒。取消用例证明实际调用及借用资源得到保留；包装 future 的准确取消动作通过源码等价核对确认，不新增访问私有状态的测试入口。

验收要求：分发状态只有一个持有者；取消没有 service 回调或可变 invocation 集合注入；公共契约/schema 与分发算法不变；关闭/完成顺序不变；定向回归通过；双语设计同步；两轮干净自审。完整 MySQL 8.4、打包 Hosted/fault、跨平台及完整 SpotBugs 门禁继续由 CI 负责。本地 fixture 不构成这些结果，单独一次通过也不能消除此前更广范围的失败。

## 风险与待定问题

主要风险包括 invocation 标记与结算顺序改变、预留清理改变、丢失原代际路由、改变 v3 截止时间/回执优先级，以及接管 executor/transport 的取消。保留方法实现与调用方锁区域，再使用现有行为测试和新增持有者测试验证。

没有待定产品决策。进一步的供应、Session 生命周期或持久化抽取不在本增量内。未解决的基线冷恢复失败继续作为独立排查项和验收缺口保留。
