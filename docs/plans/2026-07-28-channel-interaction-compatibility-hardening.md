# Channel Interaction Compatibility Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make DingTalk card callbacks explicit, owner-safe, and visible to the
clicker while preserving unconfigured Markdown behavior and existing Feishu
and QQ streaming semantics.

**Architecture:** `ChannelBase` gets a segment-end hook distinct from the
legacy provider response-boundary hook. DingTalk controllers return a local
three-state result, and `DingtalkChannel` owns callback acknowledgement and
direct feedback delivery. No cross-platform card API is added.

**Tech Stack:** TypeScript, Node.js 22+, Vitest, DingTalk Stream SDK, DingTalk
Robot OpenAPI.

## Global Constraints

- Keep the Core `ask_user_question` event, schema, and response contract
  unchanged.
- Keep card actions, card handles, DingTalk actor IDs, and DingTalk message
  delivery out of `ChannelBase`.
- `accepted` executes the original action and updates the original card without
  a second success message.
- `forbidden` and `ignored` do not mutate the card, cancel a run, settle a
  permission, enqueue a prompt, or enter Agent context.
- Feedback is a direct DingTalk message to the authenticated clicker; never
  send it to the origin group and never use `@`.
- Omitting `interactiveCards` preserves the legacy Markdown and text-permission
  path.
- Feishu and QQ receive `onResponseBoundary` only for an actual provider
  response boundary.
- The pull request remains Draft.
- Stage only the files named by the current task. The local Chinese design
  translation is never staged or pushed.

---

### Task 1: Synchronize the branch and confirm the post-rebase baseline

**Files:**

- No source files.
- Preserve local only:
  `docs/design/2026-07-28-channel-interaction-compatibility-hardening.md`
  Chinese working-tree translation.

**Interfaces:**

- Consumes: current Draft PR branch and `origin/main`.
- Produces: a clean rebased implementation base with the Chinese translation
  kept outside commits.

- [ ] **Step 1: Protect the local Chinese translation**

Stash only the unstaged translated design before rebasing:

```bash
git stash push -m "local Chinese interaction design" -- \
  docs/design/2026-07-28-channel-interaction-compatibility-hardening.md
```

Expected: the worktree is clean and the English design remains at `HEAD`.

- [ ] **Step 2: Fetch and rebase onto the current main**

```bash
git fetch origin main
git rebase origin/main
```

Expected: the rebase completes without losing the Draft PR commits. If a
conflict appears, resolve only the files changed by PR #6930 and retain both
latest-main behavior and the approved interaction contract.

- [ ] **Step 3: Restore the local-only Chinese translation**

```bash
git stash pop
```

Expected: only the Chinese design translation is unstaged.

- [ ] **Step 4: Run the focused baseline**

```bash
cd packages/channels/base
npx vitest run src/SessionRouter.test.ts src/ChannelBase.test.ts

cd ../dingtalk
npx vitest run \
  src/interactive-card-types.test.ts \
  src/question-card-controller.test.ts \
  src/status-card-controller.test.ts \
  src/interaction-presenter.test.ts \
  src/DingtalkAdapter.test.ts

cd ../feishu
npx vitest run src/adapter.test.ts

cd ../qqbot
npx vitest run src/stream.test.ts
```

Expected: all baseline tests pass before behavioral changes.

### Task 2: Restore the legacy response-boundary contract

**Files:**

- Modify: `packages/channels/base/src/ChannelBase.ts`
- Modify: `packages/channels/base/src/ChannelBase.test.ts`
- Modify: `packages/channels/dingtalk/src/DingtalkAdapter.ts`
- Modify: `packages/channels/dingtalk/src/DingtalkAdapter.test.ts`

**Interfaces:**

- Consumes:

```ts
type ChannelOutputSegmentEndReason =
  | 'response_boundary'
  | 'input_requested'
  | 'completed'
  | 'failed'
  | 'cancelled';
```

- Produces:

```ts
protected onOutputSegmentEnd(
  chatId: string,
  sessionId: string,
  segment: ChannelOutputSegmentContext,
  reason: ChannelOutputSegmentEndReason,
): void | Promise<void>;

protected onResponseBoundary(
  chatId: string,
  sessionId: string,
): void | Promise<void>;
```

- [ ] **Step 1: Write failing shared-hook tests**

Change the test adapter to record provider boundaries separately from output
segment ends:

