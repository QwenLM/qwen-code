# Runtime Binding Reconciliation After Broker Restart

[English](2026-09-24-runtime-binding-reconciliation.md) | [简体中文](2026-09-24-runtime-binding-reconciliation.zh-CN.md)

Status: implemented in `packages/sdk-java/runtime-broker`; no production
provisioner opts in yet

Related: #12380 (Managed Agent staged delivery), the integration preview in
#12358, and the endpoint-recovery reference design
`docs/design/2026-09-21-managed-runtime-endpoint-recovery.md` on that branch.

## 1. Problem

A `READY` Runtime binding is durable: it survives in the binding repository
when the Broker process dies. Until now a restarted Broker could not use such a
binding at all — `ensureBinding` failed closed with
`runtime_reconciliation_required` because only the process that provisioned a
Runtime held it in `liveBindings`. Every restart therefore orphaned every
Runtime it had provisioned, and callers had to wait out the orphaned lease or
retire the binding by hand.

Persisted metadata alone must never prove recovery. The binding table can out
of date in both directions: the Runtime process may be gone, replaced, or owned
by a different lease than the row claims.

## 2. Scope

In scope:

- Persisting the recoverable identity of a binding: the provision seed
  (encrypted), the scheduler resource handle, the attestation generation, and
  the last reconciliation time.
- Broker-side adoption of a restored `READY` binding: observe the physical
  resource through the provisioner, re-attest the Runtime identity through the
  transport, and only then allow sessions to use the lease.
- Terminal outcomes for a restored binding: `LOST` when the Runtime is proven
  gone, `RECOVERY_BLOCKED` when the evidence conflicts. `LOST` is reclaimed for
  a fresh generation only while no session or execution references it.
- Bounded reconciliation: exponential backoff inside one operation deadline
  that also fires while a provisioner or attestation call is parked, and a
  claim release that fences late writes from a timed-out operation.

Out of scope:

- Recoverable provisioner implementations. The local-process provisioner keeps
  its current in-memory ownership model and reports `legacy` kind, so its
  restored bindings keep failing closed exactly as before. Durable local
  adoption is a follow-up slice.
- Drain lifecycle, background health refresh of adopted bindings, and the
  Kubernetes provisioner.
- Schema migration for existing databases. The runtime-broker schema is still
  applied with `CREATE TABLE IF NOT EXISTS`; deployments recreate the schema,
  as before.

## 3. Design

### 3.1 Durable identity on the binding record

`RuntimeProvisionRequest` gains a `provisionerKind` (the two-argument
constructor keeps the `legacy` default). A request whose kind is neither
`legacy` nor `static` requires durable identity: the repositories assign a
`RuntimeProvisionSeed` at `findOrCreate` time, and a `READY` record for such a
request must carry the seed, lease, resource handle, attestation generation,
and reconciliation time. The seed is created from the binding id and
generation, so a retried provision for the same binding keeps a stable
identity, and its `provisionRequestId`, `provisionalRuntimeId`, and
`gatewayIncarnation` bind the record to exactly one Runtime incarnation.

The JDBC repository encrypts the seed with a required `SecretProtector`
(`AesGcmSecretProtector` is included) under the per-binding context
`runtime-provision-seed:<sha256(bindingId)>`. The lease token of a seeded
record rides inside the encrypted seed; a legacy record's lease token is
encrypted separately under `runtime-lease-token:<sha256(bindingId)>`. Both
contexts derive from a fixed-width digest of the binding id, so a legal
512-character identifier can never exceed the protector's own context bound.
No plaintext token column remains in the schema. The slot and binding tables
also persist `provisioner_kind`, and the request hash now covers it, so a
restored row can never be reinterpreted under a different provisioner.

### 3.2 Provisioner and transport SPI

`RuntimeProvisioner` gains four defaults:

- `kind()` returns `legacy`;
- `provision(request, seed)` ignores the seed and falls back to the legacy
  one-argument provision — such a provisioner can never pass reconciliation;
- `ensureResource(request, seed, knownHandle)` fails with
  `UnsupportedOperationException` — opting into a durable kind requires the
  durable provisioning path;
- `reconcile(request, seed, handle, lastLease)` returns
  `RuntimeObservation.unknown(handle)` — a provisioner that cannot observe
  proves nothing, and the Broker waits instead of guessing.

`RuntimeTransport` gains a default `attest(lease, request, seed)` that fails
closed with `runtime_broker_attestation_unavailable`. No production transport
implements `RuntimeTransport` yet, so production wiring remains a later slice.

### 3.3 Durable provisioning

For a durable request, `provisionBinding` claims the operation, ensures the
scheduler resource, provisions with the persisted seed, and then attests the
returned lease itself. The ensured resource handle is persisted before
provisioning continues, so a retryable failure afterwards keeps the record
`PROVISIONING` and the retry's `ensureResource` receives the handle it already
created instead of minting a replacement resource. The record becomes `READY`
through `withAttestation(lease, handle, …)`, so the first attestation
generation and the reconciliation timestamp are written with the same
compare-and-set. A non-retryable identity failure — a handle kind conflict, an
attestation mismatch — moves the binding to `RECOVERY_BLOCKED` rather than
`FAILED`, so a retry cannot mint a replacement Runtime over an ambiguous
resource. Provisioning runs under the same operation deadline as
reconciliation, so a parked `ensureResource`, provision, or attestation call
cannot hold the binding open; the deadline releases the claim first, which
fences any late write from the timed-out operation. The claim is released when
the operation completes, in the same way reconciliation releases it, so a
later Broker can take over without waiting out the lease.

