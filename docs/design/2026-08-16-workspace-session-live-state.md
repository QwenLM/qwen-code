# Workspace Session Live-state Protocol

## Summary

Add a workspace-qualified, memory-only session live-state endpoint so clients
can stop polling the persisted session catalog for volatile status. The new
endpoint returns the complete set of live sessions for the selected trusted
workspace together with an in-memory catalog version. Clients poll this cheap
endpoint and reload `GET /workspaces/:workspace/sessions` only when the catalog
version changes or when a local mutation already requires a refresh.

This document defines the server protocol and implementation contract. The
server implementation and TypeScript SDK belong in one follow-up feature PR.
Web Shell adoption is a separate follow-up PR so the additive protocol can be
reviewed and shipped independently from client behavior.

## Motivation

`GET /workspaces/:workspace/sessions` is a persisted catalog query, not a live
status probe. Depending on its query shape and workspace history, it can scan
session JSONL files, read organization sidecars, paginate and filter persisted
metadata, and merge bridge-owned live state. The server has a two-second cache
and a conditional live-only fast path, but a workspace with persisted history
still needs the catalog path.

Polling that route to update `hasActivePrompt`, pending interaction state, or
client counts couples a small volatile-state requirement to the most expensive
session-list operation. Large or slow session stores can therefore turn a
routine sidebar refresh into a request timeout even though the daemon and its
ACP child remain healthy.

The protocol needs two independent signals:

1. A complete, memory-only snapshot of volatile state for live sessions.
2. An equality token that tells a client when its persisted catalog may be
   stale and a full session-list reload is warranted.

## Goals

- Serve high-frequency live-state reads without session storage, settings,
  external commands, or ACP round trips.
- Scope every read to the explicitly selected workspace runtime without a
  fallback to the primary runtime.
- Let clients merge volatile state without treating an absent live session as
  a deleted persisted session.
- Detect daemon-observed catalog membership and static metadata changes across
  tabs, controllers, scheduled work, and background session creation.
- Ensure a newly exposed catalog version cannot be followed by a cache hit for
  a catalog snapshot that predates that version.
- Preserve all existing session-list routes, pagination, filtering, timeouts,
  and compatibility behavior.

## Non-goals

- Changing the existing session-list deadline or scan implementation.
- Guaranteeing that the first full catalog load cannot time out.
- Replacing polling with SSE, long polling, or WebSocket subscriptions.
- Watching JSONL or sidecar files for writes made by another daemon, a TUI, or
  an external process.
- Persisting the catalog version across daemon restarts.
- Versioning ordinary transcript appends, model activity, or session ordering
  changes after every turn.
- Adding ETags, conditional requests, pagination, query filters, a feature
  gate, or a new readiness feature.
- Changing current display-name persistence or live/persisted merge behavior.

## Ownership and Trust

The route is **selected-runtime, workspace-scoped, trusted-only**.

It resolves the plural workspace selector through the current workspace
registry generation and reads only that runtime's bridge. It never falls back
to the primary runtime. The route must use the same strict trust gate as other
workspace-qualified live-runtime surfaces, not the persisted catalog resolver
that permits bounded reads from an untrusted secondary.

This distinction is required by the untrusted workspace catalog contract:
untrusted catalog reads may inspect persisted summaries but must not query or
merge the untrusted runtime's live bridge state.

## Public REST Protocol

### Request

```http
GET /workspaces/:workspace/sessions/live-state
```

`:workspace` is an existing workspace id or an encoded absolute workspace cwd,
using the same selector rules as other plural session routes.

The endpoint has no query parameters.

### Success response

```json
{
  "v": 1,
  "catalogVersion": {
    "generation": "7eca3164-bce1-4f50-94d8-c842c480f213",
    "revision": 17
  },
  "sessions": [
    {
      "sessionId": "session-123",
      "clientCount": 1,
      "hasActivePrompt": true,
      "isWaitingForPermission": false,
      "isWaitingForUserQuestion": false
    }
  ]
}
```

Every successful response includes:

```http
Cache-Control: no-store
```

### Response semantics

- `v` is the response schema version and is `1` for this protocol.
- `catalogVersion` is an equality token for daemon-observed catalog changes.
- `sessions` is the complete, unpaginated, unordered set of sessions currently
  live in the selected workspace runtime.
- `clientCount`, `hasActivePrompt`, `isWaitingForPermission`, and
  `isWaitingForUserQuestion` are required wire fields. Missing optional bridge
  values project to `0` or `false`.
- An empty live runtime returns `200` with `sessions: []`.

The response deliberately excludes workspace cwd, display name, timestamps,
prompt content, pending interaction contents, turn errors, source metadata,
organization, worktree metadata, branch metadata, tokens, and model state.
Those fields belong to the full catalog or other dedicated status surfaces.

