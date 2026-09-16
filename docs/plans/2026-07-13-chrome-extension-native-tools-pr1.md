# Chrome Extension Native Browser Tools PR1 Implementation Plan

**Goal:** Ship PR1 for the official Qwen Code Chrome extension so users can install the extension, run `qwen serve`, and get baseline browser debugging tools without bundling or installing `chrome-devtools-mcp`.

**Architecture:** Keep Qwen Code's agent loop and tool orchestration in the local daemon. The Chrome extension connects to the daemon over `/acp`, hosts a small native MCP server inside the extension, and implements browser tools with `chrome.debugger` CDP access. Add a one-time daemon-to-extension pairing step so the extension only exposes browser-control tools to a trusted local daemon.

**Tech Stack:** TypeScript, Chrome Manifest V3 service worker, `chrome.debugger`, daemon `/acp` WebSocket, existing `qwen serve` Express server, Vitest, esbuild, npm package scanner.

## Scope

PR1 must include:

- Native extension-hosted browser tools: navigation, click/fill/key/scroll/wait, screenshot/snapshot, console, network, evaluate, and request sending.
- Default `qwen serve` compatibility for the official extension ID, with no `QWEN_SERVE_CLIENT_MCP_OVER_WS` or `QWEN_SERVE_CDP_TUNNEL_OVER_WS` required.
- No bundled `chrome-devtools-mcp`, Puppeteer, or external browser automation server in the main npm package or extension ZIP.
- Compatibility fallback for explicit external adapter users through `QWEN_CDP_MCP_COMMAND`.
- One-time pairing/auth so a random local process cannot impersonate the daemon and invoke extension-hosted browser tools.
- Self-contained verification: unit tests, extension packaging scan, CLI tests, typecheck/build/bundle/package scan, and real Chrome smoke test.

Out of scope for PR1:

- Recording/replay workflows.
- Performance timeline/profiling UI.
- Multi-tab orchestration beyond active-tab control.
- Publishing to Chrome Web Store.

## Current Baseline

The worktree contains the native browser-tools implementation and daemon-extension pairing. First-use mutual HMAC proof keeps the terminal code and derived credential secret off the wire; stored credentials are challenge-verified before `/acp`, pairing routes precede bearer authentication, and failed attempts are bounded.

## Task 1: Sync Base Branch

**Files:**

- No direct source edits.

**Step 1: Fetch latest main**

Run:

```bash
git fetch origin main
```

Expected: fetch succeeds.

**Step 2: Merge latest main into the worktree**

Run:

```bash
git merge origin/main
```

Expected: merge succeeds or exposes concrete conflicts to resolve.

**Step 3: Inspect conflicts or changed upstream serve/extension code**

Run:

```bash
git status --short --branch
git diff --name-only --diff-filter=U
```

Expected: no unresolved conflicts before continuing.

## Task 2: Define Pairing Contract Tests

**Files:**

- Create: `packages/cli/src/serve/extension-pairing.test.ts`
- Create: `packages/cli/src/serve/extension-pairing.ts`
- Modify: `packages/cli/src/serve/run-qwen-serve.test.ts`
- Modify: `packages/chrome-extension/src/daemon/discovery.test.ts`
- Modify: `packages/chrome-extension/src/background/service-worker.ts`
- Modify: `packages/chrome-extension/src/daemon/discovery.ts`

**Behavior:**

- Daemon prints a time-limited pairing code in the terminal and exposes only
  pairing status on loopback.
- Extension can store a daemon trust credential after explicit pairing.
- `/acp` browser-tools connection must carry the trust credential after pairing.
- Official extension still shows `qwen serve` as the default startup command.
- If no credential is present, the extension must not register browser tools with an untrusted daemon.

**Step 1: Write failing CLI pairing tests**

Add tests for:

