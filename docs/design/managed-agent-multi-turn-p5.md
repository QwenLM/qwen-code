# Managed Agent Multi-Turn Continuity P5

## Status

Historical design only. P7 retains P5's durable binding and multi-turn API but
removes its Runtime-owned model turns; the resident Gateway is authoritative
for every turn and the Runtime is Tool-only.

P5 extended the experimental Managed Gateway prototype from one logical turn to
sequential multi-turn Sessions. It remains opt-in behind `qwen serve
--experimental-managed-agents` and does not change the existing Session API.

P4 closes first-Prompt TTFT but exposes no Managed write API after its terminal.
Clients therefore cannot continue the conversation without falling back to an
unrelated live-Session surface and acquiring an internal Runtime client id. P5
closes that control-plane gap while retaining P4's two-stage first turn.

## Experience contract

```text
POST /managed/sessions
  -> resident Gateway model and Runtime startup overlap
  -> first authoritative Runtime turn completes

POST /managed/sessions/:id/prompts
  -> durable admission and HTTP 202
  -> reuse the same live Runtime Session when possible
  -> otherwise resume the persisted Runtime Session after a daemon restart
  -> send the follow-up Prompt directly to Runtime
  -> append the turn to the same status and event stream
```

Only the first turn uses the resident bootstrap model. Follow-up turns already
have a Runtime and therefore skip the bootstrap stage. The Runtime remains the
only stage with local tools and the only source of authoritative final answers.

## Durable binding and authorization

The first durable Gateway message establishes an immutable binding between the
Managed Session, workspace, and caller identity. The
service rebuilds this index from the inbox journal on restart. A follow-up route
accepts only `prompt` and optional `deadlineMs`; workspace, tenant, model, and
internal Runtime client identity are never accepted from the request body.

`X-Qwen-Managed-Client-Id` must exactly match the durable binding. A missing,
unknown, or mismatched binding returns the same not-found response so the route
does not disclose another caller's Session existence.

Each message still requires an `Idempotency-Key`. Repeating a durable message
with identical data returns its existing result without dispatching again.
Reusing a key with different data fails closed.

## Sequential turn ownership

P5 deliberately supports one unfinished Gateway turn per Managed Session. A
different Prompt admitted while an earlier turn is admitted or processing is
rejected with HTTP 409 and `Retry-After`. This is a conversation-ordering rule,
not a global execution lock: other Sessions continue through the bounded
asynchronous Harness slots.

The check and durable admission are serialized inside the single-process inbox
owner so two concurrent requests cannot both pass. A later turn is admitted
after the earlier durable message reaches a terminal state. The process-local
event broker independently rejects overlapping current turns as defense in
depth.

## Runtime reuse and restart recovery

The daemon keeps an opaque process-local Runtime binding containing workspace,
bridge, Session id, and daemon-issued client id. After the first exclusive
spawn, subsequent turns validate the live Session source, workspace, and client
heartbeat before reuse.

If the cached binding is absent or stale, the daemon resolves the workspace only
from the durable Managed binding and calls `resumeSession` with the stable
creator attribution `sourceType=managed-gateway` and `sourceId=<sessionId>`.
The returned Session metadata must match all three identities before dispatch.
A late restore after deadline is detached or closed best-effort. Internal client
ids never cross the Managed API boundary.

P5 does not move a Runtime between workspace processes or Pods. A production
control plane can replace the local workspace registry with placement lookup,
while retaining the same durable binding and fail-closed ownership contract.

## Unified events

The event ring is Session-scoped and survives multiple turns within the daemon
process. A newly admitted turn resets current phase, Runtime readiness, preview
text, and failure, while preserving prior ring entries and monotonic event ids.
Every accepted and terminal event includes the Prompt id. Subscribers can
reconnect with `Last-Event-ID` and continue across turn boundaries.

The ring remains a bounded process-local preview. Durable message status is the
restart authority; durable assistant output replay remains outside P5.

## Component changes

| Layer             | Change                                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| Durable inbox     | Enumerate cloned journal snapshots so startup can rebuild Managed Session bindings.                      |
| Admission service | Persist turn kind, rebuild immutable bindings, serialize check-plus-admit, and reject overlapping turns. |
| HTTP Gateway      | Add the follow-up route and derive all ownership fields from the durable binding.                        |
| Event broker      | Advance one Session through sequential current turns while retaining its bounded monotonic event ring.   |
| Runtime dispatch  | Cache and heartbeat live Runtime clients, otherwise resume and validate the bound Session.               |
| Rate limiting     | Charge follow-ups to the existing Prompt tier.                                                           |

The implementation changes the managed-runtime inbox in Core and the Managed
Prompt, Gateway route, event broker, daemon wiring, and focused tests in CLI.
It adds no new package, process, Worker thread, Pod abstraction, or public
configuration.

## Failure semantics

- An active different turn is retryable and is not durably admitted.
- A wrong client, missing binding, removed workspace, cwd mismatch, untrusted
  workspace, or mismatched Session source fails closed without Runtime dispatch.
- A stale cached client triggers one verified restore path; it never falls back
  to the primary workspace or an unrelated live Session.
- Restore and Prompt deadlines stop waiting. Any unabortable late attach is
  cleaned up best-effort.
- At-most-once recovery remains unchanged: a recovered `processing` activation
  is marked ambiguous and is never replayed.

## Exit criteria

1. A completed first turn accepts a follow-up on the same Session id.
2. The follow-up skips the resident Gateway model and sends the raw Prompt once.
3. A live Runtime and internal client are reused after validation.
4. A daemon-local cache miss resumes and validates the persisted Session.
5. Exact retries never rerun model, spawn, resume, Prompt, or tools.
6. Concurrent different turns for one Session produce one admission and one
   retryable conflict.
7. Existing APIs and disabled-mode behavior remain unchanged.

## Scope boundaries and open questions

P5 remains a single-daemon prototype. Its workspace id is only a local tenant
key, its event preview is not durably replayable, and its ACP Runtime still owns
a second model loop rather than a Tool-only execution protocol. Production
placement, authenticated tenant claims, durable output replay, distributed
leases, and the model/Tool protocol split remain later stages.

The main open design question is where a production control plane stores the
Session-to-Runtime placement record. P5 intentionally keeps that lookup behind
the durable binding plus workspace registry so a later remote scheduler can
replace placement without changing the Managed client contract.
