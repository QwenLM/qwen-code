# Durable Local Runtime Adoption (W0e-2)

[English](2026-09-27-local-runtime-adoption.md) | [简体中文](2026-09-27-local-runtime-adoption.zh-CN.md)

Status: implementation design. Builds on [W0e-1](2026-09-27-managed-workspace-recovery.md).

## Problem and scope

The local provisioner only knows processes launched by its current JVM. A
restarted Broker cannot adopt a surviving worker, and restarting an interrupted
launch could create a second process with the same credentials. The supported
deployment is a single Linux host with administrator-managed persistent local
storage and trusted workers. This is not a boundary against malicious same-UID
tools, remote storage, or external jobs that recreate writers after reboot.

## Persistent identity and launch ordering

An opt-in `runtime-broker.durable-local-process` mode uses the configured state
directory, outside Workspace roots. Linux `/etc/machine-id` and
`/proc/sys/kernel/random/boot_id` supply host and boot identity. The saved PID
namespace from `/proc/self/ns/pid` and time namespace from `/proc/self/ns/time`
must also match before inspecting processes:
[Linux PIDs are namespace-local](https://docs.kernel.org/admin-guide/namespaces/compatibility-list.html).
A kernel exposing both namespace identities is required; unsupported or unreadable identity fails startup. Tests may inject identity through a
package-private constructor; no deployment option accepts caller-supplied boot
evidence.

Each provision seed has a SHA-256 resource key, a permanent lock file and a
versioned JSON record. Directories are owner-only, files are owner-readable and
writable, and symlinks, unexpected ownership/permissions, missing records and
corrupt records fail closed. Atomic file replacement and file/directory sync
publish each state. Tokens remain in the existing encrypted SQL seed. The record
binds nonsecret seed identity and full placement digest to host/boot identity;
its v2 resource handle contains no credential or physical path.

The per-seed OS file lock serializes launch and observation across Brokers. The
launcher persists `INTENT`, then `LAUNCHING` before spawning. It persists the
actual PID and raw `/proc/<pid>/stat` field-22 start ticks as `REGISTERED` before sending any boot bytes.
The trusted direct worker command reads its complete boot document at stdin EOF
before opening a listener. An interrupted `LAUNCHING` record cannot launch
again. A `REGISTERED` worker may be observed and its ready output recovered.
Ready output goes to a private file, avoiding a stdout pipe tied to the Broker's
lifetime. After validating ready and full attestation, persist `READY` and the
endpoint before returning the lease. An interrupted publication is recoverable
from the same registered process and bounded ready record; it never creates a
replacement.

## Adoption and lifecycle

A retry for the same seed converges on its existing record. Adoption requires
the same host and boot, exact PID/start-tick identity, seed and placement, loopback
endpoint and full transport attestation. Missing kernel start information is
not a match. Busy locks return uncertainty. Generic v1 handles remain blocked
after restart. Managed boot v2 and legacy boot v1 share the launch protocol.

Raw start ticks are compared within the saved boot and PID/time namespaces.
Java wall-clock `startInstant` is not Linux death evidence: clock corrections
change the boot-time epoch it uses. Parsing skips the complete parenthesized
command name, which can contain spaces, parentheses and newlines. A read failure
proves nothing. Linux absence distinguishes a missing stat file from other
read errors; the latter cannot retire the journal or invalidate a cached worker.
Deployment must preserve the Broker user and its procfs visibility. Ephemeral
workers keep their original `Process` reaper-based lifetime checks.
The non-Linux identity used by portable tests is not deployable.

The Broker resumes interrupted provisioning only when the provisioner explicitly
supports the saved handle. A blocked startup may be observed, but observing
never spawns. Existing SQL operation claims fence late callbacks, and all
Session, grant, activation and storage-lease checks remain in force. Execution
control retains the [existing cancellation/reconciliation contract](managed-runtime-broker-service-core.md):
a lapsed dispatch is fenced with the original key and its result is reconciled
from the original worker. GET alone does not advance it. Physical cancellation
of an already `UNKNOWN` invocation is still outside that contract; this feature
does not imply Hosted Turn takeover or replay.

Closing a durable provisioner detaches. Discarding a lease after a lost SQL
claim also detaches: another Broker may already have adopted the same worker.
Neither action kills it or deletes its record. Ephemeral constructors retain
their existing shutdown semantics. Exact process death records journal loss
and a durable no-relaunch tombstone, but supplies no writer-stop proof. Physical
reuse remains blocked, including escaped descendants. W0e-3 adds only the
explicit trusted same-host reboot proof and exact storage-holder cleanup; no
general force-unlock or PID-kill recovery is introduced.

## Affected components and compatibility

`LocalProcessRuntimeProvisioner` shares boot/ready parsing between ephemeral and
durable modes. A package-private local store owns locking and durable records.
`RuntimeProvisioner` and the Workspace wrapper expose narrowly scoped startup
recovery support. `RuntimeBrokerService` permits observation of supported saved
startup records. Embedded configuration explicitly enables the mode and rejects
a recovery directory under any configured Workspace root. No database migration
or public API changes are needed. Existing constructors and the default
configuration stay ephemeral.

## Verification and acceptance

Real Broker processes must adopt the original real worker after SIGKILL without
changing identity, token, endpoint or execution receipt. Test both boot versions,
launch interruption, concurrent Brokers, late lease discard, shared observer
shutdown, mismatched placement, missing/corrupt record, unsafe permissions,
symlinks, reused PID and missing start identity. Negative cases must launch no
second worker and clear no physical pin. Existing Stage F, HTTP, Java SQL and
CLI regression tests remain required, followed by build/typecheck and two clean
full-diff audits. A simulated boot identity validates decisions only; actual
Linux reboot acceptance belongs to W0e-3 and requires a dedicated host.

## Open validation

The local development host is macOS. Portable real-process tests can use a
test-only identity source, while production Linux identity and physical reboot
acceptance must be reported separately. No dedicated rebootable Linux host has
yet been supplied.
