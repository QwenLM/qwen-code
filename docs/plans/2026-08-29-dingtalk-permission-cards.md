# DingTalk Tool Permission Cards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Present ordinary DingTalk tool permission requests as owner-bound native cards while preserving exact permission semantics and text fallback.

**Architecture:** Add an adapter-neutral permission presentation hook beside the existing user-question hook, then implement DingTalk lifecycle and callback handling in a focused controller. Reuse the existing question card template and callback transport; keep ACP, daemon, core, and other adapters unchanged.

**Tech Stack:** TypeScript, Vitest, DingTalk Card OpenAPI, existing ChannelBase permission relay

**Spec:** `docs/design/2026-08-29-dingtalk-permission-cards.md`

## Global Constraints

- Minimum code that solves GitHub Issue #10388; no speculative abstraction.
- ESM, strict TypeScript, no `any`, kebab-case `.ts` files, collocated tests.
- Preserve `/approve`, `/approve-always`, and `/deny` fallback behavior.
- No `packages/core`, ACP, daemon route, provider, model, auth, or unrelated package behavioral changes.
- Do not claim real DingTalk delivery without callback and platform evidence.

---

### Task 1: Define the Channel permission-presentation seam

**Files:**

- Modify: `packages/channels/base/src/types.ts`
- Modify: `packages/channels/base/src/index.ts`
- Modify: `packages/channels/base/src/ChannelBase.ts`
- Test: `packages/channels/base/src/ChannelBase.test.ts`

**Interfaces:**

- Consumes: existing pending permission options, attended prompt owner, output-segment boundary, and `respondToUserInput()` serialization.
- Produces: `ChannelPermissionRequestContext` and `presentPermissionRequest(context): Promise<UserInputPresentationResult>`.

- [ ] **Step 1: Write failing tests for ordinary structured presentation**

```ts
it('presents an attended ordinary permission before text fallback', async () => {
  channel.permissionPresentation = { kind: 'presented' };
  await channel.dispatchPermissionRequest(permissionRequest());
  expect(
    channel.presentedPermission?.decisions.map(({ kind }) => kind),
  ).toEqual(['allow_once', 'allow_always', 'deny']);
  expect(channel.sent).toEqual([]);
});

it('uses text fallback when permission presentation is unsupported', async () => {
  channel.permissionPresentation = { kind: 'unsupported' };
  await channel.dispatchPermissionRequest(permissionRequest());
  expect(channel.sent.at(-1)).toContain('/approve');
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cd packages/channels/base && npx vitest run src/ChannelBase.test.ts -t 'ordinary permission'`

Expected: FAIL because the permission hook and captured context do not exist.

- [ ] **Step 3: Add the minimal types, hook, and dispatch branch**

```ts
protected async presentPermissionRequest(
  _context: ChannelPermissionRequestContext,
): Promise<UserInputPresentationResult> {
  return { kind: 'unsupported' };
}
```

Build the context only for an attended non-loop prompt, derive its advertised decisions from the original options, and call the hook after question presentation returns unsupported but before formatting text.

- [ ] **Step 4: Add failing response-race and settlement tests, then implement one-shot response wiring**

```ts
const [cardResult, commandResult] = await Promise.all([
  context.respond('allow_once'),
  channel.receive('/deny'),
]);
expect(bridge.respondToPermission).toHaveBeenCalledTimes(1);
expect([cardResult, commandResult]).toContain(true);
```

Use the existing pending response promise for both presentation kinds. Preserve the question-only command warning, owner checks, chat/thread lookup, and settlement listeners.

- [ ] **Step 5: Run the complete ChannelBase test file**

Run: `cd packages/channels/base && npx vitest run src/ChannelBase.test.ts`

Expected: all ChannelBase tests pass.

### Task 2: Implement the DingTalk permission-card lifecycle

**Files:**

- Create: `packages/channels/dingtalk/src/permission-card-controller.ts`
- Create: `packages/channels/dingtalk/src/permission-card-controller.test.ts`

**Interfaces:**

- Consumes: `ChannelPermissionRequestContext`, `DingtalkInteractiveCardClient`, `DingtalkCardCallback`, and the existing question template.
- Produces: `present(context, target)`, `claim(callback)`, and `cancelRun(runId)`.

- [ ] **Step 1: Write failing rendering and decision tests**

```ts
await controller.present(context, { chatId: 'cid-1', isGroup: true });
expect(client.createAndDeliver).toHaveBeenCalledWith(
  expect.objectContaining({
    cardParamMap: expect.objectContaining({
      form: {
        fields: [expect.objectContaining({ name: 'permission_decision' })],
      },
    }),
  }),
);
```

Assert allow-once and deny are rendered, allow-always is rendered only when advertised, and an accepted form value reaches `context.respond()` as the corresponding literal decision.

- [ ] **Step 2: Run the controller test and verify RED**

Run: `cd packages/channels/dingtalk && npx vitest run src/permission-card-controller.test.ts`

Expected: FAIL because the controller module does not exist.

- [ ] **Step 3: Implement reserved, pending, claimed, and terminal records**

```ts
type PermissionCardState = 'reserved' | 'pending' | 'claimed' | 'terminal';
type PermissionCardTerminalState =
  | 'approved'
  | 'denied'
  | 'cancelled'
  | 'expired';
```

