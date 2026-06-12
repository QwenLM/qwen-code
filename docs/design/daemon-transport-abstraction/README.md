# DaemonTransport Abstraction Layer

> Target branch: `main`. Author: arnoo.gao. Date: 2026-06-12. Status: **Design v2 — review**.
> Design-first per repo workflow: this doc lands before the implementation PR.

---

## 0. TL;DR

`DaemonClient` hardcodes REST+SSE. Third-party integrations wanting ACP
WebSocket must fork the provider stack (~8 files). This proposal adds a
**`DaemonTransport` interface** with `fetch` + `subscribeEvents` methods,
enabling pluggable transports with **zero breaking changes**.

**Total change: ~178 lines of production code** across 3 files (new interface +
`RestSseTransport` extraction + DaemonClient wiring). Existing consumers untouched.

---

## 1. Background

### 1.1 Current architecture

```
DaemonClient({ baseUrl, token })
  └─ this._fetch = globalThis.fetch     ← hardcoded
  └─ subscribeEvents → GET /session/:id/events → parseSseStream → DaemonEvent
```

67 public methods, each constructing REST URLs and branching on HTTP status
codes. `fetch` is already injectable via `DaemonClientOptions.fetch`, but
`subscribeEvents` has inline SSE-specific logic (content-type check, SSE parsing,
connect-phase timeout) that cannot be swapped via fetch injection alone.

### 1.2 The problem for third parties

When a third party (e.g., `agent-web`) builds an `AcpSessionProvider` to use
WebSocket instead of REST+SSE:

- **If they replace** `DaemonSessionProvider`: components that read
  `DaemonStoreContext` (e.g., TerminalView) lose their context → crash.
- **If they keep both providers**: two event sources, two stores, desync.
- **If they inject events** into the SDK store: `DaemonSessionProvider` also
  subscribes to SSE internally → duplicate events.

**Root cause**: changing the transport requires replacing the provider, because
`DaemonClient`'s `subscribeEvents` is hardcoded to SSE.

### 1.3 Target

```
DaemonClient({ transport: new AcpWsTransport(url, token) })
  └─ transport.fetch → maps URL+verb to JSON-RPC over WS
  └─ transport.subscribeEvents → demux WS notifications → DaemonEvent
```

One provider, one store, transport is an internal detail. Third parties pass
`transport` to `DaemonClient`; everything else works unchanged.

---

## 2. Design

### 2.1 Interface

```typescript
interface DaemonTransportFetchOptions {
  timeout?: number;  // 0 = no timeout. undefined = transport default.
}

interface DaemonTransportSubscribeOptions {
  lastEventId?: number;
  maxQueued?: number;
  signal?: AbortSignal;
  connectTimeoutMs?: number;
}

interface DaemonTransport {
  /**
   * Send a request and return a Response.
   *
   * Contract:
   * - Response MUST support .json(), .text(), .ok, .status,
   *   .headers.get(), .body?.cancel()
   * - .status MUST be an accurate HTTP status code
   *   (200, 201, 202, 204, 404, etc.)
   * - Error bodies MUST preserve the daemon's structured shape
   * - Callable without prior setup; transport handles init internally
   *   (lazy-init / init-once deferred pattern)
   * - Throws DaemonTransportClosedError when connection is dead
   */
  fetch(
    url: string,
    init: RequestInit,
    opts?: DaemonTransportFetchOptions,
  ): Promise<Response>;

  /**
   * Subscribe to session events.
   *
   * Contract:
   * - MUST yield DaemonEvent with monotonic integer id
   * - MUST deliver ALL event types (session + workspace) in one stream
   * - Aborting signal MUST stop only this generator, NOT the connection
   * - MUST apply connectTimeoutMs to connect phase only
   */
  subscribeEvents(
    sessionId: string,
    opts: DaemonTransportSubscribeOptions,
  ): AsyncGenerator<DaemonEvent>;

  /** Transport identity for exhaustive switching. */
  readonly type: 'rest' | 'acp-http' | 'acp-ws';

  /** False after connection drop or dispose(). */
  readonly connected: boolean;

  /** Idempotent teardown. */
  dispose(): void;
}

class DaemonTransportClosedError extends Error {}
```

### 2.2 Why two methods (fetch + subscribeEvents), not just fetch

`subscribeEvents` has fundamentally different wire semantics per transport:

