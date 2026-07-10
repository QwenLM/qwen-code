# DingTalk SDK Keepalive PR1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable the DingTalk Stream SDK keepalive by default so failed WebSocket ping/pong liveness causes the SDK's existing reconnect path to run.

**Architecture:** Keep the change inside the DingTalk adapter's existing `DWClient` construction. Extend the collocated adapter test mock to retain constructor options, then assert the adapter supplies `keepAlive: true`. No settings field, watchdog, or retry policy is introduced in this PR.

**Tech Stack:** TypeScript, Vitest, `dingtalk-stream-sdk-nodejs`.

## Global Constraints

- Change only the DingTalk adapter and its collocated unit test.
- Do not modify settings schemas or other channel adapters.
- Preserve the SDK's default `autoReconnect` behavior.
- Run focused tests from `packages/channels/dingtalk`, then `npm run build && npm run typecheck` from the worktree root.

---

### Task 1: Enable and verify DingTalk SDK keepalive

**Files:**

- Modify: `packages/channels/dingtalk/src/DingtalkAdapter.test.ts:18-41`
- Modify: `packages/channels/dingtalk/src/DingtalkAdapter.test.ts` near `createChannel`
- Modify: `packages/channels/dingtalk/src/DingtalkAdapter.ts:142-148`

**Interfaces:**

- Consumes: `DWClient` options accepted by `dingtalk-stream-sdk-nodejs`.
- Produces: Every constructed `DingtalkChannel` creates its `DWClient` with `{ clientId, clientSecret, keepAlive: true }`.

- [ ] **Step 1: Write the failing test**

Extend the mocked `DWClient` to retain its constructor options, then add this focused behavior test:

```ts
it('enables SDK keepalive for Stream connections', () => {
  createChannel();

  expect(latestMockClient().options).toEqual(
    expect.objectContaining({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      keepAlive: true,
    }),
  );
});
```

The mock constructor should store its input as `options` before pushing itself to `dingtalkSdkMock.instances`:

```ts
constructor(readonly options: Record<string, unknown>) {
  dingtalkSdkMock.instances.push(this);
}
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```bash
cd packages/channels/dingtalk && npx vitest run src/DingtalkAdapter.test.ts
```

Expected: the new test fails because `keepAlive` is absent from the client options; existing tests continue to execute.

- [ ] **Step 3: Write the minimal implementation**

Add the one required client option to the existing adapter construction:

```ts
this.client = new DWClient({
  clientId: config.clientId,
  clientSecret: config.clientSecret,
  keepAlive: true,
});
```

- [ ] **Step 4: Run the focused test to verify it passes**

Run:

```bash
cd packages/channels/dingtalk && npx vitest run src/DingtalkAdapter.test.ts
```

Expected: all DingTalk adapter tests pass, including the keepalive assertion.

- [ ] **Step 5: Run repository verification**

Run:

```bash
npm run build && npm run typecheck
```

Expected: both commands exit successfully.

- [ ] **Step 6: Commit the implementation**

```bash
git add packages/channels/dingtalk/src/DingtalkAdapter.ts packages/channels/dingtalk/src/DingtalkAdapter.test.ts
git commit -m "fix(channels): enable DingTalk stream keepalive"
```
