# Scheduled Channel Delivery Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tested, model-invisible daemon-to-Channel-worker transport that can deliver an already-produced final message to one proactive Channel target.

**Architecture:** `ChannelBase` exposes a narrow public proactive-delivery boundary that keeps adapter-specific formatting and transport protected behind the base class. The daemon parent sends a dedicated request/reply IPC message to the worker; the worker resolves the named connected Channel and calls that boundary. This phase deliberately does not change durable task storage or depend on #7109.

**Tech Stack:** TypeScript, Node child-process IPC, Vitest, existing `ChannelBase`, `ChannelWorkerSupervisor`, and `ChannelWorkerGroup`.

## Global Constraints

- Base all work on `origin/main`; do not merge, cherry-pick, or copy #7109.
- Keep `channel_delivery` internal to daemon/worker control; do not expose it as a model tool or HTTP webhook.
- Do not add task persistence, retries, or observed-contact admission in this transport phase.
- Reuse adapter-owned proactive formatting and send behavior.
- Preserve standalone Channel loop behavior.
- Write every behavioral test before production code and observe the expected failure.

---

### Task 1: Public Channel proactive-delivery boundary

**Files:**

- Modify: `packages/channels/base/src/types.ts`
- Modify: `packages/channels/base/src/ChannelBase.ts`
- Modify: `packages/channels/base/src/index.ts`
- Test: `packages/channels/base/src/ChannelBase.test.ts`

**Interfaces:**

- Consumes: existing protected `supportsProactiveTarget(target: SessionTarget)` and `pushProactive(target: SessionTarget, text: string)`.
- Produces: exported `ChannelProactiveTarget` and `ChannelBase.deliverProactive(target, text): Promise<void>` for the daemon worker.

- [ ] **Step 1: Write failing tests for successful delivery and rejection**

Add tests that invoke the new public method on the existing test adapter:

```ts
await channel.deliverProactive(
  { channelName: 'test', chatId: 'group-1', isGroup: true },
  'inspection result',
);
expect(pushProactive).toHaveBeenCalledWith(
  expect.objectContaining({
    channelName: 'test',
    chatId: 'group-1',
    senderId: 'group-1',
    isGroup: true,
  }),
  'inspection result',
);
```

Also cover a mismatched `channelName`, an adapter with no proactive support,
and a target rejected by `supportsProactiveTarget`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd packages/channels/base && npx vitest run src/ChannelBase.test.ts
```

Expected: FAIL because `deliverProactive` and `ChannelProactiveTarget` do not
exist.

- [ ] **Step 3: Add the minimal public boundary**

Add this routing-only type to `types.ts`:

```ts
export interface ChannelProactiveTarget {
  channelName: string;
  chatId: string;
  threadId?: string;
  isGroup?: boolean;
}
```

Add a public method to `ChannelBase` that:

1. requires `target.channelName === this.name`;
2. requires `supportsProactiveSend()`;
3. converts the target into a `SessionTarget` with
   `senderId: target.chatId`;
4. requires `supportsProactiveTarget(sessionTarget)`;
5. calls `pushProactive(sessionTarget, text)` exactly once.

Export the type from the base package public surface.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the same Vitest command. Expected: all `ChannelBase.test.ts` tests pass.

- [ ] **Step 5: Commit the boundary**

```bash
git add packages/channels/base/src/types.ts \
  packages/channels/base/src/ChannelBase.ts \
  packages/channels/base/src/index.ts \
  packages/channels/base/src/ChannelBase.test.ts
