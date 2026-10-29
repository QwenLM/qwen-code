# TUI parity CI efficiency

[English](2026-10-24-tui-parity-ci-efficiency.md) | [简体中文](2026-10-24-tui-parity-ci-efficiency.zh-CN.md)

## Problem and scope

The TUI parity workflow runs for every package change, including Java service-only PRs, and does not cancel superseded PR runs. Both gates build all workspaces. In run [39975710372](https://github.com/QwenLM/qwen-code/actions/runs/39975710372), the parity job took 22m33s, including 6m21s building and 13m02s in serial product acceptance. These are baseline observations, not promised savings.

This change optimizes scheduling and build scope without changing assertions, runner routing, artifact names, or the three runtime/renderer combinations.

## Decisions

- Group concurrency by workflow, event, and PR number. Cancel superseded PR runs, including both expensive jobs. Manual dispatches use their unique run ID and are never cancelled by another dispatch or PR update.
- Keep package-wide trigger coverage. Add shared build inputs, including integrations, patches, scripts, workspace configuration, Node configuration, and local CI actions/scripts, so narrowing builds cannot hide changes to their inputs.
- A lightweight hosted job uses the paginated PR-files API without checking out PR code. Skip the existing named parity and no-flicker jobs only when every changed path is under `packages/managed-agent-server/`, `packages/vscode-ide-companion/src/`, or `docs/`. Consider rename source paths as well. Any other path requires both gates; manual dispatch always requires them.
- Incomplete file counts, missing counts, or the API's 3,000-file limit require testing. A failed classification job does not skip the gates: their condition explicitly permits failed dependencies unless the workflow was cancelled. The failed classification still makes the workflow fail.
- Both gates use the existing `npm run build -- --cli-only`, which builds the CLI dependency closure and the runtime extras already specified by the build script. Installation, bundling, component checks, and all product tests remain intact.

## Constraints and deferred work

Do not parallelize the three product legs in this change. Integration global setup uses shared timestamp-named directories and cleanup, while the caller supplies one shared `QWEN_HOME`. ECS hosts also run several runners; current integration configuration intentionally limits workers, and editor tests contain subsecond timing assertions. Parallelism needs independent setup/cache/home lifecycles and evidence under real runner contention first.

The Java exclusion is deliberately narrow: other packages, including future CLI dependencies, still run. Mixed PRs with unrelated paths outside the three excluded subtrees may conservatively run. The Companion exclusion stops at `src/`: its package manifest, bundler config, and `scripts/` are inputs to the Companion build and to the bundled-CLI copy recorded in `bundlePaths.ts`, so those still run both gates. Existing workflow-level path filtering still means docs-only changes need not start this workflow; server-only changes start it and produce skipped named checks. The new lightweight job adds a hosted scheduling/API dependency. Shared build artifacts across jobs are deferred because platform/native dependency compatibility would require a wider change.

## Validation and acceptance

- Execute the actual embedded classifier in workflow meta-tests: Java plus docs skips; Companion source-only changes skip while its manifest, bundler config, and `scripts/` run; CLI, core, channels, new packages, build inputs, renames, and changes after the first API page run; incomplete diffs and dispatches run. Give every excluded subtree its own rename row, so narrowing only the rename arm cannot stay green.
- Pin PR-only cancellation, distinct dispatch groups, stable job names, failed-classification routing, and CLI-only build commands. Retain the existing timeout, strict unhandled-error, and artifact checks.
- Run workflow syntax validation, formatting, and relevant script tests.
- From a fresh dependency install, build the CLI closure and bundle, then exercise component parity, the offline no-flicker gate, and the existing serial product acceptance when local prerequisites permit. Record unavailable checks explicitly.
- Compare PR CI timing after publication. No fixed speedup is claimed before a completed CI run; local timings do not predict shared-runner queueing.

UI verification is not applicable: this changes CI scheduling and build selection, with no product source or interaction change. Existing TUI tests validate the selected build's consumers.
