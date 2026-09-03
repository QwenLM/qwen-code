# DingTalk Lifecycle Delivery Convergence Implementation Plan

> Historical plan: later product review approved a bounded tool-title summary in the active card and a minimal `AcpBridge` partial-update fix. The final contract is `docs/design/dingtalk-dynamic-lifecycle-tags.md`; the phase-only steps below preserve the original implementation sequence rather than the final scope.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved phase-only DingTalk lifecycle prototype without exposing tool details, accumulating stale reactions, mis-resolving `auto` language, or dropping current-main source attribution.

**Architecture:** Keep lifecycle classification in the DingTalk adapter and project only a finite phase enum into reactions and the interactive card. Replace per-event reaction queueing with one desired-state drain per inbound message, where new phases overwrite pending phases and terminal states preempt them. Resolve the effective CLI language before constructing any channel, then merge current `origin/main` and preserve its source-label contract.

**Tech Stack:** TypeScript, Vitest, DingTalk emotion API, DingTalk interactive cards, Qwen CLI i18n.

**Spec:** `docs/design/dingtalk-dynamic-lifecycle-tags.md`

## Global Constraints

- The UI may display lifecycle phase labels and assistant response text only; it must not display tool title, description, path, command, parameters, output, or reasoning.
- `👀` remains stable while a single replaceable phase reaction is active.
- Phase updates are latest-wins; `completed`, `failed`, and `cancelled` preempt pending phases.
- A failed recall prevents a contradictory replacement from being attached.
- Status cards are created on `started`, stream response text below the phase, and remove the phase at terminal completion.
- Preserve current-main named-task source labels above response content in running, streaming, fallback, and terminal cards while keeping the lifecycle phase first during active runs.
- Do not change the DingTalk card template or add dependencies.

---

### Task 1: Enforce the phase-only presentation boundary

**Files:**

- Modify: `packages/channels/base/src/ChannelBase.test.ts`
- Modify: `packages/channels/base/src/ChannelBase.ts`
- Modify: `packages/channels/base/src/types.ts`
- Modify: `packages/channels/dingtalk/src/presentation-phase.ts`
- Modify: `packages/channels/dingtalk/src/DingtalkAdapter.test.ts`
- Modify: `packages/channels/dingtalk/src/DingtalkAdapter.ts`
- Modify: `packages/channels/dingtalk/src/interaction-presenter.ts`
- Modify: `packages/channels/dingtalk/src/status-card-controller.test.ts`
- Modify: `packages/channels/dingtalk/src/status-card-controller.ts`

**Interfaces:**

- Consumes: `ChannelTaskLifecycleEvent` with sanitized `kind`, `title`, and `status`.
- Produces: `lifecyclePresentationPhase(event): DingtalkPresentationPhase | undefined`; no tool-detail presentation type or card-detail API.

- [ ] **Step 1: Change the ChannelBase regression test so raw input, including `rawInput.description`, is absent from emitted lifecycle events while the adapter-owned tool callback still receives the original event.**

```ts
expect(lifecycleToolCall!.toolCall).not.toHaveProperty('description');
expect(lifecycleToolCall!.toolCall).not.toHaveProperty('rawInput');
expect(ch.toolCalls[0]!.event.rawInput).toEqual({
  command: 'echo $SECRET',
  description: 'Check disk health\nwithout exposing commands',
});
```

- [ ] **Step 2: Run the focused ChannelBase test and verify RED because the current sanitizer emits `description`.**

Run: `cd packages/channels/base && npx vitest run src/ChannelBase.test.ts -t "raw tool input"`

Expected: FAIL showing the lifecycle event still contains `description`.

- [ ] **Step 3: Change DingTalk tests to send a tool event whose title and description contain sensitive literals, then assert the card update receives only the mapped phase and card content contains none of those literals.**

```ts
expect(updateStatusCardPhase).toHaveBeenCalledWith('run-1', 'running');
expect(updateStatusCardTool).not.toBeDefined();
expect(streamedContent).toBe('🖥️ 执行中');
expect(streamedContent).not.toContain('/private/project');
expect(streamedContent).not.toContain('grep SECRET');
```

- [ ] **Step 4: Run the focused DingTalk tests and verify RED because the current tool-detail path is called and rendered.**

Run: `cd packages/channels/dingtalk && npx vitest run src/DingtalkAdapter.test.ts src/status-card-controller.test.ts -t "phase|detail|card body"`

Expected: FAIL showing `updateStatusCardTool` or a Markdown detail bullet.

