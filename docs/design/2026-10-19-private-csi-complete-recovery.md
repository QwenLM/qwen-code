# Complete private CSI cold recovery

[English](2026-10-19-private-csi-complete-recovery.md) | [简体中文](2026-10-19-private-csi-complete-recovery.zh-CN.md)

## Status and problem

Extraction candidate from cumulative PR #13526 at
`1a6529b73c007044d9d04e0614fbc30ebe13c0ac`, based independently on main after
PR #14523. Verification of this extracted candidate is pending. Historical
cumulative-branch evidence does not qualify this candidate.

Main can resume the first receipt-complete private file batch after its original
writer and activation expire. It refuses when a settled execution has no durable
receipt, or when the final complete model output has committed before result
consumption. Repeating a file operation or requesting the model again cannot
recover either window safely.

## Scope and decisions

Retain the original no-deadline prompt, READY Runtime, worker, binding, immutable
execution grants and complete success/error results. Every execution must be
SETTLED and uncancelled. Preserve the merged deterministic refusal prefix,
provider ordinals, exact existing outcome/message identities, inline capacity
limits and atomic complete-output behavior. PREPARED, executing, UNKNOWN,
incomplete or foreign membership, live owners and unsupported tails still refuse.

Missing-receipt recovery extends the existing authenticated private batch read
with the current installed writer/activation tuple. SQL independently checks the
whole original batch and persisted grants/results on its original Connection.
The original preparation read returns its existing fields without complete result
bytes. Only the installed qualified successor obtains bounded saved result/grant
bytes; neither read grants prepare, execute or dispatch permission.

Hosted validates the entire repair plan before its first durable write. Existing
receipts remain authority for message UUID, timestamp, model and Parts. An absent
receipt establishes one identity through the existing atomic outcome/receipt
publication; interruption retries reuse that committed identity. Only missing
messages and original unresolved checkpoints are repaired. Original refusal
responses retain their identity and provider order. No file effect is repeated.

Complete-output recovery requires the original atomic output transaction, exact
model attempt/checkpoint/route and assistant message, complete unconsumed tool
membership and closed history. Marker-only output remains insufficient. The
successor bypasses the model runner, consumes the original results and settles
once without another assistant identity or model request. Ordinary no-tool final
output and current main's shared turn outcome retain their behavior.

Writer claim and activation installation remain separate transactions. Natural
database-clock expiry permits replacing an abandoned uninstalled claim without
skipping an installed activation epoch. Stale owners cannot read recovery bytes,
renew, replay or publish. Concurrent READ COMMITTED and warmed REPEATABLE READ
claims must produce one winner and preserve every unrelated row and file.

## Components and boundaries

The private recovery helper, bounded batch reader, attachment and CSI text runner
change with native SQL batch/read/receipt and cold-tail qualification. Shared
model/activation behavior changes only where an actual recovery consumer needs
it. There is no schema migration, public selector, credential, replacement
worker, application retirement, physical release or volume reuse change.

The independent application-retirement slice supports only a settled original
generation-1/epoch-1 owner. Retiring a recovered owner is outside both slices.

## Validation and acceptance

First run the installed global CLI baseline and document any unreachable private
route; use a real native/Hosted test fallback for inaccessible internal paths.
Verify positive and negative original results, mixed accepted/refused ordinals,
full-batch preflight, capacity refusal, missing receipts, repeated interruption
and existing identity reuse. Verify complete-output recovery bypasses model and
file execution and rejects marker-only or altered evidence.

Run focused package tests, root build/typecheck/bundle and full Java verification.
Use disposable MySQL 8.4 for cold acquisition, refusal snapshots and RC/RR
contention. Record actual process-death tests separately from injected callbacks
and reopened authorities. Repeat matching Hosted/fault regressions where their
platform prerequisites are available; report unavailable or failed checks.

Read the complete extracted diff until two consecutive clean self-audit passes.
Independent maintainer architecture review remains required. Native Linux mount,
CSI, deployment confinement and cloud qualification are separate acceptance.
