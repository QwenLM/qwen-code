# Core Test Size Reduction: Final Experiments and Results

[English](core-test-size-reduction-results.md) | [简体中文](core-test-size-reduction-results.zh-CN.md)

Status: implementation, staged experiments, and evidence archival are complete
for the current candidate on `codex/core-test-size-next`. It has not been merged
into main. Date: 2026-09-27.

This report and the [design](core-test-size-reduction.md) form the final task
deliverable. The main narrative presents methods and results; execution history
remains available through the evidence index.

## 1. Overall Result and Baselines

**Against the fixed main snapshot, Core test code decreased from 673,272 to
449,685 lines: 223,587 lines removed (33.21%), with Core production code unchanged.**

| Metric                                                     | Main snapshot | Final candidate |               Change |
| ---------------------------------------------------------- | ------------: | --------------: | -------------------: |
| S1: test lines, including helpers, snapshots, and fixtures |       673,272 |         449,685 |   −223,587 (−33.21%) |
| S2: bytes in the same file set                             |    23,538,737 |      16,307,779 | −7,230,958 (−30.72%) |
| Runnable test source files                                 |           812 |             662 |                 −150 |
| Core production code lines                                 |       400,027 |         400,027 |                    0 |
| Test / production line ratio                               |          1.68 |            1.12 |                −0.56 |

The fixed revision identities are:

- **Overall baseline**: main snapshot `9e60263fdeff8cb5bf5fc49287a2d20cef0dbe2e`.
- **Final test code**: `460151af0c6ec2a19d7a4d736aadda023a696527`.
- **Baseline for the final capability experiments**:
  `a270907e5f3fd6ebe26ef7d17ea7da3e92c2773a`, after earlier compression, at
  490,301 lines. The subsequent 40,616-line reduction is part of the total.

S1/S2 were remeasured with the same `size.mjs` against clean Core directories at
the recorded main and final revisions. The Core Git diff changes 555 test or
support files, adding 147,244 lines and deleting 370,831; every non-test Core path
is unchanged. Auditable values, Git tree identities, the tool hash, and stage
references are in the [machine results](../../scripts/test-loc/evidence/final/results.json).

The original 417 commits started from the older `ab61e04161`, reducing
659,618 → 477,908 lines. This result integrates that work onto the stated main
snapshot while retaining intervening upstream tests. All overall percentages
use 673,272 as the denominator. The original exploration goal of at least 40%
Core reduction remains unmet.

## 2. Adopted Changes

| Method group                                     |             S1 change | Net removed | Representative changes                                                                        |
| ------------------------------------------------ | --------------------: | ----------: | --------------------------------------------------------------------------------------------- |
| Bulk structural compression and main integration |     673,272 → 491,593 |     181,679 | Parameter tables, shared builders, mocks/fixtures, repeated call sequences, assertion helpers |
| Behavioral contract consolidation                |     491,593 → 491,361 |         232 | Complete memory-import output, session hook lifecycle, equivalent input partitions            |
| Schema, Hooks, Providers                         |     491,361 → 490,301 |       1,060 | Whole-object expectations, event matrices, shared request and HTTP lifecycle checks           |
| Budgeted test reduction                          |     490,301 → 449,685 |      40,616 | Remove overlapping checks covered by retained tests; retain or strengthen risk boundaries     |
| **Total**                                        | **673,272 → 449,685** | **223,587** |                                                                                               |

The latter three groups permit fewer cases, assertions, and independent failure
labels. Helpers always count toward S1/S2; splitting files earns no reduction by
itself. The final group deletes 150 test files and modifies 29, with its 5,365
lines of helpers, snapshots, and fixtures unchanged.

## 3. Experiments with Relaxed Criteria

The final group uses explicit budgets: preserve historical-fault detection; lose
at most 1% of previously Killed mutants in the fixed sample; lose at most 0.5
percentage points of formerly covered lines against the fixed instrumented-line
denominator. New kills and coverage do not offset losses. Security, permissions,
and data-integrity checks receive separate review.

All candidates below are relative to `a270907e`, with 257,159 instrumented lines
as the coverage denominator.

