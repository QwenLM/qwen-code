# DingTalk Permission Card Language Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the DingTalk permission card and its immediate text fallback follow Qwen's default UI language, with Chinese copy for Chinese configurations and English for every other value.

**Architecture:** Resolve a two-value locale snapshot (`'zh' | 'en'`) from the already-loaded `general.language` setting at Channel startup and pass it through the existing `ChannelBaseOptions`. `ChannelBase` localizes only the permission decisions and fallback request used by this PR; DingTalk localizes only its permission-card chrome, terminal copy, and the existing card-owner feedback reached by the new card. No session-language request, live synchronization, translation framework, or other Channel copy is added.

**Tech Stack:** TypeScript, Vitest, existing Qwen settings loader, existing Channel permission-presentation seam, DingTalk interactive-card template

**Spec:** `docs/design/2026-08-29-dingtalk-permission-cards.md`

## Global Constraints

- Build on Draft PR #10457 at commit `acf6330c64b8e94aa8aa1be0586aac781367079b`; preserve its permission semantics, callback arbitration, card lifecycle, and configuration shape.
- Read only the merged default setting `settings.merged.general.language`; do not call `/daemon/session/:sessionId/language` and do not write settings.
- Support exactly two rendered locales: Chinese when the normalized setting is `zh`, starts with `zh-`, or is `Chinese`/`中文`; English otherwise, including missing, `auto`, and unsupported values.
- Treat the locale as a startup snapshot. A settings change takes effect after the existing Channel reload or process restart.
- Do not initialize or depend on CLI global i18n state. Do not add locale files, a generic translator, a new configuration field, or localization for unrelated Channel messages.
- Preserve dynamic tool titles and unrecognized daemon-provided decision labels verbatim; translate only known stock permission copy.
- Keep protocol values such as `card_status: 'approved'` unchanged; only user-visible strings are localized.
- Fix the current exact-descriptor test failure caused by the already-added `permissionCard` management field.

---

### Task 1: Resolve and pass the default Channel locale

**Files:**

- Modify: `packages/channels/base/src/ChannelBase.ts:223-250, 998-1025`
- Modify: `packages/cli/src/commands/channel/runtime.ts:1-25, 162-173`
- Modify: `packages/cli/src/commands/channel/start.ts:313-380, 447-515, 597-617`
- Modify: `packages/cli/src/commands/channel/daemon-worker.ts:486-505, 619-650`
- Test: `packages/cli/src/commands/channel/runtime.test.ts`
- Test: `packages/cli/src/commands/channel/start.test.ts`
- Test: `packages/cli/src/commands/channel/daemon-worker.test.ts`

**Interfaces:**

- Consumes: `settings.merged.general?.language`, already loaded by standalone Channel startup and the daemon worker.
- Produces: `ChannelBaseOptions.locale?: 'en' | 'zh'` and `resolveChannelLocale(value: unknown): 'en' | 'zh'`.

- [ ] **Step 1: Add failing resolver tests**

Add focused cases to `runtime.test.ts`:

```ts
expect(resolveChannelLocale('zh')).toBe('zh');
expect(resolveChannelLocale('zh-CN')).toBe('zh');
expect(resolveChannelLocale('Chinese')).toBe('zh');
expect(resolveChannelLocale('中文')).toBe('zh');
expect(resolveChannelLocale('en')).toBe('en');
expect(resolveChannelLocale('auto')).toBe('en');
expect(resolveChannelLocale('ja')).toBe('en');
expect(resolveChannelLocale(undefined)).toBe('en');
```

- [ ] **Step 2: Run the resolver tests and verify RED**

Run: `cd packages/cli && npx vitest run src/commands/channel/runtime.test.ts -t 'channel locale'`

Expected: FAIL because `resolveChannelLocale` is not exported.

- [ ] **Step 3: Add the narrow runtime option and pure resolver**

Add this optional field to `ChannelBaseOptions`:

