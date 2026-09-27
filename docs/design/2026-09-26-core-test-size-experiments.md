# Core test size: reproducible integration and further experiments

[English](2026-09-26-core-test-size-experiments.md) | [简体中文](2026-09-26-core-test-size-experiments.zh-CN.md)

Status: completed, 2026-09-27. Results are on `codex/core-test-size-next`;
main remains at `9e60263fde`. The branch has not been merged into main.

## Baseline and scope

The previous experiment compressed core tests from commit `ab61e04161` to
`e15058c26b` in 417 commits. Including fixtures and test utilities, tracked
test code fell from 659,618 to 477,908 lines, and from 23,108,022 to
17,375,101 bytes. Only core tests and a shared model fixture module changed.

This continuation integrates that final result on a branch based on main at
`9e60263fde`, preserves upstream test changes, archives the original measurement evidence,
and explores further reductions within core. Production behavior, CLI and
Web Shell compression, and a PR growth policy are outside this phase.

The user explicitly authorized experiments beyond mechanical compression,
including merging similar cases. Test count, original names and assertion
counts therefore describe the change; they are not immutable requirements
for these new experiments. They remain useful strict checks for ordinary
compression. A lower line count alone does not establish retained capability.

## Reproducible measurements

Keep the frozen historical fault corpus, targeted faults, sample definitions,
dependency versions and compact original results under `scripts/test-loc`.
Record source revisions and hashes; distinguish recovered evidence from new
runs. Large raw reports may remain in named experiment artifacts, with their
locations and hashes recorded. Never silently replace the historical sample
by rebuilding it against a different main revision.

The executable gate must reject failed or empty test runs, missing reports,
incomplete assertion observations and unexplained name changes. It emits a
machine-readable result and a failing exit status. Experiment mode accepts
explicit many-to-one case mappings and deletion reasons and reports the
resulting case and assertion changes. Each temporary file and coverage
directory belongs to one run and is cleaned up independently.

Historical fault and mutation runs use disposable checkouts because they
modify implementation files. Compare tests before and after on the same
implementation revision. Fix worker count and tool versions; repeat apparent
losses and compare identical-run variation before attributing a difference.

## Integration

Apply the final compressed tree to `9e60263fde` with a three-way merge.
Review all 17 files changed on both branches, including automatic merges,
and preserve upstream scenarios and corrected expectations. Save a separate
integration checkpoint before any new experiment, so integration and further
reduction have separate size and capability deltas.

Build and typecheck the workspace, run the full core suite with coverage,
and compare against main on the same Linux host. Recheck the applicability
of the frozen faults on both sides; report exclusions identically. Failures
already present on main are documented and reproduced separately. Review
helpers for input shape, optional fields, mock strictness and asynchronous
ordering, which counts and coverage alone cannot establish.

## Further experiments

Each experiment records a concrete hypothesis, target files, baseline,
behavior ownership, expected size reduction, and the checks used to retain
or reject it. Select independently bounded modules with existing historical
or mutation evidence first. Candidate mechanisms include:

- Combining equivalent input partitions while retaining their distinguishing
  conditions, negative boundaries and regression-specific expectations.
- Expressing related transitions as one scenario with checks at each state,
  removing repeated setup and teardown work.
- Replacing repeated internal interaction checks with a shared observable
  contract when that contract detects the same relevant failures.
- Consolidating overlapping checks across sibling test files, with explicit
  ownership of each behavior and no hidden transfer into uncounted fixtures.

Keep each accepted experiment in its own commit. Record rejected attempts
and their measurements too. The old mutation-guided deletion pilot lost a
historical fault when static mutants were excluded; mutation-guided removal
therefore needs operators and static mutations covering the behavior being
removed, plus semantic review of negative and future over-matching cases.

## Acceptance and reporting

For each accepted experiment, both test lines and bytes decrease. Historical
faults detected by the baseline remain detected, and baseline killed mutants
in the fixed relevant sample remain killed after accounting for confirmed
flakiness. Report coverage line and branch set differences, including noise
and any explained changes. Track localization and failure independence when
combining cases: a failure early in a scenario can hide later checks.

Build, typecheck, affected unit tests and formatting must pass. Report full
suite results separately from focused experiment results. Complete two
independent clean review passes over new work and resolved integration
changes. Publish measured outcomes and remaining uncertainty; the experiment
has no predetermined 50% success claim or promise of complete equivalence.

## Results

The integration checkpoint is `10a29740ae`, in six grouped commits. All
17 overlapping files were reviewed, including the seven conflict resolutions.

| Metric                                | Main `9e60263fde` | Integration `10a29740ae` |
| ------------------------------------- | ----------------: | -----------------------: |
| S1, core test lines including support |           673,272 |                  491,593 |
| S2, core test bytes including support |        23,538,737 |               17,806,901 |
| Executed suite cases plus pending     |            31,258 |                   31,277 |
| Passed cases                          |            31,247 |                   31,266 |
| Failed / pending                      |            1 / 10 |                   1 / 10 |

