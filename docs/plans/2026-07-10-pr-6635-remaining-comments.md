# PR #6635 remaining comments implementation plan

**Goal:** Prevent a resolved-on-listen daemon from retaining its HTTP listener after channel worker startup fails, and verify worker base environments reach child processes.

**Architecture:** Keep generic runtime failures on their existing degraded-health path. When a requested channel worker fails during startup, begin a raw listener close before rejecting `runtimeReady`; retain its promise so a subsequent public close waits for the same drain instead of closing twice. Extend the existing supervisor spawn assertion with an explicit injected base environment value.

## Task 1: Close the listener after asynchronous runtime startup failure

**Files:**

- Modify: `packages/cli/src/serve/run-qwen-serve.test.ts`
- Modify: `packages/cli/src/serve/run-qwen-serve.ts`

- [x] Change the existing `resolveOnListen` worker-start failure test to assert `handle.server.listening` is false after `runtimeReady` rejects.
- [x] Run the focused test and confirm it fails because the listener remains open.
- [x] Mark only channel worker startup failures for listener closure; start `server.close` during failure cleanup, force-close existing connections, retain its drain promise, and log a close error without masking the startup error.
- [x] Make public `handle.close()` await that existing listener drain instead of attempting a second close.
- [x] Run the focused test and confirm the listener is no longer active.

## Task 2: Verify worker base environment propagation

**Files:**

- Modify: `packages/cli/src/serve/channel-worker-supervisor.test.ts`

- [x] Extend the existing spawned-worker environment test with `workerBaseEnv: { ...process.env, CUSTOM: 'value' }` and assert the spawn options contain `CUSTOM: 'value'`.
- [x] Run the focused supervisor test file.

## Final verification

- [x] Run both full affected test files, `npm run build`, `npm run typecheck`, `npm run lint`, and `git diff --check`.

## Task 3: Restore webhook dispatch through the worker group

**Files:**

- Modify: `packages/cli/src/serve/channel-worker-group.test.ts`
- Modify: `packages/cli/src/serve/channel-worker-group.ts`
- Modify: `packages/cli/src/serve/run-qwen-serve.test.ts`
- Modify: `packages/cli/src/serve/run-qwen-serve.ts`

- [x] Add a group test that calls `enqueueWebhookTask()` for a named channel and expects only that channel's owning supervisor to receive the task.
- [x] Run `cd packages/cli && npx vitest run src/serve/channel-worker-group.test.ts` and confirm the test fails because `ChannelWorkerGroup` has no `enqueueWebhookTask` method.
- [x] Add `enqueueWebhookTask: ChannelWorkerSupervisor['enqueueWebhookTask']` to `ChannelWorkerGroup`, resolve named selections to their owning entry, use the `all` entry for `--channel all`, and return `channel_worker_unavailable` when no group owns the task channel.
- [x] Add serve orchestration tests that capture the `createServeApp` dependencies, verify `enqueueChannelWebhookTask` forwards to the worker group, and preserve the no-worker structured-unavailable behavior.
- [x] Reconnect `enqueueChannelWebhookTask` in `run-qwen-serve.ts` and run both focused test files until green.

## Task 4: Fix the post-merge CI type failure

**Files:**

- Modify: `packages/cli/src/serve/channel-worker-group.test.ts`

- [x] Preserve the CI failure evidence: `tsc --build` reports TS2741 because `fakeRegistry()` predates the required `WorkspaceRegistry.add` method merged from `main`.
- [x] Add the minimal `add` test double to `fakeRegistry()`; no production behavior changes.
- [x] Run `cd packages/cli && npx tsc --noEmit` and confirm the missing-method error is gone.

## Final follow-up verification

- [x] Run the affected group and serve orchestration test files.
- [x] Run `npm run build && npm run typecheck`, `npm run lint`, and `git diff --check`.
- [x] Re-read all unresolved PR threads against the final diff and run repository code review.

## Task 5: Load webhook configuration from the owning workspace

**Files:**

- Modify: `packages/cli/src/serve/server.ts`
- Modify: `packages/cli/src/serve/run-qwen-serve.ts`
- Modify: `packages/cli/src/serve/run-qwen-serve.test.ts`

- [x] Extend the multi-workspace orchestration test with a webhook configured only in secondary workspace settings and confirm the deferred request fails with 401 on the primary-only lookup.
- [x] Derive webhook configuration sources from the frozen channel ownership plan, limited to the selected channel names for each workspace.
- [x] Use the owning workspace for deferred webhook secret authentication and load the same per-workspace sources when registering runtime routes.
- [x] Confirm the secondary webhook authenticates, starts the deferred runtime, dispatches only to the secondary supervisor, and returns 202.
- [x] Re-run full verification and code review before pushing.
