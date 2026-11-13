# ExcelJS archive dependency security upgrades

[English](npm-exceljs-security-upgrades.md) | [简体中文](npm-exceljs-security-upgrades.zh-CN.md)

## Problem and baseline

This batch stacks on P4 #17149 (`12ed4e0f7f`). ExcelJS 4.4.0 still brings three
glob 7/inflight paths through archiver-utils 2, zip-stream's archiver-utils 3,
and unzipper 0.10/fstream/rimraf. archiver also uses readdir-glob 1/minimatch 5.
ExcelJS is already a Web Shell bundled development dependency. Its rebuilt
browser entry uses JSZip and excludes Node archiver/unzipper/glob code. Current
source does not establish that an old published consumer bundle is repaired.

The [unzipper advisory](https://github.com/ZJONSSON/node-unzipper/security/advisories/GHSA-2756-j7rr-9464)
describes sibling-prefix extraction escape. Its metadata still lists <=0.12.3
without a fixed version, while the supplied scan specifies >=0.12.5. Independent
runtime controls reproduce both public extraction APIs writing a marker to a
controlled temporary sibling with 0.10.14; exact 0.12.5 blocks that write and
preserves a normal entry. This is a library reproduction, not a product exploit.
The inflight cleanup probe did not independently reproduce a leak; there is no
fixed inflight version, so the obsolete dependency paths must be removed.

## Proposed changes and compatibility

| Parent edge             | Existing version | Target |
| ----------------------- | ---------------- | ------ |
| exceljs → unzipper      | 0.10.14          | 0.12.5 |
| archiver-utils 2 → glob | 7.2.3            | 14.0.6 |
| archiver-utils 3 → glob | 7.2.3            | 14.0.6 |
| readdir-glob 1          | 1.1.3            | 4.0.0  |

Apply scoped pnpm overrides and regenerate the workspace lock. Keep archiver
5.3.2, archiver-utils 2.1.0 and zip-stream 4.1.1 unchanged for ExcelJS. Do not
globally substitute glob 14 for all glob 7 consumers: unrelated legacy callers
may require its removed callback API. The inspected archiver-utils 2/3 file
helpers use only the preserved synchronous `glob.sync` API.

Reject the simpler-looking archiver 7/6 upgrade: archiver-utils 4/5 returns
`source.pipe(new PassThrough())`, but ExcelJS's StreamBuf.pipe returns undefined.
That causes a real streaming writer to fail with INPUTSTEAMBUFFERREQUIRED.
Keeping the compatible parent and changing its vulnerable child edges removes
the risks without a production shim or a change to spreadsheet APIs.

readdir-glob 4 preserves the CommonJS function/event API and uses modern
minimatch. Its workspace consumers are ExcelJS's archiver 5 and CLI test-fixture
archiver 7. Cover both. The new toolchain requires Node >=20, within repository
Node >=22; no public runtime engine declaration changes. P4 already supplies
glob 14.0.6/minimatch 11.0.8 and their later advisory fixes. Respect the existing
package-age policy and add no exemption.

## Validation and acceptance

The independent reproduction and 33 existing browser parser/build tests form
the baseline. An isolated candidate graph contains no inflight/glob 7/minimatch
3/5 and passes ordinary document/formula/style, bare-browser read, inline-string
stream write/read, archiver glob/directory and utils file-expansion controls.
This is candidate evidence, not verification of the repository installation.

After normal frozen installation, inspect every actual ExcelJS parent edge and
repeat extraction-boundary and ordinary-file controls. Add regression coverage
for the boundary and streaming writer compatibility. Run the existing Web Shell
parser/browser-build suites and spreadsheet worker/browser E2E, plus CLI
workspace-skill-archive and workspace-skill-management tests for archiver 7.
Build, bundle, typecheck, inspect browser artifacts, regenerate notices, compare
audits and verify a clean packed Web Shell consumer. Final review must establish
that ExcelJS no longer declares any path to the obsolete dependencies; unrelated
workspace dev-only legacy paths must not be called cleared.

The old shared-string streaming-reader control fails on Node 22 and 24 before
this migration. Keep that baseline explicit rather than treating it as a new
regression or silently counting it as passing. Document and browser preview
shared-string behavior is covered separately by the existing parser suite.

## Current verification

The actual frozen workspace installation, including normal prepare build and
bundle, passes under the unchanged strict package-age policy. Full typecheck
and lint pass. Actual Web Shell tests pass 36 cases: the three new archive/
stream regressions plus the existing 33 parser/browser-build cases. CLI
archive/management tests pass 83 cases. All 11 Chromium spreadsheet-preview
E2E cases pass, covering lazy loading, worker policy, virtual scrolling,
formats/merged cells and download fallback on invalid or unavailable previews.

Walking declared dependencies from actual ExcelJS reaches 84 installed packages
with no inflight, fstream, rimraf 2, glob 7 or minimatch 3/5 path. The retained
parents are ExcelJS 4.4.0, archiver 5.3.2, zip-stream 4.1.1 and archiver-utils
2.1.0/3.0.4; both helpers resolve glob 14.0.6/minimatch 11.0.8. Their ordinary
inclusion/exclusion/re-inclusion controls pass. Actual document/formula/style,
bare-browser reading and inline-string stream round trips also pass.

The same-time whole-workspace audit remains 94 reported findings before and
after this batch (14 low, 40 moderate, 33 high, 7 critical). This does not
demonstrate an audit reduction; source graph removal is assessed separately.
Independent local review found no actionable defect and separately reran the
three new regressions successfully. Final package-consumer checks are still
pending. Keep this batch a draft stacked on #17149 until the parent merges and
it can be retargeted.

## Remaining work

This batch does not close #17099 or #16434. Publication, consumer deployment/
lock refresh, original Snyk rescan, remaining independent CUA/Live Host trees
and native Windows/Linux validation remain separate. No daemon route,
production option or public API is added. No open design decision blocks the
scoped parent-edge approach.
