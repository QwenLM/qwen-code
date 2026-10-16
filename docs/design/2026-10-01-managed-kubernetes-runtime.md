# Hosted Kubernetes Tool Runtime

[English](2026-10-01-managed-kubernetes-runtime.md) | [简体中文](2026-10-01-managed-kubernetes-runtime.zh-CN.md)

Status: full K1/CSI integration for draft PR #13289, based on upstream
`691a374d2a8f2def439d6aba52a592a7bbc06fb0`, 2026-10-03; tracks #12380.
Includes the experimental SDK/container scratch Runtime and private CSI
reservation, original Pod identity, sealing, original-result settlement,
checkpoint evidence and durable ACK components. Public Hosted CSI selection,
complete physical retirement and volume handoff remain closed. Earlier local
and ACK development-cluster results, including the eight pre-integration durable
ACK groups, qualify their own source snapshots only. Final integration tests
and review remain in progress.

## Problem and current state

The Harness must start model inference independently of tool provisioning.
Kubernetes should place the existing tool worker without moving the model loop,
model credentials, Session authority, or tool execution ledger into Kubernetes.

The merged Broker already persists provisioning seeds and resource handles,
performs attestation before opening its local gate, and queries original tool
identities after ambiguous outcomes. `RuntimeProvisioner` supplies the placement
seam. Spring currently rejects `provisioner=kubernetes`. Its Workspace resolver
and public file-profile admission require `local-process`; the resolver verifies
directories on the Java host. The worker reads a closed boot envelope from stdin
and listens on a loopback ephemeral port.

The historical Kubernetes adapter at reference commit `34ea187c` is useful design
evidence, not current implementation. Its request/release interfaces differ from
main. In particular, the current `release(request, lease)` is also called when an
operation loses its CAS or attestation fails. It is not durable authorization to
delete a same-generation Pod that another Broker may already have adopted.

## Ownership and topology

Java owns admission, Workspace authorization, Broker SQL records and placement.
The TypeScript Harness owns model context, tools orchestration and checkpoints.
A Session-exclusive Runtime Pod owns admitted tool-side effects. Kubernetes owns
Pod scheduling and observations, not execution settlement or replay decisions.

The initial topology is one Java service with a Hosted Harness sidecar and
on-demand Runtime Pods. The Broker calls the Kubernetes API and the worker's
private HTTP protocol. Model inference proceeds while the Pod starts. A no-tool
Turn does not need a Pod or volume. Runtime Pods receive no model credentials or
Kubernetes service-account token. The Harness receives no Kubernetes management
credentials and must not mount or inspect the Workspace.

## Delivery slices

| Slice | Deliverable                                                                                                                     | Enablement boundary                                                                                               |
| ----- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| K1    | SDK provisioner, bounded Kubernetes HTTP client, explicit container worker entry, private file-tool and original-identity tests | Trusted development, Session-exclusive ephemeral scratch only; no Spring selection or public Workspace capability |
| K2    | Trusted CSI identity mapping, durable pre-mount reservation, worker admission fence, normal drain and volume handoff            | Registered Workspace file tools only after storage/identity/result gates; no automatic partition takeover         |
| K3    | Target-cluster fault suite, deployment identity/network/security controls and rollout documentation                             | Enable only the capabilities whose complete acceptance matrix passes                                              |

K1 rejects managed-context requests and never mounts a PVC. An `emptyDir` is
explicitly disposable scratch, not a registered or recoverable Workspace. This
keeps the infrastructure implementation executable without falsely applying the
single-host W0e/W1 guarantees to CSI. It does not complete the user's eventual
Workspace-backed Hosted deployment; K2 and K3 remain required.

## K1 provisioning and worker contract

Use a bare Pod with `restartPolicy: Never` for each persisted provisioning seed.
The deterministic Pod and immutable Secret names derive from the provision
request ID. Retries observe the same objects; a conflict never creates a second
name. The pinned image digest and command, cluster domain, namespace, scope,
Session isolation key and boot identity participate in the identity check.
Resource handles persist cluster/namespace, Pod and Secret UIDs, and a placement
digest. Credentials never enter handles or labels.

