# Daemon Turn Status Blocker Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the eight confirmed correctness blockers on PR #8682 without expanding the change to unresolved Suggestions.

**Architecture:** Preserve the existing HTTP routes, persisted `turn_result` format, and bounded terminal overlay. Normalize controlled cancellation at its source, keep pending-list live state aligned with formal terminal publication, make result capture accept only canonical answer emissions, reset rewrite state at automatic-turn ownership boundaries, and map an empty transcript to “no persisted result.”

**Tech Stack:** TypeScript, ACP bridge/session runtime, Vitest, JSONL transcript reader.

## Global Constraints

- Work from exact PR head `20a9dd451c1acc198a96e8f936f1b0256f2e5942` in the isolated worktree.
- Change only confirmed Critical behavior; defer unresolved Suggestions.
- Preserve route paths, response schema, authorization, memory bounds, and transcript scan bounds.
- Add a failing regression test before each production change.
- Run tests from the owning package directory.
- Do not force-push.

---

### Task 1: Normalize controlled prompt cancellation

**Files:**

- Modify: `packages/cli/src/acp-integration/session/Session.ts`
- Test: `packages/cli/src/acp-integration/session/Session.test.ts`

**Interfaces:**

- Consumes: `AbortSignal.reason`, `USER_CANCEL_ABORT_REASON`, and `SESSION_DISPOSE_ABORT_REASON`.
- Produces: one shared controlled-cancellation predicate used by stream gates and the outer recording classifier.

- [ ] Add a test where `dispose()` aborts a non-stream signal-aware await and assert the persisted state is `cancelled`.
- [ ] Run the focused test and verify it fails with persisted state `error`.
- [ ] Add a test where a successor supersedes a predecessor whose await rejects on abort and assert the predecessor persists `cancelled`.
- [ ] Run the focused test and verify it fails with persisted state `error`.
- [ ] Abort the predecessor with an explicit controlled reason and reuse one cancellation predicate in all classifiers.
- [ ] Run the focused tests and the complete `Session.test.ts` file.

### Task 2: Preserve deadline recovery and terminal polling precedence

**Files:**

- Modify: `packages/acp-bridge/src/bridge.ts`
- Test: `packages/acp-bridge/src/bridge.test.ts`

**Interfaces:**

- Consumes: `PendingPromptEntry.removed`, `terminalPublished`, deadline rejection, and the terminal overlay.
- Produces: prompt polling that never reports a terminal prompt as live and a running removal that retains its deadline recovery fence.

- [ ] Add a test that removes a running prompt whose agent ignores cancellation, advances past its deadline, and verifies the FIFO dispatches the successor.
- [ ] Run the test and verify the successor remains blocked.
- [ ] Add a test that expires a queued prompt behind a wedged predecessor and verifies by-id polling returns `prompt_deadline_exceeded`, not `queued`.
- [ ] Run the test and verify it reports `queued`.
- [ ] Separate “status terminal published” from “deadline recovery completed”: do not let running removal suppress deadline cleanup, and exclude formally terminal entries from live polling.
- [ ] Run the focused tests and the complete `bridge.test.ts` file.

### Task 3: Capture only the canonical visible answer

**Files:**

- Modify: `packages/cli/src/acp-integration/session/Session.ts`
- Modify: `packages/cli/src/acp-integration/session/rewrite/MessageRewriteMiddleware.ts`
- Test: `packages/cli/src/acp-integration/session/Session.test.ts`
- Test: `packages/cli/src/acp-integration/session/rewrite/MessageRewriteMiddleware.test.ts`

**Interfaces:**

- Consumes: `MessageRewriteEmissionContext`, rewrite target, update metadata, and automatic-turn boundaries.
- Produces: result segments where only a message rewrite can replace a raw answer segment and automatic-turn residue cannot cross into a daemon prompt.

- [ ] Add a test showing the token-limit diagnostic is visible on the wire but absent from persisted `resultText`; verify it fails.
- [ ] Add a `target: 'thought'` test proving the persisted result remains the raw answer; verify it fails with rewritten thought text.
- [ ] Add an aborted cron/notification residue test proving the next daemon prompt rewrites only its own answer; verify it fails with cross-turn content.
- [ ] Tag internal diagnostics as non-answer status output.
- [ ] Extend the internal rewrite context with whether the rewrite replaces message text, and gate replacement on that field.
- [ ] Add a middleware reset method that clears buffered turn state without emitting a rewrite, and invoke it after automatic work has drained and before publishing a daemon turn recording.
- [ ] Run the focused tests, then both complete test files.

### Task 4: Treat an empty transcript as no persisted turn

**Files:**

- Modify: `packages/cli/src/acp-integration/acpAgent.ts`
- Test: `packages/cli/src/acp-integration/acpAgent.test.ts`

**Interfaces:**

- Consumes: `SessionTranscriptSnapshotUnavailableError` from a zero-record transcript.
- Produces: `{ v: 1, sessionId, turnResult: null }` only for the initial empty snapshot while preserving typed failures for unavailable non-empty snapshots and oversized transcripts.

- [ ] Add a test whose turn-status reader throws `SessionTranscriptSnapshotUnavailableError` for an empty snapshot and assert `turnResult: null`; verify it fails.
- [ ] Implement the narrow empty-snapshot mapping without swallowing oversized-page or cursor errors.
- [ ] Run the focused test and complete `acpAgent.test.ts` file.

### Task 5: Verify, self-audit, commit, and push

**Files:**

- Review all files changed by Tasks 1–4 and this plan.

**Interfaces:**

- Consumes: all four independently green task groups.
- Produces: a verified commit on `feat/daemon-turn-status-polling`.

- [ ] Run package-focused tests for every changed test file.
- [ ] Run `npm run build` and `npm run typecheck` from the repository root.
- [ ] Run `npm run test:integration:cli:sandbox:none` and the daemon polling E2E scenarios where available.
- [ ] Perform two consecutive clean diff self-audit passes, resetting the count after any edit.
- [ ] Commit only the reviewed files with a Conventional Commit message.
- [ ] Fetch and verify the remote PR head has not moved, then push without force to `origin/feat/daemon-turn-status-polling`.
