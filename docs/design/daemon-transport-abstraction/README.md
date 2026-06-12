# DaemonTransport Abstraction Layer

> Target branch: `main`. Author: arnoo.gao. Date: 2026-06-12. Status: **Design v1 — review**.
> Design-first per repo workflow: this doc lands before the implementation PR.

---

## 0. TL;DR

The daemon SDK's `DaemonClient` hardcodes REST+SSE as its transport. Third-party
integrations that want ACP WebSocket must build a parallel provider stack (~8
files), causing a **store split** where TerminalView and ChatView read different
transcript stores — crash or desync.

This proposal adds a **`DaemonTransport` interface** at the fetch level inside
`DaemonClient`, enabling pluggable transports (REST+SSE, ACP HTTP+SSE, ACP
WebSocket) with **zero breaking changes** for existing consumers.

**Key decision**: abstract at the **fetch level** (not method-dispatch level),
so all 67 `DaemonClient` methods keep their per-method HTTP branching unchanged.

---

## 1. Background — the store split problem

### 1.1 Current architecture (REST+SSE)

```
DaemonSessionProvider (SDK)
  └─ DaemonClient({ baseUrl, token })  ── fetch() ── REST endpoints
  └─ store = createDaemonTranscriptStore()
       ↑ events from SSE

ChatView  → useDaemonTranscriptStore() → same store ✅
Terminal  → useDaemonTranscriptStore() → same store ✅
```

### 1.2 ACP mode — the dual-provider problem

When a third party replaces `DaemonSessionProvider` with a custom
`AcpSessionProvider` to use WebSocket:

```
AcpSessionProvider (custom)                DaemonSessionProvider (SDK)
  └─ AcpTransport (WS)                      └─ DaemonClient (REST)
  └─ store B                                 └─ store A (DaemonStoreContext)

ChatView → AcpSessionContext → store B ✅
Terminal → DaemonStoreContext → store A ✅  (but different events!)
```

- If `DaemonSessionProvider` is removed: Terminal crashes (`DaemonStoreContext`
  not found).
- If both providers exist: two event sources, two stores, events desync.
- If both subscribe to SSE: duplicate events.

**Root cause**: `DaemonClient` is hardcoded to REST+SSE. Changing the transport
requires replacing the provider, which breaks the single-store invariant.

### 1.3 Target architecture

```
DaemonSessionProvider (SDK, unchanged, sole provider)
  └─ DaemonClient({ transport })       ← only this changes
       ├─ RestSseTransport (default)    ← current behavior, zero breakage
       ├─ AcpHttpTransport              ← POST /acp + SSE
       └─ AcpWsTransport               ← WebSocket /acp
  └─ store (single)
       ↑ events (same DaemonEvent shape regardless of transport)

ChatView  → useDaemonTranscriptStore() → same store ✅
Terminal  → useDaemonTranscriptStore() → same store ✅
```

One provider, one store, one event source. Transport is an implementation detail.

---

## 2. Design

### 2.1 Core interface

```typescript
// packages/sdk-typescript/src/daemon/transport.ts

export interface DaemonTransport {
  /**
   * Transport-level fetch. DaemonClient delegates its internal
   * this._fetch / this.fetchWithTimeout here instead of globalThis.fetch.
   *
   * For RestSseTransport: thin wrapper around globalThis.fetch.
   * For AcpHttpTransport: maps URL+verb → JSON-RPC, sends via POST /acp,
   *   correlates response from conn/session SSE, synthesizes TransportResponse.
   * For AcpWsTransport: maps URL+verb → JSON-RPC frame, sends on WS socket,
   *   demuxes response from incoming frame stream, synthesizes TransportResponse.
   */
  fetch(url: string, init: TransportRequestInit): Promise<TransportResponse>;

  /** Transport identity for conditional logic (e.g., detach escape hatch). */
  readonly type: 'rest' | 'acp-http' | 'acp-ws';

  /** Idempotent cleanup. Closes underlying connection (WS/SSE). No-op for REST. */
  dispose(): void;
}

export interface TransportRequestInit {
  method: string;           // GET, POST, DELETE, PATCH
  headers?: Record<string, string>;
  body?: string | null;
  signal?: AbortSignal;
  keepalive?: boolean;      // For browser beforeunload detach
  timeout?: number;         // Per-method timeout override
}

export interface TransportResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
  json(): Promise<unknown>;
  text(): Promise<string>;
}
```

