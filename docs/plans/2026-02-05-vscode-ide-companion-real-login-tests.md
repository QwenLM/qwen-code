# VSCode IDE Companion Real Login Tests Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make VSCode IDE Companion integration/e2e tests verify real agent login and actual webview message sending, and fail fast if the bundled CLI or auth env is missing.

**Architecture:** Add test-only hooks in the extension/webview to record messages and expose agent/auth state, gate them by environment. Update integration test runner to require bundled CLI + auth env and surface failures, then extend e2e-vscode to validate login and message sending via those hooks.

**Tech Stack:** VSCode extension (TypeScript), @vscode/test-electron integration tests, Playwright e2e, Qwen CLI (OpenAI-compatible auth).

### Task 1: Add extension test hooks for agent/auth + webview message visibility

**Files:**

- Modify: `packages/vscode-ide-companion/src/webview/WebViewProvider.ts`
- Modify: `packages/vscode-ide-companion/src/extension.ts`
- Test: `packages/vscode-ide-companion/test/suite/extension.test.cjs`

**Step 1: Write failing test (agent/login expected)**

```js
// extension.test.cjs
async function waitForAgentConnected() {
  /* poll extension test API */
}
await runTest('agent connects and login succeeds', testAgentLoginSuccess);
```

Expected to fail now because there is no test API and agentConnected/authState isn’t asserted.

**Step 2: Run test to verify it fails**

Run: `npm -w packages/vscode-ide-companion run test:integration`
Expected: FAIL with “missing test API” or timeout waiting for agentConnected/authState.

**Step 3: Implement minimal test hooks**

- In `WebViewProvider.ts`, store last incoming/outgoing webview messages and expose getters:
  - `getLastWebviewMessageForTest()`
  - `getLastMessageToWebviewForTest()`
  - `getAuthStateForTest()`
  - `getAgentConnectionStateForTest()` (agentInitialized/currentSessionId/isConnected)
- In `extension.ts`, return a test API when `process.env.QWEN_CODE_TEST === '1'`:
  - `getWebviewProviders()`
  - `getLastWebviewProvider()`

**Step 4: Update integration test to use test API**

```js
const api = extension.exports;
const provider = api.getLastWebviewProvider();
await waitFor(() => provider?.getAuthStateForTest() === true);
```

**Step 5: Run test to verify it passes**

Run: `npm -w packages/vscode-ide-companion run test:integration`
Expected: PASS with agentConnected/authState true.

**Step 6: Commit**

```bash
git add packages/vscode-ide-companion/src/webview/WebViewProvider.ts \
        packages/vscode-ide-companion/src/extension.ts \
        packages/vscode-ide-companion/test/suite/extension.test.cjs
git commit -m "test: expose extension test hooks for agent auth"
```

### Task 2: Fail fast if CLI bundle/auth env missing for integration tests

**Files:**

- Modify: `packages/vscode-ide-companion/test/runTest.cjs`

**Step 1: Write failing test**

Add a preflight guard that throws when `dist/qwen-cli/cli.js` is missing or when required auth env isn’t set (`OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL` or `QWEN_OAUTH`).

**Step 2: Run test to verify it fails**

Run: `npm -w packages/vscode-ide-companion run test:integration`
Expected: FAIL with clear message if env/CLI missing.

**Step 3: Implement preflight + test env**

- Check bundled CLI path exists; if not, throw with instructions (`npm run prepackage`).
- Require real auth env; throw with message if missing.
- Pass `extensionTestsEnv` including auth env + `QWEN_CODE_TEST=1` into `runTests()`.

**Step 4: Run test to verify it passes**

Run: `npm -w packages/vscode-ide-companion run test:integration`
Expected: PASS when CLI bundled + auth env present.

**Step 5: Commit**

```bash
git add packages/vscode-ide-companion/test/runTest.cjs
git commit -m "test: require CLI bundle and auth env for integration"
```

### Task 3: Record webview message traffic for Playwright assertions

**Files:**

- Modify: `packages/vscode-ide-companion/src/webview/hooks/useVSCode.ts`
- Modify: `packages/vscode-ide-companion/src/webview/hooks/useWebViewMessages.ts`

