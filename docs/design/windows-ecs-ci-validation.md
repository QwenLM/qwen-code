# Windows ECS CI validation

## Goal

Run the required Windows test gate on the self-hosted ECS runner without weakening Windows-specific installer coverage.

## Failure classification

- Cross-platform assertions use platform-native paths and resolved fixture roots.
- POSIX-only filesystem contracts, such as executable mode bits, control bytes in file names, permission failures, and replacing an open file, remain covered on Linux and are skipped only where Windows cannot express the fixture.
- Tests for workflows whose jobs run exclusively on Linux are excluded from the Windows script suite. Linux CI remains their reachable producer and authoritative coverage.
- Cross-platform script tests remain enabled. POSIX-only subprocess fixtures are guarded individually instead of excluding their otherwise portable test files.

## Required Windows coverage

The Windows script suite continues to run `install-script.test.js`, including all nine Windows installer end-to-end cases and their security checks. Other script tests that already pass on Windows also remain enabled.

## Verification gate

The change is ready when formatting, lint configuration checks, targeted CLI and core tests, and the script suite pass locally where applicable, followed by a complete `npm run test:ci` on the Windows ECS runner.

## Operations

An offline ecs-win runner makes the job queue rather than fail, which blocks the merge queue until a maintainer intervenes. Setting the `MAINTAINER_ECS_RUNNER_DISABLED` repository variable to `true` routes the Windows gate back to `windows-2022`; runs already queued for the offline `ecs-win` label keep waiting (jobs do not re-evaluate `runs-on`, and `timeout-minutes` does not count queue time), so cancel or re-run those queued runs after flipping the switch. The fallback is not a byte-identical environment: the pre-checkout autocrlf step and the `configure-windows-runner` tuning (locale env, TEMP/TMP redirection, Git Bash on PATH) are self-hosted-only, so the hosted fallback runs the pre-migration job. A healthy-but-busy `ecs-win` fleet of one also serializes merge-queue entries that the hosted `windows-2022` pool ran in parallel, so concurrent queue entries wait for the single machine.