git commit -m "feat(channels): expose proactive delivery boundary"
```

### Task 2: Dedicated channel-delivery IPC contract

**Files:**

- Create: `packages/cli/src/serve/channel-delivery-ipc.ts`
- Create: `packages/cli/src/serve/channel-delivery-ipc.test.ts`

**Interfaces:**

- Consumes: `ChannelProactiveTarget` from `@qwen-code/channel-base`.
- Produces: `ChannelDeliveryRequest`, `ChannelDeliveryAccepted`,
  `ChannelDeliveryError`, `createChannelDeliveryMessage()`,
  `isChannelDeliveryMessage()`, and `isChannelDeliveryResultMessage()`.

- [ ] **Step 1: Write the failing contract tests**

Cover:

```ts
const message = createChannelDeliveryMessage({
  deliveryId: 'delivery-1',
  channelName: 'dingtalk-main',
  target: { channelName: 'dingtalk-main', chatId: 'group-1', isGroup: true },
  text: 'inspection result',
});
expect(message).toMatchObject({
  type: 'channel_delivery',
  request: { deliveryId: 'delivery-1' },
});
expect(isChannelDeliveryMessage(message)).toBe(true);
expect(
  isChannelDeliveryResultMessage({
    type: 'channel_delivery_result',
    id: message.id,
    ok: true,
  }),
).toBe(true);
```

Reject missing IDs, empty text, inconsistent target/channel names, non-finite
expiry, unknown result error codes, and malformed nested targets.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd packages/cli && npx vitest run src/serve/channel-delivery-ipc.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the minimal IPC types and guards**

Use this request shape:

```ts
export interface ChannelDeliveryRequest {
  deliveryId: string;
  channelName: string;
  target: ChannelProactiveTarget;
  text: string;
}
```

Use child-process messages `channel_delivery` and
`channel_delivery_result`. Generate the correlation `id` with `randomUUID()`
and set an expiry using a single exported IPC timeout. Support only these
sanitized error codes:

```ts
export type ChannelDeliveryErrorCode =
  | 'channel_worker_unavailable'
  | 'channel_delivery_timeout'
  | 'channel_delivery_invalid'
  | 'channel_delivery_queue_full'
  | 'channel_delivery_failed';
```

The guard validates structure only; target policy remains in `ChannelBase`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the same Vitest command. Expected: all contract tests pass.

- [ ] **Step 5: Commit the contract**

```bash
git add packages/cli/src/serve/channel-delivery-ipc.ts \
  packages/cli/src/serve/channel-delivery-ipc.test.ts
git commit -m "feat(daemon): define channel delivery IPC"
```

### Task 3: Parent supervisor and multi-workspace routing

**Files:**

- Modify: `packages/cli/src/serve/channel-worker-supervisor.ts`
- Modify: `packages/cli/src/serve/channel-worker-supervisor.test.ts`
- Modify: `packages/cli/src/serve/channel-worker-group.ts`
- Modify: `packages/cli/src/serve/channel-worker-group.test.ts`

**Interfaces:**

- Consumes: Task 2 `ChannelDeliveryRequest` and result guards.
- Produces: `ChannelWorkerSupervisor.deliverChannelMessage(request)` and the
  same method on `ChannelWorkerGroup`.

- [ ] **Step 1: Write failing supervisor tests**

Test that a running worker receives `channel_delivery`, resolves only after the
matching success result, rejects a matching error result with
`ChannelDeliveryError`, times out, rejects on worker exit, and reports
`channel_worker_unavailable` before the worker is running.

- [ ] **Step 2: Run supervisor tests and verify RED**

```bash
cd packages/cli && npx vitest run src/serve/channel-worker-supervisor.test.ts
```

Expected: FAIL because `deliverChannelMessage` is absent.

- [ ] **Step 3: Implement supervisor request/reply tracking**

Add a pending-delivery map keyed by IPC correlation ID. Settle it only with a
matching `channel_delivery_result`; reject all pending deliveries on worker
exit/stop. Keep this map separate from webhook tasks because webhook success
means accepted while delivery success means the platform send completed.

- [ ] **Step 4: Run supervisor tests and verify GREEN**

Run the same command. Expected: all supervisor tests pass.

- [ ] **Step 5: Write failing group-routing tests**

Test that `deliverChannelMessage` routes to the supervisor whose workspace
owns `request.channelName`, and rejects when no live/non-draining workspace
owns it.

- [ ] **Step 6: Run group tests and verify RED**

```bash
cd packages/cli && npx vitest run src/serve/channel-worker-group.test.ts
```

Expected: FAIL because the group method is absent.

- [ ] **Step 7: Implement group routing and verify GREEN**

Reuse the existing `routeEntry(channelName)` ownership resolver and preserve
the current no-primary-fallback behavior. Run the group test file again and
expect all tests to pass.

- [ ] **Step 8: Commit supervisor and group routing**

```bash
git add packages/cli/src/serve/channel-worker-supervisor.ts \
  packages/cli/src/serve/channel-worker-supervisor.test.ts \
  packages/cli/src/serve/channel-worker-group.ts \
  packages/cli/src/serve/channel-worker-group.test.ts
