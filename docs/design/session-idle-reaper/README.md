# Session Idle Reaper — Design Document

**Status:** Draft  
**Author:** qinqi  
**Date:** 2026-06-08  
**Scope:** `packages/acp-bridge/src/bridge.ts`, `packages/cli/src/serve/server.ts`

---

## 1. Problem Statement

### 1.1 Current behavior

Once created, a bridge session lives in memory (`byId: Map<string, SessionEntry>`)
indefinitely. It is only destroyed when:

1. A client explicitly calls `DELETE /session/:id` (`closeSession`)
2. The shared `qwen --acp` child process crashes (`channel.exited` handler)
3. The daemon process receives `SIGTERM` / `SIGINT` (`shutdown`)

There is **no automatic idle timeout** for sessions. The heartbeat timestamps
(`sessionLastSeenAt`, `clientLastSeenAt`) are recorded by `recordHeartbeat` but
never consumed for eviction purposes (the field comment references a future
"revocation policy (PR 24)" that has not landed).

### 1.2 Impact

| Scenario                                                                        | Symptom                                                                         |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| User opens multiple browser tabs, closes them without calling `DELETE /session` | Sessions accumulate in `byId`, each holding an EventBus ring (~2-4 MB)          |
| 20 sessions (default `maxSessions`) accumulate                                  | `SessionLimitExceededError` on new `spawnOrAttach` — user locked out            |
| Long-lived daemon with tab churn                                                | Unbounded memory growth in the EventBus replay rings and ACP-side session state |
| IDE extension restarts / crashes                                                | Orphaned sessions never cleaned up                                              |

### 1.3 Why now

The daemon is increasingly used as a long-running workspace server (desktop app,
IDE extensions, web UI). Client crashes and network blips are normal — relying on
explicit `DELETE` for cleanup is untenable.

---

## 2. Design Goals

1. **Automatically reclaim idle sessions** whose clients are gone and that have
   no active work in progress.
2. **Never destroy a session that has an active prompt** — doing so would
   silently kill user-visible work.
3. **Preserve persisted session data** — only in-memory bridge state is released;
   disk transcripts (`SessionService`) are untouched. Users can `session/load` or
   `session/resume` to restore.
4. **Observable** — emit a distinct SSE event so clients know WHY the session
   closed (idle timeout vs. explicit close vs. crash).
5. **Configurable** — operators and tests can tune timeouts or disable the
   reaper entirely.
6. **Zero new dependencies / components** — implement entirely within the
   existing bridge closure.

### Non-goals

- Cross-workspace session management (that would be a gateway concern).
- LRU eviction at `maxSessions` boundary (valuable but separate work — tracked
  as a follow-up).
- EventBus ring compaction for idle sessions (low priority given the 20-session
  cap; tracked as a follow-up).
- RSS-based adaptive pressure (requires `process.memoryUsage()` polling and
  policy design; tracked as a follow-up).

---

## 3. Architecture

### 3.1 Overview

```
Bridge closure (createHttpAcpBridge)
│
├─ byId: Map<sessionId, SessionEntry>     ← existing
├─ channelInfo: ChannelInfo               ← existing
├─ idleTimer (channel-level)              ← existing
│
└─ sessionReaper: NodeJS.Timeout          ← NEW
     │
     ├─ scans byId every REAP_INTERVAL_MS
     ├─ skips sessions with active prompt
     ├─ skips sessions with live SSE subscribers
     ├─ closes sessions exceeding idle TTL
     └─ emits session_closed { reason: 'idle_timeout' }
```

### 3.2 Relationship to existing mechanisms

| Mechanism                                 | Scope                     | What it manages                                                                  |
| ----------------------------------------- | ------------------------- | -------------------------------------------------------------------------------- |
| `channelIdleTimeoutMs` + `startIdleTimer` | Channel (child process)   | Kills the `qwen --acp` child when ALL sessions are gone                          |
| **Session reaper** (this design)          | Session (in-memory entry) | Closes individual sessions when idle                                             |
| `ConnectionRegistry` sweep                | ACP-over-HTTP connection  | Reaps `/acp` transport-layer connections (different layer)                       |
| `writerIdleTimeoutMs`                     | SSE subscriber            | Evicts a single stuck SSE subscriber                                             |
| Disconnect reaper (server.ts)             | Spawn handshake           | Reaps sessions whose spawn-owner disconnected DURING the POST /session handshake |