- [ ] **Step 5: Remove `SanitizedToolCallEvent.description`, the `rawInput.description` extraction, `DingtalkToolPresentation`, `lifecycleToolPresentation`, `updateStatusCardTool`, status-card detail collections, and the DingTalk prompt instruction that asks the model to produce descriptions. Route every tool event through `lifecyclePresentationPhase` only.**

```ts
const presentationPhase = lifecyclePresentationPhase(event);
if (event.runId && presentationPhase) {
  this.interactionPresenter?.updateStatusCardPhase(
    event.runId,
    presentationPhase,
  );
}
```

- [ ] **Step 6: Run the three focused test files and verify GREEN.**

Run: `cd packages/channels/base && npx vitest run src/ChannelBase.test.ts && cd ../../dingtalk && npx vitest run src/DingtalkAdapter.test.ts src/status-card-controller.test.ts`

Expected: all tests pass with no sensitive literal in any card payload assertion.

### Task 2: Coalesce reaction transitions and preempt with terminal state

**Files:**

- Modify: `packages/channels/dingtalk/src/DingtalkAdapter.test.ts`
- Modify: `packages/channels/dingtalk/src/DingtalkAdapter.ts`

**Interfaces:**

- Consumes: phase and terminal lifecycle events for one stable inbound message.
- Produces: one reaction drain whose mutable desired phase is overwritten by newer phases and whose terminal request has priority.

- [ ] **Step 1: Add a failing latest-wins test that blocks a phase recall, emits `searching`, `running`, and `replying`, releases the recall, and expects only `replying` to be attached.**

```ts
expect(attachReaction.mock.calls.map(([, , tag]) => tag.name)).toEqual([
  '👀',
  '🤔 Thinking',
  '✍️ Replying',
]);
```

- [ ] **Step 2: Run that test and verify RED because the existing `tail` enqueues and attaches every intermediate phase.**

Run: `cd packages/channels/dingtalk && npx vitest run src/DingtalkAdapter.test.ts -t "latest phase"`

Expected: FAIL with intermediate `Searching` and `Running` attachments.

- [ ] **Step 3: Add a failing terminal-preemption test that blocks the initial eye attach, emits multiple phases and `cancelled`, releases the attach, and expects no transient status attachment before `⏹️ Stopped`.**

```ts
expect(attachReaction.mock.calls.map(([, , tag]) => tag.name)).toEqual([
  '👀',
  '⏹️ Stopped',
]);
```

- [ ] **Step 4: Run that test and verify RED because the queued start and phase operations currently run before terminal cleanup.**

Run: `cd packages/channels/dingtalk && npx vitest run src/DingtalkAdapter.test.ts -t "terminal preempts"`

Expected: FAIL with obsolete transient attachments.

- [ ] **Step 5: Replace per-phase `enqueueReaction` calls with mutable state (`desiredStatusTag`, `terminalTag`, `drainScheduled`) and a single `drainReactionState` loop. Re-read desired state after each awaited recall and before each attach; if terminal is set, clear the current status and eye, attach exactly the terminal tag, then forget the state.**

```ts
state.desiredStatusTag = tag;
this.scheduleReactionDrain(state);

while (this.reactionStates.get(state.key) === state) {
  if (state.terminalTag) {
    await this.finishReactionState(state);
    return;
  }
  const desired = state.desiredStatusTag;
  if (!desired || desired.name === state.statusTag?.name) return;
  if (state.statusTag && !(await this.recallReaction(...))) return;
  if (state.terminalTag) continue;
  const latest = state.desiredStatusTag;
  if (latest && (await this.attachReaction(..., latest)) !== false) {
    state.statusTag = latest;
  }
}
```

- [ ] **Step 6: Run all DingTalk adapter tests and verify GREEN, including recall-failure and disconnect/session-death cleanup cases.**

Run: `cd packages/channels/dingtalk && npx vitest run src/DingtalkAdapter.test.ts`

Expected: all adapter tests pass and no test observes an obsolete terminal-delayed phase.

### Task 3: Resolve the effective display language at channel construction

**Files:**

- Modify: `packages/cli/src/i18n/index.ts`
- Modify: `packages/cli/src/commands/channel/daemon-worker.test.ts`
- Modify: `packages/cli/src/commands/channel/daemon-worker.ts`
- Modify: `packages/cli/src/commands/channel/start.test.ts`
- Modify: `packages/cli/src/commands/channel/start.ts`

**Interfaces:**

- Consumes: `QWEN_CODE_LANG`, `general.language`, and system locale.
- Produces: resolved `SupportedLanguage` in `ChannelBaseOptions.displayLanguage`; never the literal `auto`.

