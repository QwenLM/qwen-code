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

New worktrees use `node scripts/setup-worktree.js`. The script invokes the
pinned pnpm version through Corepack, freezes the lockfile, and first attempts
an offline install from the shared local store. It retries with registry access
only when that cache-only attempt is incomplete. This avoids waiting for pnpm
to prefetch optional binaries for other platforms on the common warm-store
path. The script sets `QWEN_SKIP_PREPARE=1`, keeping dependency install scripts
enabled while skipping the repository's eager build, bundle, and Husky setup.
Script execution does not implicitly install stale dependencies; the bootstrap
command is the explicit installation boundary. Builds remain available on
demand.

## Migration boundary

The package-manager migration applies to repository dependency installation,
workspace orchestration, and CI caches. It does not replace npm where npm is
the product boundary, including registry publication, extension installation,
self-update, and fixtures that intentionally exercise npm behavior.

The first draft keeps `package-lock.json` and npm-based CI operational while
pnpm compatibility is verified. The final cutover will switch CI installation
and lockfile checks before removing the npm lockfile.

## Verification

The pnpm path must complete a frozen install and pass the full repository build
with the same effective compiler and Node type versions as npm. Script tests
cover the bootstrap command, its prepare-skip environment, and the transitional
workspace rewrite. A dependency-only worktree still cannot launch the CLI
before the packages it imports through `dist` are built; removing that existing
build prerequisite is outside this migration. CI conversion is not complete
until macOS, Windows, and Linux installations all use the committed pnpm
lockfile.
