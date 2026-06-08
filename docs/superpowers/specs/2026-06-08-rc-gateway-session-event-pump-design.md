# Remote-Control Gateway — Session Event Pump (Design)

**Date:** 2026-06-08
**Status:** Proposed (cycle 10)
**Scope:** The gateway's own persistent subscription to the daemon's session
events, which auto-triggers the cycle-9 push notifier — so notifications fire even
when **no browser tab is open**. This is the piece that makes WebPush actually
useful. **Part 2b of `add-webpush-notifications`** (proposal Phase 2.0/2.2 trigger
wiring). Builds on cycles 8–9.

## Why this is the load-bearing piece

The gateway only relays SSE while a browser is connected to
`/rc/session/:id/events`. Push exists precisely for when the user is _away_ — no
tab open — so the gateway must hold its **own** daemon subscriptions, independent
of any browser client. The daemon's event API is per-session
(`subscribeEvents(sessionId)`), so the pump must also discover which sessions exist
(`listWorkspaceSessions(caps.workspaceCwd)`) and keep a subscription alive per
session.

## Deviation note

Proposal puts the trigger in the daemon's event bus. We instead consume the
daemon's public SSE as an external SDK client. Same outcome (events → push),
zero upstream edits.

## Decisions

1. **Discovery via capabilities + workspace session list.** On start, `await
daemon.capabilities()` → `workspaceCwd`. If absent/empty, the pump logs once and
   idles (retries on the poll tick) — it never crashes the gateway.
2. **Poll for the session set; one subscription loop per session.** Every
   `pollMs` (default 5000) the pump calls `listWorkspaceSessions(workspaceCwd)` and
   reconciles: start a loop for newly-seen sessions, drop (abort) loops for sessions
   no longer listed.
3. **Per-session loop = `for await (event of subscribeEvents(id, {signal,
lastEventId}))` → `notifier.notify(event, {sessionId, sessionName})`.** Track the
   last `event.id` to resume on reconnect. When the generator ends or throws (daemon
   dropped the stream, session ended) and the pump is still running and the session
   is still listed, reconnect after a short backoff (default 1000ms, capped). The
   reconcile tick is the safety net that also restarts a loop that exited.
4. **Best-effort, never throws into the gateway.** All pump errors are caught and
   logged; `notifier.notify` already never throws. A daemon outage degrades to "no
   pushes" and self-heals on reconnect — it must never take down the HTTP server.
5. **Lifecycle owned by the CLI.** `createGatewayApp` is refactored to **return
   `{ app, notifier }`** (notifier present only when both push stores are supplied).
   `runServe` builds a `SessionEventPump(daemon, notifier)` and `start()`s it after
   the server is listening; stops it on SIGINT/SIGTERM. Tests construct/start the
   pump directly against the stub daemon.

## Components

### `SessionEventPump` (`src/webpush/pump.ts`) — new

```ts
export interface SessionEventPumpOptions {
  pollMs?: number; // default 5000
  reconnectMs?: number; // default 1000
  /** Map a session summary to a display name for payloads. */
  sessionName?: (s: DaemonSessionSummary) => string | undefined;
  /** Injectable for tests so we don't wait real time. */
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  sleep?: (ms: number) => Promise<void>;
  /** Test hook: called after each event is dispatched to the notifier. */
  onDispatch?: (sessionId: string, event: DaemonEvent) => void;
}
export class SessionEventPump {
  constructor(
    daemon: DaemonClient,
    notifier: PushNotifier,
    opts?: SessionEventPumpOptions,
  );
  start(): Promise<void>; // resolves once the first reconcile has run
  stop(): Promise<void>; // aborts all loops + stops polling
}
```

- Holds a `Map<sessionId, { ctrl: AbortController; lastEventId?: number }>`.
- `start()`: resolve `workspaceCwd` from capabilities (catch → log, leave empty);
  run one immediate `reconcile()`; then schedule `reconcile()` on `pollMs`.
- `reconcile()`: `listWorkspaceSessions(cwd)` (catch → log, return — try again next
  tick). For each listed session not already tracked, `spawnLoop(session)`. For each
  tracked session not in the list, `ctrl.abort()` + delete.
