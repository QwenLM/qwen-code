# Feishu Observed-Contact Label Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve Feishu sender and group IDs into recognizable observed-contact labels without delaying inbound message processing.

**Architecture:** `ChannelBase` exposes a synchronous post-observation hook and its existing protected persistence path. `FeishuChannel` starts cached, fire-and-forget OpenAPI lookups from that hook, then writes one enriched observation after successful resolution. The existing store schema and non-Feishu channels remain unchanged.

**Tech Stack:** TypeScript, Node.js 22+, Vitest, Feishu tenant-access-token OpenAPI, existing channel-base observed-contact sink.

## Global Constraints

- Preserve the existing preflight boundary: rejected messages must not trigger lookups.
- Persist the ID observation before starting enrichment.
- Never await Feishu label lookup from `handleInbound` or the Agent prompt path.
- Query each user and group ID at most once per `FeishuChannel` instance; concurrent observations share the same promise.
- Cache failed attempts until daemon restart and emit no lookup-specific logs.
- Use `contact:user.basic_profile:readonly` and `im:chat:readonly`; do not use full-contact APIs.
- Keep ESM, strict TypeScript, no `any`, and existing file naming.

---

### Task 1: Add the post-observation extension point

**Files:**

- Modify: `packages/channels/base/src/ChannelBase.ts`
- Test: `packages/channels/base/src/ChannelBase.test.ts`

**Interfaces:**

- Produces: `protected onObservedContact(envelope: Envelope): void`
- Produces: `protected recordObservedContact(envelope: Envelope): Promise<void>`
- Guarantees: the hook runs once, after the initial persistence attempt, only for preflight-approved envelopes.

- [ ] **Step 1: Write the failing hook-order test**

Add a local test subclass and assert that persistence happens before the hook:

