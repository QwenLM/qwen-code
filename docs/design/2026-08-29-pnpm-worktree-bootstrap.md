# pnpm worktree bootstrap

## Problem

Every npm-backed Git worktree materializes another full dependency tree. The
root `prepare` lifecycle also builds and bundles the repository unless the
caller knows to set `QWEN_SKIP_PREPARE`, so a worktree pays for generated
artifacts before source-based development needs them.

On the same commit and APFS volume, a warm-cache npm install added about 1.44
GiB while a warm-store pnpm install added about 99 MiB. The dependency-only
installs took 27 and 22 seconds respectively; a separate full build took about
129 seconds.

## Design

The repository declares pnpm as its package manager and mirrors the existing
npm workspace boundaries in `pnpm-workspace.yaml`. A hoisted linker is used
for the initial migration because current build and packaging scripts still
contain assumptions inherited from npm's layout.

The committed pnpm lockfile is the source of dependency resolution for this
bootstrap only. pnpm-specific overrides preserve the dependency versions used
by the current npm installation without changing npm's manifest or lockfile.
Dependency install scripts are denied unless they are explicitly listed in
`allowBuilds`; the allowlist contains only packages whose scripts run in the
current npm installation.

During the dual-lock transition, `.pnpmfile.mjs` rewrites known internal
dependencies to pnpm's `workspace:*` protocol in memory. This covers both the
existing `file:` dependencies and the exact channel dependency versions that
the release script updates. As a result, release version bumps do not stale the
pnpm lockfile, while the checked-in manifests and npm lockfile remain untouched.
The compatibility hook can be removed when the manifests adopt `workspace:`
during the final cutover.

New worktrees use `node scripts/setup-worktree.js`. The script prefers Corepack
so an existing pnpm cache can stay fully offline, and falls back to npm's
bundled `npx` on Node versions that no longer include Corepack. Both paths use
the exact pnpm package declared by `packageManager`. The script freezes the
lockfile and first attempts an offline install from the shared local store. It
retries with registry access only when that cache-only attempt is incomplete.
This avoids waiting for pnpm to prefetch optional binaries for other platforms
on the common warm-store path. The script sets `QWEN_SKIP_PREPARE=1` plus a
bootstrap-private notice-generation guard, keeping dependency install scripts
enabled while skipping repository build, bundle, Husky setup, and npm-layout
notice generation. Script execution does not
implicitly install stale dependencies; the bootstrap command is the explicit
installation boundary. Building from this pnpm layout is deferred to Stage 2.

## Migration boundary

Stage 1 applies only to dependency installation in additional Git worktrees.
It does not change repository build commands, CI build orchestration, release
versioning, packaging, or publishing. `package-lock.json` remains authoritative
for every existing npm path. A path-filtered workflow exercises the real frozen
bootstrap on Linux, macOS, and Windows whenever a pnpm installation input
changes. The generated pnpm lockfile is excluded from the repository's
human-authored YAML style rules.

Stage 2 can separately make the pnpm layout a supported build and development
path, then migrate CI installation and caches. Stage 3 can address release
installation and build orchestration. npm remains the product boundary for
package creation, registry publication, and clean artifact installation until
the scripts that intentionally read `package-lock.json` are migrated.

## Verification

The Stage 1 pnpm path must complete a frozen install without modifying tracked
files. Script tests cover the bootstrap command, its prepare-skip environment,
the version-independent workspace rewrite, and process failure behavior. The
cross-platform workflow provides the real install gate. Building from the pnpm
layout is intentionally deferred to Stage 2; existing npm build and release
validation remain unchanged.
