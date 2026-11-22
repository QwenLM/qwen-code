# Resident Managed Monitor：有界观测窗口

[English](2026-11-22-resident-monitor-observation-bounds.md) | [简体中文](2026-11-22-resident-monitor-observation-bounds.zh-CN.md)

状态：针对 #18073 的提案，仅覆盖 resident lane。

## 问题

`HostedMonitorLoop` 将一个去抖窗口内输出的所有行聚合为一条观测和一条通知。`max_events` 只限制窗口数量，不限制单个窗口的行数或字节数。高频日志因此可以产生任意大的观测、外部存储依赖和模型输入回合。

## 目标

- 按保留行数和 UTF-8 line-text 字节数约束每条 resident 观测。
- 保留原始行顺序，并在截断时追加一条准确的省略标记。
- 持久化观测与通知使用完全相同的有界行内容。
- 周期 flush 和 watch 退出时的最终 flush 都应用同一规则。
- 保持观测序号、通知节奏、配额记账和结束行为不变。

## 非目标

- 不修改 #17953 的 worker-owned lane。
- 不修改去抖时间、`max_events`、partial-line 上限、通知单行截断、Store 行为或公开配置。
- 不声称 64 KiB line-text 预算能够证明 JSON envelope 或其他传输编码的最坏尺寸。

## 设计

共享 resident helper 接收一个窗口，最多返回 1,000 行，包括可选的省略标记。line-text 总预算为 64 KiB，包含换行分隔符和标记。

窗口已经同时满足两个限制时，内容保持不变。否则，helper 保留由完整原始行组成的最长合法前缀，不切断任何行或多字节字符。最后一项为 `... N more lines omitted`，`N` 是未保留原始行的准确数量。单行本身超过预算时也整行省略，因此结果可以只有标记。

`HostedMonitorLoop.flush` 接管缓冲区后只调用一次 helper，所得数组同时传给 `monitors.observe` 和 `buildMonitorNotificationInput`。XML 转义与显示控制字符净化仍由通知层负责，观测的数据结构不变。

这些常量是内部实现限制，不新增操作者配置。大窗口不拆成多个观测，因为拆分会更早耗尽观测配额并改变通知节奏。

## 边界情况

- 空窗口和已经满足限制的窗口保持原内容。
- 标记同时计入 1,000 行结果上限和 64 KiB line-text 预算。
- 字节预算使用 UTF-8 字节长度，不使用 JavaScript 字符串长度。
- 只有完整原始行中的多字节字符才会保留。
- 无论由哪个限制引起，标记都统计全部未保留原始行。
- 已有小观测、通知标签、wake 关联和配额结束行为保持不变。

## 验证

单元测试覆盖小窗口不变、标记计入行数预算、多字节文本的 UTF-8 字节截断，以及单行本身超预算的情况。

真实 `HostedMonitorLoop` 测试使用 fake executor、manual clock、实际 session authority 和本地 resource store，分别验证周期 flush 与退出 flush。检查观测与通知内容一致、省略数量准确、字节上限和每个原始窗口只消耗一个观测序号。

仓库检查包括聚焦 Vitest、构建、TypeScript 检查和变更文件的格式与 lint 检查。不需要真实模型、外部 managed service、凭据或危险 watch 命令。

## 验收标准

- 每条 resident 观测最多 1,000 行，line-text 最多 64 KiB。
- 截断窗口只有一条准确的省略标记，不含被切断的原始行。
- 观测与通知包含相同的有界内容。
- 周期 flush 与退出 flush 都只消耗一个观测修订，原结束行为不变。
- worker lane 与公开配置不变。
