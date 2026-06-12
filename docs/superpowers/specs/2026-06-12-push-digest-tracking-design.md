# Cycle 71 — Push digest TRACKING (`GET /rc/push/digest`), no-timer thin cut of D4

Proposal: `add-webpush`, design D4 ("suppressed-during-quiet events are
summarized in a single digest at the end of the quiet window"). The full D4 is a
stateful end-of-window TIMER that auto-pushes a digest. This cycle ships the
foundational, low-risk half: TRACK what quiet hours suppressed, per
subscription, and expose it so an owner/client can see "what you missed."

## Deviation note (the thin cut)

D4 auto-PUSHES a digest at quiet-window end (a per-subscription timer +
lifecycle + a synthetic digest payload). That timer is the genuinely-hard,
sprawl-prone part and is DEFERRED. This cycle delivers the accumulation + a
pull endpoint instead — fully additive observability with NO change to delivery
behavior and NO timer. The same per-sub counts are exactly what the auto-push
timer would later consume, so this is a clean foundation, not throwaway.

## What it adds

- `webpush/digest.ts` `PushDigest`: in-memory per-`(subscriptionId, kind)`
  counts. `record(subId, kind)` increments; `summary()` →
  `{subscriptionId, total, byKind}[]`; `forget(subId)` drops a sub (called on
  unsubscribe). Pure/total, never throws.
- Notifier: a new OPTIONAL 10th ctor arg `digest?`; on a quiet-hours
  suppression (right before the existing `return`), `this.digest?.record(r.id,
payload.kind)`. ALWAYS-ON (no opt-in needed): it only RECORDS what was already
  suppressed — zero delivery-behavior change, no fail-closed risk. A new
  `digestSummary()` method delegates to `this.digest?.summary() ?? []`.
  `forgetRateLimit` also forgets the digest.
- `GET /rc/push/digest` (OWNER, in the push router): `{digests:
DigestSummary[]}` via `notifier.digestSummary()`.
- `createGatewayApp` constructs a `PushDigest` and passes it as the notifier's
  10th arg.

## Decisions

1. Always-on tracking (vs the coalescer's opt-in): recording a count never
   suppresses a push, so the prompt-safety/fail-closed concern doesn't apply.
2. Records ONLY quiet-hours suppression this cycle (the D4 digest is
   "while you were away"); snooze/coalesced/rate-limited are NOT folded in
   (those have their own audited reasons; a digest specifically means quiet
   hours). Deferred: widening the set.
3. OWNER-gated read (counts are device/sub metadata); privacy = ids + counts +
   kind enums only (no token/endpoint/content), consistent with the audit rules.

## Fail-safe commit order

docs → `digest.ts` + unit tests INERT → notifier 10th arg + record + summary +
forget + tests (still inert: no caller passes a digest) → push route + server
construction + e2e LAST.

## Verification

- Unit: `record`/`summary`/`forget`; notifier records on a quiet-hours
  suppression (a sub in its quiet window → suppressed → `digestSummary()` shows
  the count) and NOT otherwise; no digest arg → `digestSummary()` is `[]`.
- e2e: `GET /rc/push/digest` (OWNER) → 200 `{digests:[]}` (no quiet suppression
  in the e2e); WRITE-not-OWNER → 403.

## Deferred

The end-of-quiet-window auto-PUSH timer + lifecycle + digest payload (the rest
of D4); folding snooze/coalesced/rate-limited into the digest; a web UI for the
digest (next cycle); resetting counts on read vs on next-event.
