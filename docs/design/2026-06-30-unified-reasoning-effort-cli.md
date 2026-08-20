---
title: 'Unified Reasoning Effort (/effort)'
date: '2026-06-30'
status: 'implemented'
---

# Unified Reasoning Effort (/effort)

> **Implementation status.** Landed: the 5-tier ladder + `core/reasoning-effort.ts`
> (rank clamp/normalize), the global `model.reasoningEffort` setting + runtime
> `Config.setReasoningEffort`/`getReasoningEffort` (re-applied across model
> switches in `handleModelChange`), the `/effort` command, the GLM
> verbatim-flatten adapter (`provider/zai.ts`), Gemini `medium`/`xhigh` mapping,
> **per-model Anthropic gating** (`anthropicSupportedEffortTiers` + clamp: Opus
> 4.7/4.8 and 5.x families pass `xhigh`/`max` through; Opus 4.6/Sonnet 4.6 take
> `max` only; Opus 4.5 and unversioned ids clamp to `high`), and the
> `model-with-reasoning` status line (live-updating on `/effort`), the
> DashScope tier→bool mapping (a set effort turns on `enable_thinking` for qwen
> hybrid models; the single column to extend when qwen ships a real
> `reasoning_effort` field), and the interactive `EffortDialog` — bare `/effort`
> opens a tier picker in interactive mode (and lists tiers non-interactively),
> wired through `use-effort-command`, the UI contexts, `DialogManager`, and
> `useDialogClose`. Nothing is deferred.

## Problem

Every reasoning-capable provider exposes a different knob for "how hard should
the model think": OpenAI/DeepSeek/GLM use a flat `reasoning_effort` string,
Anthropic uses `output_config.effort` (plus legacy `thinking.budget_tokens`),
Gemini 3 uses `thinking_level` (Gemini 2.5 used `thinkingConfig.thinkingBudget`),
and Qwen/DashScope only has a boolean `enable_thinking`.

The core already carries a unified `reasoning: { effort }` config shape and each
provider adapter already translates it (see Current State), but there is no
user-facing way to pick an effort level at runtime. The level can only be set by
hand-editing per-model generation config. We want one `/effort` command that
offers a small set of tiers, maps them onto whatever the active provider
supports, and persists the choice.

The unified layer must also make adding a new provider trivial: when a model
that currently only has an on/off switch (e.g. qwen3) gains real effort tiers,
the only change should be one row in the mapping/capability table.

## Goals

- One unified effort ladder exposed to the user: **`low | medium | high | xhigh | max`** (5 tiers).
- A `/effort` slash command: `/effort <tier>` sets directly; bare `/effort` opens a picker dialog.
- A **single global** setting that applies to all models, persisted across sessions.
- A per-provider translation + **clamp** layer: an unsupported tier falls back to
  the nearest supported tier for the active model, with a one-time warning
  (reusing the existing Anthropic clamp UX).
- Live display via the existing `model-with-reasoning` status-line preset.
- Adding/adjusting a provider = editing one capability/mapping table, no new wiring.

## Non-Goals

- No `off` tier. Disabling reasoning entirely stays the separate existing
  `reasoning: false` concept; `/effort` only moves between active tiers.
- No per-model persisted effort (decision: global single setting).
- No raw `budget_tokens` UI. Budget-shaped providers (Gemini 2.5, legacy
  Anthropic) are driven by the tier→bucket mapping, not exposed numerically.
- No change to the existing per-provider request wiring beyond filling mapping
  gaps and clamps.
- No desktop integration (desktop has its own `thinkingLevel` plumbing; out of scope).

## Current State

Unified config type — [`packages/core/src/core/contentGenerator.ts:104-118`]:

```ts
reasoning?: false | { effort?: 'low' | 'medium' | 'high' | 'max'; budget_tokens?: number }
```

Existing per-provider translators:

| Provider             | File                                                                                   | Behavior                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| DeepSeek             | `provider/deepseek.ts:176-218`                                                         | nested → flat `reasoning_effort`; `low/medium→high`, `xhigh→max`                                |
| Anthropic            | `anthropicContentGenerator.ts:521-593`, clamp `665-693`, beta hdr `393-431`            | `output_config.effort` + thinking; `max`→`high` clamp + one-time warn; `effort-2025-11-24` beta |
| Gemini               | `geminiContentGenerator.ts:107-146`                                                    | `thinkingConfig`/`thinkingLevel`; `low→LOW`, `high/max→HIGH`                                    |
| OpenAI/GLM/DashScope | `openaiContentGenerator/pipeline.ts:689-717` (`buildReasoningConfig`), strip `597-602` | forwards/strips `reasoning_effort`; DashScope adds `preserve_thinking`                          |

Gaps: the union lacks `xhigh`; Gemini lacks `medium` and an `xhigh→high` rule;
the generic pipeline must be confirmed to emit `reasoning_effort` for plain
OpenAI/GLM and to clamp `max→xhigh`; DashScope has no tier→bool mapping.

## Prior art: openclaw

`openclaw/openclaw` solves the same problem with a more mature shape that we
borrow from (studied at `~/Documents/openclaw`):

