# K2 pre-execution birth and physical completion

[English](2026-10-16-k2-pre-exec-birth.md) | [简体中文](2026-10-16-k2-pre-exec-birth.zh-CN.md)

Status: implementation in progress. The resident Workspace first version is
separate. The source/7 implementation connects actual shim birth records and installed-byte observations to the Java
consumer. Its compilation and ordinary data tests do not establish installed
confinement from birth and cannot authorize physical release. Ref #13395 and
Draft PR #13526.

## Problem

Reading the current container specification after Start cannot prove what the
runtime consumed before the first instruction. A stopped task and an empty
cgroup cannot repair that missing interval. The source must bind the actual
normal Create, its consumed inputs, the original created process and the normal
Start before accepting publication and subsequent stop evidence.

## Actual task boundary

Use a dedicated `io.containerd.qwen-k2.v1` shim. Its task service wraps the real
containerd runc task service. It accepts only the original Kubernetes init task;
exec, checkpoint, update, pause, resume and terminal operations are refused.
Create reserves the original ID, protects its inputs, obtains a durable source
association, delegates the exact request with only Bundle relocated, then binds
the actual returned PID. Start requires that same owner/PID and source
permission, delegates normal Start, and reports the actual result. A failed or
ambiguous transition never supplies release evidence.

Delete saves the actual native response before input cleanup. A cleanup retry
uses that response without issuing a second Delete. Shutdown delegates only
after every registered owner has completed cleanup or failed preparation before
any native Create call. An unknown native Create result still blocks shutdown. The manager's emergency
cleanup remains a runtime maintenance path and never produces a qualified
normal-stop receipt.

The shim uses pinned containerd SDK APIs rather than a replacement task engine.
The SDK module's minimum Go and dependency versions enter this module's lock
files. Both Linux architecture builds must include the new shim command and
the existing gateway/source command; build success establishes compilation
only.

## Consumed inputs and creator channel

Preserve the original Create protobuf and OCI bytes. Protect a separate private
ext4 bundle with immutable regular files for the original/consumed request and
configuration. Keep the bundle directory writable for runc's normal PID, log,
rootfs and work entries. Retain the exact read-only descriptors and the pinned
runc executable. Reject unknown protobuf fields, altered request fields,
unbounded inputs, unsafe paths and changed objects. Never infer consumption
from two equal reads of a mutable pathname.

The original worker keeps its reviewed OCI bytes. The sandbox receives the
explicit no-new-privileges, empty-capability, AppArmor and cgroup-namespace
changes before Create. Both roles must match a complete reviewed creation
contract covering command, environment, mounts, devices, seccomp and protected
paths. Parsing that contract is data validation, not deployment authority.

Use a private sequenced-packet Unix creator channel. Authenticate its actual
root peer, PID/start/pidfd, immutable executable and enforced AppArmor label.
Pass the retained input descriptors, not caller-provided file hashes. Bind
sequence, request hash, source incarnation and the original association on
every reply. A lost channel, changed peer or input object blocks the live
association. The source's matching handler and journal consumer must be wired
before this shim is installable; an isolated producer is not a working source.

## Retained service inputs

Source and gateway retain the immutable ext4 configuration, CA, certificate and
private-key objects from startup. TLS consumes their retained bytes; private
keys require mode 0400. Every control operation checks the original named
object and retained descriptor before processing and before returning its
buffered response. CSI forwarding and gateway RPCs check their role files on
both sides of the call. Changed or unavailable inputs fail closed. Each role
file remains bounded at 32 KiB.

The gateway verifies the actual root credentials, initial user mapping,
SYS_PTRACE-only capability set, no-new-privileges, seccomp filter and dedicated
enforced AppArmor profile. Both service units name their own mandatory profile
and permit the required openat2 resolver. They run only the reviewed source
entry point; executable verification comes from the protected shim
configuration, rather than a separate pre-start executable. These checks do
not yet measure the complete installed policy semantics, effective runtime
handler, admission actors or exclusive CSI wiring. None grants release.

## Offline image inputs

The pre-execution renderer now requires the actual worker and sandbox OCI blob
layouts and their concrete manifest digests, in addition to the three host
artifacts and original creation contract. It measures every ordered layer's
compressed digest, length and uncompressed diff ID, and constructs the final
file catalogue after whiteouts and opaque directories. It never extracts,
executes, downloads or installs image contents. JSON fields are unique, UTF-8
and finite. Only concrete OCI manifests, Linux amd64/arm64 configurations and
uncompressed or gzip OCI layers are accepted.
The worker composer labels verified gzip base blobs as OCI gzip layers without
changing their bytes, digests or diff IDs, including when the base used Docker
layer descriptors.

The image command must resolve through bounded symlinks to an executable ELF of
the same architecture as the host artifacts. Every ELF interpreter must resolve
to another executable ELF in the same image. Other executable files remain
catalogue data; they are not additional approved entry points. Refuse links
escaping the image, cycles, non-directory or implicit parents, unsupported file
types/xattrs and external blob descriptors. Hardlinks require an earlier
regular file in the same layer with identical inode metadata; cross-layer
hardlinks are unsupported. Each layer has a 1 GiB compressed and expanded
bound, the image has a 4 GiB expanded bound, and each layer/final tree is limited
to 65,536 entries. Manifest/configuration bytes have a combined 64 KiB bound;
each output catalogue has a 16 MiB bound.

The version-2 artifact manifest binds both original image digests, the complete
catalogue bytes and both generator files. Candidate output is exclusive and
private, and all input validation precedes directory creation. This closes the
offline image input path for a future generated policy. It does not provide the
complete five-role policy, its compilation/loading, actual actor exclusions or
the installation authority required below.

## Installed artifact byte closure

