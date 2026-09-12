---
title: 'Data-Driven Model Metadata Registry (models.dev)'
date: '2026-08-23'
status: 'proposed'
---

# Data-Driven Model Metadata Registry (models.dev)

## Problem

Model-related capabilities are currently decided by hard-coded model-name
pattern matching scattered across core:

- **Context window / output limits** — two ordered regex tables
  (`PATTERNS` / `OUTPUT_PATTERNS`) in `core/tokenLimits.ts`, behind a heavy
  `normalize()` alias rewriter.
- **Input modalities** (image/pdf/audio/video) — `MODALITY_PATTERNS` in
  `core/modalityDefaults.ts`; unknown models default to text-only.
- **Thinking / reasoning-effort support** — per-provider name checks:
  `isTieredEffortWireModel()` (only the `qwen3.8-max` prefix),
  `isQwenFamilyWireModel()`, `anthropicSupportedEffortTiers()` (parses Claude
  version numbers), DashScope `VISION_MODEL_PREFIX_PATTERNS`, `isGlmModel()`,
  `default.ts`'s `includes('qwen3')`.

Consequences:

1. **Every new model release needs a code change.** A model like `glm-5.3`
   falls through to family fallback (or the generic default) until someone
   patches a regex table and ships a release.
2. **Capability facts are duplicated.** "Which models are multimodal" lives in
   at least three files (`modalityDefaults.ts`, `tokenLimits.ts`,
   `dashscope.ts` vision patterns) and can drift.
3. **The reasoning-effort path has no capability data at all.** The unified
   effort design (`2026-06-30-unified-reasoning-effort-cli.md`) specified
   per-model `supportedReasoningEfforts` + clamp, but the DashScope leg landed
   as verbatim passthrough: `buildQwenEffortConfig()` ships whatever tier the
   user picked (`low…max`) straight into `reasoning_effort` for the
   `qwen3.8-max` family. A tier the server does not accept produces a hard
   400 — this is the incident reported in the user group.

## Prior art