- **Single canonical ladder + numeric ranks** (`src/auto-reply/thinking.shared.ts`):
  `ThinkLevel = off|minimal|low|medium|high|xhigh|adaptive|max` with
  `THINKING_LEVEL_RANKS` (off:0 … high:40, xhigh:60, max:70; adaptive≡30).
- **Rank-based clamp** (`src/llm/model-utils.ts:59` `clampThinkingLevel`): if the
  model supports the level use it; an explicit `null` opt-out for xhigh/max is a
  hard cap (walk down first); otherwise prefer the next stronger supported level,
  else walk down — never silently raise cost above a model's cap.
- **Per-model capability**, not just per-provider: catalog carries
  `compat.supportedReasoningEfforts` and a per-model `thinkingLevelMap`
  (value or `null`).
- **Three shape mappers**, one per API family:
  - OpenAI-compatible — `mapThinkingLevelToReasoningEffort()`: `off→none`,
    `adaptive→medium`, `max→xhigh`, else passthrough → `none|minimal|low|medium|high|xhigh`.
  - Anthropic — `mapThinkingLevelToEffort(model, level)`: clamp, then emit
    `output_config.effort` for adaptive-thinking models, or convert to
    `thinkingBudgetTokens` (with `adjustMaxTokensForThinking`) for older ones.
  - Gemini — `resolveGoogleGemini3ThinkingLevel()`: Gemini 3 Pro → LOW/HIGH,
    Flash → MINIMAL/LOW/MEDIUM/HIGH; Gemini 2.5 maps a budget to a level
    (`≤0→MINIMAL, ≤2048→LOW, ≤8192→MEDIUM, else HIGH`; `gemini-2.5-pro` rejects
    budget 0 — thinking required).
  - DeepSeek V4 wrapper: `off`→strip; `xhigh|max→max`, else `high`.
- **Provider thinking profile** (`src/plugins/provider-thinking.types.ts`):
  declares `levels`/`defaultLevel`; binary providers store `low` but display `on`.
- **Reasoning sanitizer** (`extensions/opencode-go/reasoning-sanitizer.ts`):
  strips `reasoning_content`/`reasoning_effort` and thinking parts when replaying
  history to providers that reject them.

What we take: the **rank-based central clamp**, **per-model capability
declaration**, the **three shape mappers**, and the **exact Gemini 2.5 budget
buckets**. What we drop for v1: `minimal`/`adaptive` user tiers (decision = 5
tiers) — they stay valid _internal_ normalization targets so a model catalog can
still declare them.

## Design

### Effort ladder & capability table

Canonical ordered ladder: `low < medium < high < xhigh < max`.

Each provider declares a supported subset; the translator clamps a requested
tier **down** the ladder to the nearest supported tier. Mapping (canonical →
wire value), with `↓` marking a clamp:

| Tier   | OpenAI `reasoning_effort` | DeepSeek `reasoning_effort` | GLM-5.2+ `reasoning_effort` | Anthropic `output_config.effort` | Gemini 3 `thinking_level` | Qwen DashScope       |
| ------ | ------------------------- | --------------------------- | --------------------------- | -------------------------------- | ------------------------- | -------------------- |
| low    | low                       | high¹                       | low                         | low                              | low                       | enable_thinking:true |
| medium | medium                    | high¹                       | medium                      | medium                           | medium                    | true                 |
| high   | high                      | high                        | high                        | high (default)                   | high                      | true                 |
| xhigh  | xhigh                     | max¹                        | xhigh                       | xhigh ↓high²                     | high ↓²                   | true                 |
| max    | xhigh ↓ (no `max`)        | max                         | max                         | max ↓high²                       | high ↓²                   | true                 |

¹ DeepSeek/GLM documented internal grouping (low/medium ≡ high, xhigh ≡ max).
² Clamped to the model's documented ceiling (varies by Anthropic model; Gemini 3
caps at `high`). Gemini 2.5 models map the tier to a `thinkingConfig.thinkingBudget`
bucket instead of `thinking_level`.