### 2.2 Why fetch-level, not method-level

An alternative interface `request<T>(method, params): Promise<T>` was considered
and rejected after adversarial audit (7 agents, 35 findings). Key reasons:

1. **DaemonClient has 67 methods with per-method HTTP branching**: status 202 vs
   200 for prompt, 204 vs 404 for delete, `res.body?.cancel()` for permission
   votes, content-type validation for SSE, per-method timeout overrides.
2. **Method-dispatch forces either**: (a) duplicating all branching in every
   transport (3×67 = 201 method bodies), or (b) making the transport aware of
   application semantics (leaky abstraction).
3. **fetch-level keeps DaemonClient unchanged**: it constructs URLs, sets
   headers, branches on status codes exactly as before — only the wire is
   different.

### 2.3 Error taxonomy (prerequisite)

The SDK provider branches on HTTP status codes (`TERMINAL_SESSION_HTTP_STATUSES`,
`AUTH_FAILURE_HTTP_STATUSES`). ACP transports produce JSON-RPC errors, not HTTP
statuses. A transport-agnostic error taxonomy is required first:

```typescript
export type DaemonErrorKind =
  | 'auth_failure'       // HTTP 401/403, WS close 1002/1008
  | 'session_not_found'  // HTTP 404 (session routes)
  | 'session_gone'       // HTTP 410
  | 'rate_limited'       // HTTP 429
  | 'connection_refused' // Network-level failure
  | 'prompt_failed'      // SSE turn error
  | 'internal';          // Everything else

export class DaemonError extends Error {
  readonly kind: DaemonErrorKind;
}

// Backward-compatible subclass — keeps .status for existing consumers
export class DaemonHttpError extends DaemonError {
  readonly status: number;
  readonly body?: unknown;
}

// New: ACP transports produce these
export class DaemonRpcError extends DaemonError {
  readonly code: number;   // JSON-RPC error code
  readonly data?: unknown;
}
```

Provider migrates from `error.status` to `error.kind`:
```typescript
// Before:
if (AUTH_FAILURE_HTTP_STATUSES.has(extractHttpStatus(error))) { ... }

// After:
if (error instanceof DaemonError && error.kind === 'auth_failure') { ... }
```

### 2.4 DaemonClient change

```typescript
export interface DaemonClientOptions {
  baseUrl: string;                    // Kept — used for default transport
  token?: string;                     // Kept
  fetch?: typeof globalThis.fetch;    // Kept — passed to default transport
  fetchTimeoutMs?: number;            // Kept — applied above transport layer
  transport?: DaemonTransport;        // NEW — optional override
}

export class DaemonClient {
  private readonly transport: DaemonTransport;

  constructor(opts: DaemonClientOptions) {
    this.transport = opts.transport ??
      new RestSseTransport(opts.baseUrl, opts.token, opts.fetch);
    // ...rest unchanged
  }

  // All 67 methods unchanged.
  // Internal: this.fetchWithTimeout delegates to this.transport.fetch
  // instead of this._fetch (which was globalThis.fetch).

  dispose(): void {
    this.transport.dispose();
  }
}
```

### 2.5 Provider change

```typescript
// DaemonWorkspaceProvider — single injection point
export interface DaemonWorkspaceProviderProps {
  baseUrl: string;
  token?: string;
  autoConnect?: boolean;
  transport?: DaemonTransport; // NEW — optional, defaults to REST
  children: React.ReactNode;
}

// DaemonSessionProvider inherits transport from workspace context.
// No transport prop on DaemonSessionProvider.
```