```ts
/** UI locale snapshot resolved from the default Qwen language setting. */
locale?: 'en' | 'zh';
```

Add a pure helper to `runtime.ts`:

```ts
export function resolveChannelLocale(value: unknown): 'en' | 'zh' {
  if (typeof value !== 'string') return 'en';
  const normalized = value.trim().toLowerCase().replaceAll('_', '-');
  return normalized === 'zh' ||
    normalized.startsWith('zh-') ||
    normalized === 'chinese' ||
    normalized === '中文'
    ? 'zh'
    : 'en';
}
```

Do not read files or environment variables in this helper.

- [ ] **Step 4: Add failing standalone and daemon propagation tests**

In `start.test.ts`, return `general.language: 'zh'` from `mockLoadSettings` and assert every created Channel receives:

```ts
expect(mockCreateChannel.mock.calls[0]?.[3]).toMatchObject({ locale: 'zh' });
```

Cover both the named single-Channel handler and the all-Channels handler. In `daemon-worker.test.ts`, set the worker's loaded setting to `zh` and assert the same option on its `createChannel` call.

- [ ] **Step 5: Pass one resolved snapshot through all three creation paths**

Resolve the locale immediately after each existing `loadSettings()` call. Pass it into `startSingle`/`startAll`, then include `locale` in their `createChannel` options. In `runChannelDaemonWorker`, include the same resolved value in the worker's `createChannel` options.

Do not add locale to persisted Channel configuration and do not make DingTalk read `settings.json` itself.

- [ ] **Step 6: Run all locale propagation tests**

Run: `cd packages/cli && npx vitest run src/commands/channel/runtime.test.ts src/commands/channel/start.test.ts src/commands/channel/daemon-worker.test.ts`

Expected: all three test files pass.

### Task 2: Localize only the shared permission presentation and its fallback

**Files:**

- Modify: `packages/channels/base/src/ChannelBase.ts:223-250, 702-850, 998-1025, 2871-2890, 2932-2940`
- Test: `packages/channels/base/src/ChannelBase.test.ts:1824-1950`

**Interfaces:**

- Consumes: `ChannelBaseOptions.locale` from Task 1 and the existing permission option IDs/names.
- Produces: localized `ChannelPermissionRequestContext.decisions` and localized output from `formatPermissionRequest()`.

- [ ] **Step 1: Add failing Chinese presentation tests**

Construct the existing test Channel with `{ locale: 'zh' }`. Assert the structured context contains Chinese stock labels:

```ts
expect(context.decisions).toEqual([
  { kind: 'allow_once', label: '仅允许本次' },
  { kind: 'allow_always', label: '始终允许此项目' },
  { kind: 'deny', label: '拒绝' },
]);
```

Add a Chinese unsupported-presentation case and assert its text fallback contains all of:

```ts
expect(channel.sent.at(-1)?.text).toContain('运行工具需要授权');
expect(channel.sent.at(-1)?.text).toContain('操作：');
expect(channel.sent.at(-1)?.text).toContain('/approve        仅允许本次');
expect(channel.sent.at(-1)?.text).toContain('/deny           拒绝');
```

Retain the existing English assertions to prove omission of `locale` is backward compatible.

- [ ] **Step 2: Run the focused ChannelBase tests and verify RED**

Run: `cd packages/channels/base && npx vitest run src/ChannelBase.test.ts -t 'permission presentation|text fallback'`

Expected: the new Chinese assertions fail while existing English cases pass.

- [ ] **Step 3: Add a two-entry permission-copy constant and store the locale**

Store `options?.locale ?? 'en'` once on `ChannelBase`. Add one local constant containing only the strings used by `permissionPresentationDecisions()`, `approvalAlwaysLabel()`, and `formatPermissionRequest()`:

