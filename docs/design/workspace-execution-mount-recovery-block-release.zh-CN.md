# 恢复阻塞 Hosted Workspace 轮次的挂载释放

[English](workspace-execution-mount-recovery-block-release.md) | [简体中文](workspace-execution-mount-recovery-block-release.zh-CN.md)

## 状态与范围

已实现并在本地验证。本切片终结 [#13800](https://github.com/QwenLM/qwen-code/issues/13800) 的跨会话楔死：进入 recovery-blocked 的 Hosted Workspace 工具轮归还其 Workspace 执行挂载，使同一 `(tenantId, storageId)` 上无关会话的后续工具轮得以继续，而不是在 `409 workspace_busy` 上永久停摆。不在范围内：A1 本身（[#13533](https://github.com/QwenLM/qwen-code/issues/13533)，修复在飞为 [#13789](https://github.com/QwenLM/qwen-code/pull/13789)）、Hook lane 的共享 acquisition 与 MCP lane 的会话级挂载（各自保有释放纪律）、daemon 死亡残留（LOST 族既有清扫，#12670 族），以及启用 `monitor_run` 或 `child_run` 的 `shell` kind。

## 问题与被点名的机制

一个 `recovery_blocked` 会话楔死了同一 daemon 上其他会话的后续轮次：journal 停在 `hostedModelAttempt` 之后、`commitMessage` 之前，模型再未被调用，没有错误、没有终态事件。运行时见证把机制隔离了出来（`.qwen/issues/issue-13800.md` 复现报告）：

1. 每个 Workspace 工具轮的 broker acquire 经过 `WorkspaceRuntimeTransport.acquire` → `WorkspaceExecutionStore.claim`，在 `managed_workspace_execution_lease` 为每个 `(tenantId, storageId)` 管理一行租约；`holder_key` 记录持有的 Runtime Session。
2. 该租约只由结算路径上 `finish()` 的完整 `release()` 释放。进入 recovery-blocked 的轮次（outcome 未知、「阻塞、绝不重放」契约）在任何释放之前抛出 `HostedToolRecoveryRequiredError`——租约被一个按契约永久 park 的轮次永远持住。
3. 同一 storage 上每个后续工具轮都在 `409 workspace_busy`（`retryable: true`）上空转，没有错误、没有终态事件；没有 prompt deadline 时（默认即没有），空转无界。只删租约行就在一秒内让已停摆的轮次恢复，而被阻塞会话仍保持阻塞——耦合恰好是租约行，范围是 `(tenantId, storageId)`。

## 修复

被阻塞的轮次归还挂载——绝不归还 Runtime Session：

- 新增 broker 内部端点 `POST /tool-sessions/{runtimeSessionId}:release-mount`。`RuntimeBrokerService.releaseMount` 只解析驻留的 Session Context（死亡 Daemon 的残留归 LOST 族的清扫），校验 Harness 身份，并在该 Session 有活动操作时以 `409 runtime_session_busy` 拒绝——一切未结算行都算，背景进程也算：drain 的排除集之所以存在，是因为它有先停掉或结算的 sweep，而这条路径不跑 sweep。门禁读取的是检查时刻 broker 已登记的状态；它不为晚一瞬到达的违约并发准入设防。`RuntimeTransport.releaseMount` 默认失败关闭；只有 `WorkspaceRuntimeTransport` 实现它：`WorkspaceExecutionStore.release` 清空持有者列。Runtime Session 行保持 `READY`，绝不 `RELEASED`——恢复舰队保留其可收养身份（`release` 会永久落 `RELEASED`，绝不能在这里运行）。
- Daemon 侧，`executeHostedTurn` 捕获三个 recovery-required 错误，在重抛前调用工具轮新增的 `releaseForRecoveryBlock()`；阻塞判定本身不变。`releaseForRecoveryBlock()` 镜像 `finish()` 的 lane 条件——只覆盖 plain lane（`broker.acquire()`），不碰 Hook lane 的共享 acquisition 与 MCP lane 的会话级挂载——并调用新增的 `HostedWorkspaceBroker.releaseMount()`。归还也在没有 acquired 标记时运行：应答在 Broker 已提交 claim 之后丢失时，挂载与正常获租时一样被持住，而存储按持有者条件的清除在未授予时是 no-op。归还失败只记日志，绝不抛出——阻塞判定必须送达会话——并按有界节奏重试（两次）：因未结算执行被拒 busy 的挂载，在这些行结算后被释放；工作永不结算的会话则诚实地保持冻结。

无挂载会话之后的完整 `release()` 会走传输层的无持有者捷径：`RELEASING && !isHeld` 本来就表示「挂载所围的一切都结束了」，而挂载释放只是把这件事提前弄真。捷径跳过的 worker 侧 detach 随 binding 消亡，行仍诚实地落定 `RELEASED`。

## 备选方案

- 阻塞转移时执行完整 `broker.release()`：否决——它会永久落 `RELEASED`，而唤醒善后/运维续跑要按同一 READY 身份重新收养。
- 服务端租约 TTL + 心跳 + 过期窃取：本 issue 否决——schema、续期与窃取协议的工程量对被点名的机制不成比例；活着的 Daemon 能够也应该在自己拥有的转移点上行动。
- 按 journal `recovery_status` 在 claim 时逐出：不足——当前 HEAD 上 recovery block 在 Daemon 本地落定而不落 journal（另一条上报不足的 finding），这种逐出不会触发。
- 只给 Daemon 的 `workspace_busy` 重试加上界：把楔死变成具名失败，但全新轮次对泄漏租约永远不能完成；其余不变——该队列在真正活着的持有者之后等待是正确的。

## 验证与验收

- Daemon 单元见证（`packages/cli/src/serve/hosted-workspace-tool-turn.test.ts`）：已获租轮次的归还恰好调用一次 `releaseMount`，绝不调用 `release`；归还被拒只记日志、不抛出，并恰好再重试两次才保持亏欠；busy 后结算的挂载在重试中被归还；应答在授予后丢失的 acquire 仍执行归还；Hook/MCP lane 不归还任何东西。
- 路由见证（`packages/cli/src/serve/hosted-harness-session.test.ts`）：prompt 驱动的工具轮分别经 Tool/MCP/Hook 三个错误族进入 recovery-blocked，每次恰好释放挂载一次，绝不触发完整释放，且仍准确上报 `recoveryBlocked`。
- Broker 服务单测：驻留挂载释放保持 `READY` 且完整释放计数为零；跨 Harness 应答 `runtime_session_conflict`；非驻留 Session 应答 `runtime_reconciliation_required`；未结算执行、在飞 control、以及主行已结算但背景进程仍在跑，各自应答 `runtime_session_busy`；非 Workspace 持有的 transport 应答 501 `workspace_mount_release_unsupported`。
- 真栈 IT（`HostedWorkspaceConcurrencyIT#mountReleaseFreesHeldStorageAndKeepsTheSessionReady`）：持有者占用时竞争 acquire 应答 `workspace_busy`；有未结算执行时窄释放拒绝 `runtime_session_busy`，结算后成功；挂载行持有者列清空；Runtime Session 保持 `READY`；竞争方获得挂载；持有者随后的完整释放完成。
- 用 issue 的复现方法重跑物理 rig：block 模式下全本轮次 2.6 秒在首次 acquire 即获租并结算，被阻塞会话与此前完全一致地上报 blocked（`workspace_busy` 计数为 0，修复前为 207）；control 模式不变；仅撤下 `await toolTurn?.releaseForRecoveryBlock();` 一行即按修复前 journal 指纹恢复楔死（机制恢复的见证——无 `:release-mount` 调用，挂载等待日志在案），恢复该行后楔死再次消失（rig 证据保存在 `.qwen/issues/13800-repro/`）。

恢复机制——去掉那一行——见证套件与 rig 都会失败：单元见证看不到 `releaseMount` 调用，IT 看到租约持有者钉住，rig 楔死。包 build/typecheck/lint/checkstyle 与触及的套件（`hosted-workspace-tool-turn`、`hosted-workspace-broker`、`hosted-harness-session`、runtime-broker、managed-agent-server、挂载释放 IT）在最终 head 通过。
