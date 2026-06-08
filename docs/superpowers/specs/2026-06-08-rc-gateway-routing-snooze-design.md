# Remote-Control Gateway — Notification Routing Part 1: Snooze (Design)

**Date:** 2026-06-08
**Status:** Proposed (cycle 15)
**Scope:** A persisted global **snooze** that suppresses push notifications for a
duration (optionally per-kind), with owner-gated routes — proposal story R5. The
first slice of `add-notification-routing`. Builds on the cycle-9 notifier.

## Deviation / context

Proposal puts the routing decision layer in the daemon between the event bus and
`pushSender`. We deviate: our routing gate sits in the gateway's `PushNotifier`
(cycle 9), which already owns the push fan-out fed by the cycle-10 pump. Zero
upstream edits.

Note on the proposal's defaults: R2 ("policy-auto-allows produce no push") is
**already satisfied** in our architecture — the cycle-14 enforcer marks auto-handled
permission events and the pump suppresses their push. So this proposal's value for
us is the _operator-controlled_ routing: snooze (this cycle), per-subscription
preferences (cycle 16), working-device suppression (17), mentions + a routing rule
file + the `routing_decision` SSE frame (later).

## This cycle's scope

**In:** a persisted `SnoozeStore`; the notifier consults it and suppresses (with a
`push_suppressed` audit) when snoozed; owner-gated `POST/GET/DELETE
/rc/routing/snooze`; audit actions `push_suppressed`, `routing_snoozed`,
`routing_unsnoozed`.

**Deferred:** per-subscription prefs (cycle 16); working-device detection (17);
mention patterns + the `routing.yaml` rule file + `routing_decision` SSE +
`qwen rc snooze/routing` CLI + web UI (later). Snooze applies globally (all
subscriptions) — per-subscription routing rules come later.

## Decisions

1. **Snooze is global, optionally scoped to a single `kind`.** `scope: 'all'`
   (default) suppresses every push; `scope: '<kind>'` (e.g. `permission.required`)
   suppresses only that kind. Auto-expires at `until`.
2. **Persisted** at `~/.qwen/rc/snooze.state` (JSON, mode 0600) so it survives a
   daemon/gateway restart (R5). Loaded on `open()`.
3. **Suppression is checked once per `notify()` call** (snooze is event-global, not
   per-subscription), BEFORE the fan-out — so a snoozed event costs no sends. The
   `/rc/push/test` path (`notifyToken`) is **not** gated by snooze (an explicit
   operator test should always fire).
4. **Expired snooze is treated as inactive** (and lazily cleared) — suppressed
   events are NOT replayed when snooze ends (they remain in the SSE stream / audit
   for in-app review, per R5). No "snooze ended" event this cycle (deferred with
   the `routing_decision` SSE frame).
5. **Owner-only.** Snooze is an operator control: routes gated by `requireScope(
OWNER)`.

## Components

### `SnoozeStore` (`src/routing/snooze.ts`) — new

```ts
export interface SnoozeState {
  until: number;
  scope: string;
} // scope 'all' | '<kind>'
export class SnoozeStore {
  static open(filePath: string, nowFn?: () => number): Promise<SnoozeStore>;
  snooze(durationSec: number, scope: string): Promise<SnoozeState>; // sets until = now + durationSec*1000
  clear(): Promise<void>;
  /** Current state if active (now < until), else null (lazily clears expired). */
  active(): SnoozeState | null;
  /** True if a push of `kind` is currently suppressed. */
  isSnoozed(kind: string): boolean;
}
```

- `open()` reads the file (absent/corrupt → no snooze). `snooze()` writes `{until:
now()+durationSec*1000, scope}` (await persist, mode 0600). `clear()` deletes the
  state (await persist / unlink-or-empty). `active()`/`isSnoozed()` compare against
  `nowFn()`; if expired, clear in-memory (best-effort).
- `isSnoozed(kind)`: `const s = active(); if (!s) return false; return s.scope ===
'all' || s.scope === kind;`

### Notifier integration (`src/webpush/notifier.ts`)