- [ ] **Step 1: Add failing command tests for `general.language: 'auto'`, mocking system detection to `zh`, and assert `displayLanguage: 'zh'`; add an env-precedence case where `QWEN_CODE_LANG=zh` overrides an English setting.**

```ts
expect(createChannel).toHaveBeenCalledWith(
  expect.anything(),
  expect.anything(),
  expect.anything(),
  expect.objectContaining({ displayLanguage: 'zh' }),
);
```

- [ ] **Step 2: Run the two command test files and verify RED because the current code forwards `auto` or the raw setting.**

Run: `cd packages/cli && npx vitest run src/commands/channel/start.test.ts src/commands/channel/daemon-worker.test.ts`

Expected: FAIL with `displayLanguage: 'auto'` or the lower-priority setting.

- [ ] **Step 3: Export the existing `resolveLanguage` helper and pass `resolveLanguage(resolveLanguageSetting(configuredLanguage))` from both direct-start and daemon-worker entry points.**

```ts
const displayLanguage = resolveLanguage(
  resolveLanguageSetting(settings.merged.general?.language as string),
);
```

- [ ] **Step 4: Run the i18n and command tests and verify GREEN.**

Run: `cd packages/cli && npx vitest run src/i18n/index.test.ts src/commands/channel/start.test.ts src/commands/channel/daemon-worker.test.ts`

Expected: all tests pass with explicit, auto-detected, and environment-overridden language cases.

### Task 4: Integrate current main without regressing source labels

**Files:**

- Modify on merge conflict: `packages/channels/dingtalk/src/interaction-presenter.ts`
- Modify on merge conflict: `packages/channels/dingtalk/src/interaction-presenter.test.ts`
- Modify on merge conflict if required: `packages/channels/dingtalk/src/DingtalkAdapter.ts`
- Modify: `docs/design/dingtalk-dynamic-lifecycle-tags.md`

**Interfaces:**

- Consumes: current-main `registerRun(..., sourceLabel?)` and `getResponseSourceLabel(sessionId)`.
- Produces: source-prefixed lifecycle card content plus the approved localized phase labels.

- [ ] **Step 1: Commit the green convergence changes so the dirty worktree is recoverable, then merge `origin/main` without rewriting published history.**

Run: `git merge --no-edit origin/main`

Expected: the known interaction-presenter conflict is surfaced for explicit resolution.

- [ ] **Step 2: Resolve the conflict by retaining the sixth `sourceLabel` argument and `withSourcePrefix` behavior from current main while retaining `updateStatusCardPhase` and phase-first active content.**

```ts
this.interactionPresenter?.registerRun(
  event.runId,
  event.owner.id,
  inboundOwner.target,
  event.sessionId,
  inboundOwner.sender,
  this.getResponseSourceLabel(event.sessionId),
);
```

- [ ] **Step 3: Update the design to state phase-only safety, desired-state coalescing, terminal preemption, effective language resolution, and source-label composition.**

- [ ] **Step 4: Run the focused DingTalk presenter/controller/adapter tests and verify GREEN after the merge.**

Run: `cd packages/channels/dingtalk && npx vitest run src/interaction-presenter.test.ts src/status-card-controller.test.ts src/DingtalkAdapter.test.ts`

Expected: all tests pass, including source labels through running, streaming, and terminal cards.

### Task 5: Verify and deliver the existing Draft PR

**Files:**

- Update remote PR: `https://github.com/QwenLM/qwen-code/pull/10504`

**Interfaces:**

- Consumes: the final merged worktree and repository PR template.
- Produces: pushed branch, current PR body, CI/readback evidence, and an explicit live-E2E evidence boundary.

- [ ] **Step 1: Format changed files, run `git diff --check`, and run focused tests, build, typecheck, and lint from the final tree.**

Run: `npx prettier --check <changed-files> && git diff --check && npm run build && npm run typecheck && npm run lint`

Expected: every command exits 0.

- [ ] **Step 2: Perform the repository self-audit over the complete `origin/main...HEAD` diff until two consecutive passes find no issue; any fix resets the clean-pass count and reruns verification.**

- [ ] **Step 3: Request an independent code review against exact final SHAs and fix every Critical or Important finding before proceeding.**

- [ ] **Step 4: Push the branch normally, update the Draft PR body from `.github/pull_request_template.md`, and read back the PR head, body, checks, and mergeability with `gh`.**

- [ ] **Step 5: Attempt live DingTalk E2E only if valid credentials are available without exposing them. If DingTalk returns credential error `40096`, record live delivery as unverified rather than treating local/loopback evidence as equivalent.**

- [ ] **Step 6: Report the exact delivered state, remaining external gates (review/CI/live credentials), and preserve the worktree for PR iteration.**