```ts
responseBoundaries: Array<{ chatId: string; sessionId: string }> = [];
outputSegmentEnds: Array<{
  chatId: string;
  sessionId: string;
  segment?: ChannelOutputSegmentContext;
  reason: ChannelOutputSegmentEndReason;
}> = [];

protected override onResponseBoundary(
  chatId: string,
  sessionId: string,
): void {
  this.responseBoundaries.push({ chatId, sessionId });
}

protected override onOutputSegmentEnd(
  chatId: string,
  sessionId: string,
  segment: ChannelOutputSegmentContext,
  reason: ChannelOutputSegmentEndReason,
): void {
  this.outputSegmentEnds.push({ chatId, sessionId, segment, reason });
  super.onOutputSegmentEnd(chatId, sessionId, segment, reason);
}
```

Update the existing segment tests to assert:

```ts
expect(ch.outputSegmentEnds).toEqual([
  expect.objectContaining({ reason: 'response_boundary' }),
  expect.objectContaining({ reason: 'completed' }),
]);
expect(ch.responseBoundaries).toEqual([{ chatId: 'chat1', sessionId: 's-1' }]);
```

Add equivalent assertions for streamed completion, failure, and cancellation:

```ts
expect(ch.outputSegmentEnds.at(-1)?.reason).toBe('failed');
expect(ch.responseBoundaries).toEqual([]);
```

Update the existing output-then-question test to expect:

```ts
const order: string[] = [];
ch.userInputPresentationHandler = async () => {
  order.push('present');
  return { kind: 'presented' };
};
ch.onOutputSegmentEndForTest = (reason) => {
  order.push(reason);
};

expect(ch.outputSegmentEnds).toEqual([
  expect.objectContaining({
    segment: expect.objectContaining({ segmentId: segment?.segmentId }),
    reason: 'input_requested',
  }),
]);
expect(ch.responseBoundaries).toEqual([]);
expect(order).toEqual(['input_requested', 'present']);
```

Expose `onOutputSegmentEndForTest` as an optional test callback invoked by the
test adapter's `onOutputSegmentEnd` override after recording the event.

```ts
expect(ch.outputSegmentEnds.at(-1)?.reason).toBe('cancelled');
expect(ch.responseBoundaries).toEqual([]);
```

- [ ] **Step 2: Run the shared tests and verify red**

```bash
cd packages/channels/base
npx vitest run src/ChannelBase.test.ts
```

Expected: FAIL because `onOutputSegmentEnd` does not exist and synthetic
segment ends still call `onResponseBoundary`.

- [ ] **Step 3: Implement the minimal hook split**

Make `notifyOutputSegmentEnd` await the new hook while containing adapter
failures:

```ts
private async notifyOutputSegmentEnd(
  chatId: string,
  sessionId: string,
  segment: ChannelOutputSegmentContext | undefined,
  reason: ChannelOutputSegmentEndReason,
): Promise<void> {
  if (!segment) return;
  try {
    await this.onOutputSegmentEnd(chatId, sessionId, segment, reason);
  } catch (error) {
    process.stderr.write(
      `[${this.name}] output segment boundary failed for session ${sanitizeLogText(
        sessionId,
        64,
      )}: ${this.lifecycleError(error)}\n`,
    );
  }
}
```

Add the default implementation:

```ts
protected onOutputSegmentEnd(
  chatId: string,
  sessionId: string,
  _segment: ChannelOutputSegmentContext,
  reason: ChannelOutputSegmentEndReason,
): void | Promise<void> {
  if (reason === 'response_boundary') {
    return this.onResponseBoundary(chatId, sessionId);
  }
}
```

Restore `onResponseBoundary` to its legacy two-argument signature and
documentation. Leave the existing direct calls used by legacy loop/synthetic
paths unchanged.

When `tryPresentUserInput` closes a preceding segment, notify the new hook
before invoking the presenter:

```ts
if (precedingSegment) {
  await this.notifyOutputSegmentEnd(
    pending.target.chatId,
    pending.sessionId,
    precedingSegment,
    'input_requested',
  );
}
```

Place this await inside the existing async presentation closure immediately
before `presentUserInputRequest(context)`. Change non-awaited lifecycle call
sites to `void this.notifyOutputSegmentEnd(...)`; their projection remains
best-effort and lifecycle settlement remains non-blocking.

- [ ] **Step 4: Move DingTalk to the new hook**

Rename only the DingTalk override:

```ts
protected override onOutputSegmentEnd(
  _chatId: string,
  _sessionId: string,
  segment: ChannelOutputSegmentContext,
  reason: ChannelOutputSegmentEndReason,
): void | Promise<void> {
  if (!this.interactionPresenter) return;
  return this.interactionPresenter
    .closeOutput(segment.segmentId, '', reason, segment)
    .then(() => undefined);
}
```

Remove the explicit `precedingSegmentId` close from
`presentUserInputRequest`; the shared segment-end hook now performs that close
once before input presentation.

Update the focused DingTalk hook helper/test to invoke `onOutputSegmentEnd` and
keep the same presenter assertion. Update the question-card test to assert
`presentInput(context)` directly, without expecting a second `closeOutput`
call.

