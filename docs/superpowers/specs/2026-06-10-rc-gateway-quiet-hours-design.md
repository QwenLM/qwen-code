# Cycle 29 — Per-subscription quiet hours (webpush) — design

## Context

`add-webpush-notifications` proposal D4 specifies per-subscription
`quietHours` (`from`, `to`, `timezone`) and `maxPerHour`: the send
pipeline filters before sending so a device can be silenced during its
own night window. Cycles 8–12/15–17 already built the VAPID/subscription
store, the scope-gated notifier fan-out, snooze, per-subscription kind
prefs, and working-device suppression. This cycle adds the **quiet-hours**
half of D4.

## Deviation from the proposal

The proposal's design.md is daemon-centric ("the send pipeline filters").
We deliver the same capability gateway-side: the gate lives in the
gateway's `PushNotifier.notify` fan-out (the same place snooze / prefs /
working-device gates already live). No daemon edit; the whole change is
inside `packages/rc-gateway/`.

## Decisions

- **D1 — Reuse the policy time-of-day helpers.** Quiet-hours uses the
  exact `{from, to, timezone}` shape that cycle-22 `parseTimeOfDay`
  already validates and `isWithinTimeOfDay` already evaluates
  (DST-correct via `Intl.DateTimeFormat`, inclusive both ends, wraps
  midnight when `from > to`). `isWithin(now)` is precisely the
  "is now inside the quiet window → suppress" predicate. We import
  `parseTimeOfDay` / `isWithinTimeOfDay` from `../policy/conditions.js`
  rather than duplicating that subtle logic. (The module is pure time
  math; its `policy/` home is incidental.)

- **D2 — Store the raw `{from, to, timezone}` strings; parse at notify
  time.** The persisted record and GET output carry the original strings
  (the validator returns minutes-of-day, which are an internal eval form).
  PATCH validates with `parseTimeOfDay` (reject malformed) but stores the
  request strings. The notifier re-parses per event; `Intl` construction
  per-subscription-per-event is cheap and keeps the record human-readable.

- **D3 — Fail OPEN.** Quiet-hours is suppress-only: a missed suppression
  is one extra push, never a missed prompt. PATCH validation already
  rejects malformed windows (so they never persist), but the notifier is
  defensive anyway — if `parseTimeOfDay` returns `null` at notify time it
  is treated as "no quiet hours" (send). This is the safe direction.

- **D4 — Gate placement: per-subscription, all kinds, after prefs.** The
  order in the fan-out becomes
  scope → session-lock → prefs → **quiet-hours** → working-device → send.
  Quiet-hours silences the device entirely during its window (that is the
  point of "don't wake me"), so it applies to all kinds, not only
  `permission.required`. Suppression audits
  `push_suppressed { kind, reason: 'quiet_hours', subscriptionId }` for
  "why no push" visibility, matching the working-device gate.

- **D5 — Clock injected as a `notify(event, ctx, now = new Date())`
  parameter, not a constructor field.** Mirrors the cycle-22 precedent
  `evaluate(policy, ctx, now = new Date())`. Keeps the 17 existing
  `new PushNotifier(...)` call sites and the pump untouched; quiet-hours
  tests pass a fixed `now`.

- **D6 — PATCH updates fields independently.** `PATCH
/rc/push/subscriptions/:id` now accepts `quietHours` alongside `prefs`.
  Each field is applied only when its key is **present** in the body:
  a `null` value clears it, an object/array sets it, an absent key leaves
  it unchanged. This refines the previous "absent prefs clears" behavior
  (no existing test asserted absent-clears — only `prefs: null` clears),
  so a PATCH that sets only `quietHours` no longer wipes `prefs`.
  `quietHours` present-and-not-null must be a `{from, to, timezone}`
  object that `parseTimeOfDay` accepts, else `400 invalid_quiet_hours`.

- **D7 — Audit reuse, zero enum churn.** The update reuses the existing
  `push_prefs_updated { subscriptionId }` action (quiet hours is a
  per-subscription delivery preference). Suppression reuses
  `push_suppressed` with a new free-form `reason: 'quiet_hours'`. Neither
  needs an `AuditAction` enum change.

## Reviewer notes (intended behavior, not gaps)

- Suppressing a `permission.required` push during quiet hours means
  **no buzz until the user next opens the app** — there is no digest
  catch-up this cycle (deferred). The permission simply waits
  server-side; nothing is lost, only un-pushed.
- Because `buildPayload` still only emits `permission.required`,
  quiet-hours applies to all kinds in code but is only ever exercised by
  that one kind today (same latent-until-more-kinds note as the
  working-device gate).
- The PATCH handler body is wrapped in `try/catch → 500` (the recurring
  async-route-error bug class: `setPrefs`/`setQuietHours` call
  `persist()` → `writeFile`, which rejects on EACCES/ENOSPC; `server.ts`
  has no global error middleware). The pre-existing unguarded `POST
/subscribe` is out of scope and left as-is (not made worse).

## Deferred (not this cycle)

- The digest push at end of quiet window (stateful: needs accumulation +
  a timer keyed to the window edge).
- `maxPerHour` rate limit / same-kind coalescing (stateful counter).
- Web UI for editing quiet hours (browser, verified-locally-only).
- `quiet_hours` as a distinct audit action (kept folded into
  `push_prefs_updated` / `push_suppressed`).

## Verification

`typecheck/lint/build/test --workspace @qwen-code/rc-gateway` +
`node scripts/rc-gateway-e2e.mjs`. The notifier change is pure
(injected clock), so the real-daemon e2e count is unchanged; new unit
tests cover store, notifier suppression (inside/outside/wrap-midnight),
fail-open, and the PATCH field-independence + validation.
