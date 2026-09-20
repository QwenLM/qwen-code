# 会话创建失败诊断

[English](2026-09-15-session-creation-diagnostics.md) | [简体中文](2026-09-15-session-creation-diagnostics.zh-CN.md)

[#11944](https://github.com/QwenLM/qwen-code/issues/11944) 的 PR 1 实现设计，基于 `main@bda4b0743b80a8d07413f03839b34cd5b470e39a`，独立于 PR 2–4。

## 问题与证据

真实 HTTP route + standalone service + error serializer 故障注入确认：派发前失败与来源写入未确认均返回 HTTP 500 `standalone_creation_rolled_back`，带 `Retry-After: 5`。原始 cause 丢失，集合 POST 的 warning 缺少目标 session ID。这证明可观测性缺口，不证明某次部署事故的根因或频率。

私有来源确认也把 recording 不可用和写入未确认合并为 `persisted:false`。bridge 原先直接记录 RPC 错误消息，对负确认则不输出诊断。全局安装的 `qwen 0.18.5-preview.0` 缺少 standalone 路由（404）；因此验收使用支持该能力的 main/候选实现进行确定性故障注入，无需模型调用。

## 范围与归属

保持公共 HTTP code、文案、重试响应头、`sourcePersisted`、模型选择、准入、回滚、隔离和 runtime 归属不变。不新增端点、SDK 升级要求、任务重试、结果 API、schema 或模型变更。

Standalone 创建属于解析后的 Conversations runtime。直接 child/side-task 创建经过同一服务边界。来源写入使用实际 session entry 的 child connection，覆盖普通/standalone 新建、side task、冷恢复和在线恢复时的来源补全。诊断不解析其他 runtime，也不回退 primary。

## 创建诊断

每个已校验的创建操作携带局部状态，失败时通过已有 daemon logger 和 telemetry 输出一次 `Standalone session creation failed.` 记录，成功时不输出。Server 向 service 注入现有有界 daemon logger，直接调用方也受益。日志失败不改变创建结果。

| 字段               | 含义                                                                                                                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessionId`        | 已校验、规范化的目标 UUID，不被父会话错误中的 ID 替换                                                                                                                                     |
| `relatedSessionId` | 可选的已校验父 UUID                                                                                                                                                                       |
| `workspaceId`      | 已解析 runtime 的既有标识（可用时）                                                                                                                                                       |
| `phase`            | `runtime`、`parent_validation`、`directory_prepare`、`spawn_pre_dispatch`、`spawn_dispatched`、`source_persistence`、`durable_validation`、`model_selection`、`binding`、`initial_prompt` |
| `reason`           | `unknown`、类型化的 `rpc_timeout` / `transport_closed`、类型化归属错误 `runtime_changed` 或 `source_not_confirmed`                                                                        |
| `dispatchState`    | 使用既有 spawn 派发标记：`not_dispatched`、`dispatched` 或 `unknown`                                                                                                                      |
| `cleanupOutcome`   | `not_needed`、已验证的 `rolled_back`、`closed`、已完成的 `quarantined` 或 `unknown`                                                                                                       |

来源 boolean 本身不能区分存储拒绝和 RPC 失败：service 记录 `source_not_confirmed`，相关联的 bridge 记录提供细分类。绑定/首轮失败后完成 close 记为 `closed`，不宣称持久状态已经回滚。只有既有 quarantine completion promise 成功后才记为隔离完成；拒绝仍为 `unknown`。

回滚/隔离期间在内存保留最初异常链，包括原始 dispatch wrapper。绑定重试需要隔离时保留第一次失败。清理错误不能替换已观测到的创建失败。不虚构新 prompt ID；诊断不含 prompt、结果、工具参数、source ID、完整路径、原始 RPC 或凭据，复用既有 logger trace/run 上下文。

HTTP 序列化继续显式投影字段。通用 expected-error warning 缺少 ID 时先使用创建诊断的目标 ID，再使用 service error 的 ID。它向 telemetry 传递新建的无 cause Error，避免暴露内存中的 cause 链。专用服务诊断同样只记录固定消息和白名单基本类型字段。直接调用方得到相同的安全服务消息和内存 cause 链。

## 私有来源确认

仅失败的 `qwen/control/session/source` 响应增加 `reason: recording_unavailable | write_not_confirmed`。Recording API 保持 boolean，不从 false 推断具体文件系统原因。成功响应不变。

Bridge 仍返回 boolean，不向 session 结果或 SDK 类型增加字段。每次未成功的来源操作输出有界 `source_persistence_failed` 行，包含实际在线 session ID 和下列分类之一：

- 已识别的私有原因：`recording_unavailable` 或 `write_not_confirmed`。
- 旧 child 返回 `{ persisted:false }`：`negative_ack`。
- 缺少或非 boolean 的 `persisted`：`invalid_ack`。
- 负确认携带未知 reason：`unknown`。
- 本地类型化 transport error：`rpc_timeout` 或 `transport_closed`；其他 RPC 拒绝：`rpc_rejected`。

不匹配错误消息，不序列化原始异常。远端异常经过 JSON-RPC 序列化后属于拒绝，不能作为本地观测超时的证据。既有 diagnostic callback 和 stderr 输出为 best-effort。成功来源确认不输出失败记录。

## 实现与消费者

| 区域                              | 消费者                                                                                         |
| --------------------------------- | ---------------------------------------------------------------------------------------------- |
| Standalone service 和 server 注入 | HTTP 创建、定时 standalone 创建、直接 child/side-task 工具创建；既有 restore helper 保持控制流 |
| HTTP 错误序列化                   | 既有 HTTP 客户端、通用 warning 和错误 telemetry                                                |
| ACP 私有来源 handler              | 托管 daemon 和直接 ACP 调用方；可选失败原因保持兼容                                            |
| Bridge 来源持久化                 | 普通/standalone 新建、side task、恢复会话、在线来源补全                                        |
| 既有 daemon logger 和 telemetry   | 有界运维诊断，不增加持久化子系统                                                               |

## 验证与验收

执行 build、typecheck、bundle，以及聚焦的 service、route、serializer、child-tool、logger、ACP、bridge 测试。对基线和候选执行相同真实 route/service/serializer 故障：公共正文、状态和响应头一致，专用诊断按阶段区分并关联请求目标 ID。

覆盖负确认、非法/旧版确认、recording 不可用、写未确认、真实 transport 关闭和超时、RPC 拒绝、直接 child 父校验、绑定/首轮失败、清理失败、抛错 logger、健康兄弟会话及含秘密的嵌套 cause。来源确认和健康创建不得新增失败记录。验证普通/standalone 和恢复调用方的 boolean 契约不变。模型推理和远端事故诊断不属于此次确定性验收。

## 风险与交付

主要风险是敏感信息序列化、归因错误和日志影响失败行为。Cause 不进入序列化器，分类固定，保留既有生命周期决策。跨包边界仍需维护者评审，不包含大规模重构。

回滚本 PR 只移除诊断细节，不改变执行，也不使 PR 2–4 失效。提交、CI、评审、合并、部署验收是独立里程碑。使用 `Refs #11944`，本 PR 不能单独关闭四项 tracker。此诊断范围不存在待决定的公共协议设计。
