# Channel Lifecycle Status Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show task lifecycle status through Telegram, Weixin, DingTalk, and
Feishu using each platform's existing native status surface.

**Architecture:** Keep the work adapter-local. P0 adds
`ChannelTaskLifecycleEvent` and `onTaskLifecycle`; this plan maps those events
to existing typing, reaction, and card paths without changing the shared channel
contract again. Because P0 still calls legacy prompt/streaming hooks, adapter
helpers must be idempotent and must not double-append streamed Feishu content.

**Tech Stack:** TypeScript, ESM, Vitest, existing channel packages under
`packages/channels/*`.

## Global Constraints

- Implement only Telegram, Weixin, DingTalk, and Feishu.
- Do not implement Slack behavior.
- Do not implement QQ Bot behavior.
- Do not update mock/plugin examples.
- Do not add terminal status emoji for DingTalk.
- Do not introduce a shared status-rendering abstraction.
- Keep platform status updates best-effort; failures must not fail the task.
- Run tests from each package directory with `npx vitest run ...`.
- Run `npm run build` and `npm run typecheck` before submitting the PR.
- Use neutral branch, issue, PR, and plan language.

---

## File Structure

- Modify `packages/channels/telegram/src/TelegramAdapter.ts`: add lifecycle
  mapping and idempotent typing helpers.
- Modify `packages/channels/telegram/src/TelegramAdapter.test.ts`: add direct
  lifecycle tests.
- Modify `packages/channels/weixin/src/WeixinAdapter.ts`: add lifecycle mapping
  and idempotent typing helpers.
- Create or modify `packages/channels/weixin/src/WeixinAdapter.test.ts`: add
  lifecycle typing tests if no adapter-level test already exists.
- Modify `packages/channels/dingtalk/src/DingtalkAdapter.ts`: add lifecycle
  mapping and idempotent reaction helpers.
- Modify `packages/channels/dingtalk/src/DingtalkAdapter.test.ts`: add lifecycle
  reaction tests.
- Modify `packages/channels/feishu/src/markdown.ts`: add a minimal card status
  label option.
- Modify `packages/channels/feishu/src/markdown.test.ts`: test running and
  terminal labels.
- Modify `packages/channels/feishu/src/FeishuAdapter.ts`: store terminal state
  from lifecycle and render explicit card labels.
- Modify `packages/channels/feishu/src/adapter.test.ts`: test completed,
  cancelled, and failed labels without double-streaming.

---

### Task 1: Prepare The Implementation Branch

**Files:**

- Read: `docs/design/2026-07-01-channel-lifecycle-status-adapters.md`
- Read: `packages/channels/base/src/types.ts`
- Read: `packages/channels/base/src/ChannelBase.ts`

**Interfaces:**

- Consumes: P0's exported `ChannelTaskLifecycleEvent` type.
- Produces: a working branch where adapter packages can import
  `ChannelTaskLifecycleEvent` from `@qwen-code/channel-base`.

- [ ] **Step 1: Verify P0 lifecycle exists**

Run:

```bash
rg -n "ChannelTaskLifecycleEvent|onTaskLifecycle" packages/channels/base/src
```

Expected: `packages/channels/base/src/types.ts` defines
`ChannelTaskLifecycleEvent`, and `packages/channels/base/src/ChannelBase.ts`
defines `protected onTaskLifecycle(...)`.

- [ ] **Step 2: If P0 is not on the current branch, base this work on P0**

Run:

```bash
git branch --show-current
rg -n "ChannelTaskLifecycleEvent|onTaskLifecycle" packages/channels/base/src
```

Expected: the lifecycle symbols exist before any adapter code is edited. If they
do not exist, switch to the P0 branch or wait for the P0 PR to merge, then rebase
this feature branch on that base.

- [ ] **Step 3: Commit only if a branch/base adjustment created metadata changes**

Run:

```bash
git status --short
```

Expected: no source changes from this task. Do not commit if the tree is clean.

---

### Task 2: Telegram Lifecycle Typing

**Files:**

