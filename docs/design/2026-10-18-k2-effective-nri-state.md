# K2 original effective NRI state

[English](2026-10-18-k2-effective-nri-state.md) | [简体中文](2026-10-18-k2-effective-nri-state.zh-CN.md)

## Status and problem

Implementation candidate after the complete host-policy artifact set. At the
preceding baseline, the gateway checks selected effective CRI settings and the
original overlay plugin root.
Neither those replies nor a disk `disable=true` setting establishes that the
actual original runtime's NRI instance is disabled. Stock containerd 2.3.4
initializes an NRI instance without an error in both states and does not expose
its state through the existing introspection metadata or extra interface. Its
default enables NRI; the existing runtime fragment does not override that.

## Original daemon producer

Add a dedicated Linux containerd entry that reuses the pinned upstream
`command.App()` and its normal OS/build-tag-selected builtins. Register one
fixed observer with dedicated type `io.qwen.k2.nri-state.v1` and ID `state`,
requiring `NRIApiPlugin`. Do not use `InternalPlugin`: upstream NRI requires
internal plugins, so a reverse dependency would form a cycle.

The observer obtains the exact `NRIApiPlugin` ID `nri` through `GetByID`,
matching the CRI service's actual selection. Require the expected unique usable
instance and the narrow `IsEnabled() bool` interface. Retain that actual object
and call it on every request; do not copy an operator expectation or cache an
initial boolean. No observer configuration switch is provided. Registration
occurs only in the dedicated daemon entry, without client-side init effects.

Use the existing introspection `PluginInfo` extension with mandatory standard
protobuf Empty options and BoolValue extra. Both ends use the pinned `typeurl`
helpers: their exact type names are `google.protobuf.Empty` and
`google.protobuf.BoolValue`. Reject missing/wrong options, types and unknown
fields. False has a valid zero-byte protobuf body; require the extra object and
its type, then decode its value. The producer only observes; it never starts or
stops NRI, changes configuration, executes a plugin or creates another socket.

This observation is process-global within the original daemon instance. It is
consumed only through the gateway's retained original runtime connection, not
through a caller-selected Workspace or a new public route.

## Mandatory gateway consumer

Extend the existing `cristate.Guard.Verify` to query the fixed observer after
the Status and overlay checks, under the same five-second deadline and 32 KiB
plugin reply bound. Validate the fixed plugin identity, successful initialization,
the exact extra type and closed value, and require NRI to be disabled. Missing,
unsupported, enabled, changed, malformed, oversized or lost replies permanently
invalidate this guard. Keep the actual startup and both existing control-boundary
callers connected; no optional flag or fallback is introduced.

The original executable is already pinned by the protected runtime target and
both role configurations' runtime digest. Operators must build, review and pin
the new dedicated daemon artifact. Stock daemons cannot satisfy this contract.
The module's selected upstream source/checksums and resulting executable hash
remain the provenance, rather than a version string. Build without `no_cri`;
`CGO_ENABLED=0` omits conditional btrfs support and does not include every
possible builtin. Account for the actual new command, CRI/CNI, NRI and default
WASM dependency closure in the module lockfile.

Add explicit `disable=true` to the existing runtime fragment's fixed
`io.containerd.nri.v1.nri` table. This is the intended configuration for the
original daemon, while the mandatory observer checks its actual instance.
Disabling the plugin registration itself cannot satisfy that observation.

## Files and verification

Add the Linux daemon command and a small observer package with its explicit
registration and wire helpers. Update the existing guard and tests, the runtime
fragment and its test, Go module pins, bilingual deployment instructions and
this design. No source/7,
installation graph, Java contract or SQL format changes are required.

First reproduce the stock gap using actual upstream warning and NRI
registrations, separate concrete configuration values and the official config
decoder for `disable=true` and `false`. Never call Start or NewCRIService in
portable tests. The enabled constructor changes timeout globals, so run these
cases serially without changing registration defaults.

After implementation, connect those real instances through the actual observer,
upstream introspection service and in-memory gRPC transport into the actual
gateway guard. CRI Status and overlay data may be explicitly declared fixtures;
NRI values must come from the real upstream initializer. Cover both states,
missing/ambiguous/failed instances, exact options/type/unknown-field validation,
false's empty body, bounds, deadline/client continuity and permanent failure.
Keep global CLI inspection with a direct-probe fallback for this private stage,
the baseline and all failed attempts. Test portable packages, build both Linux
architectures, run applicable root checks, audit the complete diff twice and
obtain independent review.

## Acceptance and remaining work

Software acceptance requires the real producer-to-wire-to-guard chain and the
existing production callers, with stock or unavailable observations refusing.
It does not qualify the native daemon, all-thread confinement or a continuous
interval between checks. The fresh original node still needs actual reviewed
daemon/configuration bytes, NRI-disabled birth, complete host policies and label
entry, policy lock, actor/admission exclusion, exclusive CSI and normal lifecycle
facts. Host memory tampering is not excluded by this RPC.

Final original-Connection-bound physical authority, the atomic four-row writer,
RELEASED historical reads and safe later-cycle reuse remain unfinished and
fenced. No cloud capacity, node reconfiguration, daemon restart or policy loading
is part of this software increment. There is no open software protocol choice;
exact dependency growth and portable constructor behavior must be measured
before implementation is accepted.