Third-party usage:
```tsx
// Current (REST+SSE) — zero changes:
<DaemonWorkspaceProvider baseUrl={url} token={token}>
  <DaemonSessionProvider sessionId={sid}>
    <ChatView />
    <TerminalView />  {/* both read same store ✅ */}
  </DaemonSessionProvider>
</DaemonWorkspaceProvider>

// ACP WebSocket — one prop added:
<DaemonWorkspaceProvider baseUrl={url} token={token}
  transport={new AcpWsTransport(wsUrl, token)}>
  {/* everything else identical */}
</DaemonWorkspaceProvider>
```

---

## 3. Transport implementations

### 3.1 RestSseTransport

Thin wrapper around `globalThis.fetch`. Produces identical behavior to current
`DaemonClient`. `dispose()` is a no-op (REST is stateless).

### 3.2 AcpHttpTransport

Maps `DaemonClient`'s URL+verb calls to ACP JSON-RPC over HTTP:

| DaemonClient call | AcpHttpTransport mapping |
|-------------------|--------------------------|
| `POST /session` body `{...}` | `POST /acp` body `{method: "session/new", params: {...}}` |
| `GET /session/:id/events` | `GET /acp` with `Acp-Connection-Id` + `Acp-Session-Id` headers |
| `POST /session/:id/prompt` | `POST /acp` body `{method: "session/prompt", params: {...}}` |
| `DELETE /session/:id` | `POST /acp` body `{method: "session/close", params: {...}}` |

Internal infrastructure:
- Connection lifecycle: `initialize` on first `fetch`, conn-stream SSE management
- Request correlation: `Map<id, {resolve, reject}>` for JSON-RPC response matching
- Session-stream lifecycle: auto-open session SSE before prompt (server
  auto-denies permission requests if no session stream exists)
- Event denormalization: `session/update` JSON-RPC notification → `DaemonEvent`

### 3.3 AcpWsTransport

Maps calls to JSON-RPC frames on a single WebSocket:

- `initialize` on first `fetch` call, mints connectionId
- All subsequent calls → JSON-RPC request frames
- Incoming frame demux: responses (by matching id) resolve Promises; notifications
  feed event iterables
- Internal `Map<id, {resolve, reject}>` multiplexer
- Reuses `AcpEventDenormalizer` from AcpHttpTransport

---

## 4. Breaking change audit

### 4.1 Verdict: zero breaking changes

`DaemonClientOptions.fetch` is already injectable. The transport abstraction
follows the same additive pattern.

| Public API | Change | Breaking? |
|-----------|--------|:---------:|
| `new DaemonClient({ baseUrl, token })` | No change | ❌ |
| `DaemonClientOptions.*` | All fields kept, `transport` added | ❌ |
| `DaemonHttpError` | Kept as-is, now extends `DaemonError` | ❌ |
| `DaemonSessionClient` | Zero changes (delegates to DaemonClient) | ❌ |
| `parseSseStream` / `SseFramingError` | Remain exported | ❌ |
| 100+ event/state type exports | Unchanged | ❌ |

### 4.2 Per-consumer impact

| Consumer | Impact |
|----------|--------|
| **webui** (25 files) | Zero code changes |
| **web-shell** (4 files) | Zero code changes |
| **vscode-ide-companion** (1 file) | Zero code changes |
| **Third-party (agent-web)** | Zero for current REST; pass `transport` for ACP |

---

## 5. Design decisions

| Decision | Rationale |
|----------|-----------|
| **No `auto` fallback in v1** | Cross-transport session migration has no handoff protocol (WS teardown destroys owned sessions). Ship explicit selection first. |
| **No `notify()` on interface** | No current fire-and-forget use case in DaemonClient's 67 methods. |
| **No `connected: boolean`** | Creates dual-source-of-truth with React state. Liveness detected by request failure. |
| **No `subscribeEvents()` on transport** | Event subscription stays in DaemonClient; transport-specific event handling is internal strategy. |
| **`detachDaemonClient` browser escape hatch** | WS in browsers cannot reliably send close frames during `beforeunload`. Use `navigator.sendBeacon` to REST detach endpoint as fallback. |
| **Transport capability discovery via `GET /capabilities`** | Not via `initialize` (chicken-and-egg: need a transport to call initialize). |

---

## 6. Alternatives considered

### 6.1 Method-dispatch interface

