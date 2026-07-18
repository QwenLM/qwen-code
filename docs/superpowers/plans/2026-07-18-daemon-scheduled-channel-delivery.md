# Daemon Scheduled Channel Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a daemon-managed scheduled task optionally deliver its successful final Agent answer to one workspace-local Channel `user` or `chat` target without changing tasks that omit delivery.

**Architecture:** The scheduled task persists a typed `{ type, id }` target and a sibling `channelName`. After a successful Agent run, the session writes the final answer to a per-workspace durable outbox; the daemon dispatcher retries that payload and routes it through the exact workspace's Channel Worker, which performs a code-driven proactive send through the adapter.

**Tech Stack:** TypeScript, Node.js child-process IPC, Express REST routes, Vitest, existing Qwen Channel adapters, durable JSON files with file locks and atomic replacement.

## Global Constraints

- Rebase the feature branch onto the latest `origin/main` before implementation.
- Scheduled delivery supports exactly `user` and `chat`; topic/thread delivery is rejected.
- User mentions are not supported.
- Task execution, outbox storage, and Channel Worker routing remain workspace-local; never fall back to another workspace.
- Observed contacts are optional discovery data and are not an admission or freshness gate.
- The Agent prompt produces only the message content; destination choice and sending are code-driven.
- No Web Shell destination picker, ordinary CLI `/loop` syntax, or standalone `qwen channel start` behavior change is included.
- Tasks without `delivery` must not write an outbox record or require a Channel Worker.
- Preserve the user-owned untracked `CHANNEL_DM_POLICY_SUMMARY.md` file.
- Write each behavioral test first, run it to observe RED, then implement and run GREEN.

---

### Task 1: Rebase and establish the typed durable contract

**Files:**

- Modify: `packages/core/src/services/cronTasksFile.ts`
- Modify: `packages/core/src/services/cronTasksFile.test.ts`
- Modify: `packages/core/src/services/scheduled-delivery-outbox.ts`
- Modify: `packages/core/src/services/scheduled-delivery-outbox.test.ts`
- Modify: `packages/core/src/index.ts`

**Interfaces:**

- Produces: `CronTaskChannelTarget`, `CronTaskDelivery`, `ScheduledDeliveryRecord`, and `EnqueueScheduledDeliveryInput` used by every later task.
- Contract:

```ts
export type CronTaskChannelTarget =
  | { type: 'user'; id: string }
  | { type: 'chat'; id: string };

export interface CronTaskDelivery {
  kind: 'channel';
  channelName: string;
  target: CronTaskChannelTarget;
}
```

- [ ] **Step 1: Rebase onto latest main and confirm the user file survives**

Run:

```bash
git fetch origin main
git rebase origin/main
git status --short --branch
test -f CHANNEL_DM_POLICY_SUMMARY.md
```

Expected: rebase completes; the branch is based on `origin/main`; the only
untracked user file remains `CHANNEL_DM_POLICY_SUMMARY.md`. Resolve conflicts
without staging that file.

- [ ] **Step 2: Write failing durable-task contract tests**

Replace old `chatId/threadId/isGroup` fixtures with these accepted variants:

```ts
const userDelivery: CronTaskDelivery = {
  kind: 'channel',
  channelName: 'dingtalk',
  target: { type: 'user', id: 'staff-42' },
};
const chatDelivery: CronTaskDelivery = {
  kind: 'channel',
  channelName: 'dingtalk',
  target: { type: 'chat', id: 'cid-group-42' },
};
```

Add table cases that reject empty `channelName`, empty `id`, unknown `type`,
`threadId`, `topicId`, and the obsolete `{ chatId, isGroup }` target.

- [ ] **Step 3: Run the core task-file test and verify RED**

Run:

```bash
cd packages/core && npx vitest run src/services/cronTasksFile.test.ts
```

Expected: FAIL because the current contract stores `channelName` inside a
`chatId`-based target.

- [ ] **Step 4: Implement exact delivery validation**

Define the union above. Make `isValidDelivery()` require a non-empty sibling
`channelName` and a target with exactly one allowed `type` plus non-empty `id`:

```ts
function isValidChannelTarget(value: unknown): value is CronTaskChannelTarget {
  if (typeof value !== 'object' || value === null) return false;
  const target = value as Record<string, unknown>;
  return (
    (target['type'] === 'user' || target['type'] === 'chat') &&
    typeof target['id'] === 'string' &&
    target['id'].trim().length > 0 &&
    Object.keys(target).every((key) => key === 'type' || key === 'id')
  );
}
```

Keep absent `delivery` valid and preserve existing durable-task semantics.

- [ ] **Step 5: Run the task-file test and verify GREEN**

Run the Step 3 command. Expected: PASS.

- [ ] **Step 6: Write failing outbox tests for separated Channel and target**

Use this enqueue input in success, idempotency, claim, and retry tests:

```ts
await enqueueScheduledDelivery(workspace, {
  deliveryId: 'task-1:1000',
  taskId: 'task-1',
  firedAt: 1000,
  channelName: 'dingtalk',
  target: { type: 'chat', id: 'cid-group-42' },
  text: 'inspection result',
  createdAt: 1000,
});
```

Assert the record persists `channelName` separately and rejects the obsolete
target shape, overlong IDs, empty IDs, and malformed records.

- [ ] **Step 7: Run the outbox test and verify RED**

Run:

```bash
cd packages/core && npx vitest run src/services/scheduled-delivery-outbox.test.ts
```

Expected: FAIL because records currently embed `channelName` in the target.

- [ ] **Step 8: Implement the separated outbox record**

Use these fields in both `ScheduledDeliveryRecord` and
`EnqueueScheduledDeliveryInput`:

```ts
channelName: string;
target: CronTaskChannelTarget;
```

Bound `channelName` and `target.id` with `MAX_TARGET_FIELD_LENGTH`, validate the
two target types exactly, include `channelName` in idempotency conflict checks,
and retain the existing lock, lease, size, and atomic-write behavior.

- [ ] **Step 9: Run both focused core tests and commit**

Run:

```bash
cd packages/core && npx vitest run src/services/cronTasksFile.test.ts src/services/scheduled-delivery-outbox.test.ts
```

Expected: PASS.

Commit:

```bash
git add packages/core/src/services/cronTasksFile.ts packages/core/src/services/cronTasksFile.test.ts packages/core/src/services/scheduled-delivery-outbox.ts packages/core/src/services/scheduled-delivery-outbox.test.ts packages/core/src/index.ts
git commit -m "refactor(scheduler): type channel delivery targets"
```

### Task 2: Make REST mutation structural and remove graph admission

**Files:**

- Modify: `packages/cli/src/serve/routes/scheduled-tasks.ts`
- Modify: `packages/cli/src/serve/routes/scheduled-tasks.test.ts`
- Delete: `packages/cli/src/serve/scheduled-task-channel-admission.ts`
- Delete: `packages/cli/src/serve/scheduled-task-channel-admission.test.ts`
- Modify: `packages/cli/src/serve/server.ts`
- Modify: `packages/cli/src/serve/server.test.ts`
- Modify: `packages/cli/src/serve/capabilities.ts`
- Modify: `packages/cli/src/serve/run-qwen-serve.ts`

**Interfaces:**

- Consumes: Task 1 `CronTaskDelivery`.
- Produces: primary and workspace-qualified create/update routes accepting the
  same structurally validated payload without an observed-contact provider.

- [ ] **Step 1: Write failing REST tests for the final wire contract**

Create tasks through both route families with:

```ts
delivery: {
  kind: 'channel',
  channelName: 'dingtalk',
  target: { type: 'chat', id: 'cid-group-42' },
}
```

Assert HTTP 201 without injecting `admitChannelTarget`. Add PATCH coverage for
switching to `{ type: 'user', id: 'staff-42' }`, clearing with `null`, and HTTP
400 `invalid_delivery` for empty IDs, unknown types, topic/thread fields, and
the obsolete `isGroup` shape.

