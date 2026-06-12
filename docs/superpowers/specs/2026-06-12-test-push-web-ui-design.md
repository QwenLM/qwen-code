# Cycle 73 — Send-test-push button (`POST /rc/push/test`)

Proposal: `add-webpush`. The owner-only self-test route (`POST /rc/push/test`,
fans a synthetic `task.completed` to the caller's own subscriptions) had no UI.
This adds the button so an owner can verify push end-to-end from the console.

## Deviation note

Gateway UI; consumes the existing OWNER `POST /rc/push/test`. No daemon change.

## Route contract (read from source)

`POST /rc/push/test` (OWNER) body `{sessionId?}` → 200 `{sent: <number of the
caller's own subscriptions>}`; 403 insufficient_scope. Delivery is async/
best-effort; `sent` is the count attempted, not confirmed.

## What it adds

A "Send test push" button in the existing Push-preferences section → `POST
/rc/push/test` → renders "test push sent to N subscription(s)" (or the 403/error).

## Decisions

1. Self-contained button + a small result span (new ids `test-push-btn`/
   `test-push-result`); touches no existing handler. textContent only. No src
   change.
2. Honest label: `sent` is the count ATTEMPTED (delivery is best-effort), so the
   text says "sent to N subscription(s)" not "delivered".

## Verification

Playwright in-session (OWNER): click Send test push → "test push sent to N
subscription(s)" with a 200 (N is the caller's own sub count; 0 in the harness
since the OWNER token has no own subscription — the wiring + count render is what
is verified). lint/build/test unchanged, e2e 45/45.

## Deferred

Choosing the target session id; confirming actual delivery (needs a real push
service + a subscription under the owner token).
