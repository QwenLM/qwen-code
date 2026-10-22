# Managed 检查点存储与运行中恢复阻塞

[English](2026-10-22-managed-checkpoint-recovery.md) | [简体中文](2026-10-22-managed-checkpoint-recovery.zh-CN.md)

## 问题与证据

较长的 Hosted Turn 会将已完成 Runtime 调用的收据累积进恢复检查点。这些条目是持久化的重复执行保护，必须保留。在 main 上的隔离复现中，73 次小调用完成后，下一份 `managed-checkpoint` 达到 65,776 字节，触发普通 HTTP 资源的 65,536 字节限制。现有检查点读取器已经支持最多 1 MiB。随后 Harness 报告没有活动 prompt 且恢复受阻，但 Java 消费端仍等待持续发送心跳的事件流。

## 决策

在 TypeScript 发布端、Java Session Store、工具发布引用和 CSI 原生回读授权中，将 `managed-checkpoint` 资源的预算对齐现有检查点解析上限 1 MiB。保留所有收据身份、ordinal、引用、摘要，以及现有资源和事务边界。其他普通资源保持 64 KiB。无需新增资源编码、数据库表结构、对象存储依赖或配置项。TypeScript 发布端超限错误写明资源类型、实际字节数与上限。

每 15 秒读取同一 tenant/session/generation 附着的状态，不受 opaque journal 控制记录续期影响。只有同时满足 `recoveryBlocked=true` 和 `hasActivePrompt=false` 才认定运行中的恢复阻塞。正常模型执行和审批等待继续保持活动。先消费并刷新已读取事件，再通过现有 transcript API 确认权威 journal 在已消费 cursor 之后没有待处理记录；探测后再次检查本地事件队列，让刚到达的完成事件优先。仅在当前 dispatch 租约约束下停放 Turn。保存具名的恢复阻塞错误，禁止重新 dispatch 执行和幂等命令重试。至少等待 15 秒后，调度器只可 claim 该 Turn，按原 epoch 和 cursor 只读观测状态与 journal；此分支不预热 Runtime、不接管执行、不提交输入，也不继续检查点。观察必须使用原有缓存附着，并让所有读取固定使用同一个 client；缓存缺失时不加载或接管 Session。缺失、不可读或世代变化的证据继续保持停放，不消耗执行重试预算。随后到达的权威终态事件可结算原 Turn。在此之前保留未结算输入、Runtime 所有权、策略变更屏障、生命周期屏障和子任务结果观察。一次阻塞采样本身不能关闭 Session，也不能将子任务结果认定为 unknown。显式取消仍可用。

WebShell 读取适配器将这个具名停放呈现为 `recovery_blocked`。浏览器通过现有 summary 轮询更新页面，不把事件流心跳当作业务进展。该 Session 禁止再次提交，保留取消能力。内部 Turn 仍为可取消、可恢复的活动记录；这项变更不伪造物理停止回执。

## 范围与发布顺序

本次修正有界的检查点预算并补上运行中阻塞观测，不建设通用大资源后端。超过 1 MiB 的检查点仍被拒绝，并应显示阻塞。先部署 Java 读取端，再让 Harness 发布超过 64 KiB 的检查点；旧 Store 仍会拒绝这些资源。现有资源和 journal 保持可读，SQL schema 不变。隔离验证通过前不重启用户预览。

## 验证与验收

使用微小工具输出复现原始拒绝，再让同一个 100 次调用的 fixture 完成，且不删除收据。验证冷加载、调用身份保持、超过 1 MiB 的拒绝，以及普通资源仍限制在 64 KiB。覆盖真实 Java 资源提交、读取和 reader 兼容性。

验证只有心跳的阻塞 Harness 能结束 Java 消费等待、持久化停放，并通过 WebShell 适配器和浏览器 provider 显示阻塞。正常的无活动 prompt 审批等待、活动模型执行、取消竞争与 dispatch 租约丢失均不得被误判。验证有界的重复观测能在不重放执行的情况下消费稍后到达的终态；证据不可读时继续停放且不消耗重试预算。执行相关 TypeScript 测试、build/typecheck/bundle、Java 验证、适用的 MySQL/Hosted 恢复检查和独立端到端验证，并明确记录环境中无法执行的门禁。
