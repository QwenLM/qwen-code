# Channel Delivery Final-Only Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver only the final tool-free assistant response block for Prompt and scheduled turns, and report successful empty finals as an authorized `skipped` session event.

**Architecture:** Carry a turn-local delivery capture through Prompt, cron, and automatic-continuation call stacks. Each model send creates an isolated response block; tool-producing blocks are discarded and the last tool-free block becomes the final candidate. Successful empty finals traverse the existing reverse-control seam, where the daemon consumes authorization before returning `skipped` without worker IPC.

**Tech Stack:** TypeScript, ACP reverse extMethod, daemon authorization store, per-session SSE EventBus, Vitest.

## Global Constraints

- Do not change direct Notify or Channel Webhook execution semantics.
- Do not add persistence, an outbox, retry, replay, or a global final-answer hook.
- Cancellation, Agent error, and token-limit termination must submit no delivery result.
- Delivery failure and diagnostic logging must remain isolated from Agent completion.
- Events and logs must not contain message text, target IDs, or credentials.

---

### Task 1: Lock final-response semantics with failing Session tests

**Files:**

- Modify: `packages/cli/src/acp-integration/session/Session.test.ts`

**Interfaces:**

- Consumes: streamed assistant chunks, function calls, retry/fallback events, and successful `end_turn`.
- Produces: one reverse-control request whose `text` is the last tool-free response block, or `''` for an empty successful final.

- [ ] Add a Prompt test with `"I will inspect" + tool call`, tool result, then `"final answer"`; assert delivery text is exactly `"final answer"`.
- [ ] Add the same scheduled-turn regression test.
- [ ] Add Prompt and scheduled successful-empty tests that assert one `qwen/control/channel-delivery` call with `text: ''`.
- [ ] Run `cd packages/cli && npx vitest run src/acp-integration/session/Session.test.ts` and verify the final-only tests fail with accumulated intermediate text while empty-final tests fail because no reverse-control call occurs.

### Task 2: Capture one model response block at a time

**Files:**

- Modify: `packages/cli/src/acp-integration/session/Session.ts`
- Test: `packages/cli/src/acp-integration/session/Session.test.ts`

**Interfaces:**

- Produces: turn-local `{ finalText }` capture passed through `#executePrompt`, `#handleStopHookLoop`, and `#runStopContinuation`.
- Produces: per-send chunk arrays supporting retry rollback and a commit decision based on `functionCalls.length === 0`.

- [ ] Replace the Session-wide collector field with a turn-local capture created only when delivery metadata exists.
- [ ] Begin a response block only after a model stream is obtained; beginning a later block clears the previous candidate.
- [ ] Append non-thought chunks to the current block and roll back only that block on non-continuation retry/model fallback.
- [ ] Commit the block only when the completed stream has no function calls; otherwise leave the final candidate empty until a later send completes.
- [ ] Submit the final candidate once for successful Prompt/scheduled `end_turn`, without an empty-text guard.
- [ ] Re-run the focused Session test and verify all delivery and existing cancellation/error/retry tests pass.

### Task 3: Consume authorization before reporting skipped

**Files:**

- Modify: `packages/acp-bridge/src/bridgeOptions.ts`
- Modify: `packages/acp-bridge/src/bridgeClient.ts`
- Modify: `packages/acp-bridge/src/bridgeClient.test.ts`
- Modify: `packages/cli/src/serve/run-qwen-serve.ts`
- Modify: `packages/cli/src/serve/run-qwen-serve.test.ts`

**Interfaces:**

- Changes: `ChannelDeliveryHostResult` adds `{ status: 'skipped' }`.
- Changes: `ChannelDeliveryHandler` always validates/consumes daemon authorization, including empty text.
- Preserves: `channel_delivery_result` SSE schema already accepts `status: 'skipped'`.

- [ ] Change the BridgeClient empty-text test to require host invocation and fail on the current short circuit.
- [ ] Add a bound-handler test proving empty text returns `skipped`, does not resolve/call a worker, and consumes Prompt authorization.
- [ ] Add scheduled coverage proving a skipped fire advances recurring monotonic state and consumes one-shot state.
- [ ] Run the ACP bridge and CLI tests and verify the new assertions fail for the intended authorization reason.
- [ ] Extend the host-result union with `skipped`, make BridgeClient always call the host, and return `skipped` in the bound handler after authorization consume but before worker lookup.
- [ ] Re-run the focused tests and verify sanitized SSE events still contain correlation only.

### Task 4: Contract, verification, and delivery

**Files:**

- Modify: `docs/design/channel-delivery-v1.md`
- Modify: `docs/developers/qwen-serve-protocol.md`
- Modify: `packages/cli/src/serve/channel-delivery-ipc.test.ts`
- Modify: `packages/cli/src/serve/channel-delivery.test.ts`
- Create: `.qwen/e2e-tests/channel-delivery-final-only.md` (git-ignored working artifact)

**Interfaces:**

- Documents: final-block-only semantics and authorized `skipped` SSE behavior.
- Verifies: no behavior change for Notify, Webhook, cancellation, errors, token limit, or worker failure isolation.

- [ ] Add the Apache-2.0 license header to the two test files.
- [ ] Update protocol wording and event example for `skipped`.
- [ ] Run focused tests in `packages/cli` and `packages/acp-bridge`.
- [ ] Run `npm run build`, `npm run typecheck`, and `npm run lint`.
- [ ] Execute real IM Prompt and scheduled E2E with a tool preamble and confirm only the final answer reaches IM; verify empty final emits `skipped` without provider traffic.
- [ ] Perform two clean diff self-audit passes, commit, and push `feat/channel-delivery-v1`.