- Modify: `packages/channels/telegram/src/TelegramAdapter.ts`
- Modify: `packages/channels/telegram/src/TelegramAdapter.test.ts`

**Interfaces:**

- Consumes:
  `type ChannelTaskLifecycleEvent` from `@qwen-code/channel-base`.
- Produces:
  `TelegramChannel.onTaskLifecycle(event: ChannelTaskLifecycleEvent): void`.

- [ ] **Step 1: Write failing lifecycle tests**

In `packages/channels/telegram/src/TelegramAdapter.test.ts`, import the
lifecycle type and add a test helper:

```ts
import type {
  ChannelAgentBridge,
  ChannelConfig,
  ChannelTaskLifecycleEvent,
  Envelope,
} from '@qwen-code/channel-base';

class TestTelegramChannel extends TelegramChannel {
  startTyping(chatId: string): void {
    this.onPromptStart(chatId, 'session-1', 'message-1');
  }

  emitLifecycle(event: ChannelTaskLifecycleEvent): void {
    this.onTaskLifecycle(event);
  }

  buildTestEnvelope(
    msg: TestTelegramMessage,
    text: string,
    entities?: TestTelegramEntity[],
  ): Envelope {
    return (
      this as unknown as {
        buildEnvelope: (
          msg: TestTelegramMessage,
          text: string,
          entities?: TestTelegramEntity[],
        ) => Envelope;
      }
    ).buildEnvelope(msg, text, entities);
  }
}
```

Add this test:

```ts
it('maps lifecycle start and terminal events to typing', () => {
  const channel = createChannel();
  const bot = installFakeBot(channel);

  const baseEvent = {
    channelName: 'telegram',
    chatId: 'chat-1',
    sessionId: 'session-1',
    messageId: 'message-1',
    identity: { id: 'channel:telegram', displayName: 'telegram' },
    memoryScope: { namespace: 'channel:telegram', mode: 'metadata-only' },
  } satisfies Omit<ChannelTaskLifecycleEvent, 'type'>;

  channel.emitLifecycle({ ...baseEvent, type: 'started' });
  channel.emitLifecycle({ ...baseEvent, type: 'started' });
  expect(bot.api.sendChatAction).toHaveBeenCalledTimes(1);

  vi.advanceTimersByTime(4000);
  expect(bot.api.sendChatAction).toHaveBeenCalledTimes(2);

  channel.emitLifecycle({ ...baseEvent, type: 'completed' });
  channel.emitLifecycle({ ...baseEvent, type: 'failed', error: 'boom' });

  vi.advanceTimersByTime(4000);
  expect(bot.api.sendChatAction).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run:

```bash
cd packages/channels/telegram && npx vitest run src/TelegramAdapter.test.ts
```

Expected: fail because `onTaskLifecycle` is not implemented in Telegram.

- [ ] **Step 3: Implement idempotent lifecycle typing**

In `packages/channels/telegram/src/TelegramAdapter.ts`, update the type import:

```ts
import type { ChannelTaskLifecycleEvent } from '@qwen-code/channel-base';
```

Replace the typing hook body with shared helpers:

```ts
private startTyping(chatId: string): void {
  if (this.typingIntervals.has(chatId)) return;

  const sendTyping = () =>
    this.bot.api.sendChatAction(chatId, 'typing').catch(() => {});
  sendTyping();
  this.typingIntervals.set(chatId, setInterval(sendTyping, 4000));
}

private stopTyping(chatId: string): void {
  const interval = this.typingIntervals.get(chatId);
  if (!interval) return;
  clearInterval(interval);
  this.typingIntervals.delete(chatId);
}

protected override onTaskLifecycle(event: ChannelTaskLifecycleEvent): void {
  if (event.type === 'started') {
    this.startTyping(event.chatId);
    return;
  }
  if (
    event.type === 'completed' ||
    event.type === 'cancelled' ||
    event.type === 'failed'
  ) {
    this.stopTyping(event.chatId);
  }
}

protected override onPromptStart(chatId: string): void {
  this.startTyping(chatId);
}

