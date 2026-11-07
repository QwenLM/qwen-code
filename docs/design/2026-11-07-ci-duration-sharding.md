# Shard CI tests by measured run time

[English](2026-11-07-ci-duration-sharding.md) | [简体中文](2026-11-07-ci-duration-sharding.zh-CN.md)

Status: implemented in this change. Follows
[Shorten the pull-request CI critical path](2026-11-06-ci-pr-critical-path.md).

## Problem

After #16450, the required-path median for internal pull requests fell from
28.5 to 21.4 minutes (95 runs, 2026-11-06 to 11-07), short of the 15-minute
target. The Linux unit-test lane finished last in 66 of those 95 runs, and the
no-AK integration lane in the rest.

- **Unit shards are uneven.** Vitest's `--shard` gives every shard the same
  number of files, ordered by a hash of the path, whatever they cost. Shard 1
  (CLI 589 s) and shard 6 (CLI 743 s) took 12–14 minutes while shard 4
  finished its CLI files in 146 s.
- **A single file sets a shard's floor.** A file runs on one worker, so no
  split can finish sooner than its slowest file. `Session.test.ts` (66k
  lines, ~556 s), `hosted-harness-session.test.ts` (~292 s) and
  `hosted-workspace-tool-turn.test.ts` (~206 s in pull-request runs, ~650 s
  with coverage) set that floor for whichever shard drew them.
- **Integration shards are uneven too** (median test step 425 s, 163 s,
  498 s). `mods-tool-middleware.test.ts` alone takes ~430 s, and shard 1 also
  type-checks the integration sources (~100 s) before its tests.
- **The build lands on slow hosts half the time.** The x64 pool includes ARM64
  hosts (hz). `test_build` took 435 s there against 206 s on the x64 (hk)
  hosts, and every unit and integration shard waits for it.

## Design

### Duration-based sharding

- **The data.** `.github/scripts/ci/test-durations.json` holds, per suite
  (`packages/cli`, `packages/core`, `integration-tests`), the worker count a
  shard runs with on ECS, a per-file overhead (import and collect) and the
  median seconds of every file that takes at least 2 s. Faster files cost the
  overhead alone.
- **The plan.** `test-shard-plan.mjs` places the files longest first. A
  shard's finish is estimated as the larger of its longest file and its total
  over the workers. Each file goes to the shard that keeps the slowest finish
  lowest; when several shards keep it equal, the least loaded one wins.
  Ordering and tie-breaks depend only on paths and durations, so every shard
  computes the same plan on any host. The worker count is part of the data,
  not read from the host, for the same reason.
- **The sequencer.** `vitest-duration-sequencer.mjs` extends Vitest's
  `BaseSequencer`. With `--shard`, it returns this shard's part of the plan and
  runs its longest files first. Suites missing from the data keep Vitest's
  default. The cli, core and integration configs use it; the other workspaces
  are small and run in the side lane.
- **The refresh.** `update-test-durations.mjs` reads the per-file times
  Vitest prints in the logs of the latest successful pull-request runs. It
  skips push runs, whose coverage slows them, and uses only shards that ran
  on the ECS pool. Someone runs it by hand and commits the diff. A new or
  renamed file falls back to the overhead until the next refresh.

### Split the slowest files

The tests move unchanged into sibling files that copy the shared setup, as
`hosted-workspace-tool-turn.*.test.ts` already did. Every split keeps the
same set of test names (checked with `vitest list`).

| Original                             | Parts                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------- |
| `Session.test.ts`                    | `Session`, `Session.prompt`, `Session.prompt-queue`, `Session.tool-calls` |
| `hosted-harness-session.test.ts`     | the original, `.no-tool`, `.tools`                                        |
| `hosted-workspace-tool-turn.test.ts` | the original, `.approvals`, `.hooks`                                      |
| `mods-tool-middleware.test.ts`       | the original and `.rest`, over a shared `.suite.ts`                       |

`Session.test.ts` also runs faster split: alone it took 294 s locally,
and its four parts took 128 s in total. Its later tests slow down as state
builds up across the 66k-line file.

### Integration type-check beside the tests

Shard 1 starts `typecheck:integration` in the background, runs its tests,
then waits for the type-check and prints its log. The step fails if either
fails.

### Pin the build to the x64 hosts

`classify_pr` publishes `build_runner`. It equals `ubuntu_runner` unless the
repository variable `BUILD_RUNNER_LABELS` is set and `ubuntu_runner` chose the
x64 fleet; then it takes the variable's labels. Only `test_build` reads it.
The hk hosts need a label of their own, proposed as `ecs-qwen-hk`, because
`runs-on` matches every listed label and cannot exclude one, and both host
groups carry the same four. Until operators add the label and set the
variable, nothing changes; clearing the variable reverts it.

## Decisions

| Decision                                     | Rationale                                                                                                |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Durations checked in, not in `actions/cache` | Reviewable and deterministic; works for forks and locally; integration tests do not run on push          |
| Per-file times from job logs, not JUnit      | Pull-request runs carry no coverage; the integration lane writes no JUnit                                |
| Worker count fixed in the data               | Hosts differ (`maxWorkers: '25%'`); a host-dependent plan would drop or repeat files across shards       |
| Split files in the same change               | Without it the slowest file sets the floor: the plan alone saves about 1–1.5 minutes per lane            |
| `build_runner` gated by a variable           | The hk label does not exist yet; the change ships inert and operators can turn it on or off without a PR |

## Risks

- **Stale durations.** New and renamed files cost the overhead until a
  refresh. A plan built on stale data is uneven, never wrong: every file
  still runs in exactly one shard.
- **The first runs use estimates** for the split files. Refresh the data from
  this change's own runs.
- **Pinning the build to hk** queues it when those hosts are busy. Clear the
  variable to return to the whole pool.

## Validation

- `.github/scripts/ci/test-shard-plan.test.mjs`: every file lands in exactly
  one shard for 1–60 shards; the plan ignores input order; the slow files
  spread; the durations file is well formed.
- Against the real file lists (1463 cli, 1015 core), the eight plans cover
  every file once; their estimated finishes are 183 s for cli and 106 s for
  core. A real `vitest run --shard=1/8` in core runs exactly the planned file.
- `.github/scripts/ci-runner-routing.test.mjs`: `build_runner` follows
  `ubuntu_runner` while the variable is empty. With the variable set, it
  narrows only the x64-fleet routing, leaving forks, the kill-switch and the
  hosted and ARM64 selectors alone. Only `test_build` reads it.
- `no-ak-integration-ci`: the new integration file is listed, and the gate
  waits for the type-check and fails with it.

## Acceptance criteria

- Every Linux unit-test file and every no-AK integration file still runs on
  every pull request, once.
- The slowest Linux unit shard's test step drops below 8 minutes (median of
  20 runs).
- The required-path median drops below 17 minutes over 20 runs, and below 15
  once `BUILD_RUNNER_LABELS` is set.
