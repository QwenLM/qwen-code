# Cycle 74 — Gateway status web UI (`GET /rc/health`)

Proposal: `add-remote-control` (core). The `/ui` had no at-a-glance liveness
check. This adds a small status panel — useful for a phone client to confirm
the gateway is reachable and whether this device is paired.

## Deviation note

Gateway UI; consumes the existing unauthenticated `GET /rc/health`. No daemon
change.

## Route contract (read from source)

`GET /rc/health` (no auth) → `{status:'ok'}`.

## What it adds

A "Gateway status" `<section>` at the top-relevant area: a "Check status" button
→ `GET /rc/health` → renders "gateway: ok" (or "unreachable" on a network
error / non-200) plus a paired/not-paired indicator derived from
`localStorage` (presence of the bearer token — NOT its value).

## Decisions

1. Health is unauthenticated → the check works even before pairing (the point:
   confirm reachability first). The paired indicator only reports presence, NEVER
   renders the token. textContent only.
2. Self-contained section (new ids `status-*`), no existing handler touched. No
   src change.

## Verification

Playwright in-session: Check status → "gateway: ok · not paired" before pairing
and "gateway: ok · paired" after; a network failure path renders "unreachable"
(not separately driven). lint/build/test unchanged, e2e 45/45.

## Deferred

Auto-poll/heartbeat; showing daemon capabilities/workspace; latency; a
connection-lost banner.
