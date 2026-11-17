# Model availability tracking (Qoder capability port, Option B)

[简体中文](./2026-11-15-model-availability-tracking.zh-CN.md)

- **Date**: 2026-11-15
- **Status**: Proposed
- **Tracker**: Qoder→main integration, Option B (main architecture wins; port
  differentiated capabilities). First ported capability: `availability`.
- **Source**: preview `packages/core/src/availability/` (tag `587e3429ca`).
  Self-contained (4 files / 393 lines, pure state machine).

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
  `consumeStickyAttempt`, `snapshot`, `resetTurn`, plus a main-specific
  `beginTurn(turnKey)` that resets consumed state only when the turn key (the
  user prompt id) changes. Main's turn identity is the prompt id: `Config`
  already carries a per-interaction turn-boundary object (`TurnBudget`, written
  by `beginTurnBudget` when an interaction starts), but the ledger deliberately
  keys on the prompt id of allowlisted sends rather than reusing it, because
  that writer also fires for the `Notification`/`Teammate` sends the ledger
  must exclude. Preview's `selectFirstAvailable` and `reset` helpers are
  deliberately not ported: nothing in the fallback-skipping wiring calls them
  and no follow-up plans to (primary selection is out of scope), so they would
  be dead surface. The `terminal` state and `markTerminal` are retained despite
  having no caller in this port because the deferred terminal/quota-marking
  follow-up is their planned caller — unlike the two dropped helpers.
- Invariants preserved from preview: a terminal failure is never downgraded to
  transient; `markRetryOncePerTurn` keeps `consumed` if already sticky (no
  infinite same-turn loop); `snapshot` reports unavailable for terminal or
  consumed-sticky.

### Ownership and wiring

- `Config` owns one instance (session-scoped), exposed via a lazy
  `getModelAvailabilityService()` getter, mirroring how preview's Config owns
  it.
