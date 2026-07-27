# DingTalk Status Card Runtime Metadata Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the configured model and elapsed wall-clock seconds in DingTalk status-card state text without adding a process, an independent timer, or estimated token usage.

**Architecture:** `DingtalkAdapter` passes the existing optional Channel model into `StatusCardController`. Each status record owns its creation time and last displayed second. The controller updates `statusLine` only when an existing coalesced model-text flush observes a new second, then writes the exact elapsed second during terminal finalization.

**Tech Stack:** TypeScript, Vitest, DingTalk Card OpenAPI, existing `StatusCardController` write chain.

## Global Constraints

- Render `Running · <model> · <seconds>s` when `channels.<name>.model` is configured.
- Omit the model component when the Channel configuration does not select one.
- Add no process and no independent elapsed-time timer.
- Trigger running metadata updates only from the existing coalesced text flush, at most once per displayed second.
- Silent thinking and tool execution do not advance the visible counter until another model-text flush.
- Always write the current elapsed second with `Completed`, `Stopped`, `Cancelled`, or `Failed`.
- Do not expose or estimate token usage.
- Preserve正文 streaming, copy content, exact-run Stop behavior, and terminal card state.
- A metadata-update failure must not disable正文 streaming.

---

### Task 1: Render and refresh status-card runtime metadata

**Files:**

- Modify: `packages/channels/dingtalk/src/status-card-controller.ts`
- Test: `packages/channels/dingtalk/src/status-card-controller.test.ts`
- Modify: `packages/channels/dingtalk/src/DingtalkAdapter.ts`
- Test: `packages/channels/dingtalk/src/DingtalkAdapter.test.ts`

**Interfaces:**

- Consumes: existing `ChannelConfig.model?: string`, `StatusCardController.append(...)`, `StatusCardController.complete(...)`, `StatusCardController.fail(...)`, and `StatusCardController.cancelRun(...)`.
- Produces: `StatusCardControllerOptions.model?: string`; formatted `statusLine` values containing state, optional configured model, and elapsed whole seconds.

- [ ] **Step 1: Write failing controller tests for creation and stream-driven refresh**

Add focused tests to `status-card-controller.test.ts` that use Vitest fake timers and system time:

```ts
it('shows the configured model and refreshes elapsed time from text flushes', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  const { client, controller } = createHarness({ model: 'qwen3.7-max' });

  controller.append(segment(), target, 'first');
  await vi.advanceTimersByTimeAsync(0);
  expect(client.createAndDeliver).toHaveBeenCalledWith(
    expect.objectContaining({
      cardParamMap: expect.objectContaining({
        statusLine: 'Running · qwen3.7-max · 0s',
      }),
    }),
  );

  vi.mocked(client.updateInstance).mockClear();
  vi.setSystemTime(1_200);
  await vi.advanceTimersByTimeAsync(500);

  expect(client.updateInstance).toHaveBeenCalledWith(
    expect.objectContaining({
      cardParamMap: {
        statusLine: 'Running · qwen3.7-max · 1s',
      },
    }),
  );
});
```

Also add assertions that advancing fake time without another text flush performs no metadata update, and that an omitted model renders `Running · 1s`.

- [ ] **Step 2: Run the controller test and verify RED**

Run:

```bash
cd packages/channels/dingtalk
npx vitest run src/status-card-controller.test.ts
```

Expected: FAIL because creation still sends `statusLine: 'Running'`, no stream flush updates elapsed metadata, and the harness does not yet accept `model`.

- [ ] **Step 3: Write failing terminal and failure-isolation tests**

Add a terminal assertion:

```ts
vi.setSystemTime(12_400);
controller.cancelRun('run-1', 'cancel_command');
await vi.runAllTimersAsync();
expect(client.updateInstance).toHaveBeenLastCalledWith(
  expect.objectContaining({
    cardParamMap: expect.objectContaining({
      statusLine: 'Stopped · qwen3.7-max · 12s',
    }),
  }),
);
```

Add a test where the running `statusLine` update rejects once, `onError` records `status card metadata`, and a later chunk still reaches `openOrUpdateStream`. This pins metadata as best-effort instead of poisoning `record.streamFailed`.

- [ ] **Step 4: Implement the minimum controller behavior**

Extend the options and record:

```ts
export interface StatusCardControllerOptions {
  client: DingtalkInteractiveCardClient;
  cancelRun(sessionId: string, runId: string): Promise<boolean>;
  model?: string;
  onError?(operation: string, error: unknown): void;
}

interface StatusRecord {
  // existing fields
  startedAt: number;
  lastStatusSecond: number;
}
```

Create one formatter that omits blank models:

```ts
private statusLine(
  record: StatusRecord,
  state: 'Running' | 'Completed' | 'Failed' | 'Stopped' | 'Cancelled',
): { text: string; second: number } {
  const second = Math.max(
    0,
    Math.floor((Date.now() - record.startedAt) / 1000),
  );
  const model = this.options.model?.trim();
  return {
    text: [state, model, `${second}s`].filter(Boolean).join(' · '),
    second,
  };
}
```

Initialize `startedAt` and `lastStatusSecond` when creating the record. Use the formatter for initial creation and every terminal state.

After a successful existing正文 `openOrUpdateStream(...)` call, compute the running line. When its second differs from `lastStatusSecond`, call:

```ts
await this.options.client
  .updateInstance({
    outTrackId: record.outTrackId,
    cardParamMap: { statusLine: running.text },
  })
  .then(() => {
    record.lastStatusSecond = running.second;
  })
  .catch((error) => {
    this.options.onError?.('status card metadata', error);
  });
```

Keep this failure handling separate from the outer正文-stream failure handler.

- [ ] **Step 5: Pass the configured model from the adapter**

Construct the controller with the existing Channel configuration:

```ts
this.statusCardController = new StatusCardController({
  client: this.interactiveCardClient,
  cancelRun: (sessionId, runId) =>
    this.requestPromptRunCancellation(sessionId, runId),
  ...(config.model ? { model: config.model } : {}),
  onError: (operation, error) => {
    // existing logger
  },
});
```

Add a focused `DingtalkAdapter.test.ts` assertion that `createChannel({ model: 'qwen3.7-max' })` supplies that exact value to the controller. Do not add a DingTalk-specific model setting.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
cd packages/channels/dingtalk
npx vitest run src/status-card-controller.test.ts src/DingtalkAdapter.test.ts
```

Expected: PASS, including the existing Stop, content-preservation, callback, and adapter tests.

- [ ] **Step 7: Run package validation**

Run from the repository root:

```bash
npx prettier --check packages/channels/dingtalk/src/status-card-controller.ts packages/channels/dingtalk/src/status-card-controller.test.ts packages/channels/dingtalk/src/DingtalkAdapter.ts packages/channels/dingtalk/src/DingtalkAdapter.test.ts
npx eslint packages/channels/dingtalk/src/status-card-controller.ts packages/channels/dingtalk/src/status-card-controller.test.ts packages/channels/dingtalk/src/DingtalkAdapter.ts packages/channels/dingtalk/src/DingtalkAdapter.test.ts
npm run typecheck
git diff --check
```

Expected: all commands exit zero.

- [ ] **Step 8: Commit the implementation**

Stage only the four DingTalk files:

```bash
git add packages/channels/dingtalk/src/status-card-controller.ts packages/channels/dingtalk/src/status-card-controller.test.ts packages/channels/dingtalk/src/DingtalkAdapter.ts packages/channels/dingtalk/src/DingtalkAdapter.test.ts
git commit -m "feat(dingtalk): show model and elapsed card status"
```

### Task 2: Verify the live DingTalk projection

**Files:**

- Modify locally only: `.qwen/settings.json`
- No tracked production files.

**Interfaces:**

- Consumes: `channels.interactive-card-e2e-current.model`, the running DingTalk Stream connection, and the tracked implementation from Task 1.
- Produces: real-device evidence that running and terminal cards update in place with the configured model and elapsed seconds.

- [ ] **Step 1: Pin the test Channel model**

Set the existing local test entry to:

```json
{
  "model": "qwen3.7-max"
}
```

Keep credentials redacted from all command output.

- [ ] **Step 2: Restart the current test Channel**

Stop the foreground development process and restart:

```bash
npm run --silent dev -- channel start interactive-card-e2e-current
```

Filter the DingTalk SDK startup dump so `clientId`, `clientSecret`, and the Stream ticket are not printed.

- [ ] **Step 3: Verify running metadata on a real card**

Send a prompt that produces model text for more than one second. Confirm the same card displays:

```text
Running · qwen3.7-max · 0s
Running · qwen3.7-max · 1s
```

and that正文 continues streaming without replacement or disappearance.

- [ ] **Step 4: Verify exact terminal projection**

Run one completion and one Stop interaction. Confirm the same card ends as:

```text
Completed · qwen3.7-max · <elapsed>s
Stopped · qwen3.7-max · <elapsed>s
```

Confirm the terminal elapsed value is at least the latest running value, the Stop button is disabled, and the final正文 remains copyable.

- [ ] **Step 5: Review the final diff**

Read the complete tracked diff, including the four pre-existing uncommitted lifecycle fixes. Run two consecutive clean self-audit passes; if a pass finds a defect, fix it, rerun validation, and reset the clean-pass count.
