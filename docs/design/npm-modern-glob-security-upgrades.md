# Modern glob and minimatch security migration

[English](npm-modern-glob-security-upgrades.md) | [简体中文](npm-modern-glob-security-upgrades.zh-CN.md)

## Problem and baseline

This batch follows merged P3 #17147 on main `6fb21a87f3`. The workspace resolves glob
10.5.0/13.0.6 with minimatch 9.0.9/10.2.5; Mobile's independent npm tree also
contains glob 10.5.0 and minimatch 9.0.9/10.2.6.

[GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249)
lists minimatch >=7,<11.0.1. Direct CLI minimatch calls do not request level 2,
but glob 10.5.0 explicitly sets `optimizationLevel: 2` in its constructor. The
earlier direct-call assessment does not cover this indirect path. Deterministic
reproduction expands eight `**/../a/b/` segments to 256 alternatives in both old
modern versions even with an explicit budget of 32; fixed versions enforce it.
This proves library amplification, not a measured product denial of service.

## Targets and compatibility decisions

Use minimatch **11.0.8** and glob **14.0.6**. Merely adopting minimatch 11.0.1
would introduce later known issues: wildcard compilation is fixed in 11.0.7
([GHSA-cf2h-pxjq-68xw](https://github.com/isaacs/minimatch/security/advisories/GHSA-cf2h-pxjq-68xw));
escaping and cache retention are fixed in 11.0.8
([GHSA-c859-jr93-m5j4](https://github.com/isaacs/minimatch/security/advisories/GHSA-c859-jr93-m5j4),
[GHSA-hqmv-qgp3-jx75](https://github.com/isaacs/minimatch/security/advisories/GHSA-hqmv-qgp3-jx75)).
glob 14.0.6 fixes ignore-pattern expansion budgets
([GHSA-qxr8-q827-836c](https://github.com/isaacs/node-glob/security/advisories/GHSA-qxr8-q827-836c));
14.0.2 also fixes traversal continuing after cancellation
([GHSA-3g3m-2fjr-6pw4](https://github.com/isaacs/node-glob/security/advisories/GHSA-3g3m-2fjr-6pw4)).

Do not force minimatch 11 beneath glob 10/13. Their pattern implementation uses
`instanceof RegExp`, whereas minimatch 11 uses nonrecursive Matcher objects.
Upgrade the modern glob parents together. Retain legacy glob 7 and minimatch
3/5 until their separate parent-chain migration; their callback/function APIs
cannot be replaced with modern majors by a global override.

Raise root/Core/CLI glob declarations and CLI's direct minimatch declaration.
Declare Core's minimatch floor as 11.0.8 too: glob 14.0.6 still requests
`^11.0.5`, which alone permits later-known vulnerable matcher versions in a
consumer installation. This declaration records the consumer floor, not a new
application API; existing consumer locks still need refresh and verification.
The direct floor cannot constrain a second matcher copy retained beneath glob
by an existing consumer lock; consumer probes must resolve through glob itself.
Use matching npm/pnpm overrides scoped to modern glob and minimatch ranges so
transitive modern consumers migrate together. Mirror these in the independent
Mobile installation. Respect pnpm's package-age policy; do not add exemptions.
If a target has not aged sufficiently, keep this batch a draft until it can
install normally. Do not choose an already vulnerable interim target.

## Consumers and impact

| Consumer                                                      | Required behavior                                                              |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| CLI extension path activation, Hosted brace containment       | dotfiles, brace expansion, escaping and traversal rejection                    |
| Core glob/grep workers                                        | async streams, limits, cancellation, symlinks and containment                  |
| Core extension converters/manager/variables, pathReader       | recursive discovery and relative/absolute paths                                |
| Core filesystem service and LSP discovery                     | sync results, ignores, nocase and limits                                       |
| CLI command loaders/migration and Hosted workspace filesystem | command enumeration, workspace scoping and ignore callbacks                    |
| Root clean/i18n/bundle scripts and workflow tests             | sync/async discovery and copying                                               |
| @ts-morph/common, vsce, TypeScript ESLint, test-exclude       | public matching, package file selection, lint filtering and coverage selection |
| archiver-utils 5, cacache 19                                  | archive file expansion and cache content enumeration                           |
| Mobile build/test tooling                                     | independent npm install, build, types and non-device tests                     |

Node requirements remain within the repository's Node >=22 contract. Mobile's
modern copies are development-only; its runtime Node >=18 declaration stays
unchanged, while development verification uses repository Node >=22. The
matching engine changes substantially, so a matching type signature alone is
insufficient. Preserve existing application guards; add no public switch or
daemon route. Refresh generated notices for changed licenses/dependencies.

## Validation and acceptance

Reproduce before editing, through the test-engineer. Verify the migration with
real directory globbing and the existing precise Core/CLI suites for the above
consumers, then full build, bundle, typecheck and lint. Check actual parent
resolution for every modern consumer. Exercise sync, async and stream searches,
dotfiles, braces, ignores, cancellation and containment; prove budgets are
enforced without weakening ordinary patterns. Check VSIX packaging and
ts-morph file selection. Install Mobile cleanly and run its non-device checks.
Compare production audit results against the parent and inspect clean CLI/Core
package consumers: workspace overrides are not inherited by published packages.

Acceptance requires these checks and a normal frozen install at fixed versions.
Local verification is recorded below; remote checks and merge remain separate.

## Current verification

Mobile's clean independent installation and build passed, as did its 32
non-device tests and actual-parent matching/globbing, coverage-selection and
TypeScript ESLint project-selection probes. Its lint still reports 6,374 errors;
an isolated parent-commit installation reports exactly the same diagnostic
files and messages, so it is a baseline failure, not a passing lint result.

After the normal 24-hour age elapsed, fresh-cache strict pnpm verification
accepted all 2,208 lock entries without an external exemption. The frozen
workspace install, prepare build, bundle, full typecheck and lint passed.
The actual installed tree passes 575 targeted Core tests and 309 CLI tests,
including all three new budget/ordinary-name regressions. Actual Core/CLI
glob parents resolve 14.0.6 with minimatch 11.0.8.

Three old worker assertions depended on the vulnerable matcher staying slow.
An independent same-source comparison measured the new worker correctly
returning no matches in 28–45 ms while the old one reached the 500 ms deadline.
The tests now verify the normal results and separately exercise a controlled
idle real Worker for the existing 500 ms deadline and 300 ms cancellation,
then verify subsequent ordinary searches. Production worker code is unchanged.
Independent verification passes all seven worker tests.

Actual-parent ts-morph, test-exclude, TypeScript ESLint, archiver-utils 5 and
cacache 19 controls pass, as do VSCE file selection and a real temporary VSIX.
Generated notices were independently reproduced exactly for 849 dependencies.
A clean Core tarball consumer without root overrides resolves minimatch through
glob to 11.0.8 and passes bounded/ordinary searches and npm tree validation.
The prepared release CLI tarball installs in another clean consumer and starts
with version/help on Node 22.23.2 and 24.19.0; npm tree validation passes.
The raw development CLI workspace tarball has local workspace references and
is not treated as the release package.

Same-time production audits against the P3 dependency baseline decrease from
60 to 58 findings, removing the minimatch optimization and glob cancellation
advisories with no added advisory keys. Other legacy findings remain. These
results do not certify publication or replace downstream lock refreshes.

## Remaining work

Keep #17099 open. Legacy ExcelJS/archiver/unzipper/inflight paths, independent
CUA/Live Host modern glob copies, #13169 example coordination, publication,
consumer deployment and original Snyk rescan remain tracked. Native Windows/Linux
and device validation cannot be inferred from macOS tests.
