# Channel Delivery V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add immediate best-effort Channel delivery for scheduled tasks, daemon Prompt, and direct Notify without a persistent outbox or global final hook.

**Architecture:** Each Agent-backed producer identifies its own successful final boundary and sends a reverse control request to the daemon. The daemon binds the request to the bridge's canonical workspace and reuses one worker IPC path ending at `ChannelBase.deliverProactive()`. Notify calls the same daemon-side path synchronously; Webhook and background notification execution paths remain unchanged.

**Tech Stack:** TypeScript, Express, ACP extMethod, child-process IPC, Vitest, REST/SSE SDK.

## Global Constraints

- Preserve Prompt and Webhook `202` contracts.
- No outbox, polling, persistence, replay, retry, global final hook, lazy worker startup, or primary-workspace fallback.
- Public delivery shape is `{ kind:'channel', target:{ channelName, type, id } }`.
- Text is non-empty and bounded to 100,000 UTF-16 code units before IPC.
- Use ESM, strict TypeScript, kebab-case filenames, no `any`, and no cross-package relative imports.
- Every production behavior follows a failing-test-first RED/GREEN cycle.

---

### Task 1: Delivery contract and proactive adapter boundary

**Files:**

- Create: `packages/channels/base/src/ChannelProactiveDeliveryError.ts`
- Modify: `packages/channels/base/src/types.ts`
- Modify: `packages/channels/base/src/ChannelBase.ts`
- Modify: `packages/channels/base/src/index.ts`
- Test: `packages/channels/base/src/ChannelBase.test.ts`
- Modify/Test: `packages/channels/dingtalk/src/DingtalkAdapter.ts`
- Test: `packages/channels/dingtalk/src/DingtalkAdapter.test.ts`
- Modify/Test: `packages/channels/feishu/src/FeishuAdapter.ts`
- Test: `packages/channels/feishu/src/adapter.test.ts`
- Test: `packages/channels/telegram/src/TelegramAdapter.test.ts`
- Test: `packages/channels/wecom/src/WeComAdapter.test.ts`

**Interfaces:**

- Produces: `ChannelProactiveTarget = { type:'user'|'chat'; id:string }`.
- Produces: `ChannelBase.deliverProactive(target, text): Promise<void>`.
- Produces: `ChannelProactiveDeliveryError` with `permanent:boolean`.

- [ ] Add focused tests proving typed user/chat targets reach `pushProactive`, blank IDs/text fail, unsupported targets fail, and DingTalk HTTP-200 invalid/flow-controlled recipients reject.
- [ ] Run each channel package test and confirm RED because the typed boundary is absent.
- [ ] Add the minimal target type, error class, validation, and adapter mapping.
- [ ] Re-run each focused test and confirm GREEN.

### Task 2: Exact-workspace worker IPC

**Files:**

- Create: `packages/cli/src/serve/channel-delivery-ipc.ts`
- Test: `packages/cli/src/serve/channel-delivery-ipc.test.ts`
- Modify/Test: `packages/cli/src/serve/channel-worker-supervisor.ts`
- Test: `packages/cli/src/serve/channel-worker-supervisor.test.ts`
- Modify/Test: `packages/cli/src/serve/channel-worker-group.ts`
- Test: `packages/cli/src/serve/channel-worker-group.test.ts`
- Modify/Test: `packages/cli/src/serve/channel-worker-manager.ts`
- Test: `packages/cli/src/serve/channel-worker-manager.test.ts`
- Modify/Test: `packages/cli/src/commands/channel/daemon-worker.ts`
- Test: `packages/cli/src/commands/channel/daemon-worker.test.ts`

**Interfaces:**

- Produces: `ChannelDeliveryRequest { deliveryId, channelName, target, text }`.
- Produces: `ChannelDeliveryErrorCode` values `channel_worker_unavailable`, `channel_delivery_timeout`, `channel_delivery_invalid`, `channel_delivery_rejected`, `channel_delivery_queue_full`, `channel_delivery_failed`.
- Produces: `ChannelWorkerManager.deliver(workspaceCwd, request): Promise<void>`.

