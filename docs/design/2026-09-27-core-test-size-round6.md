# Core test size: larger behavioral experiments

[English](2026-09-27-core-test-size-round6.md) | [简体中文](2026-09-27-core-test-size-round6.zh-CN.md)

Status: retained with the recorded limitations, 2026-09-27.

## Baseline and objective

Freeze `37412a57d473525a81f87e4ca36447981950d9a9` as the baseline:
491,361 core test lines and 17,800,460 bytes, including test support.
The user authorizes more aggressive experiments in test design, including
removing redundant cases and reassigning overlapping coverage. Product code
remains unchanged. Main stays separate from the experimental branch.

The previous three-file pilot saved 232 lines. This round seeks repeatable
module-level savings across several independent behavioral domains. The
within-file text-duplication metric is already 0.4%; candidate selection must
consider behavioral overlap and the cost of the test oracle, not just text.

## Candidate mechanisms

- Replace test-side parsing and scattered partial checks with explicit complete
  expected outputs, while retaining input partitions and failure cases.
- Exercise a coherent object or lifecycle once and check its complete result,
  replacing multiple cases that each inspect a small part of the same behavior.
- Assign overlapping behavior to the layer that actually implements it; retain
  caller wiring, option propagation, error handling and interaction boundaries.
- Remove duplicate positive examples after identifying the retained contract
  and the negative cases that distinguish incorrect implementations.

Start with three to five bounded domains. Estimated savings are selection aids,
not acceptance criteria. Moving lines into fixtures or snapshots counts toward
the same size budget. Expected outputs must be independent of the implementation.

## Execution and evidence

Record each hypothesis and its original-to-retained behavior mapping before
acceptance. Use independently built Linux checkouts at the same implementation
revision. Preserve the baseline, candidate bytes, commands, tool versions and
raw reports. Existing round-5 evidence remains unchanged.

First run affected tests and compare size and line/branch coverage. Candidates
with useful savings then undergo relevant historical fault replay and complete
static mutation of the bounded implementation and necessary dependencies. A
historical corpus that does not exercise the target behavior is an explicit gap;
supplement it with independently specified fault probes when needed, labeling
these separately from real historical defects. Freeze faults before comparing.

Use existing measurement tooling. Keep requested and executed test inventories,
health failures, collection failures and mutation Timeout outcomes visible.
Check diagnosis and case independence: one early assertion can mask later checks.
Coverage and mutation agreement support a bounded conclusion, not universal
equivalence. Retain critical negative cases through semantic review as well.

## Acceptance and stopping

Retain a candidate when both lines and bytes decrease, affected tests/build/
typecheck pass, observed historical detections and decidable mutation kills are
preserved, and coverage differences have an evidenced explanation. A failed or
incomplete raw gate stays failed; any qualified decision is recorded separately.
Record rejected approaches and their reasons. Stop expanding a mechanism when
its savings are small or its diagnostic and boundary costs outweigh them.

Commit accepted domains independently. At the batch boundary run the full core
suite, compare against the frozen baseline and audit the complete changes twice.
The previously observed prune failure, paired Timeouts and unexplained lease
failure remain recorded. A new failure requires investigation. This work does
not assume a speedup or extrapolate a pilot percentage to the whole package.

## Results

### Size and test design

| Domain                 | Baseline lines | Candidate lines |     Reduction | Mechanism                                                          |
| ---------------------- | -------------: | --------------: | ------------: | ------------------------------------------------------------------ |
| Schema validator       |          1,735 |           1,448 |   287 (16.5%) | Whole-object coercion and traversal contracts                      |
| Hook system            |          1,349 |             818 |   531 (39.4%) | Explicit per-event delegation matrix and retained output semantics |
| Provider wire behavior |            683 |             441 |   242 (35.4%) | Shared direct-request and real HTTP lifecycle assertions           |
| Total                  |          3,767 |           2,707 | 1,060 (28.1%) | New helper included                                                |

