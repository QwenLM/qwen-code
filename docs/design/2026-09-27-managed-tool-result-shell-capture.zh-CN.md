# Managed Tool Result 前台 Shell 捕获（O1c）

[English](2026-09-27-managed-tool-result-shell-capture.md) | [简体中文](2026-09-27-managed-tool-result-shell-capture.zh-CN.md)

## 状态与问题

本文设计在 [O1a 契约](2026-09-26-managed-tool-result-contract.zh-CN.md)及 [O1b 本地存储](2026-09-26-managed-tool-result-local-store.zh-CN.md)之后实现 O1c 本地基础能力。Shell 目前默认最多保留 64 MiB 原始输出。最终工具文本已经过解码、格式化和截断。该文本及其溢出文件都不能证明 100 MiB 进程输出仍可读取。目前还没有 Tool v3 路由、Session 回执消费者或生产可用的本地 Managed Harness 工具循环。

## 范围与归属

首版以 `process_pipes` 和 `complete_required` 捕获前台 Shell。本地测试宿主在同一进程注入 Session 所有的发布器和 worker 处理器，并运行真实 Shell 子进程。已有 Session writer lease 由宿主持有，同时传给 `openManagedSession` 和 O1b writable store，不重新获取 lease。未注入发布器的生产 worker 在工具产生副作用之前拒绝 v3。本轮包含 Java v3 客户端与 TS/Java 互通；生产 Broker 选择、独立进程发布通道和产品 Managed 工具循环留待后续。PTY、后台执行、公开的区间读取与下载路由、远程存储、配额和自动 GC 均不属于 O1c。

O1b 的 Session 分段目录是捕获字节的唯一持久副本。发布的分段、page 和 manifest 在 Session 生命周期内保留，包括 ACK 之后。每段获得发布回执后，Runtime 内存可复用该 Buffer；committed ACK 允许释放临时捕获状态，不删除保留字节。

## 捕获与发布

每次调用的独立 sink 在解码、二进制检测、渲染或预览截断前接收 stdout/stderr 的 Buffer。只有该调用的主命令接收 sink。v3 前台 Shell 明确使用 pipes。各条流分别保持字节顺序，manifest 不承诺跨流总顺序。普通 CLI 与 v2 行为保持现状。

内部默认值是 1 MiB 分段、每条流最多一个在途发布操作、两条流合计 64 KiB 原始预览缓冲。pipe 在 chunk 进入有界 sink 时同步暂停，收到发布回执后恢复。生产方不得向 O1b 无限排队。发布器根据回执构造有界 page，只产生一个 revision 1 的最终 manifest，并按 O1a 校验 page 和 manifest 实际序列化大小。正常写入不逐段查询 `prefix()`。空输出产生 sealed 的空 stdout/stderr 描述。经过格式化的 Shell 溢出文件仅能作为单独验证的 result 表示复用，不能证明原始 stdout/stderr 完整。

只有观察到 EOF 且所有已接受写入完成后才能 seal。现有退出后 1 秒排空上限用于等待 pipe EOF，不计入因持久化而暂停的时间。继承的未关闭 pipe 超时后产生不完整捕获。取消作用于进程，但已接受的写入仍要排空。存储拒绝或 I/O 失败会锁存捕获故障、停止发布新分段和 page、继续有界排空 pipe，并保留原始进程执行结果。如果 Session 资源仍可写，仍可用 unavailable manifest 记录该结果。完整捕获配短预览只设置 `previewTruncated`，不改变 `captureStatus` 或 `upstreamTruncated`。最终 partial/unavailable 结果不能再升级。

## 原始回执与恢复

宿主校验前台准入、Session 和 Workspace activation，以及完整的原始执行身份。注入的发布器单独固定 Runtime Session ID 和 Managed Session ID，在派发前拒绝其他 Runtime Session。宿主在派发前提交原始调用意图和 `await_runtime` 边界。分段、seal、page 和最终 manifest 持久化后，Session owner 验证完整身份、资源摘要、page 布局和捕获完整性。身份包括 tenant、Managed Session、turn、execution call、模型 call、原始 args digest、binding generation、capture ID 和 revision。

版本化 `toolOutcomeRef` 保存原始物理执行结果、最终 envelope 与 manifest 引用，以及 committed/blocked 接纳决定。可信入口对原始执行幂等追加一条 `tool.receipt`。其数值 `historyRevision` 是该回执事件的正整数 Session sequence，重放时不变。blocked 事件使用 `resultRef: null`，其 ACK 的 `historyRevision: null`；committed ACK 使用持久保存的 sequence。仅存在回执不足以让模型继续：只有经过验证的 committed 决定才能推进 `results_ready` 和模型消费。匹配的 committed ACK 后才能释放 Runtime 临时捕获状态；改变后的 ACK 发生冲突。

重试先查询原已提交回执，返回完全相同的引用和事件 sequence。因此提交成功但应答丢失不会重新发布一个不同 UUID 的 manifest。回执提交后、checkpoint 前中断时，从原回执推进；checkpoint 后、ACK 前中断时，重发相同 ACK。替换后的 activation 不能从旧的 `await_runtime` checkpoint 再次准备执行。生产方在 EOF 前停止时，仅保留已验证前缀。只有 manifest 而没有权威回执映射时阻断恢复；孤立文件不能证明接纳。物理执行结果未知时保持阻断恢复，绝不伪造成 settled success/error，也不重新执行。

## 协议与生命周期

Tool v3 按 O1a 实现 execute、status、cancel 和 acknowledge 路由，遵守 bearer/lease 身份、封闭请求体、no-store 响应头与大小上限。已准入捕获的调用始终使用 v3，不回退 v2。v2/v3 共用原始调用冲突保护。未启动的 v3 prepared cancellation 使用 `executionStatus: not_started` 和 `capture: null`。Java 客户端显式提供 v3 操作，本轮不修改生产 Broker 对 v2 的选择。

本地宿主依次停止新请求、排空执行与回执完成工作、关闭分段 store、停止 Session renewal、释放 activation，并封存现有 writer 以交接。失去 writer 所有权后不能继续发布。现有本地 lease 恢复规则可以回收已死亡进程的 writer；进程死亡本身不证明工具结果已获接纳，也不证明完成了正常交接。替换后的进程可以从保留存储读取已提交结果；不完整或没有回执的执行继续阻断。

## 验证与验收

使用真实文件和 Shell 子进程，并以持有现有 Session lease、真实 authority 与 Tool v3 处理器的子进程作为测试宿主。增量生成 100 MiB，不构造完整输出 Buffer；宿主替换后比较长度、摘要及尾部范围。以 1 GiB 生成和慢发布器验证在途内存有界。覆盖二进制/NUL/无效及跨 chunk UTF-8、分流、空输出、延迟 EOF、继承 pipe、取消，以及产生副作用标记后的磁盘故障。测试回执/ACK 丢失窗口、身份与 ACK 不匹配、v2/v3 冲突、v3 未启用、activation 丢失及 lease/关闭顺序。运行 Java/TS v3 互通和既有 v2/W0c 测试。这些本地测试通过不代表 Hosted 工具循环已发布或支持跨主机恢复。