- [ ] Add IPC validator and result-correlation tests, then confirm RED because the module is absent.
- [ ] Implement the minimal request/result types and validators, then confirm GREEN.
- [ ] Add supervisor tests for running-worker success, 30-second timeout, exit cleanup, and pending-request rejection; confirm RED.
- [ ] Implement supervisor correlation and confirm GREEN.
- [ ] Add group/manager tests proving exact workspace selection and no primary fallback; confirm RED.
- [ ] Implement group/manager routing without starting workers and confirm GREEN.
- [ ] Add worker tests for adapter resolution, maximum 16 concurrent deliveries, queue-full response, and sanitized error classification; confirm RED.
- [ ] Implement worker execution through `deliverProactive()` and confirm GREEN.

### Task 3: Shared public parser, scheduled persistence, and producer-owned Final

**Files:**

- Create: `packages/cli/src/serve/channel-delivery.ts`
- Test: `packages/cli/src/serve/channel-delivery.test.ts`
- Modify/Test: `packages/core/src/services/cronTasksFile.ts`
- Test: `packages/core/src/services/cronTasksFile.test.ts`
- Modify/Test: `packages/cli/src/serve/routes/scheduled-tasks.ts`
- Test: `packages/cli/src/serve/routes/scheduled-tasks.test.ts`
- Modify/Test: `packages/cli/src/acp-integration/session/Session.ts`
- Test: `packages/cli/src/acp-integration/session/Session.test.ts`

**Interfaces:**

- Produces: `parseChannelDelivery(value): PublicChannelDelivery` and `normalizeChannelDelivery(deliveryId, delivery, text): ChannelDeliveryRequest`.
- Consumes: Task 2's reverse delivery submission interface.

- [ ] Test exact public shape, rejected unknown kinds/types, blank fields, and bounded text; confirm RED.
- [ ] Implement the parser/normalizer and confirm GREEN.
- [ ] Test Core round-trip persistence for optional delivery while legacy tasks remain valid; confirm RED.
- [ ] Add the optional field and validation, then confirm GREEN.
- [ ] Test both scheduled REST scopes admit the new shape and reject malformed targets; confirm RED.
- [ ] Implement route parsing and persistence, then confirm GREEN.
- [ ] Test that scheduled execution without delivery does not collect or submit text, while a successful delivered run submits exactly once and cancel/error/empty output does not; confirm RED.
- [ ] Implement the delivery-gated per-run collector and reverse submission after `end_turn`, then confirm GREEN.

### Task 4: Reverse delivery control and result events

**Files:**

- Modify/Test: `packages/acp-bridge/src/status.ts`
- Modify/Test: `packages/acp-bridge/src/bridgeOptions.ts`
- Modify/Test: `packages/acp-bridge/src/bridgeClient.ts`
- Test: `packages/acp-bridge/src/bridgeClient.test.ts`
- Modify/Test: `packages/cli/src/serve/run-qwen-serve.ts`
- Test: `packages/cli/src/serve/run-qwen-serve.test.ts`

**Interfaces:**

- Produces: reverse extMethod `qwen/control/channel-delivery`.
- Produces: host handler `{ sessionId, deliveryId, source, target, text, promptId?, taskId?, firedAt? } => Promise<ChannelDeliveryResult>`.
- Produces: replayable `channel_delivery_result` Bridge event.

- [ ] Add BridgeClient tests for validated reverse dispatch, unknown session rejection, sanitized delivered/failed/skipped publication, and no target/text leakage; confirm RED.
- [ ] Add the extMethod, handler seam, and publication code; confirm GREEN.
- [ ] Add serve tests for primary, secondary, and workspace bridge constructors binding their own canonical workspace and never trusting child-supplied workspace data; confirm RED.
- [ ] Wire all three constructors to the current manager's delivery method without lazy startup; confirm GREEN.

