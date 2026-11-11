# ConfigService

`ConfigService` 定义配置值访问、更新订阅、请求就绪和服务生命周期的统一契约，
由 `@qwen-code/core` 导出。调用方无需了解配置来自环境变量、文件还是远端。

- `EnvConfigService` 是基础实现，实时读取 `QWEN_CONFIG_<UPPER_SNAKE_CASE>` 环境变量。
  未设置环境变量时，已知功能开关默认开启（自动记忆同时启用用户、项目范围及每轮后台提取）；
  显式环境变量值优先，包括关闭值和空字符串。功能所需的阈值、组织名单等参数沿用现有默认值，
  未知 key 和非开关配置仍返回 `undefined`，由消费者决定缺省行为。
- CLI 各运行模式的 Framework 默认创建 `EnvConfigService`；宿主可覆盖
  `createConfigService()` 提供其他实现。
- AppFramework 的 `createConfigService()` 创建服务，`getConfigService()` 返回持有的实例；
  `asyncInitConfigService` / `awaitInitConfigService` 和
  `asyncDisposeConfigService` / `awaitDisposeConfigService` 管理初始化与释放。
- Core 的 `installConfigService()` 注入同一个服务，`initializeConfigService()` 初始化，
  `stopConfigService()` 停止服务并清理登记状态；不再包装或额外创建产品服务。

## 配置读取与就绪

`getValue()` 返回原始配置值，具体业务消费者负责解析、校验和缺省策略。
`onValueChange()` 订阅某个 key 的后续更新，不保证立即回放当前值；消费者先读取，
再监听更新。`stop()` 使现有订阅失效，取消订阅函数允许重复调用。

`ensureConfigReadyForRequest()` 等待当前身份的首批配置完成或得到明确降级结果。
取消某个请求的等待不会取消服务共享的初始化。`ConfigReadiness` 的 `source` 字段
仍表示实际值来自 remote、local、cache 或 defaults，名称与取值保持原样。
需要独立新鲜读取的消费者仅在实现提供 `resolveValue()` 时使用该能力。

## 职责边界和命名迁移

该服务提供配置值和更新。用户、项目、本地 settings 的文件读取、合并、优先级和
持久化由现有 settings 模块负责；Core `Config` 的会话运行时职责也保持原样。

原 `ConfigSourceService`、`EnvConfigSourceService` 和相应函数改为
`ConfigService`、`EnvConfigService` 和 `…ConfigService`；类型
`ConfigSourceReadiness` / `ConfigSourceErrorListener` 改为
`ConfigReadiness` / `ConfigErrorListener`。契约文件为 `config-service.ts`，
环境实现为 `env-config-service.ts`。

本仓库不提供旧名称兼容别名。自定义实现应遵循 `ConfigService` 的读取、订阅、
请求就绪和停止契约。
