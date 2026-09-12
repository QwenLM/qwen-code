# Daemon REST API 接口文档

[English](daemon-rest-api-reference.md) | [简体中文](daemon-rest-api-reference.zh-CN.md)

## 状态

在本次变更中实现。

## 问题

`qwen serve` 已有详细的 HTTP 协议文档和较短的接入指南，但没有发布机器可读的
API 定义。集成方必须同时查阅说明文字、路由处理器、capability 文档和 TypeScript
SDK 方法，才能确认基本接口信息。REST 接入指南筛选出的接口中还有 8 个缺少独立
协议章节。

## 目标

- 为 REST 接入指南作为受支持接入面列出的 25 个路由发布 OpenAPI 3.1 定义。
- 为每个操作写明请求参数或请求体、成功及通用错误响应、所需 capability、所有权
  作用域、稳定性，以及存在时对应的 TypeScript SDK 方法。
- 补齐 8 个缺失的协议章节，并让 quickstart 命令可以直接运行。
- 当指南、OpenAPI 路径、协议章节或已注册 Express 路由发生漂移时让 CI 失败。
- 产出可由 `qwen-code-docs` 渲染为独立 Daemon REST API Reference 的文件。

## 非目标

- 不把 daemon 中仅供 Web Shell 使用或有条件注册的内部路由提升为公共接入契约。
- 本次变更不增加运行时 `/openapi.json` 路由，也不改变 daemon 请求处理。
- 本次变更不宣称支持多用户安全主体模型、容器编排或未经验证的反向代理部署。
- ACP-over-HTTP 和 WebSocket API 继续使用现有参考文档。

## 公共接口面

公共 REST Reference 就是 `docs/developers/rest-api-integration.md` 已列出且由
`rest-integration-docs-contract.test.ts` 守护的 25 个操作，覆盖发现、Session
生命周期、prompt 与 SSE、权限以及只读工作区上下文。当前 daemon 还为第一方 UI
和条件功能注册了大量其他路由；将它们写入 OpenAPI 会错误地把实现面变成兼容性
承诺。

## 产物

### OpenAPI 定义

`docs/developers/daemon-rest-api.openapi.json` 是纳入版本控制的 OpenAPI 3.1
契约。采用 JSON 后，现有 Node/Vitest 工具链无需增加依赖或维护第二份生成源即可解析。
每个操作包含：

- 稳定的 `operationId`、能力分组和摘要；
- path、query 和 header 参数；
- 请求与响应 schema 及相关 wire 约束；
- `x-qwen-capability`、`x-qwen-scope`、`x-qwen-stability` 和
  `x-qwen-sdk-method` 元数据；
- 每个操作都要求 bearer 认证；`/health` 仅在 loopback 上的例外写在该操作的
  description 中，而不是一个匿名的 `security` 备选项；
- SSE 操作的 `text/event-stream` 和共享事件 envelope。

该规范描述当前 wire contract；TypeScript SDK 仍是强类型客户端实现，本次变更
不将它改成生成代码。

### 人类可读 Reference

`docs/developers/daemon-rest-api-reference.md` 说明如何使用 OpenAPI 产物，并按
能力提供一份操作索引。详细行为继续放在 `qwen-serve-protocol.md` 中，Reference
通过链接复用，而不复制数千行生命周期说明。

接入指南继续面向任务，链接到 Reference，并保留可运行的完整生命周期示例。

### 补齐协议章节

协议文档新增以下独立章节：

- `GET /session/:id/status`
- `GET /session/:id/export`
- `GET /session/:id/pending-prompts`
- `POST /session/:id/permission/:requestId`
- `GET /workspace/tools`
- `GET /stat`
- `GET /list`
- `GET /glob`

## 事实来源与防漂移

运行时 handler 仍是行为事实来源，OpenAPI 定义是权威的可移植接口产物。扩展现有
文档契约测试，在以下位置之间比较精确的 HTTP method/path 对：

1. 接入指南；
2. OpenAPI 文档；
3. 独立协议标题；
4. 已注册的 Express 路由字面量。

测试还要求每个 OpenAPI 操作声明 Qwen 元数据、认证姿态和至少一个成功响应。这样
无需加载完整 daemon，就能发现路由重命名和不完整的新 Reference 条目。由于 handler
目前没有共用的运行时 schema 系统，详细字段语义仍需正常代码评审。

## 文档站交接

本次变更合并后，`qwen-code-docs` 将通过独立变更把 OpenAPI 产物复制到静态站点、
增加 Reference 导航并完成渲染。本仓库拥有 API 契约，站点仓库拥有展示、翻译和部署。

## 安全与兼容性

- 不改变服务器行为或认证默认值。
- 非 loopback 地址绑定示例旁明确说明必须在 daemon 或经过验证的 TLS 终止层启用
  TLS。
- bearer 值继续通过环境变量和 curl header 文件描述符传递，不进入进程参数。
- Reference 明确保留 process-global、selected-runtime、persisted-workspace、
  live-session-owner 和 legacy-primary 等所有权差异。

## 验证

- 从 `packages/cli` 运行聚焦的 REST 文档契约测试。
- 通过契约测试解析并验证 OpenAPI JSON。
- 全部实现完成后一次性运行格式化及相关 package 的 type/build 检查。
- 在后续站点仓库变更中构建文档站。

## 验收标准

- 25 个接入操作在 OpenAPI 中各出现一次，并各有独立协议章节。
- 接入指南不再包含“尚无独立参考章节”的提示。
- 最小流程会赋值 `SID`、把 SSE 放在另一个终端，并说明如何从
  `permission_request` 得到 `REQUEST_ID`。
- bridge 链接不再落入文档站路由空间，非 loopback 示例包含 TLS 提醒。
- 引用操作缺失、重命名或元数据不完整时 CI 失败。
- 本次变更不把其他 daemon 路由描述为公共接口。
