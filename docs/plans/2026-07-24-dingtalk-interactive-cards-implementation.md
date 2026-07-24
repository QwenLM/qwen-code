# DingTalk Interactive Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the design in PR #6930 on the existing
`agent/dingtalk-interactive-cards` branch, including exact-run status cards and
structured `ask_user_question` cards for attended DingTalk turns.

**Architecture:** `ChannelBase` owns prompt identity, semantic user-input
normalization, exact-run cancellation, and one-shot settlement. The DingTalk
adapter consumes that transport-neutral contract and owns Card OpenAPI calls,
owner validation, callback routing, bounded registries, and UI degradation.
Other adapters inherit an `unsupported` default and preserve their existing
behavior.

**Tech Stack:** TypeScript, ESM, Node.js 22+, Vitest, DingTalk Stream SDK,
DingTalk Card OpenAPI, native `fetch`.

## Global Constraints

- Continue in PR #6930; do not open a separate implementation PR.
- Preserve the existing design commits and work only in the isolated
  `/Users/ben/workspace/qwen-code-worktrees/agent-dingtalk-interactive-cards`
  worktree.
- Reconcile the branch with current `origin/main` before production edits.
- Follow TDD for every behavior change: failing focused test, observed failure,
  minimal implementation, observed pass.
- Keep Core, ACP, daemon protocol, SDK clients, Web, IDE, and non-DingTalk
  adapters unchanged.
- Keep DingTalk template IDs built in; do not add user-supplied template IDs or
  a startup health probe.
- Card OpenAPI calls time out after 10 seconds.
- Status content is capped at 20,000 characters and flushed no more often than
  every 500 ms.
- Terminal tombstones live for 10 minutes and are capped at 1,000 entries per
  card type.
- Loop and webhook runs remain executable but are ineligible for interactive
  cards.
- Do not add persistent card recovery, callback retries, synthetic prompts, or
  a general cross-channel card framework.
- Use the `soimy/openclaw-channel-dingtalk` main implementation at
  `a8fb6f80e7360ce0ffee2d4a8007951bd85b23a4` as the DingTalk behavior
  reference. Reuse its reserve/activate/claim/terminal race discipline and
  Card OpenAPI payload conventions, but not its separate tool,
  `AsyncLocalStorage`, synthetic inbound-message continuation, persistence,
  supersession, or fail-open owner policy.

---

### Task 1: Reconcile the branch and close the design contract gaps

**Files:**

- Modify:
  `docs/design/2026-07-15-dingtalk-interactive-cards.md`
- Create:
  `.qwen/e2e-tests/2026-07-24-dingtalk-interactive-cards.md`

**Interfaces:**

- Consumes: PR #6930 design at `dd04ae492` and current `origin/main`.
- Produces: an implementation-ready contract that explicitly addresses all
  non-outdated review threads.

- [ ] **Step 1: Merge current `origin/main` into the PR branch**

Run:

```bash
git fetch origin main
git merge --no-edit origin/main
```

Expected: the design commits remain in history without force-pushing, and the
worktree has no unresolved conflicts.

- [ ] **Step 2: Update the shared context contract**

Replace the bare `settlementSignal` design with a typed subscription and add an
adapter-neutral owner:

```ts
interface ChannelPromptOwner {
  kind: 'channel_user';
  id: string;
}

interface ChannelUserInputRequestContext {
  requestId: string;
  sessionId: string;
  runId: string;
  owner: ChannelPromptOwner;
  target: SessionTarget;
  questions: ChannelUserQuestion[];
  submitOptionId: string;
  onSettled(listener: (reason: UserInputSettlementReason) => void): () => void;
  respond(response: ChannelUserInputResponse): Promise<boolean>;
}
```

State explicitly that `handled` without a prior synchronous invocation of
`respond()` is a contract violation that falls through to the existing
permission message.

- [ ] **Step 3: Add the remaining degradation and callback invariants**

Document these exact requirements:

```text
createAndDeliver succeeds + streaming-open fails
  -> disable the blank card best-effort and use Markdown delivery

question callback
  -> reject any answer key not present in the stored normalized question set

blockStreaming=on
  -> status card remains disabled, question cards remain independently eligible

question lifecycle
  -> reserve before createAndDeliver, activate only after successful delivery,
     claim before callback ACK, and never revive a request settled in flight
```