| Candidate                                                | Remaining S1 | Reduction in this group | Covered-line loss, percentage points | Decision                                                                      |
| -------------------------------------------------------- | -----------: | ----------------------: | -----------------------------------: | ----------------------------------------------------------------------------- |
| Exploration guided by historical detection relationships |      445,134 |                  45,167 |                               0.3982 | Input to the final design; C1/C2 were historical predictions at that point    |
| Approximately 50,000 lines removed                       |      440,160 |                  50,141 |                               0.4577 | 2 new full-suite failures; not adopted                                        |
| Approximately 100,000 lines removed                      |      390,249 |                 100,052 |                               3.1094 | Exceeds coverage budget; not adopted                                          |
| Approximately 150,000 lines removed                      |      339,088 |                 151,213 |                              10.5285 | Exceeds coverage budget; not adopted                                          |
| **Adopted candidate**                                    |  **449,685** |              **40,616** |                           **0.3041** | Actual capability validation below completed; adopted within its stated scope |

See the [reduction-size experiments](../../scripts/test-loc/evidence/round7/results.json).
Exploratory candidates are alternatives; their savings do not add together.
They also lack independent paired C1/C2 validation.

One result determined the validation method: an early candidate retained all
95 training-fault detections but missed all 8 subsequently added faults. Usage
accounting kept line coverage while losing 10/32 previously Killed mutants.
The final candidate restores the relevant regression tests and validates them
through actual replay. Those 8 faults then informed repairs, so their final
detections are validation against observed samples.

## 4. Capability Evidence and Scope

### 4.1 Stage Comparisons

| Comparison stage                                     | C1: historical faults                                           | C2: mutation                                                  | C3: coverage                                                                                                                                    |
| ---------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Main → structural compression, `9e60263f → 10a29740` | 92/103 detected on both sides; 0 lost                           | 2,809 identical identities and statuses; 14 Timeouts          | 17 initial line differences: 16 showed same-version fluctuation; the other line was covered on both sides in a supplemental relevant-test scope |
| Behavioral contracts, `10a29740 → 37412a57`          | 2/2 retained; 1 other ineligible                                | 822 mutants; 0 lost kills, 2 gains, 18 paired Timeouts        | Identical memory/planner lines and branches; all 182 session lines retained, 5 branch-shape changes                                             |
| Schema/Hooks/Providers, `37412a57 → a270907e`        | 3/3 retained; 6 ineligible; no direct HookSystem fault          | 2,163 mutants; 0 lost kills, 43 gains, 19 paired Timeouts     | 0 lost lines or matched branches; 6 Schema and 15 Hooks branch-shape changes                                                                    |
| Budgeted reduction, `a270907e → 460151af`            | 95 training detections retained; 8 supplemental faults detected | Four modules, 454 mutants; all 385 previously Killed retained | 782 formerly covered lines lost, 0.3041 percentage points                                                                                       |

Each row retains its own sample and revision pair. Timeouts and unmatched
branch shapes remain inconclusive; the corresponding strict comparators remain
false. Samples overlap, so fault and mutant counts are not summed.

**Direct cumulative main-to-final measurements currently cover size and source
identity. Capability evidence consists of these staged comparisons; there is
no complete `9e60263f → 460151af` paired C1/C2/C3 report using the same
configuration and sample. The 0.3041-point and 385-Killed results apply only to
the final group.**

### 4.2 Final Candidate Detection

- **C1**: the 95 training observations comprise 10 fresh final-candidate replays
  and 85 reused observations with verified execution scopes and source hashes.
  The 8 supplemental observations comprise 7 initial detections and 1 separate
  replay after a timeout. Two historical faults also cause collection errors;
  detection rests on separately executed new failed assertions. Original
  collection diagnostics and timeout records are retained.
- **C2**: previously Killed retention is 32/32 for usage accounting, 77/77 for
  workflow budgets, 147/147 for XML recovery, and 129/129 for file cache. XML gains
  6 kills. Two file-cache baseline Timeouts remain inconclusive, excluded from
  both previously Killed and gains. The bounded-loss budget passes; strict
  full-sample comparison remains false.
- **C2 scope**: four complete production modules, all operators, and static
  mutation. XML and file cache use revised test scopes selected by function
  coverage. The original full import-owner XML scope remains incomplete, and
  three other preselected modules were not run.

### 4.3 Final Suite and Engineering Checks

After capability workloads stopped, native Core suites and V8 coverage ran
sequentially on a Linux arm64 VM with the same configuration and 2 workers per
side. The comparison remains `a270907e → 460151af`.

| Version               | Test files | Passed | Failed | Pending |
| --------------------- | ---------: | -----: | -----: | ------: |
| This group's baseline |        812 | 31,164 |      1 |      10 |
| Final candidate       |        662 | 28,256 |      1 |       3 |

