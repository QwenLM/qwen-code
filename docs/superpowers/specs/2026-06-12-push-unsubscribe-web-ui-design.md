# Cycle 59 — Push-subscription unsubscribe from the prefs UI

Proposal: `add-webpush`. Cycle 58 deferred "unsubscribe-from-this-UI". The
`DELETE /rc/push/subscriptions/:id` route already exists (OWNER can delete
any subscription; cycle 51 also frees its rate-limit window). This adds the
per-row control.

## Deviation note

Gateway-side UI cycle; consumes the existing OWNER route. No daemon change.

## What it adds

A per-row "Unsubscribe" button in the cycle-58 `subRow` (Push preferences
section). Click -> `DELETE /rc/push/subscriptions/:id`. 204 -> the row is
replaced with "unsubscribed: <id>" (the row's detached inputs/buttons are
discarded, mirroring cycle-56 token revoke). 404 -> "already gone". Other
status -> surfaced. An OWNER pruning a stale/compromised device subscription
is a real admin action (owner scope bypasses the route's ownership check).

## Decisions

1. Mirror cycle-56 `revokeToken` exactly: `btn.disabled = true` synchronously
   before the await (blocks double-submit), `row.textContent = ...` on success
   (destroys the detached buttons -> no dangling handler), re-enable on error.
2. The button passes the whole `row` element so success can collapse it
   in place without a re-list.
3. textContent-only (the id is server hex). Additive to `subRow`; touches no
   other handler.

## Verification

Playwright in-session against the cycle-58 harness (seeded sub): List -> click
Unsubscribe -> row shows "unsubscribed: <id>" (DELETE 204) -> re-List shows
"(no subscriptions)". lint/build/test unchanged (no src change), e2e 45/45.

## Deferred

A confirm prompt; bulk unsubscribe; the prefs kind-allowlist editor (next
cycle).
