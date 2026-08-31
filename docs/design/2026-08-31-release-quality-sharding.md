# Release quality sharding

## Context

The Release workflow's workspace test step grew from 19:30 to 27:17 between July 31 and August 29 while the executed test count grew by 44%. The step runs every workspace sequentially on one runner and now dominates the release critical path.

The release gate must continue to run formatting, lint, the serve fast-path bundle check, a full build, typechecking, every workspace test, and the scripts suite. `force_skip_tests` must keep its current emergency behavior, and publishing must continue to depend on one fail-closed quality result.

## Design

Split the monolithic quality job into a DAG:

- Static formatting and lint checks run independently of the build.
- The serve fast-path check and full build run once. Their generated `dist` directories are packed into one artifact.
- Typechecking, the scripts suite, and three workspace-test shards consume that build artifact.
- Workspace sharding uses Vitest's native `--shard=index/count` option through a reusable root package script. Every workspace with a `test:ci` script is still selected automatically by npm, so adding a workspace cannot silently omit it from the release gate. `--passWithNoTests` lets small workspaces participate when one shard receives no files.
- A small hosted aggregate job checks every result and retains the stable `quality` dependency used by publishing and failure notification.

Validation jobs use shallow checkouts because they test one selected ref and do not inspect tags or history. Metadata preparation and publishing keep full history.

The preparation job resolves the selected ref to one immutable commit SHA. Every validation checkout and publishing use that SHA, preventing a moving branch from mixing source and build outputs from different commits.

## Failure semantics

The matrix does not fail fast, so all shards report their result. The aggregate quality job runs after success, failure, or cancellation and fails unless every component succeeded. When `force_skip_tests` is enabled, all quality components and the aggregate are skipped, preserving the existing publish override.

Build artifacts are scoped to one workflow run and retained for one day. Uploads explicitly replace an earlier artifact with the same name so “Re-run all jobs” remains recoverable. They contain only generated repository outputs and carry no credentials.

## Expected impact

The previous 27-minute workspace phase becomes three roughly balanced shards after an approximately eight-minute build. Based on recent timings, the quality critical path should fall from about 42 minutes to roughly 20–25 minutes. The first non-publishing dispatch should compare test file and test totals with the monolithic baseline before relying on the timing estimate.

## Daily CI follow-up

The daily CI has different coverage, JUnit, fork-permission, and required-check contracts. It should adopt the same build-once and Vitest-shard primitive in a separate change, with per-shard coverage artifacts merged before the existing report job and a stable aggregate check name. Keeping that rollout separate limits the blast radius and makes runner-capacity effects measurable.
