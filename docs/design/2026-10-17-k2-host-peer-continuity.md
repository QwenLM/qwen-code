# K2 original host peer continuity

[English](2026-10-17-k2-host-peer-continuity.md) | [简体中文](2026-10-17-k2-host-peer-continuity.zh-CN.md)

Status: implementation candidate for #13395 and Draft PR #13526. This extends
the [birth design](2026-10-16-k2-pre-exec-birth.md), without authorizing release.

## Problem and scope

The runtime, CSI backend, kubelet and registrar currently retain a pidfd and
executable, but resolve later process checks through global PID paths. They do
not compare actual enforced labels with the protected installation target or
retain their original user/mount namespaces. The gateway checks current thread
credentials and label but has no retained namespace baseline.

## Implementation

Expose closed host executable values from the existing validated artifact
snapshot. Validate literal absolute paths, hashes and distinct confined labels;
copy values instead of returning mutable maps. The runtime and plugin dialers
and both frontend handshake roles consume those values directly.

Retain the original proc directory, executable and pidfd. Read bounded stat and
AppArmor entries through that directory. Require the actual executable path,
digest and enforced label to match the selected target. Before and after each
namespace comparison, verify the original live process and executable. Retain
user/mount namespace descriptors and compare their NSFS/type/device/inode with
current fixed proc entries. Require the supported initial-user inode invariant
and full initial uid_map. A failure permanently invalidates the peer. Never
rebaseline a failed or replaced process; close every descriptor on partial
initialization and shutdown.

The gateway retains its original leader namespace pair at startup. At each
existing control boundary it checks both the leader and the calling locked OS
thread against that pair, alongside its existing credential/profile checks.
Reject namespace errors permanently. Add only the fixed user/mount proc leaves
to the gateway profile; do not add namespace mutation permissions or broad
ioctl allowances.

## Limits and acceptance

These are sampled leader checks for host peers and sampled current-thread checks
for the gateway, not an all-thread or gap-free no-migration proof. Private mount
namespaces need not equal another role's namespace. The wire source/7, SQL
schema, physical progress states and release/reuse gates remain unchanged.
Effective service configuration, reciprocal host policies, exclusive CSI wiring
and trusted installation provenance still require a complete consumer and
qualification before the four-row release transaction can be enabled.

Use portable artifact byte/MapFS tests for closed host target validation and
value-copy semantics. Compile the actual Linux source, shim and assembler for
amd64/arm64 without executing outputs. Inspect all call sites and FD ownership.
Native namespace/label mutation, loaded AppArmor/nsfs ioctl permissions,
inherited seccomp and lifecycle qualification remain unverified. Restricted
native groups are not rerun through alternate executors. Any binary or generator
change requires fresh installation pins; old qualifications do not transfer.
