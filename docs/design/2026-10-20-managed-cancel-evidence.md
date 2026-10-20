# Reconcile parked Turn cancellations from the original journal

[English](2026-10-20-managed-cancel-evidence.md) | [简体中文](2026-10-20-managed-cancel-evidence.zh-CN.md)

## Problem and current state

This follows #14700 for #14166 and #12380. That change preserves a CANCEL as `recovery_blocked` / `cancel_unconfirmed` when its original Turn failed after an unobserved execution. It deliberately leaves that operation out of the reconciliation scan. The public CANCEL promise remains stronger than task cancellation: completion means the Turn reached `cancelled`, rather than merely accepting a stop request.

The Hosted cancel handler aborts its active Turn before appending `requestCancel`, keyed by `hosted-cancel:<promptId>` with SHA-256 of the prompt ID. Consequently that request transaction is insufficient to prove successful cancellation, and its absence cannot prove that cancellation never took effect, even after the journal closes. The Session authority records the definitive result as a `turn.settled` event, with `eventId = turn:<promptId>` and the prompt ID in `payload.turnId`. The enclosing transaction is `settleTurn`; its command ID is a recorder UUID, so it cannot be found by a prompt-derived command hash.

## Changes and decisions

`CancelEvidence` joins the existing acceptance-evidence registry, and `CANCEL` joins the parked-operation scan. It resolves the original operation's immutable Turn target within its tenant and Session scope, verifies the hashed target identity, and reads that Session's managed journal. It never loads, attaches, calls, cancels or re-executes a Harness or Runtime.

The reader fixes a maximum journal revision from the managed Session head and pages backwards through `settleTurn` transactions, one transaction at a time. It validates each transaction's encoding, length and SHA-256, and matches the terminal event's subtype, event ID, prompt ID, tenant, Workspace and Session. The original Turn is used only for identity; its current status, epoch and failure code do not decide the verdict. Another prompt's result, or an event carrying a different scope, is never evidence for this operation.

| Durable evidence for the original prompt                                          | Verdict and operation result                                                        |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `turn.settled` with `outcome = cancelled`                                         | Committed: complete with `harness_confirmed`, `confirmed` and a receipt.            |
| `turn.settled` with `outcome = completed` or `error`                              | Not committed: fail with `turn_already_settled`, `java_durable` and `blocked`.      |
| No matching terminal event, an unsupported outcome or unavailable/corrupt history | Unknown: retain `cancel_unconfirmed` and wait for the existing five-minute recheck. |

A `requestCancel` record by itself remains unknown. Missing history remains unknown for `ACTIVE`, `SEALED`, `DELETING` and `DELETED` heads alike. Compaction never turns absence into a negative proof; retained positive terminal evidence remains usable. CANCEL commands already coalesce by Turn, so all cancellations parked before the same Turn's failure may resolve from its one authoritative terminal event. A cancellation submitted after Java recorded the terminal failure keeps #14700's definitive late-command result and is never reclassified.

Settlement uses the existing conditional parked-operation write. It cannot rewrite an operation settled since the scan, and restarting the service needs no in-memory state. The Java Turn's previously published recovery failure is retained; this reconciliation adds the subsequently provable cancellation result to the original command operation. It does not claim that another pending Runtime execution became known or authorize cleanup or storage release.

## Files and scope

The implementation adds `CancelEvidence`, extends the managed store's existing acceptance-unknown kind set, and tests the reader and settlement through the existing Turn-command H2/InnoDB suites. Public and WebShell contract descriptions explain the additional evidence path; no route, field, schema migration, delivery mechanism or client behavior changes. The English and Chinese designs and generated contract comments are synchronized.

This is an additive reader PR against current `main`, with #14700 as a required landing dependency. That separately reviewed change supplies the parking producer; this PR supplies only the evidence reader and its scan wiring. Its SQL tests seed the persisted parked CANCEL shape as the dependency contract, rather than copying the producer into this PR. The reader activates for rows produced by #14700 or compatible existing data. General journal compaction, recording a different cancellation command identity, physical Runtime acceptance and rewriting already published Turn history are outside this change.

## Validation and acceptance

The E2E plan is `.qwen/e2e-tests/managed-cancel-evidence.md`. The globally installed CLI is checked first, but it does not expose the Java operation reconciler. A deterministic Java/SQL test-script fallback exercises actual command admission, parked rows, journal bytes, evidence reads and durable settlement. The same tests run on H2 and a disposable MySQL 8.4 InnoDB database.

Acceptance requires a matching cancellation result to settle the original operation exactly once; a completed/error result to fail it honestly; unknown, corrupt, foreign and compacted-away evidence to stay parked; coalesced cancellations to resolve independently without a second effect; and late cancellations and other operation kinds to preserve their existing behavior. Java module verification, public contract gates, generated WebShell contract verification and relevant Hosted recovery checks must be reported separately from full deployment acceptance.

## Risks and open questions

A recorder UUID requires scanning the original Session's settlement transactions. Memory is bounded to one existing journal transaction, while scan work grows with retained Turn history. A future durable event index can improve lookup cost without weakening identity checks. A compacted-away terminal event cannot currently be recovered from snapshot evidence and remains parked; absence is never guessed into a final outcome. There is no unresolved protocol decision in this slice. Production crash/kill acceptance remains a separate required validation result, not inferred from SQL fixtures.
