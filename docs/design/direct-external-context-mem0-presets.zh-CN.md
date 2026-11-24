# Direct External Context Mem0 预设

[English](direct-external-context-mem0-presets.md) | [简体中文](direct-external-context-mem0-presets.zh-CN.md)

**状态：** 已在私有直连集成中实现

**日期：** 2026-08-27

**相关设计：**
[Direct External Context Provider](./direct-external-context-provider.md)、
[Direct External Context Mem0 Write](./direct-external-context-mem0-write.md)、
[External Context Provider Extensions](./external-context-provider-extensions.md)

## 决策

私有 Direct External Context 集成使用单一的 `mem0` provider 类型，通过管理员选择的内置、带版本的预设连接兼容 Mem0 的 REST 服务。预设定义上游协议；实例配置只负责部署地址、凭据引用、固定作用域，以及继承自直连配置的超时时间。

这取代了把产品名与单一协议写死在一起的 provider 类型，例如 `polardb-mem0`。它不开放任意 API 版本、请求模板、自定义请求头映射、JSONPath 表达式或动态 provider 模块。模型可见的 MCP 契约仍是 `context_search({ query })`；仅当版本 1 配置显式启用写入且预设定义了已验证的直接导入操作时，才暴露 `context_remember({ content })`。

为向后兼容，继续接受现有的 `mem0-platform-v3` 配置。新部署使用 `type: "mem0"`。

## 为什么使用预设而不是 `apiVersion`

同一个上游产品的不同操作可能采用不同版本的路径。例如 PolarDB Mem0 的搜索和直接导入使用不同版本的路径。认证方式、作用域字段位置、结果字段、写入响应语义和末尾斜杠要求也可能各自变化，并不由一个数字版本决定。

因此，每个预设代表一套完整、已验证的契约。已发布的预设标识不可改变；上游若有不兼容变更，应增加新标识，而不是悄悄修改原有映射。

内置预设包括：

- `mem0-platform-v3`
- `mem0-oss-rest-2026-08`
- `aliyun-polardb-mysql-2026-08`
- `mem0-v2`
- `mem0-v3`
- `mem0-oss-2026-08`

## 配置

```json
{
  "version": 1,
  "timeoutMs": 5000,
  "provider": {
    "type": "mem0",
    "preset": "aliyun-polardb-mysql-2026-08",
    "endpoint": {
      "origin": "https://memory.example.com",
      "basePath": ""
    },
    "credentialEnv": "MEM0_API_KEY",
    "scope": {
      "userId": "repository-memory",
      "agentId": "qwen-code"
    }
  }
}
```

`origin` 只包含协议和主机部分；`basePath` 是可选的静态反向代理前缀。两者分别验证，避免拼接预设路径时丢失前缀或重新解释服务地址。地址配置不允许内嵌凭据、查询参数、片段、点路径、编码路径材料、空白和控制字符。

默认要求 HTTPS。本机回环 HTTP 可用于本地中继；非回环 HTTP 必须显式设置 `allowInsecureHttp`，此时凭据与记忆内容会以明文传输，仅适用于明确把可信私有网络纳入安全边界的部署。

预设声明使用哪些作用域字段，以及字段是必需还是可选。缺少必需字段，或配置了预设不使用的字段时，启动会拒绝该配置。作用域由管理员固定，绝不出现在模型工具参数中。

每个 MCP 子进程只加载一次绝对路径 `QWEN_EXTERNAL_CONTEXT_CONFIG`。同一 Qwen 会话内，包括 MCP 子进程重启后，该路径、文件内容、地址、预设、作用域及凭据与语料库的绑定都必须保持不变。修改任一项都需要新会话和新的配置路径。

## 有界的预设契约

内置预设只能选择经过审查的常量：

- `Authorization: Token`、`Authorization: Bearer` 或 `X-API-Key`
- 一个静态 POST 搜索路径
- 作为结果数量字段的 `top_k` 或 `limit`
- `user_id`、`agent_id`、`app_id` 放在 JSON 根级、`filters` 下，或省略
- 封闭集合内的固定搜索选项，例如 `threshold` 和 `rerank`
- 带有已审查 ID 和内容字段的 `results` 响应集合
- 仅针对标记 `infer: false` 的 `mem0-v2` 结果，可选的单条用户消息直接导入解码
- 可选的静态直接导入路径及一种已审查的响应映射

引擎向上游请求的数量上限始终为 5，并最多保留 5 个有效结果。它不会重试、跟随重定向、探测其他路径或在预设之间回退。格式错误的单条结果独立丢弃；响应外层格式错误则使请求失败。

新增预设需要权威的协议证据及请求、响应契约测试。不能纳入这个语法范围的服务，应按 External Context Provider Extensions 设计实现自己的本地或远程 MCP Extension，而不是把这份配置扩展成编程语言。

