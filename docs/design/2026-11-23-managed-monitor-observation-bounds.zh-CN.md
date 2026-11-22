# Managed Monitor：有界观测窗口

[English](2026-11-23-managed-monitor-observation-bounds.md) | [简体中文](2026-11-23-managed-monitor-observation-bounds.zh-CN.md)

状态：针对 #18073 的提案，覆盖两条 Managed Monitor lane。

## 问题

`HostedMonitorLoop` 和 `WorkerMonitorPolicy` 都会把一个去抖窗口内输出的所有行聚合为一条观测和一条通知。`max_events` 只限制窗口数量，不限制单个窗口的行数或字节数。

resident lane 因此可能产生任意大的持久化观测、外部存储依赖和模型输入回合。worker lane 还会携带两份行内容，一份直接位于 observation entry，另一份位于 base64 `managed-input` 通知。超大的首条 entry 无法被 batching 拆分，会被 512 KiB delivery request 守卫拒绝，后续包括 terminal 在内的 entry 全部堵在后面。

## 目标

- 两条 lane 使用同一套行数和 UTF-8 line-text 字节规则。
- 保留原始行顺序，并在截断时追加一条准确的省略标记。
- 持久化观测与通知使用完全相同的有界行内容。
- 包括 JSON 转义、XML 扩张和 base64 编码后的 XML-heavy 内容在内，worker observation entry 均满足 delivery request 上限。
- 周期 flush 和退出 flush 都保持观测序号、通知节奏、配额记账和结束行为不变。

## 非目标

- 不修改去抖时间、flush 前的缓冲、`max_events`、partial-line 上限、通知单行截断、Store 行为或公开配置。
- 不把大窗口拆成多个观测，避免更快耗尽配额并改变通知节奏。
- 不把本地测试表述为真实模型、外部 managed service 或生产 watch 验证。

## 设计

共享的 `boundMonitorObservationLines` 接收一个窗口，最多返回 1,000 行，包括可选的省略标记。原始 line-text 总预算为 32 KiB，包含换行分隔符和标记。

窗口已经同时满足两个限制时，内容保持不变。否则，helper 保留由完整原始行组成的最长合法前缀，不切断任何原始行或多字节字符。最后一项为 `... N more lines omitted`，`N` 是未保留原始行的准确数量。单行本身超过预算时整行省略。

`HostedMonitorLoop.flush` 只调用一次 helper，所得数组同时传给 `monitors.observe` 和 `buildMonitorNotificationInput`。`WorkerMonitorPolicy.flush` 在构造通知资源并调用 `enqueueObservation` 前应用同一个 helper。XML 转义、显示控制字符净化和观测数据结构保持不变。

32 KiB 预算特意为 worker 的两份表示留出空间。原始行在 observation 中经过 JSON 转义，通知内容经过最高六倍的 XML 扩张后还要 base64 编码。64 KiB 方案虽然通过纯文本回归，却在引号密集内容下仍产生 651,558 字节请求。收紧后的共享预算覆盖这种输入，不再只按纯文本 sizing。

这些常量是内部实现限制，不新增操作者配置。

## 边界情况

- 空窗口和已经满足限制的窗口保持原内容。
- 标记同时计入 1,000 行结果上限和 32 KiB 原始 line-text 预算。
- 字节预算使用 UTF-8 字节长度，不使用 JavaScript 字符串长度。
- 无论由哪个限制引起，标记都统计全部未保留原始行。
- 已有小观测、通知标签、wake 关联和配额结束行为保持不变。

## 验证

helper 测试覆盖小窗口不变、精确行数和字节边界、按行数截断、多字节 UTF-8 文本，以及单行本身超预算的情况。

resident 测试使用 fake executor、manual clock、实际 session authority 和本地 resource store，独立覆盖周期 flush 与退出 flush。检查观测与通知内容一致、省略数量准确、字节上限和每个原始窗口只消耗一个观测序号。

worker 测试驱动真实 `WorkerMonitorPolicy` 并检查 staged delivery entry。纯文本和 XML-heavy 用例断言序列化请求上限、观测与通知同源、准确省略数量和原始字节上限。另一组真实 publisher 与 applier 路径分别运行小窗口和超大窗口，验证观测只提交一次且 monitor record 最终落定。

原始纯文本回归产生 1,426,041 字节请求，超大 applier 用例的 observation sequence 停在零。第一版 64 KiB 实现也在 XML-heavy 用例中以 651,558 字节失败。最终共享实现通过三个聚焦文件的全部 65 项测试。仓方类型、格式、lint 和 diff 检查结果随 PR 证据记录。

## 验收标准

- 两条 lane 的每条观测最多 1,000 行，原始 line-text 最多 32 KiB。
- 截断窗口只有一条准确的省略标记，不含被切断的原始行。
- 观测与通知包含相同的有界内容。
- 纯文本和 XML-heavy worker entry 均满足 delivery request 上限，超大 applier 用例正常落定。
- 周期 flush 与退出 flush 保持原序号、配额和结束行为。
