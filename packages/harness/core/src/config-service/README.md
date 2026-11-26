# ConfigService

`ConfigService` 定义配置值访问、更新订阅、请求就绪和服务生命周期的统一契约，
由 `@qwen-code/core` 导出。调用方无需了解配置来自环境变量、文件还是远端。

- `EnvConfigService` 是基础实现，实时读取 `QWEN_CONFIG_<UPPER_SNAKE_CASE>` 环境变量。
  未设置环境变量时，已知功能开关默认开启（自动记忆同时启用用户、项目范围及每轮后台提取）；
  显式环境变量值优先，包括关闭值和空字符串。功能所需的阈值、组织名单等参数沿用现有默认值，
  未知 key 和非开关配置仍返回 `undefined`，由消费者决定缺省行为。
- 产品层的 `QoderConfigService` 是 QCS 实现，管理身份隔离、首批配置、缓存/默认值降级及后台更新。
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

## Auto mode 审批预设名单

QCS namespace 为 `qodercli-feature-gates`，key 为 `auto_mode_review_presets`。
初始值直接使用 [autoModeReviewPresets.defaults.json](./features/autoModeReviewPresets.defaults.json)
的完整内容；该文件也是客户端内置兜底，保留原有硬编码名单。

有效配置整体替换预设名单，四个字段均必填：

- `commands`：小写命令名数组，精确匹配去除路径和 `.exe` 后缀后的命令名。
- `git_subcommands`：Git 子命令参数前缀数组，例如 `["reset"]`、`["stash", "drop"]`。
  匹配前仍会跳过 Git 全局参数；每个子数组至少包含一个参数。
- `find_delete`：是否复核 `find` 的 `-delete` 操作。
- `mkfs_variants`：是否复核 `mkfs.*` 命令。

命令名和子命令参数仅接受小写字母、数字、点、下划线、连字符，且以字母或数字开头，
不支持命令路径、空格、通配符或正则。两个数组都为空、两个开关都为 `false` 时，明确清空预设名单。
对象和 JSON 字符串均可下发；配置缺失、删除或任何字段非法时，整体回到内置默认值。
非法配置通过 `runLogger.warn` 记录配置 key 和使用默认值的提示，不记录配置原文。
连续读取相同非法值只告警一次；非法值变化时重新告警，恢复为有效配置或缺失后重置去重状态。
未配置该 key 不告警。

每次审批从 ConfigService 的本地缓存读取一次，配置更新作用于下一次审批，无需重启或额外网络请求。
配置只决定哪些命令进入审批模型复核，命中并不直接拒绝；原有权限规则、模型 `risk`、
危险命令、危险删除及受保护路径检查不受此配置影响。

## 职责边界和命名迁移

该服务提供配置值和更新。用户、项目、本地 settings 的文件读取、合并、优先级和
持久化由现有 settings 模块负责；Core `Config` 的会话运行时职责也保持原样。

原 `ConfigSourceService`、`EnvConfigSourceService` 和相应函数改为
`ConfigService`、`EnvConfigService` 和 `…ConfigService`；类型
`ConfigSourceReadiness` / `ConfigSourceErrorListener` 改为
`ConfigReadiness` / `ConfigErrorListener`。契约文件为 `config-service.ts`，
环境实现为 `env-config-service.ts`。

本次直接更名，不提供旧名称兼容别名。QCS 的命名空间、配置 key、环境变量、
来源元数据、请求时序、身份切换和停止语义均保持原样。
