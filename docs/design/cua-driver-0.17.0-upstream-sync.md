# CUA Driver 0.17.0 upstream sync

## Goal

Move the vendored CUA Driver source from upstream
`cua-driver-rs-v0.7.0` to the released `cua-driver-rs-v0.17.0` tag while
preserving the Qwen-specific runtime and distribution contract.

The release tag, commit `10279552e2bbe479e367a082f78b1b98ee85a697`, is the
source of truth. The local `/Users/mochi/code/cua` checkout, old design notes,
and generated artifacts are inputs for comparison only.

## Scope

The upstream import is limited to `trycua/cua:libs/cua-driver`, mapped to
`packages/cua-driver`. Upstream monorepo workflows, root scripts, documentation,
and unrelated libraries are not imported automatically. Any new dependency on
those files must either be made package-local or explicitly mapped to an
existing Qwen Code facility.

The Qwen-owned release workflow remains `.github/workflows/cd-cua-driver.yml`.
It may receive the minimum changes required by the new driver build and release
contract, but it must continue to publish Qwen-owned artifacts.

## Required Qwen deltas

The sync is incomplete unless all of these remain effective:

1. The installed executable, process, app bundle, bundle identifier, paths,
   scheduled services, documentation, and release assets use the Qwen-owned
   identity expected by the current Qwen release line. The release state home
   remains `~/.cua-driver` for upgrade compatibility; the isolated local-build
   home remains `~/.qwen-cua-driver-local`.
2. `CUA_DRIVER_RS_COORDINATE_SPACE=1` continues to provide the opt-in 0-1000
   coordinate contract at the shared invocation boundary. It must cover every
   new coordinate-bearing desktop and browser-adjacent tool or fail closed.
3. `MCP_MODEL_PAYLOAD_FILTER=1` continues to filter model-visible branding in
   both MCP text content and structured content without altering binary media.
4. The still-unmerged Windows empty/null-title top-level window behavior from
   trycua/cua#2021 remains present and is adapted to the current window model.
5. The EAGAIN socket-write patch from trycua/cua#2036 is retired from the local
   patch inventory because it is part of the 0.17.0 base.

## Upstream contract changes

The import includes the SDK-owned runtime, Python and TypeScript UniFFI SDKs,
typed browser automation, runtime permission modes, per-session capture scope,
snapshot-bound element tokens, the closed `ActionResult` contract,
`verify_state`, native menu invocation, clipboard tools, window framing, and
semantic cursor themes.

These are architectural replacements rather than independent leaf features.
The Qwen coordinate and payload transformations must be reattached to the
canonical SDK/tool boundary so CLI, MCP, direct SDK, private worker, and daemon
execution cannot diverge.

## Import strategy

1. Run the repository-supported upstream-delta script from the current
   `.vendored-from` ref to `cua-driver-rs-v0.17.0`.
2. Inventory every reject, deletion, new generated file, root-relative path,
   package identity, release version, and external build dependency.
3. Resolve upstream/local overlaps by preserving the upstream architecture and
   re-expressing each Qwen delta at its new canonical boundary.
4. Update `.vendored-from`, `.vendored-patches.md`, version references, Qwen
   installers, and the Qwen release workflow together.
5. Audit source, tests, documentation, generated bindings, installers, bundle
   metadata, process names, service names, and release archives for identity
   consistency.

## Verification

Verification is layered so a green narrow unit test cannot hide a broken
distribution or trust boundary:

- Rust formatting, package checks, core/contract/SDK unit tests, and generated
  contract consistency.
- Focused coordinate-normalization, payload-filter, Windows window-enumeration,
  installer, and version tests.
- Python and TypeScript SDK generation/package checks when their package-local
  toolchain is available.
- Qwen release-workflow static checks for executable names, app bundle layout,
  bundle identifiers, assets, and baked versions.
- `npm run build && npm run typecheck` for the enclosing repository.
- Full diff and untracked-file audit, repeated until two consecutive passes are
  clean.

Signed/notarized release production and physical Windows/Linux/macOS GUI
certification are outside local verification and must remain explicit release
gates.