- [ ] **Step 2: Run route tests and verify RED**

Run:

```bash
cd packages/cli && npx vitest run src/serve/routes/scheduled-tasks.test.ts
```

Expected: FAIL with the current 501/403 admission behavior or old target parser.

- [ ] **Step 3: Replace the parser and delete admission hooks**

Make `parseDeliveryField()` return this normalized value:

```ts
{
  kind: 'channel',
  channelName: delivery['channelName'].trim(),
  target: {
    type: target['type'],
    id: target['id'].trim(),
  },
}
```

Require only `kind`, `channelName`, and `target` on delivery and only `type` and
`id` on target. Remove `AdmitScheduledTaskChannelTarget`, every
`admitChannelTarget` dependency, and all create/PATCH 501/403/503 admission
branches. Delete the admission module and its tests.

- [ ] **Step 4: Make capability reflect the installed delivery pipeline only**

Keep `scheduledTaskChannelDeliveryAvailable` as the runtime toggle, but change
capability computation to:

```ts
scheduledTaskChannelDeliveryAvailable:
  deps.scheduledTaskChannelDeliveryAvailable === true,
```

Remove `admitScheduledTaskChannelTarget` from `ServeAppDeps`, server route
registration, `loadServeRuntimeModules()`, and the real daemon dependency
object. Update server tests so the capability is advertised when the delivery
pipeline is installed regardless of observed contacts.

- [ ] **Step 5: Run REST, server, and capability tests and commit**

Run:

```bash
cd packages/cli && npx vitest run src/serve/routes/scheduled-tasks.test.ts src/serve/server.test.ts src/serve/capabilities.test.ts
```

Expected: PASS.

Commit:

```bash
git add packages/cli/src/serve/routes/scheduled-tasks.ts packages/cli/src/serve/routes/scheduled-tasks.test.ts packages/cli/src/serve/server.ts packages/cli/src/serve/server.test.ts packages/cli/src/serve/capabilities.ts packages/cli/src/serve/run-qwen-serve.ts
git add -u packages/cli/src/serve/scheduled-task-channel-admission.ts packages/cli/src/serve/scheduled-task-channel-admission.test.ts
git commit -m "refactor(daemon): accept explicit delivery targets"
```

### Task 3: Carry the typed target through proactive-delivery IPC

**Files:**

- Modify: `packages/channels/base/src/types.ts`
- Modify: `packages/channels/base/src/ChannelBase.ts`
- Modify: `packages/channels/base/src/ChannelBase.test.ts`
- Modify: `packages/channels/base/src/index.ts`
- Modify: `packages/cli/src/serve/channel-delivery-ipc.ts`
- Modify: `packages/cli/src/serve/channel-delivery-ipc.test.ts`
- Modify: `packages/cli/src/commands/channel/daemon-worker.ts`
- Modify: `packages/cli/src/commands/channel/daemon-worker.test.ts`

**Interfaces:**

- Produces:

```ts
export type ChannelProactiveTarget =
  | { channelName: string; type: 'user'; id: string }
  | { channelName: string; type: 'chat'; id: string };

export interface ChannelDeliveryRequest {
  deliveryId: string;
  channelName: string;
  target: { type: 'user' | 'chat'; id: string };
  text: string;
}
```

- [ ] **Step 1: Write failing ChannelBase tests**

Invoke:

```ts
await channel.deliverProactive(
  { channelName: 'test', type: 'chat', id: 'group-1' },
  'inspection result',
);
```

Assert the protected adapter call receives a `SessionTarget` with
`chatId/senderId = 'group-1'` and `isGroup = true`. Repeat for `type: 'user'`
with `isGroup = false`. Preserve mismatch, unsupported adapter, empty text, and
adapter rejection tests; remove thread-target coverage from this boundary.

- [ ] **Step 2: Run ChannelBase tests and verify RED**

Run:

```bash
cd packages/channels/base && npx vitest run src/ChannelBase.test.ts
```

Expected: FAIL because the current public target expects `chatId/isGroup`.

