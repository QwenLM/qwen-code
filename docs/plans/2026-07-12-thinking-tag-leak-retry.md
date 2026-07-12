# Thinking Tag Leak Retry Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Retry Qwen responses that start with structurally malformed thinking tags in visible content, without enabling tagged parsing, replaying committed output, or delaying healthy reasoning streams.

**Architecture:** Extend `GeminiChat`'s existing protocol-turn validation and retry path from #6683. A strictly bounded leading window checks exact `<think>` / `<thinking>` protocol tags for nested, mismatched, orphaned, or truncated structure before visible content or a tool call is emitted. Balanced and self-closing literal tags remain visible. Separate reasoning streams immediately unless an exact tag is structurally unresolved, in which case it is held until the attempt is known to be safe. Detection is disabled after externally visible output is committed so a later anomaly cannot replay text or tool side effects.

**Tech Stack:** TypeScript, Vitest, Qwen Code streaming pipeline, tmux CLI E2E with a deterministic local OpenAI-compatible SSE server.

### Task 1: Reproduce the production response in a failing test

**Files:**

- Modify: `packages/core/src/core/geminiChat.test.ts`

1. Add an end-to-end `GeminiChat` stream test whose first attempt contains a short visible prefix in one chunk, followed by the recorded thought text and visible malformed nested `<think>` content in later chunks, then a healthy second attempt.
2. Assert the first attempt is discarded, a retry event is emitted, only the healthy answer reaches history/recording, and the API is called twice.
3. Run the focused Vitest case and confirm it fails because only one API call occurs and leaked content is accepted.
4. Add separate coverage proving a tool call is suppressed in either part order while a tag prefix is unresolved, and that no replay occurs after visible content or a tool call has already been emitted.

### Task 2: Preserve the literal-tag boundary

**Files:**

- Modify: `packages/core/src/core/geminiChat.test.ts`

1. Add tests showing balanced and self-closing literal tags remain visible, including when reasoning is present and the literal tag spans stream chunks; verify unresolved-tag reasoning and non-text parts are released without loss once the response is safe.
2. Run the test and confirm the current behavior remains green.

### Task 3: Implement minimal response validation

**Files:**

- Modify: `packages/core/src/core/geminiChat.ts`

1. Add a small case-insensitive recognizer for the exact thinking protocol tag forms.
2. Hold only a strictly bounded response-leading visible prefix while exact tags are structurally unresolved, throw the existing retryable `PROTOCOL_TAG_LEAK` error only while the turn is still safe to replay, and stop detecting after visible content, non-text content, or a tool call is emitted.
3. Run the focused tests and confirm both the production retry case and literal boundary pass.

### Task 4: Verify regressions and real CLI behavior

**Files:**

- Create (ignored): `.qwen/e2e-tests/issue-6666-thinking-tag-retry.md`

1. Run focused GeminiChat, OpenAI converter, and pipeline tests.
2. Run build and typecheck.
3. Start a deterministic local SSE server that returns the exact bad attempt once and a valid answer on retry.
4. Run the built CLI in tmux, capture output/logs, and assert the bad tag/path/tool call are absent while the healthy answer and two server requests are present.
5. Run a second tmux case with normal streaming reasoning and no leaked tag, asserting a single request and a successful answer.

### Task 5: Review and publish

1. Run independent code review and address all blocking findings.
2. Re-run focused tests, build, typecheck, formatting/lint for touched files, and tmux E2E.
3. Commit with a conventional bugfix message.
4. Push the branch and create a PR that resolves #6666, explains why #6751's model-wide parser gate is not used, and includes the tmux report.
