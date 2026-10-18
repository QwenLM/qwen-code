# 按模型设置自动压缩阈值

[English](model-auto-compaction-threshold.md) | [简体中文](model-auto-compaction-threshold.zh-CN.md)

## 状态与问题

本文是 [#14395](https://github.com/QwenLM/qwen-code/issues/14395) 的本地实现设计。
配置形态尚未获得维护者批准。验证结果应记录在实现的测试报告中，本文不声明验证已通过。

`context.autoCompactThreshold` 为所有模型提供同一个比例。`0.85` 对 262,144 token
的模型合适，却会让 1,000,000 token 的模型直到 850,000 token 才压缩。为提前压缩而
调小 `contextWindowSize`，还会减少主请求的可用输出预算。因此，压缩时机和模型的
真实容量需要独立设置。

## 范围与配置

新增可选的 `modelProviders[provider][].generationConfig.autoCompactThreshold`。
它沿用全局设置的语义：取值范围为 `(0, 1]` 的数值比例。不引入模型前缀映射、绝对
token 设置、新 CLI 选项或提供商请求参数。

按以下顺序解析实际使用的比例：

1. 显式传入的请求生成配置中有效的 `autoCompactThreshold`；未传入时使用实际
   content generator 的配置，包括 AsyncLocalStorage 运行时覆盖或派生代理的
   generator。generator 尚未创建时，改用 `ModelsConfig.getGenerationConfig()`。
2. 有效的全局 `context.autoCompactThreshold`。
3. `computeThresholds` 现有默认值 `0.85`。

模型值缺失或无效时回退到全局值。显式请求配置或已存在的 generator 没有有效覆盖时，
不能回退到主模型或父模型的 generation config。零、负数、大于一的值、字符串、
`NaN` 和无穷大均无效。全局值也缺失或无效时，getter 仍返回 undefined，保留
`computeThresholds` 中的现有默认值。

## 解析与生命周期

将字段加入 `ContentGeneratorConfig`、`ModelGenerationConfig` 和
`MODEL_GENERATION_CONFIG_FIELDS`，让现有解析、来源追踪、注册模型替换和快照处理
统一传递它。在 `Config.getAutoCompactThreshold()` 中完成校验和模型／全局优先级
选择；所有消费点共用此 getter。

`LoggingContentGenerator` 将其绑定的生成配置通过 `createContextUsageSnapshot`
可选的第四个参数传给 getter。因此，没有 AsyncLocalStorage 覆盖的精确路由和
视觉请求，也会从请求绑定的配置中解析比例。快照窗口沿用该配置现有的解析和回退
行为。修正路由请求继承的会话窗口不在本次变更范围内。

切换已注册模型时，用目标模型的值替换覆盖值，包括目标未设置该字段的情况。
派生代理的认证类型、模型或显式未注册地址与父模型不同时，不能继承父模型的覆盖，
即使模型 ID 相同也如此。主模型切换到原始模型时，清除来自
`modelProviders` 的覆盖，但按现有运行时配置语义保留显式 runtime/settings 生成值。
恢复运行时模型快照时，同时恢复快照自己的 generation config 及其来源。
Qwen OAuth 热切换时清除上一模型的覆盖，因为这些模型是内置的，无法通过
`modelProviders` 自定义。

保留真实的 `contextWindowSize` 和现有 warn/auto/hard 公式：

- Auto 将所选比例与现有绝对安全上限结合。
- Warn 和 hard 继续按现有阈值阶梯计算。
- 主请求的输出预算继续使用真实的上下文窗口。

本次不重新设计上下文窗口推导，也不解决
[#13338](https://github.com/QwenLM/qwen-code/issues/13338) 和
[#13415](https://github.com/QwenLM/qwen-code/issues/13415) 中更广泛的窗口问题。
本次确保新比例跟随实际模型，并验证切换已注册的主模型时仍保留各自显式配置的窗口。

## 受影响的生产代码路径

实现修改以下现有文件：

| 路径                                                                        | 职责                                   |
| --------------------------------------------------------------------------- | -------------------------------------- |
| `packages/core/src/core/contentGenerator.ts`                                | 声明可选的 generator 字段。            |
| `packages/core/src/models/types.ts`                                         | 在模型生成配置中暴露该字段。           |
| `packages/core/src/models/constants.ts`                                     | 将字段纳入统一的生成字段处理。         |
| `packages/core/src/models/modelsConfig.ts`                                  | 按所选模型和快照保留或清除该字段。     |
| `packages/core/src/models/content-generator-config.ts`                      | 解析派生模型，避免继承其他模型的覆盖。 |
| `packages/core/src/config/config.ts`                                        | 解析实际使用的模型／全局比例。         |
| `packages/core/src/core/loggingContentGenerator/loggingContentGenerator.ts` | 将请求绑定的生成配置传给上下文快照。   |
| `packages/core/src/core/loggingContentGenerator/context-usage-snapshot.ts`  | 从传入的请求配置解析快照比例。         |

`packages/core/src/models/modelConfigResolver.ts` 使用共享字段列表，必须保留新增
字段，无需另外增加解析逻辑。以下五个阈值消费点继续使用共享 getter：

| 路径                                                                       | 消费点             |
| -------------------------------------------------------------------------- | ------------------ |
| `packages/core/src/services/chatCompressionService.ts`                     | 自动压缩入口判断。 |
| `packages/core/src/core/llm-chat.ts`                                       | Hard 阈值救场。    |
| `packages/core/src/core/loggingContentGenerator/context-usage-snapshot.ts` | 上下文使用量快照。 |
| `packages/cli/src/ui/commands/contextCommand.ts`                           | `/context` 展示。  |
| `packages/cli/src/ui/hooks/useContextualTips.ts`                           | 上下文警告提示。   |

## 决策与风险

模型级比例复用全局设置的含义和现有模型注册表，避免引入另一套匹配系统。
绝对 token 接口会增加优先级与安全语义，而本用例并不需要：对于 1,000,000 token
的窗口，`0.25` 已能表达在 250,000 token 时压缩。安全上限仍优先生效，因此比例
表达的是偏好，并不承诺在精确的 token 数触发。

主要风险是模型身份变化或子代理共享父配置时遗留覆盖值。集中读取并逐一测试
生命周期边界可控制这一风险。未设置此字段的现有配置继续使用全局／默认行为。
凭证、请求体设置、压缩提示词和数据库状态均不改变。

## 验证与验收标准

- 实现前使用真实配置、模型解析器、阈值计算和输出预算函数复现功能缺口；
  不声称复现了提供商截断或工具调用参数损坏。
- 全局设为 `0.85` 时，配置 `0.25` 的 1,000,000 token 模型的 auto 阈值为
  250,000；未设置覆盖的 262,144 token 模型的 auto 阈值为 222,822.4。
  反复切换仍保留各自的比例和上下文窗口。
- 大模型保留 1,000,000 token 的真实窗口，以及在 250,000 token 提示输入下
  原有的输出预算。
- 验证缺失／无效模型值和全局值，以及有效边界值 `1`，均按规定回退或解析。
- 验证初始化、实际运行时／派生 generator、同提供商子模型、未知／原始模型选择、
  运行时快照恢复和 OAuth 切换不会泄漏上一模型的覆盖。
- 验证原始子代理请求使用不同的显式未注册地址时，无论模型 ID 缺失还是保持不变，
  都不会继承父模型的比例。
- 对于没有 AsyncLocalStorage 的请求，目标比例为 `0.8` 或未设置覆盖时，应使用
  该比例或全局／默认值，不能读取主模型的 `0.25`。
- 通过共享 getter 检查五个消费点，并保留现有阈值阶梯回归测试。
- 在对应包目录运行针对性单元测试，完成构建、类型检查、lint／格式检查和独立
  修改后验证。

维护者是否接受此配置形态仍需上游审阅；这不能替代上述本地验收标准。
