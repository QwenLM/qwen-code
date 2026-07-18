# Web Shell Scheduled Delivery Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Web Shell users create and edit scheduled tasks that deliver to a recently observed direct chat, group, or group topic.

**Architecture:** The WebUI workspace action reads the existing authenticated, workspace-scoped observed-contact graph. A pure Web Shell helper flattens that graph into stable delivery options. `ScheduledTasksDialog` uses those options in an optional searchable input/list picker and submits the existing `delivery` contract; the daemon remains the authoritative admission boundary.

**Tech Stack:** TypeScript, React, Web Shell CSS Modules, Vitest, daemon REST v1.

## Global Constraints

- Support direct chats, groups, and group topics from the fresh observed-contact graph.
- Allow searching, selecting, and pasting an exact observed ID; reject unmatched arbitrary IDs.
- Never copy Channel credentials into browser state or scheduled-task payloads.
- Query only the selected workspace and never fall back from a qualified workspace to primary.
- Hide the picker unless both `scheduled_task_channel_delivery` and `workspace_channel_observed_contacts` are advertised.
- Preserve an unchanged saved target even when it is no longer freshly observed.
- Use the existing zero-or-one `delivery` contract; no multi-target delivery.

---

### Task 1: Workspace observed-contact action

**Files:**

- Modify: `packages/webui/src/daemon/workspace/types.ts`
- Modify: `packages/webui/src/daemon/workspace/actions.ts`
- Test: `packages/webui/src/daemon/workspace/scheduledTasks.actions.test.ts`

**Interfaces:**

- Produces: `DaemonObservedChannelContacts` wire types.
- Produces: `WorkspaceActions.listObservedChannelContacts(workspaceId?: string): Promise<DaemonObservedChannelContacts>`.

- [ ] **Step 1: Write failing primary and qualified route tests**

```ts
it('lists primary observed Channel contacts', async () => {
  fetchMock.mockResolvedValue(ok({ users: [], groups: [] }));
  await makeActions('tok').listObservedChannelContacts();
  expect(fetchMock.mock.calls[0][0]).toBe(
    '/workspace/channel/observed-contacts',
  );
});

it('lists observed contacts for the selected workspace only', async () => {
  fetchMock.mockResolvedValue(ok({ users: [], groups: [] }));
  await makeActions('tok').listObservedChannelContacts('ws-2');
  expect(fetchMock.mock.calls[0][0]).toBe(
    '/workspaces/ws-2/channel/observed-contacts',
  );
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `cd packages/webui && npx vitest run src/daemon/workspace/scheduledTasks.actions.test.ts`

Expected: FAIL because `listObservedChannelContacts` does not exist.

- [ ] **Step 3: Add exact wire types and the GET action**

```ts
export interface DaemonObservedChannelUser {
  channelName: string;
  id: string;
  label: string;
  chatId?: string;
  lastObservedAt: string;
}

export interface DaemonObservedChannelTopic {
  id: string;
  label: string;
  lastObservedAt: string;
  users: Array<{ id: string; label: string; lastObservedAt: string }>;
}

export interface DaemonObservedChannelGroup {
  channelName: string;
  id: string;
  label: string;
  lastObservedAt: string;
  users: Array<{ id: string; label: string; lastObservedAt: string }>;
  topics: DaemonObservedChannelTopic[];
}

