# Core test size reduction

[English](core-test-size-reduction.md) | [简体中文](core-test-size-reduction.zh-CN.md)

Status: implemented and measured on the experiment branch, 2026-09-27.
The [experiment and results report](core-test-size-reduction-results.md)
contains the measured comparisons and evidence entry points.

## Background and objective

Core's frozen main snapshot contains 673,272 test lines for 400,027 production
lines. Repeated setup, verbose expectations and overlapping scenarios make
tests expensive to read and maintain. The task reduces this maintained code
while measuring the regression detection and diagnostic information lost.

The original cross-package ambition was a 50% combined reduction, with at
least 40% per package. This task focuses on Core and achieves **223,587 fewer
lines, or 33.21%**, against the fixed main snapshot. Acceptance follows declared
capability budgets; the original ambition does not override them. Runtime
improvement is measured separately from source size.

## Scope and baselines

The implementation changes tests, helpers, fixtures and snapshots within
`packages/core`, with measurement tools and evidence under `scripts/test-loc`.
Core production behavior remains unchanged. Other packages, integration tests,
production refactoring and a future test-growth policy are outside this task.

| Comparison identity           | Revision                                   | Core test lines |
| ----------------------------- | ------------------------------------------ | --------------: |
| Overall baseline: frozen main | `9e60263fdeff8cb5bf5fc49287a2d20cef0dbe2e` |         673,272 |
| Final deletion-stage baseline | `a270907e5f3fd6ebe26ef7d17ea7da3e92c2773a` |         490,301 |
| Measured final test code      | `460151af0c6ec2a19d7a4d736aadda023a696527` |         449,685 |

Every experiment names its own baseline, candidate and scope. Overall size
uses main versus final. The last stage's coverage and mutation measurements
use `a270907e5f` versus final; they describe that stage's incremental change.

## Reduction methods

Apply the cheapest suitable method to a coherent behavior domain, keeping
input distinctions and observable expectations explicit.

| Method                           | Application                                                                                                            | Review requirement                                                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Shared setup and fixtures        | Small factories for repeated requests, configuration, responses and mock setup                                         | Preserve omitted keys, ordering, async behavior and fresh state per case; count helper and fixture size                    |
| Parameterized scenarios          | Tables and sequence helpers for scenarios with the same structure                                                      | Keep each row's input, expected output and useful label; preserve differing preconditions and assertions                   |
| Complete output expectations     | Handwritten complete results replace test-side parsing and scattered partial assertions                                | Expected values must be independent of the implementation; check preservation as well as transformation                    |
| Behavioral contracts             | One coherent object or lifecycle checks several related outcomes; shared wire assertions check actual request behavior | Retain event delegation, caller wiring, option propagation, errors and interaction boundaries                              |
| Budgeted redundant-test deletion | Use observed coverage and fault/mutant observers to find overlapping files or cases, then measure the reduced suite    | Treat observer graphs as selection evidence; preserve critical negative cases and validate actual detection after deletion |

Shared helpers stay small and describe a recognizable test operation. A
generic scenario language can hide the contract and increase maintenance cost.
Consolidated cases also lose independent failure labels: an early failed
assertion can prevent later checks from executing. These costs enter review
alongside the line savings.

## Metrics and counting

### Size

- **S1:** physical lines in every test-classified file, with the repository's
  formatting configuration held fixed. This is the primary reduction measure.
- **S2:** bytes in the same files. Report it beside S1 to expose reductions
  caused only by joining lines or changing formatting.
- Auxiliary observations: runnable files, source case-call estimates, actual
  executed cases, executed assertions and S1/production-LOC ratio. Static
  `.each` call counts and expanded runtime case counts have different meanings.

The classifier includes `.test.`, `.spec.`, `__tests__`, `__mocks__`,
`__fixtures__`, `fixtures`, `test-utils`, `testUtils` and `.snap` paths,
including non-code fixtures. The current counter includes tracked and
non-ignored untracked files, excluding `dist`, `build`, `out`, `coverage`,
`node_modules` and `vendor`. Moving text into a helper, fixture or snapshot
within this scope still counts. Cross-package relocation cannot count as a
reduction without adding the destination to the measured scope.

### Capability

| Metric                    | Definition and interpretation                                                                                                                                                                                                           |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C1: historical faults** | Reverse only production hunks from a frozen historical-fix corpus. Detection requires new executed assertion failures relative to the matching healthy run. Compare retained detections by fault identity.                              |
| **C2: mutations**         | Compare identical mutants on identical production source using a frozen expected inventory. Report every old `Killed` outcome retained, lost or unknown, plus gains and other statuses. A score alone can hide losses.                  |
| **C3: coverage sets**     | Compare formerly covered line and branch identities against the candidate. Report lost and gained sets separately, using a fixed baseline denominator for a loss budget. Branch-shape changes and unmatched identities remain separate. |
| **C4: diagnosis**         | Use C1's failing-file and failing-case counts, labels and sibling-test localization to expose the diagnostic cost of consolidation. Review whether one assertion failure masks another behavior.                                        |