| Transport | Wire mechanism |
|-----------|---------------|
| REST | `GET /session/:id/events` → SSE → `parseSseStream` → `DaemonEvent` |
| ACP HTTP | `GET /acp` (session-scoped SSE) → JSON-RPC notification unwrap |
| ACP WS | Demux notifications from shared socket by sessionId |

Forcing these through a fetch-shaped hole requires SSE re-encoding/decoding
(WS → fake SSE text → `parseSseStream` → DaemonEvent) — wasteful and fragile.

All other 66 methods work through `fetch` because they follow request→response
semantics regardless of transport.

### 2.3 Why fetch-level, not method-dispatch

DaemonClient's 67 methods contain per-method HTTP branching:
- `prompt()`: 202 vs 200 status check
- `deleteWorkspaceAgent()`: 204 vs 404 with body inspection
- `respondToPermission()`: 200 vs 404 for race detection
- 6 methods bypass `fetchWithTimeout` by calling `_fetch` directly

A method-dispatch interface (`request<T>(method, params)`) forces duplicating
all this logic in every transport. Fetch-level keeps DaemonClient unchanged.

### 2.4 DaemonClient changes (~40 lines)

```typescript
export interface DaemonClientOptions {
  baseUrl: string;
  token?: string;
  fetch?: typeof globalThis.fetch;    // Kept
  fetchTimeoutMs?: number;            // Kept
  transport?: DaemonTransport;        // NEW — optional override
}
```

Internal changes:
- Constructor: `this.transport = opts.transport ?? new RestSseTransport(...)`
- `fetchWithTimeout`: delegate to `this.transport.fetch(url, init, { timeout })`
- 6 direct `this._fetch` sites (prompt, promptNonBlocking, recapSession,
  btwSession, shellCommand, subscribeEvents): replace with
  `this.transport.fetch(url, init, { timeout: 0 })`
- `subscribeEvents`: exhaustive switch on `this.transport.type`:
  - `'rest'`: delegate to `this.transport.subscribeEvents(sessionId, opts)`
  - default: same delegation (each transport handles its own wire format)
- Remove `private _fetch` field (replaced by transport)

### 2.5 RestSseTransport (~80 lines)

Wraps `globalThis.fetch` + extracts current SSE logic from
`DaemonClient.subscribeEvents`:

```typescript
class RestSseTransport implements DaemonTransport {
  readonly type = 'rest' as const;
  readonly connected = true;  // REST is stateless

  constructor(private readonly _fetch: typeof globalThis.fetch) {}

  fetch(url, init, opts?) { return this._fetch(url, init); }

  async *subscribeEvents(sessionId, opts) {
    // Current DaemonClient.subscribeEvents logic moved here:
    // - build URL, set headers, connect-phase timeout
    // - fetch → validate content-type → parseSseStream → yield
  }

  dispose() {}  // no-op
}
```

### 2.6 ACP transport internals (follow-up PRs)

**AcpWsTransport** (~400-600 lines, separate PR):
- Lazy-init: first `fetch` call opens WS + sends `initialize`
- URL→JSON-RPC mapping table: `/session/:id/prompt` → `{method: "session/prompt", params: {sessionId: id, ...body}}`
- Request multiplexer: `Map<id, {resolve, reject}>` for pending requests
- `subscribeEvents`: filter shared notification stream by sessionId
- `connected`: tracks WS readyState
- Synthesizes `Response` objects with correct `.status`/`.json()`/`.text()`

**AcpHttpTransport** (~800-1000 lines, separate PR):
- Lazy-init: first `fetch` call sends `POST /acp {initialize}`
- Manages conn-scoped + session-scoped SSE streams internally
- Same URL→JSON-RPC mapping + request correlation

---

## 3. Breaking change audit

### Verdict: zero breaking changes

| Public API | Change | Breaking? |
|-----------|--------|:---------:|
| `new DaemonClient({ baseUrl, token })` | No change | ❌ |
| `DaemonClientOptions.*` | All kept, `transport` added | ❌ |
| `DaemonHttpError` | Unchanged | ❌ |
| `DaemonSessionClient` | Zero changes (delegates to DaemonClient) | ❌ |
| All type exports (100+) | Unchanged | ❌ |

### Per-consumer impact

| Consumer | Impact |
|----------|--------|
| webui (25 files) | Zero code changes |
| web-shell (4 files) | Zero code changes |
| vscode-ide-companion (1 file) | Zero code changes |
| Third-party | Zero for REST; pass `transport` for ACP |

---

## 4. Design decisions

