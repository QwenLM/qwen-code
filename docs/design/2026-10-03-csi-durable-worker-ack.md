# Trusted CSI worker identity and durable receipt ACK

[English](2026-10-03-csi-durable-worker-ack.md) | [简体中文](2026-10-03-csi-durable-worker-ack.zh-CN.md)

Status: IMPLEMENTED; final integrated PR source passed eight controlled ACK
cloud acceptance groups. Owned test objects, disk, bucket and credential
directories have been reclaimed. A later read-only ECS observation confirmed
the autoscaling instance absent. Maintainer integration review is pending. This
continues [ACK-1](2026-10-03-csi-original-worker-ack.md) and is included with K1
and the preceding CSI stages in draft PR #13289.

## Problem and scope

ACK-1 confirms one original receipt in the worker's memory. At the ACK-1 baseline, the CSI adapter
could not create a worker or provide a trustworthy persisted expected Pod. The
private adapter now retains API-observed identity in the existing durable
binding handle and appends an ACK evidence row only after the original
publication and receipt authorities are revalidated.

This is a single-publication evidence operation. It does not declare DRAINED,
release a holder, clear lifecycle blockers, delete resources, qualify all MCP
history or prove CSI NodeUnpublish. Cloud verification exercises this complete
operation, not aggregate physical retirement. Public Hosted CSI selection stays
disabled. Existing K1 and LOCAL behavior stays compatible.

## Trusted placement

Use explicitly configured trusted Kubernetes API, cluster domain, digest-pinned
worker image/command, registration and resource-protection identities. The
private adapter reserves the original physical holder before any API mutation,
checks the existing resource guard, and creates one immutable boot Secret and
one restricted, restartPolicy Never, PVC-backed Pod. The worker has no Kubernetes
credentials; downward API supplies its Pod UID, namespace and node name.

For a pinned base image without the bundled CLI, trusted deployment may supply
up to 48 immutable ConfigMap artifact chunks. Each fixed read-only projected
chunk has an API-observed UID and SHA-256 saved in the handle and checked on
every observation. The trusted command verifies the packed bundle, unpacks it
under tmp and launches the worker. This is a fixed artifact mount, not arbitrary
Pod template injection; ConfigMap reads add no worker permission.

A null handle permits creation only when both objects are absent and their
creation is positively confirmed. A pre-existing object, 409, lost creation
reply or pre-handle crash is ambiguous and fails closed. Do not infer an
original Pod from an annotation, a returned worker tuple or matching boot bytes.
No automatic resource deletion or second Pod is permitted on failure.

Before returning a handle, observe the same created Pod and Secret through the
API, corroborate its node UID, running container ID, immutable image ID, zero
restarts, restricted spec and original PVC/protection pins. Save the complete
closed identity in the existing binding resource handle through the Broker's
claim-fenced CAS. Persist no credential bytes. Readiness additionally requires
the original managed-context and CSI mount attestation. An existing handle only
allows observation and exact attestation of its original objects, never creation.

The retirement's existing immutable identity JSON captures that handle. The ACK
coordinator derives its expected Pod and original boot/storage from this saved
handle, registration and encrypted provision seed. Legacy null or K1 handles
cannot qualify. No extra provenance table or caller-supplied proof interface is
needed. Pre-handle failures retain the reservation and require later operator
handling; they do not promise automatic crash recovery.

## ACK authority and persistence

Provide a private coordinator and an actual command accepting only retirement
and tenant/workspace/Session/publication selectors. It uses native repositories
on one DataSource and refuses ambient transactions. It loads the original
DRAINING binding, active slot, physical holder, immutable retirement, READY
Runtime Session, pre-seal authorized SETTLED deferred-v3 execution and complete
publication binding. No endpoint, token, Pod, response JSON or success flag is
accepted from command input.

Prepare an immutable plan with the original terminal/finish operation, verified
admission outcome and manifest, exact committed tool.receipt and actual capture
identity. Reuse the existing publication resource verification outside the final
transaction; it can update verification or quarantine state. Finish all SQL
transactions before sending the ACK-1 RPC to the original lease.

After exact positive confirmation, begin a new short transaction. Reuse the
existing lock order: placement domain and active binding, registration and
physical holder/retirement, native Runtime Session, execution, tenant and original Session head,
publication, receipt/finish/resource authorities, then the ACK key. Use current
locking reads after waits. Revalidate every original pin and current writer,
activation, quarantine and referenced-resource state. The final transaction
contains no worker RPC or external object I/O. Any late conflict or commit
failure installs no row. A retry repeats the original worker RPC when no saved
row exists.

