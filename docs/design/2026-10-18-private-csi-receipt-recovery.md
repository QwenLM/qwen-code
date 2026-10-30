# Recover a receipt-complete private CSI turn

[English](2026-10-18-private-csi-receipt-recovery.md) | [简体中文](2026-10-18-private-csi-receipt-recovery.zh-CN.md)

Status: implemented candidate for Draft review. This change follows PR #14487
and extracts the first cold-recovery cut from cumulative PR #13526. Bounded
local CLI/H2/MySQL and actual private attachment checks pass; complete K2
recovery, OS-process-crash and deployed CSI qualification remain open.

## Problem and current behavior

The original private Hosted file caller can finish Read/Write/Edit, retain the
complete outcomes and commit their receipts. If its process stops before all
original result messages and checkpoints are committed, another Hosted process
cannot continue: private SQL admission refuses replacement writers and the
caller requires a new journal with writer generation and activation epoch 1.
Repeating file operations is unsafe because an existing write may have completed.

PR #14487 remains the base until it merges. Its normal execution, durable refusal
results, complete-result capacity checks and final-output fixes are prerequisites
and must survive this extraction.

## Scope and required behavior

Support one original no-deadline prompt with one accepted file batch after every
related execution is SETTLED, has an immutable grant and complete success/error
result, and has its original durable receipt. Both the old writer lease and old
activation must have expired according to database time. The original provision,
READY Runtime Session, binding, mount, worker and retained history remain in use.
The cold claim must precede the final original tool-checkpoint resolution;
that resolution clears the pending native batch. A repeated repair on an already
installed successor may observe `results_ready`, but this does not add cold
admission after the pending batch has been cleared.

A new Hosted boot claims a newer writer generation, installs exactly the next
activation epoch and repairs only missing original result messages and checkpoint
resolutions. It enters the existing model loop with the saved tool responses,
then consumes results and settles normally. No execution is allocated, prepared,
dispatched or repeated during repair.

Missing receipts, executing/PREPARED/UNKNOWN/abandoned members, cancellation,
foreign members, incomplete evidence, a live owner and unsupported journal tails
refuse. Recovery after a final model output has already committed is a separate
cut and remains refused by this slice. Public CSI selection, replacement workers,
retirement, remote release, unpublication and volume reuse are outside scope.

## Design

### Transactional writer and activation admission

Use the existing private Session acquire operation and credential. Before changing
the writer, validate the complete bounded native journal, original resource
associations and related execution inventory on the same Connection under the
existing parent/head/resource/execution lock order. Validate the receipt-complete
tail and both expired leases after blocking reads using current database time.
Failed qualification must leave all persistent state unchanged.

Writer claim and successor activation installation remain separate transactions.
An uninstalled claim cannot publish resources, replay old commands or mutate the
native journal except for its qualified successor installation. A crashed claim
may expire and be replaced without skipping an installed activation epoch.

Replay the journal in original writer/activation segments. Genesis remains
generation 1; renewal stays in its installed segment; a successor install uses a
new boot and activation ID, a strictly newer writer generation and the next
activation epoch. Never rewrite old transaction, grant or receipt identities.
Current-writer credentials and live lease checks also apply to exact old-command
replay. Ordinary Session semantics remain unchanged.

### Private Hosted recovery

On a qualified successor attachment, load the existing authority without
publishing a new definition/root or binding another history directory. Validate
the exact original prompt ID and input bytes. Before the Harness model gate,
preflight the complete ordered receipt batch, original function identities,
outcome bytes, result messages and checkpoint references.

Reuse each outcome's durable message UUID, timestamp, model and Parts. Existing
messages must match exactly and form an ordered prefix. Append only missing
messages, resolve only original in-progress members and keep settled references
unchanged. Reject an invalid later member before performing any repair writes.
Close a pending file-history obligation using only the retained worker's snapshot.

Resume the existing private text runner with the projected original turn and
saved tool results. Do not submit the input or user message again. Adopt the
successor activation when consuming results, preserving all other checkpoint
identity and original outcome references. Keep PR #14487's inline capacity,
cancellation and atomic final-output behavior.

## Affected components

The private Hosted attachment, receipt recovery helper, text runner and file-tool
consumer change together with the Java native activation proof, cold execution
qualification and Managed Session writer admission. Add collocated behavioral
tests and a connected Hosted/SQL recovery witness. No schema, deployment or
public API contract changes are planned.

## Validation and acceptance

1. Confirm the installed global CLI baseline and document an unreachable private
   route honestly; then compare the extracted candidate against PR #14487.
2. Verify full-batch preflight, original message identities, repeated recovery,
   changed prompt/evidence refusal, ordinal gaps and no new file dispatch.
3. Verify segmented activation replay, expired-owner admission, live-owner and
   incomplete-tail refusal, stale replay/renewal/publication and an interrupted
   claim before installation. Failed admission preserves original SQL state.
4. Run affected package tests, root build/typecheck/bundle and Java verification.
   Use disposable MySQL 8.4 plus matching Hosted/fault checks for SQL recovery;
   H2 or mocked transport alone does not qualify InnoDB or process recovery.
5. Exercise a real Hosted producer with the real SQL/Broker/worker consumer where
   available. Record explicit mount/placement facades and distinguish their
   evidence from native Linux CSI or deployed-cluster acceptance.

Two clean full-diff self-audit passes and an independent review are required.
Record unavailable checks without converting them into successful acceptance.
The current Codex host lacks the Workflow tool required by the repository's
complete local `/review` workflow; that review remains pending.

## Risks and open questions

The change crosses CLI and durable Java admission and requires maintainer
architecture review. PR #14487's unresolved capacity-policy decision remains a
prerequisite; this extraction does not decide it. Complete result bodies retain
the 64 KiB durable ceiling. Subsequent missing-receipt and committed-final-output
cuts need separate review and acceptance. No installation, physical-release or
safe-reuse qualification transfers from cumulative evidence to this candidate.
