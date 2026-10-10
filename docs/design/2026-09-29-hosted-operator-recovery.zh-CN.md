# Hosted Shell 运维恢复

[English](2026-09-29-hosted-operator-recovery.md) | [简体中文](2026-09-29-hosted-operator-recovery.zh-CN.md)

状态：[#12904](https://github.com/QwenLM/qwen-code/issues/12904) 的实现设计。依赖 [W0e-3](2026-09-28-local-reboot-recovery.zh-CN.md)。

## 问题与支持边界

后台 Shell 子进程可能在主进程退出后继续持有捕获管道。结果为 `captureStatus=partial`、`captureReason=producer_lost`；Hosted 回合保留 Workspace holder，因为主进程退出、杀死原进程组和管道 EOF 均不能证明逃逸写入者已停止。保存的工具执行与 Hosted 回执保留不完整结果。同一存储上的其他 Session 收到 `workspace_busy`。

本恢复路径仅适用于原主机上的 Linux durable `local-process` worker（默认模式），要求原始 version-2 注册记录、seed、lease 和精确的 Workspace holder。准备后原主机重启也可完成恢复：启动身份变化能证明原 worker 不再运行，却不能代替运维人员核查所有潜在写入者和重新启动来源。旧临时 worker 无法事后补造这些身份。运维人员负责确认旧 worker 与所有潜在 Workspace 写入者已经停止且不会重新启动；软件验证原 worker 身份与退出，但无法找全任意脱离关系的子进程。错误的人工声明不属于本契约的保证。

## 本地维护协议

独立的 `operator-recovery` 服务制品提供命令行入口；其应用上下文不开放 HTTP、不启动 worker、不运行定时恢复或 Flyway 迁移。它读取现有数据库、凭据密钥和私有 Runtime 注册目录。`operator-recovery-enabled` 默认关闭。不更改产品路由、公共能力或 Shell 协议。

`inspect <bindingId> <generation>` 读取保存的 holder、原 Shell 已结算结果及精确的本地 durable 注册记录，返回 binding、Runtime Session 与 Shell 调用标识、holder 哈希、`captureStatus`、`captureReason`、准备资格和已有恢复 ID；不打印调用参数、输出或凭据。记录缺失或身份不符时拒绝。`prepare` 在设置围栏前再次只读核对注册记录。

`prepare <bindingId> <generation> <holderKey> <reason>` 先取得租户 placement 锁，再在同一事务中为精确 holder 保存唯一审计操作，并将 READY、DRAINING 或 RECOVERY_BLOCKED binding 置为 `OPERATOR_RECOVERY`。已经 LOST 的 binding 保持原状态和失联证据，未完成的审计记录将其排除在后台恢复扫描之外。准备操作清除现有短期 claim、递增 claim 代数，阻止旧 Broker 回调将 binding 恢复为 READY。新准入、普通释放和 placement 替换继续被阻止。holder 仍保留。重复的完全相同请求返回原 recovery ID。

受管 `LOST`、`RECOVERY_BLOCKED` 和仍未回收的 `FAILED` binding 在运维准备恢复之前，也会阻止同一 storage ID 或规范化目录的替换。这是刻意的安全边界：重命名 Workspace 不得绕过仍可能存在的物理写入者。Broker 扫描恢复候选时读取共享审计表；若迁移缺失，会拒绝扫描，而不会在看不到运维围栏时继续自动恢复。服务迁移与独立 Broker schema 都创建该表。

运维人员停止旧 worker，核实所有潜在写入者和重新启动来源。证明文件是管理员拥有的 Runtime 状态目录中的私有 0600 UTF-8 JSON 文件，大小不超过 8 KiB，包含 version 1、recovery ID、不早于 `prepare` 的核实时间、方法、具体操作和 `restartPrevention: true`。文件内容及摘要保存在审计行中；之后提交不同内容会被拒绝。

`complete <recoveryId> <evidenceFile>` 在永久跨进程锁下核对原代数及注册记录，要求同次启动中的原进程身份已消失，或原主机的启动身份已变化，然后持久封存注册记录。准备后的恢复围栏跨重启保留；只有携带运维证明的显式命令可完成它。提交运维证明后，为原始写入域记录 `JOURNAL_LOST` 和 `WRITERS_STOPPED`。状态转换及后续清理由共享 owner 的短期 claim 保护。随后复用 W0e-3：保留 SETTLED 结果、不重放未知执行，将未知执行终结为 ABANDONED，仅条件清理原 holder，释放 Runtime Sessions 并退休代数。每个步骤的崩溃均留下仍被围栏保护或已精确清理的状态，待先前 claim 到期后可用相同命令安全重试。即使已完成，提交不同证明的重试也会被拒绝。旧恢复操作不能清除新 holder。

原 Hosted 回合保持恢复阻断。恢复成功只允许同一 Workspace 的新工作；它不证明旧调用的输出完整或文件已持久落盘。

## 存储与失败规则

每个 binding 代数只有一条审计记录，保存 recovery ID、原 holder 与 storage 哈希、Runtime Session 和 provision 身份、Shell 执行引用、操作人、原因、UTC 时间、证明及完成标记。准备阶段的围栏和审计插入同属一个 SQL 事务。SQL 事务不跨主机观察。缺少证明、身份不符、原进程仍存活、本地记录不确定或数据库失败时继续占用 Workspace。只有带持久停止证据的精确原 `LOST` 代数可以执行 W0e-3 holder 清理。

## 验证

用真实 Broker、worker、SQL Store 和两个 Session 触发后台 Shell 捕获不完整，核对持久 `producer_lost` 原因、已接收输出前缀以及第二个 Session 的 `workspace_busy`。主进程退出、杀原进程组、管道 EOF 或等待都不能自动解锁。让真实逃逸写入者持续写标记文件时，系统保持围栏。运维核实静止后，`complete` 允许新 Session 工作，旧调用不重放。在 `prepare` 与 `complete` 之间重启原主机，验证围栏仍在，提交新的运维证明后可完成。覆盖两个 Broker、迟到回调、授权撤销、产品 Session 删除、claim 过期及每个持久步骤的崩溃。运行 H2 合约、真实 MySQL 与 MariaDB 的迁移和执行测试；原生 Linux 物理验证与可移植进程测试分别报告。
