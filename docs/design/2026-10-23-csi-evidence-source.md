# Resident Workspace scope and platform-managed reclamation

[English](2026-10-23-csi-evidence-source.md) | [简体中文](2026-10-23-csi-evidence-source.zh-CN.md)

## Status and scope decision

On 2026-10-24, the operator accepted removing complete CSI auditing from the first-release prerequisites for [#13395](https://github.com/QwenLM/qwen-code/issues/13395). This document replaces the earlier P1 evidence-source proposal at the same path. The [published original proposal](https://github.com/QwenLM/qwen-code/issues/13395#issuecomment-6363776281) is historical; its P1 → P2 → P3 → P4 dependency chain is superseded by the delivery plan below. The first release no longer waits for a plugin audit hook.

The audit withdrawal restored the unpublished slice to its historical baseline `7ab5a95c61d5785ac66e50144e41ce29a7cf4cd5`. Subsequent native S1 qualification is pinned separately to main `2c0c9fa8dc4a8ea5ec688060549e0ff0aed717b4`. The original scope adjustment changed documentation only; on 2026-10-25, the operator requested the two S1 corrections below in the same PR. Neither those corrections nor synchronization with main extend native qualification beyond the tested revision. This work introduces no reclamation service. Platform-managed reclamation, automatic physical-owner release and cross-Workspace volume handoff remain future work. Scope adjustment does not establish full issue acceptance.

## Current implementation

[Resident Workspace execution](2026-10-14-k2-resident-workspace.md) supports public Read/Write/Edit Sessions on the same original Pod/PVC. A successful Session close settles work, revokes its context and releases its Runtime Session. A later Session may reuse the still-qualified original runtime. The binding stays `READY`; physical storage ownership stays `RESERVED`.

[Explicit idle retirement](2026-10-20-k2-physical-retirement-progress.md) checks terminal Sessions, sealed journal heads or permanently deleted heads with cleared writers, released Runtime Sessions and settled tool executions. It durably fences the Workspace and original binding as `DRAINING`, retaining the active slot and original storage owner. It has no automatic TTL trigger or undo.

The existing `delete-pod` action records and sends a bounded normal DELETE attempt for the verified original Pod, with UID/resourceVersion preconditions, a 30-second grace period and Background propagation. It does not wait for termination. `RETURNED` means that a complete HTTP response was recorded, including non-2xx responses; it does not mean deletion, process termination or unmount completed. Lost or incomplete responses remain `UNKNOWN`. Retirement continues to retain the slot and `RESERVED` owner; it does not reopen the Workspace or create a replacement Pod.

## First-release contract

| Area                     | Delivery boundary                                                                                                                                                                                                           |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session handoff          | Same tenant/Workspace and generation, same original healthy Pod/PVC; only after the preceding close succeeds and existing admission checks pass.                                                                            |
| Explicit idle retirement | Existing `inspect`, `begin` and bounded `delete-pod` actions, with durable SQL fencing and retry/readback semantics.                                                                                                        |
| Retained resources       | Keep the original binding, active slot, reservation and history. Maintenance does not delete PVC/PV, Secret or protection objects. Remaining storage and other retained resources continue to incur their applicable costs. |
| Platform trust           | Trust reviewed administrators, Kubernetes, the host and qualified ACK Disk CSI. Preserve actor grants, original runtime/mount identities, registration/protection checks, RWOP, Filesystem, ext4 and disk-serial matching.  |
| Failure handling         | Node loss, identity replacement, timeout, force deletion, Pod absence or uncertain outcomes cannot grant automatic release or handoff. Preserve ownership and closed admission.                                             |
| Deployment               | Use the supported CSI deployment and existing resident configuration. No CSI endpoint proxy, write-ahead audit hook, node recorder, CRI access or pre-publication enrollment gate is required by this scope.                |

Normal Session handoff remains available only before retirement. Removing the audit prerequisite grants no new recovery authority and does not make a missing or replaced original worker adoptable. Shell/MCP/Hooks, active-Session forced drain, automatic replacement and cross-tenant reuse remain outside this release.

## Withdrawn local implementation

Remove this task's uncommitted `CsiEvidenceProtocol`, `CsiEvidenceStore` and their fixtures/tests, along with `CSI_EVIDENCE`/`CSI_EVIDENCE_PAGE` schema and operation kinds, evidence-specific retention and inventory changes. Restore those tracked Java/SQL/test files exactly to the reviewed baseline. Keep the withdrawn files and test history in a task-local ignored snapshot; prior tests describe that withdrawn source, not this release or platform qualification.

Preserve existing `WORKSPACE_RETIREMENT`, `POD_DELETE_ATTEMPT`, private CSI retirement, runtime recovery, retention and diagnostic readers. Do not add an unused feature flag, source configuration or evidence ingress. The withdrawal itself changed documentation and planning; the later S1 fixes below change runtime admission without changing the schema. The archived withdrawal comparison refers to the earlier baseline, not to current-main acceptance.

## S1 corrections in this PR

Two independent resident containers may both mount at `/workspace` without sharing storage. The in-memory and SQL placement fences therefore ignore a matching canonical path only when both requests select the exact resident capability, Workspace isolation and `kubernetes-workspace` provisioner. The same tenant/Workspace or storage identity still blocks new placement, and paths involving a nonresident request keep their earlier rules. Registered physical ownership, original-slot checks and retirement admission remain authoritative; a different storage alias does not authorize a reserved physical volume.

The SQL resident predicate has the same effective boundary as the in-memory request predicate. Workspace isolation requires a null isolation key in the request constructor, and the independent `storage_id IS NULL` blocking arm prevents rows without managed context from using the path exemption. Neither invariant permits bypassing the same-storage or same-Workspace arms.

The saved `hosted-workspace-files/1` profile admits both ordinary and resident Workspaces, so its model catalog must resolve the saved capability first. A legacy file turn without an explicit profile or Shell/MCP/Hook/publication dependency follows the same rule. Known nonresident profiles, including Shell, MCP, file-search and read profiles, keep their existing declaration path without this lookup. A new internal `POST /internal/runtime-broker/v1/runtimes:capabilities` resolves the existing Harness Session through its admission resolver and returns only its scope. Its body is exactly `protocolVersion`, `requestId` and `harnessSessionId`; its response adds `scope` containing `tenantId`, `workspaceId`, `workspaceGeneration`, `isolationClass` and `capabilityDigest`. It uses the existing Broker authentication and lifecycle-authority checks. It creates no binding, Pod, Runtime Session or storage reservation and returns no worker credentials or endpoint. The route is scoped to the persisted Workspace resolved from that Harness Session, not a caller-supplied Workspace or the primary runtime.

The Hosted client shares concurrent resolution attempts, retains a successfully validated capability and clears a failed attempt so a later call can retry. It uses the same scope parser as warm/acquire. On a Broker with this route, catalog construction waits only for the metadata read while physical warmup remains concurrent; text-only inference does not wait for a Pod to become ready. If an older Broker returns HTTP 404, the file turn instead waits for its already-started warm request and uses that request's validated capability, without sending another warm. This compatibility path may wait for physical readiness. Authentication, transport, HTTP 503 and scope failures do not downgrade to ordinary tools; absent or foreign warm scope is also refused.

The resident runtime vocabulary contains only `read_file`, `write_file` and `edit`; a returned unsupported call, including a client-initiated Skill, is recorded as a correctable batch refusal before acquire, prepare or dispatch. Existing public Plan mode retains its Harness-local `exit_plan_mode` control: an active plan declares Read and plan exit, and durable approval restores Write/Edit without dispatching plan exit to the worker.

For older Harnesses or direct Broker callers, a valid unsupported resident payload is rejected before dispatch. The existing atomic `settlePrepared` operation writes `not_started`, empty `responseParts`, explicit `capture: null` and a `resident_tool_unsupported` error only if the original identity, version and `PREPARED` state still match. Dispatch generation remains zero and no worker is called. On a racing claim or a preexisting `UNKNOWN`, the Broker returns the stored record without changing its outcome. A worker HTTP error or uncertain effect never becomes local proof that execution did not start.

Regression coverage must include independent resident storage sharing a mount path after each retained failure/retirement state, repository restart and real MySQL, plus same-Workspace/storage and nonresident-path refusals. Tool checks must cover read-only authenticated capability resolution, concurrent reads and retry after failure, legacy HTTP 404 with valid or foreign warm scope, refusal of non-404 failures, ordinary profiles declaring without a metadata request, resident catalog and forged calls, pre-dispatch settlement, repeat requests, and preservation of dispatched/unknown work. Existing approval/media/fault consumers must retain their behavior; fault drivers classify the capability route as Harness-scoped while retaining their Runtime identity and no-replay assertions. A real-process Hosted file handoff remains a separate required check. Local checks and CI do not replace a new native ACK run on the corrected revision.

## Follow-up platform-managed reclamation

The [S2/S3 reclamation design](2026-10-27-resident-workspace-reclamation.md) specifies the proposed completion, atomic release, and retained-data handoff contract. Its implementation and platform qualification are tracked separately from the historical S1 evidence below.

The next design delegates ordinary container termination and volume cleanup to supported ACK/Kubernetes lifecycle mechanisms. Complete CSI RPC history is no longer a required implementation choice. Before implementing release, that design must define:

1. Exact eligibility and immutable identity joins for the original Workspace, runtime generation, Pod/node, registered volume and current reservation.
2. The platform-supported completion contract for a healthy normal shutdown, its authoritative observations and durable readback after restarts or lost responses. Pod phase, Pod absence, a returned DELETE, VolumeAttachment disappearance and a single cloud-disk status are not individually sufficient release conditions.
3. A distinct exceptional path for node loss, forced deletion, timeouts and unknown results. Keep ownership until a reviewed platform completion or node/storage fencing procedure satisfies the new contract; operational cleanup alone does not mutate product ownership.
4. One database transaction that revalidates that contract and current generations before changing retirement, binding, active slot and physical ownership. Stale senders and repeated requests must not release a newer owner.
5. Data retention/reset policy and restrictions on reuse across Workspaces and tenants, plus crash, lost-response, identity-replacement and node/network-partition acceptance cases.

These are design requirements, not implemented predicates or permission to release today. No particular node/storage fencing API or ACK completion signal is qualified by this adjustment. Node recovery and CSI LOST handling remain separate; unknown tool effects must never be replayed on a replacement runtime.

## Delivery and validation

| Stage                          | Work and completion condition                                                                                                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S1: first-release closure      | Validate the retained Session handoff and bounded idle-retirement behavior on the exact accepted source and supported deployment; record remaining production/security qualification explicitly. No complete CSI audit prerequisite. |
| S2: reclamation design         | Review the platform completion, exceptional isolation, data policy and transaction contract above. Select supported platform APIs and define positive/refusal/fault cases.                                                           |
| S3: reclamation implementation | Implement only the approved S2 contract, then qualify atomic release and repeated reuse. No S3 release permission exists before those checks pass.                                                                                   |
| Independent recovery           | Define CSI LOST recovery and operator procedures without reopening unknown writes or bypassing the original owner.                                                                                                                   |

Native S1 qualification at `2c0c9fa8dc4a8ea5ec688060549e0ff0aed717b4` found a blocking placement limitation: after one resident binding enters `DRAINING`, a new Workspace in the same tenant can fail with `runtime_placement_recovery_required` even when it has a different registered disk and storage identity. The placement fence also matches the common `/workspace` canonical path. An already provisioned independent binding remained usable, but that does not qualify independent cold provisioning. Preserve this failure in [#13395](https://github.com/QwenLM/qwen-code/issues/13395); qualification in a separate test tenant cannot clear it. S1 requires this boundary to be resolved and verified before acceptance.

The same native run found a second blocker in the public tool boundary: the actual model catalog advertised `web_fetch`, but the original resident worker refused it with HTTP 409. Without an injected response fault, the dispatched call remained SQL `UNKNOWN` and a later Session was refused with `workspace_busy`. Authenticated probes confirmed exact refusal of unsupported tools and successful adjacent Reads on that same original worker; they do not qualify the public catalog as correct. Align advertised capabilities with resident admission and verify that a known unsupported call cannot strand the Workspace before accepting S1. MCP catalog and missing-Hook-catalog observations do not qualify effectful MCP or Hook execution.

The original documentation adjustment checked the archived withdrawal comparison, absence of withdrawn production references, bilingual consistency and Markdown references. The S1 runtime corrections require their own focused Java/real-MySQL and Hosted-process evidence, TypeScript build/typecheck and affected consumer tests, plus the applicable full CI gates. Preserve the exact historical S1 source pin; neither those earlier documentation checks nor withdrawn evidence-source tests validate the new runtime increment.

Later S1/S2/S3 acceptance must separate source implementation, focused tests, CI, native ACK qualification and production readiness. The earlier ACK run at `c61044fae46cfeed70b882140730c0caaa944524` covered same-Pod/PVC file handoff and bounded retirement; it does not validate a new source revision or physical reclamation. Resolve S1 acceptance blockers before progressing to the S2 completion/isolation contract; plugin-audit availability is no longer the prerequisite.

## References

- [Resident deployment](../../deploy/k2-resident/README.md) and [bounded idle retirement](2026-10-20-k2-physical-retirement-progress.md).
- [Kubernetes deletion semantics](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_delete/): force deletion does not wait for process termination.
- [Kubernetes node shutdown](https://kubernetes.io/docs/concepts/cluster-administration/node-shutdown/): node failure and forced detach require special handling; an out-of-service taint requires prior shutdown/power-off verification.
