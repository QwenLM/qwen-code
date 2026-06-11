# Cycle 49 — Owner event stream `GET /rc/events` (Phase-4 broadcast surface)

**Proposal:** `add-policy-engine` Phase 4 (a gateway-level owner-broadcast SSE
surface for `policy_decision` + `policy_load_error` frames — design.md
"emit `policy_decision`" rows + the cycle-45 deferral note: _no gateway-level
non-session SSE surface existed_). This cycle BUILDS that missing surface.

**Status:** heavy frontier — the first owner-level (non-session) broadcast
surface. Single-cycle thin slice: the surface + ONE producer (the audit log),
deferring per-frame schemas and the web UI.

## The core insight (and the deviation)

The enforcer + reloader already `audit.record(...)` every `policy_decision`,
`policy_reloaded`, and `policy_reload_failed`, using the SAME `AuditLog` instance
`createGatewayApp` builds and returns (cli.ts passes it to `new PolicyEnforcer`).
So instead of threading a broadcaster into the hot permission path, we make the
**audit log itself the event producer**: every durably-appended audit record is
ALSO fanned out to an in-memory bus, and a new OWNER-scoped SSE endpoint streams
those records live.

**Deviation from the design:** the streamed frame **IS the audit record**
(`{ts, action, actorTokenId?, target?, detail?}`), not a bespoke
`policy_decision` schema. Because `policy_decision` is already audited with
`{requestId, action, ruleId?, voted, decisionSource, quotaRemaining?}`, the owner
gets exactly the design's intended payload (incl. `quotaRemaining`) through the
audit channel — plus every other security event for free (a live audit feed).

## What this delivers vs. defers (be precise)

- `policy_decision` frame — **MET** via the audit record (carries
  `quotaRemaining` when a quota rule consumed).
- `policy_load_error` frame — **PARTIALLY MET**: the _reload-path_ failure
  (`policy_reload_failed`, cycle 45) streams live. The _boot-time_ malformed-user-
  policy case CANNOT stream — it THROWS and fails boot (cycle 14) before any SSE
  client exists, so it is N/A, not covered.
- A bespoke per-frame schema / `routing_decision` / web UI / `Last-Event-ID`
  replay — **DEFERRED**.

## Decisions

1. **Audit log is the producer via an optional `onRecord` sink.** `AuditLog`'s
   ctor `opts` gains `onRecord?(record: AuditRecord)`, invoked inside `doRecord`
   ONLY after a successful `appendFile` (so the stream reflects durably-recorded
   events), wrapped in its own try/catch so a throwing sink can never break the
   never-throws contract. `ts` is captured ONCE (one `nowFn()` call) and reused
   for both the written line and the sink payload. Optional → every existing
   `new AuditLog(...)` is behavior-identical.

2. **`OwnerEventBus` is a synchronous in-memory pub/sub, internal to
   `createGatewayApp`** (NOT added to the `GatewayApp` return — nothing external
   needs it; the enforcer uses the audit instance, not the bus). `publish` fans
   out synchronously with a per-handler try/catch (it runs inside the audit
   `writeChain` — it must not stall or reject). `subscribe` enforces a hard cap
   (`MAX_OWNER_SUBSCRIBERS = 32`, defense-in-depth atop the OWNER gate) and
   returns `null` at capacity.

3. **Backpressure: drop, never buffer unboundedly.** `auth_failed` is audited and
   **externally triggerable** (any unauthenticated scanner). A wedged owner socket
   (laptop slept) would make `res.write()` buffer in Node memory until TCP
   timeout — externally-driven memory amplification. So on `res.write() === false`
   the subscriber sets a `dropping` flag and SKIPS frames until `'drain'`, then
   emits one `event: resync {dropped}` marker so the client knows to re-query
   `/rc/audit` for the complete record. A live convenience feed may drop; the
   durable record is always in the audit log. (Same lesson as cycle-46: don't let
   a storm amplify.)

4. **OWNER scope, no attach/detach audit.** `/rc/events` is OWNER-gated (it streams
   ALL audit events incl. token/scope rows — owner-only). The stream itself is NOT
   audited (no `owner_events_attached` action) — it would add enum churn and emit
   a self-referential frame; the owner connecting is low-value to record. At
   capacity → 503 `too_many_streams` (sent BEFORE `writeHead`, so it's a clean
   JSON error, not a half-open stream).

5. **Heartbeat + GET-close cleanup.** A 25 s `: ping` comment keeps proxies alive
   and surfaces a dead socket; the interval is `unref`'d and `clearInterval`'d on
   `req.on('close')` (correct for a GET SSE, per `sessionEvents.ts` — the cycle-7
   `res.on('close')` gotcha was POST-specific). Close also unsubscribes.

## Endpoint

```
GET /rc/events        (OWNER scope)
  200 text/event-stream
      : ok                                 (stream opener)
      data: {ts, action, actorTokenId?, target?, detail?}   (one per audit record)
      event: resync\ndata: {dropped}       (after a backpressure drop recovers)
      : ping                               (every 25s)
  503 { code: 'too_many_streams' }         (>= MAX_OWNER_SUBSCRIBERS)
```

## Deferred (explicit)

- Bespoke `policy_decision` / `routing_decision` frame schemas (the audit record
  IS the frame this slice).
- The boot-time `policy_load_error` case (throws before any client; N/A).
- `Last-Event-ID` replay (the bus is in-memory, no per-event store; the audit log
  query API is the replay path).
- A web UI consuming the stream (browser, verified-locally-only).
- Per-action server-side filtering (the client filters; all actions stream).
