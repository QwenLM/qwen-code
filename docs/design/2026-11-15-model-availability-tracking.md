# Model availability tracking (Qoder capability port, Option B)

[简体中文](./2026-11-15-model-availability-tracking.zh-CN.md)

- **Date**: 2026-11-15
- **Status**: Proposed
- **Tracker**: Qoder→main integration, Option B (main architecture wins; port
  differentiated capabilities). First ported capability: `availability`.
- **Source**: preview `packages/core/src/availability/` (tag `587e3429ca`),
  classified NEW-adjacent / load-bearing ALTERNATIVE in the integration
  inventory. Self-contained (4 files / 393 lines, pure state machine).

## Problem

main's model fallback (`core/llm-chat.ts`, "Model fallback chain") is
**stateless per request**: when the primary model exhausts its retry budget on
a capacity error (429/503/529, `isFallbackEligible`), the chain tries each
configured fallback with a fresh budget. Nothing remembers that a fallback was
just exhausted, so the **next request in the same turn re-tries the same
exhausted fallbacks from scratch**, wasting latency and quota before reaching a
healthy model again. This port gives the chain cross-request memory for
**fallback selection**: an exhausted fallback is skipped for the rest of the
turn and re-probed once on the next turn. The primary is still attempted on
every request (it may have recovered); skipping an unhealthy primary at the
chain's entry point is a separate design change, out of scope here.

## Current behavior (verified at branch base)

- `isFallbackEligible` (`utils/retryErrorClassification.ts`): fallback only for
  status 429/503/529, non-transport, diagnosis not `fail-fast`/`unknown`.
- Fallback chain (`core/llm-chat.ts` ~5800): gated by `getModelFallbacks()`,
  skipped in unattended/persistent mode and when a chunk already yielded; max
  3 transitions; each fallback resolved via `resolveForModel(..., failClosed)`.
- No cross-request model health memory anywhere in main.

## Proposed change

Port preview's `ModelAvailabilityService` — a per-model health ledger — and
wire it into the fallback chain so an exhausted model is skipped for the rest
of the turn instead of being re-tried on every request.

### Service (ported, self-contained)

`packages/core/src/core/model-availability-service.ts` (kebab-case per main
convention; preview file is `modelAvailabilityService.ts`). Pure state machine,
no zod / no external deps, so no zod-4 migration is needed for it:

- States: `terminal` (reason `quota`|`capacity`) and `sticky_retry`
  (`retry_once_per_turn`, with a `consumed` flag).
- API: `markTerminal`, `markHealthy`, `markRetryOncePerTurn`,
  `consumeStickyAttempt`, `snapshot`, `selectFirstAvailable`, `resetTurn`,
  `reset`, plus a main-specific `beginTurn(turnKey)` that resets consumed state
  only when the turn key (the user prompt id) changes — main has no explicit
  turn-boundary hook, so the prompt id serves as the turn key.
- Invariants preserved from preview: a terminal failure is never downgraded to
  transient; `markRetryOncePerTurn` keeps `consumed` if already sticky (no
  infinite same-turn loop); `snapshot` reports unavailable for terminal or
  consumed-sticky.

### Ownership and wiring

- `Config` owns one instance (session-scoped), exposed via a lazy
  `getModelAvailabilityService()` getter, mirroring how preview's Config owns
  it.
- In the fallback chain, behind a setting gate:
  - `beginTurn(prompt_id)` so a new turn re-probes sticky models once. Only
    fallback models are written to and read from the ledger; the primary is
    still attempted each request and is not marked (marking it would be a dead
    write, since the chain's two same-model guards exclude it from the skip).
  - Before attempting a fallback model, consult `snapshot(model)`; skip models
    reported unavailable (record them in the existing skip/debug path).
  - When a fallback exhausts retries on a fallback-eligible capacity error,
    call `markRetryOncePerTurn(model)` then `consumeStickyAttempt(model)` so it
    is skipped for the remainder of the turn.
  - On a successful fallback response, `markHealthy(model)`.
  - An explicit user Retry (`SendMessageType.Retry`, threaded as
    `isExplicitRetry` through `LlmClient` → `Turn` → `LlmChatSendOptions`) is a
    turn boundary: it calls `resetTurn()` so a retry re-probes fallbacks the
    failed attempt consumed, even though a retry reuses the prompt id.
- Error mapping for this first port is deliberately narrow: only the
  capacity statuses already admitted by `isFallbackEligible` feed the ledger
  (`sticky_retry`). Terminal/quota marking is deferred to a follow-up so the
  first PR does not change auth/billing behavior.

### Feature gate

New boolean setting `experimental.modelAvailabilityTracking`, **default
false**. When off, the fallback chain behaves exactly as today (the ledger is
not consulted and not written). This keeps the first port opt-in and
reversible; a later PR can flip the default once nightly evidence is in.

## Key design decisions

| Decision                                                | Rationale                                                                                                 |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Port the service verbatim (logic), rename to kebab-case | Pure state machine, well-tested in preview; no zod dependency so no zod-4 rework.                         |
| Session-scoped on Config                                | Matches main's per-session Config and preview's ownership; avoids a process-global health singleton.      |
| Only capacity → sticky_retry in this port               | `isFallbackEligible` already bounds the scope; terminal/quota marking would touch auth/billing, deferred. |
| Setting gate default off                                | Behavior change to the fallback chain must be opt-in and reversible first.                                |
| resetTurn at turn start                                 | A new turn should re-probe a sticky model once; matches preview semantics.                                |

## Files affected

- `packages/core/src/core/model-availability-service.ts` (new) + collocated test.
- `packages/core/src/config/config.ts` — lazy getter owning the service + the
  `modelAvailabilityTracking` parameter.
- `packages/core/src/core/llm-chat.ts` — fallback-chain consultation/marking
  behind the gate; `isExplicitRetry` on `LlmChatSendOptions`.
- `packages/core/src/core/turn.ts` + `packages/core/src/core/client.ts` — thread
  the explicit-Retry flag from `SendMessageType.Retry` to the send options.
- `packages/cli/src/config/settingsSchema.ts` + `packages/cli/src/config/config.ts`
  — `experimental.modelAvailabilityTracking` (default false) + propagation, with
  CLI wiring tests mirroring the `unifiedAgentLoop` opt-in/opt-out/unset shape.

## Acceptance criteria

- Service unit tests port and pass (terminal not downgraded; sticky consumed
  once per turn; selectFirstAvailable skips unavailable; resetTurn re-probes).
- With the gate off, fallback-chain behavior is byte-for-byte unchanged
  (existing llm-chat fallback suites stay green).
- With the gate on, a model exhausted on a capacity error is skipped on the
  next request of the same turn and re-probed once on the next turn.
- build + typecheck + affected suites green; multi-pass self-audit.

## Out of scope (follow-ups)

- Skipping an unhealthy **primary** at the chain's entry point (this port only
  skips fallbacks; the primary is still attempted each request).
- Terminal/quota marking and the `modelPolicy` action map (prompt vs silent).
  `markHealthy` is kept deliberately even though it has no observable effect
  until terminal marking lands.
- Cross-session / account-wide health sharing.
- Flipping the setting default.
