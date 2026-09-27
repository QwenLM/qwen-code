# Round 5 evidence

`manifest.json` records what has actually been collected. `collectionComplete`
only describes input availability; capability results remain in each comparison.
Pending inputs have explicit `pending-source` or `missing` states. A checkpoint
with `complete: false` remains `incomplete`.

The four initial plans were copied read-only from `agent-sandbox`. Their compressed
copies in `plans/` decompress to the exact original bytes. The manifest records
both original and gzip SHA-256 digests, original VM paths, selection parameters,
and item counts. The full integration C1 plan has 106 entries; the two mutation
plans have eight sampled and four full modules respectively. The experiment C1
plan has three entries. Eligibility remains in each frozen plan.

`results.json` retains complete small JSON inputs: replay summaries, comparator
results, gate results, mapping reasons, source hashes, and runtime provenance.
The session-hooks gate currently reports `ok: false` due to branch-shape changes;
that observed result is preserved. Subsequent analysis belongs in a separate
input and does not overwrite the original gate.

The ignored `.qwen/testloc-evidence/round5-raw.tar.gz` holds byte-identical inputs,
large raw test/mutation reports when supplied, logs, and `raw-files.json` with
per-file digests. Its digest and size are in the tracked manifest. Preserve this
archive alongside the Git evidence when transferring the work. The collector
uses only explicit local paths and never contacts the VM or runs tests.

## Fill in the final results

1. Copy completed VM reports and their raw report directories into
   `.qwen/test-loc-round5/archive-input/`. Keep original filenames and preserve
   the v2 C1 reports. Do not snapshot files while their producing run is active.
2. Set the corresponding `local` and `origin` values in `sources.json`.
   Paths in `local` are relative to the repository root, or absolute.
   Add one `kind: "json"` entry per C2 comparison if comparisons are separate
   files; replace the aggregate placeholder accordingly. Use `kind: "raw"`
   for large Stryker/Vitest reports or directories. Include full baseline,
   candidate, and independently frozen expected mutation reports; source hashes
   alone cannot replay mutation comparison. Add comparator command/exit logs
   as raw inputs, including nonzero exits.
3. From the repository root, run:

   ```sh
   python3 scripts/test-loc/evidence/round5/collect.py
   ```

The script rewrites only these derived evidence files and the ignored raw archive.
It rejects changes to inputs with `expectedSha256`. Re-running against identical
local inputs produces identical bytes and digests. Inspect pending/incomplete
entries in the manifest before describing the archive as complete.

## C1 skipped-status correction

Keep original v2 results, supplemental v3 results, the selected subset plan,
merged derived results, and their comparison as separate inputs. The original
full plan must retain its recorded digest. Select the same supplemental fault
SHA union on both sides, limited to original `no-result` entries whose reason is
exactly `Unknown assertion status: skipped`.

The merged report must retain the original plan digest and full expected SHA
inventory. Preserve a derivation record naming the original and supplemental
report digests, runner digests, selection reason, and the source used for each
replaced row. Archive that record as an additional JSON input. The collector
copies this evidence; it does not perform or approve the merge.

The runtime compatibility note and 25-test regression log are already included.
The v2 and v3 runner sources are preserved with their separate digests. A report
from a partial run, collection failure, or unverified mutation inventory remains
an observation with its original status.

## Replay a mutation comparison after moving the archive

Original run summaries and expected inventories retain their VM source paths.
Locate their members through `manifest.json` (`sources[].archiveMember`). For a
raw-directory source, its source ID is the archive prefix; `raw-files.json`
lists every exact member path and digest. The original reports stay unchanged.

After the final collection, extract the archive into an independent directory.
This example replays the first integration module, `sessionHooksManager`, using
its recorded before, after, and frozen expected reports:

```sh
testloc_unpack=$(mktemp -d)
tar -xzf .qwen/testloc-evidence/round5-raw.tar.gz -C "$testloc_unpack"
node scripts/test-loc/compare.mjs mutation \
  "$testloc_unpack/integration-mutation-raw/mutation-replay-JYWRW5/0-mutation.json" \
  "$testloc_unpack/integration-mutation-raw/mutation-replay-DDXIUI/0-mutation.json" \
  --expected \
  "$testloc_unpack/integration-mutation-raw/mutation-integration-expected/0-mutation.json"
```

The before/after summary source IDs are `integration-mutations-baseline` and
`integration-mutations-integrated`; the expected inventory source ID is
`integration-expected-mutant-inventory`. Their `module`, `report`, and `sha256`
entries identify the corresponding module and original report bytes. Resolve
other modules under the same raw-directory prefix using those entries and the
member index. The experiment reports use `experiments-mutation-raw`.

Read the returned `ok`, `lostKills`, and `inconclusive` fields with the command's
exit code. This command compares one module. The complete archived aggregates
retain every module, including unchanged Timeout outcomes. The current
comparator runs with Node and its adjacent `reports.mjs`; the recorded original
comparator sources are also preserved under each mutation raw source's
`runtime/` directory for historical reproduction.

## Final collected inputs

`sources.json` now names all completed inputs. Run the collector after the final
source review to regenerate `manifest.json`, `results.json`, the compressed
plans, and the raw archive together. The final experiment summary and its
producer are separate sources. Full timing summaries and observations are raw
sources to keep their detailed failure lists out of the compact tracked results.

Integration C1 retains 92 detections among 103 eligible faults on both sides.
Experiment C1 retains both eligible detections. The C2 aggregates retain strict
`ok: false`: integration has 14 inconclusive Timeout outcomes; experiments have 18. All mutation statuses and comparison outputs remain available.

All eight timing runs are archived. Rounds 1, 3, and 4 are the selected pairs;
round 2 was excluded after a host/VM pause, with the decision recorded before
the candidate run finished. The strict summary and the derived health and
performance gates remain false. The extra session-writer-lease failure in the
selected round 3 remains unresolved. Six focused diagnostic runs passed; their
raw reports, reply records, and the earlier collection pilot are separate
sources and preserve the original timing result.

## Reconstruct the measured experiment revision

The `measured-experiment-snapshot` raw source contains a one-commit Git bundle
and a binary patch from integration `10a29740ae` to measured snapshot
`3b60453c83`. Its provenance source records full revisions, file digests, and
bundle verification. The bundle requires the integration commit already to be
present in the receiving repository. It contains the committed test changes;
the recorded uncommitted formatting/lint configuration changes are excluded.

After extracting the archive as above, run from a repository containing the
integration commit:

```sh
git bundle verify \
  "$testloc_unpack/measured-experiment-snapshot/experiment-3b60453c83.bundle"
git fetch \
  "$testloc_unpack/measured-experiment-snapshot/experiment-3b60453c83.bundle" HEAD
git worktree add --detach /tmp/qwen-testloc-measured-replay \
  3b60453c83793234d7e7e2d50882dd892aff27a0
```

Choose an unused worktree path. Install the pinned dependencies and build in
that isolated checkout before running the frozen measurement plans. The patch
provides an alternative record of the same committed change; applying it to the
integration tree reconstructs the file contents, while the bundle preserves the
exact measured commit.
