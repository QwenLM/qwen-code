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

The committed lockfile remains the source of dependency resolution. Root
TypeScript and Node type versions are pinned to the versions currently hoisted
by npm so switching package managers does not silently change the compiler or
ambient Node declarations. Dependency install scripts are denied unless they
are explicitly listed in `allowBuilds`; the allowlist contains only packages
whose scripts run in the current npm installation.

The existing manifests use `file:` for local package dependencies. npm links
those packages to their workspace sources, while pnpm snapshots them; a build
of an upstream package therefore did not reach downstream consumers. During
the dual-lock transition, `.pnpmfile.mjs` rewrites only known internal `file:`
dependencies to pnpm's `workspace:*` protocol in memory. The checked-in
manifests stay npm-compatible until CI is cut over, while pnpm gets live
workspace links. The compatibility hook can be removed when the manifests
adopt `workspace:` during the final cutover.

New worktrees use `node scripts/setup-worktree.js`. The script prefers Corepack
so an existing pnpm cache can stay fully offline, and falls back to npm's
bundled `npx` on Node versions that no longer include Corepack. Both paths use
the exact pnpm package declared by `packageManager`. The script freezes the
lockfile and first attempts an offline install from the shared local store. It
retries with registry access only when that cache-only attempt is incomplete.
This avoids waiting for pnpm to prefetch optional binaries for other platforms
on the common warm-store path. The script sets `QWEN_SKIP_PREPARE=1`, keeping
dependency install scripts enabled while skipping repository build, bundle,
Husky setup, and npm-layout notice generation. Script execution does not
implicitly install stale dependencies; the bootstrap command is the explicit
installation boundary. Builds remain available on demand.

## Migration boundary

The package-manager migration applies to repository dependency installation,
workspace orchestration, and CI caches. It does not replace npm where npm is
the product boundary, including registry publication, extension installation,
self-update, and fixtures that intentionally exercise npm behavior.

The first stage keeps `package-lock.json` and npm-based build and release paths
operational. Release versioning refreshes and commits both lockfiles, and a
path-filtered workflow exercises the real frozen worktree bootstrap on Linux,
macOS, and Windows whenever a dependency input changes. The generated pnpm
lockfile is excluded from the repository's human-authored YAML style rules. The
release-age exception for the internal channel base package is package-scoped,
so a version bump does not require a configuration edit.

Later stages will switch development and CI orchestration to pnpm, followed by
release dependency installation and builds. npm remains the product boundary
for package creation, registry publication, and clean artifact installation
until the scripts that intentionally read `package-lock.json` are migrated.

## Verification

The pnpm path must complete a frozen install and pass the full repository build
with the same effective compiler and Node type versions as npm. Script tests
cover the bootstrap command, its prepare-skip environment, and the transitional
workspace rewrite. The cross-platform workflow provides the real install gate;
release versioning performs a second frozen lockfile check before it commits or
publishes. A dependency-only worktree still cannot launch the CLI before the
packages it imports through `dist` are built; removing that existing build
prerequisite is outside this migration.
