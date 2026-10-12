# Managed child Agent panel E2E plan

[English](2026-10-12-managed-child-task-panel-e2e.md) | [简体中文](2026-10-12-managed-child-task-panel-e2e.zh-CN.md)

## Baseline

Use global `qwen --version` and `qwen serve --help` before implementation. This CLI baseline establishes runtime availability, not browser feature support. Launch a dedicated Web Shell Vite process on port 18480 and the existing Managed Java provider browser fixture. Before the change there is no child Agent tasks entry, despite the Java Session declaring `tasks: true`. Browser tests use a controlled BFF to force response loss and races; they are not proof of real Hosted execution.

## Browser groups

Run isolated Playwright contexts from `.qwen/e2e-tests/managed-child-task-panel-browser.mjs`; temporary browser state and screenshots stay in `.qwen/e2e-tests/`. Use the installed Chromium runtime. Each context owns its Session and operation map.

1. Compatibility: absent task capability and Daemon have no entry; Java without identity scope reads tasks but has no cancel action.
2. Browsing: mixed raw pages, an empty filtered page with a next page, previous navigation and scroll restoration; no invented task name or count. Open detail, state history and missing Artifact output; verify draft and history preservation and no transcript reload.
3. Layout/accessibility: wide container has a 360px side panel and editable composer; narrow container has a themed portal Dialog, keyboard access and focus restoration.
4. Cancellation: inline confirmation, one submit, completed command while task still running, draining, task cancellation, natural completion, failure and server contention. Sending follows the existing Session rules throughout.
5. Recovery: lost 202, refresh with intent only, explicit original-key replay, refresh with known operation ID, timeout and continue confirmation, recovery blocked, permission/query failure, storage refused. Unknown outcomes must never render failure or spawn a new key.
6. Isolation: delayed list/detail/event/operation responses after changing task, page, Session and account; two tabs competing; hidden/closed panel pauses ordinary reads while cancel recovery survives.
7. Events/Artifacts: expiry resets with a visible history gap; unknown types checkpoint without display, paged cursors are not replaced by task tails; authorized public Artifact refs use the existing reader.
8. Export boundary: rebuild the library and verify the read-only transcript carries no `managed.tasks.*` strings or lookups and remains below its existing JS budget. Verify task cancellation and elapsed-time translations still work in English and Chinese in the interactive shell.

9. Settlement races: delay list/detail refreshes after the cancel reader observes a terminal task. Both surfaces must publish the terminal snapshot immediately, offer no second cancellation, and reject late running snapshots. In the losing tab, stale admission contention disappears when the task ends; unknown command recovery and genuine command failures remain. Check that periodic reads do not repeatedly announce loading or disable pagination, and timestamps follow the selected language.

## Real Java and Hosted

Build and bundle the CLI, then run the current Java task read/cancel and Hosted child-Agent acceptance tests using JDK 21 and the local `dist/cli.js`. Exercise a real child task through the browser panel against a real Java service and Hosted Harness with a deterministic OpenAI-compatible model fixture. Verify stop admission separately from actual task settlement and verify parent continuation. A deterministic model is protocol/physical-execution evidence, not live-model quality evidence. Record any unexecuted scenario explicitly.

## Unit and release checks

Run affected client/provider/hook/component tests from `packages/web-shell`, plus isolated React 18 tests for ref and Dialog paths. Run root build, typecheck and bundle, focused ESLint/Prettier and generated-type drift checks. Read the full diff in two clean self-audit passes and obtain an independent code review. Publish the observed E2E results separately on the single draft PR; state macOS/Windows/Linux validation accurately.

## Observed results (2026-10-12)

The global qwen 0.25.0 availability baseline passed; the pre-change browser had no task entry despite `tasks: true`. The completed implementation passed 190 focused React 19 tests, 24 isolated React 18 tests and 73 Java task/cancel regressions. Controlled Chromium verification passed 10 main groups and 6 extra checks, including public Artifact preview, actual 30-second timeout, visibility pause/resume, two-tab contention and delayed Session responses. Root build, typecheck and bundle and the final Web Shell build/typecheck passed; generated types had no drift.

The first Ubuntu CI run exposed a transcript bundle-budget regression: 1,329,779 UTF-16 code units exceeded the unchanged 1,325,000 ceiling. The existing artifact test reproduced the same failure locally. Moving all 51 English and 51 Chinese task-panel entries into a separate dictionary, stubbed only in the transcript build, reduced the JS remainder to 1,324,541. The new bundle-boundary guard failed against the old artifact and passed against the rebuilt artifact. All 26 artifact tests and 97 focused translation/panel/recovery tests passed; the copy values and the size ceiling were preserved.

A real browser connected through a same-origin proxy to Java, Hosted Harness, Broker/worker and the child result relay. It submitted one cancel operation, observed a completed confirmed receipt while the task remained running/draining, then observed the task cancelled. The parent draft survived and the next parent Turn displayed `PARENT_CONTINUATION_OK`. The macOS rig used H2 in MySQL mode, a deterministic model and nondurable local workers. This proves this tested cancellation/continuation path; it does not establish Linux durable-worker recovery, full MySQL acceptance or live-model quality. Windows/Linux, React 18 browser rendering, native screen-reader output and mobile native WebViews were not tested. Scroll restoration was verified in component tests.

| Before                                                                 | Wide panel                                                                                  | Narrow Dialog                                                                     |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| ![No task entry](../design/assets/managed-child-task-panel-before.png) | ![Task panel beside conversation](../design/assets/managed-child-task-panel-after-wide.png) | ![Themed task Dialog](../design/assets/managed-child-task-panel-after-narrow.png) |

Reusable local commands are `node .qwen/e2e-tests/managed-child-task-panel-browser.mjs`, the same command with `--extras`, and the sequential `managed-child-task-hosted-launch.mjs` / `managed-child-task-panel-hosted-browser.mjs` under `.qwen/e2e-tests/`. Scripts and raw reports are ignored working artifacts; the PR's separate report publishes their results. The dedicated Vite and real Java/Hosted processes were stopped after verification.