The sole failure on both sides is
`dryRunGitWorktreePrune counts any link in the admin directory against the prune`.
New failures, newly pending retained cases, collection errors, execution
anomalies, and unexpected case-inventory changes are all 0. Raw suite health
remains false. All 271 focused cases across 34 related files, build, typecheck,
and ESLint passed; the final source diff received two clean review passes.

### 4.4 Accepted Costs

- The final group loses 782 formerly covered lines, with 1 newly covered line
  reported separately. Local losses include 43/428 (10.05%) in memory discovery
  and 34/339 (10.03%) in streaming tool-call parsing. The package budget requires
  interpretation alongside local review.
- Among exactly matched V8 branches, 415 lose coverage; 897 shape changes and
  119 duplicate-location groups remain separate. Branch denominators change,
  preventing a branch-preservation claim.
- **C4 diagnosis**: main-to-structural-compression replay retains medians of
  1 failing file and 4 failing cases, with 82/92 detected faults failing in a
  same-basename sibling test. Schema consolidation reduces one fault's failure
  labels from 50 to 31; an earlier failure can mask later assertions. The final
  deletion stage has no new package-wide C4 aggregate.
- Some output formatting, diagnostics, invalid-input checks, recall-quality
  evaluations, and scan-latency evaluations were removed.
- The final candidate has no A/A coverage-noise estimate or repeated runtime
  benefit measurement. Skipped platform and live-model cases are outside this
  Linux observation scope. Earlier unresolved intermittent failures remain in
  the archive.

## 5. Deliverables and Reproduction

| Deliverable                                       | Entry point                                                                 |
| ------------------------------------------------- | --------------------------------------------------------------------------- |
| Unified design, metrics, acceptance criteria      | [Design](core-test-size-reduction.md)                                       |
| Cumulative size, revisions, hashes, stage index   | [Final machine results](../../scripts/test-loc/evidence/final/results.json) |
| Measurement tools and procedures                  | [Tool guide](../../scripts/test-loc/README.md)                              |
| Main integration and behavioral-contract evidence | [Round 5](../../scripts/test-loc/evidence/round5/README.md)                 |
| Schema/Hooks/Providers evidence                   | [Round 6](../../scripts/test-loc/evidence/round6/README.md)                 |
| Exploration with relaxed criteria                 | [Round 7](../../scripts/test-loc/evidence/round7/README.md)                 |
| Complete evidence for the adopted final candidate | [Round 8](../../scripts/test-loc/evidence/round8/README.md)                 |

Run the following from this task's checkout containing the recorded commits to
reproduce overall size independently. Git manages the temporary worktrees;
size measurement needs no dependency installation:

```sh
testloc_root=$(git rev-parse --show-toplevel)
testloc_repro=$(mktemp -d)
git worktree add --detach "$testloc_repro/main" \
  9e60263fdeff8cb5bf5fc49287a2d20cef0dbe2e
git worktree add --detach "$testloc_repro/final" \
  460151af0c6ec2a19d7a4d736aadda023a696527
node "$testloc_root/scripts/test-loc/size.mjs" \
  "$testloc_repro/main" packages/core --json
node "$testloc_root/scripts/test-loc/size.mjs" \
  "$testloc_repro/final" packages/core --json
git diff --stat 9e60263fdeff8cb5bf5fc49287a2d20cef0dbe2e \
  460151af0c6ec2a19d7a4d736aadda023a696527 -- packages/core
git worktree remove "$testloc_repro/main"
git worktree remove "$testloc_repro/final"
rmdir "$testloc_repro"
```

Full capability reproduction requires each stage's plans and original reports.
Git contains compressed plans, result summaries, manifests, and hashes. Larger
raw reports live in the ignored
`.qwen/testloc-evidence/{historical,round5,round6,round7,round8}-raw.tar.gz`
archives, which must accompany a task handoff. Each stage's README describes
extraction, path mapping, and comparison commands.

## 6. Final Conclusion

This task delivers a candidate with **33.21%** less test code, unchanged Core
production code, and auditable design, tools, and staged evidence. Structural
compression supplies most savings. Relaxed case and coverage criteria permit
another **40,616 lines** of adopted reduction with explicit costs.

Available evidence supports adopting this candidate within the stated budgets
and sample scopes. The maximum feasible reduction, the 40% Core target, and a
complete main-to-final paired capability measurement remain follow-up work.