- [ ] **Step 4: Write the E2E plan**

Record real-client scenarios for status creation, ordered streaming, completion,
failure, cancellation, exact-run Stop, structured answer submission, timeout,
duplicate callback, external resolution, independent feature disabling, and
block-streaming question-card eligibility. Mark credentials/device execution as
required release evidence rather than unit-test evidence.

- [ ] **Step 5: Verify documentation**

Run:

```bash
npx prettier --check docs/design/2026-07-15-dingtalk-interactive-cards.md docs/plans/2026-07-24-dingtalk-interactive-cards-implementation.md
git diff --check
```

Expected: both commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add docs/design/2026-07-15-dingtalk-interactive-cards.md docs/plans/2026-07-24-dingtalk-interactive-cards-implementation.md
git commit -m "docs(channels): finalize DingTalk card implementation contract"
```

The `.qwen/e2e-tests` file is intentionally git-ignored and is not committed.

---

### Task 2: Add prompt identity and exact-run cancellation to ChannelBase

**Files:**

- Modify: `packages/channels/base/src/types.ts`
- Modify: `packages/channels/base/src/index.ts`
- Modify: `packages/channels/base/src/ChannelBase.ts`
- Test: `packages/channels/base/src/ChannelBase.test.ts`

**Interfaces:**

- Produces:

```ts
interface ChannelPromptOwner {
  kind: 'channel_user';
  id: string;
}

interface ChannelTaskLifecycleBase {
  runId?: string;
  owner?: ChannelPromptOwner;
}

protected requestPromptRunCancellation(
  sessionId: string,
  runId: string,
  reason?: 'cancel_command' | 'clear' | 'steer',
): Promise<boolean>;
```

- [ ] **Step 1: Write failing lifecycle identity tests**

Add focused tests proving:

```ts
expect(new Set(firstRunEvents.map((event) => event.runId))).toEqual(
  new Set([firstRunEvents[0]!.runId]),
);
expect(secondRunStarted.runId).not.toBe(firstRunStarted.runId);
expect(firstRunStarted.owner).toEqual({
  kind: 'channel_user',
  id: 'user-1',
});
```

Also assert loop and webhook lifecycle events have a `runId` but no human
`owner`.

- [ ] **Step 2: Run the tests and observe the expected failure**

Run:

```bash
cd packages/channels/base
npx vitest run src/ChannelBase.test.ts -t "run identity"
```

Expected: FAIL because lifecycle events do not expose `runId` or `owner`.

- [ ] **Step 3: Implement minimal prompt context propagation**

Generate `runId` with `randomUUID()` when each `ActivePrompt` is created. Store
the optional attended owner on the same record and build every lifecycle event
from that record:

```ts
type ActivePrompt = {
  runId: string;
  owner?: ChannelPromptOwner;
  // existing fields remain unchanged
};
```

Make `lifecycleBase` consume the active prompt so start, chunks, tool calls,
completion, failure, and cancellation cannot drift.

- [ ] **Step 4: Verify lifecycle tests pass**

Run the same focused command. Expected: PASS.

- [ ] **Step 5: Write failing exact-run cancellation tests**

Expose a test-only wrapper and assert:

```ts
await expect(channel.cancelRunForTest(sessionId, staleRunId)).resolves.toBe(
  false,
);
expect(bridge.cancelSession).not.toHaveBeenCalled();

