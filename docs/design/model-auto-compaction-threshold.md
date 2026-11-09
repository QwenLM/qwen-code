# Model-specific auto-compaction threshold

[English](model-auto-compaction-threshold.md) | [简体中文](model-auto-compaction-threshold.zh-CN.md)

## Status and problem

Local implementation design for [#14395](https://github.com/QwenLM/qwen-code/issues/14395).
The configuration shape has not received maintainer approval. Verification
results belong in the implementation's test report, not this design.

`context.autoCompactThreshold` supplies one ratio for every model. A ratio of
`0.85` suits a 262,144-token model but delays compaction to 850,000 tokens for a
1,000,000-token model. Lowering `contextWindowSize` to compact earlier also
reduces the main request's available output budget. Compaction timing and the
model's real capacity need independent settings.

## Scope and configuration

Add optional `modelProviders[provider][].generationConfig.autoCompactThreshold`.
It uses the global setting's existing semantics: a numeric ratio in `(0, 1]`.
No model-prefix map, absolute token setting, new CLI option, or provider request
parameter is introduced.

Resolve the effective ratio in this order:

1. A valid `autoCompactThreshold` from explicitly supplied request generation
   config, or otherwise the actual content generator's config. The latter
   includes an AsyncLocalStorage runtime override or a derived agent's generator.
   Before a generator exists, use `ModelsConfig.getGenerationConfig()` instead.
2. A valid global `context.autoCompactThreshold`.
3. The existing `computeThresholds` default, `0.85`.

A missing or invalid model value falls back to the global value. Explicit
request config or an existing generator without a valid override must not fall
back to the main or parent model's generation config. Values such as zero,
negatives, values above one, strings, `NaN`, and infinity are invalid. An absent
or invalid global value leaves the getter undefined, preserving the existing
default in `computeThresholds`.

## Resolution and lifecycle

Add the field to `ContentGeneratorConfig`, `ModelGenerationConfig`, and
`MODEL_GENERATION_CONFIG_FIELDS`, so existing resolution, source attribution,
registry replacement, and snapshot handling carry it consistently. Keep
validation and model/global precedence in `Config.getAutoCompactThreshold()`;
all consumers use that getter.

`LoggingContentGenerator` passes its bound generation config through the
optional fourth argument of `createContextUsageSnapshot` to the getter. Exact
route and vision requests without an AsyncLocalStorage override therefore
resolve the ratio from the request's bound config. The snapshot window follows
the existing resolution and fallback behavior of that config. Correcting an
inherited session window on a routed request is outside this change's scope.

Switching registered models replaces the override with the destination model's
value, including an absent value. Derived agents targeting a different auth
type, model, or explicit unregistered base URL must not inherit the parent
model's override, even when the model ID is unchanged. Main-model raw switches
clear `modelProviders` overrides but retain explicit runtime/settings generation values, following
existing runtime configuration semantics. Runtime model snapshot restoration
restores both the snapshot's generation config and its sources. Qwen OAuth hot
switches clear any previous model override because these models are hard-coded
and cannot be customized through `modelProviders`.

Keep the real `contextWindowSize` and the existing warn/auto/hard formulas:

- Auto combines the selected ratio with the existing absolute safety ceiling.
- Warn and hard continue to derive from the existing threshold ladder.
- The main request's output budget continues to use the real context window.

This change does not redesign context-window inference or resolve the broader
window issues in [#13338](https://github.com/QwenLM/qwen-code/issues/13338) and
[#13415](https://github.com/QwenLM/qwen-code/issues/13415). It ensures the new
ratio follows the actual model, and verifies that registered main-model
switches retain their explicitly configured windows.

## Affected production paths

The implementation changes these existing files:

| Path                                                                        | Responsibility                                                            |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `packages/core/src/core/contentGenerator.ts`                                | Declare the optional generator field.                                     |
| `packages/core/src/models/types.ts`                                         | Expose the field in model generation configuration.                       |
| `packages/core/src/models/constants.ts`                                     | Include the field in common generation-field handling.                    |
| `packages/core/src/models/modelsConfig.ts`                                  | Preserve or clear the field according to the selected model and snapshot. |
| `packages/core/src/models/content-generator-config.ts`                      | Resolve derived models without inheriting another model's override.       |
| `packages/core/src/config/config.ts`                                        | Resolve the effective model/global ratio.                                 |
| `packages/core/src/core/loggingContentGenerator/loggingContentGenerator.ts` | Supply the request's bound generation config to context snapshots.        |
| `packages/core/src/core/loggingContentGenerator/context-usage-snapshot.ts`  | Resolve the snapshot ratio from the supplied request config.              |

`packages/core/src/models/modelConfigResolver.ts` consumes the shared field
list and must retain the new field without requiring separate resolution logic.
These five threshold consumers keep using the shared getter:

| Path                                                                       | Consumer                    |
| -------------------------------------------------------------------------- | --------------------------- |
| `packages/core/src/services/chatCompressionService.ts`                     | Automatic compression gate. |
| `packages/core/src/core/llm-chat.ts`                                       | Hard-threshold rescue.      |
| `packages/core/src/core/loggingContentGenerator/context-usage-snapshot.ts` | Context usage snapshot.     |
| `packages/cli/src/ui/commands/contextCommand.ts`                           | `/context` display.         |
| `packages/cli/src/ui/hooks/useContextualTips.ts`                           | Contextual warning tips.    |

## Decisions and risks

A per-model ratio reuses the global setting's meaning and the existing model
registry instead of adding a parallel matching system. An absolute token
interface would add precedence and safety semantics without being necessary
for this use case: `0.25` already requests 250,000 tokens for a 1,000,000-token
window. The safety ceiling remains authoritative, so a ratio is a preference,
not a promise to compact at an exact token count.

The main risk is a stale override when model identity changes or a child agent
shares its parent's config. Centralizing reads and explicitly testing each
lifecycle boundary addresses that risk. Existing configurations without this
field retain their global/default behavior. No credentials, request-body
settings, compaction prompts, or database state change.

## Validation and acceptance criteria

- Reproduce the feature gap with the real config, model resolver, threshold
  computation, and output-budget functions before implementation; do not claim
  to reproduce provider truncation or malformed tool calls.
- With global `0.85`, a 1,000,000-token model configured with `0.25` has an auto
  threshold of 250,000. A 262,144-token model without an override has an auto
  threshold of 222,822.4. Repeated switches preserve each model's ratio and
  context window.
- The large model retains its 1,000,000-token window and its existing output
  budget for a 250,000-token prompt.
- Verify missing/invalid model and global values, including the valid boundary
  `1`, fall back or resolve as specified.
- Verify initialization, actual runtime/derived generators, same-provider
  child models, unknown/raw selections, runtime snapshot restoration, and OAuth
  switches do not leak a previous model's override.
- Verify raw child requests to a different explicit, unregistered base URL do
  not inherit the parent ratio, with an absent or unchanged model ID.
- For a request without AsyncLocalStorage, a target ratio of `0.8` or an absent
  override uses that ratio or the global/default, never the main model's `0.25`.
- Exercise the five consumers through their shared getter and retain their
  existing threshold-ladder regression tests.
- Run targeted unit tests from the relevant package directories, build,
  typecheck, lint/format checks, and independent post-change verification.

Maintainer acceptance of the configuration shape remains an upstream review
question; it does not replace the local acceptance criteria above.