Clamping is **central and rank-based** (borrowed from openclaw's
`clampThinkingLevel`): assign each tier a rank
(`low:20, medium:30, high:40, xhigh:60, max:70`); a provider/model declares its
supported set (and optional `null` hard-caps for `xhigh`/`max`); the clamp picks
the nearest supported tier — hard-capped requests walk down, otherwise prefer the
next supported tier at or below the request. This replaces the ad-hoc per-adapter
clamps (e.g. Anthropic's current `max→high`).

Capability is declared **per model, not just per provider** (openclaw lesson):
the model's catalog entry / provider preset carries
`supportedReasoningEfforts?: EffortTier[]` (and an optional per-model
override map). Default when unset = the provider's full supported set. A new
provider/model is one table row; the clamp + three shape mappers are unchanged.

Three shape mappers own the wire translation (one per API family), fed the
already-clamped tier:

- `toReasoningEffort(tier)` — OpenAI/DeepSeek/GLM/DashScope flat
  `reasoning_effort` (DashScope instead → `enable_thinking` bool).
- `toAnthropicThinking(tier, model)` — `output_config.effort` for adaptive
  models, else `thinking.budget_tokens`.
- `toGeminiThinking(tier, model)` — `thinking_level` (Gemini 3) or
  `thinkingConfig.thinkingBudget` bucket (Gemini 2.5, thresholds per openclaw).

### Sampling-param hygiene

DeepSeek and GLM reject `temperature`/`top_p`/`presence_penalty`/`frequency_penalty`
in thinking mode. When a translator enables thinking for those providers it must
strip those sampling params from the request body.

### OpenAI-compatible field-shape divergence

"OpenAI-compatible" does NOT imply one effort field. The canonical config is the
nested `reasoning: { effort }` object; `buildReasoningConfig()`
(`pipeline.ts:689-717`) passes it through **verbatim, no value mapping**. Each
provider whose wire field differs must reshape it in its `buildRequest` hook.
Known shapes:

| Wire shape                           | Providers                                             | qwen-code handling                                                                                       |
| ------------------------------------ | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| nested `reasoning: { effort }`       | OpenAI Responses, OpenRouter, gpt-5.x                 | passthrough (default) ✅                                                                                 |
| flat top-level `reasoning_effort`    | DeepSeek, **GLM/z.ai**, OpenAI Chat Completions, Groq | DeepSeek adapter flattens ✅; **GLM has no adapter → currently ships the nested shape, likely wrong ❌** |
| `enable_thinking` bool               | qwen3 / DashScope                                     | adapter emits bool (disable only); no effort tiers yet                                                   |
| `extra_body.thinking.enabled` toggle | GLM                                                   | separate on/off knob from the effort value                                                               |

Implication: pure passthrough only "just works" for providers that accept the
nested shape. **PR1 must add GLM/z.ai flattening** (mirror `deepseek.ts`) and,
when qwen adds an effort field, extend the DashScope adapter to emit whatever
shape qwen's API documents (flat `reasoning_effort` most likely). A new provider
is auto-supported only if it accepts the nested canonical shape; otherwise it
needs a one-hook reshape.

### Config flow & persistence

- New global setting **`model.reasoningEffort`**: `'low' | 'medium' | 'high' | 'xhigh' | 'max'`,
  added to `settingsSchema.ts` (near the `generationConfig` node, `1412-1504`).
- At content-generator build time the config layer maps `model.reasoningEffort`
  into `generationConfig.reasoning.effort` (single source of truth into the
  existing translators). One global value, all models.
- Runtime change: add `config.setReasoningEffort(tier)` (alongside `switchModel`,
  `config.ts:~2047`) which updates the in-memory `generationConfig.reasoning.effort`
  and refreshes the active ContentGenerator, then `persistSetting('model.reasoningEffort', tier)`.

### CLI surface

- New `effortCommand.ts` (modeled on `modelCommand.ts:39-79`):
  - `/effort` → `{ type: 'dialog', dialog: 'effort' }`
  - `/effort high` → validate tier, call `config.setReasoningEffort`, persist, ack message.
  - `completion()` offers the 5 tiers.
- New `EffortDialog` Ink component + register `'effort'` dialog type in
  `commands/types.ts:168-198`. The dialog lists the 5 tiers and annotates which
  will be clamped for the current model (e.g. "max → high on this model").
- Status line: existing `model-with-reasoning` preset
  (`statusLinePresets.ts:13,46-51`) reads the live effort — no new preset.

### Type change

Extend the effort union in `contentGenerator.ts:104-118` to add `'xhigh'`. The
`reasoning: false` disable path is unchanged.

## Phasing (small PRs, each links an issue)

1. **core: ladder + mappings + clamps.** Extend union with `xhigh`; add the
   rank-based central clamp + per-model `supportedReasoningEfforts`; factor the
   three shape mappers; fill Gemini `medium`/`xhigh↓` + 2.5 budget buckets,
   confirm OpenAI/GLM `reasoning_effort` emission + `max↓xhigh`, add DashScope
   tier→bool; sampling-param stripping; verify the existing reasoning-strip path
   (`pipeline.ts:597-602`) covers history replay like openclaw's sanitizer. Unit
   tests per provider translator + clamp boundaries. No UI.
2. **cli: setting + direct command.** `model.reasoningEffort` schema, config
   mapping + `setReasoningEffort` runtime refresh, `/effort <tier>`, status-line
   live read. Tests.
3. **cli: picker dialog.** `EffortDialog` + bare `/effort`, per-model clamp hints.
4. **docs.** `docs/users/` effort page; cross-link reasoning/token-caching docs.

## Test Coverage

Highest-value checks: each provider translator emits the correct wire field for
every tier including clamp boundaries (`max` on OpenAI→`xhigh`, `xhigh`/`max` on
a Gemini-3 / capped-Anthropic model→`high`); sampling params stripped when
thinking is enabled for DeepSeek/GLM; `model.reasoningEffort` round-trips through
settings and into `generationConfig.reasoning.effort`; `setReasoningEffort`
rebuilds the ContentGenerator; one-time clamp warning fires once per
model+tier.