## 初始映射

### Mem0 Platform V3

- 搜索：`POST /v3/memories/search/`
- 认证：`Authorization: Token`
- 作用域：必需的 `appId` 放在 `filters.app_id`
- 数量字段：`top_k`
- 直接导入：`POST /v3/memories/add/`，`infer: false`
- 写入响应：`PENDING` 加 UUID 格式的 `event_id` 表示 `accepted`；只有 `SUCCEEDED` 表示 `stored`

旧的 `mem0-platform-v3` 配置仍作为这个映射的固定地址简写。

### Mem0 OSS REST 2026-08

- 搜索：`POST /search`
- 认证：`X-API-Key`
- 作用域：必需的 `userId` 和可选的 `agentId` 放在 `filters` 下
- 数量字段：`top_k`
- 直接导入：`POST /memories`，`infer: false`
- 写入响应：有效的 `results[].id` 表示 `stored`，否则表示 `unknown`

该映射对应标准 `mem0ai/mem0` REST 服务。使用 Bearer 认证的部署需要单独验证的预设，而不是按实例覆盖认证方式。

### Aliyun PolarDB MySQL 2026-08

- 搜索：`POST /v2/memories/search`
- 认证：`Authorization: Token`
- 作用域：必需的 `userId` 放在 `filters` 下，可选的 `agentId` 放在顶层
- 数量字段：`top_k`
- 直接导入：`POST /v1/memories`，`infer: false`
- 写入响应：有效的 `results[].id` 表示 `stored`，否则表示 `unknown`

历史标识 `aliyun-polardb-mysql-2026-08` 保持 `top_k` 与原样返回搜索内容。新的 `mem0-v2` 映射使用 `limit`，并仅对标记 `infer: false` 的直接导入结果提取一条非空用户消息。普通文本、其他消息数组和未带该标记的结果保持原样。`mem0-v3` 与 `mem0-oss-2026-08` 分别是旧 V3 和 OSS 契约的别名，不改变原有行为。

仅有 `event_id` 不能证明写入已持久化。如果未来 PolarDB 契约规定了异步事件轮询，应新增预设和写入设计，而不是原地更改这个预设。

## 协议依据

- Mem0 Platform V3 基于官方[搜索 API](https://docs.mem0.ai/api-reference/memory/search-memories)及 [V2 到 V3 迁移契约](https://docs.mem0.ai/migration/platform-v2-to-v3)。
- Mem0 OSS REST 固定在上游提交 [`39bc023`](https://github.com/mem0ai/mem0/tree/39bc02330563764e7d4465f1ecff5f002d94da1a)，具体参考 [`server/main.py`](https://github.com/mem0ai/mem0/blob/39bc02330563764e7d4465f1ecff5f002d94da1a/server/main.py) 与 [`server/auth.py`](https://github.com/mem0ai/mem0/blob/39bc02330563764e7d4465f1ecff5f002d94da1a/server/auth.py)。
- PolarDB 预设基于官方 [PolarDB for MySQL Mem0 契约](https://help.aliyun.com/en/polardb/polardb-for-mysql/use-polardb-mem0)及[该 PR 记录的真实端到端证据](https://github.com/QwenLM/qwen-code/pull/9952#issuecomment-5407141853)。公开文档涵盖地址、认证和作用域字段位置；真实实例还验证了直接导入时会遵守 `infer: false`。

测试必须持续固定这些确切的请求与响应形状。上游协议若发生不兼容变化，应添加新预设标识，而不是原地修改已有映射。

## 与 provider Extension 的关系

这个 provider 是已有私有 `integrations/external-context` 进程内的有界兼容功能，不是公开的 provider 注册表。第三方团队仍通过 MCP Extension 独立维护与发布其集成。只有 Qwen 维护者明确验证并愿意维护的 Mem0 系列契约，才适合直连预设路径。

同一语料库只能启用这个直连服务或另一个 Mem0 Extension，不能同时启用。暴露两个 `context_search` 工具会把 provider 选择交给模型，还可能产生重复查询。

## 验证

实现必须证明：

- 严格解析配置，并在预设或作用域无效时拒绝启动
- 安全拼接 `origin` 与 `basePath`
- 对每个预设准确映射认证、路径、作用域和数量字段
- 逐条规范化响应，并将结果上限控制在 5
- 保留历史预设的响应行为，同时限制 `mem0-v2` 的直接导入解码范围
- 保守判断同步与异步写入的结果
- 搜索和写入失败时不重试
- 随包提供的 PolarDB 和 OSS 示例可加载
- 保持现有 `mem0-platform-v3` 配置兼容
