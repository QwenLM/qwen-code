# 双引擎 owner 选择与类型化拒绝

[English](./2026-09-26-paired-engine-owner-selection.md) | [简体中文](./2026-09-26-paired-engine-owner-selection.zh-CN.md)

## 状态

#12737 的 B2a 切片，属于 #12380 的 Stage B 宿主接入，基于上游 `342ba1bcdd`。
它承接 [ACP Bridge 执行引擎](./acp-bridge-execution-engines.zh-CN.md) 中的
Bridge 路由切片，是宿主接线（B2d）的前置条件。工作区契约（B2b）、按引擎的运维
行为（B2c）和宿主接线仍是独立切片。本变更之后，普通 daemon、Channels 和嵌入式
构造方仍不传入 `executionEngines`。

## 问题与当前行为

#12693 增加了 `session_execution_engine` transcript 记录，以及在整个物理 transcript
上累计该记录的读取器。#12698 让双引擎 Bridge 要求每个 new/load/resume 响应都携带
`_meta['qwen.session.executionEngine']`。两者之间尚未连通：没有 ACP 宿主在应答前
持久化或核验 owner，Legacy ACP 宿主根本不返回回执，也没有宿主选择器在冷恢复时读取
持久 owner。

双引擎 Bridge 用 ACP SDK 的 `RequestError` 拒绝非法或已存活的请求 Session ID。
REST 将其报成 HTTP 500，ACP 传输报成 `-32603` 内部错误。普通路由只在共享 ID 准入
之后才到达 Bridge，但 `LocalManagedRuntimeProvider` 和 standalone 服务直接创建会话；
在路由的持久状态准入检查仍在进行时，直接创建方可能先注册同一 ID。Managed 分支和
side-task 的拒绝是普通 `Error`，同样变成 500。

## 范围

范围内：

- Legacy ACP 宿主在初始化副作用之前持久化或核验 owner，之后才返回引擎回执。
- 冷 load/resume 按持久 owner 选择引擎的宿主选择器。
- 由 Bridge 定义的请求 ID 与 Managed 分支类型化拒绝，并映射到 REST、ACP
  HTTP/WebSocket 传输、managed-runtime provider 和 standalone 服务。
- #12698 推迟、属于本切片的测试补强项。

不在范围内：接线任何宿主以及新会话的配置兼容选择（B2d）、工作区契约（B2b）、
按引擎运维与隔离恢复（B2c）、Managed Harness 与 Managed 分支。公开 REST 变更仅限
下文的错误分类。

## 方案

### Owner 持久化与回执

双引擎 Bridge 在 new、load、resume 请求的 `_meta['qwen.session.executionEngine']`
中写入所选引擎。单 factory 路径不发送该字段，行为不变。Legacy ACP 宿主只接受
`legacy`；其他取值在创建 Config 之前以 `-32024` 和
`session_execution_engine_unavailable` 拒绝。宿主把引擎作为 host policy 传给会话
Config（`loadCliConfig` 的 `hostPolicy.executionEngine`，再到
`ConfigParameters.sessionExecutionEngine`），绝不从 argv、settings 或环境变量读取。

`Config.initialize()` 在对话录制可以写入之后、`initializeInternal()` 启动 Hooks、
MCP、skills、工具和模型之前绑定 owner。启用 writer lease 时，这一步发生在持有
lease 并重新读取权威历史之后。

- 新会话通过严格写入路径，把 `{ version: 1, engine }` 形式的
  `session_execution_engine` 作为 transcript 的第一条记录追加。写入失败会使初始化
  和创建失败。
- 恢复要求恢复投影中的 owner 已核验且等于所选引擎。该 owner 由 transcript 读取器
  从与恢复历史相同的文件快照计算得出。属于其他引擎、历史无法证明或缺少证明时，在
  任何副作用之前以 `SessionExecutionEngineError` 拒绝。
- 关闭对话录制时不存在持久会话，因此不写入任何内容。

ACP 响应只在绑定成功后才携带回执。已在子进程中存活的会话保持原 owner，无需新
Config 即返回回执。

因此，双引擎模式下的 Legacy 会话与 Managed 会话一样，从创建起就是持久的。创建后
从未使用的会话，或在写入 owner 记录之后才失败的创建（例如在认证阶段失败），会留下
只含 owner 记录的 transcript。它会出现在列表中、可以被加载，其 ID 也保持占用。
单 factory 会话保持现有行为。

### 宿主选择器

CLI serve 层的
`createSessionExecutionEngineSelector({ newSessionEngine, runtimeBaseDir })`
构造双引擎 Bridge 的 `select` 回调。

- Spawn 返回 `newSessionEngine`。B2d 会用配置兼容策略替换这一输入。
- Load 与 resume 先解析 ACP 子进程将要恢复的持久化拼写（大小写不敏感查找），再用
  严格 owner 累计器读取整个活跃 transcript，返回已核验的 owner。没有 owner 记录的
  完整历史属于 Legacy。transcript 缺失或为空时报 `SessionNotFoundError`。非法、
  冲突或不完整的 owner 证据报 `SessionExecutionEngineError`。恢复绝不使用宿主默认值。

选择器与 ACP 子进程读取同一个 transcript，子进程还会从其恢复快照再次核验 owner，
因此两次读取之间的变化不会把会话转到另一个引擎。

### 类型化拒绝

