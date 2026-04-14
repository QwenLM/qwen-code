## 2026-04-14 - early-input-capture-3224

- TDD plan:
  - add a startup-flow test that proves buffered chunks are threaded into the
    interactive keypress pipeline
  - add an `earlyInput` utility test that proves TTY-only capture buffers data
    and restores stdin raw mode on drain
  - add a `KeypressProvider` integration test that proves replayed chunks reach
    the prompt buffer
- Verify plan after implementation:
  - run targeted vitest files in `packages/cli`
  - run `npm run build`
  - run `npm run typecheck`
- TDD result:
  - red: missing `earlyInput` module, missing `startInteractiveUI` plumbing,
    missing `KeypressProvider` replay support
  - green: added `earlyInput` capture/drain utility, threaded buffered chunks
    through `startInteractiveUI`, and replayed them after the keypress
    listeners mount
- Fresh verification evidence:
  - `cd packages/cli && npx vitest run src/utils/earlyInput.test.ts src/ui/contexts/KeypressContext.replay.test.tsx src/gemini.test.tsx`
    -> 15 tests passed
  - `npm run build` -> passed
  - `npm run typecheck` -> passed
- Quality conclusion:
  - ready

## 2026-04-14 - review early-input-capture-3224

- Review type:
  - independent code review against issue #3224 acceptance criteria
- Strengths:
  - the branch correctly moved capture earlier into `packages/cli/index.ts`
  - the branch added focused unit coverage for buffer serialization and replay
- Issues:
  - Important: in the child process, `main()` still drains early input before it
    knows whether another relaunch will happen. When `QWEN_CODE_NO_RELAUNCH=true`,
    `relaunchAppInChildProcess()` returns immediately, so the chunks restored from
    `QWEN_CODE_EARLY_INPUT` are discarded instead of being passed to the UI. This
    leaves the real `node packages/cli/dist/index.js` path unfixed.
  - Important: the sandbox path still calls `drainEarlyInput()` and then jumps
    into `start_sandbox()` without forwarding buffered chunks, so startup typing
    is still lost whenever sandboxing is enabled.
  - Minor: the new tests all stub or bypass the production parent/child relaunch
    handoff, so they do not exercise the failing self-test path.
- Fresh verification evidence:
  - `cd packages/cli && npx vitest run src/utils/earlyInput.test.ts src/ui/contexts/KeypressContext.replay.test.tsx src/gemini.test.tsx`
    -> passed (16 tests)
  - static review of `packages/cli/src/gemini.tsx` and
    `packages/cli/src/utils/relaunch.ts` shows that the child process drains and
    drops the env-restored buffer before the interactive UI path
- Assessment:
  - not-ready

## 2026-04-14 - fix early-input-capture-3224 review findings

- TDD result:
  - red: added `gemini.tsx` tests proving the child no-relaunch path still
    discarded rehydrated startup input and the sandbox branch failed to forward
    buffered chunks
  - red-2: manual reproduction still showed a missing character because early
    input capture was still being drained before `loadCliConfig()` /
    `initializeApp()` / kitty detection completed
  - green: kept capture alive until the interactive UI actually mounts, while
    still forwarding serialized early input across relaunch and sandbox hops
- Fresh verification evidence:
  - `cd packages/cli && npx vitest run src/utils/earlyInput.test.ts src/ui/contexts/KeypressContext.replay.test.tsx src/gemini.test.tsx src/utils/relaunch.test.ts`
    -> passed (26 tests)
  - `cd packages/cli && npm run build`
    -> passed
  - manual spot-check:
    - `QWEN_CODE_NO_RELAUNCH=true node packages/cli/dist/index.js`
    - `node packages/cli/dist/index.js`
    - in both cases, `aaaaaaaa` typed immediately after process start appeared
      fully in the prompt after the UI mounted
- Quality conclusion:
  - ready
