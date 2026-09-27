# Round 6 evidence

This batch freezes baseline `37412a57d473525a81f87e4ca36447981950d9a9`
and measures candidate snapshot `f678cfa38173b4195fb88087b213343b4e916d50`.
Only six test/support files differ. The final branch uses separate commits for
the three domains; `results.json` identifies the exact measured file bytes.

`results.json` contains the compact observations and the qualified retention
decision. `manifest.json` identifies the raw archive, its complete member index,
compressed plans and remaining reference limitations. Mapping files under
`../../experiments/round6-*.json` retain their measurement-time validation state;
read this round's results for final outcomes.

The ignored `.qwen/testloc-evidence/round6-raw.tar.gz` must accompany the tracked
evidence when transferring this work. It preserves both sides' full reports,
independently frozen expected mutants, commands, configs, logs, source snapshots,
failed attempts, analyses and the collector/summary scripts. `raw-files.json`
inside the archive maps original paths to members and records SHA-256 for every
file. `collectionComplete` describes stable collection of the selected bytes;
it does not change any capability or health result.

## Scope and limitations

- Core tests decrease by 1,060 lines and 36,966 bytes, including the new helper.
  The three selected domains decrease 28.1%; the whole package decreases 0.22%.
- C1 retains all three eligible detections among nine planned historical faults.
  Six reverse patches are ineligible. There is no direct HookSystem historical
  fault. Fireworks retains a collection error on both sides; its actual failure
  comes from the unchanged pipeline test.
- C2 compares all 2,163 frozen identities across nine complete modules, including
  static mutants and all operators: no lost kills and 43 gains. All requested
  tests are present. Schema's 19 paired Timeouts remain inconclusive and its
  strict result remains false; HookSystem and provider comparisons pass.
- Coverage has no lost lines or matched branches. Schema and Hook strict results
  remain false for six and 15 branch-shape differences, with separate analyses.
  Provider's six-module coverage comparison passes. The initial Hook gate's
  mapping-name error remains alongside its repaired test comparison.
- Schema consolidation loses 19 independent historical-failure labels. An early
  validation assertion masks later whole-object assertions in that fault replay.
  Nine Hook gains enforce event labels that still select the same output class;
  they are stronger wiring checks, not nine demonstrated user-visible defects.
- Build/typecheck and full-suite observations are recorded in `results.json`.
  Raw failing full-suite results remain failing. One pair supplies health
  evidence, with no runtime-speed claim. Round-5 evidence is unchanged.

## Reconstruct the measured snapshot

From a repository containing the baseline, extract into an unused directory:

```sh
testloc_unpack=$(mktemp -d)
tar -xzf .qwen/testloc-evidence/round6-raw.tar.gz -C "$testloc_unpack"
git bundle verify \
  "$testloc_unpack/vm/tmp/qwen-testloc-round6/measured-snapshot/candidate.bundle"
git fetch \
  "$testloc_unpack/vm/tmp/qwen-testloc-round6/measured-snapshot/candidate.bundle" HEAD
git worktree add --detach /tmp/qwen-testloc-round6-replay \
  f678cfa38173b4195fb88087b213343b4e916d50
```

The bundle requires the recorded baseline. The adjacent binary patch provides
an alternative reconstruction; `provenance.json` records all six source hashes.
Install pinned dependencies and build in an isolated checkout before replay.
Plans decompress to their original bytes, with both digests in the manifest.

## Reproduce comparisons from the archive

Original reports retain original VM paths. The member index resolves each path
without editing the report. For example, compare all SchemaValidator mutants:

```sh
node scripts/test-loc/compare.mjs mutation \
  "$testloc_unpack/vm/tmp/qwen-testloc-round6/mutation-replay-JHjEws/0-mutation.json" \
  "$testloc_unpack/vm/tmp/qwen-testloc-round6/mutation-replay-RmeObT/0-mutation.json" \
  --expected "$testloc_unpack/vm/tmp/qwen-testloc-round6/expected/schema/0-mutation.json"
```

Expected: exit 1, zero lost kills, four gained kills and 19 inconclusive paired
Timeout outcomes. This is one module; the stored aggregates include all nine.
The archived comparator and `reports.mjs` are available beneath
`vm/tmp/qwen-testloc-round6/baseline/scripts/test-loc/` for exact reproduction.

To repeat the repaired Hook test-inventory comparison, use the archived mapping
and the original reports beneath `local/hook-system-mapping-repair/`. Coverage
analyses and raw LCOV are separate inputs and preserve strict false. Provider
captures use independent checkouts because their shared helper changed.

The collector includes failed and incomplete attempts without outcome filtering.
Unarchived references require inspection: temporary config paths can be removed
by runner cleanup, while dependencies are represented by lockfiles and runtime
versions. Read the manifest's reference assessment before treating a path as
missing evidence. Collector and summary source are preserved under `local/`.
