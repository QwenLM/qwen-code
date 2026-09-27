# Round 8 evidence

This round reviews and measures a bounded test reduction from production
baseline `a270907e5f3fd6ebe26ef7d17ea7da3e92c2773a`. Read the
[English report](../../../../docs/design/2026-09-27-core-test-size-adoption.md)
or [Chinese report](../../../../docs/design/2026-09-27-core-test-size-adoption.zh-CN.md)
for the acceptance budgets and semantic review.

The adopted frozen v2 candidate removes 40,616 lines net
(8.28%), taking S1 from 490,301 to 449,685, with 662 runnable test files.
Production bytes and the 5,365 helper, snapshot and fixture lines are unchanged.
All 271 focused cases across 34 files, build, typecheck and ESLint passed.

## Independent failures and fitted repairs

| Sample                                     | Complete baseline |         Candidate v1 |
| ------------------------------------------ | ----------------: | -------------------: |
| 95 historical faults used for selection    |       95 detected |          95 detected |
| 8 historical faults outside that corpus    |        8 detected |           0 detected |
| Previously Killed usage-accounting mutants |                32 | 22 retained; 10 lost |
| Previously Killed workflow-budget mutants  |                77 | 62 retained; 15 lost |

The eight added faults were selected from commits affecting removed tests,
with ordering and applicability rules frozen before replay. They identify
actual gaps; this directed sample does not estimate a package-wide miss rate.
Both sides' independent v1 fault runs have healthy collection and execution.
V1 loses only 0.3243 percentage points of line coverage, yet fails the
independent capability checks above. Its whole suite also records an
unresolved code-mode budget failure alongside the known prune failure.

V2 restores regression checks using those observations, including complete
usage, workflow-budget, process-liveness, XML and file-cache tests. It also
strengthens XML fence oracles and restores small semantic boundary groups.
V2 measurements therefore validate repairs fitted to an observed sample.
The original v1 outcomes and failed attempts remain evidence in their own
right. The three frozen supplemental mutation modules remain unexecuted.

## C1 replay provenance

The training corpus retains detection of all 95 faults. V2 changes affect ten
directed test scopes: these were freshly replayed. The remaining 85 reuse v1 observations
only where executed scope and test bytes match, with unchanged implementation,
helpers and configuration. Baseline observations are reused separately.
`c1-v2-training-reuse-plan.json` records the per-fault source reports and hashes;
the final result distinguishes the ten fresh observations from 85 reused
observations. Two reverse patches have collection errors alongside genuine
executed failures on both sides; the actual assertion failures support
detection and the collection diagnostics remain explicit.

V2's first independent run records seven detections and one health timeout,
with strict comparison unsuccessful. The one-fault supplement retains the
same fault, test scope, worker count and timeout. It passed health and detected
the injected fault through one executed assertion failure. The derived
comparison retains the original attempt and identifies the replacement observation.
Only new failures of executed tests count as detections; collection errors,
empty scopes and existing failures remain separate. See archived
`c1-method.md`, plans, audits and raw reports for exact rules and exclusions.

## C2 execution scopes

Usage and workflow-budget retain their original paired-plan provenance.
The original complete import-owner XML baseline exceeds its 40-minute limit;
partial progress and its incomplete/source-drift result remain preserved.
The drift investigation identifies generated leftovers while tracked source
hashes match. An earlier workflow attempt also remains incomplete because
its requested live-test file was wholly skipped; the execution revision
records that symmetric exclusion explicitly.

The revised XML/file-cache plan selects baseline owners covering a function
other than `<static_initializer>` or `<instance_members_initializer>`: three
files for XML and 19 for file caching. Candidate scopes are the retained
intersection. Whole-module mutation, all operators and static mutants remain
enabled. Revised results describe this function-owner scope; the complete
import-owner XML result remains incomplete. See `c2-method.md`,
`c2-plan-function-owners.json` and its frozen owner-selection manifest.

All mutant identities, statuses and failed attempts are retained. Timeouts
remain inconclusive; gains do not offset previously Killed mutants lost.
Final aggregates retain each module's actual plan provenance.

The four modules contain 454 mutants and retain all 385 previously Killed:
32 usage, 77 workflow-budget, 147 XML and 129 file-cache. XML gains six kills.
The file-cache baseline has two Timeouts that become Killed in v2; their
baseline state remains inconclusive and neither contributes to old Killed or
gains. The aggregate loss budget passes while the strict comparator remains
unsuccessful because of those two unknown baseline results.