Two mechanisms work together to cover session lifecycle cleanup:

1. **Close-on-last-detach** (primary) — when `detachClient` removes the last
   registered client AND no SSE subscribers remain, the session is closed
   immediately via `closeSessionImpl`. This handles the normal path: user
   closes a tab → React cleanup → `POST /session/:id/detach`.

2. **Session idle reaper** (backstop) — periodic scan for sessions with no
   active prompt and no SSE subscribers that haven't received a heartbeat
   within the configured TTL. This catches the crash path: browser killed,
   network dropped, `kill -9` — the detach request was never sent, so
   `clientIds` still shows registered clients but the session is effectively
   orphaned.

---

## 4. Detailed Design

### 4.1 New configuration options (`BridgeOptions`)

```typescript
interface BridgeOptions {
  // ... existing fields ...

  /**
   * How often the session reaper scans `byId` for idle sessions, in
   * milliseconds. Default: 60_000 (1 minute). Set to 0 or Infinity to
   * disable the reaper entirely. The timer is `.unref()`'d.
   */
  sessionReapIntervalMs?: number;

  /**
   * A session with ZERO live SSE subscribers AND ZERO registered clients
   * that has not received a heartbeat for this many milliseconds is
   * considered idle and will be reaped.
   *
   * Default: 30 * 60_000 (30 minutes).
   * Set to 0 or Infinity to disable idle reaping.
   */
  sessionIdleTimeoutMs?: number;
}
```

**CLI surface** (`qwen serve` flags):

```
--session-reap-interval-ms <ms>   Reaper scan interval (default 60000, 0=disable)
--session-idle-timeout-ms <ms>    Idle threshold (default 1800000, 0=disable)
```

### 4.2 Session idle predicate

A session is eligible for reaping when **all** of the following hold:

1. **No active prompt**: `entry.activePromptOriginatorClientId === undefined`
2. **No live SSE subscribers**: `entry.events.subscriberCount === 0`
3. **No registered clients**: `entry.clientIds.size === 0`
4. **Idle duration exceeded**: `now - lastActivity(entry) > sessionIdleTimeoutMs`

Where `lastActivity(entry)` is defined as:

```typescript
function lastActivity(entry: SessionEntry): number {
  // `sessionLastSeenAt` is epoch-ms (from Date.now());
  // `createdAt` is an ISO 8601 string — parse to epoch-ms as fallback.
  return entry.sessionLastSeenAt ?? Date.parse(entry.createdAt);
}
```

Note: `entry.createdAt` is typed as `string` (ISO 8601), not a number.
`Date.parse` is safe here — the format is always `new Date().toISOString()`
(see `createSessionEntry`, bridge.ts:1883).

**Rationale for each guard:**

| Guard                 | Why                                                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| No active prompt      | A headless / autonomous prompt (e.g. CLI pipe, cron job) may be running with no SSE subscriber. Reaping it would kill work. |
| No SSE subscribers    | A connected client is actively listening. Even if it hasn't sent a heartbeat, the SSE connection itself proves liveness.    |
| No registered clients | A client that registered its `clientId` but hasn't yet opened SSE is still considered "present".                            |
| Idle duration         | Grace period so briefly-disconnected clients can reconnect without losing their session.                                    |

### 4.3 Reap action

For each session that passes the idle predicate, the reaper calls:

```typescript
await closeSession(sessionId, { reason: 'idle_timeout' });
```

This reuses the existing `closeSession` path which:

1. Removes from `byId` / `defaultEntry`
2. Cancels pending permissions via `permissionMediator.forgetSession`
3. Publishes `session_closed` event (with `reason: 'idle_timeout'`)
4. Closes the EventBus
5. Sends `connection.cancel()` to the ACP child (best-effort)
6. Triggers `startIdleTimer` on the channel if it was the last session

**Why `closeSession` and not `killSession`?**

`killSession` is the internal force-reap path designed for the spawn-handshake
disconnect race (`requireZeroAttaches` guard, `spawnOwnerWantedKill` tombstone).
`closeSession` is the documented client-facing path that publishes
`session_closed` (not `session_died`) and handles telemetry correctly. The reaper
is a "graceful close on behalf of an absent client", so `closeSession` is the
right semantic.

### 4.4 Extending `closeSession` to accept a close reason

Currently `closeSession` hardcodes `reason: 'client_close'` in the
`session_closed` event. We need to make this parameterizable.

**Approach:** Add a new optional `opts` parameter to `closeSession` rather than
overloading `BridgeClientRequestContext` (which is a client-request-scoped
type — adding `reason` to it would be a layer violation since "reason" is a
server-side decision, not something a client passes in a header).

```typescript
// bridgeTypes.ts — new type + signature change:
export interface CloseSessionOpts {
  /** Override the default 'client_close' reason in the session_closed event. */
  reason?: string;
}

closeSession(
  sessionId: string,
  context?: BridgeClientRequestContext,
  opts?: CloseSessionOpts,
): Promise<void>;
```

```typescript
// bridge.ts — implementation change:
async closeSession(sessionId, context, opts) {
  // ...
  const reason = opts?.reason ?? 'client_close';
  entry.events.publish({
    type: 'session_closed',
    data: { sessionId, reason, ... },
  });
}
```

Existing callers (`DELETE /session/:id` route) pass no `opts`, defaulting to
`'client_close'`. The reaper passes `{ reason: 'idle_timeout' }`.

### 4.5 Reaper lifecycle

```typescript
// Inside createHttpAcpBridge closure:

const resolvedReapIntervalMs = resolvePositiveMs(
  opts.sessionReapIntervalMs,
  60_000,
);
const resolvedIdleTimeoutMs = resolvePositiveMs(
  opts.sessionIdleTimeoutMs,
  30 * 60_000,
);

let sessionReaper: ReturnType<typeof setInterval> | undefined;

function startSessionReaper(): void {
  if (resolvedReapIntervalMs <= 0 || resolvedIdleTimeoutMs <= 0) return;
  sessionReaper = setInterval(() => {
    if (shuttingDown) return;
    const now = Date.now();
    for (const [id, entry] of byId) {
      if (entry.activePromptOriginatorClientId !== undefined) continue;
      if (entry.events.subscriberCount > 0) continue;
      if (entry.clientIds.size > 0) continue;
      const lastActive = entry.sessionLastSeenAt ?? Date.parse(entry.createdAt);
      const idle = now - lastActive;
      if (idle < resolvedIdleTimeoutMs) continue;
      writeStderrLine(
        `qwen serve: reaping idle session ${JSON.stringify(id)} ` +
          `(idle for ${Math.round(idle / 1000)}s, threshold ${Math.round(resolvedIdleTimeoutMs / 1000)}s)`,
      );
      // Pass `undefined` context (no client) and `{ reason }` opts.
      bridgeImpl
        .closeSession(id, undefined, { reason: 'idle_timeout' })
        .catch((err) => {
          writeStderrLine(
            `qwen serve: session reaper failed to close ${JSON.stringify(id)}: ${String(err)}`,
          );
        });
    }
  }, resolvedReapIntervalMs);
  sessionReaper.unref();
}

function stopSessionReaper(): void {
  if (sessionReaper !== undefined) {
    clearInterval(sessionReaper);
    sessionReaper = undefined;
  }
}
```

Note: `bridgeImpl` refers to the bridge object returned by `createHttpAcpBridge`
so `closeSession` has full access to the closure-scoped state. In practice, this
is implemented as a direct call to the closure-internal `closeSessionImpl`
function.

**Lifecycle integration:**

