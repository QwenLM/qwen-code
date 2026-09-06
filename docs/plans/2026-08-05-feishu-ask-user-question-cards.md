# Feishu Ask User Question Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Present the existing `ask_user_question` request as an owner-checked Feishu form card and resume the original permission transaction with the submitted answers.

**Architecture:** Add a pure Card V2 projection module and a Feishu-local one-shot question controller. `FeishuAdapter` supplies native send/patch operations, routes `card.action.trigger`, and delegates the existing `ChannelBase.presentUserInputRequest` hook without changing Core or bridge contracts.

**Tech Stack:** TypeScript, Vitest, `@qwen-code/channel-base`, Feishu Card V2 JSON, Feishu IM message REST APIs.

## Global Constraints

- Keep the current Qwen `ask_user_question` contract unchanged: 1-4 questions, 2-4 options per question, single-select or multi-select.
- Do not add a Feishu-specific model tool or synthetic inbound message.
- Keep every production change inside `packages/channels/feishu`.
- Callback correlation must use the captured request ID and owner; never infer the latest request from chat state.
- Permission settlement is authoritative; card updates are best-effort projections and cannot roll back an accepted answer.
- Existing Feishu streaming, Stop, block-streaming, and proactive-delivery behavior must remain compatible.

---

### Task 1: Build and parse Feishu question cards

**Files:**

- Create: `packages/channels/feishu/src/question-card.ts`
- Create: `packages/channels/feishu/src/question-card.test.ts`

**Interfaces:**

- Consumes: `ChannelUserInputRequestContext` and `ChannelUserQuestion` from `@qwen-code/channel-base`.
- Produces:

```ts
export type FeishuQuestionTerminalState =
  | 'processing'
  | 'submitted'
  | 'cancelled'
  | 'expired';

export type FeishuQuestionAction =
  | {
      kind: 'submit';
      requestId: string;
      operatorId?: string;
      formValue?: Record<string, unknown>;
    }
  | { kind: 'cancel'; requestId: string; operatorId?: string }
  | { kind: 'unhandled' };

export function buildQuestionCard(
  context: Pick<ChannelUserInputRequestContext, 'requestId' | 'questions'>,
): Record<string, unknown>;

export function buildQuestionTerminalCard(
  questions: ChannelUserQuestion[],
  state: FeishuQuestionTerminalState,
  answers?: Record<string, string>,
): Record<string, unknown>;

export function parseQuestionAction(data: unknown): FeishuQuestionAction;

export function parseQuestionAnswers(
  questions: ChannelUserQuestion[],
  formValue: Record<string, unknown> | undefined,
): Record<string, string> | undefined;
```

- [ ] **Step 1: Write failing Card V2 projection tests**

Add tests that assert one form contains all questions, single-select uses `select_static`, multi-select uses `multi_select_static`, field names equal `answerKey`, and Submit contains both `name: "qwen_ask_submit_<requestId>"` and `value: { action: "qwen_ask_submit", operation_id: requestId }` with `form_action_type: "submit"`. Assert Cancel carries `qwen_ask_cancel` and the same request ID.

- [ ] **Step 2: Run the projection tests and verify RED**

Run:

```bash
cd packages/channels/feishu
npx vitest run src/question-card.test.ts
```

Expected: FAIL because `question-card.ts` and its exports do not exist.

- [ ] **Step 3: Implement the minimum card builders**

Build Schema 2.0 cards with a single `form`, option labels as submitted values, descriptions rendered as notation Markdown, and non-interactive terminal cards. Do not add free-text inputs, alternate selection styles, localization configuration, or generic card abstractions.

- [ ] **Step 4: Write failing callback and answer parsing tests**

Cover top-level and `context` chat/message fields, `operator.open_id`, exact submit/cancel action IDs, missing operation ID, unrelated Stop actions, single string selection, array multi-selection, JSON-array multi-selection, missing required answers, unknown labels, duplicate single-select values, and extra form keys.

Representative assertion:

```ts
expect(
  parseQuestionAnswers(questions, {
    '0': 'Beijing',
    '1': ['Logs', 'Metrics'],
  }),
).toEqual({ '0': 'Beijing', '1': 'Logs, Metrics' });
```

- [ ] **Step 5: Implement strict parsing and verify GREEN**

Only accept captured answer keys and labels. Return `undefined` if a required question is missing, a single-select has anything other than one value, or any submitted key/value is not allowed.

Run:

```bash
cd packages/channels/feishu
npx vitest run src/question-card.test.ts
```

Expected: all question-card tests PASS.

### Task 2: Own the one-shot question lifecycle

**Files:**

- Create: `packages/channels/feishu/src/question-card-controller.ts`
- Create: `packages/channels/feishu/src/question-card-controller.test.ts`
- Consume: `packages/channels/feishu/src/question-card.ts`

**Interfaces:**

```ts
export type FeishuQuestionCallbackResult =
  | { kind: 'unhandled' }
  | {
      kind: 'handled';
      response: Record<string, unknown>;
      execute?: () => Promise<void>;
    };

export interface FeishuQuestionCardControllerOptions {
  timeoutMs: number;
  sendCard(chatId: string, card: Record<string, unknown>): Promise<string>;
  patchCard(messageId: string, card: Record<string, unknown>): Promise<boolean>;
  sendFallback(chatId: string, text: string): Promise<void>;
  onError?(operation: string, error: unknown): void;
}

export class FeishuQuestionCardController {
  constructor(options: FeishuQuestionCardControllerOptions);
  present(
    context: ChannelUserInputRequestContext,
  ): Promise<UserInputPresentationResult>;
  claim(data: unknown): FeishuQuestionCallbackResult;
  cancelRun(runId: string): void;
  dispose(): void;
}
```

- [ ] **Step 1: Write the failing presentation lifecycle tests**

Cover reservation before `sendCard` resolves, `presented` after delivery, settlement during delivery never reactivating the record, delivery failure sending readable fallback and calling `context.respond({ outcome: { outcome: "cancelled" } })`, and a second request in the same run/scope returning `unsupported`.

- [ ] **Step 2: Run the controller tests and verify RED**

Run:

```bash
cd packages/channels/feishu
npx vitest run src/question-card-controller.test.ts
```

Expected: FAIL because the controller does not exist.

- [ ] **Step 3: Implement reservation, delivery, and settlement cleanup**

Use `requestId` as the primary key and `sessionId + "\0" + owner.id` as the active scope. Subscribe through `context.onSettled` before awaiting delivery. Store the returned Feishu message ID only if the same reserved record is still live.

- [ ] **Step 4: Write failing callback arbitration tests**

Cover valid owner Submit, valid owner Cancel, missing operator, foreign operator, malformed form, unknown request, duplicate callback, responder returning `false`, responder throwing, accepted response followed by patch failure, and concurrent users/sessions.

The successful Submit test must assert:

```ts
expect(respond).toHaveBeenCalledWith({
  outcome: { outcome: 'selected', optionId: 'allow-once' },
  answers: { '0': 'Beijing', '1': 'Logs, Metrics' },
});
```

It must also assert that the callback is claimed synchronously, `execute` is the only asynchronous permission operation, and a second claim cannot call `respond` again.

- [ ] **Step 5: Implement first-responder-wins callback handling**

Claim the record before returning the callback response. For Submit, return a success toast plus `buildQuestionTerminalCard(..., "processing", answers)`. For Cancel, return an informational toast plus the cancelled projection. `execute` calls `context.respond`, terminalizes once, then patches the same message. Never reopen on false, throw, or patch failure.

- [ ] **Step 6: Write failing timeout/run/dispose tests**

Use fake timers to assert 270-second expiry marks the card expired before cancelling the original request. Assert `cancelRun` and `dispose` clear timers/subscriptions, terminalize live records once, and ignore late delivery or callback completion.

- [ ] **Step 7: Implement terminal cleanup and verify GREEN**

Run:

```bash
cd packages/channels/feishu
npx vitest run src/question-card.test.ts src/question-card-controller.test.ts
```

Expected: both files PASS with no unhandled promise rejection.

### Task 3: Integrate the controller with FeishuAdapter

**Files:**

- Modify: `packages/channels/feishu/src/FeishuAdapter.ts`
- Modify: `packages/channels/feishu/src/adapter.test.ts`
- Consume: `packages/channels/feishu/src/question-card-controller.ts`

**Interfaces:**

- `FeishuChannel.presentUserInputRequest(context)` delegates to the controller.
- `FeishuChannel.onOutputSegmentEnd(..., "input_requested")` finalizes the current output card while preserving session correlation.
- `card.action.trigger` returns the Ask callback response when handled and otherwise preserves the existing Stop response.

- [ ] **Step 1: Write failing callback-routing and presenter tests**

