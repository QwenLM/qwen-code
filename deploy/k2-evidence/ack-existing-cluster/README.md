# Original ACK isolated-node CSI exclusion candidate

[English](README.md) | [简体中文](README.zh-CN.md)

Status: on 2026-10-11 the reviewed CSI exclusion policy/binding was installed and the new node’s default CSI Pod was normally deleted with user approval. No collector has been installed. The target is the
existing ACK `c679c4016ff0b4872aa43a2b6688343e8`. The original shared nodes
`cn-beijing.10.135.59.8` and `cn-beijing.10.135.59.9` are outside the experiment.
The generator refuses either name. This is an addon exclusion component, not a
complete admission/confinement contract or physical-release qualification.

Kubernetes documents that the DaemonSet controller replaces a created Pod's
required node affinity with the selected Node name. That supports rejecting
the new node's CSI Pod at admission while preserving the original DaemonSet
template. Actual ACK admission dry-runs rejected the new-node direct and controller-affinity requests and admitted the two original-node affinity requests. After normal deletion, actual controller FailedCreate events named the installed policy/binding. [DaemonSet scheduling](https://kubernetes.io/docs/concepts/workloads/controllers/daemonset/)
ACK documents VAP integration for versions 1.30 and later; actual API discovery,
permissions, type checking and enforcement require live verification for each installation. This dated experiment completed those checks for the CSI exclusion objects only.
[ACK VAP support](https://www.alibabacloud.com/help/zh/ack/ack-managed-and-ack-dedicated/security-and-compliance/use-validating-admission-policy-as-a-security-policy-engine)

## Render and inspect

After read-only discovery of a new owned Node, render to a new local file:

```sh
python3 deploy/k2-evidence/ack-existing-cluster/render-csi-exclusion.py \
  --node ACTUAL_NEW_NODE_NAME --node-uid ACTUAL_NEW_NODE_UID \
  --policy-name qwen-k2-isolated-csi --binding-name qwen-k2-isolated-csi \
  --output /absolute/new/csi-exclusion.json
```

The command accesses no cluster and refuses to overwrite a file. It emits two
native API objects with `failurePolicy=Fail`, CREATE/core-v1/Pod matching and a
Deny binding. Selection is limited to kube-system's known `csi-plugin` and
`csi-plugin-non-ecs` app labels or DaemonSet owner names. The predicate covers
direct nodeName and every required-affinity OR term. A term is excluded only
when a metadata.name In/NotIn requirement explicitly excludes the protected
node; label expressions cannot supply external Node lookup. A selected addon
Pod with unconstrained affinity is conservatively refused. Generated Pods
explicitly targeting other nodes pass this predicate.

The Node UID annotation is a review pin, not an admission-time Node lookup or
authority. Compare fresh actual name/UID before installation and throughout
the experiment. Unknown addon labels/owners, other privileged workloads,
Pod binding, exec, ephemeral containers, static Pods, host administrators and
runtime socket access remain outside this component. VAP cannot protect its
own REST API policy/binding resources; actual policy modification privileges
and continued identity/spec checks are separate requirements.
[VAP limits](https://kubernetes.io/docs/reference/access-authn-authz/validating-admission-policy/)

## Proposed installation order

This sequence requires approval for concrete original-ACK resources and host
software after the remaining inputs below are known. It makes no change to
the original CSI DaemonSet or shared system-node sockets.

1. Establish one owned experimental node pool with manual capacity and a
   scheduling isolation taint. Do not create a K2 ARM, worker or publication.
   Discover the actual new Node name/UID/boot, all assigned Pods, driver
   processes, sockets, mounts and volume publications. Any unknown selected
   CSI publication or writer prevents the cold installation.
2. Verify live VAP API/RBAC and actual generated CSI requests. Review the exact
   rendered objects, dry-run their creation, then install only those new
   policy/binding names. Require current observedGeneration, no expression
   warnings and actual refusal of the new-node CSI request, with original-node
   requests permitted. This dated experiment completed the CSI exclusion checks before normal deletion.
3. Normally delete only the new-node default CSI Pod using its actual UID/RV.
   Confirm its driver/registrars and original Unix connections have terminated,
   old endpoints cannot be used or registered, and the installed policy refuses
   controller recreation. Pod NotFound and a finite absence watch alone do not
   prove this boundary. Do not touch the original two nodes' CSI Pods.
4. Cold-install the reviewed private driver backend, unique source frontend,
   registrar, runtime gateway and durable journal on this new node. Pin actual
   image/executable/configuration digests, peer identities, host systemd/LSM
   restrictions and authentication roles. Confirm no public backend or alternate
   registrar path. Default addon tags are insufficient artifact pins.
5. Qualify the complete Pod actors/RBAC/admission and nondelegated confinement
   from birth. Only then ARM the source before the first K2 worker Pod CREATE,
   associate its gated exact UID, open its scheduling gate, and accept its real
   publication/custody. Node creation and prior empty default-plugin startup
   are distinct from this original worker lifetime.
6. Complete normal stop, causal unpublish, qualified atomic release and safe
   reuse using the same actual installation. An exclusion policy, authenticated
   journal or local protocol fixture cannot grant release by itself.

## Narrow worker access candidate

`render-worker-access.py` renders five independent Fail/Deny policies and
bindings for one dedicated `qwen-k2-` namespace. It accesses no cluster and
refuses output overwrites, the two original system nodes, a default or fixed
worker coordinator ServiceAccount and equal coordinator/scheduler identities. Supply the actual
namespace/Node UIDs and authenticated usernames after discovery:

```sh
python3 deploy/k2-evidence/ack-existing-cluster/render-worker-access.py \
  --node ACTUAL_NEW_NODE_NAME --node-uid ACTUAL_NEW_NODE_UID \
  --namespace ACTUAL_QWEN_K2_NAMESPACE --namespace-uid ACTUAL_NAMESPACE_UID \
  --coordinator-user system:serviceaccount:ACTUAL_QWEN_K2_NAMESPACE:ACTUAL_COORDINATOR \
  --scheduler-user ACTUAL_SCHEDULER_USERNAME --name-prefix qwen-k2-worker-access \
  --worker-plan /absolute/reviewed/original-worker-plan.json \
  --output /absolute/new/worker-access.json
```

The rules explicitly deny CONNECT on exec/attach/portforward/proxy, UPDATE on
ephemeralcontainers/resize and CREATE on eviction in that namespace. They permit
Pod binding only by the reviewed scheduler to the exact experimental Node.
Normal Pod DELETE requires the separate coordinator, nonempty name, matching
original UID/resourceVersion, 30-second grace and Background propagation. It
rejects collection deletion, orphan options and unsafe storage-error deletion.
DELETE compares `oldObject` with `request.options`; CONNECT and Binding have
separate input shapes. [Admission request variables](https://kubernetes.io/docs/reference/access-authn-authz/validating-admission-policy/#validation-expression)

The mandatory worker plan is a closed JSON object with `schemaVersion: 1`, the original `provisionRequestId`, pinned `image`, original base `command` array, registered `pvcName`/`mountRoot` and ordered `artifactConfigMaps` array. It contains no boot Secret data or credentials. Obtain these exact values from the original persisted plan before CREATE; this offline renderer does not prove their SQL provenance. The prospective Pod/Secret name uses the production SHA-256 of the JSON-quoted request ID. Missing/duplicate/unknown/case-alias fields, unsafe paths, non-pinned images and oversized inputs fail before output. Plans are limited to 64 KiB, commands to 32 arguments/32 KiB, and chunks to 48 unique names; mount roots must avoid protected runtime paths.

CREATE permits only the coordinator and the exact original gated template, including the fixed worker account/profile, one runtime container, complete command/volumes/resources/placement and documented defaults. UPDATE permits only that coordinator to remove the original sole gate once before node assignment, retaining UID and controlled metadata and every other supported spec field's presence/value. CREATE/gate constraints explicitly enumerate the pinned Kubernetes 1.36.2 schema, including nested fields. Its primary-source digest is recorded in `worker-pod-schema-v1.36.json`; verify target schema and native expression typechecking before installation. Namespace UID is compared with the actual admission namespace object in every validation; matching remains by namespace name so recreation cannot skip validation. Binding and deletion also require the exact derived Pod name.

These objects do not read SQL ARM/BOUND/DRAINED, protect policy configuration from its writers, constrain direct kubelet/runtime/static-Pod access, prove actual actor/RBAC or loaded AppArmor, or supply confinement from birth. The existing UID/RV/whole-spec gate patch and durable BOUND checks remain required. Worker guards have not been installed; Kubernetes schema/typechecking and real admission acceptance remain pending. Local expression fixtures alone cannot establish these facts or release permission.

## Required inputs and undo

The evidence worker now selects the fixed RuntimeClass `qwen-k2-runc-v1` in
both its gated and opened templates. The CREATE/gate guards require the same
field, and the Java node-evidence reader requires the actual class to have
that name and handler, a canonical UID and no deletion, overhead or scheduling
fields. [runtime-class.json](runtime-class.json) supplies only this class
object. Before any approved installation, implement and verify the actual
dedicated handler/shim, effective options, consumed creation inputs and
confinement. A class GET or this manifest does not install the handler, prove
which executable ran, or grant birth/physical-release permission. Coordinator
RBAC must include GET of this single `node.k8s.io` RuntimeClass; no new class
write is exposed by the runtime client.

The approved experimental node `cn-beijing.10.135.59.36` was created and cordoned on 2026-10-11. Its actual Node UID is `8a55980c-65ba-4084-ab2b-083111ae39d9` and boot ID is `faf605a4-7552-43f2-bb15-524407ce9f2e`. Authenticated private API and host-namespace reads agree on Ubuntu 24.04.5, Linux 6.8.0-139, systemd 255, AppArmor enabled and containerd 2.3.4. The API reports `v1.36.2-aliyun.1`; the two original nodes remain Ready and schedulable. These are dated observations of this disposable node, not portable deployment pins.

At 22:14:59 Asia/Shanghai on 2026-10-11, the approved normal 30-second/Background DELETE used the original `kube-system/csi-plugin-sz7rn` UID `4887f01a-6353-418c-9cb3-57fbb9b5416c` and fresh resourceVersion. Pre-deletion API and host reads found no worker/PVC/inline-CSI/VolumeAttachment or CSI publication mount. The installed policy `qwen-k2-lab-exclusion-9ff330b1` has UID `47e33014-b3a4-4f4c-9d10-60c10dedd63b`, generation/observedGeneration 1 and completed typeChecking with no warnings. Its same-name Deny binding has UID `88943877-0c7d-4276-9b8e-baaa561f63f9`. All four real admission dry-runs behaved as expected without persisting test Pods; actual DaemonSet recreation was denied by these objects.

At 22:15:34, a complete host read found no original plugin/registrar process or original Pod CRI container. All six disk/nas/oss plugin/registrar socket paths were absent and connections returned ENOENT; no CSI publication mount was present. Original Node/CSI Pod UIDs remained unchanged and Ready, and the DaemonSet spec remained byte-equivalent as canonical JSON. This bounded observation prepares cold installation; it does not establish continuous worker custody, all bypass controls or physical-release qualification. The former plugin image digest was `sha256:f3dde54782067d2441ed1c784db0432e25056d298536903a3067b026e32afbbf`, and registrar image digest was `sha256:2c20e8022f88c8fed7e32445b78d4c3b7c879fd0d62fdf3b9c07192258c5a8d9`.

A complete bounded host read also confirmed kernel AppArmor binary export and namespace revision 106. One existing profile's measured raw bytes matched its kernel `raw_sha256`; this verifies the export interface, not installation of `qwen-k2-worker-v1`. Before deletion, the observed runtime, kubelet, plugin and registrar were unconfined. Actual process executable digests, namespaces, selected socket identities and the kubelet's real configuration digest were retained for the concrete installation review.

A separate read-only observation at 23:38:26 confirmed the same boot, actual AppArmor parser 4.0.1 (`4.0.1really4.0.1-0ubuntu0.24.04.7`), executable SHA-256 `6bc852b37807961c14976be9a227ae96bd817f73b5189cb0e0ff5eca4448c01c`, kernel set-load and ABI v5 through v9 support, actual enforce mode and binary/hash export. The actual node-wide policy lock was still off.

At 23:49:10, the same actual parser compiled a two-profile syntax fixture twice with `--skip-kernel-load --skip-cache`, an empty compiler configuration and the same complete target kernel/policy feature snapshot. Both runs exited successfully with identical 7107-byte output, SHA-256 `c4d4e12f07cdf86722ca3b15985ea4017cfbea585a4ef617d946f762b6d88054`. The 2503-byte actual feature snapshot has SHA-256 `21b452bc7b0c19173f5348fdebdbe8c0f4da67ac80d0ddfac86fd3474fe4f631`. This verifies the source-only `attach_disconnected.path=/qwen-k2-apparmorfs` syntax on the target compiler. The empty worker and exporter-only source fixture cannot run the production worker or services. No profile was loaded, no policy parameter was written and no collector was installed; the owned temporary files were deleted and the lock remained off. A complete runnable bundle, native set-load, alias exclusion and actual confinement remain pending.

On 2026-10-12, the separately approved three-key runtime preparation and one normal containerd restart completed only on this experimental node. At 08:25:40 Shanghai time the new runtime was active/running, the actual CRI flags were `disableApparmor=false` and `enableCDI=false`, and RuntimeReady/NetworkReady were true. NRI is disabled in the preserved-format disk configuration; its effective state remains unqualified. A later read-only diagnostic identified only the `io.containerd.deprecation/enable-cdi` warning. Six system Pods, both original nodes/CSI Pods, guard/DaemonSet specs and all 121 loaded profile entries matched before/after; the node remains cordoned and policy lock off. No collector or K2 profiles were installed. The [node design](../../../docs/design/2026-10-11-k2-node-evidence.md#experimental-runtime-configuration) records the scope and remaining proof requirements. The original cleanup deadline/cost cap remain.

Namespace/actor identities, complete executable/configuration/loaded-LSM measurements, exclusive CSI wiring and the qualified release consumer remain pending. Do not substitute a management projection, image tag, example UUID or operator completion flag for those facts. The experimental capacity has an approved 24-hour/25-CNY limit; the approved policy/normal-plugin-deletion phase is complete, and collector installation still requires its concrete approval. The scheduled capacity cleanup also includes the two owned guards, after the Node is gone.

Undo must stop new scopes, export complete original evidence, complete or
retain each existing ownership safely, and close the owned worker/driver/source
resources. Stop/remove the owned experimental capacity so its kubelet cannot
re-register the Node, verify its processes/endpoints are gone, then remove only
the created policy/binding using their saved UID/RV preconditions. Removing the
guard while the node is still active permits addon recreation and can collide
with the source frontend. No original DaemonSet template or strategy needs
restoration. Unrelated cluster changes must be preserved.
