# DingTalk Forbidden Group Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send a clear notice to the original DingTalk group when a non-owner operates a live interactive card, without changing the card or entering Agent context, and keep card cancellation and timeout behavior deterministic.

**Architecture:** Keep authorization and callback claiming inside the DingTalk card controllers. A `forbidden` result carries the already-trusted card delivery target to the adapter; the adapter ACKs first and then uses its existing proactive group-message path. Controllers suppress repeated forbidden feedback from the same actor on the same card. The daemon SDK coalesces concurrent cancellation requests caused by one abort. `accepted`, permission settlement, Channel Base, and other IM adapters remain unchanged.

**Tech Stack:** TypeScript, Vitest, DingTalk Stream callbacks, DingTalk proactive group-message API.

## Global Constraints

- Keep card-specific behavior inside `packages/channels/dingtalk`; the transport-level cancellation fix belongs in `packages/sdk-typescript`.
- Only `forbidden` produces group feedback; `ignored` never produces group feedback.
- Notify each unauthorized actor at most once per card.
- A forbidden callback must not mutate card state, call permission response APIs, or enter Agent context.
- ACK the DingTalk callback before starting feedback delivery.
- Group-feedback failure is log-only and never falls back to Agent delivery.
- Default the question card timeout to 270 seconds so the card expires before the daemon's 300-second permission timeout.
- Coalesce only concurrent SDK cancellation calls; a later independent cancellation still sends a new request.
- Do not stage or commit `docs/design/2026-07-28-channel-interaction-compatibility-hardening.md` or `e2e-img-test.png`.

---

### Task 1: Carry the trusted card target on forbidden results

**Files:**

- Modify: `packages/channels/dingtalk/src/interactive-card-types.ts`
- Modify: `packages/channels/dingtalk/src/question-card-controller.ts`
- Modify: `packages/channels/dingtalk/src/status-card-controller.ts`
- Test: `packages/channels/dingtalk/src/question-card-controller.test.ts`
- Test: `packages/channels/dingtalk/src/status-card-controller.test.ts`

**Interfaces:**

- Produces: `DingtalkCardCallbackResult` with `forbidden.target: { chatId: string; isGroup: boolean }`.
- Consumes: the exact target already supplied when a question or status card is created.

- [ ] **Step 1: Update controller tests to require the original target**

For a foreign actor, assert:

```ts
expect(result).toEqual({
  kind: 'forbidden',
  actorId: 'other',
  target: { chatId: 'group-1', isGroup: true },
});
```

Update the test-local result unions so `forbidden` requires the same `target`.

- [ ] **Step 2: Run the controller tests and verify they fail**

Run:

```bash
cd packages/channels/dingtalk
npx vitest run src/question-card-controller.test.ts src/status-card-controller.test.ts
```

Expected: failures show that current forbidden results contain only `actorId`.

- [ ] **Step 3: Implement the minimal target propagation**

Change the shared result type to:

```ts
export type DingtalkCardCallbackResult =
  | { kind: 'accepted'; execute: () => Promise<void> }
  | {
      kind: 'forbidden';
      actorId: string;
      target: { chatId: string; isGroup: boolean };
    }
  | { kind: 'ignored'; actorId?: string };
```

Store the creation target on both controller records:

```ts
target: {
  chatId: string;
  isGroup: boolean;
}
```

Return it only from the foreign-owner branch:

```ts
return { kind: 'forbidden', actorId, target: record.target };
```

- [ ] **Step 4: Re-run the controller tests**

Run:

```bash
cd packages/channels/dingtalk
npx vitest run src/question-card-controller.test.ts src/status-card-controller.test.ts
```

Expected: both files pass.

### Task 2: Send forbidden feedback to the original group

**Files:**

- Modify: `packages/channels/dingtalk/src/DingtalkAdapter.ts`
- Test: `packages/channels/dingtalk/src/DingtalkAdapter.test.ts`

**Interfaces:**

- Consumes: `forbidden.target` from Task 1.
- Produces: an ACK-first proactive group message for group cards; direct feedback remains available for direct cards and ignored callbacks.

- [ ] **Step 1: Add a failing adapter test for group feedback**

Route this result:

```ts
{
  kind: 'forbidden',
  actorId: 'other-user',
  target: { chatId: 'group-1', isGroup: true },
}
```

Assert:

```ts
expect(client.send).toHaveBeenCalledWith('card-message', {
  status: 'success',
  message: 'ok',
});
await vi.waitFor(() => expect(groupSendCalls()).toHaveLength(1));
expect(directSendCalls()).toHaveLength(0);
expect(requestBody.openConversationId).toBe('group-1');
expect(JSON.parse(requestBody.msgParam).text).toContain('任务发起人');
expect(JSON.parse(requestBody.msgParam).text).toContain('未生效');
```

Keep the ignored test asserting zero group sends. Update existing forbidden fixtures with an explicit direct target where required.