Add one append-only table in the next migration number unused on current main:
`managed_workspace_csi_worker_ack`, keyed by retirement ID and SHA-256 of the
exact execution ID. Store the raw ID, bounded closed evidence JSON, its byte
digest and database epoch-microsecond observation time. Read back and strictly
validate the complete first row. Exact semantic retries preserve its bytes/time;
same-key conflicts or corrupt documents fail closed. A historical read after
restart does not certify worker liveness or authorize storage release. Do not
backfill rows from REFERENCED publications.

The evidence schema and 16 KiB wire/32 KiB saved-document limits remain those in
ACK-1's ACK-2 design. Keep SQL revisions as canonical decimal strings and native
receipt sequence as an exact safe integer. Compare full Broker results using
existing numeric semantics without dropping other fields.

## Files and verification

Extend the private CSI provisioner and add its closed handle validator. Add the
coordinator/command and one migration; extend publication authorities only
where final locking validation needs an existing authority exposed internally.
Keep focused source tests and the bilingual ACK design synchronized.

The E2E plan separates global CLI baseline, fake-API placement boundaries,
native worker HTTP, production publication/receipt chain, H2 persistence,
real MySQL repeatable-read lock waits and real ACK cluster qualification.
Positive durable acceptance must obtain worker identity from Kubernetes API and
receipt/capture/publication from production APIs, not seeded successful SQL or a
canned ACK. Test exact retry/reload, lost response, competing insert, rollback,
late expiry/quarantine and wrong original identity. Record source/bundle/class
hashes, executed assertions, time-zone checks and owned cleanup.

## Cloud acceptance and open constraints

Use a uniquely owned namespace and disposable RWOP disk, the existing restricted
Pod profile and pinned public images. Preserve all unrelated cluster resources.
Current profile `data-governmance` and the target cn-beijing cluster are valid;
its API endpoint is private. Local direct access times out. The existing OAuth profile can execute owned
temporary verification commands through ECS Cloud Assistant on a cluster node.
Stage checksum-verified tools in a private temporary OSS bucket, retain the
short-lived kubeconfig only in a mode-0600 owned directory, and remove both
after acceptance. No public API endpoint or permanent host configuration is
required.

On 2026-10-03 at 16:34:48–16:35:16 UTC, the final integrated PR source
passed all eight groups on actual Alibaba Cloud ACK: actual adapter
API-origin placement and native publication/receipt, response loss leaving zero
rows, native insertion rolled back by a pre-commit failure, two concurrent real
ACKs installing one row, wrong retirement refusal, exact original manifest
quarantine refusal, immutable original retry with DRAINING ownership retained,
and historical reread by the production command in a second JVM. The actual
post-ACK worker status retained the exact original seal identity and remained
DRAINING/BLOCKED with capture, publication and shell lifecycle blockers.

The publication service used actual HTTPS with a temporary private CA trusted
by the two owned native processes. The test used file H2 across JVMs in one Pod
and an inline publication; it does not qualify positive MySQL concurrency,
Pod/PV restart recovery, external OSS publication objects or public Hosted CSI.
Separately, real MySQL repeatable-read resource-reference and manifest lock
waits refused late writer expiry and quarantine with zero ACK rows. The native
database epoch-microsecond expression was checked in 128 samples across UTC
and +08:00. A real MySQL V34-to-V38 upgrade preserved prior migration history,
LOCAL/Hook data and legacy PREPARED records; new authorization columns remained
null and no ACK was backfilled. Local or historical results are not substitutes
for the cloud run.

Earlier failed test deployments and their databases were preserved separately.
The accepted run must retain its original raw evidence and exact source/class/
bundle hashes. Owned namespace/PVC/PV/VolumeAttachment, disposable disk, protection/RBAC
objects, temporary OSS objects/bucket and node/local credential directories
were removed and their absence verified. The two original nodes retained their
UIDs and Ready state. The autoscaling node was present at 16:45:29 UTC; a
separate read-only ECS query at 17:02:41 UTC returned zero matching instances.
No manual node deletion or final billing-reclamation claim is made. Maintainer
integration review remains required; aggregate
drain/release/NodeUnpublish remains outside this operation.

The October 4 main integration moved the four unmerged CSI migrations to V40–V43 because main owned V35–V39. The October 5 integration preserves main’s new V40 Session creator migration and moves the unchanged CSI chain to V41–V44. The V34-to-V38 MySQL result above and any earlier V39-to-V43 results belong to their prior numbering and commits; they do not validate the current V40-to-V44 upgrade. Applied private histories require explicit reconciliation or a fresh database, with no automatic Flyway repair.
