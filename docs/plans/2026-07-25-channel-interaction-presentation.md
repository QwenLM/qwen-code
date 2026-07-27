# Channel Interaction Presentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the run-scoped DingTalk status-card lifecycle with
segment-scoped lazy output cards and request-scoped input cards that update in
place, while exposing a platform-neutral context that future Feishu and other
IM presenters can consume.

**Architecture:** `ChannelBase` remains the owner of session, run, output
segment, input request, target, and owner identity. Existing response and
structured-input hooks receive stronger semantic contexts, while each IM
adapter owns native handles, rendering, callbacks, and projection queues. The
DingTalk adapter composes a run presenter whose output records are keyed by
`segmentId` and whose input records remain keyed by `requestId`.

**Tech Stack:** TypeScript, Vitest, DingTalk Card OpenAPI V2, existing
`@qwen-code/channel-base` adapter hooks.

## Global Constraints

- Do not create a status card from the run-level `started` event.
- Allocate an output segment only for the first visible chunk or a non-empty
  final response.
- A direct `ask_user_question` must display one input card and no status card.
- Input cards update in place through submitted, cancelled, expired, and
  externally resolved states.
- Do not parse ordinary IM text as structured answers.
- Keep platform handles and template fields out of shared Channel types.
- Existing adapters that do not consume the new context must retain their
  behavior.
- Keep the correction minimal; do not refactor Feishu production code.
- Do not add another local commit until real DingTalk acceptance passes. Do
  not push.

---

## File map

- `packages/channels/base/src/types.ts`
  - Defines platform-neutral output-segment context and end reasons.
- `packages/channels/base/src/ChannelBase.ts`
  - Allocates and closes output segments and passes context to existing hooks.
- `packages/channels/base/src/ChannelBase.test.ts`
  - Proves lazy allocation, boundaries, continuation, and context isolation.
- `packages/channels/dingtalk/src/interaction-presenter.ts`
  - Owns per-run projection ordering, segment output records, and question
    presentation coordination.
- `packages/channels/dingtalk/src/interaction-presenter.test.ts`
  - Proves direct-question, text-question, continuation, and failure behavior.
- `packages/channels/dingtalk/src/status-card-controller.ts`
  - Becomes a single-segment native output controller; it no longer owns a
    whole run.
- `packages/channels/dingtalk/src/status-card-controller.test.ts`
  - Proves lazy segment creation, terminal updates, Stop, and bounded writes.
- `packages/channels/dingtalk/src/question-card-controller.ts`
  - Keeps request-scoped form state and delegates run ordering to the
    presenter.
- `packages/channels/dingtalk/src/question-card-controller.test.ts`
  - Proves input cards update in place and never trigger output-card creation.
- `packages/channels/dingtalk/src/DingtalkAdapter.ts`
  - Correlates inbound owners/runs and delegates output/input hooks.
- `packages/channels/dingtalk/src/DingtalkAdapter.test.ts`
  - Proves eligibility, exact-run Stop, and adapter-level routing.
- `docs/design/2026-07-25-channel-interaction-presentation-contract.md`
  - Records the approved contract.
- `.qwen/e2e-tests/dingtalk-interaction-presentation.md`
  - Records real-device steps and results; remains ignored.

---

### Task 1: Add shared output-segment identity

**Files:**

- Modify: `packages/channels/base/src/types.ts`
- Modify: `packages/channels/base/src/ChannelBase.ts`
- Modify: `packages/channels/base/src/ChannelBase.test.ts`
- Modify: `packages/channels/base/src/index.ts`

**Interfaces:**

- Consumes: existing `runId`, `ChannelPromptOwner`, `SessionTarget`, response
  hooks, and `ChannelUserInputRequestContext`.
- Produces:

```ts
export interface ChannelOutputSegmentContext {
  channelName: string;
  sessionId: string;
  runId: string;
  segmentId: string;
  owner: ChannelPromptOwner;
  target: SessionTarget;
  messageId?: string;
}

export type ChannelOutputSegmentEndReason =
  | 'response_boundary'
  | 'input_requested'
  | 'completed'
  | 'failed'
  | 'cancelled';
```