export interface DaemonObservedChannelContacts {
  users: DaemonObservedChannelUser[];
  groups: DaemonObservedChannelGroup[];
}
```

The action must use `/workspace/channel/observed-contacts` for primary and `/workspaces/${encodeURIComponent(workspaceId)}/channel/observed-contacts` for a selected workspace, with the existing daemon auth headers and error reader.

- [ ] **Step 4: Run the action tests and verify GREEN**

Run: `cd packages/webui && npx vitest run src/daemon/workspace/scheduledTasks.actions.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/webui/src/daemon/workspace/types.ts packages/webui/src/daemon/workspace/actions.ts packages/webui/src/daemon/workspace/scheduledTasks.actions.test.ts
git commit -m "feat(webui): read observed channel delivery targets"
```

### Task 2: Pure delivery-option mapping

**Files:**

- Create: `packages/web-shell/client/components/dialogs/scheduledTaskDeliveryTargets.ts`
- Test: `packages/web-shell/client/components/dialogs/scheduledTaskDeliveryTargets.test.ts`

**Interfaces:**

- Consumes: `DaemonObservedChannelContacts` and `DaemonScheduledTaskChannelTarget`.
- Produces: `ScheduledTaskDeliveryOption` with `kind`, `label`, `inputValue`, `searchText`, and `target`.
- Produces: `flattenScheduledTaskDeliveryTargets`, `deliveryTargetKey`, `deliveryTargetsEqual`, and `resolveScheduledTaskDeliveryInput`.

- [ ] **Step 1: Write failing mapping tests**

Cover these exact cases:

```ts
expect(
  flattenScheduledTaskDeliveryTargets(graph).map((item) => item.kind),
).toEqual(['direct', 'group', 'topic']);
expect(options[0]!.target).toEqual({
  channelName: 'dingtalk',
  chatId: 'staff-1',
  isGroup: false,
});
expect(options[1]!.target).toEqual({
  channelName: 'dingtalk',
  chatId: 'group-1',
  isGroup: true,
});
expect(options[2]!.target).toEqual({
  channelName: 'dingtalk',
  chatId: 'group-1',
  threadId: 'topic-1',
  isGroup: true,
});
expect(resolveScheduledTaskDeliveryInput('topic-1', options)).toBe(options[2]);
expect(resolveScheduledTaskDeliveryInput('unknown', options)).toBeNull();
```

Also verify direct users without `chatId` are omitted and target keys cannot collide when IDs contain punctuation.

- [ ] **Step 2: Run the helper tests and verify RED**

Run: `cd packages/web-shell && npx vitest run client/components/dialogs/scheduledTaskDeliveryTargets.test.ts`

Expected: FAIL because the helper module does not exist.

- [ ] **Step 3: Implement the minimal pure mapper**

Use a JSON tuple for stable identity:

```ts
export function deliveryTargetKey(target: DaemonScheduledTaskChannelTarget) {
  return JSON.stringify([
    target.channelName,
    target.chatId,
    target.threadId ?? null,
    target.isGroup === true,
  ]);
}
```

Resolution must accept an option's formatted input value or an exact `chatId`/`threadId`. If an exact ID matches more than one option, return `null` and require the user to choose the fully formatted option.

- [ ] **Step 4: Run the helper tests and verify GREEN**

Run: `cd packages/web-shell && npx vitest run client/components/dialogs/scheduledTaskDeliveryTargets.test.ts`

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/web-shell/client/components/dialogs/scheduledTaskDeliveryTargets.ts packages/web-shell/client/components/dialogs/scheduledTaskDeliveryTargets.test.ts
git commit -m "feat(web-shell): map observed delivery destinations"
```

### Task 3: Scheduled Tasks destination UI

**Files:**

- Modify: `packages/web-shell/client/components/dialogs/ScheduledTasksDialog.tsx`
- Modify: `packages/web-shell/client/components/dialogs/ScheduledTasksDialog.module.css`
- Modify: `packages/web-shell/client/components/dialogs/ScheduledTasksDialog.test.tsx`
- Modify: `packages/web-shell/client/App.tsx`
- Modify: `packages/web-shell/client/i18n.tsx`

**Interfaces:**

- Consumes: Task 1 action and Task 2 option helpers.
- Adds: `channelDeliveryEnabled?: boolean` to `ScheduledTasksDialogProps`.
- Produces: optional create/update `delivery` payloads using the existing daemon contract.

- [ ] **Step 1: Write failing dialog tests**

Tests must verify:

1. the picker is absent when `channelDeliveryEnabled` is false;
2. opening create loads contacts for the form workspace;
3. direct/group/topic options render in a searchable input plus list;
4. selecting a group sends `delivery.kind = 'channel'` on create;
5. pasting an exact observed direct `chatId` resolves and submits;
6. unmatched text blocks submit with a localized error;
7. editing an unchanged stale target omits `delivery` from PATCH;
8. clearing an existing target sends `delivery: null`;
9. changing the workspace reloads contacts through that workspace's qualified action only.

