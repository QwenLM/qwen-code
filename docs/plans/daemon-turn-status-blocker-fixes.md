# Daemon Turn Status Bounded-History Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make exact `sessionId + promptId` polling reliable for every active-history turn inside the existing bounded transcript scan window.

**Architecture:** Keep the existing HTTP routes and JSONL transcript. Use the transcript as the bounded durable source, retain only a small transient terminal overlay, and make every normally admitted terminal path append the same bounded `turn_result` shape. Fold the review comments into seven root-cause fixes rather than adding independent stores or state machines.

**Tech Stack:** TypeScript, ACP bridge/session runtime, Vitest, JSONL transcript reader, real daemon integration tests.

## Global Constraints

- Work from exact PR head `3493ae055c0a4440c51a9013d3f47493381475bd`.
- “Within the system limit” means the current active transcript chain scanned backward for at most 10 pages × 500 records, with 4 MiB per page.
- Preserve `GET /session/:id/turns/:promptId` and `/turns/current`, client-id authorization, and the 32,768-character prompt/result cap.
- Agent-side model settlement keeps the existing best-effort recording behavior; bridge-owned pre-dispatch outcomes are acknowledged only after their strict transcript write succeeds.
- No database, unbounded daemon history, cron-result routing, or prompt-count index.
- Add and run a failing regression test before each production behavior change.
- Tests run from the owning package directory; integration tests run through the repository scripts or from `integration-tests/`.
- Do not commit, push, reply, resolve threads, rerun CI, or modify the PR without separate authorization.

---

### Task 1: Fix deterministic capability CI failure

**Files:**

- Modify: `integration-tests/cli/qwen-serve-routes.test.ts`

**Interfaces:**

- Consumes: `SERVE_CAPABILITY_REGISTRY` order.
- Produces: integration baseline containing `session_turn_status` immediately after `session_status`.

- [ ] Run the integration capability test and capture the expected missing-feature failure.
- [ ] Add only `session_turn_status` to the expected ordered list.
- [ ] Re-run the focused integration file and verify it passes.

### Task 2: Bound and race-proof terminal status resolution

**Files:**

- Modify: `packages/acp-bridge/src/bridge.ts`
- Modify: `packages/acp-bridge/src/bridgeTypes.ts`
- Test: `packages/acp-bridge/src/bridge.test.ts`

**Interfaces:**

- Consumes: live pending entries, persisted `turn_result`, and recent formal terminal outcomes.
- Produces: a small fixed overlay that is re-read after the transcript RPC and evicted when persistence is visible.

- [ ] Add a failing test where a terminal is published while `sessionTurnStatus` is awaiting and assert the post-await terminal wins.
- [ ] Add a failing capacity test independent of `eventRingSize` and a persisted-match eviction test.
- [ ] Introduce one small named overlay limit, re-read after await, and delete matching overlay entries after persisted enrichment.
- [ ] Run focused tests and the complete `bridge.test.ts` file.

### Task 3: Persist all normally admitted terminal paths

**Files:**

- Modify: `packages/acp-bridge/src/bridge.ts`
- Modify: `packages/acp-bridge/src/status.ts`
- Modify: `packages/cli/src/acp-integration/acpAgent.ts`
- Modify: `packages/cli/src/acp-integration/session/Session.ts`
- Modify: `packages/core/src/services/chatRecordingService.ts`
- Test: corresponding collocated test files.

**Interfaces:**

- Consumes: trusted `InvocationContextV1`, bridge pre-dispatch cancellation/error terminals, and `ChatRecordingService.recordTurnResult`.
- Produces: one bounded persisted record for queued cancellation and for every failure after bridge admission but before model dispatch.

- [ ] Add failing restart-oriented tests for queued cancellation and pre-record `assertCanStartTurn`/live-tool failure.
- [ ] Add a trusted child control method that appends a bridge-owned pre-dispatch terminal through the existing recording service; do not add a new file/store.
- [ ] Validate invocation session ownership before recording, create the recording before fallible child admission checks, and settle every exit path.
- [ ] Make `startedAt` optional until actual model dispatch and update projections/tests.
- [ ] Run focused bridge, agent, Session, and recording-service tests.