- Renames the branch-local settlement value
  `resolved_outside_card` to `resolved_outside_presenter`.

- [x] **Step 1: Write failing segment tests**

Add a test adapter to `ChannelBase.test.ts` that records the optional segment
argument received by `onResponseChunk`, `onResponseBoundary`, and
`onResponseComplete`. Add literal assertions for:

```ts
expect(eventsBeforeFirstChunk).toEqual([]);
expect(firstChunk.segment?.runId).toBe(started.runId);
expect(firstChunk.segment?.segmentId).toMatch(
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-/,
);
expect(secondChunk.segment?.segmentId).toBe(firstChunk.segment?.segmentId);
expect(afterBoundary.segment?.segmentId).not.toBe(
  firstChunk.segment?.segmentId,
);
```

Add a direct-question test that emits a user-input permission before any
chunk and asserts that `precedingSegmentId` is `undefined`. Add a
text-then-question test that asserts the shared segment identity is closed,
the question context receives its ID, and no platform response boundary is
projected before adapter support is known.

- [x] **Step 2: Run RED**

Run:

```bash
cd packages/channels/base
npx vitest run src/ChannelBase.test.ts -t "output segment|preceding segment"
```

Expected: FAIL because response hooks receive no segment context and
`ChannelUserInputRequestContext` has no `precedingSegmentId`.

- [x] **Step 3: Implement minimal shared state**

Add `activeSegmentId?: string` to `ActivePrompt`. Implement helpers that:

```ts
private ensureOutputSegment(
  sessionId: string,
  prompt: ActivePrompt,
): ChannelOutputSegmentContext;

private closeOutputSegment(
  sessionId: string,
  prompt: ActivePrompt,
  target?: SessionTarget,
): ChannelOutputSegmentContext | undefined;
```

`ensureOutputSegment` creates `randomUUID()` only when called for visible
output. `closeOutputSegment` clears the stored ID before invoking an adapter
hook so duplicate boundary paths are idempotent.

Pass the same context to all chunks in one segment. Close before
`presentUserInputRequest`, on bridge response boundaries, and on terminal
paths. If `onResponseComplete` receives a non-empty response without a prior
chunk, allocate one segment before calling it.

Existing hook overrides remain source-compatible through optional trailing
parameters.

- [x] **Step 4: Run GREEN**

Run:

```bash
cd packages/channels/base
npx vitest run src/ChannelBase.test.ts -t "output segment|preceding segment"
```

Expected: PASS.

- [x] **Step 5: Run the complete base package test**

Run:

```bash
cd packages/channels/base
npx vitest run src/ChannelBase.test.ts
```

Expected: all tests pass with no unhandled rejection or lifecycle warning.

---

### Task 2: Make native status cards segment-scoped and lazy

**Files:**

- Modify: `packages/channels/dingtalk/src/status-card-controller.ts`
- Modify: `packages/channels/dingtalk/src/status-card-controller.test.ts`

**Interfaces:**

- Consumes: `ChannelOutputSegmentContext` and exact-run cancellation.
- Produces:

```ts
interface StatusCardController {
  append(
    segment: ChannelOutputSegmentContext,
    target: { chatId: string; isGroup: boolean },
    chunk: string,
  ): void;
  complete(segmentId: string, text: string): Promise<boolean>;
  fail(segmentId: string, error: string): void;
  cancelRun(runId: string, reason: ChannelTaskCancellationReason): void;
  claimStop(
    outTrackId: string,
    ownerId: string,
  ): (() => Promise<void>) | undefined;
}
```

- [x] **Step 1: Write failing lazy-creation tests**

Replace the eager `start()` expectation with:

```ts
expect(client.createAndDeliver).not.toHaveBeenCalled();
controller.append(segment('segment-1'), target, 'first');
await vi.waitFor(() => expect(client.createAndDeliver).toHaveBeenCalledOnce());
```

Add two segments with the same `runId` and assert that they receive different
`outTrackId` values and independent final content. Add a test that
`cancelRun(runId, reason)` terminalizes every live segment from that run but
does not touch another run.

- [x] **Step 2: Run RED**

