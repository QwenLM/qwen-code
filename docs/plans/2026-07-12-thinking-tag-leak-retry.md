# Thinking Tag Leak Retry Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Retry Qwen responses that mix a separate reasoning channel with leaked `<think>` tags in visible content, without enabling tagged parsing or delaying healthy reasoning streams.

**Architecture:** Extend `GeminiChat`'s existing protocol-turn validation and retry path from #6683. A response is invalid when visible text contains nested, mismatched, orphaned, or truncated think-family tags; balanced and self-closing literal tags remain visible. A streaming detector buffers only a potentially tagged block, so healthy reasoning and visible text continue streaming immediately.

**Tech Stack:** TypeScript, Vitest, Qwen Code streaming pipeline, tmux CLI E2E with a deterministic local OpenAI-compatible SSE server.

### Task 1: Reproduce the production response in a failing test

**Files:**

- Modify: `packages/core/src/core/geminiChat.test.ts`

1. Add an end-to-end `GeminiChat` stream test whose first attempt contains the recorded thought text, visible malformed nested `<think>` content, and malformed tool-call shape, followed by a healthy second attempt.
2. Assert the first attempt is discarded, a retry event is emitted, only the healthy answer reaches history/recording, and the API is called twice.
3. Run the focused Vitest case and confirm it fails because only one API call occurs and leaked content is accepted.

### Task 2: Preserve the literal-tag boundary

**Files:**

- Modify: `packages/core/src/core/geminiChat.test.ts`

1. Add a test showing `<think>example</think>` remains visible when the response has no thought part.
2. Run the test and confirm the current behavior remains green.

### Task 3: Implement minimal response validation

**Files:**

- Modify: `packages/core/src/core/geminiChat.ts`

1. Add a small case-insensitive think-family tag recognizer.
2. Before recording/history persistence, throw the existing retryable `PROTOCOL_TAG_LEAK` error when consolidated visible text contains such a tag and the same turn has non-empty thought text.
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