await expect(channel.cancelRunForTest(sessionId, currentRunId)).resolves.toBe(
  true,
);
expect(bridge.cancelSession).toHaveBeenCalledWith(sessionId);
```

Cover missing, stale, current, delivery-started, and a new run replacing the
same session.

- [ ] **Step 6: Run the exact-run tests and observe failure**

```bash
cd packages/channels/base
npx vitest run src/ChannelBase.test.ts -t "exact run"
```

Expected: FAIL because the protected exact-run entry point is missing.

- [ ] **Step 7: Implement exact-run cancellation**

Read the active prompt once, reject a missing or mismatched run ID before
calling the bridge, then delegate to the existing cancellation state machine:

```ts
protected requestPromptRunCancellation(
  sessionId: string,
  runId: string,
  reason: 'cancel_command' | 'clear' | 'steer' = 'cancel_command',
): Promise<boolean> {
  const active = this.activePrompts.get(sessionId);
  if (!active || active.runId !== runId) return Promise.resolve(false);
  return this.requestActivePromptCancellation(sessionId, reason);
}
```

- [ ] **Step 8: Run focused tests and commit**

```bash
cd packages/channels/base
npx vitest run src/ChannelBase.test.ts -t "run identity|exact run"
git add src/types.ts src/index.ts src/ChannelBase.ts src/ChannelBase.test.ts
git commit -m "feat(channels): add exact prompt run identity"
```

---

### Task 3: Add the semantic user-input presentation and settlement contract

**Files:**

- Modify: `packages/channels/base/src/types.ts`
- Modify: `packages/channels/base/src/index.ts`
- Modify: `packages/channels/base/src/ChannelBase.ts`
- Test: `packages/channels/base/src/ChannelBase.test.ts`

**Interfaces:**

- Produces:

```ts
type UserInputPresentationResult =
  | { kind: 'presented' }
  | { kind: 'handled' }
  | { kind: 'unsupported' };

type UserInputSettlementReason =
  | 'resolved_outside_card'
  | 'cancelled'
  | 'run_cancelled';

interface ChannelUserQuestion {
  answerKey: string;
  header: string;
  question: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
}

type ChannelUserInputResponse = RequestPermissionResponse & {
  answers?: Record<string, string>;
};
```

- [ ] **Step 1: Write failing semantic normalization tests**

Cover canonical `_meta.qwenInteractionKind/qwenQuestions`, identified legacy
`rawInput.questions`, one-to-four bounds, ordered string answer keys, omitted
`multiSelect`, malformed canonical data, unrelated tools with `questions`, and
both valid submit-option forms.

- [ ] **Step 2: Run the normalization tests and observe failure**

```bash
cd packages/channels/base
npx vitest run src/ChannelBase.test.ts -t "semantic user input"
```

Expected: FAIL because the hook and normalized context are absent.

- [ ] **Step 3: Implement the default hook and normalizer**

The default must preserve all existing adapters:

```ts
protected async presentUserInputRequest(
  _context: ChannelUserInputRequestContext,
): Promise<UserInputPresentationResult> {
  return { kind: 'unsupported' };
}
```

Invoke it only after pending registration and only for a current attended
prompt with `runId`, owner, valid questions, and a real submit option.

- [ ] **Step 4: Write failing ownership and settlement tests**

Cover `presented`, `handled`, `handled` without `respond()`, `unsupported`,
responder `true`, `false`, throw, synchronous ACP settlement, later daemon
settlement, session cleanup, run cancellation, and exactly-once typed
subscription delivery.

- [ ] **Step 5: Run settlement tests and observe failure**

```bash
cd packages/channels/base
npx vitest run src/ChannelBase.test.ts -t "user input settlement"
```

Expected: FAIL because pending permissions do not expose typed settlement or a
one-shot responder.

- [ ] **Step 6: Implement one-shot response and typed settlement**

Store settlement listeners and a response promise with the pending request.
Only `ChannelBase` calls:

```ts
private settleUserInput(
  pending: PendingPermission,
  reason: UserInputSettlementReason,
): void;
```

`context.respond()` must bind the request ID, call the existing bridge, and
remove/settle the pending request on `true`, `false`, and throw. The returned
unsubscribe function must remove only its own listener.

- [ ] **Step 7: Write failing command tests**

Assert that a card-presented user question:

```text
/approve and /approve-always -> explanatory message, no bridge response
/deny by owner              -> same one-shot context responder
/deny by another user       -> rejected
ordinary permissions        -> existing behavior unchanged
```

- [ ] **Step 8: Implement command behavior and run focused tests**

```bash
cd packages/channels/base
npx vitest run src/ChannelBase.test.ts -t "semantic user input|user input settlement|card-presented"
```

Expected: PASS.

- [ ] **Step 9: Run the full base-package test and commit**

```bash
cd packages/channels/base
npx vitest run src/ChannelBase.test.ts
git add src/types.ts src/index.ts src/ChannelBase.ts src/ChannelBase.test.ts
git commit -m "feat(channels): add structured user input presentation"
```

---

### Task 4: Add the DingTalk Card OpenAPI and callback foundation

**Files:**

- Create: `packages/channels/dingtalk/src/interactive-card-client.ts`
- Create: `packages/channels/dingtalk/src/interactive-card-client.test.ts`
- Create: `packages/channels/dingtalk/src/interactive-card-types.ts`
- Modify: `packages/channels/dingtalk/src/DingtalkAdapter.ts`
- Test: `packages/channels/dingtalk/src/DingtalkAdapter.test.ts`

**Interfaces:**

- Produces:

```ts
interface DingtalkInteractiveCardConfig {
  enabled: boolean;
  statusCard: { enabled: boolean };
  questionCard: { enabled: boolean; timeoutMs: number };
}

