# External model reasoning configuration

[English](external-model-reasoning-config.md) | [简体中文](external-model-reasoning-config.zh-CN.md)

## Problem and scope

Model providers already accept endpoints, credentials, generation settings and
some reasoning capabilities. Model-name and hostname checks still determine
thinking formats, supported effort tiers and defaults. New models and aliases
need an external declaration that both the controls and actual requests honor.

Add three optional fields under `generationConfig.reasoningConfig`:
`profile`, `supportedEfforts` and `defaultEffort`. Reuse existing protocols,
settings scopes and model identity. Do not add arbitrary request templates,
new user-visible effort tiers or configurable per-effort token budgets.
Existing `reasoning.budget_tokens` remains the fixed-budget escape hatch.

## Configuration

```json
{
  "generationConfig": {
    "reasoningConfig": {
      "profile": "dashscope-effort",
      "supportedEfforts": ["low", "medium", "xhigh"],
      "defaultEffort": "medium"
    }
  }
}
```

Profiles reuse the existing thinking wire formats:

- OpenAI Chat Completions: `openai-reasoning`, `openai-effort`,
  `deepseek-openai`.
- OpenAI Responses: `openai-reasoning`.
- Qwen: `dashscope-thinking`, `dashscope-effort`, `qwen-chat-template`.
- Anthropic: `anthropic-manual`, `anthropic-adaptive`,
  `anthropic-adaptive-only`, `deepseek-anthropic`.
- Gemini: `gemini`.

An omitted profile uses existing inference. Other omitted fields inherit the
inferred or selected profile's behavior. Explicit declarations override
thinking-related model-name and hostname inference; they never select an SDK,
endpoint or credential. Existing `capabilities.reasoning` remains compatible;
the new generation configuration takes precedence when present.

`capabilities.reasoning` remains the model-discovery and control contract used
by built-in manifests and clients. The external profile belongs to
`generationConfig` because it also selects provider request and history
transformations, and must travel with the exact model, endpoint, credentials and
staged generation settings. Extending the client-facing capability object would
still require a transport profile and would couple provider serialization to
discovery payloads. The resolver keeps the boundary one-way: an explicit
generation declaration wins, while omitted fields may inherit existing
capabilities.

Efforts use `low/medium/high/xhigh/max`. Toggle-only profiles reject effort
fields. Validate profile/protocol compatibility, unique supported efforts and
membership of the default effort. Gemini accepts its existing low/medium/high
mapping. A declaration must contain at least one field; an empty object is
invalid. Invalid declarations report the model and field.

## Resolution and lifecycle

Keep model defaults separate from explicit user selections. Existing selection
precedence remains intact; when no selection exists, an external default affects
both the request and the controls. The controls expose concrete effort tiers only.
Clamping uses the effective supported set once, without a second built-in clamp.
Keep existing raw-parameter overrides, request opt-out, thinking-mandatory rules
and budget ceilings. A default must not override a request's thinking opt-out.

Core exposes one resolved reasoning configuration for providers and clients.
OpenAI must combine it with sampling parameters. Anthropic thinking-related
history handling follows the selected profile. Unconfigured routes retain their
existing behavior. The new declaration follows exact model/endpoint selection,
runtime snapshots and subagents; it must not leak between model routes.

Workspace reload validates the new configuration before applying it. Existing
sessions retain their configuration for the entire active prompt, including
tools and retries. The latest valid reload is applied before the next user
prompt, after the previous prompt has ended. New sessions use the latest
configuration. A failed update preserves the previous runtime and reports an
error. Reuse existing workspace ownership and prompt admission paths.

ACP keeps `reasoning_effort`; existing metadata carries defaults and thinking
availability. CLI and WebShell render the same effective state. Tiered profiles
expose concrete efforts only; toggle-only models remain switches.

## Validation and acceptance

Record a global CLI baseline, then test the built local bundle using controlled
compatible endpoints. Cover unknown model IDs and proxy hosts, all profiles,
defaults, explicit choices, disabling, fixed budgets, sampling coexistence,
raw overrides and invalid configuration. Assert final request payloads.

Cover same-name/different-endpoint models, switching, snapshots, subagents,
Default restoration and explicit selection preservation. Reload twice during
a multi-request prompt: its requests keep the original configuration and the
next user prompt uses the latest one. Validate CLI, ACP and WebShell controls,
including welcome and existing-session states.

Run focused package tests, build, typecheck, bundle and full-diff self-audit.
New authentication, response formats and non-thinking model restrictions are
outside this change; configuration does not implement a new protocol.