- [ ] **Step 3: Implement the typed public boundary**

In `deliverProactive()`, validate `channelName`, proactive support, and target
type, then derive the legacy adapter `SessionTarget` without exposing a public
boolean contract:

```ts
const sessionTarget: SessionTarget = {
  channelName: target.channelName,
  senderId: target.id,
  chatId: target.id,
  isGroup: target.type === 'chat',
};
```

Use existing `supportsProactiveTarget()` and `pushProactive()` hooks so
standalone Channel loops remain unchanged.

- [ ] **Step 4: Write failing IPC and worker tests**

Use requests whose target has only `type` and `id`. Assert the IPC guard rejects
empty IDs, unknown target types, `threadId`, `topicId`, `chatId`, and `isGroup`.
Assert the worker chooses `request.channelName` and calls:

```ts
channel.deliverProactive(
  { channelName: request.channelName, ...request.target },
  request.text,
);
```

- [ ] **Step 5: Run IPC and worker tests and verify RED**

Run:

```bash
cd packages/cli && npx vitest run src/serve/channel-delivery-ipc.test.ts src/commands/channel/daemon-worker.test.ts
```

Expected: FAIL on the old nested target validator and worker call.

- [ ] **Step 6: Implement IPC validation and worker composition**

Keep the existing correlation ID, expiry, queue limit, timeout, sanitized error
codes, and shutdown draining. Change only the nested target guard and the
worker-to-ChannelBase call shown in Step 4.

- [ ] **Step 7: Run all Task 3 tests and commit**

Run:

```bash
cd packages/channels/base && npx vitest run src/ChannelBase.test.ts
cd packages/cli && npx vitest run src/serve/channel-delivery-ipc.test.ts src/commands/channel/daemon-worker.test.ts
```

Expected: PASS.

Commit:

```bash
git add packages/channels/base/src/types.ts packages/channels/base/src/ChannelBase.ts packages/channels/base/src/ChannelBase.test.ts packages/channels/base/src/index.ts packages/cli/src/serve/channel-delivery-ipc.ts packages/cli/src/serve/channel-delivery-ipc.test.ts packages/cli/src/commands/channel/daemon-worker.ts packages/cli/src/commands/channel/daemon-worker.test.ts
git commit -m "refactor(channels): route typed proactive targets"
```

### Task 4: Map `user` and `chat` in every proactive adapter

**Files:**

- Modify: `packages/channels/dingtalk/src/DingtalkAdapter.ts`
- Modify: `packages/channels/dingtalk/src/DingtalkAdapter.test.ts`
- Modify: `packages/channels/feishu/src/FeishuAdapter.ts`
- Modify: `packages/channels/feishu/src/adapter.test.ts`
- Modify: `packages/channels/wecom/src/WeComAdapter.test.ts`
- Modify: `packages/channels/telegram/src/TelegramAdapter.test.ts`

**Interfaces:**

- Consumes: Task 3's derived `SessionTarget`, where `isGroup` is always a
  boolean for scheduled proactive delivery.
- Produces: verified native mapping for both supported target types.

- [ ] **Step 1: Update adapter tests first**

For DingTalk assert:

```ts
// chat
expect(body).toMatchObject({ openConversationId: 'cid-group-42' });
// user
expect(body).toMatchObject({ userIds: ['staff-42'] });
```

For Feishu assert the request URLs use
`receive_id_type=chat_id` for chat and `receive_id_type=open_id` for user, with
the same `receive_id` body field. For WeCom assert the SDK receives the target
ID for both variants. For Telegram assert `bot.api.sendMessage()` receives the
numeric/string target ID for both variants and no topic option.

- [ ] **Step 2: Run adapter tests and verify RED**

Run:

```bash
cd packages/channels/dingtalk && npx vitest run src/DingtalkAdapter.test.ts
cd packages/channels/feishu && npx vitest run src/adapter.test.ts
cd packages/channels/wecom && npx vitest run src/WeComAdapter.test.ts
cd packages/channels/telegram && npx vitest run src/TelegramAdapter.test.ts
```