- **opencode / hermes** fetch `https://models.dev/api.json` at startup,
  cache it locally (`~/.cache/opencode/models.json`), and ship a bundled copy
  as offline fallback. A disable switch was added later for corporate proxies
  (opencode issue #4959) — we should ship the switch from day one.
- **models.dev** is an open model registry keyed by provider → model id, with
  per-model `limit.context`, `limit.output`, `modalities.input/output`,
  `reasoning` (boolean), and cost data. It does **not** carry:
  - which effort tiers a model accepts (`low/medium/high/xhigh/max` are
    provider-private ladders),
  - which wire field carries reasoning (`reasoning_effort` vs
    `enable_thinking` vs `thinking_budget` vs `output_config.effort`),
  - Qwen-internal identities (`coder-model` alias, OAuth endpoints, internal
    `*.alibaba-inc.com` / token-plan gateways).

So models.dev can replace the *data* behind context limits, modalities, and
"does it reason at all", but effort-tier support and wire-knob selection stay
qwen-code-owned metadata. The design is therefore two layers: an external
catalog (models.dev) plus a local override table.

## Goals

- New models picked up by models.dev work (context window, modalities,
  reasoning presence) **without a code change or release**, via runtime
  refresh; bundled data covers offline use.
- One lookup entry point for model metadata; the scattered regex tables become
  fallbacks, not the primary source.
- Reasoning-effort tiers are clamped per model on **every** provider path
  (closing the DashScope 400), driven by declared per-model capability.
- No behavior change for models absent from the catalog: existing regex
  fallbacks and defaults apply exactly as today.

## Non-Goals

- Not replacing `modelProviders` user config — explicit user configuration
  stays the highest priority.
- Not fetching models.dev at request time or blocking startup on it.
- Not adopting models.dev cost/pricing data (no consumer in qwen-code today).
- Not changing the Qwen OAuth model list (`QWEN_OAUTH_MODELS`) or provider
  detection (`isDashScopeProvider` etc.).

## Design

### Layering & precedence

Resolution order for any model-metadata field (highest wins):

1. **User `modelProviders` config** — explicit `generationConfig.*` /
   `capabilities` (unchanged, already top priority in
   `modelConfigResolver.ts`).
2. **qwen-code local overrides** — a small committed table for facts
   models.dev does not carry or carries wrongly for our wire protocols
   (effort tiers, thinking knob, `coder-model` alias, Qwen-specific
   corrections). Owned by us, reviewed in PRs.
3. **Runtime catalog** — refreshed models.dev snapshot cached at
   `~/.qwen/model-registry.json`.
4. **Bundled catalog** — models.dev snapshot committed at build time; the
   floor that always exists.
5. **Regex family fallback** — the existing `tokenLimits.ts` /
   `modalityDefaults.ts` tables, unchanged, for ids no catalog knows
   (local quant builds, private gateway models, dated snapshots not yet
   listed).
6. **Generic defaults** — `DEFAULT_TOKEN_LIMIT` etc., unchanged.

### Catalog data layer

New module `packages/core/src/models/modelCatalog.ts` exposing:

```ts
export interface ModelCatalogEntry {
  contextWindow?: number;      // from limit.context
  maxOutputTokens?: number;    // from limit.output
  modalities?: InputModalities; // from modalities.input (image/pdf/audio/video)
  reasoning?: boolean;         // models.dev reasoning flag
}

export function lookupModelCatalog(model: string): ModelCatalogEntry | undefined;
```

- Lookup runs the model id through the existing `normalize()` first, then
  exact-id match across all providers (models.dev ids are bare, e.g.
  `qwen3-coder`; `normalize()` already strips provider prefixes and variant
  tags). First exact match wins; provider-scoped disambiguation is a
  follow-up only if real collisions appear (YAGNI).
- Data source selection at module init: local cache file if present and newer
  than the bundled snapshot, else bundled. Pure sync read — no startup I/O
  beyond one `readFileSync` guarded by try/catch.

**Build-time fetch**: a script (`packages/core/scripts/fetch-models-dev.mjs`,
run manually / by a scheduled workflow, output committed) downloads
`api.json` and **trims** it to the four fields above per model — the full
registry is multi-MB; the trimmed projection should stay well under 500 KB.
Output: `packages/core/src/models/generated/model-registry.json` (committed,
imported statically so bundling works).

**Runtime refresh**: best-effort background fetch (reuse the configured
proxy via `buildRuntimeFetchOptions`), 10 s timeout, at most once per 24 h
(timestamp recorded in the cache file). Failures are silent — the bundled
snapshot is the guarantee. Disabled entirely when
`QWEN_CODE_MODELS_DEV_REFRESH=off` (corporate-proxy / air-gapped
environments), mirroring the opencode lesson.

### Local overrides

`packages/core/src/models/modelOverrides.ts` — a committed table keyed by
normalized model id (or family regex where a whole family shares a fact):

```ts
export interface ModelOverride {
  contextWindow?: number;
  maxOutputTokens?: number;
  modalities?: InputModalities;
  /** Effort tiers the wire API accepts; drives clampReasoningEffort. */
  supportedEffortTiers?: readonly ReasoningEffort[];
  /** Which wire field carries reasoning for this model. */
  thinkingKnob?:
    | 'reasoning_effort'   // qwen3.8-max family, OpenAI chat, GLM, DeepSeek
    | 'enable_thinking'    // older qwen hybrids
    | 'thinking_budget'    // Gemini 2.5-style budgets
    | 'output_config.effort'; // Anthropic
}
```

This is where the effort design's per-model `supportedReasoningEfforts`
finally lives. First entries (confirmed against the Qwen platform API reference,
`platform.qianwenai.com/docs/api-reference/chat/dashscope`, 2026-08):

- `qwen3.8-max` family: `thinkingKnob: 'reasoning_effort'`,
  `supportedEffortTiers: ['low', 'medium', 'xhigh']` — the server accepts
  **only** these three (default `xhigh`); `high` and `max` are rejected.
  Interop with `thinking_budget`: low→4096, medium→16384, xhigh→262144.
- DashScope-served DeepSeek-V4 / GLM series: only `high` / `max` accepted;
  low/medium→`high`, xhigh→`max` (the DeepSeek adapter already maps this;
  GLM via DashScope does not).
- `coder-model`: alias facts (1M window, image+video) that models.dev cannot
  know.
- Anthropic version gates currently in `anthropicSupportedEffortTiers()`
  migrate here as data (Opus 4.7+/5.x → full ladder; Opus/Sonnet 4.6 →
  `…max`; older → `…high`).

### Integration points (each = one lookup swap, fallback preserved)

| Site | Change |
| ---- | ------ |
| `tokenLimits.ts` `knownTokenLimit()` | Catalog/override lookup first; regex tables become step 5. |
| `modalityDefaults.ts` `defaultModalities()` | Same pattern. |
| `dashscope.ts` `buildQwenEffortConfig()` | Clamp the tier via `clampReasoningEffort(effort, supportedEffortTiers(model))` before emitting; one-time warn on clamp (Anthropic's existing UX). |
| `anthropicContentGenerator.ts` | `anthropicSupportedEffortTiers()` reads overrides instead of parsing versions inline. |
| Generic OpenAI pipeline | `max` has no OpenAI wire value — clamp via the same lookup (`max→xhigh` per the effort design doc). |

Nothing else moves. `modelConfigResolver.ts`, `modelRegistry.ts`,
`modelsConfig.ts` keep their shape — they already call
`knownTokenLimit()`/`defaultModalities()` and pick up the new source
transparently.

### Phase 0 (independent stopgap — landed upstream)

The DashScope 400 was fixed independently upstream while this doc was in
flight: #9501 (`fix(core): cap the effort tier at what each endpoint
accepts`) declares the tiered family's accepted subset and clamps the
configured tier through `clampReasoningEffort` with a one-time warning,
matching the approach below. One gap to verify in a follow-up: #9501's
subset is `low/medium/high/xhigh`, while the Qwen platform API reference
(2026-08) documents only `low/medium/xhigh` — if the server truly rejects
`high`, the override table below corrects it when PR4 lands.

## Phasing

1. **PR1 — Phase 0 clamp.** Landed upstream as #9501 (see Phase 0 section
   for the `high`-tier verification gap).
2. **PR2 — catalog data layer.** Fetch script + trimmed bundled JSON +
   `lookupModelCatalog()` + integration into `knownTokenLimit()` /
   `defaultModalities()` with regex fallback. No network code yet.
3. **PR3 — runtime refresh + cache + disable switch.** Background fetch,
   `~/.qwen/model-registry.json`, 24 h throttle, `QWEN_CODE_MODELS_DEV_REFRESH`.
4. **PR4 — effort metadata.** `supportedEffortTiers` / `thinkingKnob`
   overrides drive DashScope, Anthropic, and the generic pipeline; delete the
   inline version-parsing tables they replace.

## Test Coverage

- Catalog lookup: exact id, normalized alias (`provider/model:tag`), miss →
  `undefined`; cache-newer-than-bundled selection; malformed cache ignored.
- Precedence: user config > override > catalog > regex > default, per field.
- Effort clamp on DashScope: every tier for `qwen3.8-max` family (existing
  passthrough tests update to the clamped expectations), older qwen hybrids
  still collapse to `enable_thinking`, clamp warning fires once per
  model+tier.
- Refresh: proxy respected, timeout never blocks startup, `=off` skips
  entirely, failed fetch keeps previous cache.
- Fetch script: trimmed output schema validation, size budget assertion.

## Risks & Open Questions

- **models.dev data accuracy for Qwen models.** It is a third-party registry;
  a wrong context window there would override a correct regex. Mitigation:
  local overrides outrank the catalog, and PR2 should diff catalog vs.
  existing regex tables and pin any disagreement as an override.
- **qwen3.8-max accepted tier set** — confirmed `low/medium/xhigh` (2026-08
  doc). Re-verify against the server when PR1 lands: the doc and the
  commercial-API endpoint can drift, and a wrong ceiling silently degrades
  users while a wrong floor reintroduces the 400.
- **Bundle size**: full `api.json` is multi-MB; the trim step is mandatory,
  and the fetch script asserts a size budget.
- **Registry availability**: models.dev is an external service; the committed
  snapshot + disable switch mean qwen-code never depends on it at runtime.