protected override onPromptEnd(chatId: string): void {
  this.stopTyping(chatId);
}
```

- [ ] **Step 4: Run Telegram tests**

Run:

```bash
cd packages/channels/telegram && npx vitest run src/TelegramAdapter.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit Telegram changes**

Run:

```bash
git add packages/channels/telegram/src/TelegramAdapter.ts packages/channels/telegram/src/TelegramAdapter.test.ts
git commit -m "feat(channels): map telegram lifecycle to typing"
```

---

### Task 3: Weixin Lifecycle Typing

**Files:**

- Modify: `packages/channels/weixin/src/WeixinAdapter.ts`
- Create or modify: `packages/channels/weixin/src/WeixinAdapter.test.ts`

**Interfaces:**

- Consumes:
  `type ChannelTaskLifecycleEvent` from `@qwen-code/channel-base`.
- Produces:
  `WeixinChannel.onTaskLifecycle(event: ChannelTaskLifecycleEvent): void`.

- [ ] **Step 1: Write failing tests**

If no adapter-level test exists, create
`packages/channels/weixin/src/WeixinAdapter.test.ts` with the local mocks needed
to instantiate `WeixinChannel`. Add a test-only subclass:

```ts
class TestWeixinChannel extends WeixinChannel {
  emitLifecycle(event: ChannelTaskLifecycleEvent): void {
    this.onTaskLifecycle(event);
  }
}
```

Add the behavior test:

```ts
it('maps lifecycle start and terminal events to typing state', () => {
  const channel = createChannel();
  const setTyping = vi.fn().mockResolvedValue(undefined);
  (channel as unknown as { setTyping: typeof setTyping }).setTyping = setTyping;

  const baseEvent = {
    channelName: 'weixin',
    chatId: 'user-1',
    sessionId: 'session-1',
    messageId: 'message-1',
    identity: { id: 'channel:weixin', displayName: 'weixin' },
    memoryScope: { namespace: 'channel:weixin', mode: 'metadata-only' },
  } satisfies Omit<ChannelTaskLifecycleEvent, 'type'>;

  channel.emitLifecycle({ ...baseEvent, type: 'started' });
  channel.emitLifecycle({ ...baseEvent, type: 'started' });
  channel.emitLifecycle({ ...baseEvent, type: 'cancelled', reason: 'clear' });
  channel.emitLifecycle({ ...baseEvent, type: 'completed' });

  expect(setTyping).toHaveBeenNthCalledWith(1, 'user-1', true);
  expect(setTyping).toHaveBeenNthCalledWith(2, 'user-1', false);
  expect(setTyping).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run:

```bash
cd packages/channels/weixin && npx vitest run src/WeixinAdapter.test.ts
```

Expected: fail because the lifecycle hook is not implemented.

- [ ] **Step 3: Implement idempotent typing helpers**

In `packages/channels/weixin/src/WeixinAdapter.ts`, import the lifecycle type and
add a per-chat active set:

```ts
import type { ChannelTaskLifecycleEvent } from '@qwen-code/channel-base';

private activeTypingChats = new Set<string>();
```

Replace prompt hook bodies with:

```ts
private startTyping(chatId: string): void {
  if (this.activeTypingChats.has(chatId)) return;
  this.activeTypingChats.add(chatId);
  this.setTyping(chatId, true).catch(() => {
    this.activeTypingChats.delete(chatId);
  });
}

private stopTyping(chatId: string): void {
  if (!this.activeTypingChats.delete(chatId)) return;
  this.setTyping(chatId, false).catch(() => {});
}

protected override onTaskLifecycle(event: ChannelTaskLifecycleEvent): void {
  if (event.type === 'started') {
    this.startTyping(event.chatId);
    return;
  }
  if (
    event.type === 'completed' ||
    event.type === 'cancelled' ||
    event.type === 'failed'
  ) {
    this.stopTyping(event.chatId);
  }
}

protected override onPromptStart(chatId: string): void {
  this.startTyping(chatId);
}