Expected: DingTalk mappings may already pass after fixture conversion; Feishu
user delivery fails because proactive sends currently force `chat_id`; all
packages must still be observed before production changes.

- [ ] **Step 3: Implement only the missing native mappings**

Preserve DingTalk's existing group/direct endpoints and WeCom/Telegram's shared
send APIs. Refactor Feishu proactive send to select the receive-ID type:

```ts
const receiveIdType = target.isGroup === true ? 'chat_id' : 'open_id';
await this.sendMessageInternal(target.chatId, text, true, receiveIdType);
```

Keep ordinary Feishu replies on `chat_id`. Do not add mention markup or topic
parameters to any adapter.

- [ ] **Step 4: Run all adapter tests and commit**

Run the Step 2 commands. Expected: PASS.

Commit:

```bash
git add packages/channels/dingtalk/src/DingtalkAdapter.ts packages/channels/dingtalk/src/DingtalkAdapter.test.ts packages/channels/feishu/src/FeishuAdapter.ts packages/channels/feishu/src/adapter.test.ts packages/channels/wecom/src/WeComAdapter.test.ts packages/channels/telegram/src/TelegramAdapter.test.ts
git commit -m "feat(channels): map scheduled user and chat targets"
```

### Task 5: Enqueue and dispatch final answers without cross-workspace fallback

**Files:**

- Modify: `packages/cli/src/acp-integration/session/Session.ts`
- Modify: `packages/cli/src/acp-integration/session/Session.test.ts`
- Modify: `packages/cli/src/serve/scheduled-delivery-dispatcher.ts`
- Modify: `packages/cli/src/serve/scheduled-delivery-dispatcher.test.ts`
- Modify: `packages/cli/src/serve/channel-worker-manager.ts`
- Modify: `packages/cli/src/serve/channel-worker-manager.test.ts`
- Modify: `packages/cli/src/serve/channel-worker-group.ts`
- Modify: `packages/cli/src/serve/channel-worker-group.test.ts`
- Modify: `packages/cli/src/commands/channel/durable-loop-controller.ts`
- Modify: `packages/cli/src/commands/channel/durable-loop-controller.test.ts`
- Verify: `packages/core/src/services/cronScheduler.ts`
- Verify: `packages/core/src/services/cronScheduler.test.ts`

**Interfaces:**

- Consumes: Task 1 outbox input and Task 3 IPC request.
- Produces: durable final-answer delivery and exact workspace routing.

- [ ] **Step 1: Write failing Session and dispatcher tests**

Assert successful cron completion enqueues:

```ts
expect(enqueueScheduledDelivery).toHaveBeenCalledWith(workspace, {
  deliveryId: `${taskId}:${firedAt}`,
  taskId,
  firedAt,
  channelName: 'dingtalk',
  target: { type: 'chat', id: 'cid-group-42' },
  text: 'final answer',
});
```

Retain negative tests for no delivery, abort, Agent failure, missing identity,
and empty final answer. In dispatcher tests assert `toDeliveryRequest()` copies
`channelName` and target separately, retries transient failures, and does not
invoke any Agent/session method.

- [ ] **Step 2: Run Session and dispatcher tests and verify RED**

Run:

```bash
cd packages/cli && npx vitest run src/acp-integration/session/Session.test.ts src/serve/scheduled-delivery-dispatcher.test.ts
```

Expected: FAIL because current enqueue/request shapes embed Channel metadata in
the old target.

- [ ] **Step 3: Update Session enqueue and dispatcher request creation**

Pass `item.delivery.channelName` and `item.delivery.target` separately while
preserving the existing clean-completion condition and deduplicated
`taskId:firedAt` identity. Do not change scheduler fire/catch-up semantics.

- [ ] **Step 4: Write exact-workspace routing tests**

Create group entries where workspace A owns `dingtalk` and workspace B owns no
such Channel. Assert:

```ts
await expect(
  manager.deliverChannelMessage(WORKSPACE_B, request),
).rejects.toMatchObject({ code: 'channel_worker_unavailable' });
expect(workspaceASupervisor.deliverChannelMessage).not.toHaveBeenCalled();
```

