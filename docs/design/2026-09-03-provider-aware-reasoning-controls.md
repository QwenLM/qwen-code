# Provider-aware reasoning controls

## Motivation

Reasoning controls cannot be selected from a model ID alone. The same ID can
be served by a first-party API, Alibaba Model Studio, a subscription endpoint,
or an unrelated OpenAI-compatible endpoint, and those routes do not accept the
same request fields or effort tiers.

This change introduces one core resolver keyed by the complete model ID,
authentication protocol, and parsed endpoint hostname. CLI and ACP surfaces
project that result into the existing `reasoning_effort` session option, while
the request pipeline uses the same result to choose the wire shape.

## Evidence and capability matrix

Model IDs are matched case-insensitively but as complete strings. A snapshot or
alias is supported only when it appears explicitly below.

| Endpoint family                            | Models                                                                         | Controls                 | Default          | Disable wire shape        | Effort wire shape            |
| ------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------ | ---------------- | ------------------------- | ---------------------------- |
| Qwen OAuth / Alibaba Standard / Token Plan | `qwen3.5-plus`, `qwen3.6-plus`, `qwen3.6-flash`, `qwen3.7-plus`, `qwen3.7-max` | On / off                 | Provider default | `enable_thinking: false`  | None                         |
| Qwen OAuth / Alibaba Standard / Token Plan | `qwen3.8-max`, `qwen3.8-max-0902`, `qwen3.8-flash`                             | `low`, `medium`, `xhigh` | `xhigh`          | `reasoning_effort: none`  | Top-level `reasoning_effort` |
| DeepSeek API                               | `deepseek-v4-pro`, `deepseek-v4-flash`                                         | `high`, `max`            | `high`           | `thinking.type: disabled` | Top-level `reasoning_effort` |
| Alibaba Standard / Token Plan              | `deepseek-v4-pro`, `deepseek-v4-flash`                                         | `high`, `max`            | `high`           | `enable_thinking: false`  | Top-level `reasoning_effort` |
| Alibaba Standard / Token Plan              | `deepseek-v4-pro-0813`, `deepseek-v4-flash-0731`                               | `low`, `high`, `max`     | `high`           | `enable_thinking: false`  | Top-level `reasoning_effort` |
| Z.AI                                       | `GLM-5.2`                                                                      | `high`, `max`            | `max`            | `thinking.type: disabled` | Top-level `reasoning_effort` |
| Alibaba Standard                           | `glm-5.2`                                                                      | `high`, `max`            | `high`           | `enable_thinking: false`  | Top-level `reasoning_effort` |
| Alibaba Token Plan                         | `glm-5.2`                                                                      | On / off                 | Provider default | `enable_thinking: false`  | None                         |
| Moonshot                                   | `kimi-k2.6`                                                                    | On / off                 | Provider default | `thinking.type: disabled` | None                         |
| Alibaba Token / Coding Plan                | `kimi-k2.5`; Token Plan also `kimi-k2.6`                                       | On / off                 | Provider default | `enable_thinking: false`  | None                         |
| Moonshot / Alibaba Standard                | `kimi-k3`                                                                      | `low`, `high`, `max`     | `max`            | Not allowed               | Top-level `reasoning_effort` |
| Alibaba Standard                           | `ZHIPU/GLM-5.3`, `ZHIPU/GLM-5.3-Flash`                                         | `low`, `high`, `max`     | `max`            | Not allowed               | Top-level `reasoning_effort` |

The Qwen OpenAI-compatible parameter reference documents the Qwen 3.8 native
ladder, `none` disable mapping, and the conflict between `reasoning_effort` and
`thinking_budget`:
https://help.aliyun.com/en/model-studio/qwen-api-via-openai-chat-completions.

The DeepSeek Chat API documents `thinking.type`, the supported effort field,
and its provider default:
https://api-docs.deepseek.com/guides/thinking_mode/.

Alibaba's GLM reference documents that `ZHIPU/GLM-5.3` and
`ZHIPU/GLM-5.3-Flash` reject disabling thinking and accept
`low/high/max`, defaulting to `max`:
https://help.aliyun.com/en/model-studio/glm-zhipu.

Alibaba's deep-thinking reference distinguishes hybrid and thinking-only Kimi
routes:
https://help.aliyun.com/en/model-studio/deep-thinking. The current Token Plan
catalog explicitly lists `qwen3.8-flash`, `deepseek-v4-pro-0813`, and
`deepseek-v4-flash-0731`:
https://help.aliyun.com/en/model-studio/token-plan-personal-overview.

## Design

The core resolver returns both the user-facing capability and an internal wire
shape. Model switches, restored selections, ACP previews, live ACP options, and
request-level model overrides all resolve against the active route. Unsupported
persisted selections fall back to the provider default instead of being
clamped to a different visible tier.

The ACP metadata remains narrow. Tiered mandatory models add only
`canDisable: false` under `_meta.qwenCode/reasoning`; there is no new setting,
storage format, daemon route, or duplicated reasoning option. WebShell consumes
that metadata to keep the thinking switch on while leaving real effort choices
available.

The request pipeline translates only registered routes. Qwen toggles use
`enable_thinking`; Qwen 3.8 uses `reasoning_effort`; Alibaba-hosted third-party
models use a top-level `reasoning_effort`; DeepSeek, Moonshot, and Z.AI use
`thinking.type` for their switch. Unknown or custom endpoints keep the generic
OpenAI-compatible request and never receive one of these provider-specific
fields from this resolver.

The existing retry that learns a model rejected a disable request remains a
last line of defense. Known mandatory models are rejected by capability
validation and sanitized before their first request, so they do not need a
failed probe to become safe.

## Deliberate exclusions

- MiniMax M3 and Step 3.7 need new wire semantics and remain follow-up work.
- Alibaba `kimi/kimi-k3` exposes no useful choice when only `max` is available,
  so it receives no control.
- Unprefixed GLM 5.3 is not registered for Z.AI without direct provider
  documentation.
- Alibaba Coding Plan's model catalog is unchanged.
- Unregistered providers keep the generic `/effort` behavior, and all storage
  formats remain unchanged.