The next runtime prerequisite is a fixed `/etc/qwen-k2/artifacts` snapshot.
An offline assembler consumes the original artifact/profile candidates and a
successful compilation record, checking every referenced file before creating
a new private output. It copies only the closed public metadata set, feature
bytes and packed policy. It never opens configuration-referenced TLS or client credential files,
executes a parser, loads policy or installs files. The snapshot and its manifest remain
data, not an installation certificate or a release grant.

Preserve the exact compilation-time profile candidate and source configuration.
To avoid a hash cycle, derive the deployed source configuration by replacing
only its top-level `workerPolicySha256` JSON value token with the packed digest;
preserve every other original byte. Do not regenerate the compilation candidate
after that replacement. The gateway configuration remains byte-identical.

Both real service startup paths must open and retain the fixed snapshot with
the existing immutable ext4/name/descriptor checks. Keep the private immutable
root and protected ancestor identities, and open fixed child names through the
retained directory FD with no symlinks or mount crossings. Separate artifact limits
allow 16 MiB catalogues/profile source and an 8 MiB packed bundle without
widening the existing 32 KiB birth/configuration bound. Compare the actual own
configuration, own fixed systemd unit and protected shim configuration with the
snapshot, and preserve the existing protected executable checks. Retain all
objects until service shutdown and verify them at the existing control, CSI,
gateway, birth and background-observation boundaries. Missing or changed bytes
refuse startup or the original operation.

The source additionally compares the installed packed hash and byte count with its actual
kernel policy measurement. The gateway keeps its own confinement check; it
does not acquire the source's kernel exporter permissions. Neither role reads
the other role's live configuration or private key. Snapshot configuration
copies contain only the closed configuration's paths and identities.

The runtime identity protocol is version 2. Its gateway byte observation records
the full original installation manifest digest, architecture, packed digest and
length, role, actual own configuration path/digest, shim digest and fixed own
unit path/digest. Construct it only after matching the actual retained inputs.
The source compares every field with the gateway role in its independently
validated snapshot before creating a journal. Existing request guards then
compare the complete original gateway identity, including these comparable
scalar fields. A different role, manifest byte or input refuses; there is no
version-one fallback. [Source/7](2026-10-17-k2-installed-byte-journal.md) additionally persists
the paired observations and original ARM frontend identities, with independent
reviewed metadata expectations in Java. These are recorded facts, not a qualified
installation identity.

This step binds actual retained runtime inputs to the generated artifact graph.
It does not prove the effective daemon handler, loaded unit configuration,
external actor exclusion, reciprocal host policy, exclusive CSI wiring or a
gap-free installed lifecycle. It does not add an installation authority, grant final release or relax the reuse
fence. Source/7 records these byte facts; further actual live installation facts
and their external trust root remain required.

## Source and release dependency

The offline profile stage consumes the exact version-2 artifact manifest, both
catalogues and shim configuration, plus reviewed target facts, the original
private Runtime request and both actual service configurations. It generates
one five-profile source and service units whose argv names the same configuration
paths. The generator owns all permission syntax; caller rules, includes and
AppArmor patterns are not accepted. Configuration/key paths must stay outside
writable input, journal, socket and worker roots. Different role keys must not
alias. Host peer hashes must agree with the actual source/gateway configuration.

Policy source remains a candidate. AppArmor can constrain mount type, flags,
source and destination, but it cannot compare arbitrary mount data, device
numbers or DBus message bodies. The complete original contract remains pinned
for the trusted creator/consumer to compare. Numeric proc names also require
the actual kernel's self-only attribute-write semantics; UID ownership does
not establish process ownership. SDK child OOM adjustment and disconnected
namespace/root naming require explicit installation qualification. Generating
five named profiles does not supply the reciprocal profiles of existing host
actors or qualify an installation.

Outer snapshot mount inputs are separate from inner OCI mounts. Rules split
normal mount stages and preserve the original data in the reviewed target and
contract. Actual source types, VFS flags and disconnected aliases still require
native qualification. The following compilation stage consumes the full pinned
candidate, uses exact parser/features with an empty configuration and no kernel
load/cache, and saves failed attempts. Its ordinary tests only prepare data and
inspect argv; they never execute a parser. Neither stage grants release.

The current source/7 format preserves paired sandbox/worker births, actual image
and snapshot ancestry, raw consumed inputs, created-process custody and the
explicit publication/stop/unpublish dependencies. Update the Go producer and
Java reader together. A decoder, signature, hash chain or claimed digest does
not qualify the installed implementation. The consumer must compare the actual
installation and reviewed shim/runc/sandbox/role inputs, including the creation
contract, through a private authority tied to the original SQL connection.

Only that complete authority may commit the final receipt and four compare-and-
set writes on one connection: physical outcome, original binding, original
occupied request slot and original holder. Preserve every other column and raw
credential value; any count mismatch, overflow, expiry or post-image mismatch
rolls back all four. Historical reads must return the saved original outcome
after a later owner reserves the volume. New ownership requires a fresh
Session/request/slot/binding and the actual monotonic shared-holder revision.
Do not relax the current reuse fence before this entire path is connected.

## Validation and acceptance

Keep old candidates as read-only references and select individual reviewed
files. Do not restore an old tree, dependencies or test qualification wholesale.
Use compilation and permitted ordinary data/Java checks for the current
candidate. Previously refused native/source/custody/Main-F2 groups remain
unexecuted; a different directory or runner does not change that restriction.

Acceptance requires a real installed Create-to-Start chain, paired birth
custody, original normal stop and CSI unpublish, all four atomic writes with
rollback cases, historical credential replay and a subsequent distinct owner
using the same volume. Current metadata fixtures, compiler output and resident
Workspace acceptance cannot stand in for those results. Keep physical release
and public selection closed while any prerequisite is missing.
