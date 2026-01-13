# Standalone Release Spec (Bun Native + npm Fallback)

This document describes the target release design for shipping Qwen Code as native
binaries built with Bun, while retaining the existing npm JS bundle as a fallback
distribution. It is written as a migration-ready spec that bridges the current
release pipeline to the future dual-release system.

## Goal

Provide a CLI that:

- Runs as a standalone binary on Linux/macOS/Windows without requiring Node or Bun.
- Retains npm installation (global/local) as a JS-only fallback.
- Supports a curl installer that pulls the correct binary from GitHub Releases.
- Ships multiple variants (x64/arm64, musl/glibc where needed).
- Uses one release flow to produce all artifacts with a single tag/version.

## Non-Goals

- Replacing npm as a dev-time dependency manager.
- Shipping a single universal binary for all platforms.
- Supporting every architecture or OS outside the defined target matrix.
- Removing the existing Node/esbuild bundle.

## Current State (Baseline)

The current release pipeline:

- Bundles the CLI into `dist/cli.js` via esbuild.
- Uses `scripts/prepare-package.js` to create `dist/package.json`,
  plus `vendor/`, `locales/`, and `*.sb` assets.
- Publishes `dist/` to npm as the primary distribution.
- Creates a GitHub Release and attaches only `dist/cli.js`.
- Uses `release.yml` for nightly/preview schedules and manual stable releases.

This spec extends the above pipeline; it does not replace it until the migration
phases complete.

## Target Architecture

### 1) Build Outputs

There are two build outputs:

1. Native binaries (Bun compile) for a target matrix.
2. Node-compatible JS bundle for npm fallback (existing `dist/` output).

Native build output for each target:

- dist/<name>/bin/<cli> (or .exe on Windows)
- dist/<name>/package.json (minimal package metadata)

Name encodes target:

- <cli>-linux-x64
- <cli>-linux-x64-musl
- <cli>-linux-arm64
- <cli>-linux-arm64-musl
- <cli>-darwin-arm64
- <cli>-darwin-x64
- <cli>-windows-x64

### 2) npm Distribution (JS Fallback)

Keep npm as a pure JS/TS CLI package that runs under Node/Bun. Do not ship or
auto-install native binaries through npm.

Implications:

- npm install always uses the JS implementation.
- No optionalDependencies for platform binaries.
- No postinstall symlink logic.
- No node shim that searches for a native binary.

### 3) GitHub Release Distribution (Primary)

Native binaries are distributed only via GitHub Releases and the curl installer:

- Archive each platform binary into a tar.gz (Linux) or zip (macOS/Windows).
- Attach archives to the GitHub Release.
- Provide a shell installer that detects target and downloads the correct archive.

## Detailed Implementation

### A) Target Matrix

Define a target matrix that includes OS, arch, and libc variants.

Target list (fixed set):

- darwin arm64
- darwin x64
- linux arm64 (glibc)
- linux x64 (glibc)
- linux arm64 musl
- linux x64 musl
- win32 x64

### B) Build Scripts

1. Native build script (new, e.g. `scripts/build-native.ts`)
   Responsibilities:

- Remove native build output directory (keep npm `dist/` intact).
- For each target:
  - Compute a target name.
  - Compile using `Bun.build({ compile: { target: ... } })`.
  - Write the binary to `dist/<name>/bin/<cli>`.
  - Write a minimal `package.json` into `dist/<name>/`.

2. npm fallback build (existing)
   Responsibilities:

- `npm run bundle` produces `dist/cli.js`.
- `npm run prepare:package` creates `dist/package.json` and copies assets.

Key details:

- Use Bun.build with compile.target = <bun-target> (e.g. bun-linux-x64).
- Include any extra worker/runtime files in entrypoints.
- Use define or execArgv to inject version/channel metadata.
- Use "windows" in archive naming even though the OS is "win32" internally.

Build-time considerations:

