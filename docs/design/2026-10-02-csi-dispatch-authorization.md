# Durable dispatch authorization before CSI retirement

[English](2026-10-02-csi-dispatch-authorization.md) | [简体中文](2026-10-02-csi-dispatch-authorization.zh-CN.md)

Status: implemented and locally verified; scoped independent review found no
confirmed issue. The formal review timed out without a verdict. This prerequisite
for [K2c](2026-10-01-managed-kubernetes-k2.md) precedes
[original publication settlement](2026-10-02-csi-original-publication-settlement.md)
during DRAINING.

## Problem and current behavior

An execution's dispatch generation records a coordinator claim, not execution
authorization. A claim can become UNKNOWN when the parent admission check
fails. SETTLED can also come from cancellation before dispatch or reconciliation.
Neither the current state nor a timestamp proves authorization before a CSI seal.
The publication producer currently requires READY, so it also rejects the output
tail of an original authorized execution after the parent becomes DRAINING.

## Proposed change

Add nullable `authorized_dispatch_generation` and `authorized_binding_version`
to the existing execution row. Atomic `authorizeDispatch` records the current
dispatch generation and locked parent record version in the same transaction as
DISPATCHING to EXECUTING. The in-memory repository follows the same ownership
checks. A coordinator claim, wrong owner, stale version, cancellation, closed
Session or sealed parent cannot write this pair.

JDBC requires the existing concrete Session/execution repositories on the same
DataSource. In-memory evidence requires both native in-memory repositories so
Session mutations share the monitor held by admission. A custom or mixed CSI
combination fails closed. Non-CSI custom combinations retain their existing
unmarked CAS path, including ownership hooks; they cannot provide CSI evidence.

Both fields are absent together or present together. The dispatch generation is
positive and matches the execution's dispatch generation; the binding version
is non-negative. Subsequent renewal, cancellation, UNKNOWN, reconciliation,
settlement and abandonment preserve the pair. Ordinary insertion and execution
CAS cannot introduce, replace or erase authorization. The pair is mutable only
at the existing atomic dispatch admission boundary, rather than a public setter.
CAS checks the actual current row against expected authorization as well as
replacement, so a forged expected record cannot bypass this restriction.
The authorization-specific CAS also requires the actual current row to be
uncancelled DISPATCHING with absent evidence. A caller's claimed state cannot
retroactively authorize an old unmarked EXECUTING row.

An authorization inspection checks the stored pair and compares its binding
version strictly below the retirement journal's sealed binding version. This
only answers whether dispatch was authorized before that version. It does not
prove tool entry, output completion, current liveness or safe storage release.
The future publication consumer must additionally match the committed original
retirement, binding/generation, publication grant, execution and Session writer.

## Compatibility and affected files

Managed-server Flyway V43 (V42 in the October 4 integration, V30 in the earlier development snapshot) adds the
nullable columns without backfill. The private
Broker schema and its additive initializer support both fresh and existing
databases. Old rows remain readable with absent evidence; CSI original-only
settlement must reject them rather than infer or fabricate authorization. LOCAL
dispatch and result behavior retain their existing rules.

The change touches the execution record, JDBC and in-memory execution
repositories, both binding repositories' atomic authorization, private schema
and initializer, one new Flyway migration and collocated tests. Existing callers
continue using `authorizeDispatch`; no new HTTP route or worker boot field is
added. The migration must precede running the updated JDBC repository.

## Validation and acceptance

Use the global CLI for the baseline version check and a private Java test-script
fallback for the DB boundary that the CLI cannot expose. Verify actual claim
versus authorization, both dispatch/seal lock orders, wrong owner/generation,
stale/cancelled/closed Session refusal, rollback, independent-process reload,
preservation through original result paths, malformed pairs, fresh/upgrade
schema and LOCAL compatibility. Verify both JDBC and in-memory implementations.
Build, typecheck, bundle, run focused tests and checkstyle, independently verify
the DB evidence, then self-audit and review the complete slice.

## Boundaries and follow-up

This prerequisite does not relax the publication READY guard. Original producer
finish, unique result admission and receipt settlement require the next consumer
slice, including transaction and lock-order analysis. Retirement stays DRAINING;
worker QUIESCENT is insufficient for durable settlement. There is no DRAINED,
physical release, cloud qualification or public persistent CREATE/selector.
An old row's missing evidence is a compatibility constraint, not an open choice
to reconstruct authorization from its terminal state.

## Verified evidence

On 2026-10-02, the pre-implementation JDBC/H2 baseline reproduced the missing
pair and original producer refusal in five assertions. The implementation passed
224 Broker and 84 Managed Server focused tests, both Java checkstyle checks and
root build/typecheck/bundle. The initial test fixture used an invalid capability
digest; the initial V30 statement also used a multi-column ADD unsupported by
H2. Those failures remain recorded; the corrected fixture and two separate
ALTER statements passed the unchanged behavioral assertions.

Independent verification passed 13 MySQL/native-memory groups and five H2
producer assertions. Actual independent JVMs observed MySQL RECORD waits in
both orders: authorization first committed pair `[1, 2]` before sealed version
`3`; seal first refused authorization and left the unmarked claim unchanged.
An AFTER UPDATE trigger forced the entire authorization transaction to roll
back, followed by a successful original retry. Frozen V29 binaries created old
rows before real V30 migration; no backfill occurred and original LOCAL holder,
Hook and projection rows survived. The first independent attempt's last group
used an overbroad LOCAL snapshot; only the helper's scope was corrected, and
the complete matrix was repeated. Production source/class/dependency hashes
and the frozen worker archive stayed unchanged; all owned JVMs, database,
port and temporary data were cleaned up.

The H2 producer check still refuses DRAINING after the marker is present. This
confirms that the prerequisite does not silently enable the subsequent consumer.
It is local component evidence, not new ACK qualification or complete K2.

Two clean self-audit passes and independent review of the twelve-file slice
found no confirmed issue. The formal medium-effort SDK directory review also
captured earlier K2 changes and timed out after 15 minutes (900154 ms), with no
report or verdict. Neither the timeout nor the scoped review is a full-feature
approval. Production source stayed frozen throughout verification and review.
