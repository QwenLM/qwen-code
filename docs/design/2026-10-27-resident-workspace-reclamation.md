# Resident Workspace reclamation and retained-data handoff

[English](2026-10-27-resident-workspace-reclamation.md) | [简体中文](2026-10-27-resident-workspace-reclamation.zh-CN.md)

## Status

Combined S2 design and S3 implementation for [#13395](https://github.com/QwenLM/qwen-code/issues/13395). Implementation baseline: main `0539160f35f983ba4a6d4d369c0ae18941b2fdb2`. This document describes the implemented contract; complete platform acceptance remains pending.

On 2026-10-27 focused Java/Checkstyle, real MySQL/process checks and an isolated ACK healthy handoff passed in their recorded scopes. The native run used the implementation baseline plus the 31-file source manifest with SHA-256 `9edfca3f939c5e19b4cebdacbc13460b9c4b4590c2de2c9113b30d59fa299ee2`, ACK `1.36.2-aliyun.1` and Disk CSI `1.37.3`. One disk passed A→B→C→D with reserved revisions `1/3/5/7`, released revisions `2/4/6`, and 22 successful file-tool executions preserving prior bytes. The model endpoint was a controlled fixture. This evidence covers that source/artifact snapshot and healthy sequence; a rebase does not qualify a new integrated artifact. Full CI, the required native fault matrix and production least-privilege qualification remain pending.

On 2026-10-27 the operator selected preserving files and explicitly handing the disk to another Workspace in the same tenant. Reuse must preserve this decision through every ownership cycle. The [existing delivery boundary](2026-10-23-csi-evidence-source.md) and separate CSI LOST recovery issue [#12670](https://github.com/QwenLM/qwen-code/issues/12670) still apply.

## Problem and baseline state

Idle retirement fences the Workspace and original binding as `DRAINING`. It retains the active slot and `RESERVED` physical owner. Its normal Pod DELETE records an actual HTTP result or `UNKNOWN`; neither result releases anything. There is no durable platform-cleanup receipt or atomic physical release.

Four resident consumers assume reservation revision `1`, and the shared original-only CSI protocol allows only revisions `0`, `1`, and `2`. Releasing the current owner without changing these consumers cannot support repeated handoff. The CSI owner also lacks a populated tenant data owner. Clearing its reservation identity would otherwise let a foreign-tenant alias acquire retained files. Retirement inspection currently depends on the active configuration mapping, so changing that mapping would hide the old operation.

## Goals and boundaries

Provide explicit administrator maintenance for a healthy, idle, original resident runtime, with durable readback, atomic release, and repeated same-tenant handoff. Preserve original files, PVC/PV, disk, protection, and historical identity. Keep one configured Workspace per physical volume.

Do not add automatic expiry, active-Session forced drain, reopening of the retired Workspace, same-request replacement generations, cross-tenant reuse, data wiping, Shell/MCP/Hooks, CSI RPC auditing, node agents, or automatic LOST recovery. An uncertain shutdown stays fenced. External infrastructure cleanup does not itself change product ownership.

## Trust and platform completion

The supported boundary trusts the reviewed administrator, Kubernetes API and kubelet, host, and qualified ACK Disk CSI. The maintenance process uses its configured HTTPS origin, pinned CA, rotating credentials, and existing registration/protection verification. A request file supplies identity only; it cannot supply a completion receipt or claim that a node was fenced.

The runtime namespace and PVC are exclusive to this single Managed provisioner. Deployment admission/RBAC must exclude other Pod creators and external controllers using the PVC; administrators must not remount, alias, or force-modify the storage during maintenance or handoff. The existing resource protection alone does not enforce Pod-creation exclusivity. Complete bounded namespace Pod scans at preparation and completion reject every nonoriginal Pod referencing the PVC, including Pending and terminal Pods. Complete bounded PV scans require the registered name/UID to be the sole PV for the CSI driver/volumeHandle and reject physical aliases. Product-created consumers are fenced by Workspace and physical ownership. A receipt does not claim safety against subsequent external remount or cluster-admin actions outside this prerequisite.

Normal completion requires all of these observations, joined to the original resource handle:

1. Before DELETE, the exact original Pod is running with the original sole container ID, image ID, zero restarts, spec digest, Pod UID, and node UID. It has no owner references, deletion timestamp, or foreign finalizers. The original healthy node has a nonempty boot ID, the CSI unique volume in `status.volumesInUse`, and exactly one matching attached `VolumeAttachment` for the original PV, driver, and node. Record its UID. A current `kube-node-lease` Lease must belong to that Node UID and name.
2. Install only the operation's deterministic Pod finalizer with JSON Patch tests for UID and resourceVersion, before sending the existing normal 30-second graceful DELETE. Preserve the Pod object while the kubelet and CSI perform normal cleanup. The finalizer is a metadata retention mechanism, not evidence of physical completion.
3. Observe that same deleting Pod with the owned finalizer still present, unchanged spec and container identity, and the original container explicitly `terminated`, including `finishedAt`. A Pod phase alone is insufficient. Require no restart, replacement container, init container, or sidecar.
4. Read the same Node UID and boot ID, `Ready=True`, no deleting/out-of-service state, and no occurrence of the original CSI unique volume in either `status.volumesInUse` or `status.volumesAttached`. Its Ready heartbeat must advance beyond the baseline and cover the container termination. Read the same Node Lease UID with the same Node owner and holder, a renewed lease after termination, and a current renewal within its declared duration, capped at 60 seconds. An old Ready condition or a fresh Lease alone is insufficient.
5. A complete, bounded list of `storage.k8s.io/v1/volumeattachments` must contain no attachment for the original PV. Reject partial pages, malformed entries, duplicate identities, inconsistent pagination, overflow, and a replacement matching attachment. Recheck the original registration and protection. These are conjunctive observations, not independent release permissions.

The unique volume name is `kubernetes.io/csi/<driver>^<volumeHandle>`, matched exactly. Node and Lease timestamps are evaluated conservatively; clock skew or missing fields holds ownership. No force delete, force detach, node shutdown claim, cloud-disk status, or user-supplied boolean can substitute for these conditions.

`deletionTimestamp` is a grace deadline, not the start of deletion. The original container may finish before it, and normal kubelet finalization may change it. Require a valid non-null deletion timestamp and the original terminated-container evidence; do not compare `finishedAt` against the grace deadline or require that deadline to stay equal to the saved receipt. Fresh Node/Lease observations must still cover termination. See Kubernetes [graceful deletion implementation](https://github.com/kubernetes/kubernetes/blob/v1.36.2/staging/src/k8s.io/apiserver/pkg/registry/rest/delete.go).

Kubernetes documents [graceful Pod termination](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/) and [finalizers](https://kubernetes.io/docs/concepts/overview/working-with-objects/finalizers/). The kubelet removes terminating Pods from its desired volume state after their containers stop; the attach/detach controller removes terminal Pods from its desired state. Therefore a retained terminal Pod should permit normal volume cleanup. This ordering is an implementation dependency to verify on the target ACK release. [Non-graceful node shutdown](https://kubernetes.io/docs/concepts/cluster-administration/node-shutdown/) can force detach without normal unmount; that path is excluded by the same-node, same-boot, terminated-container and fresh-status checks. A missing VolumeAttachment alone never proves unmount.

## Maintenance protocol and durable state

Extend the existing trusted maintenance entry point; expose no public or daemon route. The existing `inspect`, `begin`, and deletion-only `delete-pod` remain available. Add `prepare-reclamation <request-json> <resourceVersion>` and `reclaim <request-json>`.

| Stage                 | Durable contract                                                                                                                                                                     | Infrastructure action                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `begin`               | Save a versioned immutable plan with the original mapping, request, binding/generation, handle identity and digest. Set Workspace/binding `DRAINING`; retain slot and owner.         | None.                                                                          |
| `prepare-reclamation` | Save the original node boot/Lease/attachment baseline and a bounded conditional finalizer attempt before I/O.                                                                        | Add the owned finalizer to the verified original Pod.                          |
| `delete-pod`          | Preserve the existing per-Pod-UID/resourceVersion attempt and `UNKNOWN` semantics. A prepared operation accepts exactly its owned finalizer.                                         | One normal UID/RV-conditional DELETE per durable attempt.                      |
| `reclaim`: observe    | Revalidate the held original identity and idle state. Save a bounded immutable cleanup receipt and its digest; move operation to `PLATFORM_CLEANED`.                                 | Read the conjunctive completion observations above.                            |
| `reclaim`: finish     | Save the conditional finalizer-removal intent before I/O. Keep all product ownership until the original Pod is absent.                                                               | Remove only the owned finalizer using UID/RV tests; read original Pod absence. |
| `reclaim`: commit     | In one SQL transaction mark the operation `RELEASED`, binding `RELEASED`, clear only its active slot, advance the physical revision to `RELEASED`, and retain tenant data ownership. | None.                                                                          |

Every mutation is preceded by durable intent and uses a bounded response. Lost, incomplete, or unrecorded responses remain `UNKNOWN`. A DELETE attempt at the same Pod UID/resourceVersion is never resent. Metadata PATCH alone permits a bounded retry after a fresh GET proves the original UID, the pre-effect finalizer set, and the same or newer resourceVersion. Each PATCH tests UID, resourceVersion and the exact pre-effect finalizer set; a successful write advances the version and rejects stale copies. Preserve every old `UNKNOWN` attempt and SQL claim-generation fencing. This permits recovery from a crash before PATCH without waiting for an unrelated Pod change. Do not rewrite an earlier `UNKNOWN` DELETE into success when later observations prove cleanup.

Keep the receipt independent from transient HTTP outcomes. Once the exact original deleting Pod is terminal and its physical cleanup has been durably observed, that fact can survive a process restart and finalizer removal. A crash before receipt persistence requires observing completion again; Pod absence without a saved receipt cannot reconstruct one. A crash after receipt persistence resumes only the owned-finalizer cleanup and final SQL transition. Refuse a same-name replacement Pod even after recording cleanup.

An old version-1 deletion-only plan remains inspectable and conservative. It cannot retroactively qualify a Pod that was deleted without preparation. New plans freeze their mapping so terminal inspection after configuration changes needs no current mapping or current owner equality. Validate the original request actor's current OWNER grant, tenant, Workspace and generation, immutable plan and receipt digests, and terminal binding history. Keep the retired Workspace `DRAINING`; do not misuse the public Workspace removal lifecycle as a physical-release signal.

## Atomic release and lock order

Use the existing ten-second transaction bound and lock order: tenant placement guard, tenant publication guard, Workspace/access, original runtime slot, original binding, storage alias, physical owner, retirement operation, then Session/journal/RuntimeSession/execution idle checks. No Kubernetes HTTP call occurs inside this transaction.

At final commit, recheck the immutable plan and receipt, exact original binding and generation, sealed `DRAINING` state, no operation claim, original resource handle/lease identity, active slot, registration/protection, held reservation ID/revision/seed, and idle state. Require the terminal original-Pod readback associated with that receipt. Update the binding through a dedicated transaction-only repository primitive. Keep general binding CAS closed to sealed CSI transitions.

The physical CAS clears binding, reservation, registration and provision-seed references only for that exact holder. Preserve the tenant data owner. Advance revision without reset. Clear the exact active slot while preserving its last generation and original request identity. Mark retirement terminal in the same transaction. Any mismatch or failed update rolls everything back. A stale sender or lost SQL reply reads the terminal receipt and cannot modify a later holder.

Retain the original binding through `WORKSPACE_RETIREMENT` references, including terminal records. This is intentionally bounded by explicit maintenance history retention; this change adds no automatic deletion of those records. The receipt and original history must remain inspectable after another Workspace reserves the disk.

## Repeated same-tenant handoff

Populate and preserve `ma_storage_owner.tenant_id` on the first CSI reservation. Registration, inspection, and reservation refuse a different tenant once this owner exists. A previously reserved pre-release row may be backfilled only under the exact original binding/registration lock; never infer the tenant from the new claimant.

Resident ownership uses monotonically increasing even `RELEASED` and odd `RESERVED` revisions: `0 → 1 → 2 → 3 → 4 → 5`. Match the exact revision from the original handle at every execution, close, observation and retirement read. The private CSI retirement protocol retains its original-only `0/1/2` predicates and does not gain release or reuse authority from this extension. Later-cycle reservations require the resident profile; overflow or invalid phase/revision fails closed.

After `RELEASED`, the administrator replaces the sole configured mapping with a different Workspace in the same tenant and restarts with the new configuration. The existing PVC/PV, physical key, registration and files remain. Use a new Workspace ID and request key; its generation starts at 1 and its reservation gets the next physical revision. The old Workspace and request stay fenced. This configuration action is the explicit data handoff; there is no implicit assignment based on a disk becoming available. Concurrent aliases still serialize on the physical owner, and only one exact claimant can reserve it.

## Exceptional paths and readback

| Observation                                                                                                     | Required outcome                                                                     |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Busy Session, live writer, unsettled execution or RuntimeSession                                                | Refuse maintenance; do not install a new fence or release anything.                  |
| API outage, lost reply, stale Lease/heartbeat, missing node, changed boot ID, partition or out-of-service taint | Retain original slot/owner and closed admission; report incomplete reclamation.      |
| Forced Pod deletion or missing Pod before a saved cleanup receipt                                               | Hold ownership; no receipt synthesis from absence.                                   |
| Replaced Pod/node/PVC/PV/protection/attachment or changed container                                             | Hold ownership; never adopt the replacement.                                         |
| Crash before the release transaction commits                                                                    | Recover the held original state and resume readback; no partial release.             |
| Crash or lost response after commit                                                                             | Return the same terminal receipt, including after subsequent reuse; no new mutation. |
| Foreign tenant or old Workspace tries to acquire the disk                                                       | Refuse, preserving both data tenancy and the new holder.                             |

An administrator may diagnose and repair infrastructure independently. Such repair does not authorize an exceptional product release. A future node/storage isolation procedure must have its own reviewed API contract and qualification; this change does not provide an override command. CSI LOST recovery and replay of unknown tools remain out of scope.

## Components affected

Extend the resident retirement store and maintenance entry point, bounded Kubernetes HTTP client, transaction-only binding repository, CSI reservation store, resident execution/close/observation predicates, operation state/work domains in the canonical V1 schema, and runtime retention guard. Update focused Java, MySQL and process-crash tests and the bilingual resident deployment instructions. No TypeScript, public API or OpenAPI changes are planned.

The canonical V1 work-kind domain changes. Follow the server's pre-release schema policy and recreate development catalogs; this change supplies no V2 migration or catalog upgrade path. Reading an old version-1 retirement plan is a protocol safeguard, not a promise that an older catalog can be upgraded in place. Preserve the separately retained volume files.

## Validation and acceptance

Use the detailed ignored E2E plan under `.qwen/e2e-tests/13395-s2-s3-20261027/`. Dry-run the global CLI first and explicitly record if the private maintenance path needs a Java/API fallback. Share one 600-second local Java verification budget across setup, builds, selected unit tests and selected real MySQL/process cases; leave full profiles to CI and keep uncovered checks explicit.

Required acceptance includes at least three reserve/release cycles with preserved file contents across distinct same-tenant Workspaces; execution and close at revisions greater than 1; foreign-tenant and old-Workspace refusal; two concurrent claimants; platform identity substitutions; API and node/network partition retention; duplicate and lost replies; crashes before/after receipt persistence and SQL commit; rollback at each release write; and terminal inspection after mapping replacement and later reuse. Verify task-owned resource cleanup independently.

Native ACK qualification must record Kubernetes/CSI versions and exact source/artifact identity. Prove the owned finalizer permits container termination, Node volume cleanup, attachment removal and final Pod deletion without a node-side helper. If that sequence fails, keep release disabled by its unmet predicates and revise the design; a unit fixture or Pod DELETE success cannot establish acceptance. Qualify healthy normal completion and fail-closed exceptional cases separately. Required CI profiles and full native acceptance remain pending until their evidence exists.

## Open qualification questions

Extend the recorded healthy retained-Pod cleanup result to the required native fault matrix and any different target Kubernetes/CSI versions. Verify production exclusive namespace/PVC use and the absence of external creators/controllers; the isolated run verified its own creator admission boundary. Check deployment RBAC grants only the additional Pod patch/list, Node Lease get, and PV/VolumeAttachment list permissions needed by this maintenance process; the isolated run used a trusted administrative control plane and did not qualify minimum RBAC. These are platform verification tasks, not permission to weaken completion conditions.