The legacy path is byte-for-byte the reviewed behavior, including its claim
lifecycle.

### 3.4 Reconciliation of a restored binding

`ensureBinding` on a `READY` record this process does not hold in
`liveBindings` now splits:

- a legacy binding still fails closed with
  `runtime_reconciliation_required`;
- a durable binding enters `reconcileBinding`, single-flighted through
  `bindingOperations`.

Reconciliation claims the operation, renews the claim while it works, and
observes the resource through `provisioner.reconcile`:

- `READY` observation: the observation's runtime instance, lease id, and epoch
  must equal the persisted seed's, the handle kind must match the request's
  provisioner, and the Broker re-attests through `transport.attest` and
  compares the full identity (runtime instance, incarnation, lease, epoch,
  scope, provision request id). Success adopts the lease into `liveBindings`
  with a bumped attestation generation; any mismatch blocks recovery. A
  re-attestation failure blocks recovery only when it is evidence about
  identity (`managed_runtime_identity_conflict`,
  `managed_runtime_unauthorized`); every other non-retryable transport code —
  a throttle, an incompatible or malformed attestation route — leaves the
  binding `READY`, so a later attempt adopts it once the transient condition
  passes instead of wedging the row behind an operator.
- `STARTING` or `UNKNOWN`: retry with 50 ms exponential backoff capped at
  2 s until the operation deadline (four operation leases). The observation
  never creates or replaces the resource.
- `NOT_FOUND`: the binding becomes `LOST`.
- `CONFLICT`, or a non-retryable provisioner error: `RECOVERY_BLOCKED`.

The deadline is an independent scheduled task, not a check inside the retry
loop, so a parked reconcile or attestation call cannot hold the binding open.
When the deadline fires it first releases the operation claim and then fails
the waiter with `runtime_broker_reconcile_timeout`; a late result after the
release finds the claim gone and is fenced by the operation-generation
compare-and-set. The same fencing covers a provisioner result that returns
after a newer Broker took the claim.

### 3.5 Loss and reclamation

A `LOST` record stays active, so existing sessions and executions keep
pointing at the lost generation instead of drifting to a replacement. The next
`warm`/`acquire` reclaims the slot — `LOST` to `RELEASED`, then a fresh
generation through the normal provisioning path — only while
`countActiveByBinding` and the new
`ToolExecutionRepository.hasActiveByBinding` both report nothing referencing
the lost generation. Reclamation is single-flighted on the binding key
together with reconciliation, so concurrent `warm` calls for one idle `LOST`
binding join the same reclamation and observe one new generation. While
anything is still active the caller gets `runtime_broker_runtime_lost` and the
binding stays `LOST`.

An explicit `release` can settle a same-generation session locally while it is
still active — `ACQUIRING`, `READY` or `RELEASING` — when its binding is
`LOST` and it has no active execution. The Runtime is proven gone, so no
transport call is possible, and a Broker killed mid-acquire or mid-release
would otherwise leave a session that pins the lost generation forever; a
session already `RELEASING` is settled without a further state transition. An
active execution continues to pin the session and the lost generation.

`RECOVERY_BLOCKED` never transitions on its own; it requires an operator,
matching the rule that an ambiguous Runtime is never retried away.

### 3.6 Claim release

`RuntimeBindingRepository.releaseOperation(bindingId, owner, generation)`
clears the caller's claim so a takeover does not wait for lease expiry.
Releasing a lapsed claim is permitted cleanup; releasing someone else's claim
returns null. Reconciliation and durable provisioning release their claim on
every outcome.

## 4. Validation

`mvn test` in `packages/sdk-java/runtime-broker`: 188 tests, including the new
`DurableRuntimeRecoveryTest` (29 cases: gated reconcile-and-adopt, unknown
never replaces and retries to the deadline, starting never replaces, timeout
releases the claim and resumes, in-flight reconcile bounded by the deadline,
late attestation fenced, initial-provision mismatch blocks, every persisted
identity mismatch blocks, non-retryable attestation failure blocks recovery,
non-retryable and retryable reconcile failures, conflict keeps the last
trusted handle, non-retryable ensure failure stops, a retryable ensure failure
keeps the ensured resource, a retryable provision failure leaves a fresh
binding retryable, provisioning is bounded by the operation deadline,
concurrent provisioning and reclamation converge once, a late ensure result
cannot overwrite a new owner, the SPI defaults fail closed, loss re-creates a
generation only when idle, loss stays pinned by an active session or an active
execution until it can be safely released, a transient attestation failure
waits instead of blocking recovery, sessions a crash left `ACQUIRING` or
`RELEASING` still settle against a lost binding, and nothing settles locally
while the Runtime is not proven gone).
`JdbcRepositoryContract` now round-trips the seed, handle, attestation
generation and reconciliation time on H2, asserts the seed and the legacy
lease token are stored encrypted, keeps the seed ciphertext stable across a
claim renewal, round-trips a 200-character provisioner kind, and covers
`releaseOperation` handoff and its rejection paths.
`mvn checkstyle:check` passes.

## 5. Follow-up work

- Recoverable local-process provisioning (ready-record adoption) so a real
  local Runtime survives a Broker restart.
- Drain lifecycle and adopted-binding health refresh.
- Settling an `UNKNOWN` execution whose generation is proven `LOST`.
  `reconcileExecution` shipped in #12655 and answers only for a generation
  that can still produce evidence, so this case needs its own rule.
- Kubernetes provisioning, and schema migrations once the schema is versioned.
