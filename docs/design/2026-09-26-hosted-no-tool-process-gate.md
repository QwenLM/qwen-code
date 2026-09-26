# Hosted no-tool process gate

[English](2026-09-26-hosted-no-tool-process-gate.md) | [简体中文](2026-09-26-hosted-no-tool-process-gate.zh-CN.md)

Status: implementation for #12728.

## Problem and baseline

The Hosted no-tool runtime in PR #12713 passed mocked tests while configuration initialization and stale prompt replay failed at the packaged CLI boundary. Initial independent verification used exact revision `5aa0b70526cc3bd5ebc32c247e44c6915f1734c5`, without production patches. After #12713 merged, this change was rebased onto its squash commit `879c311092f847e29539a9fc49dc7dbbabe0db63` on main, retaining only the process tests and CI gate.

## Proposed coverage

Add a focused integration suite that spawns `node dist/cli.js`, uses the existing deterministic OpenAI fixture and an HTTP adapter backed by the repository Session Store journal/resource implementation. Assert model request counts and contents, committed text/terminal order, retry receipts, cursor replay, failed/cancelled A → successful B → C history, tool refusal without filesystem effects, private-profile rejection, and writer release on detach/close.

## Isolation and failure handling

Each case owns a temporary home, workspace and Store directory, loopback listeners on ephemeral ports, and a bounded child process. Use an allowlisted process environment and local fake credentials. Always terminate children, abort SSE readers, close fixture listeners and remove temporary state, including startup timeout and assertion failure. Retain bounded diagnostics on failure. Missing build prerequisites fail explicitly; this gate never skips for absent credentials.

## CI and database slice

Add a reproducible focused npm entry point and include it in the existing required no-AK PR gate, with build/bundle prerequisites and workflow guards. Add startup/bind/cleanup coverage to the existing macOS/Windows lanes. Separately exercise the real Java HostedHarnessClient against the packaged CLI and Spring private Store using isolated real MySQL; assert the engine/version so MariaDB or H2 cannot substitute. Keep Java/database evidence separate from fixture evidence.

## Files and scope

Changes are limited to integration test helpers/cases/configuration, npm scripts, CI workflows and their guard tests, Java integration tests, and this design. No tools, approvals, output artifacts, public control-plane pipeline, kill/takeover recovery, uncertain turn replay, multi-instance failover, or production certification. No paid model calls.

## Validation and acceptance

Record exact SHA, platform, commands, results and omissions. Demonstrate separately that restoring configuration initialization and stale-history defects breaks the associated process regressions. Build, typecheck, run focused tests and workflow guards, then perform open-ended and reverse-evidence audits until two consecutive clean passes. A remote CI job must actually execute to count as evidence; skipped or unrun jobs do not count.

## Reproduction and recorded evidence

Install with `corepack pnpm install --frozen-lockfile` (its prepare step builds and bundles), or run `npm run build && npm run bundle` after a worktree bootstrap. Run `npm run test:integration:hosted:sandbox:none`. The portable subset is `npm run test:integration:hosted:sandbox:none -- -t 'portable startup'`.

For the database slice, install the `qwencode` and `runtime-broker` Maven modules, then run `mvn -f packages/sdk-java/managed-agent-server/pom.xml -Phosted-harness-mysql -Dit.test=HostedHarnessMySqlIT -Dqwen.cli.entry=<absolute-path-to-dist/cli.js> -Dmysql.url=<isolated-MySQL-JDBC-URL> -Dmysql.user=<user> -Dmysql.password=<password> verify checkstyle:check` using Java 21 and Node 22. The profile fails when prerequisites or tests are missing. The existing MariaDB profile excludes this test; the new CI job supplies an ephemeral `mysql:8.4.6` service.

On 2026-09-26, macOS 26.5.1 arm64 / Node 22.22.2 independently passed all 7 fixture-backed process tests against production SHA `5aa0b70526cc3bd5ebc32c247e44c6915f1734c5` without production source changes. Removing `lenientToolWarmup: true` from the bundled model function restored the original initialization defect: the fresh-session test failed with zero model requests and `SkillManager not available`. Restoring the old `setHistory(history)` made both failed/cancelled history cases fail because B contained A. Restoring and rebuilding the bundle passed again; all 1303 bundle files matched the baseline checksums.

The separate Java 21 / Spring private Store / packaged CLI test passed against an isolated Oracle MySQL **8.4.6, MySQL Community Server - GPL**, with 1 integration test executed and 0 skipped. It covered create, close/load, prompt receipt replay, SSE reconnection, explicit cancellation and subsequent history, detach/load, and persisted writer generations. The temporary database process stopped and its data directory was removed. This is macOS evidence, separate from the local JSONL fixture.

After rebasing onto main `879c311092f847e29539a9fc49dc7dbbabe0db63`, full build, bundle and typecheck passed again. Both the focused and standard no-AK configurations passed all 7 process tests with zero skips. Reinstalling the Java dependencies from that revision and rerunning against isolated MySQL 8.4.6 passed 1 integration test and 86 Java unit tests with zero skips; Checkstyle and resource cleanup also passed.

## Open evidence

The prerequisite PR has merged and this PR now targets main. Remote CI acceptance still requires a successful run on the final workflow revision. Linux and Windows execution remain unverified locally, and the existing macOS/Windows CI lanes run on merge-group, schedule or dispatch rather than ordinary PRs. The required no-AK PR job includes all process cases. Kill/takeover recovery and production readiness remain outside this verification.