protected override onPromptEnd(chatId: string): void {
  this.stopTyping(chatId);
}
```

- [ ] **Step 4: Run Weixin tests**

Run:

```bash
cd packages/channels/weixin && npx vitest run src/WeixinAdapter.test.ts src/api.test.ts src/send.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit Weixin changes**

Run:

```bash
git add packages/channels/weixin/src/WeixinAdapter.ts packages/channels/weixin/src/WeixinAdapter.test.ts
git commit -m "feat(channels): map weixin lifecycle to typing"
```

---

### Task 4: DingTalk Lifecycle Reactions

**Files:**

- Modify: `packages/channels/dingtalk/src/DingtalkAdapter.ts`
- Modify: `packages/channels/dingtalk/src/DingtalkAdapter.test.ts`

**Interfaces:**

- Consumes:
  `type ChannelTaskLifecycleEvent` from `@qwen-code/channel-base`.
- Produces:
  `DingtalkChannel.onTaskLifecycle(event: ChannelTaskLifecycleEvent): void`.

- [ ] **Step 1: Write failing lifecycle tests**

In `packages/channels/dingtalk/src/DingtalkAdapter.test.ts`, import
`ChannelTaskLifecycleEvent` and add a lifecycle hook accessor:

```ts
function getLifecycleHook(
  channel: DingtalkChannelInstance,
): (event: ChannelTaskLifecycleEvent) => void {
  const fn = (channel as unknown as Record<string, unknown>)
    .onTaskLifecycle as (event: ChannelTaskLifecycleEvent) => void;
  return fn.bind(channel);
}
```

Add tests:

```ts
it('maps lifecycle start and terminal events to the eye reaction', () => {
  const channel = createChannel();
  const attachReaction = vi.fn().mockResolvedValue(undefined);
  const recallReaction = vi.fn().mockResolvedValue(undefined);
  (
    channel as unknown as {
      attachReaction: typeof attachReaction;
      recallReaction: typeof recallReaction;
    }
  ).attachReaction = attachReaction;
  (
    channel as unknown as {
      attachReaction: typeof attachReaction;
      recallReaction: typeof recallReaction;
    }
  ).recallReaction = recallReaction;

  const event = {
    channelName: 'dingtalk',
    chatId: 'cid-123',
    sessionId: 'session-1',
    messageId: 'message-1',
    identity: { id: 'channel:dingtalk', displayName: 'dingtalk' },
    memoryScope: { namespace: 'channel:dingtalk', mode: 'metadata-only' },
  } satisfies Omit<ChannelTaskLifecycleEvent, 'type'>;

  const lifecycle = getLifecycleHook(channel);
  lifecycle({ ...event, type: 'started' });
  lifecycle({ ...event, type: 'started' });
  lifecycle({ ...event, type: 'failed', error: 'boom' });
  lifecycle({ ...event, type: 'completed' });

  expect(attachReaction).toHaveBeenCalledOnce();
  expect(attachReaction).toHaveBeenCalledWith('message-1', 'cid-123');
  expect(recallReaction).toHaveBeenCalledOnce();
  expect(recallReaction).toHaveBeenCalledWith('message-1', 'cid-123');
});

it('does not attach lifecycle reactions without a conversation id', () => {
  const channel = createChannel();
  const attachReaction = vi.fn().mockResolvedValue(undefined);
  (
    channel as unknown as { attachReaction: typeof attachReaction }
  ).attachReaction = attachReaction;

  getLifecycleHook(channel)({
    type: 'started',
    channelName: 'dingtalk',
    chatId: 'HTTPS://oapi.dingtalk.com/robot/send?access_token=token',
    sessionId: 'session-1',
    messageId: 'message-1',
    identity: { id: 'channel:dingtalk', displayName: 'dingtalk' },
    memoryScope: { namespace: 'channel:dingtalk', mode: 'metadata-only' },
  });

  expect(attachReaction).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run:

```bash
cd packages/channels/dingtalk && npx vitest run src/DingtalkAdapter.test.ts
```

Expected: fail because lifecycle reactions are not implemented.

- [ ] **Step 3: Implement idempotent reaction helpers**

In `packages/channels/dingtalk/src/DingtalkAdapter.ts`, import the lifecycle type
and add a reaction key set:

```ts
import type { ChannelTaskLifecycleEvent } from '@qwen-code/channel-base';

