# Resident Workspace configuration

[English](README.md) | [简体中文](README.zh-CN.md)

This first-release configuration retains one Pod/PVC per tenant/Workspace.
It supports Read, Write and Edit through the public files profile. Session close
settles and revokes the original context; the next Session retains the same
files and runtime. It does not install a node collector or automatically delete
or reuse storage. This directory has not been deployed or accepted in ACK.

The runtime is implemented on main by PR #14340. The simplified PR #14758
documents this deployment boundary. The resident path is independent of the
node-evidence candidate withdrawn from #14758 and the installation and physical
retirement proposals #14761 and #14765. This configuration needs no Go toolchain,
custom containerd/shim, node collector or cold-bootstrap installation.

## Trusted platform and supported storage

Trust the administrator, Kubernetes control plane, host and qualified CSI driver.
Keep the existing tenant/actor, Workspace generation, original runtime and mount
checks. This configuration does not independently prove continuous host
confinement. The supported driver is `diskplugin.csi.alibabacloud.com` with
`ReadWriteOncePod`, `Filesystem` and `ext4`; the registered disk serial must match
the actual mounted device. Other drivers or access modes require independent
design and qualification. RWOP does not authorize storage handoff after a node
failure.

## Configuration and installation

Use `application.example.yaml` as an additional Spring configuration file.
Supply the server's existing database, Hosted Harness, Session store, Broker
token and credential-encryption settings separately. The Kubernetes token and CA
settings name local files read by the server; credentials do not belong in this
template or the worker Workspace.

Keep the Session store's global `workspace-id` equal to the Broker's global
`workspace-id`, as in the example. The existing Hosted startup contract requires
this match; each public Workspace still resolves its own registered identity.

Before enabling the mapping, register the exact CSI registration with the
existing registration operator and register the matching tenant/Workspace,
generation and storage in the Workspace registry. Use `managed-runtime-tools/1`
and `preapproved-workspace-tools/1` as the Workspace config/policy, then grant the
trusted actor OPERATOR or OWNER. Each physical volume may appear in only one
resident mapping. A registration or a caller-supplied Workspace ID alone does
not enable CSI execution.

Render the exact storage/namespace protection objects with the existing Java
protection operator, passing `<reviewed-registration-json> <policy-name>
<binding-name>`. This prints a Kubernetes JSON List and
does not contact the cluster or database. From the server package, invoke the
built operator with:

```bash
java -Dloader.main=com.alibaba.qwen.code.managedagent.workspace.runtime.WorkspaceCsiProtectionMain \
  -cp target/qwen-managed-agent-server-0.1.0-alpha-csi-runtime.jar \
  org.springframework.boot.loader.launch.PropertiesLauncher \
  /absolute/path/registration.json resident-protection resident-binding
```

After separately authorized installation, pin its actual namespace/policy/binding
UIDs and generations. Select an immutable image digest containing Node.js 22 or
later and the built CLI. The CSI file path uses Node filesystem APIs and reads
Linux `/proc/self/mountinfo`, `/proc/self/fd` and the volume's
`/sys/dev/block/<major>:<minor>/device/serial`; these must be available to UID 1000. The command contains only the executable and CLI path;
the provisioner appends `managed-runtime-worker --container-boot` and the boot
file path. Optional artifact ConfigMaps must be immutable and explicitly pinned.

The server must reach the Kubernetes API and the original Pod's worker endpoint.
The worker runs as UID/GID 1000, with a read-only root filesystem, no added Linux
capabilities or service-account token, its fixed PVC at `/workspace`, and its
temporary directory in an emptyDir. The Pod has `restartPolicy: Never`. A
missing, restarted or replaced original Pod keeps admission closed; this version
does not recreate or adopt a replacement.

Create and close Sessions using the existing public Workspace Session APIs.
Only one unfinished Session is admitted. Close must succeed before another
Session can begin. A release timeout or unknown outcome retains the reservation
and blocks handoff. The selected cwd is fixed for each Session; choose another
cwd at the next Session's creation. Shell, MCP, Hooks, child Sessions sharing the
runtime and in-place cwd changes are unavailable in this version.

## Failure handling and acceptance

When an execution or release outcome is unknown, preserve its Session and
reservation and refuse the next Session. A missing or changed original Pod,
container or mount keeps the Workspace unavailable. Lease expiry, operator
inspection or a missing Kubernetes object must not clear the physical owner or
authorize a replacement Pod. Normal idle application/Broker restart can use the
retained database and original worker; this does not qualify interrupted-Turn,
expired-writer or lost-Pod recovery.

Qualify the deployment before claiming acceptance:

1. Run A's Write/Edit/Read, close A, then read in B. Check exact file bytes and
   unchanged Pod/container, binding generation, PVC/PV and reservation. Confirm
   that A's old context refuses activation and dispatch, the binding stays READY
   and storage stays RESERVED.
2. Exercise concurrent different-key creation and same-key replay against real
   MySQL; only one unfinished Session may be admitted. Test lost release replies
   and UNKNOWN execution with controlled peers: the hold must remain and no
   uncertain effect may be repeated.
3. At an idle boundary, restart actual application/Broker processes while
   retaining the database and worker. Confirm original-runtime adoption without
   a new Pod. Separately verify refusal of missing or changed identities.

Record source commit, environment, original identities and observed results for
each run. Keep component/H2, MySQL, independent-process and ACK evidence separate.
The documentation revision does not execute those deployment checks; they remain
pending. Existing historical fixtures are not acceptance of a new deployment.

Resident resources continue to incur normal Pod/node/storage costs after
Session close. No live cloud installation, paid resource creation or manual
physical teardown is authorized by this template. Use a separately approved
deployment/maintenance plan for those actions. See the
[design](../../docs/design/2026-10-14-k2-resident-workspace.md) for the failure and
acceptance boundaries.
