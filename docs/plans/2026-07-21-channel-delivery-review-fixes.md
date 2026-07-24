# Channel Delivery Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the actionable review findings on PR #7388 without adding durable delivery retries or allowing delivery diagnostics to affect Agent execution.

**Architecture:** Keep immediate delivery semantics. Add short-lived daemon-owned authorization for prompt and scheduled targets, preserve producer-specific execution, and keep logging as a best-effort observation side effect. Reuse the existing Channel worker IPC and public result event.

**Tech Stack:** TypeScript, ACP bridge, Express daemon routes, Channel worker IPC, Vitest.

## Global Constraints

- Delivery remains immediate and best-effort; no persistent outbox or retry queue.
- A delivery failure or a logging failure must not reject or delay the completed Prompt or scheduled Agent turn.
- Logs and events must not contain message text, target IDs, or credentials.
- Existing calls without `delivery` remain unchanged.

---

### Task 1: Restore CI capability coverage

**Files:**

- Modify: `integration-tests/cli/qwen-serve-routes.test.ts`

**Interfaces:**

- Consumes: `GET /capabilities` feature list.
- Produces: exact integration expectation including `channel_delivery`.

- [x] Add `channel_delivery` to the existing exact capability expectation.
- [x] Run the affected bundled-daemon integration file and verify all 35 cases pass.

### Task 2: Pin daemon-authorized delivery targets

**Files:**

- Create: `packages/cli/src/serve/channel-delivery-authorization.ts`
- Create: `packages/cli/src/serve/channel-delivery-authorization.test.ts`
- Modify: `packages/cli/src/serve/routes/session.ts`
- Modify: `packages/cli/src/serve/routes/scheduled-tasks.ts`
- Modify: `packages/cli/src/serve/scheduled-task-keepalive.ts`
- Modify: `packages/cli/src/serve/run-qwen-serve.ts`
- Modify: `packages/cli/src/serve/server.ts`
- Modify affected route, keepalive, and server tests.

**Interfaces:**

- Consumes: daemon-admitted Prompt `{sessionId, promptId, target}` and persisted scheduled task `{id, sessionId, recurring, lastFiredAt, delivery.target}`.
- Produces: one-shot `authorizePrompt`, scheduled `registerTask`, `revokeTask`, and callback `consume` checks that deep-compare the target before worker IPC.

- [x] Write failing tests proving an unregistered callback, changed target, repeated Prompt callback, and invalid/replayed scheduled fire are rejected before worker IPC.
- [x] Run the focused tests and confirm the expected authorization failures.
- [x] Implement an in-memory authorization store with Prompt consume-once behavior and scheduled monotonic-fire/one-shot behavior.
- [x] Wire Prompt admission, scheduled CRUD/rehydration, and the bound delivery handler to the store.
- [x] Run the focused tests and verify authorized Prompt, recurring, and one-shot deliveries still pass.

### Task 3: Preserve final-answer semantics across retries and failures

**Files:**

- Modify: `packages/cli/src/acp-integration/session/Session.ts`
- Modify: `packages/cli/src/acp-integration/session/Session.test.ts`
- Modify: `packages/cli/src/serve/run-qwen-serve.ts`
- Modify: `packages/cli/src/serve/run-qwen-serve.test.ts`

**Interfaces:**

- Consumes: Prompt and cron stream events plus resolved `channel_delivery_result` values.
- Produces: retry-safe final text, no delivery for non-`end_turn`/aborted turns, and best-effort sanitized daemon warning logs for non-delivered results.

- [x] Add failing Prompt and cron tests for retry collector rollback and cancelled/error non-delivery.
- [x] Add tests where delivery resolves `failed` or daemon logger output throws while the Agent turn remains normal.
- [x] Run focused Session tests and confirm each regression test fails for the intended reason.
- [x] Trim the collector at retry boundaries without awaiting delivery from the Agent turn.
- [x] Route failure diagnostics through a non-throwing sanitized daemon helper.
- [x] Run focused Session and daemon-handler tests and verify all cases pass.

### Task 4: Make worker shutdown and errors deterministic

**Files:**

- Modify: `packages/cli/src/commands/channel/daemon-worker.ts`
- Modify: `packages/cli/src/commands/channel/daemon-worker.test.ts`
- Modify: `packages/cli/src/serve/channel-delivery-ipc.ts`
- Modify: `packages/cli/src/serve/routes/channel-notify.ts`
- Modify corresponding ACP bridge and SDK event types/tests.

**Interfaces:**

- Consumes: active webhook/delivery promises and Channel adapter failures.
- Produces: one shared 10-second drain budget, typed unavailable errors, and a distinct provider-rejection code.

- [x] Add failing tests for concurrent drain, typed unavailable classification, and provider rejection not mapping to HTTP 400.
- [x] Run focused worker/route tests and confirm the expected failures.
- [x] Drain both active maps concurrently, throw/classify typed errors, and add `channel_delivery_rejected` across the wire contract.
- [x] Run focused worker, route, bridge, and SDK tests.

### Task 5: Remove local contract drift and repair Unicode coverage

**Files:**

- Modify: `packages/cli/src/serve/channel-delivery.ts`
- Modify: `packages/cli/src/serve/channel-delivery.test.ts`
- Modify: `packages/cli/src/acp-integration/session/Session.ts`

**Interfaces:**

- Consumes: arbitrary delivery text.
- Produces: one CLI truncation helper with surrogate-safe 100,000-code-unit output.

- [x] Correct the surrogate-boundary test so deleting the protection makes it fail.
- [x] Export and reuse the CLI text normalizer from Session.
- [x] Run both focused test files.

### Task 6: Full verification and PR update

**Files:**

- Inspect every changed and untracked file.

**Interfaces:**

- Consumes: completed implementation.
- Produces: verified branch suitable for maintainer rereview.

- [x] Run focused tests for every touched package.
- [x] Run `npm run build`, `npm run typecheck`, and `npm run lint`.
- [x] Run the bundled-daemon route integration test that failed in CI.
- [ ] Run real IM E2E for notify, Prompt final, scheduled final, and provider rejection using redacted credentials.
- [x] Perform two clean diff self-audit passes.
- [ ] Commit and deliver the fixes to the maintainer-selected branch without resolving or replying to review threads.
