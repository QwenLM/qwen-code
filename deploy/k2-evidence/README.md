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

Install the reviewed executable at `/opt/qwen-k2/bin/k2-node-evidence`. Both units
require `/etc/qwen-k2/executable.sha256`, containing its actual SHA-256 and this
absolute path. Supply root-owned configuration and certificate files beneath
the private `/etc/qwen-k2` directory. `gateway.json` and `source.json` must contain
the exact fields declared by the Go entry point; credentials and invented
node/process/image pins are not distributed in this directory. The gateway's
runtime socket remains an administrative capability held by that trusted helper.

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

The source explicitly sets `RestrictSUIDSGID=no`: systemd's
[SUID/SGID filter](https://github.com/systemd/systemd/blob/v259.5/src/shared/seccomp-util.c)
returns `ENOSYS` for every `openat2` call. An actual service trace reproduced
this failure at the original BIND target check. The source requires `openat2`
with beneath-root and no-symlink resolution; it never falls back to a weaker
resolver. `NoNewPrivileges`, the capability bound and the declared writable
paths remain enforced. The reviewed LSM policy must additionally prevent
set-ID file creation or changes; these service units alone do not establish
that restriction. The gateway retains its SUID/SGID filter.

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

The current source requires `workerPolicySha256`, the reviewed full packed bundle containing both fixed worker/source profiles. It records actual loaded-policy measurements and the original image in a v2 ARM, and the admitted gated-spec digest/resourceVersion in BIND. Startup and live operations fail closed on missing or changed measurements. Mandatory source confinement, actual node-wide enforce/lock, the source-only disconnected exporter prefix and complete birth confinement still require concrete native qualification and installation approval. The code only reads policy; these artifacts never set the node-wide lock.