`ensureResource` creates or observes Secret then Pod, validates their identity,
and returns the handle. A supplied handle is observation-only: missing or
different UIDs cannot be recreated. Create conflicts and lost create replies are
resolved by GET of the original deterministic name and full validation. A missing
Pod beside a pre-existing Secret is ambiguous and blocks rather than guessing
whether a previously executing Pod can be recreated.

`provision(request, seed)` uses only a handle already established by
`ensureResource` in that process, uses a bounded readiness polling window with bounded API calls, and
returns a lease derived from the exact Pod observation. `reconcile` never writes
Kubernetes resources. API unavailability stays UNKNOWN, a pending Pod stays
STARTING, identity changes or a terminated/missing worker stay CONFLICT. K1 does
not return NOT_FOUND to authorize a new generation after losing an execution
journal. Failed or non-ready observations revoke local lease usability; an endpoint
change invalidates the old lease. UNKNOWN confirmation errors retain a retryable
503 diagnostic; Broker confirmation still fails closed under the existing default
policy. Automatic retry/adoption after failed confirmation is deferred. Pod readiness is only transport readiness: the Broker still performs
attestation, compares the complete boot identity and commits its CAS.

Each provisioner retains at most 1024 seeds, including in-progress or ambiguous
placements. It reserves a slot before Kubernetes writes and refuses a new seed
with retryable `runtime_kubernetes_capacity` when full. Existing seeds can still
be observed at capacity. The Broker checks this in pre-create admission, keeps
the original binding PROVISIONING, and releases its operation claim for retry;
a capacity-like error after entering ensure remains fail closed. A supplied
durable handle always takes priority over an empty pending local entry. Lease lookup uses the complete immutable lease identity
and checks its endpoint without scanning the seed map. `release` never evicts;
UNKNOWN revokes local endpoint usability but retains ownership. Only a validated
reconciliation conflict for that entry's own original resources removes its slot.
A conflict in another seed cannot evict a live original worker. `close` clears
both local indexes without deleting Kubernetes resources; process restart does
not authorize replacing or retiring them.