Also retain the success case where workspace B owns the named Channel. Do not
use the workspace-omitted `routeEntry()` fallback for scheduled delivery.

- [ ] **Step 5: Run manager/group tests and verify behavior**

Run:

```bash
cd packages/cli && npx vitest run src/serve/channel-worker-manager.test.ts src/serve/channel-worker-group.test.ts
```

Expected: PASS if existing exact-workspace routing survived the contract
change; otherwise RED until the request plumbing is corrected.

- [ ] **Step 6: Convert daemon Channel `/loop` persistence to the same contract**

When the loop target is group-like, persist:

```ts
delivery: {
  kind: 'channel',
  channelName: input.channelName,
  target: { type: 'chat', id: input.target.chatId },
}
```

For direct targets persist `type: 'user'` and the stable delivery ID already
selected by `ChannelBase.loopTargetFromEnvelope()`. Update equality and
task-to-loop conversion accordingly. Do not add a target-selection argument to
`/loop` and do not change standalone `qwen channel start`.

- [ ] **Step 7: Run runtime tests and commit**

Run:

```bash
cd packages/cli && npx vitest run src/acp-integration/session/Session.test.ts src/serve/scheduled-delivery-dispatcher.test.ts src/serve/channel-worker-manager.test.ts src/serve/channel-worker-group.test.ts src/commands/channel/durable-loop-controller.test.ts
cd packages/core && npx vitest run src/services/cronScheduler.test.ts
```

Expected: PASS.

Commit:

```bash
git add packages/cli/src/acp-integration/session/Session.ts packages/cli/src/acp-integration/session/Session.test.ts packages/cli/src/serve/scheduled-delivery-dispatcher.ts packages/cli/src/serve/scheduled-delivery-dispatcher.test.ts packages/cli/src/serve/channel-worker-manager.ts packages/cli/src/serve/channel-worker-manager.test.ts packages/cli/src/serve/channel-worker-group.ts packages/cli/src/serve/channel-worker-group.test.ts packages/cli/src/commands/channel/durable-loop-controller.ts packages/cli/src/commands/channel/durable-loop-controller.test.ts packages/core/src/services/cronScheduler.ts packages/core/src/services/cronScheduler.test.ts
git commit -m "feat(daemon): dispatch scheduled final answers"
```

### Task 6: Remove deferred UI/graph work and restore the serve fast path

**Files:**

- Delete: `packages/web-shell/client/components/dialogs/scheduledTaskDeliveryTargets.ts`
- Delete: `packages/web-shell/client/components/dialogs/scheduledTaskDeliveryTargets.test.ts`
- Modify: `packages/web-shell/client/App.tsx`
- Modify: `packages/web-shell/client/components/dialogs/ScheduledTasksDialog.tsx`
- Modify: `packages/web-shell/client/components/dialogs/ScheduledTasksDialog.test.tsx`
- Modify: `packages/web-shell/client/i18n.tsx`
- Modify: `packages/webui/src/daemon-react-sdk.ts`
- Modify: `packages/webui/src/daemon/index.ts`
- Modify: `packages/webui/src/daemon/workspace/index.ts`
- Modify: `packages/webui/src/daemon/workspace/types.ts`
- Modify: `packages/webui/src/daemon/workspace/scheduledTasks.actions.test.ts`
- Modify: `packages/cli/src/commands/channel/observed-contact-store.ts`
- Modify: `packages/cli/src/commands/channel/observed-contact-store.test.ts`
- Modify: `packages/cli/src/serve/routes/workspace-channel-observed-contacts.test.ts`
- Modify: `packages/cli/src/serve/run-qwen-serve.ts`
- Delete: `docs/superpowers/plans/2026-07-18-web-shell-scheduled-delivery-picker.md`
- Delete: `docs/superpowers/plans/2026-07-18-scheduled-channel-delivery-runtime.md`
- Delete: `docs/superpowers/plans/2026-07-18-scheduled-channel-delivery-transport.md`
- Delete: `docs/design/2026-07-18-scheduled-channel-delivery.md`

