# Hosted no-tool process gate

[English](2026-09-26-hosted-no-tool-process-gate.md) | [简体中文](2026-09-26-hosted-no-tool-process-gate.zh-CN.md)

Status: implemented for #12728 by #12733 and its review follow-up.

## Problem and baseline

The Hosted no-tool runtime in PR #12713 passed mocked tests while configuration initialization and stale prompt replay failed at the packaged CLI boundary. Initial independent verification used exact revision `5aa0b70526cc3bd5ebc32c247e44c6915f1734c5`, without production patches. After #12713 merged, this change was rebased onto its squash commit `879c311092f847e29539a9fc49dc7dbbabe0db63` on main, retaining only the process tests and CI gate.

## Proposed coverage

Add a focused integration suite that spawns `node dist/cli.js`, uses the existing deterministic OpenAI fixture and an HTTP adapter backed by the repository Session Store journal/resource implementation. Assert model request counts and contents, committed text/terminal order, retry receipts, cursor replay, failed/cancelled/empty A → successful B → C history, tool refusal without filesystem effects, private-profile rejection, and writer release on detach/close. Empty A is a thought-only reply: a completed turn without answer text, whose prompt is omitted like an unanswered one. Private-profile probes cover routes a default-profile daemon serves to the same token, with and without authentication, the ordinary shell route under the `/session/` prefix the Hosted routes share, an unauthenticated `/health`, and a Store connection naming another writer.

## Isolation and failure handling

Each case owns a temporary home, workspace and Store directory, loopback listeners on ephemeral ports, and a bounded child process. Temporary roots use the `qwen-e2e-home-` prefix, so the integration sweeper can reclaim any that a torn-down worker leaves behind. The sweep runs only in integration runs that own their scratch home and use the default temp directory. The required no-AK lane pins `QWEN_HOME`, the focused configuration has no global setup, and the E2E legs use a private temp directory, so none of them reclaims these roots. Use an allowlisted process environment and local fake credentials. Always terminate children, abort SSE readers, close fixture listeners and remove temporary state, including startup timeout and assertion failure. Retain bounded diagnostics on failure, and give teardown the same explicit hook budget in every configuration. Missing build prerequisites fail explicitly; this gate never skips for absent credentials.

## CI and database slice

Add a reproducible focused npm entry point and include it in the existing required no-AK PR gate, with build/bundle prerequisites and workflow guards. Add startup/bind/cleanup coverage to the existing macOS/Windows lanes. Separately exercise the real Java HostedHarnessClient against the packaged CLI and Spring private Store using isolated real MySQL; assert the engine/version so MariaDB or H2 cannot substitute. Keep Java/database evidence separate from fixture evidence.

The suite file is also collected by the `cli` path-filter lane (merge groups and releases) and by the E2E full-suite legs under the default configuration; its describe-level timeout and retry settings apply there too. The Java profiles split integration tests by family: `Hosted*IT` runs only in the MySQL job, which selects by profile rather than `-Dit.test`, and every other `*IT` stays in the MariaDB job. The SDK Java workflow also triggers on `packages/cli/src/config/**`, `packages/core/src/config/**` and `packages/core/src/core/**`, which the Hosted runtime loads. Replayed over main's commits from 2026-08-27 to 2026-09-26, that raises its trigger rate from about 32% to 42%, each run adding the MySQL job.

## Files and scope

Changes are limited to integration test helpers/cases/configuration, npm scripts, CI workflows and their guard tests, Java integration tests and their Maven test selection, and this design. No tools, approvals, output artifacts, public control-plane pipeline, kill/takeover recovery, uncertain turn replay, multi-instance failover, or production certification. No paid model calls.

## Validation and acceptance

Record exact SHA, platform, commands, results and omissions. Demonstrate separately that restoring configuration initialization and stale-history defects breaks the associated process regressions. Build, typecheck, run focused tests and workflow guards, then perform open-ended and reverse-evidence audits until two consecutive clean passes. A remote CI job must actually execute to count as evidence; skipped or unrun jobs do not count.

## Reproduction and recorded evidence

