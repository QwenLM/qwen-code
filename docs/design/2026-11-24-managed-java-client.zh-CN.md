# Managed Agent 公共 Java 客户端

[English](2026-11-24-managed-java-client.md) | [简体中文](2026-11-24-managed-java-client.zh-CN.md)

## 背景与范围

Java 服务接入独立 Managed Agent 时，需要发现和执行会话、处理审批以及发布资产。现有 Java SDK 通过 `ManagedExtensionsClient` 支持 Managed 扩展。daemon 和 Hosted Harness 的客户端各自对接对应的 API。

在 `qwencode-sdk` 中增加 `ManagedAgentClient`，覆盖 AgentDefinition 和 Workspace 访问、会话创建与列表、生命周期操作、消息与取消、Turn 和 Items、审批、恢复及资源目录。扩展发布与绑定复用 `ManagedExtensionsClient`，服务端路由和结构沿用现有 OpenAPI 契约。会话列表按 Workspace 筛选需要服务端修改，在本次客户端范围之外。

## 设计

`ManagedAgentClient` 的公开方法使用 Java 请求和响应类型表示结构化数据。保留现有方法名与标量参数。Agent 创建和更新共用定义请求，并返回相同的已保存修订摘要。会话创建、输入块、审批响应和 MCP 管理命令使用类型化请求。普通列表共用类型化分页，Workspace、Items 和事件分页保留各自的额外字段。

响应类型暴露固定字段，包括嵌套数据。调用方定义的 Agent 元数据、工具定义的 JSON Schema 和未知事件数据沿用 JSON。MCP 工具 Schema 同时提供常用关键字和完整 JSON。会话标题、已知事件字段和资源描述符通过具名方法读取。请求字段名、字段省略规则和状态码遵循当前服务端契约。

调用方提供租户、调用者、签名密钥和写请求的幂等键。与扩展客户端共用签名 HTTP 传输，保留入口的路径前缀，由调用方处理 HTTP 结果和重试。现有的 `extensions()` 方法返回扩展客户端。使用过 Map 签名的 SDK 调用方需要重新编译并迁移到请求构造器和 getter。

复用现有 SSE 帧解析器，提供可关闭的事件读取器。常规帧携带事件序号。收到重新同步帧时，将其交给调用方且保留原游标，由调用方读取 Items 后按重建后的快照序号重新订阅。提交回执表示已受理，并提供查询最终结果需要的标识。

## 验证

使用 Java 11 编译和本地 HTTP 测试服务验证类型化请求及响应、签名协议、字段省略规则、查询编码、状态与错误处理和 SSE 续读。使用独立服务验证类型化的会话创建、查询和消息链路。客户端测试与现有扩展测试一起运行。
