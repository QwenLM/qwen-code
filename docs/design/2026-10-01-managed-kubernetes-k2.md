# Kubernetes Workspace admission and storage handoff

[English](2026-10-01-managed-kubernetes-k2.md) | [简体中文](2026-10-01-managed-kubernetes-k2.zh-CN.md)

Status: the complete CSI development delta is integrated locally for draft PR
#13289. Private reservation, pre-create admission, trusted API original Pod
identity, sealing, original-result settlement, checkpoint and durable ACK
components are implemented. The current trusted create/ACK entry is documented
in the [durable ACK design](2026-10-03-csi-durable-worker-ack.md); earlier CREATE
refusals below describe historical stage snapshots, and the legacy three-argument
constructor remains closed. Public Kubernetes Workspace selection, complete
physical retirement and volume handoff remain disabled. Historical stage results
do not qualify the latest-main integration; its tests and review are in progress.
This continues #12380's [K1](2026-10-01-managed-kubernetes-runtime.md).

## Current evidence and gap

K1 has exercised the production Broker, Kubernetes HTTPS client, scratch Pod and
bundled worker on ACK. Two orderly Java processes adopted the same identities
and preserved the original execution result. Its database was H2 inside one
Pod; it did not test a persistent Workspace or physical retirement.

The subsequent read-only ACK preflight found Kubernetes 1.36.2, Disk CSI 1.37.2,
and Terway 1.17.7. The four existing Disk StorageClasses include
`alicloud-disk-topology-alltype`, with `WaitForFirstConsumer` and `Delete`
reclamation. The Disk CSIDriver requires attachment and supports persistent
volumes. These declarations alone do not establish RWOP support. Initially,
Terway's component configuration had `NetworkPolicy=false`; its live `eni-config`
had `disable_network_policy=true`. Both existing system nodes reported `veth` in the
Terway Node resource. Do not infer DataPath V2 from the component version or the
`network_policy_provider=ebpf` configuration alone.

The subsequent all-namespace native query found zero NetworkPolicies. The
console preview warns that parameter changes regenerate the component template
and may overwrite direct template edits. Configuration and policy inventory must
be rechecked before a cluster-wide change. On October 2, the approved component
change set only `NetworkPolicy=true`. The component returned active and the live
configuration reported `disable_network_policy=false`. No system node was
restarted. The setting remains enabled after disposable probe cleanup.

The disposable ACK test used one fresh business node and one 20Gi RWOP ESSD
volume. The scheduler rejected the same contender Pod UID specifically because
the claim was already in use. The original non-root holder fsynced an alpha file,
then stopped normally with a retained stopped log, Succeeded phase and exit 0.
The CSI plugin logged successful unpublish for its exact Pod UID and volume,
followed by successful publish for the contender. The contender read alpha and
fsynced beta on the same Node, PVC UID, PV UID, driver and handle. It started
after the original holder finished, before that holder's normal Pod deletion.

Fixed-label ingress passed allow/deny/allow controls. Immediate label transitions
had failed observations; after a five-second wait, the same client completed two
allow/deny cycles with unchanged UID, IP and Node. This supports eventual
selector enforcement on that fresh node, not immediate isolation or a five-second
convergence guarantee. CNI and CSI reported 3/3 Ready while the node was present.
These are platform observations, not durable Broker reservations or retirement.

Cleanup used saved-UID checks and normal deletion. Native queries confirmed the
namespace, original PV, VolumeAttachment and business Node absent; successful
ACK/ECS query records reported the exact disk and instance absent and the
business nodepool back to zero. The original system Node UIDs remained Ready,
with CNI/CSI back at 2/2. Allocation to observed reclamation took under 22
minutes. Hourly price quotes supported the approved incremental test budget;
they are not final billing records or a financial cap.

On October 2, a second approved disposable test ran the frozen CLI archive
`f4a768d6f5fe623d70225d4079ea828efe7251f6ec187f3e33faed22d988013b`
on Node.js 22.23.2 as UID 1000. Fresh native PVC/PV/Node UIDs and the ECS API's
independently fetched disk serial populated the container boot-v3 envelope.
The authenticated closed CSI receipt agreed with actual mountinfo, independently
decoded Linux device numbers, root inode and sysfs serial across repeated reads.
Negative authentication/context requests were rejected, the original alpha file
survived the holder transition, and an actual worker `write_file` succeeded with
its exact contents verified. Both original containers retained restart count zero
and Succeeded/exit 0 after normal SIGTERM. Downloaded native CSI logs retained the
same observed plugin incarnation, extended their preceding bytes and recorded
successful unpublish for each original Pod target. Normal cleanup reclaimed the
namespace, PV, attachment, disk, business Node and ECS instance; both original
system Nodes remained Ready and CNI/CSI returned to 2/2 within 16 minutes 25 seconds.