- Add optional `snooze?: SnoozeStore` and `audit?: AuditRecorder` to the
  constructor (after the existing args, back-compat).
- In `notify(event, ctx)`: after `buildPayload` (kind known), BEFORE the fan-out:
  `if (this.snooze?.isSnoozed(payload.kind)) { void this.audit?.record({ action:
'push_suppressed', target: ctx.sessionId, detail: { kind: payload.kind, reason:
'snoozed' } }); return; }`
- `notifyToken` (the `/test` path) is unchanged (not snooze-gated).

### Routing routes (`src/routes/routing.ts`) — new

`createRoutingRouter(snooze: SnoozeStore, audit?: AuditRecorder): Router`, mounted
at `/rc/routing` under `requireScope(OWNER)`:

- `POST /snooze` body `{ durationSec: number, scope?: string }`: validate
  `durationSec` is a finite number > 0 (else `400 invalid_snooze`); `scope` default
  `'all'`; `await snooze.snooze(durationSec, scope)`; audit `routing_snoozed {scope,
durationSec}`; `200 { until, scope }`.
- `GET /snooze` → `200 { active: boolean, until?, scope? }` from `active()`.
- `DELETE /snooze` → `await snooze.clear()`; audit `routing_unsnoozed`; `204`.

### Audit (`src/auditLog.ts`)

Add `'push_suppressed'`, `'routing_snoozed'`, `'routing_unsnoozed'` to the union +
`AUDIT_ACTIONS`.

### Wiring (`src/server.ts`, `src/cli.ts`)

- `GatewayDeps` gains optional `snooze?: SnoozeStore`. When `deps.snooze` present
  (and push stores present), pass it + the audit into the `PushNotifier`, and mount
  `createRoutingRouter(deps.snooze, audit)` at `/rc/routing` under
  `requireScope(OWNER)`.
- `cli.ts`: `const snooze = await SnoozeStore.open(join(homedir(),'.qwen','rc',
'snooze.state'));` pass into `createGatewayApp` deps. Banner: optional, skip.
- `server.test.ts` `boot()`: open a temp SnoozeStore and pass it.

## Testing strategy (TDD)

**`snooze.test.ts`:** snooze(60,'all') → isSnoozed('x') true; expires (nowFn
advances past until) → false; scope 'permission.required' → isSnoozed('task.
completed') false, isSnoozed('permission.required') true; clear() → inactive;
persistence (reopen reflects an active snooze; reopen after expiry → inactive).

**`routing.test.ts`** (mini app, injected owner `req.rcClient`): POST /snooze
{durationSec:60} → 200 {until,scope:'all'} + audit routing_snoozed; GET → active:true;
DELETE → 204 + audit routing_unsnoozed; GET → active:false; POST {durationSec:0}/
missing → 400.

**`notifier.test.ts` (extend):** with a SnoozeStore snoozed for 'all', `notify` a
permission_request → sender NOT called, audit push_suppressed{reason:'snoozed'};
snoozed for a different kind → still sends.

**`server.test.ts`:** owner token → POST /rc/routing/snooze → 200; GET → active;
non-owner → 403.

**e2e:** with the boot owner token, POST /rc/routing/snooze {durationSec:1} → 200;
GET active; DELETE → 204. (Pure gateway.)

## File boundary

All within `packages/rc-gateway/`. New: `src/routing/snooze.ts` (+test),
`src/routes/routing.ts` (+test). Modified: `src/webpush/notifier.ts` (+test),
`src/auditLog.ts` (3 actions), `src/server.ts` (deps+wire), `src/cli.ts` (open
store), `src/index.ts` (exports), `src/server.test.ts`, `scripts/rc-gateway-e2e.mjs`.
Zero upstream edits.

## Follow-on

Cycle 16: per-subscription preferences (`prefs: string[]` on the subscription
record + `PATCH /rc/push/subscriptions/:id`; notifier filters per-sub). Cycle 17:
working-device detection (track per-token POST activity; `suppressIfWorkingDevice`).
Later: mention patterns, the `routing.yaml` rule file + evaluator (mirroring the
policy loader), the `routing_decision` SSE frame + viewer surface, CLI.
