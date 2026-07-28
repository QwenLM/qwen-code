# DSW SWE-bench Verified Release Pipeline

This pipeline is an isolated implementation of:

`GitHub Release -> self-hosted DSW runner -> short run submission -> persistent Coordinator + 10 Executors -> Publisher -> Release result`

It does not use or modify the workflow, service, state, or result markers from
PR #7584.

## Production behavior

- A stable `vX.Y.0` Release starts the workflow from the Release tag's target
  commit. Patch releases, prereleases, and unrelated tag families are skipped.
- The Release tag is resolved to its immutable Git commit.
- The full 500-instance SWE-bench Verified manifest is frozen before dispatch.
- The self-hosted runner receives the Actions job over its outbound GitHub
  connection. The one-shot dispatch script freezes the manifest and calls
  `qwen-benchmark-pool submit` to create the run and initial tasks.
- The Action records the pool `run_id` and ends without waiting for the
  benchmark.
- A persistent Coordinator and ten persistent Executors process the run. Each
  Executor atomically claims one task and runs one Harbor/Docker trial at a time.
- Harbor live trial directories stay on local NVMe. Completed attempt artifacts
  are copied to OSS without depending on OSS POSIX permission operations.
- Executors heartbeat their leases and atomically submit outcomes. Retryable
  infrastructure errors receive up to four attempts with 60, 120, and 240
  second backoff.
- The Coordinator recovers expired leases, reconciles run counters, and applies
  the manifest completion and publication gates. Isolated terminal failures do
  not cancel the remaining tasks.
- A persistent DSW publisher watches terminal runs and actively updates the
  triggering Release with the public result JSON and a per-case trajectory
  archive.
- A score is written only after all 500 instances reach a unique terminal
  state, no task is canceled, and `EXECUTION_ERROR + INFRA_FAILED < 10`.
  The score is `RESOLVED / (RESOLVED + UNRESOLVED)`, using only valid grader
  results as the denominator.
- Ten or more terminal errors, a canceled task, a missing result, or a missing
  trajectory for a scoreable case makes the run `QUARANTINED`; status and
  counts are written without a score.

## Isolation boundaries

- Runner label: `qwen-benchmark-dsw`
- Workflow: `.github/workflows/dsw-swe-verified-release.yml`
- Suite: `dsw_release_swe_verified_v1`
- PostgreSQL database: `qwen_benchmark_dsw_release_v1`
- Runtime: `/mnt/workspace/qwen-benchmark-dsw-release-v1`
- Model credential: `/mnt/workspace/qwen-benchmark-dsw-release-v1/config/model.key`
  (`root:github-runner`, mode `0640`)
- OSS: `/mnt/data/qwen-benchmark/dsw-release-v1`
- Release markers: `qwen-code-dsw-swe-verified`

Docker image layers may use the DSW host cache, but experiment state and
artifacts do not share paths or tables with another benchmark pipeline.

## Branch validation

Use `workflow_dispatch` from this branch and target an isolated prerelease.
Automatic `release.published` runs are intentionally limited to stable
`vX.Y.0` releases.

For a manually dispatched test prerelease, a single body line such as
`Benchmark-Qwen-Ref: v0.20.0-nightly.20260722.b98306b7e` selects an existing
published Qwen npm version while keeping the result on the isolated POC Release.
This override is accepted only for prereleases. A normal Release always evaluates
its own tag.

`workflow_dispatch` remains available for explicit diagnostics and reruns.
Manual validation defaults to one instance to bound time and model cost; 5 and
500 instance runs do not forward the single-case `instance_id`. Both triggers
are asynchronous: Actions records a dispatch receipt but does not stay alive
for the benchmark duration.

## Component boundary

- GitHub self-hosted runner: long-running GitHub job receiver.
- Dispatch / pool submit: one-shot run and task creator.
- PostgreSQL: shared persistent state store, not the scheduler.
- Coordinator: expired-lease recovery, run reconciliation, and completion gate.
- Executors: task claim, Harbor/Qwen Code/grader execution, heartbeat, and
  outcome submission.
- Publisher: terminal-run validation, public result and trajectory bundle
  generation, and active GitHub Release writeback.

The DSW implementation is maintained separately in the internal
`qwen-code-benchmark-dsw` repository. This PR contains only the GitHub trigger,
manifest, dispatch adapter, and public design contract.

## Full-suite validation

The isolated prerelease validation completed on 2026-07-25:

- Test Release:
  `dsw-swe-full-async-poc-20260724-2c5ad4a5d0-r3`
- GitHub Actions run: `30079405895`
- Pool run: `pool-31a24bc8acca49d2`
- Dataset: `swe-bench/swe-bench-verified@2`, 500 frozen instances
- Execution: 10 persistent Executors, at most two attempts per instance
- Qwen Code: `v0.20.0-nightly.20260722.b98306b7e`
- Model: `qwen3.7-max`
- Wall time: approximately 12 hours 27 minutes
- Results: 332 `RESOLVED`, 107 `UNRESOLVED`, 56 `EXECUTION_ERROR`,
  5 `INFRA_FAILED`
- Valid grader coverage: 439/500 (87.8%)
- Diagnostic resolved rate among valid grader results: 332/439 (75.6%)
- Run status: `QUARANTINED`; no official score was published
- Public JSON: 500 records and 500 unique instance IDs

Evidence:

- https://github.com/QwenLM/qwen-code/releases/tag/dsw-swe-full-async-poc-20260724-2c5ad4a5d0-r3
- https://github.com/QwenLM/qwen-code/actions/runs/30079405895
- https://github.com/QwenLM/qwen-code/releases/download/dsw-swe-full-async-poc-20260724-2c5ad4a5d0-r3/swe-bench-verified-dsw-swe-full-async-poc-20260724-2c5ad4a5d0-r3.json

The full chain was validated, including asynchronous dispatch, task-pool
execution, strict quarantine, and Publisher writeback. The run is not an
official model score: 61 instances lacked valid grader results, and a running
Executor pool retained an older error classifier after a source hot update.
A clean full rerun requires a pinned worker commit/digest and restarted,
version-checked Executors.
