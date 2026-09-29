# Managed Agent Prompt Admission P2

## Status

This document defines the durable user-message admission seam between the P1
embedded Harness scheduler and a future live daemon Prompt route. P2 makes the
complete user input authoritative before an activation can be acknowledged.
It does not yet change `POST /session/:id/prompt`.

## Verified current boundary

The current daemon Prompt route calls `AcpSessionBridge.sendPrompt()` before
returning HTTP 202. The bridge synchronously reserves a per-Session queue slot
and appends an `in_flight` Prompt-ledger record, but that ledger intentionally
contains no Prompt content. The complete user message is recorded by the ACP
child only after the Prompt reaches the head of the FIFO and begins dispatch.

Moving the existing callback behind a durable activation queue without another
store would therefore be unrecoverable: after a daemon restart the scheduler
could know that work existed while having no authoritative input to replay.

## Decision

Add a single-process append-only Session inbox with a recoverable three-step
admission protocol:

```text
fsync user.message.admitted (complete JSON payload)
  -> fsync user.message.activation_ready
  -> fsync activation.queued (P1 store)
  -> acknowledge admission
```

The message id is also the activation id. A retry with the same tenant,
Session, message id, and payload is idempotent. Reusing that identity with a
different payload fails closed.

This is a recoverable logical transaction, not a filesystem transaction across
two files. Its ordering guarantees that an activation never exists without its
payload or before the message is eligible to run. A crash after the message
append but before the readiness marker leaves a detectable message that startup
reconciliation marks ready and submits. A crash after readiness but before
activation submission produces the same safe idempotent submission.

The caller must retain and retry the same message id after an ambiguous network
failure. The future HTTP adapter must therefore accept an idempotency key; a
server-generated id that the caller never received is insufficient for exactly
once admission recovery.

## Durable message record

The inbox records JSON values rather than ACP types so Core does not depend on
the transport package. The live adapter will validate and canonicalize ACP
content before admission, then place only the fields required to reconstruct
the trusted bridge request in the payload.

The journal contains:

```text
user.message.admitted
user.message.activation_ready
user.message.processing
user.message.finished
```

Every append is newline-delimited JSON, owner-only at creation, and flushed
before the in-memory state changes. Startup replays complete lines, truncates
only a torn final line, and rejects malformed or inconsistent committed
history.

`user.message.processing` binds authoritative work to the P1 activation fence.
`user.message.finished` is accepted only from that exact Worker and epoch. A
newer epoch may replace an unfinished processing owner; a late older Worker
cannot finish the message.

## Admission bounds

The readiness marker is durable scheduling intent, not proof that the second
journal append has already happened. Reconciliation submits every unfinished
message idempotently, including already-ready messages, so it closes a crash
between the two files without letting the scheduler race ahead of readiness.

The inbox, not the activation journal, is the authoritative admission bound.
It limits all admitted-but-unfinished messages globally and per tenant. This
includes work already assigned to a Harness slot, preventing a fast scheduler
from making the queue-only count appear artificially small.

An idempotent duplicate is returned even when limits are full. A finished
message releases inbox capacity. The P1 activation queue should be configured
at least as large as the inbox limit; if activation submission still fails,
the message remains durably ready and startup reconciliation can retry it. The
HTTP adapter must not report success until both readiness and activation are
durable.

## Security and privacy

Unlike the Prompt terminal ledger, this inbox intentionally stores full user
input because it is the authoritative recovery source. The file is created
with mode `0600`, has a configured per-message byte bound, and rejects non-JSON
values, non-finite numbers, excessive nesting, malformed identities, and
unexpected durable event shapes.

The live adapter must place the inbox under the daemon runtime directory, apply
the same tenant/workspace authorization before admission that the current
Prompt route applies before dispatch, and never persist provider credentials,
authorization headers, runtime leases, or untrusted internal metadata.

P2 does not add encryption or retention/compaction. Those are required before
a shared-host production deployment whose threat model does not permit
owner-readable plaintext Session transcripts.

## Failure semantics

| Failure                                   | Behavior                                          |
| ----------------------------------------- | ------------------------------------------------- |
| Inbox limit reached                       | Reject before writing a new message               |
| Duplicate identical message               | Return the existing state                         |
| Duplicate identity with different payload | Fail closed                                       |
| Inbox append or flush fails               | Do not mutate memory; halt later writes           |
| Activation submission fails               | Leave the durable message ready; return failure   |
| Crash before readiness                    | Reconciliation marks ready, then submits          |
| Crash after readiness                     | Reconciliation submits the stored message         |
| Crash after activation submission         | Duplicate submission is idempotent                |
| Stale Worker finishes                     | Reject without changing the authoritative message |
| Torn final record                         | Truncate it on open                               |
| Corrupt committed record                  | Fail startup closed                               |

An HTTP client can still observe an ambiguous outcome if the process dies after
durable admission but before the response arrives. Retrying the same message id
is the required resolution; the server must never silently generate a second
logical message for that retry.

## Implementation boundary

P2 adds:

- `FileManagedSessionInbox`, the authoritative user-message journal and fenced
  message state machine; and
- `ManagedPromptAdmissionController`, which submits deterministic P1
  activations and reconciles unfinished messages.

P2 intentionally omits:

- changes to the public daemon Prompt route or SDK;
- live Session restoration and bridge dispatch;
- direct Gateway model execution;
- Runtime provisioning or remote tool transport;
- cancellation, retention, compaction, encryption, and distributed storage;
- retry policy for a model turn whose durable downstream terminal is unknown;
  and
- multi-process access to either JSONL file.

## Exit criteria

Focused tests must prove:

- a complete JSON payload survives reopen;
- a torn tail is removed without losing earlier messages;
- corrupt committed history fails closed;
- identity conflicts and invalid JSON fail closed;
- global and per-tenant bounds include processing work;
- a finished message releases capacity;
- a newer epoch fences an older Worker;
- activation submission happens only after the message is readable;
- a crash-shaped unready message is readied and submitted on reconciliation;
  and
- duplicate activation submission does not create another message.

After these contracts pass, P3 can add an explicit experimental daemon route
that accepts a caller idempotency key, stores a sanitized bridge request in this
inbox, restores or resolves the owning Session runtime, and dispatches the real
model turn through the embedded Harness.
