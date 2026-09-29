# Managed Agent Gateway Bootstrap P4

> Historical milestone: P7 removed this non-authoritative bootstrap response.
> The active path starts the authoritative Gateway model immediately and waits
> for Runtime only if that model emits a local Tool Call.

## Status

P4 is an experimental, single-process vertical slice that makes the first
useful model response independent of a live ACP Session Runtime. It extends the
durable admission and bounded embedded Harness from P1-P3; it does not replace
the existing Session API.

The implementation is enabled only by `qwen serve
--experimental-managed-agents`.

## Experience contract

```text
POST /managed/sessions
  -> durable admission and HTTP 202
  -> resident Gateway model starts immediately
  -> Session Runtime starts concurrently
  -> GET /managed/sessions/:id/events streams both stages
  -> Runtime becomes ready
  -> original Prompt + bootstrap context continue in the same logical turn
  -> authoritative Runtime answer completes the stream
```

The bootstrap output is explicitly non-authoritative. It may analyse the
request, explain what will happen next, or ask the user to wait while the local
environment starts. It cannot claim that it inspected files, called tools, or
completed the task. The Runtime stage owns Tool Calls and the final answer.

The Gateway model receives no Tool declarations. Model-provider credentials
remain in the resident service process. The Runtime continues to use the
existing ACP child in P4, so it still contains a second model loop; making that
Runtime Tool-only is a later protocol migration, not a property claimed here.

The P4 Managed API covers this first logical turn only. It does not yet bind the
Managed client identity to a follow-up-turn API after handoff; durable multi-turn
continuity is the next control-plane slice.

## Admission

The create request requires:

- `Idempotency-Key`: stable identity for the first logical turn;
- `X-Qwen-Managed-Client-Id`: caller identity used to authorize status and
  event reads inside the authenticated daemon boundary;
- a non-empty Prompt containing text and inline raster images only;
- an optional existing workspace `cwd` selecting the future Runtime owner.

The Gateway derives tenant identity from the resolved workspace runtime. The
workspace id is only a local prototype tenant key; a production multi-tenant
service must derive tenant and workspace identities from authenticated control
plane claims rather than paths or request fields.

A deterministic RFC UUID is derived from workspace id and idempotency key so a
retry addresses the same future Runtime Session. Reusing the key with different
Prompt or client data fails with HTTP 409. Durable capacity remains bounded by
the P3 global and per-workspace limits.

The Runtime spawn must create that future Session exclusively. If it attaches
to a pre-existing Session, returns a different id, or resolves under a different
workspace, the Gateway detaches without dispatching the Prompt and fails the
turn. The Runtime's internal client id is never exposed on the Managed API.

## Events

The Gateway maintains a bounded event ring for each admitted P4 Session. Every
event has a monotonic id and one of these types:

```text
accepted
bootstrap_started
bootstrap_thought
bootstrap_delta
bootstrap_completed
bootstrap_failed
runtime_starting
runtime_ready
runtime_event
completed
failed
```

`runtime_event` carries the existing bridge event inside its `event` field,
after applying the same full-Skill-detail redaction as the SDK SSE boundary and
removing the Runtime's internal originator client id. Clients reconnect with
`Last-Event-ID`. Falling behind the bounded ring returns a terminal
`stream_gap` event and requires a status/read-model resync. The preview ring is
capped by both event count and serialized bytes; an individual event too large
for the preview surface is replaced with a `stream_gap` marker without stopping
the underlying Runtime.

## Same-logical-turn handoff

Runtime provisioning and bootstrap inference begin concurrently. The handoff
waits for both to settle, then sends one authoritative Runtime Prompt containing
the original user content plus the completed bootstrap response. The handoff
instruction tells the Runtime that the bootstrap is non-authoritative context,
not a second user request, and that it must continue the original task and
produce the final answer.

This avoids waiting for a second or third user message. It does not attempt to
migrate an in-flight model stream. P4 has two bounded model calls in one logical
turn; the first optimizes useful TTFT and the second owns tools and completion.

## Failure semantics

- Bootstrap failure does not cancel Runtime provisioning. The Runtime receives
  the original Prompt with an empty bootstrap context and can still finish.
- Runtime provisioning failure terminates the logical turn as failed; a
  bootstrap message is never promoted to a final answer.
- Client event-stream disconnect does not cancel admitted work.
- Deadline expiry aborts bootstrap and handoff. The existing ACP provisioning
  call is not cancellable in P4, so the Gateway stops waiting for it and
  best-effort closes a Session that becomes ready after the deadline.
- A crash after Runtime dispatch remains at-most-once: P3 recovery marks the
  ambiguous activation failed instead of replaying possible model or Tool side
  effects.
- P4 event rings are process-local preview state. Durable Prompt status remains
  authoritative after restart; durable assistant deltas and unified replay are
  a production follow-up.

## Capacity and isolation

P4 uses the same four asynchronous Harness slots, 64 global unfinished-message
limit, 16 unfinished messages per workspace, tenant-fair scheduling, and RSS
headroom gate as P3. A slot is an asynchronous activation, not a process,
thread, or Pod. Session Runtime processes remain independently bounded by the
existing daemon limits.

## Exit criteria

1. A create request returns before `spawnOrAttach` resolves.
2. Bootstrap model output is observable while Runtime startup is still pending.
3. Runtime startup and bootstrap inference overlap in wall-clock time.
4. The eventual Runtime Prompt preserves the original Prompt and bootstrap
   context and produces one authoritative terminal.
5. An identical retry does not start a second model call or Runtime Session.
6. Existing `/session` and `/session/:id/prompt` behavior is unchanged when the
   experiment is disabled.