- Behind a setting gate, the turn boundary runs once per request at the
  `sendMessageStream` entry — not inside the fallback branch — so it applies
  even when a request never reaches the chain:
  - `beginTurn(prompt_id)` re-probes sticky models once when the turn key (the
    user prompt id) changes; same-key requests keep their consumed state.
  - An explicit user Retry (`SendMessageType.Retry`, threaded as
    `isExplicitRetry` through `LlmClient` → `Turn` → `LlmChatSendOptions`) calls
    `resetTurn()` so a retry re-probes fallbacks the failed attempt consumed,
    even though a retry reuses the prompt id and even when the recovered primary
    serves the retry's first request.
  - Only session-turn sends participate, via an `isSessionTurn` flag the ledger
    gate requires. Membership is decided by the **sender**, not inferred from
    "went through `Turn`": `LlmClient` constructs the live turn's `Turn` with
    `isSessionTurn` set per `messageType` — true for the turn's own sends
    (user query, cron, goal, retry, tool result, and continuations), false for
    `Notification`/`Teammate` (which carry fresh prompt ids). A concurrent
    `/btw` side query, `Notification` and `Teammate` are additionally excluded by
    a registry of their prompt ids (`backgroundInteractionPromptIds`): the
    background flag/messageType is only on the first send, so their unflagged
    ToolResult/Hook/Steer continuations must be excluded by prompt id too, or
    they would rotate the live turn's key. Every registered id is unique: the
    CLI advances a monotonic prompt-id **mint counter** whenever a top-level turn
    mints a fresh id — user query, cron, teammate, `Notification`, `Goal` and
    `Retry` alike — so a registered id is never reused by a foreground turn
    (R6-1/R7-1/R8-F1 root fix). The mint counter is decoupled from the
    user-visible `Prompts` statistic (`userPromptCount`, advanced only for
    user-initiated turns), so background mints do not inflate `/stats`, the
    feedback threshold or the tip cadence (R8-F3). The registry is bounded FIFO
    like `stopHookChains`, evicting by insertion order (R8-F11); this is safe
    because a background interaction's continuations drain within its turn, long
    before 32 newer interactions would evict its id — the bound is not a drain
    check. In the headless CLI a teammate turn mints its own id and a
    later foreground turn restores the base id once the teammate turn ends, so
    the registered teammate id cannot drop later foreground sends (R8-F2). A
    `Goal` turn is a ledger member (not registered), but its minted id is
    likewise unique, so a fallback it exhausts cannot be skipped by a later user
    turn that never tried it.
    `Turn` takes it as a constructor parameter (default unset) and
    forwards it to the send options only when set. `turnModelRound` builds its
    `Turn` without it because every production caller is a background round (the
    subagent shared loop and unified-loop speculation) sharing the session
    `Config`. The ACP session send sets it true, and
    `LlmChat.sendPreparedMessageStream` (the hosted-harness prepared resume)
    hardcodes it in its delegation to `sendMessageStream` — both are genuine
    session sends. ACP mid-turn automatic continuations rewrite the
    prompt id with a guard/stop-hook/background-result/mid-turn suffix, so the
    ACP sender passes the turn's base id as `ledgerTurnKey` and the ledger keys
    on it (`prompt_id` keeps its prompt identity); otherwise each continuation
    would read as a new turn and reset the consumed marks. Direct background
    sends (forked queries, legacy speculation/subagent, suggestions) call
    `sendMessageStream` without the flag. Background operations therefore neither rotate the live
    turn's key nor read or write its marks, and keep the gate-off fallback
    behaviour. This is an allowlist, not a prompt-id blacklist: background
    senders use ids (e.g. a subagent's `session#agent#ordinal`) that no fixed
    blacklist matches, and the shared `isInternalPromptId` filter must not be
    extended because it also gates recording/telemetry. Without the exclusion a
    background send would wipe the live turn's consumed state, and could skip a
    transiently-exhausted fallback and fail a request the gate-off chain would
    have served.
- In the fallback chain itself, only fallback models are written to and read
  from the ledger; the primary is still attempted each request and is not
  marked (marking it would be a dead write: the primary is attempted before the
  fallback chain and is never a fallback candidate, so the skip never reads its
  mark):
  - Before attempting a fallback model, consult `snapshot(model)`; skip models
    reported unavailable (record them in the existing skip/debug path).
  - When a fallback exhausts retries on a fallback-eligible capacity error,
    call `markRetryOncePerTurn(model)` then `consumeStickyAttempt(model)` so it
    is skipped for the remainder of the turn. The marking happens even if the
    fallback emitted output before failing (the chain still stops there to
    avoid duplicating user-visible output); it stays gated on
    `isFallbackEligible` so a post-output auth/client error is not recorded.
  - On a successful fallback response, `markHealthy(model)`.
- Turn-key limitation: `lastTurnKey` is a single scalar on the session-scoped
  service, and marks are keyed by model alone with no attribution to the turn
  that wrote them. Internal background sends are excluded (above), so the
  residual case is two genuine user turns sharing one `Config` concurrently.
  That concurrency cuts both ways. Fail-open: a new turn's `beginTurn` resets
  the other turn's consumed marks, so models are re-probed (pre-PR behaviour)
  and the skip optimization simply does not apply. Fail-closed: a late mark
  written by turn A's in-flight request after turn B has begun binds turn B, so
  B skips a fallback it never attempted and can fail where the gate-off chain
  would have tried it. Both directions are confined to that concurrency and to
  the opt-in gate; a follow-up can tag each mark with its requesting turn key so
  foreign marks are ignored.
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

| Decision                                                 | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Port the service logic (drop unused helpers), kebab-case | Pure state machine, well-tested in preview; no zod dependency so no zod-4 rework. `selectFirstAvailable`/`reset` have no caller here, so they are not ported.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Session-scoped on Config                                 | Matches main's per-session Config and preview's ownership; avoids a process-global health singleton.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Only capacity → sticky_retry in this port                | `isFallbackEligible` already bounds the scope; terminal/quota marking would touch auth/billing, deferred.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Setting gate default off                                 | Behavior change to the fallback chain must be opt-in and reversible first.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Turn boundary at request entry                           | `beginTurn`/`resetTurn` run in `sendMessageStream` before any model call, so an explicit Retry the primary serves still re-probes consumed fallbacks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Allowlist session turns (`isSessionTurn`)                | Membership is decided by the sender (`LlmClient` per `messageType`; the ACP session send and prepared resume set it true), not inferred from "went through `Turn`". Background senders (`turnModelRound` subagent/speculation, forked, suggestion, Notification/Teammate) leave it unset; a concurrent side query is excluded by its registered prompt id (covering its unflagged continuation), and ACP mid-turn continuations keep the turn's base `ledgerTurnKey`. An allowlist, not a prompt-id blacklist, because background ids (e.g. `session#agent#ordinal`) match no fixed blacklist and the shared internal-id filter also gates telemetry. |

## Files affected

- `packages/core/src/core/model-availability-service.ts` (new) + collocated test.
- `packages/core/src/config/config.ts` — lazy getter owning the service + the
  `modelAvailabilityTracking` parameter.
- `packages/core/src/core/llm-chat.ts` — request-entry turn boundary plus
  fallback-chain consultation/marking behind the gate, allowlisting session
  turns; `isExplicitRetry`, `isSessionTurn` and `ledgerTurnKey` on
  `LlmChatSendOptions` (`beginTurn` keys on `ledgerTurnKey ?? prompt_id`).
- `packages/core/src/core/turn.ts` + `packages/core/src/core/client.ts` — thread
  the explicit-Retry flag from `SendMessageType.Retry` to the send options, and
  decide ledger membership at the sender: `LlmClient` sets `isSessionTurn` per
  `messageType`, `Turn` forwards it from a constructor parameter (default unset),
  and a registry of concurrent side-query prompt ids excludes a side query's
  unflagged tool-result continuation.
- `packages/cli/src/acp-integration/session/Session.ts` +
  `packages/cli/src/acp-integration/session/ledger-turn-key.ts` — the ACP send
  sets `isSessionTurn`; `deriveLedgerTurnKey` normalizes mid-turn continuation
  suffixes into `ledgerTurnKey` (prompt identity unchanged).
- `packages/cli/src/ui/hooks/use-llm-stream.ts` +
  `packages/cli/src/ui/contexts/SessionContext.tsx` — the prompt-id mint counter
  (`promptCount`) advances for every minting top-level turn (user query, cron,
  teammate, notification, goal, retry); the user-visible Prompts statistic
  (`userPromptCount`) advances only for user-initiated turns and feeds `/stats`,
  the feedback threshold and the tip cadence.
- `packages/cli/src/nonInteractiveCli.ts` — a headless teammate turn mints its
  own prompt id; a `teammateTurnActive` flag keeps it for the turn and its
  continuations and restores the base id for the next foreground turn.
- `packages/cli/src/config/settingsSchema.ts` + `packages/cli/src/config/config.ts`
  — `experimental.modelAvailabilityTracking` (default false) + propagation, with
  CLI wiring tests mirroring the `unifiedAgentLoop` opt-in/opt-out/unset shape.
- `docs/users/configuration/settings.md` + `packages/web-shell/client/settings.ts`
  / `settings/messages.ts` — settings reference row, Web Shell alias and zh-CN
  label/description.

## Acceptance criteria

- Service unit tests port and pass (terminal not downgraded; sticky consumed
  once per turn; resetTurn/beginTurn re-probe).
- With the gate off, fallback-chain behavior is byte-for-byte unchanged
  (existing llm-chat fallback suites stay green), pinned by a case that injects
  a real service while the gate returns false and asserts the exhausted
  fallback is still retried and the getter is never called.
- With the gate on, a model exhausted on a capacity error is skipped on the
  next request of the same turn and re-probed once on the next turn.
- Internal background sends neither wipe the live turn's consumed state nor
  fail on a skipped fallback; an explicit Retry the primary serves still
  re-probes consumed fallbacks (regression cases in `llm-chat.test.ts`).
- The id-uniqueness premise every registry-based exclusion rests on is pinned:
  each minting top-level turn (user query, cron, teammate, Notification, Goal,
  Retry) advances the mint counter so the next minted id differs; the mint
  counter is decoupled from the user-visible Prompts statistic; the registry is
  bounded FIFO; and a headless foreground turn after a teammate turn restores
  the base id (R8-F1/F2/F3/F11 cases in `use-llm-stream.test.tsx`,
  `client.test.ts`, `nonInteractiveCli.test.ts`).
- The primary is still attempted each request even when the ledger marks it
  unavailable, and the MODEL_FALLBACK ordinal counts only attempted fallbacks
  across a ledger skip (R8-F9/F10 cases in `llm-chat.test.ts`).
- Config pins the false default, a stable lazy service instance, and that
  derived Configs (via `deriveConfig`) share the session ledger through the
  prototype chain once the session has created it.
- build + typecheck + affected suites green; multi-pass self-audit.

## Out of scope (follow-ups)

- Skipping an unhealthy **primary** at the chain's entry point (this port only
  skips fallbacks; the primary is still attempted each request).
- Terminal/quota marking and the `modelPolicy` action map (prompt vs silent).
  `markHealthy` is kept deliberately even though it has no observable effect
  until terminal marking lands.
- Cross-session / account-wide health sharing.
- Flipping the setting default.
