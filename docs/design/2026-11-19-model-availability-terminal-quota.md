# Model availability: terminal quota marking for the fallback chain

- **Date:** 2026-11-19
- **Status:** Implemented (pending review)
- **Builds on:** [2026-11-15-model-availability-tracking.md](./2026-11-15-model-availability-tracking.md) (merged in #17377, squash `3755d5e7af`)
- **中文版本:** [2026-11-19-model-availability-terminal-quota.zh-CN.md](./2026-11-19-model-availability-terminal-quota.zh-CN.md)

## Problem statement

The merged availability port (#17377) records a fallback model that exhausts a
**transient capacity** error (429/503/529, `isFallbackEligible`) as
`sticky_retry`: the model is skipped for the rest of the current turn and
re-probed on the next turn. The ledger also defines a `terminal` state
(`markTerminal(model, 'quota' | 'capacity')`) that survives `resetTurn` and is
never downgraded, but the port deliberately left `markTerminal` without a
caller.

The gap: a fallback model that fails with a **permanent quota** error is not
recorded at all today, so it is re-probed on every subsequent turn even though
it cannot succeed until its quota resets (possibly days later). Each re-probe
spends a request and latency for a foregone conclusion.

### Why permanent quota never reaches the ledger today

`classifyRetryError` labels the permanent-quota shapes `fail-fast`:

| Reason literal               | Signal                                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------------------------- |
| `qwen-oauth-free-tier-quota` | QWEN_OAUTH + `isQwenQuotaExceededError` (429 `insufficient_quota`, "free allocated quota exceeded") |
| `allocated-quota-exceeded`   | provider code `Throttling.AllocationQuota`                                                          |
| `permanent-provider-code`    | provider code/type matching the permanent pattern, incl. `insufficient_quota`                       |

`isFallbackEligible` excludes `fail-fast` (and `unknown`) diagnoses, so in the
fallback `catch` block `canTryNextFallback` is `false` for these errors and the
existing `markRetryOncePerTurn` / `consumeStickyAttempt` pair — gated on
`canTryNextFallback` — never runs. The chain stops (correct: a permanent error
should not cascade), but the exhausted model leaves no ledger trace.

A reset-time quota error (Bailian token-plan "1-week quota has been exhausted,
will reset at …", detected by `isQuotaExhaustedError`) can also reach the
fallback `catch` from a fallback's own stream. Depending on its shape it
classifies either `fail-fast`/`unclassified` (chain stops, unmarked) or
`rate-limit` retryable (marked `sticky_retry`, re-probed next turn). Neither is
right for a quota that only resets at a named future time.

The primary's own mid-stream reset-time quota fast-fail
(`llm-chat.ts`, `isQuotaExhaustedError` branch) throws a status-less formatted
`Error` and explicitly skips model fallback; that path is unchanged here.

## Proposed change

Mark a **fallback** model `terminal` with reason `quota` when its failure is a
permanent-quota error, so the chain's entry snapshot skips it for the rest of
the session instead of re-probing it each turn.

### 1. A terminal-quota predicate

Add `isTerminalQuotaError(error, classification)` next to the retry
classification (`packages/core/src/utils/retryErrorClassification.ts`). It
returns true exactly for the permanent-quota signals. The flow is:

- `classification.reason === 'qwen-oauth-free-tier-quota'` or
  `'allocated-quota-exceeded'` (the two fail-fast quota reasons) returns true.
- `classification.providerCode` matching `insufficient_quota` (case/separator
  insensitive) returns true. This is checked once, before the walk.
- Otherwise walk a **bounded cause chain** (the error and up to four `cause`
  levels); at each node, return true if `isQuotaExhaustedError(node)` (the
  reset-time quota message) or if the `insufficient_quota` code appears in the
  provider fields' `providerCode` / `providerType` (`getProviderFields`) or the
  message-scraped `getRateLimitErrorDetails` `providerCode` / `providerType`.

The signal is read **independent of `classification.reason`**: the canonical
OpenAI `429 insufficient_quota` classifies `rate-limit` (`isRateLimitError` runs
before the classifier's permanence arms), never `permanent-provider-code`, so
gating the code check on that reason would miss it. The provider fields cover
the SDK shape that puts `insufficient_quota` in `.type` with `code: null`; the
scraped details cover a nested body whose `type` is `insufficient_quota` beside a
non-quota sibling `code` (the classifier reads permanence from
`details.providerType`). The cause walk covers the retry layer's wraps: the
QWEN_OAUTH free-tier replacement strips the quota wording and keeps the original
as `cause` (attached unconditionally in `retry.ts`, since the fallback's
`retryWithBackoff` call passes no `singleAttempt`), so the signal must be read
through the wrap rather than off the thrown error alone.

**No arm returns a negative verdict** — the only negative exit is the final one
after the walk. This is the invariant that lets a reset-time quota message under
a permanent non-quota code still be marked terminal: a node's code test never
masks a later node's message. Adding an early `return false` (a natural-looking
"optimization" once the classifier has decided the reason) would break that case.

Non-quota permanent errors (moderation `data_inspection_failed`, auth, billing
other than `insufficient_quota`, malformed request) do **not** match: none of
their codes is `insufficient_quota` and their messages carry no reset-time quota
signal. Transient capacity (429/503/529 retryable, e.g. TPM throttling) does not
match and keeps its existing `sticky_retry` behavior. The classifier itself is
unchanged: a 429 stays `rate-limit`/`retryable` because the bounded retry ladder
and `isFallbackEligible` depend on it; the quota signal is added alongside that
classification, not by re-reasoning the 429 as fail-fast.

### 2. Wire it into the fallback catch block

In `llm-chat.ts`'s fallback `catch`, replace the single sticky-marking branch
with a terminal-first decision (still gated on the bound `availability`, which
is `undefined` when the opt-in gate is off or the send is not a session turn):

```
if (availability) {
  if (isTerminalQuotaError(fallbackError, fallbackClassification)) {
    availability.markTerminal(fallbackRouteKey, 'quota');
  } else if (canTryNextFallback) {
    availability.markRetryOncePerTurn(fallbackRouteKey);
    availability.consumeStickyAttempt(fallbackRouteKey);
  }
}
```

Terminal wins over sticky: a reset-time quota that happens to classify
retryable is marked `terminal`, not `sticky_retry`. The ledger key is the
resolved route identity (`fallbackRouteKey`), exactly as the existing marking
uses, so same-model-different-route health stays separate.

### 3. No new read or recovery path needed

- The chain-entry snapshot already reports `available: false` for `terminal`,
  so a terminal fallback is skipped on every later request this session.
- `resetTurn` already preserves `terminal` (only `sticky_retry.consumed` is
  reset), so the skip survives turn boundaries.
- `startNewSession` already drops the service instance, so terminal health is
  session-scoped and a new session re-probes from scratch.
- The fallback success path already calls `markHealthy(fallbackRouteKey)`,
  which clears any state including terminal; it is the recovery API the prior
  design kept deliberately. A terminal fallback is skipped at entry and so is
  not re-attempted within the session — terminal is session-permanent by
  design, consistent with "a terminal failure is never downgraded".

## Key design decisions

| Decision                                                              | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Fallback-only, not primary                                            | The primary is attempted every request (primary-skip is out of scope, #17377). Writing terminal for the primary would be a dead write with no reader.                                                                                                                                                                                                                                                                                                                                                                                            |
| Reason `quota` only                                                   | The narrow slice wires the quota signal. `terminal` reason `capacity` stays available on the ledger but has no caller (main has no permanent-capacity classification; 529 is retryable).                                                                                                                                                                                                                                                                                                                                                         |
| Terminal-first `else if`                                              | Avoids a double mark when a reset-time quota classifies retryable; `markRetryOncePerTurn` already refuses to downgrade terminal, and the `else if` makes the intent explicit.                                                                                                                                                                                                                                                                                                                                                                    |
| Predicate reads the quota signal independent of classification reason | The two fail-fast quota reason literals and `classification.providerCode` are checked first (providerCode once, before the walk); then a bounded cause walk tests the reset-time message (`isQuotaExhaustedError`) and the `insufficient_quota` code (from the provider fields' code/type and the message-scraped details) at each node. No arm returns a negative verdict. Not gated on `permanent-provider-code`, because the canonical `429 insufficient_quota` classifies `rate-limit`. The classifier is unchanged (a 429 stays retryable). |
| Gate unchanged                                                        | Marking is gated on the bound `availability` (`isSessionTurn && isModelAvailabilityTrackingEnabled?.()`); gate-off behavior is byte-identical.                                                                                                                                                                                                                                                                                                                                                                                                   |
| No `modelPolicy` action map                                           | The preview's prompt-vs-silent `ModelPolicy` UI is a separate concern and out of scope (Option B: main architecture wins).                                                                                                                                                                                                                                                                                                                                                                                                                       |

## Files affected

- `packages/core/src/utils/retryErrorClassification.ts` — add
  `isTerminalQuotaError`; import `isQuotaExhaustedError` from
  `quotaErrorDetection.js`.
- `packages/core/src/utils/retryErrorClassification.test.ts` — predicate unit
  corpus (each quota signal true; auth/moderation/transient-capacity false).
- `packages/core/src/core/llm-chat.ts` — terminal-first marking in the fallback
  `catch`.
- `packages/core/src/core/llm-chat.test.ts` — gate-on integration: a fallback
  hitting permanent quota is marked terminal and skipped on the next turn and
  the next request; gate-off leaves the ledger untouched; transient capacity
  still uses sticky_retry.
- `docs/design/2026-11-15-model-availability-tracking.md` (+ zh-CN) — move
  terminal/quota marking out of "Out of scope" once landed; note `markHealthy`
  now has its intended recovery role.
- `packages/cli/src/config/settingsSchema.ts` (+ regenerated
  `packages/vscode-ide-companion/schemas/settings.schema.json`, web-shell
  `messages.ts` / `i18n-zh-tw.ts`) — refresh the `modelAvailabilityTracking`
  description to mention session-permanent skipping of quota-exhausted
  fallbacks, if the wording changes.

## Scope boundaries

- No primary-skip at the chain entry (still attempted each request).
- No `modelPolicy` prompt-vs-silent user interaction.
- No cross-session / account-wide health sharing.
- No change to the opt-in default (`experimental.modelAvailabilityTracking`
  stays `false`).
- No change to the primary mid-stream quota fast-fail or to retry budgets.

## Verification plan

- Predicate unit corpus with a killed mutation per signal (drop each arm →
  the matching case turns red).
- Gate-on integration tests through the real fallback wiring, driven by the real
  classifier: the canonical `429 insufficient_quota` (rate-limit/retryable, not
  fast-failed) is marked terminal and fallback B serves, with A skipped on a
  second same-turn request and a new-turn request (terminal survives
  `resetTurn`); a statusless fail-fast quota stops the chain yet still marks A
  terminal, and a fresh turn reaches B directly; a transient capacity fallback
  still re-probes next turn (sticky unchanged).
- Gate-off witness: inject a real service with the gate false, assert no
  `markTerminal` call and byte-identical fallback behavior.
- A permanent real-HTTP test (real local OpenAI-compatible server + real SDK +
  real `ModelAvailabilityService`) where fallback A returns a reset-time quota
  body. The retry layer's stop/continue decision is pinned by delegating the
  quota fast-fail to the real source functions (`isQuotaExhaustedError` /
  `formatQuotaExhaustedMessage`, replicating `retry.ts`): the real
  `retryWithBackoff` cannot run over the real socket because its transient-429
  rate-limit ladder uses real 1-5 min delays and fake timers freeze socket I/O.
  Request 1 fast-fails the quota into a status-less formatted Error, so the chain
  stops (B never called) but A is marked terminal; fresh turns skip A and serve
  via B over the real socket. Mutation-witnessed (disable terminal marking →
  re-probe observed).
- core typecheck + lint + affected suites green; multi-pass self-audit.

## Open questions / residuals

- Whether `makeFallbackStream` shares the primary's mid-stream
  `isQuotaExhaustedError` fast-fail determines the exact error shape reaching
  the fallback `catch` (formatted status-less `Error` vs raw 429). The predicate
  handles both; the integration test pins the observed shape.
- The single-scalar `lastTurnKey` concurrency limitation documented in #17377
  is unchanged; terminal marking inherits the same session-turn whitelist.
- Background model rounds (subagent rounds, unified-loop speculation) deliberately
  do not bind the ledger, so they still attempt a quota-marked fallback. The skip
  applies to the conversation's own session turns; the setting description says
  so. Letting background rounds read the ledger without writing it is a possible
  refinement, out of this slice.
- A terminal mark has no in-session escape: a quota whose reset time passes
  mid-session, or a credential swap on the same route key (the route identity
  digests only `authType` + `baseUrl`), leaves the fallback skipped until a new
  session. This is the deliberate session-permanent scope; the description names
  a new session as the only re-probe. Carrying the reset deadline on the mark and
  re-probing once it passes, or clearing terminal marks on credential rebuild, is
  a larger recovery enhancement out of this slice.
- The terminal mark runs before the post-output `break`, so a fallback that
  streamed a partial chunk and then failed on quota is still recorded terminal;
  a dedicated test pins this (scoping the mark behind `!currentFallbackYieldedAnyChunk`
  turns it red).
- The "gate-off behavior is byte-identical" claim holds for the fallback
  marking/skip behavior, with one exception: `retry.ts` attaches the QWEN_OAUTH
  free-tier replacement's `cause` unconditionally (not gated by the setting), and
  `getErrorMessage` appends a `(cause: …)` detail, so that one error message's
  text grows even when the setting is off. This is harmless extra diagnostics,
  not a behavior change to the fallback chain; no code change is made for it.