- Pairing challenge generation returns a high-entropy code, nonce, and expiration timestamp.
- Pairing exchange rejects wrong or expired HMAC proofs without receiving the code.
- Pairing exchange mutually authenticates the daemon and derives a persistent credential without transferring its secret.
- Stored credential verification accepts the issued credential and rejects random values.

Run:

```bash
cd packages/cli && npx vitest run src/serve/extension-pairing.test.ts
```

Expected: fails because the module does not exist or behavior is missing.

**Step 2: Write failing extension discovery tests**

Add tests for:

- Reading pairing state from storage.
- Returning `unpaired` when daemon is reachable but no trust credential exists.
- Returning `ready` when daemon is reachable and trust credential is accepted.

Run:

```bash
npm -w packages/chrome-extension run test -- src/daemon/discovery.test.ts
```

Expected: fails because pairing behavior is missing.

## Task 3: Implement Minimal Daemon Pairing

**Files:**

- Create: `packages/cli/src/serve/extension-pairing.ts`
- Modify: `packages/cli/src/serve/run-qwen-serve.ts`
- Modify: `packages/cli/src/serve/run-qwen-serve.test.ts`
- Modify: `packages/cli/src/serve/types.ts` only if a shared type is truly needed.

**Implementation:**

- Keep state in the running daemon process for PR1: current pairing code, expiration, and issued trust credential hash.
- Generate a pasteable 128-bit code and nonce with Node `crypto`.
- Add loopback-only HTTP endpoints:
  - `GET /extension/pairing` returns pairing status and expiration metadata,
    but never returns the terminal code.
  - `POST /extension/pairing/confirm` accepts a client proof and returns a credential ID plus daemon proof; the secret is derived independently at both ends.
  - `POST /extension/pairing/verify` returns a challenge proof for the public
    credential id without receiving the credential secret.
- Use constant-time comparison for credential verification.
- Do not write secrets to logs.
- Do not persist credentials in the repo; extension stores its copy in Chrome storage.

**Step 1: Implement module only**

Run:

```bash
cd packages/cli && npx vitest run src/serve/extension-pairing.test.ts
```

Expected: pairing module tests pass.

**Step 2: Wire routes into `qwen serve`**

Run:

```bash
cd packages/cli && npx vitest run src/serve/run-qwen-serve.test.ts
```

Expected: existing serve tests plus new pairing route tests pass.

## Task 4: Implement Extension Pairing Flow

**Files:**

- Modify: `packages/chrome-extension/src/daemon/discovery.ts`
- Modify: `packages/chrome-extension/src/daemon/discovery.test.ts`
- Modify: `packages/chrome-extension/src/background/service-worker.ts`
- Modify: `packages/chrome-extension/public/sidepanel.js`
- Modify: `packages/chrome-extension/public/sidepanel.html` only if the existing markup cannot support the pairing UI.

**Implementation:**

- Add a `paired` daemon state in discovery.
- Store the daemon credential under the existing daemon storage object.
- Side panel states:
  - daemon down: show `qwen serve`;
  - daemon up but unpaired: ask the user to paste the pairing code shown
    in the `qwen serve` terminal;
  - daemon up and paired: frame Web Shell.
- Service worker behavior:
  - Do not connect/register native browser tools until pairing verifies.
  - Include the trust credential in `/acp` authentication using the existing token/subprotocol mechanism only if it does not collide with `QWEN_SERVER_TOKEN`; otherwise add a small pairing-specific message before MCP registration.
- Keep external adapter fallback unchanged.

**Step 1: Add failing extension tests**

Run:

```bash
npm -w packages/chrome-extension run test -- src/daemon/discovery.test.ts src/background/service-worker.test.ts
```

Expected: tests fail for missing pairing state or service worker gating.

**Step 2: Implement minimal pairing UI and service worker gating**

Run:

```bash
npm -w packages/chrome-extension run test
```

Expected: all extension tests pass.

## Task 5: Preserve Packaging and Scanner Guarantees

**Files:**