```ts
const PERMISSION_COPY = {
  en: {
    toolUse: 'Tool use',
    allowOnce: 'Allow once',
    allowAlwaysProject: 'always allow for this project',
    allowAlwaysUser: 'always allow for this user',
    allowAlways: 'always allow',
    deny: 'Deny',
    required: 'Permission required to run a tool',
    command: 'Command:',
    replyWith: 'Reply with:',
  },
  zh: {
    toolUse: '工具调用',
    allowOnce: '仅允许本次',
    allowAlwaysProject: '始终允许此项目',
    allowAlwaysUser: '始终允许此用户',
    allowAlways: '始终允许',
    deny: '拒绝',
    required: '运行工具需要授权',
    command: '操作：',
    replyWith: '回复以下命令：',
  },
} as const;
```

- [ ] **Step 4: Apply copy without changing permission semantics**

Use the selected copy for stock labels and fallback headings. Preserve the original option IDs and response closures. Preserve an unrecognized non-empty `allow_once` name rather than guessing a translation; translate the known stock names `Allow` and `Allow once`, plus the fallback used when the name is absent.

Keep slash commands unchanged. Only their descriptions change by locale.

- [ ] **Step 5: Run the complete ChannelBase test file**

Run: `cd packages/channels/base && npx vitest run src/ChannelBase.test.ts`

Expected: every existing permission race/settlement test and both locale cases pass.

### Task 3: Localize the DingTalk card copy reached by the current PR

**Files:**

- Modify: `packages/channels/dingtalk/src/permission-card-controller.ts:34-47, 242-277, 313-338`
- Modify: `packages/channels/dingtalk/src/DingtalkAdapter.ts:732-843, 1353-1381`
- Test: `packages/channels/dingtalk/src/permission-card-controller.test.ts`
- Test: `packages/channels/dingtalk/src/DingtalkAdapter.test.ts`

**Interfaces:**

- Consumes: `ChannelBaseOptions.locale` and localized decision labels from Task 2.
- Produces: localized DingTalk card chrome, terminal user-visible copy, and owner-only interaction feedback.

- [ ] **Step 1: Add failing Chinese card tests**

Extend the controller harness to accept `locale: 'en' | 'zh' = 'en'`. For `zh`, assert initial card data contains:

```ts
expect.objectContaining({
  question_title: '需要授权',
  form_btn_text: '提交',
  form: {
    fields: [expect.objectContaining({ label: '请选择后续操作' })],
  },
});
```

Assert the four terminal projections use Chinese descriptions/buttons while retaining these protocol states unchanged: `approved`, `denied`, `expired`, and `cancelled`.

- [ ] **Step 2: Run the controller tests and verify RED**

Run: `cd packages/channels/dingtalk && npx vitest run src/permission-card-controller.test.ts -t 'Chinese|terminal'`

Expected: the new Chinese assertions fail.

- [ ] **Step 3: Add a local two-entry card-copy constant**

Add `locale?: 'en' | 'zh'` to `PermissionCardControllerOptions`, default it to English, and select from this local copy:

```ts
const PERMISSION_CARD_COPY = {
  en: {
    required: 'Permission required',
    submit: 'Submit',
    choose: 'Choose how to continue',
    approved: ['Permission approved.', 'Approved'],
    denied: ['Permission denied.', 'Denied'],
    expired: ['This permission request is no longer available.', 'Expired'],
    cancelled: ['Permission request cancelled.', 'Cancelled'],
  },
  zh: {
    required: '需要授权',
    submit: '提交',
    choose: '请选择后续操作',
    approved: ['已授权。', '已授权'],
    denied: ['已拒绝授权。', '已拒绝'],
    expired: ['此授权请求已失效。', '已失效'],
    cancelled: ['授权请求已取消。', '已取消'],
  },
} as const;
```

Pass `options?.locale` from `DingtalkChannel` when constructing the permission controller.

- [ ] **Step 4: Cover and localize the existing owner-only feedback**

