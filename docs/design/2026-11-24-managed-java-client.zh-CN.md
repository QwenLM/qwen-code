# Managed Agent 公共 Java 客户端

[English](2026-11-24-managed-java-client.md) | [简体中文](2026-11-24-managed-java-client.zh-CN.md)

## 背景与范围

Java 服务接入独立 Managed Agent 时，需要发现和执行会话、处理审批以及发布资产。现有 Java SDK 通过 `ManagedExtensionsClient` 支持 Managed 扩展。daemon 和 Hosted Harness 的客户端各自对接对应的 API。

在 `qwencode-sdk` 中增加 `ManagedAgentClient`，覆盖 AgentDefinition 和 Workspace 访问、会话创建与列表、生命周期操作、消息与取消、Turn 和 Items、审批、恢复及资源目录。扩展发布与绑定复用 `ManagedExtensionsClient`，服务端路由和结构沿用现有 OpenAPI 契约。会话列表按 Workspace 筛选需要服务端修改，在本次客户端范围之外。

## 设计

使用公共 `/v1/agents` 路由。通过 `ManagedAgentClient.workspaces()` 和 `sessions()` 提供类型化的 Workspace 和会话操作。创建请求的 Builder 列出字段，并要求传入 Agent ID。输入、Skills、模型配置和扩展 pin 都有 Java 类型。分页对象包含类型化条目和下一页游标，Items 分页还包含快照序号。Session、Turn、Turn 受理回执和命令操作各有独立类型。事件直接暴露通用字段和文本增量。状态与事件类型允许服务端后续扩展。

通过 `extensionPackages()` 提供类型化的扩展导入、已发布 pin、设置修订和会话配置操作。已发布 pin 可显式选择设置修订。会话客户端可查询 Skill 资源、Hook 目录和 MCP 目录。AgentDefinition 管理和高级扩展操作使用现有 Map API。已发布 SNAPSHOT 的调用方可以继续使用原方法。响应元数据和多态事件数据沿用 JSON 表示。SDK 省略未设置的请求字段，并保留显式传入的空扩展选择。请求字段名与能力校验由现有契约和服务端维护。

调用方提供租户、调用者、签名密钥和写请求的幂等键。各入口共用签名 HTTP 传输，保留入口的路径前缀，由调用方处理 HTTP 结果和重试。

复用现有 SSE 帧解析器，提供可关闭的事件读取器。常规帧携带事件序号。收到重新同步帧时，将其交给调用方且保留原游标，由调用方读取 Items 后按重建后的快照序号重新订阅。提交回执表示已受理，并提供查询最终结果需要的标识。

## 验证

以 Java 11 编译。使用本地 HTTP 测试服务验证请求签名、查询编码、类型化分页与回执、字段省略与显式空值、服务端错误、SSE 终态及重新同步事件。运行现有客户端和扩展测试验证兼容性。