Use a fixture with all three target kinds and assert the exact request body rather than component state.

- [ ] **Step 2: Run the dialog tests and verify RED**

Run: `cd packages/web-shell && npx vitest run client/components/dialogs/ScheduledTasksDialog.test.tsx`

Expected: the new picker tests fail because no UI or contact action is called.

- [ ] **Step 3: Implement form state and capability gating**

Pass the gate from `App.tsx`:

```tsx
channelDeliveryEnabled={
  connection.capabilities?.features.includes(
    'scheduled_task_channel_delivery',
  ) === true &&
  connection.capabilities?.features.includes(
    'workspace_channel_observed_contacts',
  ) === true
}
```

The dialog keeps `deliveryInput`, `initialDelivery`, contact loading/error state, and the options for the current `formWorkspaceId`. Reset all destination state on close. On edit, initialize from `task.delivery?.target` and preserve it unchanged even when absent from the fresh graph.

- [ ] **Step 4: Add the searchable input/list and submit rules**

Use an `<input list="scheduled-task-delivery-targets">` plus `<datalist>` so the user can type, paste, or select without a new portal implementation. On submit:

```ts
const selected = resolveScheduledTaskDeliveryInput(deliveryInput, options);
if (deliveryInput.trim() && !selected && !unchangedStoredTarget) {
  setFormError(t('scheduledTasks.delivery.unobserved'));
  return;
}
```

Create omits `delivery` when blank. Edit omits it when unchanged, sends `null` when cleared, and sends a new channel target when replaced. Add card metadata for stored destination kind plus resolved label when available.

- [ ] **Step 5: Add localized copy and focused CSS**

Add English and Chinese keys for destination, optional placeholder, direct/group/topic kinds, loading, empty, stale saved target, and unobserved error. Reuse existing form input/error/pill styles; add only the destination description and pill styles that are not already available.

- [ ] **Step 6: Run dialog tests and verify GREEN**

Run: `cd packages/web-shell && npx vitest run client/components/dialogs/ScheduledTasksDialog.test.tsx`

Expected: all tests pass without act warnings.

- [ ] **Step 7: Commit**

```bash
git add packages/web-shell/client/components/dialogs/ScheduledTasksDialog.tsx packages/web-shell/client/components/dialogs/ScheduledTasksDialog.module.css packages/web-shell/client/components/dialogs/ScheduledTasksDialog.test.tsx packages/web-shell/client/App.tsx packages/web-shell/client/i18n.tsx
git commit -m "feat(web-shell): select scheduled delivery destinations"
```

### Task 4: Browser and daemon E2E

**Files:**

- Modify: `.qwen/e2e-tests/scheduled-channel-delivery.md`

**Interfaces:**

- Consumes: the live daemon's observed-contact route and scheduled-task UI.
- Produces: repeatable evidence for Web Shell, IM `/loop`, and hosted/BFF entry points.

- [ ] **Step 1: Run focused verification**

```bash
cd packages/webui && npx vitest run src/daemon/workspace/scheduledTasks.actions.test.ts
cd packages/web-shell && npx vitest run client/components/dialogs/scheduledTaskDeliveryTargets.test.ts client/components/dialogs/ScheduledTasksDialog.test.tsx
npm run typecheck --workspace=packages/webui
npm run typecheck --workspace=packages/web-shell
git diff --check
```

- [ ] **Step 2: Run Web Shell E2E against the credentialed local daemon**

Open `/scheduled-tasks` with daemon auth, create a one-shot task, choose each available target kind in separate runs, and record:

- task POST response and owned session binding;
- final Outbox text/status/attempt count;
- user-visible IM receipt;
- deletion or disable cleanup.

Topic E2E is conditional on an observed topic being present; if none exists, record it as not exercised rather than synthesizing a target.

- [ ] **Step 3: Update the manual matrix and commit**

```bash
git add .qwen/e2e-tests/scheduled-channel-delivery.md
git commit -m "test(channels): record scheduled delivery client e2e"
```

- [ ] **Step 4: Final self-audit**

Read the full diff twice. Verify every new optional field has both producers and consumers, every qualified request stays workspace-scoped, and no credential or raw platform error body entered the diff.
