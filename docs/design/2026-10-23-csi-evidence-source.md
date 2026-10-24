# Resident Workspace scope and platform-managed reclamation

[English](2026-10-23-csi-evidence-source.md) | [简体中文](2026-10-23-csi-evidence-source.zh-CN.md)

## Status and scope decision

On 2026-10-24, the operator accepted removing complete CSI auditing from the first-release prerequisites for [#13395](https://github.com/QwenLM/qwen-code/issues/13395). This document replaces the earlier P1 evidence-source proposal at the same path. The [published original proposal](https://github.com/QwenLM/qwen-code/issues/13395#issuecomment-6363776281) is historical; its P1 → P2 → P3 → P4 dependency chain is superseded by the delivery plan below. The first release no longer waits for a plugin audit hook.

The reviewed implementation baseline is `7ab5a95c61d5785ac66e50144e41ce29a7cf4cd5`. This adjustment withdraws the uncommitted evidence-source slice; it does not introduce a new reclamation service. Platform-managed reclamation, automatic physical-owner release and cross-Workspace volume handoff remain future work. Scope adjustment does not establish full issue acceptance.

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

Preserve existing `WORKSPACE_RETIREMENT`, `POD_DELETE_ATTEMPT`, private CSI retirement, runtime recovery, retention and diagnostic readers. Do not add an unused feature flag, source configuration or ingress. The resulting deliverable changes documentation and planning while runtime and schema remain at the reviewed baseline.

## Follow-up platform-managed reclamation

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

For this adjustment, verify that the server's tracked Java/SQL/tests equal the baseline, withdrawn source files and evidence kinds have no remaining production references, both language versions match, and Markdown formatting/relative references pass. No runtime behavior is added, so a new CLI, Maven or MySQL run is not evidence needed for this documentation change. Earlier evidence-source test snapshots remain historical.

Later S1/S2/S3 acceptance must separate source implementation, focused tests, CI, native ACK qualification and production readiness. The earlier ACK run at `c61044fae46cfeed70b882140730c0caaa944524` covered same-Pod/PVC file handoff and bounded retirement; it does not validate a new source revision or physical reclamation. The next delivery decision is the S2 completion/isolation contract, rather than a plugin-audit availability decision.

## References

- [Resident deployment](../../deploy/k2-resident/README.md) and [bounded idle retirement](2026-10-20-k2-physical-retirement-progress.md).
- [Kubernetes deletion semantics](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_delete/): force deletion does not wait for process termination.
- [Kubernetes node shutdown](https://kubernetes.io/docs/concepts/cluster-administration/node-shutdown/): node failure and forced detach require special handling; an out-of-service taint requires prior shutdown/power-off verification.