### Task 4: Normalize bounded terminal errors

**Files:**

- Modify: `packages/core/src/services/chatRecordingService.ts`
- Modify: `packages/acp-bridge/src/bridge.ts`
- Modify: `packages/cli/src/acp-integration/session/Session.ts`
- Test: corresponding collocated test files.

**Interfaces:**

- Consumes: arbitrary thrown values from provider/tool/ACP paths.
- Produces: a non-throwing error payload with bounded message/code and explicit truncation metadata, shared by persisted and overlay projections.

- [ ] Add failing tests for oversized message/code and throwing coercion/getters.
- [ ] Implement one core-safe terminal-error normalizer and use it on both sides.
- [ ] Verify oversized error records remain below transcript page limits and expose truncation flags.
- [ ] Run focused tests.

### Task 5: Preserve canonical visible-answer and terminal consistency

**Files:**

- Modify: `packages/cli/src/acp-integration/session/Session.ts`
- Modify: `packages/cli/src/acp-integration/session/rewrite/MessageRewriteMiddleware.ts`
- Test: `Session.test.ts` and `MessageRewriteMiddleware.test.ts`.

**Interfaces:**

- Consumes: raw answer chunks, rewritten replacements, diagnostic/status messages, prompt cancellation, and live-end cleanup.
- Produces: `resultText` equal to the final primary answer the user could observe.

- [ ] Add failing tests proving repeated-tool diagnostics are visible and rewrite-aware but excluded from `resultText`.
- [ ] Add failing tests for model error during an in-flight rewrite and cancellation immediately before rewrite delivery/commit.
- [ ] Route diagnostics with explicit non-answer metadata through the rewrite-aware path.
- [ ] Drain or discard the owning rewrite before settlement and re-check abort immediately before send and commit.
- [ ] Include awaited live-end cleanup in the terminal outcome so a later cleanup rejection cannot follow an already persisted `completed` result.
- [ ] Run both complete test files.

### Task 6: Keep fork and rewind identities consistent

**Files:**

- Modify: `packages/core/src/services/sessionService.ts`
- Modify: `packages/acp-bridge/src/bridge.ts`
- Test: `sessionService.test.ts` and `bridge.test.ts`.

**Interfaces:**

- Consumes: active transcript reconstruction, fork record copying, and successful rewind response.
- Produces: forks without source-session `turn_result` identity and rewinds without abandoned overlay terminals.

- [ ] Add a failing fork test proving a source `turn_result` is not copied.
- [ ] Add a failing rewind test proving an abandoned overlay result is no longer returned while surviving active transcript results remain readable.
- [ ] Exclude `turn_result` from fork copies and clear/reconcile terminal overlay immediately after successful transcript rewind.
- [ ] Run both complete test files.

### Task 7: Full verification and review

**Files:**

- Review every changed and untracked file.

**Interfaces:**

- Consumes: all green task groups.
- Produces: a verified commit and non-force push after explicit user authorization.

- [ ] Run all focused test files from their package directories.
- [ ] Run formatting on changed files, inspect formatting changes, then `npm run lint`, `npm run build`, `npm run typecheck`, and `npm run bundle`.
- [ ] Run the six dedicated real-daemon scenarios for capability, completed result polling, the full public turn-state matrix, restart durability, diagnostic/result isolation, late-rewrite cancellation, and provider error polling.
- [ ] Ask the read-only test-engineer agent to audit every Critical as either public-daemon E2E or a deterministic component-level fault-injection regression.
- [ ] Perform two consecutive clean full-diff self-audit passes; any edit resets the count.
- [ ] Re-fetch PR head/state, confirm the reviewed base has not moved, then commit and push without force.
