# Feishu Worker Credential Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Feishu WebSocket startup reject invalid credentials and wait for a real initial WebSocket handshake before a daemon-managed channel worker reports ready.

**Architecture:** Keep the fix inside the Feishu adapter. Preflight the existing tenant-token request, then adapt the Lark SDK's callback-based readiness events into a bounded promise, following the readiness pattern already shipped in the SDK's higher-level `LarkChannel` implementation.

**Tech Stack:** TypeScript, Vitest, `@larksuiteoapi/node-sdk`, Qwen Code daemon-managed channel worker.

## Global Constraints

- Branch name is `fix/feishu-worker-credential-validation`; do not use a `codex/` prefix.
- All commits use `hit_aran <hit_aran@163.com>` and Conventional Commits.
- Limit production changes to the Feishu adapter; do not patch or fork the Lark SDK.
- Preserve Feishu webhook behavior and post-ready SDK automatic reconnect behavior.
- Use the repository PR template, push the branch, include `Fixes #6779`, and post E2E evidence as a separate PR comment.

---

### Task 1: Implement the Feishu WebSocket readiness contract with TDD

**Files:**
- Modify: `packages/channels/feishu/src/FeishuAdapter.ts`
- Modify: `packages/channels/feishu/src/adapter.test.ts`
- Test: `packages/channels/feishu/src/adapter.test.ts`

**Interfaces:**
- Consumes: `FeishuChannel.connect(): Promise<void>`, `getTenantAccessToken(): Promise<string | undefined>`, and the Lark `WSClient` constructor callbacks.
- Produces: A bounded authenticated `connectWebSocket(): Promise<void>` plus regression coverage for credential preflight, `onReady` gating, `onError` propagation, and a 15-second startup timeout.

- [ ] **Step 1: Add a hoisted Lark `WSClient` test double**

Use `vi.hoisted()` because the state is consumed by `vi.mock()` at module-load time. Preserve the real SDK exports and replace only `WSClient`:

```ts
const wsMock = vi.hoisted(() => ({
  close: vi.fn(),
  options: undefined as
    | { onReady?: () => void; onError?: (error: Error) => void }
    | undefined,
  start: vi.fn<() => Promise<void>>(),
}));

vi.mock('@larksuiteoapi/node-sdk', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@larksuiteoapi/node-sdk')>();
  return {
    ...actual,
    WSClient: class {
      constructor(options: typeof wsMock.options) {
        wsMock.options = options;
      }

      start = wsMock.start;
      close = wsMock.close;
    },
  };
});
```

Reset the test double before each WebSocket-connect test and default `start()` to a resolved promise.

- [ ] **Step 2: Add the invalid-credential regression test**

Mock the tenant-token request with HTTP 401, call `connect()`, and assert:

```ts
await expect(channel.connect()).rejects.toThrow(
  'failed to authenticate Feishu credentials',
);
expect(wsMock.start).not.toHaveBeenCalled();
```

- [ ] **Step 3: Add initial WebSocket readiness tests**

Use a successful tenant-token response and verify that `connect()` remains pending until `wsMock.options?.onReady?.()` is invoked. Add a second test invoking `onError(new Error('credential rejected'))` and assert that `connect()` rejects with Feishu WebSocket context and closes the SDK client.

- [ ] **Step 4: Add the handshake-timeout test**

Use Vitest fake timers, return a successful token, leave both SDK callbacks silent, advance 15 seconds, and assert that `connect()` rejects with `WebSocket handshake did not complete within 15000ms` and closes the SDK client. Restore real timers in `finally`.

- [ ] **Step 5: Run the focused tests and verify RED**

Run from `packages/channels/feishu`:

```bash
node ../../../node_modules/vitest/vitest.mjs run src/adapter.test.ts
```

Expected: the new tests fail because the current adapter neither authenticates before constructing `WSClient` nor waits for the SDK readiness callbacks.

- [ ] **Step 6: Add the startup timeout constant**

Define the adapter-local bound next to the existing constants:

```ts
const FEISHU_WS_STARTUP_TIMEOUT_MS = 15_000;
```

- [ ] **Step 7: Require credential preflight for WebSocket mode**

Before `connectWebSocket()` is called, reuse the existing token cache path:

```ts
const token = await this.getTenantAccessToken();
if (!token) {
  throw new Error(
    `Channel "${this.name}" failed to authenticate Feishu credentials.`,
  );
}
await this.connectWebSocket();
```

Do not add this gate to webhook mode.

- [ ] **Step 8: Convert SDK callbacks into a bounded readiness promise**