git commit -m "feat(daemon): route channel delivery to workers"
```

### Task 4: Worker delivery execution

**Files:**

- Modify: `packages/cli/src/commands/channel/daemon-worker.ts`
- Modify: `packages/cli/src/commands/channel/daemon-worker.test.ts`

**Interfaces:**

- Consumes: Task 1 `ChannelBase.deliverProactive()` and Task 2 IPC guards.
- Produces: a worker command that completes one delivery request without
  starting an Agent turn.

- [ ] **Step 1: Write failing worker tests**

Cover success, missing Channel, target rejection, adapter send failure, queue
limit, expired message, and shutdown drain. Assert success is returned only
after `deliverProactive` resolves. Assert `runWebhookTask` and bridge prompt
methods are never called.

- [ ] **Step 2: Run the focused test and verify RED**

```bash
cd packages/cli && npx vitest run src/commands/channel/daemon-worker.test.ts
```

Expected: FAIL because the worker ignores `channel_delivery` messages.

- [ ] **Step 3: Add delivery to the worker handle**

Extend `ChannelDaemonWorkerHandle` with:

```ts
deliverChannelMessage(request: ChannelDeliveryRequest): Promise<void>;
```

Resolve `request.channelName` from the connected map and call
`channel.deliverProactive(request.target, request.text)`. Do not call
`runWebhookTask`, `prompt`, or any session method.

- [ ] **Step 4: Handle delivery IPC in the command**

Track active delivery promises separately from active webhook tasks. Return a
sanitized result code/message and drain active delivery promises during normal
shutdown using the existing bounded shutdown window.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run the same Vitest command. Expected: all daemon-worker tests pass.

- [ ] **Step 6: Commit worker execution**

```bash
git add packages/cli/src/commands/channel/daemon-worker.ts \
  packages/cli/src/commands/channel/daemon-worker.test.ts
git commit -m "feat(channels): deliver daemon messages in worker"
```

### Task 5: Transport verification and design sync

**Files:**

- Modify: `docs/design/2026-07-18-scheduled-channel-delivery.md`
- Create: `.qwen/e2e-tests/scheduled-channel-delivery.md`

**Interfaces:**

- Consumes: the complete transport from Tasks 1-4.
- Produces: verified transport foundation and an E2E plan for later durable-task integration.

- [ ] **Step 1: Add the E2E plan**

Document baseline behavior on global `qwen`, local daemon startup, one direct
transport invocation through a test seam, expected adapter send, negative
missing-worker behavior, and proof that no second Agent turn was created.

- [ ] **Step 2: Format changed files**

```bash
npx prettier --write \
  docs/design/2026-07-18-scheduled-channel-delivery.md \
  docs/superpowers/plans/2026-07-18-scheduled-channel-delivery-transport.md \
  .qwen/e2e-tests/scheduled-channel-delivery.md \
  packages/channels/base/src/types.ts \
  packages/channels/base/src/ChannelBase.ts \
  packages/channels/base/src/ChannelBase.test.ts \
  packages/cli/src/serve/channel-delivery-ipc.ts \
  packages/cli/src/serve/channel-delivery-ipc.test.ts \
  packages/cli/src/serve/channel-worker-supervisor.ts \
  packages/cli/src/serve/channel-worker-supervisor.test.ts \
  packages/cli/src/serve/channel-worker-group.ts \
  packages/cli/src/serve/channel-worker-group.test.ts \
  packages/cli/src/commands/channel/daemon-worker.ts \
  packages/cli/src/commands/channel/daemon-worker.test.ts
```

- [ ] **Step 3: Run focused verification**

```bash
cd packages/channels/base && npx vitest run src/ChannelBase.test.ts
cd packages/cli && npx vitest run \
  src/serve/channel-delivery-ipc.test.ts \
  src/serve/channel-worker-supervisor.test.ts \
  src/serve/channel-worker-group.test.ts \
  src/commands/channel/daemon-worker.test.ts
```

Expected: zero failed tests.

- [ ] **Step 4: Run package typechecks/build**

```bash
npm run typecheck
npm run build
```

Expected: both commands exit 0.

- [ ] **Step 5: Self-audit and commit documentation**

Read the complete diff twice. Verify no model tool, webhook reuse, #7109 code,
credential storage, or primary-workspace fallback was introduced. Then commit:

```bash
git add docs/design/2026-07-18-scheduled-channel-delivery.md \
  docs/superpowers/plans/2026-07-18-scheduled-channel-delivery-transport.md \
  .qwen/e2e-tests/scheduled-channel-delivery.md
git commit -m "docs(channels): refine scheduled delivery rollout"
```

After this transport plan is complete, create separate TDD plans for durable
task state/outbox, daemon `/loop` convergence, and client surfaces. Each later
plan consumes the stable `ChannelWorkerGroup.deliverChannelMessage()` boundary
without changing adapter delivery semantics.
