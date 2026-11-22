# DeepInfra 服务商预设与 Service Tier 支持设计

[English](deepinfra-provider-and-service-tier.md) | [简体中文](deepinfra-provider-and-service-tier.zh-CN.md)

## 背景与问题陈述

DeepInfra 是一家 Serverless AI 推理平台，通过 OpenAI 兼容 API 托管热门开源大语言模型（如 DeepSeek-V3、DeepSeek-R1、Llama 3.3 和 Qwen 2.5 等）。除标准实时推理之外，DeepInfra 还提供了 **Flex** 服务层级（service tier）：通过尽力而为调度（最多排队等待 10 分钟，若容量不足返回 HTTP 429 且不扣费），以 0.8× 价格（立减 20%）运行对延迟不敏感的工作负载。

在本次改动之前，Qwen Code 缺少：

1. 第三方服务商注册表中的 DeepInfra 内置预设。
2. 通过配置（`generationConfig`）、服务商预设、环境变量以及 CLI 参数原生指定 `service_tier`（例如 DeepInfra 的 `flex`，或 OpenAI 的 `priority`/`auto`/`default`/`flex`）的能力。

## 目标

- 将 DeepInfra 添加为第三方内置服务商预设，使用其 OpenAI 兼容端点（`https://api.deepinfra.com/v1/openai`）与 `DEEPINFRA_API_KEY`。
- 支持在 `modelProviders[].generationConfig`、`model.generationConfig`、服务商/模型预设、环境变量（`OPENAI_SERVICE_TIER`、`DEEPINFRA_SERVICE_TIER`）和命令行参数（`--service-tier`）中配置 `service_tier`（包含 `flex`）。
- 将 `service_tier` 透传至发往底层 OpenAI Chat Completions 及 OpenAI Responses API 的请求体中。
- 提供完备的单元测试覆盖与文档更新。

## 非目标

- 实现服务商特定的离线批量异步 API（DeepInfra Flex 仍然是同步 API 调用）。
- 在用户显式传入覆盖参数时强制修改用户参数。

## 方案与架构设计

### 1. DeepInfra 服务商预设

DeepInfra 注册为 OpenAI 兼容服务商：

- **服务商 ID**：`deepinfra`
- **显示名称**：`DeepInfra`
- **协议**：`AuthType.USE_OPENAI`
- **基地址**：`https://api.deepinfra.com/v1/openai`
- **环境变量名**：`DEEPINFRA_API_KEY`
- **预置模型**：精选热门模型（`deepseek-ai/DeepSeek-V3`、`deepseek-ai/DeepSeek-R1`、`meta-llama/Llama-3.3-70B-Instruct`、`Qwen/Qwen2.5-Coder-32B-Instruct`），配置 `modelsEditable: true`。
- **归属判断门禁**：双重检查，要求 `model.envKey === DEEPINFRA_ENV_KEY` 且主机名为 `api.deepinfra.com` 或以 `.deepinfra.com` 结尾。
- **归属标头**：配置 `HTTP-Referer` 与 `X-Title` 进行请求归属标识。
- **界面分组**：`third-party`。

### 2. Service Tier 配置与请求透传

`service_tier` 参数在整条调用链路中得到完整支持：

1. **配置层**：将 `service_tier` 纳入 `ContentGeneratorConfig`、`ModelGenerationConfig` 与 `MODEL_GENERATION_CONFIG_FIELDS`。
2. **服务商预设**：在 `ModelSpec`、`ProviderConfig` 和 `ProviderSetupInputs.advancedConfig` 中增加 `service_tier`，允许服务商与模型声明默认服务层级。
3. **模型配置解析器**：支持从 CLI（`--service-tier`）、`modelProviders[].generationConfig.service_tier`、`model.generationConfig.service_tier` 或环境变量（`OPENAI_SERVICE_TIER`、`DEEPINFRA_SERVICE_TIER`）解析 `service_tier`。
4. **Chat Completions 调用链路**：`openaiContentGenerator` 在 `baseRequest` 中包含 `service_tier`，并在 `DefaultOpenAICompatibleProvider.buildRequest` 中妥善保留，允许通过 `extra_body.service_tier` 进行覆盖。
5. **Responses 调用链路**：`openaiResponsesContentGenerator` 在 `ResponsesApiRequest` 中携带 `service_tier`，并扩展 `ResponsesApiServiceTier` 类型以支持 `'flex'`。

## 验证计划

- `deepinfraProvider` 预设的归属判断、URL 校验与请求头单元测试。
- `modelConfigResolver.test.ts` 中针对 `service_tier` 解析优先级的单元测试。
- `DefaultOpenAICompatibleProvider` 与 `openaiResponsesContentGenerator` 中针对 `service_tier` 透传的单元测试。
- Auth 命令与 CI 环境变量快照测试。

## 验收条件

- DeepInfra 正常显示在 `/auth` 的第三方服务商列表中。
- 设置 `service_tier: "flex"`（无论是通过 settings、环境变量还是 `--service-tier flex`）后，请求体中包含 `"service_tier": "flex"`。
- 所有单元测试和类型检查均能顺利通过，无任何回归问题。
