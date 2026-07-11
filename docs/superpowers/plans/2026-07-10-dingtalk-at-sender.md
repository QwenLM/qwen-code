# DingTalk At-Sender Replies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a DingTalk channel optionally @ the group member whose message triggered an agent response.

**Architecture:** Add a protected, session-aware response-delivery hook in `ChannelBase`; its default preserves existing adapters. The DingTalk adapter records the inbound message's staff ID, binds it to the prompt session, and only includes DingTalk's `atUserIds` on the first Markdown chunk of that response.

**Tech Stack:** TypeScript, Vitest, DingTalk Stream session webhooks.

## Global Constraints

- Work only in `/Users/qqqys/Desktop/qys/qwen-code/.worktrees/feat-dingtalk-reply-mention` on branch `feat/dingtalk-reply-mention`.
- `atSender` is an optional DingTalk-only boolean and defaults to `false`.
- Mention only group agent responses with a non-empty inbound `senderStaffId`; leave DMs, local command replies, error fallbacks, and proactive sends unchanged.
- For a multi-chunk Markdown response, include `at.atUserIds` only on the first chunk.
- Keep TypeScript strict; do not add dependencies.

---

## File Structure

- Modify `packages/channels/base/src/ChannelBase.ts`: route complete and block-streamed agent output through a session-aware protected hook while retaining `sendMessage(chatId, text)` for all non-agent output.
- Modify `packages/channels/base/src/ChannelBase.test.ts`: verify block streaming supplies its session ID to the new hook.
- Modify `packages/channels/dingtalk/src/DingtalkAdapter.ts`: parse `atSender`, correlate DingTalk message IDs to staff IDs and sessions, and add the optional Markdown `at` payload.
- Modify `packages/channels/dingtalk/src/DingtalkAdapter.test.ts`: assert enabled, disabled, missing-ID, and multi-chunk outbound payloads.
- Modify `docs/users/features/channels/dingtalk.md`: document the new setting and its scope.

### Task 1: Preserve session identity through response delivery

**Files:**

- Modify: `packages/channels/base/src/ChannelBase.ts:1216-1222, 3470-3570`
- Modify: `packages/channels/base/src/ChannelBase.test.ts:35-90, 8050-8080`

**Interfaces:**

- Consumes: `sendMessage(chatId: string, text: string): Promise<void>` implemented by every adapter.
- Produces: `protected sendResponseMessage(chatId: string, text: string, sessionId: string): Promise<void>` for adapter-specific agent-response delivery.

- [ ] **Step 1: Write the failing block-streaming routing test**

Add a test-only subclass and test beside the existing block-streaming tests:

```ts
class ResponseTrackingChannel extends TestChannel {
  responseDeliveries: Array<{
    chatId: string;
    text: string;
    sessionId: string;
  }> = [];

  protected override async sendResponseMessage(
    chatId: string,
    text: string,
    sessionId: string,
  ): Promise<void> {
    this.responseDeliveries.push({ chatId, text, sessionId });
    await super.sendResponseMessage(chatId, text, sessionId);
  }
}

it('passes the prompt session to block-streamed response delivery', async () => {
  (bridge.prompt as ReturnType<typeof vi.fn>).mockImplementation(
    (sid: string) => {
      (bridge as unknown as EventEmitter).emit('textChunk', sid, 'reply');
      return Promise.resolve('reply');
    },
  );
  const ch = new ResponseTrackingChannel(
    'test-chan',
    defaultConfig({
      blockStreaming: 'on',
      blockStreamingChunk: { minChars: 1, maxChars: 100 },
      blockStreamingCoalesce: { idleMs: 0 },
    }),
    bridge,
  );

  await ch.handleInbound(envelope());

  expect(ch.responseDeliveries).toEqual([
    { chatId: 'chat1', text: 'reply', sessionId: 's-1' },
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/channels/base && npx vitest run src/ChannelBase.test.ts -t "passes the prompt session"`

Expected: FAIL because `sendResponseMessage` does not exist and block streaming calls `sendMessage` directly.

- [ ] **Step 3: Write minimal implementation**

Replace the default completion body and the block streamer callback with:

```ts
protected async sendResponseMessage(
  chatId: string,
  text: string,
  _sessionId: string,
): Promise<void> {
  await this.sendMessage(chatId, text);
}

protected async onResponseComplete(
  chatId: string,
  fullText: string,
  sessionId: string,
): Promise<void> {
  await this.sendResponseMessage(chatId, fullText, sessionId);
}

const streamer = useBlockStreaming
  ? new BlockStreamer({
      minChars: this.config.blockStreamingChunk?.minChars ?? 400,
      maxChars: this.config.blockStreamingChunk?.maxChars ?? 1000,
      idleMs: this.config.blockStreamingCoalesce?.idleMs ?? 1500,
      send: (text) =>
        this.sendResponseMessage(envelope.chatId, text, sessionId),
    })
  : null;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/channels/base && npx vitest run src/ChannelBase.test.ts -t "passes the prompt session"`

Expected: PASS with one delivery tagged `s-1`.

- [ ] **Step 5: Commit**

```bash
git add packages/channels/base/src/ChannelBase.ts packages/channels/base/src/ChannelBase.test.ts
git commit -m "feat(channels): preserve session for response delivery"
```

### Task 2: Send a real DingTalk mention for the correlated prompt

**Files:**

- Modify: `packages/channels/dingtalk/src/DingtalkAdapter.ts:106-112, 304-340, 953-1020`
- Modify: `packages/channels/dingtalk/src/DingtalkAdapter.test.ts:86-104, 1140-1164`

