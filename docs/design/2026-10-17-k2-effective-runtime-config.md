# K2 effective CRI runtime configuration

[English](2026-10-17-k2-effective-runtime-config.md) | [简体中文](2026-10-17-k2-effective-runtime-config.zh-CN.md)

Status: implementation candidate for #13395 and Draft PR #13526.

## Problem

Protected configuration bytes do not show what the original containerd CRI
service loaded. The gateway already holds the authenticated original runtime
connection, but does not read its effective configuration. The dedicated shim
path and the narrow creation lane must be checked before accepting gateway
identity, creation metadata or task observations.

## Implementation

Use CRI Status with Verbose=true through that same held connection. Fixed
upstream containerd v2.3.4 serializes its actual runtime Config into
Info["config"]. Require the exact RuntimeReady condition and one unambiguous
qwen-k2-runc-v1 handler; unrelated conditions, handlers and Info entries remain
permitted within fixed bounds. A handler listing alone proves no shim identity.

Check the builtin runc runtime type, fixed custom shim path, exact three runc
options, explicit overlayfs snapshotter, podsandbox controller, empty base spec,
no annotation pass-through or writable cgroups, and the supported default CNI
overrides. Accept empty or fifo io_type: the pinned upstream normalizer can
leave the empty value in its runtime map. Accept null or empty annotation
arrays, since its nil slices serialize as null. Reject unknown handler/options
fields, wrong case, duplicate JSON keys, absent required values, type coercion,
invalid UTF-8, trailing JSON, depth over 64 and configuration over 1 MiB.

Require explicit false for disableApparmor, enableSelinux, enableCDI,
enableCRIU, enableExperimentalRestoreViaCreate and netnsMountsUnderStateDir.
In particular, a null CDI or CRIU pointer is not disabled. Check the fixed
containerd endpoint, root and CRI root/state directories against this supported
lane's literal paths. These are fixed layout checks, not namespace/root
identities read from the installed Snapshot.
The offline fragment supplies these settings and explicit snapshotter; it
does not install them or change an existing daemon.

[Snapshotter root checks](2026-10-18-k2-snapshotter-root.md) additionally consume the independently validated target snapshot directory and exact builtin overlay PluginInfo through the same connection. Only the root export is accepted, excluding the pinned proxy producer. The two queries share one five-second deadline; the plugin response has a 32 KiB limit. This does not establish mount or filesystem object identity.

The production checker has one mutex and permanently refuses after its first
failure. Status has a five-second deadline and a 1 MiB gRPC receive bound.
Check once before serving, then consume it on both sides of the existing
gateway control wrapper. Source identity, ARM, birth, CSI and started-worker polling
consume that wrapper through the original gateway connection. Sandbox-only
polling returns early and gains no periodic check. Keep peer continuity, service/unit checks and actual birth inputs;
do not replace them with config equality or add a second connection.

## Verification and remaining boundary

Portable inert protobuf/JSON tests cover both accepted upstream representations,
every checked field, missing/null/wrong types, aliases, duplicate keys, size and
depth limits, readiness and handler ambiguity. Compile actual Linux source,
shim and assembler for amd64/arm64 without executing the outputs; run root
build/typecheck/bundle and review the complete increment twice.

Actual Status output and startup compatibility on a target daemon remain
unverified. Status does not expose NRI or the independent image configuration,
nor prove host reciprocal policy, exclusive CSI actors, installation provenance
or gap-free containment. No configuration success creates qualification
authority, changes source/7, authorizes physical release, reads released
credentials or opens later-cycle reuse. Those implementations and their
acceptance remain separate prerequisites for full K2.