Run:

```bash
cd packages/channels/dingtalk
npx vitest run src/status-card-controller.test.ts
```

Expected: FAIL because the controller requires eager `start(run)` and stores
one record per run.

- [x] **Step 3: Implement the minimal segment registry**

Change the primary live registry to `recordsBySegment`. Retain
`recordsByOutTrack` for callbacks and a bounded `segmentIdsByRun` index for
run cancellation.

The first non-empty `append` creates the record, starts `createAndDeliver`,
and queues the initial full snapshot. Later appends reuse that record.

Keep the verified V2 terminal update:

```ts
{
  blockList: JSON.stringify([{ type: 0, markdown: finalContent }]),
  content: finalContent,
  copy_content: finalContent,
  flowStatus: 3,
  statusLine,
  hasAction: 'false',
  stop_action: 'false',
}
```

Remove `waiting` and `setWaitingInput`. Stop remains bound to the record's
captured `sessionId`, `runId`, and owner.

- [x] **Step 4: Run GREEN**

Run:

```bash
cd packages/channels/dingtalk
npx vitest run src/status-card-controller.test.ts
```

Expected: all tests pass.

---

### Task 3: Add the DingTalk per-run interaction presenter

**Files:**

- Create: `packages/channels/dingtalk/src/interaction-presenter.ts`
- Create: `packages/channels/dingtalk/src/interaction-presenter.test.ts`
- Modify: `packages/channels/dingtalk/src/question-card-controller.ts`
- Modify: `packages/channels/dingtalk/src/question-card-controller.test.ts`

**Interfaces:**

- Consumes: segment-scoped `StatusCardController`,
  request-scoped `QuestionCardController`, attended run target, and shared
  contexts.
- Produces:

```ts
interface DingtalkInteractionPresenter {
  registerRun(
    runId: string,
    ownerId: string,
    target: { chatId: string; isGroup: boolean },
  ): void;
  appendOutput(segment: ChannelOutputSegmentContext, chunk: string): void;
  closeOutput(
    segmentId: string,
    text: string,
    reason: ChannelOutputSegmentEndReason,
    segment?: ChannelOutputSegmentContext,
  ): Promise<boolean>;
  presentInput(
    context: ChannelUserInputRequestContext,
  ): Promise<UserInputPresentationResult>;
  terminalizeRun(
    runId: string,
    terminal: 'completed' | 'failed' | 'cancelled',
    detail?: string,
  ): void;
}
```

- [x] **Step 1: Write failing presenter sequence tests**

Use real controllers with only the Card OpenAPI client mocked. Cover:

```ts
presenter.registerRun('run-1', 'owner-1', target);
await presenter.presentInput(questionContext({ runId: 'run-1' }));
expect(createdTemplateIds).toEqual([QUESTION_CARD_TEMPLATE_ID]);
```

Then cover text followed by a question:

```ts
presenter.appendOutput(segment('segment-1'), 'Explanation');
await presenter.closeOutput('segment-1', '', 'input_requested');
await presenter.presentInput(
  questionContext({ runId: 'run-1', precedingSegmentId: 'segment-1' }),
);
expect(projectionOrder).toEqual([
  'create:status',
  'finalize:segment-1',
  'create:question',
]);
```

Finally submit the question, append `segment-2`, and assert:

```ts
expect(projectionOrder).toContain('update:question:submitted');
expect(statusOutTrackIds).toHaveLength(2);
```

- [x] **Step 2: Run RED**

Run:

```bash
cd packages/channels/dingtalk
npx vitest run src/interaction-presenter.test.ts
```

Expected: FAIL because `interaction-presenter.ts` does not exist.

- [x] **Step 3: Implement the minimal presenter**

Store one run record:

```ts
interface RunPresentation {
  ownerId: string;
  target: { chatId: string; isGroup: boolean };
  projectionChain: Promise<void>;
  activeSegmentId?: string;
}
```

