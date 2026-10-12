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

## Real Java and Hosted

Build and bundle the CLI, then run the current Java task read/cancel and Hosted child-Agent acceptance tests using JDK 21 and the local `dist/cli.js`. Exercise a real child task through the browser panel against a real Java service and Hosted Harness with a deterministic OpenAI-compatible model fixture. Verify stop admission separately from actual task settlement and verify parent continuation. A deterministic model is protocol/physical-execution evidence, not live-model quality evidence. Record any unexecuted scenario explicitly.

## Unit and release checks

Run affected client/provider/hook/component tests from `packages/web-shell`, plus isolated React 18 tests for ref and Dialog paths. Run root build, typecheck and bundle, focused ESLint/Prettier and generated-type drift checks. Read the full diff in two clean self-audit passes and obtain an independent code review. Publish the observed E2E results separately on the single draft PR; state macOS/Windows/Linux validation accurately.
