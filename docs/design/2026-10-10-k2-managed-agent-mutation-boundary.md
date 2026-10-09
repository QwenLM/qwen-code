# Private CSI Managed Agent mutation boundary

[English](2026-10-10-k2-managed-agent-mutation-boundary.md) | [简体中文](2026-10-10-k2-managed-agent-mutation-boundary.zh-CN.md)

Status: proposed K2 admission-closure increment, 2026-10-10, based on
`5e8dc04f9a8c2837bae29eff33598e7eb0d5f88d`. Refs #12380, #13395;
implementation belongs to Draft PR #13526.

## Problem and current state

Private CSI CREATE persists an immutable `csi-files-retirement/1` profile and
`runtime_request_key`. Its Hosted producer uses the private native Session
Store, Broker and worker paths. It does not use the legacy Managed Agent turn,
operation, dispatch or message-projection writers. Public selection is still
closed. Public service checks already reject child creation and generic
lifecycle operations, but those checks do not cover every direct store writer.
For example, event append and replay-floor/materialization updates can change a
private Session without the original CSI parent fence. Such changes must not be
admitted through the legacy mutation family while K2 retirement is assembled.

The generated `managed_agent_session.csi_guard` is true when the persisted profile
is private CSI or the immutable request pin is non-null. Production never changes
these two source fields after CREATE. The discriminator is an exclusion boundary,
not proof of an original binding, activation, result or retirement state.

## Decision and implementation

Refuse private CSI at every existing-Session mutation entry in
`ManagedAgentStore`, before its first mutation or its own child write lock. Nested callbacks can
already hold outer locks. Use one exact
current locking TRUE probe on `(tenant_id, session_id, csi_guard)`; force the
existing unique index on MySQL/MariaDB, matching the native guard's negative
probe contract. The probe has a ten-second query timeout and adds one fixed
query per mutation; materialization budgets count it once per batch and retain
the existing per-event and snapshot-write limits. An ordinary Session's FALSE
row is not selected. Preserve existing
placement-domain acquisition before the probe where the method already takes
that domain. The probe never acquires a placement domain after a Session lock.

Return semantic HTTP 409 `csi_managed_mutation_unavailable`. Refuse private rows
before binding provision as well as while READY, DRAINING or terminal: this
family has no qualified CSI continuation to admit. A changed profile with a
retained request pin still refuses. Do not put the check in the shared private
CREATE request reader, because that reader must continue to validate the original
pin. Child creation/replay retain their existing explicit refusal contract.

Include turn admission/cancellation, display mutation commands, lifecycle and cwd
admission/completion, operation delivery, turn lease/dispatch/admission/recovery,
output retraction/event append and projection/replay-floor writers. Add Spring
transaction boundaries to the existing single-statement turn lease/retry methods
so their current probe and update share one transaction. Read-only queries remain
available. Background projection, replay-floor, turn-dispatch and operation-delivery
discovery omit private rows so private backlog cannot fill a page and starve
ordinary work;
the mutation guard still handles stale discovery or a direct caller.

## Scope and lock boundary

This increment changes only the legacy Managed Agent store and its tests, plus
this linked design pair. It adds no schema, public CSI selector, new capability,
new retirement state or physical operation. Native CSI mutations keep their
existing complete parent/binding/history proof. Legacy creation never creates a
private profile; private CREATE and its pin reader remain separate.

The TRUE probe is a refusal, not original membership certification. It does not
qualify an ordinary-profile/null-pin Session with contradictory CSI slot history.
Complete retirement inventory must still detect that contradiction. Retention
collector/read metadata, extension/action/result stores and native cut/finalizer
writers require their own complete audit and closure. This batch does not prove
aggregate `DRAINED`, writer termination, NodeUnpublish, `RELEASED` or reuse.

## Validation and acceptance

First attempt the globally installed CLI and record that public CLI cannot reach
this private Java mutation family. Use a JDBC test-script fallback with the real
private CREATE producer and current Flyway schema. Reproduce an unguarded event
append before implementation; observe complete affected rows before and after.
No fixture binding or clock expiry is a retirement authorization.

After implementation, verify every guarded entry refuses before mutation,
including missing child rows, with complete relevant table snapshots unchanged.
Verify a retained pin still refuses when the profile differs. Verify ordinary
Session event append, projection and turn lease behavior, and private CREATE
replay/request reading. Exercise current-read contention independently; H2
checks do not substitute for MySQL isolation qualification. Run focused Java
regressions, Java packaging/static analysis, repository build, typecheck and
applicable bundle checks. Read the full diff twice and obtain independent review.

Acceptance for this increment is consistent refusal without ordinary regression.
Full K2 remains active until all remaining writers, immutable cut, physical
termination, exact CSI unpublish, atomic release/reuse, public integration and
Linux/cloud qualification are implemented and validated.