The complete snapshot is intentional. A client needs absence to clear stale
volatile state for a known catalog row. The default live-session cap is 32, so
the usual response is bounded. If an operator disables the cap, endpoint cost
is proportional to the number of live sessions but remains independent of the
number and size of persisted session files.

## Catalog Version Contract

The bridge exposes an in-memory clock:

```ts
export interface BridgeSessionCatalogVersion {
  readonly generation: string;
  readonly revision: number;
}

getSessionCatalogVersion(): BridgeSessionCatalogVersion;
markSessionCatalogChanged(): void;
```

`generation` is a random UUID created with each bridge instance. It changes
when the daemon restarts or a workspace runtime replaces its bridge.
`revision` starts at zero and monotonically increases within that generation.

The pair is not a gap-free event sequence. Conservative extra increments are
allowed, and clients must not perform revision arithmetic or compare revisions
across generations. The only supported operation is equality over the whole
pair:

```text
same generation and revision  => no daemon-observed catalog change
different generation/revision => reload the full catalog
```

A generation component is required because a scalar revision can reset to the
same value after daemon restart or workspace runtime replacement.

The clock is intentionally daemon-local and non-durable. Writes made directly
to the session store outside the current daemon are not observed.

## What Advances the Revision

The catalog version covers membership and static catalog metadata. It does not
cover ordinary turn activity; volatile turn state is returned directly by the
live-state response.

| Event                                                             | Revision behavior                           | Ordering requirement                                                                                                        |
| ----------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Live entry registration                                           | Increment                                   | After the entry is installed in the bridge map                                                                              |
| Live entry removal                                                | Increment                                   | After the entry is removed; includes close, kill, crash, failed restore cleanup, and shutdown                               |
| Manual display-name change                                        | Increment only for an actual value change   | After updating bridge metadata and before publishing the metadata SSE event                                                 |
| Child auto-title notification                                     | Increment                                   | After validating the session and before publishing the metadata SSE event; the child notification follows title persistence |
| Live worktree summary update                                      | Increment when the target live entry exists | After updating the entry                                                                                                    |
| Persisted branch/fork commit                                      | Increment                                   | Immediately after a valid committed `newSessionId`, before any attempt to restore it as live                                |
| Archive, unarchive, or delete                                     | Increment conservatively                    | After cache invalidation; batch paths may increment from `finally` after a partial result                                   |
| Session organization update                                       | Increment after success                     | Invalidate active and archived catalog scopes first                                                                         |
| Group create/update/delete                                        | Increment after success                     | A delete that reports `deleted: false` does not increment                                                                   |
| Successful orphan or rollback persisted deletion                  | Increment                                   | After the persisted removal succeeds                                                                                        |
| Prompt admission, start, settle, deadline, or transcript append   | No increment                                | Live status carries the active state; clients may refresh on their own turn-complete signal if ordering matters             |
| Attach, detach, heartbeat, permission wait, or user-question wait | No increment                                | The live snapshot carries these values                                                                                      |
| Runtime or bridge replacement                                     | New generation                              | Revision restarts at zero                                                                                                   |

The persisted branch rule closes an important lifecycle gap. A branch can be
committed to storage without being restored as a live session, and a committed
branch remains valid even if the subsequent restore fails. Relying only on live
registration would make that catalog change invisible.

The bridge passes its internal mark function to `BridgeClient` through a new
optional final constructor callback. This captures child-side automatic title
notifications without changing existing direct constructor calls.

## Persisted Mutation Integration

Existing REST and ACP mutation helpers already invalidate portions of the
persisted session-list cache. Their catalog mutation ordering becomes:

```text
perform mutation
invalidate every affected active/archived cache scope
advance the selected runtime bridge's catalog revision
```

Archive, unarchive, and delete can partially commit before returning an error,
so their wrapper retains `finally` invalidation and also advances the revision
there. A false-positive increment is safe; a missed partial mutation is not.

Session organization and group mutations affect organized views for both
active and archived sessions, so successful writes invalidate both scopes
before advancing the revision. Direct persisted removals used by orphan,
scheduled-task, Live, and sub-session cleanup paths advance the revision after
successful deletion. Lifecycle removal may produce an additional increment;
the protocol explicitly permits this.

## Cache Consistency

The persisted session-list cache is process-global and keyed by runtime base
directory, workspace, and archive state. Invalidated in-flight loads may still
resolve to their existing waiter, but their generation check prevents them
from installing a stale cache value.

The live-state route maintains a registration-local:

```ts
WeakMap<AcpSessionBridge, BridgeSessionCatalogVersion>;
```

containing the last version successfully exposed for each bridge.

For each request the route performs, without an `await` between bridge reads:

1. Resolve and trust-check the selected active runtime.
2. Capture its generation assertion.
3. Read the bridge catalog version.
4. If the version differs from the last exposed value, synchronously invalidate
   both active and archived persisted catalog cache scopes.