class DingtalkInteractiveCardClient {
  createAndDeliver(input: CreateCardInput): Promise<void>;
  openOrUpdateStream(input: StreamCardInput): Promise<void>;
  updateInstance(input: UpdateCardInput): Promise<void>;
}
```

- [ ] **Step 1: Write failing configuration tests**

Cover defaults, independent disabling, finite positive timeout validation, and
invalid nested values. No shared `ChannelConfig` field is added.

- [ ] **Step 2: Write failing Card OpenAPI request tests**

Use mocked `fetch` and assert exact methods, endpoints, access-token header,
group/DM `openSpaceId`, stringified `cardParamMap`, 10-second timeout, non-2xx
errors, and failed `deliverResults`.

- [ ] **Step 3: Run tests and observe failure**

```bash
cd packages/channels/dingtalk
npx vitest run src/interactive-card-client.test.ts src/DingtalkAdapter.test.ts -t "interactive card config|Card OpenAPI"
```

Expected: FAIL because the client and parser do not exist.

- [ ] **Step 4: Implement the minimal client and config parser**

Use the adapter's existing access-token cache and native `fetch`. Keep template
IDs constants in the DingTalk package:

```ts
export const STATUS_CARD_TEMPLATE_ID =
  '675cde2f-f526-40cb-b828-f5b2b57b8b77.schema';
export const QUESTION_CARD_TEMPLATE_ID =
  'c2a6355b-9724-4f7e-9653-d33fcb3311bb.schema';
