# Cycle 72 — Push digest web UI (`GET /rc/push/digest` consumer)

Proposal: `add-webpush`. Cycle 71 added the digest TRACKING + the OWNER read
endpoint; this is the client view of "what you missed while quiet."

## Deviation note

Gateway UI; consumes the existing OWNER `GET /rc/push/digest`. No daemon change.

## What it adds

A "Missed while quiet (digest)" `<section>`: a "Refresh digest" button →
`GET /rc/push/digest` → one row per subscription with a pending count:
`<subscriptionId>  total=<n>  (<kind>:<n>, ...)`. Empty → "(nothing missed)".

## Decisions

1. textContent/createElement only (subscriptionId is server hex; kinds are
   server enums; counts are numbers). Additive section (new ids `digest-*`),
   no existing handler touched. No src change.
2. Surface 401/403 (needs owner). Read-only (no mutation this cycle).

## Feasibility / harness

`GET /rc/push/digest` is OWNER-gated and reads the always-on notifier digest.
The `/tmp` harness is enhanced to SEED a digest entry: take the `notifier` from
`createGatewayApp`, issue a real `[SESSION_READ, APPROVE]` device token, add a
push subscription under it, set an all-day UTC quiet window on it, and drive one
`notifier.notify(permission_request, {sessionId})` — which the quiet-hours gate
suppresses and records — so `GET /rc/push/digest` returns one populated row.

## Verification

Playwright in-session (OWNER): Refresh digest → a row renders
(`<subId>  total=1  (permission.required:1)`) from the seeded suppression.
lint/build/test unchanged (no src change), e2e 45/45.

## Deferred

A clear/acknowledge action; auto-refresh; the end-of-quiet auto-push timer (the
rest of D4).
