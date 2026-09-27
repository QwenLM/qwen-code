# Core test size: validate and adopt a bounded reduction

[English](2026-09-27-core-test-size-adoption.md) | [简体中文](2026-09-27-core-test-size-adoption.zh-CN.md)

Status: round 8 complete; adopt the frozen v2 candidate under the stated budgets.

## Starting point

[Round 7](2026-09-27-core-test-size-relaxed-budget.md) produced a candidate
removing 45,167 lines across 184 test files from production baseline
`a270907e5f3fd6ebe26ef7d17ea7da3e92c2773a`. Its full core suite has no new
failures and loses 0.3982 percentage points of baseline line coverage.
Its fault and mutation retention results were historical graph predictions.
This round validates actual detection and prepares an adoptable test change.

## Accepted budgets

- Allow case deletion, fewer assertions and fewer independent failure labels.
- Lose at most 0.5 percentage points of covered lines using the fixed baseline
  instrumented-line denominator; gains do not offset losses.
- Lose at most 1% of previously Killed mutants in a frozen paired sample;
  apply this budget to the aggregate, report each module separately, never
  offset losses with gains, and keep Timeouts inconclusive.
- Retain historical fault detection and security, permission and data-integrity
  checks. Review local coverage holes separately from package averages.
- Keep production implementation unchanged.

## Candidate review

Review deleted cases against retained tests and the production branches they
exercise. Restore small groups where deletion exposes a necessary behavior.
Pay particular attention to compaction, memory discovery, file-cache freshness,
streaming/tool protocols, process cleanup and persistent state. Freeze final
test file hashes after these changes and before capability comparisons.

## Measurement design

C1 replays real historical reverse patches in separate complete and reduced
checkouts. Preserve each fault's original directed baseline test scope and
record its intersection with the reduced candidate. A deleted test cannot
become a collection failure that counts as detection. Empty retained scopes,
ineligible patches and existing failures stay visible. Add usable faults
outside the selection corpus where available; label training-corpus replays.
Both sides exclude only the exact known prune-failure test name from C1
execution; the native whole-suite runs include that test and retain its result.

C2 freezes a stratified sample outside the 19-module mutation training graph,
including modules with concentrated coverage loss and modules with redundant
line coverage. Keep both sides' production source and mutant identities equal.
Record selected operators, static-mutant scope, requested/observed tests and
all exclusions. Freeze the expected identity inventory before candidate runs.
Any repair driven by these outcomes is fitted to this sample and must be
reported as such.

Use separate Linux VM checkouts and bounded workers. Directed capability runs
may overlap; runtime performance is outside this experiment. Final verification
includes native whole-core coverage, suite health, build and typecheck.
Preserve the known prune failure and any new failure without relabeling the
raw suite as healthy.

XML's complete import-owner run stops after 40 minutes and remains incomplete.
Baseline per-file coverage shows most owners only execute module initialization.
An execution revision selects owners whose baseline `coveredFunctions` contain
a function other than `<static_initializer>` or `<instance_members_initializer>`:
three files for XML and 19 for file caching. The candidate executes the retained
intersection. Whole modules, all operators and static mutations stay enabled.
Report the two scopes separately; success in the revised scope does not replace
the missing complete-import-scope result. Completed usage and workflow-budget
measurements retain their original plan provenance. The three frozen
supplemental modules are not run this round.

## Measured detection in candidate v1

After semantic review, candidate v1 retains 648 test files and removes 43,199
lines net. Its 20 restored files pass 84 focused cases, build, typecheck and
ESLint. Coverage loses 834 lines over the fixed 257,159-line denominator,
or 0.3243 percentage points.

| Measured sample                            | Complete baseline | Candidate v1 | Result                    |
| ------------------------------------------ | ----------------: | -----------: | ------------------------- |
| 95 historical faults used for selection    |       95 detected |  95 detected | Recorded corpus retained  |
| 8 historical faults outside that corpus    |        8 detected |   0 detected | Restore regression checks |
| Previously Killed usage-accounting mutants |                32 |  22 retained | 10/32 lost                |
| Previously Killed workflow-budget mutants  |                77 |  62 retained | 15/77 lost                |

The eight added historical faults target modules associated with removed
tests. Their commit ordering and patch-applicability selection were frozen
before replay. They expose real candidate gaps but do not estimate a
package-wide missed-fault rate. Neither side has health, collection or timeout
problems; all 20 new baseline failures map to executed assertions. The usage
module loses no covered lines but loses 31.25% of its previously Killed
mutants. Line coverage and the historical observer graph therefore need
independent capability checks.

The v1 whole suite has the existing prune failure and one code-mode 50 ms
budget failure. Two alternating baseline/candidate focused pairs pass, and
relevant source and build hashes match. This does not establish the cause.
Keep the original failure and run final whole suites separately after
capability workloads finish.

## Repairs after observation

Keep complete original tests for usage accounting, workflow budgets, process
liveness, XML recovery and file caching; strengthen the XML fence oracles.
The first two mutation modules already reject v1. Cancel its unstarted runs
for the latter two modules and measure v2 directly; their v1 outcomes remain
"not run". Restore small groups for the independent historical regressions:
Git/Qwen ignore whitespace semantics, schema conversion, streaming call index
collisions, Skill-result compaction and dotfile language detection. Semantic
review also restores media provenance isolation, unreadable persistent-data
protection, handle binding, workspace realpath containment, runtime sidecar
ownership and bundled skill authorization. Correct XML fence fixtures that
previously masked one another's guards.

