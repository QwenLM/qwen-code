# Cycle 63 — Same-kind push coalescing (D6), leading-edge, opt-in

Proposal: `add-webpush`, design D6 ("same-kind coalescing within a 5 s
window"). The storm mitigation: a misbehaving task firing 50 same-kind events
in 10 s should not produce 50 pushes.

## Deviation notes (two, deliberate)

1. **Leading-edge drop, NOT trailing digest-with-count.** D6 describes
   DELAYING the first push up to 5 s to coalesce a burst into one "3 prompts
   pending in <session>" push. That (a) delays the user's first notification
   and (b) needs held sends + timers + a count. This cycle ships the simpler,
   safer **leading-edge** variant mirroring the cycle-46 rate limiter: the
   FIRST push of a same-`(subscription,kind,sessionId)` burst goes through
   IMMEDIATELY; same-kind-same-session repeats within the window are SUPPRESSED.
   The deep link still goes to the session, so "the user sees all three on
   arrival" (D6's own justification) holds. The "N pending" count is Deferred.
2. **Default OFF (window 0 = disabled).** Every other notifier gate FAILS OPEN
   (a glitch yields at most an extra push, never a missed prompt) — that is the
   project's load-bearing posture. Coalescing is the ONE gate that fails
   CLOSED: it can drop a genuine SECOND permission prompt 3 s after the first.
   D6 lists it as a default, but silently dropping a real prompt contradicts the
   never-miss-a-prompt invariant. So the window defaults to 0 (disabled) and an
   operator opts in via `GatewayDeps.coalesceWindowMs` (or the
   `QWEN_RC_COALESCE_MS` env). When enabled, the deep-link mitigation makes the
   tradeoff acceptable; when unset, behavior is byte-identical to today.

## Component (mirrors PushRateLimiter exactly)

`webpush/coalescer.ts` — `PushCoalescer`:

- `DEFAULT_COALESCE_WINDOW_MS = 5000` (the D6 window; only used when an operator
  enables coalescing without specifying a window).
- ctor `(windowMs = DEFAULT_COALESCE_WINDOW_MS)`. The gateway constructs it with
  the operator value (default 0).
- `tryPass(subId, kind, sessionId, nowMs): boolean` — `windowMs <= 0` -> always
  true (disabled). Else key = `subId\0kind\0sessionId`; if a previous allow is
  within `windowMs` -> false (SUPPRESS), else record `nowMs` and return true.
  Pure/total, never throws -> the notifier gate needs no try/catch (fail-open).
- `forget(subId)` — drop every key with that subscription prefix (called on
  unsubscribe alongside the rate-limiter forget; bounds memory as subs churn).

In-memory only: a restart resets, which for THIS feature means a restart can let
one extra push through (the fail-open direction — correct).

## Notifier wiring

- New OPTIONAL 9th ctor arg `coalescer?: PushCoalescer` (every existing
  `new PushNotifier(...)` site stays byte-identical -> no coalescer -> no gate).
- Gate placement: just BEFORE the rate-limit gate (coalesce the storm first, so
  suppressed duplicates never consume the rate-limit budget). On suppress: audit
  `push_suppressed{kind, reason:'coalesced', subscriptionId}` (a new detail
  VALUE, NOT a new AuditAction — `push_suppressed` already exists; like cycle
  53's `reason:'prefs'`) and `return`. Audited so "why no push" stays visible.
- `forgetRateLimit(subId)` also forgets the coalescer (rename-free: it already
  exists and is called from DELETE-subscription; just add the coalescer forget).

## Gateway wiring

`createGatewayApp`: inside the `if (deps.vapid && deps.pushStore)` block,
`const coalescer = new PushCoalescer(deps.coalesceWindowMs ?? Number(
process.env.QWEN_RC_COALESCE_MS) || 0)` and pass it as the notifier's 9th arg.
Default 0 -> disabled -> the e2e (no opt-in) is unaffected. New GatewayDeps
field `coalesceWindowMs?: number`.

## Fail-safe commit order

docs -> `coalescer.ts` + unit tests INERT (nothing constructs it) -> notifier
9th arg + gate + audit + forget (still inert: no caller passes a coalescer) ->
`createGatewayApp` construction + the GatewayDeps field LAST.

## Verification

- Unit: tryPass first-in-window true, repeat-within-window false, after-window
  true again, different-kind/different-session/different-sub all pass
  independently, window 0 always true, forget clears a sub's keys. Notifier: a
  same-kind-same-session second event within the window is suppressed + audited
  `reason:'coalesced'`; a different kind/session is not; no coalescer -> never
  suppressed. (Injected clock — no real timers.)
- e2e 45/45 unchanged (default window 0 -> coalescer inert in createGatewayApp;
  ran to confirm no regression).

## Deferred

The trailing digest-with-count ("N pending"); the end-of-quiet-window digest
(D4, a separate stateful-timer cycle); a per-kind window; surfacing the window
in a config file / web UI; coalescing across sessions.
