# Qwen4-Max Integration

[English](2026-11-16-qwen4-max-integration.md) | [简体中文](2026-11-16-qwen4-max-integration.zh-CN.md)

- Status: implemented (this change)
- Date: 2026-11-16
- Scope: `packages/core`, `packages/cli`, settings schema, user docs

## Problem statement

`qwen4-max` is the Qwen family's new flagship native-multimodal model. The
ModelStudio GTM one-pager (§3.1 "API 变更") lists seven API-level changes versus
`qwen3.8-max`. Qwen Code already recognizes the `qwen4*` prefix for the tiered
`reasoning_effort` wire gate and the 1M context window (#15987), but the model is
not fully usable: the effort ladder and default are wrong, the output-token
budget is sized for the old `max_tokens` semantics, image/video input is not
declared, and the new explicit-cache TTL and image `detail` controls are absent.

This design makes `qwen4-max` a first-class model across four channels:
ModelStudio Standard (DashScope pay-as-you-go), Token Plan, QwenCloud Standard,
and Qwen Subscription (OAuth).

## The seven §3.1 changes and their disposition

| #   | Change                       | qwen4-max behavior                                                                                                                                                                  | Disposition                                            |
| --- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 1   | `reasoning_effort`           | Native tiers `low`/`high`/`xhigh`; **default `high`** (was `xhigh`). Server maps `minimal→low`, `medium→high`, `max→xhigh`; `none` disables thinking.                               | This change                                            |
| 2   | Explicit cache TTL           | `5m` / `1h` on Chat Completions, Responses, Anthropic. `5m` writes at 1.25x input, `1h` at 2x.                                                                                      | This change                                            |
| 3   | CoT summary                  | `thinking_display:"summarized"` returns a summary plus `encrypted_content` that must be replayed verbatim. Default off (full CoT).                                                  | Deferred                                               |
| 4   | `max_tokens`                 | Equals `max_completion_tokens`; caps **thinking + answer** together. Thinking cap 262,144; non-thinking 131,072.                                                                    | This change                                            |
| 5   | Parameter defaults           | Thinking-mode `temperature` defaults to `1.0` for text/image/video (no 0.6 floor); non-thinking `0.7`.                                                                              | No code change (client injects no default temperature) |
| 6   | ptc (programmatic tool call) | Model calls tools from a code sandbox; whitelist-gated.                                                                                                                             | Deferred                                               |
| 7   | Image/video understanding    | Chat Completions defaults to `detail:"high"` (~16,384 image tokens, 16,777,216 px); `detail:"low"` falls back to 2,621,440 px (~2,560 tokens). Responses does not support `detail`. | This change                                            |

## Current state

- `core/src/core/tokenLimits.ts`: `PATTERNS` has `[/^qwen4/, LIMITS['1m']]`
  (input). `OUTPUT_PATTERNS` has **no** `qwen4` row, so output falls through to
  `[/^qwen/, LIMITS['32k']]`. `defaultOutputCeiling` clips auto requests to
  `OUTPUT_TOKEN_CEILING` (64K) except for `CLAUDE_OPUS_EXTENDED`.
- `core/src/core/modalityDefaults.ts`: `isTieredEffortQwenPrefix` matches
  `qwen4*` and `qwen-latest-series-invite-*`; `isTieredEffortWireModel` admits
  them. `MODALITY_PATTERNS` has **no** `qwen4` row, so modalities fall through to
  `[/^qwen/, {}]` (text-only).
- `core/src/core/openaiContentGenerator/pipeline.ts`: the tiered family's
  canonical disable is `reasoning_effort:'none'`; the subscription branch
  (~line 1653) instead maps effort to `thinking_budget`
  (`low:4096, medium:16384, high:32768, xhigh:32768, max:32768`) plus
  `enable_thinking`.
- `core/src/core/openaiContentGenerator/provider/dashscope.ts`:
  `buildQwenEffortConfig` sends top-level `reasoning_effort` for the tiered
  family; `preserve_thinking:true` is injected; cache breakpoints are stamped
  `cache_control:{ type:'ephemeral' }` (no `ttl`); `clampTieredEffort` uses
  `DASHSCOPE_TIERED_EFFORTS` (`low/medium/high/xhigh`) for undeclared routes.
- `cli/src/acp-integration/model-configuration.ts`: `MODEL_CONFIGURATIONS` has
  `qwen3.8-max`/`qwen3.8-flash` (`['low','medium','xhigh']`, default `xhigh`).
  `getModelConfiguration` falls back to `MODEL_CONFIGURATIONS['qwen3.8-max']`
  for any tiered Qwen prefix, so `qwen4*` currently inherits the wrong ladder
  and default.
- Presets `alibaba-standard.ts`, `alibaba-token-plan.ts`,
  `qwencloud-standard.ts`: no `qwen4-max` entry. ModelStudio Standard and
  QwenCloud have `supportsModelDiscovery:true`, so a served `qwen4-max` appears
  via `/models` but without declared capabilities.
- `core/src/core/openaiContentGenerator/converter.ts`: emits
  `image_url:{ url }` with no `detail`; preserves `reasoning_content` across
  turns but does not capture chat-completions `encrypted_content`.
- Settings: `generationConfig.cacheRetention:'ephemeral'|'1h'` already exists
  (Anthropic-named) and flows through `config.ts` into `contentGeneratorConfig`.

## Goals

1. `qwen4-max` is selectable on all four channels with the correct effort ladder
   (`low`/`high`/`xhigh`), default `high`, and `none` to disable thinking.
2. The output-token budget reflects `max_tokens` = thinking + answer, so thinking
   does not starve the answer.
3. Image and video input are declared and reach the wire.
4. Explicit cache TTL (`5m`/`1h`) is configurable, reusing the existing
   `cacheRetention` knob.
5. Image `detail` (`low`/`high`/`auto`) is configurable to trade quality for
   tokens.

## Scope boundaries

- In scope: goals 1–3 (effort ladder, output budget, media input) across the
  four channels; goals 4–5 (cache TTL, image detail) on the DashScope-backed
  channels only; bilingual design; unit tests; user-doc effort table; E2E test
  plan.
- Deferred: CoT summary (`thinking_display` + `encrypted_content` replay) and
  ptc. Both are recorded as follow-ups.
- Product/server dependency: the Qwen Subscription gateway must serve
  `qwen4-max` and accept the qwen4 effort/budget contract. Switching the
  subscription default model (`QWEN_SUBSCRIPTION_MODEL`) away from `qwen3.8-max`
  is a product decision and is **not** done here; this change only ensures a
  served `qwen4-max` is selectable with correct effort.

## Proposed solution

### A. Model identity and limits (`core`)

- `tokenLimits.ts`: add `[/^qwen4-max/, 262_144]` to `OUTPUT_PATTERNS` before the
  `/^qwen/` fallback. Exempt `qwen4-max` from `OUTPUT_TOKEN_CEILING` in
  `defaultOutputCeiling` (mirroring `CLAUDE_OPUS_EXTENDED`) so an auto request
  can carry the full thinking+answer budget; `clampOutputTokensToWindow` still
  bounds every request by window room. Scoped to `qwen4-max`, not the whole
  `qwen4` prefix: the combined cap is a qwen4-max contract, and other `qwen4*`
  routes keep their shipped 32K output limit. Input stays 1M for the generation.
  The non-thinking cap is exported as `QWEN4_NON_THINKING_OUTPUT_CAP` (131,072).
- `pipeline.ts`: the 262,144 budget is the **thinking-mode** cap; non-thinking
  output caps at 131,072. Because the disable shape is finalized in the pipeline
  _after_ the provider sizes `max_tokens`, clamp a `qwen4-max` request's
  `max_tokens` to `QWEN4_NON_THINKING_OUTPUT_CAP` there when thinking is disabled,
  so a short-prompt thinking-off request does not exceed the non-thinking range
  and 400. Gate on the **final wire shape** (`reasoning_effort:'none'` or
  `enable_thinking:false`), not the endpoint: DashScope disables via
  `reasoning_effort:'none'` and Qwen Subscription via `enable_thinking:false`, and
  both must be clamped. Thinking-mode requests keep the full budget.
- `modalityDefaults.ts`: add `[/^qwen4-max/, { image:true, video:true }]` to
  `MODALITY_PATTERNS` before the `/^qwen/` text fallback.
- `model-catalog.ts`: extend `PDF_CARVE_OUT_IDS` to `qwen4-max` (the model's
  documented input is text/image/video, not pdf), so a future models.dev pdf
  flag does not enable an unsupported path.

### B. Effort ladder and default (`core` presets + `cli` manifest)

- Add a `qwen4-max` `ModelSpec` to each of `alibaba-standard.ts`,
  `alibaba-token-plan.ts`, `qwencloud-standard.ts`:
  `contextWindowSize:1_000_000`,
  `capabilities.reasoning:{ thinking:true, efforts:['low','high','xhigh'],
defaultEffort:'high', disableField:'reasoning_effort' }`,
  `modalities:{ image:true, video:true }`.
- `model-configuration.ts`: add a `'qwen4-max'` manifest entry with the same
  ladder/default. Change the `getModelConfiguration` prefix fallback so only a
  `qwen4-max*` id resolves the qwen4 ladder; other `qwen4*` routes and
  `qwen-latest-series-invite-*` keep the `qwen3.8-max` ladder, so existing models
  retain their shipped effort controls.
- Out-of-ladder tiers: the declared-capability path normally **drops** a tier
  outside `efforts` (the established contract). qwen4-max is the exception: its
  server maps a persisted `medium`/`max` onto `high`/`xhigh`, so
  `applyConfiguredReasoningEffort` clamps those to the nearest declared tier
  (`clampReasoningEffort`) instead of dropping to the server default. Other
  declared models (including other `qwen4*` routes) keep the drop behavior.
  `none` disable already ships through the pipeline.

### C. Subscription wire shape (`core`)

- `pipeline.ts` subscription branch: for a `qwen4-max` wire model, map effort to
  the qwen4 `thinking_budget` ladder (`low→4096`, `high→131072`, `xhigh→262144`)
  instead of the qwen3.8 table; keep the `enable_thinking` switch. Scoped to
  `qwen4-max` so other `qwen4*` and qwen3.8 subscription models keep their
  shipped budget table.

### D. Explicit cache TTL (`core` + settings, reuse existing knob)

- Reuse `generationConfig.cacheRetention:'ephemeral'|'1h'`. In
  `dashscope.ts addCacheControlToContentArray`, when the wire model is `qwen4*`
  and `cacheRetention==='1h'`, stamp `cache_control:{ type:'ephemeral',
ttl:'1h' }`; otherwise omit `ttl` (the 5m default). Generalize the setting's
  documentation so it is not Anthropic-only.
- `converter.ts` usage parsing already reads `cache_write_tokens` /
  `cached_tokens`; the per-TTL breakdown (`ephemeral_5m_input_tokens` /
  `ephemeral_1h_input_tokens`) is optional display and not required here.

### E. Image `detail` (`core` + settings, new knob)

- Add `generationConfig.imageDetail:'low'|'high'|'auto'` (settings schema,
  `ContentGeneratorConfig` type, `config.ts` passthrough; default `undefined` =
  server decides). In `converter.ts`, when set, inject `detail` into each
  `image_url` part. qwen4-max defaults to `high` server-side; a user sets `low`
  to save tokens.

## Design decisions and rationale

- **Reuse `cacheRetention` rather than a new TTL setting.** The knob already
  exists, is plumbed end to end, and its `'ephemeral'|'1h'` values map exactly
  onto qwen4's `5m`/`1h`. A parallel `cacheTtl` setting would duplicate state.
- **Scope the qwen4-max contracts to `qwen4-max`, not the whole `qwen4` prefix.**
  The native ladder, the combined output cap, the non-thinking clamp, the
  legacy-tier clamping, and the subscription budget ladder are qwen4-max
  contracts from §3.1; there is no vendor evidence that other `qwen4*` routes
  share them. Other `qwen4*` ids and the invite-series previews keep the
  qwen3.8-max ladder and their shipped 32K output limit, so existing models
  retain their shipped behavior. The 1M input window and the tiered wire gate
  stay `qwen4`-wide (pre-existing, #15987), and the models.dev catalog still
  overrides the regex rows once it publishes a qwen4 entry with different limits.
  (The cache TTL gate also stays `qwen4`-wide because the vendor documents
  explicit cache for the whole "Qwen4 series", and it only activates on the
  opt-in `'1h'` setting.)
- **Exempt qwen4-max from the 64K output ceiling.** `qwen3.8-max` keeps a 64K
  `max_tokens` because its `max_tokens` excludes CoT. qwen4-max's `max_tokens`
  includes CoT, so the same 64K would be consumed by thinking. The exemption
  follows the existing `CLAUDE_OPUS_EXTENDED` precedent; the window clamp still
  prevents `prompt + max_tokens > window`.
- **Declare `efforts:['low','high','xhigh']`; clamp legacy selections only for
  qwen4-max.** Exposing the native three-tier ladder keeps the UI honest about
  what the model distinguishes. The declared-capability wire path clamps a
  persisted `medium`/`max` onto the declared ladder (`medium→high`, `max→xhigh`)
  via `clampReasoningEffort` for qwen4-max only; other profile-less declarations
  keep their shipped drop-to-server-default semantics (the legacy no-re-tier
  contract).
- **Scope subscription budget changes to qwen4-max.** The subscription gateway's
  qwen3.8 budget contract is shipped behavior; only qwen4-max takes the new
  ladder.
- **Clamp the non-thinking budget on the final wire shape, not the endpoint.**
  The subscription gateway (`api.qwen.ai`) is not DashScope-detected, yet its
  disable path ships `enable_thinking:false` through the same pipeline
  shaping; gating the clamp on `isDashScope` would leave exactly that channel
  unclamped. Generic OpenAI-compatible hosts disable via
  `chat_template_kwargs` instead, so the shape gate keeps the clamp off there.

## Constraints

- ESM, strict TypeScript, no `any`, kebab-case core/cli files, collocated
  `file.test.ts`, Prettier (single quotes, 2-space, 80-col).
- Core imports in cli use the defining module path, not the package barrel.
- The changes are a `feat`-type model integration, not a large core refactor.

## Risks

- The subscription gateway may not yet serve `qwen4-max` or may reject the qwen4
  budget contract; client support is necessary but not sufficient there. The
  non-thinking 131,072 clamp on subscription is inferred from the §3.1 contract,
  not measured against `api.qwen.ai` (no key available).
- A models.dev catalog entry for `qwen4` overrides the regex **input-window**
  row (catalog wins for input). For **output**, the curated row wins
  (`curatedOutputLimit(norm) ?? fromCatalog`), so once the `/^qwen4-max/` output
  row exists a catalog entry cannot override it; the catalog only supplies an
  output limit for ids with no curated row.
- The output-ceiling exemption does **not** interact with truncation escalation
  in practice: qwen4-max's initial budget (262,144, window-clamped) is always at
  least the escalated cap (at most 64K), so `shouldEscalateMaxOutputTokens` never
  fires for it and no escalation path is exercised.
- `imageDetail` and `cacheRetention` are carried only on the DashScope-backed
  channels; the subscription resolver copies neither and the subscription
  provider injects no `cache_control`, so both are inert on Qwen Subscription.
  The user docs scope these two controls accordingly.

## Validation plan

- `npm run build && npm run typecheck`.
- Per-package `npx vitest run <file>` for every changed file (core and cli from
  their own directories).
- Real-model E2E (`.qwen/e2e-tests/`): on each channel, select `qwen4-max`,
  exercise `/effort low|high|xhigh|none`, attach an image, and inspect the wire
  body (`reasoning_effort` tier and default `high`, `none` disable, `max_tokens`
  total budget, `cache_control.ttl`, `image_url.detail`) and `usage`. Dry-run the
  baseline against the global `qwen` CLI first.

## Acceptance criteria

1. `qwen4-max` appears and is selectable on all four channels; the effort picker
   shows `low`/`high`/`xhigh` with default `high`, and `none` disables thinking.
2. An auto request carries a thinking+answer-sized `max_tokens` (not 32K/64K),
   bounded by the context window; with thinking disabled it is clamped to the
   131,072 non-thinking cap on both DashScope and Qwen Subscription.
3. Image and video parts reach the wire for `qwen4-max`.
4. `cacheRetention:'1h'` stamps `ttl:'1h'` on qwen4 cache breakpoints; default
   omits `ttl`. DashScope-based channels only — the subscription provider
   injects no `cache_control` breakpoints.
5. `imageDetail:'low'` injects `detail:'low'` into image parts; default injects
   nothing. DashScope-based channels only — the subscription resolver does
   not forward the setting.
6. qwen3.8-max and other `qwen4*` routes keep their shipped ladder, default,
   output limit, and subscription budget table.
7. Only `qwen4-max` projects the native ladder (`none/low/high/xhigh`, default
   `high`) in the workspace provider controls; other `qwen4*` routes,
   invitation-only previews, and the stable family keep the qwen3.8-max ladder;
   a subscription non-thinking `qwen4-max` request ships `enable_thinking:false`
   with `max_tokens` clamped to 131,072.

## Open questions / follow-ups

- CoT summary: capture chat-completions `encrypted_content` and replay it
  verbatim under `thinking_display:'summarized'` (converter does not capture it
  today).
- ptc: whitelist-gated programmatic tool calling.
- Subscription default-model switch to `qwen4-max`: pending product/server
  confirmation.