**Interfaces:**

- Produces: a minimal daemon-only diff; existing mainline observed-contact APIs
  remain unchanged and unrelated CLI startup does not statically load delivery
  runtime dependencies.

- [ ] **Step 1: Remove Web Shell destination UI and draft-only SDK exports**

Delete the picker helper files. Remove only branch-added delivery picker props,
state, fetches, labels, and tests from `ScheduledTasksDialog`, `App`, i18n, and
the WebUI workspace client. Preserve every `origin/main` change in those files.
After editing, this command must produce no Web Shell/WebUI diff:

```bash
git diff --name-only origin/main...HEAD -- packages/web-shell packages/webui
```

Expected: no output.

- [ ] **Step 2: Remove graph mutations used only by the old picker/admission**

Restore `ObservedChannelContactStore` and its route tests to the current
`origin/main` behavior: do not persist a direct-chat `chatId` extension solely
for scheduled delivery. Keep #7109's workspace observed graph intact. Verify:

```bash
git diff --name-only origin/main...HEAD -- packages/cli/src/commands/channel/observed-contact-store.ts packages/cli/src/commands/channel/observed-contact-store.test.ts packages/cli/src/serve/routes/workspace-channel-observed-contacts.test.ts
```

Expected: no output.

- [ ] **Step 3: Add a fast-path regression test before changing imports**

Run the existing bundle check once and retain its failure output:

```bash
npm run check:serve-fast-path-bundle
```

Expected before the fix: FAIL naming delivery-imported runtime modules such as
glob, TOML, shell, chokidar, or fzf in the pre-listen serve bundle.

- [ ] **Step 4: Lazy-load the dispatcher at runtime startup**

Remove the static value import of `createScheduledDeliveryDispatcher`. Keep an
import-only type alias and load the factory inside `completeRuntimeStartup()`:

```ts
type ScheduledDeliveryDispatcher =
  import('./scheduled-delivery-dispatcher.js').ScheduledDeliveryDispatcher;

const { createScheduledDeliveryDispatcher } = await import(
  './scheduled-delivery-dispatcher.js'
);
scheduledDeliveryDispatcher ??= createScheduledDeliveryDispatcher({
  listWorkspaces: () =>
    registry?.list().map((runtime) => runtime.workspaceCwd) ?? [boundWorkspace],
  deliver: async (workspaceCwd, request) => {
    const manager =
      channelWorkerManager ?? (await ensureChannelWorkerManager?.());
    if (!manager) {
      throw new ChannelDeliveryError(
        'channel_worker_unavailable',
        'Channel worker manager is unavailable.',
      );
    }
    return manager.deliverChannelMessage(workspaceCwd, request);
  },
  onError: (error) => {
    daemonLog.warn('scheduled Channel delivery dispatcher error', {
      error: error instanceof Error ? error.message : String(error),
    });
  },
});
```

Do not change dispatcher startup/shutdown ordering.

- [ ] **Step 5: Run scope and fast-path checks**

Run:

```bash
npm run check:serve-fast-path-bundle
cd packages/web-shell && npx vitest run client/components/dialogs/ScheduledTasksDialog.test.tsx
cd packages/cli && npx vitest run src/commands/channel/observed-contact-store.test.ts src/serve/routes/workspace-channel-observed-contacts.test.ts src/serve/run-qwen-serve.test.ts
```

Expected: PASS; the scheduled tasks dialog retains legacy non-delivery behavior.

- [ ] **Step 6: Commit scope trimming**

```bash
git add -u packages/web-shell packages/webui packages/cli/src/commands/channel/observed-contact-store.ts packages/cli/src/commands/channel/observed-contact-store.test.ts packages/cli/src/serve/routes/workspace-channel-observed-contacts.test.ts docs/design/2026-07-18-scheduled-channel-delivery.md docs/superpowers/plans/2026-07-18-web-shell-scheduled-delivery-picker.md docs/superpowers/plans/2026-07-18-scheduled-channel-delivery-runtime.md docs/superpowers/plans/2026-07-18-scheduled-channel-delivery-transport.md
git add packages/cli/src/serve/run-qwen-serve.ts
git commit -m "refactor(daemon): narrow scheduled delivery scope"
```

