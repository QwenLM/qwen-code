# DSW SWE-bench Verified Release Pipeline

This pipeline is an isolated implementation of:

`GitHub Release -> DSW self-hosted runner -> 10-executor SWE-bench Verified pool -> Release result`

It does not use or modify the workflow, service, state, or result markers from
PR #7584.

## Production behavior

- A published Release starts the workflow from the Release tag's target commit.
- The Release tag is resolved to its immutable Git commit.
- The DSW preflight removes Harbor's CLI key argument so the model key is passed
  to Qwen Code only through the process environment.
- The full 500-instance SWE-bench Verified manifest is frozen before dispatch.
- Ten executors atomically claim tasks from PostgreSQL. Each executor runs one
  Harbor/Docker trial at a time.
- The Coordinator maintains leases, heartbeat recovery, one infrastructure
  retry, run counters, and the completion gate.
- A score is written to the Release only when all 500 instances have a unique
  terminal state and the run status is `SUCCEEDED`.
- A `QUARANTINED` or pipeline-error run writes status and counts, but never a
  score.

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

Publish an isolated prerelease whose target commit is on this branch. GitHub
then evaluates this branch's `release.published` workflow and automatically
starts the DSW job with `instance_limit=500` and `executor_count=10`; no manual
DSW dispatch is involved.

For an event-driven test prerelease, a single body line such as
`Benchmark-Qwen-Ref: v0.20.0-nightly.20260722.b98306b7e` selects an existing
published Qwen npm version while keeping the result on the isolated POC Release.
This override is accepted only for prereleases. A normal Release always evaluates
its own tag.

`workflow_dispatch` remains available for explicit diagnostics and reruns.
Manual validation defaults to one instance to bound time and model cost.