Install with `corepack pnpm install --frozen-lockfile` (its prepare step builds and bundles), or run `npm run build && npm run bundle` after a worktree bootstrap. Run `npm run test:integration:hosted:sandbox:none`. The portable subset is `npm run test:integration:hosted:sandbox:none -- -t 'portable startup'`.

For the database slice, install the `qwencode` and `runtime-broker` Maven modules, then run `mvn -f packages/sdk-java/managed-agent-server/pom.xml -Phosted-harness-mysql -Dqwen.cli.entry=<absolute-path-to-dist/cli.js> -Dmysql.url=<isolated-MySQL-JDBC-URL> -Dmysql.user=<user> -Dmysql.password=<password> verify checkstyle:check` using Java 21 and Node 22. The profile fails when prerequisites or tests are missing. The existing MariaDB profile excludes `Hosted*IT`; the new CI job supplies an ephemeral `mysql:8.4.6` service.

On 2026-09-26, macOS 26.5.1 arm64 / Node 22.22.2 independently passed all 7 fixture-backed process tests against production SHA `5aa0b70526cc3bd5ebc32c247e44c6915f1734c5` without production source changes. Removing `lenientToolWarmup: true` from the bundled model function restored the original initialization defect: the fresh-session test failed with zero model requests and `SkillManager not available`. Restoring the old `setHistory(history)` made both failed/cancelled history cases fail because B contained A. Restoring and rebuilding the bundle passed again; all 1303 bundle files matched the baseline checksums.

The separate Java 21 / Spring private Store / packaged CLI test passed against an isolated Oracle MySQL **8.4.6, MySQL Community Server - GPL**, with 1 integration test executed and 0 skipped. It covered create, close/load, prompt receipt replay, SSE reconnection, explicit cancellation and subsequent history, detach/load, and persisted writer generations. The temporary database process stopped and its data directory was removed. This is macOS evidence, separate from the local JSONL fixture.

After rebasing onto main `879c311092f847e29539a9fc49dc7dbbabe0db63`, full build, bundle and typecheck passed again. Both the focused and standard no-AK configurations passed all 7 process tests with zero skips. Reinstalling the Java dependencies from that revision and rerunning against isolated MySQL 8.4.6 passed 1 integration test and 86 Java unit tests with zero skips; Checkstyle and resource cleanup also passed.

Remote CI on the final #12733 head `fe524758a0bd4bf03d5a8582530b239654f06aa4` executed the required no-AK gate (206 passed, including the 7 Hosted cases, none skipped) and the MySQL 8.4.6 job (86 unit tests and 1 integration test). After merge, scheduled run 36265809340 on `d6f414190a` executed the portable smoke on macOS and self-hosted Windows, 2 passed with 5 filtered on each, and SDK Java push runs on main have passed the MySQL job since.

The review follow-up was verified on Debian 13 x86_64 / Node 22.22.2 at main `663d98eac5`. All 8 process cases passed. In the bundle, removing either Hosted route gate, the forced `/health` authentication at all three sites, the Store writer check or the empty-answer filter each failed only its intended case, while the previous 7-case suite passed every one of them. The original configuration and history defects still failed their cases, and all 1316 bundle files matched the baseline after restoration. Java 21.0.10 ran the Hosted profile without `-Dit.test` against docker `mysql:8.4` (8.4.11): 95 unit tests and 1 integration test passed, none skipped. The MariaDB 10.11.18 profile ran `ManagedAgentMySqlIT` alone. A temporary `HostedZzzProbeIT` ran only in the MySQL job. Under the previous POM it ran in the MariaDB job and was absent from the Hosted job.

## Limits

- Windows CI runs only the portable subset. The 7 cases of that time, fixture-backed ones included, passed on a GitHub-hosted `windows-2022` runner once #12718 made directory sync tolerant on Windows, as recorded in the second verification round of #12733. No QwenLM lane runs the fixture-backed cases, and the cases added later have run only on Linux.
- The macOS and Windows lanes run on merge group, schedule or dispatch, not on ordinary PRs.
- Core rejects a model stream without a finish reason (`NO_FINISH_REASON`) after about 20 s of retry backoff, before the Hosted guard sees it. The process gate does not include that case.
- Kill/takeover recovery, uncertain-turn replay, multi-instance failover and production readiness stay outside this gate; see #12740.