- `startSessionReaper()` is called at bridge construction time (after
  option validation, alongside the existing `channelIdleTimeoutMs` setup).
- `stopSessionReaper()` is called in both `shutdown()` and `killAllSync()`.

### 4.6 Interaction with existing `closeSession` callers

| Caller                       | Impact                                                             |
| ---------------------------- | ------------------------------------------------------------------ |
| `DELETE /session/:id` route  | None — no `opts` passed, defaults to `reason: 'client_close'`      |
| Session reaper (this design) | Passes `opts: { reason: 'idle_timeout' }`                          |
| `detachClient` deferred reap | Calls `killSession` (not `closeSession`), unaffected               |
| `channel.exited` handler     | Publishes `session_died`, unaffected                               |
| `shutdown()`                 | Publishes `session_died` with reason `daemon_shutdown`, unaffected |

### 4.7 Concurrency safety

The reaper callback runs on the Node.js event loop. Key considerations:

- **`for...of` iteration is synchronous.** The reaper evaluates each entry's
  idle predicate synchronously, then fires `closeSession(...).catch(...)` for
  matching entries. No `await` in the loop body — all closes are dispatched
  in a single microtask boundary, then the loop exits.
- **`byId.delete` is deferred.** Inside `closeSession`, `byId.delete` runs
  AFTER the first `await` (`notifyAgentSessionClose`). This means deletions
  happen in microtasks after the `for...of` loop has completed. Since each
  `closeSession` operates on a distinct key, there is no aliasing. And `for...of`
  has already finished iterating, so mid-iteration deletion is not a concern.
- **Double-close race.** If a client calls `DELETE /session/:id` for the same
  session between the reaper's predicate check and the async `closeSession`
  execution, the reaper's `closeSession` will throw `SessionNotFoundError`
  (caught by `.catch()`). Safe.
- **Reconnect race.** If a client reconnects to a session (registers clientId /
  opens SSE) between the reaper's predicate check and `closeSession` execution,
  `closeSession` will still proceed and close the session. The client receives
  `session_closed` and must re-load. This window is extremely narrow (one
  synchronous `setInterval` tick) and the consequence is benign — no data loss,
  just a re-load prompt. The 30-minute default TTL makes this vanishingly rare.
- A concurrent `spawnOrAttach` that creates a new session while the reaper
  is scanning won't be seen (we iterate `byId` entries at the start of each
  tick). This is safe — new sessions are fresh and won't meet the idle threshold.

### 4.8 Wire-format change

The `session_closed` event's `data.reason` field already exists with value
`'client_close'`. We add two new values:

- `'idle_timeout'` — emitted by the idle reaper (backstop for crashed clients)
- `'last_client_detached'` — emitted by close-on-last-detach (normal tab close)

This is backward-compatible — existing SDK code that checks
`reason === 'client_close'` will simply not match the new values, and the
generic terminal-frame handler (`isTerminalLifecycleEvent`) already handles
`session_closed` regardless of reason.

---

## 5. Test Plan

### 5.1 Unit tests (`bridge.test.ts`)

| #   | Test                                                   | Description                                                                                                                                                                            |
| --- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Idle session is reaped after timeout                   | Create a session, advance time past `sessionIdleTimeoutMs`, trigger reaper tick, verify session removed from `byId` and `session_closed` event published with `reason: 'idle_timeout'` |
| 2   | Session with active prompt is NOT reaped               | Create a session, start a prompt, advance time, verify session survives reaper tick                                                                                                    |
| 3   | Session with live SSE subscriber is NOT reaped         | Create a session, subscribe to its EventBus, advance time, verify session survives                                                                                                     |
| 4   | Session with registered client is NOT reaped           | Create a session, register a clientId, advance time, verify session survives                                                                                                           |
| 5   | Reaper disabled when interval = 0                      | Pass `sessionReapIntervalMs: 0`, verify no `setInterval` is armed                                                                                                                      |
| 6   | Reaper disabled when timeout = 0                       | Pass `sessionIdleTimeoutMs: 0`, verify no `setInterval` is armed                                                                                                                       |
| 7   | Reaper stopped on shutdown                             | Call `shutdown()`, verify `clearInterval` was called                                                                                                                                   |
| 8   | closeSession reason defaults to 'client_close'         | Call `closeSession` without explicit reason, verify published event has `reason: 'client_close'`                                                                                       |
| 9   | closeSession with explicit reason                      | Call `closeSession` with `reason: 'idle_timeout'`, verify published event                                                                                                              |
| 10  | Multiple idle sessions reaped in one tick              | Create 3 idle sessions, advance time, trigger tick, verify all 3 reaped                                                                                                                |
| 11  | Session with heartbeat within TTL survives             | Create a session, record heartbeat, advance time to just under TTL, verify session survives                                                                                            |
| 12  | Channel idle timer triggered after last session reaped | Create 1 session (last on channel), reap it, verify `startIdleTimer` is called on the channel                                                                                          |

