# Cycle 51 — Forget a subscription's rate-limiter window on unsubscribe

Proposal: `add-webpush-notifications`. Closes the explicitly-deferred
remainder noted since cycle 46: `PushRateLimiter.forget(subId)` exists
(its doc-comment literally says "e.g. on unsubscribe") but nothing calls
it, so a deleted subscription's rolling-hour window lingers in the
in-memory `subs` Map for the process lifetime. As subscriptions churn
(subscribe → delete → re-subscribe with a fresh id) the Map grows
unbounded — a slow memory leak on a long-lived gateway.

## What changes

`DELETE /rc/push/subscriptions/:id` now forgets the subscription's
rate-limiter window after removing it from the store.

The rate limiter is private to `PushNotifier` (8th ctor arg), and the
DELETE route already holds the `notifier` — so the cleanest seam is a
delegating method on the notifier rather than threading the limiter into
the push router separately:

- `PushNotifier.forgetRateLimit(subId)` → `this.rateLimiter?.forget(subId)`.
  A no-op when no limiter is configured (the limiter is only built
  alongside vapid+pushStore).

## Decisions

1. **Delegate through the notifier, don't re-plumb the limiter.** The
   route's dependency surface is unchanged (`createPushRouter` signature
   untouched); the notifier already owns the limiter's lifecycle.
2. **No security surface.** The rate limiter is the FAIL-OPEN _comfort_
   throttle (a glitch must never suppress a push); the _security_ quota
   is the separate persisted `QuotaStore`. So even if subscription ids
   were reused, a churn attacker resetting their own comfort counter via
   delete+resubscribe gains nothing — they were never throttled for a
   security reason here. forget-on-delete is pure cleanup.
3. **No new audit action.** Deleting already audits `push_unsubscribed`;
   forgetting the counter is an internal memory-hygiene side effect, not
   a distinct event.
4. **Fail-safe order:** the delegating method lands INERT first (nothing
   calls it → behavior-identical), the DELETE-route call lands last.

## Verification honesty

The forget effect is internal (frees a Map entry) and NOT externally
observable through the API — DELETE still returns 204 either way. So the
e2e is unchanged; verification is the unit tests: (a) the notifier
delegates to the limiter (and is a safe no-op without one), and (b) the
DELETE route invokes `forgetRateLimit` with the removed id. The existing
`PushRateLimiter.forget` unit test already covers the Map deletion.

## Deferred

- A `maxPerHour`/quiet-hours/digest WEB UI (browser, verified-locally-
  only); end-of-quiet-window DIGEST + same-kind COALESCING (stateful
  timers) — all unchanged from the add-webpush deferred list.