- [ ] **Step 5: Run shared and DingTalk hook tests**

```bash
cd packages/channels/base
npx vitest run src/ChannelBase.test.ts

cd ../dingtalk
npx vitest run src/DingtalkAdapter.test.ts src/interaction-presenter.test.ts
```

Expected: PASS. Completion, failure, cancellation, and input request are
visible to DingTalk but not to legacy boundary overrides.

- [ ] **Step 6: Commit the hook split**

```bash
git add \
  packages/channels/base/src/ChannelBase.ts \
  packages/channels/base/src/ChannelBase.test.ts \
  packages/channels/dingtalk/src/DingtalkAdapter.ts \
  packages/channels/dingtalk/src/DingtalkAdapter.test.ts
git commit -m "fix(channels): separate output segment ends"
```

### Task 3: Make DingTalk interactive cards explicit opt-in

**Files:**

- Modify:
  `packages/channels/dingtalk/src/interactive-card-types.test.ts`
- Modify: `packages/channels/dingtalk/src/interactive-card-types.ts`
- Modify: `packages/channels/dingtalk/src/DingtalkAdapter.ts`
- Modify: `packages/channels/dingtalk/src/DingtalkAdapter.test.ts`

**Interfaces:**

- Consumes: `parseDingtalkInteractiveCardConfig(value: unknown)`.
- Produces:

```ts
parseDingtalkInteractiveCardConfig(undefined).enabled === false;
parseDingtalkInteractiveCardConfig({}).enabled === true;
```

- [ ] **Step 1: Write failing configuration tests**

Replace the implicit-default assertion with:

```ts
expect(parseDingtalkInteractiveCardConfig(undefined)).toEqual({
  enabled: false,
  statusCard: { enabled: true },
  questionCard: { enabled: true, timeoutMs: 300_000 },
});

expect(parseDingtalkInteractiveCardConfig({})).toEqual({
  enabled: true,
  statusCard: { enabled: true },
  questionCard: { enabled: true, timeoutMs: 300_000 },
});
```

In the adapter test helper, explicitly opt card-specific tests in:

```ts
interactiveCards: {},
...overrides,
```

Add an unconfigured adapter test:

```ts
const channel = createChannel({ interactiveCards: undefined });
const client = latestMockClient() as MockDingtalkClient;

expect([...client.callbacks.keys()]).toEqual(['robot']);
expect(
  (channel as unknown as { interactionPresenter?: unknown })
    .interactionPresenter,
).toBeUndefined();
```

Add a presenter fallback test using a context whose `respond` is a spy:

```ts
const channel = createChannel({ interactiveCards: undefined });
const respond = vi.fn().mockResolvedValue(true);
const context = {
  requestId: 'request-disabled',
  sessionId: 'session-disabled',
  runId: 'run-disabled',
  owner: { kind: 'channel_user', id: 'owner-1' },
  target: {
    channelName: 'dingtalk',
    senderId: 'owner-1',
    chatId: 'conversation-1',
    isGroup: false,
  },
  questions: [],
  submitOptionId: 'proceed_once',
  onSettled: () => () => {},
  respond,
} as ChannelUserInputRequestContext;

await expect(getUserInputHook(channel)(context)).resolves.toEqual({
  kind: 'unsupported',
});
expect(respond).not.toHaveBeenCalled();
```

Repeat with `interactiveCards: { enabled: false }` and with
`interactiveCards: { questionCard: { enabled: false } }`. This proves
disabled native presentation returns control to `ChannelBase` instead of
cancelling the question.

- [ ] **Step 2: Run the configuration tests and verify red**

```bash
cd packages/channels/dingtalk
npx vitest run src/interactive-card-types.test.ts src/DingtalkAdapter.test.ts
```

Expected: FAIL because omitted configuration currently enables cards and
registers the card callback topic.

- [ ] **Step 3: Implement explicit opt-in**

Use presence of the root object as the top-level fallback:

```ts
const configured = value !== undefined;
const root = asRecord(value) ?? {};

return {
  enabled: optionalBoolean(root['enabled'], 'enabled', configured),
  statusCard: {
    enabled: optionalBoolean(status?.['enabled'], 'statusCard.enabled', true),
  },
  questionCard: {
    enabled: optionalBoolean(
      question?.['enabled'],
      'questionCard.enabled',
      true,
    ),
    timeoutMs,
  },
};
```

Do not add a shared capability flag. Existing constructor checks already avoid
controller creation and callback registration when `enabled` is false.

Return the shared unsupported result whenever no question controller/presenter
is available:

```ts
if (!this.questionCardController || !this.interactionPresenter) {
  return { kind: 'unsupported' };
}
return this.interactionPresenter.presentInput(context);
```

