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

| Variable                                 | Default | Used in                 | Controls                                                                                  |
| ---------------------------------------- | ------- | ----------------------- | ----------------------------------------------------------------------------------------- |
| `QWEN_CI_VITEST_RETRY`                   | `2`     | `ci.yml`                | Retry count for the main CI workspace and script test step                                |
| `QWEN_RELEASE_VITEST_RETRY`              | `2`     | `release.yml`           | Retry count for the release workspace test shards                                         |
| `QWEN_RELEASE_WORKSPACE_TIMEOUT_MINUTES` | `45`    | `release.yml`           | Job timeout of each release workspace test shard                                          |
| `QWEN_CI_VITEST_MAX_WORKERS`             | `4`     | `ci.yml`, `release.yml` | Worker cap for main CI unit tests and release workspace/quality tests on reserved runners |

### Retry counts

`QWEN_CI_VITEST_RETRY` and `QWEN_RELEASE_VITEST_RETRY` are passed to Vitest as
`--retry=<n>` in the main CI test step (`npm run test:ci:workspaces` and
`npm run test:scripts`) and on the release lane
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
release `workspace_tests` and `quality_scripts` steps; other Vitest
integration Vitest invocations that land on the same reserved pool in the CI
and release workflows do not consume it; they use their own Vitest limits.
The web-shell E2E smoke is pinned to `ubuntu-latest`, so the cap cannot apply
to it. On GitHub-hosted runners
the variable is ignored and Vitest uses its own defaults.

### Related variables outside test execution

`release.yml` also exposes `QWEN_RELEASE_STATIC_TIMEOUT_MINUTES` (default `60`,
controlling the `quality_static` lint lane) and
`QWEN_RELEASE_BUILD_TIMEOUT_MINUTES` (default `45`, controlling the
`quality_build` packaging lane). Because they govern static linting and artifact
builds rather than test execution, they are outside this page's test execution scope.
