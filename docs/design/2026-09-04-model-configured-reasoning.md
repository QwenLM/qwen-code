# Model-configured reasoning capabilities

## Goal

Make reasoning support part of each existing provider model declaration. After
this foundation lands, adding a model must only require editing its provider
configuration entry.

## Design

`ModelSpec.capabilities.reasoning` declares the model's selectable effort tiers,
provider default, disable support, and disable wire field. Provider setup copies
the capability into `ModelConfig`; the existing model registry then preserves it
with the model's protocol and endpoint identity.

ACP, session restoration, workspace previews, and TUI effort controls read the
capability from the resolved model. The request pipeline resolves the request
model through the same registry, maps a supported tier to top-level
`reasoning_effort`, and emits the configured disable field. Unsupported stored
tiers fall back through the existing default-selection path. Models without an
explicit capability keep existing behavior and receive no new provider field.

## Proof model

This PR configures only the native `deepseek-v4-pro` entry:

- efforts: `high`, `max`;
- default: `high`;
- disable: `thinking.type = disabled`.

Evidence: [DeepSeek Chat Completions](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion/).

No DeepSeek model id or endpoint is added to generic control code. The model's
configuration is the only source of its new capability.

## Follow-up

Qwen 3.8, DeepSeek snapshots, Kimi K3, and GLM models are deliberately deferred
to a separate configuration-only PR. MiniMax M3, Step 3.7, and Coding Plan
remain excluded.