### Task 7: Verify end to end and update the PR

**Files:**

- Modify: `.qwen/e2e-tests/scheduled-channel-delivery.md`
- Retain: `docs/superpowers/specs/2026-07-18-daemon-scheduled-channel-delivery-design.md`
- Retain: `docs/superpowers/plans/2026-07-18-daemon-scheduled-channel-delivery.md`

**Interfaces:**

- Produces: merge-ready evidence for the daemon-only contract and an updated
  Draft PR description.

- [ ] **Step 1: Run focused package verification**

Run:

```bash
cd packages/core && npx vitest run src/services/cronTasksFile.test.ts src/services/cronScheduler.test.ts src/services/scheduled-delivery-outbox.test.ts
cd packages/channels/base && npx vitest run src/ChannelBase.test.ts
cd packages/channels/dingtalk && npx vitest run src/DingtalkAdapter.test.ts
cd packages/channels/feishu && npx vitest run src/adapter.test.ts
cd packages/channels/wecom && npx vitest run src/WeComAdapter.test.ts
cd packages/channels/telegram && npx vitest run src/TelegramAdapter.test.ts
cd packages/cli && npx vitest run src/acp-integration/session/Session.test.ts src/commands/channel/daemon-worker.test.ts src/commands/channel/durable-loop-controller.test.ts src/serve/channel-delivery-ipc.test.ts src/serve/channel-worker-supervisor.test.ts src/serve/channel-worker-group.test.ts src/serve/channel-worker-manager.test.ts src/serve/routes/scheduled-tasks.test.ts src/serve/scheduled-delivery-dispatcher.test.ts src/serve/server.test.ts src/serve/run-qwen-serve.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run static and bundle checks**

Run:

```bash
npm run typecheck --workspace @qwen-code/qwen-code-core
npm run typecheck --workspace @qwen-code/channel-base
npm run typecheck --workspace @qwen-code/channel-dingtalk
npm run typecheck --workspace @qwen-code/channel-feishu
npm run typecheck --workspace @qwen-code/channel-wecom
npm run typecheck --workspace @qwen-code/channel-telegram
npm run typecheck --workspace @qwen-code/qwen-code
npm run check:serve-fast-path-bundle
git diff --check origin/main...HEAD
```

Expected: PASS with no whitespace errors.

- [ ] **Step 3: Run isolated real DingTalk daemon E2E**

Start a daemon with the existing local DingTalk Channel configuration, create
one immediate workspace task with a `chat` target and one with a `user` target,
then verify exactly one generated result reaches each destination. Confirm the
outbox records become `delivered`, restart around one controlled transient
failure if practical, and verify delivery retry does not execute the Agent a
second time. Never print credentials or tokens in logs or the E2E document.

- [ ] **Step 4: Record sanitized E2E evidence**

Update `.qwen/e2e-tests/scheduled-channel-delivery.md` with date, commit, daemon
mode, target types, task IDs, delivery IDs, status transitions, and redacted
platform result. Do not include group IDs, user IDs, secrets, API keys, or raw
tokens.

- [ ] **Step 5: Commit evidence and request final review**

```bash
git add .qwen/e2e-tests/scheduled-channel-delivery.md
git commit -m "test(channels): verify typed scheduled delivery"
```

Run `superpowers:requesting-code-review`, address actionable findings, then run
`superpowers:verification-before-completion` before claiming success.

- [ ] **Step 6: Push and update Draft PR #7153**

Push the rebased branch with the safest required lease protection, then update
the PR title/body to describe only: optional daemon scheduled delivery,
workspace-local routing, `user|chat` target contract, durable outbox/retry, no
graph admission, and unchanged behavior without delivery. Remove Web Shell,
topic, mention, and ordinary CLI claims from the PR text.