Subscribe before delivery, index live records by request and outTrack ID, claim synchronously, delete terminal records, and update delivered cards best-effort.

- [ ] **Step 4: Add failing security and failure-path tests, then implement them**

Cover foreign actors, unknown fields, multiple values, unavailable decisions, duplicate callbacks, delivery failure returning `unsupported`, timeout cancellation, run cancellation, resolution during delivery, and resolution outside the card.

- [ ] **Step 5: Run the controller tests**

Run: `cd packages/channels/dingtalk && npx vitest run src/permission-card-controller.test.ts`

Expected: all permission controller tests pass.

### Task 3: Wire configuration, presenter, adapter, and callback routing

**Files:**

- Modify: `packages/channels/dingtalk/src/interactive-card-types.ts`
- Modify: `packages/channels/dingtalk/src/interactive-card-types.test.ts`
- Modify: `packages/channels/dingtalk/src/index.ts`
- Modify: `packages/channels/dingtalk/src/interaction-presenter.ts`
- Modify: `packages/channels/dingtalk/src/interaction-presenter.test.ts`
- Modify: `packages/channels/dingtalk/src/DingtalkAdapter.ts`
- Modify: `packages/channels/dingtalk/src/DingtalkAdapter.test.ts`

**Interfaces:**

- Consumes: the controller from Task 2 and the Channel hook from Task 1.
- Produces: independently configurable permission cards and callback routing through the existing streamed callback listener.

- [ ] **Step 1: Write failing configuration tests**

```ts
expect(parseDingtalkInteractiveCardConfig(undefined).permissionCard).toEqual({
  enabled: true,
  timeoutMs: 270_000,
});
expect(() =>
  parseDingtalkInteractiveCardConfig({ permissionCard: { timeoutMs: 0 } }),
).toThrow('permissionCard.timeoutMs');
```

- [ ] **Step 2: Run the configuration tests and verify RED, then add parsing and management metadata**

Run: `cd packages/channels/dingtalk && npx vitest run src/interactive-card-types.test.ts`

Expected before implementation: FAIL because `permissionCard` is absent. Expected after implementation: pass.

- [ ] **Step 3: Write failing presenter and adapter wiring tests**

Assert that a matching registered run delegates permission presentation, mismatched owner or target returns `unsupported`, permission callbacks are offered to the permission controller before the question controller, and terminal run cleanup cancels permission cards.

- [ ] **Step 4: Implement the minimal wiring**

```ts
presentPermission(
  context: ChannelPermissionRequestContext,
): Promise<UserInputPresentationResult> {
  const run = this.runs.get(context.runId);
  if (!run || run.terminal || run.ownerId !== context.owner.id) {
    return Promise.resolve({ kind: 'unsupported' });
  }
  return this.options.permissionCards?.present(
    context,
    this.cardTarget(context.target),
  ) ?? Promise.resolve({ kind: 'unsupported' });
}
```

Construct the controller only when root cards and `permissionCard.enabled` are true. Override the Channel permission hook and route unclaimed callbacks onward to the question controller.

- [ ] **Step 5: Run all affected DingTalk tests**

Run: `cd packages/channels/dingtalk && npx vitest run src/permission-card-controller.test.ts src/question-card-controller.test.ts src/interaction-presenter.test.ts src/interactive-card-types.test.ts src/DingtalkAdapter.test.ts`

Expected: all affected DingTalk tests pass.

### Task 4: Validate and prepare the Draft PR

**Files:**

- Create: `.qwen/e2e-tests/2026-08-29-dingtalk-permission-cards.md` (ignored evidence)
- Modify if evidence changes: `docs/design/2026-08-29-dingtalk-permission-cards.md`

**Interfaces:**

- Consumes: completed implementation and tests.
- Produces: reproducible reviewer evidence and a template-compliant Draft PR linked to #10388.

- [ ] **Step 1: Run formatting, affected tests, build, and typecheck**

Run: `npm run format && (cd packages/channels/base && npx vitest run src/ChannelBase.test.ts) && (cd packages/channels/dingtalk && npx vitest run src/permission-card-controller.test.ts src/question-card-controller.test.ts src/interaction-presenter.test.ts src/interactive-card-types.test.ts src/DingtalkAdapter.test.ts) && npm run build && npm run typecheck`

Expected: every command exits zero.

- [ ] **Step 2: Perform the repository-required self-audit**

Read `git status --short`, `git diff --check`, the full diff, and all new untracked files. Run two consecutive clean review passes; any fix resets the count and reruns affected verification.

- [ ] **Step 3: Request read-only code review and resolve Critical or Important findings**

Review the exact `origin/main...HEAD` plus working-tree diff against Issue #10388, the design, and this plan. Re-run verification after any fix.

- [ ] **Step 4: Present the complete commit plan for explicit approval**

Use one scoped commit with this message after the user approves:

```text
to #10388 [feat] Present DingTalk permission requests as cards

Co-authored-by: Codex Using gpt-5.6-sol
```

- [ ] **Step 5: After separate push approval, push and create a Draft PR**

Use `.github/pull_request_template.md`, write corresponding English and Chinese sections, include `Closes #10388`, and run `gh pr create --draft --base main --head BenGuanRan:feat/dingtalk-permission-cards-10388`.