**Interfaces:**

- Consumes: `sendResponseMessage(chatId, text, sessionId)` from Task 1 and inbound `msgId`, `senderStaffId`, and `conversationType` from DingTalk.
- Produces: Markdown session-webhook payloads containing `at: { atUserIds: [staffId] }` only when `atSender` is enabled for the correlated group prompt.

- [ ] **Step 1: Write failing adapter payload tests**

Add a `DingtalkChannel reply mentions` suite before proactive-send tests. Use a mocked session webhook and `fetch`; seed the private maps through the existing test cast pattern.

```ts
it('mentions the originating group member when atSender is enabled', async () => {
  const channel = createChannel({ atSender: true });
  seedWebhook(channel, 'cid123');
  seedMentionTarget(channel, 'm1', 'staff-1');
  const fetchSpy = vi
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response('{}', { status: 200 }));

  getPromptHook(channel, 'onPromptStart')('cid123', 'session-1', 'm1');
  await getResponseHook(channel)('cid123', 'hello', 'session-1');

  expect(
    JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body)),
  ).toMatchObject({
    msgtype: 'markdown',
    markdown: { text: 'hello' },
    at: { atUserIds: ['staff-1'] },
  });
});
```

Add three equivalent assertions: default config has no `at`, an enabled prompt without a stored staff ID has no `at`, and a response longer than 3800 characters produces two payloads where only the first has `at`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/channels/dingtalk && npx vitest run src/DingtalkAdapter.test.ts -t "reply mentions"`

Expected: FAIL because `createChannel` has no `atSender` test override and the adapter has no response/session correlation or `at` payload.

- [ ] **Step 3: Write minimal implementation**

In `DingtalkChannel`, add these fields and helpers:

```ts
private readonly atSender: boolean;
private mentionTargets = new Map<string, string>();
private sessionMentionTargets = new Map<string, string>();

private async sendReply(
  chatId: string,
  text: string,
  atUserId?: string,
): Promise<void> {
  const webhook = this.webhooks.get(chatId);
  if (!webhook) return;
  const chunks = normalizeDingTalkMarkdown(text);
  const title = extractTitle(text);
  for (let i = 0; i < chunks.length; i++) {
    const body = {
      msgtype: 'markdown',
      markdown: { title: i === 0 ? title : `${title} (cont.)`, text: chunks[i]! },
      ...(i === 0 && atUserId ? { at: { atUserIds: [atUserId] } } : {}),
    };
    await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }
}
```

Set `this.atSender` in the constructor with `(config as Record<string, unknown>)['atSender'] === true`. Before `processMessage()` in `onMessage`, record only non-empty `msgId`, group, and `senderStaffId` targets. Extend the existing dedup timer to delete the same message ID from `mentionTargets` when it expires. Override `onPromptStart` to move a stored target to `sessionMentionTargets`; override `onPromptEnd` to clear that session entry; and override `sendResponseMessage` to call `sendReply` with the stored ID. Keep public `sendMessage` delegating to `sendReply(chatId, text)` so commands, fallbacks, and proactive paths do not acquire a mention.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/channels/dingtalk && npx vitest run src/DingtalkAdapter.test.ts -t "reply mentions"`

Expected: PASS; the first enabled response payload contains exactly `['staff-1']` and all other asserted payloads omit `at`.

- [ ] **Step 5: Commit**

```bash
git add packages/channels/dingtalk/src/DingtalkAdapter.ts packages/channels/dingtalk/src/DingtalkAdapter.test.ts
git commit -m "feat(dingtalk): optionally mention response sender"
```

### Task 3: Document configuration and validate the complete local change

**Files:**

- Modify: `docs/users/features/channels/dingtalk.md:28-43, 78-88, 102-106`

**Interfaces:**

- Consumes: the `atSender` behavior from Task 2.
- Produces: a copyable configuration example and an accurate statement of mention scope.

- [ ] **Step 1: Add documentation**

Add this configuration line after `groupPolicy` in the existing JSON example:

```json
"atSender": true,
```

Add this group-chat paragraph after the current mention-triggering explanation:

```md
Set `"atSender": true` to have the bot @mention the member whose group message triggered its response. It is off by default; it only applies to agent replies with a DingTalk staff ID, and only the first message of a long reply contains the mention.
```

- [ ] **Step 2: Verify documentation formatting**

Run: `npx prettier --check docs/users/features/channels/dingtalk.md`

Expected: PASS.

- [ ] **Step 3: Run focused regression tests**

Run:

```bash
cd packages/channels/base && npx vitest run src/ChannelBase.test.ts
cd ../dingtalk && npx vitest run src/DingtalkAdapter.test.ts
```

Expected: both test files PASS with no failures.

- [ ] **Step 4: Run build and typecheck from the worktree root**

Run: `npm run build && npm run typecheck`

Expected: both commands exit 0.

- [ ] **Step 5: Perform local DingTalk verification before any push**

Run:

```bash
npm run bundle
node dist/cli.js channel start my-dingtalk
```

With `"atSender": true` in the local channel configuration, @ the bot from an internal DingTalk group account and send a short prompt. Expected: the first response visibly @mentions and notifies that account. Repeat with `"atSender": false`; expected: an identical reply without a mention.

- [ ] **Step 6: Commit**

```bash
git add docs/users/features/channels/dingtalk.md
git commit -m "docs(dingtalk): explain response mentions"
git status --short
```
