# DaemonTransport Abstraction Layer

> Target branch: `main`. Author: arnoo.gao. Date: 2026-06-12. Status: **Design v4 — review**.
> Design-first per repo workflow: this doc lands before the implementation PR.

---

## 0. TL;DR

`DaemonClient` hardcodes REST+SSE. Third-party integrations wanting ACP
WebSocket must fork the provider stack (~8 files). This proposal adds a
**`DaemonTransport` interface** with `fetch` + `subscribeEvents` methods,
plus auto-detection and runtime fallback, enabling pluggable transports
with **zero breaking changes**.

**Total change: ~1300 lines** in a single implementation PR. Existing
consumers untouched — `new DaemonClient({ baseUrl, token })` = current behavior.

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
   * - When init.signal aborts: for prompt requests, transport MUST
   *   cancel the in-flight prompt on the wire (WS: send session/cancel
   *   RPC; HTTP: abort fetch). For ordinary requests, abort only
   *   rejects/cancels the pending request without side effects.
   *   Pending response rejects with AbortError.
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
   * - Events with id MUST have monotonic integer ids; synthetic/terminal
   *   frames (e.g., stream_error) MAY omit id (DaemonEvent.id is optional)
   * - MUST deliver ALL event types (session + workspace) in one stream
   * - Aborting signal MUST stop only this generator, NOT the connection
   * - When the connection dies, all pending generators MUST throw
   *   DaemonTransportClosedError (transport maintains generator refs)
   * - MUST apply connectTimeoutMs to connect phase only
   * - Transport MUST declare whether lastEventId replay is supported;
   *   if not, consumer MUST use session/load for full resync on reconnect
   */
  subscribeEvents(
    sessionId: string,
    opts: DaemonTransportSubscribeOptions,
  ): AsyncGenerator<DaemonEvent>;

  /** Transport identity for exhaustive switching. */
  readonly type: 'rest' | 'acp-http' | 'acp-ws';

  /** Whether this transport supports Last-Event-ID based replay on reconnect.
   *  When false, consumer MUST use session/load for full resync. */
  readonly supportsReplay: boolean;

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

### 2.5 Provider injection point

`DaemonWorkspaceProvider` and `DaemonSessionProvider` both construct
`DaemonClient` internally. To let third parties inject a transport without
bypassing the provider:

```typescript
// DaemonWorkspaceProvider — add optional transport prop
interface DaemonWorkspaceProviderProps {
  baseUrl: string;
  token?: string;
  transport?: DaemonTransport;  // NEW — forwarded to DaemonClient
  // ...existing props
}

// DaemonSessionProvider — inherit from workspace context
// No transport prop needed; reads from workspace context
```

When `transport` is provided, the provider passes it to `DaemonClient`:
```typescript
new DaemonClient({ baseUrl, token, transport: props.transport })
```

When omitted: current behavior (REST+SSE). ~5 lines of provider change.

### 2.5 RestSseTransport (~80 lines)

Wraps `globalThis.fetch` + extracts current SSE logic from
`DaemonClient.subscribeEvents`:

```typescript
class RestSseTransport implements DaemonTransport {
  readonly type = 'rest' as const;
  readonly supportsReplay = true;  // SSE supports Last-Event-ID
  readonly connected = true;       // REST is stateless

  constructor(
    private readonly baseUrl: string,
    private readonly token: string | undefined,
    private readonly _fetch: typeof globalThis.fetch,
  ) {}

  fetch(url, init, opts?) { return this._fetch(url, init); }

  async *subscribeEvents(sessionId, opts) {
    // Current DaemonClient.subscribeEvents logic moved here:
    // - build URL from this.baseUrl + sessionId
    // - set Authorization header from this.token
    // - connect-phase timeout from opts.connectTimeoutMs
    // - fetch → validate content-type → parseSseStream → yield
  }

  dispose() {}  // no-op
}
```

### 2.6 ACP transport internals

**AcpWsTransport** (~400-600 lines):
- Lazy-init: first `fetch` call opens WS + sends `initialize`
- URL→JSON-RPC mapping table: `/session/:id/prompt` → `{method: "session/prompt", params: {sessionId: id, ...body}}`
- Request multiplexer: `Map<id, {resolve, reject}>` for pending requests
- `subscribeEvents`: filter shared notification stream by sessionId
- `connected`: tracks WS readyState
- `supportsReplay`: false (WS has no Last-Event-ID; consumer must `session/load`)
- Synthesizes `Response` objects with correct `.status`/`.json()`/`.text()`