```typescript
interface DaemonTransport {
  request<T>(method: string, params?: unknown): Promise<T>;
  subscribeEvents(sessionId: string): AsyncIterable<DaemonEvent>;
}
```

Rejected: forces either 3×67 method body duplication or leaky abstraction.
DaemonClient's per-method HTTP branching cannot be cleanly abstracted at this
level.

### 6.2 Dual provider with BridgeContext

The approach taken by `data-agent-sandboxs/agent-web`: parallel
`AcpSessionProvider` + `ChatBridgeContext` + `SessionBridgeContext`.

Rejected: causes store split (TerminalView crash), requires ~8 files of
duplicate infrastructure, and cannot be fixed without SDK changes.

### 6.3 Event injection into SDK store

Keep `DaemonSessionProvider` but inject ACP events into its store via
`store.dispatch()` from an external `AcpEventInjector` component.

Rejected: `DaemonSessionProvider` also subscribes to SSE internally — two event
sources inject into one store → duplicate events. Cannot disable SSE subscription
without modifying the SDK.

---

## 7. Scope & implementation plan

### PR 0: Error taxonomy (prerequisite, ~300 lines)

- `packages/sdk-typescript/src/daemon/errors.ts`: `DaemonError`, `DaemonErrorKind`, `DaemonRpcError`
- `packages/sdk-typescript/src/daemon/DaemonClient.ts`: `DaemonHttpError extends DaemonError`
- `packages/webui/src/daemon/session/DaemonSessionProvider.tsx`: branch on `error.kind`
- Full backward compat: `DaemonHttpError` retains `.status`, `instanceof` still works

### PR 1: Extract RestSseTransport + DaemonTransport interface (~650 lines)

- `packages/sdk-typescript/src/daemon/transport.ts`: interface definitions
- `packages/sdk-typescript/src/daemon/RestSseTransport.ts`: wraps `globalThis.fetch`
- `packages/sdk-typescript/src/daemon/DaemonClient.ts`: accept optional `transport`
- `packages/webui/src/daemon/workspace/DaemonWorkspaceProvider.tsx`: thread transport prop
- **Zero behavioral change** — all existing tests pass unchanged

### PR 2: AcpHttpTransport (~1200 lines)

- `packages/sdk-typescript/src/daemon/AcpHttpTransport.ts`
- `packages/sdk-typescript/src/daemon/AcpEventDenormalizer.ts`
- `packages/webui/src/daemon/session/clientLifecycle.ts`: `transport.type` check

### PR 3: AcpWsTransport (~600 lines, deferrable)

- `packages/sdk-typescript/src/daemon/AcpWsTransport.ts`
- Reuses `AcpEventDenormalizer` from PR 2

### PR 4: Transport discovery (deferred, ~200 lines)

- Server: add `transports` field to `GET /capabilities`
- SDK: `DaemonTransport.negotiate()` static factory

---

## 8. Verification plan

1. **PR 0**: All existing tests pass. Provider terminates reconnect on auth failure
   with new `error.kind`.
2. **PR 1**: `npm run test` across sdk-typescript and webui — zero test changes.
   `new DaemonClient({ baseUrl, token })` produces identical behavior.
3. **PR 2**: Integration test connecting to real daemon via ACP HTTP. Both
   ChatView and TerminalView render from single transcript store.
4. **PR 3**: Same as PR 2 over WebSocket. Single connection, bidirectional.
5. **End-to-end**: Third-party app (agent-web) replaces 8 files with
   `transport={new AcpWsTransport(url)}`. Chat + Terminal in sync.

---

## 9. Risks

| Risk | Mitigation |
|------|-----------|
| ACP transports produce different event ordering | `AcpEventDenormalizer` produces identical `DaemonEvent` objects; transcript store dispatch is transport-agnostic |
| Browser `beforeunload` detach unreliable for WS | `navigator.sendBeacon` fallback to REST detach endpoint; server treats WS close as implicit detach |
| RFD changes before ratification | Transport implementations are behind `transport` injection; easy to revise without breaking consumers |
| `DaemonHttpError` naming is HTTP-specific | SDK is Stage-1 experimental; deprecation alias + rename to `DaemonError` can happen at Stage-2 boundary |