## Final results

| Evidence                                                          | Final value                                                                                                   |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| V2 C1 training, including fresh/reused counts                     | 95 detected: 10 fresh + 85 reused                                                                             |
| V2 independent C1 and timeout supplement                          | 7 original detections + 1 supplemental detection; original timeout retained                                   |
| V2 paired C2, losses and inconclusive statuses by scope           | 385/385 old Killed retained; 2 baseline Timeouts remain inconclusive                                          |
| Final whole-core suite health and fixed-denominator coverage loss | 28,256 passed, one shared prune failure, three pending; no new failures; 782 lost lines / 257,159 = 0.3041 pp |
| Raw archive/index SHA-256 and source-file count                   | Recorded in `manifest.json` and `round8-files.json`                                                           |
| Complete XML leftover backup member and SHA-256                   | `vm/c2-xml-timeout-leftovers.tar.gz`; see manifest                                                            |

Coverage loss uses the fixed baseline denominator of 257,159 instrumented
lines; one newly covered line does not offset the 782 lost lines. Both sides
have the same instrumented file and line sets. The final baseline has 31,164
passed cases, the same prune failure and ten pending cases. Raw suite health
remains false and the retained-case comparison passes. The original v1
code-mode failure remains recorded, although it does not recur in the final
pair. No A/A noise floor or runtime speedup was established.

## Tracked and raw artifacts

- `candidate-v1.json.gz` and `candidate-v2.json.gz`: frozen candidate records.
- `candidate-v2-inventory.json.gz`: exact retained test file hashes.
- `repair-v2-map.json.gz`: restored-case mappings and reasons.
- `manifest.json` and `results.json`: final identities, results and limitations.

The four gzip files use a fixed timestamp; the final manifest records both
compressed and original hashes. Transfer the ignored
`.qwen/testloc-evidence/round8-raw.tar.gz` and
`.qwen/testloc-evidence/round8-files.json` with this tracked evidence.
`local/` resolves paths relative to `.qwen/test-loc-round8/`; `vm/` resolves
paths relative to `/tmp/qwen-testloc-round8/`. Embedded `raw-files.json`
records every original path, archive member, size and SHA-256.

Collection includes plans, expected mutant inventories, commands, logs,
reports, native coverage JSON/LCOV, failed attempts and old tool versions,
without filtering by outcome. Repository checkouts, dependency/build trees
and coverage HTML are excluded; used measurement/configuration files inside
VM checkouts are explicitly enumerated in `vmCheckoutEvidence`. XML timeout
leftovers have a separate complete backup of 5,061 files, including generated
`dist/` files excluded by ordinary directory collection; the manifest records
its member and hash. Collection completeness means copied bytes were verified
stable, independently of suite health or capability success.

Round 5, 6 and 7 archives remain separate dependencies. Historical references
are preserved rather than traversed. Install pinned repository dependencies
separately; the baseline bundle requires the commit identified below.

## Reconstruct candidate v2

Run from a repository containing prerequisite commit
`37412a57d473525a81f87e4ca36447981950d9a9`, with an unused destination:

```sh
testloc_unpack=$(mktemp -d)
tar -xzf .qwen/testloc-evidence/round8-raw.tar.gz -C "$testloc_unpack"
git bundle verify "$testloc_unpack/local/baseline.bundle"
git fetch "$testloc_unpack/local/baseline.bundle" HEAD
git worktree add --detach /tmp/qwen-testloc-round8-replay \
  a270907e5f3fd6ebe26ef7d17ea7da3e92c2773a
git -C /tmp/qwen-testloc-round8-replay apply --check \
  "$testloc_unpack/local/candidate-v2.patch"
git -C /tmp/qwen-testloc-round8-replay apply \
  "$testloc_unpack/local/candidate-v2.patch"
```

The patch SHA-256 is
`11a9b921bd4fdd855884c25655a4cfccc18f72c3b162ea6bcde2df24242962bc`.
Check retained files against the frozen inventory, install pinned dependencies
and build before package tests. Resolve archived command paths through the
member index when replaying elsewhere; preserve the recorded scope, exclusions
and tool version for each attempt.
