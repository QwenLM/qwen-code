# Core test size: exploring explicit loss budgets

[English](2026-09-27-core-test-size-relaxed-budget.md) | [简体中文](2026-09-27-core-test-size-relaxed-budget.zh-CN.md)

Status: size, suite and coverage measurements completed for four candidates;
candidates retained for evaluation, 2026-09-27.

## Conclusion and scope

This round produced a concrete **45,167-line (9.21%)** removal candidate:
core tests fall from 490,301 to 445,134 lines and from 17,763,494 to 16,149,972
bytes. Support code, fixtures and snapshots remain in the existing accounting.
184 test files were physically removed; all 628 remaining files ran, with no
new failures and the existing prune failure retained.

The candidate loses 1,024 previously covered lines, or **0.3982 percentage
points** of the fixed baseline instrumented-line denominator. All 95 detected
historical faults retain recorded observers in the historical graph; 3 of
3,267 matched Killed mutants lose all recorded observers. Those are training
graph predictions. This round did not rerun C1 or C2 and does not establish
actual detection preservation.

This supports a next-stage target of about 45,000 lines. The 100k and 150k
points show substantially larger coverage costs. The working branch adds
reports and evidence; deletions exist in isolated VM checkouts, with patches
available for module-by-module evaluation.

## Why change the method

Round 6 rewrote three small scopes while preserving observed detections,
saving 1,060 lines. The original design allowed a one-percentage-point mutation
score drop; later execution tightened preservation of existing kills. This
round permits deliberately retiring lower-priority tests and measures the cost.

Build attribution per test file, then rank whole-file deletions by marginal
covered-line loss per removed test line. A semantic screen protects 375 files
covering permissions, secrets, destructive actions or durable-write isolation.
Ordinary protocol, presentation, compatibility and lifecycle files can enter
exploration. The screen still requires review of the actual deletion before
adoption.

## Baseline and attribution

Frozen baseline: `a270907e5f3fd6ebe26ef7d17ea7da3e92c2773a`.
Linux arm64, Node 22.23.2, Vitest 3.2.7, four workers, no retries.

- 812 test files and 31,175 cases: 31,164 passed, one prune failure, ten pending.
- The existing V8 configuration covers 870 source files, 257,159 instrumented
  lines and 233,104 covered lines.
- Baseline line coverage is 90.645865%. Existing included test helpers remain
  part of this coverage denominator.
- 812 singleton file captures had zero collection errors. Their covered-line
  union exactly matches native coverage, with zero missing or extra lines.

The baseline keeps native V8 collection and additionally records file
attribution, converted offline. Candidate runs use the native V8 provider.
Configuration, source identity, actual file inventories and result hashes are
preserved. Different collection overhead and one run per point prevent a
speedup claim.

## Initial coverage-only curve

Three nested deletion sets were frozen before historical capability scoring;
the historical graph did not guide their selection.

| Actual removed lines | Baseline share | Actual lost covered lines | Loss as percentage points of fixed instrumented lines | Historical faults losing all observers / 95 | Killed mutants losing all observers / 3,267 |
| -------------------: | -------------: | ------------------------: | ----------------------------------------------------: | ------------------------------------------: | ------------------------------------------: |
|               50,141 |         10.23% |                     1,177 |                                                0.4577 |                                           6 |                                         143 |
|              100,052 |         20.41% |                     7,996 |                                                3.1094 |                                          10 |                                         284 |
|              151,213 |         30.84% |                    27,075 |                                               10.5285 |                                          19 |                                         637 |

The first four columns are actual size/coverage measurements; the last two
are historical observer predictions. Attribution predicted 1,175, 7,994 and
27,242 lost lines. Actual runs also gained 2, 1 and 2 lines. Differences remain
in raw reports, without automatically dismissing them as noise or offsetting
losses with gains.

At 150k, all 700 formerly covered Responses pipeline lines disappear. OpenAI
converter loses 818/1,640 lines and LSP server manager loses 660/965. This point
exceeds a small relaxation.

## Candidate after restoring high-contribution files

