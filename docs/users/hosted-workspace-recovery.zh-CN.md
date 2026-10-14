# Hosted Workspace 运维恢复

[English](hosted-workspace-recovery.md) | [简体中文](hosted-workspace-recovery.zh-CN.md)

本流程仅适用于原主机上的 Linux durable local-process worker 的 Hosted Shell 捕获不完整、Workspace 租约仍被占用的情况。`prepare` 与 `complete` 之间重启不会清除围栏；运维人员仍须核实所有潜在写入者已停止且不会重启，并通过 `complete` 提交证明。恢复后，新的 Session 可以使用该物理 Workspace；原 Shell 调用不会完成、重试或获得成功证明。

维护命令位于 `qwen-managed-agent-server-*-operator-recovery.jar`。在原 worker 主机上以服务的 OS 账号运行，使用服务原有的数据库配置、Runtime 凭据密钥和 `QWEN_MANAGED_AGENT_RUNTIME_STATE_DIRECTORY`。维护进程需设置 `QWEN_MANAGED_AGENT_RUNTIME_DURABLE_LOCAL_PROCESS=true`、`QWEN_MANAGED_AGENT_RUNTIME_PROVISIONER=local-process`、`QWEN_MANAGED_AGENT_RUNTIME_OPERATOR_RECOVERY_ENABLED=true`。保护数据库与凭据环境，并先执行服务数据库迁移。此命令不启动 HTTP 监听、调度器或 worker。

1. 从受影响 run 的 `runtime.runtimeBindingId` 和 `runtime.generation` 获取参数。若 run 记录不可用，授权 DBA 可只读查询 `qwen_runtime_binding` 中对应 `tenant_id`、`workspace_id` 的 `binding_id`、`runtime_generation` 和 `binding_state`；逐一 inspect 候选项，只采用租约和 Shell 捕获均匹配的记录。运行 `java -jar qwen-managed-agent-server-*-operator-recovery.jar inspect <bindingId> <generation>`。记录返回的 `holderKey`、Runtime Session、Shell 调用、`captureStatus` 和 `captureReason`。必须有已保存的 `producer_lost` Shell 结果及精确、仍被占用的 Workspace 租约。旧临时 worker、注册身份缺失或 holder 缺失时，不能通过补造身份记录修复。
2. 运行 `java -jar qwen-managed-agent-server-*-operator-recovery.jar prepare <bindingId> <generation> <holderKey> '<事故原因>'`。保存返回的 `recoveryId`。尚未失联或恢复阻断的 binding 成为 `OPERATOR_RECOVERY` 围栏；已经 LOST 的 binding 保持 LOST，并被排除在后台恢复扫描之外。Workspace 租约仍未释放。相同服务 OS 账号及原因的重试安全；记录的账号、原因、代数或 holder 不同则会被拒绝。另在事故记录中记录实际操作人员；`operator_id` 只标识运行命令的 OS 账号。
3. 停止原 worker，检查**所有**可能写入 Workspace 的进程，包括脱离父进程的子进程和外部监管器；阻止原 worker 与写入者重新启动，并确认它们已经停止。仅凭进程组死亡、管道 EOF、时间流逝或父 PID 消失均不足以证明静止。无法确认时停在此步，保持 Workspace 围栏。
4. 在私有 Runtime 状态目录的直接子路径创建普通、非符号链接的 UTF-8 JSON 文件，大小不超过 8 KiB，权限为 `0600`，恰好包含以下字段（替换示例值）：

   ```json
   {
     "version": 1,
     "recoveryId": "<recoveryId>",
     "verifiedAt": "2026-09-29T03:00:00Z",
     "method": "host inspection",
     "actions": "Stopped worker and detached writers; disabled their external restart source; verified no writer remains",
     "restartPrevention": true
   }
   ```

   `verifiedAt` 必须是不早于 `prepare`、且不超过维护主机当前时间五分钟的真实 UTC 核实时间。记录具体操作和阻止重启的依据；完成核实前不得写下该声明。证明文件及事故记录应保持私密。

5. 运行 `java -jar qwen-managed-agent-server-*-operator-recovery.jar complete <recoveryId> <absoluteEvidenceFile>`。命令核对保存的原 worker 身份；同次启动时核实其已退出，原主机重启后核实启动身份已变化。然后封存注册记录，持久保存不可覆盖的声明，并仅回收原 holder。崩溃或临时数据库失败后可用**相同文件**重试；更改声明会被拒绝。成功时输出 `completed`。

完成后新建 Session，验证其可以使用 Workspace。原回合应单独检查：部分输出和不确定副作用仍不确定，Shell 调用不会重放。不得手工清空 SQL 表或注册文件来绕过拒绝。如果原注册记录缺失、损坏，或 worker 属于旧临时模式，本流程不支持恢复；应带着已保存的证据升级处理，不能补造记录。

软件可核对已注册 worker 的身份和精确 SQL holder，但无法证明任意逃逸子进程全部停止。运维人员的声明是这一事实的信任边界。