- `spawnLoop(session)`: create an AbortController; run an async loop:
  `for await (const ev of daemon.subscribeEvents(id, { signal: ctrl.signal,
lastEventId }))` → if `ev.id` set, update `lastEventId`; `await
notifier.notify({ type: ev.type, data: ev.data }, { sessionId: id, sessionName });`
  `onDispatch?.(id, ev)`. On loop exit/throw: if not aborted and pump still running,
  `await sleep(reconnectMs)` then the next reconcile (or an internal re-spawn) will
  restart it. Catch AbortError silently. **Never rethrow.**
- `stop()`: set a stopped flag, clear the interval, abort every tracked controller,
  clear the map.

### Stub daemon extensions (`src/testing/stubDaemon.ts`)

Add (additive, default-safe):

- `GET /capabilities` → `{ v:1, mode, features:[], modelServices:[], workspaceCwd }`
  where `workspaceCwd` is a new option (default `'/stub/workspace'`).
- `GET /workspace/:cwd/sessions` → `{ sessions }` from a new option
  `sessions?: DaemonSessionSummary[]` (default `[]`). (`:cwd` is URL-encoded by the
  SDK; just echo configured sessions regardless of the param.)
- Existing `/session/:id/events` already emits configurable frames — reused as the
  per-session stream the pump consumes.

### Server refactor (`src/server.ts`)

- `createGatewayApp(deps)` now returns `{ app: Express; notifier?: PushNotifier }`.
  Internals unchanged except it returns the object; when push stores are present it
  builds `sender`+`notifier` (as today) and includes `notifier` in the return.
- Update the two call sites: `src/cli.ts` and `src/server.test.ts`'s `boot()` →
  `const { app, notifier } = createGatewayApp(...)`. boot() returns `notifier` too
  (handy for future tests). All existing assertions keep working (they used `app`).

### CLI (`src/cli.ts`)

After `app.listen(...)` succeeds, if `notifier` exists: `const pump = new
SessionEventPump(handle.daemon, notifier); await pump.start();` and add `await
pump.stop()` to the `shutdown` handler before `handle.stop()`. Add a banner line
`push pump: watching <workspaceCwd or 'workspace'>`.

## Testing strategy (TDD)

**`pump.test.ts`** (real `DaemonClient` → `startStubDaemon`, fake notifier =
`{ notify: vi.fn().mochaesque collector }`, tiny `pollMs`, no-op `sleep`):

- stub configured with `sessions:[{sessionId:'s1',workspaceCwd:'/w'}]`,
  `workspaceCwd:'/w'`, and frames including a `permission_request` → after
  `start()`, await until the fake notifier received a `permission_request` for s1
  (poll/`onDispatch`); assert ctx.sessionId==='s1'. Then `stop()`.
- a session present then removed from the list on a later tick → its loop is
  aborted (assert no further dispatches after removal; assert the controller was
  aborted via `onDispatch` quiescence).
- capabilities throwing (stub `capabilitiesStatus:500`) → `start()` still resolves,
  no crash, zero dispatches.
- `listWorkspaceSessions` empty → no loops, no dispatch, clean `stop()`.
- `stop()` aborts loops: after stop, even if the stub would emit more, no
  dispatches; `start()` then `stop()` leaves no open handles (test completes).

**`server.test.ts`**: update `boot()` destructuring; add an assertion that
`createGatewayApp` returns a `notifier` when stores are supplied and `undefined`
when not.

**Manual e2e (`scripts/rc-gateway-e2e.mjs`):** the gateway already boots a real
daemon; add a check that the pump starts without error against the real daemon
(capabilities + empty/ën session list resolve; no exception). Since no live model
turn is driven, no event is asserted — this only proves the pump wires up and
tolerates a real daemon. (Auto-push delivery remains verified-locally-only.)

## File boundary

All within `packages/rc-gateway/` (+ e2e script). New: `src/webpush/pump.ts`
(+ `pump.test.ts`). Modified: `src/testing/stubDaemon.ts` (capabilities + sessions),
`src/server.ts` (return shape), `src/cli.ts` (start/stop pump + banner),
`src/index.ts` (export `SessionEventPump`), `src/server.test.ts`,
`scripts/rc-gateway-e2e.mjs`.

## Follow-on

Cycle 11: service worker (`public/sw.js`) push + notificationclick (approve/deny via
the cycle-6 vote route) + web-client "Enable notifications" enrollment — completes
`add-webpush-notifications` (modulo prefs/quiet-hours, deferred). Then the next
proposal per the backlog: `add-policy-engine` (gateway auto-votes permission
requests it sees on these same pumped events).