Restore seven files totaling 4,974 lines from the 50,141-line set, leaving
45,167 lines removed. Restoring modalityDefaults, cronParser,
TeamManager.ghost-member and tokenLimits restores matched observers for the
six exposed historical faults. Restoring Mistral, default provider and
workflow-runner reduces Killed mutants without observers from 143 to three.
The hookSystem file associated with 17 unknown-only Killed observations remains.

This selection is fitted to the same historical graph. The mutation graph covers only
**19 production modules**, with sampling, early-bail and static-mutation scope
differences. Its 51 Timeouts and 17 unknown Killed observations remain separate;
these results cannot establish package-wide detection preservation.

The three remaining records are two MiMo provider-selection mutations and one
shell comment-trimming mutation. The shell report used early bail and may omit
other killers. These records are neither three demonstrated real bugs nor
three established actual detection losses.

| Candidate                | Executed files | Passed / failed / pending | Actual lost lines | New failures |
| ------------------------ | -------------: | ------------------------- | ----------------: | -----------: |
| Coverage 50k             |            621 | 27,639 / 3 / 3            |             1,177 |            2 |
| Coverage 100k            |            514 | 24,353 / 1 / 3            |             7,996 |            0 |
| Coverage 150k            |            413 | 21,310 / 1 / 3            |            27,075 |            0 |
| Observer-constrained 45k |            628 | 27,985 / 1 / 3            |             1,024 |            0 |

The two new 50k failures occur in unchanged extensionManager tests about
external marketplace commit records and GitHub release update markers. Their
first error line is `STACK_TRACE_ERROR`. Their cause is unresolved and the raw
failures remain. The prune failure keeps every raw health result false.
Removed cases and pending cases match frozen file deletions; retained files
preserve their case-identity multisets.

The 45k point still has local costs: microcompact loses 74/662 formerly covered
lines, memoryDiscovery 63/428 and fileReadCache 34/164. The package average
cannot replace judgment about these behavior boundaries.

## Branch and verification limitations

At 45k, the orientation-only branch percentage changes from 88.5646% to
87.8255%. Its denominator changes from 80,146 to 79,100, so this is not a loss
rate over fixed branch identities. Exact location matching finds 517 lost
covered slots; 1,018 branch-shape changes and 16 changed duplicate-location
groups are preserved separately.

Native V8 can assign multiple branch IDs identical locations. Matching by
line, count or reordered ID would be unsound. The comparator first gained
location matching, then separate duplicate-location ambiguity handling. Old
errors, the failed first comparison and original tools are retained. The first
health summary rejected the authorized capture command; after correction it
reread the same reports without rerunning suites.

The old baseline runner omitted ignored capture config/provider files from
its execution-period snapshot. Their pre-run recorded hashes match current
bytes, but that snapshot limitation remains explicit. The later runner includes
tool hashes. Measured test/product sources stayed unchanged during every run.

## Proposed relaxation and next decision

- C4: allow case deletion, fewer assertions and fewer independent failure
  labels, recording the diagnostic cost.
- C3: initially screen with **0.5 percentage points** of lost lines using a
  fixed denominator. Review branch changes and local coverage gaps by module.
- C2: in fresh measurements, allow at most **1%** loss of previously Killed
  mutants in the fixed sample. Gains cannot offset losses; Timeout stays
  unresolved. This differs from a one-percentage-point mutation-score drop;
  the training constraint here uses the former denominator.
- C1 and hard boundaries: retain real historical-fault detection and security,
  permission and data-integrity checks.

Use the 45k candidate for the next stage. Review local gaps and restore needed
boundaries as small case groups, then freeze faults and stratified mutation
samples independent of the selection graph. Expand measurement for risky
modules. Adopt bounded batches after independent capability validation, allowing
changes to case names, assertion counts and ordinary coverage rather than
requiring their universal preservation.

## Evidence

[Results, candidate inventories and raw archive](../../scripts/test-loc/evidence/round7/README.md).
Native coverage, suite JSON, logs, four deletion patches, attribution/training
graphs, selectors, tool corrections and member hashes are archived together.
The working branch retains reports and indexes; experimental deletions are not
merged.
