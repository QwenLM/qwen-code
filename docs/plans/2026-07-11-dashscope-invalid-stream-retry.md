# DashScope Invalid Stream Retry Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Qwen Code tolerate up to four consecutive transient invalid model streams before surfacing `InvalidStreamError`.

**Architecture:** Keep the existing provider-independent `InvalidStreamError` validation and retry path. Increase only its independent retry budget, preserving the existing linear delay and abort behavior; prove the change with stream factories that return a fresh async generator for every attempt.

**Tech Stack:** TypeScript, Vitest, fake timers, Qwen Code core streaming pipeline.

### Task 1: Add the regression test

**Files:**

- Modify: `packages/core/src/core/geminiChat.test.ts`

**Step 1: Write the failing test**

Add a test under `sendMessageStream with retries` that returns four fresh invalid streams followed by a valid response. Assert five generator calls, four retry telemetry events, a successful response chunk, and clean two-turn history.

**Step 2: Run the focused test to verify it fails**

Run: `cd packages/core && npx vitest run src/core/geminiChat.test.ts -t "should recover after four consecutive invalid streams"`

Expected: FAIL because the current two-retry budget stops after three calls.

### Task 2: Increase the invalid-stream retry budget

**Files:**

- Modify: `packages/core/src/core/geminiChat.ts`
- Modify: `packages/core/src/core/geminiChat.test.ts`

**Step 1: Implement the minimal change**

Change `INVALID_STREAM_RETRY_CONFIG.maxRetries` from `2` to `4`.

**Step 2: Update the persistent-failure assertions**

Update the existing persistent invalid-content test to expect five total stream calls and four retry telemetry events.

**Step 3: Run focused tests to verify they pass**

Run: `cd packages/core && npx vitest run src/core/geminiChat.test.ts -t "sendMessageStream with retries"`

Expected: PASS.

### Task 3: Verify the change

**Files:**

- Verify: `packages/core/src/core/geminiChat.ts`
- Verify: `packages/core/src/core/geminiChat.test.ts`

**Step 1: Run the full affected test file**

Run: `cd packages/core && npx vitest run src/core/geminiChat.test.ts`

Expected: PASS.

**Step 2: Run repository checks**

Run: `npm run lint`, `npm run typecheck`, and `npm run build` from the worktree root.

Expected: all commands exit successfully.

**Step 3: Review the diff**

Check that the change is limited to the retry budget, its regression coverage, and these planning artifacts.

**Step 4: Commit**

Run: `git add docs/plans/2026-07-11-dashscope-invalid-stream-retry.md packages/core/src/core/geminiChat.ts packages/core/src/core/geminiChat.test.ts && git commit -m "fix(core): tolerate repeated invalid model streams"`
