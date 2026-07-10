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