**Step 1: Write failing test**

Update e2e-vscode tests to expect `window.__qwenPostedMessages` / `window.__qwenReceivedMessages` to be populated.

**Step 2: Run test to verify it fails**

Run: `npm -w packages/vscode-ide-companion run test:e2e:vscode`
Expected: FAIL because arrays don’t exist.

**Step 3: Implement message recording (test-only when arrays exist)**

- In `useVSCode.postMessage`, if `window.__qwenPostedMessages` is an array, push each outgoing message.
- In `useWebViewMessages` listener, if `window.__qwenReceivedMessages` is an array, push each incoming message.

**Step 4: Run test to verify it passes**

Run: `npm -w packages/vscode-ide-companion run test:e2e:vscode`
Expected: PASS; arrays contain messages.

**Step 5: Commit**

```bash
git add packages/vscode-ide-companion/src/webview/hooks/useVSCode.ts \
        packages/vscode-ide-companion/src/webview/hooks/useWebViewMessages.ts
git commit -m "test: record webview message traffic for e2e"
```

### Task 4: E2E VSCode tests: verify real login + message send

**Files:**

- Modify: `packages/vscode-ide-companion/e2e-vscode/fixtures/vscode-fixture.ts`
- Modify: `packages/vscode-ide-companion/e2e-vscode/tests/open-chat.spec.ts`
- Modify: `packages/vscode-ide-companion/e2e-vscode/tests/permission-drawer.spec.ts` (if needed)

**Step 1: Write failing test**

In `open-chat.spec.ts`, remove manual `authState` dispatch and wait for real `agentConnected`/`authState true` in `__qwenReceivedMessages`. Add a send-message assertion that `__qwenPostedMessages` contains `sendMessage`.

**Step 2: Run test to verify it fails**

Run: `npm -w packages/vscode-ide-companion run test:e2e:vscode`
Expected: FAIL until auth/env and message hooks are in place.

**Step 3: Implement real-login env plumbing**

- In `vscode-fixture.ts`, assert required auth env exists, and pass them into `_electron.launch({ env: ... })`.
- Add early error if bundled CLI is missing (`dist/qwen-cli/cli.js`).

**Step 4: Implement assertions in tests**

```ts
await webview.evaluate(() => {
  window.__qwenPostedMessages = [];
  window.__qwenReceivedMessages = [];
});
await webview.waitForFunction(() =>
  window.__qwenReceivedMessages?.some(
    (m) =>
      m?.type === 'agentConnected' ||
      (m?.type === 'authState' && m?.data?.authenticated === true),
  ),
);
await input.fill('Hello');
await input.press('Enter');
await webview.waitForFunction(() =>
  window.__qwenPostedMessages?.some((m) => m?.type === 'sendMessage'),
);
```

**Step 5: Run test to verify it passes**

Run: `npm -w packages/vscode-ide-companion run test:e2e:vscode`
Expected: PASS with real auth + sendMessage recorded.

**Step 6: Commit**

```bash
git add packages/vscode-ide-companion/e2e-vscode/fixtures/vscode-fixture.ts \
        packages/vscode-ide-companion/e2e-vscode/tests/open-chat.spec.ts \
        packages/vscode-ide-companion/e2e-vscode/tests/permission-drawer.spec.ts
git commit -m "test: e2e-vscode real login and send message"
```

### Task 5: CI env wiring for real login (workflow)

**Files:**

- Modify: `.github/workflows/vscode-extension-test.yml`

**Step 1: Update workflow env**

Add `OPENAI_API_KEY`, `OPENAI_BASE_URL`, and `OPENAI_MODEL` (or equivalent secrets) to integration/e2e jobs so auth can succeed.

**Step 2: Run targeted CI simulation (optional)**

Run: `npm -w packages/vscode-ide-companion run test:integration`
Expected: PASS with env present.

**Step 3: Commit**

```bash
git add .github/workflows/vscode-extension-test.yml
git commit -m "ci: provide auth env for vscode extension tests"
```
