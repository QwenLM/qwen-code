# K2 effective snapshotter root

[English](2026-10-18-k2-snapshotter-root.md) | [简体中文](2026-10-18-k2-snapshotter-root.zh-CN.md)

Status: implementation candidate for #13395 and Draft PR #13526.

## Problem

The target declares the fixed overlay snapshot directory, but the artifact
validator does not check or retain it. CRI Status confirms the selected
snapshotter name, not its actual root. In pinned containerd v2.3.4 the overlay
plugin can override that root independently of the containerd root directory.

## Implementation

Validate and retain the target's exact
`/var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots` value.
The gateway supplies that retained value to its existing effective-config
guard, together with an introspection client on the same authenticated, held
original containerd connection. No extra connection or background task is
created. Reject empty or unsupported expected roots before making an RPC.

Within the existing five-second verification deadline, read CRI Status and
then PluginInfo for type `io.containerd.snapshotter.v1`, ID `overlayfs`, with
no options. Require the exact plugin identity, no initialization error, no
extra response, a response within 32 KiB and exports containing only `root`.
The exported root must exactly equal the declared snapshot directory's parent;
do not clean, resolve or accept equivalent paths.

The pinned overlay initializer publishes the same root that it passes to
NewSnapshotter, which uses its `snapshots` child. PluginInfo reads the named
plugin directly without the Plugins list cache. Pinned proxy registrations
always add an `address` export, even when empty, so reject that field rather
than trusting a proxy's caller-supplied root export. This narrow check does not
prove an unknown vendor build has the same implementation.

Run this check before serving and at both existing control boundaries. Any
Status, PluginInfo or semantic failure permanently closes the guard. Existing
source consumers and started-worker polling inherit it; sandbox-only intervals
still gain no periodic check. Retain original peer, protected file, unit,
namespace, policy and birth checks. This is sampled metadata validation, not a
new installation or release authority.

## Verification and remaining boundary

Ordinary data tests must reject coherently repinned empty, missing or changed
target roots; retain the original valid value after caller input mutation.
Inert protobuf/client tests cover exact request identity, root mismatch,
proxy exports, initialization errors, missing/extra/oversized responses and
permanent failure. An independent test engineer verifies this data boundary
and the same-connection startup/control consumers. Compile the actual Linux
source/shim/assembler for both architectures without executing outputs, run
root build/typecheck/bundle, and audit the full increment twice.

No renderer, image, parser, Linux runtime or previously restricted acceptance
group runs here. Actual target PluginInfo/startup, filesystem object and mount
identity, NRI, reciprocal host policy, exclusive CSI actors and installation
provenance remain unqualified. No source/7 or Java/SQL format changes, final
physical writer, released receipt read or later-cycle reuse are introduced.
