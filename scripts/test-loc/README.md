# Core test size experiments

These tools measure test size and compare test capability on the **same product implementation**. Historical evidence covers `ab61e04161a30bf825fefede85bcc09ebef7a673` through `e15058c26b86673f18bc22aae67577bc3ddad1e3`. New work uses a newly frozen plan at its integration baseline.

## Preserved evidence

`evidence/historical/` contains the original 100-fault corpus, six targeted faults, original base and head results, four rechecks of two flaky readings, exact mutation ranges and requested test lists, and provenance with SHA-256 digests. `base-c1.corrected.json` replaces those two readings with the consistent rechecks: 89/100 detected. It is a derived baseline, not another full replay. Round 4's 100 results match its fault outcomes and failing counts; the six targeted faults are detected on both sides.

`frozen-faults.json` is an **archival candidate inventory**: 106 original implementation patches and reconstructed candidate lists at the old baseline. All reconstructed candidate counts match the original reported counts. Original results did not save candidate filenames. The inventory retains historical selection behavior, including its limitations; use `prepare-faults` to create an executable plan.

`mutation-samples.json` records 18 module/sample pairs across two seeds (`20260925` and `20260926`), with exact ranges, requested and observed test files, and implementation hashes. `mutation-summary.json` compares 8,027 mutant identities; source text and mutant sets were checked before calculating status changes. Earlier rounds use the individual revisions in `run-provenance/`; Round 4's head is `e15058c26b`.

The original mutation JSON, LCOV, configuration, and run scripts are preserved in the ignored artifact `.qwen/testloc-evidence/historical-raw.tar.gz`. Its digest, original Linux absolute paths, and per-file digests are in `provenance.json`. Extract it into a task artifact directory when the original Stryker reports are needed. Whole-suite JSON logs are represented by small summaries, original paths, and digests rather than copied into Git. Historical suite runs include the same Git prune environment failure on both sides.

## Install and build

Use disposable, clean checkouts with independently installed dependencies. Build each checkout before measuring it:

```sh
corepack pnpm install --frozen-lockfile
npm run build
```

Run both sides on the same machine with the same Node version and without competing mutation or full-suite jobs. The repository's lockfile pins its Vitest runtime. Install the separate measurement runtime from this directory:

```sh
npm ci --prefix scripts/test-loc/measurement
```

The measurement runtime requires Node 22.18 or newer within Node 22, or Node 24.11 or newer, matching its locked Babel dependencies. The measurement lock preserves Stryker core and Vitest runner **10.0.0** plus their resolved dependency versions. Its bundled peer Vitest is 5.0.2; the historical project installation used Vitest 3.2.7. Node v22.23.2 was observed when archiving the surviving Linux environment; the original runs did not separately record Node's version. The lock's root metadata and direct version ranges were normalized; dependency entries came from the original lock.

## Freeze and replay historical faults

Prepare **once** from the new uncompressed baseline; supply exactly that plan to both checkouts. The plan freezes product files, runtime configuration and lockfiles, patch bytes, candidate selection, and four workers. Tests, fixtures, test utilities, documentation, and this measurement tooling are excluded from the product fingerprint. A different product fingerprint refuses to run.

```sh
node scripts/test-loc/measurement/replay.mjs prepare-faults \
  --repo /path/to/baseline \
  --corpus scripts/test-loc/evidence/historical/corpus-core.json,scripts/test-loc/evidence/historical/corpus-targeted.json \
  --max-workers 4 --out /path/to/artifacts/fault-plan.json

node scripts/test-loc/measurement/replay.mjs run-faults \
  --repo /path/to/baseline --plan /path/to/artifacts/fault-plan.json \
  --out /path/to/artifacts/fault-before.json
node scripts/test-loc/measurement/replay.mjs run-faults \
  --repo /path/to/candidate --plan /path/to/artifacts/fault-plan.json \
  --out /path/to/artifacts/fault-after.json
node scripts/test-loc/compare.mjs faults \
  /path/to/artifacts/fault-before.json /path/to/artifacts/fault-after.json
```

Candidate selection retains the original ordering and default cap of 40: changed tests, sibling tests, then direct importers. The plan records any candidates from another package removed after that cap. `--max-tests 0` explicitly selects the whole package and therefore creates a different experiment.

Every candidate group first runs without an injected fault. A fault is detected only by **new failed assertions** relative to that group's health run. Existing failures remain visible; the comparator marks those results inconclusive. Reports verify the requested files, actual executed assertions, all assertion counts, process exit, and unhandled errors. A health run with collection failures is `no-result`. An injected run may detect a fault through new failed assertions while retaining separate `collectionFailures`; collection errors without new assertion failures are `no-result`. Each injection restores the exact previous contents and executable modes in `finally`.

Unapplicable reverse patches and corpus entries that include test-support code are marked `ineligible` in the frozen plan, identically on both sides. The original corpus accidentally included test helpers in `5e97fc8f2e` and `8b0e8b8192`; current replay excludes them explicitly. On the integration baseline `9e60263fde`, `9414461c82` also cannot reverse-apply. This leaves 103 eligible entries from the original 106; subsequent collection failures remain visible in the results and follow the collection rules above.

For a separately reproduced environment failure, `prepare-faults --exclude-name 'exact full test name'` records and excludes that exact name on both sides. Record the reproduction and reason with the plan. The integration experiment excludes `dryRunGitWorktreePrune counts any link in the admin directory against the prune`, which failed in both unmodified checkouts on the Linux VM. Excluding an entire file would change the experiment's coverage of other behaviors.

