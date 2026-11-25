# Managed Agent 公共 Java 客户端

[English](2026-11-24-managed-java-client.md) | [简体中文](2026-11-24-managed-java-client.zh-CN.md)

## 背景与范围

Java 服务接入独立 Managed Agent 时，需要发现和执行会话、处理审批以及发布资产。现有 Java SDK 通过 `ManagedExtensionsClient` 支持 Managed 扩展。daemon 和 Hosted Harness 的客户端各自对接对应的 API。

在 `qwencode-sdk` 中增加 `ManagedAgentClient`，覆盖 AgentDefinition 和 Workspace 访问、会话创建与列表、生命周期操作、消息与取消、Turn 和 Items、审批、恢复及资源目录。扩展发布与绑定复用 `ManagedExtensionsClient`，服务端路由和结构沿用现有 OpenAPI 契约。会话列表按 Workspace 筛选需要服务端修改，在本次客户端范围之外。

## 设计

直接使用公共 `/v1/agents` 路由和 JSON 字段名。沿用扩展客户端的 Map 形式保存结构化请求和响应，以保留可选字段和不同操作的返回结构。每个操作提供具名方法。调用方提供租户、调用者、签名密钥和写请求的幂等键。与扩展客户端共用签名 HTTP 传输，保留入口的路径前缀，并将 HTTP 结果交给调用方处理。

复用现有 SSE 帧解析器，提供可关闭的事件读取器。常规帧携带事件序号。收到重新同步帧时，将其交给调用方且保留原游标，由调用方读取 Items 后按重建后的快照序号重新订阅。提交回执表示已受理，并提供查询最终结果需要的标识。

## 验证

使用 loopback HTTP 服务验证请求签名、查询编码、协议字段、状态及错误处理和 SSE 续读。新测试与现有扩展测试一起运行，验证拆出共享传输后的行为。
