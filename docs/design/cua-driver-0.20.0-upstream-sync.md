# CUA Driver 0.20.0 Upstream Sync

## Source of truth

The synchronization target is the stable Cua Driver release
`cua-driver-rs-v0.20.0` from `trycua/cua`, resolved to commit
`bb8c86049cad1bf0853c6d25c03c14875d0d047f`. The npm `latest` dist-tag for
`@trycua/cua-driver` also resolves to `0.20.0`. The newer `0.20.1` artifacts
are nightly prereleases and are not used as a release baseline.

The existing Qwen snapshot is `cua-driver-rs-v0.17.0` at commit
`10279552e2bbe479e367a082f78b1b98ee85a697`. The supported
`packages/cua-driver/scripts/sync-from-upstream.sh` delta is checked against a
three-way merge with 0.17.0 as the common ancestor.

## Adopted upstream behavior

The 0.20.0 runtime becomes the vendored base, including:

- transport-owned implicit lifecycle sessions and explicit per-action targets;
- capability manifests applied across permission profiles;
- typed SDK, contract, and generated binding updates;
- foreground-focus verification and background-input hardening;
- policy-filtered tool discovery and named CLI session behavior;
- stable/nightly release-channel support; and
- removal of legacy browser approval tokens.

The removed browser-token path is not retained as a Qwen compatibility fork.
Existing-profile access continues only through trusted launch grants, bounded
manifests, or an embedding host's authorization callback.

## Qwen invariants

The sync must preserve these downstream-owned boundaries:

- executable, app, bundle, service, install, update, and release identities
  remain Qwen-owned;
- telemetry remains disabled by default and, when explicitly enabled, goes
  directly to the documented upstream endpoint;
- `MCP_MODEL_PAYLOAD_FILTER=1` remains an explicit Qwen-facing payload filter;
- `CUA_DRIVER_RS_COORDINATE_SPACE=1` remains the opt-in normalized-coordinate
  adapter, with absolute pixels as the default;
- the release installation continues to use `~/.cua-driver` for compatibility,
  while source builds retain their separate Qwen identity; and
- the still-open `trycua/cua#2021` empty-title Windows-window patch remains
  carried and documented.

## Release and packaging boundary

The Qwen release workflow keeps its existing signing, notarization, artifact
names, and publication ownership. It advances its manual default to 0.20.0,
uses the restored upstream TypeScript lockfile required by `npm ci`, and keeps
macOS bundle versions valid when a prerelease suffix is present.

The upstream tag left its standalone Agent SDK examples pinned to 0.19.2 even
though both npm and PyPI publish 0.20.0. The vendored examples and their npm
lockfile are aligned to 0.20.0 so they exercise the synchronized contract.

Upstream's monorepo-wide nightly orchestration, release-attribution services,
Python publishing, and documentation publishing are not copied into Qwen Code.
They depend on upstream-only scripts, secrets, repositories, and release
governance. Cross-platform signed release publication remains a CI gate.

## Out of scope

This change does not update Qwen Code's current built-in downloader pin,
Computer Use MCP adapter, bootstrap flow, permission UX, or model-visible tool
schemas. It also does not implement Issue #9334. Those integration changes
remain independently reviewable follow-ups on top of the verified 0.20.0
runtime and TypeScript SDK.