Do not send the branch-specific “interactive questions are disabled” message
and do not call `context.respond`. `ChannelBase` will continue through its
pre-existing text-permission fallback.

- [ ] **Step 4: Run the DingTalk configuration tests**

```bash
cd packages/channels/dingtalk
npx vitest run src/interactive-card-types.test.ts src/DingtalkAdapter.test.ts
```

Expected: PASS for omitted, `{}`, explicit true/false, and subtype toggles.

- [ ] **Step 5: Commit explicit opt-in**

```bash
git add \
  packages/channels/dingtalk/src/interactive-card-types.ts \
  packages/channels/dingtalk/src/interactive-card-types.test.ts \
  packages/channels/dingtalk/src/DingtalkAdapter.ts \
  packages/channels/dingtalk/src/DingtalkAdapter.test.ts
git commit -m "fix(dingtalk): require interactive card opt-in"
```

### Task 4: Return explicit three-state controller results

**Files:**

- Modify: `packages/channels/dingtalk/src/interactive-card-types.ts`
- Modify:
  `packages/channels/dingtalk/src/interactive-card-types.test.ts`
- Modify: `packages/channels/dingtalk/src/status-card-controller.ts`
- Modify:
  `packages/channels/dingtalk/src/status-card-controller.test.ts`
- Modify: `packages/channels/dingtalk/src/question-card-controller.ts`
- Modify:
  `packages/channels/dingtalk/src/question-card-controller.test.ts`
- Modify:
  `packages/channels/dingtalk/src/interaction-presenter.test.ts`

**Interfaces:**

- Produces:

```ts
export type DingtalkCardCallbackResult =
  | { kind: 'accepted'; execute: () => Promise<void> }
  | { kind: 'forbidden'; actorId: string }
  | { kind: 'ignored'; actorId?: string };

export interface DingtalkCardCallback {
  outTrackId: string;
  actionId: string;
  actorId: string;
  formData: Record<string, unknown>;
  hasBusinessPayload?: boolean;
  isCancel?: boolean;
}

export function parseDingtalkCardActorId(value: unknown): string | undefined;
```

- [ ] **Step 1: Write parser and result-shape tests**

Change parser expectations from `ownerId` to `actorId` and add:

```ts
expect(
  parseDingtalkCardActorId({
    userId: ' actor-1 ',
    value: JSON.stringify({ outTrackId: 'missing-action' }),
  }),
).toBe('actor-1');
```

This preserves a trusted actor for an otherwise malformed callback.

- [ ] **Step 2: Write failing status-controller tests**

Replace undefined-action assertions with:

```ts
expect(controller.claimStop(outTrackId, 'other')).toEqual({
  kind: 'forbidden',
  actorId: 'other',
});

const accepted = controller.claimStop(outTrackId, 'owner-1');
expect(accepted.kind).toBe('accepted');
if (accepted.kind === 'accepted') await accepted.execute();

expect(controller.claimStop(outTrackId, 'owner-1')).toEqual({
  kind: 'ignored',
  actorId: 'owner-1',
});
```

Also assert the owner can still claim after a forbidden attempt.

- [ ] **Step 3: Write failing question-controller tests**

Cover owner mismatch before malformed action checks:

```ts
expect(
  controller.claim({
    outTrackId,
    actionId: 'submit',
    actorId: 'other',
    formData: { '0': 'Beijing' },
  }),
).toEqual({ kind: 'forbidden', actorId: 'other' });

const accepted = controller.claim({
  outTrackId,
  actionId: 'submit',
  actorId: 'owner-1',
  formData: { '0': 'Beijing' },
});
expect(accepted.kind).toBe('accepted');
if (accepted.kind === 'accepted') await accepted.execute();
```

Add `ignored` assertions for unknown outTrack ID, terminal record, duplicate
claim, non-business callback, unsupported action, and invalid form answers.

- [ ] **Step 4: Run controller tests and verify red**

```bash
cd packages/channels/dingtalk
npx vitest run \
  src/interactive-card-types.test.ts \
  src/status-card-controller.test.ts \
  src/question-card-controller.test.ts \
  src/interaction-presenter.test.ts
```

Expected: FAIL because controllers still return a function or `undefined`.

- [ ] **Step 5: Implement actor parsing and the result union**

Extract the actor only from authenticated top-level DingTalk identity fields:

```ts
export function parseDingtalkCardActorId(value: unknown): string | undefined {
  const root = parseEmbeddedRecord(value);
  if (!root) return undefined;
  return ['userId', 'senderStaffId', 'senderId']
    .map((key) => root[key])
    .find(
      (candidate): candidate is string =>
        typeof candidate === 'string' && candidate.trim().length > 0,
    )
    ?.trim();
}
```

