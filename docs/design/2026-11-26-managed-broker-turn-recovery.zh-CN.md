# Broker 故障转移后接续活跃 Managed Turn

[English](2026-11-26-managed-broker-turn-recovery.md) | [简体中文](2026-11-26-managed-broker-turn-recovery.zh-CN.md)

## 范围

两个 Java 副本共享 MySQL，各自运行内嵌的 Runtime Broker。第一个副本故障后，Hosted Harness 与原 Runtime Worker 继续运行。验收用例使用持久化本地 Worker 执行文件编辑。

## 恢复

当新 Broker 尚未接管 Runtime，Prompt 因此挂起时，常驻 Harness 记录该 Prompt 的工具恢复阻塞。驱动前的瞬时读取故障保留该阻塞，供后续重试。主动 `/load` 将工具结果写入日志，并确认当前仍待结算的 Prompt 和 checkpoint 在当前 activation 下可续跑后，解除该阻塞。`recoveredTurn` 保留原 Prompt，直到现有的续跑接口受理它。若续跑中的工具再次遇到同类 Broker 拒绝，后续主动 `/load` 可恢复原 Turn 并重新受理续跑。Writer、清理和取消相关的阻塞继续由各自的恢复流程处理。

Broker 在接管时首次查询 Worker，可能看到执行仍在进行且结果尚不可用。后续轮询由其他 Broker 持有的执行时，复用现有恢复路径查询原 Worker。并发请求共享同一次查询，连续请求复用现有限频机制。一轮轮询等待两秒后返回当时读取的执行记录，共享查询仍可完成，并将经验证的结果结算到原记录。仍在执行、暂不可达或证据无效时继续等待结算。恢复沿用执行 ID 和 dispatch generation，只向 Worker 发状态查询。

## 验收

Worker 进入编辑工具后终止 Java A。验证立即切流，以及 Worker 保持暂停、Java B 接管原 Runtime 后再切流。两种场景都要只提交一条工具结果、把它交给模型、在原 Turn ID 下生成最终回复并完成，而且文件只被修改一次。同时验证其他原因阻塞的续跑仍会被拒绝。