- Modify: `packages/chrome-extension/scripts/artifact-scan.js` only if new signatures must be added.
- Modify: `scripts/tests/chrome-extension-package.test.js` if packaging expectations change.
- Modify: `packages/chrome-extension/package.json` only if package scripts need adjustment.

**Behavior:**

- Extension production ZIP must not contain `chrome-devtools-mcp`, Puppeteer, or external MCP server code.
- Main npm final package must not contain those signatures either.
- Native CDP code remains extension-only.

**Step 1: Run extension release test**

Run:

```bash
npm -w packages/chrome-extension run test:release
```

Expected: tests, typecheck, build/package, and artifact scan pass.

**Step 2: Run root package scanner**

Run:

```bash
npm run build
npm run bundle
npm run prepare:package
```

Expected: build and final package scan pass.

## Task 6: Real Chrome Smoke Test

**Files:**

- No source edits unless smoke test exposes a product bug.

**Setup:**

Run daemon without browser env flags:

```bash
node packages/cli/dist/index.js serve --port 4170 --hostname 127.0.0.1
```

Load the built extension ZIP or unpacked `packages/chrome-extension/dist/extension`.

**Verify manually or with Playwright:**

- Extension side panel detects daemon.
- First run requires pairing.
- After pairing, reload the extension and verify it stays paired.
- `/workspace/mcp` includes `qwen-browser-tools`.
- Agent can:
  - navigate to `http://127.0.0.1:4170/demo`;
  - inspect snapshot;
  - fill and click;
  - evaluate JavaScript;
  - read console output;
  - read network requests and response metadata.

Expected: all checks pass without `QWEN_SERVE_CLIENT_MCP_OVER_WS`, `QWEN_SERVE_CDP_TUNNEL_OVER_WS`, or `QWEN_CDP_MCP_COMMAND`.

## Task 7: Final Review and PR Readiness

**Files:**

- Modify docs as needed:
  - `packages/chrome-extension/README.md`
  - `packages/chrome-extension/docs/05-daemon-direct-architecture.md`

**Step 1: Run changed-file lint**

Run:

```bash
npm run lint
```

Expected: no errors.

**Step 2: Run full typecheck**

Run:

```bash
npm run typecheck
```

Expected: no errors.

**Step 3: Run code review workflow**

Use review and ponytail checks on the final diff.

Expected: no Critical or High issues remain. Any remaining Medium/Low items are documented as PR2 follow-ups.

**Step 4: Prepare Draft PR**

Draft PR must state:

- PR1 user flow.
- Pairing behavior and security model.
- Native tools included.
- Explicit statement that `chrome-devtools-mcp` is not bundled.
- Test evidence with exact commands.
- Known PR2 follow-ups: recording/replay, performance profiling, richer multi-tab workflow.

## Validation Results

Automated validation after syncing `origin/main` on 2026-07-16:

- Extension `test:release`: 58 tests passed, including typecheck, ZIP creation, and artifact scan.
- Relevant CLI session authentication, ACP bridge, and Web Shell tests: 101 tests passed.
- `npm run lint`, `npm run build`, `npm run typecheck`, `npm run bundle`, and `npm run prepare:package`: passed.
- Main npm tarball: 23.4 MB and 833 files; path and content scans found no `chrome-devtools-mcp`, Puppeteer, extension ZIP/manifest, or native browser-MCP source.
- Full `npm run verify:pr` passed every deterministic stage and all other workspaces. One unrelated CLI webhook test ended with `socket hang up`; the exact test passed twice in isolation.

The real Chrome smoke test in Task 6 remains the final manual release check.

## Acceptance Criteria

- Official extension + `qwen serve` gives browser tools after one-time pairing.
- No external `chrome-devtools-mcp` install is required for PR1 baseline tools.
- No browser env flags are required for the official extension path.
- Main npm package and extension ZIP scans do not flag `chrome-devtools-mcp` or Puppeteer.
- Untrusted local processes cannot silently use the extension-hosted tools.
- All listed verification commands pass in this worktree before declaring the PR ready.
