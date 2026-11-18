# Managed 挂起有界恢复（待解决问题 8）

[English](2026-11-18-managed-suspension-bounded-recovery.md) | [简体中文](2026-11-18-managed-suspension-bounded-recovery.zh-CN.md)

状态：解决[无状态 Hosted Harness 设计](2026-11-16-managed-stateless-harness.zh-CN.md)的待解决问题 8。日期：2026-11-18。已在第一阶段 PR（#17690）实现。无 schema 或 Store 协议变更。

## 1. 问题

挂起 teardown 在重试上限处失败或结果未知时，是否必须由运维恢复 Session，还是现有 Store 协议能保证有界自动恢复？设计提示的障碍：相同 Harness boot id 的新 client 不能充当后继 fencing 证明，因为租约存活时同写者 acquire 续租同 generation。

## 2. 证明

`JournalWriterLifecycle.acquireWriter` 仅在 head 为 ACTIVE **且写者租约未过期**（`writerLeaseUntil.after(now)`）且 writer id 与 token 匹配时续租同 generation。租约一旦过期，任何 acquire——包括相同 boot id 与 token——都落入 generation 递增分支。`sealWriter` 按 generation fencing，故携带旧 generation 的 seal 在任何后继 acquire 后被拒。

重试上限处挂起驱动器不再发起 seal 尝试，blocked 分支停止续约。闸门拒绝本 Harness 自身的 load，故租约存活期间无同进程 client 能 acquire。经过超过写者租约加 Store 请求超时的有界等待后：

1. 写者租约已过期（续约已停），且
2. 上限处尝试的在飞 seal 请求已超时，无旧 seal 仍在飞。

此后任何 acquire 都 bump generation 并 fence 旧 seal。head 处于三种状态之一，均安全：

- **旧 generation SEALED**——teardown 自己的 seal 已提交；完成。
- **generation 已推进**——后继已 fence 旧 seal。
- **旧 generation ACTIVE、租约过期**——下一次 acquire（含本 Harness 冷打开）bump generation 并 fence 旧 seal。

因此闸门可在边界后自动清除；下一次 load 安全冷打开。资源义务（Runtime 租约、cleanup debt、owners）由 load 既有 takeover/cleanup 路径对账——与设计「挂起过程中 Harness 崩溃」故障模式同形。仅当 Store 持续不可达时才需运维，那表现为 load 自身的暂时性 Store 失败，而非挂起闸门拒绝。

设计的障碍仅适用租约存活期；有界等待先使其过期，故障碍不阻挡证明。

## 3. 行为

- capped uncertain teardown 时 Harness 停流停续约，保持闸门 **blocked**（以 `hosted_session_teardown_blocked` 拒绝 load），并在 `HOSTED_SUSPEND_RECONCILE_MS`（候选 65s = 60s 写者租约 + 超过 30s Store 请求超时的余量；启用前对照真实 Store 超时验证）后调度闸门清除。
- 边界后移除闸门 entry（若仍 blocked 且未被复用）；下一次 load 冷打开。`reconciledGates` 计数记录自动恢复。
- 控制面对 `hosted_session_teardown_blocked` 的分类不变（拒绝，非免预算等待）：teardown 楔住的 Turn 以该码失败；Session 本身为后续请求恢复。Session 级恢复自动；在飞 Turn 是楔住 teardown 的代价。
- 闸门清除时 Store 仍不可达，则冷打开以暂时性 Store 错误失败并重试至 Store 恢复；闸门本身无需运维。

## 4. 测试

- reconciliation 等待期间，load 与读遇到 `hosted_session_teardown_blocked`；闸门不被静默移除。
- 边界后闸门自动清除（`reconciledGates` 递增），后续 load 不再被闸门拒绝。
- 持续 Store 不可达在闸门清除后仍表现为 load 失败（非闸门拒绝）。
- 干净挂起→冷打开路径不变。

## 5. 边界

- reconcile 等待是候选常量；与空闲周期、冷打开上限一样启用前由测量验证。它必须超过写者租约加 Store 请求超时。
- 本补篇解决 Session 级恢复问题；不改变控制面 Turn 分类，不新增回执。
