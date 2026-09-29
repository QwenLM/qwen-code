# Managed Agent Live Prompt P3

## Status

Historical design only. P7 removed this route and its existing-Session dispatch
branch so the experimental surface has one authoritative execution model:
`/managed/sessions` with a resident Gateway model and Tool-only Runtime.

P3 was the first user-runnable Managed Agent path. It mounted an explicit,
experimental daemon route that durably admits a Prompt through the P2 Session
inbox, schedules it on the P1 embedded Harness, and then dispatches the real
turn through the existing ACP bridge and configured model.

The existing `POST /session/:id/prompt` route remains unchanged.

## Experience contract

When `qwen serve --experimental-managed-agents` is enabled:

```text
POST /session/:id/managed-prompt
Idempotency-Key: caller-stable-id

202 after user.message readiness + activation are flushed
  -> embedded Harness slot
  -> wait for the live Session owner
  -> bridge.sendPrompt with the same prompt id
  -> real model/tool turn
  -> fenced inbox terminal
```

The response carries the ordinary `promptId`, `lastEventId`, and `eventEpoch`
fields plus `managed: true` and the durable inbox state. Clients consume the
same Session SSE stream used by ordinary prompts. A companion status route
exposes the durable Harness state throughout admission, processing, and
completion.

## Scope and restrictions

The experimental route:

- requires a bounded caller-supplied `Idempotency-Key`;
- keeps the first admission's absolute deadline when an identical request is
  retried; changing content, client, or other identity requires a new key;
- uses the selected workspace id as the local prototype tenant boundary;
- accepts at most 257 text or inline raster image blocks, with no more than
  256 images;
- rejects attachment references, resources, delivery routing, trusted channel
  metadata, retry/continue controls, and unknown body fields;
- validates the client id against the live Session before durable admission;
- computes an absolute deadline from the configured server cap and any shorter
  request override, so Harness wait counts against the same wall-clock budget
  as execution; and
- does not cancel accepted work when the admitting HTTP socket closes.

The workspace id is not a production tenant identity. A shared service must
replace it with the identity from authenticated tenancy middleware before this
route can be called multi-tenant.

## Runtime wait and recovery

The Harness resolves the Session owner at execution time instead of retaining
the route's runtime object. This allows a workspace runtime generation to be
replaced between admission and execution. A missing owner is waited for with a
bounded, abortable poll; ambiguous, unavailable, or wrong-workspace ownership
fails closed.

P3 deliberately does not call `resumeSession()` itself. The current restore
route also restores worktree metadata, source metadata, archive coordination,
and internal Conversation ownership. Bypassing that orchestration from the
Harness could run tools in the wrong directory. After a daemon restart, the
client or normal Session load path must restore the Session; the pending
activation then observes the live owner and continues.

P3 never replays a message that had already entered `processing`. A process
death can happen after the bridge accepted the Prompt but before the inbox
recorded its terminal, and the bridge does not provide an atomic transaction
with this inbox. Recovery therefore fences the old worker, records the message
as failed, and does not call the model again. This trades possible loss for
at-most-once dispatch and prevents duplicate model/tool side effects. A future
recovery adapter may inspect the exact Prompt terminal and interrupted-turn
state to continue safely, but that downstream idempotency/continuation policy
remains a production gate.

## Capacity

The prototype keeps one long-lived service and a fixed pool of four async
Harness slots. It creates no process, Worker thread, or Pod per Session. The
inbox admits at most 64 unfinished Prompts globally and 16 per local tenant.

New claims stop when the daemon process RSS reaches 80% of its resolved memory
budget. A low-frequency unref'd capacity tick rechecks blocked work. This is a
root-process safety gate, not aggregate Pod accounting; child/container memory
must be supplied by the production deployment adapter.

## Failure semantics

| Failure                                     | Result                                                                                         |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Missing/invalid idempotency key             | Synchronous 400, nothing durable                                                               |
| Unsupported content or body field           | Synchronous 400, nothing durable                                                               |
| Unknown client/session                      | Existing authorization error, nothing durable                                                  |
| Inbox full                                  | Retryable 429, nothing new durable                                                             |
| Durable append/activation failure           | 500; same key may be retried                                                                   |
| Socket closes after durable admission       | Work remains accepted                                                                          |
| Session owner not live yet                  | Activation waits within its deadline                                                           |
| Owner ambiguous/unavailable/wrong workspace | Fenced failed terminal                                                                         |
| Admission deadline expires before dispatch  | Fenced failed terminal                                                                         |
| Daemon shuts down during dispatch           | Handler writes no false terminal; recovery fences it failed without replaying the model        |
| Model/bridge turn fails                     | Inbox and activation finish as failed; ordinary turn terminal remains authoritative to clients |

## Exit criteria

- The feature is absent unless explicitly enabled.
- Route tests prove validation occurs before persistence and duplicate keys are
  idempotent.
- Service tests prove durable ACK precedes dispatch, slot bounds hold, deadline
  expiry prevents dispatch, shutdown leaves the message fenced, ambiguous
  recovery never replays the model, and successful/failed turns write matching
  fenced terminals.
- A daemon E2E sends a real configured-model Prompt through the experimental
  route and observes the correlated terminal on the normal SSE stream.