New reports contain the complete expected SHA list, plan digest, replay script digest, and a completion marker. A partial checkpoint cannot pass comparison even when both processes stopped at the same fault. The runner uses a per-checkout lock, unique report paths, and persistent restore journals. Replay execution requires Linux or macOS. Each run owns a separate POSIX process group; SIGINT/SIGTERM terminate its children and grandchildren before restoring source files. Descendants still running after one second receive SIGKILL. Normal process exit also cleans remaining descendants. SIGKILL or machine loss requires recovery from the saved `*-restore.json` journal or replacement of the disposable checkout; a stale lock prevents accidental reuse.

## Mutation replay

`prepare-mutations` freezes module source hashes, test lists, product/runtime fingerprint, and exact ranges. `sampled` retains the historical six 150-line windows per module and seeded generator. `deletion` mutates each complete supplied module, includes static initialization and every mutation operator, and disables bail so all killing tests can be observed. Include every relevant behavioral dependency when testing deletions; a narrow mutation model previously missed the hook alias regression.

```sh
node scripts/test-loc/measurement/replay.mjs prepare-mutations \
  --repo /path/to/baseline --modules src/hooks/sessionHooksManager.ts \
  --profile sampled --seed 20260926 --max-workers 4 \
  --out /path/to/artifacts/mutation-plan.json
node scripts/test-loc/measurement/replay.mjs run-mutations \
  --repo /path/to/baseline --plan /path/to/artifacts/mutation-plan.json \
  --runtime /path/to/tools/scripts/test-loc/measurement \
  --out /path/to/artifacts/mutation-before.json
```

Repeat the run with the candidate checkout and the same plan. `--tests` on preparation can explicitly freeze a comma-separated set of paths relative to core; otherwise the sibling and direct value-importing tests are selected. The run writes each full Stryker report at the path listed in its result and records the replay script digest plus the resolved Stryker and Vitest configuration digests. Preserve the successful full baseline report as the expected mutant inventory, then compare each pair:

```sh
node scripts/test-loc/compare.mjs mutation \
  /path/to/before.mutation.json /path/to/after.mutation.json \
  --expected /path/to/frozen-baseline.mutation.json
```

Both source text and the complete mutant identity set must match. Omitting `--expected` produces an observation with `sampleComplete: false`, not a passing gate. A changed implementation requires a new plan and new baseline inventory; historical reports cannot supply the expected inventory for changed source.

The historical sampled profile excludes static mutants and the `StringLiteral`, `ObjectLiteral`, and `Regex` operators. Both profiles retain five exclusions required by Stryker's worker-thread execution: `ripGrep`, `extension/github`, `projectSummary`, `openaiLogger`, and `ipc/peer-controllers` tests that change the process working directory. They remain part of ordinary testing and C1. Every archived sample lists both requested tests and tests actually present in its Stryker report; the five exclusions can make those sets differ. The current runner records the actual report and these omissions must remain visible when evaluating detection. These exclusions limit mutation evidence and must be considered during semantic review.

The current exploratory batch freezes the three faults in `experiments/corpus.json`: Claude tool aliases, flat-memory depth, and escaped whitespace in hook matchers. Its full mutation scope is `memoryImportProcessor`, `sessionHooksManager`, `hookPlanner`, and `hook-matcher`. Existing alias cases remain part of the test suite, and the alias fault also changes `permissions/rule-parser.ts` during C1. The four-module C2 plan does not mutate that dependency's full static alias table. This boundary supports evaluating the selected consolidation; broader claims about deleting permission-parser or other core behavior need additional evidence.

## Size, assertions, and coverage

```sh
node scripts/test-loc/size.mjs /path/to/candidate packages/core --json
node scripts/test-loc/gate.mjs /path/to/candidate \
  src/hooks/sessionHooksManager.test.ts src/hooks/sessionHooksManager.ts \
  BASE_REV /path/to/artifacts/file-gate
```

`size.mjs` includes new, untracked test fixtures as well as tracked tests, snapshots, and test utilities. The default file gate requires test-name and per-test assertion preservation plus unchanged covered line/branch sets. It writes a unique run directory with reports, commands, hashes, and runtime versions.

The file gate substitutes only the baseline test file and corresponding snapshots. Shared helpers come from the candidate checkout; changes to shared helpers require measurements in two separately built checkouts. For multiple implementation files, provide comma-separated exact paths.

Intentional consolidation or deletion uses `--mode experiment --mapping mapping.json`. Explain each removed case and each assertion reduction, including reductions within a retained name:

```json
{
  "mappings": [
    {
      "before": "original full name",
      "after": "new full name",
      "reason": "Behavior retained by the named parameterized scenario."
    }
  ],
  "removed": [
    {
      "before": "redundant full name",
      "reason": "Exact duplicate of the named retained scenario; replay evidence recorded separately."
    }
  ]
}
```

A mapping records intent; fault replay, full-scope mutation where appropriate, coverage, and semantic review supply capability evidence. Review input shape, missing keys, mock behavior, timing, ordering, and each variant's own assertions. Equal counts alone cannot establish equivalence.

Comparators return JSON and exit `0` for a passing comparison, `1` for a capability failure or explicitly incomplete evidence, and `2` for invalid or failed collection. Historical raw results used weaker collection rules and must be read with their provenance. Fault reports without a frozen plan digest produce `sampleComplete: false` and `ok: false`; they remain observations rather than passing evidence. The replay command completing means its attempts finished; use the comparator to determine the A/B result.

Run focused tool regressions with:

```sh
node --test scripts/test-loc/measurement/replay.test.mjs
node --test scripts/test-loc/reports.test.mjs
```