5. Read `bridge.listWorkspaceSessions(runtime.workspaceCwd)` and project the
   minimal response fields.
6. Re-assert that the runtime generation remains open.
7. Record the successfully exposed version and return the response.

The first live-state request for a bridge also invalidates both scopes. An
unchanged high-frequency poll does not repeatedly invalidate the cache or
disturb a slow in-flight scan.

This ordering handles bridge-internal changes, such as automatic titles and
persisted-only branches, without coupling the ACP bridge package to the CLI
cache. Known REST and ACP catalog mutations continue to invalidate immediately
at their mutation sites.

## Client Consistency Handshake

An initial load, runtime replacement, or observed catalog version change uses:

```text
live-state A
full /workspaces/:workspace/sessions load
live-state B
```

- If `A.catalogVersion` equals `B.catalogVersion`, the catalog load is accepted.
- If they differ, the client marks the catalog stale and coalesces one more
  full reload. It must not enter a tight retry loop.
- A mutation before A is covered by A's pre-response cache invalidation.
- A mutation between A and B is detected by B, which invalidates before
  exposing the new version.
- A mutation after B is detected by the next live-state poll.
- Runtime replacement changes generation even when the new revision happens to
  equal the old value.

An absent live-state row only clears volatile fields such as active, waiting,
and client count. It never deletes a persisted catalog row. An unknown live
session id or a changed catalog version schedules a full catalog reload.

Clients that know they just created, archived, deleted, renamed, regrouped, or
completed a turn may still update local state and explicitly refresh as needed.
The server version is the cross-controller and background safety net, not a
replacement for local mutation feedback.

## Failure Semantics

| Condition                                                           | Response                                                                |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Trusted active primary or secondary runtime                         | `200` with live-state snapshot                                          |
| Any untrusted runtime                                               | Existing `403 untrusted_workspace` response                             |
| Unknown, malformed, nested, or unregistered selector                | Existing `400` selector-validation or `workspace_mismatch` behavior     |
| Bootstrapping, transitioning, draining, blocked, or removed runtime | Existing `503 workspace_runtime_unavailable` behavior and `Retry-After` |
| Runtime generation closes during the request                        | Existing generation-closed `503` mapping                                |
| Unexpected local error                                              | Existing bridge error `500` mapping                                     |

The route must never resolve an unknown selector to the primary runtime. It
does not invoke the permissive persisted catalog inspection policy for an
untrusted secondary.

## Capability and TypeScript SDK

Add an unconditional v1 capability:

```ts
workspace_session_live_state: {
  since: 'v1';
}
```

The capability is independent from `workspace_qualified_rest_core`; older
daemons with the broader workspace REST capability do not implement this new
route. The route remains subject to per-workspace trust checks even when the
global capability is advertised.

Add the following public TypeScript SDK shapes:

```ts
export interface DaemonSessionCatalogVersion {
  generation: string;
  revision: number;
}

export interface DaemonSessionLiveState {
  sessionId: string;
  clientCount: number;
  hasActivePrompt: boolean;
  isWaitingForPermission: boolean;
  isWaitingForUserQuestion: boolean;
}

export interface DaemonWorkspaceSessionLiveState {
  v: 1;
  catalogVersion: DaemonSessionCatalogVersion;
  sessions: DaemonSessionLiveState[];
}
```

Add:

```ts
DaemonClient.getWorkspaceSessionLiveState(workspaceCwd);
WorkspaceDaemonClient.getSessionLiveState();
```

Both methods use native REST, bearer authentication, encoded workspace
selectors, and the existing short-request timeout. They do not automatically
call `requireCapability()` because doing so on every poll would double request
volume. Consumers preflight `workspace_session_live_state` once from their
already-loaded capabilities and fall back to existing catalog behavior when it
is absent.

No ACP method or Java SDK surface is added in this phase.

## Implementation Boundaries

The implementation is one atomic feature PR containing:

- The bridge clock, lifecycle marks, persisted-branch mark, and automatic-title
  callback.
- The trusted workspace-qualified route and cache exposure ordering.
- Known REST and ACP catalog mutation marks.
- Capability registration and TypeScript SDK surface.
- Protocol, lifecycle, capability, and SDK documentation plus tests.

Splitting these pieces would temporarily publish an endpoint with an
incomplete version, or publish a clock that clients cannot discover and use.
The subsequent Web Shell PR only consumes the capability and protocol; it does
not redefine their semantics.

The REST and SDK changes are wire-additive. Adding required clock methods to
the exported `AcpSessionBridge` interface is a source-level contract change for
custom structural bridge implementations and complete test fakes. Every
production bridge in this repository is created by `createAcpSessionBridge`
and receives the implementation automatically; direct implementers must add
the two in-memory methods when upgrading. This migration must be called out in
the implementation PR's risk section rather than described as having no source
impact.