```

- [ ] **Step 5: Write failing callback parsing and ACK-order tests**

Cover embedded JSON payloads, `outTrackId`, action IDs, form data, normalized
callback owner, malformed frames, and an assertion that Stream ACK occurs
before the first Card OpenAPI or permission await.

- [ ] **Step 6: Implement a card callback router**

Register the card callback topic in addition to `TOPIC_ROBOT`. Synchronously
parse, correlate, authorize, and claim; send exactly one ACK; then launch the
async action. Unknown, stale, duplicate, malformed, and foreign-owner callbacks
are also ACKed and cannot mutate state.

- [ ] **Step 7: Run tests and commit**

```bash
cd packages/channels/dingtalk
npx vitest run src/interactive-card-client.test.ts src/DingtalkAdapter.test.ts -t "interactive card|callback"
git add src/interactive-card-client.ts src/interactive-card-client.test.ts src/interactive-card-types.ts src/DingtalkAdapter.ts src/DingtalkAdapter.test.ts
git commit -m "feat(dingtalk): add interactive card transport"
```

---

### Task 5: Implement the exact-run streaming status card

**Files:**

- Create: `packages/channels/dingtalk/src/status-card-controller.ts`
- Create: `packages/channels/dingtalk/src/status-card-controller.test.ts`
- Modify: `packages/channels/dingtalk/src/DingtalkAdapter.ts`
- Test: `packages/channels/dingtalk/src/DingtalkAdapter.test.ts`

**Interfaces:**

- Consumes: lifecycle `runId/owner`, exact-run cancellation, and
  `DingtalkInteractiveCardClient`.
- Produces:

```ts
interface StatusCardController {
  start(event: ChannelTaskLifecycleEvent): void;
  append(runId: string, chunk: string): void;
  setWaitingInput(runId: string, waiting: boolean): void;
  complete(runId: string, text: string): Promise<boolean>;
  fail(runId: string, error: string): void;
  cancel(runId: string, reason: ChannelTaskCancellationReason): void;
  stop(outTrackId: string, ownerId: string): Promise<boolean>;
}
```

- [ ] **Step 1: Write failing attended-owner correlation tests**

Prove only a real inbound `messageId -> owner` record can bind the matching
`started` event. Unknown, missing-owner, loop, and webhook lifecycle events must
not create a status card.

- [ ] **Step 2: Run and observe failure**

```bash
cd packages/channels/dingtalk
npx vitest run src/status-card-controller.test.ts src/DingtalkAdapter.test.ts -t "status card eligibility"
```

- [ ] **Step 3: Implement bounded owner and run registries**

Use insertion-ordered maps capped at 1,000. Consume the message owner when
`started` binds it to the shared `runId`.

- [ ] **Step 4: Write failing coalescing tests**

With fake timers and a deferred fetch, prove:

```text
one Card OpenAPI write in flight
one replaceable pending full snapshot
500 ms minimum flush interval
20,000-character visible bound with truncation marker
late writes rejected after terminalization
```

- [ ] **Step 5: Implement create/open/coalesced streaming**

If `createAndDeliver` or streaming-open fails, disable the blank card
best-effort and mark the run for awaited Markdown fallback. Intermediate write
failure stops later streaming but retains the bounded latest text.

- [ ] **Step 6: Write failing terminal and Stop tests**

Cover awaited completion, final stream close, instance finalization, Markdown
fallback, failure/cancellation projections, owner mismatch, duplicate claim,
stale `runId`, and retry after exact-run cancellation returns `false`.

- [ ] **Step 7: Implement terminal delivery and exact-run Stop**

Override `onResponseComplete()` only when block streaming is off. It returns
only after a successful final card update or the existing Markdown sender.
Stop must call `requestPromptRunCancellation(sessionId, runId)` and never a
session-only fallback.

- [ ] **Step 8: Verify block-streaming isolation**

Add and pass a test proving `blockStreaming: 'on'` skips status-card creation
and preserves the existing block sender.

- [ ] **Step 9: Run focused tests and commit**

```bash
cd packages/channels/dingtalk
npx vitest run src/status-card-controller.test.ts src/DingtalkAdapter.test.ts -t "status card|exact-run Stop|block streaming"
git add src/status-card-controller.ts src/status-card-controller.test.ts src/DingtalkAdapter.ts src/DingtalkAdapter.test.ts
git commit -m "feat(dingtalk): stream exact-run status cards"
```

---

### Task 6: Implement structured question cards and settlement

**Files:**

- Create: `packages/channels/dingtalk/src/question-card-controller.ts`
- Create: `packages/channels/dingtalk/src/question-card-controller.test.ts`
- Modify: `packages/channels/dingtalk/src/DingtalkAdapter.ts`
- Test: `packages/channels/dingtalk/src/DingtalkAdapter.test.ts`

**Interfaces:**

- Consumes: `ChannelUserInputRequestContext`,
  `DingtalkInteractiveCardClient`, and the run registry.
- Produces one question card per permission request, with one terminalization
  function:

```ts
type QuestionRecordState = 'reserved' | 'pending' | 'responding' | 'terminal';

type QuestionTerminalState =
  | 'submitted'
  | 'cancelled'
  | 'expired'
  | 'resolved_outside_card';