The three domains decrease from 127,163 to 90,197 bytes: **36,966 bytes saved**.
Core totals become **491,361 → 490,301 lines** and
**17,800,460 → 17,763,494 bytes**, including support code. The three initial
candidate source versions stayed unchanged throughout capability measurement;
production code stayed unchanged. The 28.1% reduction applies to these selected
domains, not the whole package.

Schema tests combine distinct fields into handwritten complete expected
objects. Dangerous-key, reference, recursion-limit and cache protection cases
remain independent. Some accepted-value checks now share an object with an
invalid sibling, forcing the coercion passes before checking preservation.

Hook tests explicitly specify each method's event, output class, full argument
list and omitted-argument defaults. A call-through spy observes the real output
factory; expected outputs and accessor results are independently written.
Selected branchless enum/string examples are removed, including explicit
`false` for `PostToolUseFailure.isInterrupt`, while retaining `true` and omitted.
The mapping records those deliberate input reductions.

Provider tests retain all 16 names and original inputs. The counted helper
compares literal complete outbound messages and preserves source requests.
Two cases retain real two-turn HTTP conversations; server setup and teardown
now fall within the case timeout. The existing Fireworks title mentions tool
calls, but its unchanged fixture exercises thought/text replay only.

### Targeted tests and C3 coverage

| Domain    | Passed cases, before → after | Executed assertions | Coverage result                           |
| --------- | ---------------------------: | ------------------: | ----------------------------------------- |
| Schema    |                     142 → 96 |           326 → 242 | 894 covered lines unchanged; strict false |
| Hooks     |                      95 → 64 |           147 → 223 | 649 → 683 covered lines; strict false     |
| Providers |                      16 → 16 |             29 → 34 | Six-module comparison passes              |

Schema has no lost covered lines or matched branches. Of six branch-shape
changes, the accepted-string `continue` at production line 1011 is genuinely
newly covered; the other five have specific loop-count or preceding-continue
explanations. They are not all noise. Hooks have no lost lines or matched
branches: all 15 shape changes add a record, with nine positive counts and six
zero counts as new accessors/paths become visible. Both original strict
coverage failures remain unchanged.

The first Hook gate failed on quoted `describe.each` names in its mapping.
Names were corrected against the same completed raw test reports; the corrected
test comparison passes. The first gate error and its original reports remain.
This correction did not change test source or rerun the capture.

### C1 historical faults and C4 diagnosis

The frozen plan contains nine historical faults. Three applicable faults are
detected on both sides; six reverse patches do not apply to the frozen
implementation and remain excluded. Healthy runs for the applicable faults
pass on both sides. The comparator reports complete sampling, no lost
detections and no baseline health failures.

| Applicable historical fault                 | Failed test cases, before → after | Detection evidence                                          |
| ------------------------------------------- | --------------------------------: | ----------------------------------------------------------- |
| `1103a95f2b`, non-string parameter coercion |                           50 → 31 | Assertion failures in schema tests                          |
| `6a5c041885`, unknown-format warnings       |                             1 → 1 | The retained custom-format warning assertion                |
| `3ba01990e1`, Fireworks reasoning mirror    |                             1 → 1 | The native-history assertion in the unchanged pipeline test |

The Fireworks reverse patch also removes the provider module, causing one
collection error in `fireworks.test.ts` on each side. Detection relies on the
separate pipeline assertion; this replay does not show that the six compressed
Fireworks cases detect that fault. There is no direct Hook historical fault
in this corpus.

The schema fault exposes a concrete diagnosis cost: **19 independent failure
labels disappear**. Twenty-five failures retain their names, four merged groups
reduce 23 failures to four, and two cases are renamed one-to-one. Every old
failure has a mapped, actually failing successor. The six renamed/merged cases
fail at the initial `valid()` assertion, so their subsequent whole-object
checks do not execute; the first integer/name/enabled error masks later fields.
File localization stays the same, but the overall median of one failed case
per fault hides this local loss of granularity. Preserved detection does not
establish unchanged diagnosis or independent detection of every merged field.