`Timeout`, collection errors and missing results remain visible and
inconclusive where applicable. A mutation gain cannot cancel an old kill
lost. Coverage and structural duplication suggest candidates; their agreement
alone does not establish equal regression detection.

### Suite health and execution cost

Record actual test inventories, pass/fail/pending counts, collection errors,
unhandled errors and process exits. Compare against the baseline and identify
new failures separately from existing ones. Build, typecheck and focused tests
verify the retained changes.

T1 is full-suite wall time at fixed workers; T2 records the slowest file or an
explicitly fixed file. A performance claim requires repeated paired runs,
reported spread and a quiet shared environment. Final adoption makes no speedup
claim. Long-term retry rates, test growth and review effort remain follow-up
measurements rather than completed acceptance gates.

## Experiment protocol

1. **Freeze the comparison.** Record revisions, production/runtime fingerprints,
   formatter, lockfiles, tool versions, test inventories and candidate hashes.
   State the hypothesis, behavior mapping and acceptance budget before deciding
   whether to retain a candidate.
2. **Prepare comparable checkouts.** Build separate baseline and candidate
   checkouts on the same Linux VM with the same runtime and bounded workers.
   Shared helper changes require complete independent checkouts. Run package
   tests from `packages/core`.
3. **Screen and review.** Measure S1/S2 and focused test health/coverage. Review
   removed input partitions, mocks, expected results, ordering, state isolation
   and security, permission and data-integrity boundaries.
4. **Measure capability.** Freeze C1 patches and directed test scopes before
   replay. Run each group without a fault first. For deletions, record the
   original scope and retained intersection. Freeze C2 source, mutant inventory,
   operators, static scope and requested/observed tests before comparison.
   Include dependencies that implement the relevant behavior.
5. **Validate the candidate.** Compare full native suite health and coverage,
   build/typecheck/lint results and the source hashes after execution. Run final
   whole-suite comparisons after competing capability workloads stop. Review
   local losses alongside aggregate metrics.
6. **Archive and decide.** Preserve plans, commands, configurations, raw reports,
   failed attempts, mappings and exact candidate bytes with hashes. Publish
   summaries separately from raw evidence. Audit the accepted diff and record
   the commit carrying the measured test code.

Inapplicable patches are excluded symmetrically in the frozen plan. A known
environment failure may be excluded from directed replay by its exact full
test name with supporting evidence; native suite reports retain it. Collection
errors alone cannot detect a historical fault. A reused observation requires
identical executed scope and relevant source/test hashes, with its origin
identified. Repaired candidates are fitted to observed faults or mutants;
subsequent passes on those samples validate the repair.

## Acceptance policy

### Conservative compression and contract consolidation

Mechanical compression initially preserves names and per-case assertions,
with duplicate removal logged explicitly. Intentional contract consolidation
allows changed cases and assertions when the behavior mapping is reviewed.
Both S1 and S2 must fall. Observed historical detections and decidable old
mutation kills must be retained in the measured scope. Coverage differences
require evidence and explanation. Unknown outcomes and unsuccessful strict
comparators remain recorded beside any qualified adoption decision.

### Final budgeted deletion

- C1: retain observed historical-fault detection and review security,
  permission and data-integrity checks explicitly.
- C2: lose at most **1%** of baseline `Killed` mutants in the declared aggregate
  sample; report modules separately. Gains do not offset losses. Unknown old
  `Killed` outcomes cannot pass the budget.
- C3: lose at most **0.5 percentage points**, calculated as
  `100 × lost formerly covered lines / baseline instrumented lines`.
  New coverage does not offset loss. Inspect concentrated local losses.
- C4: allow fewer cases, assertions and independent labels; disclose the
  reduced diagnostic detail and retain meaningful failure explanations.
- Keep production unchanged and investigate new test failures. Final source
  must pass build, typecheck, lint and focused verification, with native suite
  differences assessed against the frozen baseline.

These budgets supersede preservation of every case and assertion for the
final stage. A failed sample leads to repair or a smaller candidate. A passing
sample supports its declared scope; expanding to another domain requires a
new comparison and any additional behavioral evidence that domain needs.

## Final state and limits

Against frozen main, S1 is **673,272 → 449,685** and S2 is
**23,538,737 → 16,307,779 bytes**. Production LOC stays **400,027**, and the
core diff changes only test-classified paths. The result is implemented on the
experiment branch; the [results report](core-test-size-reduction-results.md)
records the stage-specific validation and reproduction entry points.

The final deletion stage loses **0.3041 percentage points** of previously
covered lines and retains **385/385** old `Killed` mutants in its four measured
modules. Those values compare against `a270907e5f`. Capability was measured in
stages; a fresh main-to-final capability comparison was not performed.

The samples cover only part of core. Repaired fault samples are fitted
validation, mutation timeouts limit strict comparisons, and Linux arm64 plus
skipped platform/live-model cases bound execution coverage. Some local coverage
losses are materially larger than the package average. Consolidation and
deletion reduce diagnostic detail, ordinary edge-case checks, recall-quality
evaluation and scan-latency evaluation. These are recorded costs of the adopted
result. The measured 33.21% is an achieved reduction, with no established
maximum and no whole-package equivalence or runtime speedup claim.
