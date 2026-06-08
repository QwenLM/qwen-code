# Remote-Control Gateway — Notification Routing Part 3: Working-Device Suppression (Design)

**Date:** 2026-06-08
**Status:** Proposed (cycle 17)
**Scope:** Don't push-notify a device that's actively being used — suppress a
`permission.required` push to a subscription whose owning token has posted to the
gateway within a recent window. Proposal's working-device detection / story R1.
Builds on cycles 6 (vote), 7 (prompt), 9 (notifier), 15 (snooze).

## Deviation / important interpretation

The proposal is internally inconsistent here:

- Its **mechanical definition** ("What Changes"): _a subscription is "working" if
  **its owning token** posted in the last `workingDeviceWindowSec`; routes with
  `suppressIfWorkingDevice` skip **those** subscriptions; other devices still
  receive the push._
- Its **R1 narrative**: the laptop is active → the **phone** (a different device)
  goes quiet.

These only agree if "laptop" and "phone" share one token. Our model binds each
subscription to a `tokenId` and has **no person↔devices linkage**, so we implement
the precise **mechanical** definition: **suppress a push to a subscription whose own
token is currently working.** This delivers the real value (no redundant ping to a
device you're actively using — e.g. the phone PWA you're typing in) without
inventing an identity model. Cross-device suppression (R1's laptop→phone) is noted
as a known limitation; it can return if/when a person/account concept exists.

## This cycle's scope

**In:** an in-memory `WorkingDeviceTracker`; activity recording on the
authenticated session POST routes (prompt, permission vote); the notifier suppresses
`permission.required` pushes to a working subscription (audited
`push_suppressed{reason:'working_device'}`), default-on. Window default 120s.

**Deferred:** the `suppressIfWorkingDevice` per-rule flag (needs the `routing.yaml`
file — later); applying it to other kinds; cross-device/person linkage; the
`routing_decision` SSE frame.

## Decisions

1. **Working = the subscription's own token posted within `windowMs` (default
   120000).** Ephemeral, in-memory (process-local) — activity has no value across
   restarts, so no persistence.
2. **Recorded on authenticated session POSTs** that represent a human acting:
   the prompt route (`POST /rc/session/:id/prompt`) and the permission vote route
   (`POST /rc/session/:id/permission/:requestId`). Implemented as a tiny
   `recordActivity(tracker)` middleware mounted before those handlers; it touches
   `req.rcClient.id` and calls `next()`.
3. **Suppression applies to `permission.required` only** (the "you're already here,
   no need to ping" case). `task.completed` and other kinds are unaffected (you may
   still want completion pings). Default-on (no rule file needed yet).
4. **Audited** as the existing `push_suppressed` action with
   `detail:{kind, reason:'working_device', subscriptionId}` — no new audit action.
5. **Order in the notifier fan-out:** event-global snooze (cycle 15) → per-sub scope
   (cycle 9) → per-sub prefs (cycle 16) → **per-sub working-device (this cycle)** →
   send. Each per-sub skip is silent except working-device, which audits (so R6
   "see why no push fired" is partially served via the audit feed).

## Components

### `WorkingDeviceTracker` (`src/routing/workingDevice.ts`) — new

```ts
export class WorkingDeviceTracker {
  constructor(windowMs?: number, nowFn?: () => number); // window default 120_000
  touch(tokenId: string): void; // record activity now
  isWorking(tokenId: string): boolean; // now - last(tokenId) < windowMs
}
```

- In-memory `Map<tokenId, lastMs>`. `isWorking` → a token never seen → false.
  (Optional cheap GC: prune entries older than the window on touch; not required.)

### Activity middleware (`src/routing/workingDevice.ts` or `src/auth.ts`)

```ts
export function recordActivity(tracker: WorkingDeviceTracker): RequestHandler;
```

`(req,_res,next) => { if (req.rcClient?.id) tracker.touch(req.rcClient.id); next(); }`

### Notifier (`src/webpush/notifier.ts`)

- Add optional `workingDevice?: WorkingDeviceTracker` to the ctor.
- In the fan-out, after the prefs check and before `sender.send`:
  `if (payload.kind === 'permission.required' && this.workingDevice?.isWorking(
record.tokenId)) { void this.audit?.record({action:'push_suppressed',
target:ctx.sessionId, detail:{kind:payload.kind, reason:'working_device',
subscriptionId:record.id}}); return; }`

### Wiring (`src/server.ts`)

- Build one `const workingDevice = new WorkingDeviceTracker();` inside
  `createGatewayApp`. Pass it into the `PushNotifier` (new arg). Mount
  `recordActivity(workingDevice)` immediately before the prompt route handler and
  the permission route handler (after their `requireScope`, so only authenticated
  callers touch — `req.rcClient` is set by then).
- No `GatewayDeps` change needed (tracker is internal/process-local). Tests can
  reach it indirectly via the notifier + a fake tracker, or construct a notifier
  with an injected tracker.

## Testing strategy (TDD)

**`workingDevice.test.ts`:** unknown token → not working; `touch` → working;
after the window (advance `nowFn`) → not working; a second `touch` re-arms it.

**middleware test** (in workingDevice.test or routes): `recordActivity(tracker)`
with a req carrying `rcClient.id` → `tracker.isWorking(id)` true after; no
`rcClient` → no throw, nothing recorded.

**`notifier.test.ts` (extend):** a `permission.required` event; sub whose token
`isWorking` (use a real/fake tracker touched for that token) → NOT sent + audit
`push_suppressed{reason:'working_device'}`; a non-working token → sent; a
`task.completed` event with a working token → still sent (suppression is
permission.required-only).

**`server.test.ts` (extend):** mint a `write`+`approve` token, `POST
/rc/session/s1/prompt` → 200 (proves the activity middleware is wired and doesn't
break the route). (Asserting tracker state through HTTP is indirect; the unit +
notifier tests cover the suppression logic.)

**e2e:** unchanged (push delivery is verified-locally-only); optionally confirm a
prompt POST still 200s with the middleware in place — already covered.

## File boundary

All within `packages/rc-gateway/`. New: `src/routing/workingDevice.ts` (+test).
Modified: `src/webpush/notifier.ts` (+test), `src/server.ts` (build+wire+
middleware), `src/server.test.ts`. (No new audit action; reuses `push_suppressed`.)
Zero upstream edits.

## Follow-on

Later notification-routing cycles: mention patterns (glob match on tool args →
synthetic `mention` push); the `routing.yaml` rule file + evaluator (mirroring the
policy loader) which makes `suppressIfWorkingDevice` and route-targeting
operator-configurable instead of hardcoded defaults; the `routing_decision` SSE
frame + viewer "why no push" surface; `qwen rc snooze/routing` CLI. Then the next
proposal: `add-link-share`.