These repairs use v1 failure observations. Subsequent replays validate repairs
against an observed sample; report original independent failures separately
from repaired results. Ordinary formatting, diagnostics, some error inputs,
recall quality and scan-latency evaluations still shrink. Package averages
do not remove those risks.

## Measured candidate v2

The frozen v2 candidate removes 40,616 lines net (8.28%), reducing S1 from
490,301 to 449,685. S1 includes test helpers, snapshots and fixtures; their
5,365 additional lines remain unchanged. Runnable test source files fall from
812 to 662: 150 are removed and 29 are shortened or strengthened. Production
bytes remain unchanged. All 271 focused cases across 34 relevant files pass,
as do build, typecheck and ESLint.

The 95 training faults retain detection: ten fresh v2 replays and 85 reused
v1 observations with identical executed test scope and source hashes.
Two historical reverse patches cause collection errors alongside genuine new
failed assertions on both sides; detection uses those executed assertions.
Their diagnostics remain explicit. This is not 95 fresh v2 executions.

The eight additional faults have seven detections in the first v2 attempt
and one in a separate supplement. The first attempt's `b6103543f5` health
invocation timed out after 600 seconds and remains incomplete evidence.
After other capability workloads stopped, its supplement kept the same full
test scope, two workers and 600-second limit: health passed and fault injection
produced one executed assertion failure. The combined result identifies the
source of every observation and preserves the original failed strict comparison.

| Mutation module  | Baseline Killed | Retained | Lost | Unknown among old Killed |
| ---------------- | --------------: | -------: | ---: | -----------------------: |
| Usage accounting |              32 |       32 |    0 |                        0 |
| Workflow budget  |              77 |       77 |    0 |                        0 |
| XML recovery     |             147 |      147 |    0 |                        0 |
| File cache       |             129 |      129 |    0 |                        0 |
| Total            |             385 |      385 |    0 |                        0 |

The four paired modules contain 454 mutants and meet the aggregate 1% loss
budget. XML gains six detections. File-cache baseline has two Timeouts that
become Killed in v2; they stay inconclusive on the baseline side and count
as neither old Killed nor gains. The strict comparator remains unsuccessful
because of those two unknown baseline results. This distinction is preserved
alongside the successful bounded old-Killed comparison. All actual C2
attempts, including failed and timed-out attempts, total 6,839.86 seconds of
module wall time; concurrent attempts overlap in calendar time.

## Final whole-suite verification

After capability workloads stopped, the two native coverage runs executed
sequentially with the same configuration and two workers per side.

| Native core suite | Test files | Passed | Failed | Pending |
| ----------------- | ---------: | -----: | -----: | ------: |
| Complete baseline |        812 | 31,164 |      1 |      10 |
| Candidate v2      |        662 | 28,256 |      1 |       3 |

Both failures are the existing `dryRunGitWorktreePrune` assertion. There are
no new failures, newly pending retained cases, collection errors, execution
anomalies or unexpected case-inventory changes. Raw suite health remains
false. The earlier v1 code-mode failure remains recorded; it does not recur
in this final pair, without establishing its original cause. Source hashes
remain unchanged throughout both runs.

Both runs instrument the same 257,159 lines in 870 files. Baseline covers
233,103 lines and v2 covers 232,322. V2 loses 782 formerly covered lines:
**0.3041 percentage points**, within the 0.5 budget. One new covered line
does not offset that loss. Some local reductions remain substantial:

| Module                      | Lost covered lines | Share of that module's formerly covered lines |
| --------------------------- | -----------------: | --------------------------------------------: |
| Microcompaction             |                 48 |                                         7.25% |
| Memory discovery            |                 43 |                                        10.05% |
| Streaming tool-call parser  |                 34 |                                        10.03% |
| Compaction input slimming   |                 33 |                                         9.59% |
| Post-compaction attachments |                 33 |                                         7.93% |

The raw evidence contains every local lost line. V8 branch denominators
change from 80,143 to 79,279; 415 exact matched branches lose coverage,
while 897 shape changes and 119 duplicate-location groups remain separately
reported. These counts do not establish complete branch preservation.
There is no A/A coverage noise estimate, and observed differences are not
automatically dismissed as noise. Runtime observations support no speedup
claim. Linux arm64 and skipped platform/live-model cases limit the observed
execution scope.

## Adoption and evidence

Adopt v2's 40,616-line reduction with the measured coverage cost and explicitly
bounded capability claims above. This is a verified point within this round's
budget, not a measured maximum reduction. The four mutation modules and
repaired historical samples do not establish equivalence across the whole
core package. Removed recall-quality and scan-latency evaluations remain an
explicit cost. Production implementation and existing round 7 evidence stay
unchanged.

The final source diff received two consecutive clean review passes. The
[round 8 evidence](../../scripts/test-loc/evidence/round8/README.md) contains
the result summary, frozen inventories, archive identities and reconstruction
instructions. `.qwen/test-loc-round8/` holds working evidence; the ignored
`.qwen/testloc-evidence/round8-raw.tar.gz` and `round8-files.json` retain plans,
exact candidate bytes, commands, native reports, failed attempts, tool
versions and per-file hashes. Collection completeness describes copied bytes
and is separate from raw suite health.
