---
name: electron-desktop-dev
description: Develop, debug, and verify the Electron desktop app. Use when
  changing packages/desktop, Electron main/preload/renderer code, desktop IPC,
  desktop settings, terminal/diff/thread/project UI, packaged desktop startup,
  or any UI/renderer behavior that must be validated in a real Electron app via
  Chrome DevTools Protocol, browser/DevTools MCP, or an equivalent harness.
---

# Electron Desktop Development

Use this workflow for desktop work where correctness depends on the real
Electron runtime, not just isolated React/component behavior.

## Core Rule

For any UI or renderer-related change, start and drive the real Electron app.
Do not declare UI usability from component tests, static reading, or imagined
screenshots. Screenshots are diagnostics; executable assertions over real user
paths are the pass/fail signal.

An Electron smoke test that only proves the process launched is insufficient
for behavior changes. The test must interact with the app as a user would.

## Workflow

### 1. Scope the runtime surface

Classify the change before editing:

- **Renderer/UI**: React components, CSS, workbench layout, terminal UI, diff
  UI, thread/project/settings views. Requires real Electron interaction.
- **Preload/IPC**: bridge APIs, channel names, request/response contracts.
  Requires unit coverage plus Electron integration when the renderer consumes
  the path.
- **Main/server/lifecycle**: Electron startup, windows, protocol handling,
  local server, filesystem or git operations. Requires targeted unit tests and
  a real app smoke or E2E path when user-visible.
- **Packaging**: bundled resources, app.asar, platform launch. Requires package
  smoke and launch verification.

Inspect existing scripts first. In this repo, desktop scripts live in
`packages/desktop/package.json`.

### 2. Implement with local coverage

Add or update focused tests near the code under change. For unit tests, run
Vitest from the package directory, not from the repository root:

```bash
cd packages/desktop
npx vitest run src/path/to/file.test.ts
```

Use unit tests for pure logic, IPC/server behavior that can be isolated, and
regression cases that do not require the renderer. Keep mocks honest: they must
model the contract the real Electron path uses.

### 3. Verify the real Electron app

For UI/renderer slices, build the desktop package and run an Electron harness
that attaches to the renderer through Chrome DevTools Protocol or an available
browser/DevTools MCP.

Prefer the existing CDP smoke when it covers the path:

```bash
cd packages/desktop
npm run build
npm run e2e:cdp
```

When adding a new path, extend or create a harness that:

- Launches Electron with isolated `HOME`, runtime, and user-data directories.
- Enables a CDP port or uses the available browser/DevTools MCP connection.
- Waits for real app readiness through visible text, accessible labels, or
  stable `data-testid` hooks.
- Clicks buttons, fills fields, sends keyboard input, and waits for resulting
  UI state.
- Verifies side effects outside the DOM when relevant, such as git status,
  commit history, settings files, terminal output, or generated artifacts.
- Captures console errors, failed network requests, Electron logs, and
  screenshots as debugging artifacts.

Do not rely on brittle sleeps when a state-based wait is possible.

### 4. Assert real user paths

Executable E2E or harness assertions must cover the user journey affected by
the change. Choose from the relevant paths below, and add missing coverage when
the current harness does not exercise the changed behavior:

- Open a project and confirm the workbench reflects the selected directory.
- Create or switch a thread and confirm the active session changes.
- Send a prompt, approve or deny a command, and verify the resulting message.
- Review a diff, accept a hunk, accept all, reject/revert where applicable, and
  confirm the staged/modified counts.
- Run terminal commands, send stdin, copy output, and send output to AI.
- Edit and save settings, then confirm the saved values appear or persist.
- Commit changes and verify the repository log/status, not only the UI toast.
- Package the app and run a packaged launch smoke when packaging, resources, or
  startup behavior changes.

For packaging checks in this repo:

```bash
npm run package:desktop
```

This builds, bundles, packages the desktop app, and runs the package smoke.

### 5. Treat failures as blockers

If a unit, E2E, harness, or package smoke fails, do not record the failure in a
Markdown report and continue as if the task is complete. Fix the feature or fix
the test, then rerun the relevant verification.

Only stop with a blocker when the failure cannot be resolved in the current
environment. Report the exact command, the failure, and what is needed next.

### 6. Finish with evidence

Before declaring done, run the smallest complete verification set for the
change:

- Targeted unit tests for changed logic.
- Desktop build and typecheck when TypeScript or bundling paths changed.
- Real Electron interaction for any renderer/UI behavior.
- Package smoke for packaging/resource/startup changes.

In the final response, name the commands that passed and the real user path
that was exercised. If artifacts were produced, include the artifact directory.

## Practical CDP/MCP Checks

When driving Electron through CDP or browser/DevTools MCP, prefer observable
app semantics over implementation details:

- Use accessible names, visible text, and stable test IDs.
- Assert both "the control was clicked" and "the user-visible outcome changed".
- Subscribe to `Runtime`, `Page`, `Log`, and `Network` events where available.
- Fail on unexpected console errors or failed requests unless the test
  explicitly expects them.
- Use screenshots to investigate layout and rendering regressions, then pair
  them with assertions over text, geometry, focus, or state.

The goal is confidence that the shipped desktop app works for a person sitting
in front of it.