Both checkouts build. The integration workspace and integration-test typechecks,
and formatting/lint of all 424 changed files pass. The sole suite failure is
`dryRunGitWorktreePrune counts any link in the admin directory against the prune`,
reproduced separately on both sides. Each full suite has also been repeated
with the same command. Among the original 17 lost coverage lines, 16 show
same-revision variation. The remaining host-client callback is covered on both
sides when all seven calling test files run together (135 passing cases per
side, 245 covered lines retained); its full-suite difference depends on
asynchronous callback opportunities. No behavioral coverage loss was found.
Historical fault replay detects **92/103 eligible faults on both sides**,
with 11 existing misses and three frozen exclusions from the 106-item plan.
There are zero lost detections or health-run failures. Both derived reports
retain two mixed outcomes: `99fd76553e` has a collection error in
`tool-call.test.ts` and 18 actual new failures across four other files;
`3ba01990e1` has a collection error in `fireworks.test.ts` and one actual new
failure in `pipeline.test.ts`. Detection is based on the actual new failures.
New failed-case counts and failing-file sets match for every fault.
C4 is unchanged: one failing file and four failing cases at the median;
82/92 detected faults fail a same-basename sibling test (89.1%).

The legacy Config compression has 23 tables with 169 rows whose `%s`
formatter prints whole row objects. Native case names therefore change,
including 43 failed-case labels across two replayed faults. The C4 numbers
above measure file localization and counts; title readability remains a
limitation of those legacy tables.

Five groups containing platform-skipped cases needed a collector compatibility
correction. Both sides replayed the same five-item subset with the corrected
runner. The full original reports, subset plan, supplementary reports and
per-fault derivation are preserved with separate source and runner hashes.

The eight-module integration mutation comparison is complete. All **2,809**
mutant identities have the same status on both sides: 1,520 Killed,
483 Survived, 230 NoCoverage, 562 Ignored and 14 Timeout. Lost kills,
gained kills and status changes are all zero. Within the **2,003 common
Killed/Survived outcomes**, C2 is **75.88617%** on each side. This is a
conditional comparison of that population.

The strict full-sample comparator remains **`ok:false`** because of the
14 Timeouts. They are the same mutants with `Hit limit reached` outcomes
in the historical baseline, old compressed head, current main and integrated
checkpoint. The investigation attributes these outcomes to Stryker's
execution-count protection; it does not establish a wall-clock timeout.
Original statuses remain Timeout. Historical recurrence explains the limit
of the comparison; it does not convert the full sample into a passing gate.

The three further experiments are retained following capability comparisons
and independent review. Unit/assertion collection and formatting/lint pass.
Their measured reductions are:

| Mechanism                 | Test module             | Lines before → after | Bytes before → after | Cases before → after | Assertions before → after |
| ------------------------- | ----------------------- | -------------------: | -------------------: | -------------------: | ------------------------: |
| Complete output oracle    | memory import processor |            730 → 598 |      26,448 → 22,065 |              37 → 34 |                  123 → 77 |
| Lifecycle scenarios       | session hooks manager   |            384 → 320 |      11,485 → 10,588 |              41 → 26 |                   71 → 75 |
| Subsumed input partitions | hook planner            |            595 → 559 |      19,083 → 17,922 |              84 → 77 |                  100 → 93 |

The accepted commits are `7d1d527cc8` (memory), `cc003091b9` (session hooks)
and `598aa4e53e` (planner). Final core test size, including support, is
**491,361 lines and 17,800,460 bytes**. The experimental test source hashes
match the VM snapshot used for capability checks and timing runs.

Memory import and hook planner retain identical scoped line and branch coverage.
Session hooks retains all 182 covered lines and every comparable covered branch;
five V8 branch shapes change with the added multi-event iterations. The raw gate
keeps those shape changes visible. Each experiment has an explicit case mapping
in `scripts/test-loc/experiments`.

The targeted experiment C1 comparison is complete: the hook-alias fault
`e04f2ec5d4` and flat-memory depth fault `2554d1e186` are detected on both
sides. The escaped-whitespace fault `f7e48d5c4b` remains a frozen symmetric
ineligibility. The comparison is `ok:true`, with no lost detections, baseline
health failures or detection changes. For these two detected faults, C4 is
also unchanged: the median is two failing files and six failing cases, and
both fail a same-basename sibling test (2/2). These two faults exercise alias
matching and memory depth. They do not establish unchanged case-level
localization for the lifecycle consolidation: an early failure within a
scenario can still suppress its later diagnostic checks.

The four-module full/static/all-operator experiment C2 comparison is also
complete, with all source bytes, identities and configurations verified.
Of **822 mutants**, the baseline has 596 Killed, 153 Survived,
55 NoCoverage and 18 Timeout; the experiments have 598 Killed, 151 Survived,
55 NoCoverage and 18 Timeout. There are **zero lost kills and two gained
kills**, both previously Survived memory-import mutants; the other 820
statuses are unchanged. On the **749 common Killed/Survived outcomes**,
conditional C2 rises from **79.57276% to 79.83979%**.

