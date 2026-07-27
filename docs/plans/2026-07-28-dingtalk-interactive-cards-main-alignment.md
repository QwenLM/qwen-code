# DingTalk Interactive Cards Main Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebase PR #6930 onto latest main while preserving interactive-card
isolation and integrating DingTalk outbound image delivery into streamed status
cards without exposing local paths.

**Architecture:** ChannelBase remains unchanged beyond the PR's existing
generic interaction contract. DingTalk keeps raw segment content for final
image upload while projecting sanitized intermediate snapshots; the adapter
reuses its existing final outbound-image transformer before terminal card
projection.

**Tech Stack:** TypeScript, Vitest, Qwen Channel Base, DingTalk Stream and Card
OpenAPI, Node.js 22.

## Global Constraints

- Work only in
  `/Users/ben/workspace/qwen-code-worktrees/agent-dingtalk-interactive-cards`.
- Keep PR #6930 Draft.
- Do not change the AskUserQuestion tool or permission event schema.
- Do not add workspace-specific identifiers to the shared card contract.
- Do not address existing review threads or the pre-existing duplicate cancel
  request.
- Use `git push --force-with-lease`, never an unconditional force push.
- Run tests from their owning package directories.
- Add every production behavior through a failing test first.

---

### Task 1: Rebase onto latest main

**Files:**

- Merge: `packages/channels/dingtalk/src/DingtalkAdapter.ts`
- Merge: `packages/channels/dingtalk/src/DingtalkAdapter.test.ts`

**Interfaces:**

- Consumes: `origin/main@3209b89f3` and the current PR commits.
- Produces: one conflict-free branch containing both outbound-image and
  interactive-card behavior.

- [ ] **Step 1: Reconfirm a clean branch and remote head**

Run:

```bash
git status -sb
git fetch origin main
git rev-parse HEAD origin/main fork/agent/dingtalk-interactive-cards
```

Expected: no uncommitted files; `origin/main` resolves to `3209b89f3`.

- [ ] **Step 2: Rebase the branch**

Run:

```bash
git rebase origin/main
```

Expected: conflicts only in `DingtalkAdapter.ts` and
`DingtalkAdapter.test.ts`.

- [ ] **Step 3: Resolve the adapter constructor conflict**

Keep both behaviors in this order:

```ts
this.atSender =
  (config as unknown as Record<string, unknown>)['atSender'] === true;
if (!this.config.instructions) {
  this.config.instructions = [
    '## DingTalk Channel',
    '',
    'You are responding through DingTalk.',
    IMAGE_INSTRUCTIONS,
  ].join('\n');
} else if (!this.config.instructions.includes('[IMAGE:')) {
  this.config.instructions += IMAGE_INSTRUCTIONS;
}
this.interactiveCardConfig = parseDingtalkInteractiveCardConfig(
  (config as DingtalkChannelConfig).interactiveCards,
);
```

- [ ] **Step 4: Resolve the test conflict**

Retain the latest-main custom-instruction test and every PR callback,
configuration, owner, and conversation-fallback test.

- [ ] **Step 5: Continue and verify the rebase**

Run:

```bash
git add packages/channels/dingtalk/src/DingtalkAdapter.ts \
  packages/channels/dingtalk/src/DingtalkAdapter.test.ts
GIT_EDITOR=true git rebase --continue
git status -sb
git merge-base --is-ancestor origin/main HEAD
```

Expected: the rebase completes, the worktree is clean, and the ancestry check
exits zero.

### Task 2: Sanitize image markers in intermediate card snapshots

**Files:**

- Modify: `packages/channels/dingtalk/src/outbound-image.ts`
- Test: `packages/channels/dingtalk/src/outbound-image.test.ts`
- Modify: `packages/channels/dingtalk/src/status-card-controller.ts`
- Test: `packages/channels/dingtalk/src/status-card-controller.test.ts`

**Interfaces:**

- Consumes: raw accumulated status-card content.
- Produces:
  `sanitizeStreamingImageMarkers(text: string): string`, returning display-safe
  content without complete or trailing partial local image paths.

- [ ] **Step 1: Add failing sanitizer tests**

Add tests equivalent to:

```ts
expect(
  sanitizeStreamingImageMarkers(
    'before [IMAGE: /Users/ben/private/image.png] after',
  ),
).toBe('before [Image pending] after');

expect(
  sanitizeStreamingImageMarkers('before [IMAGE: /Users/ben/private/image'),
).toBe('before [Image pending]');

expect(sanitizeStreamingImageMarkers('`[IMAGE: /Users/ben/code.png]`')).toBe(
  '`[IMAGE: /Users/ben/code.png]`',
);
```

- [ ] **Step 2: Verify the sanitizer tests fail**

Run:

```bash
cd packages/channels/dingtalk
npx vitest run src/outbound-image.test.ts -t "streaming image"
```

Expected: FAIL because `sanitizeStreamingImageMarkers` does not exist.

- [ ] **Step 3: Implement the minimal sanitizer**

Reuse the existing code-mask logic. Replace complete visible image markers with
`[Image pending]`; if the visible text ends with a case-insensitive prefix or
unterminated form of `[IMAGE:`, replace that suffix with `[Image pending]`.
Do not modify markers inside inline or fenced code.

- [ ] **Step 4: Verify sanitizer tests pass**

Run:

```bash
cd packages/channels/dingtalk
npx vitest run src/outbound-image.test.ts -t "streaming image"
```

Expected: all selected tests pass.

- [ ] **Step 5: Add a failing status-card snapshot test**

Append a segment in two chunks:

```ts
controller.append(segment, target, 'before [IMA');
controller.append(segment, target, 'GE: /Users/ben/private/image.png] after');
```

Advance the 500ms flush timer and assert every non-final streaming request:

```ts
expect(streamContents.join('\n')).not.toContain('/Users/ben/private');
expect(streamContents.at(-1)).toContain('[Image pending]');
```

- [ ] **Step 6: Verify the status-card test fails**

Run:

```bash
cd packages/channels/dingtalk
npx vitest run src/status-card-controller.test.ts -t "hides streamed image paths"
```

Expected: FAIL because the raw absolute path reaches the streaming request.

- [ ] **Step 7: Sanitize pending snapshots**

Keep `StatusRecord.content` raw. Set `pendingSnapshot` from
`sanitizeStreamingImageMarkers(record.content)` so final image processing still
receives the original marker.

- [ ] **Step 8: Verify focused status-card tests pass**

Run:

```bash
cd packages/channels/dingtalk
npx vitest run src/status-card-controller.test.ts -t "hides streamed image paths"
```

Expected: the selected test passes.

### Task 3: Transform final status-card image content

**Files:**

- Modify: `packages/channels/dingtalk/src/DingtalkAdapter.ts`
- Test: `packages/channels/dingtalk/src/DingtalkAdapter.test.ts`

**Interfaces:**

- Consumes: complete response text and an optional
  `ChannelOutputSegmentContext`.
- Produces: terminal status-card content that has passed through the existing
  `prepareOutgoingText(text)` validation, upload, retry, and redaction path.

- [ ] **Step 1: Add a failing adapter integration test**

Create a temporary valid PNG inside the channel workspace, stub the existing
token and media-upload endpoints to return `@lAL-card-media-id`, inject an
interaction presenter with a `closeOutput` spy, and invoke the protected
response-complete hook with:

```ts
`before\n[IMAGE: ${image.path}]\nafter`;
```

Assert the text passed to `closeOutput`:

```ts
expect(finalText).toContain('![image](@lAL-card-media-id)');
expect(finalText).not.toContain('[IMAGE:');
expect(finalText).not.toContain(image.path);
```

- [ ] **Step 2: Verify the integration test fails**

Run:

```bash
cd packages/channels/dingtalk
npx vitest run src/DingtalkAdapter.test.ts -t "final status card image"
```

Expected: FAIL because `onResponseComplete` passes raw text to the presenter.

- [ ] **Step 3: Transform only terminal card content**

In `onResponseComplete`, when both `segment` and `interactionPresenter` exist,
await `prepareOutgoingText(text)` before calling `closeOutput`. Leave the normal
fallback path unchanged so a failed card finalization still uses the existing
reply delivery behavior.

- [ ] **Step 4: Verify focused adapter tests pass**

Run:

```bash
cd packages/channels/dingtalk
npx vitest run src/DingtalkAdapter.test.ts -t \
  "final status card image|outbound image|interactive card config"
```

Expected: all selected tests pass.

### Task 4: Regression verification

**Files:**

- Test: `packages/channels/dingtalk/src/*.test.ts`
- Test: `packages/channels/base/src/ChannelBase.test.ts`
- Test: `packages/channels/base/src/SessionRouter.test.ts`