private activeReactionKeys = new Set<string>();
```

Replace prompt hook bodies with helpers:

```ts
private reactionKey(messageId: string, conversationId: string): string {
  return `${conversationId}:${messageId}`;
}

private startReaction(chatId: string, messageId?: string): void {
  if (!messageId || !this.isConversationId(chatId)) return;
  const key = this.reactionKey(messageId, chatId);
  if (this.activeReactionKeys.has(key)) return;
  this.activeReactionKeys.add(key);
  this.attachReaction(messageId, chatId).catch(() => {
    this.activeReactionKeys.delete(key);
  });
}

private stopReaction(chatId: string, messageId?: string): void {
  if (!messageId || !this.isConversationId(chatId)) return;
  const key = this.reactionKey(messageId, chatId);
  if (!this.activeReactionKeys.delete(key)) return;
  this.recallReaction(messageId, chatId).catch(() => {});
}

protected override onTaskLifecycle(event: ChannelTaskLifecycleEvent): void {
  if (event.type === 'started') {
    this.startReaction(event.chatId, event.messageId);
    return;
  }
  if (
    event.type === 'completed' ||
    event.type === 'cancelled' ||
    event.type === 'failed'
  ) {
    this.stopReaction(event.chatId, event.messageId);
  }
}

protected override onPromptStart(
  chatId: string,
  _sessionId: string,
  messageId?: string,
): void {
  this.startReaction(chatId, messageId);
}

protected override onPromptEnd(
  chatId: string,
  _sessionId: string,
  messageId?: string,
): void {
  this.stopReaction(chatId, messageId);
}
```

- [ ] **Step 4: Run DingTalk tests**

Run:

```bash
cd packages/channels/dingtalk && npx vitest run src/DingtalkAdapter.test.ts src/markdown.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit DingTalk changes**

Run:

```bash
git add packages/channels/dingtalk/src/DingtalkAdapter.ts packages/channels/dingtalk/src/DingtalkAdapter.test.ts
git commit -m "feat(channels): map dingtalk lifecycle to reactions"
```

---

### Task 5: Feishu Card Status Labels

**Files:**

- Modify: `packages/channels/feishu/src/markdown.ts`
- Modify: `packages/channels/feishu/src/markdown.test.ts`

**Interfaces:**

- Produces:
  `buildCardContent(markdown, { statusLabel?: string })`.

- [ ] **Step 1: Write failing markdown tests**

In `packages/channels/feishu/src/markdown.test.ts`, add:

```ts
it('uses a custom running status label', () => {
  const card = buildCardContent('text', {
    isStreaming: true,
    statusLabel: '运行中...',
  }) as unknown as CardStructure;

  expect(card.body.elements[0]!.content).toContain('运行中...');
  expect(card.body.elements[0]!.content).not.toContain('生成中...');
});

it('uses a terminal status label without enabling streaming controls', () => {
  const card = buildCardContent('text', {
    statusLabel: '已完成',
  }) as unknown as CardStructure;

  expect(card.body.elements[0]!.content).toContain('已完成');
  expect(card.body.elements.some((e) => e.tag === 'button')).toBe(false);
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run:

```bash
cd packages/channels/feishu && npx vitest run src/markdown.test.ts
```

Expected: fail because `statusLabel` is not accepted.

- [ ] **Step 3: Implement the minimal status label option**

In `packages/channels/feishu/src/markdown.ts`, extend the options object:

```ts
statusLabel?: string;
```

Replace the current content markdown calculation with:

```ts
const statusLabel =
  options?.statusLabel ?? (options?.isStreaming ? '生成中...' : undefined);
const contentMd = statusLabel
  ? `${markdown}\n\n---\n*${statusLabel}*`
  : markdown;
```

- [ ] **Step 4: Run Feishu markdown tests**

Run:

```bash
cd packages/channels/feishu && npx vitest run src/markdown.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit markdown changes**