```ts
class ObservedHookChannel extends TestChannel {
  readonly observedEnvelopes: Envelope[] = [];

  protected override onObservedContact(envelope: Envelope): void {
    this.observedEnvelopes.push(envelope);
  }
}

it('notifies the adapter after an approved contact is persisted', async () => {
  const order: string[] = [];
  const observe = vi.fn(() => {
    order.push('persisted');
  });
  const ch = new ObservedHookChannel('test-chan', defaultConfig(), bridge, {
    observedContacts: { observe },
  });
  const message = envelope();

  await ch.handleInbound(message);

  expect(order).toEqual(['persisted']);
  expect(ch.observedEnvelopes).toEqual([message]);
  expect(bridge.prompt).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the base test and verify RED**

Run:

```bash
cd packages/channels/base
npx vitest run src/ChannelBase.test.ts -t "notifies the adapter after an approved contact is persisted"
```

Expected: compilation fails because `onObservedContact` does not exist.

- [ ] **Step 3: Implement the minimal base hook**

Change only the persistence method visibility from `private` to `protected`; keep its body unchanged. Add the default no-op hook and invoke it synchronously after the initial observation:

```ts
protected async recordObservedContact(envelope: Envelope): Promise<void> {
```

```ts
protected onObservedContact(_envelope: Envelope): void {}

// Inside processInbound, after await this.recordObservedContact(envelope):
this.onObservedContact(envelope);
```

- [ ] **Step 4: Run the base test and verify GREEN**

Run:

```bash
cd packages/channels/base
npx vitest run src/ChannelBase.test.ts
```

Expected: all ChannelBase tests pass.

### Task 2: Enrich Feishu observations in the background

**Files:**

- Modify: `packages/channels/feishu/src/FeishuAdapter.ts`
- Test: `packages/channels/feishu/src/adapter.test.ts`

**Interfaces:**

- Consumes: `onObservedContact(envelope)` and `recordObservedContact(envelope)` from Task 1.
- Produces: process-local user/group name and lookup-promise caches.
- Produces: `basic_batch` requests with the callback ID type and `GET /im/v1/chats/:chat_id` requests.

- [ ] **Step 1: Write failing success and cache tests**

Allow the test factory to pass `ChannelBaseOptions`, preload `tokenCache`, and send two complete Feishu group-event fixtures with different message IDs. Mock these complete API responses:

```ts
new Response(
  JSON.stringify({
    code: 0,
    msg: 'success',
    data: { users: [{ user_id: 'ou_user', name: 'Alice' }] },
  }),
  { status: 200 },
);

new Response(
  JSON.stringify({
    code: 0,
    msg: 'success',
    data: { name: 'Project Group' },
  }),
  { status: 200 },
);
```

Assert the observable store calls, not private maps:

```ts
expect(observe).toHaveBeenNthCalledWith(1, 'test', {
  user: { id: 'ou_user', label: 'ou_user' },
  group: { id: 'oc_group', label: 'oc_group' },
});
expect(observe).toHaveBeenNthCalledWith(2, 'test', {
  user: { id: 'ou_user', label: 'Alice' },
  group: { id: 'oc_group', label: 'Project Group' },
});
```

After the first lookup settles, deliver the second fixture and assert its first observation already contains the cached names and that each OpenAPI endpoint was requested exactly once.

- [ ] **Step 2: Write the failing non-blocking and silent-failure test**

Use an externally controlled rejected lookup promise, a real mock bridge, and a no-op `onPromptStart` test subclass. Assert `bridge.prompt` runs while lookup work is unresolved. After rejecting the lookups, assert the ID observation remains and `process.stderr.write` received no lookup error.

- [ ] **Step 3: Run Feishu tests and verify RED**

Run:

```bash
cd packages/channels/feishu
npx vitest run src/adapter.test.ts -t "observed contact"
```

Expected: the enriched observation and background request assertions fail because Feishu does not yet resolve labels.

- [ ] **Step 4: Implement cached background lookups**

Add successful-name maps and promise caches:

```ts
private readonly observedUserNames = new Map<string, string>();
private readonly observedChatNames = new Map<string, string>();
private readonly observedUserLookups = new Map<
  string,
  Promise<string | undefined>
>();
private readonly observedChatLookups = new Map<
  string,
  Promise<string | undefined>
>();
```

Populate later envelopes synchronously from successful caches:

```ts
const cachedSenderName = this.observedUserNames.get(senderId);
const cachedChatName = isGroup ? this.observedChatNames.get(chatId) : undefined;

const envelope: Envelope = {
  channelName: this.name,
  senderId,
  senderName: cachedSenderName || senderId,
  chatId,
  text: cleanText,
  messageId: msgId,
  threadId: msg.root_id || undefined,
  isGroup,
  isMentioned,
  isReplyToBot: false,
  ...(cachedChatName ? { chatName: cachedChatName } : {}),
};
```

Override the base hook without returning or awaiting the lookup promise:

```ts
protected override onObservedContact(envelope: Envelope): void {
  void this.enrichObservedContact(envelope);
}
```

Implement user and chat request helpers with `AbortSignal.timeout(15_000)`. Convert `ou_` to `open_id`, `on_` to `union_id`, and other IDs to `user_id`. Return `undefined` for missing tokens, non-2xx responses, non-zero API codes, malformed JSON, empty names, and thrown errors without writing logs. Store the promise before awaiting it so concurrent messages share the same request; retain resolved `undefined` promises to suppress retries until restart.

After `Promise.all`, call:

```ts
await this.recordObservedContact({
  ...envelope,
  ...(senderName ? { senderName } : {}),
  ...(chatName ? { chatName } : {}),
});
```

only when at least one lookup returned a name.

- [ ] **Step 5: Run Feishu tests and verify GREEN**

Run:

```bash
cd packages/channels/feishu
npx vitest run src/adapter.test.ts
```

Expected: all Feishu adapter tests pass with no unexpected output from the new failure cases.

### Task 3: Verify, review, and publish

**Files:**

- Verify: `packages/channels/base/src/ChannelBase.ts`
- Verify: `packages/channels/base/src/ChannelBase.test.ts`
- Verify: `packages/channels/feishu/src/FeishuAdapter.ts`
- Verify: `packages/channels/feishu/src/adapter.test.ts`
- Include: `docs/design/feishu-observed-contact-label-enrichment.md`
- Include: `docs/plans/feishu-observed-contact-label-enrichment.md`

**Interfaces:**

- Links: GitHub issue `QwenLM/qwen-code#8566`.
- Produces: one draft pull request from `BenGuanRan:feat/feishu-observed-contact-labels` to `QwenLM/qwen-code:main`.

- [ ] **Step 1: Run focused verification**

```bash
cd packages/channels/base && npx vitest run src/ChannelBase.test.ts
cd ../feishu && npx vitest run src/adapter.test.ts
cd ../../.. && npm run build && npm run typecheck
git diff --check origin/main...HEAD
```

- [ ] **Step 2: Self-audit the complete diff**

Read `git diff origin/main...HEAD` in open-ended passes. Check every changed behavior against the design, verify the tests would fail if the hook or enrichment write were removed, and stop after two consecutive clean passes.

- [ ] **Step 3: Run the Codex review workflow**

Review the exact branch diff against `origin/main`. Triage every finding as valid, false positive, or overthinking; accepted fixes return to focused tests and self-audit.

- [ ] **Step 4: Commit after explicit staging and commit authorization**

```bash
git add -- packages/channels/base/src/ChannelBase.ts packages/channels/base/src/ChannelBase.test.ts packages/channels/feishu/src/FeishuAdapter.ts packages/channels/feishu/src/adapter.test.ts docs/plans/feishu-observed-contact-label-enrichment.md
git commit -m "feat(feishu): enrich observed contact labels"
```

- [ ] **Step 5: Push after explicit push authorization**

```bash
git push -u fork feat/feishu-observed-contact-labels
```

- [ ] **Step 6: Create the authorized draft PR with the repository template**

Create exactly one draft PR with title `feat(feishu): enrich observed contact labels`, base `QwenLM/qwen-code:main`, head `BenGuanRan:feat/feishu-observed-contact-labels`, and `Closes #8566`. Fill every English template section and provide a complete paragraph-for-paragraph Chinese translation in the `<details>` block.
