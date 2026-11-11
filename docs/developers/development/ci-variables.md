# CI and Release Variables

Several knobs of the CI and release pipelines are exposed as GitHub Actions
repository variables (the `vars.*` context) so operators can retune them
without opening a pull request. This page lists the variables that affect test
execution in `.github/workflows/ci.yml` and `.github/workflows/release.yml`,
together with their defaults and where each one applies.

## Setting a variable

Repository maintainers set these under **Settings → Secrets and variables →
Actions → Variables**. An unset (or empty) variable uses the fallback in the
workflow expression. The worker cap applies only on reserved runners, even when
its variable is set.

The workflow files are the source of truth for these levers, and the test
suites pin the workflow expressions byte-for-byte:
`scripts/tests/package-scripts.test.js` pins the shared worker-cap
expression in `release.yml` (`QWEN_CI_VITEST_MAX_WORKERS` with the
`ecs-qwen-` guard), `scripts/tests/no-ak-integration-ci.test.js` pins the
worker-cap expression in `ci.yml`, and
`scripts/tests/release-workflow.test.js` pins the `release.yml` retry and
workspace-test timeout expressions. `scripts/tests/package-scripts.test.js`
also checks the documented defaults and workflow locations against both
workflows. Because this guard runs on the full-profile CI lane
(`test:scripts`) rather than on docs-only checks, verify edits confined to this
page locally before opening a pull request with `npm run test:scripts` (or
`npx vitest run --config ./scripts/tests/vitest.config.ts scripts/tests/package-scripts.test.js`).
If the docs and the workflows ever disagree, trust the workflows and update
this page in the same change.

## Variables

| Variable                                 | Default | Used in                 | Controls                                                                                    |
| ---------------------------------------- | ------- | ----------------------- | ------------------------------------------------------------------------------------------- |
| `QWEN_CI_VITEST_RETRY`                   | `2`     | `ci.yml`                | Retry count for the main CI workspace and script test step                                  |
| `QWEN_CI_RPC_RETRY`                      | `1`     | `ci.yml`                | Re-runs of an all-green workspace suite that failed only on Vitest's worker RPC timeout     |
| `QWEN_CI_HOST_LOAD_MAX_RATIO`            | `2.0`   | `ci.yml`                | Load-per-CPU ceiling above which a self-hosted Linux host is refused before the unit suites |
| `QWEN_RELEASE_VITEST_RETRY`              | `2`     | `release.yml`           | Retry count for the release workspace test shards                                           |
| `QWEN_RELEASE_WORKSPACE_TIMEOUT_MINUTES` | `45`    | `release.yml`           | Job timeout of each release workspace test shard                                            |
| `QWEN_CI_VITEST_MAX_WORKERS`             | `4`     | `ci.yml`, `release.yml` | Worker cap for main CI unit tests and release workspace/quality tests on reserved runners   |

### Retry counts

`QWEN_CI_VITEST_RETRY` and `QWEN_RELEASE_VITEST_RETRY` are passed to Vitest as
`--retry=<n>` in the main CI test step (every workspace's `test:ci`, which
that step runs in two concurrent lanes, and `npm run test:scripts:unit`) and on
the release lane
(`npm run test:release:workspaces`) respectively. The two lanes have separate
variables so they can be tuned independently.

Vitest reruns failing tests within the same run. This can help with intermittent
contention, but a failure that recovers within the retry budget greens the
check and is not recorded as a failure by the flaky-rerun tracker. Keep the
budget modest instead of using retries to paper over a flaky suite. Both
variables also accept the literal value `off`, which omits
the `--retry` flag entirely instead of passing `--retry=0` (a command-line
`--retry=0` outranks a workspace's own Vitest config and would disable a
deliberate retry policy).

### Worker RPC timeouts on a contended host