**AcpHttpTransport** (~800-1000 lines):
- Lazy-init: first `fetch` call sends `POST /acp {initialize}`
- Manages conn-scoped + session-scoped SSE streams internally
- Same URL→JSON-RPC mapping + request correlation
- `supportsReplay`: true (session SSE supports Last-Event-ID)

### 2.7 Transport auto-detection

Server advertises supported transports in `GET /capabilities`:

```json
{
  "transports": ["rest+sse", "acp-http+sse", "acp-ws"],
  ...existing capabilities fields...
}
```

SDK provides a one-shot static factory:

```typescript
// Probe once before React render, never switches mid-session
const transport = await DaemonTransport.negotiate(baseUrl, token);
// Returns best available: acp-ws > acp-http > rest (fallback)
```

Implementation:
1. `GET /capabilities` → read `transports` array
2. If `acp-ws` in list → try WS upgrade; on success return `AcpWsTransport`
3. If WS fails or not in list → try `acp-http`; on success return `AcpHttpTransport`
4. Fallback → `RestSseTransport`

No existing API affected: `GET /capabilities` adds a new field (additive),
existing consumers ignore unknown fields.

### 2.8 Runtime fallback (WS → REST on disconnect)

When a non-REST transport disconnects mid-session:

```
AcpWsTransport (connected=true)
  │
  ├── WS drops (network, server restart, idle timeout)
  │
  ├── connected = false
  ├── All pending fetch() calls → reject with DaemonTransportClosedError
  ├── All subscribeEvents generators → throw DaemonTransportClosedError
  │
  └── Consumer (Provider / third party) detects disconnect:
        1. Create new RestSseTransport (guaranteed to work if daemon is up)
        2. Create new DaemonClient({ transport: newTransport })
        3. For each active session: session/load to re-attach
        4. Resume event subscription
```

**Key constraint**: runtime fallback is **consumer-driven, not transport-internal**.
The transport does not silently switch protocols — it fails loudly
(`DaemonTransportClosedError`) and the consumer decides whether to rebuild.

Rationale:
- WS teardown destroys all owned sessions server-side (`registry.delete` →
  `conn.destroy`). A silent switch would hide this data loss.
- `session/load` re-attaches to the existing bridge session (transcripts
  preserved), but the prompt in flight is aborted. The consumer must handle
  this explicitly (retry or surface to user).
- No `Last-Event-ID` resume across transports yet (Phase 4). Events between
  disconnect and reconnect may be lost. The consumer should request a full
  state resync via `session/load` (which replays history).

**AutoReconnectTransport** (~150 lines, optional wrapper):

```typescript
class AutoReconnectTransport implements DaemonTransport {
  constructor(
    private baseUrl: string,
    private token: string,
    private preferred: 'acp-ws' | 'acp-http' | 'rest',
  ) {}

  // On DaemonTransportClosedError from inner transport:
  // 1. Try to re-create preferred transport
  // 2. If preferred fails, fallback to REST
  // 3. Re-initialize connection
  // Caller still needs to session/load — this wrapper only
  // handles transport-level reconnect, not session-level.
}
```

This wrapper is opt-in. Existing consumers who don't want auto-reconnect
simply catch `DaemonTransportClosedError` and handle it themselves.

**Impact on existing functionality**: zero. All auto-detection and fallback
code is additive and opt-in. `new DaemonClient({ baseUrl, token })` without
`transport` = current REST behavior, no auto-detection, no fallback logic.

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
| Auto-detection is one-shot, not mid-session | `negotiate()` probes once at startup; runtime fallback is consumer-driven via `DaemonTransportClosedError`, not silent internal switch |
| No error taxonomy prerequisite | ACP transports map errors to HTTP-equivalent status codes internally; `DaemonHttpError` works as-is |
| Provider gets `transport` prop | `DaemonWorkspaceProvider` gains optional `transport` prop (~5 lines), forwarded to `DaemonClient` constructor. Third parties set this prop; omitting it = current REST behavior |

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
map to HTTP-equivalent status codes). Separate PRs increase review context-switch
cost for a single cohesive abstraction.

