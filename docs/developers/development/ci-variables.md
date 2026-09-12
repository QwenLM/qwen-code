# CI and Release Variables

Several knobs of the CI and release pipelines are exposed as GitHub Actions
repository variables (the `vars.*` context) so operators can retune them
without opening a pull request. This page lists the variables that affect test
execution in `.github/workflows/ci.yml` and `.github/workflows/release.yml`,
together with their defaults and where each one applies.

## Setting a variable

Repository maintainers set these under **Settings → Secrets and variables →
Actions → Variables**. An unset (or empty) variable always falls back to the
default listed below.

The workflow files are the source of truth for these levers:
`scripts/tests/release-workflow.test.js` pins the `release.yml` expressions
byte-for-byte, and this page mirrors them. If the two ever disagree, trust the
workflow and update this page in the same change.

## Variables

| Variable                                 | Default | Used in                 | Controls                                              |
| ---------------------------------------- | ------- | ----------------------- | ----------------------------------------------------- |
| `QWEN_CI_VITEST_RETRY`                   | `2`     | `ci.yml`                | Retry count for the main CI Vitest suites             |
| `QWEN_RELEASE_VITEST_RETRY`              | `2`     | `release.yml`           | Retry count for the release workspace test shards     |
| `QWEN_RELEASE_WORKSPACE_TIMEOUT_MINUTES` | `45`    | `release.yml`           | Job timeout of each release workspace test shard      |
| `QWEN_CI_VITEST_MAX_WORKERS`             | `4`     | `ci.yml`, `release.yml` | Vitest worker cap on the reserved self-hosted runners |

### Retry counts

`QWEN_CI_VITEST_RETRY` and `QWEN_RELEASE_VITEST_RETRY` are passed to Vitest as
`--retry=<n>` on the main CI lane (`npm run test:ci:workspaces` and
`npm run test:scripts`) and on the release lane
(`npm run test:release:workspaces`) respectively. The two lanes have separate
variables so they can be tuned independently.

Every attempt of a contended shard is a fresh roll: the same commit can fail
three disjoint test sets on a busy shared runner, while a real break fails all
attempts. The tradeoff is that a failure which recovers within the retry
budget greens the check and is not recorded as a failure by the flaky-rerun
tracker, so keep the budget modest instead of using retries to paper over a
flaky suite. Both variables also accept the literal value `off`, which omits
the `--retry` flag entirely instead of passing `--retry=0` (a command-line
`--retry=0` outranks a workspace's own Vitest config and would disable a
deliberate retry policy).

### Workspace test timeout

`QWEN_RELEASE_WORKSPACE_TIMEOUT_MINUTES` sets the job-level
`timeout-minutes` of each of the three `workspace_tests` shards in the release
pipeline. The timeout is sized by how busy the reserved host is rather than by
the suite itself, so raise it when the host is contended instead of assuming a
test regression.

### Vitest worker cap on self-hosted runners

`QWEN_CI_VITEST_MAX_WORKERS` caps each Vitest process
(`VITEST_MAX_THREADS` / `VITEST_MAX_FORKS`, with the matching minimum forced to
`1`) on the reserved self-hosted runners whose name starts with `ecs-qwen-`.
The variable is exported only by the main CI workspace-test step and the
release `workspace_tests` and `quality_scripts` steps; other Vitest
invocations that land on the same reserved pool (the web-shell E2E smoke and
the integration suites) do not consume it. On GitHub-hosted runners the
variable is ignored and Vitest uses its own defaults.