| Decision | Rationale |
|----------|-----------|
| `subscribeEvents` on transport, not just `fetch` | SSE re-encoding through fetch is wasteful and fragile |
| `connected: boolean` on transport | Provider reconnect loop needs to distinguish "transport dead" from "transient 500" |
| Lazy-init (not explicit `connect()`) | Keeps DaemonClient construction synchronous; default `new RestSseTransport()` needs no init |
| No `auto` fallback | Cross-transport session migration has no handoff protocol. Explicit selection. |
| No error taxonomy prerequisite | ACP transports map errors to HTTP-equivalent status codes internally; `DaemonHttpError` works as-is |
| No provider changes needed | Third parties construct `DaemonClient` with `transport` directly; provider creates `DaemonClient` from workspace context which can carry a transport |

---

## 5. Alternatives considered

### 5.1 Custom fetch injection (no new interface)

Pass a WS-based `fetch` via existing `DaemonClientOptions.fetch`.

**Rejected**: `subscribeEvents` validates `content-type: text/event-stream` and
uses `parseSseStream`. A custom fetch must re-encode WS frames as SSE text, then
the SDK decodes them back — wasteful encode-decode roundtrip. Also,
`capabilities()` and `initialize` have different response shapes requiring a
format mapping layer.

### 5.2 Full formal interface (4 PRs, ~2750 lines)

Error taxonomy → Interface → AcpHttp → AcpWs as separate PRs.

**Rejected**: over-engineered. Error taxonomy is unnecessary (ACP transports can
map to HTTP-equivalent status codes). Provider changes unnecessary (transport
injected via DaemonClient constructor, not provider props).

### 5.3 Dual provider with BridgeContext

Parallel `AcpSessionProvider` + `ChatBridgeContext` + `SessionBridgeContext`.

**Rejected**: causes store desync, requires ~8 files, cannot work without SDK changes.

---

## 6. Implementation plan

### PR 1: DaemonTransport interface + RestSseTransport extraction (~178 lines)

| File | Change | Lines |
|------|--------|-------|
| `packages/sdk-typescript/src/daemon/DaemonTransport.ts` | New: interface + types + `DaemonTransportClosedError` | ~50 |
| `packages/sdk-typescript/src/daemon/RestSseTransport.ts` | New: wraps `globalThis.fetch` + SSE logic extracted from DaemonClient | ~80 |
| `packages/sdk-typescript/src/daemon/DaemonClient.ts` | Constructor + 6 `_fetch` sites + subscribeEvents rewrite | ~40 net |
| `packages/sdk-typescript/src/daemon/index.ts` | Export new types | ~5 |

**Zero behavioral change**: all existing tests pass unchanged.

### PR 2: AcpWsTransport (~400-600 lines, follow-up)

| File | Change |
|------|--------|
| `packages/sdk-typescript/src/daemon/AcpWsTransport.ts` | WS multiplexer + URL→JSON-RPC mapping |
| `packages/sdk-typescript/src/daemon/AcpEventDenormalizer.ts` | JSON-RPC notification → DaemonEvent |
| Tests | WS integration tests |

### PR 3: AcpHttpTransport (optional, ~800 lines, follow-up)

---

## 7. Verification

1. **PR 1**: `npm run test` across sdk-typescript — zero test changes needed.
   `new DaemonClient({ baseUrl, token })` produces identical behavior.
2. **PR 2**: Integration test connecting to real daemon via ACP WS. Verify:
   - `subscribeEvents` yields same `DaemonEvent` shapes as REST SSE
   - prompt 202/200 branching works with synthesized Response
   - permission vote round-trips correctly
   - `connected` transitions to `false` on WS drop
3. **End-to-end**: Third-party passes `transport={new AcpWsTransport(url, token)}`
   to `DaemonClient`. All SDK hooks and transcript store work unchanged.

---

## 8. Risks

| Risk | Mitigation |
|------|-----------|
| URL→JSON-RPC mapping table maintenance | Table co-located with transport; daemon route changes require transport update |
| ACP WS synthesized Response fidelity | Provide `syntheticResponse(status, json)` helper; document contract (`.json()`, `.text()`, `.status`, `.body?.cancel()`) |
| `DaemonEvent.id` monotonicity for WS | ACP server's JSON-RPC notifications carry event id; transport surfaces it directly |
| Prompt 202 vs 200 for WS | Transport maps JSON-RPC response → 200 with result body (blocking path); events still flow via `subscribeEvents` |
| WS connection drop detection | `connected: boolean` + `DaemonTransportClosedError` thrown from `fetch` |
