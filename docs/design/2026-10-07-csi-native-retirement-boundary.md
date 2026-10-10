# Original CSI native retirement boundary

[English](2026-10-07-csi-native-retirement-boundary.md) | [简体中文](2026-10-07-csi-native-retirement-boundary.zh-CN.md)

Status: locally implemented K2-A2 observation component, 2026-10-07. Based on
`99596829308df61fe3d64c1bf0bf73e8db1821f3` and the
[K2 completion design](2026-10-06-kubernetes-k2-retirement-handoff.md).
This component does not close admission, commit an application cut, finalize a
worker, establish `DRAINED`, or release storage.

## Problem and current state

The A1 inventory observer verifies the original file results and their consumed
native checkpoints. An orderly retirement subsequently commits the original
native `releaseActivation` boundary. Its event is later than the result
checkpoint, and an observer must validate its own evidence rather than claim the
checkpoint covers that later event. A valid checksum or released phase alone
cannot prove that the boundary refers to the previously settled history.

The complete A2 admission work also needs a private CREATE-persisted file profile,
original request and first-activation pins, every production writer's parent
fence, a Harness mutation/renewal barrier, a locked immutable cut and an original
worker finalizer. These are coordinated changes, not supplied by this observer.
Legacy activation replacement, writer takeover and ordinary release retain their
existing contracts.

## Input and validation

Use a new private observation format,
`qwen-csi-session-retirement-boundary/1`, with exactly three fields: `format`,
`settledInventory`, and `terminalSnapshot`. The former is a complete A1
`qwen-csi-retirement-inventory/1`; the latter is a complete existing native
`qwen-csi-session-checkpoint-snapshot/1`. This format is not a new worker boot,
capability profile, or caller-provided release proof.

Before comparing the boundary, run the original A1 inventory observer and require
no blockers. Require exactly one `READY` Runtime Session, one durable Session
snapshot, Session isolation and the exact original Session key. Every allowed
execution remains checked by the A1 file verifier; independently enumerated
publication, lifecycle and resource obligations retain their blockers.

Read and replay both complete native snapshots without acquiring a writer. The
settled head must be `ACTIVE`, uncompacted and recovery-ready, with the original
active activation at epoch 1. The terminal head may be `ACTIVE` or `SEALED`; both
are observations, and neither proves an immutable cut. Preserve storage version,
writer generation, activation epoch, checkpoint reference and recovery fields.
The terminal journal has exactly one extra revision and one extra event.
Every earlier transaction's metadata and original bytes must be identical.

That single suffix transaction must be `releaseActivation`. Replay must produce
exactly one `activation.changed` event with phase `released`, the original ID,
epoch, worker and subject, the unchanged expiry, null install reference and null
lease duration. The referenced `managed-activation-boundary` v1 body must contain
exactly the original activation ID/epoch, settled committed sequence, and settled
last journal record UUID. The last UUID is the commit marker's UUID, not the
last event's UUID. Its resource bytes and references must be valid. Preserve all
prior resource descriptors, bytes and reference revisions; permit only the new
boundary resource at the suffix revision.

The combined input keeps the existing 48 MiB JSON and 32 MiB decoded-data limits,
4,096-entry collection limits, and strict native resource checks. Overflow,
incomplete history, replacement activation, additional suffix work, inconsistent
pins or unsupported shape returns an explicit unresolved reason. No truncation,
clock-expiry inference, replacement writer, RPC or database write is permitted.

## Output and integration

Expose a small native observer consumed by the existing private checkpoint
evidence entry. A success has `status: observed`, `stage:
original_native_boundary`, the inventory and observation digests, exact Session
key, original activation, boundary reference and pre/post journal pins. Exit zero
means the observation parsed and matched these native conditions. It does not
mean complete retirement or acceptance. The output has no cut, finalization,
`drained`, or `releasable` claim.

The future trusted coordinator will derive both inputs from original authorities,
then compare these exact pins with current locked authorities before committing a
cut. This component does not authenticate supplied snapshot origins or qualify
physical evidence. It must not be used as a standalone release authorization.
Existing live file/publication verification and old worker protocols stay intact.

## Affected areas and validation

Changes cover the core native observer, the existing private CLI evidence entry,
shared decoded-size accounting, and native test fixtures. Tests use real Session,
resource, journal, checkpoint and activation APIs. Broker results and file effects
in those fixtures remain synthetic and do not constitute worker or cloud tests.

Validate Read/Write/Edit settlement followed by the real native release boundary,
including unchanged retries. Refuse unsettled membership, premature Runtime
Session release, wrong Session/CSI identity, replacement activation, renewal or
ordinary-work suffixes, altered prefix metadata/bytes/resources, extra resources,
wrong boundary body/subject and malformed or oversized input. Include semantic
boundary tampering with internally valid recomputed hashes; checksum rejection
alone is insufficient. Keep existing A1/legacy controls green and verify the
private entry's exit code and absence of release-authority fields.

Local validation passed 67 focused core tests, 320 private-entry/worker/envelope
tests, build, typecheck, bundle, focused lint and formatting checks. An independent
test-engineer passed 37 script checks against the rebuilt private entry, including
a genuinely empty native Session, Read/Edit success, Write error, exact retry,
internally valid semantic tampering and combined decoded/JSON limits. Each
oversized combination's two subtrees were individually below the relevant limit;
the complete input was refused. Temporary native fixtures and large padded inputs
were cleaned up. These results describe this observation component, not MySQL
admission races, actual worker file effects or cluster handoff.

## Acceptance and remaining work

This component is complete only when both languages, focused tests, build,
typecheck, bundle, independent test-script verification and review agree on the
observation contract. It supplies one native semantic input to A2. Full A2, K2-B
source qualification, K2-C atomic release/reuse and K2-D public integration remain
required for the overall K2 goal. No privileged collector installation is
performed or authorized by this change.
