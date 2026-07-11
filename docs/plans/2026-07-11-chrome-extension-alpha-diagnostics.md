# Chrome Extension Alpha Diagnostics Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the Chrome extension alpha accurately report browser automation readiness, cover its CDP bridge behavior, and generate a versioned side-loadable package.

**Architecture:** Keep the extension as a thin daemon client. Derive presentation state from the existing `/health` and `/capabilities` responses without changing the daemon protocol, display a small warning only when chat is ready but browser automation is not, and keep the Web Shell iframe as the primary UI. Test the pure capability reducer and the existing `chrome.debugger` bridge directly with mocked Chrome APIs.

**Tech Stack:** TypeScript, Manifest V3, Chrome extension APIs, esbuild, Vitest, jsdom.

### Task 1: Capability readiness model

**Files:**

- Create: `packages/chrome-extension/src/sidepanel/capability-status.ts`
- Create: `packages/chrome-extension/src/sidepanel/capability-status.test.ts`
- Modify: `packages/chrome-extension/config/esbuild.background.config.js`

1. Write failing tests for daemon down, missing allow-origin, chat-only, CDP-tunnel-only, and browser-automation-configured states.
2. Run the focused test and confirm it fails because the module does not exist.
3. Implement the minimal pure reducer and presentation labels.
4. Add the reducer as an esbuild entry point for the side panel.
5. Run the focused test and typecheck.

### Task 2: Side panel readiness banner

**Files:**

- Modify: `packages/chrome-extension/public/sidepanel.js`
- Modify: `packages/chrome-extension/public/sidepanel.html`
- Test: `packages/chrome-extension/src/sidepanel/capability-status.test.ts`

1. Extend the reducer tests with the exact warning visibility and message expectations.
2. Confirm the new assertions fail.
3. Import the built reducer from the side panel and preserve the full capability response in `probeState`.
4. Show a restrained status banner over the Web Shell for chat-only or tunnel-only states; hide it when browser automation is ready.
5. Re-run focused tests and the extension build.

### Task 3: CDP bridge regression tests

**Files:**

- Create: `packages/chrome-extension/src/background/cdp-bridge.test.ts`
- Modify only if a failing test exposes a defect: `packages/chrome-extension/src/background/cdp-bridge.ts`

1. Write tests for active-tab attach, command forwarding, debugger detach notification, and shutdown during an in-flight attach.
2. Run tests and confirm each new case fails for the expected missing test fixture or behavior.
3. Add only the minimal production fix required by a demonstrated failure.
4. Run the focused tests and the complete extension test suite.

### Task 4: Versioned alpha package

**Files:**

- Create: `packages/chrome-extension/scripts/manifest-version.ts`
- Create: `packages/chrome-extension/scripts/manifest-version.test.ts`
- Modify: `packages/chrome-extension/scripts/sync-extension.js`
- Modify: `packages/chrome-extension/package.json`

1. Write failing tests that normalize stable and prerelease package versions into Chrome-compatible manifest versions.
2. Implement the minimal normalization helper.
3. Update the sync step to write the package version into the generated manifest, without editing the source manifest.
4. Build and package the extension, then verify the zip has a root manifest and the generated version matches the package version.

### Task 5: Documentation and verification

**Files:**

- Modify: `packages/chrome-extension/README.md`
- Modify: `packages/chrome-extension/docs/05-daemon-direct-architecture.md`

1. Document the readiness states and clarify that the current alpha requires an external executable adapter.
2. Remove stale claims about content scripts and an extension-hosted MCP server.
3. Run Prettier, extension tests, typecheck, production build, package, and `git diff --check`.
4. Review the final diff for scope and regressions before commit/PR handoff.