`parseDingtalkCardCallback` calls that helper and stores `actorId`.

- [ ] **Step 6: Implement minimal controller decision order**

Status Stop:

```ts
const record = this.recordsByOutTrack.get(outTrackId);
if (!record || record.terminal || record.stopClaimed) {
  return { kind: 'ignored', actorId };
}
if (record.ownerId !== actorId) {
  return { kind: 'forbidden', actorId };
}
record.stopClaimed = true;
return {
  kind: 'accepted',
  execute: async () => {
    const cancelled = await this.options.cancelRun(
      record.sessionId,
      record.runId,
    );
    if (this.recordsByOutTrack.get(outTrackId) !== record || record.terminal) {
      return;
    }
    if (!cancelled) {
      record.stopClaimed = false;
      return;
    }
    this.cancelRun(record.runId, 'cancel_command');
  },
};
```

Question callback:

```ts
const record = this.byOutTrack.get(callback.outTrackId);
if (!record || record.state !== 'pending') {
  return { kind: 'ignored', actorId: callback.actorId };
}
if (record.context.owner.id !== callback.actorId) {
  return { kind: 'forbidden', actorId: callback.actorId };
}
if (callback.hasBusinessPayload === false) {
  return { kind: 'ignored', actorId: callback.actorId };
}
if (callback.isCancel || callback.actionId === 'cancel') {
  this.reserveTerminalProjection(record);
  record.state = 'claimed';
  return {
    kind: 'accepted',
    execute: () => this.respond(record, 'cancelled'),
  };
}
if (
  callback.actionId !== 'submit' &&
  callback.actionId !== record.context.requestId
) {
  return { kind: 'ignored', actorId: callback.actorId };
}
const answers = this.parseAnswers(record, callback.formData);
if (!answers) {
  return { kind: 'ignored', actorId: callback.actorId };
}
this.reserveTerminalProjection(record);
record.state = 'claimed';
return {
  kind: 'accepted',
  execute: () => this.respond(record, 'submitted', answers),
};
```

Keep the existing `respond` and terminal projection methods unchanged.

- [ ] **Step 7: Run controller tests**

```bash
cd packages/channels/dingtalk
npx vitest run \
  src/interactive-card-types.test.ts \
  src/status-card-controller.test.ts \
  src/question-card-controller.test.ts \
  src/interaction-presenter.test.ts
```

Expected: PASS. Forbidden attempts leave the record pending, and only the first
valid owner action executes.

- [ ] **Step 8: Commit controller outcomes**

```bash
git add \
  packages/channels/dingtalk/src/interactive-card-types.ts \
  packages/channels/dingtalk/src/interactive-card-types.test.ts \
  packages/channels/dingtalk/src/status-card-controller.ts \
  packages/channels/dingtalk/src/status-card-controller.test.ts \
  packages/channels/dingtalk/src/question-card-controller.ts \
  packages/channels/dingtalk/src/question-card-controller.test.ts \
  packages/channels/dingtalk/src/interaction-presenter.test.ts
git commit -m "fix(dingtalk): classify card callback outcomes"
```

### Task 5: Deliver forbidden and ignored feedback directly

**Files:**

- Modify: `packages/channels/dingtalk/src/DingtalkAdapter.ts`
- Modify: `packages/channels/dingtalk/src/DingtalkAdapter.test.ts`

**Interfaces:**

- Consumes: `DingtalkCardCallbackResult` and
  `parseDingtalkCardActorId(value)`.
- Produces:

```ts
protected routeCardCallback(
  callback: DingtalkCardCallback,
): DingtalkCardCallbackResult;

private sendCardInteractionFeedback(
  actorId: string,
  kind: 'forbidden' | 'ignored',
): Promise<void>;
```

- [ ] **Step 1: Write failing adapter-ordering tests**

Return `{ kind: 'accepted', execute }` from the callback test subclass and keep
the existing ordering assertion:

```ts
expect(events).toEqual(['ack', 'action']);
```

Add a forbidden test:

```ts
expect(events[0]).toBe('ack');
await vi.waitFor(() => expect(directSendCalls()).toHaveLength(1));
expect(action).not.toHaveBeenCalled();
const requestBody = JSON.parse(
  String((directSendCalls()[0]![1] as RequestInit).body),
);
expect(requestBody.userIds).toEqual(['other-user']);
expect(requestBody.openConversationId).toBeUndefined();
expect(JSON.parse(requestBody.msgParam).text).toContain('无权操作');
```

Add equivalent tests for:

- `ignored` with a trusted actor uses the generic expired message;
- malformed callback with a top-level `userId` uses
  `parseDingtalkCardActorId` and sends the generic message;