### 5.2 Integration tests (`server.test.ts`)

| #   | Test                                                                   | Description                                                                             |
| --- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 1   | `GET /health?deep=1` reflects reaper-cleaned session count             | Start daemon, create sessions, advance time, verify health endpoint shows reduced count |
| 2   | SSE subscriber receives `session_closed` with `reason: 'idle_timeout'` | Open SSE, disconnect, reconnect before TTL, then let TTL expire, verify event           |

---

## 6. Configuration Defaults

| Option                  | Default            | Rationale                                                                                                   |
| ----------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------- |
| `sessionReapIntervalMs` | 60,000 (1 min)     | Frequent enough to prevent long accumulation, cheap enough (simple Map scan) to run often                   |
| `sessionIdleTimeoutMs`  | 1,800,000 (30 min) | Generous grace period for reconnection. Matches `ConnectionRegistry.idleTtlMs` for mental model consistency |

---

## 7. Observability

- **stderr log**: `qwen serve: reaping idle session "<id>" (idle for Nms)` on
  each reap, matching existing `qwen serve:` prefix convention.
- **Telemetry event**: `session.close` with operation
  `qwen-code.daemon.bridge.operation: 'session.close'` (reuses existing
  `closeSession` telemetry path).
- **Telemetry metric**: `sessionLifecycle('close')` (reuses existing counter).
- **SSE event**: `session_closed` with `data.reason: 'idle_timeout'`.

---

## 8. Follow-up Work (Out of Scope)

| Item                            | Description                                                                     | Priority |
| ------------------------------- | ------------------------------------------------------------------------------- | -------- |
| LRU eviction at `maxSessions`   | Instead of rejecting new sessions, evict the least-recently-active idle session | P1       |
| EventBus ring compaction        | Shrink the ring for sessions with 0 subscribers to save memory                  | P2       |
| RSS-based adaptive pressure     | Monitor `process.memoryUsage().rss` and lower the idle TTL when memory is tight | P2       |
| Heartbeat-based client liveness | Auto-unregister clients that miss N consecutive heartbeat windows               | P2       |

---

## 9. Risks and Mitigations

| Risk                                                                            | Mitigation                                                                                                                                                                        |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reaper closes a session that a headless client is about to reconnect to         | 30-minute default TTL is generous; headless clients should send heartbeats. Disk transcript is preserved — `session/load` restores it.                                            |
| `closeSession` inside reaper throws, poisoning the scan loop                    | Each close is in its own `.catch()` — one failure doesn't block others                                                                                                            |
| Reaper iteration over `byId` during concurrent `closeSession` from another path | ES2015 Map iteration tolerates deletion of current/previous keys. Double-close is idempotent (`byId.get` returns undefined → `SessionNotFoundError` caught by reaper's `.catch`). |
| Performance of scanning 20 sessions every 60s                                   | Trivial — 20 Map reads + 4 field checks each. No I/O.                                                                                                                             |
| Channel idle timer interaction                                                  | When the last session is reaped, `closeSession` already calls `startIdleTimer` on the channel. No additional logic needed.                                                        |
