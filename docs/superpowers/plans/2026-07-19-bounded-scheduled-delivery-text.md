# Bounded Scheduled Delivery Text Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist and deliver an explicit bounded snapshot when a scheduled Agent answer exceeds the 100,000-code-unit outbox record limit.

**Architecture:** Keep normalization inside the core outbox enqueue boundary so every caller shares the same behavior. Normalize once before validation and idempotency comparison; leave Session, dispatcher, IPC, and Channel adapters unchanged.

**Tech Stack:** TypeScript, Node.js, Vitest, existing JSON outbox and atomic-write helpers.

## Global Constraints

- `ScheduledDeliveryRecord.text` remains bounded to 100,000 JavaScript UTF-16 code units.
- Text within the bound is preserved exactly.
- Oversized text receives `\n\n[Channel delivery truncated because the result exceeded the outbox size limit.]` inside the bound.
- Truncation must not leave a dangling UTF-16 high surrogate.
- Candidate validation and duplicate-delivery comparison must use the same normalized text.
- Do not change outbox schema, dispatcher IPC, adapters, or Session behavior.
- Preserve the unrelated untracked `CHANNEL_DM_POLICY_SUMMARY.md` file.

---

### Task 1: Normalize oversized outbox text

**Files:**

- Modify: `packages/core/src/services/scheduled-delivery-outbox.ts:78-84,258-314`
- Test: `packages/core/src/services/scheduled-delivery-outbox.test.ts:25-120`

**Interfaces:**

- Consumes: `enqueueScheduledDelivery(projectRoot, input)` and the existing 100,000-unit record validator.
- Produces: the unchanged `enqueueScheduledDelivery` signature, returning a record whose `text` is normalized before persistence and idempotency comparison.

- [ ] **Step 1: Write failing boundary and idempotency tests**

Add the following cases after `enqueues an idempotent pending record`:

```ts
const truncationMarker =
  '\n\n[Channel delivery truncated because the result exceeded the outbox size limit.]';

it('preserves delivery text exactly at the outbox limit', async () => {
  const text = 'x'.repeat(100_000);

  const record = await enqueue({ text });

  expect(record.text).toBe(text);
});

it('truncates oversized delivery text without splitting a surrogate pair', async () => {
  const prefixLimit = 100_000 - truncationMarker.length;
  const text = `${'x'.repeat(prefixLimit - 1)}😀${'y'.repeat(
    truncationMarker.length + 1,
  )}`;

  const record = await enqueue({ text });

  expect(record.text.length).toBeLessThanOrEqual(100_000);
  expect(record.text).toBe(`${'x'.repeat(prefixLimit - 1)}${truncationMarker}`);
});

it('keeps repeated oversized enqueue idempotent', async () => {
  const text = 'x'.repeat(100_001);

  const first = await enqueue({ text });
  const second = await enqueue({ text });

  expect(second).toEqual(first);
  expect(await readScheduledDeliveryOutbox(workspace)).toEqual([first]);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
cd packages/core
npx vitest run src/services/scheduled-delivery-outbox.test.ts
```

Expected: the exact-limit test passes; the oversized tests fail because `enqueueScheduledDelivery` currently rejects text longer than 100,000 units.

- [ ] **Step 3: Implement one normalization boundary**

Add beside the existing limits:

```ts
const TRUNCATED_TEXT_SUFFIX =
  '\n\n[Channel delivery truncated because the result exceeded the outbox size limit.]';
```

Add before `sameEnqueue`:

```ts
function normalizeDeliveryText(text: string): string {
  if (text.length <= MAX_TEXT_LENGTH) return text;
  const prefixLimit = MAX_TEXT_LENGTH - TRUNCATED_TEXT_SUFFIX.length;
  let prefix = text.slice(0, prefixLimit);
  const lastCodeUnit = prefix.charCodeAt(prefix.length - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
    prefix = prefix.slice(0, -1);
  }
  return `${prefix}${TRUNCATED_TEXT_SUFFIX}`;
}
```

At the start of `enqueueScheduledDelivery`, normalize the input once and use it for both the candidate record and duplicate comparison:

```ts
const normalizedInput: EnqueueScheduledDeliveryInput = {
  ...input,
  text: normalizeDeliveryText(input.text),
};
const createdAt = normalizedInput.createdAt ?? Date.now();
```

Replace candidate reads of `input` with `normalizedInput`, locate the existing record by `normalizedInput.deliveryId`, and call `sameEnqueue(existing, normalizedInput)`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
cd packages/core
npx vitest run src/services/scheduled-delivery-outbox.test.ts
```

Expected: all scheduled-delivery outbox tests pass.

- [ ] **Step 5: Run type, lint, and related regression checks**

Run:

```bash
cd packages/core
npm run typecheck
npx eslint src/services/scheduled-delivery-outbox.ts src/services/scheduled-delivery-outbox.test.ts
npx vitest run src/services/cronTasksFile.test.ts src/services/cronScheduler.test.ts src/services/scheduled-delivery-outbox.test.ts
```

Expected: every command exits 0 with no test failures or lint errors.

- [ ] **Step 6: Commit and push the scoped change**

Run:

```bash
git add docs/superpowers/plans/2026-07-19-bounded-scheduled-delivery-text.md packages/core/src/services/scheduled-delivery-outbox.ts packages/core/src/services/scheduled-delivery-outbox.test.ts
git commit -m "fix(scheduler): bound oversized delivery text"
git push
```

Expected: the existing PR head advances; `CHANNEL_DM_POLICY_SUMMARY.md` remains untracked.