Bridge 包中的 `RequestedSessionIdRejectedError` 继承 ACP SDK 的 `RequestError`，
直接的 ACP 调用方仍收到 invalid params（`-32602`）。其 `errorKind` 为
`invalid_session_id` 或 `session_id_conflict`；冲突携带 `sessionId`，非法 ID 不会
被回显。Bridge 包不引入 CLI 准入类。`ManagedSessionBranchUnsupportedError` 取代
Managed 分支和 side-task 请求原来的普通错误，这些请求仍在修改历史之前拒绝。

| 拒绝类型                      | REST                                                               | ACP HTTP/WebSocket `data`                                                                      |
| ----------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| 非法请求 ID                   | 400 `{ code: 'invalid_session_id' }`                               | `-32602`，`{ httpStatus: 400, errorKind: 'invalid_session_id' }`                               |
| 已存活的请求 ID               | 409 `{ code: 'session_id_conflict', sessionId, conflict: 'live' }` | `-32602`，`{ httpStatus: 409, errorKind: 'session_id_conflict', sessionId, conflict: 'live' }` |
| Managed 分支或 side task      | 409 `{ code: 'managed_session_branch_unsupported', sessionId }`    | `-32602`，`{ httpStatus: 409, errorKind: 'managed_session_branch_unsupported', sessionId }`    |
| owner 不可用（选择器/子进程） | 409 `{ code: 'session_execution_engine_unavailable' }`             | `-32602`，`{ httpStatus: 409, errorKind: 'session_execution_engine_unavailable' }`             |
| transcript 快照不可用         | 409 `{ code: 'transcript_snapshot_unavailable' }`（已有）          | `-32603`，`{ httpStatus: 409, errorKind: 'transcript_snapshot_unavailable' }`                  |

冲突与非法 ID 的形状与现有共享准入响应一致。SDK 的 HTTP 与 WebSocket 传输从
`data.httpStatus` 还原 HTTP 状态。选择器读取快照时与 ACP 子进程都可能报告快照不可用，
REST 此前已返回 409；ACP 传输现在也带上相同的 409 分类，不再是笼统的内部错误。只映射
这些类型；其他 SDK 错误仍映射为内部错误。

直接创建方保留各自的错误词汇。`LocalManagedRuntimeProvider` 把已存活 ID 的拒绝
映射为不可重试的 `managed_runtime_identity_conflict`。standalone 服务把未派发的
已存活 ID 拒绝映射为 `standalone_session_conflict`，而不是
`standalone_creation_rolled_back`。此时它不检查该 ID 是否有已持久化的内容，因为存活
owner 自己的 transcript 本就应当存在；发现它不能导致 runtime 被隔离。

## 文件与消费者

| 区域       | 文件                                                                                                                                                     |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bridge     | `bridgeErrors.ts`、`session-control-plane.ts`                                                                                                            |
| owner 绑定 | core `config.ts`、`chatRecordingService.ts`；CLI `config.ts`、`acpAgent.ts`                                                                              |
| 宿主选择器 | `serve/session-execution-engine-selector.ts`                                                                                                             |
| 错误映射   | `serve/server/error-response.ts`、`serve/acp-http/dispatch.ts`、`serve/managed-runtime-provider.ts`、`serve/conversations/standalone-session-service.ts` |

不新增 daemon 路由。会话创建、恢复、分支和 side-task 路由保持其 live-session-owner
或 selected-runtime 归属，只改变错误分类。

## 验证与验收标准

1. 路由测试注入双引擎 Bridge，暂停持久状态准入检查，让直接创建方注册请求的 ID
   后再恢复。路由返回带 `conflict: 'live'` 的 409 `session_id_conflict`，不再派发
   第二次 ACP `newSession`，原会话仍能 Prompt。非法输入（400）与普通共享准入（409）
   仍在 Bridge 之前应答。
2. 双引擎的 new/load/resume 请求携带所选引擎；单 factory 请求不携带。
3. 无论是否启用 writer lease，Legacy 宿主都在初始化副作用之前把 owner 写为第一条
   记录。属于其他引擎、历史无法证明或缺少 owner 证明的恢复在副作用之前拒绝；
   Managed 选择在 Config 创建之前被拒绝。
4. 无论新会话使用哪个引擎，选择器都恢复已记录的 Legacy 和 Managed owner，把没有
   owner 记录的完整历史视为 Legacy，并拒绝不可用的历史。
5. #12698 推迟的 Bridge 覆盖：选择失败后的准入与 ID 释放、请求与返回 ID 不匹配、
   另一引擎存活时的迟到非法 ID、ID 在清理确认前保持占用、Legacy 冷恢复、成功的
   双引擎 Legacy 分支，以及移到回调之外的重入选择器断言。

## 风险与待定项

- 如上所述，未使用或创建失败的双引擎会话留下的纯 owner transcript 会出现在列表中，
  并保持 ID 占用。
- 选择器在冷恢复前读取整个 transcript，与恢复本身相同，成本随 transcript 增长。
- 选择器尚未接线。B2d 必须用 runtime 的会话 base 目录构造它，并决定新会话的选择。
  #12737 中关于选择器输入、下发失败、隔离恢复和 Hosted 边界的问题不由本切片决定。
  B2d 的设计见[双引擎宿主接线](./2026-09-26-paired-engine-host-wiring.zh-CN.md)。