### 5.3 Dual provider with BridgeContext

Parallel `AcpSessionProvider` + `ChatBridgeContext` + `SessionBridgeContext`.

**Rejected**: causes store desync, requires ~8 files, cannot work without SDK changes.

---

## 6. Implementation plan (single PR)

All changes land in one PR. Estimated ~1300 lines total.

| File | Change | Lines |
|------|--------|-------|
| `packages/sdk-typescript/src/daemon/DaemonTransport.ts` | Interface + types + `DaemonTransportClosedError` + `negotiate()` factory | ~110 |
| `packages/sdk-typescript/src/daemon/RestSseTransport.ts` | Wraps `globalThis.fetch` + SSE logic extracted from DaemonClient | ~80 |
| `packages/sdk-typescript/src/daemon/AcpWsTransport.ts` | WS multiplexer + URL→JSON-RPC mapping + request correlation | ~400 |
| `packages/sdk-typescript/src/daemon/AcpHttpTransport.ts` | POST /acp + conn/session SSE management | ~300 |
| `packages/sdk-typescript/src/daemon/AcpEventDenormalizer.ts` | JSON-RPC notification → DaemonEvent mapping | ~150 |
| `packages/sdk-typescript/src/daemon/AutoReconnectTransport.ts` | Opt-in wrapper: reconnect + fallback | ~150 |
| `packages/sdk-typescript/src/daemon/DaemonClient.ts` | Constructor + 6 `_fetch` sites + subscribeEvents rewrite | ~40 net |
| `packages/sdk-typescript/src/daemon/index.ts` | Export new types | ~10 |
| `packages/cli/src/serve/server.ts` | Add `transports` field to `GET /capabilities` | ~5 |
| `packages/sdk-typescript/src/daemon/types.ts` | Add `transports` to `DaemonCapabilities` type | ~3 |
| `packages/webui/src/daemon/workspace/DaemonWorkspaceProvider.tsx` | Add optional `transport` prop, forward to `DaemonClient` | ~5 |
| Tests | Transport unit + integration tests | ~200 |

**Backward compatibility**: `new DaemonClient({ baseUrl, token })` without
`transport` = identical REST+SSE behavior. All existing tests pass unchanged.

---

## 7. Verification

1. **Backward compat**: `npm run test` across sdk-typescript and webui — zero
   test changes needed. `new DaemonClient({ baseUrl, token })` = identical behavior.
2. **RestSseTransport extraction**: bit-for-bit equivalent SSE behavior confirmed
   by existing test suite.
3. **AcpWsTransport**: integration test connecting to real daemon via WS. Verify:
   - `subscribeEvents` yields same `DaemonEvent` shapes as REST SSE
   - prompt 202/200 branching works with synthesized Response
   - permission vote round-trips correctly
   - `connected` transitions to `false` on WS drop
   - abort signal on prompt → WS sends session/cancel RPC
4. **AcpHttpTransport**: same verification as WS but over HTTP+SSE.
5. **Auto-detect**: `negotiate()` returns best transport; fallback to REST on WS failure.
6. **Runtime fallback**: `AutoReconnectTransport` catches `DaemonTransportClosedError`,
   rebuilds transport, consumer calls `session/load` for resync.
7. **Provider**: `DaemonWorkspaceProvider` with `transport` prop — ChatView +
   TerminalView both read from single store.
8. **End-to-end**: Third-party passes `transport={new AcpWsTransport(url, token)}`
   to `DaemonWorkspaceProvider`. All SDK hooks and transcript store work unchanged.

---

## 8. Risks

| Risk | Mitigation |
|------|-----------|
| URL→JSON-RPC mapping table maintenance | Table co-located with transport; daemon route changes require transport update |
| ACP WS synthesized Response fidelity | Provide `syntheticResponse(status, json)` helper; document contract (`.json()`, `.text()`, `.status`, `.body?.cancel()`) |
| `DaemonEvent.id` monotonicity for WS | ACP server's JSON-RPC notifications carry event id; transport surfaces it directly |
| Prompt 202 vs 200 for WS | Transport maps JSON-RPC response → 200 with result body (blocking path); events still flow via `subscribeEvents` |
| WS connection drop detection | `connected: boolean` + `DaemonTransportClosedError` thrown from `fetch` |