- malformed callback without an actor sends no message;
- direct-message delivery failure is logged and never calls the group API;
- `accepted` never sends feedback.

- [ ] **Step 2: Run adapter tests and verify red**

```bash
cd packages/channels/dingtalk
npx vitest run src/DingtalkAdapter.test.ts
```

Expected: FAIL because routing still returns a function or `undefined` and no
feedback is sent.

- [ ] **Step 3: Implement result routing and ACK-first execution**

Build an ignored result when full parsing fails:

```ts
const callback = parseDingtalkCardCallback(msg.data);
const actorId = callback?.actorId ?? parseDingtalkCardActorId(msg.data);
let result: DingtalkCardCallbackResult;
try {
  result = callback
    ? this.routeCardCallback(callback)
    : { kind: 'ignored', ...(actorId ? { actorId } : {}) };
} catch (error) {
  process.stderr.write(
    `[DingTalk:${this.name}] card callback routing failed: ${sanitizeLogText(
      String(error),
      200,
    )}\n`,
  );
  result = { kind: 'ignored', ...(actorId ? { actorId } : {}) };
}

client.send(msg.headers.messageId, {
  status: EventAck.SUCCESS,
  message: 'ok',
});

if (result.kind === 'accepted') {
  void result.execute().catch((error) => {
    process.stderr.write(
      `[DingTalk:${this.name}] card callback action failed: ${sanitizeLogText(
        String(error),
        200,
      )}\n`,
    );
  });
} else if (result.actorId) {
  void this.sendCardInteractionFeedback(result.actorId, result.kind).catch(
    (error) => {
      process.stderr.write(
        `[DingTalk:${this.name}] card interaction feedback failed: ${sanitizeLogText(
          String(error),
          200,
        )}\n`,
      );
    },
  );
}
```

Controller routing returns `ignored` when the relevant card feature is
disabled:

```ts
return (
  this.questionCardController?.claim(callback) ?? {
    kind: 'ignored',
    actorId: callback.actorId,
  }
);
```

- [ ] **Step 4: Implement direct-only feedback**

Reuse the existing direct Robot OpenAPI path:

```ts
private sendCardInteractionFeedback(
  actorId: string,
  kind: 'forbidden' | 'ignored',
): Promise<void> {
  const text =
    kind === 'forbidden'
      ? '你无权操作这张卡片，仅任务发起人可以提交或停止。'
      : '该卡片操作已失效或暂时无法处理。';
  return this.sendProactiveChunk(
    {
      channelName: this.name,
      senderId: actorId,
      chatId: actorId,
      isGroup: false,
    },
    '卡片操作',
    text,
    'card interaction feedback',
  );
}
```

Do not call `sendMessage`, do not read the origin chat target, and do not add a
group fallback.

- [ ] **Step 5: Run full DingTalk tests**

```bash
cd packages/channels/dingtalk
npx vitest run
```

Expected: all DingTalk tests pass, including callback parsing, ACK order,
controller state, direct feedback, projection, images, and existing proactive
delivery.

- [ ] **Step 6: Commit adapter feedback**

```bash
git add \
  packages/channels/dingtalk/src/DingtalkAdapter.ts \
  packages/channels/dingtalk/src/DingtalkAdapter.test.ts
git commit -m "fix(dingtalk): notify rejected card clickers"
```

### Task 6: Prove context and downstream-adapter isolation

**Files:**

- Modify: `packages/channels/base/src/ChannelBase.test.ts`
- Modify: `packages/channels/feishu/src/adapter.test.ts`
- Verify without source changes:
  `packages/channels/qqbot/src/stream.test.ts`
- Local only:
  `.qwen/e2e-tests/2026-07-28-channel-interaction-compatibility-hardening.md`

**Interfaces:**

- Consumes: shared run/request correlation and the new hook split.
- Produces: table-driven proof for four session scopes by three dispatch modes,
  plus Feishu partial-text regression proof.

- [ ] **Step 1: Add the 12-combination correlation matrix**

Use:

```ts
const scopes = ['user', 'thread', 'chat_thread', 'single'] as const;
const modes = ['collect', 'steer', 'followup'] as const;
const cases = scopes.flatMap((sessionScope) =>
  modes.map((dispatchMode) => ({
    sessionScope,
    dispatchMode,
    first: {
      chatId: 'matrix-chat',
      threadId: 'matrix-thread',
      senderId: 'alice',
      isGroup: true,
      isMentioned: true,
    },
    second: {
      chatId: 'matrix-chat',
      threadId: 'matrix-thread',
      senderId: sessionScope === 'user' ? 'alice' : 'bob',
      isGroup: true,
      isMentioned: true,
    },
  })),
);

it.each(cases)(
  'keeps input correlation for $sessionScope + $dispatchMode',
  async ({ sessionScope, dispatchMode, first, second }) => {
    const promptResolvers: Array<(value: string) => void> = [];
    (bridge.prompt as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          promptResolvers.push(resolve);
        }),
    );
    (bridge.cancelSession as ReturnType<typeof vi.fn>).mockImplementation(
      () => {
        promptResolvers[0]?.('');
        return Promise.resolve();
      },
    );
    const ch = createChannel({
      sessionScope,
      dispatchMode,
      groupPolicy: 'open',
    });
    ch.userInputPresentationResult = { kind: 'presented' };

    const firstTurn = ch.handleInbound(
      envelope({ ...first, messageId: 'matrix-1', text: 'first' }),
    );
    await vi.waitFor(() => expect(bridge.prompt).toHaveBeenCalledTimes(1));
    const firstSessionId = (bridge.prompt as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as string;
    emitUserQuestion(firstSessionId, 'matrix-request-1');
    await vi.waitFor(() => expect(ch.userInputPresentations).toHaveLength(1));
    const firstContext = ch.userInputPresentations[0]!;
    const firstSettled = vi.fn();
    firstContext.onSettled(firstSettled);

    const secondTurn = ch.handleInbound(
      envelope({ ...second, messageId: 'matrix-2', text: 'second' }),
    );
    if (dispatchMode !== 'steer') {
      await firstContext.respond({
        outcome: { outcome: 'selected', optionId: 'proceed_once' },
        answers: { '0': 'Beijing' },
      });
      promptResolvers[0]?.('');
    }
    await firstTurn;
    await vi.waitFor(() => expect(bridge.prompt).toHaveBeenCalledTimes(2));
    const secondSessionId = (bridge.prompt as ReturnType<typeof vi.fn>).mock
      .calls[1]![0] as string;
    emitUserQuestion(secondSessionId, 'matrix-request-2');
    await vi.waitFor(() => expect(ch.userInputPresentations).toHaveLength(2));
    const secondContext = ch.userInputPresentations[1]!;

    expect(secondSessionId).toBe(firstSessionId);
    expect(secondContext.runId).not.toBe(firstContext.runId);
    expect(firstContext.owner.id).toBe(first.senderId);
    expect(secondContext.owner.id).toBe(second.senderId);
    expect(firstContext.target).toMatchObject({
      chatId: first.chatId,
      threadId: first.threadId,
      senderId: first.senderId,
      isGroup: first.isGroup,
    });
    expect(secondContext.target).toMatchObject({
      chatId: second.chatId,
      threadId: second.threadId,
      senderId: second.senderId,
      isGroup: second.isGroup,
    });
    if (dispatchMode === 'steer') {
      expect(firstSettled).toHaveBeenCalledWith('run_cancelled');
      await expect(
        firstContext.respond({
          outcome: { outcome: 'selected', optionId: 'proceed_once' },
          answers: { '0': 'late' },
        }),
      ).resolves.toBe(false);
    } else {
      expect(respondToPermissionMock()).toHaveBeenCalledWith(
        'matrix-request-1',
        expect.objectContaining({ answers: { '0': 'Beijing' } }),
      );
    }
    expect(respondToPermissionMock()).not.toHaveBeenCalledWith(
      'matrix-request-2',
      expect.anything(),
    );

    promptResolvers[1]?.('');
    await secondTurn;
  },
);
```

The case data deliberately chooses inputs that share one session under each
scope so every dispatch mode exercises its real same-session scheduling path.
Existing `SessionRouter.test.ts` remains the source of truth for cross-session
isolation.

- [ ] **Step 2: Run the matrix and verify it exposes no correlation failure**

```bash
cd packages/channels/base
npx vitest run src/ChannelBase.test.ts
```

Expected: PASS after using existing routing and dispatch semantics. If a case
fails, fix only a demonstrated correlation defect; do not add a second queue or
card-specific state to `ChannelBase`.

- [ ] **Step 3: Strengthen Feishu terminal-content assertions**

In the existing failed and cancelled card-finalization tests, keep
`accumulatedText: 'partial answer'` and add:

```ts
expect(updateCard.mock.calls[0]![3]).toContain('partial answer');
expect(updateCard.mock.calls[0]![4]).toBe('已失败，请重试');
```

and:

```ts
expect(updateCard.mock.calls[0]![3]).toContain('partial answer');
expect(updateCard.mock.calls[0]![4]).toBe('已取消');
```

These tests combine with Task 2's shared-hook test to prove synthetic segment
ends cannot clear Feishu's partial text.

- [ ] **Step 4: Run downstream adapter regressions**