Construct the SDK client with `autoReconnect: true`, `onReady`, and `onError`. Use one settle function that clears the timer. On failure, close the client, clear `this.wsClient`, and reject. Start the SDK client with `void client.start(...).catch(fail)` so synchronous or promise-level SDK errors also reject.

The timeout error text must be:

```text
Feishu WebSocket handshake did not complete within 15000ms.
```

The SDK error wrapper must begin with:

```text
Feishu WebSocket connection failed:
```

- [ ] **Step 9: Run the focused tests and verify GREEN**

Run:

```bash
node ../../../node_modules/vitest/vitest.mjs run src/adapter.test.ts
```

Expected: all Feishu adapter tests pass with no unhandled promise rejection or leaked fake timer.

- [ ] **Step 10: Run package typecheck/build verification**

Run from the repository root with the bundled Node runtime on `PATH`:

```bash
node node_modules/typescript/bin/tsc --build packages/channels/feishu --pretty false
```

Expected: exit code 0.

- [ ] **Step 11: Commit the implementation**

```bash
git add packages/channels/feishu/src/FeishuAdapter.ts packages/channels/feishu/src/adapter.test.ts
git commit -m "fix(feishu): wait for authenticated WebSocket startup"
```

### Task 2: Verify the real daemon-worker regression

**Files:**
- Create: `.qwen/e2e-tests/feishu-worker-credential-validation.md`
- Verify: `packages/cli/dist/index.js`

**Interfaces:**
- Consumes: `qwen serve --channel <name>` and `GET /daemon/status`.
- Produces: Reproduction evidence that invalid Feishu credentials prevent worker readiness and terminate startup.

- [ ] **Step 1: Build the CLI and channel packages**

Run the repository build using the available Node runtime. If the complete build fails outside the changed packages, record the exact unrelated failure and build the Feishu and CLI package outputs needed by the E2E instead.

- [ ] **Step 2: Run the isolated invalid-credential E2E**

Create temporary `QWEN_HOME`, `QWEN_RUNTIME_DIR`, and workspace directories under `/tmp`. Configure a Feishu WebSocket channel with `clientId: "cli_0000000000000000"` and `clientSecret: "definitely-not-a-feishu-secret"`. Start `qwen serve --channel bad-feishu` with fake local model configuration.

Expected evidence:

```text
[Channel] Failed to connect "bad-feishu": Channel "bad-feishu" failed to authenticate Feishu credentials.
[Channel] daemon worker failed: No channels connected.
Channel worker exited before ready (code=1, signal=null).
```

Confirm the worker never reports `"bad-feishu" connected`, never sends `ready`, and the serve process exits with code 1.

- [ ] **Step 3: Record the E2E report**

Write `.qwen/e2e-tests/feishu-worker-credential-validation.md` with the tested commit, commands, redacted configuration, timestamps, exit code, and before/after log excerpts. This path is git-ignored and must not be committed.

### Task 3: Final verification, review, and PR delivery

**Files:**
- Review: all changes from `origin/main...HEAD`, including untracked files.
- Use: `.github/pull_request_template.md`

**Interfaces:**
- Consumes: committed design, implementation, unit-test evidence, typecheck/build evidence, and E2E report.
- Produces: pushed branch and a GitHub pull request linked to #6779.

- [ ] **Step 1: Run final focused verification**

Run the full Feishu adapter test file, Feishu package build/typecheck, `git diff --check`, and the isolated daemon-worker regression. Record exact pass counts and exit codes.

- [ ] **Step 2: Perform the repository self-audit**

Read the complete diff and new files without targeting a specific suspected defect. Verify every behavioral claim and green test under the assumption it may be wrong. Continue until two consecutive passes find no issue; any fix resets the clean-pass count and reruns verification.

- [ ] **Step 3: Run code review and triage findings**

Run the available review workflow against the exact HEAD. Classify each result as valid, false positive, or overthinking. Apply valid fixes through another RED/GREEN cycle and repeat verification.

- [ ] **Step 4: Push the branch**

```bash
git push -u fork fix/feishu-worker-credential-validation
```

- [ ] **Step 5: Create the PR from the repository template**

Create the PR from `BenGuanRan:fix/feishu-worker-credential-validation` to `QwenLM/qwen-code:main`. Describe motivation and behavior in prose without naming implementation files or functions. Include reviewer behavior checks, macOS evidence, risk boundaries, a complete Chinese translation, and:

```text
Fixes #6779
```

- [ ] **Step 6: Post the separate E2E report comment**

Post the contents of `.qwen/e2e-tests/feishu-worker-credential-validation.md` as a PR comment, then verify the PR URL, head commit, linked issue text, checks state, and comment URL through `gh`.
