# Gemini 4 protocol defaults and reasoning controls

[English](2026-11-21-gemini-4-support.md) | [简体中文](2026-11-21-gemini-4-support.zh-CN.md)

## Problem statement

Gemini 4 model ids are not in the bundled model catalog. On a Gemini or Vertex
route without an explicit `capabilities.reasoning` declaration, the runtime
therefore has no reasoning capability for the model, while the generic Gemini
output fallback still reports 8K tokens. Users cannot rely on a consistent set
of built-in defaults for the new generation.

## Current state

- Token limits are derived from the models.dev catalog and then the normalized
  family tables in `packages/core/src/core/tokenLimits.ts`. The generic Gemini
  input fallback is 1M, but its output fallback is 8K; the 64K output row only
  names `gemini-3*`.
- An explicitly declared `profile: "gemini"` supports `low`, `medium`, and
  `high`. Without a declaration, Gemini has no built-in capability fallback;
  other protocol-specific fallbacks already exist.
- `/effort`, ACP session options, and the Web Shell provider preview consume
  the resolved capabilities. An undeclared Gemini 4 route either exposes the
  generic five-tier ladder or no provider preview at all.
- The Gemini generator already maps reasoning tiers to `thinkingLevel`, honors
  `reasoning: false`, and preserves a per-request opt-out once capabilities
  resolve. No new transport field is needed.

## Goals

- Give normalized `gemini-4*` ids a built-in 1M input window and 64K output
  limit.
- Give Gemini and Vertex routes serving `gemini-4*` a built-in reasoning
  capability: `low`, `medium`, and `high`, defaulting to `high`.
- Offer only those three tiers in CLI, ACP, and Web Shell controls, allow
  thinking to be disabled, and clamp any persisted legacy tier to that ladder.
- Preserve explicit user settings and explicit capability declarations.

## Proposed changes

### Token limits

Add a generation-specific row before the generic Gemini output fallback. The
existing generic 1M input rule already covers Gemini 4 and receives explicit
regression tests. Normalization continues to handle provider prefixes,
`-preview`, and dated aliases. Catalog values, when published, retain their
existing precedence.

### Reasoning capabilities

Add a narrowly scoped built-in recognizer for `gemini-4*` on `gemini` and
`vertex-ai` routes. It returns the existing `gemini` profile with
`low/medium/high`, default `high`, and the `thinking` disable field.

When no declaration exists, this recognizer is the Gemini counterpart of the
existing DeepSeek fallback. When a partial declaration exists, its native
ladder and default can be inherited just like GPT and Claude built-ins. Explicit
full declarations still govern the route.

The existing effective-reasoning clamp turns unsupported persisted tiers such
as `xhigh` or `max` into `high` at request time; selection controls reject new
choices outside the declared ladder. Selecting the provider default emits
`thinkingLevel: HIGH`; selecting thinking off emits the existing disabled
thinking config.

### Controls and documentation

No separate UI tier table is added. The CLI `/effort` lookup and the ACP/Web
Shell route previews already consume `resolveReasoningForModel`, so the one
built-in definition drives every surface. User-facing provider documentation
records the defaults and the override mechanism.

## Design decisions

- Scope the recognizer by both protocol and normalized model id. A
  `gemini-4-neon` id served through an OpenAI-compatible route must not acquire
  Gemini wire behavior.
- Scope it to Gemini 4 only. Existing Gemini 2.x and 3.x routes keep their
  current declaration and fallback behavior.
- Use the repository's decimal `1M` convention (`1,000,000`) and binary `64K`
  convention (`65,536`), matching the existing family tables.
- Reuse the current disabled-thinking wire shape rather than inventing a new
  Gemini 4-specific field without endpoint evidence.

## Scope boundaries

- No model catalog entries are generated or fetched.
- No endpoint-specific authentication, SSE, or proxy behavior changes.
- No changes for non-Gemini protocols or for explicitly declared Gemini 2.x/3.x
  routes beyond the existing behavior.

## Validation plan

- Unit tests pin input/output limits, aliases, non-Gemini exclusion, inherited
  defaults, default-high effective reasoning, clamping, opt-out, and the
  restricted CLI/ACP options.
- Generator tests pin default `HIGH`, an explicit lower tier, and thinking off,
  including a request-level opt-out.
- Build and typecheck the repository and run focused core/CLI/unit and
  web/provider-status tests.
- A local mock Gemini endpoint captures the final wire request for default,
  selected-tier, and disabled cases without real credentials.

## Acceptance criteria

1. Undeclared `gemini-4*` Gemini/Vertex routes resolve to 1M input and 64K
   output defaults.
2. Their default request uses `thinkingLevel: HIGH`; low and medium are honored,
   legacy stronger tiers clamp to high, and thinking can be disabled.
3. `/effort` and provider reasoning controls offer only low/medium/high, with
   high as the default and no persistence of an implicit user choice.
4. OpenAI routes with the same model id and pre-Gemini-4 routes are unchanged.
5. Focused tests, typecheck, and the mock-wire verification pass.

## Open questions

None. Provider-specific features beyond these defaults require evidence from
the serving endpoint before they are added.
