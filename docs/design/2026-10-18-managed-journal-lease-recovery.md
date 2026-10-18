# Managed journal recovery after a lapsed writer lease

- Status: implemented
- Issue: #13650

## Problem

A Hosted Session renews its journal activation through the Session Store. When
the control plane is down longer than the writer lease, the renewal commit
cannot be acknowledged. The local authority treats any append failure as proof
that the log may hold a half-written transaction, latches `writeFailure`, and
answers every later append with `ManagedSessionWritesStoppedError` — a 503 that
outlives the outage. The durable journal is intact; only the local writer is
dead, and nothing asks the Store again.

## Decision

Treat a writer lease that lapsed under an outage as recoverable by design. The
durable head, not the expired grant, decides whether an append landed.

The journal handle gains an optional settlement step. A Store that can prove the
answer from its head implements `settleAppend()`; the local JSONL journal does
not, and keeps its existing fence.

## Rules

- **Unknown outcome, not death.** Transport failures, 429, 5xx, and a `409` from
  an expired writer lease raise `ManagedSessionAppendUnsettledError`. The
  authority keeps the exact records it attempted and latches nothing.
- **Settle before the next append.** The next commit asks the journal which of
  two things is true:
  - the head is still at the pre-append revision: the attempt is `absent`;
  - the head is one revision ahead and its record digest is the attempt's:
    the transaction `landed`, and the authority applies the same events and
    marker through the normal post-commit path.
    A head that advanced by any other transaction is fatal: this writer lost the
    log and the Session needs a takeover.
- **Re-acquire, then read.** A lapsed grant is replaced with a fresh
  acquisition before the head is read. If the acquisition fails, the expired
  grant is restored so a later settlement can retry instead of finding a
  writer-less handle.
- **Definite failures still fence the log.** A rejected commit stays
  retriable without latching. A spent tenant-guard budget, a malformed receipt,
  a regressed head, and a fence by another writer remain terminal.
- **No renewal backlog.** The activation renewal timer skips a tick while its
  previous renewal is still in flight, so a stalled Store call cannot queue one
  renewal per interval for the whole outage.
- **No duplicate application.** The settlement path and the normal append share
  one post-commit function, including the extension-record apply callback, so a
  landed transaction advances the authority exactly once.

## Flow

1. The renewal commit fails with an unknown outcome; the client keeps the
   record digest and the pre-append revision, and the authority keeps the
   transaction.
2. The next renewal tick settles: acquire if the lease lapsed, then read the
   head.
3. `absent` retries the renewal; `landed` applies the recorded transaction and
   the following renewal is a no-op; a foreign head fences the Session.

## Tests

- `packages/core/src/managed-runtime/http-managed-session-store.test.ts`
  - outage longer than the writer lease re-attests and accepts a user Turn;
  - a renewal that landed before its acknowledgement was lost is applied once;
  - a journal whose append position holds another writer's transaction is
    fenced by the settlement;
  - a lapsed lease with a spent guard budget still fences the log;
  - a permanent fence still stops keepalive.
- `packages/core/src/managed-runtime/managed-session-assembly.test.ts`
  - activation renewals do not stack behind one in flight.

## Non-goals

- Automatic takeover of a journal another writer advanced.
- Changing the local JSONL journal's crash semantics.
- Reworking the control plane's lease protocol.
