# Kimi, Qwen and DeepSeek reasoning model presets

[English](2026-09-08-reasoning-model-presets.md) | [简体中文](2026-09-08-reasoning-model-presets.zh-CN.md)

## Problem and boundaries

PR #10999 introduced declarative reasoning capabilities but configured tiers only for native DeepSeek V4 Pro. Other models still rely on the legacy table or generic tiers, and native Kimi installs an enable_thinking field outside its protocol. This change expands provider presets and regression coverage through the existing installer, registry, ACP/WebShell, TUI and request pipeline without adding model-name checks.

Qwen 3.8 Flash exposed a legacy Max-only DashScope check that appended enable_thinking even after tiers were declared. The existing tiered-protocol predicate now prioritizes the resolved capability, and UI static-override reporting uses the same predicate. Unconfigured models retain the name fallback. Alibaba Kimi K3 accepts text/images; native Moonshot K3 retains video input.

CLI mock acceptance also found that provider defaults overwrite the global off preference during initial authentication. refreshAuth previously restored only tiers. It now restores reasoning=false in both live and rebuildable configuration so headless startup's two consecutive authentications preserve Off; mandatory-thinking models remain exempt. Authentication and hot-reload rebuilds preserve the session preference following the existing tier policy; model switching still applies the target model's defaults through its existing flow.

## Configuration matrix

| Route / model                                                    | Tiers or toggle              | Default tier     | Disable field         |
| ---------------------------------------------------------------- | ---------------------------- | ---------------- | --------------------- |
| Moonshot K3                                                      | low / high / max             | max              | Cannot disable        |
| Moonshot K2.7 Code / Highspeed                                   | Mandatory thinking, no tiers | Provider default | Cannot disable        |
| Moonshot K2.6                                                    | Toggle                       | Provider default | thinking.type         |
| Native DeepSeek V4 Pro / Flash                                   | low / high / max             | high             | thinking.type         |
| Alibaba Standard Qwen 3.8 Max / Max-0902 / Flash                 | low / medium / xhigh         | xhigh            | reasoning_effort=none |
| Existing Alibaba Qwen 3.5 / 3.6 / 3.7 and Qwen3 Max-0123 hybrids | Toggle                       | Retain preset On | enable_thinking       |
| Alibaba DeepSeek V4 Pro / Flash                                  | high / max                   | high             | enable_thinking       |
| Alibaba DeepSeek V4 Pro-0813 / Flash-0731                        | low / high / max             | high             | enable_thinking       |
| Alibaba Standard Kimi K3                                         | low / high / max             | max              | Cannot disable        |
| Alibaba Standard / existing Token Plan Kimi K2.7 Code            | Mandatory thinking, no tiers | Provider default | Cannot disable        |
| Alibaba Standard / existing plan Kimi K2.6 / K2.5                | Toggle                       | Retain preset On | enable_thinking       |

The existing Token Plan DeepSeek V3.2 entry also gains an enable_thinking toggle capability.

Token Plan adds the listed Qwen 3.8 Flash and DeepSeek V4 Pro-0813 entries, retaining the existing mandatory-thinking restrictions on 3.8 Max / Preview and reflecting them in canDisable. Preview remains as an existing compatibility alias. Coding Plan adds capabilities only to existing hybrids, without adding models. Native DeepSeek stable IDs already point to the newer snapshots; Alibaba snapshot IDs are not assumed to be native API IDs.

## Native tiers and compatibility inputs

Qwen 3.8's native choices are low / medium / xhigh. The official Chat parameter reference also maps high and max to xhigh, so high in the legacy input ladder does not introduce another native tier. Explicit capabilities expose native choices only; unsupported persisted values are omitted and use the provider default (xhigh for Qwen 3.8). Routes without capabilities retain their existing clamp and warning for compatibility; explicit extra_body / samplingParams remain provider overrides. This is intentional configuration precedence, not a claim that the provider rejects high or max. No-argument /effort reports the model/provider default for unsupported saved tiers without modifying settings.

## Implementation and acceptance

Update the moonshot, deepseek, alibaba-standard, alibaba-token-plan and alibaba-coding-plan presets. Native Kimi removes enableThinking because its API defaults thinking on. Mandatory models retain thinkingMandatory and declare canDisable=false for existing generation-config consumers. toggleOnly declares no fabricated tiers. Alibaba Standard DeepSeek V4 Pro removes the redundant enableThinking; high/max send reasoning_effort alone, while Off still sends enable_thinking=false.

Preset installation tests inspect real configuration output. Request tests build configurations from real presets and assert the final payload. ACP tests verify exact choices and defaults. Coverage includes Off, non-thinking side queries, invalid tiers and unknown models. Run build, typecheck, bundle, focused tests and lint, and drive CLI acceptance against a mock API with isolated settings. Live paid provider requests are not part of local validation.

Presets affect new installations or provider reconfiguration. Existing settings are not automatically migrated or modified. Regional availability depends on the provider and account; existing endpoint scope is not expanded. GLM, MiniMax, Step, OpenRouter, ModelScope, Idealab and independent boundaries tracked in #11328 are outside this change.

## Official evidence (checked 2026-09-08)

- [Kimi K3](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart): three tiers, default max, always thinking.
- [Kimi K2.7 Code](https://platform.kimi.ai/docs/guide/kimi-k2-7-code-quickstart): thinking defaults on and cannot be disabled.
- [Kimi K2.6](https://platform.kimi.ai/docs/guide/kimi-k2-6-quickstart): thinking.type toggle.
- [DeepSeek Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/) and [model entry point](https://api-docs.deepseek.com/): native stable-ID versions, three tiers and disable shape.
- [Alibaba Chat parameters](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions): family-specific tiers/defaults, enable_thinking and Qwen 3.8 parameter exclusivity.
- [Alibaba DeepSeek](https://help.aliyun.com/zh/model-studio/deepseek-api): stable-versus-snapshot tier differences.
- [Alibaba Kimi](https://help.aliyun.com/zh/model-studio/kimi-api): models and routes; max-only kimi/kimi-k3 is not added.
- [Token Plan model list](https://help.aliyun.com/zh/model-studio/token-plan-personal-overview): added Flash, Pro snapshot and Preview alias.