### Task 5: Prompt delivery

**Files:**

- Modify/Test: `packages/cli/src/serve/routes/session.ts`
- Test: `packages/cli/src/serve/server.test.ts`
- Modify/Test: `packages/acp-bridge/src/bridge.ts`
- Test: `packages/acp-bridge/src/bridge.test.ts`
- Modify/Test: `packages/cli/src/acp-integration/session/Session.ts`
- Test: `packages/cli/src/acp-integration/session/Session.test.ts`

**Interfaces:**

- Consumes: Task 3 public parser and Task 4 reverse control.
- Preserves: `202 { promptId, lastEventId }`, followed by normal `turn_complete`/`turn_error`.

- [ ] Test route validation, removal of top-level delivery from the ACP payload, reserved `_meta` stripping, and trusted correlation injection; confirm RED.
- [ ] Implement route/Bridge propagation without adding delivery data to `params.prompt`; confirm GREEN.
- [ ] Test per-turn successful Final submission, no-delivery legacy behavior, and no send on cancel/error/max-token/empty Final; confirm RED.
- [ ] Implement the delivery-gated collector and fire-and-forget reverse request after `end_turn`; confirm GREEN.
- [ ] Test that `turn_complete` precedes `channel_delivery_result` and Prompt completion does not wait for delivery; confirm GREEN.

### Task 6: Synchronous Notify routes and SDK surface

**Files:**

- Create: `packages/cli/src/serve/routes/channel-notify.ts`
- Test: `packages/cli/src/serve/routes/channel-notify.test.ts`
- Modify/Test: `packages/cli/src/serve/server.ts`
- Test: `packages/cli/src/serve/server.test.ts`
- Modify/Test: `packages/sdk-typescript/src/daemon/DaemonClient.ts`
- Test: `packages/sdk-typescript/test/unit/DaemonClient.test.ts`
- Test: `packages/sdk-typescript/test/unit/daemon-public-surface.test.ts`

**Interfaces:**

- Produces: `POST /workspace/notify` and `POST /workspaces/:workspace/notify`.
- Produces: SDK `notify({ text, delivery })` on primary and workspace clients.

- [ ] Add route tests for strict bearer authorization, exact workspace routing, success, 400/502/503/504 mapping, and absence of a test route; confirm RED.
- [ ] Implement the two routes using the current manager only and confirm GREEN.
- [ ] Add SDK tests for request paths, body, result type, and capability preflight; confirm RED.
- [ ] Implement primary/workspace SDK helpers and confirm GREEN.

### Task 7: SDK events, capability, docs, and end-to-end verification

**Files:**

- Modify/Test: `packages/sdk-typescript/src/daemon/events.ts`
- Test: `packages/sdk-typescript/test/unit/daemonEvents.test.ts`
- Modify/Test: `packages/cli/src/serve/capabilities.ts`
- Test: `packages/cli/src/serve/server.test.ts`
- Modify: `docs/developers/qwen-serve-protocol.md`
- Modify: `.qwen/e2e-tests/channel-delivery-v1.md`

**Interfaces:**

- Produces: known `channel_delivery_result` event.
- Produces: `channel_delivery` daemon capability.

- [ ] Add SDK event tests for delivered, failed, skipped, replay after `turn_complete`, and rejection of malformed known events; confirm RED.
- [ ] Implement the event schema/validator without changing `DaemonClient.prompt()` completion and confirm GREEN.
- [ ] Add capability tests, replace any narrower branch-only capability, and confirm GREEN.
- [ ] Update protocol and E2E documentation with the final no-outbox/no-retry semantics.
- [ ] Run all touched-file tests, `npm run build`, `npm run typecheck`, and `npm run bundle`.
- [ ] Execute the E2E matrix using formal Prompt, Scheduled, Notify, and Webhook routes; record redacted evidence and confirm no historical replay.
- [ ] Perform two clean full-diff self-audit passes; any fix resets verification and the clean-pass count.