### C2 complete static mutation

| Domain                         | Mutants | Lost kills | Gained kills | Paired Timeout | Strict result |
| ------------------------------ | ------: | ---------: | -----------: | -------------: | ------------- |
| Schema validator               |   1,369 |          0 |            4 |             19 | False         |
| Hook system and output types   |     467 |          0 |           39 |              0 | True          |
| Provider behavior, six modules |     327 |          0 |            0 |              0 | True          |
| Total                          |   2,163 |          0 |           43 |             19 | False         |

All requested test inventories are present, source identities match, and no
mutation collection error is reported. The 19 paired schema Timeouts remain
inconclusive. Gains comprise 28 Survived → Killed and 15 NoCoverage → Killed;
eight additional Hook NoCoverage → Survived changes remain Survived.

The four schema gains are assertion failures with resolved killing-case IDs:
JSON parsing through composed references now checks root-schema preservation;
JSON-looking strings and numeric-looking strings accepted by their schemas
must remain strings while invalid siblings trigger coercion. These are new
checks exposed by the complete-object arrangement.

Hook gains include omitted defaults, specialized output selection and literal
accessor results. Nine gains check event labels that currently select
`DefaultHookOutput` even if the label becomes empty. Those nine strengthen the
call contract; they are not nine demonstrated user-visible defects. Provider
mutation statuses are identical across all 327 samples.

### Qualified retention assessment and evidence

The three candidates are retained after the verification below. Each reduces lines and bytes,
preserves observed applicable fault detection and decidable mutation kills,
and has a source-based explanation for coverage differences. The remaining
strict failures and measured diagnosis cost stay part of that assessment.

Behavior mappings were frozen for measurement. Their pending validation
status fields preserve the pre-measurement state; final outcomes belong in this report
and the round-6 evidence archive. The Hook expanded-name correction is recorded
separately. Original gates, fault reports, mutation reports, analysis files and
source hashes are retained rather than overwritten by a qualified decision.

### Batch verification and commits

Formatting, lint, root build and typecheck pass. Both complete core runs execute
all 812 expected files. Baseline has 31,241 passed, one failed and ten pending
cases; candidate has 31,164 passed, the same one failed and ten pending cases.
The 77-case reduction exactly matches the targeted inventories: 145 names are
replaced by 68, with no name changes elsewhere. There are no missing files,
new failures, unhandled errors, collection errors or snapshot failures.

Both runs retain the known `dryRunGitWorktreePrune` failure with the same
assertion signature, so raw full-suite health remains false. The previously
observed lease failure does not recur in this pair; the earlier observation
remains unresolved in round-5 evidence. Durations are 200.36 and 204.38 seconds
for this one pair; they do not establish a speedup.

Two final source/evidence review passes found no concrete source defect.
Independent coverage, mutation-gain, historical-diagnosis and packaging reviews
are preserved. The helper follows existing core test-utils compilation, and
is outside the normal CLI production dependency graph.

Accepted domains are committed separately: schema `58f407c906`, hooks
`ac99ffd917`, providers `cdafe6b390`. Their six source hashes match measured
snapshot `f678cfa38173b4195fb88087b213343b4e916d50`. The full reports, frozen
plans and reconstructable snapshot are indexed in
[round-6 evidence](../../scripts/test-loc/evidence/round6/README.md).
Main remains at `9e60263fdeff8cb5bf5fc49287a2d20cef0dbe2e`.

### What to carry forward

The measured mechanisms are complete contracts that exercise preservation
alongside transformation, explicit event-boundary contracts, and shared wire
lifecycle oracles with counted support code. This round demonstrates substantial
local reduction across independent domains; total core reduction is 1,060 lines
and does not establish a runtime improvement.

A bounded follow-up scan of client, LLM chat and scheduler tests found no
additional well-supported experiment promising at least 500 lines. The clearest
scheduler terminal-state overlap is estimated at 100–180 lines, still untested.