The Pod IP is an observed endpoint, not identity. Only a literal IPv4 Pod IP returned
by the trusted Kubernetes API is admitted; invalid, loopback, unspecified,
link-local or multicast addresses are rejected. The configured worker port is
fixed at 43190 (outside Node fetch's blocked port list). IPv6-only clusters are
not supported by K1. Automatic container restarts are forbidden, and observations reject
nonzero restart counts so an empty replacement journal cannot appear to be the
original incarnation. K1 uses HTTP with the existing bearer/lease protocol only
inside a trusted test network. Production TLS/workload identity is a K3 gate.

The hidden worker command adds `--container-boot <path>`. It reads the existing
bounded boot-v1 JSON envelope from the Secret file and explicitly listens on
`0.0.0.0:43190`. Ordinary stdin startup keeps loopback and its current ready record.
The non-CSI boot-v1 container mode accepts Session isolation only and rejects managed-context boot. The private CSI boot-v3 increment instead validates its nested workspace context and original mount before listening.
Container cwd validation uses POSIX lexical rules independently of the Broker host.
No private protocol schema is widened. Boot bytes and bearer credentials are not
printed. The worker image must supply Node.js 22+, the built CLI and required
runtime dependencies. K1 Pods are non-root, drop capabilities, disable privilege
escalation, use RuntimeDefault seccomp and a read-only root filesystem, and have
bounded scratch/tmp writable volumes and resource limits. K1 rejects unknown
container security keys; explicit container user/group/non-root settings must match
the Pod policy, and omitted inherited settings remain accepted. These settings are not
a hostile multi-tenant isolation claim; same-UID trusted tools remain the boundary.

The Kubernetes API client uses HTTPS, configured CA trust, a token file re-read
per request, no redirects, bounded responses and deadlines. It distinguishes
GET absence and POST conflict from transport/authorization errors, does not emit
server error bodies or credentials, and has fake-API contract tests. HTTP client injection for the loopback API tests remains package-private.

`release` is a no-op; `close` clears local bookkeeping without deleting Pods or
Secrets.
They do not establish cancellation, retirement, physical stop or output delivery.
K1 therefore has no automatic idle collection; operators must budget retained
resources. Evidence-preserving deletion needs a later explicit retirement
operation with the saved UIDs, settlement barriers and UID delete preconditions.

A lost K1 Pod leaves a LOST binding that blocks new placement in the same tenant
with non-retryable `runtime_placement_recovery_required`. When the repository is
shared, this also blocks new local-process and other provisioner kinds. Existing
healthy bindings and other tenants are unaffected. K1 does not emit NOT_FOUND
with the stopped-writer evidence needed by Broker recovery, so repeated recovery, external
Pod deletion and process restart cannot clear this durable block. The operator
must stop new admission for the affected tenant, preserve its original binding,
seed, resource UIDs and execution inventory, and escalate for evidence-preserving
recovery or an explicitly reviewed placement-policy change. No in-place recovery
is implemented; database deletion or fabricated RELEASED/stop evidence is unsafe.
Track this K1 availability gate in #13395 without opening retirement or CSI reuse.

## K2 Workspace storage and handoff

The [K2 detailed design](2026-10-01-managed-kubernetes-k2.md) records the target
preflight, implementation sequence, platform qualification and unresolved
mount-provenance/retirement contracts. Its read-only and MySQL baseline results
do not upgrade K2/K3 acceptance.

Persist a trusted mapping from tenant/storage ID to cluster, namespace, PVC UID,
PV UID, CSI driver, backend domain and opaque volumeHandle. Verify the PVC/PV
binding and RWOP support in the target CSI deployment. The physical conflict key
is backend domain + CSI driver + volumeHandle: aliases, directories, Workspace
names and tenants must not split the same physical lock. A path or PVC name alone
does not prove identity. RWO allows multiple Pods on one node and is insufficient.

Acquire a durable reservation before any Pod or initialization can mount/read the
volume. The existing acquire-time Workspace lease is too late for a Kubernetes
Pod mount. Extend the existing Workspace/Broker repositories with explicit
reserved, active, draining and released phases, original operation/generation,
CAS revision and evidence references. A coordinator lease grants responsibility
to investigate, not permission to mount after expiry. Never hold a SQL transaction
across an API/RPC call.

Worker admission verifies the physical mount, immutable ContextBinding and holder
generation before preparing tools. Any additional control envelope is versioned
with paired Java/TypeScript fixtures; strict v2/v3 records cannot acquire fields
silently. The holder spans prepare/approval, execution, result and necessary
history/checkpoint settlement. Waiting for a busy volume must not create a fake
UNKNOWN tool execution. Independent volumes may run in parallel.

Normal cross-Session handoff requires sealed dispatch, confirmed worker and
descendant stop, durable results/history and verified volume unmount before CAS
release. An idle Pod retaining a hot mount still holds the volume. Node NotReady,
Pod deletion, force deletion, VolumeAttachment disappearance, lease expiry and
new database epochs are not physical stop evidence. Unknown executions are
queried/cancelled by the original identity; they are never replayed in a new Pod.
K2 remains blocked on uncertain writers or outcomes. Automatic node/storage
fencing and cross-failure-domain takeover require a separately accepted platform
contract and are not initial enablement requirements.

## Integration and scope

K1 changes the SDK runtime-broker package, the hidden CLI worker entry and worker
tests. It preserves the Spring Kubernetes rejection and public Workspace guards.
K2 must change Workspace resolution, durable reservation and worker admission
together; simply enabling the Spring selector is insufficient. Reuse existing
output publication, result receipts and history work rather than creating a
second store. Public Shell, approvals, file-history, G1/G3 takeover, O3/O4 and H
extensions retain their existing tracker ownership and acceptance gates.

Ordinary local Managed engine completion, a full operator/CRD, warm pools,
per-tool Jobs, multi-cluster placement, Workspace creation, RWX/hostPath,
automatic UNKNOWN replay and malicious-tenant certification are outside this
initial scope. K1's private v1 tool path retains the existing trusted tool set;
it does not open those tools through public Hosted admission.

## Validation and acceptance

The baseline dry-run uses the global `qwen` worker command. Its rejection of the
container argument is the expected gap. Local verification uses the built bundle
and Maven tests. The fake Kubernetes client launches the real worker for a private
read/write/edit, duplicate-call and original-status round trip; this is protocol
integration evidence, not scheduler/CSI evidence. The local test proves live-worker
adoption and settled-call deduplication; it does not prove Broker UNKNOWN
recovery, durable journal restoration after Pod loss, or JVM crash recovery.

K1 tests cover deterministic create/join, lost replies, Pod/Secret UID and boot
conflicts, image/placement changes, startup deadline, API denial/oversize/redirect,
token rotation, restart and deletion observations, stale release, lease-cache
invalidation, missing local
handle, and regression of loopback/stdin startup. They prove no create during
reconcile, no recreation after ambiguous loss and no deletion from release.

On 2026-10-01, the K1 smoke passed on an ACK managed development cluster running
Kubernetes 1.36.2-aliyun.1 through authenticated Workbench kubectl. The production
HTTPS Kubernetes client, provisioner, Broker and complete bundled worker created
one Pod and one boot Secret, attested READY, and executed remote write/edit/read.
Broker and worker duplicate paths preserved the edited file. Two separate,
sequential JVMs shared file-backed H2 state within one runner Pod; the second
restored identical binding/generation, Pod/Secret UIDs, endpoint, execution ID
and result, with zero resource creates. Anonymous 401, wrong-lease 409, tampered
saved-UID rejection and resource retention after Broker close passed. Both final
phase outputs were `pass`, and the runner terminated `Succeeded` with exit 0.
The test engineer independently checked the captured terminal results against
the runner and packet. Evidence is recorded in
local verification artifacts (not committed).

This smoke uses digest-pinned official ECR Node/Java base images and SHA-256
verified temporary artifact delivery, not a production worker image. Docker Hub
pulls timed out; the official ECR distribution worked. ACK automatically added
a workload node because the original nodes had untolerated taints. Cold capacity
and image startup therefore remain deployment concerns; namespace quotas do not
establish a zero-cost test. The smoke does not establish MySQL acceptance, abrupt
JVM crash recovery, Pod/PVC recovery, physical Pod replacement, enforced network
denial or production worker TLS.

After acceptance, the approved namespace Broker RBAC was revoked. The test
namespace and Workbench files were removed after checking resource identities;
the live API returned namespace NotFound and no test resources. ACK's automatic
workload node was still Ready at the final checkpoint; its reclamation is not
verified.

K2/K3 acceptance additionally needs real MySQL and the target Kubernetes/CNI/CSI:
two independent volumes, two Sessions on one volume, aliases, stale/late grants,
Java restart, Pod replacement, delayed readiness, API outage, node/network
partition, physical cancellation including descendants, output-store failure,
normal unmount and handoff. Verify both successful progress and refusal, no
duplicate physical side effects, no premature holder release, and model output
before a deliberately 15-second delayed tool environment. Required deployment
controls include minimum RBAC, runtime credential isolation, enforced network
policy, TLS/workload identity and quotas for the admitted profile.

## Open decisions and evidence

The ACK development target and official base-image digests have been validated
for K1. CSI, production worker image/registry, runtime workload identity and
trusted stop/unmount evidence source must still be selected before K2/K3
enablement. Development defaults to portable Kubernetes contracts while these
are pending. Real-cluster access is through authenticated Workbench; local
Docker, kubectl and kind remain absent. Test results and unexecuted gates must
be recorded separately.

Sources: [proposal #12380](https://github.com/QwenLM/qwen-code/issues/12380),
[reference Hosted physical-volume design](https://github.com/doudouOUC/qwen-code/blob/c7abb13f79f35b7bd2dfbca277624cbf36054616/docs/design/2026-09-21-managed-runtime-endpoint-recovery.md#hosted-runtime-profile),
[Kubernetes Pod lifecycle](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/),
[volume access modes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/#access-modes).