Assert `card.action.trigger` returns the controller response for Ask actions, does not call Stop handling for those actions, and still returns `{ toast: { type: "info", content: "已停止" } }` for an accepted Stop action. Assert `presentUserInputRequest` returns the controller result.

- [ ] **Step 2: Run the focused adapter tests and verify RED**

Run:

```bash
cd packages/channels/feishu
npx vitest run src/adapter.test.ts -t 'question|card action'
```

Expected: FAIL because the adapter has no question controller or presenter override.

- [ ] **Step 3: Add generic interactive-card send/patch helpers and wire the controller**

Extract the existing Feishu HTTP mechanics without changing endpoint behavior:

```ts
private async sendInteractiveCard(
  chatId: string,
  card: Record<string, unknown>,
): Promise<string>;

private async patchInteractiveCard(
  messageId: string,
  card: Record<string, unknown>,
): Promise<boolean>;
```

Make the existing streaming-card update method delegate to `patchInteractiveCard`. Construct `FeishuQuestionCardController` with a fixed `270_000` ms timeout.

- [ ] **Step 4: Write failing output-ordering tests**

Assert `onPromptStart` preserves reaction/session correlation but does not call the card-create endpoint. Assert the first `onResponseChunk` creates the status card. Assert an `input_requested` segment end finalizes/removes the current output-card state without deleting `sessionToInboundMsg`, and a later chunk can create a new status card in the same session.

- [ ] **Step 5: Implement lazy output creation and Ask boundary finalization**

Remove eager streaming-card creation from `onPromptStart`; keep the already-existing first-chunk creation path. Split output-card cleanup so `input_requested` releases only the current card state, while final prompt cleanup still removes sender/session auxiliary maps.

- [ ] **Step 6: Write failing lifecycle and disconnect tests**

Assert terminal task lifecycle calls `cancelRun` with the exact `runId`, and `disconnect` disposes the controller without changing existing WebSocket/HTTP cleanup.

- [ ] **Step 7: Implement lifecycle integration and verify GREEN**

Run:

```bash
cd packages/channels/feishu
npx vitest run src/question-card.test.ts src/question-card-controller.test.ts src/adapter.test.ts src/markdown.test.ts src/media.test.ts
```

Expected: all Feishu focused tests PASS, including existing Stop and streaming-card coverage.

### Task 4: Verify behavior and prepare the pull request

**Files:**

- Create: `.qwen/e2e-tests/feishu-ask-user-question-cards.md` (git-ignored evidence)
- Review: `docs/design/2026-08-05-feishu-ask-user-question-cards.md`
- Review: all changed and untracked files in the isolated worktree

**Interfaces:** None; this task validates the complete feature.

- [ ] **Step 1: Record the E2E scenarios and dry-run the baseline capability**

Document direct question, multi-question, multi-select, foreign clicker, duplicate submit, Cancel, expiry, text-before-question, and post-answer continuation. Record unavailable credentials or callback routing as an explicit blocker rather than claiming device verification.

- [ ] **Step 2: Run focused tests, build, and typecheck**

Run:

```bash
cd packages/channels/feishu
npx vitest run src/question-card.test.ts src/question-card-controller.test.ts src/adapter.test.ts src/markdown.test.ts src/media.test.ts
cd ../../..
npm run build
npm run typecheck
git diff --check
```

Expected: every command exits 0. Existing diagnostic stderr from media and credential-failure tests is baseline output, not a failure.

- [ ] **Step 3: Perform the repository self-audit**

Read the complete diff and every new file in two open-ended passes. Verify each test can fail for the intended production defect, every accepted permission remains accepted after projection failure, and no OpenClaw tool/injection code entered the implementation. Any fix resets the clean-pass count and reruns Step 2.

- [ ] **Step 4: Request code review and resolve valid findings**

Review the exact diff against Issue #8567, the design document, Core-module gate, callback owner safety, first-responder-wins semantics, late async completion, existing Stop behavior, and test adequacy. Fix Critical and Important findings, rerun Step 2, and repeat the self-audit.

- [ ] **Step 5: Publish only with explicit Git authorization**

After receiving authorization for the exact changed paths, stage only those paths, commit with:

```text
feat(channels): add Feishu ask-user question cards
```

Push `feat/feishu-ask-user-question-card` to the appropriate fork and create one Draft PR against `QwenLM/qwen-code:main` using `.github/pull_request_template.md`. Link Issue #8567 and post the E2E report as a separate PR comment when applicable.
