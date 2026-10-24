# 恢复阻塞 Hosted Workspace 轮次的挂载释放

[English](workspace-execution-mount-recovery-block-release.md) | [简体中文](workspace-execution-mount-recovery-block-release.zh-CN.md)

## 状态与范围

已实现。本切片终结 [#13800](https://github.com/QwenLM/qwen-code/issues/13800) 的跨会话楔死：进入 recovery-blocked 的 Hosted Workspace 工具轮归还其 Workspace 执行挂载，使同一存储上无关会话的后续工具轮得以继续，而不是在 `409 workspace_busy` 上永久停摆。覆盖普通工具 lane、Hook lane 的会话级 owner 与 MCP lane 的会话级 owner，并覆盖持有挂载的轮次把会话停在 blocked 的每个入口：prompt 路由的 recovery block、释放欠在 cleanup 欠账上的轮次其 cleanup 失败或因终态记录未落地而从未执行，以及恢复队列使用的 `POST /session/:id/managed-runtime/continue` 的每个停驻分支。不在范围内：A1 本身（[#13533](https://github.com/QwenLM/qwen-code/issues/13533)，已由 [#13789](https://github.com/QwenLM/qwen-code/pull/13789) 修复）、daemon 死亡残留（LOST 族既有清扫，`#12670` 族）、`POST /session/:id/files/rewind` 通道的按请求挂载（失败的 rewind 会把会话停在 blocked 而不归还其挂载——既有泄漏，已记入跟踪后续），以及启用 `monitor_run` 或 `child_run` 的 `shell` kind。

## 问题与被点名的机制

一个 `recovery_blocked` 会话楔死了同一 daemon 上其他会话的后续轮次：journal 停在 `hostedModelAttempt` 之后、`commitMessage` 之前，模型再未被调用，没有错误、没有终态事件。issue 中的运行时见证把机制隔离了出来：

1. 每个 Workspace 工具轮的 Broker acquire 都经过 `WorkspaceRuntimeTransport.acquire` → `WorkspaceExecutionStore.claim`，后者为每个本地存储维护一行 `ma_storage_owner`（`storage_key`、`storage_kind = 'LOCAL'`）；其持有者列（`holder_key`、`binding_id`、`runtime_generation`、`runtime_session_id`）指明持有该挂载的 Runtime Session。
2. 只有已结算路径上 `finish()` 的完整 `release()` 会释放这一行。进入 recovery-blocked 的轮次（block-and-never-replay 契约下的不确定结果）在任何释放之前抛出 `HostedToolRecoveryRequiredError`，于是一个按契约永久停驻的轮次永远持有挂载。Hook 与 MCP lane 持有会话级挂载，而它们自己的释放者会被同一份未证实工作否决，所以这两类 profile 的阻塞会话同样一直持有它。
3. 同一存储上之后的每个工具轮都在 `409 workspace_busy`（`retryable: true`）上空转，没有错误、没有终态事件。只清掉该行的持有者，就能在一秒内在线解开一个停摆的轮次，而被阻塞的会话保持阻塞——耦合点恰好就是这个挂载。

## 修复

被阻塞的轮次只归还挂载——绝不归还 Runtime Session。

**Broker 端点。** 新增 broker 内部端点 `POST /tool-sessions/{runtimeSessionId}:release-mount`，请求体 `{harnessSessionId, mountClaimId}`。`RuntimeBrokerService.releaseMount` 只解析驻留的 Session Context（已死 daemon 的残留属于 LOST 族的清扫，回答 `503 runtime_reconciliation_required`），校验 Harness 身份，并套用兄弟路由 `:release` 的生命周期栅栏：在 close、archive 或 delete 期间，归还回答 `409 runtime_admission_closed`，由该操作自身的 drain 释放挂载。随后在 Session Context 锁内依次要求：

- **欠这次归还的那个 claim。** 每次 acquire 都携带一个 `mountClaimId`，Broker 在同一把锁下记录它；同一身份之后的任何 acquire——恢复重驱动、load、lane 的下一次运行——都会取代它，旧的归还回答 `409 runtime_session_conflict`，而不会释放一个活轮次的挂载。持有者与 binding generation 无法充当这道栅栏：同一 Runtime Session 的重驱动拿到的恰好是同一组值。
- **没有未结算的工作。** 进行中的 control 或任何未结算的执行（包括后台进程——这条路径不做清扫，因此不像 drain 那样排除任何东西）回答可重试的 `409 runtime_session_busy`。
- **没有未证明已停止的写入者。** 已结算执行若其存储的 capture 既不是 `complete`（两条流都已封口）也不是 `detached`（其活进程是自己的 `:process` 行）——即 `partial` 或 `unavailable`——就可能在 Workspace 中留下逃逸的写入者；operator-recovery 族恰好对这个 Workspace 设栅栏。已结算行不会再变，所以这里回答终态的 `409 workspace_writer_unproven`。存储的 `deliveryStatus` 不能用在这里：每个 Shell capture 的它都永远停在 `pending`，提交只存在于 publication 的 admission outcome 中。

校验与清除在同一把锁内完成，因此两者之间记录的 acquire 不会丢失挂载。`RuntimeTransport.releaseMount` 默认 fail-closed（`501 workspace_mount_release_unsupported`）；`WorkspaceRuntimeTransport` 清除持有者列。Runtime Session 行保持 `READY`，绝不变成 `RELEASED`，恢复队列因此保有可接管的身份。

**重新占用。** 在本切片之前，READY 的 Runtime Session 只在首次 acquire 时占用一次挂载。现在对既有身份的每次 acquire——驻留的、存储为 `READY` 的、或 Hook owner 的恢复 acquire——都会调用 `RuntimeTransport.reclaimMount`，当会话已不再持有挂载时重新占用。占用以持有者为条件：仍持有的挂载保持不动，被对手占走的则回答可重试的 `workspace_busy`，而轮次的 acquire 队列本就会等待它。

**Worker 侧 detach。** worker 保留被归还会话的安装，因为重驱动会复用它。`WorkspaceRuntimeTransport` 在清除 `READY` 会话的持有者时，或清除因 cleanup 释放在 worker 侧失败而仍持有挂载的 `RELEASING` 会话的持有者时，把 detach 记为欠账，因此该会话之后的完整释放仍会派发 provider release 与 Workspace 去激活，而不走无持有者捷径；这条捷径继续服务于从未安装过任何东西的会话，这类会话本就没有可归还的挂载。欠账在内存中；Broker 重启后退回到 worker 自身的生命周期。

**Daemon。** `HostedWorkspaceBroker.acquire` 在请求发出之前记录一个新的 claim，因此在授予之后丢失的回复仍能指明它，`releaseMount(claim)` 会携带它。停在 blocked 的轮次在每个入口调用 `releaseForRecoveryBlock()`：`executeHostedTurn` 在四类 recovery-required 错误上（`monitorWakeNeedsRecovery`）、已结算轮次的欠账 cleanup 释放失败时，以及欠着该 cleanup 的轮次因终态记录未落地而在执行 cleanup 前退出时（持久化的 cleanup 欠账继续重试其完整释放，挂载不等它），以及 continue 路由为每个让重驱动停在 blocked 的分支所设的唯一出口。由 lane 选择 owner：

- 普通 lane 归还其 broker 的最新 claim，或 takeover 分支的原始身份；从未发出 acquire 的轮次不持有任何东西，也不发送任何东西。
- Hook lane 的 owner（`HostedHookSession.mountHandback`）与 MCP lane 的 owner（`HostedMcpSession.mountHandback`）只在自身工作已被证实时归还会话级挂载。Broker 看不到 Hook 运行或 MCP 操作，因此既无结果又不能证明从未下发的 Hook 执行、待定的 occurrence、处于恢复中的 MCP 操作、进行中的配置，或共享 MCP owner 的 Hook 运行，都会保留挂载。每个 owner 仍记为已 acquire，因此其关闭仍会执行完整释放，而它的下一次 acquire 会重新占用挂载。

失败的尝试只记日志、绝不抛出——block 判定必须送达会话，它只在一个较短的上限内等待第一次尝试。丢失的回复、busy 拒绝和 Broker 的内部错误按逐步拉长、最终稳定在一分钟的节奏重试；lane 自身未证实的工作同样重试，于是那份工作结算后挂载就会归还。其余回答都是终态。会话的关闭不会停止这条链，因为关闭从不释放停驻轮次的挂载；daemon 拥有这条链并在关闭时停止它，日志对每种不同的失败只记一次。

## 考虑过的替代方案

- 在 block 转变时完整 `broker.release()`：否决——它永久持久化 `RELEASED`，而恢复队列会重新接管同一个 READY 身份。
- 像 cleanup release 那样按 binding id 与 generation 给归还设栅栏：不充分——同一 Runtime Session 的重驱动拥有相同的 binding 与 generation，只有按 acquire 的 claim 才能区分过期的归还与活的归还。
- 在每次无持有者的释放上都派发 worker detach：否决——acquire 从未安装任何东西的会话会永远无法完成其激活释放，停在 `RELEASING`。
- 服务端租约 TTL 加心跳与过期抢占：本 issue 否决——schema、续约与抢占协议的机制规模与被点名的机制不相称；活着的 daemon 能够也应当在它拥有的转变点上行动。
- 以 journal `recovery_status` 为键的 claim 时驱逐：不充分——recovery block 在 daemon 本地结算而不持久化到 journal，此类驱逐不会触发。
- 给 daemon 的 `workspace_busy` 队列设上限：把楔死变成具名失败，却永远不能让新轮次在泄漏的挂载下完成，还会让排在真正长期持有者之后的轮次失败；prompt 期限本就约束了等待。

## 验证与验收

- Broker 单元与契约测试：驻留会话的归还保持 `READY`，完整释放计数为零；跨 Harness 回答 `runtime_session_conflict`，被之后 acquire 取代的 claim 同样如此，而之后的 claim 能够归还；携带生命周期 authority 回答 `runtime_admission_closed`；非驻留会话回答 `runtime_reconciliation_required`；未结算执行、进行中的 control，以及后台进程仍在运行的已结算执行都回答 `runtime_session_busy`；存储投递停在 `pending` 的 `complete` capture 可以归还；`partial`/`producer_lost` 与 `unavailable`/`storage_failed` 回答 `workspace_writer_unproven`；归还之后的重新 acquire 会重新占用挂载。仓储探针的同一契约分别跑在内存存储和经 JDBC 存储的 H2 上。
- Transport 测试（`WorkspaceRuntimeTest`）：归还不派发 detach，之后的完整释放各派发一次 provider release 与去激活，对手的 claim 保持不变；cleanup 释放在 worker 侧失败后的归还，使重试的释放仍到达 worker 并执行去激活，而从未安装的会话归还后仍无欠账；对手持有挂载时重新占用被拒，挂载空出后成功。
- Daemon 单元测试：归还携带欠它的那次 acquire 的 claim，包括 acquire 回复丢失之后；从未 acquire 的轮次不发送任何东西；busy 拒绝让归还按节奏保持欠账并只记一次日志；丢失的回复会重发；每种终态拒绝在一次尝试后停止；block 判定不等待挂起的归还；daemon 关闭会停止这条链；Hook 与 MCP lane 通过其 owner 归还。Hook lane 在工作被证实后归还，在结果未知时保留挂载；MCP lane 对未知操作和共享的 Hook 运行同样处理，两者都在下一次 acquire 时重新占用挂载。
- 路由测试：经四类 recovery-required 错误族进入 recovery-blocked 的 prompt 驱动轮次恰好归还一次挂载，且从不触发完整释放；欠账 cleanup 释放失败的已结算轮次、欠着该 cleanup 但终态记录无法写入的轮次，以及 continue 后再次进入 recovery-blocked 的轮次，同样如此。
- 真实栈 IT（`HostedWorkspaceConcurrencyIT#mountReleaseFreesHeldStorageAndKeepsTheSessionReady`）：持有期间对手 acquire 回答 `workspace_busy`；有未结算执行时归还拒绝为 `runtime_session_busy`，外来 claim 拒绝为 `runtime_session_conflict`，结算后归还成功；持有者列被清空；Runtime Session 保持 `READY`；对手完成 acquire；对手持有期间持有者的重驱动回答 `workspace_busy`，挂载空出后重新占用；持有者随后的完整释放结算为 `RELEASED`。
- 故障门 IT（`HostedWorkspaceToolTurnIT`）：工作已结算的各故障族在 Runtime Session 保持 `READY` 的同时归还挂载——包括经欠账 cleanup 停驻会话的丢失 release——执行永不结算的 `prepare-twice` 保留挂载；前一个用例欠下的归还可能在下一个用例运行时仍在重试，driver 会在该用例的账本之外转发它。

还原该机制——去掉 block 转变处的归还——路由见证就看不到归还，IT 会看到持有者被钉住，对手会楔死。