- Preinstall platform-specific native deps for bundling (example: bun install --os="_" --cpu="_" for dependencies with native bindings).
- Include worker assets in the compile entrypoints and embed their paths via define constants.
- Use platform-specific bunfs root paths when resolving embedded worker files.
- Set runtime execArgv flags for user-agent/version and system CA usage.

Target name example:
<cli>-<os>-<arch>[-musl]

Minimal package.json example:
{
"name": "<cli>-linux-x64",
"version": "<version>",
"os": ["linux"],
"cpu": ["x64"]
}

### C) Publish Script (new, optional)

Responsibilities:

1. Run the native build script.
2. Smoke test a local binary (`dist/<host>/bin/<cli> --version`).
3. Create GitHub Release archives.
4. Optionally build and push Docker image.
5. Publish npm package (JS-only fallback) as a separate step or pipeline.

Note: npm publishing is now independent of native binary publishing. It should not reference platform binaries.

### D) GitHub Release Installer (install)

A bash installer that:

1. Detects OS and arch.
2. Handles Rosetta (macOS) and musl detection (Alpine, ldd).
3. Builds target name and downloads from GitHub Releases.
4. Extracts to ~/.<cli>/bin.
5. Adds PATH unless --no-modify-path.

Supports:

- --version <version>
- --binary <path>
- --no-modify-path

Installer details to include:

- Require tar for Linux and unzip for macOS/Windows archives.
- Use "windows" in asset naming, not "win32".
- Prefer arm64 when macOS is running under Rosetta.

## CI/CD Flow (Dual Pipeline)

Release pipeline (native binaries):

1. Bump version.
2. Build binaries for the full target matrix.
3. Smoke test the host binary.
4. Create GitHub release assets.
5. Mark release as final (if draft).

Release pipeline (npm fallback):

1. Bump version (same tag).
2. Publish the JS-only npm package.

Release orchestration details to consider:

- Update all package.json version fields in the repo.
- Update any extension metadata or download URLs that embed version strings.
- Tag the release and create a GitHub Release draft that includes the binary assets.

### Workflow Mapping to Current Code

The existing `release.yml` workflow remains the orchestrator:

- Use `scripts/get-release-version.js` for version/tag selection.
- Keep tests and integration checks as-is.
- Add a native build matrix job that produces archives and uploads them to
  the GitHub Release.
- Keep the npm publish step from `dist/` as the fallback.
- Ensure the same `RELEASE_TAG` is used for both native and npm outputs.

## Edge Cases and Pitfalls

- musl: Alpine requires musl binaries.
- Rosetta: macOS under Rosetta should prefer arm64 when available.
- npm fallback: ensure JS implementation is functional without native helpers.
- Path precedence: binary install should appear earlier in PATH than npm global bin if you want native to win by default.
- Archive prerequisites: users need tar/unzip depending on OS.

## Testing Plan

- Build all targets in CI.
- Run dist/<host>/bin/<cli> --version.
- npm install locally and verify CLI invocation.
- Run installer script on each OS or VM.
- Validate musl builds on Alpine.

## Migration Plan

Phase 1: Add native builds without changing npm

- [ ] Define target matrix with musl variants.
- [ ] Add native build script for Bun compile per target.
- [ ] Generate per-target package.json.
- [ ] Produce per-target archives and upload to GitHub Releases.
- [ ] Keep existing npm bundle publish unchanged.

Phase 2: Installer and docs

- [ ] Add curl installer for GitHub Releases.
- [ ] Document recommended install paths (native first).
- [ ] Add smoke tests for installer output.

Phase 3: Default install guidance and cleanup

- [ ] Update docs to recommend native install where possible.
- [ ] Decide whether npm stays equal or fallback-only in user docs.

## Implementation Checklist

- [ ] Keep `npm run bundle` + `npm run prepare:package` for JS fallback.
- [ ] Add `scripts/build-native.ts` for Bun compile targets.
- [ ] Add archive creation and asset upload in `release.yml`.
- [ ] Add an installer script with OS/arch/musl detection.
- [ ] Ensure tag/version parity across native and npm releases.
