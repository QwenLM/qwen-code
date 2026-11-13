# Independent Electron matcher security upgrades

[English](npm-independent-matcher-security-upgrades.md) | [简体中文](npm-independent-matcher-security-upgrades.zh-CN.md)

## Problem and scope

The independent Live Host and CUA Electron fixture npm locks do not inherit
workspace overrides. After P3, both still resolve minimatch 9/10 through their
Electron build tooling; the fixture also resolves glob 10 through config-file-ts.
P4's workspace migration cannot repair these separate installed trees.

This batch stacks on P5 #17163 (`355b73e044`) after P4 #17149 and upgrades the modern matcher edges while preserving
the existing Electron, builder, ASAR and native application versions. These are
development/build dependencies of private packages, not evidence of a reachable
production application exploit. Publication and consumer rescan remain separate.

## Targets and consumers

| Tree        | Existing parent           | Existing child                | Target                         |
| ----------- | ------------------------- | ----------------------------- | ------------------------------ |
| Live Host   | app-builder-lib 26.15.3   | minimatch 10.2.6              | 11.0.8                         |
| Live Host   | @electron/universal 2.0.3 | minimatch 9.0.9               | 11.0.8                         |
| CUA fixture | app-builder-lib 25.0.5    | minimatch 10.2.6              | 11.0.8                         |
| CUA fixture | @electron/universal 2.0.1 | minimatch 9.0.9               | 11.0.8                         |
| CUA fixture | config-file-ts 0.2.8-rc1  | glob 10.5.0 / minimatch 9.0.9 | glob 14.0.6 / minimatch 11.0.8 |

Use npm overrides scoped to minimatch 9/10 in each tree, plus glob 10 in the
fixture. The latest assessed builder 26.18.0 still declares minimatch ^10.2.5;
updating that parent alone would not establish the security target. Retain each
locked parent and inspect the matcher through the actual parent after install.

The modern matcher requires a build host on Node 20 or >=22. The repository
requires Node >=22, and validation uses Node 22/24. These private build-tool
changes do not raise a public application's runtime engine declaration.

The version targets follow [P4's reconciled advisories](npm-modern-glob-security-upgrades.md): minimatch 11.0.8 includes
compile/escape/cache corrections, and glob 14.0.6 includes the ignore expansion
budget fix. A matcher-only override inside glob 10 is invalid: its RegExp
assumptions break ordinary matching with minimatch 11's Matcher objects. Upgrade
that parent jointly. Add no release-age exception to the workspace policy.

Keep legacy ASAR/dir-compare/filelist/glob 7/minimatch 3/5 and the fixture's
cacache/glob 8 paths separate. Their different APIs and advisory ranges are not
covered by this modern migration; do not claim inflight or every audit finding
has been removed from the independent build trees.

## Compatibility evidence and risks

Before edits, the test engineer exercised the actual installed parents and
repeated the same ordinary-file controls using temporary aliases to glob 14.0.6
and minimatch 11.0.8. Both passed. Alias evidence is not a clean installation.

Builder file selection uses Minimatch.match, including partial directory
traversal and ordered negation/reinclusion. Its hasMagic helper inspects .set
using string/nonstring classification, preserving compatibility with Matcher
objects. Preserve each builder's existing root-node_modules behavior: versions
25 and 26 have different basic filters before packaging defaults apply.

Universal uses the named minimatch function and matchBase for single-architecture
ASAR files, x64ArchFiles and Info.plist selection. Actual ordinary-file ASAR
merges and negative allowlists passed the alias control. That preliminary
control did not cover Mach-O/lipo, native architecture or plist rewriting;
the separate installed/native results are recorded below.

config-file-ts calls the exact glob.glob.sync API, expects arrays and uses
source/output mtimes to decide whether to compile an explicit TS config. The
baseline and alias controls both compile configs under paths with spaces,
resolve relative helper imports and preserve the unchanged-output cache hit.
The pre-existing raw-glob limitation for a literal builder[local].ts filename
still produces MODULE_NOT_FOUND in both controls; this batch does not fix it.

## Validation and acceptance

Generate each independent lock and perform a clean npm ci. Require actual
parent-resolved minimatch 11.0.8 and fixture config-file-ts → glob 14.0.6 →
minimatch 11.0.8, with no remaining 9/10 copies on those paths. Confirm unchanged
parent versions and inspect npm ls, rather than trusting manifest intent.

Repeat parent-level selection, ASAR allowlist, configuration compilation and
cache controls on the installed migration, including stale imported-source
invalidation. Verify plist/native architecture selection and real macOS packaging
where available. Run Live Host build/typecheck/tests and launch the staged CUA
fixture with its preload bridge. Record untested platforms and native boundaries.

Complete workspace build, bundle, typecheck and applicable checks after its
normal release-age policy passes; inspect notices/artifacts and audit changes.
Keep this PR draft while its stack parents are open, update its base after their
merges, then complete current-head CI/review. Original Snyk scan closure and
release/deployment are not established by these build-tool source upgrades.

### Local evidence (November 13, macOS)

Both independent clean npm installs and npm ls pass, with the exact parent and
child versions above. Actual installed-tree file selection, ASAR/plist rules,
configuration caching and imported-helper invalidation pass without aliases.
Two actual universal consumers also merge locally compiled thin x64/arm64
Mach-O fixtures; matching x64ArchFiles preserves identical thin x64 bytes,
while absent/nonmatching rules reject that case. These fixture libraries are
not loaded or executed.

Live Host build, typecheck and all 374 tests pass. Both applications complete
real macOS universal directory packaging with signing/notarization/publication
disabled for this local test. Their executables contain x64 and arm64, expected
ASAR entries and integrity metadata are present, and Live Host's existing
privacy-key cleanup remains effective. Its configured packaged Electron remains
39.2.7, separate from its unchanged npm development runtime 39.8.10; the fixture
uses 39.8.5. No Electron version upgrade is claimed.

Both the staged CUA app and its universal package launch successfully with an
isolated temporary user-data directory. Read-only loopback CDP checks confirm
the actual harness DOM and preload bridge; no desktop input is sent. Live Host
microphone/camera/device behavior, signed/notarized distributions, execution of
the x64 slice and Windows/Linux remain outside these checks.

On npm 11.17 the initial installs left lifecycle scripts pending approval. For
local native setup, only the exact locked Electron/esbuild versions were
explicitly approved in temporary project configuration and rebuilt; that local
configuration was removed. No blanket script permission or committed policy
change was introduced.

Same-time audit snapshots remove six reported Live Host aggregates (13 → 7)
and five fixture aggregates (22 → 17), with no new unique advisory key. Remaining
high/critical and legacy paths remain disclosed; this is not an audit-zero claim.

The final stack includes P5's verified archive migration. The actual frozen
workspace installation passes the unchanged strict package-age policy and
completes normal prepare build/bundle. Full workspace typecheck and all ten
parent worker/budget regression cases pass. Actual independent parent-consumer
and native-selection controls also pass again after this alignment. Generated
tracked notices have no additional delta from the parent.

Full workspace lint and lock/Playwright parity checks also pass. Independent
local dependency review found no actionable defect, and final self-audit is
clean. Status: local acceptance and stack alignment pass; current-head CI/review
and merge remain pending. Keep this batch draft while its parents remain open.