function finalizeQuestion(
  record: LiveQuestionRecord,
  state: QuestionTerminalState,
  message: string,
): void;
```

- [ ] **Step 1: Write failing presentation tests**

Cover one-to-four questions in one card, all field types used by the normalized
contract, multiple independent requests in one run, disabled cards, creation
failure, Markdown cancellation fallback, and question-card eligibility while
block streaming is on. Use a deferred `createAndDeliver` to prove settlement
during delivery cannot reactivate the request or invoke its responder.

- [ ] **Step 2: Run and observe failure**

```bash
cd packages/channels/dingtalk
npx vitest run src/question-card-controller.test.ts src/DingtalkAdapter.test.ts -t "question card presentation"
```

- [ ] **Step 3: Implement `presentUserInputRequest()`**

Subscribe to settlement and insert a `reserved` record before
`createAndDeliver`. Activate it to `pending` only after successful delivery
and only if it is still reserved. If it became terminal while delivery was in
flight, best-effort disable the delivered card and do not revive or respond.
Return `presented` only after activation. On disable/create failure, send
readable semantic Markdown, call the bound responder with a cancelled outcome,
and return `handled`. Preserve `unsupported` for a missing eligible run/owner.

- [ ] **Step 4: Write failing submit/cancel tests**

Cover single select, multi-select joined with `", "`, custom text, original
`submitOptionId`, advertised rejection, unknown answer keys, owner mismatch,
missing owner, malformed payloads, duplicate callbacks, and first-responder
wins.

- [ ] **Step 5: Implement callback validation and one-shot claims**

Validate every callback answer key against the stored normalized question set
before calling `respond()`. Atomically claim `pending -> responding`, ACK, then
await the responder. Do not mark success before `respond()` returns `true`.
Unlike the OpenClaw reference, do not synthesize a new inbound message: call
the original request-bound responder directly.

- [ ] **Step 6: Write failing finalization tests**

Exercise submit, cancel, timeout, run cancellation, request destruction,
external non-cancel resolution, collapsed cancellation, responder `false`,
responder throw, and Card UI projection failure. Every case must:

```text
clear timer and settlement subscription
remove the request from pendingQuestionRequestIds
re-derive status-card waiting_input
remove responder/questions/answers/queued content
insert one compact tombstone
ignore later settlement and duplicate callbacks
```

- [ ] **Step 7: Implement `finalizeQuestion()` and bounded tombstones**

Use one first-wins transition to `terminal` for every terminal reason. The
timer finalizes `expired` before calling the responder; local run cancellation
finalizes cancellation before later collapsed bridge settlement. Keep only
correlation IDs and the terminal reason in the tombstone; never retain owner,
questions, answers, responder, timer, subscription, or queued card content.

- [ ] **Step 8: Run focused and full DingTalk tests**

```bash
cd packages/channels/dingtalk
npx vitest run src/question-card-controller.test.ts src/status-card-controller.test.ts src/interactive-card-client.test.ts src/DingtalkAdapter.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/question-card-controller.ts src/question-card-controller.test.ts src/DingtalkAdapter.ts src/DingtalkAdapter.test.ts
git commit -m "feat(dingtalk): answer structured questions with cards"
```

---

### Task 7: Integrate, verify, self-audit, and update PR #6930

**Files:**

- Modify: `docs/design/2026-07-15-dingtalk-interactive-cards.md`
- Modify: PR body draft under `.qwen/pr-drafts/`
- Modify: E2E result under `.qwen/e2e-tests/`

**Interfaces:**

- Consumes all previous tasks.
- Produces the reviewable implementation state for the existing PR.

- [ ] **Step 1: Run focused package verification**

```bash
cd packages/channels/base
npx vitest run src/ChannelBase.test.ts

cd ../dingtalk
npx vitest run
```

Expected: both commands exit 0 with zero failed tests.

- [ ] **Step 2: Run repository build and typecheck**

```bash
cd /Users/ben/workspace/qwen-code-worktrees/agent-dingtalk-interactive-cards
npm run build
npm run typecheck
```

Expected: both commands exit 0.

- [ ] **Step 3: Run formatting and lint checks**

```bash
npx prettier --check packages/channels/base/src packages/channels/dingtalk/src docs/design/2026-07-15-dingtalk-interactive-cards.md
npm run lint
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 4: Dry-run the E2E plan**

Use the globally installed `qwen` CLI to confirm the baseline configuration and
startup path. Record any credential, template, or real-device blocker
explicitly; do not treat unit tests as real DingTalk delivery evidence.

- [ ] **Step 5: Self-audit**

Read the full diff and all new files in open-ended passes. For each green test,
verify that its assertions would fail if the intended behavior regressed.
Require two consecutive clean passes; any fix resets the count and reruns the
relevant verification.

- [ ] **Step 6: Run code review and triage findings**

Use the Codex code-review workflow. For every finding, classify it as valid,
false positive, or overthinking. Valid fixes return through focused tests,
build/typecheck, and self-audit.

- [ ] **Step 7: Update the PR body**

Replace “design-only” language with the verified implementation scope and
reviewer behavior plan. Keep real-device cases marked unverified until executed.
Address the six non-outdated review threads with the implementing commit and
test evidence.

- [ ] **Step 8: Push the existing branch**

```bash
git push fork agent/dingtalk-interactive-cards
```

Expected: PR #6930 updates without creating another PR.