Run:

```bash
git add packages/channels/feishu/src/markdown.ts packages/channels/feishu/src/markdown.test.ts
git commit -m "feat(channels): add feishu card status labels"
```

---

### Task 6: Feishu Lifecycle Terminal Mapping

**Files:**

- Modify: `packages/channels/feishu/src/FeishuAdapter.ts`
- Modify: `packages/channels/feishu/src/adapter.test.ts`

**Interfaces:**

- Consumes:
  `type ChannelTaskLifecycleEvent` from `@qwen-code/channel-base`.
- Consumes:
  `buildCardContent(markdown, { statusLabel?: string })` from Task 5.
- Produces:
  explicit Feishu card labels for completed, cancelled, and failed states.

- [ ] **Step 1: Write failing adapter tests**

In `packages/channels/feishu/src/adapter.test.ts`, add tests that patch
`updateCard` and call lifecycle directly:

```ts
it('records failed lifecycle state for prompt-end card finalization', async () => {
  const channel = createChannel();
  const cardSessions = getPrivateMethod<Map<string, unknown>>(
    channel,
    'cardSessions',
  );
  cardSessions.set('inbound_1', {
    messageId: 'om_valid_message_id',
    created: true,
    creating: false,
    stopped: false,
    accumulatedText: 'partial answer',
    lastUpdateAt: Date.now(),
  });

  const updateCard = vi.fn().mockResolvedValue(true);
  (channel as unknown as { updateCard: typeof updateCard }).updateCard =
    updateCard;

  getPrivateMethod<(event: ChannelTaskLifecycleEvent) => void>(
    channel,
    'onTaskLifecycle',
  ).call(channel, {
    type: 'failed',
    channelName: 'feishu',
    chatId: 'oc_chat_id',
    sessionId: 'session_1',
    messageId: 'inbound_1',
    error: 'boom',
    identity: { id: 'channel:feishu', displayName: 'feishu' },
    memoryScope: { namespace: 'channel:feishu', mode: 'metadata-only' },
  });

  await getPrivateMethod<
    (chatId: string, sessionId: string, messageId?: string) => Promise<void>
  >(channel, 'onPromptEnd').call(
    channel,
    'oc_chat_id',
    'session_1',
    'inbound_1',
  );

  expect(updateCard.mock.calls[0]![1]).toContain('已失败，请重试');
});
```

Add the same shape for cancelled:

```ts
it('records cancelled lifecycle state for prompt-end card finalization', async () => {
  const channel = createChannel();
  const cardSessions = getPrivateMethod<Map<string, unknown>>(
    channel,
    'cardSessions',
  );
  cardSessions.set('inbound_1', {
    messageId: 'om_valid_message_id',
    created: true,
    creating: false,
    stopped: false,
    accumulatedText: 'partial answer',
    lastUpdateAt: Date.now(),
  });

  const updateCard = vi.fn().mockResolvedValue(true);
  (channel as unknown as { updateCard: typeof updateCard }).updateCard =
    updateCard;

  getPrivateMethod<(event: ChannelTaskLifecycleEvent) => void>(
    channel,
    'onTaskLifecycle',
  ).call(channel, {
    type: 'cancelled',
    reason: 'cancel_command',
    channelName: 'feishu',
    chatId: 'oc_chat_id',
    sessionId: 'session_1',
    messageId: 'inbound_1',
    identity: { id: 'channel:feishu', displayName: 'feishu' },
    memoryScope: { namespace: 'channel:feishu', mode: 'metadata-only' },
  });

  await getPrivateMethod<
    (chatId: string, sessionId: string, messageId?: string) => Promise<void>
  >(channel, 'onPromptEnd').call(
    channel,
    'oc_chat_id',
    'session_1',
    'inbound_1',
  );

  expect(updateCard.mock.calls[0]![1]).toContain('已取消');
});
```

Add a completed test by mocking the final `updateCard` call in
`onResponseComplete`:

```ts
it('marks completed cards with the completed status label', async () => {
  const channel = createChannel();
  const sessionToInboundMsg = getPrivateMethod<Map<string, string>>(
    channel,
    'sessionToInboundMsg',
  );
  const cardSessions = getPrivateMethod<Map<string, unknown>>(
    channel,
    'cardSessions',
  );
  sessionToInboundMsg.set('session_1', 'inbound_1');
  cardSessions.set('inbound_1', {
    messageId: 'om_valid_message_id',
    created: true,
    creating: false,
    stopped: false,
    accumulatedText: 'answer',
    lastUpdateAt: Date.now(),
  });

  const updateCard = vi.fn().mockResolvedValue(true);
  (channel as unknown as { updateCard: typeof updateCard }).updateCard =
    updateCard;

  await getPrivateMethod<
    (chatId: string, fullText: string, sessionId: string) => Promise<void>
  >(channel, 'onResponseComplete').call(
    channel,
    'oc_chat_id',
    'final answer',
    'session_1',
  );

  expect(updateCard.mock.calls[0]![1]).toContain('已完成');
});
```

- [ ] **Step 2: Run the focused adapter tests and confirm they fail**

Run:

```bash
cd packages/channels/feishu && npx vitest run src/adapter.test.ts
```

Expected: fail because Feishu does not store lifecycle terminal state or render
the new labels.

- [ ] **Step 3: Add terminal state to card sessions**

In `packages/channels/feishu/src/FeishuAdapter.ts`, import the lifecycle type and
extend `CardSessionState`:

```ts
import type { ChannelTaskLifecycleEvent } from '@qwen-code/channel-base';

type FeishuTerminalStatus = 'completed' | 'cancelled' | 'failed';

interface CardSessionState {
  terminalStatus?: FeishuTerminalStatus;
}
```

If `CardSessionState` already exists, only add the `terminalStatus` property to
the existing interface.

- [ ] **Step 4: Add Feishu lifecycle handling without double-streaming**

Add this method to `FeishuAdapter.ts`:

```ts
protected override onTaskLifecycle(event: ChannelTaskLifecycleEvent): void {
  if (
    event.type !== 'completed' &&
    event.type !== 'cancelled' &&
    event.type !== 'failed'
  ) {
    return;
  }

  const inboundMsgId =
    event.messageId || this.sessionToInboundMsg.get(event.sessionId);
  if (!inboundMsgId) return;

  const cardState = this.cardSessions.get(inboundMsgId);
  if (!cardState) return;

  cardState.terminalStatus = event.type;
}
```

Do not process `text_chunk` in `onTaskLifecycle` in this task. The base channel
still calls `onResponseChunk` immediately after emitting the lifecycle chunk, so
handling both paths would duplicate Feishu card content.

- [ ] **Step 5: Pass status labels into card rendering**

Add a helper:

```ts
private statusLabelFor(terminalStatus?: FeishuTerminalStatus): string {
  switch (terminalStatus) {
    case 'completed':
      return '已完成';
    case 'cancelled':
      return '已取消';
    case 'failed':
      return '已失败，请重试';
    default:
      return '运行中...';
  }
}
```

Update `createStreamingCard` and non-final `updateCard` calls to use the running
label:

```ts
const card = buildCardContent(text, {
  title: cardTitle,
  showStopButton: true,
  isStreaming: true,
  statusLabel: this.statusLabelFor(),
  collapsible: this.collapsible,
  collapsibleThreshold: this.collapsibleThreshold,
});
```

Update `updateCard` so final calls can pass a terminal label:

```ts
private async updateCard(
  messageId: string,
  text: string,
  finished = false,
  inboundMsgId?: string,
  statusLabel?: string,
): Promise<boolean> {
  const card = buildCardContent(text, {
    title: cardTitle,
    showStopButton: !finished,
    isStreaming: !finished,
    statusLabel,
    collapsible: this.collapsible,
    collapsibleThreshold: this.collapsibleThreshold,
  });
}
```

When `onResponseComplete` finalizes a card, pass the completed label:

```ts
await this.updateCard(
  cardState.messageId,
  `${displayText}\n\n---\n*${this.statusLabelFor('completed')}*`,
  true,
  inboundMsgId,
);
```

When `onPromptEnd` finalizes a failed or cancelled card, use the stored terminal
state:

```ts
const terminalStatus = cs.terminalStatus || 'failed';
const terminalLabel = this.statusLabelFor(terminalStatus);
const text = cs.accumulatedText
  ? (atPrefix ? `${atPrefix}\n\n${cs.accumulatedText}` : cs.accumulatedText) +
    '\n\n---\n' +
    `*${terminalLabel}*`
  : (atPrefix ? `${atPrefix}\n\n` : '') + `*${terminalLabel}*`;
```

Do not append the label both in `text` and through `statusLabel` on the same
call. Use the existing text-append style in `onPromptEnd` and use
`statusLabel` for normal card builder paths.

- [ ] **Step 6: Run Feishu tests**

Run:

```bash
cd packages/channels/feishu && npx vitest run src/markdown.test.ts src/adapter.test.ts
```

Expected: pass.

- [ ] **Step 7: Commit Feishu changes**

Run:

```bash
git add packages/channels/feishu/src/markdown.ts packages/channels/feishu/src/markdown.test.ts packages/channels/feishu/src/FeishuAdapter.ts packages/channels/feishu/src/adapter.test.ts
git commit -m "feat(channels): show feishu lifecycle card status"
```

---

### Task 7: Final Verification And PR Prep

**Files:**

- Read: `.github/pull_request_template.md`
- Write if needed: `.qwen/pr-drafts/channel-lifecycle-status-adapters.md`

**Interfaces:**

- Consumes: all prior adapter commits.
- Produces: verified branch ready for PR.

- [ ] **Step 1: Run focused channel tests**

Run:

```bash
cd packages/channels/telegram && npx vitest run src/TelegramAdapter.test.ts
cd packages/channels/weixin && npx vitest run src/WeixinAdapter.test.ts src/api.test.ts src/send.test.ts
cd packages/channels/dingtalk && npx vitest run src/DingtalkAdapter.test.ts src/markdown.test.ts
cd packages/channels/feishu && npx vitest run src/markdown.test.ts src/adapter.test.ts
```

Expected: all pass.

- [ ] **Step 2: Run project verification**

Run:

```bash
npm run build
npm run typecheck
```

Expected: both pass.

- [ ] **Step 3: Inspect final diff**

Run:

```bash
git status --short
git diff --stat main...HEAD
```

Expected: only the design/plan and four channel adapter areas changed.

- [ ] **Step 4: Prepare PR body**

Use `.github/pull_request_template.md`. Keep the description prose-based and do
not hard-wrap paragraphs. The reviewer test plan should say:

```markdown
## Reviewer Test Plan

- Verify Telegram shows typing while a task is running and clears typing when it completes, is cancelled, or fails.
- Verify Weixin sends typing true while a task is running and typing false for completed, cancelled, and failed terminal states.
- Verify DingTalk keeps the existing eye reaction behavior: attach while running and recall on completed, cancelled, or failed, with no terminal emoji.
- Verify Feishu cards show running, completed, cancelled, and failed labels without duplicating streamed content.
```

- [ ] **Step 5: Open PR**

Run:

```bash
git push -u origin feat/channel-lifecycle-status-adapters
gh pr create --fill
```

Expected: PR opens against the repository default branch.

---

## Self-Review

- Spec coverage: Tasks 2-4 cover Telegram, Weixin, and DingTalk lifecycle status
  mapping. Tasks 5-6 cover Feishu card labels and terminal lifecycle mapping.
  Task 7 covers package-local tests, build, typecheck, and PR prep.
- Scope check: no Slack, QQ Bot, mock/plugin, or shared abstraction work is
  included.
- Ambiguity check: Feishu `text_chunk` lifecycle is intentionally not consumed
  directly because the base still calls the legacy `onResponseChunk` hook in the
  same path. This prevents duplicate card content while preserving existing
  streaming behavior.
- Placeholder scan: no placeholder markers remain.