This is component acceptance with synthetic context/reservation inputs. It does
not validate production authorization, durable activation/release, strict drain,
or a qualified CSI collector. Native Pod API snapshots still do not independently
bind log bytes to their container incarnation. The frozen archive also predates
the later local executor-close repair, so this cloud run does not verify that
repair. Persistent provider CREATE and the public selector stayed closed in that snapshot; the later trusted create entry is described above.

The existing Broker repository contracts passed a separate 3/3 MySQL baseline.
K2a subsequently passed twelve custom integration groups on isolated local MySQL
8.4.11: independent-process alias contention/restart, V25 LOCAL migration, full
seed/stale authority guards, and LOCAL/CSI snapshot exclusion. An initially
reproduced outer repeatable-read transaction defect was fixed by requiring fresh
registration/claim transactions; the failing observations remain preserved.
K2b then passed two custom MySQL groups through the production Broker/adapter:
four busy retries across two JVMs preserved the original binding and other
holder, while the provenance gate retained RECOVERY_BLOCKED plus RESERVED across
restart. A real ownership row wait timed out after 10.07 seconds with its lease
still live and rolled back completely. These are private persistence/admission
results, not mounted-worker or cloud database acceptance. The global CLI and
local K1 worker still refuse the proposed container managed-context path.

Current Workspace ownership is acquired after a worker becomes READY, during
transport acquisition. Kubernetes can already mount a PVC by that time. The
current conflict key is tenant/storage ID, so aliases can split one physical
volume into multiple locks. The local storage guard's host/device/inode/marker
proof cannot establish a CSI volume identity. Ordinary release does not prove
worker descendants stopped, output settled, or a volume unmounted.

## Target-platform qualification

Before implementing a runnable persistent Pod, qualify one disposable ACK Disk
PVC using `ReadWriteOncePod`, filesystem mode, and 20Gi on the existing
`WaitForFirstConsumer` class. Never downgrade to RWO after a failure. Keep all
probes off system nodes, use one business node, and pin the contender to the
first holder's observed hostname. A Pending contender is insufficient: establish
that the scheduler or CSI rejection is specifically caused by the original
live holder, with enough spare resource capacity. After an orderly first-holder
stop, prove the second Pod reads the original fsynced file, then verify the same
PVC UID, PV UID, CSI driver and opaque volumeHandle. This qualifies a normal
platform path; it does not prove safety under node partition or force deletion.

