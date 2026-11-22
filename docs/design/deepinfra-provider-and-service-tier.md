# DeepInfra Provider Preset and Service Tier Support

[English](deepinfra-provider-and-service-tier.md) | [简体中文](deepinfra-provider-and-service-tier.zh-CN.md)

## Context and Problem Statement

DeepInfra is a serverless AI inference platform offering fast, cost-effective access to popular open-source LLMs (such as DeepSeek-V3, DeepSeek-R1, Llama 3.3, and Qwen 2.5) via an OpenAI-compatible API. In addition to standard real-time inference, DeepInfra provides a **Flex** service tier that runs workloads at a 20% discount (0.8× pricing) using best-effort scheduling with up to 10 minutes wait time, returning HTTP 429 without charge if capacity is unavailable.

Previously, Qwen Code lacked:

1. A built-in provider preset for DeepInfra in the third-party providers registry.
2. First-class support for specifying a `service_tier` (such as `flex` on DeepInfra, or `priority`/`auto`/`default`/`flex` on OpenAI) through configuration (`generationConfig`), provider presets, environment variables, and CLI arguments.

## Goals

- Add DeepInfra as a first-class third-party provider preset using its OpenAI-compatible endpoint (`https://api.deepinfra.com/v1/openai`) and `DEEPINFRA_API_KEY`.
- Enable configuration of `service_tier` (including `flex`) across `modelProviders[].generationConfig`, `model.generationConfig`, provider presets/specs, environment variables (`OPENAI_SERVICE_TIER`, `DEEPINFRA_SERVICE_TIER`), and the CLI (`--service-tier`).
- Wire `service_tier` to outgoing OpenAI Chat Completions and OpenAI Responses API requests.
- Provide full test coverage and documentation updates.

## Non-Goals

- Implementing provider-specific offline batch asynchronous APIs (DeepInfra Flex is a synchronous API call).
- Overriding user-specified custom request parameters when explicit parameters are provided.

## Proposed Solution & Architecture

### 1. DeepInfra Provider Preset

DeepInfra is registered as an OpenAI-compatible provider:

- **Provider ID**: `deepinfra`
- **Label**: `DeepInfra`
- **Protocol**: `AuthType.USE_OPENAI`
- **Base URL**: `https://api.deepinfra.com/v1/openai`
- **Env Key**: `DEEPINFRA_API_KEY`
- **Models**: Curated starter models (`deepseek-ai/DeepSeek-V3`, `deepseek-ai/DeepSeek-R1`, `meta-llama/Llama-3.3-70B-Instruct`, `Qwen/Qwen2.5-Coder-32B-Instruct`) with `modelsEditable: true`.
- **Ownership Gate**: Dual-gate requiring `model.envKey === DEEPINFRA_ENV_KEY` and host ending in `.deepinfra.com` or equal to `api.deepinfra.com`.
- **Attribution Headers**: `HTTP-Referer` and `X-Title` set for request attribution.
- **UI Group**: `third-party`.

### 2. Service Tier Configuration and Wire Propagation

The `service_tier` parameter is supported end-to-end:

1. **Config Layer**: Added `service_tier` to `ContentGeneratorConfig`, `ModelGenerationConfig`, and `MODEL_GENERATION_CONFIG_FIELDS`.
2. **Provider Presets**: Added `service_tier` to `ModelSpec`, `ProviderConfig`, and `ProviderSetupInputs.advancedConfig`. Providers and model specifications can declare a default `service_tier`.
3. **Model Configuration Resolver**: Resolves `service_tier` from CLI (`--service-tier`), `modelProviders[].generationConfig.service_tier`, `model.generationConfig.service_tier`, or environment variables (`OPENAI_SERVICE_TIER`, `DEEPINFRA_SERVICE_TIER`).
4. **Chat Completions Wire**: `openaiContentGenerator` includes `service_tier` on `baseRequest` and preserves it through `DefaultOpenAICompatibleProvider.buildRequest`, allowing `extra_body.service_tier` overrides.
5. **Responses Wire**: `openaiResponsesContentGenerator` includes `service_tier` on `ResponsesApiRequest` and broadens `ResponsesApiServiceTier` to allow `'flex'`.

## Validation Plan

- Unit tests for `deepinfraProvider` preset ownership checks, URL validation, and attribution headers.
- Unit tests for `service_tier` resolution in `modelConfigResolver.test.ts`.
- Unit tests for `service_tier` propagation in `DefaultOpenAICompatibleProvider` and `openaiResponsesContentGenerator`.
- Auth command and CI environment snapshot tests.

## Acceptance Criteria

- DeepInfra appears in `/auth` under Third-Party Providers.
- Setting `service_tier: "flex"` (via settings, env var, or `--service-tier flex`) emits `"service_tier": "flex"` in the request payload.
- All unit and type tests pass without regressions.