`appendOutput` captures a bounded snapshot and queues the native update without
blocking model generation. `closeOutput` appends terminalization to
`projectionChain`. `presentInput` awaits question delivery without joining that
run-wide chain, so a slow terminal update for the previous question cannot
block the next question. The DingTalk adapter closes a
`precedingSegmentId` with `input_requested` before invoking `presentInput`; it
does not create or update an output card when no `precedingSegmentId` exists.

The optional segment context lets a non-empty final response create and
complete a card even when the provider emitted no chunks. Terminal question
updates reserve their position in the run queue before the original
permission response resumes the model. If output-card creation or
finalization fails, buffered visible text is sent through the existing
Markdown path before the question is presented. Terminal segment IDs remain
as compact bounded tombstones so late chunks cannot reopen them.

Question-card settlement remains request-scoped. Remove the
`setWaitingInput` callback from `QuestionCardControllerOptions`; terminal
question updates continue to use `/card/instances`.

- [x] **Step 4: Run GREEN**

Run:

```bash
cd packages/channels/dingtalk
npx vitest run src/interaction-presenter.test.ts src/question-card-controller.test.ts
```

Expected: all tests pass.

---

### Task 4: Wire the presenter into the DingTalk adapter

**Files:**

- Modify: `packages/channels/dingtalk/src/DingtalkAdapter.ts`
- Modify: `packages/channels/dingtalk/src/DingtalkAdapter.test.ts`

**Interfaces:**

- Consumes: shared output contexts and `DingtalkInteractionPresenter`.
- Produces: adapter hooks that no longer create a status card on `started`.

- [x] **Step 1: Write failing adapter behavior tests**

Add an attended `started` event and assert:

```ts
expect(statusCardController.append).not.toHaveBeenCalled();
```

Emit the first chunk with `segmentId: 'segment-1'` and assert one append.
Present a direct question before any chunk and assert only
`presenter.presentInput` is called.

Add text-question-continuation coverage asserting segment IDs `segment-1` and
`segment-2` route to two output records in the same run.

- [x] **Step 2: Run RED**

Run:

```bash
cd packages/channels/dingtalk
npx vitest run src/DingtalkAdapter.test.ts -t "interaction presenter|direct question|continuation segment"
```

Expected: FAIL because `started` still calls
`statusCardController.start(event, target)`.

- [x] **Step 3: Implement adapter delegation**

On attended `started`, register only the run/owner/target. On `text_chunk`,
delegate the shared segment and chunk. On terminal lifecycle events,
terminalize the run and clean exact identity maps.

Update `onResponseBoundary` and `onResponseComplete` to accept the optional
segment context and delegate finalization through the presenter. Preserve the
existing Markdown fallback when native output finalization returns `false`.

`presentUserInputRequest` delegates to the same presenter so segment closure
and question creation share the per-run projection queue.

- [x] **Step 4: Run GREEN**

Run:

```bash
cd packages/channels/dingtalk
npx vitest run src/DingtalkAdapter.test.ts
```

Expected: all adapter tests pass.

---

### Task 5: Verify callback, failure, and concurrency invariants

**Files:**

- Modify: `packages/channels/dingtalk/src/interaction-presenter.test.ts`
- Modify: `packages/channels/dingtalk/src/status-card-controller.test.ts`
- Modify: `packages/channels/dingtalk/src/question-card-controller.test.ts`
- Modify: `packages/channels/dingtalk/src/DingtalkAdapter.test.ts`

**Interfaces:**

- Consumes: completed Tasks 1-4.
- Produces: regression coverage for the approved design.

- [x] **Step 1: Add failing edge tests**

Add literal tests for:

- direct question creates zero status cards;
- question creation failure creates no status card and cancels the original
  request once;
- submitted/cancelled/expired/resolved-outside-presenter each update the same
  question `outTrackId`;
- duplicate callbacks cannot create a new segment or respond twice;
- a newer question in the same session-and-owner scope expires the older card
  without responding to the agent;
- different users and sessions keep independent pending cards;
- a slow previous terminal update does not block the next question card;
- two runs in the same session cannot share segment or request state;
- late output writes after segment terminalization are ignored;
- exact-run Stop from an old output card cannot cancel a later run.

- [x] **Step 2: Run RED**

Run:

```bash
cd packages/channels/dingtalk
npx vitest run src/interaction-presenter.test.ts src/status-card-controller.test.ts src/question-card-controller.test.ts src/DingtalkAdapter.test.ts
```

Expected: only newly added uncovered invariants fail.

- [x] **Step 3: Add the smallest corrections**

Change only the state checks or cleanup required by the failing cases. Do not
add retry queues, persistence, generic capability registries, or Feishu
changes.

- [x] **Step 4: Run GREEN**

Run the same four-file command. Expected: all tests pass with no timer or
unhandled-promise leaks.

---

### Task 6: Cross-IM and repository verification

**Files:**

- No Feishu production changes expected.
- Modify only tests required by source-compatible type imports.

**Interfaces:**

- Consumes: final shared and DingTalk implementation.
- Produces: evidence that opt-out adapters remain unchanged.

- [x] **Step 1: Run focused package tests**

```bash
cd packages/channels/base
npx vitest run src/ChannelBase.test.ts

cd packages/channels/dingtalk
npx vitest run

cd packages/channels/feishu
npx vitest run src/adapter.test.ts
```

Expected: all pass.

- [x] **Step 2: Run static validation**

From the repository root:

```bash
npx prettier --check \
  packages/channels/base/src/types.ts \
  packages/channels/base/src/ChannelBase.ts \
  packages/channels/base/src/ChannelBase.test.ts \
  packages/channels/dingtalk/src/interaction-presenter.ts \
  packages/channels/dingtalk/src/interaction-presenter.test.ts \
  packages/channels/dingtalk/src/status-card-controller.ts \
  packages/channels/dingtalk/src/status-card-controller.test.ts \
  packages/channels/dingtalk/src/question-card-controller.ts \
  packages/channels/dingtalk/src/question-card-controller.test.ts \
  packages/channels/dingtalk/src/DingtalkAdapter.ts \
  packages/channels/dingtalk/src/DingtalkAdapter.test.ts

npm run build
npm run typecheck
```

Expected: all commands exit 0. Run build and typecheck serially because the
build cleans package `dist` directories.

- [x] **Step 3: Review the full diff twice**

Read all tracked and untracked files in the implementation diff. Check:

- no eager status-card creation;
- no `Waiting for input` output projection;
- no normal-path question-card deletion;
- exact context fields at every callback and cleanup boundary;
- no platform fields in shared types;
- no unrelated Feishu change;
- no credentials or local configuration.

Any correction resets the clean-pass count and re-runs focused validation.

---

### Task 7: Real DingTalk acceptance and final local commit

**Files:**

- Create ignored result:
  `.qwen/e2e-tests/dingtalk-interaction-presentation.md`
- Commit only after acceptance:
  all approved design, plan, source, and tracked tests.

**Interfaces:**

- Consumes: locally built implementation and configured DingTalk test channel.
- Produces: real-client acceptance evidence and one reviewable local commit.

- [ ] **Step 1: Record and execute real-client scenarios**

Verify:

1. A direct `ask_user_question` shows one pending question card and no status
   card.
2. Submit updates that same card to Submitted.
3. The resumed answer opens a new status card and retains its completed text.
4. Text followed by a question leaves the text card completed and makes only
   the question card active.
5. Cancel and timeout update the same question card in place.
6. Stop cancels only the run captured by the active output card.

Record card IDs, visible outcomes, timestamps, and sanitized logs. Never record
credentials.

- [ ] **Step 2: Run final verification**

Re-run the focused base, DingTalk, and Feishu tests, followed serially by:

```bash
npm run build
npm run typecheck
git diff --check
```

Expected: all pass after the exact source state used in the real-client test.

- [ ] **Step 3: Commit only the accepted result**

Confirm `.qwen/settings.json`, credentials, logs, screenshots, and ignored E2E
artifacts are not staged. Then create one local commit:

```bash
git add \
  docs/design/2026-07-25-channel-interaction-presentation-contract.md \
  docs/plans/2026-07-25-channel-interaction-presentation.md \
  packages/channels/base/src \
  packages/channels/dingtalk/src
git commit -m "fix(channels): align native interaction presentation"
```

Do not push.
