# K2 node source packaging

[English](README.md) | [简体中文](README.zh-CN.md)

This directory packages the reviewed Linux source executable. No ACK
installation has been performed. Physical release remains closed until the
actual node, driver wiring, confinement and complete source chain have passed
qualification. The current
ACK cluster is `c679c4016ff0b4872aa43a2b6688343e8`. Its shared system nodes are
outside the experimental installation scope.

Build in `packages/k2-node-evidence` with the reviewed Go toolchain and the
module's pinned dependencies:

```sh
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 GOTOOLCHAIN=local GOWORK=off \
  go build -trimpath -o /absolute/output/k2-node-evidence .
```

Use `amd64` when qualifying an amd64 node. Record the actual source files,
toolchain, dependency closure, executable digest and command before independent
acceptance. A successful build does not qualify an executable.

Package that exact executable without a base image or Docker daemon:

```sh
python3 deploy/k2-evidence/package-oci.py \
  --binary /absolute/output/k2-node-evidence \
  --expected-sha256 REVIEWED_EXECUTABLE_SHA256 \
  --architecture arm64 \
  --output /absolute/output/new-oci-layout
```

The output follows the [OCI image layout 1.1.1 specification](https://github.com/opencontainers/image-spec/blob/v1.1.1/image-layout.md).
It contains one uncompressed layer with the static executable and fixed file
metadata. It has no shell, package manager, credentials or embedded deployment
configuration. Publishing the layout and installing it are separate actions.
Pin the emitted manifest digest when referring to an installed image; a tag is
not an artifact pin.

The executable has two roles, `gateway` and `source`, each taking one absolute
JSON configuration path. They run as host-visible root because the runtime and
CSI Unix peers, executable identities and retained pidfds require that boundary.
The source has no containerd socket. Configuration, CA and role-specific keys
are mounted separately; the source journal uses a private disk outside the
worker and its PVC. Detailed permissions and source ordering are specified in
the [node source design](../../docs/design/2026-10-11-k2-node-evidence.md).

A node installation must provide an exclusive CSI frontend: kubelet and the
registrar use its socket, and only the driver and source can reach the private
backend. The original ACK addon tolerates arbitrary node taints and has no
published configuration for excluding a new node pool. A label or taint alone
cannot establish this boundary. No installation manifest may claim isolation
until the actual addon wiring is verified; this packaging tool does not modify
the cluster or create that isolation.

The [original ACK exclusion candidate](ack-existing-cluster/README.md) renders
an independent validating admission policy for one new Node's known CSI addon
Pods, preserving the original DaemonSet and shared nodes. Its earlier expressions compiled and passed 20 local request-map cases with cel-go 0.26.0. On 2026-10-11, the approved CSI-only policy/binding passed real ACK typechecking and four admission dry-runs; normal deletion stopped only the new node's default CSI Pod. The worker CREATE/gate guards and collector remain uninstalled and unqualified. The staged installation
must establish persistent exclusion and cold exclusive driver wiring before the
first K2 ARM and worker CREATE; its renderer performs no cluster writes.

## Private worker image candidate

The [worker packaging design](../../docs/design/2026-10-12-k2-worker-packaging.md) supplies new bundle and image candidates because the original worker's complete artifact record is unavailable. Build the exact production worker with `node deploy/k2-evidence/build-worker.mjs /absolute/new-bundle-directory`. It records the actual complete module bytes and embeds WASM; the fixed base command is `/usr/local/bin/node /opt/qwen-k2/worker.mjs`, followed by the provisioner's private arguments. The source renderer still obtains its image/command from the original persisted request. A successful local build does not qualify startup or the ACK runtime.

After independently verifying a selected official Node 22 Linux OCI base, use `package-worker.py` with its absolute base layout, exact base manifest digest, exact bundle path/SHA-256, architecture and a new absolute output directory. The composer verifies compressed blobs and uncompressed diff IDs and adds only a root-owned read-only JS layer. It clears inherited startup/environment defaults and supplies the fixed non-root worker command. It performs no archive extraction, image execution, publication or installation. Review the actual Node/loader/library closure and restrictive policy before native acceptance. Keep all earlier build failures; do not use historical ACK acceptance for this replacement.

## Host service deployment candidate

`host-services/` contains two static systemd units and private directory rules.
They are review inputs, not an approved ACK installation. They keep the host PID,
user and cgroup namespaces while creating private filesystem mount views. This
avoids assuming that a `hostPID` Pod also sees the host cgroup hierarchy. The
source must still prove that `/proc/<originalPID>/cgroup` resolves beneath its
actual `/sys/fs/cgroup` view.

Install the reviewed executable at `/opt/qwen-k2/bin/k2-node-evidence`. Both roles
verify its actual digest against the retained `/etc/qwen-k2/shim.json` and use
that configuration for the dedicated handler inputs. Supply root-owned
configuration and certificate files beneath
the private `/etc/qwen-k2` directory. `gateway.json` and `source.json` must contain
the exact fields declared by the Go entry point; credentials and invented
node/process/image pins are not distributed in this directory. The gateway's
runtime socket remains an administrative capability held by that trusted helper.
Each configuration/PEM object must be a root-owned immutable read-only regular
file on ext4, at most 32 KiB; private keys require mode 0400. Both roles retain
the original descriptors and verify names, identity and bytes before and after
control processing. Source gateway RPCs and CSI forwarding also check both
sides of the call. These checks do not establish complete installation authority.

The selected driver must expose its private socket under
`/run/qwen-k2/backend`. The source configuration uses
`/run/qwen-k2/source/csi.sock` as its frontend and `/var/lib/qwen-k2/journal`
as its separate journal root. Only the original driver and source can reach the
backend; only the pinned original kubelet and unique registrar can reach the
frontend. Neither socket is mounted into a worker. Start gateway, selected
backend, source and frontend registrar in that order, then inspect the actual
source identity before starting the reviewed coordinator. Units have no boot
enablement or automatic restart; a lost source cannot resume old custody.

The units retain only `CAP_SYS_PTRACE` because reading the executable of a real
root daemon may require it when the caller lacks the daemon's permitted
capabilities. They deny tracing, process-memory access, pidfd signalling and
namespace-changing syscalls while preserving Go's internal thread signals.
This is a candidate permission boundary: actual kernel, systemd, peer capability
sets and LSM rules must be verified. Restrict the LSM profile to the necessary
proc reads, reviewed sockets, source journal and frontend, with no task-memory
or worker-volume writes. Do not infer that an empty capability set works from
the owned fixture's test result.

Both roles explicitly set `RestrictSUIDSGID=no`: systemd's
[SUID/SGID filter](https://github.com/systemd/systemd/blob/v259.5/src/shared/seccomp-util.c)
returns `ENOSYS` for every `openat2` call. An actual service trace reproduced
this failure at the original BIND target check. Both roles require `openat2`
for protected role files; the source also requires beneath-root target resolution, and it never falls back to a weaker
resolver. `NoNewPrivileges`, the capability bound and the declared writable
paths remain enforced. The reviewed LSM policy must additionally prevent
set-ID file creation or changes; these service units alone do not establish
that restriction. The gateway now requires its dedicated enforced AppArmor
profile and checks its actual root credentials, initial user mapping, seccomp
and SYS_PTRACE-only capability set before serving and returning control replies.

Filesystem read-only settings do not prove that newly propagated CSI submounts
are recursively read-only. Verify one-way mount visibility and enforce the
source's inability to write those mounts through the reviewed LSM policy. The
host service configuration, CSI exclusivity, Pod/gate/exec/DELETE admission and
RBAC, addon exclusion, actual artifact pins and undo procedure remain deployment
qualification requirements. Validate unit syntax against the target systemd version and exercise the services
on an owned Linux host before proposing privileged installation. Actual ACK
qualification follows the approved installation.

Before the current mandatory source AppArmor profile and v2 reader were added, the earlier exact units passed an owned Ubuntu 26.04.1/aarch64 Linux 7.0
host test using systemd 259.5. The main source chain passed 333 checks with real
UID 1000 parent/descendant tasks, retained pidfd/cgroup descriptors and mount
publication/unpublication. Born-task BIND refusal passed 46 checks; registrar
death refusal passed 223. Actual units, processes, mounts, cgroups, temporary
paths and the VM were closed. Runtime/CSI backends were explicit protocol
fixtures and the LSM was unconfined. This result does not qualify actual ACK
runtime/plugin/driver wiring, a restrictive LSM, admission, physical release or
volume reuse. It does not qualify the changed current source unit or v2 reader. The original `openat2` failure remains recorded separately.

The current source requires `workerPolicySha256`, the reviewed full packed bundle containing the fixed worker/source/sandbox/shim/gateway profiles. It records actual loaded-policy measurements and the original image in a v6 ARM, and the admitted gated-spec digest/resourceVersion in BIND. Startup and live operations fail closed on missing or changed measurements. Mandatory source confinement, actual node-wide enforce/lock, the source-only disconnected exporter prefix and complete birth confinement still require concrete native qualification and installation approval. The code only reads policy; these artifacts never set the node-wide lock.

## Pre-execution shim candidate

Build the dedicated shim with the same Go 1.26.3-or-newer toolchain and locked module as the source. Record both architecture builds of both entry points; do not substitute a source-only build for the shim.

```sh
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 GOTOOLCHAIN=local GOWORK=off \
  go build -mod=readonly -trimpath -buildvcs=false \
  -o /absolute/output/containerd-shim-qwen-k2-v1 ./cmd/containerd-shim-qwen-k2-v1
```

From the repository root, render the reviewed candidate from the exact source, shim and separately reviewed runc artifacts and original creation-contract bytes:

```sh
python3 deploy/k2-evidence/render-pre-exec.py \
  --source /absolute/output/k2-node-evidence \
  --shim /absolute/output/containerd-shim-qwen-k2-v1 \
  --runc /absolute/reviewed/runc \
  --worker-layout /absolute/reviewed/worker-oci \
  --worker-image-sha256 REVIEWED_WORKER_MANIFEST_SHA256 \
  --sandbox-layout /absolute/reviewed/sandbox-oci \
  --sandbox-image-sha256 REVIEWED_SANDBOX_MANIFEST_SHA256 \
  --creation-contract /absolute/reviewed/creation-contract.json \
  --output /absolute/output/new-pre-exec-candidate
```

The renderer hashes the actual artifact bytes, checks their ELF header architecture agrees, preserves the contract bytes, refuses duplicate JSON and existing output, and writes root-private candidate files. It checks the contract envelope; the shim and Java consumer perform the complete semantic validation. It does not establish artifact source provenance or execution compatibility.

Both image layouts must contain the exact selected OCI manifest, configuration and ordered layer blobs. `image-catalog.py` measures compressed hashes/sizes and uncompressed diff IDs, applies whiteouts, and resolves the original ELF entry and loaders without extracting or executing them. Version 2 of the artifact manifest binds both image digests and complete `worker-catalog.json` / `sandbox-catalog.json` bytes. The supported subset requires explicit directory parents and same-layer hardlinks with unchanged metadata; cross-layer links, external blobs, unknown file types/xattrs, mismatched architectures and missing loaders refuse before output creation. See the birth design for bounds. This is an offline input artifact, not a complete AppArmor bundle or installed protection evidence.

`shim.json` is the candidate for `/etc/qwen-k2/shim.json`. The `runtime-handler.toml` fragment keeps the `qwen-k2-runc-v1` RuntimeClass/handler and literal custom `runtime_path`, but uses `io.containerd.runc.v2` to produce the exact runc options protobuf. It explicitly selects overlayfs, podsandbox and FIFO, keeps AppArmor enabled, disables SELinux/CDI/CRIU/restore-via-create, and keeps network namespaces outside the CRI state directory. Review these global CRI settings before installing the fragment. The source configuration additionally requires the generated `sandboxImageSha256`; tmpfiles supplies the fixed private directories. This tool does not install or apply them. See [options wiring](../../docs/design/2026-10-17-k2-cri-options-wiring.md).

The gateway reads the actual CRI Status configuration through its held original containerd connection before serving and on both control boundaries. It checks the fixed handler, three options, selected security settings and fixed root/state/socket paths. Failed or unavailable observations permanently refuse. Existing source calls, including started-worker polling, consume that boundary; sandbox-only intervals do not gain periodic checks. This Status observation alone does not establish NRI state, exclusive CSI wiring, installation provenance or uninterrupted containment. See [effective runtime configuration](../../docs/design/2026-10-17-k2-effective-runtime-config.md).

The effective-config guard also reads the exact builtin overlay plugin through no-options PluginInfo on that original connection. Its single root export must match the independently validated target snapshot directory; proxy address exports refuse. This is sampled metadata validation, not filesystem object or mount identity. See [snapshotter root](../../docs/design/2026-10-18-k2-snapshotter-root.md).

Build the dedicated original daemon from the same locked module, for both Linux architectures. For example, from `packages/k2-node-evidence`:

```sh
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 GOTOOLCHAIN=local GOWORK=off \
  go build -mod=readonly -trimpath -buildvcs=false \
  -o /absolute/output/containerd-k2 ./cmd/containerd-k2
```

This entry reuses upstream containerd 2.3.4's command and normal OS/tag-selected builtins, with the fixed read-only `io.qwen.k2.nri-state.v1.state` observer. Do not use `no_cri`; `CGO_ENABLED=0` omits conditional btrfs support. Review the exact selected dependencies and executable bytes, then pin this artifact as the runtime executable in the protected target and both role configurations. The upstream version string does not establish that provenance. This command only builds an artifact; it does not install or restart the daemon.

The rendered fragment now explicitly sets `disable=true` in `plugins."io.containerd.nri.v1.nri"`; upstream defaults to enabled. Keep the NRI registration available: disabling the registration itself makes the required observation unavailable. Under the same five-second deadline as Status/overlay, the guard requests standard Empty options and BoolValue extra from the actual retained NRI object through the original connection. Enabled, stock, missing, failed, malformed, oversized or lost observations permanently refuse. False's typed empty body is valid. This is sampled state, not native daemon acceptance, disabled birth, all-thread confinement or continuous exclusion. See [effective NRI state](../../docs/design/2026-10-18-k2-effective-nri-state.md).

Before installation, qualify the actual daemon's handler/bootstrap compatibility, private ext4 consumed-input mount, immutable installed files and ancestors, initial namespaces, complete loaded/locked AppArmor bundle and actor/admission boundary. The current service units and historical profiles have not inherited this changed candidate's qualification. The runtime directory must remain writable for its normal PID/log/rootfs/cleanup operations. Do not make the entire consumption bundle immutable. Use `node-config` with the exact reviewed source/shim configurations to produce the mandatory Java birth inputs; successful parsing remains distinct from installation qualification and physical release. See the [birth design](../../docs/design/2026-10-16-k2-pre-exec-birth.md).

## Offline complete profile candidate

Continue from that exact artifact directory using `render-profiles.py`. This stage remeasures both original image layouts and compares the complete catalogue bytes with the version-2 manifest. It also checks the original contract and fixed shim configuration. It reads the actual source/gateway JSON files without opening their referenced keys, uses their literal paths and sockets in the rules, and emits service units whose argv uses those same deployed configuration paths.

```sh
python3 deploy/k2-evidence/render-profiles.py \
  --candidate /absolute/output/new-pre-exec-candidate \
  --artifact-manifest-sha256 REVIEWED_ARTIFACT_MANIFEST_SHA256 \
  --target /absolute/reviewed/profile-target.json \
  --target-sha256 REVIEWED_TARGET_SHA256 \
  --runtime /absolute/reviewed/private-runtime.json \
  --runtime-sha256 REVIEWED_RUNTIME_SHA256 \
  --source-config /absolute/reviewed/source.json \
  --source-config-sha256 REVIEWED_SOURCE_CONFIG_SHA256 \
  --gateway-config /absolute/reviewed/gateway.json \
  --gateway-config-sha256 REVIEWED_GATEWAY_CONFIG_SHA256 \
  --host-policy /absolute/reviewed/complete-host-bases \
  --host-policy-sha256 REVIEWED_HOST_POLICIES_MANIFEST_SHA256 \
  --worker-layout /absolute/reviewed/worker-oci \
  --sandbox-layout /absolute/reviewed/sandbox-oci \
  --output /absolute/output/new-profile-candidate
```

The closed `qwen-k2-profile-target/2` object requires the following fields. These are reviewed deployment inputs, not observations or an installation certificate.

| Field                           | Supported input                                                                                                                                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `format`, `architecture`        | Exact version above; `amd64` or `arm64`, agreeing with both images and all three host artifacts                                                                                                      |
| `hostExecutables`               | Exact `runtime`, `kubelet`, `registrar`, `plugin`, `systemd` objects, each with literal `path`, `sha256` and a distinct confined `label`; the four peer digests must equal the service configuration |
| `snapshotRoot`                  | `/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots`                                                                                                                               |
| `podSlicePrefix`                | The actual systemd kubepods Pod-slice prefix, optionally in the burstable or besteffort hierarchy                                                                                                    |
| `apparmorExportRoot`            | The specific measured exporter path below `/qwen-k2-disconnected/source`; the generator owns its read-only leaf patterns                                                                             |
| `systemBus`                     | Closed `socket`, `privateSocket`, `label`; the system bus socket and `/run/systemd/private` with an actual confined bus label                                                                        |
| `volumeSerialPath`              | The actual final `/sys/devices/.../serial` object                                                                                                                                                    |
| `roleConfigPaths`               | Exact `source` and `gateway` deployed JSON paths directly beneath `/etc/qwen-k2`; these also enter the emitted units                                                                                 |
| `sandboxNetworkNamespaceSource` | A `/run/netns/` component template containing exactly one `${SANDBOX_ID}` (64 hex) or `${NETWORK_NAMESPACE_ID}` (UUID), without caller patterns                                                      |
| `rootfsMounts`                  | Exact `worker` and `sandbox` arrays, currently one outer `overlay` mount each with `type`, `source`, complete `options` including lowerdir data; these are separate from inner OCI mounts            |
| `oldRootPath`                   | The specific measured old-root name below `/qwen-k2-disconnected/shim`; no global unmount fallback                                                                                                   |
| `hugepageSizes`                 | Up to 128 actual unique sizes such as `2MB` or `1GB`, used only for same-leaf read rules                                                                                                             |

Both service configurations must contain exactly the fields consumed by the Go entry point. Configuration and TLS paths stay directly beneath `/etc/qwen-k2`; declared private-key paths cannot alias another role or public input. Host executable paths cannot enter role files, journals, sockets, kubelet data, proc/sys/dev, temporary or worker writable roots. This prevents executable-identity inputs from introducing a second key/data read route; actual inode/key-byte isolation still requires installation qualification. The journal root and runtime socket remain fixed; frontend and backend socket basenames may differ within the existing private directories. The gateway URL must name its concrete IP listener; DNS and unspecified listener addresses are outside this offline lane. The full persisted Runtime command/image and worker mount root must agree with the creation contract and image. Writable worker roots cannot overlap protected roots or image files.

The mandatory host directory contains `host-policies.json` (`qwen-k2-host-policies/1`) with exactly `format` and `files`; the latter pins the byte count and SHA-256 of `host-runtime.rules`, `host-kubelet.rules`, `host-registrar.rules`, `host-plugin.rules`, `host-systemd.rules` and `host-system-bus.rules`. Each is a complete separately reviewed expanded base body, at most 1 MiB, rather than a few K2 permissions. The manifest is at most 64 KiB; supply its independently reviewed hash. The flat body lane and code-owned reciprocal additions are described in the [complete host policy design](../../docs/design/2026-10-18-k2-host-policy-set.md). Names must be literal root-namespace labels without `:` or `//` or a trailing slash. A distinct bus name cannot start with `/`, which would create an implicit executable attachment. A bus reusing an explicitly attached host label must have exactly the same complete base bytes; its profile is emitted once. No runnable host bases are supplied by the inert test fixtures.

The output contains one `qwen-k2-profiles` source, all seven host input leaves, the two adjusted units, original service/target/runtime/contract bytes and a version-2 `profile-candidate.json` binding every output and generator. The generator owns Qwen permissions, all headers/attachments and K2 reciprocal/transition rules; arbitrary permission arrays or patterns in target facts and ambient includes are unsupported. It preserves mount data in the original contract while generating only the type/flags/source/destination constraints AppArmor can express. The first lane refuses unknown mount options, idmapped mounts, relative bind sources and broad device grants.

Mount rules distinguish outer snapshot mounts from inner OCI mounts and split initial mounting, propagation, bind remount, post-pivot read-only finalization and masked paths. Read-only remounts admit only the finite combinations of the supported retained security flags. Image parent symlinks are resolved before rendering mount/boot paths; new mountpoint directories may be absent in the image, while normal image catalogue resolution still requires existing parents. Resolved names outside the literal-path subset refuse. These rules do not establish mount source types, inherited VFS flags, namespace membership or actual disconnected names; those require the reviewed target and native acceptance. The source remains unable to write cgroup controllers. The shim's root-controller/statistics additions are read-only, and its normal state temporary files stay inside the original CID state directory.

Pathname Unix sockets use literal file access rules. Unix peer-label rules cover abstract/anonymous sockets and do not enforce pathname peer labels. The trusted programs retain actual credential, executable/process/namespace and original held-peer checks; actor/admission exclusion and native qualification remain required.

This stage never runs a parser, loads or locks policy, executes an image or installs a service. Its manifest records the remaining semantic boundaries, including numeric proc self-only checks, the SDK's parent/child OOM relationship, disconnected object naming and external host profiles/CSI isolation. Those depend on the actual kernel and pinned trusted implementation. Profile source and its hashes cannot establish them. `workerPolicySha256` must eventually contain the actual packed bundle hash. Preserve this compilation-time candidate and its original configuration bytes; the assembly stage below derives a separate deployed configuration without regenerating the compiled candidate. No provisional hash is installation evidence. Actual normal lifecycle, complete actor exclusion and final physical-release authority remain pending.

## Explicit policy compilation stage

`compile-profiles.py` consumes the reviewed version-2 `profile-candidate.json` and every pinned candidate file. It checks the generated flat, ordered five-Qwen prefix and reconstructs the exact complete host suffix from pinned bases and target/configuration bytes, with no ambient includes, aliases, ABI selection or nested profiles. This layout check is not a general policy parser or permission audit. The subsequent installation graph is version 2; old candidates/installations are not converted. Supply the exact target parser ELF and target feature bytes:

```sh
python3 deploy/k2-evidence/compile-profiles.py \
  --candidate /absolute/output/new-profile-candidate \
  --profile-candidate-sha256 REVIEWED_PROFILE_CANDIDATE_SHA256 \
  --parser /absolute/reviewed/apparmor_parser \
  --parser-sha256 REVIEWED_PARSER_SHA256 \
  --features /absolute/reviewed/kernel-features \
  --features-sha256 REVIEWED_FEATURES_SHA256 \
  --output /absolute/output/new-policy-compilation
```

The compiler copies the exact parser/source/features into a private new directory, uses an empty explicit parser configuration and both explicit feature arguments, disables kernel loading and caches, and records the actual argv. Warnings about unenforced rules are errors. The attempt, stderr and partial output survive failure or timeout; successful output is bounded to the source reader's 8 MiB limit and gets its own byte count/hash. Parser dependencies, target feature correctness and toolchain provenance still require independent qualification. Compilation does not load or lock the policy and cannot certify its semantics or installation. Ordinary tests exercise only preparation, layout rejection and argv construction, with parser execution blocked. A separate no-load/no-cache stdin syntax smoke using the existing AppArmor 5 parser is not compilation with the reviewed target Ubuntu 24 parser/features and produces no positive compilation or installation protocol record.

## Installed artifact byte assembly

Build `./cmd/k2-assemble-artifacts` from `packages/k2-node-evidence`, then use the assembler with the original three stage directories and their reviewed pins:

```sh
k2-assemble-artifacts \
  --pre-exec /absolute/output/new-pre-exec-candidate \
  --profiles /absolute/output/new-profile-candidate \
  --compilation /absolute/output/new-policy-compilation \
  --profile-candidate-sha256 REVIEWED_PROFILE_CANDIDATE_SHA256 \
  --compile-record-sha256 REVIEWED_COMPILE_RECORD_SHA256 \
  --output /absolute/output/new-installed-artifacts
```

This offline command reads the fixed artifact set; it never opens configuration-referenced TLS or client credential files or executes the recorded compiler command. It checks the original dependency pins, successful compilation record, unchanged saved compiler inputs and exact packed size/hash before creating output. It preserves the original profile candidate and source configuration, derives `source-config.installed.json` by replacing only the top-level `workerPolicySha256` JSON value token, and keeps every other original byte. The gateway configuration stays byte-identical. `installation.json` pins the other 24 output files, including all seven host input leaves and the original `compile.json` renamed to `profile-compile.json`.

An approved installation must place these 25 files under the fixed `/etc/qwen-k2/artifacts` root. Both that directory and `/etc/qwen-k2` must be root-owned, private and immutable on the supported ext4 filesystem; the files must satisfy the existing root-owned, immutable, read-only, single-link checks. Install the derived source configuration at its original declared source path, the unchanged gateway configuration at its declared gateway path, the exact shim configuration at `/etc/qwen-k2/shim.json`, and each own unit at its fixed `/etc/systemd/system` path. TLS credentials are separately installed role-private inputs. The assembler performs none of these installation actions.

Both actual service entry points retain the artifact directory and its protected ancestors, open only fixed child names through the retained directory FD without symlinks or mount crossings, and compare their own configuration/unit and the shim configuration against the snapshot. Existing request guards recheck retained objects; the source additionally compares the packed hash and byte count with the actual loaded kernel policy. The gateway gains no source-only policy-exporter permission and neither role opens the other role's live configuration or private key. Catalogues and profile source have separate 16 MiB bounds, packed policy 8 MiB and the full snapshot 64 MiB; the existing 32 KiB birth/configuration bound remains unchanged.

The gateway now returns a version-two runtime identity with an observation of its matched own configuration, shim and unit bytes, complete original installation manifest, architecture and packed policy. Before creating a journal, the source compares every observation field against its independently validated snapshot's gateway role. Subsequent checks retain the complete original identity. Old runtime identity version 1, another role or any different byte identity refuses. Neither role opens the other role's live configuration or credentials.

The manifest proves byte consistency only. It does not certify effective systemd settings, a loaded policy's semantics, runtime handler selection, actor exclusion, CSI ownership or installation provenance. Current validation uses explicitly synthetic compilation data and portable byte tests, plus compile-only Linux outputs; the assembler CLI, actual protected-object behavior and live installation remain unverified. [Source/7](../../docs/design/2026-10-17-k2-installed-byte-journal.md) now records both byte observations in SOURCE_START and the original held frontend identities in ARM. Java compares mandatory independent reviewed metadata expectations; source/6 and old Node configurations are refused without conversion. This records facts without supplying installation trust, physical-release authority or safe reuse.

The `node-config` deployment JSON now requires `installedArtifacts`, an absolute path to the separately reviewed 25-file artifact directory, alongside `nodeName`, `client`, `sourceConfiguration` and `shimConfiguration`. Use the exact derived `source-config.installed.json` and original `shim.json`. The client object retains source/coordinator principals and external PKCS12/password/CA paths. Only compact non-secret byte expectations enter saved Node configuration; the artifact directory path is not persisted, and referenced credential files are not opened as artifacts. The Java reader checks fixed metadata, bounded complete host base bytes and their pins; the real Go service retains the full artifact graph. This operator parsing is not installation qualification.

Both services additionally require an original root PID-1 connection on `/run/systemd/private`, whose executable and enforced label match the reviewed `systemd` target; they retain its original user/mount namespaces. The [effective service identity check](../../docs/design/2026-10-17-k2-effective-service-identity.md) reads the fixed own Unit/Service properties at startup and existing operation boundaries: exact process/command, native unit without drop-ins or pending reload, original invocation/start times, and selected privilege properties. Errors permanently invalidate this instance; the client neither reconnects nor manages services. These sampled checks do not qualify all effective settings or installation provenance. Real systemd property compatibility, startup timing and loaded-policy permissions remain unverified. Changed binaries and profile generators require fresh artifact pins and qualification.