```bash
cd packages/channels/feishu
npx vitest run src/adapter.test.ts

cd ../qqbot
npx vitest run src/stream.test.ts
```

Expected: Feishu preserves terminal partial text; QQ continues to clear only at
an explicit response boundary and retains its existing completion behavior.

- [ ] **Step 5: Commit isolation tests**

```bash
git add \
  packages/channels/base/src/ChannelBase.test.ts \
  packages/channels/feishu/src/adapter.test.ts
git commit -m "test(channels): cover interaction isolation matrix"
```

Do not stage `.qwen/e2e-tests/` or the Chinese design translation.

### Task 7: Full verification, real DingTalk proof, and Draft handoff

**Files:**

- Update locally:
  `.qwen/e2e-tests/2026-07-28-channel-interaction-compatibility-hardening.md`
- No production changes unless verification finds a demonstrated defect.

**Interfaces:**

- Consumes: all previous tasks.
- Produces: automated, daemon, and real-device evidence for the Draft PR.

- [ ] **Step 1: Run focused and package-level tests**

```bash
cd packages/channels/base
npx vitest run src/SessionRouter.test.ts src/ChannelBase.test.ts

cd ../dingtalk
npx vitest run

cd ../feishu
npx vitest run src/adapter.test.ts

cd ../qqbot
npx vitest run src/stream.test.ts
```

Expected: all tests pass with exact counts recorded in the local E2E report.

- [ ] **Step 2: Run repository verification**

From the repository root:

```bash
npm run build
npm run typecheck
npx eslint \
  packages/channels/base/src/ChannelBase.ts \
  packages/channels/base/src/ChannelBase.test.ts \
  packages/channels/dingtalk/src/interactive-card-types.ts \
  packages/channels/dingtalk/src/interactive-card-types.test.ts \
  packages/channels/dingtalk/src/status-card-controller.ts \
  packages/channels/dingtalk/src/status-card-controller.test.ts \
  packages/channels/dingtalk/src/question-card-controller.ts \
  packages/channels/dingtalk/src/question-card-controller.test.ts \
  packages/channels/dingtalk/src/DingtalkAdapter.ts \
  packages/channels/dingtalk/src/DingtalkAdapter.test.ts \
  packages/channels/feishu/src/adapter.test.ts
git diff --check origin/main...HEAD
```

Expected: build, typecheck, focused lint, and diff check pass.

- [ ] **Step 3: Perform two clean self-audit passes**

Read:

```bash
git diff --stat origin/main...HEAD
git diff origin/main...HEAD -- \
  packages/channels/base/src \
  packages/channels/dingtalk/src \
  packages/channels/feishu/src
```

For each pass, verify every added field has a setter and consumer, every
controller outcome has one adapter path, no group-feedback call exists, and
Feishu/QQ are not passed synthetic response boundaries. A found defect resets
the clean-pass count and reruns affected verification.

- [ ] **Step 4: Run daemon validation**

Build/bundle the current branch and start a local daemon with the approved test
workspace:

```bash
npm run bundle
qwen serve start --foreground
```

Record worker startup, DingTalk Stream connection, one normal Markdown/card
response as configured, and graceful shutdown. Do not record credentials.

- [ ] **Step 5: Run real DingTalk scenarios**

Use only the `Qwen3.8-Max` robot:

1. Owner submits a question card; the same card becomes submitted and the Agent
   continues.
2. A second user clicks Submit; the original card stays pending, no Agent turn
   occurs, and the clicker receives a direct unauthorized notice.
3. The owner submits after the forbidden attempt.
4. A second user clicks Stop; the run continues and the clicker receives a
   direct unauthorized notice.
5. The owner clicks Stop; the exact run stops and the same status card updates.
6. Click a terminal/stale card; the card stays unchanged and the clicker
   receives the generic expired notice.
7. Repeat owner, non-owner, and stale scenarios in a DM where applicable.
8. Remove `interactiveCards`, restart the worker, and verify Markdown/text
   fallback with no card callback listener.
9. Run representative `collect`, `steer`, and `followup` message sequences.

The user supplies second-account clicks only when needed. Separate visible
device evidence from server-side ACK/API evidence.

- [ ] **Step 6: Refresh main and rerun affected verification before push**

```bash
git fetch origin main
git merge-base --is-ancestor origin/main HEAD || git rebase origin/main
```

If rebased, rerun Steps 1 and 2. Restore the local Chinese translation after
the rebase, but never stage it.

- [ ] **Step 7: Push without changing review state**

```bash
git push --force-with-lease fork agent/dingtalk-interactive-cards
gh pr view 6930 --repo QwenLM/qwen-code --json isDraft,headRefOid,statusCheckRollup
```

Expected: push succeeds, the PR head matches the verified commit, and
`isDraft` remains `true`.