## Test Plan

### Bridge tests

- Initial version is stable; separate bridge instances have different
  generations.
- Registration, removal, actual rename, automatic title, worktree update, and
  public marks advance revision.
- A no-op rename does not advance revision.
- A persisted-only branch advances revision without a live registration.
- A committed branch followed by restore failure still advances revision.
- A failed branch mutation does not advance revision.
- Prompt start/settle, attach/detach, heartbeat, and waiting-state transitions
  do not advance revision.

### Route and ownership tests

- The exact v1 response contains no extra session-summary fields and always
  supplies all live booleans and `clientCount`.
- Empty and multi-session snapshots are complete and unpaginated.
- Successful responses include `Cache-Control: no-store`.
- Trusted primary and secondary selectors read only their selected bridge.
- Every untrusted runtime returns 403 before any bridge method is called.
- Unknown selectors never fall back to primary; unavailable generations retain
  existing 503 semantics.
- The route does not instantiate `SessionService`, load settings, inspect
  storage, invoke external commands, or call an ACP child.

### Cache and race tests

- First exposure, a new revision, and a new generation invalidate both active
  and archived scopes.
- Repeated exposure of the same version does not invalidate again.
- An invalidated in-flight load cannot install its result as a current cache
  entry.
- `live A -> in-flight list -> mutation -> live B -> retry` returns a catalog
  from the new cache generation.

### Mutation tests

- REST and ACP archive, unarchive, delete, organization, and group writes
  invalidate and advance with the declared success/partial-result semantics.
- Successful orphan, scheduled-task, Live, and sub-session persisted cleanup
  advances revision.

### SDK and capability tests

- Workspace cwd is URL encoded correctly for top-level and scoped clients.
- A live-state SDK call makes exactly one HTTP request and does not perform a
  capability request.
- Types are exported through the daemon and root public surfaces.
- Capability registry, advertised features, and capability documentation stay
  synchronized.

### E2E and fault injection

1. Create a workspace with many or large persisted session files, or block a
   persisted scan.
2. Send concurrent live-state requests and verify they remain independent of
   the blocked scan, do not spawn an ACP child, and do not change the daemon or
   qwen process identity.
3. Exercise create, persisted-only branch, rename, organization, archive, and
   delete; verify the catalog version changes.
4. Exercise active, waiting, and client-count changes; verify the response body
   changes while catalog version remains stable.
5. Replace a workspace runtime and verify generation changes.
6. Verify the client handshake recovers from a mutation during an in-flight
   full catalog load.

## Acceptance and Rollout

The server PR is additive and ships without a feature flag. Rollout follows the
normal daemon release path, with clients gated by the capability.

Acceptance requires:

- Live-state latency and work are independent of persisted session count and
  JSONL size.
- A blocked persisted scan does not delay direct live-state responses.
- No live-state request starts an ACP child, reloads settings, executes a
  command, or drives daemon lifecycle.
- Every known catalog mutation is visible as a new version no later than the
  next live-state request.
- A new version is never exposed before old active and archived catalog cache
  generations are invalidated.
- Existing clients and all existing session-list shapes remain wire-compatible.

No custom success log is added for the high-frequency route. Existing HTTP
route count, latency, and failure telemetry is sufficient. Canary validation
compares live-state latency and error rate with session-list scan count and
confirms that client adoption reduces periodic full catalog requests without
increasing ACP child or daemon restart activity.

## Rejected Alternatives

### Continue polling the full session list

This retains the coupling between volatile state and persisted scanning and is
the failure mode this protocol is intended to remove.

### Add the version or an ETag to the existing session-list response

The server would still need to execute the expensive catalog path before it
could compute or return the response. It also would not provide the current
live-state snapshot needed by the client.

### Reuse the conditional live-only session-list fast path

That path is conditional on persisted history and request shape, returns the
full session-summary surface, participates in pagination, and has no stable
version contract.

### Use SSE, long polling, or WebSockets

Push delivery introduces connection lifecycle, replay, backpressure, and
reconnection semantics that are unnecessary for a small two-second status
snapshot. The polling endpoint is deliberately stateless.

### Watch session storage

`fs.watch` adds platform-specific event semantics, unknown-writer races,
coalescing, and lifecycle management. The first version explicitly covers
daemon-observed mutations only.

### Persist a global catalog revision

Durability adds storage migration and multi-process coordination without
benefit to a client that must re-establish state after daemon restart anyway.
The generation UUID makes the in-memory clock restart-safe.

### Include static catalog metadata in live-state

Duplicating titles, timestamps, organization, and source metadata would create
a second catalog protocol and increase the payload and invalidation surface.
The endpoint is only the volatile overlay plus a signal to reload the canonical
catalog.
