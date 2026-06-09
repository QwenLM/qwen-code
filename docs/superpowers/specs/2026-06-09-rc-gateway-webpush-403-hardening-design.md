# Design — rc-gateway webpush 403/401 send-failure hardening (cycle 24)

**Proposal:** hardening follow-up to `add-webpush-notifications` cycle 9
(recorded in [[qwen-rc-full-backlog-goal]] #3 and
[[qwen-rc-gateway-architecture]] cycle 9 as a KNOWN MINOR FOLLOW-UP).
**Date:** 2026-06-09.
**Branch:** `add-remote-control-spec`.

## The bug

`PushSender.send` (`src/webpush/sender.ts`) currently classifies HTTP **403**
as a _permanent / dead-subscription_ status — same bucket as 404/410 — and
**removes the subscription** from the store:

```ts
function isPermanent(code) {
  return code === 404 || code === 410 || code === 403;
}
```

But 403 (and 401) from a Web Push service is an **auth/config** rejection, not
a dead endpoint: a bad VAPID JWT signature, a wrong `subject`, or an
application-server-key mismatch. That condition is **identical across every
subscription** — so a single VAPID misconfiguration makes the very next push
fan-out return 403 for all of them and **silently wipe the entire push-store**.
The keys are fine; the operator just mis-set VAPID, but every device is now
unsubscribed and must re-enroll by hand. The privkey footgun is real: VAPID
keys never rotate silently (cycle 8), but a hand-edited `subject`/`audience`
can flip every push to 403 in one go.

## Decision — three distinct status branches

Per attempt, classify into exactly one of three buckets:

1. **`404` / `410` — Gone.** The endpoint is dead. `store.remove(id)` +
   `push_subscription_expired`, stop. (Unchanged.)
2. **`401` / `403` — Auth/config error.** KEEP the subscription. **Fail fast:**
   emit a single `push_send_failed` with `reason: 'auth_error'` and the
   `statusCode`, then stop — **no retry** (the config won't change across the
   ~31s of a 5-attempt backoff; retrying just delays the inevitable). The sub
   survives the operator's misconfig and works again once VAPID is fixed.
3. **`429` / `5xx` / network-throw (mapped to code `0`) — Transient.** Retry per
   the backoff schedule (max 5 attempts); after the last attempt emit
   `push_send_failed` with `reason: 'transient_exhausted'` + `statusCode`, keep
   the subscription. (Behavior unchanged; the `reason` field is new.)

`is2xx` → `push_sent`, stop (unchanged).

### Why reuse `push_send_failed` (not a new audit action)

The auth-error case is a _send failure that kept the sub_ — exactly what
`push_send_failed` already means. A new `reason` discriminator
(`'auth_error'` vs `'transient_exhausted'`) gives operators the diagnostic they
need (a burst of `push_send_failed{reason:'auth_error'}` across many subs in one
fan-out ⇒ "check your VAPID config") **without** adding to the `AUDIT_ACTIONS`
enum or the route validator. No new action; the detail already carries
`statusCode`.

### Out of scope (deliberately unchanged)

- **`400` Bad Request** stays in the transient bucket (retried, kept). It's
  neither auth nor a dead endpoint; reclassifying it is a separate judgment
  call and not the recorded footgun. Noted here so the reviewer doesn't read
  the omission as an oversight.
- No change to the notifier fan-out, scope/snooze/prefs/working-device gates,
  payload privacy, or any route. This cycle touches `sender.ts` status
  branching only.

## Files

- `src/webpush/sender.ts` — replace `isPermanent` with `isGone(404|410)` +
  `isAuthError(401|403)`; restructure the per-attempt branching; add the
  `reason` field to both `push_send_failed` sites; update the class doc block.
- `src/webpush/sender.test.ts` — add: `403 → keep + push_send_failed{reason:
'auth_error'} + single transport call (no retry)`; `401 → same`; assert the
  existing persistent-503 path now carries `reason:'transient_exhausted'`. Keep
  the 410-removes test (proves the Gone path is untouched).

## Verification

- `npm run typecheck|lint|build|test --workspace @qwen-code/rc-gateway`.
- `node scripts/rc-gateway-e2e.mjs` — unchanged (no route/wire surface; the
  sender is exercised only via the fake transport in unit tests). Must stay
  39/39.
- `git diff --name-only <start>..HEAD` → only the two `sender*` files + docs.

## Deferred

- Per-subscription consecutive-auth-failure quarantine / backoff (a sub that
  401s for N fan-outs running could be flagged) — not needed for the footgun.
- `400` reclassification (see Out of scope).
