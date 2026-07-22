# Session writer lease P0a

## Problem

A persisted session can currently be loaded by a second Qwen process while the original process is still producing and recording a turn. Both recorders cache the same parent UUID. When they append independently, the JSONL transcript gains two unmarked children from that parent. Resume follows the physical tail and can therefore hide the first process's complete answer.

The production incident had exactly this ordering: the original process recorded a tool result, the daemon fresh-loaded that session, the original process recorded the remaining tool work and final answer, and the daemon later recorded a user message using the earlier tool result as its parent.

## Scope

P0a establishes one cross-process writer for each ACP/daemon `(runtime base, session ID)` and protects the ordinary linear append path involved in this incident. It includes:

- an atomic owner-token lease with dead-process recovery;
- an authoritative transcript reload after lease acquisition;
- owner, file-identity, and byte-length fencing on every JSONL append;
- turn admission before user, cron, notification, and teammate work starts;
- reuse of an already-live session inside one daemon;
- owner-barrier reads for live transcript replay and Desktop history refresh;
- deterministic ACP/HTTP conflict errors; and
- lease draining and release on session close and failed initialization.

P0a does not make session switching, rewind, branch/fork, working-directory migration, archive/delete/rename maintenance, or transcript repair transactional. It also does not introduce an initializing registry entry that serializes every same-daemon load/resume against close; a repeated load reuses the owner after that owner is registered, while the cross-process lease still rejects a second writer during initialization. Full load/close outcome coalescing belongs to P0b. Session switching and persistence-root migration fail closed while an ACP Config owns a lease. ACP's logical working-directory change remains supported because it keeps the recorder and SessionService bound to the original persistence root. Same-owner rewind loads through that Config-pinned SessionService under the recorder write barrier; rename and branch retain their existing recorder or flush-before-copy paths. Daemon archive/delete and maintenance of non-live sessions retain their existing semantics. Concurrent maintenance from outside the live owner remains unsupported and is part of the P0b boundary. Interactive and headless CLI recorders retain their existing unleased behavior so `/clear`, `/resume`, `/branch`, and `/cd` do not regress; they must not write the same session concurrently with an ACP owner until P0b broadens the protocol.

## Invariants

1. At most one cooperating ACP process owns a session writer lease under a runtime base.
2. A leased ACP recorder is inactive until it owns the lease and has reloaded the transcript while holding it.
3. Preview data loaded before the lease is never the recorder's authoritative tail.
4. Every leased ACP append verifies the owner token and the expected transcript file identity, metadata, and byte length.
5. An ownership or transcript-integrity failure permanently rejects later top-level turns in that leased ACP Config.
6. A daemon never constructs a second writable Config for a session already live in that daemon.
7. A live entry is removed only after its recorder has drained and released the lease.
8. Runtime output roots are pinned per Config so the lock and transcript cannot resolve through different async workspace contexts.

## Lease protocol

The lock is stored at:

```text
<runtime base>/tmp/session-writer-locks/<encoded session id>.lock
```

Its immutable record contains a random owner token, PID, host, process kind, acquisition time, Qwen version, and (when available) a stable OS process-start identity. Linux uses the kernel boot ID plus the process start ticks, so wall-clock corrections cannot make a live owner appear stale. Darwin normalizes the process-start probe to the C locale and UTC so two processes with different environments compare the same identity. The identity distinguishes PID reuse when the platform exposes it reliably. A foreign-host owner and any state whose safety cannot be proven fail closed.

Acquisition creates a fully written temporary record and links it into the lock name atomically. A valid live owner returns `session_writer_conflict`. A valid dead local owner can be renamed, rechecked, and reclaimed. Reclaim guards form bounded owner generations so another process can recover if a reclaimer itself crashes. A malformed, symlink, or non-regular lock returns `session_writer_unavailable` rather than being guessed stale.

The lease snapshots whether the transcript exists, its file identity and metadata, and its byte length. `appendJsonLine` checks the immutable owner record and snapshot immediately before writing through the same file handle, then advances the expected state only after a successful durable append and post-write path verification. New transcript creation uses exclusive creation.

## Activation and close

An ACP `Config.initialize()` acquires the lease before extension, hook, tool, model, or scheduler initialization. While holding the lease it resolves active/archive state, reloads the active transcript when one exists, verifies that the transcript did not change during the reload, replaces any pre-lock preview, and activates the recorder. Non-ACP Configs continue through the legacy recorder path without acquiring this P0a lease.

Any later initialization failure closes the recorder and releases the lease. Normal shutdown and ACP session close finalize pending metadata, drain the recorder queue, release the owner token, and only then remove the live session entry. Cleanup is identity-checked so a failed older initialization cannot close a newer same-ID entry, and an unreturned Config whose first release fails is retried before the daemon creates another fresh session. A definitive child refusal leaves the session live so close can be retried. Close draining is bounded; a timeout or transport failure has an unknown result, so the bridge terminates the shared ACP channel and its process-owned leases become recoverable as stale. Other sessions on that channel are also reaped by that recovery action.

## Error contract

| Kind                         | JSON-RPC | HTTP | Meaning                                                 |
| ---------------------------- | -------: | ---: | ------------------------------------------------------- |
| `session_writer_conflict`    | `-32020` |  409 | Another live process owns the session.                  |
| `session_writer_lost`        | `-32021` |  409 | This Config no longer owns its lock.                    |
| `session_transcript_changed` | `-32022` |  409 | The JSONL changed outside the expected append sequence. |
| `session_writer_unavailable` | `-32023` |  503 | Ownership could not be verified safely.                 |

External responses use fixed messages and `errorKind`; they do not expose PID, host, owner token, lock path, or transcript path.

## Compatibility and rollout

The protocol only coordinates ACP binaries that understand it. Deployment and rollback must drain old ACP/daemon writer processes before the new version starts. Mixed-version ACP operation is not safe because an old writer ignores the lock. Concurrent interactive or headless access to the same persisted session remains outside P0a and is unsupported until P0b.

The runtime filesystem must support same-directory hard links with atomic no-replace behavior. If that prerequisite is unavailable, acquisition fails closed with `session_writer_unavailable`.

Existing branched transcripts are not automatically repaired. P0a prevents a new stale-load branch after rollout; repair and explicit branch semantics remain separate work.

## Verification

Unit coverage exercises lock contention, dead-owner and crashed-reclaimer recovery, malformed and non-regular locks, concurrent and retryable owner-token release, truncated and externally changed transcripts, equal-length file replacement, UTF-8 byte accounting, recorder activation/fencing/close, authoritative reload, initialization cleanup, runtime-root pinning, turn admission, same-daemon replay reuse, disabled-recording compatibility, legacy interactive recorder behavior, and error sanitization. Darwin coverage also verifies that processes with different time zones derive the same owner identity. PID-reuse handling is implemented but is not claimed as test evidence because process-start probing is platform dependent.

A real two-process regression recreates the incident timing: process A holds the writer after a tool-result tail, process B is rejected before loading as a writer, A appends its final answer and closes, and B then acquires, reloads that final answer, and appends the next user record with the final answer as its parent.

Desktop coverage verifies that a writer conflict is surfaced to the user instead of silently replacing the requested persisted session with a fresh session. Live history refresh is served through the owner's write barrier and Config-pinned SessionService, including after a logical `/cd`.
