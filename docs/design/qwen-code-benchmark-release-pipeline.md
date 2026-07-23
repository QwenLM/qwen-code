# Qwen Code Benchmark Release Pipeline

## Goal

Publish a reproducible SWE-bench result for each stable Qwen Code release without exposing benchmark infrastructure or raw model traces to the public internet. A small manual smoke suite remains available for prerelease validation.

## Architecture

```text
GitHub release.published / workflow_dispatch
  -> repository-scoped self-hosted ECS runner
  -> root-owned qwen-benchmark-dispatch
  -> qwen-benchmark-submit
  -> SQLite run, instance, and event state
  -> systemd qwen-benchmark-worker
  -> Harbor Docker testbed with the requested Qwen Code npm version
  -> SWE-bench verifier
  -> checksummed private artifacts
  -> public summary on the triggering GitHub Release
```

The GitHub job only validates immutable release metadata and queues work. It does not wait for the multi-minute or multi-hour benchmark. The worker owns execution, heartbeat, retry, artifact validation, terminal state, and Release publication.

The runner and worker share one ECS host in the POC. The dispatcher is the only sudo command granted to the unprivileged runner account. There is no public FastAPI service, HTTP listener, Nginx route, release poller, or commit Check Run.

## Trigger and version identity

Stable `release.published` events run the default Harbor smoke suite. Prereleases are excluded from automatic execution. Maintainers can manually dispatch an allowlisted suite against an existing prerelease and optionally provide that prerelease's numeric Release ID for result publication.

The workflow resolves annotated tags until it reaches a 40-character commit SHA. Each request records the repository, tag, immutable commit, suite, dataset revision, GitHub run identity, and Release ID. Harbor must report the exact Qwen Code npm version derived from the requested tag.

## State, completion, and retry

SQLite is both the single-node queue and source of truth. Runs move through `QUEUED`, `PREPARING`, `RUNNING_AGENT`, `GRADING`, `UPLOADING`, and one terminal state. Every manifest instance must have one terminal result before a run can succeed.

The worker emits heartbeat and event records. A restart can recover an interrupted infrastructure attempt. Infrastructure failures may retry once; a valid unresolved answer, failed repository tests, or a normal agent timeout is a benchmark outcome and is not retried.

## Publication and data boundary

Only suites explicitly marked publishable can update GitHub. The publisher verifies that the Release tag matches the benchmarked ref and restricts manual publication to prereleases. Successful runs replace the paired-marker benchmark table on the triggering Release while preserving content before and after it. The table contains dataset and revision, suite, evaluation method, completed/resolved/unresolved/infrastructure-error counts, score, exact Qwen Code version and commit, and ECS run ID. Failed terminal runs publish status and counts without a score.

Only the aggregate public summary is written to GitHub. Model keys, GitHub tokens, raw trajectories, patches, Docker logs, and internal paths stay on the ECS host or private object storage. Run artifacts include a SHA-256 manifest and a separate publication-error record only when Release publication fails.

## POC scope and production path

The POC intentionally uses one worker and SQLite. Production scale should move the same run/instance contract to a shared scheduler and object store without changing the GitHub trigger or public result schema. Multi-case failure thresholds, durable publication retry, image mirroring, secret injection that never expands credentials into process arguments, and concurrent resource classes remain production follow-ups.
