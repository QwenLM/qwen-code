# Cycle 70 — Snooze-notifications web UI (`/rc/routing/snooze`)

Proposal: `add-notification-routing`. The snooze backend (`/rc/routing/snooze`
POST/GET/DELETE, OWNER) exists but had no client surface. This adds it — an
owner can snooze ALL (or one kind of) push notifications for a window.

## Deviation note

Gateway UI; consumes the existing owner-gated `/rc/routing/snooze`. No daemon
change.

## Route contract (read from source)

- `POST /rc/routing/snooze` (OWNER) body `{durationSec (>0 number), scope?:
'all'|<kind>}` → 200 `{until, scope}`; 400 `invalid_snooze`.
- `GET /rc/routing/snooze` → `{active:false}` or `{active:true, until, scope}`.
- `DELETE /rc/routing/snooze` → 204, clears.

## What it adds

A "Snooze notifications" `<section>`: a status line (current snooze, refreshed
on a Status button and after every mutation), a duration input (sec), a scope
`<select>` (all / permission.required / task.completed), a Snooze button (POST),
and an Unsnooze button (DELETE).

## Decisions

1. Status is shown via `GET` (on Status click + after each mutation); `until`
   rendered as an ISO time. textContent only.
2. Snooze guards a non-finite/<=0 duration client-side and surfaces 400
   `invalid_snooze` + 401/403.
3. Self-contained section (new ids `snooze-*`), no existing handler touched. No
   src change.

## Feasibility / harness

`/rc/routing` mounts only when `createGatewayApp` gets a `snooze` SnoozeStore
(barrel-exported `static async open`). The `/tmp` harness is enhanced: open a
SnoozeStore in a temp dir and pass it in. No product code depends on the harness.

## Verification

Playwright in-session (OWNER): Status → "no snooze active" → Snooze 3600s
scope=all → status shows "snoozed (all) until <iso>" → Unsnooze → Status → "no
snooze active". lint/build/test unchanged (no src change), e2e 45/45.

## Deferred

A live countdown; multiple simultaneous kind-scoped snoozes (the store holds one
window); quiet-hours integration UI.
