# 会员 MCP 联网搜索

[English](subscription-mcp-web-search.md) | [简体中文](subscription-mcp-web-search.zh-CN.md)

## 问题与范围

会员模型推理已可用，但内置 `web_search` 目前只支持 DashScope 凭证。预发会员搜索服务在 `https://pre-api.qwen.ai/api/v1/mcp/web_search` 提供 MCP，使用已有设备 Access Token 鉴权。通过共用 Core 工具接入，使 CLI、VS Code 和桌面端使用同一套行为。

## 协议证据

真实 SDK 探测在完整 URL 上完成了 `initialize`（200）、`notifications/initialized`（204）、`tools/list`（200）和 `tools/call`（200）。服务端 `qwen-web-search` 0.1.0 提供 `web_search`：必填 `query` 字符串，长度 1–500；可选 `num`（1–20，默认 10）、`country`、`locale`、`location`。公开查询返回含编号结果、URL 和摘要的文本块，没有结构化来源字段，也未返回 MCP Session ID。证据位于 `.qwen/e2e-tests/subscription-mcp-protocol.json`。

## 实现方案

为 `WebSearchBackendConfig` 增加会员分支，并通过现有 MCP SDK 的 Streamable HTTP transport 实现小型后端。每次搜索创建独立客户端，初始化、发现 `web_search`、传入 `query` 调用，并在 `finally` 关闭。沿用服务端默认结果数量。合并返回文本块，仅从返回内容提取 HTTP(S) 链接作为未打开来源；引用规则、输出截断、权限及每会话次数限制继续由现有工具处理。超过 500 字符的查询及不支持或错误响应返回安全错误文案。

搜索使用自动配置时，仅在开发环境且当前鉴权为 `qwen-subscription` 时选择该后端。显式禁用，以及显式指定其他搜索模型或端点的配置，保留原有含义。鉴权切换成功后同步工具注册，覆盖已初始化的会话，并保留 bare、安全模式、Managed Runtime、子代理和权限边界。

每次 HTTP 请求都通过 `QwenSubscriptionSession.getAccessToken` 取 Token。固定完整 URL、拒绝重定向、复用运行时代理和会话 fetch 选项，合并调用取消与搜索总超时，并在 HTTP 401 时最多刷新一次。不把 Token 存入配置，也不暴露原始鉴权或传输错误。短生命周期客户端避免共用 MCP 池及跨工作区 transport 状态。

## 边界与验证

不注入 `mcpServers`、替换用户 MCP 条目、改动通用 MCP transport 或连接池、增加搜索配置开关，或改变 DashScope 搜索。用户配置的 MCP 服务与内置工具保持独立。

验证启用条件优先级、鉴权热切换注册、真实 SDK 协议及结果映射、动态 Token/401、取消和超时、错误脱敏、固定目的地和禁止重定向，以及已有 DashScope 回归。最后完成整仓构建、类型检查、打包，并使用会员模型实际调用内置搜索。验收要求拿到真实搜索结果及来源链接，不能只证明 MCP 连接成功。原生 GUI 行为仅在另行实际操作后宣称通过。验证已通过：1,090 项定向测试、整仓构建/类型检查/打包、定向 lint/格式检查，以及打包后 CLI 的真实会员请求。模型发现并调用内置搜索，收到结果并引用官方仓库。搜索 tools/call 返回 HTTP 200，request ID 为 `411b17f2-5d4e-406c-ba26-ad4918ff16a9`。成功对话后的后台记忆抽取另返回 HTTP 405；本次未操作原生 GUI 搜索。详见 E2E 报告。