The strict comparisons for session hooks (164 mutants) and hook planner
(113 mutants) are `ok:true`. Memory import and hook-matcher remain
`ok:false`: the same 18 Timeouts occur on both sides, with
14 in memory import and four in hook-matcher. Independent review explains
17 as disrupted loop progress. One memory-import StringLiteral mutation
changes `indexOf('@')` to `indexOf('')`; its `Hit limit reached` result is
unchanged, but its cause remains unlocated. The two gained kills concern
misplaced or lost repeated inline code and the blank line between flat-output
sections; the latter reflects a stricter formatting contract.

The decision is to retain all three changes: **no reduction in fault detection
was observed in the decidable portion of the existing samples**. The original
strict-gate limitations remain. The conditional rate does not establish a
full four-module C2 pass or general semantic equivalence.

### Suite timing and interruption

An environment interruption was recorded while the round-2 candidate run
was still active in the VM: the supervisor's UTC observation advanced from
2026-09-26 15:05 to 2026-09-27 00:19. **Before reading that run's result**,
the entire round-2 pair was excluded from T1/T2, with both raw runs retained.
The three selected pairs are rounds **1, 3 and 4**; round 4 repeats the
same commands as the original plan.

The interrupted candidate run subsequently reported **541.822 seconds**,
a `runtimeStatus.config` collection timeout with 14 fewer collected cases,
and an additional `shell-ast-parser-lazy` failure. This run did not pass and
is excluded from both valid performance measurements and healthy-suite
conclusions.

Round 3 remains selected. Main recorded **202.973 seconds**, 31,247 passed
cases and the known prune failure. The final candidate recorded
**212.660 seconds**, all 31,252 cases collected, 31,240 passed cases and
two failures: prune and `SessionWriterLease elects exactly one certified
replacement for a sealed session`, which expected one winner and observed
zero. This run is complete but did not pass. Its performance observation
does not establish a healthy-suite result, and the extra failure is not a
reason to silently remove the pair.

All eight raw runs are complete. The preselected pairs give these observations
in seconds; T2 is `llm-chat.test.ts` in every run:

| Pair   | Main T1 | Final T1 | Main T2 | Final T2 |
| ------ | ------: | -------: | ------: | -------: |
| 1      | 192.896 |  185.574 |  37.049 |   35.722 |
| 3      | 202.973 |  212.660 |  36.492 |   38.614 |
| 4      | 210.190 |  205.967 |  39.234 |   38.090 |
| Median | 202.973 |  205.967 |  37.049 |   38.090 |

T1's median increases **1.475%**. The observed ranges span 17.294 seconds
on main and 27.086 seconds on final, larger than the median difference.
Runtime observations are similar relative to this variation; these runs
provide no evidence of a speedup.

All three main runs have 31,247 passed cases plus the known prune failure.
Two final runs have 31,241 passed cases plus prune; round 3 has 31,240 passed
cases plus prune and lease failures. Final collection is complete in all three
selected runs at 31,252 cases, including ten pending cases. The strict timing
summary remains **`ok:false`**, with two round-3 health-validation errors.
These are complete timing observations, not a passing health gate.

The bounded lease diagnostic passed **3/3 on main and 3/3 with the integrated
tests**, with exactly one winner in each run. Production, test and helper
hashes were preserved, and temporary diagnostic copies were removed.
Independent source review found no semantic change in the helper extraction.
The final version passed this case in full-suite rounds 1 and 4 and failed
it in round 3. The cause remains undetermined; main did not reproduce the
failure, so this is not a confirmed pre-existing main flake. The one extra
failure and strict timing result remain recorded; the bounded investigation
is complete.

## Stage conclusion and validation limits

- **Integration:** the measured size reduction retains all observed C1
  detections and all 2,809 mutation statuses. The existing Git prune suite
  failure, 14 mutation Timeouts and legacy Config title readability remain
  explicit limitations. The strict full-sample C2 gate remains `ok:false`.
- **Further experiments:** the three retained changes save 232 lines and
  6,441 bytes in the selected modules. Targeted C1 and scoped coverage evidence are
  recorded. The 822-mutant sample has no lost kills and two gains, with
  18 matching Timeouts still visible, one with an unlocated cause.
  Their savings are separate from the integration checkpoint and do not
  predict whole-core savings.

Comparator v4 (`bb78d117f4`) rejects modern fault reports that omit
health-failure accounting; its 13 report regressions pass. Recomparison of
the original C1 report bytes is `ok:true` for both pairs: integration retains
103 eligible faults and three exclusions, and the experiments retain two
eligible faults and one exclusion, with zero lost detections in either pair.
No injected fault rerun was needed.

This integration and experiment stage is complete. All three reduction
mechanisms are retained under the stated sample limits. T1 observations are
similar within the measured variation and provide no speedup claim; strict
mutation and timing limitations remain visible. The round-5 evidence inventory
records the reports, interruption decision, excluded raw pair, investigations
and timing data. The result is ready for review on `codex/core-test-size-next`;
main remains unchanged at `9e60263fde`.
