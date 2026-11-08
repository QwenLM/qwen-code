# Managed activation and inbox terminal identity lookup

[English](2026-10-26-managed-terminal-identity-lookup.md) | [简体中文](2026-10-26-managed-terminal-identity-lookup.zh-CN.md)

## Problem and current state

Issue [#13184](https://github.com/QwenLM/qwen-code/issues/13184) tracks growth of Managed state. The [bounded-retention design](2026-10-19-managed-session-bounded-retention.md) requires durable historical identity queries before any terminal state can leave memory. This is PR1 of that remaining work.

`FileManagedActivationStore` and `FileManagedSessionInbox` already preserve terminal results in their authoritative journals and snapshots. Opening them rebuilds every identity in memory. Duplicate admission consults those resident maps; there is no per-identity durable terminal lookup. Activation/inbox transition compaction does not bound the number of terminal identities.

These are single-process local adapters. Their consumers are `EmbeddedHarnessScheduler` and `ManagedPromptAdmissionController`; neither is wired into the public Hosted application. The native HTTP Session journal is a different store. This change does not claim to bound Hosted service memory or startup reads.

## Goals and scope

- Materialize and read a complete immutable terminal result by its tenant, Session and activation/message identity.
- Preserve original normalized data, queue/admission position, timestamps, outcome, cancellation state and processing fence.
- Keep exact duplicate replay and conflicting identity refusal unchanged, including when current admission limits are full.
- Establish a usable durable query path without changing terminal commit acknowledgements.

Memory eviction, identity expiration, journal deletion, native Session snapshots, Java/HTTP APIs and automatic inbox completion are follow-up work. Resident maps and existing synchronous reads remain unchanged.

## Design

### Authority and index layout

The existing journal remains the sole authority. A sibling `<journal>.terminal-identities` directory contains derived immutable records. Each filename is the SHA-256 of the JSON-encoded identity tuple `[tenantId, sessionId, activationId/messageId]`. Activation and inbox records live beside their respective journals and include distinct record kinds.

Each version-1 record contains its kind, full identity tuple, original terminal snapshot and the snapshot's SHA-256 digest. Encoding uses the original journal-derived snapshot, never the retry's property order. A read must match the complete canonical expected record, including identity, type and digest. Missing files may be rebuilt only from an already validated journal terminal. Corrupt or conflicting files cause the lookup to fail; they are never treated as a new identity or silently overwritten.

An orphan side record cannot establish an identity absent from the journal, override an active state or restore a missing journal. The index is not independently authoritative. Future eviction must first introduce a durable completeness/publication boundary; these files alone do not permit eviction.

### Read-through and real consumers

Both adapters expose an asynchronous `readTerminal` lookup. It runs in the adapter's existing serial queue, validates and captures the requested identity, and returns no result for missing or non-terminal journal state. For a known terminal state it reads or materializes the per-key record and returns the original cloned snapshot.

The existing duplicate paths in `enqueue` and `admit` use the same read-through for terminal records after their current normalization, limit validation and deep-equality conflict checks. Non-terminal duplicates keep their existing path. Reordered object keys and normalized numbers continue to compare by the existing semantic rules; request JSON bytes are not an idempotency key.

This also preserves reconciliation: resubmitting an unfinished inbox entry whose activation is already released returns that original activation and cannot queue the effect again. Reconciliation still does not finish the inbox automatically.

### Publication and failure behavior

Materialization happens only during terminal lookup or duplicate replay. `release`, `cancelQueued`, `finish` and cancellation continue committing only their original journals. An index write failure therefore cannot turn an already committed terminal mutation into a reported release/finish failure.

The index directory is created with mode `0700`; records use `0600`. Parent/index directories must be real directories and leaf reads use the existing no-follow opener. A bounded read checks the expected record length before allocation. These checks preserve the trusted single-owner boundary; they do not establish isolation against a hostile same-UID process.

A record is written to a unique pending file, flushed, linked exclusively to its final name and followed by a directory sync on supported platforms. An existing final name is read and validated instead of replaced. Pending files are removed in normal cleanup and never consulted as results. A crash may leave an ignored pending file; repeated process crashes can accumulate these files, and orphan reclamation remains follow-up work.

A failed query rejects without changing the authoritative journal, admission counters or resident result. A missing derived file is rebuilt on a later query; conflicting/corrupt data continues to reject. No new availability fallback or terminal-transition retry behavior is introduced.

## Affected components

| Component                            | Change                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------ |
| `managed-terminal-identity-store.ts` | Shared derived index, bounded validation and immutable publication.      |
| `managed-activation-store.ts`        | Serialized terminal lookup and released-identity duplicate read-through. |
| `managed-session-inbox.ts`           | Serialized terminal lookup and finished-message duplicate read-through.  |
| Focused store/admission tests        | Persistence, normalization, refusal, faults and reconciliation.          |

No dependency, configuration switch, migration or public protocol is added. Existing version-1 journals and version-2 transition snapshots remain readable by old and new code. Old code ignores the sibling index, which is safe because PR1 retains all authoritative identities.

## Validation and acceptance

- Confirm the installed global CLI cannot expose this internal adapter API, then use a direct adapter script for the baseline and local verification.
- Verify lookup and original-result replay after process restart for completed/failed activations, queued cancellation, finished inbox messages and cancellation without a processing fence.
- Verify normalized/reordered payload retries, conflicting payload/descriptor reuse, tenant/Session identity separation and duplicates while admission is full.
- Remove an index record and prove it is rebuilt from the original journal terminal. Corrupt or substitute a record and prove lookup rejects without another admission or effect.
- Inject pending write, file-sync, publication and directory-sync failures. Verify terminal journal mutations remain acknowledged independently, retry preserves the original result and pending records never become authority.
- Verify reconciliation against an already released activation cannot create another queued activation, and preserve existing FIFO/epoch/fence tests.
- Run affected package tests with strict unhandled-rejection handling, build, typecheck, bundle, changed-file lint/format and two clean self-audit passes followed by independent review.

Acceptance is a durable per-key terminal query used by actual duplicate paths. Constant service memory, bounded startup replay, physical history reclamation and independently authoritative archive queries are not acceptance claims for this PR.

## Risks and follow-up

The index duplicates terminal bytes on disk and adds I/O to terminal duplicate replay. Its records include private inbox payloads, so the directory remains local and private. Index corruption can make a duplicate query fail while its journal remains valid; there is no automatic destructive repair.

Before memory eviction, persist a completeness boundary that proves which terminal identities have safe durable query results, migrate historical consumers, and define crash recovery and missing-index behavior after eviction. Native snapshot/HTTP/local replay and the authority window remain the later PRs. The complete #13184 tracker stays open.

## Open questions

None for this bounded local-index slice. Archive authority, eviction and reclamation are intentionally deferred decisions.