Add adapter tests showing `{ locale: 'en' }` sends the existing card-owner rejection in English and `{ locale: 'zh' }` preserves the current Chinese copy. Select only these four existing strings by locale:

```ts
const english = {
  title: 'Card interaction',
  group:
    'Only the task initiator can operate this card. This action had no effect.',
  direct:
    'You cannot operate this card. Only the task initiator can submit or stop it.',
};
```

Do not localize other DingTalk status/question-card text in this change.

- [ ] **Step 5: Run affected DingTalk tests**

Run: `cd packages/channels/dingtalk && npx vitest run src/permission-card-controller.test.ts src/interaction-presenter.test.ts src/DingtalkAdapter.test.ts`

Expected: all affected tests pass and existing English snapshots remain unchanged.

### Task 4: Reconcile the current PR, documentation, and verification

**Files:**

- Modify: `packages/cli/src/serve/routes/workspace-channel-management.test.ts:181-217`
- Modify: `docs/design/2026-08-29-dingtalk-permission-cards.md`
- Add: `docs/plans/2026-08-31-dingtalk-permission-card-language.md`

**Interfaces:**

- Consumes: the already-added `interactiveCards.permissionCard` descriptor and the completed locale behavior.
- Produces: green focused CI coverage and reviewer-facing documentation that matches the implementation.

- [ ] **Step 1: Fix the known exact management-descriptor expectation**

Add the existing `permissionCard` descriptor beside `questionCard` in the expected `interactiveCards.properties` array:

```ts
{
  key: 'permissionCard',
  label: 'Permission Card',
  kind: 'object',
  properties: [
    { key: 'enabled', label: 'Enabled', kind: 'boolean' },
    {
      key: 'timeoutMs',
      label: 'Timeout (ms)',
      kind: 'number',
      exclusiveMinimum: 0,
    },
  ],
},
```

Run: `cd packages/cli && npx vitest run src/serve/routes/workspace-channel-management.test.ts`

Expected: the currently failing exact-descriptor test passes.

- [ ] **Step 2: Update the existing design, without adding a second design document**

Add a short “Language behavior” subsection stating:

- the source is merged `general.language` at Channel startup;
- Chinese is used for `zh*`, English otherwise;
- card and immediate text fallback use the same snapshot;
- runtime language switching and non-permission Channel localization remain non-goals;
- no daemon session-language endpoint is used.

Adjust the existing “No daemon changes” wording to the more precise “No daemon route, session-language, ACP, permission-policy, provider, or core changes”; the existing daemon worker only forwards the startup snapshot.

- [ ] **Step 3: Run focused verification**

Run:

```bash
cd packages/cli && npx vitest run \
  src/commands/channel/runtime.test.ts \
  src/commands/channel/start.test.ts \
  src/commands/channel/daemon-worker.test.ts \
  src/serve/routes/workspace-channel-management.test.ts
cd ../channels/base && npx vitest run src/ChannelBase.test.ts
cd ../dingtalk && npx vitest run \
  src/permission-card-controller.test.ts \
  src/question-card-controller.test.ts \
  src/interaction-presenter.test.ts \
  src/interactive-card-types.test.ts \
  src/DingtalkAdapter.test.ts
```

Expected: every command exits zero.

- [ ] **Step 4: Run repository checks required for the changed package boundary**

From repository root run: `npm run build && npm run typecheck && git diff --check`

Expected: build and typecheck exit zero; `git diff --check` prints nothing.

- [ ] **Step 5: Perform the repository-required self-audit**

Read `git status --short` and the complete `git diff origin/main...HEAD`, including this follow-up. Verify two consecutive clean passes. Any correction resets the clean-pass count and reruns the affected tests.

- [ ] **Step 6: Prepare one follow-up commit only after explicit approval**

Stage only the files named in this plan and use one scoped commit:

```text
fix(dingtalk): localize permission cards from default language
```

Do not push or update Draft PR #10457 until separately authorized.