- [ ] **Step 2: Run the adapter test and verify it fails**

Run:

```bash
cd packages/channels/dingtalk
npx vitest run src/DingtalkAdapter.test.ts
```

Expected: the current adapter calls the direct-message API instead of the group API.

- [ ] **Step 3: Implement target-aware forbidden feedback**

In the callback handler, pass `result.target` only for `forbidden`. Build this group target without invoking inbound routing:

```ts
{
  channelName: this.name,
  senderId: actorId,
  chatId: target.chatId,
  isGroup: true,
}
```

Use this group copy:

```text
仅任务发起人可以操作这张卡片，本次操作未生效。
```

For direct forbidden feedback and ignored feedback, retain the existing direct-message target and copy. Continue logging asynchronous delivery failures.

- [ ] **Step 4: Re-run the adapter test**

Run:

```bash
cd packages/channels/dingtalk
npx vitest run src/DingtalkAdapter.test.ts
```

Expected: all adapter tests pass, the group case calls only the group API, and ignored callbacks still do not call the group API.

### Task 3: Align timeout and cancellation behavior

**Files:**

- Modify: `packages/channels/dingtalk/src/interactive-card-types.ts`
- Test: `packages/channels/dingtalk/src/interactive-card-types.test.ts`
- Modify: `packages/sdk-typescript/src/daemon/DaemonSessionClient.ts`
- Test: `packages/sdk-typescript/test/unit/DaemonSessionClient.test.ts`

- [ ] **Step 1: Set the default question-card timeout to 270 seconds**

Keep explicit user configuration unchanged. Update the default-value test.

- [ ] **Step 2: Add a failing cancellation regression test**

Abort an active prompt and explicitly cancel the same session before the first
cancel request settles. Assert that the daemon receives exactly one request.

- [ ] **Step 3: Coalesce concurrent cancellation requests**

Route prompt-abort cancellation through `DaemonSessionClient.cancel()` and
reuse its in-flight promise. Clear the promise after settlement so later,
independent cancellation remains possible.

- [ ] **Step 4: Run focused SDK verification**

Run:

```bash
cd packages/sdk-typescript
npx vitest run test/unit/DaemonSessionClient.test.ts test/unit/DaemonClient.test.ts
npm run build
npm run typecheck
```

Expected: all commands pass, including the concurrent cancellation regression.

### Task 4: Verify the package and repeat the real-device authorization case

**Files:**

- No production changes.
- Update only the ignored E2E report: `.qwen/e2e-tests/2026-07-28-channel-interaction-compatibility-hardening.md`

**Interfaces:**

- Consumes: the completed DingTalk implementation.
- Produces: automated and real-device evidence that the notice is visible but isolated from Agent context.

- [ ] **Step 1: Run DingTalk verification**

Run:

```bash
cd packages/channels/dingtalk
npx vitest run
cd ../../..
npm run build
npm run typecheck
npm run bundle
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 2: Audit the complete implementation diff**

Confirm:

- `forbidden` is the only result carrying a group target.
- ACK still precedes feedback delivery.
- No `ChannelBase`, ACP, permission, or other IM file changed.
- SDK changes are limited to coalescing concurrent cancellation requests.
- `ignored` cannot send a group message.
- Repeated forbidden callbacks from the same actor are silent.
- The Chinese local design file and generated test image are unstaged.

- [ ] **Step 3: Repeat the group real-device scenario**

1. Owner creates a pending question card in a DingTalk group.
2. A second user submits it.
3. Verify the card remains pending and no `POST /permission/:id` occurs.
4. Verify the group receives “仅任务发起人可以操作这张卡片，本次操作未生效。”
5. Owner submits the card and the original Agent run continues exactly once.

- [ ] **Step 4: Commit the implementation**

Stage only the DingTalk source and test files plus the English implementation plan:

```bash
git add \
  docs/plans/2026-07-28-dingtalk-forbidden-group-feedback.md \
  packages/channels/dingtalk/src/interactive-card-types.ts \
  packages/channels/dingtalk/src/interactive-card-types.test.ts \
  packages/channels/dingtalk/src/question-card-controller.ts \
  packages/channels/dingtalk/src/status-card-controller.ts \
  packages/channels/dingtalk/src/question-card-controller.test.ts \
  packages/channels/dingtalk/src/status-card-controller.test.ts \
  packages/channels/dingtalk/src/DingtalkAdapter.ts \
  packages/channels/dingtalk/src/DingtalkAdapter.test.ts
git commit -m "fix(dingtalk): report forbidden card actions in groups"
```

Commit the SDK cancellation fix separately:

```bash
git add \
  packages/sdk-typescript/src/daemon/DaemonSessionClient.ts \
  packages/sdk-typescript/test/unit/DaemonSessionClient.test.ts
git commit -m "fix(sdk): coalesce concurrent session cancellation"
```
