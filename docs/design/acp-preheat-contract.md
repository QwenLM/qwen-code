# ACP preheat contract and compatibility

## Context

The daemon exposes `POST /workspace/acp/preheat` and
`GET /workspace/acp/status`, but released clients cannot discover those routes
through `/capabilities`. The TypeScript SDK also sends both calls through its
active ACP transport by default even though they are daemon REST control-plane
routes. Finally, an HTTP waiter that times out currently clears the workspace
service's shared preheat promise while the underlying channel initialization
continues.

This change makes the existing primary-workspace routes discoverable and
reliable. It does not introduce a durable readiness state or move the first
Session barrier. A Session remains the authoritative operation: preheat and
Session creation coalesce through the bridge's shared channel initialization,
and Session creation revalidates the channel after any point-in-time status or
preheat response.

## Capabilities and scope

The daemon advertises two always-on v1 capability tags:

- `workspace_acp_preheat` for `POST /workspace/acp/preheat`
- `workspace_acp_status` for `GET /workspace/acp/status`

Each tag means that the named route contract exists. Neither tag says that the
ACP channel is currently live. The routes remain singular and primary-
workspace-only. Clients must not use them for a secondary workspace or fall
back from a secondary workspace to the primary runtime.

Workspace-qualified ACP warmup requires separate ownership, trust, draining,
and resource-limit semantics and is outside this change.

## Response semantics

`GET /workspace/acp/status` returns a point-in-time snapshot:

```ts
{
  channelLive: boolean;
}
```

`POST /workspace/acp/preheat` preserves its existing response shape:

```ts
interface WorkspaceAcpPreheatResult {
  ready: boolean;
  channelLive: boolean;
  durationMs: number;
  reason?: 'timeout' | 'error';
  error?: string;
}
```

The following invariants apply:

- `ready` always equals `channelLive`.
- A live snapshot returns `ready: true` without `reason` or `error`.
- A waiter timeout returns `reason: 'timeout'` only if the channel is still not
  live when the response is built.
- A failed initialization, or a resolved preheat that did not produce a live
  channel, returns `reason: 'error'`.
- `durationMs` is a finite, non-negative integer measured with a monotonic
  clock. It is the current HTTP call's elapsed time, not the lifetime of a
  shared initialization that the call may have joined.
- Client-visible error text is stable and sanitized. Detailed child-process
  errors remain in daemon logs.

Operational timeout and initialization failure continue to use HTTP 200 so
existing clients can inspect the result. Invalid input, authentication, rate
limit, and deferred-runtime startup failures retain their existing HTTP error
contracts.

## Concurrency and failure behavior

The workspace service keeps one shared preheat promise until that promise
settles. Every request races the same promise against its own timeout. A waiter
timeout ends only that request; it neither cancels the bridge operation nor
clears the shared promise. Settlement clears the promise only when its identity
still matches the current shared operation, so an older completion cannot erase
a newer attempt.

Once the shared operation settles, a later request may retry if the channel is
not live. A channel that exits after a successful response is not covered by a
lease: status reports the new snapshot and the next Session or preheat starts a
new channel.

## Client compatibility

The TypeScript SDK sends both routes through its REST fetch path regardless of
the configured ACP transport. It does not automatically fetch capabilities;
callers decide when to preflight.

The Web UI uses the routes only in its deferred, no-session bootstrap flow. It
requires `workspace_acp_preheat`, gates the optional status optimization on
`workspace_acp_status`, and requires the effective workspace to exactly match
`capabilities.workspaceCwd`. An exact comparison can conservatively skip a
preheat for an alternate spelling of the primary path, but it cannot warm the
wrong runtime.

If an older daemon omits the capabilities, the Web UI makes no ACP status or
preheat request and the first Session follows the existing lazy initialization
path. Preheat failure remains best-effort and cannot fail connection or Session
creation.

## Non-goals

- Awaiting preheat before the first Session
- Moving preheat earlier in daemon or Web UI startup
- A readiness lease, generation, token, or protocol-version bump
- Cancelling shared channel initialization when an HTTP waiter times out
- Workspace-qualified ACP preheat or status routes
- Claiming a latency improvement from this contract-only change