`QWEN_CI_RPC_RETRY` is a different lever from `--retry`: it re-runs a whole
workspace suite, and only when that suite's own report shows no failed test and
Vitest's worker-to-main RPC budget (`Timeout calling "onTaskUpdate"`) was the
only unhandled error. On this pool that shape is host contention rather than a
regression — main runs 43018456551 and 43016357976 both went red with 902 of 902
tests passing in `packages/channels/github`. The first attempt keeps npm's own
batched call; only the workspaces npm names as failed are re-run, each alone.

The release lane already grants this same pass on its own shards
(`.github/scripts/run-release-workspace-tests.sh`), and the evidence rules are
the ones `scripts/tests/release-workflow.test.js` pins there: the run must have
reached a passing tally, it must not have been killed by a signal, and Vitest's
own count of unhandled errors must equal how many carried the transport message
exactly. A count, not the crash header — the header is producer-chosen, so any
pattern over headers is incomplete. Both figures are sums over the whole report,
so one attempt's green tally cannot cover a later attempt's crash.

The Linux lanes deliberately keep unhandled errors fatal
(`scripts/tests/unit-vitest-configs.test.ts`, #10438), so this does not ignore
them: any failed test, any second unhandled error, or a process that died before
reporting declines the retry. A stall that outlives both attempts still fails.
Set `0` to make the first failure stand.

### Host load admission

`QWEN_CI_HOST_LOAD_MAX_RATIO` is the load-per-CPU ceiling of the
`Host load gate (self-hosted)` step in the unit-test shards. The gate samples
the five-minute load average from `/proc/loadavg` against `nproc`, waits up to
six samples ten seconds apart, and admits the job as soon as one sample clears
the ceiling. A host still above it fails the step before the suites start.

The gate cannot move a job: GitHub has already placed it, and only a re-run
lands it on another host. What it changes is when the job fails. The disk floor
gate beside it admits on free bytes and inodes, which say nothing about CPU
contention; on 2026-11-11 the hk1 pool ran 64-CPU hosts at load 53-98 with 28-140
concurrent Vitest processes, and that occupancy is what expires the 60-second
test budgets, the RPC budget above, and the test step's whole 45-minute budget.
Refusing costs the install already spent and returns that budget, with a message
that says to re-run instead of a test failure no branch authored.

**The gate is a backstop, not a predictor.** The default `2.0` is calibrated
against the five-minute load per CPU of the shards that failed on 2026-11-11 and
of four shards that passed on the same pool in the same hour:

| Shard | Host   | At entry | Median | Peak | Outcome                |
| ----- | ------ | -------- | ------ | ---- | ---------------------- |
| 2/2   | hk1-4  | 1.34     | 1.43   | 1.54 | worker RPC timeout     |
| 2/2   | hk1-30 | 1.45     | 1.42   | 1.54 | worker RPC timeout     |
| 2/2   | hk1-29 | 0.85     | 1.42   | 1.54 | 45-minute step timeout |
| 1/2   | hk1-7  | 0.94     | 1.40   | 1.49 | passed                 |
| 2/2   | hk5-27 | 1.03     | 1.03   | 1.19 | passed                 |
| 1/2   | hk2-32 | 0.75     | 0.97   | 1.18 | passed                 |
| 1/2   | hk3-28 | 0.48     | 0.67   | 0.87 | passed                 |

The bands overlap. A host that passed reached 1.49, while a host that failed
started at 0.85 — occupancy grew during the run, and only two of the three
failing hosts were already contended when their suites began. No entry-time
threshold separates them, so a ceiling tight enough to catch the contended two
would also refuse hosts that demonstrably pass. `2.0` sits above every reading
measured on a host that completed its suites: it refuses a host none of these
samples survived, and leaves the RPC flake to the report-based retry above,
where the evidence does exist. Tightening it should be expected to produce false
refusals; raising it much further makes the gate inert.

The ceiling is a ratio, not an absolute load, because the pool mixes host sizes.
Set `off` to admit every host while the fleet is being resized. The gate runs
only on self-hosted Linux; GitHub-hosted and macOS lanes are unaffected, and an
unreadable CPU count or load average admits the job with a warning rather than
blocking a lane.

### Workspace test timeout

`QWEN_RELEASE_WORKSPACE_TIMEOUT_MINUTES` sets the job-level
`timeout-minutes` of each of the three `workspace_tests` shards in the release
pipeline. The timeout is sized by how busy the reserved host is rather than by
the suite itself, so raise it when the host is contended instead of assuming a
test regression.

### Vitest worker cap on self-hosted runners

`QWEN_CI_VITEST_MAX_WORKERS` caps the Vitest processes in the steps listed below
(`VITEST_MAX_THREADS` / `VITEST_MAX_FORKS`, with the matching minimum forced to
`1`) on the reserved self-hosted runners whose name starts with `ecs-qwen-`.
The variable is exported only by the main CI workspace-test step and the
release `workspace_tests` and `quality_scripts` steps; other
integration tests running Vitest that land on the same reserved pool in the CI
and release workflows do not consume it; they use their own Vitest limits.
The web-shell E2E smoke runs on the ARM64 pool with its own two Playwright
workers, so the cap does not apply to it. On GitHub-hosted runners
the variable is ignored and Vitest uses its own defaults.

Each Vitest run applies the cap on its own. The main CI workspace-test step
runs two lanes at once (`.github/scripts/ci/run-unit-test-lanes.sh`): the main
lane runs the CLI and core suites at the cap, and the side lane runs the other
workspaces' suites and `npm run test:scripts:unit` at half the cap, at least 1,
so at its peak the step runs the cap plus that half. On GitHub-hosted runners
the side lane's Vitest runs use 2 workers.

The step runs in two shards (`Linux unit tests (shard N/2)`), each passing
`--shard=N/2` to every one of those Vitest runs. The shards apply the cap on
their own too, so the pool sees up to two such steps at once. They install
without the `prepare` build and unpack the tree `test_build` built once.
`Test (ubuntu-latest, Node 22.x)` passes only when the build and every shard
pass.

`test_build` is the only job that builds. It builds through
`scripts/ci-build-cache.mjs`: a pull request restores the build its base
commit's `main` push saved (`key --at <base>`), falling back to the newest
cached build, and rebuilds only the workspaces whose inputs changed: a
workspace's tracked files other than tests, the root files, `patches/` and
`scripts/` outside `scripts/tests/`, and the workspaces it depends on. A push
to `main` always builds from scratch and saves that build. The cache key
carries no CPU architecture: the x64-labelled pool includes ARM64 hosts, and
the only architecture-specific output, the bundle's opentui native library,
is recopied for the host after every restore and unpack
(`ci-build-cache.mjs host-assets`).

The unit-test shards, the two `Integration Tests (no-AK, shard N/2)` shards
and the two web-shell smoke shards all unpack that one tree. `test_build`
also runs the checks that read it, the serve fast-path bundle closure, the
core subpath exports and the settings-schema freshness check, which
`Lint & Static` used to build for.
`Integration Tests (no-AK, No Sandbox)` passes only when the build and every
integration shard pass. A draft pull request skips the integration shards and
the browser smoke; marking it ready for review starts the run that includes
them. A change confined to `packages/managed-agent-server/` or
`packages/sdk-java/` (except the files TypeScript suites read) classifies as
`java_only`: `Lint & Static` runs its payload plus the `scripts/tests` suites
that name those trees, and the TypeScript build and test lanes skip.

### Related variables outside test execution

`release.yml` also exposes `QWEN_RELEASE_STATIC_TIMEOUT_MINUTES` (default `60`,
controlling the `quality_static` lint lane) and
`QWEN_RELEASE_BUILD_TIMEOUT_MINUTES` (default `45`, controlling the
`quality_build` packaging lane). Because they govern static linting and artifact
builds rather than test execution, they are outside this page's test execution scope.