**Interfaces:**

- Consumes: rebased implementation from Tasks 1-3.
- Produces: package-level evidence for card, image, shared lifecycle, and scope
  behavior.

- [ ] **Step 1: Run focused DingTalk controller and adapter tests**

Run:

```bash
cd packages/channels/dingtalk
npx vitest run \
  src/outbound-image.test.ts \
  src/status-card-controller.test.ts \
  src/question-card-controller.test.ts \
  src/interaction-presenter.test.ts \
  src/DingtalkAdapter.test.ts
```

Expected: all tests pass.

- [ ] **Step 2: Run the complete DingTalk suite**

Run:

```bash
cd packages/channels/dingtalk
npx vitest run
```

Expected: all DingTalk tests pass.

- [ ] **Step 3: Run complete shared Channel tests**

Run:

```bash
cd packages/channels/base
npx vitest run src/ChannelBase.test.ts src/SessionRouter.test.ts
```

Expected: both suites pass with zero failures.

- [ ] **Step 4: Run static and build verification**

Run:

```bash
cd /Users/ben/workspace/qwen-code-worktrees/agent-dingtalk-interactive-cards
npm run typecheck
npx eslint \
  packages/channels/dingtalk/src/outbound-image.ts \
  packages/channels/dingtalk/src/outbound-image.test.ts \
  packages/channels/dingtalk/src/status-card-controller.ts \
  packages/channels/dingtalk/src/status-card-controller.test.ts \
  packages/channels/dingtalk/src/DingtalkAdapter.ts \
  packages/channels/dingtalk/src/DingtalkAdapter.test.ts
npm run build
npm run bundle
git diff --check
```

Expected: every command exits zero.

### Task 5: Daemon-managed Channel verification

**Files:**

- Read: `.qwen/settings.json`
- Record: `.qwen/e2e-tests/2026-07-28-dingtalk-main-alignment.md`

**Interfaces:**

- Consumes: the bundled CLI and ignored test Channel configuration.
- Produces: redacted evidence that the latest-main daemon worker can start,
  stop, restart, and receive a new DingTalk message.

- [ ] **Step 1: Start the dedicated daemon**

Run the bundled CLI on a dedicated loopback port with
`--channel interactive-card-e2e-current`. Do not print credentials.

Expected: daemon health succeeds and the selected worker logs `connected`.

- [ ] **Step 2: Verify restart**

Stop the worker or daemon cleanly, restart it with the same channel, and verify
the new Stream connection reaches `connected` without stale route errors.

- [ ] **Step 3: Record the unattended boundary**

Record daemon startup/restart evidence. Mark card rendering, Stop clicks,
AskUserQuestion submissions, and image rendering as pending real-device steps
when no user interaction is available.

- [ ] **Step 4: Stop the daemon**

Send SIGINT and verify the worker disconnects and the daemon logs
`daemon stopped`.

### Task 6: Audit, commit, and update the Draft PR

**Files:**

- Review: every changed and untracked file.
- Modify: PR description and test report only if they are stale after the
  rebase.

**Interfaces:**

- Consumes: verified implementation and recorded evidence.
- Produces: a rebased, committed, pushed Draft PR with a precise handoff.

- [ ] **Step 1: Perform two clean diff audits**

Read the complete diff against `origin/main`, including new files. In each pass,
check ownership, stale-run behavior, image-path redaction, fallback delivery,
resource bounds, and test assertions. Any fix resets the clean-pass count.

- [ ] **Step 2: Commit the implementation**

Stage only the files in this plan and commit with a conventional commit message.

- [ ] **Step 3: Push safely**

Run:

```bash
git push --force-with-lease fork agent/dingtalk-interactive-cards
```

Expected: the remote branch updates without overwriting an unexpected remote
head.

- [ ] **Step 4: Verify remote state**

Use `gh pr view` and `gh pr checks` to prove:

- PR HEAD matches local HEAD;
- PR remains Draft and open;
- no check has failed;
- pending checks are reported as pending rather than passed.

- [ ] **Step 5: Produce the morning handoff**

Report exact test counts and command exits, changed architecture, known
non-goals, CI state, and these pending real-device cases:

- streamed text followed by image rendering in the same card;
- direct AskUserQuestion;
- sequential AskUserQuestion;
- Stop and stale Stop;
- timeout and `/clear` visible terminal states;
- two-user owner isolation when a second account is available.