Network qualification requires positive controls before and after repeated
denied requests to the same healthy endpoint. Test ingress using Pod selectors
within the disposable namespace. Egress, cross-node isolation, TLS and hostile
tenancy remain K3 gates. Preserve the original Terway configuration before any
component change. Use ACK component management, rather than editing generated
CNI files. Existing non-DataPath-V2 nodes may require restart according to ACK's
[network-policy documentation](https://help.aliyun.com/zh/ack/ack-managed-and-ack-dedicated/user-guide/use-network-policies).
System-node restart is a separate operation with its own impact assessment;
it is not part of this probe. Qualify fresh business nodes after the approved
configuration change and explicitly record the scope that passed.

The disposable test scope is `qwen-runtime-k2`: one 20Gi PVC, at most four probe
Pods and namespace quota, ConfigMap and ingress policies. Pods have no Kubernetes
token, run as UID/GID 1000, drop all capabilities, use RuntimeDefault seccomp,
and use the already K1-verified SHA-pinned public Node image. No Broker RBAC,
model credentials, Service, public endpoint, production data or source archive
is required for these platform probes. Run for at most 30 minutes before
cleanup. Pod deadlines and namespace quotas are not monetary caps or automatic
disk cleanup. Preserve and inspect the actual cloud disk ID and confirm deletion
through ACK and ECS observations; a failed cleanup remains actionable.

## Trusted registration and mount provenance

Persist an immutable registration that maps an authorized tenant/storage ID to
cluster domain, namespace, PVC name/UID, PV name/UID, CSI driver, opaque
volumeHandle, trusted backend domain, trusted disk serial, mount root and registration revision.
Backend domain is operator configuration for the physical storage service; it
is not derived from a tenant or a display name. Compute a length-delimited
physical key from backend domain, driver and volumeHandle. Two registrations
for the same physical volume must reference the same ownership row, even across
tenant/storage aliases. Never publish opaque handles or registration details in
ordinary Workspace errors.

Read the PVC and PV through the trusted API, check reciprocal claimRef binding,
the original UIDs, filesystem mode, driver allowlist and RWOP. Revalidate before
Pod creation and admission. Kubernetes Pod volume references contain a PVC
name, not its UID; a GET followed by CREATE cannot eliminate replacement races.
The deployment must protect registered PVC/PV objects from replacement for the
entire reservation, and supply an independently verifiable mount-provenance
chain. A declared Pod spec or a mounted directory alone is insufficient.

The worker's Linux mount information and dev/inode observations are useful
incarnation checks, but cannot generically recover an opaque CSI volumeHandle.
For ACK Disk, settle the concrete provenance contract with observed CSI/device
information before accepting tools. If that contract cannot be established,
keep persistent execution closed. No privileged worker, hostPath, or general
node-management agent is introduced as a shortcut.

The separate `managed-csi/1` boot-v3 envelope wraps an unchanged closed
managed-context boot-v2 record. The container file entry accepts it only after
the actual Linux observer succeeds; the stdin entry rejects it. Its independent
attestation route authenticates the original lease and checks the complete
reservation request before observing the mount. A closed reply contains the
unchanged context attestation, exact storage identity, downward-API Pod identity,
and the pinned mount ID, device, source, disk serial and root dev/inode. Both
languages require the root stat device to equal the Linux encoded major/minor,
and compare Pod identity with the trusted API observation. Boot, request and
reply fixtures cover extra fields, numeric encoding and identity substitution.
The existing boot-v2 READY record only reports context listener identity;
it never replaces this CSI receipt. The private Broker adapter still refuses
CREATE until deployment protection and durable provenance are connected.

The ACK probe's exact filesystem mount resolved to an NVMe device. Its read-only
kernel sysfs serial matched both trusted ECS `DescribeDisks.SerialNumber` and the
CSI plugin's disk-by-serial lookup. Aliyun documents
[disk serial identification](https://help.aliyun.com/en/ecs/user-guide/query-the-serial-number-of-a-disk).
This supplies a concrete candidate contract: resolve the actual mount's device
and compare its serial with a trusted registered disk identity. Do not infer a
generic CSI mapping from a device name or strip a handle prefix without trusted
backend validation. The observed CSI log records still need a bounded, versioned
reader and durable receipts tied to the original node/plugin/Pod incarnation;
diagnostic log text alone is not a production handoff implementation.

For the qualified ACK profile, normal handoff needs unpublish of the original
Pod's publication target, not disappearance of the CSI-only staging mount or
VolumeAttachment. The
[CSI specification](https://github.com/container-storage-interface/spec/blob/e6fc13ea4d529db12e211ef79c924ee3186c39d5/spec.md)
defines this target-scoped operation. Pin the trusted plugin Pod UID, containerID,
imageID, restart count and Node UID before and after collection. Collect before
Pod creation, identify the original successful publication and subsequent
ordinary unpublish, and persist the complete provenance and ordering receipt.
Do not upgrade log absence, idempotent empty-target branches, truncated records,
source replacement or uncertain stream recovery into successful retirement.
The profile/parser must be verified against its immutable plugin image; a
version tag alone is insufficient.

The private native log reader now requests the current available log segment from
the trusted API with timestamps, without server-side tail or byte truncation.
It rejects redirects, malformed UTF-8 and responses over one MiB. Each snapshot
checks the original kube-system CSI plugin Pod, DaemonSet, Node, container and
image identity before and after the read, including zero restarts and Ready Node.
An appended snapshot must retain every byte of the original complete prefix;
empty, partial, terminal-wrapped or replaced prefixes are refused. These local
checks provide qualification inputs only. They do not implement a durable
pre-CREATE collector, qualify the plugin's event parser, prove ordinary unpublish,
or authorize physical release. A restarted collector must never substitute a
new baseline for the original reservation's saved log history.
The Kubernetes log API omits rotated files and can skip malformed CRI records.
It selects a container from kubelet-local status, whose synchronization to the
API server is asynchronous. Matching API observations therefore do not prove
that returned log bytes belong to that container ID. A qualified collector must
establish this additional source binding before its receipts can authorize a
handoff. Native RFC3339 timestamps, including ACK's observed `+08:00` offset, are
accepted without rewriting the original bytes.

Registered-object protection is an independent deployment prerequisite. One
minimal option is a native ValidatingAdmissionPolicy with a Deny binding that
protects fixed PVC/PV names and immutable identity fields and namespace deletion,
combined with an independently audited RBAC boundary that protects the policy
and binding. API-created VAPs cannot protect admission configuration objects:
Kubernetes excludes those kinds from API-based policy evaluation to prevent
circular dependencies. This is explicit in the
[v1.36.2 admission plugin](https://github.com/kubernetes/kubernetes/blob/v1.36.2/staging/src/k8s.io/apiserver/pkg/admission/plugin/policy/generic/plugin.go)
and the [official policy documentation](https://kubernetes.io/docs/reference/access-authn-authz/validating-admission-policy/#api-kinds-exempt-from-admission-validation).
Do not render a self-protecting VAP and treat it as effective. An audited equivalent
authorization boundary can also satisfy the requirement; do not assume static
control-plane manifests are available on managed ACK. Install
protection before trusted UID registration and runtime reservation; remove it
only after every alias and holder is safely released. K2a persistence alone
neither installs nor proves this boundary.

The concrete native renderer freezes the entire registered PVC/PV spec and every
Namespace label, and rejects deletion. This excludes resizing, rebinding,
reclaim-policy changes and label maintenance while protected. Match the actual
`oldObject.metadata.name`, including DELETECOLLECTION whose admission request
name is empty. Cover Namespace `status` and `finalize` updates explicitly:
those subresources can change metadata in v1.36.2. Keep normal PVC/PV status
updates available because their strategies restore the old spec.

The bounded client permits only explicit core/admission v1 reads and Pod/Secret
CREATE. The private resource guard checks policy/binding UID, generation, exact
spec and observed type-check status before and after reciprocal Bound PVC/PV
reads, including RWOP, Filesystem, ext4, driver/handle, Namespace UID and pinned
restricted PSA labels. These observations do not prove continuous admission
enforcement, PodSecurity exemptions or effective authorization. On October 2,
ACK accepted the rendered VAP and binding through server dry-run; later GETs
reported both absent. No protection policy or new resource was installed.

API-created dynamic webhooks also skip admission configuration objects and cannot
replace independent authorization protection. Runtime namespaces accept workload
creation only from the trusted provisioner. Worker service accounts have no
permissions or mounted token; operator identities and credentials stay outside
namespaces where Runtime workloads may be created. Review existing and external
grants, bind/escalate/impersonate, service-account token and workload credential
paths. RBAC is additive; a narrow Role cannot cancel other grants. Qualify actual
denied requests with positive controls before enabling persistent CREATE.

## Durable ownership before mounting

Extend the existing Workspace registry and execution repository. Reuse the
existing execution/result/history stores; do not add a competing execution
ledger. Registration metadata can have its own table, while aliases resolve to
one physical ownership row. Keep the Linux local-storage recovery path distinct
from CSI evidence.

The ownership row records the registration revision, original provision request,
binding/generation, reservation ID, CAS revision, phase and evidence references.
The phases are `RESERVED`, `ACTIVE`, `DRAINING` and `RELEASED`. Ambiguous effects
retain the holder and record the blocking reason; an expired coordinator lease
changes investigation responsibility, never physical ownership.

| Transition          | Required facts                                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| RELEASED → RESERVED | Authorized registration, matching physical key, original provisioning identity, atomic comparison against the released revision                              |
| RESERVED → ACTIVE   | Exact original Pod/Secret and registration identities, trusted mount proof, successful worker admission and original-holder CAS                              |
| RESERVED → DRAINING | Exact original holder at reservation revision 1 and durable dispatch seal; retain ownership because original Pod creation or mount may already have occurred |
| ACTIVE → DRAINING   | Durable dispatch seal for the exact generation; retain ownership through approval, result, history and checkpoint settlement                                 |
| DRAINING → RELEASED | Original executions settled, worker/descendants stopped, trusted unmount proof, all receipts durable, exact-holder CAS                                       |

Commit RESERVED before any Pod or init container can mount or read the volume.
SQL transactions never span Kubernetes API or worker RPC calls. Creation with a
lost reply retains the reservation and observes only the deterministic original
resource. A changed/missing resource or uncertain journal cannot authorize a new
generation or execution replay.

Current managed-context provisioning blocks recovery on any `ensureResource`
failure. A same-volume busy refusal must therefore be classified before resource
creation, with explicit proof that this attempt issued no create; it remains a
retryable wait on the original provisioning identity. Do not turn it into
UNKNOWN execution, release another holder, or permanently block an otherwise
untouched binding. All failures after a potentially effective create retain the
existing conservative blocked semantics. Test this distinction at the Broker
boundary, not just in the reservation repository.

## Worker admission and normal handoff

Introduce a versioned container control envelope and paired Java/TypeScript
fixtures; never append fields silently to strict boot-v2 or tool-v3 records.
Include immutable ContextBinding, storage registration/revision and reservation
identity in placement and admission checks. The worker opens no tool preparation
gate until it verifies mount incarnation/provenance and the current holder.
Approval cannot outlive the holder. Changing identities permanently closes the
local gate and preserves pending outcomes for original-identity reconciliation.

The new `managed-csi/1` boot-v3 envelope nests the unchanged closed boot-v2
context and a closed storage identity: cluster/backend domain, Namespace, PVC/PV
UID, driver/opaque handle, serial, physical key, registration revision and
reservation UUID/revision. Shared Java/TypeScript fixtures include independent
length-delimited SHA-256 values, Unicode and malformed/stale identities. The
ACK Disk mount observer reads bounded Linux mountinfo and sysfs serial, requires
one complete writable ext4 NVMe mount with no nested coverage or subdirectory
bind, and pins mount ID/device/source plus root dev/inode. Identity loss
permanently fences that observer. Parser conformance and retained kernel text
are not a fresh Linux worker acceptance. The container file entry now wires the
envelope, observer and separate authenticated CSI receipt route, but the public
CSI selector remains closed; the later trusted Broker create entry is described above.

An explicit durable retirement operation owns normal handoff. The generic
`release(request, lease)` callback remains unable to delete resources: a losing
Broker operation can share the winner's Pod. Retirement seals new dispatch,
waits for running tools and approval, settles output/history/checkpoints, obtains
successful worker and descendant termination, and verifies physical unmount
before CAS release. UID-conditioned deletion follows the saved original
resource identities; cleanup errors retain the durable holder.

The dispatch seal must share the parent binding lock with the authorization of
each new Tool dispatch. Merely checking READY before `claimDispatch`, or changing
the binding to DRAINING, leaves a race. PREPARED calls are cancelled without RPC;
already authorized calls retain their original dispatch identity and may only be
observed, cancelled and settled. Retirement inventory covers PREPARED and
DISPATCHING as well as executing, UNKNOWN and terminal receipts; ABANDONED is
uncertainty and never a normal handoff proof. Restart resumes a saved generation
through a settlement-only context, not ordinary acquire or activation.

The Broker now authorizes DISPATCHING-to-EXECUTING through the binding
repository's atomic admission operation. JDBC locks binding, Session and
execution in that order on one connection; memory uses the same parent lock.
Original cancellation and result reconciliation remain available. Custom binding
repositories must implement this operation; the default fails closed rather
than using a readiness read outside the execution CAS. This seals new execution
authorization but does not implement the durable CSI retirement coordinator.

The execution repository now provides a bounded exact-binding/generation
inventory across all Sessions and all seven execution states, including
PREPARED, DISPATCHING, SETTLED and ABANDONED. Its exclusive execution-hash cursor
remains valid when earlier records settle. Unsupported repositories refuse
the scan instead of reporting an empty inventory. This is a read component,
not a consistent settlement snapshot or a release predicate; the retirement
coordinator must seal admission before inventory and verify original outcomes.

Worker sealing also waits for tool lookup and capture preparation that have not
yet entered the execution journal. Executor shutdown now tracks the original
tool, capture-preparation and file-history entrance promises and waits for them.
It rechecks closing after asynchronous lookups, so a resumed V3 lookup cannot
start a new capture and a resumed MCP lookup cannot create a new invocation.
The existing best-effort `close()` methods,
`hasActiveSession()` that excludes UNKNOWN, provider disposal and parent-process
exit do not establish strict drain or descendant stop. An application drain
receipt only covers admission and original preparation/execution/publication
work. The independent trusted Pod/container termination and target unpublish
receipt establish physical stop for this bare-Pod profile.

Strict CSI sealing remains separate from shutdown: it must retain original
status/cancel/ack, history snapshot and MCP release while refusing new admission.
Successful promise completion cannot hide UNKNOWN, failed/partial capture or
uncommitted publication. Shell history backup cancellation and asynchronous PR
metadata writes also require explicit tracking or exclusion in the qualified
CSI execution profile; an invocation promise alone does not cover these tails.

Reuse the authoritative publication, Session journal/checkpoint and MCP extension
ledgers. FINISHED publication or Broker SETTLED alone is insufficient: require
complete original capture, a matching committed REFERENCED receipt, and a durable
checkpoint covering the settlement boundary. A continuation helper returning
null is not checkpoint evidence. Reuse the original MCP operation reconciliation
and `active → releasing → drained` generation transition; unknown replies and
close failures retain the holder. The CSI retirement journal stores only original
identity, phase and immutable evidence references. Final binding/slot and physical
holder release must use the same database connection and transaction; invoking
a repository method that opens another transaction cannot provide this atomicity.

Pod absence, NodeNotReady, VolumeAttachment disappearance, SQL epoch changes,
lease expiry, force deletion, and an HTTP release success alone do not establish
physical stop. Uncertain stop or settlement blocks handoff. Automatic fencing,
cross-fault-domain takeover, UNKNOWN replay and general operators/CRDs remain
outside K2.

### K2c first slice: durable intent and dispatch seal

A private `beginRetirement` operation accepts the exact registration, original
binding/generation, reservation UUID/revision and retirement UUID. A fresh
transaction locks placement domain, active slot, binding, alias, physical
reservation and journal in that order. It verifies the complete original seed,
handle, lease and live operation claim before atomically recording intent and
sealing dispatch. It changes RESERVED to DRAINING, clears the old coordinator
claim, and retains both slot and physical ownership. PROVISIONING, READY and
RECOVERY_BLOCKED are eligible; LOST remains blocked.

The journal pins original identities, binding version and optional scheduler
handle/lease without credentials. Missing handle means no scheduler identity is
recorded, never proof of no mount. Exact retry returns the original journal;
conflicting UUIDs, stale identities or altered resource pins fail closed. Generic
CAS cannot clear the sealed CSI gate, alter handle/lease/attestation or leave
DRAINING, including under a fresh operation claim. Original result/cancel and
Session release remain available. Transaction failure rolls back journal and seal
together. The private offline command adds no listener or cloud operation.

The October 5 integration preserves upstream V27–V40 byte for byte, including
the Java V29 Hook backfill, V35 Session tool profile, V36–V39 query optimizations
and V40 Session creator. Unmerged CSI reservation moves to V41, retirement
journal to V42, dispatch authorization to V43 and durable worker ACK to V44.
Earlier CSI V26-to-V27 and V27-to-V28/V29 runs remain historical source-snapshot
evidence; the integration needs a fresh V40-to-V44 upgrade test without rewriting
any already-applied database Flyway history. Verification covers V27 data preservation,
independent MySQL JVM dispatch races, exact restart retry, conflicting aliases,
corruption, rollback and LOCAL regression. This slice does not authorize ACTIVE,
worker drain, physical stop/unpublish, RELEASED or persistent CREATE/selector.

The first slice passed 27 focused Java tests and 17 independent real MySQL 8.4
checks on 2026-10-02. The MySQL checks observed actual RECORD lock waits in both
dispatch/seal orders and exercised the real offline command in independent JVMs.
Two reproduced defects were fixed: JDBC lease comparison must compare values,
and journal UTC time must use database epoch values rather than converting
session wall time. The final check kept the server in CST and the JVM in
Asia/Shanghai, verified the committed timestamp against an independent numeric
epoch interval, and normally shut down and removed the isolated database.
This evidence covers intent/seal; the earlier frozen ACK worker remains a
separate component qualification.

### K2c worker slice: admission seal and observations

The private endpoint belongs to the original boot-v3 worker generation.
It accepts `seal` or `status`, a canonical retirement UUID, the original closed
CSI attestation pin, runtime instance/incarnation and original Pod UID. Existing
bearer, lease ID/epoch, no-store and body limits apply. The synchronous seal
rejects new context installations, activation, tools, provider controls, MCP
configure/discover/invoke and publisher installation before starting work. Every
worker-owned asynchronous preparation rechecks admission at its final
mutation/start boundary. Provider controls already admitted into core may finish
their existing continuations; their pending work and permanent lifecycle blocker
prevent this slice from certifying strict completion.
Original status, cancel, result, acknowledgement, history snapshot and release
remain available; the listener and original mount identity remain alive.

This slice preserves the current capability contract. It does not silently
replace it with a smaller file profile or infer binding generation from lease
epoch. The endpoint identifies an application worker, not an independently
verified durable binding. A future retirement caller must match that exact
worker identity to the committed journal and trusted original scheduler handle;
boot has no independent bindingId/runtimeGeneration fields today. Any later
file-only profile or expanded identity envelope needs explicit Java/TypeScript
contracts and qualification before activation.

The executor reuses its invocation journal and pending preparations. A status
reports PENDING while preparations or original invocations remain, BLOCKED for
UNKNOWN, incomplete/uncommitted capture, entered capture preparation, installed
publication/MCP grants, failed mutating history controls, or provider/MCP/Shell
activity whose strict lifecycle is not qualified, and QUIESCENT only for observed completed
ordinary work. Neither a fulfilled Promise nor generic close establishes
settlement; starting shutdown is itself a permanent blocker. This application observation never returns DRAINED, changes the
journal, releases storage or proves descendant/container/unmount completion.
Broker execution inventory, publication receipts and Session checkpoints remain
separate authoritative requirements for the subsequent settlement stage.

On 2026-10-02, this worker slice passed 1,982 focused tests across ten files
(three focused runs), root build/typecheck/bundle and the changed TypeScript
files' lint check. Independent verification passed eight groups and two
supplementary groups, including actual local read/write, original V3 result/ACK,
stdio MCP and full-profile provider/context/publisher callers. Boot-v3 route
tests explicitly substituted mount observation and resolution; they do not
qualify Linux/ACK storage behavior. Two clean self-audit passes and a scoped
independent read review found no confirmed issue. The formal medium-effort
review timed out after 15 minutes without a verdict; it is not an approval.
The frozen ACK archive remains unchanged and does not cover the new endpoint.
[Durable dispatch authorization](2026-10-02-csi-dispatch-authorization.md) is
locally verified with 308 focused Java tests and 18 independent assertions/groups;
its scoped review found no confirmed issue and formal review timed out without
a verdict. The
[original-only publication settlement consumer](2026-10-02-csi-original-publication-settlement.md)
now locally passes 275 focused Java tests and 41 independent groups, including
actual MySQL lock waits, rollback, reload and late quarantine refusal. It retains
the DRAINING holder. Its formal review also timed out without a verdict. The next
slice must verify original publication receipts, covering Session checkpoints,
worker ACK and MCP durable settlement before any physical retirement.

Acceptance covers authenticated HTTP scope/UUID conflicts, post-await races,
original result/cancel/release, actual text read/write, UNKNOWN and capture
blockers, conservative provider/MCP/Shell blockers, and LOCAL regressions. The
frozen cloud worker archive is retained unchanged; this endpoint requires a new
worker qualification before any production handoff.

## Implementation sequence and affected layers

| Step     | Change                                                                                                             | Completion evidence                                                                                                      |
| -------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Platform | Read-only probes, then approved RWOP/network probes and cleanup                                                    | Actual rejection and persistence observations, retained UID/device evidence, scope and limitations recorded              |
| K2a      | Trusted CSI registration, physical-key resolution, durable reservation in Workspace persistence                    | MySQL concurrent independent connections/processes, alias collision, restart and stale CAS tests                         |
| K2b      | Broker pre-create admission, bounded PVC/PV API reads, Pod placement identity, container envelope and worker fence | No create before reservation; busy is retryable; ambiguous create retains holder; Java/TS fixtures and real worker tests |
| K2c      | Durable retirement, dispatch sealing, settlement and trusted stop/unmount proof                                    | Successful normal handoff; every uncertain stage keeps the original holder; no replacement replay                        |
| K2d      | Spring resolver/selector and registered Workspace file profile                                                     | Two independent volumes run concurrently; same volume serializes across Sessions; real MySQL and ACK tests pass          |

The main integration points are `KubernetesRuntimeProvisioner`,
`KubernetesHttpRuntimeClient`, `RuntimeBrokerService`, `WorkspaceRuntimeResolver`,
`WorkspaceExecutionStore`, `WorkspaceStorageGuard`, `WorkspaceRuntimeTransport`,
`EmbeddedRuntimeBroker`, the Spring migrations/properties, and the container and
managed-context workers. Keep the runtime-broker independent of Spring and keep
its `managedworkspace` package on the JDK alone. Final public admission changes
must also update the Workspace input and execution-profile guards. Shell v3
capture, MCP, restore and local-process recovery retain their existing gates.

K2a is a private persistence slice. An operator-only registration command accepts
reviewed registration data; it never authorizes mounting or creates Kubernetes
resources. Store an immutable JSON registration under a length-delimited
tenant/storage alias key, with its physical key and revision checked against the
decoded value on every read. Add CSI phase, reservation and revision columns to
the existing execution ownership table, with `LOCAL` defaults preserving V25
rows. All aliases insert or lock the same physical ownership row. CSI registration
and LOCAL claim/mount registration serialize through the existing tenant placement
guard and require a fresh transaction. They reject an enclosing transaction whose
older repeatable-read snapshot could hide a committed registration. CSI registration
refuses any existing legacy LOCAL row, including a released one; LOCAL consumers
refuse a CSI alias and constrain ownership reads/writes to `LOCAL`. K2a does not
convert storage profiles.

The implementation is aligned to upstream `a7deb01bc`. Upstream V26 owns the
public tool-result projection; the CSI migration was then V27 (V41 in this integration, as described above). A new
independent MySQL 8.4.11 run established V26-to-V27 preservation of the original
LOCAL holder, binding/session, projection samples, tables and indexes, together
with current CSI contention and dispatch regressions. Historical V25-to-CSI-V26
test records remain historical evidence; renaming an already-applied migration
does not establish a valid upgrade. Recheck the next free version before shipping.

Reserve only against the current PROVISIONING binding. Decode the complete durable
seed through the configured JDBC repository on the same locked transaction connection;
compare the complete request, seed, binding generation, resource/lease identity,
PROVISIONING state, drain flag and coordinator owner/operation generation. The
same operation's renewal may change record version and operation deadline between
the caller's snapshot and the locked read; those fields are not equality fences
for reservation admission. The authoritative deadline must remain non-null and
live at fresh database time after acquiring the physical lock,
including on an idempotent retry. CSI transactions and the locked authoritative read
have a ten-second SQL timeout; timeout is not a successful reservation or a busy proof. The same original reservation
retries idempotently; stale callers and another physical holder leave all rows
unchanged. K2a has no activate, release, timeout takeover or public selector.
The private pre-create adapter consumes this reservation through a separate
`reserveResource` step before the Broker starts renewal or enters `ensureResource`.
Its reservation UUID is stable for the original registration revision and provision
request. Only a typed physical busy from this step keeps PROVISIONING and permits
an original-identity retry. The Broker releases the coordinator claim on that path;
it does not release physical storage. After successful admission it renews the
original operation before entering the existing resource workflow. A failure after
entering ensure retains the existing fail-closed recovery semantics, even if its
error happens to have the same busy code.

The legacy three-argument adapter still refuses ensure before any Pod or Secret
CREATE. The later explicitly trusted constructor adds resource-protection,
PVC/PV, Pod/node/container/image and mount checks as described in the durable ACK
design. Full physical retirement remains unimplemented.

Private CSI Pod verification rejects unknown spec, container and security-context
keys while permitting the explicitly supported API defaults to be omitted.
Built-in ServiceAccount and Priority admission may add `imagePullSecrets` and
`priorityClassName`; both are accepted during creation and original-Pod recovery.
Other unsupported admission mutations remain refused. In particular a container
cannot override the Pod's non-root user policy. A failed operation invalidates
only a cached placement matching its original request,
seed and handle; a foreign seed or forged handle cannot revoke a live original
worker. ConfigMap GET has a separate one-MiB-plus-64-KiB response budget for the
JSON envelope around a base64 chunk bounded to one MiB. Native CSI logs retain
the strict one-MiB byte limit. These checks do not implement physical retirement.

## Acceptance and unresolved contracts

Run the existing build/typecheck/bundle, focused Java/TS tests and MySQL contracts
after implementation. Run the new target-cluster matrix only against the
approved disposable scope. Self-audit the complete diff twice without findings
and complete independent review of the integrated source. Earlier scoped review
results and formal runs without verdicts do not approve this integration.

The implementation remains gated on actual RWOP support, the registered-object
replacement boundary, ACK Disk mount provenance and trustworthy normal
stop/unmount evidence. Define each contract from target-platform observations
before opening the corresponding execution gate. This document records the full target and stage-specific implementation;
partial evidence does not establish production readiness.

## Mainline integration: Hook sealing and migrations

The same upstream ManagedHookRuntime now receives the CSI seal and rechecks
admission after directory resolution and before native dispatch. Original
operation replay, status and cancellation remain available; new Hook entry is
refused. Aggregate inspection includes pending starts and unsettled operations;
any started Hook lifecycle permanently retains `hook_lifecycle_unqualified`,
including after ordinary close. This is not proof of physical Hook drain. Hook
race tests and actual-worker qualification belong to the integrated source.
