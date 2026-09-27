# Round 7 evidence

This round explores whole-file test removal from baseline
`a270907e5f3fd6ebe26ef7d17ea7da3e92c2773a`. The branch records experiments;
test deletions exist in isolated VM checkouts and archived patches.

Read the [English report](../../../../docs/design/2026-09-27-core-test-size-relaxed-budget.md)
or [Chinese report](../../../../docs/design/2026-09-27-core-test-size-relaxed-budget.zh-CN.md)
for the method, local coverage costs and proposed next decision.

## Results and limits

| Candidate                  | Removed lines | Remaining lines | Lost covered lines | Loss in percentage points |
| -------------------------- | ------------: | --------------: | -----------------: | ------------------------: |
| Historical-observer budget |        45,167 |         445,134 |              1,024 |                    0.3982 |
| Coverage 50k               |        50,141 |         440,160 |              1,177 |                    0.4577 |
| Coverage 100k              |       100,052 |         390,249 |              7,996 |                    3.1094 |
| Coverage 150k              |       151,213 |         339,088 |             27,075 |                   10.5285 |

Loss uses the fixed baseline denominator of 257,159 instrumented lines;
newly covered lines do not offset losses. Existing included test helpers stay
in scope. The 45k candidate removes 184 files and 1,613,522 bytes; all 628
retained files ran, with 27,985 passed cases, one existing prune failure and
three pending cases. The 50k run has two additional unresolved extension
failures. Every raw suite health result remains false.

The 45k candidate retains recorded observers for 95 historical detected faults.
Three of 3,267 matched Killed mutants lose all recorded observers. These are
predictions from the same historical graph used to select this candidate.
C1/C2 were not replayed. The mutation graph covers 19 production modules;
17 Killed records with unknown current transfer and 51 Timeouts remain separate.
Fresh independent capability checks are required before adopting deletions.

Branch identities, changed shapes and duplicate-location ambiguity are reported
separately. There is no A/A noise estimate or runtime-speedup claim. The old
baseline runner omitted capture tools from execution-period snapshots;
pre-recorded and current hashes match, with that limitation retained.

## Tracked and raw artifacts

- `results.json`: measured size, suite and coverage results, historical
  predictions, evidence hashes and limitations.
- `tier-*.json.gz`: exact frozen deletion inventories, compressed with a fixed
  timestamp; `manifest.json` records compressed and original SHA-256 values.
- `manifest.json`: archive/index identities, candidate patches and key inputs.

Transfer the ignored `.qwen/testloc-evidence/round7-raw.tar.gz` and
`.qwen/testloc-evidence/round7-files.json` with this tracked evidence.
The archive contains 2,612 source files plus `raw-files.json`, the complete
member index. `local/` resolves paths relative to `.qwen/test-loc-round7/`;
`vm/` resolves paths relative to `/tmp/qwen-testloc-round7/`.
The index records each original path, archive member, size and SHA-256.
Collection completeness describes stable copied bytes, independently of
suite health or capability outcomes.

Primary reports are under `vm/full-baseline/` and `vm/run-<target>/`, including
commands, execution snapshots, logs, suite JSON and native coverage JSON/LCOV.
`vm/coverage-<target>.json`, `vm/health-frontier-v2.json` and
`vm/health-budget.json` summarize the same reports. Raw per-file attribution,
historical graphs, protection manifests, selectors and summary tools are
included. The first failed comparison, original health summary, smoke runs
and superseded tool versions remain archived without outcome filtering.

Dependency/build trees, repository checkouts and coverage HTML are excluded.
Pinned repository dependencies and the earlier `round5-raw.tar.gz` and
`round6-raw.tar.gz` are separate reconstruction inputs. Historical references
to those archives remain in the original reports; collection does not traverse
them. The manifest identifies the actual baseline capture tools explicitly.

## Reconstruct a candidate

Run from a repository containing prerequisite commit
`37412a57d473525a81f87e4ca36447981950d9a9`, with an unused destination:

```sh
testloc_unpack=$(mktemp -d)
tar -xzf .qwen/testloc-evidence/round7-raw.tar.gz -C "$testloc_unpack"
git bundle verify "$testloc_unpack/local/baseline.bundle"
git fetch "$testloc_unpack/local/baseline.bundle" HEAD
git worktree add --detach /tmp/qwen-testloc-round7-replay \
  a270907e5f3fd6ebe26ef7d17ea7da3e92c2773a
git -C /tmp/qwen-testloc-round7-replay apply --check \
  "$testloc_unpack/vm/tier-45000.patch"
git -C /tmp/qwen-testloc-round7-replay apply \
  "$testloc_unpack/vm/tier-45000.patch"
```

The other three patches also apply directly to this baseline. Install pinned
dependencies and build in the isolated checkout before rerunning package tests.
Archived commands preserve the original environment and paths; resolve them
through the member index when replaying elsewhere. Reuse the frozen inventory
to check deleted files, retained case identities and pending cases.

This report-only round reused built dependencies for unchanged production
sources. It records full core suite and coverage runs, with no new build or
typecheck claim and no adopted test removal.
